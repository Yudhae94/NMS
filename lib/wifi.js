'use strict';
/**
 * Discovery kanal WiFi 2.4 GHz & 5 GHz (dan 6 GHz bila ada).
 *
 * Cara kerja:
 *  1) `scanWifi()` memanggil tool bawaan OS tanpa dependency eksternal:
 *     - Windows : `netsh wlan show networks mode=bssid` + `netsh wlan show interfaces`
 *     - Linux   : `nmcli -t -f ... dev wifi list --rescan yes`
 *     - macOS   : `airport -s` + `airport -I`
 *  2) hasil teks di-parse menjadi daftar AP: { ssid, bssid, band, channel, freq_mhz, signal, rssi, ... }
 *  3) `analyze()` menghitung okupansi per kanal, interferensi (kanal bertumpang tindih),
 *     peta DFS/UNII, dan kanal terbaik yang direkomendasikan untuk tiap band.
 *  4) `saveScan()` menyimpan snapshot ke tabel `wifi_scans` + `wifi_networks`.
 *
 * Parser dipisah sebagai fungsi murni (exported) supaya bisa diuji tanpa hardware WiFi.
 */
const path = require('node:path');
const { run, SYS32 } = require('./net-scan');
const { vendorOf } = require('./identify');
const { db } = require('./db');

// ---- rencana kanal (channel plan) -------------------------------------------
const CH_24 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const CH_5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165, 169, 173, 177];
const CH_6 = [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69, 73, 77, 81, 85, 89, 93, 97, 101, 105, 109, 113, 117, 121, 125, 129, 133, 137, 141, 145, 149, 153, 157, 161, 165, 169, 173, 177, 181, 185, 189, 193, 197, 201, 205, 209, 213, 217, 221, 225, 229, 233]
  .map((v) => (v - 1) * 4 + 1);

/** Frekuensi tengah (MHz) sebuah kanal. */
function freqFrom(channel, band) {
  const ch = Number(channel);
  if (!ch) return null;
  if (band === '2.4') return ch === 14 ? 2484 : 2407 + ch * 5;
  if (band === '6') return 5950 + ch * 5;
  return 5000 + ch * 5;
}

/** Tentukan band dari channel/freq/teks 'Band : 5 GHz'. */
function bandFrom({ channel, freq, bandText, radio } = {}) {
  const t = String(bandText || '').toLowerCase();
  if (t.includes('6')) return '6';
  if (t.includes('5')) return '5';
  if (t.includes('2.4') || t.includes('2,4')) return '2.4';
  const ch = Number(channel);
  if (ch >= 1 && ch <= 14) return '2.4';
  const f = Number(freq);
  if (f) { if (f < 2500) return '2.4'; if (f >= 5925) return '6'; return '5'; }
  if (ch >= 32) return '5';
  if (/ax|ac|n/.test(String(radio || '')) && ch === 0) return '2.4';
  return bandFromFreq(freq);
}
function bandFromFreq(freq) {
  const f = Number(freq);
  if (!f) return null;
  if (f < 2500) return '2.4';
  if (f >= 5925 && f <= 7125) return '6';
  if (f >= 5150 && f < 5925) return '5';
  return null;
}

/** Frekuensi dari teks "5745 MHz" / "5745". */
function freqOfText(txt) {
  const m = String(txt || '').match(/(\d{4,5})/);
  return m ? Number(m[1]) : null;
}

