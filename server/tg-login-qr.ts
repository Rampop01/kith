// One-time Telegram login by QR code (no SMS/code needed).
// Run in your own terminal: npm run tg:login:qr
// Then on your phone: Telegram > Settings > Devices > Link Desktop Device > scan.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createInterface } from 'node:readline/promises';
import { writeFileSync } from 'node:fs';
import qrcode from 'qrcode-terminal';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? '';
if (!apiId || !apiHash) throw new Error('Fill TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
client.setLogLevel('error' as any);
await client.connect();

console.log('\nOn your phone: Telegram > Settings > Devices > Link Desktop Device, then scan:\n');
await client.signInUserWithQrCode({ apiId, apiHash }, {
  qrCode: async ({ token }) => {
    const url = 'tg://login?token=' + Buffer.from(token).toString('base64url');
    qrcode.generate(url, { small: true });
    console.log('(The QR refreshes every ~30s if not scanned. Waiting...)\n');
  },
  password: async (hint) => rl.question(`Two-step verification password${hint ? ` (hint: ${hint})` : ''}: `),
  onError: async (err) => { console.error('Login error:', err.message); return true; },
});

const me: any = await client.getMe();
writeFileSync('.tg-session', String(client.session.save()), { mode: 0o600 });
console.log(`\nLogged in as ${me.firstName ?? ''} (@${me.username ?? 'no username'}). Session saved to .tg-session.`);
console.log('Keep .tg-session private: it gives access to your Telegram account.');
rl.close();
await client.disconnect();
process.exit(0);
