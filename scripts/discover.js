'use strict';
// Auto-discovery subnet via ping-sweep + catat discovery_runs.
// Utilitas ping/ARP ada di lib/net-scan.js supaya tidak ada duplikasi dengan script lain.
const { db } = require('../lib/db');
const { pingSweep } = require('../lib/net-scan');

async function discover(subnet, opts = {}) {
  // subnet format: "192.168.1" -> scan .1..254 (batasi dgn limit)
  const limit = Math.min(254, Math.max(1, opts.limit || 30));
  const alive = (await pingSweep(subnet, limit, { batch: 20, waitMs: 800 })).map((a) => a.ip);
  const ins = db.prepare('INSERT INTO devices(name,ip,type,vendor,snmp_version,snmp_protocol,status,discovered) VALUES (?,?,?,?,?,?,?,1)');
  let added = 0;
  for (const ip of alive) {
    const ex = db.prepare('SELECT id FROM devices WHERE ip=?').get(ip);
    if (!ex) {
      ins.run('DISC-' + ip.replace(/\./g, '-'), ip, opts.type || 'server', opts.vendor || 'auto', opts.snmp_version || 'v2c', opts.snmp_protocol || 'ssh', 'up');
      added++;
    } else db.prepare('UPDATE devices SET discovered=1, status=? WHERE id=?').run('up', ex.id);
  }
  db.prepare('INSERT INTO discovery_runs(subnet,found,detail) VALUES (?,?,?)').run(subnet, alive.length, JSON.stringify(alive.slice(0, 50)));
  db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('discovery','discovery','info',?)").run(`Discovery ${subnet}.0/24: ${alive.length} hidup, ${added} baru`);
  return { subnet, alive, added };
}
if (require.main === module) {
  discover(process.argv[2] || '192.168.1', { limit: Number(process.argv[3] || 30) }).then((r) => { console.log(JSON.stringify(r, null, 2)); });
}
module.exports = { discover };
