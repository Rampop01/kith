# Kith

**Kith remembers who people are and what you owe them. Your Telegram is the memory.**

Kith is an app for Even Realities G2 smart glasses (Track 01: Messaging). It reads your own Telegram chats, finds the people you talk to and the promises you made them, and shows them on your glasses when you need them. No camera. Nothing is sent to anyone without your tap.

## What it does

| Feature | How it works |
|---|---|
| **Person card** | Hold the touchpad while someone says their name ("Hi, I'm Bimbim"). Kith matches the name to your Telegram chats and shows: who they are, what you last talked about, what you owe them, what they owe you, and what they asked you. |
| **What you owe** | The home screen lists the promises found in your chats ("send pitch deck, Fri", "send spreadsheet, 2d overdue"), soonest first. |
| **They owe you** | Kith also tracks what other people promised you. |
| **Promise catcher** | During a face-to-face conversation, choose "Catch promises". Kith listens through the glasses mic and catches commitments you say out loud ("I'll send you the deck by Friday"). They are saved with a real date, and a recap arrives in Telegram. |
| **One-tap deliver** | Choose a promise, check the drafted message, tap to send it to that person on Telegram. The promise is marked kept. |
| **Telegram bot** | `@kith_memory_bot` sends a morning digest of what you owe, with ✅ Done buttons. `/today` gets it any time. The bot only answers its owner. |

### Glasses controls

| Gesture | Action |
|---|---|
| Tap | Select / confirm |
| Double tap | Back / cancel / end catching |
| Hold, then release | Listen for a name |

## How it works

```
G2 glasses (Even Hub WebView app, src/)
   │  HTTP
   ▼
Kith server (server/index.ts, Node)
   ├─ Telegram user account via MTProto (GramJS): reads your chats, sends on your tap
   ├─ Groq: gpt-oss-120b finds people and promises; whisper-large-v3-turbo turns speech into text
   └─ Telegram bot (server/bot.ts): daily digest, Done buttons, promise recaps
```

- The AI copies deadline words exactly as written ("friday", "dec 3"). Kith's own code turns them into dates, relative to when the message was sent, so dates don't depend on the AI's calendar maths.
- Data is cached locally in `data/` (gitignored).

## Safety and privacy

- **Nothing is sent without a tap**, and you see the exact message first.
- **Safe by default:** in normal mode, "sending" goes to your own Saved Messages. Real sending needs `KITH_SEND_MODE=live`.
- **Demo mode** (`KITH_DEMO_IDS`) shows only the chats you list, and refuses to send to anyone else. We filmed the demo this way, so no real contacts appear.
- **No camera, no face recognition.** People are recognised by the name they say.
- The bot ignores everyone except the owner.
- Chat text and audio are sent to Groq for AI processing. Sessions and keys stay on your machine (`.env`, `.tg-session`, `.bot-session`, all gitignored).

## Run it

Requirements: Node 22+ (runs `.ts` directly), a Telegram API ID/hash from https://my.telegram.org, a Groq API key, a bot token from @BotFather.

```bash
npm install
cp .env.example .env        # fill in the values
npm run tg:login:qr         # scan the QR in Telegram > Settings > Devices
npm run server              # Kith server on :8787
npm run dev                 # glasses app on :5180
npm run sim                 # Even Hub simulator
npm run pack                # build kith.ehpk for real glasses
```

`npm run server:demo` runs demo mode (live sending, only the chats in `KITH_DEMO_IDS`).

## What existed before November 23

Nothing. Kith was built from scratch during the hackathon (Nov 23–29, 2026). We used the public Even Hub SDK, CLI and simulator, GramJS, and the Groq API.

## API feature requests for Even Realities

1. **Background or notification mode:** let an app show a short alert (e.g. "Bimbim is calling: you owe her the deck") without being open.
2. **Wake word or button shortcut** that opens a chosen app straight into a mode (e.g. Promise catcher), so you don't open it mid-conversation.
3. **Speaker separation in `audioEvent`** (self vs. other, per frame) on all devices, so we can tell "I'll send it" from "you'll send it".
4. **On-device or SDK speech-to-text,** so audio doesn't have to leave the phone.
5. **Richer text styling** (bold or larger text in a text container) to show urgent items such as overdue promises.

## Team

- Rampop01 (Lagos)
