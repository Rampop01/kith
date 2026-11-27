import {
  waitForEvenAppBridge,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  CreateStartUpPageContainer,
  AudioInputSource,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { api, setToken, type Person, type Home } from './api';

// G2 display: 576 x 288, monochrome. One container captures input.
// Gestures: tap = select / confirm, double tap = back, hold = listen for a name.

type Screen =
  | { kind: 'home'; home: Home }
  | { kind: 'person'; person: Person }
  | { kind: 'actions'; person: Person }
  | { kind: 'confirm'; person: Person; text: string; promiseId?: string }
  | { kind: 'connect'; person: Person }
  | { kind: 'listening' }
  | { kind: 'catching'; person: Person; caught: string[]; heard: string }
  | { kind: 'message'; text: string; then?: () => void }
  | { kind: 'pairing' };

const W = 576, H = 288;
const HEADER = { containerID: 1, containerName: 'header' };
const BODY = { containerID: 2, containerName: 'body' };

let bridge: EvenAppBridge;
let first = true;
let screen: Screen | { kind: 'boot' } = { kind: 'boot' };
let listItems: (() => void)[] = [];
let busy = false;             // ignore input while a request is in flight
let audio: Uint8Array[] = []; // mic frames while holding / catching
let catchSession = '';
let catchTimer: ReturnType<typeof setInterval> | undefined;

const debug = (msg: string) => {
  console.log(msg);
  const el = document.getElementById('log');
  if (el) el.textContent = msg;
};
// "Ahmed Khan" -> "Ahmed", but keep short names like "My Airtel" whole
const firstName = (name: string) => { const f = name.split(' ')[0]; return f.length <= 2 ? name : f; };
const clip = (s: string, max = 58) => (s.length > max ? s.slice(0, max - 1) + '…' : s); // list rows max 63 bytes

// ---------- rendering ----------

async function render(page: Partial<RebuildPageContainer>) {
  if (first) {
    first = false;
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page));
    if (r === StartUpPageCreateResult.success) return;
  }
  if (!(await bridge.rebuildPageContainer(new RebuildPageContainer(page)))) debug('rebuild failed');
}

function listPage(title: string, rows: { label: string; run: () => void }[]) {
  listItems = rows.map((r) => r.run);
  return render({
    containerTotalNum: 2,
    textObject: [new TextContainerProperty({ xPosition: 16, yPosition: 8, width: W - 32, height: 40, ...HEADER, content: title, isEventCapture: 0 })],
    listObject: [new ListContainerProperty({
      xPosition: 16, yPosition: 52, width: W - 32, height: H - 60, ...BODY,
      itemContainer: new ListItemContainerProperty({ itemCount: rows.length, itemName: rows.map((r) => clip(r.label)), isItemSelectBorderEn: 1 }),
      isEventCapture: 1,
    })],
  });
}

function textPage(content: string) {
  listItems = [];
  return render({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({ xPosition: 16, yPosition: 12, width: W - 32, height: H - 24, ...BODY, content, isEventCapture: 1 })],
  });
}

/** Run a server call behind a loading screen, with a friendly error. */
async function load<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  busy = true;
  await textPage(label);
  try { return await fn(); }
  catch (e: any) {
    busy = false;
    if (e.status === 401) { await forgetPairing(); return; }
    await show({ kind: 'message', text: `Couldn't reach Kith.\n${clip(e.message ?? String(e), 80)}\n\nTap: home` });
  } finally { busy = false; }
}

// ---------- screens ----------

async function goHome() {
  const home = await load('KITH\n\nLoading...', api.home);
  if (home) return show({ kind: 'home', home });
}

async function openPerson(id: string) {
  const person = await load('KITH\n\nRemembering...', () => api.person(id));
  if (person) return show({ kind: 'person', person });
}

