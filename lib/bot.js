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
  vip: "💎 VIP ဈေးနှုန်း",
  gift: "🎁 လက်ဆောင်",
  slip: "📤 စလစ်ပို့မယ်",
  help: "🆘 အကူအညီ",
};

export function getLabels(settings) {
  const s = settings || {};
  return {
    vip: s.btn_vip || DEFAULT_LABELS.vip,
    gift: s.btn_gift || DEFAULT_LABELS.gift,
    slip: s.btn_slip || DEFAULT_LABELS.slip,
    help: s.btn_help || DEFAULT_LABELS.help,
  };
}

export function mainKeyboard(labels) {
  const L = labels || DEFAULT_LABELS;
  return {
    keyboard: [
      [{ text: L.vip }, { text: L.gift }],
      [{ text: L.slip }, { text: L.help }],
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

const WELCOME =
  "👋 PK AI Hub မှ ကြိုဆိုပါတယ်!\n" +
  "\n" +
  "• 💎 VIP ဈေးနှုန်းကြည့်ရန် — အောက်က ခလုတ်နှိပ်ပါ\n" +
  "• 🎁 အခမဲ့လက်ဆောင် ရယူရန်\n" +
  "• 📤 ငွေလွှဲပြီးရင် စလစ်ပို့ရန်\n" +
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
// VIP pricing
// ---------------------------------------------------------------------------

export async function handleVipPrices(send, chatId) {
  let body;
  try {
    const rows = await fetchCSV(sheetUrl("prices"));
    if (!rows || rows.length < 2) throw new Error("no price rows");
    const lines = rows.slice(1).map((r) => {
      const plan = (r[0] || "").trim();
      const price = (r[1] || "").trim();
      const note = (r[2] || "").trim();
      return `• ${plan} — ${price}${note ? ` (${note})` : ""}`;
    });
    body = `💎 PK AI Hub VIP ဈေးနှုန်း\n\n${lines.join("\n")}`;
  } catch (err) {
    console.error("handleVipPrices failed:", err.message);
    body = "💎 PK AI Hub VIP ဈေးနှုန်း\n\nဈေးနှုန်းစာရင်း မကြာမီ ရရှိပါမယ် 🙏";
  }

  const settings = await getSettings();
  const payInfo = settings.payment_info || "";
  const text =
    (payInfo ? `${body}\n\n💳 ငွေပေးချေနည်း:\n${payInfo}` : body) +
    "\n\nငွေလွှဲပြီးရင် စလစ်ပုံကို ဒီ chat ထဲမှာ ပို့ပေးပါ 📤";

  await send("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      // w3k-style: stacked full-width buttons under the message
      inline_keyboard: [
        [{ text: "📤 စလစ်ပို့မယ်", callback_data: "send_slip" }],
        [{ text: "🎁 လက်ဆောင်ရယူမည်", callback_data: "gift" }],
      ],
    },
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
  if (!link) {
    await send("sendMessage", {
      chat_id: chatId,
      text: `${title}\n\nလက်ဆောင် မကြာမီ ရရှိပါမယ် 🙏`,
    });
    return;
  }
  await send("sendMessage", {
    chat_id: chatId,
    text: `${title}\n\n${text}`.trim(),
    reply_markup: {
      inline_keyboard: [[{ text: "🔗 ဖွင့်ကြည့်မယ်", url: link }]],
    },
  });
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

  // approve → single-use invite link for the VIP channel
  let inviteLink = process.env.VIP_INVITE_LINK || "";
  const channelId = process.env.VIP_CHANNEL_ID || "";
  if (!inviteLink && channelId) {
    try {
      const res = await send("createChatInviteLink", {
        chat_id: channelId,
        member_limit: 1,
        name: `VIP-${targetId}`.slice(0, 32),
      });
      if (res && res.ok && res.result?.invite_link) {
        inviteLink = res.result.invite_link;
      }
    } catch (err) {
      console.error("createChatInviteLink failed:", err.message);
    }
  }

  if (inviteLink) {
    await send("sendMessage", {
      chat_id: Number(targetId),
      text:
        "🎉 VIP အတည်ပြုပြီးပါပြီ!\n" +
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
    const name = msg.from?.first_name || "မိတ်ဆွေ";
    await send("sendMessage", {
      chat_id: chatId,
      text: welcomeText(settings, name),
      reply_markup: mainKeyboard(L),
    });
  } else if (text === "/help") {
    await send("sendMessage", { chat_id: chatId, text: HELP_TEXT });
  } else if (text === "/vip") {
    await handleVipPrices(send, chatId);
  } else if (text === L.vip) {
    // bottom-menu button (reply keyboard)
    await handleVipPrices(send, chatId);
  } else if (text === L.gift) {
    // bottom-menu button (reply keyboard)
    await handleGift(send, chatId);
  } else if (text === L.slip) {
    // bottom-menu button (reply keyboard)
    await sendSlipPrompt(send, chatId);
  } else if (text === L.help) {
    // bottom-menu button (reply keyboard)
    await send("sendMessage", { chat_id: chatId, text: HELP_TEXT });
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
  } else if (data === "vip_prices") {
    await handleVipPrices(send, chatId);
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

export async function handleUpdate(send, update) {
  if (update.message) {
    await handleMessage(send, update.message);
  } else if (update.callback_query) {
    await handleCallback(send, update.callback_query);
  } else if (update.chat_member) {
    await handleChatMember(send, update.chat_member);
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
