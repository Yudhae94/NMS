'use strict';
/**
 * Identifikasi perangkat LAN: nama host + MAC + vendor + kelas (laptop/phone/tv/printer/router).
 * Metode: ARP table, NetBIOS (UDP 137), LLMNR (UDP 5355), mDNS (UDP 5353), reverse DNS,
 * lookup OUI vendor, dan probe port ringan (62078 iPhone, 445/3389 Windows, 22 Linux, 9100 printer).
 */
const dgram = require('node:dgram');
const net = require('node:net');
const dns = require('node:dns');
const os = require('node:os');
const { exec } = require('node:child_process');
const { db } = require('./db');

// ---- tabel OUI ringkas (prefix MAC -> [vendor, kelas]) ----
const OUI = {
  '6C:D2:BA': ['TP-Link', 'router'], '50:C7:BF': ['TP-Link', 'router'], 'A4:2B:B0': ['TP-Link', 'router'],
  'F4:EC:38': ['TP-Link', 'router'], '60:32:B1': ['TP-Link', 'router'], 'EC:08:6B': ['TP-Link', 'router'],
  '8C:77:12': ['Samsung', 'phone'], '5C:0A:5B': ['Samsung', 'phone'], 'A0:21:95': ['Samsung', 'phone'],
  'D0:22:BE': ['Samsung', 'phone'], '2C:AE:2B': ['Samsung', 'phone'], '38:AA:3C': ['Samsung', 'phone'],
  'F4:0F:24': ['Apple', 'laptop'], 'A8:66:7F': ['Apple', 'laptop'], '3C:22:FB': ['Apple', 'laptop'],
  'D8:1D:72': ['Apple', 'laptop'], '88:E9:FE': ['Apple', 'phone'], 'F0:18:98': ['Apple', 'laptop'],
  '9C:F3:87': ['Apple', 'phone'], 'B8:5D:0A': ['Apple', 'phone'], 'E0:5F:45': ['Apple', 'laptop'],
  'F4:8C:50': ['Xiaomi', 'phone'], '64:CC:2E': ['Xiaomi', 'phone'], '78:11:DC': ['Xiaomi', 'phone'],
  '50:8F:4C': ['Xiaomi', 'phone'], '28:6C:07': ['Xiaomi', 'phone'], '8C:BE:BE': ['Xiaomi', 'phone'],
  '3C:CD:5D': ['Xiaomi', 'phone'], '9C:99:A0': ['Xiaomi', 'phone'],
  '00:E0:4C': ['Realtek', 'laptop'], '1C:1B:0D': ['Gigabyte', 'laptop'], '2C:F0:5D': ['Micro-Star', 'laptop'],
  '8C:16:45': ['Intel', 'laptop'], 'A4:BB:6D': ['Intel', 'laptop'], 'DC:53:60': ['Intel', 'laptop'],
  'B4:6B:FC': ['Intel', 'laptop'], '34:13:E8': ['Intel', 'laptop'], 'E4:5F:01': ['Raspberry Pi', 'server'],
  'B8:27:EB': ['Raspberry Pi', 'server'], 'DC:A6:32': ['Raspberry Pi', 'server'],
  '88:C9:E8': ['Asus', 'laptop'], '2C:56:DC': ['Asus', 'laptop'], '1C:87:2C': ['Asus', 'laptop'],
  'F0:2F:74': ['Asus', 'laptop'], '00:1B:FC': ['Asus', 'laptop'],
  'C8:5A:9F': ['Oppo', 'phone'], 'FC:A1:83': ['Oppo', 'phone'], '10:47:80': ['Oppo', 'phone'],
  '5C:C9:D3': ['Vivo', 'phone'], '3C:5A:B4': ['Vivo', 'phone'], 'D4:6A:6A': ['Vivo', 'phone'],
  '10:2C:6B': ['Huawei', 'phone'], '48:DB:50': ['Huawei', 'phone'], 'E0:24:7F': ['Huawei', 'phone'],
  '6C:5A:B0': ['Realme', 'phone'], 'AC:64:62': ['Realme', 'phone'],
  'B0:BE:76': ['Hewlett-Packard', 'laptop'], '3C:D9:2B': ['Hewlett-Packard', 'laptop'],
  '84:2A:FD': ['Lenovo', 'laptop'], 'E8:6A:64': ['Lenovo', 'laptop'],
  '00:1E:C9': ['Dell', 'laptop'], 'B0:83:FE': ['Dell', 'laptop'], '5C:F9:DD': ['Dell', 'laptop'],
  '7C:D3:0A': ['LG', 'tv'], 'A8:23:FE': ['LG', 'tv'], 'C4:36:6C': ['LG', 'tv'],
  'D8:0D:17': ['Hisense', 'tv'], 'F8:DF:A8': ['Sony', 'tv'], '30:39:26': ['Sony', 'tv'],
  '38:B8:EB': ['Roku', 'tv'], 'B0:A7:37': ['Roku', 'tv'],
  'CC:32:E5': ['Espressif', 'iot'], '24:0A:C4': ['Espressif', 'iot'], '3C:71:BF': ['Espressif', 'iot'],
  '00:17:88': ['Philips Hue', 'iot'], '5C:CF:7F': ['Espressif', 'iot'],
  '00:80:77': ['Brother', 'printer'], '00:1B:A9': ['Brother', 'printer'], '3C:2A:F4': ['Brother', 'printer'],
  '00:00:48': ['Seiko Epson', 'printer'], 'A4:EE:57': ['Seiko Epson', 'printer'],
  '0C:89:10': ['Samsung', 'printer'], '9C:AE:D3': ['Canon', 'printer'],
  'E0:1F:88': ['Xiaomi', 'phone'], 'E8:65:38': ['Cloud Network Technology', 'laptop'],
  'F4:F5:D8': ['Google', 'phone'], '3C:28:6D': ['Google', 'phone'], 'A4:77:33': ['Google', 'phone'],
  '94:65:9C': ['OnePlus', 'phone'], '64:2C:62': ['Vivo', 'phone'], 'F0:98:38': ['Vivo', 'phone'],
};

