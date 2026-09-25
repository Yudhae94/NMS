'use strict';
// Auto-discovery subnet via ping-sweep + SNMP/SSH info + catat discovery_runs.
const { exec } = require('node:child_process');
const { db } = require('../lib/db');
function ping(ip) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? `ping -n 1 -w 800 ${ip}` : `ping -c 1 -W 1 ${ip}`;
    exec(cmd, (err) => resolve(!err));
  });
}
async function discover(subnet, opts = {}) {
  // subnet format: "10.10.1" -> scan .1..254 (batasi dgn limit)
  const limit = Math.min(254, Math.max(1, opts.limit || 30));
  const found = [];
  const jobs = [];
  for (let i = 1; i <= limit; i++) {
    const ip = `${subnet}.${i}`;
    jobs.push(ping(ip).then((ok) => { if (ok) found.push(ip); }));
    if (jobs.length >= 20) { await Promise.all(jobs.splice(0, jobs.length)); }
  }
  await Promise.all(jobs);
  const ins = db.prepare('INSERT INTO devices(name,ip,type,vendor,snmp_version,snmp_protocol,status,discovered) VALUES (?,?,?,?,?,?,?,1)');
  let added = 0;
  for (const ip of found) {
    const ex = db.prepare('SELECT id FROM devices WHERE ip=?').get(ip);
    if (!ex) {
      ins.run('DISC-' + ip.replace(/\./g, '-'), ip, opts.type || 'server', opts.vendor || 'auto', opts.snmp_version || 'v2c', opts.snmp_protocol || 'ssh', 'up');
      added++;
    } else db.prepare('UPDATE devices SET discovered=1, status=? WHERE id=?').run('up', ex.id);
  }
  db.prepare('INSERT INTO discovery_runs(subnet,found,detail) VALUES (?,?,?)').run(subnet, found.length, JSON.stringify(found.slice(0, 50)));
  db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('discovery','discovery','info',?)").run(`Discovery ${subnet}.0/24: ${found.length} hidup, ${added} baru`);
  return { subnet, alive: found, added };
}
if (require.main === module) {
  discover(process.argv[2] || '10.10.1', { limit: Number(process.argv[3] || 30) }).then((r) => { console.log(JSON.stringify(r, null, 2)); });
}
module.exports = { discover };
