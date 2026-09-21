// Shared bot logic — used by both the Vercel webhook (api/webhook.js)
// and the local polling runner (bot.js).
//
// `send` is an async function: send(method, params) -> Telegram API result.
// This keeps the logic identical everywhere; only the transport differs.

export function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "ℹ️ Bot အကြောင်း", callback_data: "about" }],
      [
        { text: "🕐 အခုအချိန်", callback_data: "time" },
        { text: "🎲 အံစာပစ်", callback_data: "dice" },
      ],
      [{ text: "❓ အကူအညီ", callback_data: "help" }],
    ],
  };
}

const WELCOME =
  "မင်္ဂလာပါ! 👋\n" +
  "ကျွန်တော်က Pupu ဆောက်ပေးထားတဲ့ demo bot ပါ။\n" +
  "အောက်က ခလုတ်တွေကို နှိပ်ကြည့်ပါဦး။";

const HELP_TEXT =
  "ရနိုင်တဲ့ command တွေ:\n" +
  "/start — ကြိုဆိုစာနဲ့ menu ပြန်ဖွင့်\n" +
  "/help — ဒီစာရင်း\n" +
  "/time — မြန်မာအချိန်\n" +
  "/dice — အံစာပစ်\n\n" +
  "ရိုးရိုးစာပို့ရင်လည်း ပြန်ပြောပေးပါတယ် 🙂";

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

export async function handleMessage(send, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (msg.sticker) {
    await send("sendMessage", {
      chat_id: chatId,
      text: "Sticker လှတယ် 😄",
    });
    return;
  }

  if (!text) return;

  if (text === "/start") {
    await send("sendMessage", {
      chat_id: chatId,
      text: WELCOME,
      reply_markup: mainKeyboard(),
    });
  } else if (text === "/help") {
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
  } else {
    await send("sendMessage", {
      chat_id: chatId,
      text: `ခင်ဗျား ပြောတာက:\n“${text}”`,
      reply_markup: mainKeyboard(),
    });
  }
}

export async function handleCallback(send, query) {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Acknowledge the button press so the loading spinner disappears.
  await send("answerCallbackQuery", { callback_query_id: query.id });

  if (data === "about") {
    await send("sendMessage", {
      chat_id: chatId,
      text:
        "ℹ️ ဒီ bot အကြောင်း:\n" +
        "• Vercel serverless (webhook) နဲ့ run ထားတဲ့ demo\n" +
        "• Code က GitHub ပေါ်မှာ, deploy က Vercel အခမဲ့ tier\n" +
        "• Pupu က ဆောက်ပေးထားတာ 🤖",
    });
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

export async function handleUpdate(send, update) {
  if (update.message) {
    await handleMessage(send, update.message);
  } else if (update.callback_query) {
    await handleCallback(send, update.callback_query);
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
