// Kith server: many users, each connects their own Telegram from the Mini App.
// Glasses pair with a 6-digit code. Every request is tied to one user; nobody sees anyone else's data.
// Run: npm run server   (DATABASE_URL + KITH_SECRET in production, local JSON file otherwise)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createHmac, timingSafeEqual, randomBytes, randomInt } from 'node:crypto';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { kv } from './db.ts';
import { getAccount, saveLogin, connectedUserIds, userKey, API_ID, API_HASH, MAX_CHOSEN, type Account, type UserRec } from './account.ts';
import { startLogin, resendCode, submitCode, submitPassword } from './login.ts';
import { startBot } from './bot.ts';

const PORT = Number(process.env.PORT ?? 8787);
const BETA_MAX = Number(process.env.KITH_BETA_MAX ?? 20);
const ADMIN_ID = process.env.KITH_ADMIN_ID ?? '';  // gets signup alerts, always allowed in
const DEV_USER = process.env.KITH_DEV_USER ?? '';  // local only: Mini App opened in a desktop browser acts as this user

const publicUrl = () =>
  (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL ||
    (existsSync('data/public-url.txt') ? readFileSync('data/public-url.txt', 'utf8').trim() : '')).replace(/\/$/, '');
const appUrl = () => (publicUrl() ? publicUrl() + '/mini' : '');

let bot: Awaited<ReturnType<typeof startBot>>;

// ---------- auth ----------
type TgUser = { id: string; name: string; username?: string };

/** Telegram-signed Mini App identity (initData). */
function verifyInitData(initData: string): TgUser | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = createHmac('sha256', secret).update(check).digest('hex');
  if (hash.length !== calc.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(calc))) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') ?? 0) > 86400) return null;
  try {
    const u = JSON.parse(params.get('user') ?? '{}');
    return u.id ? { id: String(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(' '), username: u.username } : null;
  } catch { return null; }
}

const isLocal = (req: IncomingMessage) =>
  !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '');

function miniUser(req: IncomingMessage): TgUser {
  const u = verifyInitData(String(req.headers['x-init-data'] ?? ''));
  if (u) return u;
  if (DEV_USER && isLocal(req)) return { id: DEV_USER, name: 'Dev' };
  throw httpError(401, 'Open Kith from Telegram.');
}

async function glassesAccount(req: IncomingMessage): Promise<Account> {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const uid = token ? await kv.get<string>(`device:${token}`) : undefined;
  const a = uid ? await getAccount(uid) : undefined;
  if (!a) throw httpError(401, 'Glasses not paired');
  return a;
}

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

// ---------- beta ----------
async function betaInfo(userId: string) {
  const used = (await connectedUserIds()).length;
  const waitlist = (await kv.get<any[]>('waitlist')) ?? [];
  return { used, max: BETA_MAX, full: used >= BETA_MAX && userId !== ADMIN_ID, waitlisted: waitlist.some((w) => w.id === userId) };
}

// ---------- glasses pairing ----------
const pairings = new Map<string, { code: string; token?: string; exp: number }>(); // by pairId
setInterval(() => { for (const [k, v] of pairings) if (v.exp < Date.now()) pairings.delete(k); }, 60_000);

