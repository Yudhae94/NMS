'use strict';
/**
 * Uji worker.js tanpa deploy: simulasikan 3 kondisi origin
 *   1. tunnel MATI  -> harus fallback ke aset statis (bukan 530 mentah)
 *   2. tunnel HIDUP -> request diteruskan ke origin
 *   3. aset statis  -> dilayani dari edge (binding ASSETS tiruan)
 * Pakai: node scripts/worker-check.js
 */
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** Binding ASSETS tiruan: baca file dari public/ */
const ASSETS = {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const fp = path.join(PUB, p === '/' ? 'index.html' : p);
    if (!fp.startsWith(PUB) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return new Response('not found', { status: 404 });
    const ext = path.extname(fp).toLowerCase();
    return new Response(fs.readFileSync(fp), { status: 200, headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
  },
};

(async () => {
  const mod = await import('../worker.js');
  const worker = mod.default;
  const ctx = { waitUntil() {} };
  const ck = (n, ok, d = '') => console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + d : ''));
  const cacheStore = new Map();
  globalThis.caches = { default: { match: async (k) => cacheStore.get(String(k.url || k)), put: async (k, v) => cacheStore.set(String(k.url || k), v) } };

  // ---- 1. tunnel mati: fetch ke host tak ada -> balasan 530-like dari edge
  const MATI = 'https://tunnel-mati-tidak-ada.trycloudflare.com';
  globalThis.fetch = async () => new Response('<html>Origin DNS error</html>', { status: 530, headers: { 'Content-Type': 'text/html' } });
  let r = await worker.fetch(new Request('https://nms-monitoring.workers.dev/'), { ORIGIN_URL: MATI, ASSETS }, ctx);
  const body = await r.text();
  ck('origin-mati-html-fallback', r.status === 200 && body.includes('Network Monitoring'), 'status=' + r.status + ' len=' + body.length);

  r = await worker.fetch(new Request('https://nms-monitoring.workers.dev/api/health'), { ORIGIN_URL: MATI, ASSETS }, ctx);
  ck('origin-mati-api-fallback', r.status !== 530, 'status=' + r.status);

  // ---- 2. tunnel hidup: request harus diteruskan apa adanya
  const HIDUP = 'http://127.0.0.1:3000';
  let seen = '';
  globalThis.fetch = async (req) => {
    seen = String(req.url || req);
    if (String(req.url).endsWith('/api/health')) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('<html>ORIGIN LIVE</html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  r = await worker.fetch(new Request('https://nms-monitoring.workers.dev/api/health'), { ORIGIN_URL: HIDUP, ASSETS }, ctx);
  ck('origin-hidup-api', r.status === 200 && (await r.text()).includes('"ok":true'), 'status=' + r.status);
  ck('api-cache-miss-lalu-hit', r.headers.get('X-NMS-Cache') === 'MISS');
  const r2 = await worker.fetch(new Request('https://nms-monitoring.workers.dev/api/health'), { ORIGIN_URL: HIDUP, ASSETS }, ctx);
  ck('api-cache-hit', r2.headers.get('X-NMS-Cache') === 'HIT', 'cache=' + r2.headers.get('X-NMS-Cache'));
  r = await worker.fetch(new Request('https://nms-monitoring.workers.dev/some/page.html'), { ORIGIN_URL: HIDUP, ASSETS }, ctx);
  ck('origin-hidup-html', (await r.text()).includes('ORIGIN LIVE') && seen.includes('/some/page.html'));

  // ---- 3. aset statis dari edge
  r = await worker.fetch(new Request('https://nms-monitoring.workers.dev/app.js'), { ORIGIN_URL: HIDUP, ASSETS }, ctx);
  const js = await r.text();
  ck('aset-dari-edge', r.status === 200 && r.headers.get('X-NMS-Served') === 'edge' && js.includes('vDash'), 'len=' + js.length);
  r = await worker.fetch(new Request('https://nms-monitoring.workers.dev/app.js?v=119c1d3'), { ORIGIN_URL: HIDUP, ASSETS }, ctx);
  ck('aset-immutable', (r.headers.get('Cache-Control') || '').includes('immutable'), r.headers.get('Cache-Control'));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });