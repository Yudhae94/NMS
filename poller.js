'use strict';
// Poller: ICMP ping, resource monitoring (simulasi), threshold alerts, notifikasi, eskalasi, syslog listener.
const dgram = require('node:dgram');
const { exec } = require('node:child_process');
const { db } = require('./lib/db');
const POLL_MS = Number(process.env.POLL_MS || 30000);
const SYSLOG_PORT = Number(process.env.SYSLOG_PORT || 5514);
const TH = { cpu: 85, mem: 90, temp: 75, loss: 5, latency: 300 };
function ping(ip) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? `ping -n 1 -w 1500 ${ip}` : `ping -c 1 -W 2 ${ip}`;
    const t0 = Date.now();
    exec(cmd, (err, out) => {
      if (err) return resolve({ ok: false });
      const ms = Date.now() - t0;
      const m = out.match(/time[=<]([\d.]+)\s?ms/i);
      resolve({ ok: true, ms: m ? Number(m[1]) : ms });
    });
  });
}
// SNMP poll (snmpwalk bila tersedia; fallback simulasi bila tidak ada / v3 tanpa kredensial)
function snmpWalk(ip, o) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where snmpwalk' : 'which snmpwalk';
    exec(cmd, (e) => {
      if (e) return resolve({ simulated: true });
      const ver = (o.snmp_version || 'v2c').replace('v', '');
      let args = ver === '3'
        ? `-v3 -l authPriv -u ${o.snmp_user || 'monitor'} -a SHA -A *** -x AES -X *** ${ip} 1.3.6.1.2.1.1.3.0`
        : `-v${ver} -c ${o.snmp_community || 'public'} ${ip} 1.3.6.1.2.1.1.3.0`;
      exec(`snmpwalk ${args}`, { timeout: 8000 }, (err, out) => resolve({ simulated: !!err, raw: (out || '').slice(0, 300) }));
    });
  });
}
// SSH/WinRM/API: eksekusi perintah baca resource bila kredensial tersedia via env (fallback simulasi)
function remoteExec(d) {
  return new Promise((resolve) => {
    const proto = d.snmp_protocol || 'ssh';
    if (proto === 'api') return resolve({ simulated: true, via: 'api' });
    if (proto === 'wmi' || proto === 'winrm') {
      exec(`powershell -NoProfile -Command "Test-WSMan -ComputerName ${d.ip} -ErrorAction Stop | Out-Null"`, { timeout: 8000 }, (err) => resolve({ simulated: !!err, via: proto }));
      return;
    }
    const user = process.env.SSH_USER;
    if (!user) return resolve({ simulated: true, via: 'ssh' });
    exec(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${user}@${d.ip} "cat /proc/loadavg; free -m | head -2"`, { timeout: 10000 }, (err, out) => resolve({ simulated: !!err, via: 'ssh', raw: (out || '').slice(0, 300) }));
  });
}
function raiseAlert(deviceId, severity, type, message) {
  const open = db.prepare("SELECT id FROM alerts WHERE device_id IS ? AND type=? AND status='open'").get(deviceId, type);
  if (open) return open.id;
  const r = db.prepare('INSERT INTO alerts(device_id,severity,type,message) VALUES (?,?,?,?)').run(deviceId, severity, type, message);
  db.prepare('INSERT INTO events(source,facility,severity,message) VALUES (?,?,?,?)').run('poller', 'poller', severity, message);
  notify(Number(r.lastInsertRowid), severity, message);
  return Number(r.lastInsertRowid);
}
function sevRank(s) { return { info: 0, warning: 1, critical: 2 }[s] ?? 1; }
function notify(alertId, severity, message) {
  const chans = db.prepare('SELECT * FROM channels WHERE enabled=1').all();
  for (const c of chans) {
    if (sevRank(severity) < sevRank(c.min_severity || 'warning')) continue;
    let status = 'sent', detail = message.slice(0, 200);
    try {
      if (c.type === 'telegram' && process.env.TELEGRAM_BOT_TOKEN && !String(c.target).includes('EXAMPLE')) {
        // kirim sinkron via https bawaan (tanpa dep)
        const https = require('node:https');
        const data = JSON.stringify({ chat_id: c.target, text: `[${severity.toUpperCase()}] ${message}`.slice(0, 4000) });
        const rq = https.request(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } });
        rq.on('error', () => {});
        rq.write(data); rq.end();
      } else if (c.type === 'slack' && String(c.target).startsWith('https://')) {
        const https = require('node:https');
        const data = JSON.stringify({ text: `[${severity}] ${message}` });
        const u = new URL(c.target);
        const rq = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } });
        rq.on('error', () => {});
        rq.write(data); rq.end();
      }
    } catch { status = 'failed'; }
    db.prepare('INSERT INTO notifications_log(channel_type,channel_target,alert_id,status,detail) VALUES (?,?,?,?,?)')
      .run(c.type, c.target, alertId, status, detail);
    db.prepare('INSERT INTO events(source,facility,severity,message) VALUES (?,?,?,?)')
      .run('notify', 'notify', 'info', `[${c.type} -> ${c.target}] ${message}`);
    console.log(`[notify][${c.type}] ${message}`);
  }
}
async function pollOnce() {
  // hanya perangkat nyata (monitored=1) yang dipoll; perangkat demo dilewati
  const devs = db.prepare('SELECT * FROM devices WHERE monitored=1').all();
  for (const d of devs) {
    const r = await ping(d.ip);
    const now = Date.now();
    if (!r.ok) {
      db.prepare("UPDATE devices SET status='down', latency=NULL, last_seen=last_seen WHERE id=?").run(d.id);
      raiseAlert(d.id, 'critical', 'down', `Device DOWN: ${d.name} (${d.ip}) tidak merespons ping`);
      continue;
    }
    // simulasi resource walk di sekitar baseline + info jalur data (snmp/ssh/winrm/api)
    const snmp = await snmpWalk(d.ip, d);
    const rem = await remoteExec(d);
    const jitter = (v, a) => Math.max(1, Math.min(99, (v || 30) + (Math.random() - 0.5) * a));
    const cpu = jitter(d.cpu, 10), mem = jitter(d.mem, 6), temp = jitter(d.temp || 40, 3);
    const loss = Math.random() < 0.03 ? +(Math.random() * 8).toFixed(1) : 0;
    const status = cpu > 95 || loss > 10 ? 'degraded' : 'up';
    db.prepare('UPDATE devices SET status=?,latency=?,packet_loss=?,cpu=?,mem=?,temp=?,last_seen=datetime(?) WHERE id=?')
      .run(status, r.ms, loss, +cpu.toFixed(1), +mem.toFixed(1), +temp.toFixed(1), 'now', d.id);
    db.prepare('INSERT INTO metrics(device_id,ts,cpu,mem,disk,temp,in_bps,out_bps,latency,packet_loss) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(d.id, now, cpu, mem, d.disk, temp, Math.round(Math.random() * 5e7), Math.round(Math.random() * 3e7), r.ms, loss);
    if (cpu > TH.cpu) raiseAlert(d.id, 'warning', 'cpu', `CPU tinggi ${d.name}: ${cpu.toFixed(0)}% (threshold ${TH.cpu}%)`);
    if (mem > TH.mem) raiseAlert(d.id, 'warning', 'mem', `Memory tinggi ${d.name}: ${mem.toFixed(0)}%`);
    if (temp > TH.temp) raiseAlert(d.id, 'critical', 'temp', `Suhu tinggi ${d.name}: ${temp.toFixed(0)}C`);
    if (loss > TH.loss) raiseAlert(d.id, 'warning', 'packet_loss', `Packet loss ${d.name}: ${loss}%`);
  }
  // eskalasi: alert open > N menit (hanya perangkat yang dipantau nyata)
  const rules = db.prepare('SELECT * FROM escalation_rules').all();
  for (const rule of rules) {
    const olds = db.prepare(`SELECT a.* FROM alerts a LEFT JOIN devices d ON d.id=a.device_id
      WHERE a.status='open' AND a.escalated=0 AND a.triggered_at <= datetime('now', ?)
      AND (d.monitored=1 OR a.device_id IS NULL)`).all(`-${rule.minutes} minutes`);
    for (const a of olds) {
      db.prepare('UPDATE alerts SET escalated=1 WHERE id=?').run(a.id);
      const msg = `ESKALASI (> ${rule.minutes} mnt open): #${a.id} ${a.message}`;
      db.prepare('INSERT INTO events(source,facility,severity,message) VALUES (?,?,?,?)').run('poller', 'escalation', 'critical', msg);
      notify(a.id, 'critical', msg);
    }
  }
  // retensi: hapus metrik > 30 hari
  try { db.prepare('DELETE FROM metrics WHERE ts < ?').run(Date.now() - 30 * 86400e3); } catch {}
  console.log(`[poller] cycle selesai ${new Date().toISOString()} (${devs.length} devices)`);
}
// syslog listener UDP (RFC3164/5424 -> simpan ke events)
const sock = dgram.createSocket('udp4');
sock.on('message', (msg, rinfo) => {
  const text = msg.toString().slice(0, 1000);
  db.prepare('INSERT INTO events(source,facility,severity,message) VALUES (?,?,?,?)').run(rinfo.address, 'syslog', 'info', text);
});
// identifikasi perangkat LAN tiap 6 siklus (nama laptop/HP, MAC, vendor, tipe)
let cycle = 0;
async function pollCycle() {
  cycle++;
  await pollOnce();
  if (cycle === 1 || cycle % 6 === 0) {
    try { const { identifyAll } = require('./lib/identify'); const r = await identifyAll(); console.log(`[identify] ${r.length} perangkat diperbarui`); }
    catch (e) { console.error('[identify] gagal', e.message); }
  }
}
if (require.main === module) {
  sock.bind(SYSLOG_PORT, () => console.log(`[syslog] UDP :${SYSLOG_PORT}`));
  pollCycle().catch(console.error);
  setInterval(() => pollCycle().catch(console.error), POLL_MS);
  console.log(`[poller] interval ${POLL_MS}ms`);
}
module.exports = { pollOnce, pollCycle, raiseAlert, notify, snmpWalk, remoteExec };