// ---------- http ----------
const readBody = (req: IncomingMessage, max = 4_000_000) => new Promise<Buffer>((res, rej) => {
  const chunks: Buffer[] = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > max) { rej(httpError(413, 'too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => res(Buffer.concat(chunks))); req.on('error', rej);
});
const json = async (req: IncomingMessage) => { try { return JSON.parse((await readBody(req, 100_000)).toString() || '{}'); } catch { return {}; } };

function reply(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Init-Data',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}
function html(res: ServerResponse, file: string) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(readFileSync(new URL(file, import.meta.url)));
}

async function miniRoutes(req: IncomingMessage, res: ServerResponse, path: string) {
  const u = miniUser(req);
  const a = await getAccount(u.id);

  if (req.method === 'GET' && path === '/api/mini/me') {
    return reply(res, 200, { user: u, connected: !!a, beta: await betaInfo(u.id), bot: bot?.username ?? '', state: a?.miniState() });
  }

  // --- connect Telegram ---
  if (req.method === 'POST' && path === '/api/mini/login/phone') {
    if (!a && (await betaInfo(u.id)).full) throw httpError(403, 'The beta is full. Join the waitlist.');
    return reply(res, 200, await startLogin(u.id, String((await json(req)).phone ?? '')));
  }
  if (req.method === 'POST' && path === '/api/mini/login/resend') return reply(res, 200, await resendCode(u.id));
  if (req.method === 'POST' && (path === '/api/mini/login/code' || path === '/api/mini/login/password')) {
    const b = await json(req);
    const r = path.endsWith('code') ? await submitCode(u.id, String(b.code ?? ''), b.tz) : await submitPassword(u.id, String(b.password ?? ''), b.tz);
    if ('needPassword' in r) return reply(res, 200, { needPassword: true });
    await r.account.loadDialogs().catch(() => {});
    const n = (await connectedUserIds()).length;
    bot?.adminNotify(`🆕 New Kith user: <b>${u.name || 'someone'}</b>${u.username ? ` (@${u.username})` : ''}. Beta ${n}/${BETA_MAX}.`).catch(() => {});
    return reply(res, 200, { connected: true, state: r.account.miniState() });
  }
  if (req.method === 'POST' && path === '/api/mini/waitlist') {
    const list = (await kv.get<any[]>('waitlist')) ?? [];
    if (!list.some((w) => w.id === u.id)) {
      list.push({ id: u.id, name: u.name, username: u.username, at: new Date().toISOString() });
      await kv.set('waitlist', list);
      bot?.adminNotify(`📝 Waitlist: <b>${u.name}</b>${u.username ? ` (@${u.username})` : ''} (#${list.length})`).catch(() => {});
    }
    return reply(res, 200, { waitlisted: true, position: list.findIndex((w) => w.id === u.id) + 1 });
  }

  if (!a) throw httpError(403, 'Connect your Telegram first.');

  if (req.method === 'GET' && path === '/api/mini/state') return reply(res, 200, a.miniState());
  const m = path.match(/^\/api\/mini\/promise\/([\w-]+)$/);
  if (req.method === 'POST' && m) {
    if (!a.editPromise(m[1], await json(req))) throw httpError(404, 'not found');
    return reply(res, 200, a.miniState());
  }
  if (req.method === 'POST' && path === '/api/mini/chats') {
    const ids: string[] = (await json(req)).ids ?? [];
    if (ids.length > MAX_CHOSEN) throw httpError(400, `Choose up to ${MAX_CHOSEN} chats in the beta.`);
    await a.setChosen(ids);
    return reply(res, 200, { ...a.miniState(), indexing: true });
  }
  if (req.method === 'POST' && path === '/api/mini/refresh') {
    a.index().catch((e) => console.log(`[${a.id}] index failed: ${e.message}`));
    return reply(res, 200, { ...a.miniState(), indexing: true });
  }
  const mm = path.match(/^\/api\/mini\/met\/([\w-]+)$/);
  if (req.method === 'POST' && mm) {
    const b = await json(req), p = a.store.people[mm[1]];
    if (!p?.metAt) throw httpError(404, 'not found');
    if (b.action === 'username') await a.setCandidate(p, String(b.username ?? ''));
    else if (b.action === 'connect') a.connectMet(p.id, b.targetId ? String(b.targetId) : undefined);
    else if (b.action === 'hello') {
      const mode = await a.send(p.id, String(b.text || a.followUp(p)).slice(0, 1000));
      return reply(res, 200, { ...a.miniState(), sent: mode });
    }
    else if (b.action === 'forget') a.forget(p.id);
    return reply(res, 200, a.miniState());
  }
  if (req.method === 'POST' && path === '/api/mini/settings') {
    const b = await json(req);
    if (b.sendMode === 'live' || b.sendMode === 'saved') a.rec.sendMode = b.sendMode;
    if (Number.isInteger(b.digestHour) && b.digestHour >= 0 && b.digestHour < 24) a.rec.digestHour = b.digestHour;
    if (typeof b.tz === 'string' && b.tz.length < 60) { try { new Intl.DateTimeFormat('en', { timeZone: b.tz }); a.rec.tz = b.tz; } catch {} }
    await a.saveRec();
    return reply(res, 200, a.miniState());
  }
  if (req.method === 'POST' && path === '/api/mini/pair') {
    const code = String((await json(req)).code ?? '').replace(/\D/g, '');
    const entry = [...pairings.values()].find((p) => p.code === code && !p.token && p.exp > Date.now());
    if (!entry) throw httpError(400, 'That code is wrong or expired. Check the code on your glasses.');
    entry.token = randomBytes(24).toString('base64url');
    await kv.set(`device:${entry.token}`, a.id);
    return reply(res, 200, { paired: true });
  }
  if (req.method === 'POST' && path === '/api/mini/delete') {
    await a.deleteAll();
    return reply(res, 200, { deleted: true });
  }
  throw httpError(404, 'not found');
}

async function glassesRoutes(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
  // pairing (no account yet)
  if (req.method === 'POST' && path === '/api/pair/start') {
    const pairId = randomBytes(12).toString('base64url');
    let code = '';
    do { code = String(randomInt(100000, 1000000)); } while ([...pairings.values()].some((p) => p.code === code));
    pairings.set(pairId, { code, exp: Date.now() + 10 * 60_000 });
    return reply(res, 200, { pairId, code, bot: bot?.username ?? '' });
  }
  if (req.method === 'GET' && path === '/api/pair/status') {
    const p = pairings.get(url.searchParams.get('pairId') ?? '');
    if (!p) return reply(res, 404, { error: 'expired' });
    if (p.token) pairings.delete(url.searchParams.get('pairId')!);
    return reply(res, 200, { token: p.token ?? null });
  }

  const a = await glassesAccount(req);
  if (req.method === 'GET' && path === '/api/home') return reply(res, 200, a.home());
  let m = path.match(/^\/api\/person\/([\w-]+)$/);
  if (req.method === 'GET' && m) {
    const p = await a.person(m[1]);
    return p ? reply(res, 200, p) : reply(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && path === '/api/find') {
    const p = a.findByName(url.searchParams.get('q') ?? '');
    return p ? reply(res, 200, await a.person(p.id)) : reply(res, 404, { error: 'no match' });
  }
  if (req.method === 'POST' && path === '/api/hear') {
    const pcm = await readBody(req);
    if (pcm.length < 3200) return reply(res, 400, { error: 'too little audio' });
    const text = await a.hear(pcm);
    const p = a.findByName(text);
    if (p) return reply(res, 200, { text, person: await a.person(p.id) });
    // not in their chats: someone new. Remember who they said they are.
    const met = text ? await a.meet(text).catch((e) => { console.log('meet failed:', e.message); return undefined; }) : undefined;
    return reply(res, 200, { text, person: null, met: met ?? null });
  }
  if (req.method === 'POST' && path === '/api/catch') {
    const session = url.searchParams.get('session') ?? '', personId = url.searchParams.get('personId') ?? '';
    const pcm = await readBody(req);
    if (!session || pcm.length < 3200) return reply(res, 200, { text: '', caught: [] });
    return reply(res, 200, await a.catchChunk(session, personId, pcm));
  }
  if (req.method === 'POST' && path === '/api/catch/end') {
    const r = a.endCatch(url.searchParams.get('session') ?? '');
    if (r.count && bot) {
      const lines = r.caught.map((x, i) => `${i + 1}. ${x.what}${x.due ? ` <i>(${x.due})</i>` : ''}`).join('\n');
      bot.notify(a.id, `🎙 <b>You promised ${r.personName}</b> in person:\n\n${lines}\n\nSaved in Kith. I'll remind you.`).catch(() => {});
    }
    return reply(res, 200, { count: r.count, person: r.person ?? null });
  }
  if (req.method === 'POST' && path === '/api/met/connect') {
    const id = a.connectMet(String((await json(req)).personId ?? ''));
    const p = await a.person(id);
    return reply(res, 200, { person: p, text: a.followUp(a.store.people[id]) });
  }
  if (req.method === 'POST' && path === '/api/met/forget') {
    a.forget(String((await json(req)).personId ?? ''));
    return reply(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/send') {
    const { personId, text, promiseId } = await json(req);
    const mode = await a.send(String(personId), String(text ?? '').slice(0, 1000), promiseId);
    return reply(res, 200, { ok: true, mode });
  }
  if (req.method === 'POST' && path === '/api/unpair') {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    await kv.del(`device:${token}`);
    return reply(res, 200, { ok: true });
  }
  throw httpError(404, 'not found');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') return reply(res, 204, {});
    if (path === '/health') return reply(res, 200, { ok: true });
    if (req.method === 'GET' && (path === '/mini' || path === '/mini/')) return html(res, '../miniapp/index.html');
    if (req.method === 'GET' && path === '/') return html(res, '../miniapp/landing.html');
    if (path.startsWith('/api/mini/')) return await miniRoutes(req, res, path);
    if (path.startsWith('/api/')) return await glassesRoutes(req, res, path, url);
    return reply(res, 404, { error: 'not found' });
  } catch (e: any) {
    if (!e.status || e.status >= 500) console.error(path, e);
    return reply(res, e.status ?? 500, { error: e.status ? e.message : 'Something went wrong. Try again.' });
  }
});

// Local convenience: import the old single-user login (.tg-session) as a user, so local dev keeps working.
async function importLocalSession() {
  if (process.env.DATABASE_URL || !existsSync('.tg-session')) return;
  const tg = new TelegramClient(new StringSession(readFileSync('.tg-session', 'utf8').trim()), API_ID, API_HASH, { connectionRetries: 3 });
  tg.setLogLevel('error' as any);
  await tg.connect();
  const me: any = await tg.getMe();
  const id = String(me.id);
  if (!(await kv.get<UserRec>(userKey(id)))?.session) {
    const demo = (process.env.KITH_DEMO_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const a = await saveLogin(id, me, String(tg.session.save()), 'Africa/Lagos');
    if (demo.length) { a.rec.chosen = demo; await a.saveRec(); }
    console.log(`Imported local Telegram login for @${me.username}`);
  }
  await tg.disconnect();
}

await importLocalSession().catch((e) => console.log('local import skipped:', e.message));
server.listen(PORT, () => console.log(`Kith server on :${PORT}  ${publicUrl() || '(no public URL yet)'}`));
bot = await startBot({ appUrl, adminId: ADMIN_ID }).catch((e) => { console.log('Bot failed to start:', e.message); return undefined; });
// warm up: refresh every user's chats on boot (one at a time)
(async () => {
  for (const id of await connectedUserIds()) {
    const a = await getAccount(id);
    await a?.index().catch((e) => console.log(`[${id}] index failed: ${e.message}`));
  }
})();