// MAC dengan bit local-administer set = privacy/randomized (umum di HP & IoT modern)
function isRandomMac(mac) {
  if (!mac || !/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(mac)) return false;
  return (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0;
}

function vendorOf(mac) {
  if (!mac) return [null, null];
  return OUI[mac.toUpperCase().slice(0, 8)] || [null, null];
}

// ---- ARP table (Windows/Linux) -> { ip: mac } ----
function arpTable() {
  return new Promise((resolve) => {
    exec(process.platform === 'win32' ? 'arp -a' : 'ip neigh', { timeout: 6000 }, (err, out) => {
      const map = {};
      (out || '').split(/\r?\n/).forEach((line) => {
        const m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/);
        if (m) map[m[1]] = m[2].replace(/-/g, ':').toUpperCase();
      });
      // interface lokal sendiri (tidak muncul di tabel ARP)
      for (const ifs of Object.values(os.networkInterfaces())) {
        for (const a of ifs || []) {
          if (a.family === 'IPv4' && a.mac && a.mac !== '00:00:00:00:00:00') map[a.address] = a.mac.toUpperCase();
        }
      }
      resolve(map);
    });
  });
}

// ---- NetBIOS NBSTAT (UDP 137) : nama komputer Windows ----
function nbstat(ip, timeout = 900) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (v) => { try { sock.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), timeout);
    sock.on('error', () => { clearTimeout(t); done(null); });
    sock.on('message', (msg) => {
      try {
        let i = 12;                        // lewati header DNS
        while (i < msg.length && msg[i] !== 0) i++; // qname (32 char encoded)
        i += 1 + 2 + 2 + 4;                // null + type + class + ttl
        i += 2;                            // rdlength (16-bit)
        const count = msg[i];              // NUM_NAMES
        if (count > 0 && msg.length >= i + 26) {
          const nm = msg.slice(i + 1, i + 16).toString('latin1').replace(/\0.*$/, '').trim();
          if (nm) { clearTimeout(t); return done(nm); }
        }
      } catch {}
      clearTimeout(t); done(null);
    });
    // query NetBIOS wildcard "*" (encode: '*' -> "CK", 0x00 -> "AA")
    const hdr = Buffer.from([0x12, 0x34, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const raw = Buffer.alloc(16); raw[0] = 0x2a;            // '*' + 15 nol
    let enc = '';
    for (const b of raw) enc += String.fromCharCode(0x41 + (b >> 4), 0x41 + (b & 0x0f));
    const qname = Buffer.from(enc + '\0', 'latin1');        // 32 char + null
    const pkt = Buffer.concat([hdr, qname, Buffer.from([0x00, 0x21, 0x00, 0x01])]); // NBSTAT/IN
    sock.send(pkt, 137, ip, () => {});
  });
}

