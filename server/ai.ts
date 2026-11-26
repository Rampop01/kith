// AI helpers: Groq LLM + speech-to-text, prompts, and deadline-words -> date.
const GROQ = 'https://api.groq.com/openai/v1';
const LLM_MODEL = 'openai/gpt-oss-120b';
const STT_MODEL = 'whisper-large-v3-turbo';

export const today = () => new Date().toISOString().slice(0, 10);

// All users share one Groq key: run at most 2 AI calls at once so the free rate limit holds.
let running = 0; const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

async function groqRaw(path: string, init: RequestInit, tries = 4): Promise<any> {
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

const groq = (path: string, init: RequestInit) => slot(() => groqRaw(path, init));

export async function llmJSON(system: string, user: string): Promise<any> {
  const j = await groq('/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL, temperature: 0.2, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  return JSON.parse(j.choices[0].message.content);
}

export const ANALYZE_PROMPT = `You help the user remember people. You get the user's recent Telegram chat with one person.
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

export const CATCH_PROMPT = `The user is wearing smart glasses during a face-to-face conversation with {NAME}.
You get a fresh piece of the speech transcript. Today is {TODAY} ({WEEKDAY}).
Find commitments the user makes out loud ("I'll send you...", "I will call you tomorrow", "let me intro you to...").
Already known promises (do not repeat them): {KNOWN}
Return JSON only: { "promises": [ { "what": "max 5 words, e.g. send pitch deck",
  "due": "deadline words exactly as said, e.g. friday, tomorrow, next week, else \"\"",
  "deliverText": "short friendly message the user could later send to deliver it, max 25 words" } ] }
Use [] if there is no clear commitment. Never invent.`;

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

// ---------- speech to text ----------
function pcmToWav(pcm: Buffer, sampleRate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Loudness of 16-bit PCM (0..32768). Silence makes Whisper hallucinate, so we skip it. */
function rms(pcm: Buffer) {
  let sum = 0; const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Speech to text. `names` (the user's contacts) helps spell unusual names right. */
export async function transcribe(pcm: Buffer, names: string[] = []): Promise<string> {
  if (rms(pcm) < 200) return ''; // silence makes Whisper invent text
  const form = new FormData();
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', STT_MODEL);
  form.append('language', 'en');
  if (names.length) form.append('prompt', `Names: ${names.slice(0, 40).join(', ')}.`);
  const j = await groq('/audio/transcriptions', { method: 'POST', body: form });
  const text = (j.text ?? '').trim();
  return /^names\b/i.test(text) ? '' : text; // the model echoing our hint, not speech
}
