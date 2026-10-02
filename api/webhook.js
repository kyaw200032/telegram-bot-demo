// Vercel serverless webhook endpoint.
// Telegram -> POST https://<project>.vercel.app/api/webhook

import { handleUpdate, makeSender } from "../lib/bot.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("telegram-bot-demo is running");
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return res.status(500).send("bot token not configured");
  }
  try {
    await handleUpdate(makeSender(token), req.body || {});
  } catch (err) {
    console.error("handleUpdate failed:", err);
  }
  // Always 200 so Telegram doesn't retry the same update.
  return res.status(200).send("OK");
}
