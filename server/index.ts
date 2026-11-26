// Kith server: reads your own Telegram chats, finds people + promises with AI,
// serves them to the glasses app, and sends messages only when you confirm.
// Run: npm run server
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { startBot } from './bot.ts';

const PORT = 8787;
const GROQ = 'https://api.groq.com/openai/v1';
const LLM_MODEL = 'openai/gpt-oss-120b';
const STT_MODEL = 'whisper-large-v3-turbo';
const MAX_CHATS = Number(process.env.KITH_MAX_CHATS ?? 12);  // chats analysed at startup
const MSGS_PER_CHAT = 30;
// SAFE by default: "saved" sends to your own Saved Messages. Set KITH_SEND_MODE=live to send for real.
const SEND_MODE = process.env.KITH_SEND_MODE === 'live' ? 'live' : 'saved';
const CACHE = `data/${process.env.KITH_CACHE ?? 'cache'}.json`; // demo mode uses its own file
// Demo mode: only these chat IDs are visible (comma-separated), so filming never shows real contacts.
const DEMO_IDS = (process.env.KITH_DEMO_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);

// ---------- types ----------
type KPromise = { id: string; personId: string; what: string; dueISO: string; deliverText: string; done?: boolean };
type KPerson = {
  id: string; name: string; username?: string; who: string; lastTopic: string;
  lastChatISO: string; theyAsked: string; theyOwe?: string; theyOweDueISO?: string; note?: string; analyzedAt?: string;
};
type Store = { people: Record<string, KPerson>; promises: KPromise[] };

// ---------- store ----------
mkdirSync('data', { recursive: true });
const store: Store = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : { people: {}, promises: [] };
if (DEMO_IDS.length) { // hide everyone else
  for (const id of Object.keys(store.people)) if (!DEMO_IDS.includes(id)) delete store.people[id];
  store.promises = store.promises.filter((p) => DEMO_IDS.includes(p.personId));
}
const save = () => writeFileSync(CACHE, JSON.stringify(store, null, 2), { mode: 0o600 });
delete store.people['777000']; // Telegram service account, not a person
store.promises = store.promises.filter((p) => p.personId !== '777000');

// ---------- telegram ----------
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? '';
if (!existsSync('.tg-session')) throw new Error('No .tg-session: run npm run tg:login:qr first');
const tg = new TelegramClient(new StringSession(readFileSync('.tg-session', 'utf8').trim()), apiId, apiHash, { connectionRetries: 5 });
tg.setLogLevel('error' as any);
const entities = new Map<string, any>(); // personId -> Telegram entity (for sending)

