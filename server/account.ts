// One Kith user: their Telegram connection, the people and promises found in their chosen chats.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { kv, encrypt, decrypt } from './db.ts';
import { llmJSON, transcribe, resolveDue, today, ANALYZE_PROMPT, CATCH_PROMPT, INTRO_PROMPT } from './ai.ts';
import { Api } from 'telegram';

export const API_ID = Number(process.env.TELEGRAM_API_ID);
export const API_HASH = process.env.TELEGRAM_API_HASH ?? '';
const MSGS_PER_CHAT = 30;
export const MAX_CHOSEN = 15;          // chats a user may let Kith read (protects the shared AI quota)
const IDLE_MS = 20 * 60_000;           // disconnect from Telegram after 20 idle minutes
// Filming only: limit every account to these chat IDs so no real contacts appear on screen.
const DEMO_IDS = (process.env.KITH_DEMO_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export type KPromise = { id: string; personId: string; what: string; dueISO: string; deliverText: string; done?: boolean; spoken?: boolean };
export type KPerson = {
  id: string; name: string; username?: string; who: string; lastTopic: string; lastChatISO: string;
  theyAsked: string; theyOwe?: string; theyOweDueISO?: string; analyzedAt?: string;
  // people met in person (no chat needed): when, what you talked about, and a Telegram account they said
  metAt?: string; notes?: string[]; tgCandidate?: { id: string; username: string; name: string };
};
export type Store = { people: Record<string, KPerson>; promises: KPromise[] };
export type UserRec = {
  id: string; name: string; username?: string; session?: string; // session is encrypted
  createdAt: string; chosen: string[]; sendMode: 'saved' | 'live'; digestHour: number; tz: string;
  lastDigest?: string; lastIndex?: string; lastMeetRecap?: string;
};

export const userKey = (id: string) => `user:${id}`;
const storeKey = (id: string) => `store:${id}`;

const accounts = new Map<string, Account>();

/** Get the loaded account for a Telegram user id (connected user), or undefined if not signed up. */
export async function getAccount(id: string): Promise<Account | undefined> {
  let a = accounts.get(id);
  if (a) return a;
  const rec = await kv.get<UserRec>(userKey(id));
  if (!rec?.session) return;
  const store = (await kv.get<Store>(storeKey(id))) ?? { people: {}, promises: [] };
  a = new Account(rec, store);
  accounts.set(id, a);
  return a;
}

/** Create or update the user record after a successful Telegram login. */
export async function saveLogin(id: string, me: any, session: string, tz?: string): Promise<Account> {
  const old = await kv.get<UserRec>(userKey(id));
  const rec: UserRec = {
    chosen: [], sendMode: 'saved', digestHour: 8, tz: tz || 'UTC', createdAt: new Date().toISOString(),
    ...old,
    id, name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'You',
    username: me.username ?? undefined, session: encrypt(session),
  };
  await kv.set(userKey(id), rec);
  accounts.get(id)?.disconnect();
  accounts.delete(id);
  return (await getAccount(id))!;
}

export async function connectedUserIds() {
  return (await kv.keys('user:')).map((k) => k.slice(5));
}

export class Account {
  private tg?: TelegramClient;
  private connecting?: Promise<TelegramClient>;
  private entities = new Map<string, any>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  indexing = false;
  private catches = new Map<string, { personId: string; transcript: string[]; caught: string[] }>();

  rec: UserRec;
  store: Store;
  constructor(rec: UserRec, store: Store) { this.rec = rec; this.store = store; }
  get id() { return this.rec.id; }

  // ---------- Telegram connection (lazy, closes when idle) ----------
  async client(): Promise<TelegramClient> {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.disconnect(), IDLE_MS);
    if (this.tg?.connected) return this.tg;
    if (!this.connecting) {
      this.connecting = (async () => {
        const tg = new TelegramClient(new StringSession(decrypt(this.rec.session!)), API_ID, API_HASH, { connectionRetries: 3 });
        tg.setLogLevel('error' as any);
        await tg.connect();
        if (!(await tg.checkAuthorization())) throw Object.assign(new Error('Telegram session ended. Connect again in the Kith app.'), { status: 401 });
        this.tg = tg;
        return tg;
      })().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  disconnect() { clearTimeout(this.idleTimer); this.tg?.disconnect().catch(() => {}); this.tg = undefined; }

  // ---------- persistence ----------
  save() { // debounced
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => kv.set(storeKey(this.id), this.store).catch((e) => console.log('save failed', e.message)), 300);
  }
  async saveRec() { await kv.set(userKey(this.id), this.rec); }

  /** Delete everything Kith knows about this user and log the session out of Telegram. */
  async deleteAll() {
    try { const tg = await this.client(); await tg.invoke(new (await import('telegram')).Api.auth.LogOut()); } catch {}
    this.disconnect();
    accounts.delete(this.id);
    await kv.del(storeKey(this.id));
    await kv.del(userKey(this.id));
    for (const k of await kv.keys('device:')) if ((await kv.get<string>(k)) === this.id) await kv.del(k);
  }

  // ---------- chats ----------
  /** Recent private chats with real people (for the chat picker). */
  async loadDialogs() {
    const tg = await this.client();
    const dialogs = [...(await tg.getDialogs({ limit: 100 })), ...(await tg.getDialogs({ limit: 30, archived: true }))]
      .sort((a: any, b: any) => b.date - a.date);
    const found: string[] = [];
    for (const d of dialogs as any[]) {
      const e = d.entity;
      if (!d.isUser || !e || e.bot || e.self || e.deleted || String(e.id) === '777000') continue;
      const id = String(e.id);
      if (found.includes(id) || (DEMO_IDS.length && !DEMO_IDS.includes(id))) continue;
      this.entities.set(id, e);
      const name = [e.firstName, e.lastName].filter(Boolean).join(' ') || e.username || 'Unknown';
      this.store.people[id] = {
        ...(this.store.people[id] ?? { who: '', lastTopic: '', theyAsked: '' }),
        id, name, username: e.username ?? undefined, lastChatISO: new Date(d.date * 1000).toISOString(),
      };
      found.push(id);
    }
    // people outside the recent list who are not chosen: drop them
    for (const id of Object.keys(this.store.people)) if (!found.includes(id) && !this.mine(id)) delete this.store.people[id];
    this.save();
    return found;
  }

  /** Telegram entity for a chat (loads the chat list once after a restart). */
  private async entity(personId: string) {
    if (!this.entities.has(personId)) await this.loadDialogs();
    return this.entities.get(personId) ?? this.store.people[personId]?.username ?? personId;
  }

  async analyzeChat(personId: string) {
    const p = this.store.people[personId];
    if (!p || !this.mine(personId)) return;
    const tg = await this.client();
    const entity = await this.entity(personId);
    const msgs = await tg.getMessages(entity, { limit: MSGS_PER_CHAT });
    const lines = msgs.filter((m: any) => m.message).reverse()
      .map((m: any) => `${new Date(m.date * 1000).toISOString().slice(0, 10)} ${m.out ? 'Me' : 'Them'}: ${m.message.slice(0, 300)}`);
    if (!lines.length) return;
    const r = await llmJSON(ANALYZE_PROMPT.replace('{TODAY}', today()), `Chat with ${p.name}:\n${lines.join('\n')}`);
    p.who = r.who || p.who || ''; p.lastTopic = r.lastTopic ?? ''; p.theyAsked = r.theyAsked ?? '';
    p.theyOwe = r.theyOwe ?? ''; p.theyOweDueISO = resolveDue(r.theyOweDue, r.theyOweSaid);
    p.analyzedAt = new Date().toISOString();
    // replace chat-found open promises; keep done ones and ones caught out loud (they are not in the chat)
    const kept = this.store.promises.filter((x) => x.personId !== personId || x.done || x.spoken || x.id.includes('-spoken-'));
    const fresh = (r.promises ?? []).map((x: any, i: number) => ({
      id: `${personId}-${Date.now()}-${i}`, personId, what: String(x.what ?? '').slice(0, 40),
      dueISO: resolveDue(x.due, x.said), deliverText: x.deliverText ?? '',
    })).filter((x: KPromise) => x.what && !kept.some((k) => k.personId === personId && k.what === x.what));
    this.store.promises = [...kept, ...fresh];
    this.save();
  }

  /** Re-read all chosen chats. */
  async index() {
    if (this.indexing) return;
    this.indexing = true;
    try {
      await this.loadDialogs();
      for (const id of this.rec.chosen) {
        try { await this.analyzeChat(id); } catch (e: any) { console.log(`[${this.id}] skip chat: ${e.message}`); }
      }
      this.rec.lastIndex = new Date().toISOString();
      await this.saveRec();
    } finally { this.indexing = false; }
  }

  async setChosen(ids: string[]) {
    const valid = ids.map(String).filter((id) => this.store.people[id] && !id.startsWith('met-')).slice(0, MAX_CHOSEN);
    this.rec.chosen = valid;
    // forget what Kith learned from chats that were switched off
    for (const p of Object.values(this.store.people)) if (!valid.includes(p.id) && !p.metAt) {
      Object.assign(p, { who: '', lastTopic: '', theyAsked: '', theyOwe: '', theyOweDueISO: '', analyzedAt: undefined });
      this.store.promises = this.store.promises.filter((x) => x.personId !== p.id || x.done);
    }
    await this.saveRec();
    this.save();
    this.index().catch((e) => console.log(`[${this.id}] index failed: ${e.message}`));
  }

  // ---------- views ----------
  /** People Kith may use: chats the user chose, plus people they met in person. */
  mine(id: string) { return this.rec.chosen.includes(id) || !!this.store.people[id]?.metAt; }
  open() { return this.store.promises.filter((p) => !p.done && this.mine(p.personId)); }
  sorted(list: KPromise[]) { return [...list].sort((a, b) => (a.dueISO || '9999').localeCompare(b.dueISO || '9999')); }
  promiseView = (p: KPromise) => ({ ...p, due: dueLabel(p.dueISO), overdue: !!p.dueISO && p.dueISO < today(), personName: this.store.people[p.personId]?.name ?? '?' });
  personView = (p: KPerson) => ({
    ...p, org: p.who === p.name ? '' : p.who, met: !!p.metAt, connected: !p.id.startsWith('met-'),
    theyOwe: p.theyOwe ? `${p.theyOwe}${p.theyOweDueISO ? ` (${dueLabel(p.theyOweDueISO)})` : ''}` : '',
    lastChat: p.metAt && !p.analyzedAt ? `met ${ago(p.metAt)}` : `${ago(p.lastChatISO)}${p.lastTopic ? ': ' + p.lastTopic : ''}`,
    promises: this.open().filter((x) => x.personId === p.id).map(this.promiseView),
  });
  owed() { return this.sorted(this.open()).map(this.promiseView); }
  chosenPeople() { return Object.values(this.store.people).filter((p) => this.mine(p.id)); }
  metPeople() { return Object.values(this.store.people).filter((p) => p.metAt).sort((a, b) => b.metAt!.localeCompare(a.metAt!)); }

  home() { return { owed: this.owed(), people: this.rec.chosen.length, indexing: this.indexing, sendMode: this.rec.sendMode }; }

  async person(id: string) {
    const p = this.store.people[id];
    if (!p || !this.mine(id)) return;
    if (!p.analyzedAt && this.rec.chosen.includes(id)) await this.analyzeChat(id).catch(() => {});
    return this.personView(p);
  }

  miniState() {
    const people = this.chosenPeople().filter((p) => p.analyzedAt && !p.metAt)
      .sort((a, b) => b.lastChatISO.localeCompare(a.lastChatISO)).map(this.personView);
    return {
      me: { name: this.rec.name, sendMode: this.rec.sendMode, digestHour: this.rec.digestHour, tz: this.rec.tz, maxChats: MAX_CHOSEN },
      owed: this.owed(),
      met: this.metPeople().map((p) => ({ ...this.personView(p), suggest: this.suggestLinks(p) })),
      kept: this.store.promises.filter((p) => p.done && this.mine(p.personId)).slice(-10).reverse().map(this.promiseView),
      theyOwe: people.filter((p) => p.theyOwe).map((p) => ({ personId: p.id, personName: p.name, what: p.theyOwe })),
      people,
      chats: Object.values(this.store.people).filter((p) => !p.id.startsWith('met-')).sort((a, b) => b.lastChatISO.localeCompare(a.lastChatISO)).slice(0, 60)
        .map((p) => ({ id: p.id, name: p.name, lastChat: ago(p.lastChatISO), chosen: this.rec.chosen.includes(p.id), read: !!p.analyzedAt })),
      indexing: this.indexing,
      demo: DEMO_IDS.length > 0,
    };
  }

  editPromise(id: string, b: any) {
    const pr = this.store.promises.find((x) => x.id === id);
    if (!pr) return false;
    if (b.delete) this.store.promises = this.store.promises.filter((x) => x !== pr);
    if (typeof b.done === 'boolean') pr.done = b.done;
    if (typeof b.what === 'string' && b.what.trim()) pr.what = b.what.trim().slice(0, 40);
    if (typeof b.dueISO === 'string' && (b.dueISO === '' || /^\d{4}-\d{2}-\d{2}$/.test(b.dueISO))) pr.dueISO = b.dueISO;
    this.save();
    return true;
  }

  // ---------- names & voice ----------
  /** Match a spoken phrase ("Hi, I'm Ahmed from TVM") to a person. Tolerates speech-to-text slips ("Vim Vim" -> Bimbim). */
  findByName(text: string): KPerson | undefined {
    const words = text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const heard = [...words, ...words.slice(1).map((w, i) => words[i] + w)].filter((w) => w.length > 1);
    let best: KPerson | undefined, bestScore = 0;
    for (const p of this.chosenPeople()) {
      const parts = [...p.name.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/), p.username?.toLowerCase() ?? ''].filter((x) => x.length > 1);
      let score = 0;
      for (const part of parts) {
        if (heard.includes(part)) { score += 1; continue; }
        if (part.length >= 4 && heard.some((w) => Math.abs(w.length - part.length) <= 2 && editDistance(w, part) <= Math.floor(part.length / 3))) score += 0.6;
      }
      const recent = Date.parse(p.lastChatISO) / 1e13; // tie-break: more recent chat wins
      if (score > 0 && score + recent > bestScore) { best = p; bestScore = score + recent; }
    }
    return best;
  }

  hear(pcm: Buffer) { return transcribe(pcm, this.chosenPeople().map((p) => p.name)); }

  async catchChunk(sessionId: string, personId: string, pcm: Buffer) {
    const p = this.store.people[personId];
    if (!p) throw new Error('unknown person');
    let s = this.catches.get(sessionId);
    if (!s) { s = { personId, transcript: [], caught: [] }; this.catches.set(sessionId, s); }
    const text = await transcribe(pcm, [p.name]);
    if (!text || text.length < 4) return { text: '', caught: [] as any[] };
    s.transcript.push(text);
    const known = this.open().filter((x) => x.personId === personId).map((x) => x.what);
    if (p.metAt) this.learnAboutMet(p, s.transcript.slice(-2).join(' ')).catch((e) => console.log('met notes failed:', e.message));
    const r = await llmJSON(
      CATCH_PROMPT.replace('{NAME}', p.name).replace('{TODAY}', today())
        .replace('{WEEKDAY}', new Date().toLocaleDateString('en', { weekday: 'long' }))
        .replace('{KNOWN}', known.length ? known.join('; ') : 'none'),
      s.transcript.slice(-2).join(' '), // include the previous chunk so split sentences still match
    );
    const fresh: KPromise[] = (r.promises ?? [])
      .filter((x: any) => x.what && !known.some((k) => k.toLowerCase() === String(x.what).toLowerCase()))
      .map((x: any, i: number) => ({
        id: `${personId}-spoken-${Date.now()}-${i}`, personId, what: String(x.what).slice(0, 40), spoken: true,
        dueISO: resolveDue(x.due, today()), deliverText: x.deliverText ?? '',
      }));
    this.store.promises.push(...fresh);
    s.caught.push(...fresh.map((x) => x.id));
    if (fresh.length) this.save();
    return { text, caught: fresh.map(this.promiseView) };
  }

  endCatch(sessionId: string) {
    const s = this.catches.get(sessionId);
    this.catches.delete(sessionId);
    if (!s) return { count: 0, caught: [], personName: '' };
    const caught = this.store.promises.filter((x) => s.caught.includes(x.id)).map(this.promiseView);
    const p = this.store.people[s.personId];
    return { count: caught.length, caught, personName: p?.name ?? 'someone', person: p && this.mine(p.id) ? this.personView(p) : undefined };
  }

  // ---------- meeting new people (no chat history needed) ----------
  /** Someone introduced themselves and is not in the user's chats: pull out who they are and remember them. */
  async meet(text: string) {
    const r = await llmJSON(INTRO_PROMPT, text);
    const name = String(r.name ?? '').trim().slice(0, 40);
    if (!name) return;
    // the same person introduced again today: reuse
    const again = this.metPeople().find((x) => x.name.toLowerCase() === name.toLowerCase() && x.metAt!.slice(0, 10) === today());
    const p: KPerson = again ?? {
      id: `met-${Date.now().toString(36)}`, name, who: '', lastTopic: '', theyAsked: '',
      lastChatISO: new Date().toISOString(), metAt: new Date().toISOString(), notes: [],
    };
    if (r.org) p.who = String(r.org).slice(0, 40);
    if (r.topic) addNote(p, r.topic);
    this.store.people[p.id] = p;
    if (r.telegram) await this.setCandidate(p, r.telegram).catch((e) => console.log('telegram lookup failed:', e.message));
    this.save();
    return this.personView(p);
  }

  private async learnAboutMet(p: KPerson, text: string) {
    const r = await llmJSON(INTRO_PROMPT, `(Already known: ${p.name}${p.who ? ', ' + p.who : ''}.)
${text}`);
    if (r.org && !p.who) p.who = String(r.org).slice(0, 40);
    if (r.topic) addNote(p, r.topic);
    if (r.telegram && p.id.startsWith('met-')) await this.setCandidate(p, r.telegram).catch((e) => console.log('telegram lookup failed:', e.message));
    this.save();
  }

  /** Look up a Telegram username they said or typed. The user confirms before anything is sent. */
  async setCandidate(p: KPerson, raw: string) {
    const username = String(raw).trim().replace(/^@/, '').replace(/\s+/g, '').replace(/[^\w]/g, '');
    if (username.length < 4) throw new Error('That username looks too short.');
    const tg = await this.client();
    const r: any = await tg.invoke(new Api.contacts.ResolveUsername({ username }));
    const uid = r.peer?.userId ? String(r.peer.userId) : "";
    const u = uid ? r.users?.find((x: any) => String(x.id) === uid) : undefined;
    if (u?.self) throw Object.assign(new Error("That username is you."), { status: 400 });
    if (!u || u.bot || u.deleted) throw Object.assign(new Error(`No Telegram person @${username}. Check the spelling.`), { status: 404 });
    this.entities.set(String(u.id), u);
    p.tgCandidate = { id: String(u.id), username: u.username ?? username, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || username };
    this.save();
    return p.tgCandidate;
  }

  /** Turn a met person into a Telegram contact (after the user confirmed who it is). Returns the new person id. */
  connectMet(metId: string, targetId?: string) {
    const p = this.store.people[metId];
    if (!p?.metAt || !metId.startsWith('met-')) throw Object.assign(new Error('not found'), { status: 404 });
    const to = targetId ?? p.tgCandidate?.id;
    if (!to) throw Object.assign(new Error('No Telegram account yet. Type their @username.'), { status: 400 });
    const existing = this.store.people[to];
    const merged: KPerson = existing
      ? { ...existing, metAt: p.metAt, notes: [...(existing.notes ?? []), ...(p.notes ?? [])], who: existing.who || p.who }
      : { ...p, id: to, name: p.tgCandidate?.name || p.name, username: p.tgCandidate?.username, tgCandidate: undefined };
    if (!merged.metAt) merged.metAt = p.metAt;
    this.store.people[to] = merged;
    for (const x of this.store.promises) if (x.personId === metId) x.personId = to;
    delete this.store.people[metId];
    this.save();
    return to;
  }

  forget(id: string) {
    const p = this.store.people[id];
    if (!p?.metAt) return false;
    if (id.startsWith('met-')) { delete this.store.people[id]; this.store.promises = this.store.promises.filter((x) => x.personId !== id); }
    else { p.metAt = undefined; p.notes = undefined; } // a real chat: just drop the meeting notes
    this.save();
    return true;
  }

  /** Chats that might be this met person (same first name, chatted since you met). Shown in the Mini App to link. */
  suggestLinks(p: KPerson) {
    if (!p.id.startsWith('met-')) return [];
    const first = p.name.toLowerCase().split(' ')[0];
    return Object.values(this.store.people)
      .filter((x) => !x.id.startsWith('met-') && x.name.toLowerCase().split(' ').some((w) => w === first || (first.length >= 4 && editDistance(w, first) <= 1)))
      .slice(0, 3).map((x) => ({ id: x.id, name: x.name }));
  }

  followUp(p: KPerson) {
    const first = firstName(p.name), me = firstName(this.rec.name);
    const mine = this.open().filter((x) => x.personId === p.id);
    const owe = mine.find((x) => x.spoken) ?? mine[0]; // what you promised in person comes first
    return owe?.deliverText ||
      `Great meeting you today, ${first}! It's ${me}${p.notes?.length ? `, we talked about ${p.notes[p.notes.length - 1].toLowerCase()}` : ''}. Let's keep in touch.`;
  }

  // ---------- sending ----------
  async send(personId: string, text: string, promiseId?: string) {
    const p = this.store.people[personId];
    if (!p || !this.mine(personId) || personId.startsWith('met-')) throw new Error('Kith can only message chats you chose or people you connected');
    const tg = await this.client();
    if (this.rec.sendMode === 'live') {
      await tg.sendMessage(await this.entity(personId), { message: text });
    } else {
      await tg.sendMessage('me', { message: `[Kith test mode, would send to ${p.name}]\n${text}` });
    }
    if (promiseId) { const pr = this.store.promises.find((x) => x.id === promiseId); if (pr) { pr.done = true; this.save(); } }
    return this.rec.sendMode;
  }
}

// ---------- small helpers ----------
const firstName = (name: string) => name.split(' ')[0] || name;
function addNote(p: KPerson, note: string) {
  const n = String(note).trim().slice(0, 60);
  if (!n) return;
  p.notes = [...(p.notes ?? []).filter((x) => x.toLowerCase() !== n.toLowerCase()), n].slice(-5);
}

export function dueLabel(iso: string) {
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

function editDistance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
