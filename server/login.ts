// Connect a user's Telegram account from inside the Mini App: phone -> code -> (2FA password).
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import QRCode from 'qrcode';
import { API_ID, API_HASH, saveLogin, type Account } from './account.ts';

type Pending = { client: TelegramClient; phone: string; hash: string; at: number };
const pending = new Map<string, Pending>(); // by Telegram user id (from the Mini App)

const friendly = (e: any) => {
  const m = String(e?.errorMessage ?? e?.message ?? e);
  if (m.includes('PHONE_NUMBER_INVALID')) return 'That phone number looks wrong. Use the international format, e.g. +234 801 234 5678.';
  if (m.includes('PHONE_CODE_INVALID')) return 'That code is not right. Check the latest message from Telegram.';
  if (m.includes('PHONE_CODE_EXPIRED')) return 'That code expired. Tap "Send a new code".';
  if (m.includes('PASSWORD_HASH_INVALID')) return 'Wrong password. This is your Telegram two-step verification password.';
  if (m.includes('FLOOD')) return 'Telegram asks us to wait a bit. Try again in a few minutes.';
  return 'Telegram said: ' + m.slice(0, 120);
};
const fail = (e: any) => Object.assign(new Error(friendly(e)), { status: 400 });

setInterval(() => { // drop abandoned logins after 10 minutes
  for (const [id, p] of pending) if (Date.now() - p.at > 10 * 60_000) { p.client.disconnect().catch(() => {}); pending.delete(id); }
}, 60_000);

export async function startLogin(userId: string, phone: string) {
  phone = phone.replace(/[^\d+]/g, '');
  if (!/^\+?\d{7,15}$/.test(phone)) throw fail('PHONE_NUMBER_INVALID');
  pending.get(userId)?.client.disconnect().catch(() => {});
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 3 });
  client.setLogLevel('error' as any);
  await client.connect();
  try {
    const r: any = await client.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId: API_ID, apiHash: API_HASH, settings: new Api.CodeSettings({}) }));
    const type = String(r.type?.className ?? r.className).replace(/^auth\.SentCodeType/, '');
    console.log(`[login ${userId}] code sent via ${type}${r.nextType ? `, next ${r.nextType.className}` : ''}`); // never logs phone or code
    if (!r.phoneCodeHash) throw new Error(`Telegram did not send a code (${type})`);
    pending.set(userId, { client, phone, hash: r.phoneCodeHash, at: Date.now() });
    return { sent: true, via: type, email: r.type?.emailPattern ?? '', length: r.type?.length ?? 5, canResend: !!r.nextType };
  } catch (e: any) {
    console.log(`[login ${userId}] send code failed: ${e?.errorMessage ?? e?.message}`);
    await client.disconnect().catch(() => {}); throw fail(e);
  }
}

async function finish(userId: string, p: { client: TelegramClient }, tz?: string): Promise<Account> {
  const me: any = await p.client.getMe();
  pending.delete(userId); qrs.delete(userId);
  if (String(me.id) !== userId) { // the Telegram account must be the one using the Mini App
    await p.client.invoke(new Api.auth.LogOut()).catch(() => {});
    await p.client.disconnect().catch(() => {});
    throw Object.assign(new Error('Please connect the same Telegram account you opened Kith from.'), { status: 400 });
  }
  const session = String(p.client.session.save());
  await p.client.disconnect().catch(() => {});
  console.log(`[login ${userId}] connected`);
  return saveLogin(userId, me, session, tz);
}

// ---------- QR login: no code needed. Approve from Telegram on your phone (Settings > Devices > Link Desktop Device). ----------
type Qr = {
  client: TelegramClient; at: number; url: string; status: 'waiting' | 'password' | 'done' | 'error';
  error?: string; hint?: string; tz?: string; account?: Account; givePassword?: (pw: string) => void;
};
const qrs = new Map<string, Qr>();
setInterval(() => { for (const [id, q] of qrs) if (Date.now() - q.at > 10 * 60_000 && q.status !== 'done') { q.client.disconnect().catch(() => {}); qrs.delete(id); } }, 60_000);

