// Gives the Kith server a temporary public https URL (Telegram only opens Mini Apps over https).
// Only /mini and /api/mini/* answer through it, and only for the owner (see server/index.ts).
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const cf = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', 'http://localhost:8787'], { stdio: ['ignore', 'pipe', 'pipe'] });
let found = false;
const scan = (buf: Buffer) => {
  const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !found) {
    found = true;
    writeFileSync('data/public-url.txt', m[0]);
    console.log(`Tunnel up: ${m[0]}/mini  (the bot's "Kith" button now opens it)`);
  }
};
cf.stdout.on('data', scan);
cf.stderr.on('data', scan);
const stop = () => { rmSync('data/public-url.txt', { force: true }); cf.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
cf.on('exit', (code) => { rmSync('data/public-url.txt', { force: true }); console.log('Tunnel closed', code ?? ''); process.exit(code ?? 0); });
