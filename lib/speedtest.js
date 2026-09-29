'use strict';
/**
 * Speedtest koneksi yang sedang dipakai (WiFi/LAN): latensi, jitter, unduh, unggah.
 * Zero dependency — endpoint uji publik speed.cloudflare.com (fallback: Google).
 * Semua diukur dari server NMS ini; hasilnya disimpan ke tabel `speedtests` + tampil di halaman Kanal WiFi.
 */
const { db } = require('./db');
const { pingOnce, localIfaces } = require('./net-scan');

// ---- skema ----
function ensureTable() {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS speedtests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      iface TEXT, local_ip TEXT, subnet TEXT,
      target TEXT, endpoint TEXT,
      ping_min REAL, ping_avg REAL, ping_max REAL, jitter REAL, loss REAL,
      down_mbps REAL, up_mbps REAL, grade TEXT, duration_ms INTEGER,
      isp TEXT, asn TEXT, public_ip TEXT, geo TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS speedtest_samples (
      speedtest_id INTEGER PRIMARY KEY,
      ping_raw TEXT
    )`);
    // migrasi ringan: tabel lama belum punya kolom identitas ISP
    const cols = db.prepare('PRAGMA table_info(speedtests)').all().map((c) => c.name);
    if (cols.length) {
      for (const c of ['isp', 'asn', 'public_ip', 'geo']) {
        if (!cols.includes(c)) db.exec(`ALTER TABLE speedtests ADD COLUMN ${c} TEXT`);
      }
    }
  } catch {}
}
ensureTable();

/** Median array angka (tahan terhadap satu sampel aneh). */
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Ping N kali ke target -> statistik latensi + jitter (median |selisih berurutan|). */
async function pingStats(host, count = 10, waitMs = 1000) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const r = await pingOnce(host, waitMs);
    if (r.alive && Number.isFinite(r.ms)) samples.push(r.ms);
  }
  if (!samples.length) return { ok: false, host, samples: 0, loss: 100 };
  const diffs = [];
  for (let i = 1; i < samples.length; i++) diffs.push(Math.abs(samples[i] - samples[i - 1]));
  return {
    ok: true, host, samples: samples.length, loss: +(((count - samples.length) / count) * 100).toFixed(1),
    min: +Math.min(...samples).toFixed(2), avg: +median(samples).toFixed(2), max: +Math.max(...samples).toFixed(2),
    jitter: diffs.length ? +median(diffs).toFixed(2) : 0, raw: samples.map((v) => +v.toFixed(1)),
  };
}

/** Unduh N byte secepat mungkin -> Mbps. */
async function downTest(url, timeout = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const t0 = Date.now();
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let bytes = 0;
    for await (const chunk of r.body) bytes += chunk.length;
    const secs = Math.max(0.05, (Date.now() - t0) / 1000);
    return { ok: true, bytes, secs: +secs.toFixed(2), mbps: +((bytes * 8 / secs / 1e6).toFixed(2)) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  } finally { clearTimeout(t); }
}

/** Unggah N byte secepat mungkin -> Mbps. */
async function upTest(url, bytes, timeout = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const body = Buffer.alloc(bytes, 'a');
    const t0 = Date.now();
    const r = await fetch(url, { method: 'POST', body, signal: ctrl.signal, duplex: 'half' });
    await r.text().catch(() => '');
    const secs = Math.max(0.05, (Date.now() - t0) / 1000);
    return { ok: r.ok, bytes, secs: +secs.toFixed(2), mbps: +((bytes * 8 / secs / 1e6).toFixed(2)) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  } finally { clearTimeout(t); }
}

function gradeOf(pingAvg, jitter, down) {
  let score = 100;
  if (pingAvg > 200) score -= 35; else if (pingAvg > 100) score -= 20; else if (pingAvg > 50) score -= 10; else if (pingAvg > 20) score -= 4;
  if (jitter > 50) score -= 25; else if (jitter > 20) score -= 12; else if (jitter > 8) score -= 6;
  if (!(down > 0)) score -= 15; else if (down < 1) score -= 25; else if (down < 5) score -= 12; else if (down < 20) score -= 4;
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

/** Gateway = host .1 di subnet lokal (umum di router rumahan). */
async function detectGateway(prefix) {
  if (!prefix) return null;
  const gw = `${prefix}.1`;
  const r = await pingOnce(gw, 1000);
  return r.alive ? { ip: gw, ms: r.ms } : { ip: gw, ms: null };
}

/**
 * Identitas ISP yang sedang dipakai: nama penyedia layanan, IP publik, dan lokasi.
 * Sumber data gratis tanpa API key (diurutkan, dipakai yang pertama berhasil):
 * ipwho.is -> ipapi.co -> ipinfo.io. Gagal semua -> null (speedtest tetap jalan).
 */
const ISP_SOURCES = [
  { name: 'ipwho.is', url: 'https://ipwho.is/', map: (m) => ({ isp: m.connection?.isp, org: m.connection?.org, asn: m.connection?.asn, ip: m.ip, city: m.city, country: m.country }) },
  { name: 'ipapi.co', url: 'https://ipapi.co/json/', map: (m) => ({ isp: m.org, org: m.org, asn: m.asn, ip: m.ip, city: m.city, country: m.country_name }) },
  { name: 'ipinfo.io', url: 'https://ipinfo.io/json', map: (m) => ({ isp: m.org, org: m.org, asn: m.asn, ip: m.ip, city: m.city, country: m.country }) },
];
// nama jaringan generik milik registry regional -> lebih informatif pakai nama organisasi
const GENERIC_ISP = /network information center|nccnet|apnic|ripencc|arin|registry/i;

function pickIspName(isp, org) {
  const a = String(isp || '').trim(), b = String(org || '').trim();
  if (a && !GENERIC_ISP.test(a)) return a;
  if (b) return b;
  return a || null;
}

async function fetchJson(url, timeout = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function ispInfo() {
  for (const s of ISP_SOURCES) {
    const m = await fetchJson(s.url);
    if (!m) continue;
    const d = s.map(m) || {};
    const isp = pickIspName(d.isp, d.org);
    if (!isp) continue;
    return {
      isp,
      asn: d.asn ? (String(d.asn).toUpperCase().startsWith('AS') ? String(d.asn).toUpperCase() : 'AS' + d.asn) : null,
      public_ip: d.ip || null,
      geo: [d.city, d.country].filter(Boolean).join(', ') || null,
      source: s.name,
    };
  }
  return { isp: null, asn: null, public_ip: null, geo: null, source: null };
}

/**
 * Speedtest lengkap: ping gateway + internet, lalu unduh & unggah bila ping internet OK.
 * opts: { pings, bytesDown, bytesUp, target }
 */
async function runSpeedtest(opts = {}) {
  ensureTable();
  const t0 = Date.now();
  const ifaces = localIfaces();
  const local = ifaces[0] || { name: null, ip: null, prefix: null };
  const target = opts.target || '1.1.1.1';
  const gateway = await detectGateway(local.prefix);
  const out = {
    ok: false, ts: new Date().toISOString(), iface: local.name, local_ip: local.ip,
    subnet: local.prefix ? local.prefix + '.0/24' : null,
    gateway: gateway ? gateway.ip : null, target, endpoint: 'speed.cloudflare.com',
    ping_gateway: null, ping: null, down: null, up: null,
    grade: null, duration_ms: 0, note: null,
  };
  const pings = Math.min(20, Math.max(3, Number(opts.pings) || 10));
  const metaP = ispInfo();   // ambil identitas ISP paralel dengan proses ping (tidak menambah durasi)
  if (gateway && gateway.ip) out.ping_gateway = await pingStats(gateway.ip, pings);
  out.ping = await pingStats(target, pings);
  Object.assign(out, await metaP);   // isp, asn, public_ip, geo
  out.ping_raw = out.ping.raw || null;   // deretan sampel untuk grafik jitter (tidak masuk kolom DB)
  delete out.ping.raw;
  if (out.ping.ok) {
    const bytesDown = Math.min(25e6, Math.max(250e3, Number(opts.bytesDown) || 5e6));
    const bytesUp = Math.min(10e6, Math.max(100e3, Number(opts.bytesUp) || 1e6));
    out.down = await downTest(`https://speed.cloudflare.com/__down?bytes=${bytesDown}`);
    if (!out.down.ok) {
      // fallback: file statis Google bila endpoint cloudflare diblokir
      out.down = await downTest('https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png');
      out.endpoint = 'google (fallback)';
    }
    out.up = out.down.ok ? await upTest('https://speed.cloudflare.com/__up', bytesUp) : { ok: false, error: 'unduh gagal, unggah dilewati' };
    out.ok = true;
    out.grade = gradeOf(out.ping.avg, out.ping.jitter, out.down.mbps);
  } else {
    out.note = `Ping ke ${target} gagal — periksa koneksi internet (gateway ${gateway ? gateway.ip : 'tidak terdeteksi'}).`;
  }
  out.duration_ms = Date.now() - t0;
  try {
    db.prepare(`INSERT INTO speedtests(iface,local_ip,subnet,target,endpoint,ping_min,ping_avg,ping_max,jitter,loss,down_mbps,up_mbps,grade,duration_ms,isp,asn,public_ip,geo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      out.iface, out.local_ip, out.subnet, target, out.endpoint,
      out.ping.min ?? null, out.ping.avg ?? null, out.ping.max ?? null, out.ping.jitter ?? null, out.ping.loss ?? null,
      out.down ? out.down.mbps ?? null : null, out.up ? out.up.mbps ?? null : null, out.grade, out.duration_ms,
      out.isp, out.asn, out.public_ip, out.geo,
    );
    out.id = Number(db.prepare('SELECT last_insert_rowid() id').get().id);
    try { db.prepare('INSERT INTO speedtest_samples(speedtest_id,ping_raw) VALUES (?,?)').run(out.id, JSON.stringify(out.ping_raw || [])); } catch {}
    db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('speedtest','speedtest','info',?)")
      .run(`Speedtest ${out.iface || ''} ${out.local_ip || ''}${out.isp ? ' • ' + out.isp + (out.asn ? ' (' + out.asn + ')' : '') : ''}: ping ${out.ping.avg ?? '-'} ms, jitter ${out.ping.jitter ?? '-'} ms` +
        (out.down ? `, down ${out.down.mbps} Mbps, up ${out.up ? out.up.mbps : '-'} Mbps (grade ${out.grade})` : ' (gagal)'));
  } catch {}
  return out;
}

function latestSpeedtest() {
  ensureTable();
  const last = db.prepare('SELECT * FROM speedtests ORDER BY id DESC LIMIT 1').get() || null;
  const history = db.prepare('SELECT id,ts,iface,local_ip,isp,public_ip,target,ping_avg,jitter,down_mbps,up_mbps,grade FROM speedtests ORDER BY id DESC LIMIT 10').all();
  try {
    if (last) {
      const raw = db.prepare('SELECT ping_raw FROM speedtest_samples WHERE speedtest_id=?').get(last.id);
      last.ping_raw = raw && raw.ping_raw ? JSON.parse(raw.ping_raw) : null;
    }
  } catch { if (last) last.ping_raw = null; }
  return { last, history };
}

module.exports = { runSpeedtest, pingStats, downTest, upTest, detectGateway, latestSpeedtest, gradeOf, median, ispInfo };

