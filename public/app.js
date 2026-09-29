'use strict';
let T = localStorage.getItem('nms_tok') || '';
let U = JSON.parse(localStorage.getItem('nms_user') || 'null');
let CUR = 'dash';
const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(p, o = {}) {
  const r = await fetch(p, { ...o, headers: { 'Content-Type': 'application/json', Authorization: T ? 'Bearer ' + T : '' } });
  if (r.status === 401) { logout(); throw new Error('Unauthorized'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
}
function logout() { stopLive(); T = ''; U = null; CUR = 'dash'; localStorage.clear(); render(); }
function toast(msg, ok = true) {
  let w = document.querySelector('.toast');
  if (!w) { w = document.createElement('div'); w.className = 'toast'; document.body.appendChild(w); }
  const d = document.createElement('div');
  d.style.borderLeftColor = ok ? '#22c55e' : '#ef4444';
  d.textContent = msg;
  w.appendChild(d);
  setTimeout(() => d.remove(), 3200);
}
function pill(v, map) {
  const k = String(v).toLowerCase();
  const cls = (map && map[k]) || (k === 'up' || k === 'open' ? 'up' : k === 'down' || k === 'critical' ? 'down' : k === 'warning' || k === 'acknowledged' || k === 'degraded' ? 'warn' : 'info');
  return '<span class="pill ' + cls + '">' + esc(v) + '</span>';
}
function lineChart(cv, series) {
  const c = cv.getContext('2d');
  const W = cv.width = cv.clientWidth || 640, H = cv.height = 240;
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#93a1c4'; c.font = '11px Segoe UI';
  const all = series.flatMap((s) => s.data); const mx = Math.max(10, ...all);
  const X = (i, n) => 34 + (i / Math.max(1, n - 1)) * (W - 46);
  const Y = (v) => H - 26 - (v / mx) * (H - 46);
  c.strokeStyle = '#2b3a66'; c.lineWidth = 1;
  for (let g = 0; g <= 4; g++) { const y = 10 + (g / 4) * (H - 36); c.beginPath(); c.moveTo(34, y); c.lineTo(W - 12, y); c.stroke(); c.fillText(Math.round(mx * (1 - g / 4)), 4, y + 3); }
  const cols = ['#38bdf8', '#f472b6', '#a3e635'];
  series.forEach((s, k) => {
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, cols[k % 3] + '55'); grad.addColorStop(1, cols[k % 3] + '00');
    c.beginPath();
    s.data.forEach((v, i) => (i ? c.lineTo(X(i, s.data.length), Y(v)) : c.moveTo(X(i, s.data.length), Y(v))));
    c.strokeStyle = cols[k % 3]; c.lineWidth = 2; c.stroke();
    c.lineTo(X(s.data.length - 1, s.data.length), H - 26); c.lineTo(X(0, s.data.length), H - 26); c.closePath();
    c.fillStyle = grad; c.fill();
    c.fillStyle = cols[k % 3]; c.fillRect(40 + k * 110, 12, 22, 3); c.fillText(s.name, 66 + k * 110, 18);
  });
}
function shell(inner, active) {
  const isA = U.role === 'admin' || U.role === 'superadmin', isO = U.role === 'operator' || isA;
  const btn = (id, label) => '<button data-v="' + id + '" class="' + (active === id ? 'on' : '') + '" onclick="go(\'' + id + '\')">' + label + '</button>';
  let nav = btn('dash', '&#128202; Dashboard') + btn('live', '&#128994; Live Traffic') + btn('dev', '&#128752; Devices') + btn('topo', '&#127760; Topologi') + btn('wifi', '&#128246; Kanal WiFi') + btn('alerts', '&#128276; Alerts') + btn('events', '&#128221; Events') + btn('flow', '&#8646; Flows') + btn('rep', '&#128203; Laporan') + btn('sla', '&#9989; SLA');
  if (isA) nav += btn('users', '&#128100; Users') + btn('chan', '&#128225; Channels');
  if (isO) nav += btn('disc', '&#128269; Discovery');
  return '<header class="topbar"><div class="brand"><span class="logo">N</span><span>NMS <span style="color:var(--mut);font-weight:400">Monitoring</span></span></div>'
    + '<div class="userchip"><span class="dot"></span><b>' + esc(U.username) + '</b><span class="role">' + esc(U.role) + '</span></div>'
    + '<nav class="menu">' + nav + '<button class="danger" onclick="logout()">&#9166; Keluar</button></nav></header><main><div id="c">' + inner + '</div></main>';
}
function render() {
  if (!T || !U) {
    app.innerHTML = '<div id="loginWrap"><div id="login"><div class="l-logo">&#128752;</div><h3>Network Monitoring</h3><p class="mut">Masuk untuk memantau jaringan Anda</p><input id="u" value="superadmin" autocomplete="username"><input id="pw" type="password" value="superadmin123" autocomplete="current-password"><button class="btn" onclick="doLogin()">Masuk Dashboard</button><p class="mut">superadmin/superadmin123 &bull; admin/admin123 &bull; operator/operator123 &bull; viewer/viewer123</p><p id="le" style="color:#f87171"></p></div></div>';
    const go2 = () => doLogin();
    document.getElementById('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go2(); });
    return;
  }
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat...</div>', CUR);
  go(CUR);
}
function go(v) { stopLive(); CUR = v; ({ dash: vDash, live: vLive, dev: vDev, topo: vTopo, wifi: vWifi, alerts: vAlerts, events: vEvents, flow: vFlow, rep: vRep, sla: vSla, users: vUsers, chan: vChan, disc: vDisc }[v] || vDash)().catch((e) => { document.getElementById('c').innerHTML = '<div class="panel">Gagal memuat: ' + esc(e.message) + '</div>'; }); }
let liveTimer = null;
function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
async function vLive() {
  stopLive();
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat live traffic...</div>', 'live');
  const c = document.getElementById('c');
  c.innerHTML = '<div class="cards">'
    + '<div class="card" style="--bar:#38bdf8"><small>Download (In)</small><h2 id="lvIn">-</h2><span style="color:var(--mut)">realtime • refresh 3 dtk</span></div>'
    + '<div class="card" style="--bar:#a3e635"><small>Upload (Out)</small><h2 id="lvOut">-</h2><span style="color:var(--mut)">realtime • refresh 3 dtk</span></div>'
    + '<div class="card" style="--bar:#818cf8"><small>Total</small><h2 id="lvTot">-</h2><span style="color:var(--mut)">in + out</span></div>'
    + '<div class="card" style="--bar:#f59e0b"><small>Status</small><h2 id="lvSt">● LIVE</h2><span style="color:var(--mut)" id="lvTs">-</span></div></div>'
    + '<div class="grid"><div class="panel"><h4>Grafik Live <span class="sub">15 menit terakhir + update tiap 3 dtk</span></h4><canvas id="lvChart" style="width:100%"></canvas></div>'
    + '<div class="panel"><h4>Per Device <span class="sub">in/out saat ini</span></h4><div id="lvTbl">...</div></div></div>';
  const buf = { in: [], out: [] };
  try {
    const h = await api('/api/traffic/history?minutes=15');
    buf.in = h.points.map((p) => p.in_bps);
    buf.out = h.points.map((p) => p.out_bps);
  } catch {}
  const tick = async () => {
    try {
      const t = await api('/api/traffic/live');
      document.getElementById('lvIn').textContent = fmtBps(t.total_in_bps);
      document.getElementById('lvOut').textContent = fmtBps(t.total_out_bps);
      document.getElementById('lvTot').textContent = fmtBps(t.total_in_bps + t.total_out_bps);
      document.getElementById('lvTs').textContent = new Date(t.ts).toLocaleTimeString('id-ID');
      buf.in.push(t.total_in_bps); buf.out.push(t.total_out_bps);
      if (buf.in.length > 60) { buf.in.shift(); buf.out.shift(); }
      const cv = document.getElementById('lvChart');
      if (cv) lineChart(cv, [{ name: 'download', data: buf.in.slice() }, { name: 'upload', data: buf.out.slice() }]);
      document.getElementById('lvTbl').innerHTML = '<table><tr><th>Device</th><th>Down</th><th>Up</th></tr>' + t.devices.map((d) => '<tr><td><b>' + esc(d.name) + '</b><br><span style="color:var(--mut)">' + esc(d.ip) + '</span></td><td>' + fmtBps(d.in_bps) + '</td><td>' + fmtBps(d.out_bps) + '</td></tr>').join('') + '</table>';
    } catch (e) { const s = document.getElementById('lvSt'); if (s) s.textContent = 'TERPUTUS'; }
  };
  await tick();
  liveTimer = setInterval(tick, 3000);
}
const isSuper = () => U && U.role === 'superadmin';
const canW = () => U && (U.role === 'admin' || U.role === 'operator' || U.role === 'superadmin');
const canAdmin = () => U && (U.role === 'admin' || U.role === 'superadmin');
function fmtInt(n) { try { return Number(n).toLocaleString('id-ID'); } catch { return n; } }
function fmtBps(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' Gbps';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' Mbps';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' Kbps';
  return n + ' bps';
}

// ---- util tampilan kanal WiFi (2.4 & 5 GHz) ----
const AP_PAL = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#818cf8', '#fb7185', '#34d399', '#22d3ee', '#c084fc', '#fdba74'];
function apColor(bssid) { let h = 0; for (const ch of String(bssid || '')) h = (h * 31 + ch.charCodeAt(0)) % 9973; return AP_PAL[h % AP_PAL.length]; }
function sigBars(bars) { let s = ''; for (let i = 1; i <= 4; i++) s += '<i class="sigbar' + (i <= (bars || 0) ? ' on' : '') + '"></i>'; return '<span class="sigbars">' + s + '</span>'; }
function barsOfSignal(sig) { return Math.max(0, Math.min(4, Math.round((Number(sig) || 0) / 25))); }
const CONG_CLS = { kosong: 'up', rendah: 'info', sedang: 'warn', padat: 'down' };
const ST_CLS = { kosong: 'info', bersih: 'up', sedang: 'warn', padat: 'down' };
const dot = (bssid) => '<span class="dot" style="background:' + apColor(bssid) + '"></span>';
async function downloadCsv(path, filename) {
  try {
    const r = await fetch(path, { headers: { Authorization: T ? 'Bearer ' + T : '' } });
    if (r.status === 401) { logout(); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const url = URL.createObjectURL(new Blob([await r.text()], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('CSV diunduh: ' + filename);
  } catch (e) { toast('Unduh gagal: ' + e.message, false); }
}
let WIFI = null;
// spektrum kanal: kurva lonceng per AP + batang interferensi + kanal rekomendasi
function drawSpectrum(cv, band) {
  const c = cv.getContext('2d');
  const W = cv.width = cv.clientWidth || 620, H = cv.height = 260;
  const pad = { l: 40, r: 14, t: 18, b: 34 };
  const chans = band.channels;
  const min = chans[0].channel, max = chans[chans.length - 1].channel;
  const X = (v) => pad.l + ((v - min) / Math.max(1, max - min)) * (W - pad.l - pad.r);
  const Y = (p) => H - pad.b - (Math.max(0, Math.min(100, p)) / 100) * (H - pad.t - pad.b);
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#0a1024'; c.fillRect(0, 0, W, H);
  if (band.band === '5') {                                   // tandai kanal DFS (radar)
    c.fillStyle = 'rgba(245,158,11,.10)';
    c.fillRect(X(52), pad.t, Math.max(2, X(64) - X(52)), H - pad.t - pad.b);
    c.fillRect(X(100), pad.t, Math.max(2, X(144) - X(100)), H - pad.t - pad.b);
    c.fillStyle = '#fbbf24'; c.font = '10px Segoe UI';
    c.fillText('DFS', X(52) + 4, pad.t + 12); c.fillText('DFS', X(100) + 4, pad.t + 12);
  }
  c.strokeStyle = '#1e2a52'; c.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = Y(g * 25);
    c.beginPath(); c.moveTo(pad.l, y); c.lineTo(W - pad.r, y); c.stroke();
    c.fillStyle = '#93a1c4'; c.font = '10px Segoe UI'; c.fillText(g * 25 + '%', 4, y + 3);
  }
  const mxI = Math.max(1, ...chans.map((x) => x.interference));
  for (const ch of chans) {                                  // batang okupansi/gangguan
    if (!ch.count) continue;
    const h = (ch.interference / mxI) * (H - pad.t - pad.b);
    c.fillStyle = ch.recommended ? 'rgba(34,197,94,.28)' : 'rgba(56,189,248,.14)';
    c.fillRect(X(ch.channel) - 5, H - pad.b - h, 10, h);
  }
  const step = Math.max(0.1, (max - min) / 300);
  const aps = chans.reduce((all, x) => all.concat(x.aps), []);
  aps.forEach((a, i) => {                                    // kurva tiap AP (lonceng 20/40/80 MHz)
    const sig = a.signal || 0; if (!sig) return;
    const sigma = Math.max(0.7, ((a.width_mhz || 20) / 5) / 2.35);
    const from = Math.max(min, a.channel - 3 * sigma), to = Math.min(max, a.channel + 3 * sigma);
    if (to <= from) return;
    const col = apColor(a.bssid);
    c.beginPath();
    let first = true;
    for (let x = from; x <= to; x += step) {
      const v = sig * Math.exp(-0.5 * Math.pow((x - a.channel) / sigma, 2));
      if (first) { c.moveTo(X(x), Y(v)); first = false; } else c.lineTo(X(x), Y(v));
    }
    c.strokeStyle = col; c.lineWidth = a.active ? 2.5 : 1.6; c.stroke();
    const grad = c.createLinearGradient(0, pad.t, 0, H - pad.b);
    grad.addColorStop(0, col + '66'); grad.addColorStop(1, col + '05');
    c.lineTo(X(to), H - pad.b); c.lineTo(X(from), H - pad.b); c.closePath();
    c.fillStyle = grad; c.fill();
    c.fillStyle = col; c.font = 'bold 10px Segoe UI'; c.textAlign = 'center';
    c.fillText(String(a.ssid).slice(0, 18), X(a.channel), Y(sig) - 4 - (i % 2 ? 11 : 0));
    c.textAlign = 'left';
  });
  const rec = band.recommend;
  if (rec) {
    c.setLineDash([5, 4]); c.strokeStyle = '#22c55e'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(X(rec.channel), pad.t); c.lineTo(X(rec.channel), H - pad.b); c.stroke(); c.setLineDash([]);
    c.fillStyle = '#4ade80'; c.font = 'bold 10px Segoe UI';
    c.fillText('REKOMENDASI ch ' + rec.channel, Math.min(W - 132, X(rec.channel) + 6), H - pad.b - 6);
  }
  c.textAlign = 'center'; c.font = '10px Segoe UI';
  for (const ch of chans) {
    if (!(band.band === '2.4' || ch.count || ch.recommended || ch.channel % 2 === 0)) continue;
    c.fillStyle = '#93a1c4'; c.fillText(String(ch.channel), X(ch.channel), H - pad.b + 14);
    if (ch.count) { c.fillStyle = ch.count > 1 ? '#fbbf24' : '#93a1c4'; c.fillText(ch.count + 'AP', X(ch.channel), H - pad.b + 26); }
  }
  c.textAlign = 'left'; c.fillStyle = '#93a1c4';
  c.fillText('kanal', W - 46, H - 8);
}
function drawWifiCharts() {
  if (!WIFI || !WIFI.bands) return;
  if (WIFI.bands['2.4'] && document.getElementById('sp24')) drawSpectrum(document.getElementById('sp24'), WIFI.bands['2.4']);
  if (WIFI.bands['5'] && document.getElementById('sp5')) drawSpectrum(document.getElementById('sp5'), WIFI.bands['5']);
  if (WIFI.bands['6'] && document.getElementById('sp6')) drawSpectrum(document.getElementById('sp6'), WIFI.bands['6']);
}
window.addEventListener('resize', () => { if (CUR === 'wifi') drawWifiCharts(); });


async function vDash() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat dashboard...</div>', 'dash');
  const c = document.getElementById('c');
  const m = await api('/api/metrics/latest');
  const s = m.summary;
  const warn = m.devices.filter((d) => d.monitored && d.status !== 'up').length;
  const rows = m.devices.map((d) => '<tr><td><b>' + esc(d.name) + '</b> ' + (d.monitored ? '<span class="pill up">MONITOR</span>' : '<span class="pill info">DEMO</span>') + '<br><span style="color:var(--mut)">' + esc(d.ip) + '</span></td><td>' + pill(d.status) + '</td><td>' + (d.cpu ?? '-') + '%</td><td>' + (d.mem ?? '-') + '%</td><td>' + (d.latency ?? '-') + ' ms</td></tr>').join('');
  c.innerHTML = '<div class="cards">'
    + '<div class="card" style="--bar:#38bdf8"><small>Total Perangkat</small><h2>' + s.total + '</h2><span style="color:var(--mut)">' + (s.monitored ?? 0) + ' dipantau nyata</span></div>'
    + '<div class="card" style="--bar:#22c55e"><small>Up</small><h2 style="color:#4ade80">' + s.up + '</h2><span style="color:var(--mut)">online</span></div>'
    + '<div class="card" style="--bar:#ef4444"><small>Down / Degraded</small><h2 style="color:#f87171">' + warn + '</h2><span style="color:var(--mut)">perlu perhatian</span></div>'
    + '<div class="card" style="--bar:#818cf8"><small>Kesehatan</small><h2>' + (s.total ? Math.round((s.up / s.total) * 100) : 0) + '%</h2><span style="color:var(--mut)">uptime saat ini</span></div></div>'
    + '<div class="grid"><div class="panel"><h4>Traffic & Resource <span class="sub">24 jam</span></h4><canvas id="ch" style="width:100%"></canvas><div id="devSel" class="toolbar" style="margin-top:8px"></div></div>'
    + '<div class="panel"><h4>Status Perangkat <span class="sub">' + s.up + ' up / ' + s.total + '</span></h4><table><tr><th>Device</th><th>Status</th><th>CPU</th><th>MEM</th><th>Lat</th></tr>' + rows + '</table></div></div>';
  const devs = await api('/api/devices');
  const real = devs.filter((d) => d.monitored);
  document.getElementById('devSel').innerHTML = '<select id="dsel">' + (real.length ? real : devs).map((d) => '<option value="' + d.id + '">' + esc(d.name) + ' — ' + esc(d.ip) + '</option>').join('') + '</select><button class="btn sm" onclick="drawSel()">Tampilkan</button>';
  drawSel();
}
// grafik device terpilih (tombol "Tampilkan" pada dashboard) — global agar bisa dipanggil dari atribut onclick
async function drawSel() {
  try {
    const id = document.getElementById('dsel').value;
    const h = await api('/api/devices/' + id + '/metrics?hours=24');
    const f = h.filter((_, i) => i % 6 === 0);
    lineChart(document.getElementById('ch'), [{ name: 'cpu %', data: f.map((x) => x.cpu || 0) }, { name: 'mem %', data: f.map((x) => x.mem || 0) }]);
  } catch (e) { toast(e.message, false); }
}
const ICON = { router: '&#128752;', switch: '&#128268;', firewall: '&#128737;', server: '&#128421;', ap: '&#128246;', laptop: '&#128187;', phone: '&#128241;', tv: '&#128250;', printer: '&#128424;', iot: '&#128268;', host: '&#10068;' };
const humanType = (t) => ({ laptop: 'Laptop/PC', phone: 'Handphone', tv: 'Smart TV', printer: 'Printer', router: 'Router', server: 'Server', ap: 'Access Point', iot: 'IoT', host: 'Host', switch: 'Switch', firewall: 'Firewall' }[t] || t);
async function vDev() {
  stopLive();
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat devices...</div>', 'dev');
  const d = await api('/api/devices');
  const canW2 = canW();
  const form = canW2 ? '<div class="toolbar"><input id="dn" placeholder="Nama device"><input id="di" placeholder="IP address"><select id="dt"><option>router</option><option>laptop</option><option>phone</option><option>server</option><option>switch</option><option>ap</option><option>printer</option><option>tv</option><option>firewall</option></select><button class="btn sm" onclick="addDev()">+ Tambah</button><button class="btn sm ghost" onclick="doIdentify()">&#128269; Deteksi nama perangkat</button></div>' : '<p style="color:var(--mut)">Mode read-only (viewer)</p>';
  document.getElementById('c').innerHTML = '<div class="panel"><h4>Devices <span class="sub">' + d.length + ' perangkat • ' + d.filter((x) => x.monitored).length + ' dipoll nyata</span></h4>' + form + '<table><tr><th>Perangkat</th><th>Jenis</th><th>Vendor</th><th>MAC</th><th>Status</th><th>Latency</th>' + (canW2 ? '<th>Aksi</th>' : '') + '</tr>' + d.map((x) => '<tr><td><b>' + (ICON[x.type] || ICON.host) + ' ' + esc(x.name) + '</b><br><span style="color:var(--mut)">' + esc(x.ip) + (x.monitored ? '' : ' • DEMO') + '</span></td><td>' + esc(humanType(x.type)) + '</td><td>' + esc(x.vendor || '-') + '</td><td><span style="color:var(--mut);font-size:11px">' + esc(x.mac || '-') + '</span></td><td>' + pill(x.status) + '</td><td>' + (x.latency ?? '-') + ' ms</td>' + (canW2 ? '<td><button class="btn sm ghost" onclick="toggleMon(' + x.id + ',' + (x.monitored ? 0 : 1) + ')">' + (x.monitored ? 'Matikan poll' : 'Aktifkan poll') + '</button> <button class="btn sm ghost danger" onclick="delDev(' + x.id + ')">Hapus</button></td>' : '') + '</tr>').join('') + '</table></div>';
}
async function doIdentify() {
  const c = document.getElementById('c');
  c.innerHTML = '<div class="panel"><span class="spin"></span> Mendeteksi nama perangkat (NetBIOS/LLMNR/mDNS/ARP/port)...</div>';
  try {
    const r = await api('/api/devices/identify', { method: 'POST' });
    toast(r.count + ' perangkat terdeteksi');
    vDev();
  } catch (e) { toast(e.message, false); vDev(); }
}
async function addDev() {
  try {
    const b = { name: document.getElementById('dn').value, ip: document.getElementById('di').value, type: document.getElementById('dt').value };
    await api('/api/devices', { method: 'POST', body: JSON.stringify(b) });
    toast('Device ditambahkan'); vDev();
  } catch (e) { toast(e.message, false); }
}
async function delDev(id) {
  if (!confirm('Hapus device #' + id + '?')) return;
  try { await api('/api/devices/' + id, { method: 'DELETE' }); toast('Device dihapus'); vDev(); }
  catch (e) { toast(e.message, false); }
}
async function toggleMon(id, on) {
  try { await api('/api/devices/' + id, { method: 'PATCH', body: JSON.stringify({ monitored: on }) }); toast(on ? 'Poll diaktifkan' : 'Poll dimatikan'); vDev(); }
  catch (e) { toast(e.message, false); }
}
async function vTopo() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat topologi...</div>', 'topo');
  const t = await api('/api/topology');
  const n = t.nodes; const pos = {};
  n.forEach((x, i) => { const a = (i / n.length) * Math.PI * 2; pos[x.id] = [400 + 280 * Math.cos(a), 205 + 155 * Math.sin(a)]; });
  const L = t.links.map((l) => { const a = pos[l.from] || [50, 50], b = pos[l.to] || [100, 100]; return '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" stroke="#38bdf8" stroke-width="2" opacity=".7"/><text x="' + ((a[0] + b[0]) / 2) + '" y="' + ((a[1] + b[1]) / 2 - 4) + '" fill="#93a1c4" font-size="9" text-anchor="middle">' + esc(l.src_port || '') + '</text>'; }).join('');
  const real = n.filter((x) => x.monitored).length;
  const N = n.map((x) => { const q = pos[x.id]; const col = x.status === 'up' ? '#22c55e' : x.status === 'down' ? '#ef4444' : '#f59e0b'; const r = x.monitored ? 26 : 18; const gl = { router: '&#128752;', laptop: '&#128187;', phone: '&#128241;', tv: '&#128250;', printer: '&#128424;' }[x.type] || '&#10068;'; return '<g><circle cx="' + q[0] + '" cy="' + q[1] + '" r="' + r + '" fill="#0e1730" stroke="' + col + '" stroke-width="3"/><text x="' + q[0] + '" y="' + (q[1] + 6) + '" font-size="16" text-anchor="middle">' + gl + '</text><text x="' + q[0] + '" y="' + (q[1] + 40) + '" fill="#e8eefc" font-size="10" font-weight="bold" text-anchor="middle">' + esc(x.label) + '</text><text x="' + q[0] + '" y="' + (q[1] + 51) + '" fill="#93a1c4" font-size="9" text-anchor="middle">' + esc(x.ip) + '</text></g>'; }).join('');
  document.getElementById('c').innerHTML = '<div class="panel"><h4>Peta Topologi <span class="sub">' + n.length + ' nodes (' + real + ' nyata ★) • ' + t.links.length + ' links • hijau=up merah=down kuning=degraded</span></h4><svg id="topo" viewBox="0 0 800 420">' + L + N + '</svg></div>';
}
async function vAlerts() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat alerts...</div>', 'alerts');
  const a = await api('/api/alerts');
  const canW3 = canW();
  document.getElementById('c').innerHTML = '<div class="panel"><h4>Alerts <span class="sub">' + a.length + ' insiden</span></h4>' + (canW3 ? '' : '<p style="color:var(--mut)">Mode read-only (viewer)</p>') + '<table><tr><th>ID</th><th>Device</th><th>Sev</th><th>Status</th><th>Pesan</th>' + (canW3 ? '<th>Aksi</th>' : '') + '</tr>' + a.map((x) => '<tr><td>' + x.id + '</td><td>' + esc(x.device_name || x.device_id || '-') + '</td><td>' + pill(x.severity) + '</td><td>' + pill(x.status) + '</td><td>' + esc(x.message) + '</td>' + (canW3 ? '<td><button class="btn sm ghost" onclick="ack(' + x.id + ')">Ack</button> <button class="btn sm" onclick="res(' + x.id + ')">Resolve</button></td>' : '') + '</tr>').join('') + '</table></div>';
}
async function vEvents() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat events...</div>', 'events');
  const e = await api('/api/events?limit=100');
  document.getElementById('c').innerHTML = '<div class="panel"><h4>Events & Syslog <span class="sub">' + e.length + ' terbaru</span></h4><table><tr><th>ID</th><th>Waktu</th><th>Source</th><th>Sev</th><th>Pesan</th></tr>' + e.map((x) => '<tr><td>' + x.id + '</td><td style="white-space:nowrap">' + esc(x.ts) + '</td><td>' + esc(x.source) + ' / ' + esc(x.facility) + '</td><td>' + pill(x.severity) + '</td><td>' + esc(x.message) + '</td></tr>').join('') + '</table></div>';
}
async function vRep() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat laporan...</div>', 'rep');
  const r = await api('/api/reports/summary');
  document.getElementById('c').innerHTML = '<div class="cards"><div class="card" style="--bar:#38bdf8"><small>Devices</small><h2>' + r.devices + '</h2></div><div class="card" style="--bar:#22c55e"><small>Up</small><h2>' + r.up + '</h2></div><div class="card" style="--bar:#818cf8"><small>Avg CPU</small><h2>' + r.avg_cpu + '%</h2></div><div class="card" style="--bar:#f472b6"><small>Avg MEM</small><h2>' + r.avg_mem + '%</h2></div></div><div class="panel"><h4>Unduh Laporan <span class="sub">CSV diambil memakai token login (aman untuk RBAC)</span></h4><div class="toolbar"><button class="btn sm" onclick="downloadCsv(\'/api/reports/export.csv\',\'report-devices.csv\')">&#11015; Devices CSV</button><button class="btn sm ghost" onclick="downloadCsv(\'/api/reports/sla.csv?days=7\',\'sla-7d.csv\')">&#11015; SLA CSV (7 hari)</button><button class="btn sm ghost" onclick="downloadCsv(\'/api/reports/sla.csv?days=30\',\'sla-30d.csv\')">&#11015; SLA CSV (30 hari)</button></div></div>';
}
async function vSla() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat SLA...</div>', 'sla');
  const r = await api('/api/reports/sla?days=7');
  document.getElementById('c').innerHTML = '<div class="panel"><h4>SLA / Uptime <span class="sub">' + r.days + ' hari • target 99.5%</span></h4><div class="toolbar"><button class="btn sm ghost" onclick="downloadCsv(\'/api/reports/sla.csv?days=' + r.days + '\',\'sla-' + r.days + 'd.csv\')">&#11015; Unduh CSV</button></div><table><tr><th>Device</th><th>Sampel</th><th>Down</th><th>Total downtime</th><th>Uptime</th><th>SLA</th></tr>' + r.rows.map((x) => '<tr><td><b>' + esc(x.name) + '</b><br><span style="color:var(--mut)">' + esc(x.ip) + '</span></td><td>' + fmtInt(x.samples) + '</td><td>' + x.down_events + '</td><td>' + fmtInt(x.downtime_minutes) + ' mnt</td><td>' + x.uptime_pct + '%</td><td>' + (x.sla_ok ? '<span class="pill up">OK</span>' : '<span class="pill down">BREACH</span>') + '</td></tr>').join('') + '</table><p class="hint">Uptime dihitung dari sampel metrik poller; bila belum ada sampel dipakai durasi alert “down”.</p></div>';
}
async function vFlow() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat flows...</div>', 'flow');
  const r = await api('/api/flows?limit=50');
  document.getElementById('c').innerHTML = '<div class="grid"><div class="panel"><h4>Top Talkers <span class="sub">by bytes</span></h4><table><tr><th>Src IP</th><th>Bytes</th><th>Flows</th></tr>' + r.top_talkers.map((x) => '<tr><td>' + esc(x.src_ip) + '</td><td>' + fmtInt(x.b) + '</td><td>' + x.f + '</td></tr>').join('') + '</table></div><div class="panel"><h4>Flows Terbaru</h4><table><tr><th>Waktu</th><th>Src → Dst</th><th>Proto</th><th>Bytes</th></tr>' + r.rows.slice(0, 30).map((x) => '<tr><td style="white-space:nowrap">' + esc(x.ts) + '</td><td>' + esc(x.src_ip) + ':' + x.src_port + ' → ' + esc(x.dst_ip) + ':' + x.dst_port + '</td><td>' + pill(x.proto) + '</td><td>' + fmtInt(x.bytes) + '</td></tr>').join('') + '</table></div></div>';
}
async function vDisc() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat discovery...</div>', 'disc');
  const [h, net] = await Promise.all([api('/api/discovery'), api('/api/network/local').catch(() => ({ subnet: '192.168.1', interfaces: [] }))]);
  const ift = (net.interfaces || []).map((i) => '<tr><td><b>' + esc(i.name) + '</b></td><td>' + esc(i.ip) + '</td><td style="font-size:11px;color:var(--mut)">' + esc(i.mac || '-') + '</td><td>' + esc(i.cidr || (i.prefix + '.0/24')) + '</td></tr>').join('');
  document.getElementById('c').innerHTML = '<div class="panel"><h4>Auto-Discovery <span class="sub">ping-sweep subnet</span></h4>'
    + '<div class="toolbar"><input id="ds" value="' + esc(net.subnet || '192.168.1') + '" title="prefix subnet, mis. 192.168.1"><input id="dl" value="254" style="width:90px" title="jumlah host yang discan (maks 254)"><button class="btn sm" onclick="runDisc()">Scan</button><button class="btn sm ghost" onclick="vDisc()">Muat ulang</button></div>'
    + '<p class="hint">Subnet diisi otomatis dari interface aktif (bisa diganti manual). Untuk scan menyeluruh sekaligus identifikasi nama perangkat &amp; topologi, jalankan <b>node scripts/scan-lan.js</b>.</p>'
    + '<table><tr><th>Interface</th><th>IP</th><th>MAC</th><th>Subnet</th></tr>' + (ift || '<tr><td colspan="4" style="color:var(--mut)">interface lokal tidak terbaca</td></tr>') + '</table></div>'
    + '<div class="panel"><h4>Riwayat Discovery <span class="sub">20 terakhir</span></h4><table><tr><th>ID</th><th>Waktu</th><th>Subnet</th><th>Ditemukan</th><th>Host</th></tr>'
    + h.map((x) => { let host = []; try { host = JSON.parse(x.detail || '[]'); } catch { host = []; } return '<tr><td>' + x.id + '</td><td style="white-space:nowrap">' + esc(x.ts) + '</td><td>' + esc(x.subnet) + '</td><td><b>' + x.found + '</b></td><td style="font-size:11px;color:var(--mut)">' + esc(host.slice(0, 12).join(', ') || '-') + '</td></tr>'; }).join('') + '</table></div>';
}
async function runDisc() {
  try {
    const b = { subnet: document.getElementById('ds').value, limit: Number(document.getElementById('dl').value) };
    const r = await api('/api/discovery', { method: 'POST', body: JSON.stringify(b) });
    toast('Scan selesai: ' + r.alive.length + ' hidup, ' + r.added + ' baru'); vDisc();
  } catch (e) { toast(e.message, false); }
}
async function doLogin() {
  const username = document.getElementById('u').value, password = document.getElementById('pw').value;
  const btn = document.querySelector('#login button');
  btn.innerHTML = '<span class="spin"></span> Memeriksa...';
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await r.json();
    if (data.token) { T = data.token; U = data.user; localStorage.setItem('nms_tok', T); localStorage.setItem('nms_user', JSON.stringify(U)); CUR = 'dash'; render(); }
    else document.getElementById('le').textContent = data.error || 'Login gagal';
  } catch (e) { document.getElementById('le').textContent = 'Server tidak merespons — pastikan node server.js berjalan'; }
  btn.textContent = 'Masuk Dashboard';
}
async function vUsers() {
  if (!canAdmin()) return go('dash');
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat users...</div>', 'users');
  const us = await api('/api/users');
  document.getElementById('c').innerHTML = '<div class="panel"><h4>Users <span class="sub">' + us.length + ' akun • superadmin/admin/operator/viewer</span></h4><div class="toolbar"><input id="un" placeholder="username"><input id="up" type="password" placeholder="password"><select id="ur"><option>superadmin</option><option>admin</option><option>operator</option><option>viewer</option></select><button class="btn sm" onclick="addUser()">+ Tambah</button></div><table><tr><th>User</th><th>Role</th><th>Dibuat</th><th>Aksi</th></tr>' + us.map((x) => '<tr><td><b>' + esc(x.username) + '</b><br><span style="color:var(--mut)">' + esc(x.email || '-') + '</span></td><td>' + pill(x.role, { superadmin: 'down', admin: 'down', operator: 'warn', viewer: 'info' }) + '</td><td>' + esc(x.created_at || '-') + '</td><td>' + (x.username !== U.username ? '<button class="btn sm ghost danger" onclick="delUser(' + x.id + ')">Hapus</button>' : '<span style="color:var(--mut)">(saya)</span>') + '</td></tr>').join('') + '</table></div>';
}
async function addUser() {
  try {
    const b = { username: document.getElementById('un').value, password: document.getElementById('up').value, role: document.getElementById('ur').value };
    await api('/api/users', { method: 'POST', body: JSON.stringify(b) });
    toast('User ditambahkan'); vUsers();
  } catch (e) { toast(e.message, false); }
}
async function delUser(id) {
  if (!confirm('Hapus user #' + id + '?')) return;
  try { await api('/api/users/' + id, { method: 'DELETE' }); toast('User dihapus'); vUsers(); }
  catch (e) { toast(e.message, false); }
}
async function vChan() {
  if (!canAdmin()) return go('dash');
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat channels...</div>', 'chan');
  const ch = await api('/api/channels');
  document.getElementById('c').innerHTML = '<div class="panel"><h4>Channels Notifikasi <span class="sub">' + ch.length + ' tujuan</span></h4><div class="toolbar"><select id="ct"><option>telegram</option><option>email</option><option>slack</option><option>sms</option><option>whatsapp</option></select><input id="cg" placeholder="target (chat id / email / webhook)"><button class="btn sm" onclick="addChan()">+ Tambah</button></div><table><tr><th>Tipe</th><th>Target</th><th>Min Sev</th><th>Aktif</th><th>Aksi</th></tr>' + ch.map((x) => '<tr><td>' + pill(x.type) + '</td><td>' + esc(x.target) + '</td><td>' + esc(x.min_severity) + '</td><td>' + (x.enabled ? 'ya' : 'tidak') + '</td><td><button class="btn sm ghost danger" onclick="delChan(' + x.id + ')">Hapus</button></td></tr>').join('') + '</table></div>';
}
async function addChan() {
  try {
    const b = { type: document.getElementById('ct').value, target: document.getElementById('cg').value };
    await api('/api/channels', { method: 'POST', body: JSON.stringify(b) });
    toast('Channel ditambahkan'); vChan();
  } catch (e) { toast(e.message, false); }
}
async function delChan(id) {
  if (!confirm('Hapus channel #' + id + '?')) return;
  try { await api('/api/channels/' + id, { method: 'DELETE' }); toast('Channel dihapus'); vChan(); }
  catch (e) { toast(e.message, false); }
}
async function ack(id) { try { await api('/api/alerts/' + id + '/ack', { method: 'POST' }); toast('Alert #' + id + ' di-ack'); vAlerts(); } catch (e) { toast(e.message, false); } }
async function res(id) { try { await api('/api/alerts/' + id + '/resolve', { method: 'POST' }); toast('Alert #' + id + ' resolved'); vAlerts(); } catch (e) { toast(e.message, false); } }
render();

