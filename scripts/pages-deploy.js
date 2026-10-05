'use strict';
/**
 * Deploy frontend NMS ke Cloudflare PAGES (-> https://nms-eov.pages.dev).
 *
 * Bedanya dengan `npm run deploy` (Worker):
 *   - Pages menyajikan aset statis (public/) + Functions (functions/_middleware.js)
 *   - Secret ORIGIN_URL diisi otomatis dari logs/tunnel-url.txt (tunnel aktif)
 *   - URL tidak memuat nama akun Cloudflare
 *
 * Pakai: node scripts/pages-deploy.js
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROJECT = process.env.PAGES_PROJECT || 'nms';
const URL_FILE = path.join(ROOT, 'logs', 'tunnel-url.txt');
const say = (m) => console.log('[pages] ' + m);
const die = (m) => { console.error('[pages] ERROR: ' + m); process.exit(1); };

function run(args, opts = {}) {
  return execFileSync('npx', ['--yes', 'wrangler@latest', ...args], {
    encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24,
    ...opts,
  }).trim();
}

// 1. pastikan secret ORIGIN_URL selalu sesuai tunnel yang sedang hidup
if (fs.existsSync(URL_FILE)) {
  const origin = fs.readFileSync(URL_FILE, 'utf8').trim();
  if (!origin) die('logs/tunnel-url.txt kosong - tunnel belum aktif');
  say('sinkron ORIGIN_URL -> ' + origin);
  const r = execFileSync('npx', ['--yes', 'wrangler@latest', 'pages', 'secret', 'put',
    'ORIGIN_URL', '--project-name', PROJECT], {
    cwd: ROOT, encoding: 'utf8', input: origin, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 20,
  });
  say('  secret diperbarui');
} else {
  say('PERINGATAN: logs/tunnel-url.txt tidak ada. API mungkin tidak berfungsi.');
}

// 2. deploy folder public + functions
say('deploy ke project "' + PROJECT + '"...');
const out = run(['pages', 'deploy', 'public', '--project-name', PROJECT,
  '--branch', 'main', '--commit-dirty=true']);

// 3. tampilkan URL
const m = out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/);
if (m) {
  say('');
  say('  URL PUBLIK : ' + m[0]);
  say('  (tanpa nama akun Cloudflare)');
} else {
  say('deploy selesai. Lihat URL di https://dash.cloudflare.com/ > Workers & Pages > ' + PROJECT);
}