/** Rentang DFS (radar) — 5 GHz UNII-2A & UNII-2C. */
function isDfs(channel, band) {
  if (band !== '5') return false;
  const ch = Number(channel);
  return (ch >= 52 && ch <= 64) || (ch >= 100 && ch <= 144);
}
/** Label UNII/ISM untuk ditampilkan di UI. */
function uniiLabel(channel, band) {
  const ch = Number(channel);
  if (band === '2.4') return ch === 14 ? 'ISM (JP)' : 'ISM 2.4 GHz';
  if (band === '6') return 'UNII-5/6/7/8 (6 GHz)';
  if (ch >= 36 && ch <= 48) return 'UNII-1';
  if (ch >= 52 && ch <= 64) return 'UNII-2A (DFS)';
  if (ch >= 100 && ch <= 144) return 'UNII-2C (DFS)';
  if (ch >= 149 && ch <= 165) return 'UNII-3';
  return 'UNII-4';
}
/** Lebar kanal: netsh/nmcli tidak selalu melaporkan, jadi diestimasi dari tipe radio. */
function widthFromRadio(radio, band) {
  const r = String(radio || '').toLowerCase();
  if (band === '6') return 160;
  if (band === '2.4') return 20;
  if (/be/.test(r)) return 160;
  if (/ax|ac/.test(r)) return 80;
  if (/n/.test(r)) return 40;
  return 20;
}
/** Perkiraan RSSI (dBm) dari persentase sinyal Windows: dBm ≈ signal/2 − 100. */
function rssiFromSignal(signal) {
  const s = Number(signal);
  if (!s && s !== 0) return null;
  return Math.round(s / 2 - 100);
}
/** Kekuatan sinyal 0..4 untuk indikator bar di UI. */
function signalBars(pct) {
  const s = Number(pct) || 0;
  if (s >= 80) return 4;
  if (s >= 60) return 3;
  if (s >= 40) return 2;
  if (s >= 20) return 1;
  return 0;
}


// ---- normalisasi satu AP -----------------------------------------------------
function normalizeAp(raw) {
  const band = bandFrom({ channel: raw.channel, freq: raw.freq_mhz, bandText: raw.band_text, radio: raw.radio_type });
  const channel = Number(raw.channel) || null;
  const freq_mhz = Number(raw.freq_mhz) || freqFrom(channel, band);
  const sigNum = raw.signal === null || raw.signal === undefined || raw.signal === '' ? NaN : Number(raw.signal);
  const signal = Number.isFinite(sigNum) ? Math.max(0, Math.min(100, Math.round(sigNum))) : null;
  const rssiNum = raw.rssi === null || raw.rssi === undefined || raw.rssi === '' ? NaN : Number(raw.rssi);
  const [vendor] = vendorOf(raw.bssid);
  return {
    ssid: raw.ssid || '(hidden)',
    bssid: raw.bssid ? String(raw.bssid).toUpperCase() : null,
    band, channel, freq_mhz,
    width_mhz: Number(raw.width_mhz) || widthFromRadio(raw.radio_type, band),
    width_estimated: !Number(raw.width_mhz),
    radio_type: raw.radio_type || null,
    security: raw.security || 'open',
    vendor: raw.vendor || vendor || 'unknown',
    signal,
    rssi: Number.isFinite(rssiNum) ? Math.round(rssiNum) : rssiFromSignal(signal),
    bars: signalBars(signal),
    active: !!raw.active,
    dfs: isDfs(channel, band),
    unii: uniiLabel(channel, band),
    max_rate: raw.max_rate || null,
  };
}

