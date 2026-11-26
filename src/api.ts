// Talks to the Kith server (server/index.ts). The URL must be whitelisted in app.json.
export const SERVER = (import.meta as any).env?.VITE_KITH_SERVER ?? 'http://localhost:8787';

export type Promise_ = { id: string; personId: string; what: string; due: string; overdue: boolean; deliverText: string; personName?: string };
export type Person = { id: string; name: string; org: string; lastChat: string; theyAsked: string; theyOwe: string; note?: string; promises: Promise_[] };
export type Home = { owed: Promise_[]; people: number; indexing: boolean; sendMode: 'saved' | 'live' };

let token = ''; // device token from pairing
export const setToken = (t: string) => { token = t; };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as any) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(SERVER + path, { ...init, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status });
  return body as T;
}

export const api = {
  pairStart: () => call<{ pairId: string; code: string; bot: string }>('/api/pair/start', { method: 'POST' }),
  pairStatus: (pairId: string) => call<{ token: string | null }>(`/api/pair/status?pairId=${pairId}`),
  home: () => call<Home>('/api/home'),
  person: (id: string) => call<Person>(`/api/person/${id}`),
  find: (q: string) => call<Person>(`/api/find?q=${encodeURIComponent(q)}`),
  hear: (pcm: Uint8Array) => call<{ text: string; person: Person | null }>('/api/hear', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm as any,
  }),
  catchChunk: (session: string, personId: string, pcm: Uint8Array) =>
    call<{ text: string; caught: Promise_[] }>(`/api/catch?session=${session}&personId=${personId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm as any,
    }),
  catchEnd: (session: string) => call<{ count: number }>(`/api/catch/end?session=${session}`, { method: 'POST' }),
  send: (personId: string, text: string, promiseId?: string) => call<{ ok: boolean; mode: string }>('/api/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personId, text, promiseId }),
  }),
};
