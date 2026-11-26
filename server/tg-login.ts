// One-time Telegram login. Run in your own terminal: npm run tg:login
// Saves a session to .tg-session (private, never committed).
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createInterface } from 'node:readline/promises';
import { writeFileSync, existsSync } from 'node:fs';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? '';
if (!apiId || !apiHash) throw new Error('Fill TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first');
if (existsSync('.tg-session')) console.log('Note: .tg-session exists and will be replaced.');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
client.setLogLevel('error' as any);

await client.start({
  phoneNumber: () => rl.question('Phone number with country code (e.g. +234...): '),
  phoneCode: () => rl.question('Login code Telegram just sent you: '),
  password: () => rl.question('Two-step verification password (if you set one): '),
  onError: (err) => console.error('Login error:', err.message),
});

const me: any = await client.getMe();
writeFileSync('.tg-session', String(client.session.save()), { mode: 0o600 });
console.log(`\nLogged in as ${me.firstName ?? ''} (@${me.username ?? 'no username'}). Session saved to .tg-session.`);
console.log('Keep .tg-session private: it gives access to your Telegram account.');
rl.close();
await client.disconnect();
process.exit(0);