// ---- parser Windows: netsh wlan show networks mode=bssid ---------------------
function parseNetshNetworks(text) {
  const out = [];
  let ssid = null; let meta = {}; let cur = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || /^Interface name\s*:/i.test(line) || /networks? currently visible/i.test(line)) continue;
    let m = line.match(/^\s*SSID\s+\d+\s*:\s*(.*)$/);
    if (m) { ssid = m[1].trim() || '(hidden)'; meta = {}; cur = null; continue; }
    m = line.match(/^\s*BSSID\s+\d+\s*:\s*([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/);
    if (m) {
      cur = { ssid, bssid: m[1], security: meta.authentication || null, encryption: meta.encryption || null };
      out.push(cur);
      continue;
    }
    m = line.match(/^\s*([A-Za-z][A-Za-z0-9 ()./-]*?)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase(); const val = m[2].trim();
    if (key === 'authentication' || key === 'encryption') { if (cur) cur[key] = val; else meta[key] = val; continue; }
    if (!cur) continue;
    if (key === 'signal') cur.signal = Number(val.replace('%', '')) || 0;
    else if (key === 'radio type') cur.radio_type = val;
    else if (key === 'band') cur.band_text = val;
    else if (key === 'channel') cur.channel = Number(val) || null;
  }
  return out.filter((a) => a.bssid).map(normalizeAp);
}

// ---- parser Windows: netsh wlan show interfaces ------------------------------
function parseNetshInterfaces(text) {
  const info = {}; let target = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const m = rawLine.match(/^\s*([A-Za-z][A-Za-z0-9 ()./-]*?)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase(); const val = m[2].trim();
    if (key === 'name') { if (info.name) break; info.name = val; target = info; continue; }  // interface pertama saja
    if (!target) continue;
    if (key === 'description') target.description = val;
    else if (key === 'state') target.state = val;
    else if (key === 'ssid') target.ssid = val;
    else if (key === 'ap bssid') target.bssid = val.toUpperCase();
    else if (key === 'band') target.band_text = val;
    else if (key === 'channel') target.channel = Number(val) || null;
    else if (key === 'radio type') target.radio_type = val;
    else if (key === 'authentication') target.security = val;
    else if (key === 'signal') target.signal = Number(val.replace('%', '')) || 0;
    else if (key === 'rssi') target.rssi = Number(val);
    else if (key === 'receive rate (mbps)') target.rx_mbps = Number(val);
    else if (key === 'transmit rate (mbps)') target.tx_mbps = Number(val);
  }
  if (!info.name) return null;
  const ap = normalizeAp(info);
  ap.state = info.state || null;
  ap.rx_mbps = info.rx_mbps ?? null;
  ap.tx_mbps = info.tx_mbps ?? null;
  ap.adapter = info.name;
  ap.description = info.description || null;
  return ap;
}

// ---- parser Linux: nmcli (pemisah ':' dengan escape '\:') --------------------
function splitNmcli(line) {
  const out = []; let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { cur += line[i + 1] || ''; i++; continue; }
    if (c === ':') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
function parseNmcliList(text, fields) {
  const cols = (fields || 'SSID,BSSID,CHAN,FREQ,SIGNAL,SECURITY,ACTIVE').split(',').map((f) => f.trim().toUpperCase());
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = splitNmcli(line);
    const rec = {};
    cols.forEach((c, i) => { rec[c] = (parts[i] || '').trim(); });
    if (!rec.BSSID) continue;
    out.push(normalizeAp({
      ssid: rec.SSID || '(hidden)', bssid: rec.BSSID,
      channel: Number(rec.CHAN) || null,
      freq_mhz: freqOfText(rec.FREQ),
      signal: Number(rec.SIGNAL) || null,
      security: rec.SECURITY || 'open',
      radio_type: rec['RADIO-TYPE'] || rec.RATE || null,
      active: String(rec.ACTIVE || '').toLowerCase().startsWith('yes'),
    }));
  }
  return out;
}

// ---- parser macOS: airport -s (daftar AP) & airport -I (koneksi aktif) -------
function parseAirportScan(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const m = line.match(/^(.*?)\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s+(-?\d+)\s+(\d+)(?:,[+-\d]+)?\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const rssi = Number(m[3]);
    out.push(normalizeAp({
      ssid: m[1].trim() || '(hidden)', bssid: m[2], channel: Number(m[4]) || null,
      rssi, signal: Math.max(0, Math.min(100, 2 * (rssi + 100))),
      security: (m[7] || '').trim().split(/\s+/)[0] || 'open',
    }));
  }
  return out;
}
function parseAirportInfo(text) {
  const info = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/);
    if (m) info[m[1].trim().toLowerCase().replace(/\s+/g, '')] = m[2].trim();
  }
  if (!info.ssid && !info.bssid) return null;
  const ap = normalizeAp({
    ssid: info.ssid || '(hidden)', bssid: info.bssid, channel: Number(info.channel) || null,
    rssi: Number(info.agrctrlrssi || info.rssi) || null, signal: null,
    security: info.lasttxrate ? 'connected' : null, radio_type: info.phymode || null,
  });
  ap.state = info.state || null;
  ap.adapter = info.interface || null;
  return ap;
}

