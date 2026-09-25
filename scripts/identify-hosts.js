'use strict';
// Deteksi nama/MAC/tipe semua perangkat LAN yang terpantau (laptop, HP, TV, printer, router).
// Pakai: node scripts/identify-hosts.js
const { identifyAll } = require('../lib/identify');
const { db } = require('../lib/db');
identifyAll().then((rows) => {
  console.log('--- hasil identifikasi ---');
  for (const r of rows) {
    console.log([r.ip, r.name, r.type, r.vendor, r.mac || '-', JSON.stringify(r.hints)].join(' | '));
  }
  console.log('\nDevices di DB:');
  console.log(db.prepare('SELECT id,name,ip,type,vendor,mac,os_guess FROM devices ORDER BY id').all()
    .map((d) => [d.id, d.name, d.ip, d.type, d.vendor, d.mac || '-', d.os_guess || '-'].join(' | ')).join('\n'));
}).catch((e) => { console.error(e); process.exit(1); });
