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
    slip: s.btn_slip || DEFAULT_LABELS.slip,
    help: s.btn_help || DEFAULT_LABELS.help,
    profile: s.btn_profile || DEFAULT_LABELS.profile,
    raffle: s.btn_raffle || DEFAULT_LABELS.raffle,
  };
}

export function mainKeyboard(labels, isAdmin = false) {
  const L = labels || DEFAULT_LABELS;
  const kb = [
    [{ text: L.vip }, { text: L.gift }],
    [{ text: L.slip }, { text: L.help }],
    [{ text: L.profile }, { text: L.raffle }],
  ];
  // Spin buttons are visible to the admin only.
  if (isAdmin) kb.push([{ text: SPIN_LABEL }, { text: SPIN_TEST_LABEL }]);
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

const KPAY_NUMBER = "09788922566";
const KPAY_NAME = "Ma Pan Ei Phyu";

const VIP_MAIN_TEXT =
  "💎 PK AI Hub VIP\n" +
  "\n" +
  "🎉 တသက်တာ Lifetime — မြန်မာငွေ ၁သောင်းကျပ် / ထိုင်းဘတ် ၁၀၀ ပဲဖြစ်ပါတယ် 🇲🇲🇹🇭\n" +
  "\n" +
  "👇 VIP အကြောင်းအသေးစိတ် သိချင်ရင် အောက်ကခလုတ်ကို နှိပ်ပြီးဖတ်ကြည့်ပါ 👇";

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
  "📱 KPay: `09788922566`\n" +
  "👤 Name: Ma Pan Ei Phyu\n" +
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

export async function handleVip(send, chatId) {
  await send("sendMessage", {
    chat_id: chatId,
    text: VIP_MAIN_TEXT,
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
  const base = process.env.SETTINGS_CSV_URL || "";
  if (!base) return "";
  const enc = encodeURIComponent(tab);
  if (/[?&]sheet=/.test(base)) return base.replace(/([?&])sheet=[^&]*/, `$1sheet=${enc}`);
  return `${base}${base.includes("?") ? "&" : "?"}sheet=${enc}`;
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
  const nameTokens = ["ma", "pan", "ei", "phyu"];
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

export async function handlePhoto(send, msg) {
  // Slips are only accepted in private chats, never in channels/groups.
  if (!msg.chat || msg.chat.type !== "private") return;

  // Raffle screenshot flow takes precedence over the slip flow.
  if (isRafflePending(msg.from?.id)) {
    await handleRafflePhoto(send, msg);
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
  try {
    const fileId = photos[photos.length - 1].file_id;
    const gf = await send("getFile", { file_id: fileId });
    const fpath = gf && gf.result && gf.result.file_path;
    if (fpath && typeof send.downloadFile === "function") {
      const buf = await send.downloadFile(fpath);
      const { text, strict } = await ocr.image(buf);
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

// userId -> timestamp: waiting for the raffle screenshot photo.
const rafflePending = new Map();
const RAFFLE_PENDING_TTL_MS = 15 * 60 * 1000;
// number -> timestamp: handed out / drawn moments ago (race guards).
const recentRaffleNumbers = new Map();
const recentRaffleDraws = new Map();
const RECENT_TTL_MS = 5 * 60 * 1000;

function raffleTabUrl(tab) {
  const base = process.env.SETTINGS_CSV_URL || "";
  if (!base) return "";
  const enc = encodeURIComponent(tab);
  if (/[?&]sheet=/.test(base)) return base.replace(/([?&])sheet=[^&]*/, `$1sheet=${enc}`);
  return `${base}${base.includes("?") ? "&" : "?"}sheet=${enc}`;
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
async function getRaffleData() {
  const entries = new Map();
  const byUser = new Map();
  const drawn = new Set();
  try {
    const s = await getSettings();
    const rows = await fetchCSV(raffleTabUrl(s.raffle_tab || "Raffle"), true);
    for (const r of (rows || []).slice(1)) {
      const action = (r[0] || "").trim();
      const num = (r[3] || "").trim();
      if (action === "enter" && /^\d{4}$/.test(num)) {
        const uid = (r[1] || "").trim();
        const un = (r[2] || "").trim();
        entries.set(num, { username: un, userId: uid });
        if (/^\d+$/.test(uid)) byUser.set(uid, num);
      } else if (action === "draw" && num) {
        drawn.add(num);
      }
    }
  } catch (err) {
    console.error("raffle read failed:", err.message);
  }
  pruneMap(recentRaffleDraws, RECENT_TTL_MS);
  for (const n of recentRaffleDraws.keys()) drawn.add(n);
  return { entries, byUser, drawn };
}

function pickRaffleNumber(used) {
  pruneMap(recentRaffleNumbers, RECENT_TTL_MS);
  const taken = new Set([...used, ...recentRaffleNumbers.keys()]);
  for (let i = 0; i < 200; i++) {
    const n = String(Math.floor(1000 + Math.random() * 9000));
    if (!taken.has(n)) return n;
  }
  return null;
}

export async function handleRaffleEntry(send, msg) {
  if (!RAFFLE_READY) {
    await send("sendMessage", {
      chat_id: msg.chat.id,
      text: "🛠️ မဲစာရင်း system ပြင်ဆင်နေပါတယ် — ခဏစောင့်ပါ 🙏",
    });
    return;
  }
  await send("sendMessage", {
    chat_id: msg.chat.id,
    text:
      "🎫 ကံစမ်းမဲ စာရင်းသွင်းရန်\n\n" +
      "Facebook မှာ post ကို share ထားတဲ့ screenshot ပုံကို ပို့ပေးပါ 📸\n" +
      "Share ထားတဲ့ပုံမှန်ရင် auto လက်ခံပြီး မဲနံပါတ် (4 လုံး) ပေးမယ် ✅",
    reply_markup: {
      inline_keyboard: [[{ text: "📸 ssပုံပို့ရန်", callback_data: "raffle_ss" }]],
    },
  });
}

export async function handleRaffleCallback(send, query, data) {
  const userId = String(query.from?.id || "");
  const chatId = query.message.chat.id;
  await send("answerCallbackQuery", { callback_query_id: query.id });
  if (data === "raffle_ss") {
    rafflePending.set(userId, Date.now());
    await send("sendMessage", {
      chat_id: chatId,
      text: "📸 share screenshot ပုံကို ဒီမှာ ပို့ပေးပါ 👇",
      reply_markup: {
        inline_keyboard: [[{ text: "❌ မလုပ်တော့ဘူး", callback_data: "raffle_cancel" }]],
      },
    });
  } else if (data === "raffle_cancel") {
    rafflePending.delete(userId);
    await send("sendMessage", { chat_id: chatId, text: "ဖျက်လိုက်ပါပြီ 👍" });
  }
}

async function handleRafflePhoto(send, msg) {
  const userId = String(msg.from?.id || "");
  const username = msg.from?.username ? `@${msg.from.username}` : "";
  let text = "";
  try {
    const photos = msg.photo || [];
    const fileId = photos[photos.length - 1].file_id;
    const gf = await send("getFile", { file_id: fileId });
    const fpath = gf && gf.result && gf.result.file_path;
    if (fpath && typeof send.downloadFile === "function") {
      const buf = await send.downloadFile(fpath);
      ({ text } = await ocr.image(buf));
    }
  } catch (err) {
    console.error("raffle OCR failed:", err.message);
  }
  const nospace = (text || "").toLowerCase().replace(/\s+/g, "");
  if (!nospace.includes("museai")) {
    await send("sendMessage", {
      chat_id: msg.chat.id,
      text:
        "❌ Share ထားတဲ့ပုံမဟုတ်ပါ😅\n" +
        "Facebook share screenshot အမှန်ကို ပြန်ပို့ပေးပါ 📸",
      reply_markup: {
        inline_keyboard: [[{ text: "❌ မလုပ်တော့ဘူး", callback_data: "raffle_cancel" }]],
      },
    });
    return; // stay pending so they can retry
  }
  const { entries, byUser } = await getRaffleData();
  if (byUser.has(userId)) {
    rafflePending.delete(userId);
    await send("sendMessage", {
      chat_id: msg.chat.id,
      text: `✅ စာရင်းသွင်းပြီးသားပါ!\n🎫 မဲနံပါတ်: ${byUser.get(userId)} 🍀`,
    });
    return;
  }
  const num = pickRaffleNumber(entries.keys());
  if (!num) {
    await send("sendMessage", {
      chat_id: msg.chat.id,
      text: "😅 မဲနံပါတ်တွေ ကုန်သွားပြီ — admin ကို ဆက်သွယ်ပါ 🙏",
    });
    return;
  }
  recentRaffleNumbers.set(num, Date.now());
  await postRaffleRow({ action: "enter", userId, username, number: num });
  rafflePending.delete(userId);
  await send("sendMessage", {
    chat_id: msg.chat.id,
    text:
      "✅ လက်ခံပြီးပါပြီ! 🎉\n" +
      `🎫 မဲနံပါတ်: ${num}\n` +
      `👤 ${username || "မိတ်ဆွေ"}\n\n` +
      "ကံစမ်းမဲနေ့ကျ ကံကောင်းပါစေ 🍀",
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
    await send("sendMessage", {
      chat_id: chatId,
      text: isTest ? "🧪 စာရင်းထဲမှာ မဲမရှိသေးဘူး" : "🎰 မဲအားလုံး ကျပြီးပါပြီ! 🎉",
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

export async function handleMessage(send, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
  const isAdmin = !!adminId && String(msg.from?.id || "") === adminId;

  if (msg.photo && msg.photo.length > 0) {
    if (await handleGiftEventPhoto(send, msg)) return;
    await handlePhoto(send, msg);
    return;
  }

  if (msg.sticker) {
    await send("sendMessage", {
      chat_id: chatId,
      text: "Sticker လှတယ် 😄",
    });
    return;
  }

  if (!text) return;

  // Admin unmute: reply "ဖွင့်" to someone's message to unrestrict them.
  if (text === "ဖွင့်") {
    const target = msg.reply_to_message?.from;
    if (String(msg.from?.id || "") === adminId && target?.id && !target.is_bot) {
      const targetId = String(target.id);
      try {
        await setGiftMute(send, msg.chat.id, targetId, false);
        giftMuted.delete(targetId);
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
      return;
    }
  }

  // Button labels are user-editable in the settings sheet (60s cache).
  const settings = await getSettings();
  const L = getLabels(settings);

  // Typing anything else cancels raffle-photo mode.
  if (text && text !== L.raffle) rafflePending.delete(String(msg.from?.id || ""));

  if (text === "/start") {
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
    await handleVip(send, chatId);
  } else if (text === L.vip) {
    // bottom-menu button (reply keyboard)
    if (await forceJoinGate(send, msg, settings)) return;
    await handleVip(send, chatId);
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
  } else if (text === SPIN_LABEL && isAdmin) {
    if (await forceJoinGate(send, msg, settings)) return;
    await handleSpin(send, msg, false);
  } else if (text === SPIN_TEST_LABEL && isAdmin) {
    if (await forceJoinGate(send, msg, settings)) return;
    await handleSpin(send, msg, true);
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
    await editVipScreen(send, query, VIP_MAIN_TEXT, vipMainKeyboard());
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

export async function handleUpdate(send, update) {
  if (update.message) {
    await handleMessage(send, update.message);
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