// ---- LLMNR PTR (UDP 5355) : nama host Windows/modern ----
function llmnr(ip, timeout = 900) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (v) => { try { sock.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), timeout);
    sock.on('error', () => { clearTimeout(t); done(null); });
    sock.on('message', (msg) => {
      const words = (msg.toString('latin1').match(/[A-Za-z0-9][A-Za-z0-9\-_]{0,62}/g) || [])
        .filter((s) => s.length > 3 && !/^(in-addr|arpa|local)$/i.test(s));
      clearTimeout(t); done(words[0] || null);
    });
    const labels = ip.split('.').reverse().concat(['in-addr', 'arpa']);
    const parts = [Buffer.from([0x12, 0x34, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])];
    labels.forEach((l) => parts.push(Buffer.from([l.length]), Buffer.from(l, 'latin1')));
    parts.push(Buffer.from([0x00, 0x00, 0x0c, 0x00, 0x01]));
    sock.send(Buffer.concat(parts), 5355, ip, () => {});
  });
}

// ---- mDNS (UDP 5353) : nama .local (Apple/Android) ----
function mdns(ip, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = (v) => { try { sock.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), timeout);
    sock.on('error', () => { clearTimeout(t); done(null); });
    sock.bind(0, () => {
      sock.on('message', (msg) => {
        const m = msg.toString('latin1').match(/([A-Za-z0-9][A-Za-z0-9\-_]{1,62})\.local\.?/);
        clearTimeout(t); done(m ? m[1] : null);
      });
      const labels = ip.split('.').reverse().concat(['in-addr', 'arpa']);
      const parts = [Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])];
      labels.forEach((l) => parts.push(Buffer.from([l.length]), Buffer.from(l, 'latin1')));
      parts.push(Buffer.from([0x00, 0x00, 0x0c, 0x00, 0x01]));
      sock.send(Buffer.concat(parts), 5353, '224.0.0.251', () => {});
    });
  });
}

function reverseDns(ip) {
  return new Promise((resolve) => dns.reverse(ip, (err, names) => resolve(err || !names || !names.length ? null : String(names[0]).replace(/\.$/, ''))));
}

// ---- probe port ringan untuk klasifikasi kelas perangkat ----
function probe(ip, port, timeout = 450) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
async function portHints(ip) {
  const [iphone, win, linux, printer, cast] = await Promise.all([
    probe(ip, 62078), probe(ip, 445), probe(ip, 22), probe(ip, 9100), probe(ip, 8009),
  ]);
  return { iphone, win, linux, printer, cast };
}

function classify({ name, cls, hints }) {
  const n = (name || '').toLowerCase();
  if (hints.iphone || /^(iphone|ipad)/.test(n)) return 'phone';
  if (/redmi|xiaomi|oppo|vivo|realme|infinix|poco|galaxy|sm-[a-z]\d|android|huawei|honor|oneplus|nokia/.test(n)) return 'phone';
  if (/macbook|imac|thinkpad|ideapad|latitude|inspiron|vivobook|zenbook|elitebook|pavilion|desktop-|laptop|nb-|pc-/.test(n)) return 'laptop';
  if (hints.printer || cls === 'printer') return 'printer';
  if (hints.cast || cls === 'tv') return 'tv';
  if (hints.win) return 'laptop';
  if (hints.linux && cls === 'server') return 'server';
  if (cls === 'iot') return 'iot';
  if (cls) return cls;
  return 'host';
}

