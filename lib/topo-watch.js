'use strict';
/**
 * Topology watch — deteksi cepat perangkat baru & gangguan jaringan (WiFi/LAN).
 * Berjalan otomatis sebagai loop background server.js (matikan dengan TOPO_WATCH=0):
 *  1) ping-sweep /24 paralel (timeout pendek) + tabel ARP -> daftar host hidup
 *  2) host baru          -> daftar otomatis ke `devices`, auto-link ke router, event
 *  3) hilang 1x          -> status 'degraded' + event peringatan
 *     hilang >= MISS     -> status 'down' + alert 'down' + event (jaringan error)
 *     muncul kembali     -> status 'up', alert down di-resolve, event pulih
 *  4) SSID WiFi terkoneksi dibaca via `netsh wlan show interfaces` (cache 60 dtk)
 *     agar topologi tahu perangkat tersambung di WiFi apa (ruang sekcam, aula, dst.)
 *     -> perangkat ditandai `ssid` + link khusus "WiFi:<ssid>" ke gateway/AP
 *  5) ringkasan jumlah perangkat (`counts`) disediakan untuk GET /api/topology
 *
 * Host yang memblokir ICMP tidak dianggap down: bila masih ada di tabel ARP atau
 * merespons port TCP umum, tetap dihitung hidup (lihat `reachable` di net-scan).
 *
 * Env: TOPO_WATCH=0 (matikan), TOPO_WATCH_MS (default 15000), TOPO_SUBNET (prefix
 *      "192.168.1" bila subnet berbeda), TOPO_MISS (default 2), TOPO_NEW_MIN (default 15)
 */
const path = require('node:path');
const os = require('node:os');
const { db } = require('./db');
const { pingSweep, arpMap, localSubnet, reachable, run, IS_WIN, SYS32 } = require('./net-scan');

const WATCH_MS = Math.max(5000, Number(process.env.TOPO_WATCH_MS) || 15000);
const MISS_LIMIT = Math.max(1, Number(process.env.TOPO_MISS) || 2);
const NEW_MIN = Math.max(1, Number(process.env.TOPO_NEW_MIN) || 15);
const WIFI_CACHE_MS = 60000;
// Rentang pool DHCP yang dianggap dinamis (oktet terakhir >= batas ini).
// Host hidup di rentang ini + belum bernama -> didaftarkan sebagai DHCP-xxx.
// Bila router/AP memakai pool berbeda, set TOPO_DHCP_FROM=... (mis. 50).
const DHCP_FROM = Math.min(254, Math.max(2, Number(process.env.TOPO_DHCP_FROM) || 100));
const SELF_IP = /^(127\.|0\.0\.0\.0$)/;

let timer = null;
let busy = false;
let last = null;               // ringkasan scan terakhir
const miss = new Map();        // ip -> jumlah scan berturut tidak terlihat
let wifi = null;               // cache info SSID WiFi terkoneksi
let wifiAt = 0;
let selfIps = new Set();       // IP milik mesin NMS ini (dikecualikan dari perangkat baru)

// ---- kolom `ssid`/`iface` pada devices (db lama belum punya) ------------------
function ensureDeviceCols() {
  try {
    const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
    if (!cols.includes('ssid')) db.exec('ALTER TABLE devices ADD COLUMN ssid TEXT');
    if (!cols.includes('iface')) db.exec('ALTER TABLE devices ADD COLUMN iface TEXT');
  } catch { /* abaikan */ }
}
ensureDeviceCols();

function ev(severity, message) {
  try {
    db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('watch','discovery',?,?)").run(severity, message);
  } catch { /* db sibuk — lewati */ }
}

function raiseDown(d) {
  try {
    const open = db.prepare("SELECT id FROM alerts WHERE device_id IS ? AND type='down' AND status='open'").get(d.id);
    if (!open) {
      db.prepare("INSERT INTO alerts(device_id,severity,type,message) VALUES (?,'critical','down',?)")
        .run(d.id, `Device DOWN: ${d.name} (${d.ip}) tidak terdeteksi ${MISS_LIMIT}x berturut-turut (topology watch)`);
    }
    ev('critical', `Jaringan error: ${d.name} (${d.ip}) DOWN — tidak terlihat ${MISS_LIMIT}x berturut-turut`);
  } catch { /* abaikan */ }
}

function resolveDown(id) {
  try {
    db.prepare("UPDATE alerts SET status='resolved', resolved_at=datetime('now') WHERE device_id=? AND type='down' AND status='open'").run(id);
  } catch { /* abaikan */ }
}

/** Link yang sama tidak dibuat dua kali (src,dst,src_port unik). */
function ensureLink(srcId, dstId, srcPort, dstPort, state) {
  if (!srcId || !dstId || srcId === dstId) return;
  try {
    const r = db.prepare('INSERT OR IGNORE INTO links(src_device,src_port,dst_device,dst_port,state) VALUES (?,?,?,?,?)')
      .run(srcId, srcPort || '', dstId, dstPort || '', state || 'up');
    if (r.changes) return;
    db.prepare('UPDATE links SET state=? WHERE src_device=? AND dst_device=? AND src_port=?').run(state || 'up', srcId, dstId, srcPort || '');
  } catch { /* abaikan */ }
}

/** Tautkan perangkat baru ke router (bintang) supaya langsung tampil terhubung di topologi. */
function autoLinkRouter(newId, ssid) {
  try {
    const router = db.prepare("SELECT id FROM devices WHERE type='router' AND monitored=1 ORDER BY id LIMIT 1").get();
    if (!router || router.id === newId) return;
    // perangkat WiFi -> link berlabel WiFi:<ssid> (dikelompokkan per ruangan di topologi)
    ensureLink(router.id, newId, ssid ? ('WiFi:' + ssid) : 'LAN', '', 'up');
  } catch { /* abaikan */ }
}

/** Baca SSID WiFi yang sedang dipakai (cepat, satu perintah netsh; cache 60 dtk). */
async function refreshWifi(force) {
  if (!force && wifi && Date.now() - wifiAt < WIFI_CACHE_MS) return wifi;
  try {
    if (IS_WIN) {
      const txt = await run(path.join(SYS32, 'netsh.exe'), ['wlan', 'show', 'interfaces'], 8000);
      const ap = require('./wifi').parseNetshInterfaces(txt);
      if (ap && ap.ssid) {
        wifi = {
          ssid: ap.ssid, bssid: ap.bssid || null, channel: ap.channel ?? null, signal: ap.signal ?? null,
          radio: ap.radio_type || null, state: ap.state || null, adapter: ap.adapter || null, at: Date.now(),
        };
      } else if (ap) {
        wifi = null;   // interface ada tapi tidak tersambung WiFi (mis. kabel)
      } // ap null -> perintah gagal: pertahankan cache
    }
  } catch { /* adapter WiFi nonaktif */ }
  wifiAt = Date.now();
  return wifi;
}

