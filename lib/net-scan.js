'use strict';
/**
 * Utilitas pemindaian jaringan bersama (dipakai discovery, scan LAN/WiFi, dan poller).
 * Tidak ada dependency eksternal: hanya child_process + node:net + node:os.
 * Fungsi: ping tunggal, ping-sweep paralel, tabel ARP, daftar interface lokal, probe port TCP.
 */
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { exec, execFile } = require('node:child_process');

// Path absolut utilitas Windows: sebagian proses tidak mewarisi System32 di PATH
// sehingga 'ping'/'arp' gagal dijalankan (hasil scan jadi kosong).
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const IS_WIN = process.platform === 'win32';
const PING_EXE = IS_WIN ? path.join(SYS32, 'PING.EXE') : 'ping';
const ARP_EXE = IS_WIN ? path.join(SYS32, 'ARP.EXE') : 'arp';
const PING_CMD = IS_WIN ? `"${PING_EXE}"` : 'ping';
const ARP_CMD = IS_WIN ? `"${ARP_EXE}" -a` : 'ip neigh';

/** Jalankan perintah shell, selalu resolve (tidak pernah melempar error). */
function sh(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    const child = exec(cmd, { timeout, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? '' : (out || '')));
    child.on('error', () => resolve(''));
  });
}

/** Jalankan executable + argumen tanpa shell (aman terhadap spasi pada nama interface). */
function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 1 << 22, windowsHide: true }, (err, out) => resolve(err ? '' : (out || '')));
  });
}

/** Ping satu host -> { ip, alive, ms }. */
function pingOnce(ip, waitMs = 900) {
  const cmd = IS_WIN
    ? `${PING_CMD} -n 1 -w ${waitMs} ${ip}`
    : `ping -c 1 -W ${Math.max(1, Math.round(waitMs / 1000))} ${ip}`;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = exec(cmd, { timeout: waitMs + 3000 }, (err, out) => {
      if (err) return resolve({ ip, alive: false });
      const m = String(out).match(/time[=<]\s*([\d.]+)\s?ms/i);
      resolve({ ip, alive: true, ms: m ? Number(m[1]) : Date.now() - t0 });
    });
    child.on('error', () => resolve({ ip, alive: false }));
  });
}

/** Ping-sweep seluruh host /24 (batch paralel) -> [{ ip, ms }]. */
async function pingSweep(prefix, limit = 254, opts = {}) {
  const batchSize = opts.batch || 32;
  const waitMs = opts.waitMs || 900;
  const alive = [];
  let batch = [];
  for (let i = 1; i <= limit; i++) {
    const ip = `${prefix}.${i}`;
    batch.push(pingOnce(ip, waitMs).then((r) => { if (r.alive) alive.push({ ip: r.ip, ms: r.ms }); }));
    if (batch.length >= batchSize) { await Promise.all(batch); batch = []; }
  }
  await Promise.all(batch);
  alive.sort((a, b) => Number(a.ip.split('.')[3]) - Number(b.ip.split('.')[3]));
  return alive;
}

/** Baca tabel ARP sistem -> { ip: MAC }. Nilai null bila tidak terbaca. */
async function arpMap() {
  const out = await sh(ARP_CMD, 6000);
  const real = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/);
    if (!m) continue;
    const mac = m[2].replace(/-/g, ':').toUpperCase();
    if (/^(FF:FF:FF|01:00:5E|00:00:00)/.test(mac)) continue;   // broadcast / multicast
    real[m[1]] = mac;
  }
  // interface lokal sendiri tidak muncul di tabel ARP
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && a.mac && a.mac !== '00:00:00:00:00:00') real[a.address] = a.mac.toUpperCase();
    }
  }
  return real;
}

/** Interface IPv4 aktif (ip, mac, prefix /24, nama interface). */
function localIfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({
        name, ip: a.address, mac: a.mac ? a.mac.toUpperCase() : null,
        prefix: a.address.split('.').slice(0, 3).join('.'), cidr: a.cidr || null,
      });
    }
  }
  return out;
}

/** Subnet /24 dari interface aktif (prioritas RFC1918). */
function localSubnet(prefixArg) {
  if (prefixArg) return String(prefixArg).replace(/\.$/, '');
  const ips = localIfaces().filter((i) => !i.ip.startsWith('169.254.'));
  const pref = ips.find((i) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.ip));
  return (pref || ips[0] || { ip: '192.168.1.1' }).prefix;
}

/** Probe port TCP -> true bila terhubung. */
function tcpProbe(ip, port, timeout = 300) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

/** Host hidup walau ICMP diblokir: ping atau ada port TCP umum yang terbuka. */
async function reachable(ip, ports = [80, 443, 445, 22, 53, 8008, 62078]) {
  if ((await pingOnce(ip, 700)).alive) return true;
  for (const p of ports) if (await tcpProbe(ip, p)) return true;
  return false;
}

module.exports = {
  IS_WIN, SYS32, PING_EXE, ARP_EXE, PING_CMD, ARP_CMD,
  sh, run, pingOnce, pingSweep, arpMap, localIfaces, localSubnet, tcpProbe, reachable,
};
