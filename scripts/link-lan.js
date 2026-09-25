'use strict';
// Hubungkan perangkat LAN nyata ke router (topologi bintang) + rapikan bila sudah ada.
const { db } = require('../lib/db');
const router = db.prepare("SELECT id FROM devices WHERE ip='192.168.1.1'").get();
if (!router) { console.log('router 192.168.1.1 belum terdaftar'); process.exit(0); }
const hosts = db.prepare('SELECT id,name,ip FROM devices WHERE monitored=1 AND ip LIKE ? AND id<>?').all('192.168.1.%', router.id);
const ins = db.prepare('INSERT INTO links(src_device,src_port,dst_device,dst_port) VALUES (?,?,?,?)');
let n = 0;
for (const h of hosts) {
  const exists = db.prepare('SELECT COUNT(*) c FROM links WHERE (src_device=? AND dst_device=?) OR (src_device=? AND dst_device=?)').get(router.id, h.id, h.id, router.id).c;
  if (!exists) { ins.run(router.id, 'LAN', h.id, 'eth0'); n++; }
}
db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('system','audit','info',?)").run(`Topologi LAN: ${n} link router->host ditambahkan`);
console.log('link ditambahkan', n, '| total link', db.prepare('SELECT COUNT(*) c FROM links').get().c);