// ---------- AI (Groq) ----------
async function groq(path: string, init: RequestInit, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(GROQ + path, { ...init, headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, ...(init.headers ?? {}) } });
    if (r.status === 429) {
      const wait = Number(r.headers.get('retry-after') ?? 5);
      console.log(`  rate limited, waiting ${wait}s`);
      await new Promise((res) => setTimeout(res, (wait + 1) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
  throw new Error('Groq: too many retries');
}

async function llmJSON(system: string, user: string): Promise<any> {
  const j = await groq('/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL, temperature: 0.2, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  return JSON.parse(j.choices[0].message.content);
}

const today = () => new Date().toISOString().slice(0, 10);

const ANALYZE_PROMPT = `You help the user remember people. You get the user's recent Telegram chat with one person.
Lines are "Me:" (the user) or "Them:" (the other person), with dates. Today is {TODAY}.
Return JSON only:
{
 "who": "their role/company if mentioned, max 4 words, else \\"\\"",
 "lastTopic": "what the latest conversation was about, max 6 words",
 "theyAsked": "an open question THEY asked that Me has not answered yet, max 6 words, else \\"\\"",
 "theyOwe": "the main thing THEY promised or were asked by Me to do/send, not yet done, max 5 words, else \\"\\"",
 "theyOweDue": "deadline words for that exactly as written, e.g. \\"monday\\", \\"tomorrow\\", \\"dec 3\\", else \\"\\"",
 "theyOweSaid": "YYYY-MM-DD date of the message that set that deadline, else \\"\\"",
 "promises": [ { "what": "thing Me owes them, max 5 words",
                 "due": "deadline words exactly as written, e.g. \\"friday\\", \\"tomorrow\\", \\"end of month\\", \\"dec 3\\", else \\"\\"",
                 "said": "YYYY-MM-DD date of the message that set the deadline",
                 "deliverText": "short friendly message Me could send now to deliver or update it, max 25 words" } ]
}
"promises" = things Me promised to do, OR things Them asked/reminded Me to do (e.g. \"don't forget to send the file\"), not yet done in the chat. Use [] if none.
Do not convert deadlines to dates; copy the words. Never invent facts.`;

async function analyzeChat(personId: string) {
  const entity = entities.get(personId);
  const p = store.people[personId];
  if (!entity || !p) return;
  const msgs = await tg.getMessages(entity, { limit: MSGS_PER_CHAT });
  const lines = msgs
    .filter((m: any) => m.message)
    .reverse()
    .map((m: any) => `${new Date(m.date * 1000).toISOString().slice(0, 10)} ${m.out ? 'Me' : 'Them'}: ${m.message.slice(0, 300)}`);
  if (!lines.length) return;
  const r = await llmJSON(ANALYZE_PROMPT.replace('{TODAY}', today()), `Chat with ${p.name}:\n${lines.join('\n')}`);
  p.who = r.who ?? ''; p.lastTopic = r.lastTopic ?? ''; p.theyAsked = r.theyAsked ?? '';
  p.theyOwe = r.theyOwe ?? ''; p.theyOweDueISO = resolveDue(r.theyOweDue, r.theyOweSaid);
  p.analyzedAt = new Date().toISOString();
  // replace this person's open promises with the fresh ones; keep ones the user already marked done
  const kept = store.promises.filter((x) => x.personId !== personId || x.done);
  const fresh = (r.promises ?? []).map((x: any, i: number) => ({
    id: `${personId}-${Date.now()}-${i}`, personId, what: String(x.what ?? '').slice(0, 40),
    dueISO: resolveDue(x.due, x.said), deliverText: x.deliverText ?? '',
  })).filter((x: KPromise) => x.what && !kept.some((k) => k.personId === personId && k.what === x.what));
  store.promises = [...kept, ...fresh];
  save();
}

/** Load private chats with real people (no bots, not yourself). */
async function loadDialogs() {
  const dialogs = [...(await tg.getDialogs({ limit: 150 })), ...(await tg.getDialogs({ limit: 50, archived: true }))]
    .sort((a: any, b: any) => b.date - a.date);
  const found: string[] = [];
  for (const d of dialogs as any[]) {
    if (found.includes(String(d.entity?.id))) continue;
    if (DEMO_IDS.length && !DEMO_IDS.includes(String(d.entity?.id))) continue;
    const e = d.entity;
    // skip bots, yourself, deleted accounts and Telegram's service account (777000)
    if (!d.isUser || !e || e.bot || e.self || e.deleted || String(e.id) === '777000') continue;
    const id = String(e.id);
    entities.set(id, e);
    const name = [e.firstName, e.lastName].filter(Boolean).join(' ') || e.username || 'Unknown';
    store.people[id] = {
      ...(store.people[id] ?? { who: '', lastTopic: '', theyAsked: '' }),
      id, name, username: e.username ?? undefined,
      lastChatISO: new Date(d.date * 1000).toISOString(),
    };
    found.push(id);
  }
  save();
  return found;
}

let indexing = false;
async function indexRecent() {
  if (indexing) return;
  indexing = true;
  try {
    const ids = (await loadDialogs()).slice(0, MAX_CHATS);
    console.log(`Indexing ${ids.length} recent chats...`);
    for (const id of ids) {
      try { await analyzeChat(id); console.log(`  ok: ${store.people[id].name}`); }
      catch (e: any) { console.log(`  skip ${store.people[id].name}: ${e.message}`); }
    }
    console.log(`Index done: ${openPromises().length} open promises.`);
  } finally { indexing = false; }
}

/** Turn deadline words ("friday", "tomorrow", "dec 3") into YYYY-MM-DD, relative to when it was said. */
export function resolveDue(words?: string, saidISO?: string): string {
  const w = (words ?? '').toLowerCase().trim();
  if (!w) return '';
  const base = /^\d{4}-\d{2}-\d{2}$/.test(saidISO ?? '') ? new Date(saidISO + 'T12:00:00Z') : new Date(today() + 'T12:00:00Z');
  const add = (d: number) => new Date(base.getTime() + d * 86400000).toISOString().slice(0, 10);
  if (/\b(today|tonight|asap|now)\b/.test(w)) return add(0);
  if (/\btomorrow\b/.test(w)) return add(1);
  if (/\bnext week\b/.test(w)) return add(7);
  const next = (day: number) => add((day - base.getUTCDay() + 7) % 7 || 7); // next such weekday after it was said
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const i = days.findIndex((d) => w.includes(d) || new RegExp(`\\b${d.slice(0, 3)}\\b`).test(w));
  if (i >= 0) return next(i); // "this friday", "by friday evening"
  if (/\bnext week\b/.test(w)) return add(7);
  if (/\bweekend\b/.test(w)) return next(6);
  if (/\bend of (the |this )?week\b|\bthis week\b/.test(w)) return next(5);
  if (/\bend of (the |this )?month\b|\bthis month\b/.test(w)) return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  if (/\bnext month\b/.test(w)) return add(30);
  const inN = w.match(/\bin (\d+|a|one|two|three) (day|week)s?\b/);
  if (inN) { const n = { a: 1, one: 1, two: 2, three: 3 }[inN[1]] ?? Number(inN[1]); return add(n * (inN[2] === 'week' ? 7 : 1)); }
  // Explicit dates only ("dec 3", "3 december", "12/03"). Date.parse turns junk like "soon" into Jan 1, so require a month or digits.
  const months = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/;
  if (!months.test(w) && !/\d{1,2}[\/.-]\d{1,2}/.test(w)) return '';
  const parsed = Date.parse(`${w.replace(/\b(by|before|on|the|of)\b|(st|nd|rd|th)\b/g, ' ')} ${base.getUTCFullYear()} 12:00 UTC`);
  if (isNaN(parsed)) return '';
  let d = new Date(parsed);
  if (d.getTime() < base.getTime() - 30 * 86400000) d = new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate(), 12));
  return d.toISOString().slice(0, 10);
}

// ---------- views for the glasses ----------
const openPromises = () => store.promises.filter((p) => !p.done);

function dueLabel(iso: string) {
  if (!iso) return '';
  const days = Math.round((Date.parse(iso) - Date.parse(today())) / 86400000);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return new Date(iso + 'T12:00:00Z').toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' });
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function ago(iso: string) {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (d <= 0) return 'today';
  if (d < 7) return `${d}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

const promiseView = (p: KPromise) => ({ ...p, due: dueLabel(p.dueISO), overdue: !!p.dueISO && p.dueISO < today() });
const personView = (p: KPerson) => ({
  ...p, org: p.who === p.name ? '' : p.who,
  theyOwe: p.theyOwe ? `${p.theyOwe}${p.theyOweDueISO ? ` (${dueLabel(p.theyOweDueISO)})` : ''}` : '',
  lastChat: `${ago(p.lastChatISO)}${p.lastTopic ? ': ' + p.lastTopic : ''}`,
  promises: openPromises().filter((x) => x.personId === p.id).map(promiseView),
});

function sortPromises(list: KPromise[]) {
  return [...list].sort((a, b) => (a.dueISO || '9999').localeCompare(b.dueISO || '9999'));
}

/** Match a spoken phrase ("Hi, I'm Ahmed from TVM") to a person. */
function findByName(text: string): KPerson | undefined {
  const words = text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
  let best: KPerson | undefined, bestScore = 0;
  for (const p of Object.values(store.people)) {
    const parts = [...p.name.toLowerCase().split(/\s+/), p.username?.toLowerCase() ?? ''].filter((x) => x.length > 1);
    const score = parts.filter((part) => words.includes(part)).length;
    const recent = Date.parse(p.lastChatISO) / 1e13; // tie-break: more recent chat wins
    if (score > 0 && score + recent > bestScore) { best = p; bestScore = score + recent; }
  }
  return best;
}

async function lookup(personId: string) {
  const p = store.people[personId];
  if (p && !p.analyzedAt) { try { await analyzeChat(personId); } catch (e: any) { console.log('analyze failed:', e.message); } }
  return p;
}

// ---------- speech to text ----------
function pcmToWav(pcm: Buffer, sampleRate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function transcribe(pcm: Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', STT_MODEL);
  form.append('language', 'en');
  const j = await groq('/audio/transcriptions', { method: 'POST', body: form });
  return (j.text ?? '').trim();
}

// ---------- sending ----------
async function send(personId: string, text: string) {
  const p = store.people[personId];
  if (!p) throw new Error('unknown person');
  if (DEMO_IDS.length && !DEMO_IDS.includes(personId)) throw new Error('demo mode: can only send to demo chats');
  if (SEND_MODE === 'live') {
    await tg.sendMessage(entities.get(personId) ?? p.username ?? personId, { message: text });
  } else {
    await tg.sendMessage('me', { message: `[Kith test, would send to ${p.name}]\n${text}` });
  }
  return SEND_MODE;
}

// ---------- promise catcher (live conversation) ----------
const CATCH_PROMPT = `The user is wearing smart glasses during a face-to-face conversation with {NAME}.
You get a fresh piece of the speech transcript. Today is {TODAY} ({WEEKDAY}).
Find commitments the user makes out loud ("I'll send you...", "I will call you tomorrow", "let me intro you to...").
Already known promises (do not repeat them): {KNOWN}
Return JSON only: { "promises": [ { "what": "max 5 words, e.g. send pitch deck",
  "due": "deadline words exactly as said, e.g. friday, tomorrow, next week, else \"\"",
  "deliverText": "short friendly message the user could later send to deliver it, max 25 words" } ] }
Use [] if there is no clear commitment. Never invent.`;

type CatchSession = { personId: string; transcript: string[]; caught: string[] };
const sessions = new Map<string, CatchSession>();

async function catchChunk(sessionId: string, personId: string, pcm: Buffer) {
  const p = store.people[personId];
  if (!p) throw new Error('unknown person');
  let s = sessions.get(sessionId);
  if (!s) { s = { personId, transcript: [], caught: [] }; sessions.set(sessionId, s); }
  const text = await transcribe(pcm);
  if (!text || text.length < 4) return { text: '', caught: [] as any[] };
  s.transcript.push(text);
  const known = openPromises().filter((x) => x.personId === personId).map((x) => x.what);
  const recent = s.transcript.slice(-2).join(' '); // include previous chunk so split sentences still match
  const r = await llmJSON(
    CATCH_PROMPT.replace('{NAME}', p.name).replace('{TODAY}', today())
      .replace('{WEEKDAY}', new Date().toLocaleDateString('en', { weekday: 'long' }))
      .replace('{KNOWN}', known.length ? known.join('; ') : 'none'),
    recent,
  );
  for (const x of r.promises ?? []) console.log(`  caught: "${x.what}" due words: "${x.due}" -> ${resolveDue(x.due, today()) || "no date"}`);
  const fresh: KPromise[] = (r.promises ?? [])
    .filter((x: any) => x.what && !known.some((k) => k.toLowerCase() === String(x.what).toLowerCase()))
    .map((x: any, i: number) => ({
      id: `${personId}-spoken-${Date.now()}-${i}`, personId, what: String(x.what).slice(0, 40),
      dueISO: resolveDue(x.due, today()), deliverText: x.deliverText ?? '',
    }));
  store.promises.push(...fresh);
  s.caught.push(...fresh.map((x) => x.id));
  if (fresh.length) save();
  return { text, caught: fresh.map(promiseView) };
}

let notifyOwner: ((html: string) => Promise<void>) | undefined;

async function endCatch(sessionId: string) {
  const s = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (!s) return { count: 0 };
  const p = store.people[s.personId];
  const caught = store.promises.filter((x) => s.caught.includes(x.id)).map(promiseView);
  if (caught.length && notifyOwner) {
    const lines = caught.map((x, i) => `${i + 1}. ${x.what}${x.due ? ` <i>(${x.due})</i>` : ''}`).join('\n');
    await notifyOwner(`🎙 <b>You promised ${p?.name ?? 'someone'}</b> in person:\n\n${lines}\n\nSaved in Kith. I'll remind you.`).catch(() => {});
  }
  return { count: caught.length, caught };
}

// ---------- http ----------
const readBody = (req: IncomingMessage) => new Promise<Buffer>((res, rej) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c)); req.on('end', () => res(Buffer.concat(chunks))); req.on('error', rej);
});

