'use strict';
// Cek cepat bahwa sidebar & pergeseran konten benar-benar ter-deploy di URL publik.
const URL_CF = process.env.CF_URL || 'https://nms-monitoring.yudhaekapratamay.workers.dev';
(async () => {
  const t = await (await fetch(URL_CF + '/app.js')).text();
  const c = await (await fetch(URL_CF + '/style.css')).text();

  // aturan main di luar media query pada CSS yang benar-benar terkirim
  const lines = c.split('\n');
  let depth = 0;
  const topMain = [];
  lines.forEach((s, i) => {
    const before = depth;
    for (const ch of s) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (before === 0 && /^\s*main\{/.test(s)) topMain.push(s.trim());
  });

  const cek = [
    ['struktur <aside class="sidebar">', t.includes('<aside class="sidebar"')],
    ['tombol hamburger', t.includes('class="sb-toggle"')],
    ['topbar lama hilang', !t.includes('class="topbar"')],
    ['CSS sidebar fixed', /\.sidebar\{position:fixed/.test(c)],
    ['CSS drawer layar kecil', c.includes('body.sb-open .sidebar{transform:translateX(0)}')],
    ['CSS tepat 1 aturan main', topMain.length === 1, topMain.length + ' aturan'],
    ['CSS konten digeser sidebar', /margin:\s*0 auto 0 var\(--sb-w\)/.test(c)],
    ['CSS bukan margin:0 auto polos', !/^\s*main\{[^}]*margin:\s*0 auto;/.test(c)],
    ['CSS reset margin di drawer', /margin-left:0/.test(c)],
    ['CSS kurung seimbang', (c.match(/{/g) || []).length === (c.match(/}/g) || []).length],
  ];
  let bad = 0;
  for (const [n, ok, extra] of cek) {
    if (!ok) bad++;
    console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra ? ' :: ' + extra : ''));
  }
  console.log(bad ? 'EDGE-CHECK: ADA YANG GAGAL' : 'EDGE-CHECK: SEMUA OK');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });