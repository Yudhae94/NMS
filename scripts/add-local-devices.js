'use strict';
/**
 * Daftarkan perangkat nyata yang sedang dipakai ke NMS.
 * Default: router TP-Link 192.168.1.1 + PC/laptop ini (IP lokal otomatis).
 * Pakai: node scripts/add-local-devices.js [routerIp] [pcIp]
 * Idempoten: bila IP sudah terdaftar, hanya di-update.
 */
const os = require('node:os');
const { db } = require('../lib/db');
function localIPs() {
  const out = [];
  Object.values(os.networkInterfaces()).flat().forEach((n) => {
    if (n && n.family === 'IPv4' && !n.internal) out.push(n.address);
  });
  return [...new Set(out)];
}
function upsert(dev) {
  const ex = db.prepare('SELECT id FROM devices WHERE ip=?').get(dev.ip);
  if (ex) {
    db.prepare('UPDATE devices SET name=?, type=?, vendor=?, snmp_version=?, snmp_community=?, snmp_protocol=?, monitored=1, discovered=1 WHERE id=?')
      .run(dev.name, dev.type, dev.vendor, dev.snmp_version || 'v2c', dev.snmp_community || 'public', dev.snmp_protocol || 'api', ex.id);
    return { id: ex.id, created: false };
  }
  const r = db.prepare('INSERT INTO devices(name,ip,type,vendor,snmp_version,snmp_community,snmp_protocol,status,discovered,monitored) VALUES (?,?,?,?,?,?,?,?,1,1)')
    .run(dev.name, dev.ip, dev.type, dev.vendor, dev.snmp_version || 'v2c', dev.snmp_community || 'public', dev.snmp_protocol || 'api', 'unknown');
  return { id: Number(r.lastInsertRowid), created: true };
}
function ensureIfaces(id, ports) {
  const has = db.prepare('SELECT COUNT(*) c FROM interfaces WHERE device_id=?').get(id).c;
  if (has) return;
  const ins = db.prepare('INSERT INTO interfaces(device_id,name,status,speed_mbps,in_bps,out_bps) VALUES (?,?,?,?,?,?)');
  ports.forEach((p) => ins.run(id, p, 'up', 1000, Math.round(2e6 + Math.random() * 3e7), Math.round(1e6 + Math.random() * 2e7)));
}
function main() {
  const routerIp = process.argv[2] || '192.168.1.1';
  const ips = localIPs();
  const pcIp = process.argv[3] || ips.find((i) => i.startsWith(routerIp.split('.').slice(0, 3).join('.'))) || ips[0] || '127.0.0.1';
  const router = upsert({ name: 'ROUTER-TPLINK-HOME', ip: routerIp, type: 'router', vendor: 'TP-Link', snmp_version: 'v2c', snmp_community: 'public', snmp_protocol: 'api' });
  ensureIfaces(router.id, ['WAN', 'LAN1', 'LAN2', 'LAN3', 'LAN4', 'WiFi-2G', 'WiFi-5G']);
  const pc = upsert({ name: 'PC-' + os.hostname().toUpperCase(), ip: pcIp, type: 'server', vendor: os.platform() === 'win32' ? 'Windows' : 'Linux', snmp_protocol: 'wmi' });
  ensureIfaces(pc.id, ['eth0', 'WiFi']);
  // link router <-> pc bila belum ada
  const hasLink = db.prepare('SELECT COUNT(*) c FROM links WHERE (src_device=? AND dst_device=?) OR (src_device=? AND dst_device=?)').get(router.id, pc.id, pc.id, router.id).c;
  if (!hasLink) db.prepare('INSERT INTO links(src_device,src_port,dst_device,dst_port) VALUES (?,?,?,?)').run(router.id, 'LAN1', pc.id, 'eth0');
  db.prepare('INSERT INTO events(source,facility,severity,message) VALUES (?,?,?,?)')
    .run('system', 'audit', 'info', `Perangkat nyata didaftarkan: ${routerIp} (router TP-Link) + ${pcIp} (${os.hostname()})`);
  console.log(JSON.stringify({ router: { ip: routerIp, id: router.id, created: router.created }, pc: { ip: pcIp, hostname: os.hostname(), id: pc.id, created: pc.created }, localIPs: ips }, null, 2));
}
main();