// ---- pemindai utama (per OS) -------------------------------------------------
function sysPath(exe) { return path.join(SYS32, exe); }

/** Jalankan pemindaian WiFi sesuai OS. Selalu resolve (tidak melempar error). */
async function scanWifi(opts = {}) {
  const started = Date.now();
  const res = {
    ok: false, platform: process.platform, source: null, adapter: null,
    scanned_at: new Date().toISOString(), duration_ms: 0, rounds: 1, deep: !!opts.deep,
    connected: null, networks: [], reason: null,
  };
  try {
    if (process.platform === 'win32') {
      res.source = 'netsh';
      const listTxt = await run(sysPath('netsh.exe'), ['wlan', 'show', 'networks', 'mode=bssid'], opts.timeout || 20000);
      const ifTxt = await run(sysPath('netsh.exe'), ['wlan', 'show', 'interfaces'], opts.timeout || 10000);
      res.connected = parseNetshInterfaces(ifTxt);
      res.adapter = res.connected ? res.connected.adapter : null;
      const rounds = opts.deep ? Math.min(10, Math.max(2, Number(opts.rounds) || 5)) : 3;
      const gapMs = opts.deep ? (opts.gapMs || 8000) : 1500;
      let all = []; let listTxtOk = '';
      for (let r = 0; r < rounds; r++) {
        if (r > 0) await new Promise((s) => setTimeout(s, gapMs));
        const txt = await run(sysPath('netsh.exe'), ['wlan', 'show', 'networks', 'mode=bssid'], opts.timeout || 20000);
        if (txt && !listTxtOk) listTxtOk = txt;
        all = mergeAps(all, parseNetshNetworks(txt));
        if (!opts.deep && all.length > 2) break;              // scan cepat: cukup bila tetangga langsung terlihat
      }
      res.networks = all;
      res.rounds = rounds;
      if (!res.networks.length && res.connected && res.connected.bssid) {
        // Windows menahan hasil scan aktif saat idle: pakai info koneksi agar peta kanal tidak kosong
        res.networks = [{ ...res.connected, active: true }];
        res.reason = res.reason || 'Tetangga WiFi tidak masuk cache scan saat ini — yang tampil hanya AP terhubung. Coba “Scan Mendalam”.';
      }
      if (!listTxtOk) res.reason = 'netsh tidak tersedia atau adapter WiFi dimatikan';
    } else if (process.platform === 'darwin') {
      res.source = 'airport';
      const bin = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
      const listTxt = await run(bin, ['-s'], opts.timeout || 20000);
      const infoTxt = await run(bin, ['-I'], opts.timeout || 8000);
      res.connected = parseAirportInfo(infoTxt);
      res.adapter = res.connected ? res.connected.adapter : 'en0';
      res.networks = parseAirportScan(listTxt);
      if (!listTxt) res.reason = 'airport tidak tersedia';
    } else {
      res.source = 'nmcli';
      const fields = 'SSID,BSSID,CHAN,FREQ,SIGNAL,SECURITY,ACTIVE';
      const listTxt = await run('nmcli', ['-t', '-f', fields, 'dev', 'wifi', 'list', '--rescan', 'yes'], opts.timeout || 25000);
      res.networks = parseNmcliList(listTxt, fields);
      const cur = res.networks.find((n) => n.active) || null;
      res.connected = cur;
      res.adapter = (await run('nmcli', ['-t', '-f', 'DEVICE,TYPE', 'dev', 'status'], 6000))
        .split(/\r?\n/).filter((l) => l.includes(':wifi:')).map((l) => l.split(':')[0])[0] || null;
      if (!listTxt) res.reason = 'nmcli tidak tersedia (butuh NetworkManager)';
    }
  } catch (e) {
    res.reason = e.message;
  }
  if (res.connected && res.connected.bssid) {
    res.connected.active = true;                                    // tandai AP yang sedang dipakai
    const hit = res.networks.find((n) => n.bssid === res.connected.bssid);
    if (hit) { hit.active = true; if (hit.signal === null) hit.signal = res.connected.signal; }
  }
  if (!res.networks.length && !res.reason) {
    res.reason = res.connected && res.connected.state && !/connected/i.test(res.connected.state)
      ? 'Adapter WiFi tidak terhubung ke jaringan'
      : 'Tidak ada AP yang terdeteksi (izin lokasi/WiFi nonaktif?)';
  }
  res.ok = res.networks.length > 0;
  res.counts = countByBand(res.networks);
  res.duration_ms = Date.now() - started;
  return res;
}

