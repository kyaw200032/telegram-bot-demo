// Shared bot logic — used by both the Vercel webhook (api/webhook.js)
// and the local polling runner (bot.js).
//
// `send` is an async function: send(method, params) -> Telegram API result.
// This keeps the logic identical everywhere; only the transport differs.
//
// Optional env vars (Vercel → Settings → Environment Variables):
//   PRICES_CSV_URL     published-CSV link of the "prices" sheet tab
//                      (columns: Plan, Price, Note)
//   SETTINGS_CSV_URL   published-CSV link of the "settings" sheet tab
//                      (columns: Key, Value — supported keys:
//                       payment_info, admin_username,
//                       gift_title, gift_text, gift_link,
//                       btn_vip, btn_gift, btn_slip, btn_help,
//                       welcome_text — {name} becomes the user's name)
//   ADMIN_TELEGRAM_ID  numeric Telegram user id of the owner/admin
//                      (get it from @userinfobot)
//   ADMIN_USERNAME     (optional) e.g. @kyawgyi — shown if a slip is rejected
//   VIP_CHANNEL_ID     VIP channel id, e.g. -1001234567890
//                      (needed for auto single-use invite links;
//                       bot must be admin with "Invite Users" right)
//   VIP_INVITE_LINK    (optional) static invite link fallback when
//                      VIP_CHANNEL_ID is not set

import { createWorker } from "tesseract.js";

// Persistent bottom menu (reply keyboard), VerveMarket-style 2x2 grid.
// These buttons send plain text, handled in handleMessage below.
//
// Labels are user-editable in the settings sheet (keys btn_vip, btn_gift,
// btn_slip, btn_help); empty/missing values fall back to the defaults.
const DEFAULT_LABELS = {
  vip: "💎 VIP ဝင်မည်",
  gift: "🎁 လက်ဆောင်",
  tiktok: "📥 TikTok ဒေါင်း",
  slip: "📤 စလစ်ပို့မယ်",
  help: "🆘 အကူအညီ",
  profile: "👤 ပရိုဖိုင်",
  raffle: "🎫 မဲစာရင်းသွင်းရန်",
};

export function getLabels(settings) {
  const s = settings || {};
  return {
    vip: s.btn_vip || DEFAULT_LABELS.vip,
    gift: s.btn_gift || DEFAULT_LABELS.gift,
    tiktok: s.btn_tiktok || DEFAULT_LABELS.tiktok,
    slip: s.btn_slip || DEFAULT_LABELS.slip,
    help: s.btn_help || DEFAULT_LABELS.help,
    profile: s.btn_profile || DEFAULT_LABELS.profile,
    raffle: s.btn_raffle || DEFAULT_LABELS.raffle,
  };
}

export function mainKeyboard(labels, isAdmin = false) {
  const L = labels || DEFAULT_LABELS;
  const kb = [
    [{ text: L.vip }, { text: L.gift }, { text: L.tiktok }],
    [{ text: L.slip }, { text: L.help }],
    [{ text: L.profile }, { text: L.raffle }],
  ];
  // Spin + raffle toggle are visible to the admin only.
  if (isAdmin) {
    kb.push([{ text: SPIN_LABEL }, { text: SPIN_TEST_LABEL }]);
    kb.push([{ text: RAFFLE_TOGGLE_LABEL }]);
    kb.push([{ text: AI_TRAIN_LABEL }, { text: AI_TOGGLE_LABEL }]);
  }
  return { keyboard: kb, resize_keyboard: true };
}

// Welcome text is sheet-editable (welcome_text); {name} is replaced with
// the sender's first name. Falls back to WELCOME when unset.
export function welcomeText(settings, name) {
  const tpl = (settings && settings.welcome_text) || WELCOME;
  return tpl.replaceAll("{name}", name || "မိတ်ဆွေ");
}

// ---------------------------------------------------------------------------
// Force-join: users must join this channel before using the bot.
// Sheet key: force_join_channel (e.g. @pkaihub1). Empty = feature disabled.
// ---------------------------------------------------------------------------
function forceJoinChannel(settings) {
  const v = (settings && settings.force_join_channel) || "";
  return String(v).trim();
}

async function isChannelMember(send, channel, userId) {
  try {
    const res = await send("getChatMember", {
      chat_id: channel,
      user_id: userId,
    });
    const st = res && res.result && res.result.status;
    return st === "creator" || st === "administrator" || st === "member";
  } catch {
    return false;
  }
}

async function sendJoinRequired(send, chatId, channel, name) {
  const display = name || channel;
  const rows = [];
  if (channel.startsWith("@")) {
    rows.push([
      { text: `📢 ${display} Join`, url: `https://t.me/${channel.slice(1)}` },
    ]);
  }
  rows.push([
    { text: "✅ Join ပြီးပြီ၊ စစ်ဆေးမယ်", callback_data: "verify_join" },
  ]);
  await send("sendMessage", {
    chat_id: chatId,
    text:
      "🔒 Channel Join လိုအပ်ပါတယ်\n" +
      "\n" +
      "Bot ဆက်သုံးဖို့ အောက်က channel ကို အရင် join ပေးပါ 👇\n" +
      "\n" +
      `📢 ${display}`,
    reply_markup: { inline_keyboard: rows },
  });
}

// Returns true when the user was blocked by the force-join gate.
async function forceJoinGate(send, msg, settings) {
  const fj = forceJoinChannel(settings);
  if (!fj) return false;
  const userId = msg.from && msg.from.id;
  if (await isChannelMember(send, fj, userId)) return false;
  const fjName = String((settings && settings.force_join_name) || "").trim();
  await sendJoinRequired(send, msg.chat.id, fj, fjName);
  return true;
}

const WELCOME =
  "👋 PK AI Hub မှ ကြိုဆိုပါတယ်!\n" +
  "\n" +
  "• 💎 VIP အကြောင်းသိချင်ရင် VIP ဝင်မည်ဆိုတဲ့ခလုတ်ကိုနှိပ်ပါ\n" +
  "\n" +
  "စလစ်ပို့ပြီးရင် Admin အတည်ပြုတာနဲ့ VIP invite link ရပါမယ် 🙏";

const HELP_TEXT =
  "🆘 အကူအညီ\n" +
  "\n" +
  "💳 VIP join ချင်ရင် /vip နှိပ်ပြီး ဈေးကြည့်ပါ။\n" +
  "ငွေလွှဲပြီးရင် စလစ်ပုံကို ဒီ chat ထဲမှာ ပို့ပေးပါ 📤\n" +
  "Admin အတည်ပြုပြီးတာနဲ့ VIP invite link ပို့ပေးပါမယ် 🙏\n" +
  "\n" +
  "ရနိုင်တဲ့ command တွေ:\n" +
  "/vip — VIP ဈေးနှုန်းကြည့်ရန်\n" +
  "/tiktok <link> — TikTok video ဒေါင်းရန် (watermark မပါ) 📥\n" +
  "/start — menu ပြန်ဖွင့်\n" +
  "/help — ဒီစာရင်း\n" +
  "\n" +
  "ℹ️ PK AI Hub ရဲ့ Telegram bot 🤖 — Pupu က ဆောက်ပေးထားတာ";

function yangonTime() {
  return new Intl.DateTimeFormat("my-MM", {
    timeZone: "Asia/Yangon",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

// ---------------------------------------------------------------------------
// Google Sheet helpers (prices + settings are user-editable, no code change)
// ---------------------------------------------------------------------------

const SHEET_CACHE_MS = 60 * 1000;
const sheetCache = new Map();

// Minimal CSV parser that handles quoted fields ("a, b").
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }
  return rows;
}

async function fetchCSV(url, fresh = false) {
  if (!url) return null;
  const now = Date.now();
  if (!fresh) {
    const cached = sheetCache.get(url);
    if (cached && now - cached.at < SHEET_CACHE_MS) return cached.rows;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sheet fetch failed: ${res.status}`);
  const rows = parseCSV(await res.text());
  sheetCache.set(url, { at: now, rows });
  return rows;
}

function sheetUrl(which) {
  return which === "prices"
    ? process.env.PRICES_CSV_URL || ""
    : process.env.SETTINGS_CSV_URL || "";
}

// CSV URL for any tab of the settings spreadsheet.
// SETTINGS_CSV_URL may be a gviz URL or an export?format=csv&gid=... URL —
// in the export form Google ignores an appended &sheet= override (gid wins),
// so we always rebuild a clean gviz URL from the spreadsheet ID.
function tabCsvUrl(tab) {
  const base = process.env.SETTINGS_CSV_URL || "";
  const m = base.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return "";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

// settings tab → { key: value } (first row is the header Key,Value)
async function getSettings() {
  const map = {};
  try {
    const rows = await fetchCSV(sheetUrl("settings"));
    if (rows) {
      for (const r of rows.slice(1)) {
        const key = (r[0] || "").trim();
        if (key) map[key] = (r[1] || "").trim();
      }
    }
  } catch (err) {
    console.error("getSettings failed:", err.message);
  }
  return map;
}

// ---------------------------------------------------------------------------
// VIP flow: main screen (Lifetime price) → about / pay (KPay + tap-to-copy)
// → slip. Every sub-screen has a Back button.
// ---------------------------------------------------------------------------

const KPAY_NUMBER = "09670451746";
const KPAY_NAME = "Ma Mya Hnin Aye";

const VIP_MAIN_TEXT =
  "💎 PK AI Hub VIP\n" +
  "\n" +
  "🎉 တသက်တာ Lifetime — မြန်မာငွေ ၃သောင်းကျပ် / ထိုင်းဘတ် ၃၀၀ ပဲဖြစ်ပါတယ် 🇲🇲🇹🇭\n" +
  "\n" +
  "👇 VIP အကြောင်းအသေးစိတ် သိချင်ရင် အောက်ကခလုတ်ကို နှိပ်ပြီးဖတ်ကြည့်ပါ 👇";

// No-username nudge: website auto-sync matches on the Telegram username, so a
// buyer without one never gets the automatic LIFETIME upgrade. Warn at /vip
// entry; the approval paths re-read the username fresh, so setting one
// mid-flow still syncs fine.
function vipMainText(hasUsername) {
  if (hasUsername) return VIP_MAIN_TEXT;
  return (
    "⚠️ သင့် Telegram username မရှိသေးပါဘူး\n" +
    "🌐 Website မှာ auto VIP ရဖို့ Telegram username လိုပါတယ်\n" +
    "👉 Telegram Settings → Username မှာ တစ်ခုခု set လိုက်ပါ\n" +
    "(set ပြီးရင် ဒီကပဲ ဆက်လုပ်လို့ရပါတယ် ✅)\n" +
    "\n" +
    VIP_MAIN_TEXT
  );
}

const VIP_ABOUT_TEXT =
  "📌 VIP ဆိုတာဘာလဲ?\n" +
  "\n" +
  "🎓 သင်တန်း မဟုတ်ပါ!\n" +
  "💡 အဓိက Prompt တွေကို စိတ်ကြိုက်ယူသုံးနိုင်အောင် စီစဉ်ပေးထားတာပဲ ဖြစ်ပါတယ်\n" +
  "\n" +
  "📚 Prompt အသုံးပြုနည်းအပြင်\n" +
  "🔄 တစ်ခါသုံးမဟုတ်ပဲ ထပ်ခါထပ်ခါ မတူညီတဲ့ Video Prompt တွေ ရရှိမှာပါ\n" +
  "\n" +
  "✨ VIP Member ဝင်ထားရင် ဘာတွေအားသာလဲ?\n" +
  "👤 သာမန် Member — ကျနော်ပေးတဲ့ Free Prompt တွေ ပေးသလောက်ပဲ သုံးနိုင်မယ်\n" +
  "👑 VIP Member — အဆင့်မြင့် Master Prompt တွေနဲ့ Free ဂုန်းဆင်းလို့ရမယ့် နည်းတွေ အသေးစိတ်သိရမယ် 💰";

const VIP_PAY_TEXT =
  "💳 ငွေလွှဲရန်အကောင့်\n" +
  "\n" +
  "📱 KPay: `09670451746`\n" +
  "👤 Name: Ma Mya Hnin Aye\n" +
  "\n" +
  "ငွေလွှဲပြီးရင် «📤 စလစ်ပို့ရန်» ကို နှိပ်ပြီး စလစ်ပို့ပေးပါ 🙏";

  "https://telegram-bot-demo-chi.vercel.app/copy.html?n=" + KPAY_NUMBER;

function vipMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📖 VIP အကြောင်းဖတ်ရန်", callback_data: "vip_about" },
        { text: "💳 ငွေလွှဲရန်", callback_data: "vip_pay" },
      ],
      [{ text: "📤 စလစ်ပို့ရန်", callback_data: "send_slip" }],
    ],
  };
}

function vipBackKeyboard(extraRows = []) {
  return {
    inline_keyboard: [
      ...extraRows,
      [{ text: "⬅️ Back", callback_data: "vip_back" }],
    ],
  };
}

export async function handleVip(send, chatId, msg) {
  const hasUsername = !!(msg && msg.from && msg.from.username);
  await send("sendMessage", {
    chat_id: chatId,
    text: vipMainText(hasUsername),
    reply_markup: vipMainKeyboard(),
  });
}

async function editVipScreen(send, query, text, keyboard, parseMode) {
  await send("editMessageText", {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
    reply_markup: keyboard,
  });
}

// ---------------------------------------------------------------------------
// Gift delivery (link stored in the settings sheet: gift_link)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gift event: participants post their share-screenshot in the event group.
// The bot records each poster's Telegram ID (Google Form -> Sheet tab) and
// the gift button only reveals the gift link to recorded participants.
// Settings keys: gift_event_active ("1" = on), gift_event_group_id,
// gift_event_tab (default "Form Responses 1"), gift_event_text (optional
// custom instructions, supports {fb} and {group}), gift_event_fb,
// gift_group_invite.
// ---------------------------------------------------------------------------
const GIFT_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSddQ9JmoZJJkwseKHtlPQ2FND1AzEKVGrD8Exdgql1Sbgp03g/formResponse";
const GIFT_FORM_ENTRIES = {
  userId: "entry.956716737",
  username: "entry.1004461039",
  date: "entry.27176386",
};

function bangkokStamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Yangon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(",", "");
  return parts;
}

async function recordGiftParticipant(userId, username) {
  try {
    const body = new URLSearchParams({
      [GIFT_FORM_ENTRIES.userId]: String(userId),
      [GIFT_FORM_ENTRIES.username]: username || "",
      [GIFT_FORM_ENTRIES.date]: bangkokStamp(),
    });
    await fetch(GIFT_FORM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error("gift record failed:", err.message);
  }
}

function giftResponsesUrl(tab) {
  return tabCsvUrl(tab);
}

// Users recorded in the last few minutes (userId -> timestamp). Merged into
// getGiftParticipants() so someone who just posted a screenshot and instantly
// taps the gift button is recognised even before the sheet cache refreshes.
const recentGiftJoins = new Map();
const RECENT_JOIN_TTL_MS = 5 * 60 * 1000;

async function getGiftParticipants() {
  const set = new Set();
  const now = Date.now();
  for (const [id, at] of recentGiftJoins) {
    if (now - at < RECENT_JOIN_TTL_MS) set.add(id);
    else recentGiftJoins.delete(id);
  }
  try {
    const s = await getSettings();
    // Fresh read (no 60s cache): the user may have posted seconds ago.
    const rows = await fetchCSV(giftResponsesUrl(s.gift_event_tab || "Form Responses 1"), true);
    if (rows && rows.length > 1) {
      const head = rows[0].map((h) => (h || "").trim().toLowerCase());
      const ui = head.indexOf("user_id");
      if (ui >= 0) {
        for (const r of rows.slice(1)) {
          const id = (r[ui] || "").trim();
          if (/^\d{5,}$/.test(id)) set.add(id);
        }
      }
    }
  } catch (err) {
    console.error("gift participants fetch failed:", err.message);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Gift event OCR gate: when gift_event_ocr=1, a group photo must look like a
// Facebook share screenshot (any token below in the OCR text). Otherwise the
// sender is muted and the photo goes to the admin for ✅/❌ review.
// ---------------------------------------------------------------------------
// Strict share check: the screenshot must show THIS post — the page name
// "PK AI Hub" plus the post text ("Muse ai agent app" / "နည်းလမ်းနဲ့").
// Spacing-tolerant so OCR misreads like "PKAIHub" still pass.
function looksLikeShareScreenshot(ocrText) {
  const t = (ocrText || "").toLowerCase();
  const nospace = t.replace(/\s+/g, "");
  const hasPage = nospace.includes("pkaihub");
  const hasPost =
    nospace.includes("museaiagentapp") || t.includes("နည်းလမ်းနဲ့");
  return hasPage && hasPost;
}

// userId -> { chatId, username, at } for currently muted gift-event users.
const giftMuted = new Map();

const FULL_PERMS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: true,
  can_invite_users: true,
  can_pin_messages: true,
  can_manage_topics: true,
};
const MUTED_PERMS = Object.fromEntries(Object.keys(FULL_PERMS).map((k) => [k, false]));

async function setGiftMute(send, chatId, userId, muted) {
  await send("restrictChatMember", {
    chat_id: Number(chatId),
    user_id: Number(userId),
    permissions: muted ? MUTED_PERMS : FULL_PERMS,
  });
}

// Group language rule: English-only text (Latin letters, no Myanmar script)
// -> temporary mute. Messages containing Myanmar chars are always fine.
// Covers the Myanmar block + Extended-A/B.
const MYANMAR_RE = /[\u1000-\u109F\uAA60-\uAA7F\uA9E0-\uA9FF]/;
function isEnglishOnlyText(text) {
  const t = text || "";
  return /[a-zA-Z]/.test(t) && !MYANMAR_RE.test(t);
}

// Temporary mute (e.g. 60s); Telegram auto-lifts it at until_date.
async function muteTemp(send, chatId, userId, seconds) {
  recentMute.set(String(chatId), { userId: String(userId), at: Date.now() });
  await send("restrictChatMember", {
    chat_id: Number(chatId),
    user_id: Number(userId),
    permissions: MUTED_PERMS,
    until_date: Math.floor(Date.now() / 1000) + seconds,
  });
}

// Group language rule: chatId:userId -> warned at ms (1st English-only offense
// warns, 2nd+ mutes). In-memory like the other pending maps (best effort).
const langWarned = new Map();
// Group command-tap rule: chatId:userId -> warned at ms (1st tap warns, 2nd+ mutes).
const cmdWarned = new Map();
// chatId -> {userId, at}: most recent temp mute, for reply-less unmute fallback.
const recentMute = new Map();

async function checkShareScreenshot(send, msg) {
  try {
    const photos = msg.photo || [];
    if (!photos.length) return false;
    const fileId = photos[photos.length - 1].file_id;
    const gf = await send("getFile", { file_id: fileId });
    const fpath = gf && gf.result && gf.result.file_path;
    if (!fpath || typeof send.downloadFile !== "function") return true; // can't check -> fail open
    const buf = await send.downloadFile(fpath);
    const { text } = await ocr.image(buf);
    return looksLikeShareScreenshot(text);
  } catch (err) {
    console.error("gift OCR failed:", err.message);
    return true; // fail open on error
  }
}

// Returns true when the photo was consumed as a gift-event entry.
async function handleGiftEventPhoto(send, msg) {
  let s;
  try {
    s = await getSettings();
  } catch {
    return false;
  }
  if (s.gift_event_active !== "1") return false;
  const groupId = (s.gift_event_group_id || "").trim();
  if (!groupId || String(msg.chat.id) !== groupId) return false;
  const userId = msg.from?.id;
  if (!userId || msg.from?.is_bot) return false;
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
  const username = msg.from?.username ? `@${msg.from.username}` : "";

  // OCR gate: mute + admin review when the photo doesn't look like a share.
  if (s.gift_event_ocr === "1" && String(userId) !== adminId) {
    const looksOk = await checkShareScreenshot(send, msg);
    if (!looksOk) {
      const who =
        username || `${msg.from?.first_name || ""}`.trim() || "အမည်မသိ";
      try {
        await setGiftMute(send, groupId, userId, true);
      } catch (err) {
        console.error("gift mute failed:", err.message);
      }
      giftMuted.set(String(userId), { chatId: groupId, username: who, at: Date.now() });
      if (adminId) {
        await send("copyMessage", {
          chat_id: Number(adminId),
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
          caption:
            `🎁 Gift event: ပုံစစ်မအောင်ပါ ⚠️\n👤 ${who}\n🆔 ${userId}\n\n` +
            `လက်ခံရင် ✅ (mute ပြန်ဖွင့် + စာရင်းမှတ်)\nငြင်းရင် ❌ (mute ဆက်ထား)`,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ လက်ခံ", callback_data: `gift_accept:${userId}` },
                { text: "❌ ငြင်း", callback_data: `gift_reject:${userId}` },
              ],
            ],
          },
        });
      }
      return true;
    }
  }

  const participants = await getGiftParticipants();
  if (participants.has(String(userId))) return true;
  await recordGiftParticipant(userId, username);
  recentGiftJoins.set(String(userId), Date.now());
  return true;
}

// Admin ✅/❌ review for a muted gift-event photo.
export async function handleGiftReview(send, query, data) {
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
  const clickerId = String(query.from?.id || "");
  const targetId = data.slice(data.indexOf(":") + 1);
  if (adminId && clickerId !== adminId) {
    await send("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Admin မှသာ အတည်ပြုနိုင်ပါတယ်",
      show_alert: true,
    });
    return;
  }
  await send("answerCallbackQuery", { callback_query_id: query.id });
  if (query.message) {
    try {
      await send("editMessageReplyMarkup", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      /* best effort */
    }
  }
  const info = giftMuted.get(targetId) || {};
  const s = await getSettings();
  const groupId = info.chatId || (s.gift_event_group_id || "").trim();
  if (data.startsWith("gift_reject:")) {
    giftMuted.delete(targetId);
    await send("sendMessage", {
      chat_id: query.message.chat.id,
      text: `❌ ငြင်းလိုက်ပါပြီ — 🆔 ${targetId} mute ဆက်ထားမယ် 🔇`,
    });
    return;
  }
  // gift_accept → unmute + record as participant.
  if (groupId) {
    try {
      await setGiftMute(send, groupId, targetId, false);
    } catch (err) {
      console.error("gift unmute failed:", err.message);
    }
  }
  giftMuted.delete(targetId);
  await recordGiftParticipant(targetId, info.username || "");
  recentGiftJoins.set(String(targetId), Date.now());
  await send("sendMessage", {
    chat_id: query.message.chat.id,
    text: `✅ လက်ခံလိုက်ပါပြီ — 🆔 ${targetId} mute ပြန်ဖွင့်ပြီး စာရင်းမှတ်လိုက်ပြီ 🎉`,
  });
}

function giftEventJoinText(s) {
  const custom = (s.gift_event_text || "").trim();
  const fb = (s.gift_event_fb || "").trim();
  const group = (s.gift_group_invite || "").trim();
  const fallback =
    "🎁 လက်ဆောင်ရဖို့ ဒီအဆင့်တွေလုပ်ပါ 👇\n\n" +
    (fb ? `1️⃣ ဒီ Facebook post ကို Share လုပ်ပါ:\n${fb}\n\n` : "") +
    (group ? `2️⃣ Share screenshot ကို ဒီ group ထဲပို့ပါ:\n${group}\n\n` : "") +
    "ပြီးရင် 🎁 ခလုတ်ကို ပြန်နှိပ်ပါ 😉";
  return (custom || fallback).replaceAll("{fb}", fb).replaceAll("{group}", group);
}

export async function handleGift(send, msg) {
  const chatId = msg.chat.id;
  const s = await getSettings();
  // Gift event gating: only recorded participants see the gift.
  if (s.gift_event_active === "1") {
    const participants = await getGiftParticipants();
    if (!participants.has(String(msg.from?.id || ""))) {
      await send("sendMessage", {
        chat_id: chatId,
        text: giftEventJoinText(s),
      });
      return;
    }
  }
  const link = s.gift_link || "";
  const title = s.gift_title || "🎁 လက်ဆောင်";
  const text = s.gift_text || "";
  if (!link && !text) {
    await send("sendMessage", {
      chat_id: chatId,
      text: "🎁 လာကြည့်မနေနဲ့… ဘာမှမရှိသေးဘူး 😅\n\nလက်ဆောင်ရရင် ဒီမှာ လာယူနော် 😉",
    });
    return;
  }
  const params = {
    chat_id: chatId,
    text: `${title}\n\n${text}`.trim(),
  };
  if (link) {
    params.reply_markup = {
      inline_keyboard: [[{ text: "🔗 ဖွင့်ကြည့်မယ်", url: link }]],
    };
  }
  await send("sendMessage", params);
}

// ---------------------------------------------------------------------------
// Payment slip flow: user sends photo (DM only) → forwarded to admin with
// ✅ / ❌ buttons → approve creates a single-use VIP invite link
// ---------------------------------------------------------------------------

export async function sendSlipPrompt(send, chatId) {
  await send("sendMessage", {
    chat_id: chatId,
    text: "ငွေလွှဲစလစ်ပုံကို ဒီ chat ထဲမှာ ပို့ပေးပါ 📤\n(ဓာတ်ပုံအနေနဲ့ ပို့ပေးနော်)",
  });
}

// ---------------------------------------------------------------------------
// Slip OCR auto-verification.
// Two OCR backends: OCR.space when OCR_SPACE_API_KEY is set (accurate,
// strict checks), otherwise the bundled Tesseract.js (fuzzy checks, no
// setup needed). `ocr.image` is swappable in tests.
// ---------------------------------------------------------------------------
export const ocr = { image: ocrImageImpl };

async function ocrImageImpl(buffer) {
  const key = process.env.OCR_SPACE_API_KEY || "";
  if (key) return { text: await ocrSpace(buffer, key), strict: true };
  return { text: await ocrTesseract(buffer), strict: false };
}

async function ocrSpace(buffer, key) {
  const body = new URLSearchParams({
    base64Image: "data:image/png;base64," + buffer.toString("base64"),
    language: "eng",
    isOverlayRequired: "false",
  });
  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: {
      apikey: key,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const d = await res.json();
  if (!d || d.OCRExitCode !== 1)
    throw new Error("ocr.space: " + ((d && d.ErrorMessage) || "parse failed"));
  return (d.ParsedResults || []).map((r) => r.ParsedText || "").join("\n");
}

let _tessWorker = null;
async function ocrTesseract(buffer) {
  if (!_tessWorker) _tessWorker = await createWorker("eng");
  const { data } = await _tessWorker.recognize(buffer);
  return data.text || "";
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

// Yangon (UTC+7) calendar parts, for the slip-date check.
function yangonParts(offsetDays = 0) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Yangon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const d = new Date(Date.now() + offsetDays * 86400000);
  const [y, mo, da] = dtf.format(d).split("-").map(Number);
  return { y, mo, da };
}
const MONTHS_EN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Checks a slip's OCR text. Returns { ok, reasons[] }.
// strict=true  -> exact-ish matching (OCR.space quality)
// strict=false -> fuzzy matching (Tesseract quality)
export function verifySlipText(text, strict) {
  const reasons = [];
  const t = (text || "").toLowerCase();
  const digits = t.replace(/\D/g, "");

  // 1) must be a KBZ slip
  if (!t.includes("kbz")) reasons.push("KBZ စာလုံး မတွေ့");

  // 2) amount: no restriction — any amount is accepted

  // 3) receiver name must match (all tokens present)
  const nameTokens = ["ma", "mya", "hnin", "aye"];
  const nameHit = nameTokens.filter((w) => t.includes(w)).length;
  if (nameHit < nameTokens.length) reasons.push("လက်ခံသူအမည် မမှန်");

  // 4) date: today or yesterday (Yangon)
  let dateOk = false;
  for (const off of [0, -1]) {
    const { y, mo, da } = yangonParts(off);
    const p2 = (x) => String(x).padStart(2, "0");
    if (strict) {
      const cands = [
        `${p2(da)}/${p2(mo)}/${y}`,
        `${p2(da)}-${p2(mo)}-${y}`,
        `${y}-${p2(mo)}-${p2(da)}`,
        `${da} ${MONTHS_EN[mo - 1]} ${y}`,
      ];
      if (cands.some((c) => t.includes(c))) { dateOk = true; break; }
    } else {
      const target = `${p2(da)}${p2(mo)}${y}`;
      let found = false;
      for (let i = 0; i + 8 <= digits.length && !found; i++) {
        if (levenshtein(digits.slice(i, i + 8), target) <= 2) found = true;
      }
      if (found) { dateOk = true; break; }
    }
  }
  if (!dateOk) reasons.push("ရက်စွဲ မမှန်/မတွေ့");

  return { ok: reasons.length === 0, reasons };
}

// Shared: create a per-buyer join-request invite link.
// Returns { inviteLink, joinRequest } or null.
async function createVipJoinLink(send, targetId) {
  const settings = await getSettings();
  const channelId =
    (settings && settings.vip_channel_id) || process.env.VIP_CHANNEL_ID || "";
  if (!channelId) {
    const fallback = process.env.VIP_INVITE_LINK || "";
    return fallback ? { inviteLink: fallback, joinRequest: false } : null;
  }
  try {
    const res = await send("createChatInviteLink", {
      chat_id: channelId,
      creates_join_request: true,
      expire_date: Math.floor(Date.now() / 1000) + 48 * 3600,
      name: `VIP-${targetId}`.slice(0, 32),
    });
    if (res && res.ok && res.result?.invite_link) {
      return { inviteLink: res.result.invite_link, joinRequest: true };
    }
  } catch (err) {
    console.error("createChatInviteLink failed:", err.message);
  }
  const fallback = process.env.VIP_INVITE_LINK || "";
  return fallback ? { inviteLink: fallback, joinRequest: false } : null;
}

async function sendBuyerInvite(send, targetId, inviteLink, joinRequest) {
  await send("sendMessage", {
    chat_id: Number(targetId),
    text: joinRequest
      ? "🎉 VIP အတည်ပြုပြီးပါပြီ!\n" +
        "အောက်က link ကို နှိပ်ပြီး Join Request လုပ်ပါ 👇\n" +
        "Bot က အလိုအလျောက် လက်ခံပေးပါမယ် ✅\n\n" +
        `${inviteLink}\n\n` +
        "⚠️ ဒီ link က သင့်အတွက်ပဲ (48 နာရီအတွင်း)"
      : "🎉 VIP အတည်ပြုပြီးပါပြီ!\n" +
        "အောက်က link ကို နှိပ်ပြီး VIP channel ကို join လိုက်ပါ 👇\n\n" +
        `${inviteLink}\n\n` +
        "⚠️ ဒီ link က တစ်ခါပဲ သုံးလို့ရပါတယ်",
  });
}

// ---------------------------------------------------------------------------
// Website VIP auto-sync: after a buyer is approved, tell the PK AI Hub website
// to flip their member plan to LIFETIME. Best-effort: never breaks the invite
// flow. The secret stays in the Vercel env var VIP_SYNC_SECRET (never in the
// sheet or the repo). The Supabase URL + anon key below are public values
// (the anon key ships in the website's public JS) so hardcoding is fine.
// ---------------------------------------------------------------------------
const WEBSITE_SUPABASE_URL = "https://wrudhcqrdbrndgfzxwud.supabase.co";
const WEBSITE_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndydWRoY3FyZGJybmRnZnp4d3VkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5OTYxNjcsImV4cCI6MjEwNTU3MjE2N30.vn0gb0RZ-IconHPboNU2ZMDBZkSNdNjFO1s-rwO5GvE";

async function syncVipToWebsite(send, telegramId, username) {
  try {
    const secret = process.env.VIP_SYNC_SECRET || "";
    if (!secret) {
      console.error("vip sync skipped: VIP_SYNC_SECRET not set");
      return;
    }
    const uname = String(username || "").replace(/^@/, "").toLowerCase();
    const res = await fetch(`${WEBSITE_SUPABASE_URL}/rest/v1/rpc/record_vip_purchase`, {
      method: "POST",
      headers: {
        apikey: WEBSITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${WEBSITE_SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_secret: secret,
        p_username: uname || null,
        p_telegram_id: Number(telegramId) || null,
        p_plan: "LIFETIME",
      }),
    });
    const data = await res.json().catch(() => null);
    console.log("vip sync:", res.status, JSON.stringify(data));
  } catch (err) {
    console.error("vip sync failed:", err.message);
  }
}

// Website password reset: user tapped t.me/Pkaihub_bot?start=reset_<requestId>.
// Fetches the 6-digit code via the secret-gated RPC and DMs it — but ONLY if
// the tapper's Telegram @username matches the username on the reset request.
// ---------------------------------------------------------------------------
async function handlePasswordResetStart(send, msg, requestId) {
  const chatId = msg.chat.id;
  const failText =
    "⚠️ ဒီ link သက်တမ်းကုန်သွားပြီ (သို့) မမှန်ဘူး — website ကနေ ကုဒ်ပြန်တောင်းကြည့်ပါ။";
  try {
    const secret = process.env.VIP_SYNC_SECRET || "";
    if (!secret) {
      console.error("password reset: VIP_SYNC_SECRET not set");
      await send("sendMessage", { chat_id: chatId, text: failText });
      return;
    }
    const res = await fetch(`${WEBSITE_SUPABASE_URL}/rest/v1/rpc/get_password_reset_code`, {
      method: "POST",
      headers: {
        apikey: WEBSITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${WEBSITE_SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_request_id: requestId, p_bot_secret: secret }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || typeof data.code !== "string") {
      await send("sendMessage", { chat_id: chatId, text: failText });
      return;
    }
    const tapper = String(msg.from?.username || "").toLowerCase();
    if (!tapper) {
      await send("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Telegram Settings မှာ @username သတ်မှတ်ပြီးမှ ပြန်နှိပ်ပါ — website မှာသုံးတဲ့ username နဲ့ တူရမယ်။",
      });
      return;
    }
    if (tapper !== String(data.username).toLowerCase()) {
      await send("sendMessage", {
        chat_id: chatId,
        text: `⚠️ ဒီ Telegram အကောင့် (@${tapper}) က @${data.username} နဲ့ မကိုက်ဘူး — ပိုင်ရှင်အကောင့်နဲ့ ဖွင့်ပြီးမှ link ကို ပြန်နှိပ်ပါ။`,
      });
      return;
    }
    await send("sendMessage", {
      chat_id: chatId,
      parse_mode: "Markdown",
      text: `🔐 Password ပြန်ယူမယ့် ကုဒ်:

*${data.code}*

၁၀ မိနစ်အတွင်း website မှာ ရိုက်ထည့်ပါ။ ဒီကုဒ်ကို ဘယ်သူ့ကိုမှ မပေးပါနဲ့။`,
    });
  } catch (err) {
    console.error("password reset start failed:", err.message);
    try {
      await send("sendMessage", {
        chat_id: chatId,
        text: "⚠️ တစ်ခုခု မှားသွားတယ် — ခဏနေမှ ပြန်စမ်းကြည့်ပါ။",
      });
    } catch (_) {}
  }
}

export async function handlePhoto(send, msg) {
  // Slips are only accepted in private chats, never in channels/groups.
  if (!msg.chat || msg.chat.type !== "private") return;

  // Raffle V2: screenshots are retired — guide them to send the phrase.
  // (Slip flow below is untouched.)
  if (isRafflePending(msg.from?.id)) {
    await send("sendMessage", {
      chat_id: msg.chat.id,
      text: "\u{1f4dd} Version 2 \u1019\u103e\u102c screenshot \u1019\u101c\u102d\u102f\u1010\u1031\u102c\u1037\u1018\u1030\u1038\n'Join' \u101c\u102d\u102f\u1037\u1015\u1032 \u{1f447}",
      reply_markup: {
        inline_keyboard: [[{ text: "❌ မလုပ်တော့ဘူး", callback_data: "raffle_cancel" }]],
      },
    });
    return;
  }

  const photos = msg.photo || [];
  if (photos.length === 0) return;
  const user = msg.from || {};
  const who = user.username
    ? `@${user.username}`
    : `${user.first_name || ""} ${user.last_name || ""}`.trim() || "အမည် မသိ";

  const adminId = process.env.ADMIN_TELEGRAM_ID || "";
  if (!adminId) {
    await send("sendMessage", {
      chat_id: msg.chat.id,
      text: "စလစ်လက်ခံမှု မကြာမီ ရရှိပါမယ် 🙏",
    });
    return;
  }

  // Buyer acknowledgment: verification is in progress. The follow-up
  // message depends on the verdict (auto-invite vs manual review).
  await send("sendMessage", {
    chat_id: msg.chat.id,
    text: "⏳ ခနစောင့်ပါ 🙏\nစလစ်စစ်မှန်ပါက VIP channel link ပို့ပေးပါမယ် ✅",
  });

  // Try automatic OCR verification first.
  let verdict = null;
  let slipText = "";
  try {
    const fileId = photos[photos.length - 1].file_id;
    const gf = await send("getFile", { file_id: fileId });
    const fpath = gf && gf.result && gf.result.file_path;
    if (fpath && typeof send.downloadFile === "function") {
      const buf = await send.downloadFile(fpath);
      const { text, strict } = await ocr.image(buf);
      slipText = text || "";
      verdict = verifySlipText(text, strict);
    }
  } catch (err) {
    console.error("slip OCR failed:", err.message);
  }

  // Auto-accept when OCR checks pass.
  if (verdict && verdict.ok) {
    const link = await createVipJoinLink(send, String(user.id));
    if (link) {
      await sendBuyerInvite(send, String(user.id), link.inviteLink, link.joinRequest);
      await syncVipToWebsite(send, String(user.id), user.username);
      await send("copyMessage", {
        chat_id: Number(adminId),
        from_chat_id: msg.chat.id,
        message_id: msg.message_id,
        caption: `🤖 Auto ✅ OCR စစ်ပြီး\n👤 ${who}\n🆔 ${user.id}`,
      });
      return;
    }
    // Link creation failed -> fall through to manual review.
  }

  const flag =
    verdict && !verdict.ok ? `\n⚠️ OCR: ${verdict.reasons.join(", ")}` : "";
  await send("copyMessage", {
    chat_id: Number(adminId),
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
    caption: `🧾 VIP စလစ်အသစ်\n👤 ${who}\n🆔 ${user.id}${flag}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ လက်ခံ", callback_data: `approve:${user.id}` },
          { text: "❌ ငြင်း", callback_data: `reject:${user.id}` },
        ],
      ],
    },
  });

  await send("sendMessage", {
    chat_id: msg.chat.id,
    text: "စလစ်ကို လက်ခံရရှိပါတယ် ✅\nAdmin အတည်ပြုပြီးတာနဲ့ VIP invite link ပို့ပေးပါမယ် 🙏",
  });
}

