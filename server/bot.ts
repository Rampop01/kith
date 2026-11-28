// @kith_memory_bot: welcome + "Open Kith" Mini App button, daily "what you owe" digests with Done buttons,
// and recaps after the promise catcher. Works for every Kith user; each only ever sees their own data.
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { CallbackQuery, type CallbackQueryEvent } from 'telegram/events/CallbackQuery.js';
import { Button } from 'telegram/tl/custom/button.js';
import bigInt from 'big-integer';
import { kv } from './db.ts';
import { API_ID, API_HASH, getAccount, connectedUserIds, type Account } from './account.ts';

type Deps = { appUrl: () => string; adminId?: string };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startBot(deps: Deps) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) { console.log('Bot: no TELEGRAM_BOT_TOKEN, skipping'); return; }
  const saved = (await kv.get<string>('bot:session')) ?? '';
  const bot = new TelegramClient(new StringSession(saved), API_ID, API_HASH, { connectionRetries: 10, autoReconnect: true });
  bot.setLogLevel('error' as any);
  await bot.start({ botAuthToken: token });
  await kv.set('bot:session', String(bot.session.save()));
  const me: any = await bot.getMe();

  // Watchdog: after a network drop (or the host pausing us) Telegram can stop pushing updates to this session
  // until we ask again. Every minute: reconnect if needed and call updates.GetState, which resumes the stream.
  const status = { ok: true, lastCheck: '', lastMessage: '', error: '' };
  setInterval(async () => {
    try {
      if (!bot.connected) await bot.connect();
      await bot.invoke(new Api.updates.GetState());
      status.ok = true; status.lastCheck = new Date().toISOString();
    } catch (e: any) {
      status.ok = false; status.error = e.message;
      console.log('bot watchdog:', e.message);
    }
  }, 60_000);
  await bot.invoke(new Api.updates.GetState()).catch(() => {});

  const appButton = (text = '📋 Open Kith') => {
    const url = deps.appUrl();
    return url ? [new Api.KeyboardButtonWebView({ text, url })] : [];
  };
  // Always attach buttons to the message (inline). The library otherwise turns a lone Mini App button into a reply-keyboard
  // button, which Telegram rejects with BUTTON_TYPE_INVALID.
  const rows = (...r: any[][]) => {
    const x = r.filter((row) => row.length);
    return x.length ? new Api.ReplyInlineMarkup({ rows: x.map((row) => new Api.KeyboardButtonRow({ buttons: row })) }) : undefined;
  };

  let menuUrl = '';
  const syncMenu = async () => {
    const url = deps.appUrl();
    if (!url || url === menuUrl) return;
    await bot.invoke(new Api.bots.SetBotMenuButton({ userId: new Api.InputUserEmpty(), button: new Api.BotMenuButton({ text: 'Kith', url }) }));
    menuUrl = url;
    console.log(`Bot menu button -> ${url}`);
  };
  setInterval(() => syncMenu().catch((e) => console.log('menu button failed:', e.message)), 5000);
  syncMenu().catch(() => {});

  const digest = (a: Account) => {
    const owed = a.owed();
    if (!owed.length) return { text: '✨ <b>Kith:</b> you owe nobody anything right now. Promises kept!', buttons: rows(appButton()) };
    const lines = owed.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.overdue ? '🔴' : '🔵'} <b>${esc(p.personName)}</b>: ${esc(p.what)}${p.due ? ` <i>(${esc(p.due)})</i>` : ''}`);
    const btns = owed.slice(0, 10).map((p, i) => [Button.inline(`✅ ${i + 1}. Done: ${p.what.slice(0, 24)}`, Buffer.from('done:' + p.id))]);
    return {
      text: `☀️ <b>Kith: you owe ${owed.length} ${owed.length === 1 ? 'thing' : 'things'}</b>\n\n${lines.join('\n')}\n\nDeliver with one tap on your G2, or tick them off here.`,
      buttons: rows(...btns, appButton()),
    };
  };

  const meetRecap = (a: Account, met: ReturnType<Account['metPeople']>) => {
    const lines = met.slice(0, 10).map((p, i) => {
      const owe = a.open().filter((x) => x.personId === p.id).map((x) => x.what);
      return `${i + 1}. <b>${esc(p.name)}</b>${p.who ? `, ${esc(p.who)}` : ''}` +
        (p.notes?.length ? `\n    💬 ${esc(p.notes[p.notes.length - 1])}` : '') +
        (owe.length ? `\n    🤝 You promised: ${esc(owe.join(', '))}` : '') +
        (p.id.startsWith('met-') ? (p.tgCandidate ? `\n    ✈️ @${esc(p.tgCandidate.username)}, tap to connect` : '\n    ✈️ Not on Telegram with you yet') : '\n    ✅ Connected');
    });
    return `🌙 <b>You met ${met.length} new ${met.length === 1 ? 'person' : 'people'} today</b>\n\n${lines.join('\n')}\n\nSay hi while it's fresh.`;
  };

  // A bot can only message a user with their access hash. The library keeps it in memory only, so after a restart it is
  // gone: store it in the database whenever the user writes to us, and rebuild the peer from it.
  const peerFor = async (userId: string) => {
    const h = await kv.get<string>(`botpeer:${userId}`);
    return h ? new Api.InputPeerUser({ userId: bigInt(userId), accessHash: bigInt(h) }) : userId;
  };
  const send = async (userId: string, message: string, buttons?: any) => {
    try { await bot.sendMessage(await peerFor(userId), { message, parseMode: 'html', buttons, linkPreview: false }); }
    catch (e: any) { console.log(`bot send to ${userId} failed: ${e.message}`); throw e; }
  };
  const sendDigest = async (a: Account) => { const d = digest(a); await send(a.id, d.text, d.buttons); };

  bot.addEventHandler((ev: NewMessageEvent) => onMessage(ev).catch((e) => { status.error = 'reply: ' + e.message; console.log('bot reply failed:', e.message); }), new NewMessage({}));
  async function onMessage(ev: NewMessageEvent) {
    status.lastMessage = new Date().toISOString();
    const m = ev.message;
    if (!m.isPrivate || m.out) return;
    const uid = String(m.senderId);
    await kv.set(`botuser:${uid}`, true); // they started the bot, so we may message them
    try { const p: any = await m.getInputChat(); if (p?.accessHash) await kv.set(`botpeer:${uid}`, String(p.accessHash)); }
    catch (e: any) { console.log('bot: could not read sender:', e.message); }
    const text = (m.message ?? '').trim();
    const a = await getAccount(uid);
    if (!a) {
      return send(uid,
        "👋 <b>Welcome to Kith.</b>\n\nKith remembers who people are and what you owe them, from your own Telegram chats, and shows it on your Even Realities G2 glasses.\n\n" +
        '• Meet someone: they say their name, you see your history with them\n• Promises you make, in chats or out loud, get real deadlines\n• Deliver with one tap\n\n' +
        '🔒 You choose which chats Kith may read. Nothing is sent without your tap. Delete everything any time.\n\nTap below to connect (free beta).',
        rows(appButton('🚀 Open Kith')));
    }
    if (text.startsWith('/start')) {
      await send(uid, `👋 Welcome back, ${esc(a.rec.name.split(' ')[0])}! Send /today any time.`, rows(appButton()));
      return sendDigest(a);
    }
    if (text.startsWith('/today')) return sendDigest(a);
    if (text.startsWith('/app')) return send(uid, 'Your promises, people and settings:', rows(appButton()));
    return send(uid, 'Commands: /today (what you owe), /app (open Kith)');
  }

  bot.addEventHandler(async (ev: CallbackQueryEvent) => {
    const uid = String(ev.query.userId);
    const data = Buffer.from(ev.query.data ?? []).toString();
    if (!data.startsWith('done:')) return;
    const a = await getAccount(uid);
    const pr = a?.store.promises.find((x) => x.id === data.slice(5) && !x.done);
    if (!a || !pr) return ev.answer({ message: 'Already done' });
    a.editPromise(pr.id, { done: true });
    await ev.answer({ message: 'Promise kept ✅' });
    const d = digest(a);
    await ev.edit({ message: ev.query.msgId as number, text: d.text, parseMode: 'html', buttons: d.buttons }).catch(() => {});
  }, new CallbackQuery({}));

  // Daily digest at each user's chosen hour, in their own time zone. Re-reads their chats first.
  setInterval(async () => {
    for (const id of await connectedUserIds()) {
      try {
        if (!(await kv.get(`botuser:${id}`))) continue; // never started the bot
        const a = await getAccount(id);
        if (!a) continue;
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: a.rec.tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
        const day = `${get('year')}-${get('month')}-${get('day')}`, hour = Number(get('hour'));
        if (hour === 20 && a.rec.lastMeetRecap !== day) { // evening: people met today, with follow-ups
          a.rec.lastMeetRecap = day; await a.saveRec();
          const met = a.metPeople().filter((p) => new Date(p.metAt!).toLocaleDateString('en-CA', { timeZone: a.rec.tz || 'UTC' }) === day);
          if (met.length) await send(a.id, meetRecap(a, met), rows(appButton('👥 Follow up in Kith')));
        }
        if (hour !== a.rec.digestHour || a.rec.lastDigest === day) continue;
        a.rec.lastDigest = day; await a.saveRec();
        await a.index().catch(() => {});
        await sendDigest(a);
      } catch (e: any) { console.log(`digest ${id} failed: ${e.message}`); }
    }
  }, 60_000);

  console.log(`Bot @${me.username} ready.`);
  return {
    username: me.username as string,
    status,
    notify: (userId: string, html: string) => send(userId, html).then(() => {}),
    sendDigest,
    adminNotify: (html: string) => (deps.adminId ? send(deps.adminId, html).then(() => {}) : Promise.resolve()),
  };
}
