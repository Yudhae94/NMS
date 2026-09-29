'use strict';
/**
 * Pemindai host LAN/WiFi (satu skrip untuk semua kebutuhan scan):
 *  1) tentukan subnet dari interface aktif (atau argumen)
 *  2) ping-sweep /24 paralel + baca tabel ARP + probe port TCP (host yang blokir ICMP tetap terdeteksi)
 *  3) daftarkan perangkat baru (monitored=1, discovered=1) / perbarui MAC & status
 *  4) rapikan identitas PC ini (IP WiFi saat ini) + buang MAC basi/duplikat
 *  5) identifikasi nama/vendor/tipe (NetBIOS/LLMNR/mDNS/OUI/port) + topologi bintang ke router
 * Pakai: node scripts/scan-lan.js [subnetPrefix] [limit]
 */
const os = require('node:os');
const { db } = require('../lib/db');
const { pingSweep, arpMap, localIfaces, localSubnet, reachable } = require('../lib/net-scan');

function log(msg) { console.log(msg); }

async function main() {
  const prefix = localSubnet(process.argv[2]);
  const limit = Math.min(254, Math.max(1, Number(process.argv[3]) || 254));
  const locals = localIfaces();
  const localMacs = new Set(locals.map((l) => l.mac).filter(Boolean));
  const local = locals.find((l) => l.prefix === prefix) || locals[0] || { ip: null, mac: null };

  log(`[scan] subnet ${prefix}.0/24 (limit ${limit}) — PC ini ${local.ip || '?'} (${local.mac || 'MAC tidak terbaca'})`);
  const t0 = Date.now();
  const [swept, arp] = await Promise.all([pingSweep(prefix, limit), arpMap()]);
  const sweptIps = new Set(swept.map((s) => s.ip));

  // gabungkan hasil sweep + tabel ARP; host tanpa ARP/ICMP diuji port TCP-nya
  const candidates = new Set([...sweptIps, ...Object.keys(arp).filter((ip) => ip.startsWith(prefix + '.'))]);
  const alive = [];
  for (const ip of [...candidates].sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]))) {
    const mac = arp[ip] || null;
    if (mac || sweptIps.has(ip) || await reachable(ip)) alive.push({ ip, mac });
  }
  log(`[scan] ${alive.length} host aktif (${Date.now() - t0}ms): ${alive.map((a) => a.ip).join(', ') || '-'}`);

  const upd = db.prepare("UPDATE devices SET discovered=1, monitored=1, status='up', mac=COALESCE(?,mac), last_seen=datetime('now') WHERE ip=?");
  const ins = db.prepare("INSERT INTO devices(name,ip,type,vendor,snmp_version,snmp_community,snmp_protocol,status,discovered,monitored) VALUES (?,?,?,?,?,?,?,?,1,1)");
  const added = [];
  for (const a of alive) {
    const ex = db.prepare('SELECT id FROM devices WHERE ip=?').get(a.ip);
    if (ex) upd.run(a.mac, a.ip);
    else {
      const r = ins.run('HOST-' + a.ip.split('.').join('-'), a.ip, 'host', 'auto-discovery', 'v2c', 'public', 'ssh', 'up');
      added.push({ ip: a.ip, id: Number(r.lastInsertRowid) });
    }
  }

  // rapikan identitas PC ini + MAC basi/duplikat
  let cleaned = 0;
  if (local.ip && local.mac) {
    for (const d of db.prepare('SELECT id,ip,mac FROM devices WHERE ip LIKE ?').all(prefix + '.%')) {
      if (d.ip === local.ip) {
        db.prepare("UPDATE devices SET mac=?, status='up', monitored=1, discovered=1, last_seen=datetime('now') WHERE id=?").run(local.mac, d.id);
      } else if (d.mac && (d.mac === local.mac || localMacs.has(d.mac))) {
        db.prepare('UPDATE devices SET mac=NULL WHERE id=?').run(d.id);
        cleaned++;
      }
    }
  }
  const seen = new Set(alive.map((a) => a.ip));
  for (const d of db.prepare('SELECT id,ip,mac FROM devices WHERE ip LIKE ?').all(prefix + '.%')) {
    if (d.mac && !seen.has(d.ip) && d.ip !== local.ip) { db.prepare('UPDATE devices SET mac=NULL WHERE id=?').run(d.id); cleaned++; }
  }

  db.prepare('INSERT INTO discovery_runs(subnet,found,detail) VALUES (?,?,?)')
    .run(prefix + '.0', alive.length, JSON.stringify(alive.map((a) => a.ip)));
  db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('discovery','discovery','info',?)")
    .run(`Scan LAN/WiFi ${prefix}.0/24: ${alive.length} host aktif, ${added.length} perangkat baru, ${cleaned} MAC basi dibersihkan`);

  // identifikasi nama/vendor/tipe (sekaligus membuat link topologi ke router)
  let identified = [];
  try { identified = await require('../lib/identify').identifyAll(); } catch (e) { console.error('[scan] identify gagal:', e.message); }

  log(`[scan] selesai: ${alive.length} aktif, ${added.length} baru, ${cleaned} MAC dibersihkan, ${identified.length} diidentifikasi`);
  log(db.prepare('SELECT id,name,ip,type,vendor,mac,status FROM devices WHERE monitored=1 ORDER BY id').all()
    .map((d) => [d.id, d.name, d.ip, d.type, d.vendor, d.mac || '-', d.status].join(' | ')).join('\n'));
  return { subnet: prefix + '.0', local, alive: alive.map((a) => a.ip), added: added.length, cleaned, identified: identified.length };
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
