'use strict';
/**
 * Uji geometri sidebar secara statis (tanpa browser).
 *
 * Bug yang pernah terjadi: aturan `main` yang lebih akhir menimpa aturan
 * sidebar sehingga kembali ke `margin:0 auto` dan konten tertutup sidebar.
 * Penguji ini memastikan:
 *   1. hanya ada SATU aturan main di luar media query
 *   2. aturan itu menggeser konten sebesar lebar sidebar
 *   3. mode drawer (<=900px) mengembalikannya ke margin 0
 *   4. tablet 768-1024px tetap menggeser (sidebar masih tampil di >900px)
 */
const css = require('fs').readFileSync('public/style.css', 'utf8');
const lines = css.split('\n');

let depth = 0;
const topMain = [];
lines.forEach((s, i) => {
  const before = depth;
  for (const ch of s) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  if (before === 0 && /^\s*main\{/.test(s)) topMain.push({ line: i + 1, rule: s.trim() });
});

let bad = 0;
const ck = (n, ok, d = '') => { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + d : '')); };

ck('tepat satu aturan main di luar media query', topMain.length === 1,
  'ditemukan ' + topMain.length + ' di baris ' + topMain.map((m) => m.line).join(','));

const outer = topMain[0];
ck('aturan main utama menggeser konten sebesar sidebar',
  !!outer && /margin:[^;]*var\(--sb-w\)/.test(outer.rule), outer ? outer.rule : 'tidak ada');
ck('bukan margin:0 auto polos (penyebab konten tertutup sidebar)',
  !!outer && !/margin:\s*0 auto\s*;/.test(outer.rule));

const w = /:root\{--sb-w:(\d+)px\}/.exec(css);
ck('lebar sidebar --sb-w terdefinisi', !!w, w ? w[1] + 'px' : 'tidak ada');

ck('mode drawer <=900px mengembalikan margin ke 0', /margin-left:0/.test(css));
ck('breakpoint drawer 900px ada', /@media\s*\(max-width:900px\)/.test(css));

const tablet = /@media \(min-width:768px\) and \(max-width:1024px\)\{([\s\S]*?)\n\}/.exec(css);
ck('tablet 768-1024px tetap menggeser konten',
  !!tablet && /main\{[^}]*margin-left:\s*var\(--sb-w\)/.test(tablet[1]),
  tablet ? 'ditemukan' : 'blok tidak ditemukan');

ck('sidebar fixed di kiri', /\.sidebar\{position:fixed;[^}]*inset:0 auto 0 0/.test(css));
ck('keseimbangan kurung CSS', (css.match(/{/g) || []).length === (css.match(/}/g) || []).length);

console.log(bad ? 'LAYOUT-CHECK: ADA YANG GAGAL' : 'LAYOUT-CHECK: SEMUA OK');
process.exit(bad ? 1 : 0);