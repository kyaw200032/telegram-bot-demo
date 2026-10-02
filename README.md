# Telegram Bot Demo 🤖

Pupu ဆောက်ပေးထားတဲ့ Telegram bot demo — မြန်မာလို ပြန်ပြောတဲ့ bot လေး။
Dependency မရှိ၊ Node.js 18+ ဆို ရပြီ။

## ပါဝင်တာ

| Command / ခလုတ် | လုပ်ဆောင်ချက် |
|---|---|
| `/start` | ကြိုဆိုစာနဲ့ menu ခလုတ်တွေ |
| `/help` | အကူအညီ |
| `/time` | မြန်မာအချိန် |
| `/dice` | အံစာပစ် 🎲 |
| ရိုးရိုးစာ | echo ပြန်ပြောပေး |
| ℹ️ / 🕐 / 🎲 / ❓ ခလုတ်တွေ | inline button demo |

## 1. Bot ဖွင့်ရန် (၁ မိနစ်)

1. Telegram မှာ **@BotFather** ကို ရှာ
2. `/newbot` ပို့ → နာမည်ပေး (ဥပမာ `Pupu Demo Bot`)
3. username ပေး (ဥပမာ `pupu_demo_xyz_bot` — နောက်ဆုံးမှာ `bot` ပါရမယ်)
4. **token** ရမယ် — ဒါကို လျှို့ဝှက်ထားပါ

## 2. Local မှာ စမ်းရန် (polling)

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC..."
node bot.js
```

ပြီးရင် Telegram မှာ ကိုယ့် bot ကို ရှာပြီး `/start` လို့ ပို့ကြည့်။

## 3. Vercel ပေါ် တင်ရန် (အမြဲတမ်း run, အခမဲ့)

1. ဒီ repo ကို GitHub ပေါ်တင်
2. [vercel.com](https://vercel.com) မှာ **Add New → Project → Import** Git repository
3. Environment Variables မှာ `TELEGRAM_BOT_TOKEN` ထည့် → **Deploy**
4. Deploy ပြီးရင် webhook သတ်မှတ်ပေး (browser မှာ ဒီ URL ကို ဖွင့်ရုံပဲ):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project>.vercel.app/api/webhook
```

`{"ok":true}` ပြန်လာရင် အောင်မြင်ပြီ ✅

> Webhook သုံးနေရင် polling (`node bot.js`) ကို တစ်ပြိုင်နက် မ run ပါနဲ့ —
> နှစ်ခုလုံး update လုနေလို့ error တက်မယ်။

## ဖိုင်များ

- `lib/bot.js` — bot logic အဓိက (webhook + polling နှစ်ခုလုံး ဒါကိုပဲ သုံးတယ်)
- `api/webhook.js` — Vercel serverless function
- `bot.js` — local polling runner
