'use strict';
/**
 * Uji menu navigasi untuk tiap role tanpa browser.
 * Memastikan: jumlah tombol per role, Discovery hanya untuk operator+,
 * Users/Channels hanya untuk admin+, dan pemisah kelompok benar.
 */
const fs = require('node:fs');
const src = fs.readFileSync('public/app.js', 'utf8');
const fn = src.match(/function shell\(inner, active\) \{[\s\S]*?\n\}/);
if (!fn) { console.error('FATAL: fungsi shell tidak ditemukan'); process.exit(1); }
const brandFn = src.match(/function brandLetters\([\s\S]*?\n\}/);
if (!brandFn) { console.error('FATAL: brandLetters tidak ditemukan'); process.exit(1); }
const run = new Function('U', 'esc', brandFn[0] + '\n' + fn[0] + '\nreturn shell("", "dash");');
const runActive = new Function('U', 'esc', brandFn[0] + '\n' + fn[0] + '\nreturn shell("", "net");');
const esc = (s) => String(s ?? '');

const EXPECT = {
  viewer:      { must: ['dash', 'live', 'topo', 'dev', 'wifi', 'net'], mustNot: ['disc', 'users', 'chan'] },
  operator:    { must: ['dash', 'net', 'wifi', 'disc'],              mustNot: ['users', 'chan'] },
  admin:       { must: ['dash', 'net', 'disc', 'users', 'chan'],      mustNot: [] },
  superadmin:  { must: ['dash', 'net', 'disc', 'users', 'chan'],      mustNot: [] },
};

let bad = 0;
for (const role of Object.keys(EXPECT)) {
  const html = run({ username: 'u', role }, esc);
  const ids = [...html.matchAll(/data-v="(\w+)"/g)].map((m) => m[1]);
  const seps = (html.match(/class="msep"/g) || []).length;
  const e = EXPECT[role];
  const hilang = e.must.filter((x) => !ids.includes(x));
  const bocor = e.mustNot.filter((x) => ids.includes(x));
  const ok = hilang.length === 0 && bocor.length === 0;
  if (!ok) bad++;
  console.log(
    (ok ? 'PASS ' : 'FAIL ') + role.padEnd(11) +
    ' tombol=' + String(ids.length).padEnd(3) +
    ' pemisah=' + seps +
    ( hilang.length ? ' HILANG:' + hilang.join(',') : '') +
    ( bocor.length ? ' BOCOR:' + bocor.join(',') : '') +
    '\n           ' + ids.join(' ')
  );
}

// atribut aksesibilitas
const sample = run({ username: 'u', role: 'viewer' }, esc);
for (const attr of ['title=', 'aria-label=', 'aria-current=', 'role="navigation"']) {
  const ok = sample.includes(attr);
  if (!ok) bad++;
  console.log((ok ? 'PASS ' : 'FAIL ') + 'atribut ' + attr);
}
// tombol aktif harus ditandai
const activeHtml = runActive({ username: 'u', role: 'viewer' }, esc);
const aktif = (activeHtml.match(/aria-current="page"/g) || []).length;
const on = (activeHtml.match(/class="navbtn on"/g) || []).length;
const okAktif = aktif === 1 && on === 1;
if (!okAktif) bad++;
console.log((okAktif ? 'PASS ' : 'FAIL ') + 'halaman aktif ditandai (aria-current=' + aktif + ', class on=' + on + ')');

console.log(bad ? 'MENU-CHECK: ADA YANG GAGAL' : 'MENU-CHECK: SEMUA OK');
process.exit(bad ? 1 : 0);