/** Gabungkan dua hasil scan (union by BSSID, ambil sinyal terkuat). */
function mergeAps(a, b) {
  const map = new Map();
  for (const ap of [...(a || []), ...(b || [])]) {
    if (!ap || !ap.bssid) continue;
    const ex = map.get(ap.bssid);
    if (!ex || (ap.signal || 0) > (ex.signal || 0)) map.set(ap.bssid, ap);
  }
  return [...map.values()];
}
/** Kelompokkan AP per SSID (nama WiFi yang terlihat, terhubung atau belum). */
function groupBySsid(nets) {
  const map = new Map();
  for (const n of nets || []) {
    if (!n) continue;
    const key = String(n.ssid || '(hidden)');
    if (!map.has(key)) map.set(key, { ssid: key, bands: new Set(), channels: [], strongest: 0, count: 0, secured: true, connected: false });
    const g = map.get(key);
    g.count++;
    if (n.band) g.bands.add(String(n.band));
    if (n.channel && !g.channels.includes(n.channel)) g.channels.push(n.channel);
    g.strongest = Math.max(g.strongest, Number(n.signal) || 0);
    if (String(n.security || '').toLowerCase() === 'open') g.secured = false;
    if (n.active) g.connected = true;
  }
  return [...map.values()]
    .map((g) => ({ ssid: g.ssid, count: g.count, bands: [...g.bands].sort().join(' + ') || '-', channels: g.channels.sort((a, b) => a - b).join(', ') || '-', strongest: g.strongest, bars: signalBars(g.strongest), secured: g.secured, connected: g.connected }))
    .sort((a, b) => (b.connected - a.connected) || (b.strongest - a.strongest));
}
function countByBand(nets) {
  const c = { total: nets.length, b24: 0, b5: 0, b6: 0, hidden: 0 };
  for (const n of nets) {
    if (n.band === '2.4') c.b24++;
    else if (n.band === '5') c.b5++;
    else if (n.band === '6') c.b6++;
    if (n.ssid === '(hidden)') c.hidden++;
  }
  return c;
}


