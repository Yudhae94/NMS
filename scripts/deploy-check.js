'use strict';
/**
 * Validasi paket deploy VPS (tanpa Linux di mesin ini).
 * Memeriksa struktur skrip shell & unit systemd agar tidak ada kesalahan
 * yang baru ketahuan setelah di-upload ke VPS.
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'deploy');
let bad = 0;
const ck = (n, ok, d = '') => { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + d : '')); };

const files = ['setup-vps.sh', 'deploy-vps.sh', 'nms.service', 'nms-tunnel.service'];
for (const f of files) ck('berkas ada: ' + f, fs.existsSync(path.join(DIR, f)));

const setup = fs.readFileSync(path.join(DIR, 'setup-vps.sh'), 'utf8');
const deploy = fs.readFileSync(path.join(DIR, 'deploy-vps.sh'), 'utf8');
const svc = fs.readFileSync(path.join(DIR, 'nms.service'), 'utf8');
const tsvc = fs.readFileSync(path.join(DIR, 'nms-tunnel.service'), 'utf8');

// --- shell:shebang, set -euo, balanced braces/quoting kasar ---
for (const [nama, isi] of [['setup-vps.sh', setup], ['deploy-vps.sh', deploy]]) {
  ck(nama + ' punya shebang', isi.startsWith('#!/bin/bash'));
  ck(nama + ' memakai set -euo pipefail', /set -euo pipefail/.test(isi));
  const kurung = (isi.match(/{/g) || []).length - (isi.match(/}/g) || []).length;
  ck(nama + ' kurung kurawal seimbang', kurung === 0, kurung !== 0 ? 'selisih ' + kurung : '');
  const endif = (isi.match(/^\s*if .*; then/gm) || []).length;
  const endfi = (isi.match(/^\s*fi\s*$/gm) || []).length;
  const fors = (isi.match(/^\s*for .*; do/gm) || []).length;
  const dones = (isi.match(/^\s*done\s*$/gm) || []).length;
  const whiles = (isi.match(/^\s*while .*; do/gm) || []).length;
  ck(nama + ' blok if/fi seimbang', endif === endfi, endif + ' if / ' + endfi + ' fi');
  ck(nama + ' blok for/done seimbang', fors === dones, fors + ' for / ' + dones + ' done');
  ck(nama + ' blok while/done seimbang', whiles === dones - fors, whiles + ' while / ' + (dones - fors));
}

// --- isi installer ---
ck('setup-vps.sh memasang Node.js', /nodesource\.com\/setup_/.test(setup));
ck('setup-vps.sh membuat user nms', /useradd[^\n]*nms/.test(setup));
ck('setup-vps.sh memasang cloudflared', /cloudflared-linux-amd64/.test(setup));
ck('setup-vps.sh menyalin aplikasi ke /opt/nms', /\/opt\/nms/.test(setup));
ck('setup-vps.sh mengaktifkan service saat boot', /systemctl enable nms\.service/.test(setup));
ck('setup-vps.sh menyimpan token dengan izin ketat', /chmod 0600 \/etc\/nms\/tunnel-token/.test(setup));
ck('setup-vps.sh menolak jalan tanpa sudo', /\[ "\$\(id -u\)" -eq 0 \]/.test(setup));
ck('setup-vps.sh menolak tanpa token', /TUNNEL_TOKEN wajib/.test(setup));
ck('setup-vps.sh menyalin semua modul aplikasi', /server\.js poller\.js worker\.js/.test(setup) && /lib scripts deploy/.test(setup));
ck('setup-vps.sh tidak menyalin folder data/log (mulai bersih)', !/cp -r[^\n]*\bdata\b/.test(setup));

// --- deploy dari laptop ---
ck('deploy-vps.sh pakai rsync', /rsync -az/.test(deploy));
ck('deploy-vps.sh mengecualikan data & logs', /--exclude 'data\/'/.test(deploy) && /--exclude 'logs\/'/.test(deploy));
ck('deploy-vps.sh restart service setelah copy', /systemctl restart nms/.test(deploy));

// --- systemd ---
for (const [nama, isi] of [['nms.service', svc], ['nms-tunnel.service', tsvc]]) {
  ck(nama + ' punya section [Unit]', /\[Unit\]/.test(isi));
  ck(nama + ' punya section [Service]', /\[Service\]/.test(isi));
  ck(nama + ' punya section [Install]', /\[Install\]/.test(isi));
  ck(nama + ' auto-restart', /Restart=always/.test(isi));
  ck(nama + ' berjalan sebagai user nms', /User=nms/.test(isi));
}
ck('nms.service menjalankan server.js', /ExecStart=\/usr\/bin\/node server\.js/.test(svc));
ck('nms.service mengaktifkan TOPO_WATCH', /TOPO_WATCH=1/.test(svc));
ck('nms.service membatasi memori (VPS gratis)', /MemoryMax=512M/.test(svc));
ck('nms-tunnel.service memakai wrapper token', /tunnel-service\.sh/.test(tsvc));
ck('nms-tunnel.service bergantung pada nms.service', /Requires=nms\.service/.test(tsvc));

console.log(bad ? 'DEPLOY-CHECK: ADA YANG GAGAL' : 'DEPLOY-CHECK: SEMUA OK');
process.exit(bad ? 1 : 0);