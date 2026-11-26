// Tiny key-value store: Postgres when DATABASE_URL is set (production), a local JSON file otherwise (development).
// Also encrypts secrets (Telegram sessions) with KITH_SECRET before they are stored.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

class FileKV implements KV {
  private data: Record<string, unknown>;
  private file: string;
  constructor(file: string) {
    this.file = file;
    mkdirSync('data', { recursive: true });
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }
  private flush() { writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 }); }
  async get<T>(k: string) { return structuredClone(this.data[k]) as T | undefined; }
  async set(k: string, v: unknown) { this.data[k] = structuredClone(v); this.flush(); }
  async del(k: string) { delete this.data[k]; this.flush(); }
  async keys(prefix: string) { return Object.keys(this.data).filter((k) => k.startsWith(prefix)); }
}

class PgKV implements KV {
  private pool: pg.Pool;
  private ready: Promise<unknown>;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }, max: 4 });
    this.ready = this.pool.query('create table if not exists kv (k text primary key, v jsonb not null, updated timestamptz default now())');
  }
  async get<T>(k: string) {
    await this.ready;
    const r = await this.pool.query('select v from kv where k = $1', [k]);
    return r.rows[0]?.v as T | undefined;
  }
  async set(k: string, v: unknown) {
    await this.ready;
    await this.pool.query('insert into kv (k, v) values ($1, $2) on conflict (k) do update set v = $2, updated = now()', [k, JSON.stringify(v)]);
  }
  async del(k: string) { await this.ready; await this.pool.query('delete from kv where k = $1', [k]); }
  async keys(prefix: string) {
    await this.ready;
    const r = await this.pool.query("select k from kv where k like $1 || '%'", [prefix]);
    return r.rows.map((x) => x.k);
  }
}

export const kv: KV = process.env.DATABASE_URL
  ? new PgKV(process.env.DATABASE_URL)
  : new FileKV(`data/${process.env.KITH_CACHE ?? 'kith'}.json`);

// ---------- encryption for secrets at rest (AES-256-GCM) ----------
const secret = process.env.KITH_SECRET ?? '';
if (process.env.DATABASE_URL && secret.length < 16) throw new Error('Set KITH_SECRET (16+ random characters) to encrypt sessions');
const key = createHash('sha256').update(secret || 'kith-local-dev-only').digest();

export function encrypt(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decrypt(b64: string) {
  const raw = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