// ---- analisis kanal: okupansi, interferensi, rekomendasi ---------------------
function channelStatus(n) {
  if (!n) return 'kosong';
  if (n === 1) return 'bersih';
  if (n <= 3) return 'sedang';
  return 'padat';
}
function overlapWeight(diff, width) {
  const span = Math.max(1, (Number(width) || 20) / 5);   // 20 MHz = 4 unit kanal (tiap unit 5 MHz)
  return Math.max(0, 1 - Math.abs(diff) / span);
}
/** Skor interferensi sebuah kanal: sum(overlap x kekuatan sinyal AP). */
function interferenceAt(ch, aps, band) {
  return +aps.reduce((sum, a) => {
    const d = ch - a.channel;
    const w = band === '2.4' ? Math.max(0, 1 - Math.abs(d) / 5) : overlapWeight(d, a.width_mhz);
    return sum + w * ((a.signal || 0) / 100);
  }, 0).toFixed(2);
}
/** Kanal terbaik: interferensi terkecil, bebas DFS, utamakan 1/6/11 non-overlapping. */
function recommendChannel(channels, band) {
  const pool = channels.filter((c) => c.channel >= 1);
  if (!pool.length) return null;
  const penalty = (c) => (c.dfs ? 0.35 : 0) + (band === '2.4' && ![1, 6, 11].includes(c.channel) ? 0.12 : 0) + (band === '2.4' && c.channel >= 12 ? 0.2 : 0);
  const score = (c) => c.interference + penalty(c);
  let best = pool[0];
  for (const c of pool) {
    const d = score(c) - score(best);
    if (d < -0.02) { best = c; continue; }
    if (Math.abs(d) <= 0.02) {                                  // seri: 2.4 GHz mendekati kanal 6, 5 GHz kanal terkecil
      const tie = band === '2.4' ? Math.abs(c.channel - 6) < Math.abs(best.channel - 6) : c.channel < best.channel;
      if (tie) best = c;
    }
  }
  return {
    channel: best.channel, freq_mhz: best.freq_mhz, score: +score(best).toFixed(2),
    interference: best.interference, ap_count: best.count, dfs: best.dfs, unii: best.unii,
    non_overlapping: band === '2.4' ? [1, 6, 11].includes(best.channel) : !best.dfs,
    reason: (best.count ? best.count + ' AP di kanal ini' : 'kanal kosong') +
      ' • interferensi ' + best.interference +
      (band === '2.4'
        ? ([1, 6, 11].includes(best.channel) ? ' • non-overlapping (1/6/11)' : ' • bertumpang tindih dengan 1/6/11')
        : (best.dfs ? ' • DFS (radar/indoor)' : ' • non-DFS (aman untuk AP apa pun)')),
  };
}

/** Analisis satu band: daftar kanal + okupansi + rekomendasi. */
function analyzeBand(nets, band) {
  const aps = nets.filter((n) => n.band === band && n.channel);
  const plan = band === '2.4' ? CH_24 : band === '6' ? CH_6 : CH_5;
  const extra = [...new Set(aps.map((a) => a.channel))].filter((c) => !plan.includes(c));
  const channels = [...plan, ...extra].sort((a, b) => a - b).map((ch) => {
    const here = aps.filter((a) => a.channel === ch);
    const strongest = here.reduce((m, a) => Math.max(m, a.signal || 0), 0);
    return {
      channel: ch, freq_mhz: freqFrom(ch, band), dfs: isDfs(ch, band), unii: uniiLabel(ch, band),
      count: here.length, strongest, interference: interferenceAt(ch, aps, band),
      status: channelStatus(here.length), recommended: false,
      aps: here.map((a) => ({ ssid: a.ssid, bssid: a.bssid, signal: a.signal, rssi: a.rssi, vendor: a.vendor, radio_type: a.radio_type, width_mhz: a.width_mhz, security: a.security, active: !!a.active })),
    };
  });
  const recommend = recommendChannel(channels, band);
  for (const c of channels) c.recommended = !!recommend && c.channel === recommend.channel && c.status !== 'padat';
  const nr = aps.length;
  return {
    band, label: band === '2.4' ? '2.4 GHz' : band === '5' ? '5 GHz' : '6 GHz',
    aps: nr, ssids: [...new Set(aps.map((a) => a.ssid))].length,
    dfs_aps: aps.filter((a) => a.dfs).length,
    congestion: nr === 0 ? 'kosong' : nr <= 2 ? 'rendah' : nr <= 5 ? 'sedang' : 'padat',
    recommend, channels,
  };
}
/** Analisis penuh semua band (2.4 & 5 selalu ada supaya UI tetap utuh walau kosong). */
function analyze(nets, connected) {
  const list = Array.isArray(nets) ? nets : [];
  const bands = { '2.4': analyzeBand(list, '2.4'), 5: analyzeBand(list, '5') };
  if (list.some((n) => n.band === '6')) bands['6'] = analyzeBand(list, '6');
  return { bands, counts: countByBand(list), ssids: groupBySsid(list), connected: connected || null };
}

