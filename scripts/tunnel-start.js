'use strict';
/**
 * Jalankan Cloudflare Quick Tunnel ke server NMS lokal (port 3000).
 * Cetak URL publik yang terbit, lalu simpan ke logs/tunnel-url.txt
 * (dipakai skrip online.ps1 & deploy worker).
 * Pakai: node scripts/tunnel-start.js
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const EXE = process.env.CLOUDFLARED || path.join(process.env.USERPROFILE || '', '.cloudflared', 'cloudflared.exe');
const PORT = Number(process.env.PORT || 3000);
const LOGDIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(EXE)) { console.error('cloudflared tidak ditemukan di: ' + EXE); process.exit(1); }
fs.mkdirSync(LOGDIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = fs.openSync(path.join(LOGDIR, 'tunnel-' + stamp + '.log'), 'a');
const err = fs.openSync(path.join(LOGDIR, 'tunnel-' + stamp + '.err.log'), 'a');

const child = spawn(EXE, ['tunnel', '--no-autoupdate', '--url', 'http://localhost:' + PORT], {
  stdio: ['ignore', out, err], windowsHide: true,
});

const RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
let found = null;
const timer = setInterval(async () => {
  if (found) return;
  try {
    const f = path.join(LOGDIR, 'tunnel-' + stamp + '.err.log');
    const txt = fs.readFileSync(f, 'utf8');
    const m = txt.match(RE);
    if (m) {
      found = m[0];
      fs.writeFileSync(path.join(LOGDIR, 'tunnel-url.txt'), found + '\n');
      console.log('[tunnel] URL publik: ' + found);
      console.log('[tunnel] origin untuk wrangler.jsonc  ->  "ORIGIN_URL": "' + found + '"');
      console.log('[tunnel] log: ' + f);
    }
  } catch {}
}, 1500);

child.on('exit', (code) => { clearInterval(timer); console.error('[tunnel] cloudflared berhenti (code ' + code + ')'); process.exit(code || 1); });
process.on('SIGINT', () => { try { child.kill(); } catch {} });