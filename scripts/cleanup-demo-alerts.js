'use strict';
// Bersihkan alert lama dari perangkat demo (monitored=0) yang belum nyata.
const { db } = require('../lib/db');
const demo = db.prepare("SELECT id FROM devices WHERE monitored=0").all().map((d) => d.id);
let n = 0;
if (demo.length) {
  const ids = demo.join(',');
  n = db.prepare(`UPDATE alerts SET status='resolved', resolved_at=datetime('now') WHERE status IN ('open','acknowledged') AND device_id IN (${ids})`).run().changes;
  db.prepare(`DELETE FROM alerts WHERE device_id IN (${ids})`).run();
  db.prepare(`UPDATE devices SET status='up' WHERE monitored=0`).run();
}
db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('system','audit','info',?)")
  .run(`Cleanup alert demo: ${n} alert ditutup (perangkat demo tidak dipoll)`);
console.log('alert demo dibersihkan =', n, '| device nyata =', db.prepare('SELECT COUNT(*) c FROM devices WHERE monitored=1').get().c);