// ---- simpan & baca ulang snapshot hasil scan --------------------------------
const STALE_COL = 'stale';
function ensureStaleColumn() {
  try {
    const has = db.prepare('PRAGMA table_info(wifi_networks)').all().some((c) => c.name === STALE_COL);
    if (!has) db.exec('ALTER TABLE wifi_networks ADD COLUMN ' + STALE_COL + ' INTEGER DEFAULT 0');
  } catch {}
}
ensureStaleColumn();
/**
 * Tandai AP lama yang tidak muncul di scan baru ini sebagai basi (stale=1),
 * tapi JANGAN hapus — cache Windows sering menyembunyikan tetangga sehingga
 * ketidakhadiran sesaat belum tentu AP hilang.
 * Scan mendalam (deep) tidak menandai basi agar peta tetap lengkap.
 */
function markStale(scanId, seenBssids) {
  ensureStaleColumn();
  try {
    const prev = db.prepare('SELECT MAX(id) m FROM wifi_scans WHERE id<?').get(scanId).m;
    if (!prev) return;
    const prevSeen = db.prepare('SELECT DISTINCT bssid FROM wifi_networks WHERE last_scan_id=?').all(prev).map((r) => r.bssid);
    if (!prevSeen.length) return;
    const cur = new Set(seenBssids);
    const gone = prevSeen.filter((b) => !cur.has(b));
    const mark = db.prepare('UPDATE wifi_networks SET stale=1 WHERE bssid=?');
    for (const b of gone) mark.run(b);
  } catch {}
}
function saveScan(scan) {
  const counts = scan.counts || countByBand(scan.networks || []);
  const nets = scan.networks || [];
  const info = { reason: scan.reason || null, connected: scan.connected || null };
  const r = db.prepare('INSERT INTO wifi_scans(platform,adapter,source,total,n24,n5,detail) VALUES (?,?,?,?,?,?,?)')
    .run(scan.platform || process.platform, scan.adapter || null, scan.source || null, counts.total, counts.b24, counts.b5, JSON.stringify(info));
  const scanId = Number(r.lastInsertRowid);
  if (!scan.deep) markStale(scanId, nets.map((n) => n.bssid).filter(Boolean));
  const best24 = scan.bands && scan.bands['2.4'] && scan.bands['2.4'].recommend ? scan.bands['2.4'].recommend.channel : null;
  const up = db.prepare(`INSERT INTO wifi_networks(bssid,ssid,band,channel,freq_mhz,width_mhz,radio_type,security,vendor,signal,rssi,best_channel_24,seen_count,last_seen,last_scan_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'),?)
    ON CONFLICT(bssid) DO UPDATE SET ssid=excluded.ssid, band=excluded.band, channel=excluded.channel, freq_mhz=excluded.freq_mhz,
      width_mhz=excluded.width_mhz, radio_type=excluded.radio_type, security=excluded.security, vendor=excluded.vendor,
      signal=excluded.signal, rssi=excluded.rssi, best_channel_24=excluded.best_channel_24,
      seen_count=wifi_networks.seen_count+1, last_seen=datetime('now'), last_scan_id=excluded.last_scan_id`);
  for (const n of scan.networks || []) {
    if (!n.bssid) continue;
    up.run(n.bssid, n.ssid, n.band, n.channel, n.freq_mhz, n.width_mhz, n.radio_type, n.security, n.vendor, n.signal, n.rssi, best24, scanId);
  }
  const b24 = scan.bands && scan.bands['2.4'].recommend, b5 = scan.bands && scan.bands['5'].recommend;
  db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('wifi','discovery','info',?)")
    .run(`Scan kanal WiFi: ${counts.total} AP (2.4GHz ${counts.b24}, 5GHz ${counts.b5})` +
      (b24 ? ` • rekomendasi 2.4GHz kanal ${b24.channel}` : '') + (b5 ? `, 5GHz kanal ${b5.channel}` : ''));
  return scanId;
}