// ---- identifikasi satu perangkat ----
async function identify(raw, arp) {
  const ip = raw.ip;
  const mac = arp[ip] || raw.mac || null;
  const [vendor, cls] = vendorOf(mac);
  const hints = await portHints(ip).catch(() => ({}));
  let found = null;
  if (raw.type !== 'router') {
    found = (await nbstat(ip)) || (await llmnr(ip)) || (await mdns(ip)) || (await reverseDns(ip));
  }
  const type = raw.type === 'router' ? 'router' : classify({ name: found, cls, hints });
  const knownVendor = vendor && !/^(MAC randomized|unknown)$/i.test(vendor);
  const guess = knownVendor
    ? `${vendor.replace(/[^A-Za-z0-9]+/g, '')}-${type}-${ip.split('.')[3]}`
    : 'HOST-' + ip.split('.').join('-');
  const keepName = raw.name && !/^HOST-LAN-/.test(raw.name);
  let name;
  if (raw.type === 'router') name = raw.name || 'ROUTER-' + ip.split('.').join('-');
  else if (found) name = found;
  else if (keepName) name = raw.name;             // nama manual/user dipertahankan
  else if (knownVendor) name = guess;             // mis. XIAOMI-PHONE-4
  else name = raw.name || guess;                  // pertahankan HOST-LAN-x
  const vendorLabel = vendor || (isRandomMac(mac) ? 'MAC randomized' : (raw.vendor === 'auto-discovery' ? 'unknown' : raw.vendor)) || 'unknown';
  return {
    ip, mac, vendor: vendorLabel, type,
    name: String(name).toUpperCase().slice(0, 40).trim(),
    hostname: found, hints,
  };
}

// ---- identifikasi semua perangkat terpantau + sinkronkan DB ----
async function identifyAll(opts = {}) {
  const arp = await arpTable();
  const devs = db.prepare('SELECT * FROM devices WHERE monitored=1').all();
  const upd = db.prepare('UPDATE devices SET name=?, vendor=?, type=?, mac=?, model=?, os_guess=? WHERE id=?');
  const results = await Promise.all(devs.map((d) => identify(d, arp).catch(() => null))); // paralel, cepat
  const evIns = db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('identify','discovery','info',?)");
  for (let k = 0; k < devs.length; k++) {
    const r = results[k]; if (!r) continue;
    const d = devs[k];
    upd.run(r.name, r.vendor === 'unknown' && d.vendor !== 'auto-discovery' ? (d.vendor || 'unknown') : r.vendor, r.type, r.mac, r.hostname || d.model, r.type, d.id);
    results[k] = r;
    evIns.run(`${r.ip} → ${r.name} (${r.type}, ${r.vendor}, MAC ${r.mac || 'n/a'})`);
  }
  const rows = results.filter(Boolean);
  if (opts.linkRouter !== false) {
    const router = db.prepare("SELECT id FROM devices WHERE type='router' AND monitored=1 ORDER BY id LIMIT 1").get();
    if (router) {
      const ins = db.prepare('INSERT INTO links(src_device,src_port,dst_device,dst_port) VALUES (?,?,?,?)');
      for (const d of db.prepare('SELECT id FROM devices WHERE monitored=1 AND id<>?').all(router.id)) {
        const ex = db.prepare('SELECT COUNT(*) c FROM links WHERE (src_device=? AND dst_device=?) OR (src_device=? AND dst_device=?)').get(router.id, d.id, d.id, router.id).c;
        if (!ex) ins.run(router.id, 'LAN', d.id, 'eth0');
      }
    }
  }
  return rows;
}

module.exports = { identify, identifyAll, arpTable, nbstat, llmnr, mdns, reverseDns, vendorOf, portHints, classify, isRandomMac };