function reply(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') return reply(res, 204, {});

    if (req.method === 'GET' && path === '/api/home') {
      const owed = sortPromises(openPromises()).map((p) => ({ ...promiseView(p), personName: store.people[p.personId]?.name ?? '?' }));
      return reply(res, 200, { owed, people: Object.keys(store.people).length, indexing, sendMode: SEND_MODE });
    }

    let m = path.match(/^\/api\/person\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      const p = await lookup(m[1]);
      return p ? reply(res, 200, personView(p)) : reply(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET' && path === '/api/find') {
      const p = findByName(url.searchParams.get('q') ?? '');
      if (!p) return reply(res, 404, { error: 'no match' });
      await lookup(p.id);
      return reply(res, 200, personView(p));
    }

    if (req.method === 'POST' && path === '/api/hear') {
      // body: raw PCM, 16 kHz, signed 16-bit LE mono
      const pcm = await readBody(req);
      if (pcm.length < 3200) return reply(res, 400, { error: 'too little audio' });
      const text = await transcribe(pcm);
      const p = findByName(text);
      if (p) await lookup(p.id);
      return reply(res, 200, { text, person: p ? personView(p) : null });
    }

    if (req.method === 'POST' && path === '/api/catch') {
      // body: raw PCM chunk; query: session, personId
      const sessionId = url.searchParams.get('session') ?? '', personId = url.searchParams.get('personId') ?? '';
      const pcm = await readBody(req);
      if (!sessionId || pcm.length < 3200) return reply(res, 200, { text: '', caught: [] });
      return reply(res, 200, await catchChunk(sessionId, personId, pcm));
    }

    if (req.method === 'POST' && path === '/api/catch/end') {
      return reply(res, 200, await endCatch(url.searchParams.get('session') ?? ''));
    }

    if (req.method === 'POST' && path === '/api/send') {
      const { personId, text, promiseId } = JSON.parse((await readBody(req)).toString() || '{}');
      const mode = await send(personId, String(text ?? '').slice(0, 1000));
      if (promiseId) { const pr = store.promises.find((x) => x.id === promiseId); if (pr) { pr.done = true; save(); } }
      return reply(res, 200, { ok: true, mode });
    }

    m = path.match(/^\/api\/promise\/([\w-]+)\/done$/);
    if (req.method === 'POST' && m) {
      const pr = store.promises.find((x) => x.id === m![1]);
      if (pr) { pr.done = true; save(); }
      return reply(res, 200, { ok: !!pr });
    }

    if (req.method === 'POST' && path === '/api/reindex') {
      indexRecent();
      return reply(res, 202, { ok: true });
    }

    return reply(res, 404, { error: 'not found' });
  } catch (e: any) {
    console.error(path, e);
    return reply(res, 500, { error: e.message });
  }
});

await tg.connect();
const me: any = await tg.getMe();
console.log(`Telegram connected as @${me.username}. Send mode: ${SEND_MODE.toUpperCase()}${DEMO_IDS.length ? `. DEMO MODE: ${DEMO_IDS.length} chats only` : ''}`);
server.listen(PORT, () => console.log(`Kith server on http://localhost:${PORT}`));
indexRecent();
startBot({
  ownerId: String(me.id),
  owed: () => sortPromises(openPromises()).map((p) => ({ ...promiseView(p), personName: store.people[p.personId]?.name ?? '?' })),
  markDone: (id) => { const pr = store.promises.find((x) => x.id === id && !x.done); if (pr) { pr.done = true; save(); } return !!pr; },
  digestHour: Number(process.env.KITH_DIGEST_HOUR ?? 8),
}).then((b) => { if (b) notifyOwner = b.notify; }).catch((e) => console.log('Bot failed to start:', e.message));