function rowToAp(r) {
  ensureStaleColumn();
  return {
    ssid: r.ssid, bssid: r.bssid, band: r.band, channel: r.channel, freq_mhz: r.freq_mhz,
    width_mhz: r.width_mhz, width_estimated: true, radio_type: r.radio_type, security: r.security,
    vendor: r.vendor, signal: r.signal, rssi: r.rssi, bars: signalBars(r.signal), active: false,
    dfs: isDfs(r.channel, r.band), unii: uniiLabel(r.channel, r.band), stale: r.stale ? 1 : 0,
    seen_count: r.seen_count, first_seen: r.first_seen, last_seen: r.last_seen,
  };
}

/** Snapshot terakhir dari database (tanpa memanggil tool OS). */
function latestAnalysis() {
  const scan = db.prepare('SELECT * FROM wifi_scans ORDER BY id DESC LIMIT 1').get();
  const history = db.prepare('SELECT id,ts,platform,adapter,source,total,n24,n5 FROM wifi_scans ORDER BY id DESC LIMIT 10').all();
  if (!scan) {
    return {
      ...analyze([], null), ok: false, empty: true, scanned_at: null, platform: process.platform,
      source: null, adapter: null, networks: [], history,
      reason: 'Belum ada scan tersimpan. Klik "Scan Kanal WiFi" untuk memindai kanal 2.4 & 5 GHz.',
    };
  }
  let info = {};
  try { info = JSON.parse(scan.detail || '{}'); } catch { info = {}; }
  ensureStaleColumn();
  const fresh = db.prepare('SELECT * FROM wifi_networks WHERE last_scan_id=? ORDER BY band, channel, signal DESC').all(scan.id).map(rowToAp);
  // AP basi (pernah terlihat, tidak muncul di scan terakhir): tetap tampil agar peta lengkap
  let staleNets = [];
  try {
    staleNets = db.prepare(`SELECT * FROM wifi_networks WHERE last_scan_id<>? OR stale=1 ORDER BY band, channel, signal DESC LIMIT 200`)
      .all(scan.id).filter((r) => !fresh.some((f) => f.bssid === r.bssid)).map(rowToAp);
  } catch { staleNets = []; }
  const networks = fresh.concat(staleNets);
  const connected = info.connected || null;
  if (connected && connected.bssid) for (const n of networks) if (n.bssid === connected.bssid) n.active = true;
  return {
    ...analyze(networks, connected), ok: networks.length > 0, empty: false, scanned_at: scan.ts,
    platform: scan.platform || process.platform, source: scan.source, adapter: scan.adapter,
    reason: info.reason || null, networks, history,
  };
}

module.exports = {
  // rencana kanal & util
  CH_24, CH_5, CH_6, freqFrom, bandFrom, bandFromFreq, isDfs, uniiLabel, widthFromRadio, rssiFromSignal, signalBars,
  // parser (murni, bisa diuji tanpa hardware)
  normalizeAp, parseNetshNetworks, parseNetshInterfaces, parseNmcliList, splitNmcli, parseAirportScan, parseAirportInfo,
  // pemindaian & analisis
  scanWifi, countByBand, groupBySsid, mergeAps, analyze, analyzeBand, recommendChannel, interferenceAt, channelStatus,
  // persistensi
  saveScan, latestAnalysis,
};