async function show(next: Screen) {
  screen = next;
  switch (next.kind) {
    case 'home': {
      const { owed } = next.home;
      const rows = owed.slice(0, 8).map((p) => ({
        label: `${firstName(p.personName ?? '?')}: ${p.what}${p.due ? ` (${p.due})` : ''}`,
        run: () => openPerson(p.personId),
      }));
      rows.push({ label: 'Meet someone: hold to listen', run: () => startListening() });
      const title = owed.length ? `KITH   You owe ${owed.length} ${owed.length === 1 ? 'thing' : 'things'}` : 'KITH   All promises kept';
      return listPage(title, rows);
    }
    case 'person': {
      const p = next.person;
      if (p.met && !p.connected) { // someone new, met in person
        const owe = p.promises[0], tg = p.tgCandidate;
        const lines = [
          `NEW: ${p.name.toUpperCase()}${p.org ? '  /  ' + p.org : ''}`,
          '',
          `Met ${p.lastChat.replace(/^met /, '')}${p.notes?.length ? ': ' + clip(p.notes[p.notes.length - 1], 40) : ''}`,
          owe ? `YOU OWE: ${owe.what}${owe.due ? ` (${owe.due})` : ''}` : '',
          tg ? `Telegram: @${tg.username} (${clip(tg.name, 20)})` : 'Not on Telegram with you yet',
          '',
          'Tap: remember & connect    Double tap: home',
        ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
        return textPage(lines.join('\n'));
      }
      const owe = p.promises[0];
      const lines = [
        `${p.name.toUpperCase()}${p.org ? '  /  ' + p.org : ''}`,
        '',
        `Last chat ${p.lastChat}`,
        owe ? `YOU OWE: ${owe.what}${owe.due ? ` (${owe.due})` : ''}` : 'You owe nothing. Nice.',
        p.promises.length > 1 ? `+ ${p.promises.length - 1} more` : '',
        p.theyOwe ? `THEY OWE YOU: ${p.theyOwe}` : '',
        p.theyAsked ? `They asked: ${p.theyAsked}` : '',
        '',
        'Tap: actions    Double tap: back',
      ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
      return textPage(lines.join('\n'));
    }
    case 'actions': {
      const p = next.person;
      if (p.met && !p.connected) {
        const rows = [{ label: 'Listen: notes, promises, @username', run: () => startCatching(p) }];
        if (p.tgCandidate) rows.unshift({ label: `Connect @${p.tgCandidate.username} & say hi`, run: () => show({ kind: 'connect', person: p }) });
        rows.push({ label: 'Forget them', run: () => forgetMet(p) });
        rows.push({ label: 'Back', run: () => show({ kind: 'person', person: p }) });
        return listPage(`${firstName(p.name)} (new): what now?`, rows);
      }
      const rows: { label: string; run: () => void }[] = p.promises.slice(0, 2).map((owe) => ({
        label: `Deliver: ${owe.what}`,
        run: () => show({ kind: 'confirm', person: p, text: owe.deliverText, promiseId: owe.id }),
      }));
      rows.unshift({ label: 'Catch promises (talk now)', run: () => startCatching(p) });
      rows.push({ label: 'Send follow-up', run: () => show({ kind: 'confirm', person: p, text: `Great seeing you today, ${firstName(p.name)}! Let's keep in touch.` }) });
      rows.push({ label: 'Back', run: () => show({ kind: 'person', person: p }) });
      return listPage(`${firstName(p.name)}: what now?`, rows);
    }
    case 'connect': {
      const tg = next.person.tgCandidate!;
      return textPage(`CONNECT ON TELEGRAM?\n\n@${tg.username}\nTelegram says: ${tg.name}\n\nIs this ${firstName(next.person.name)}?\nTap: yes, draft a hello    Double tap: no`);
    }
    case 'confirm':
      return textPage(`SEND TO ${next.person.name.toUpperCase()}?\n\n"${next.text}"\n\nTap: send    Double tap: cancel`);
    case 'listening':
      return textPage('LISTENING...\n\nHold while they say their name.\nRelease when done.');
    case 'catching': {
      const isNew = next.person.met && !next.person.connected;
      const lines = [
        `WITH ${next.person.name.toUpperCase()}   (listening)`,
        '',
        next.caught.length ? `Promises caught: ${next.caught.length}` : isNew ? 'Noting what you talk about.\nAsk for their Telegram @username.' : 'Catching promises you make...',
        ...next.caught.slice(-3).map((c) => `+ ${c}`),
        '',
        next.heard ? `"${clip(next.heard, 60)}"` : '',
        '',
        'Double tap: end',
      ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
      return textPage(lines.join('\n'));
    }
    case 'message':
      return textPage(next.text);
    case 'pairing':
      return; // drawn by pair()
  }
}

function back() {
  switch (screen.kind) {
    case 'catching': return stopCatching();
    case 'person': case 'listening': case 'message': return goHome();
    case 'actions': case 'connect': return show({ kind: 'person', person: screen.person });
    case 'confirm': return show({ kind: 'actions', person: screen.person });
  }
}

async function tap(listIndex?: number) {
  switch (screen.kind) {
    case 'home': case 'actions':
      return listItems[listIndex ?? 0]?.();
    case 'person':
      return show({ kind: 'actions', person: screen.person });
    case 'connect': {
      const s = screen;
      const r = await load('Connecting...', () => api.metConnect(s.person.id));
      if (r) return show({ kind: 'confirm', person: r.person, text: r.text });
      return;
    }
    case 'message':
      return screen.then ? screen.then() : goHome();
    case 'confirm': {
      const s = screen;
      const r = await load('Sending...', () => api.send(s.person.id, s.text, s.promiseId));
      if (!r) return;
      const where = r.mode === 'live' ? `to ${firstName(s.person.name)}` : 'to your Saved Messages\n(test mode: turn on real sending\nin Kith > You)';
      await show({ kind: 'message', text: `SENT ${where}\n\n${s.promiseId ? 'Promise kept.' : ''}` });
      setTimeout(() => { if (screen.kind === 'message') goHome(); }, 1800);
    }
  }
}

// ---------- listening ----------

async function startListening() {
  audio = [];
  await show({ kind: 'listening' });
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses);
  if (!ok) debug('mic did not open');
}

async function stopListening() {
  await bridge.audioControl(false);
  const pcm = takeAudio();
  const total = pcm.length;
  debug(`captured ${total} bytes of audio`);
  if (total < 3200) return show({ kind: 'message', text: "Didn't hear anything.\nHold longer while they speak.\n\nTap: home" });
  const r = await load('Who is this?...', () => api.hear(pcm));
  if (!r) return;
  debug('heard: ' + r.text);
  if (r.person) return show({ kind: 'person', person: r.person });
  if (r.met) return show({ kind: 'person', person: r.met });
  return show({ kind: 'message', text: `Didn't catch a name.\nHeard: "${clip(r.text, 70)}"\n\nHold again while they say it.\nTap: home` });
}

async function forgetMet(p: Person) {
  const r = await load('Forgetting...', () => api.metForget(p.id));
  if (r) await show({ kind: 'message', text: `Forgot ${firstName(p.name)}.\n\nTap: home` });
}

// ---------- promise catcher ----------

async function startCatching(person: Person) {
  audio = [];
  catchSession = Math.random().toString(36).slice(2);
  await show({ kind: 'catching', person, caught: [], heard: '' });
  await bridge.audioControl(true, AudioInputSource.Glasses);
  catchTimer = setInterval(flushCatch, 6000); // send speech every 6 s
}

async function flushCatch() {
  if (screen.kind !== 'catching' || !audio.length) return;
  const chunk = takeAudio();
  const s = screen;
  try {
    const r = await api.catchChunk(catchSession, s.person.id, chunk);
    if (screen !== s && screen.kind !== 'catching') return;
    const caught = [...s.caught, ...r.caught.map((c) => `${c.what}${c.due ? ` (${c.due})` : ''}`)];
    await show({ kind: 'catching', person: s.person, caught, heard: r.text || s.heard });
  } catch (e: any) { debug('catch failed: ' + e.message); }
}

async function stopCatching() {
  if (screen.kind !== 'catching') return;
  clearInterval(catchTimer);
  const s = screen;
  await flushCatch(); // last words
  await bridge.audioControl(false);
  const r = await load('Saving...', () => api.catchEnd(catchSession));
  if (!r) return;
  const person = r.person ?? s.person;
  const isNew = person.met && !person.connected;
  const then = isNew ? () => show({ kind: 'person', person }) : undefined;
  await show({ kind: 'message', then, text: (r.count
    ? `CAUGHT ${r.count} ${r.count === 1 ? 'PROMISE' : 'PROMISES'}\nto ${s.person.name}\n\nSaved. Recap sent to your Telegram.`
    : isNew ? `Saved notes on ${firstName(person.name)}.` : `No promises heard.`) +
    (isNew && person.tgCandidate ? `\nFound @${person.tgCandidate.username} on Telegram.` : '') +
    `\n\nTap: ${isNew ? 'continue' : 'home'}` });
}

function takeAudio() {
  const total = audio.reduce((n, a) => n + a.length, 0);
  const pcm = new Uint8Array(total);
  let o = 0; for (const a of audio) { pcm.set(a, o); o += a.length; }
  audio = [];
  return pcm;
}

// ---------- pairing (first launch) ----------
const TOKEN_KEY = 'kith_token';

async function pair() {
  screen = { kind: 'pairing' };
  let r;
  try { r = await api.pairStart(); }
  catch { await textPage("KITH\n\nCan't reach Kith.\nCheck your phone's internet.\n\nRetrying..."); setTimeout(pair, 5000); return; }
  await textPage(`PAIR YOUR GLASSES\n\n1. Open @${r.bot || 'kith_memory_bot'} in Telegram\n2. Tap Kith, then the You tab\n3. Enter this code:\n\n        ${r.code.slice(0, 3)} ${r.code.slice(3)}`);
  const started = Date.now();
  const tick = async () => {
    if (screen.kind !== 'pairing') return;
    if (Date.now() - started > 9.5 * 60_000) return pair(); // code expired: new one
    try {
      const s = await api.pairStatus(r.pairId);
      if (s.token) {
        setToken(s.token);
        await bridge.setLocalStorage(TOKEN_KEY, s.token);
        await textPage('PAIRED\n\nKith is ready.');
        setTimeout(goHome, 1200);
        return;
      }
    } catch {}
    setTimeout(tick, 2000);
  };
  tick();
}

async function forgetPairing() {
  setToken('');
  await bridge.setLocalStorage(TOKEN_KEY, '');
  return pair();
}

// ---------- input ----------

function onEvent(event: any) {
  if (event.audioEvent) {
    if (screen.kind === 'listening' || screen.kind === 'catching') audio.push(event.audioEvent.audioPcm);
    return;
  }
  const ev = event.listEvent ?? event.textEvent ?? event.sysEvent;
  if (!ev) return;
  if (busy && screen.kind !== 'catching') return;
  if (screen.kind === 'pairing') return;
  // CLICK_EVENT is 0 and protobuf omits zero values, so missing type = click.
  const type: OsEventTypeList = ev.eventType ?? OsEventTypeList.CLICK_EVENT;
  switch (type) {
    case OsEventTypeList.CLICK_EVENT:
      if (screen.kind === 'listening' || screen.kind === 'catching') return;
      return tap(event.listEvent ? (ev.currentSelectItemIndex ?? 0) : undefined);
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return back();
    case OsEventTypeList.LONG_PRESS_EVENT:
      if (screen.kind === 'catching') return;
      return startListening();
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      if (screen.kind === 'listening') return stopListening();
  }
}

async function main() {
  bridge = await waitForEvenAppBridge();
  bridge.onEvenHubEvent(onEvent);
  const saved = await bridge.getLocalStorage(TOKEN_KEY).catch(() => '');
  if (!saved) return pair();
  setToken(saved);
  await goHome();
}

main().catch((e) => debug('error: ' + e));