export async function handleReview(send, query, data) {
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
  const clickerId = String(query.from?.id || "");
  const sep = data.indexOf(":");
  const action = data.slice(0, sep);
  const targetId = data.slice(sep + 1);

  // Only the admin may approve/reject.
  if (adminId && clickerId !== adminId) {
    await send("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Admin မှသာ အတည်ပြုနိုင်ပါတယ်",
      show_alert: true,
    });
    return;
  }
  await send("answerCallbackQuery", { callback_query_id: query.id });

  // Clear the buttons so the same slip can't be decided twice.
  if (query.message) {
    try {
      await send("editMessageReplyMarkup", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      /* best effort */
    }
  }

  if (action === "reject") {
    const s = await getSettings();
    const adminUser =
      s.admin_username || process.env.ADMIN_USERNAME || "";
    await send("sendMessage", {
      chat_id: Number(targetId),
      text:
        "စလစ်အတည်မပြုနိုင်ပါ ❌\n" +
        (adminUser
          ? `အသေးစိတ်ကို ${adminUser} ကို ဆက်သွယ်ပါ 🙏`
          : "Admin ကို ဆက်သွယ်ပါ 🙏"),
    });
    return;
  }

  // approve → per-buyer join-request link (shared with OCR auto-accept).
  const link = await createVipJoinLink(send, targetId);
  if (link) {
    await sendBuyerInvite(send, targetId, link.inviteLink, link.joinRequest);
  } else {
    await send("sendMessage", {
      chat_id: Number(targetId),
      text: "🎉 VIP အတည်ပြုပြီးပါပြီ! Admin က invite link ပို့ပေးပါလိမ့်မယ် 🙏",
    });
  }

  // Website VIP auto-sync (best-effort; buyer username via getChat).
  try {
    const gc = await send("getChat", { chat_id: Number(targetId) });
    const buyerUsername = (gc && gc.result && gc.result.username) || "";
    await syncVipToWebsite(send, targetId, buyerUsername);
  } catch {
    await syncVipToWebsite(send, targetId, "");
  }
}

