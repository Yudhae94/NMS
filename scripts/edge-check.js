'use strict';
// Cek cepat bahwa sidebar benar-benar ter-deploy di URL publik.
const URL_CF = process.env.CF_URL || 'https://nms-monitoring.yudhaekapratamay.workers.dev';
(async () => {
  const t = await (await fetch(URL_CF + '/app.js')).text();
  const c = await (await fetch(URL_CF + '/style.css')).text();
  const cek = [
    ['struktur <aside class="sidebar">', t.includes('<aside class="sidebar"')],
    ['penutup (scrim) sidebar', t.includes('id="sbScrim"')],
    ['tombol hamburger', t.includes('class="sb-toggle"')],
    ['label kategori', t.includes('class="mlabel"')],
    ['fungsi navPick', t.includes('function navPick')],
    ['topbar lama hilang', !t.includes('class="topbar"')],
    ['CSS sidebar fixed', /\.sidebar\{position:fixed/.test(c)],
    ['CSS drawer layar kecil', c.includes('body.sb-open .sidebar{transform:translateX(0)}')],
    ['CSS geser konten', c.includes('calc(var(--sb-w) + 16px)')],
    ['CSS kurung seimbang', (c.match(/{/g) || []).length === (c.match(/}/g) || []).length],
  ];
  let bad = 0;
  for (const [n, ok] of cek) { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + n); }
  console.log(bad ? 'EDGE-CHECK: ADA YANG GAGAL' : 'EDGE-CHECK: SEMUA OK');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });