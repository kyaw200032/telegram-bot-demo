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
};

export function getLabels(settings) {
  const s = settings || {};
  return {
    vip: s.btn_vip || DEFAULT_LABELS.vip,
    gift: s.btn_gift || DEFAULT_LABELS.gift,
    slip: s.btn_slip || DEFAULT_LABELS.slip,
    help: s.btn_help || DEFAULT_LABELS.help,
    profile: s.btn_profile || DEFAULT_LABELS.profile,
  };
}

export function mainKeyboard(labels) {
  const L = labels || DEFAULT_LABELS;
  return {
    keyboard: [
      [{ text: L.vip }, { text: L.gift }],
      [{ text: L.slip }, { text: L.help }],
      [{ text: L.profile }],
    ],
    resize_keyboard: true,
  };
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

async function fetchCSV(url) {
  if (!url) return null;
  const now = Date.now();
  const cached = sheetCache.get(url);
  if (cached && now - cached.at < SHEET_CACHE_MS) return cached.rows;
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

export async function handleGift(send, chatId) {
  const s = await getSettings();
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

export async function handlePhoto(send, msg) {
  // Slips are only accepted in private chats, never in channels/groups.
  if (!msg.chat || msg.chat.type !== "private") return;

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

  await send("copyMessage", {
    chat_id: Number(adminId),
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
    caption: `🧾 VIP စလစ်အသစ်\n👤 ${who}\n🆔 ${user.id}`,
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

  // approve → per-buyer join-request link for the VIP channel.
  // The link name carries the buyer id (VIP-<id>); handleChatJoinRequest
  // approves only the matching id and declines everyone else.
  // Sheet value wins so the channel can be changed from the phone.
  const settings = await getSettings();
  let inviteLink = "";
  let joinRequest = false;
  const channelId = settings.vip_channel_id || process.env.VIP_CHANNEL_ID || "";
  if (channelId) {
    try {
      const res = await send("createChatInviteLink", {
        chat_id: channelId,
        member_limit: 1,
        creates_join_request: true,
        expire_date: Math.floor(Date.now() / 1000) + 48 * 3600,
        name: `VIP-${targetId}`.slice(0, 32),
      });
      if (res && res.ok && res.result?.invite_link) {
        inviteLink = res.result.invite_link;
        joinRequest = true;
      }
    } catch (err) {
      console.error("createChatInviteLink failed:", err.message);
    }
  }
  if (!inviteLink) inviteLink = process.env.VIP_INVITE_LINK || "";

  if (inviteLink) {
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
  } else {
    await send("sendMessage", {
      chat_id: Number(targetId),
      text: "🎉 VIP အတည်ပြုပြီးပါပြီ! Admin က invite link ပို့ပေးပါလိမ့်မယ် 🙏",
    });
  }
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

  if (msg.photo && msg.photo.length > 0) {
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

  // Button labels are user-editable in the settings sheet (60s cache).
  const settings = await getSettings();
  const L = getLabels(settings);

  if (text === "/start") {
    if (await forceJoinGate(send, msg, settings)) return;
    const name = msg.from?.first_name || "မိတ်ဆွေ";
    await send("sendMessage", {
      chat_id: chatId,
      text: welcomeText(settings, name),
      reply_markup: mainKeyboard(L),
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
    await handleGift(send, chatId);
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

  // Approve/reject buttons answer the query themselves (may show an alert).
  if (data.startsWith("approve:") || data.startsWith("reject:")) {
    await handleReview(send, query, data);
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
        reply_markup: mainKeyboard(getLabels(s)),
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
    await handleGift(send, chatId);
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
  const linkName = (cjr.invite_link && cjr.invite_link.name) || "";
  const m = /^VIP-(\d+)$/.exec(linkName);
  if (!chatId || !fromId || !m) return;
  const method =
    m[1] === String(fromId)
      ? "approveChatJoinRequest"
      : "declineChatJoinRequest";
  try {
    await send(method, { chat_id: chatId, user_id: fromId });
  } catch (err) {
    console.error(method + " failed:", err.message);
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
  return async (method, params = {}) => {
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
}