// ---- halaman Kanal WiFi (2.4 GHz & 5 GHz) ----
function wifiCards(w) {
  const b24 = w.bands['2.4'], b5 = w.bands['5'], c = w.connected;
  const r24 = b24.recommend, r5 = b5.recommend;
  const connTitle = c && c.ssid ? esc(c.ssid) : '—';
  const connSub = c ? (c.channel ? 'ch ' + c.channel + ' (' + esc(c.band) + ' GHz) • ' + (c.signal ?? '-') + '% / ' + (c.rssi ?? '-') + ' dBm' : 'tidak terhubung') : 'tanpa adapter WiFi';
  return '<div class="cards">'
    + '<div class="card" style="--bar:#38bdf8"><small>Band 2.4 GHz</small><h2>' + b24.aps + ' AP</h2><span style="color:var(--mut)">' + esc(b24.congestion) + ' • terbaik <b>ch ' + (r24 ? r24.channel : '-') + '</b></span></div>'
    + '<div class="card" style="--bar:#a3e635"><small>Band 5 GHz</small><h2>' + b5.aps + ' AP</h2><span style="color:var(--mut)">' + esc(b5.congestion) + ' • terbaik <b>ch ' + (r5 ? r5.channel : '-') + '</b>' + (b5.dfs_aps ? ' • ' + b5.dfs_aps + ' DFS' : '') + '</span></div>'
    + '<div class="card" style="--bar:#22c55e"><small>WiFi Terhubung</small><h2 style="font-size:18px">' + connTitle + '</h2><span style="color:var(--mut)">' + connSub + '</span></div>'
    + '<div class="card" style="--bar:#818cf8"><small>Total AP Terdeteksi</small><h2>' + w.counts.total + '</h2><span style="color:var(--mut)">' + esc(w.adapter || 'adapter -') + ' • ' + (w.scanned_at ? esc(w.scanned_at) + ' UTC' : 'belum ada scan') + '</span></div></div>';
}
function chanTable(band) {
  const rows = band.channels.filter((x) => band.band === '2.4' || x.count || x.recommended);
  if (!rows.length) return '<p class="hint">Tidak ada AP terdeteksi di band ini.</p>';
  return '<table><tr><th>Ch</th><th>Freq</th><th>UNII</th><th>AP</th><th>Terkuat</th><th>Gangguan</th><th>Kondisi</th><th>SSID</th></tr>'
    + rows.map((x) => '<tr' + (x.recommended ? ' class="recrow"' : '') + '><td><b>' + x.channel + '</b>'
      + (x.recommended ? ' <span class="pill up">pilih</span>' : '') + (x.dfs ? ' <span class="pill warn">DFS</span>' : '') + '</td>'
      + '<td style="white-space:nowrap">' + x.freq_mhz + ' MHz</td><td style="font-size:11px">' + esc(x.unii) + '</td>'
      + '<td><b>' + x.count + '</b></td><td>' + (x.count ? x.strongest + '%' : '-') + '</td><td>' + x.interference + '</td>'
      + '<td>' + pill(x.status, ST_CLS) + '</td>'
      + '<td style="font-size:12px">' + (x.aps.length ? x.aps.map((a) => dot(a.bssid) + esc(a.ssid) + ' ' + sigBars(barsOfSignal(a.signal))).join('<br>') : '<span style="color:var(--mut)">kosong</span>') + '</td></tr>').join('')
    + '</table>';
}
function ssidTable(ssids) {
  if (!ssids.length) return '<p class="hint">Belum ada nama WiFi tersimpan. Jalankan “Scan Kanal WiFi” — semua SSID tetangga yang masuk cache scan ikut tampil (bukan hanya yang terhubung).</p>';
  return '<table><tr><th>Nama WiFi (SSID)</th><th>Status</th><th>Band</th><th>Kanal</th><th>Sinyal</th><th>Keamanan</th><th>BSSID</th></tr>'
    + ssids.map((g) => '<tr><td><b>' + esc(g.ssid) + '</b></td>'
      + '<td>' + (g.connected ? '<span class="pill up">TERHUBUNG</span>' : '<span class="pill info">' + g.count + ' AP terlihat</span>') + '</td>'
      + '<td>' + esc(g.bands) + ' GHz</td><td><b>' + esc(g.channels) + '</b></td>'
      + '<td>' + sigBars(barsOfSignal(g.strongest)) + ' ' + g.strongest + '%</td>'
      + '<td>' + (g.secured ? '&#128274; WPA' : '<span class="pill warn">OPEN</span>') + '</td>'
      + '<td style="font-size:11px;color:var(--mut)">' + g.count + ' BSSID</td></tr>').join('')
    + '</table><p class="hint">SSID dengan badge hijau adalah WiFi yang sedang dipakai perangkat ini; sisanya nama WiFi tetangga yang terdeteksi.</p>';
}
function apTable(nets) {
  if (!nets.length) return '<p class="hint">Belum ada AP tersimpan. Jalankan “Scan Kanal WiFi”.</p>';
  return '<table><tr><th>SSID</th><th>BSSID</th><th>Band</th><th>Ch</th><th>Sinyal</th><th>RSSI</th><th>Radio</th><th>Keamanan</th><th>Vendor</th><th>Terlihat</th></tr>'
    + nets.map((n) => '<tr><td>' + dot(n.bssid) + '<b>' + esc(n.ssid) + '</b>' + (n.active ? ' <span class="pill up">TERHUBUNG</span>' : '') + '</td>'
      + '<td style="font-size:11px;color:var(--mut)">' + esc(n.bssid || '-') + '</td><td>' + esc(n.band) + ' GHz</td><td><b>' + (n.channel || '-') + '</b></td>'
      + '<td>' + sigBars(n.bars) + ' ' + (n.signal ?? '-') + '%</td><td>' + (n.rssi ?? '-') + ' dBm</td>'
      + '<td>' + esc(n.radio_type || '-') + '</td><td>' + esc(n.security || '-') + '</td><td>' + esc(n.vendor || '-') + '</td>'
      + '<td style="font-size:11px;color:var(--mut)">' + (n.seen_count || 1) + '×<br>' + esc(n.last_seen || '-') + '</td></tr>').join('')
    + '</table>';
}
function histTable(hist) {
  if (!hist || !hist.length) return '<p class="hint">Belum ada riwayat scan.</p>';
  return '<table><tr><th>ID</th><th>Waktu (UTC)</th><th>Sumber</th><th>Adapter</th><th>Total</th><th>2.4 GHz</th><th>5 GHz</th></tr>'
    + hist.map((h) => '<tr><td>' + h.id + '</td><td style="white-space:nowrap">' + esc(h.ts) + '</td><td>' + esc(h.source || '-') + '</td><td>' + esc(h.adapter || '-') + '</td><td><b>' + h.total + '</b></td><td>' + h.n24 + '</td><td>' + h.n5 + '</td></tr>').join('') + '</table>';
}
function recPanel(band) {
  const r = band.recommend;
  return '<div class="panel"><h4>Rekomendasi Band ' + esc(band.label) + ' <span class="sub">' + band.aps + ' AP • kondisi ' + esc(band.congestion) + '</span></h4>'
    + (r ? '<div class="reco"><div class="reco-ch" style="--bar:' + (band.band === '2.4' ? '#38bdf8' : '#a3e635') + '">ch ' + r.channel + '</div>'
      + '<div><b>' + r.freq_mhz + ' MHz</b> • ' + esc(r.unii) + (r.dfs ? ' <span class="pill warn">DFS</span>' : '') + '<br>'
      + '<span style="color:var(--mut)">' + esc(r.reason) + '</span></div></div>'
      + '<p class="hint">Skor gangguan ' + r.score + ' (semakin kecil semakin baik). Setel kanal AP ke <b>ch ' + r.channel + '</b> bila band ini mulai padat.</p>'
      : '<p class="hint">Belum ada data kanal pada band ini.</p>')
    + '</div>';
}
function renderWifi(w) {
  const b24 = w.bands['2.4'], b5 = w.bands['5'], b6 = w.bands['6'];
  const spectrum = (band, id) => '<div class="panel"><h4>Spektrum ' + esc(band.label) + ' <span class="sub">' + band.aps + ' AP • ' + (band.band === '2.4' ? 'kanal 1–14 saling bertumpang tindih' : 'kanal 36–177 + area DFS radar') + '</span></h4>'
    + '<canvas id="' + id + '" style="width:100%"></canvas>'
    + '<p class="hint">Tinggi kurva = kekuatan sinyal (%), garis hijau = kanal rekomendasi. Lebar kanal diestimasi dari tipe radio karena netsh/nmcli tidak selalu melaporkannya.</p></div>';
  const toolbar = '<div class="panel"><h4>Discovery Kanal WiFi <span class="sub">band 2.4 GHz &amp; 5 GHz</span></h4><div class="toolbar" id="wifiBar">'
    + (canW() ? '<button class="btn sm" onclick="runWifiScan()">&#128260; Scan Kanal WiFi</button><button class="btn sm ghost" onclick="runWifiScan(true)">&#128269; Scan Mendalam</button>' : '<span style="color:var(--mut)">Mode read-only (viewer) — minta admin/operator menjalankan scan</span>')
    + '<span class="hint">sumber: <b>' + esc(w.source || '-') + '</b> • adapter: <b>' + esc(w.adapter || '-') + '</b>' + (w.reason ? ' • ' + esc(w.reason) : '') + '</span></div>'
    + '<p class="hint">Cache scan Windows biasanya hanya memuat tetangga sesaat setelah connect/roam (AP yang terhubung selalu muncul). Untuk pemetaan penuh, jalankan scan saat adapter baru terhubung atau buka halaman ini setelah koneksi WiFi dibuat ulang.</p></div>';
  document.getElementById('c').innerHTML = toolbar + wifiCards(w) + '<div id="speedBox">' + speedHtml(SPEED) + '</div>'
    + '<div class="panel"><h4>Nama WiFi Terlihat <span class="sub">' + (w.ssids || []).length + ' SSID (terhubung + tetangga)</span></h4>' + ssidTable(w.ssids || []) + '</div>'
    + '<div class="grid">' + spectrum(b24, 'sp24') + spectrum(b5, 'sp5') + (b6 ? spectrum(b6, 'sp6') : '') + '</div>'
    + '<div class="grid"><div class="panel"><h4>Okupansi Kanal 2.4 GHz <span class="sub">1/6/11 = non-overlapping</span></h4>' + chanTable(b24) + '</div>'
    + '<div class="panel"><h4>Okupansi Kanal 5 GHz <span class="sub">UNII-1 / 2A / 2C / 3</span></h4>' + chanTable(b5) + '</div></div>'
    + '<div class="grid">' + recPanel(b24) + recPanel(b5) + '</div>'
    + '<div class="panel"><h4>AP Terdeteksi <span class="sub">' + w.counts.total + ' BSSID • ' + w.counts.hidden + ' SSID hidden</span></h4>' + apTable(w.networks) + '</div>'
    + '<div class="panel"><h4>Riwayat Scan <span class="sub">10 terakhir</span></h4>' + histTable(w.history) + '</div>';
  drawWifiCharts();
}
let SPEED = { last: null, history: [] };
function fmtMs(v) { return v === null || v === undefined ? '-' : (+v).toFixed(v < 10 ? 1 : 0) + ' ms'; }
function qualityWord(g, jitter) {
  if (!g) return '<span style="color:var(--mut)">belum diuji</span>';
  return '<span class="pill ' + ({ A: 'up', B: 'info', C: 'warn', D: 'warn', E: 'down' }[g] || 'info') + '">' + g + '</span>'
    + ' <span style="color:var(--mut)">(jitter ' + fmtMs(jitter) + ')</span>';
}
function jitterBars(samples, pingAvg) {
  if (!samples || !samples.length) return '<span style="color:var(--mut)">-</span>';
  const mx = Math.max(pingAvg || 1, ...samples);
  const bars = samples.slice(-20).map((v) => {
    const h = Math.max(8, Math.round((v / mx) * 100));
    const bad = v > (pingAvg || 0) * 2 + 10;
    return '<i style="height:' + h + '%;background:' + (bad ? '#ef4444' : '#38bdf8') + '" title="' + v + ' ms"></i>';
  }).join('');
  return '<span class="pingbars">' + bars + '</span>';
}
function speedHtml(sp) {
  const last = sp ? sp.last : null;
  const hist = sp ? sp.history || [] : [];
  const canRun = canW();
  let body = '';
  if (!last) {
    body = '<p class="hint">Belum ada hasil. Speedtest mengukur koneksi yang sedang dipakai perangkat ini (WiFi/LAN): <b>ping</b> + <b>jitter</b> ke gateway & internet, lalu <b>unduh</b> dan <b>unggah</b> nyata ±5 MB / ±1 MB.</p>';
  } else {
    const ping = { min: last.ping_min, avg: last.ping_avg, max: last.ping_max, jitter: last.jitter, loss: last.loss, target: last.target };
    body = '<div class="speedgrid">'
      + '<div><small>Unduh</small><h2>' + (last.down_mbps ?? '-') + ' <span>Mbps</span></h2></div>'
      + '<div><small>Unggah</small><h2>' + (last.up_mbps ?? '-') + ' <span>Mbps</span></h2></div>'
      + '<div><small>Ping internet (' + esc(last.target || '-') + ')</small><h2>' + fmtMs(ping.avg) + '</h2><span style="color:var(--mut)">min ' + fmtMs(ping.min) + ' • maks ' + fmtMs(ping.max) + '</span></div>'
      + '<div><small>Jitter</small><h2>' + fmtMs(ping.jitter) + '</h2><span style="color:var(--mut)">loss ' + (ping.loss ?? '-') + '%</span></div>'
      + '<div><small>Kualitas</small><h2>' + qualityWord(last.grade, ping.jitter) + '</h2></div>'
      + '</div>'
      + '<div class="speedmeta"><span>via <b>' + esc(last.iface || '-') + '</b> • IP lokal <b>' + esc(last.local_ip || '-') + '</b>' + (last.subnet ? ' (' + esc(last.subnet) + ')' : '') + ' • endpoint <b>' + esc(last.endpoint || '-') + '</b> • ' + esc(last.ts || '') + ' UTC</span></div>'
      + '<div class="speedmeta"><span>Ping per sampel (20 terakhir) ke ' + esc(ping.target) + ': </span>' + jitterBars(last.ping_raw || null, ping.avg) + '</div>';
  }
  const hrows = hist.length ? '<table><tr><th>Waktu</th><th>Via / IP</th><th>Ping</th><th>Jitter</th><th>Down</th><th>Up</th><th>Grade</th></tr>'
    + hist.map((x) => '<tr><td style="white-space:nowrap">' + esc(x.ts) + '</td><td>' + esc(x.iface || '-') + ' ' + esc(x.local_ip || '') + '</td><td>' + fmtMs(x.ping_avg) + '</td><td>' + fmtMs(x.jitter) + '</td><td>' + (x.down_mbps ?? '-') + ' Mbps</td><td>' + (x.up_mbps ?? '-') + ' Mbps</td><td>' + (x.grade || '-') + '</td></tr>').join('') + '</table>' : '';
  return '<div class="panel"><h4>Speedtest WiFi / LAN <span class="sub">koneksi yang sedang dipakai perangkat ini</span></h4>'
    + '<div class="toolbar">' + (canRun ? '<button class="btn sm" onclick="runSpeedtestUi()">&#9889; Jalankan Speedtest</button>' : '<span style="color:var(--mut)">Mode read-only (viewer)</span>')
    + '<span class="hint">±10 ping ke gateway + internet, unduh ±5 MB, unggah ±1 MB (bisa ±30 dtk)</span></div>'
    + '<div id="speedRes">' + body + '</div>' + hrows + '</div>';
}
async function runSpeedtestUi() {
  const box = document.getElementById('speedRes');
  if (box) box.innerHTML = '<p><span class="spin"></span> Mengukur: ping gateway & internet dulu, lalu unduh & unggah... (bisa ±30 detik)</p>';
  try {
    const r = await api('/api/speedtest', { method: 'POST' });
    if (r.ok) {
      toast('Speedtest: down ' + r.down.mbps + ' Mbps, up ' + r.up.mbps + ' Mbps, ping ' + r.ping.avg + ' ms, jitter ' + r.ping.jitter + ' ms');
    } else {
      toast((r.note || 'Speedtest gagal') , false);
    }
    try {
      const sp = await api('/api/speedtest');
      SPEED = sp && sp.last !== undefined ? sp : { last: null, history: [] };
      const nb = document.getElementById('speedBox');
      if (nb) nb.innerHTML = speedHtml(SPEED);
    } catch (e) { toast(e.message, false); }
  } catch (e) { toast(e.message, false); vWifi(); }
}
async function vWifi() {
  stopLive();
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat kanal WiFi...</div>', 'wifi');
  const [w, sp] = await Promise.all([api('/api/wifi'), api('/api/speedtest').catch(() => ({ last: null, history: [] }))]);
  WIFI = w; SPEED = (sp && sp.last !== undefined) ? sp : { last: null, history: [] };
  renderWifi(w);
}
async function runWifiScan(deep) {
  const btns = document.querySelectorAll('#wifiBar button');
  btns.forEach((b) => { b.disabled = true; });
  if (btns[0]) btns[0].innerHTML = '<span class="spin"></span> ' + (deep ? 'Scan mendalam (bisa ±1 mnt)...' : 'Memindai 2.4 &amp; 5 GHz...');
  try {
    const w = await api('/api/wifi/scan', { method: 'POST', body: JSON.stringify({ deep: !!deep }) });
    WIFI = w;
    toast((deep ? 'Scan mendalam selesai: ' : 'Scan selesai: ') + w.counts.total + ' AP (2.4 GHz ' + w.counts.b24 + ', 5 GHz ' + w.counts.b5 + ')');
    renderWifi(w);
  } catch (e) { toast(e.message, false); vWifi(); }
}
