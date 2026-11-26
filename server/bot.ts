// @kith_memory_bot: daily "what you owe" digest with one-tap Done buttons.
// Only ever talks to the owner (the Telegram account Kith is logged into).
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { CallbackQuery, type CallbackQueryEvent } from 'telegram/events/CallbackQuery.js';
import { Button } from 'telegram/tl/custom/button.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export type OwedItem = { id: string; what: string; due: string; overdue: boolean; personName: string };
type Deps = {
  ownerId: string;
  owed: () => OwedItem[];
  markDone: (promiseId: string) => boolean;
  digestHour?: number; // local hour for the daily digest
};

const SESSION = '.bot-session';
const STATE = 'data/bot.json';

export async function startBot(deps: Deps) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) { console.log('Bot: no TELEGRAM_BOT_TOKEN, skipping'); return; }
  const apiId = Number(process.env.TELEGRAM_API_ID), apiHash = process.env.TELEGRAM_API_HASH ?? '';
  const saved = existsSync(SESSION) ? readFileSync(SESSION, 'utf8').trim() : '';
  const bot = new TelegramClient(new StringSession(saved), apiId, apiHash, { connectionRetries: 5 });
  bot.setLogLevel('error' as any);
  await bot.start({ botAuthToken: token });
  writeFileSync(SESSION, String(bot.session.save()), { mode: 0o600 });
  const me: any = await bot.getMe();

  const state: { lastDigest?: string; started?: boolean } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  const saveState = () => writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });

  // Mini App (light-blue home base). URL comes from the tunnel (data/public-url.txt), set via setMiniApp().
  let appUrl = '';
  const appButton = () => (appUrl ? [[new Api.KeyboardButtonWebView({ text: '📋 Open Kith', url: appUrl })]] : []);
  const setMiniApp = async (url: string) => {
    appUrl = url.replace(/\/$/, '') + '/mini';
    await bot.invoke(new Api.bots.SetBotMenuButton({
      userId: new Api.InputUserEmpty(), button: new Api.BotMenuButton({ text: 'Kith', url: appUrl }),
    }));
    console.log(`Mini App: ${appUrl}`);
  };

  const digest = () => {
    const owed = deps.owed();
    if (!owed.length) return { text: '✨ Kith: you owe nobody anything right now. Promises kept!', buttons: appUrl ? appButton() : undefined };
    const lines = owed.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.overdue ? '🔴' : '🔵'} <b>${esc(p.personName)}</b>: ${esc(p.what)}${p.due ? ` <i>(${esc(p.due)})</i>` : ''}`);
    const text = `☀️ <b>Kith: you owe ${owed.length} ${owed.length === 1 ? 'thing' : 'things'}</b>\n\n${lines.join('\n')}\n\nOpen Kith on your G2 to deliver with one tap.`;
    const buttons: any[][] = owed.slice(0, 10).map((p, i) => [Button.inline(`✅ ${i + 1}. Done: ${p.what.slice(0, 24)}`, Buffer.from('done:' + p.id))]);
    buttons.push(...appButton());
    return { text, buttons };
  };

  const sendDigest = async () => {
    const d = digest();
    await bot.sendMessage(deps.ownerId, { message: d.text, parseMode: 'html', buttons: d.buttons });
  };

  bot.addEventHandler(async (ev: NewMessageEvent) => {
    const m = ev.message;
    if (!m.isPrivate) return;
    if (String(m.senderId) !== deps.ownerId) {
      await m.reply({ message: 'This is a private Kith assistant. It only works for its owner.' });
      return;
    }
    const text = (m.message ?? '').trim();
    if (text.startsWith('/start')) {
      state.started = true; saveState();
      await m.reply({ message: "👋 Hi! I'm your Kith assistant. Every morning I'll tell you what you owe people. Send /today any time." });
      return sendDigest();
    }
    if (text.startsWith('/today')) return sendDigest();
    if (text.startsWith('/app')) {
      if (!appUrl) return m.reply({ message: 'The Kith app is offline right now.' });
      return bot.sendMessage(deps.ownerId, { message: 'Your promises, people and chat settings:', buttons: appButton() });
    }
    await m.reply({ message: 'Commands: /today, /app' });
  }, new NewMessage({}));

  bot.addEventHandler(async (ev: CallbackQueryEvent) => {
    if (String(ev.query.userId) !== deps.ownerId) return ev.answer({ message: 'Not yours.' });
    const data = Buffer.from(ev.query.data ?? []).toString();
    if (data.startsWith('done:')) {
      const ok = deps.markDone(data.slice(5));
      await ev.answer({ message: ok ? 'Promise kept ✅' : 'Already done' });
      const d = digest();
      await ev.edit({ message: ev.query.msgId as number, text: d.text, parseMode: 'html', buttons: d.buttons }).catch(() => {});
    }
  }, new CallbackQuery({}));

  // Daily digest at digestHour local time (checked every minute).
  const hour = deps.digestHour ?? 8;
  setInterval(() => {
    const now = new Date(), day = now.toDateString();
    if (state.started && now.getHours() === hour && state.lastDigest !== day) {
      state.lastDigest = day; saveState();
      sendDigest().catch((e) => console.log('digest failed:', e.message));
    }
  }, 60_000);

  console.log(`Bot @${me.username} ready (owner only). Daily digest at ${hour}:00.`);
  const notify = async (html: string) => { await bot.sendMessage(deps.ownerId, { message: html, parseMode: 'html' }); };
  return { sendDigest, notify, setMiniApp };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