/** Ringkasan jumlah perangkat untuk kartu statistik halaman Topologi. */
function counts() {
  const r = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(status='up'), 0) AS up,
      COALESCE(SUM(status='down'), 0) AS down,
      COALESCE(SUM(status='degraded'), 0) AS degraded,
      COALESCE(SUM(status IS NULL OR status='unknown'), 0) AS unknown,
      COALESCE(SUM(monitored=1), 0) AS monitored
    FROM devices`).get();
  let newDevices = 0, links = 0, wifiClients = 0;
  try { newDevices = db.prepare("SELECT COUNT(*) c FROM devices WHERE created_at >= datetime('now', ?)").get(`-${NEW_MIN} minutes`).c; } catch { /* abaikan */ }
  try { links = db.prepare('SELECT COUNT(*) c FROM links').get().c; } catch { /* abaikan */ }
  try { wifiClients = db.prepare("SELECT COUNT(*) c FROM devices WHERE monitored=1 AND ssid IS NOT NULL AND ssid<>''").get().c; } catch { /* abaikan */ }
  return {
    total: r.total, up: r.up, down: r.down, degraded: r.degraded, unknown: r.unknown,
    monitored: r.monitored, new_devices: newDevices, new_window_min: NEW_MIN, links,
    wifi_clients: wifiClients,
  };
}

/** IP milik mesin ini sendiri: dikecualikan agar localhost tidak jadi perangkat baru. */
function computeSelfIps() {
  const s = new Set();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && a.address && !SELF_IP.test(a.address)) s.add(a.address);
    }
  } catch { /* abaikan */ }
  return s;
}

/**
 * Scan dipanggil tombol "Scan sekarang" (dengan token auth).
 * Menunggu siklus yang sedang jalan sampai 25 dtk supaya tombol tidak
 * membalikkan hasil kosong hanya karena kebetulan watcher sedang bekerja.
 */
function scanNow(timeoutMs) {
  const ms = Math.max(3000, Number(timeoutMs) || 25000);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const t = setTimeout(() => finish({ skipped: true, reason: 'scan masih berjalan', ts: Date.now(), counts: counts() }), ms);
    if (t.unref) t.unref();
    scanOnce().then((r) => { clearTimeout(t); finish(r); }).catch((e) => { clearTimeout(t); finish({ error: e.message, counts: counts() }); });
  });
}


/**
 * Satu siklus deteksi. Aman dipanggil bersamaan (bila masih jalan, return ringkasan terakhir).
 * Hasil: { ts, duration_ms, subnet, alive, added[], down[], changed[], counts }
 */
async function scanOnce() {
  if (busy) {
    return { skipped: true, ts: last ? last.ts : Date.now(), subnet: last ? last.subnet : null, alive: last ? last.alive : 0, added: [], down: [], changed: [], counts: counts() };
  }
  busy = true;
  const t0 = Date.now();
  try {
    ensureDeviceCols();
    if (!selfIps.size) selfIps = computeSelfIps();
    const prefix = localSubnet(process.env.TOPO_SUBNET || undefined);
    const [swept, arp] = await Promise.all([
      pingSweep(prefix, 254, { batch: 64, waitMs: 600 }),
      arpMap(),
      refreshWifi(),   // SSID WiFi terkoneksi (cache 60 dtk) agar pesan "perangkat baru" menyebut SSID
    ]);
    const alive = new Set(swept.map((s) => s.ip));
    const devs = db.prepare('SELECT * FROM devices').all();
    const known = new Map();
    for (const d of devs) if (!known.has(d.ip)) known.set(d.ip, d);   // lookup per-IP (baris pertama)
    const inSub = (ip) => ip.startsWith(prefix + '.') && !ip.endsWith('.0') && !ip.endsWith('.255') && !ip.startsWith('169.254.');

    // Uji host yang tak terlihat sweep: kandidat baru dari tabel ARP + perangkat dipantau
    // (ping + port TCP -> host yang blokir ICMP tidak dianggap down salah).
    const recheck = new Set();
    for (const ip of Object.keys(arp)) {
      if (inSub(ip) && !alive.has(ip) && !known.has(ip) && !selfIps.has(ip)) recheck.add(ip);
    }
    for (const d of known.values()) {
      if (d.monitored && inSub(d.ip) && !alive.has(d.ip)) recheck.add(d.ip);
    }
    await Promise.all([...recheck].map(async (ip) => { if (await reachable(ip)) alive.add(ip); }));

    const added = [], changed = [], down = [];
    const wifiAp = await refreshWifi();
    const ssid = wifiAp && wifiAp.ssid ? wifiAp.ssid : null;
    const adapter = wifiAp && wifiAp.adapter ? wifiAp.adapter : null;
    const sel = db.prepare('SELECT * FROM devices WHERE ip=?');
    const ins = db.prepare("INSERT INTO devices(name,ip,type,vendor,snmp_version,snmp_community,snmp_protocol,status,mac,discovered,monitored,ssid,iface,last_seen) VALUES (?,?,?,'auto-watch','v2c','public','ssh','up',?,1,1,?,?,datetime('now'))");
    const updSeen = db.prepare("UPDATE devices SET last_seen=datetime('now'), mac=COALESCE(?,mac), ssid=COALESCE(?,ssid), iface=COALESCE(?,iface) WHERE id=?");
    const updUp = db.prepare("UPDATE devices SET status='up', latency=?, last_seen=datetime('now'), mac=COALESCE(?,mac), ssid=COALESCE(?,ssid), iface=COALESCE(?,iface) WHERE id=?");

    // 1) perangkat baru + pembaruan status yang terlihat
    for (const ip of [...alive].sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]))) {
      const mac = arp[ip] || null;
      const rows = sel.all(ip);
      if (!rows.length) {
        if (selfIps.has(ip)) continue;   // mesin NMS sendiri bukan "perangkat baru"
        const oct4 = Number(ip.split('.')[3]);
        const tag = ssid ? String(ssid).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) : '';
        const nm = ((oct4 >= DHCP_FROM) || tag ? 'DHCP' + (tag ? '-' + tag : '') + '-' + (tag ? oct4 : ip.replace(/\./g, '-')) : 'HOST-' + ip.replace(/\./g, '-'));
        const r = ins.run(nm, ip, 'host', mac, ssid, adapter);
        const id = Number(r.lastInsertRowid);
        added.push({ ip, mac, ssid });
        autoLinkRouter(id, ssid);
        ev('info', `Perangkat baru (DHCP) terdeteksi${ssid ? ' di WiFi ' + ssid : ' di subnet ' + prefix} : ${nm} ${ip}${mac ? ' (' + mac + ')' : ''} — langsung masuk topologi`);
        changed.push({ id, ip, from: null, to: 'up' });
        continue;
      }
      miss.delete(ip);
      const hit = swept.find((s) => s.ip === ip);
      for (const d of rows) {
        // Perangkat lama bernama HOST-xxx yang masih aktif di pool/WiFi yang sama
        // -> migrasikan namanya ke skema DHCP agar peta konsisten.
        try {
          if (d && /^HOST-/i.test(d.name || '')) {
            const tag2 = ssid ? String(ssid).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) : '';
            const o4 = Number(String(ip).split('.')[3]);
            if ((o4 >= DHCP_FROM) || tag2) {
              const nm2 = 'DHCP' + (tag2 ? '-' + tag2 : '') + '-' + (tag2 ? o4 : String(ip).replace(/\./g, '-'));
              db.prepare('UPDATE devices SET name=? WHERE id=?').run(nm2, d.id);
              d.name = nm2;
            }
          }
        } catch { /* abaikan */ }
        if (d.status !== 'up') {
          updUp.run(hit ? hit.ms : null, mac, ssid, adapter, d.id);
          if (d.status === 'down') {
            resolveDown(d.id);
            ev('info', `Perangkat pulih: ${d.name} (${d.ip}) kembali terhubung`);
          }
          changed.push({ id: d.id, ip, from: d.status, to: 'up' });
        } else {
          updSeen.run(mac, ssid, adapter, d.id);
        }
      }
    }

    // 2) deteksi gangguan jaringan pada perangkat dipantau (hanya subnet aktif)
    for (const d of devs) {
      if (!d.monitored || !inSub(d.ip) || alive.has(d.ip)) continue;
      const m = (miss.get(d.ip) || 0) + 1;
      miss.set(d.ip, m);
      if (m >= MISS_LIMIT && d.status !== 'down') {
        db.prepare("UPDATE devices SET status='down' WHERE id=?").run(d.id);
        raiseDown(d);
        down.push({ id: d.id, ip: d.ip, name: d.name });
        changed.push({ id: d.id, ip: d.ip, from: d.status, to: 'down' });
      } else if (m === 1 && d.status === 'up') {
        db.prepare("UPDATE devices SET status='degraded' WHERE id=?").run(d.id);
        ev('warning', `Jaringan bermasalah: ${d.name} (${d.ip}) gagal dijangkau (percobaan 1/${MISS_LIMIT})`);
        changed.push({ id: d.id, ip: d.ip, from: d.status, to: 'degraded' });
      }
    }

    // 3) status link WiFi/AP: link ke perangkat down ikut ditandai down (garis merah di peta)
    try {
      db.prepare(`UPDATE links SET state='down' WHERE dst_device IN (SELECT id FROM devices WHERE status='down')
        OR src_device IN (SELECT id FROM devices WHERE status='down')`).run();
      db.prepare(`UPDATE links SET state='up' WHERE state='down'
        AND src_device NOT IN (SELECT id FROM devices WHERE status='down')
        AND dst_device NOT IN (SELECT id FROM devices WHERE status='down')`).run();
    } catch { /* abaikan */ }

    await refreshWifi();
    last = {
      ts: Date.now(), duration_ms: Date.now() - t0, subnet: prefix + '.0/24',
      alive: alive.size, added, down, changed, counts: counts(),
    };
    if (added.length) ev('info', `Scan watch: ${alive.size} host aktif, ${added.length} perangkat baru terdaftar otomatis`);
    return last;
  } finally { busy = false; }
}

/** Info SSID WiFi terkoneksi (hasil terakhir; null bila belum terbaca / tidak tersambung). */
function wifiInfo() { return wifi; }

/** Status watcher untuk GET /api/topology. */
function status() {
  return {
    running: !!timer, interval_ms: WATCH_MS, miss_limit: MISS_LIMIT, new_min: NEW_MIN,
    last_scan: last ? last.ts : null, duration_ms: last ? last.duration_ms : null,
    subnet: last ? last.subnet : null,
  };
}

/** Mulai loop background (idempoten). */
function startWatch() {
  if (timer) return;
  const runOnce = () => { scanOnce().catch((e) => console.error('[topo-watch] ' + e.message)); };
  timer = setInterval(runOnce, WATCH_MS);
  if (timer.unref) timer.unref();
  const first = setTimeout(runOnce, 2000);
  if (first.unref) first.unref();
  console.log(`[topo-watch] deteksi perangkat baru & gangguan tiap ${WATCH_MS}ms (TOPO_WATCH=0 untuk mematikan)`);
}

module.exports = { scanOnce, scanNow, startWatch, counts, wifiInfo, status, ensureDeviceCols };


