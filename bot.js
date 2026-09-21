// Local polling runner: node bot.js
// Uses long-polling (getUpdates). Good for testing; for 24/7 use the
// Vercel webhook instead.

import { handleUpdate, makeSender } from "./lib/bot.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN first (see .env.example)");
  process.exit(1);
}

const send = makeSender(token);
let offset = 0;
let me = await send("getMe");
console.log(`Polling as @${me.result?.username} ... (Ctrl+C to stop)`);

while (true) {
  try {
    const data = await send("getUpdates", { offset, timeout: 30 });
    if (data.ok && data.result) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        handleUpdate(send, update).catch((e) => console.error(e));
      }
    } else {
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (err) {
    console.error("poll error:", err.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
