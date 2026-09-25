'use strict';
// Rapikan nama perangkat hasil auto-discovery (DISC-192-168-1-3 -> HOST-LAN-192.168.1.3).
const { db } = require('../lib/db');
const rows = db.prepare("SELECT id,ip FROM devices WHERE name LIKE 'DISC-%'").all();
const up = db.prepare('UPDATE devices SET name=?, vendor=?, type=? WHERE id=?');
let n = 0;
for (const r of rows) {
  const last = r.ip.split('.').pop();
  up.run('HOST-LAN-' + last, 'auto-discovery', 'server', r.id);
  n++;
}
db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('system','audit','info',?)").run(`Rename ${n} perangkat hasil discovery`);
console.log('renamed', n);