// ---------------------------------------------------------------------------
// Raffle (ကံစမ်းမဲ): users register with a Facebook share screenshot.
// Entries + draws are logged to the "PK AI Hub Raffle" Google Form; the bot
// reads them back via the response sheet CSV. One entry per user, 4-digit
// numbers are unique, drawn numbers never repeat (test spins don't record).
// ---------------------------------------------------------------------------
const RAFFLE_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSccDic_T-YWOF38RMEtUi4MWDk011LwaGiqbqrPIlmi79QQyA/formResponse";
const RAFFLE_ENTRY = {
  action: "entry.1837583532",
  user_id: "entry.713061467",
  username: "entry.2116005494",
  number: "entry.1822932350",
  date: "entry.59546731",
};
const RAFFLE_READY = RAFFLE_FORM_URL.startsWith("https://docs.google.com/");

const SPIN_LABEL = "🎰 Spin";
const SPIN_TEST_LABEL = "🧪 စမ်းသပ်ရန်";
const RAFFLE_TOGGLE_LABEL = "🚦 မဲပိတ်/ဖွင့်";

// userId -> timestamp: waiting for the raffle screenshot photo.
const rafflePending = new Map();
const RAFFLE_PENDING_TTL_MS = 15 * 60 * 1000;
// number -> timestamp: drawn moments ago (race guard).
const recentRaffleDraws = new Map();
const RECENT_TTL_MS = 5 * 60 * 1000;

function raffleTabUrl(tab) {
  return tabCsvUrl(tab);
}