export async function startQr(userId: string, tz?: string) {
  qrs.get(userId)?.client.disconnect().catch(() => {});
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 3 });
  client.setLogLevel('error' as any);
  await client.connect();
  const q: Qr = { client, at: Date.now(), url: '', status: 'waiting', tz };
  qrs.set(userId, q);
  let first: () => void;
  const ready = new Promise<void>((r) => { first = r; });
  client.signInUserWithQrCode({ apiId: API_ID, apiHash: API_HASH }, {
    qrCode: async ({ token }) => { q.url = 'tg://login?token=' + Buffer.from(token).toString('base64url'); first(); },
    password: async (hint) => {
      q.status = 'password'; q.hint = hint ?? '';
      return new Promise<string>((res) => { q.givePassword = res; });
    },
    onError: async (e: any) => {
      const m = String(e?.errorMessage ?? e?.message ?? e);
      console.log(`[login ${userId}] qr: ${m}`);
      if (m.includes('PASSWORD_HASH_INVALID')) { q.error = friendly(e); q.status = 'password'; return false; } // ask again
      q.error = friendly(e); q.status = 'error'; first();
      return true;
    },
  }).then(async () => {
    try { q.account = await finish(userId, q, q.tz); q.status = 'done'; }
    catch (e: any) { q.status = 'error'; q.error = e.message; }
  }).catch((e) => { if (q.status !== 'error') { q.status = 'error'; q.error = friendly(e); } first(); });
  await Promise.race([ready, new Promise((r) => setTimeout(r, 15_000))]);
  return qrStatus(userId);
}

export async function qrStatus(userId: string) {
  const q = qrs.get(userId);
  if (!q) return { status: 'expired' as const };
  const svg = q.url && q.status === 'waiting' ? await QRCode.toString(q.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : '';
  return { status: q.status, svg, url: q.url, error: q.error ?? '', hint: q.hint ?? '', account: q.account };
}

/** 2FA password for a QR login in progress. Returns false if no QR login is waiting for one. */
export function qrPassword(userId: string, password: string) {
  const q = qrs.get(userId);
  if (!q?.givePassword || q.status !== 'password') return false;
  q.error = ''; q.status = 'waiting';
  const give = q.givePassword; q.givePassword = undefined;
  give(password);
  return true;
}

export async function resendCode(userId: string) {
  const p = pending.get(userId);
  if (!p) throw Object.assign(new Error('Start again: enter your phone number.'), { status: 400 });
  try {
    const r: any = await p.client.invoke(new Api.auth.ResendCode({ phoneNumber: p.phone, phoneCodeHash: p.hash }));
    p.hash = r.phoneCodeHash; p.at = Date.now();
    const type = String(r.type?.className ?? '').replace(/^auth\.SentCodeType/, '');
    console.log(`[login ${userId}] code resent via ${type}`);
    return { sent: true, via: type, email: r.type?.emailPattern ?? '', length: r.type?.length ?? 5, canResend: !!r.nextType };
  } catch (e: any) { console.log(`[login ${userId}] resend failed: ${e?.errorMessage ?? e?.message}`); throw fail(e); }
}

export async function submitCode(userId: string, code: string, tz?: string) {
  const p = pending.get(userId);
  if (!p) throw Object.assign(new Error('Start again: enter your phone number.'), { status: 400 });
  try {
    await p.client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.hash, phoneCode: code.replace(/\D/g, '') }));
  } catch (e: any) {
    if (String(e?.errorMessage ?? e?.message).includes('SESSION_PASSWORD_NEEDED')) return { needPassword: true as const };
    throw fail(e);
  }
  return { account: await finish(userId, p, tz) };
}

export async function submitPassword(userId: string, password: string, tz?: string) {
  const p = pending.get(userId);
  if (!p) throw Object.assign(new Error('Start again: enter your phone number.'), { status: 400 });
  let err: any;
  await p.client.signInWithPassword({ apiId: API_ID, apiHash: API_HASH }, {
    password: async () => password,
    onError: async (e) => { err = e; return true; }, // stop after the first failure
  }).catch((e) => { err = err ?? e; });
  if (err) throw fail(err);
  return { account: await finish(userId, p, tz) };
}