// Raffle responses tab, addressed by gid so a tab rename can never break the
// read path again (Google renamed "Form_Responses2" to a Burmese name on
// 2026-09-30; gviz then silently served the first tab and the raffle looked
// empty, and every new ticket was numbered 1).
const RAFFLE_GID = "1376592021";
function raffleGidUrl() {
  const base = process.env.SETTINGS_CSV_URL || "";
  const m = base.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return "";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv&gid=${RAFFLE_GID}`;
}

// Fetch raffle rows: try the gid URL first, then the configured/historical
// tab names. Keep the first result whose header really has an "action"
// column, so a wrong name can never silently return another tab's data.
async function fetchRaffleRows() {
  const urls = [];
  const gidUrl = raffleGidUrl();
  if (gidUrl) urls.push(gidUrl);
  try {
    const s = await getSettings();
    for (const t of [s.raffle_tab, "Form_Responses2"]) {
      if (!t) continue;
      const u = raffleTabUrl(t);
      if (u && !urls.includes(u)) urls.push(u);
    }
  } catch (err) {
    console.error("raffle settings read failed:", err.message);
  }
  for (const u of urls) {
    try {
      const rows = await fetchCSV(u, true);
      if (rows && rows.length > 1) {
        const head = rows[0].map((h) => (h || "").trim().toLowerCase());
        if (head.includes("action")) return rows;
      }
    } catch (err) {
      console.error("raffle fetch failed:", err.message);
    }
  }
  return null;
}

function pruneMap(m, ttl) {
  const now = Date.now();
  for (const [k, at] of m) if (now - at > ttl) m.delete(k);
}

function isRafflePending(userId) {
  pruneMap(rafflePending, RAFFLE_PENDING_TTL_MS);
  return rafflePending.has(String(userId));
}

async function postRaffleRow({ action, userId = "", username = "", number = "" }) {
  const body = new URLSearchParams({
    [RAFFLE_ENTRY.action]: action,
    [RAFFLE_ENTRY.user_id]: String(userId),
    [RAFFLE_ENTRY.username]: username,
    [RAFFLE_ENTRY.number]: String(number),
    [RAFFLE_ENTRY.date]: bangkokStamp(),
  });
  await fetch(RAFFLE_FORM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

// entries: number -> {username, userId}; byUser: userId -> number; drawn: Set(number)
// open: registration toggle — latest raffle_open/raffle_close row wins (default open).
// Columns are read by header name, so the leading Timestamp column can't shift them.
async function getRaffleData() {
  const entries = new Map();
  const byUser = new Map();
  const drawn = new Set();
  let open = true;
  try {
    const rows = await fetchRaffleRows();
    if (rows && rows.length > 1) {
      const head = rows[0].map((h) => (h || "").trim().toLowerCase());
      const ai = head.indexOf("action");
      const ui = head.indexOf("user_id");
      const ni = head.indexOf("username");
      const gi = head.indexOf("number");
      if (ai >= 0) {
        for (const r of rows.slice(1)) {
          const action = (r[ai] || "").trim();
          const num = gi >= 0 ? (r[gi] || "").trim() : "";
          if (action === "enter" && /^\d+$/.test(num)) {
            const uid = ui >= 0 ? (r[ui] || "").trim() : "";
            const un = ni >= 0 ? (r[ni] || "").trim() : "";
            entries.set(num, { username: un, userId: uid });
            if (/^\d+$/.test(uid)) byUser.set(uid, num);
          } else if (action === "draw" && num) {
            drawn.add(num);
          } else if (action === "raffle_close") {
            open = false;
          } else if (action === "raffle_open") {
            open = true;
          }
        }
      }
    }
  } catch (err) {
    console.error("raffle read failed:", err.message);
  }
  pruneMap(recentRaffleDraws, RECENT_TTL_MS);
  for (const n of recentRaffleDraws.keys()) drawn.add(n);
  return { entries, byUser, drawn, open };
}

export async function handleRaffleEntry(send, msg) {
  if (!RAFFLE_READY) {
    await send("sendMessage", {
      chat_id: msg.chat.id,
      text: "🛠️ မဲစာရင်း system ပြင်ဆင်နေပါတယ် — ခဏစောင့်ပါ 🙏",
    });
    return;
  }
  const { open: raffleOpen } = await getRaffleData();
  if (!raffleOpen) {
    await send("sendMessage", {
      chat_id: msg.chat.id,
      text: "🚫 မဲစာရင်းပိတ်ထားပါတယ် 🙏",
    });
    return;
  }
  rafflePending.set(String(msg.from?.id || ""), Date.now());
  await send("sendMessage", {
    chat_id: msg.chat.id,
    text: "\u{1f3ab} \u1000\u1036\u1005\u1019\u103a\u1038\u1019\u1032 \u1005\u102c\u101b\u1004\u103a\u1038\u101e\u103d\u1004\u103a\u1038\u101b\u1014\u103a\n\n'Join' \u101c\u102d\u102f\u1037 \u1012\u102e\u1019\u103e\u102c \u1015\u102d\u102f\u1037\u1015\u1031\u1038\u1015\u102b \u{1f4dd}\n\u1010\u1005\u103a\u101a\u1031\u102c\u1000\u103a\u1010\u1005\u103a\u1001\u102b\u1015\u1032 \u1005\u102c\u101b\u1004\u103a\u1038\u101e\u103d\u1004\u103a\u1038\u101c\u102d\u102f\u1037\u101b\u1015\u102b\u1010\u101a\u103a \u{1f340}",
    reply_markup: {
      inline_keyboard: [[{ text: "❌ မလုပ်တော့ဘူး", callback_data: "raffle_cancel" }]],
    },
  });
}

export async function handleRaffleCallback(send, query, data) {
  const userId = String(query.from?.id || "");
  const chatId = query.message.chat.id;
  await send("answerCallbackQuery", { callback_query_id: query.id });
  if (data === "raffle_ss") {
    // Stale V1 button — point it at the V2 phrase flow.
  rafflePending.set(userId, Date.now());
  await send("sendMessage", {
    chat_id: chatId,
    text: "\u{1f3ab} \u1000\u1036\u1005\u1019\u103a\u1038\u1019\u1032 \u1005\u102c\u101b\u1004\u103a\u1038\u101e\u103d\u1004\u103a\u1038\u101b\u1014\u103a\n\n'Join' \u101c\u102d\u102f\u1037 \u1012\u102e\u1019\u103e\u102c \u1015\u102d\u102f\u1037\u1015\u1031\u1038\u1015\u102b \u{1f4dd}\n\u1010\u1005\u103a\u101a\u1031\u102c\u1000\u103a\u1010\u1005\u103a\u1001\u102b\u1015\u1032 \u1005\u102c\u101b\u1004\u103a\u1038\u101e\u103d\u1004\u103a\u1038\u101c\u102d\u102f\u1037\u101b\u1015\u102b\u1010\u101a\u103a \u{1f340}",
    reply_markup: {
      inline_keyboard: [[{ text: "❌ မလုပ်တော့ဘူး", callback_data: "raffle_cancel" }]],
    },
  });
  } else if (data === "raffle_cancel") {
    rafflePending.delete(userId);
    await send("sendMessage", { chat_id: chatId, text: "ဖျက်လိုက်ပါပြီ 👍" });
  }
}

async function handleRafflePhrase(send, msg) {
  // Raffle Version 2: "Join" (any letter case) = one entry.
  // Ticket numbers are sequential (1, 2, 3...); one entry per user.
  const userId = String(msg.from?.id || "");
  const { open: raffleOpen, entries, byUser } = await getRaffleData();
  if (!raffleOpen) {
    rafflePending.delete(userId);
    await send("sendMessage", { chat_id: msg.chat.id, text: "\u{1f6ab} \u1019\u1032\u1005\u102c\u101b\u1004\u103a\u1038\u1015\u102d\u1010\u103a\u1011\u102c\u1038\u1015\u102b\u1010\u101a\u103a \u{1f64f}" });
    return;
  }
  const username = msg.from?.username ? `@${msg.from.username}` : "";
  if (byUser.has(userId)) {
    rafflePending.delete(userId);
    await send("sendMessage", {
      chat_id: msg.chat.id,
      text: `\u2705 \u1005\u102c\u101b\u1004\u103a\u1038\u101e\u103d\u1004\u103a\u1038\u1015\u103c\u102e\u1038\u101e\u102c\u1038\u1015\u102b!\n\u{1f3ab} \u1019\u1032\u1014\u1036\u1015\u102b\u1010\u103a: ${byUser.get(userId)} \u{1f340}`,
    });
    return;
  }
  // Smallest unused positive integer becomes the ticket number.
  const usedNums = new Set(
    [...entries.keys()].map((k) => parseInt(k, 10)).filter((n) => n > 0)
  );
  let ticket = 1;
  while (usedNums.has(ticket)) ticket++;
  await postRaffleRow({ action: "enter", userId, username, number: ticket });
  rafflePending.delete(userId);
  await send("sendMessage", {
    chat_id: msg.chat.id,
    text:
      "\u2705 \u1005\u102c\u101b\u1004\u103a\u1038\u101e\u103d\u1004\u103a\u1038\u1015\u103c\u102e\u1038\u1015\u102b\u1015\u103c\u102e! \u{1f389}\n" +
      `\u{1f3ab} \u1019\u1032\u1014\u1036\u1015\u102b\u1010\u103a: ${ticket}\n` +
      `\u{1f464} ${username || "\u1019\u102d\u1010\u103a\u1006\u103d\u1031"}\n\n` +
      "\u1000\u1036\u1005\u1019\u103a\u1038\u1019\u1032\u1014\u1031\u1037\u1000\u103b \u1000\u1036\u1000\u1031\u102c\u1004\u103a\u1038\u1015\u102b\u1005\u1031 \u{1f340}",
  });
  // Notify the admin about the new entry.
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
  if (adminId && adminId !== userId) {
    try {
      await send("sendMessage", {
        chat_id: adminId,
        text: `\u{1f3ab} \u1019\u1032\u1005\u102c\u101b\u1004\u103a\u1038\u101e\u103d\u1004\u103a\u1038\u101e\u1030 \u1021\u101e\u1005\u103a (V2)!\n\u{1f464} ${username || userId}\n\u{1f522} \u1014\u1036\u1015\u102b\u1010\u103a: ${ticket}`,
      });
    } catch (err) {
      console.error("raffle admin notify failed:", err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// AI auto-reply for Telegram Business Chat Automation.
// The owner connects @Pkaihub_bot at Settings -> Business -> Chatbots; user
// messages arrive as `business_message` updates and the bot answers them with
// Gemini, in the style the admin trained via the admin-only button.
// Config (ai_style, ai_enabled) is stored via the BotConfig Google Form so
// it survives serverless restarts. Settings keys: botconfig_form_url,
// botconfig_key_entry, botconfig_value_entry, botconfig_tab.
// ---------------------------------------------------------------------------
const AI_TRAIN_LABEL = "\u{1f916} AI \u{101c}\u{1031}\u{1037}\u{1000}\u{103b}\u{1004}\u{1037}\u{103a}\u{101b}\u{1014}\u{103a}";
const AI_TOGGLE_LABEL = "\u{1f916} AI \u{1016}\u{103d}\u{1004}\u{1037}\u{103a}/\u{1015}\u{102d}\u{1010}\u{103a}";
const CUR_STYLE_LABEL = "\u{101c}\u{1000}\u{103a}\u{101b}\u{103e}\u{102d}\u{1015}\u{102f}\u{1036}\u{1005}\u{1036}:";
const SEND_NEW_STYLE = "\u{1015}\u{102f}\u{1036}\u{1005}\u{1036}\u{1021}\u{101e}\u{1005}\u{103a}\u{1000}\u{102d}\u{102f} \u{1012}\u{102e}\u{1019}\u{103e}\u{102c} \u{1015}\u{102d}\u{102f}\u{1037}\u{1015}\u{1031}\u{1038}\u{1015}\u{102b} \u{1f4dd}";
const TRAIN_SAVED = "\u{2705} AI \u{1015}\u{102f}\u{1036}\u{1005}\u{1036} \u{101e}\u{102d}\u{1019}\u{103a}\u{1038}\u{1015}\u{103c}\u{102e}\u{1038}\u{1015}\u{103c}\u{102e}!";
const TRAIN_SAVED2 = "\u{1014}\u{1031}\u{102c}\u{1000}\u{103a}\u{1005}\u{102c}\u{1010}\u{103d}\u{1031}\u{1000}\u{102d}\u{102f} \u{1012}\u{102e}\u{1015}\u{102f}\u{1036}\u{1005}\u{1036}\u{1021}\u{1010}\u{102d}\u{102f}\u{1004}\u{103a}\u{1038} \u{1016}\u{103c}\u{1031}\u{1015}\u{1031}\u{1038}\u{1019}\u{101a}\u{103a} \u{1f916}";
const AI_ON = "\u{25b6}\u{fe0f} AI auto-reply \u{1016}\u{103d}\u{1004}\u{1037}\u{103a}\u{101c}\u{102d}\u{102f}\u{1000}\u{103a}\u{1015}\u{103c}\u{102e} \u{2705}";
const AI_OFF = "\u{23f8}\u{fe0f} AI auto-reply \u{1015}\u{102d}\u{1010}\u{103a}\u{101c}\u{102d}\u{102f}\u{1000}\u{103a}\u{1015}\u{103c}\u{102e}";
const AI_SETUP_NEEDED = "\u{1f4cb} Google Form (Bot Config) \u{1021}\u{101b}\u{1004}\u{103a} \u{1006}\u{1031}\u{102c}\u{1000}\u{103a}\u{1015}\u{1031}\u{1038}\u{1015}\u{102b} \u{1f64f}";
const DEFAULT_AI_STYLE = "\u{1019}\u{1004}\u{103a}\u{1038}\u{1000} PK AI Hub \u{101b}\u{1032}\u{1037} customer service assistant \u{1015}\u{102b}\u{104b} \u{1019}\u{103c}\u{1014}\u{103a}\u{1019}\u{102c}\u{101c}\u{102d}\u{102f} (\u{1017}\u{1019}\u{102c}\u{1005}\u{1000}\u{102c}\u{1038}) \u{1014}\u{1032}\u{1037}\u{1015}\u{1032} \u{1016}\u{103c}\u{1031}\u{1015}\u{102b}\u{104b} \u{101e}\u{1030}\u{1004}\u{101a}\u{103a}\u{1001}\u{103b}\u{1004}\u{103a}\u{1038}\u{101c}\u{102d}\u{102f} \u{1001}\u{1004}\u{103a}\u{1001}\u{1004}\u{103a}\u{1019}\u{1004}\u{103a}\u{1019}\u{1004}\u{103a}\u{1014}\u{1032}\u{1037} \u{1010}\u{102d}\u{102f}\u{1010}\u{102d}\u{102f}\u{1010}\u{102f}\u{1010}\u{103a}\u{1010}\u{102f}\u{1010}\u{103a} \u{1016}\u{103c}\u{1031}\u{1015}\u{102b}\u{104b} VIP \u{1021}\u{1000}\u{103c}\u{1031}\u{102c}\u{1004}\u{103a}\u{1038}: Lifetime VIP \u{1000} \u{1019}\u{103c}\u{1014}\u{103a}\u{1019}\u{102c}\u{1004}\u{103d}\u{1031} \u{1041}\u{101e}\u{1031}\u{102c}\u{1004}\u{103a}\u{1038}\u{1000}\u{103b}\u{1015}\u{103a} / \u{1011}\u{102d}\u{102f}\u{1004}\u{103a}\u{1038}\u{1018}\u{1010}\u{103a} \u{1041}\u{1040}\u{1040}\u{104b} \u{101d}\u{101a}\u{103a}\u{101a}\u{1030}\u{101b}\u{1014}\u{103a}: bot \u{1011}\u{1032}\u{1019}\u{103e}\u{102c} VIP \u{101d}\u{1004}\u{103a}\u{1019}\u{100a}\u{103a} \u{1000}\u{102d}\u{102f}\u{1014}\u{103e}\u{102d}\u{1015}\u{103a}\u{1015}\u{102b}\u{104b} \u{1019}\u{101e}\u{102d}\u{1010}\u{1032}\u{1037}\u{1021}\u{1000}\u{103c}\u{1031}\u{102c}\u{1004}\u{103a}\u{1038}\u{1000}\u{102d}\u{102f} \u{1019}\u{101e}\u{102d}\u{1018}\u{1030}\u{1038}\u{101c}\u{102d}\u{102f}\u{1037} \u{101d}\u{1014}\u{103a}\u{1001}\u{1036}\u{1015}\u{102b}\u{104b}";
const aiTrainPending = new Map();
const AI_TRAIN_TTL_MS = 15 * 60 * 1000;
const bizHistory = new Map(); // chatId -> [{role, text}] (best-effort, in-memory)
// business_connection_id -> { ownerId, isEnabled } (best-effort, in-memory).
// Filled from `business_connection` updates; falls back to getBusinessConnection.
const bizConns = new Map();

function botConfigReady(settings) {
  const s = settings || {};
  return !!(
    s.botconfig_form_url &&
    s.botconfig_key_entry &&
    s.botconfig_value_entry &&
    s.botconfig_tab
  );
}

async function postConfigRow(settings, key, value) {
  const s = settings || {};
  const body = new URLSearchParams({
    [s.botconfig_key_entry]: key,
    [s.botconfig_value_entry]: value,
  });
  await fetch(s.botconfig_form_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

// BotConfig form tab -> { key: latest value } (header: Timestamp,key,value).
async function getBotConfig(settings) {
  const cfg = {};
  const tab = (settings && settings.botconfig_tab) || "";
  if (!tab) return cfg;
  try {
    const rows = await fetchCSV(tabCsvUrl(tab), true);
    if (rows && rows.length > 1) {
      const head = rows[0].map((h) => (h || "").trim().toLowerCase());
      const ki = head.indexOf("key");
      const vi = head.indexOf("value");
      if (ki >= 0 && vi >= 0) {
        for (const r of rows.slice(1)) {
          const k = (r[ki] || "").trim();
          if (k) cfg[k] = (r[vi] || "").trim();
        }
      }
    }
  } catch (err) {
    console.error("botconfig read failed:", err.message);
  }
  return cfg;
}

function aiChatStyle(cfg) {
  const v = ((cfg && cfg.ai_style) || "").trim();
  return v || DEFAULT_AI_STYLE;
}

async function askGemini(style, history, userText) {
  const key = process.env.GEMINI_API_KEY || "";
  if (!key) {
    console.error("askGemini: GEMINI_API_KEY not set");
    return null;
  }
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: userText }] },
  ];
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: style }] },
          contents,
          generationConfig: { maxOutputTokens: 500, temperature: 0.7 },
        }),
      }
    );
    if (!res.ok) {
      console.error("askGemini failed:", res.status);
      return null;
    }
    const data = await res.json();
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const t = parts.map((pt) => pt.text || "").join("").trim();
    return t || null;
  } catch (err) {
    console.error("askGemini error:", err.message);
    return null;
  }
}

// Owner id for a business connection: cache first, then the Bot API.
async function resolveBizOwner(send, bcid) {
  const cached = bizConns.get(bcid);
  if (cached && cached.ownerId) return cached.ownerId;
  try {
    const data = await send("getBusinessConnection", {
      business_connection_id: bcid,
    });
    const bc = (data && data.result) || {};
    if (bc && bc.id) {
      bizConns.set(bc.id, {
        ownerId: bc.user && bc.user.id,
        isEnabled: bc.is_enabled !== false,
      });
      if (bc.user && bc.user.id) return bc.user.id;
    }
  } catch {
    // ignore: without an owner id we still answer the customer
  }
  return null;
}

async function handleBusinessMessage(send, biz) {
  // Real Telegram shape: { business_connection_id, message }.
  const bcid = biz && biz.business_connection_id;
  const msg = (biz && biz.message) || {};
  if (!bcid) return;
  const cached = bizConns.get(bcid);
  if (cached && cached.isEnabled === false) return;
  const from = msg.from || {};
  if (from.is_bot) return;
  const ownerId = await resolveBizOwner(send, bcid);
  if (ownerId && String(from.id) === String(ownerId)) return; // owner's own messages
  const text = (msg.text || "").trim();
  if (!text) return; // MVP: text only
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;
  const settings = await getSettings();
  if (!botConfigReady(settings)) return;
  const cfg = await getBotConfig(settings);
  if ((cfg.ai_enabled || "1").trim() === "0") return;
  const style = aiChatStyle(cfg);
  const hist = bizHistory.get(chatId) || [];
  try {
    await send("sendChatAction", {
      chat_id: chatId,
      action: "typing",
      business_connection_id: bcid,
    });
  } catch {
    // ignore typing-indicator failures
  }
  const reply = await askGemini(style, hist.slice(-8), text);
  if (!reply) return;
  hist.push({ role: "user", text }, { role: "model", text: reply });
  bizHistory.set(chatId, hist.slice(-10));
  await send("sendMessage", {
    chat_id: chatId,
    text: reply,
    business_connection_id: bcid,
  });
}

export async function handleSpin(send, msg, isTest) {
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
  if (!adminId || String(msg.from?.id || "") !== adminId) return; // admin only
  const chatId = msg.chat.id;
  if (!RAFFLE_READY) {
    await send("sendMessage", { chat_id: chatId, text: "🛠️ မဲစာရင်း system ပြင်ဆင်နေပါတယ် 🙏" });
    return;
  }
  const { entries, drawn } = await getRaffleData();
  const pool = [...entries.entries()].filter(([num]) => isTest || !drawn.has(num));
  if (!pool.length) {
    const emptyMsg =
      entries.size === 0
        ? "🎰 စာရင်းထဲမှာ မဲမရှိသေးဘူး"
        : "🎰 မဲအားလုံး ကျပြီးပါပြီ! 🎉";
    await send("sendMessage", {
      chat_id: chatId,
      text: isTest ? "🧪 စာရင်းထဲမှာ မဲမရှိသေးဘူး" : emptyMsg,
    });
    return;
  }
  const [num, win] = pool[Math.floor(Math.random() * pool.length)];
  if (!isTest) {
    recentRaffleDraws.set(num, Date.now());
    await postRaffleRow({ action: "draw", userId: win.userId, username: win.username, number: num });
  }
  await send("sendMessage", {
    chat_id: chatId,
    text:
      `${isTest ? "🧪 စမ်းသပ်မှု" : "🎰 ကျသွားတဲ့မဲ!"}\n` +
      `🔢 နံပါတ်: ${num}\n` +
      `👤 ${win.username || "အမည်မသိ"} 🎉` +
      (isTest ? "\n(ဒါ စမ်းသပ်မှုပဲ — မှတ်မထားဘူး)" : ""),
  });
}

// ---------------------------------------------------------------------------
// Message / callback / chat-member handlers
// ---------------------------------------------------------------------------

// 👤 Profile: name, user id, and live VIP status (channel membership).
async function handleProfile(send, msg, settings) {
  const user = msg.from || {};
  const name = `${user.first_name || ""} ${user.last_name || ""}`.trim() || "—";
  const uname = user.username ? `@${user.username}` : "—";
  const channelId =
    (settings && settings.vip_channel_id) || process.env.VIP_CHANNEL_ID || "";
  let vip = false;
  if (channelId) {
    vip = await isChannelMember(send, channelId, user.id);
  }
  await send("sendMessage", {
    chat_id: msg.chat.id,
    text:
      "👤 ပရိုဖိုင်\n" +
      "\n" +
      `• နာမည်: ${name} (${uname})\n` +
      `• 🆔 User ID: ${user.id}\n` +
      `• 💎 VIP: ${vip ? "✅ VIP" : "❌ VIP မဟုတ်သေးပါ"}`,
  });
}

// TikTok downloader (private chats only).
// Paste a TikTok link -> bot sends back the video without watermark.
// Uses the free TikWM API (no key): it returns a watermark-free mp4 URL,
// and Telegram fetches that URL itself via sendVideo, so the bot never
// downloads the file (works on Vercel serverless).
// Short links (vt.tiktok.com / vm.tiktok.com) are resolved first.
// Private/deleted videos and photo slideshows return a friendly error.
// ---------------------------------------------------------------------------
const TIKTOK_URL_RE =
  /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s)>\]]+/i;

export function extractTikTokUrl(text) {
  if (!text) return null;
  const m = String(text).match(TIKTOK_URL_RE);
  if (!m) return null;
  // Strip trailing punctuation left over from copy-paste.
  return m[0].replace(/[.,!?;:)"']+$/, "");
}

async function resolveTikTokShortUrl(url) {
  try {
    const u = new URL(url);
    if (!/^(vt|vm)\.tiktok\.com$/i.test(u.hostname)) return url;
    const res = await fetch(url, { redirect: "follow" });
    try {
      await res.body?.cancel();
    } catch {}
    return res.url || url;
  } catch {
    return url;
  }
}

// Returns { videoUrl, title, author, duration } or null when the video
// can't be fetched. Throws { code: "slideshow" } for photo-mode posts.
async function fetchTikTokInfo(pageUrl) {
  const api =
    "https://www.tikwm.com/api/?url=" + encodeURIComponent(pageUrl);
  let json = null;
  try {
    const res = await fetch(api, { headers: { "User-Agent": "Mozilla/5.0" } });
    json = await res.json();
  } catch {
    return null;
  }
  if (!json || json.code !== 0 || !json.data) return null;
  const d = json.data;
  if (!d.play && d.images && d.images.length > 0) {
    throw { code: "slideshow" };
  }
  if (!d.play) return null;
  return {
    videoUrl: d.play,
    title: d.title || "",
    author: d.author?.nickname || d.author?.unique_id || "",
    duration: d.duration || 0,
  };
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export async function handleTikTokLink(send, msg, pageUrl) {
  const chatId = msg.chat.id;
  let waitId = null;
  try {
    const w = await send("sendMessage", {
      chat_id: chatId,
      text: "⏳ TikTok video ဒေါင်းလုပ်ဆွဲနေပါတယ်...",
    });
    waitId = w?.result?.message_id || null;
  } catch {}
  try {
    const resolved = await resolveTikTokShortUrl(pageUrl);
    const info = await fetchTikTokInfo(resolved);
    if (!info) throw { code: "not_found" };
    const lines = ["🎬 " + (info.title ? info.title.slice(0, 150) : "TikTok video")];
    if (info.author) lines.push("👤 @" + info.author);
    if (info.duration) lines.push("⏱ " + fmtDuration(info.duration));
    lines.push("📥 watermark မပါ");
    const r = await send("sendVideo", {
      chat_id: chatId,
      video: info.videoUrl,
      caption: lines.join("\n"),
      supports_streaming: true,
    });
    if (!r?.ok) {
      const desc = String(r?.description || "");
      if (/too big|file.+too large|wrong file/i.test(desc))
        throw { code: "too_big" };
      throw { code: "send_failed" };
    }
    if (waitId) {
      try {
        await send("deleteMessage", { chat_id: chatId, message_id: waitId });
      } catch {}
    }
  } catch (err) {
    const code = err?.code || "not_found";
    let errText;
    if (code === "too_big") {
      errText =
        "❌ video ကြီးလွန်းလို့ Telegram က လက်မခံဘူး 😅\n" +
        "ဒီ link ကနေ တိုက်ရိုက်ဒေါင်းလို့ရတယ် 👇\n" +
        pageUrl;
    } else if (code === "slideshow") {
      errText =
        "📸 ဒါက photo slideshow မို့ video အနေနဲ့ ဒေါင်းမရဘူး 😅\n" +
        "video link နဲ့မှ ပြန်ပို့ပေးပါ 🙏";
    } else {
      errText =
        "❌ ဒီ link က video ရှာမတွေ့ဘူး 😅\n" +
        "Public video ရဲ့ link အမှန်ဟုတ်မဟုတ် ပြန်စစ်ကြည့်ပါ 🙏";
    }
    if (waitId) {
      try {
        await send("editMessageText", {
          chat_id: chatId,
          message_id: waitId,
          text: errText,
        });
        return;
      } catch {}
    }
    try {
      await send("sendMessage", { chat_id: chatId, text: errText });
    } catch {}
  }
}


export async function handleMessage(send, msg) {
  const chatId = msg.chat.id;
  let text = (msg.text || "").trim();
  // Group slash commands often arrive as /cmd@BotName — strip the mention.
  // Only strip when @ directly follows the command word (no space), so that
  // commands carrying @usernames (e.g. /synclifetime @alice) keep them.
  if (text.startsWith("/") && /^\/[^\s@]+@/.test(text)) {
    text = text.slice(0, text.indexOf("@"));
  }
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
  const isAdmin = !!adminId && String(msg.from?.id || "") === adminId;

  if (msg.photo && msg.photo.length > 0) {
    if (await handleGiftEventPhoto(send, msg)) return;
    await handlePhoto(send, msg);
    return;
  }

  if (msg.sticker) {
    // Playful reply only in private chats; stay silent in groups/channels.
    if (msg.chat?.type === "private") {
      await send("sendMessage", {
        chat_id: chatId,
        text: "Sticker လှတယ် 😄",
      });
    }
    return;
  }

  if (!text) return;

  // Raffle Version 2: "Join" (any letter case) in a private
  // chat registers the sender. Works with or without pending state
  // (serverless instances don't share the in-memory map).
  if (msg.chat?.type === "private" && /^\s*join\s*$/i.test(text)) {
    await handleRafflePhrase(send, msg);
    return;
  }

  // Admin unmute: reply "ဖွင့်" to someone's message to unrestrict them.
  // Without a reply, falls back to the most recently muted user in this chat.
  if (text === "ဖွင့်") {
    if (isAdmin) {
      const rt = msg.reply_to_message?.from;
      let targetId = rt?.id && !rt.is_bot ? String(rt.id) : null;
      if (!targetId) {
        const rec = recentMute.get(String(msg.chat.id));
        if (rec) targetId = rec.userId;
      }
      if (targetId) {
        try {
          await setGiftMute(send, msg.chat.id, targetId, false);
          giftMuted.delete(targetId);
          langWarned.delete(`${msg.chat.id}:${targetId}`);
          cmdWarned.delete(`${msg.chat.id}:${targetId}`);
          recentMute.delete(String(msg.chat.id));
          await send("sendMessage", {
            chat_id: chatId,
            text: "🔓 ပြန်ဖွင့်ပေးလိုက်ပါပြီ ✅",
          });
        } catch (err) {
          await send("sendMessage", {
            chat_id: chatId,
            text: `ပြန်ဖွင့်မရဘူး 😅 (${err.message})`,
          });
        }
      } else {
        await send("sendMessage", {
          chat_id: chatId,
          text: "\u{1f513} mute \u1011\u102c\u1038\u1010\u1032\u101e\u1030 \u1019\u101b\u103e\u102d\u1015\u102b\u1018\u1030\u1038 \u{1f642}",
        });
      }
      return;
    }
  }

  // Button labels are user-editable in the settings sheet (60s cache).
  // Group language rule: English-only text (no Myanmar chars).
  // 1st offense -> warning only; 2nd+ -> mute 1 min.
  // Admin unmute: reply "/ပြန်ဖွင့်ပေးလိုက်" (slash optional) to the muted user's message.
  const chatType = msg.chat?.type || "";
  if (chatType === "group" || chatType === "supergroup") {
    const isUnmuteCmd = text === "/\u1015\u103c\u1014\u103a\u1016\u103d\u1004\u1037\u103a\u1015\u1031\u1038\u101c\u102d\u102f\u1000\u103a" || text === "\u1015\u103c\u1014\u103a\u1016\u103d\u1004\u1037\u103a\u1015\u1031\u1038\u101c\u102d\u102f\u1000\u103a";
    if (isUnmuteCmd) {
      if (isAdmin) {
        const rt = msg.reply_to_message?.from;
        let targetId = rt?.id && !rt.is_bot ? String(rt.id) : null;
        if (!targetId) {
          const rec = recentMute.get(String(msg.chat.id));
          if (rec) targetId = rec.userId;
        }
        if (targetId) {
          try {
            await setGiftMute(send, msg.chat.id, targetId, false);
            giftMuted.delete(targetId);
            langWarned.delete(`${msg.chat.id}:${targetId}`);
            cmdWarned.delete(`${msg.chat.id}:${targetId}`);
            recentMute.delete(String(msg.chat.id));
            await send("sendMessage", {
              chat_id: chatId,
              text: "\u101f\u102f\u1010\u103a\u1000\u1032\u1037 \u1015\u103c\u1014\u103a\u1016\u103d\u1004\u1037\u103a\u1015\u1031\u1038\u101c\u102d\u102f\u1000\u103a\u1015\u102b\u1015\u103c\u102e \u1021\u1000\u102d\u102f \u1000\u103b\u1031\u102c\u103a\u1000\u103c\u102e\u1038",
            });
          } catch (err) {
            await send("sendMessage", {
              chat_id: chatId,
              text: `\u1015\u103c\u1014\u103a\u1016\u103d\u1004\u1037\u103a\u1018\u101b\u1030\u1038 \u{1f605} (${err.message})`,
            });
          }
        } else {
          await send("sendMessage", {
            chat_id: chatId,
            text: "\u1021\u1032\u1037\u101c\u1030\u101b\u1032\u1037\u1005\u102c\u1000\u102d\u102f reply \u101c\u102f\u1015\u103a\u1015\u103c\u102e\u1038 /\u1015\u103c\u1014\u103a\u1016\u103d\u1004\u1037\u103a\u1015\u1031\u1038\u101c\u102d\u102f\u1000\u103a \u1015\u102d\u102f\u1037\u1015\u1031\u1038\u1015\u102b \u{1f64f}",
          });
        }
        return;
      }
      // non-admin: fall through (slash -> unknown-command reply, plain -> silent)
    } else if (
      isEnglishOnlyText(text) &&
      !isAdmin &&
      !msg.from?.is_bot &&
      !text.startsWith("/")
    ) {
      const warnKey = `${msg.chat.id}:${msg.from.id}`;
      try {
        if (!langWarned.has(warnKey)) {
          langWarned.set(warnKey, Date.now());
          await send("sendMessage", {
            chat_id: chatId,
            text: "\u269a\ufe0f \u1014\u1031\u102c\u1000\u103a\u1010\u1005\u103a\u1001\u102b \u1021\u1004\u103a\u1039\u1002\u101c\u102d\u1015\u103a\u1005\u102c\u101e\u1015\u103a\u101e\u1015\u103a\u1015\u102d\u102f\u1037\u101b\u1004\u103a 1 \u1019\u102d\u1014\u1005\u103a mute \u1019\u101a\u103a \u23f3",
          });
        } else {
          await muteTemp(send, chatId, msg.from.id, 60);
          await send("sendMessage", {
            chat_id: chatId,
            text: "\u269a\ufe0f Group \u1011\u1032\u1019\u103e\u102c \u1019\u103c\u1014\u103a\u1019\u102c\u1005\u102c\u1014\u1032\u1037\u1015\u1032 \u1015\u103c\u1031\u102c\u1015\u1031\u1038\u1015\u102b \u{1f64f}\n1 \u1019\u102d\u1014\u1005\u103a mute \u1011\u102c\u1038\u1015\u102b\u1010\u101a\u103a \u23f3",
          });
        }
      } catch (err) {
        console.error("group lang rule failed:", err.message);
      }
      return;
    }
  }

  const settings = await getSettings();
  const L = getLabels(settings);

  // Group discipline: members tapping menu buttons or /commands in groups.
  // 1st tap -> warning, 2nd+ -> 1-minute mute. Admins and bots are exempt.
  if ((chatType === "group" || chatType === "supergroup") && !isAdmin && !msg.from?.is_bot) {
    const menuBtns = [L.vip, L.gift, L.tiktok, L.slip, L.help, L.profile, L.raffle];
    if (menuBtns.includes(text) || text.startsWith("/")) {
      const warnKey = `${msg.chat.id}:${msg.from.id}`;
      try {
        if (!cmdWarned.has(warnKey)) {
          cmdWarned.set(warnKey, Date.now());
          await send("sendMessage", {
            chat_id: chatId,
            text: "\u269a\ufe0f Group \u1011\u1032\u1019\u103e\u102c bot \u1000\u102d\u102f \u1019\u1014\u103e\u102d\u1015\u103a\u1015\u102b\u1014\u1032\u1037 \u{1f64f}\nPrivate \u1019\u103e\u102c\u1015\u1032\u101e\u102f\u1036\u1038\u1015\u102b \u{1f449} @Pkaihub_bot\n\u1014\u1031\u102c\u1000\u103a\u1010\u1005\u103a\u1001\u102b \u1011\u1015\u103a\u101c\u102f\u1015\u103a\u101b\u1004\u103a 1 \u1019\u102d\u1014\u1005\u103a mute \u1019\u100a\u103a \u23f3",
          });
        } else {
          await muteTemp(send, chatId, msg.from.id, 60);
          await send("sendMessage", {
            chat_id: chatId,
            text: "\u269a\ufe0f \u1011\u1015\u103a\u1014\u103e\u102d\u1015\u103a\u101c\u102d\u102f\u1037 1 \u1019\u102d\u1014\u1005\u103a mute \u101c\u102d\u102f\u1000\u103a\u1015\u103c\u102e \u23f3\u{1f64f}",
          });
        }
      } catch (err) {
        console.error("group command rule failed:", err.message);
      }
      return;
    }
  }

  // Typing anything else cancels raffle-photo mode.
  if (text && text !== L.raffle) rafflePending.delete(String(msg.from?.id || ""));

  // TikTok downloader: bare link or /tiktok <link>, private chats only.
  // (In groups a bare URL hits the English-only rule above, so this stays null.)
  const tiktokUrl = chatType === "private" ? extractTikTokUrl(text) : null;

  // AI training: the admin's next message after tapping the train button
  // becomes the new AI style — unless it's another button/command.
  pruneMap(aiTrainPending, AI_TRAIN_TTL_MS);
  const aiKey = String(msg.from?.id || "");
  const knownBtn = [L.vip, L.gift, L.tiktok, L.slip, L.help, L.profile, L.raffle, SPIN_LABEL, SPIN_TEST_LABEL, RAFFLE_TOGGLE_LABEL, AI_TRAIN_LABEL, AI_TOGGLE_LABEL];
  if (isAdmin && text && aiTrainPending.has(aiKey) && !knownBtn.includes(text) && !text.startsWith("/")) {
    aiTrainPending.delete(aiKey);
    if (!botConfigReady(settings)) {
      await send("sendMessage", { chat_id: chatId, text: AI_SETUP_NEEDED });
      return;
    }
    await postConfigRow(settings, "ai_style", text);
    await send("sendMessage", {
      chat_id: chatId,
      text: TRAIN_SAVED + "\n\n" + TRAIN_SAVED2,
    });
    return;
  }

  // Telegram Business "Manage Bot" deep link: /start bizChat<user_chat_id>.
  // Treat it exactly like /start (welcome + menu).
  // Password-reset deep link from the website: t.me/Pkaihub_bot?start=reset_<id>.
  // No force-join gate here: this is an account-recovery flow, keep it frictionless.
  // The bot verifies the tapper's Telegram @username matches the reset request
  // before revealing the code, so a stolen link is useless.
  if (/^\/start\s+reset_[A-Za-z0-9_-]{1,64}$/.test(text)) {
    const requestId = text.split(/\s+/)[1].slice("reset_".length);
    await handlePasswordResetStart(send, msg, requestId);
    return;
  }

  if (text === "/start" || /^\/start\s+bizChat\d+$/.test(text)) {
    if (await forceJoinGate(send, msg, settings)) return;
    const name = msg.from?.first_name || "မိတ်ဆွေ";
    await send("sendMessage", {
      chat_id: chatId,
      text: welcomeText(settings, name),
      reply_markup: mainKeyboard(L, isAdmin),
    });
  } else if (text === "/help") {
    if (await forceJoinGate(send, msg, settings)) return;
    await send("sendMessage", { chat_id: chatId, text: HELP_TEXT });
  } else if (text === "/vip") {
    if (await forceJoinGate(send, msg, settings)) return;
    await handleVip(send, chatId, msg);
  } else if (text === L.vip) {
    // bottom-menu button (reply keyboard)
    if (await forceJoinGate(send, msg, settings)) return;
    await handleVip(send, chatId, msg);
  } else if (text === L.gift) {
    // bottom-menu button (reply keyboard)
    if (await forceJoinGate(send, msg, settings)) return;
    await handleGift(send, msg);
  } else if (text === L.slip) {
    // bottom-menu button (reply keyboard)
    if (await forceJoinGate(send, msg, settings)) return;
    await sendSlipPrompt(send, chatId);
  } else if (text === L.help) {
    // bottom-menu button (reply keyboard)
    if (await forceJoinGate(send, msg, settings)) return;
    await send("sendMessage", { chat_id: chatId, text: HELP_TEXT });
  } else if (text === L.profile) {
    // bottom-menu button (reply keyboard)
    if (await forceJoinGate(send, msg, settings)) return;
    await handleProfile(send, msg, settings);
  } else if (text === L.raffle) {
    // bottom-menu button (reply keyboard)
    if (await forceJoinGate(send, msg, settings)) return;
    await handleRaffleEntry(send, msg);
  } else if (text === L.tiktok) {
    // TikTok downloader menu button: prompt for a link (private chats only).
    if (chatType !== "private") {
      await send("sendMessage", {
        chat_id: chatId,
        text: "📥 TikTok downloader က bot ရဲ့ private chat မှာပဲ သုံးလို့ရတယ် 🙏",
      });
    } else {
      await send("sendMessage", {
        chat_id: chatId,
        text:
          "📥 TikTok video ဒေါင်းလုပ်ဆွဲမယ်\n\n" +
          "link ကို ဒီမှာပို့ပေးပါ 👇\n" +
          "(tiktok.com / vt.tiktok.com link တွေ ရတယ်, watermark မပါ)",
      });
    }
  } else if (text === SPIN_LABEL && isAdmin) {
    if (await forceJoinGate(send, msg, settings)) return;
    await handleSpin(send, msg, false);
  } else if (text === SPIN_TEST_LABEL && isAdmin) {
    if (await forceJoinGate(send, msg, settings)) return;
    await handleSpin(send, msg, true);
  } else if (text === RAFFLE_TOGGLE_LABEL && isAdmin) {
    if (await forceJoinGate(send, msg, settings)) return;
    const { open } = await getRaffleData();
    const uname = msg.from?.username ? `@${msg.from.username}` : "";
    await postRaffleRow({
      action: open ? "raffle_close" : "raffle_open",
      userId: String(msg.from?.id || ""),
      username: uname,
    });
    await send("sendMessage", {
      chat_id: chatId,
      text: open ? "🔴 မဲစာရင်းပိတ်လိုက်ပြီ" : "🟢 မဲစာရင်းဖွင့်လိုက်ပြီ",
    });
  } else if (text === AI_TRAIN_LABEL && isAdmin) {
    if (await forceJoinGate(send, msg, settings)) return;
    if (!botConfigReady(settings)) {
      await send("sendMessage", { chat_id: chatId, text: AI_SETUP_NEEDED });
      return;
    }
    aiTrainPending.set(String(msg.from?.id || ""), Date.now());
    const cfg = await getBotConfig(settings);
    const cur = aiChatStyle(cfg).slice(0, 400);
    await send("sendMessage", {
      chat_id: chatId,
      text: AI_TRAIN_LABEL + "\n\n" + CUR_STYLE_LABEL + "\n" + cur + "\n\n" + SEND_NEW_STYLE,
    });
  } else if (text === AI_TOGGLE_LABEL && isAdmin) {
    if (await forceJoinGate(send, msg, settings)) return;
    if (!botConfigReady(settings)) {
      await send("sendMessage", { chat_id: chatId, text: AI_SETUP_NEEDED });
      return;
    }
    const bcfg = await getBotConfig(settings);
    const on = (bcfg.ai_enabled || "1").trim() !== "0";
    await postConfigRow(settings, "ai_enabled", on ? "0" : "1");
    await send("sendMessage", { chat_id: chatId, text: on ? AI_OFF : AI_ON });
  } else if (text.startsWith("/synclifetime") && isAdmin) {
    // Admin backfill: /synclifetime @user1 @user2 ...
    // Flips each username's website plan to LIFETIME (ledger recorded even
    // without a website account yet — they get LIFETIME on signup).
    const names = text
      .split(/\s+/)
      .slice(1)
      .map((s) => s.replace(/^@/, "").trim().toLowerCase())
      .filter((s) => /^[a-z0-9_]{5,32}$/.test(s));
    if (names.length === 0) {
      await send("sendMessage", {
        chat_id: chatId,
        text: "အသုံးပြုပုံ:\n/synclifetime @user1 @user2 @user3\n\nVIP channel ထဲက member တွေရဲ့ username တွေ ထည့်ပေးပါ — website မှာ LIFETIME ပြောင်းပေးမယ် ✅",
      });
    } else {
      let ok = 0;
      for (const u of names) {
        await syncVipToWebsite(send, null, u);
        ok++;
      }
      await send("sendMessage", {
        chat_id: chatId,
        text: `✅ ${ok} ယောက် sync လုပ်ပြီးပြီ — website မှာ LIFETIME ဖြစ်မယ် 🎉\n(username နဲ့ website account ရှိတဲ့သူ ချက်ချင်း, မရှိသေးတဲ့သူ နောက် sign up လုပ်မှ ရမယ်)`,
      });
    }
  } else if (text === "/lifetime") {
    // Self-service website LIFETIME claim for VIP channel members.
    if (chatType !== "private") {
      await send("sendMessage", {
        chat_id: chatId,
        text: "bot ရဲ့ private chat မှာ လာရိုက်ပါ 🙏",
      });
    } else {
      await handleLifetimeClaim(send, msg);
    }
  } else if (text === "/tiktok" || text.startsWith("/tiktok ")) {
    // TikTok downloader command — private chats only.
    if (chatType !== "private") {
      await send("sendMessage", {
        chat_id: chatId,
        text: "📥 TikTok downloader က bot ရဲ့ private chat မှာပဲ သုံးလို့ရတယ် 🙏",
      });
    } else if (tiktokUrl) {
      if (await forceJoinGate(send, msg, settings)) return;
      await handleTikTokLink(send, msg, tiktokUrl);
    } else {
      await send("sendMessage", {
        chat_id: chatId,
        text:
          "အသုံးပြုပုံ:\n/tiktok <tiktok link>\n\nဒါမှမဟုတ် link ကို ဒီတိုင်းပို့လိုက်ရုံပဲ 📥",
      });
    }
  } else if (tiktokUrl) {
    // Bare TikTok link pasted in a private chat.
    if (await forceJoinGate(send, msg, settings)) return;
    await handleTikTokLink(send, msg, tiktokUrl);
  } else if (text === "/time") {
    await send("sendMessage", {
      chat_id: chatId,
      text: `🕐 အခုအချိန် (မြန်မာ):\n${yangonTime()}`,
    });
  } else if (text === "/dice") {
    await send("sendDice", { chat_id: chatId, emoji: "🎲" });
  } else if (text.startsWith("/")) {
    await send("sendMessage", {
      chat_id: chatId,
      text: `«${text}» ဆိုတဲ့ command ကို မသိဘူး 😅\n/help လို့ ရိုက်ကြည့်ပါ။`,
    });
    // NOTE: plain-text echo was removed on purpose (2026-09-23) —
    // the bot now stays silent on ordinary text.
  }
}

export async function handleCallback(send, query) {
  const chatId = query.message.chat.id;
  const data = query.data || "";
  const cbAdminId = String(process.env.ADMIN_TELEGRAM_ID || "");
  const cbIsAdmin = !!cbAdminId && String(query.from?.id || "") === cbAdminId;

  // Approve/reject buttons answer the query themselves (may show an alert).
  if (data.startsWith("approve:") || data.startsWith("reject:")) {
    await handleReview(send, query, data);
    return;
  }

  if (data.startsWith("gift_accept:") || data.startsWith("gift_reject:")) {
    await handleGiftReview(send, query, data);
    return;
  }

  if (data === "raffle_ss" || data === "raffle_cancel") {
    await handleRaffleCallback(send, query, data);
    return;
  }

  if (data === "verify_join") {
    const s = await getSettings();
    const fj = forceJoinChannel(s);
    const userId = query.from && query.from.id;
    const okMember = !fj || (await isChannelMember(send, fj, userId));
    if (okMember) {
      await send("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "✅ Channel join ပြီးပါပြီ!",
      });
      const name = (query.from && query.from.first_name) || "မိတ်ဆွေ";
      await send("sendMessage", {
        chat_id: chatId,
        text: welcomeText(s, name),
        reply_markup: mainKeyboard(getLabels(s), cbIsAdmin),
      });
    } else {
      await send("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "🔒 Channel ကို အရင် join ပေးပါ 🙏",
        show_alert: true,
      });
    }
    return;
  }

  // Acknowledge the button press so the loading spinner disappears.
  await send("answerCallbackQuery", { callback_query_id: query.id });

  if (data === "about") {
    await send("sendMessage", {
      chat_id: chatId,
      text:
        "ℹ️ ဒီ bot အကြောင်း:\n" +
        "• PK AI Hub ရဲ့ Telegram bot 🤖\n" +
        "• Vercel serverless (webhook) နဲ့ run ထားတာ\n" +
        "• Pupu က ဆောက်ပေးထားတာ",
    });
  } else if (data === "gift") {
    await handleGift(send, { chat: { id: chatId }, from: query.from });
  } else if (data === "vip_about") {
    await editVipScreen(send, query, VIP_ABOUT_TEXT, vipBackKeyboard());
  } else if (data === "vip_pay") {
    // copy_text button: one tap copies the number straight to the clipboard.
    // (plain buttons can never touch the clipboard - Telegram rule).
    await editVipScreen(
      send,
      query,
      VIP_PAY_TEXT,
      {
        inline_keyboard: [
          [
            { text: "📋 နံပါတ်ကော်ပီယူရန်", copy_text: { text: KPAY_NUMBER } },
            { text: "📤 စလစ်ပို့ရန်", callback_data: "send_slip" },
          ],
          [{ text: "⬅️ Back", callback_data: "vip_back" }],
        ],
      },
      "Markdown"
    );
  } else if (data === "vip_back") {
    await editVipScreen(send, query, vipMainText(!!(query.from && query.from.username)), vipMainKeyboard());
  } else if (data === "send_slip") {
    await sendSlipPrompt(send, chatId);
  } else if (data === "time") {
    await send("sendMessage", {
      chat_id: chatId,
      text: `🕐 အခုအချိန် (မြန်မာ):\n${yangonTime()}`,
    });
  } else if (data === "dice") {
    await send("sendDice", { chat_id: chatId, emoji: "🎲" });
  } else if (data === "help") {
    await send("sendMessage", { chat_id: chatId, text: HELP_TEXT });
  }
}

// Welcome new channel/group members.
// Telegram sends a `chat_member` update when someone joins, but only if
// the bot is an administrator and `chat_member` is in allowed_updates.
export async function handleChatMember(send, cmu) {
  const oldStatus = cmu.old_chat_member?.status;
  const newMember = cmu.new_chat_member;
  const newStatus = newMember?.status;

  // Joined: was left/kicked, now a member (or admin/creator).
  const joined =
    (oldStatus === "left" || oldStatus === "kicked") &&
    (newStatus === "member" ||
      newStatus === "administrator" ||
      newStatus === "creator");
  if (!joined) return;

  const user = newMember.user || {};
  const mention = user.username ? `@${user.username}` : user.first_name || "မိတ်ဆွေ";

  await send("sendMessage", {
    chat_id: cmu.chat.id,
    text: `🎉 PK AI Hub Telegram Channel မှ ကြိုဆိုပါတယ် ${mention}!`,
    // Ephemeral (Bot API 10.3): only the new member sees this message.
    ephemeral_message_parameters: { receiver_user_id: user.id },
  });

  // VIP channel join → auto-flip the website plan to LIFETIME (best-effort).
  // Safety net for manually-added members or joins that missed the sync.
  if (!user.is_bot) {
    try {
      const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
      const settings = await getSettings();
      const vipChannelId =
        (settings && settings.vip_channel_id) || process.env.VIP_CHANNEL_ID || "";
      if (
        vipChannelId &&
        String(cmu.chat.id) === String(vipChannelId) &&
        String(user.id) !== adminId
      ) {
        await syncVipToWebsite(send, user.id, user.username);
      }
    } catch (err) {
      console.error("vip join sync failed:", err.message);
    }
  }
}

// Auto-accept VIP join requests.
// Invite links are created per buyer with name "VIP-<buyerId>".
// Only the matching buyer is approved; everyone else is declined.
export async function handleChatJoinRequest(send, cjr) {
  const chatId = cjr.chat && cjr.chat.id;
  const fromId = cjr.from && cjr.from.id;
  const link = (cjr.invite_link && cjr.invite_link.invite_link) || "";
  const linkName = (cjr.invite_link && cjr.invite_link.name) || "";
  const m = /^VIP-(\d+)$/.exec(linkName);
  if (!chatId || !fromId || !m) return;
  if (m[1] === String(fromId)) {
    try {
      const r = await send("approveChatJoinRequest", {
        chat_id: chatId,
        user_id: fromId,
      });
      // Single-use: kill the link once its owner is in.
      if (r && r.ok && link) {
        try {
          await send("revokeChatInviteLink", {
            chat_id: chatId,
            invite_link: link,
          });
        } catch {
          /* best effort */
        }
      }
      if (r && r.ok) {
        try {
          await send("sendMessage", {
            chat_id: fromId,
            text:
              "🎉 VIP channel မှာ လက်ခံပြီးပါပြီ!\n" +
              "စတင်ဝင်ရောက်နိုင်ပါပြီ ✅",
          });
        } catch {
          /* best effort */
        }
      }
    } catch (err) {
      console.error("approveChatJoinRequest failed:", err.message);
    }
  } else {
    try {
      await send("declineChatJoinRequest", { chat_id: chatId, user_id: fromId });
    } catch (err) {
      console.error("declineChatJoinRequest failed:", err.message);
    }
  }
}

export async function handleLifetimeClaim(send, msg) {
  const chatId = msg.chat.id;
  const user = msg.from || {};
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
  const settings = await getSettings();
  const vipChannelId =
    (settings && settings.vip_channel_id) || process.env.VIP_CHANNEL_ID || "";
  if (!vipChannelId) {
    await send("sendMessage", {
      chat_id: chatId,
      text: "VIP channel မသတ်မှတ်ရသေးပါ 😅",
    });
    return;
  }
  // The website links accounts by Telegram username.
  const username = String(user.username || "").toLowerCase();
  if (!username) {
    await send("sendMessage", {
      chat_id: chatId,
      text: "⚠️ Telegram username အရင်ထားပေးပါ 🙏\n(Settings → Edit profile → Username)\nပြီးမှ /lifetime ပြန်ရိုက်ပါ",
    });
    return;
  }
  // Verify real VIP channel membership — no self-claim without membership.
  let status = "";
  try {
    const r = await send("getChatMember", {
      chat_id: vipChannelId,
      user_id: user.id,
    });
    status = r && r.ok && r.result ? r.result.status : "";
  } catch (err) {
    console.error("getChatMember failed:", err.message);
  }
  const isMember =
    status === "member" ||
    status === "administrator" ||
    status === "creator";
  if (!isMember) {
    await send("sendMessage", {
      chat_id: chatId,
      text: "😅 VIP channel ထဲ member မဟုတ်သေးဘူးနော်\nVIP ဝင်ချင်ရင် /vip ကို နှိပ်ပါ 💎",
    });
    return;
  }
  await syncVipToWebsite(send, user.id, username);
  await send("sendMessage", {
    chat_id: chatId,
    text: `🎉 Website မှာ LIFETIME ရသွားပြီ!\n@${username} ဆိုတဲ့ username နဲ့ website မှာ log in / sign up လုပ်လိုက်ပါ ✅`,
  });
  // Admin notification.
  if (adminId) {
    try {
      await send("sendMessage", {
        chat_id: Number(adminId),
        text: `🔔 Website LIFETIME claim\n👤 @${username}\n🆔 ${user.id}\nVIP channel member စစ်ပြီး ✅`,
      });
    } catch (err) {
      console.error("lifetime admin notify failed:", err.message);
    }
  }
}

export async function handleUpdate(send, update) {
  if (update.message) {
    await handleMessage(send, update.message);
  } else if (update.business_message) {
    await handleBusinessMessage(send, update.business_message);
  } else if (update.business_connection) {
    const bc = update.business_connection || {};
    if (bc.id) {
      if (bc.is_enabled) {
        bizConns.set(bc.id, {
          ownerId: bc.user && bc.user.id,
          isEnabled: true,
        });
      } else {
        bizConns.delete(bc.id);
      }
    }
    if (!bc.is_enabled && bc.user_chat_id) bizHistory.delete(bc.user_chat_id);
  } else if (update.callback_query) {
    await handleCallback(send, update.callback_query);
  } else if (update.chat_member) {
    await handleChatMember(send, update.chat_member);
  } else if (update.chat_join_request) {
    await handleChatJoinRequest(send, update.chat_join_request);
  }
}

// Default transport: direct HTTPS call to the Bot API.
export function makeSender(token) {
  const base = `https://api.telegram.org/bot${token}`;
  const send = async (method, params = {}) => {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("Telegram API error:", method, JSON.stringify(data));
    }
    return data;
  };
  // Download a file (e.g. a slip photo) by its file_path from getFile.
  send.downloadFile = async (filePath) => {
    const res = await fetch(
      `https://api.telegram.org/file/bot${token}/${filePath}`
    );
    if (!res.ok) throw new Error("download failed: " + res.status);
    return Buffer.from(await res.arrayBuffer());
  };
  return send;
}
