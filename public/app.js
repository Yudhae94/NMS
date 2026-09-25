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
  let nav = btn('dash', '&#128202; Dashboard') + btn('live', '&#128994; Live Traffic') + btn('dev', '&#128752; Devices') + btn('topo', '&#127760; Topologi') + btn('alerts', '&#128276; Alerts') + btn('events', '&#128221; Events') + btn('flow', '&#8646; Flows') + btn('rep', '&#128203; Laporan') + btn('sla', '&#9989; SLA');
  if (isA || U.role === 'superadmin') nav += btn('users', '&#128100; Users') + btn('chan', '&#128225; Channels');
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
function go(v) { stopLive(); CUR = v; ({ dash: vDash, live: vLive, dev: vDev, topo: vTopo, alerts: vAlerts, events: vEvents, flow: vFlow, rep: vRep, sla: vSla, users: vUsers, chan: vChan, disc: vDisc }[v] || vDash)().catch((e) => { document.getElementById('c').innerHTML = '<div class="panel">Gagal memuat: ' + esc(e.message) + '</div>'; }); }
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
  window.drawSel = async () => {
    try {
      const id = document.getElementById('dsel').value;
      const h = await api('/api/devices/' + id + '/metrics?hours=24');
      const f = h.filter((_, i) => i % 6 === 0);
      lineChart(document.getElementById('ch'), [{ name: 'cpu %', data: f.map((x) => x.cpu || 0) }, { name: 'mem %', data: f.map((x) => x.mem || 0) }]);
    } catch (e) { toast(e.message, false); }
  };
  drawSel();
}
async function vDev() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat devices...</div>', 'dev');
  const d = await api('/api/devices');
  const canW2 = canW();
  const form = canW2 ? '<div class="toolbar"><input id="dn" placeholder="Nama device"><input id="di" placeholder="IP address"><select id="dt"><option>router</option><option>switch</option><option>firewall</option><option>server</option><option>ap</option></select><button class="btn sm" onclick="addDev()">+ Tambah</button></div>' : '<p style="color:var(--mut)">Mode read-only (viewer)</p>';
  const ico = { router: '&#128752;', switch: '&#128268;', firewall: '&#128737;', server: '&#128187;', ap: '&#128246;' };
  document.getElementById('c').innerHTML = '<div class="panel"><h4>Devices <span class="sub">' + d.length + ' perangkat • ' + d.filter((x) => x.monitored).length + ' dipoll nyata</span></h4>' + form + '<table><tr><th>Device</th><th>Tipe</th><th>Status</th><th>Latency</th><th>Mode</th>' + (canW2 ? '<th>Aksi</th>' : '') + '</tr>' + d.map((x) => '<tr><td><b>' + (ico[x.type] || '&#128187;') + ' ' + esc(x.name) + '</b><br><span style="color:var(--mut)">' + esc(x.ip) + ' • ' + esc(x.vendor || '-') + '</span></td><td>' + esc(x.type) + '</td><td>' + pill(x.status) + '</td><td>' + (x.latency ?? '-') + ' ms</td><td>' + (x.monitored ? '<span class="pill up">MONITOR</span>' : '<span class="pill info">DEMO</span>') + '</td>' + (canW2 ? '<td><button class="btn sm ghost" onclick="toggleMon(' + x.id + ',' + (x.monitored ? 0 : 1) + ')">' + (x.monitored ? 'Matikan poll' : 'Aktifkan poll') + '</button> <button class="btn sm ghost danger" onclick="delDev(' + x.id + ')">Hapus</button></td>' : '') + '</tr>').join('') + '</table></div>';
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
  const N = n.map((x) => { const q = pos[x.id]; const col = x.status === 'up' ? '#22c55e' : x.status === 'down' ? '#ef4444' : '#f59e0b'; const r = x.monitored ? 26 : 20; return '<g><circle cx="' + q[0] + '" cy="' + q[1] + '" r="' + r + '" fill="#0e1730" stroke="' + col + '" stroke-width="' + (x.monitored ? 4 : 2) + '"' + (x.monitored ? '' : ' opacity=".55"') + '/><circle cx="' + q[0] + '" cy="' + q[1] + '" r="7" fill="' + col + '"/><text x="' + q[0] + '" y="' + (q[1] + 42) + '" fill="#e8eefc" font-size="11" font-weight="bold" text-anchor="middle">' + esc(x.label) + '</text><text x="' + q[0] + '" y="' + (q[1] + 54) + '" fill="#93a1c4" font-size="9" text-anchor="middle">' + esc(x.ip) + (x.monitored ? ' ★' : '') + '</text></g>'; }).join('');
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
  document.getElementById('c').innerHTML = '<div class="cards"><div class="card" style="--bar:#38bdf8"><small>Devices</small><h2>' + r.devices + '</h2></div><div class="card" style="--bar:#22c55e"><small>Up</small><h2>' + r.up + '</h2></div><div class="card" style="--bar:#818cf8"><small>Avg CPU</small><h2>' + r.avg_cpu + '%</h2></div><div class="card" style="--bar:#f472b6"><small>Avg MEM</small><h2>' + r.avg_mem + '%</h2></div></div><div class="panel"><h4>Unduh Laporan</h4><div class="toolbar"><a class="btn sm" href="/api/reports/export.csv">Devices CSV</a><a class="btn sm ghost" href="/api/reports/sla.csv?days=7">SLA CSV (7 hari)</a></div></div>';
}
async function vSla() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat SLA...</div>', 'sla');
  const r = await api('/api/reports/sla?days=7');
  document.getElementById('c').innerHTML = '<div class="panel"><h4>SLA / Uptime <span class="sub">' + r.days + ' hari • target 99.5%</span></h4><table><tr><th>Device</th><th>Sampel</th><th>Down</th><th>Uptime</th><th>SLA</th></tr>' + r.rows.map((x) => '<tr><td><b>' + esc(x.name) + '</b><br><span style="color:var(--mut)">' + esc(x.ip) + '</span></td><td>' + fmtInt(x.samples) + '</td><td>' + x.down_events + '</td><td>' + x.uptime_pct + '%</td><td>' + (x.sla_ok ? '<span class="pill up">OK</span>' : '<span class="pill down">BREACH</span>') + '</td></tr>').join('') + '</table></div>';
}
async function vFlow() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat flows...</div>', 'flow');
  const r = await api('/api/flows?limit=50');
  document.getElementById('c').innerHTML = '<div class="grid"><div class="panel"><h4>Top Talkers <span class="sub">by bytes</span></h4><table><tr><th>Src IP</th><th>Bytes</th><th>Flows</th></tr>' + r.top_talkers.map((x) => '<tr><td>' + esc(x.src_ip) + '</td><td>' + fmtInt(x.b) + '</td><td>' + x.f + '</td></tr>').join('') + '</table></div><div class="panel"><h4>Flows Terbaru</h4><table><tr><th>Waktu</th><th>Src → Dst</th><th>Proto</th><th>Bytes</th></tr>' + r.rows.slice(0, 30).map((x) => '<tr><td style="white-space:nowrap">' + esc(x.ts) + '</td><td>' + esc(x.src_ip) + ':' + x.src_port + ' → ' + esc(x.dst_ip) + ':' + x.dst_port + '</td><td>' + pill(x.proto) + '</td><td>' + fmtInt(x.bytes) + '</td></tr>').join('') + '</table></div></div>';
}
async function vDisc() {
  app.innerHTML = shell('<div class="panel"><span class="spin"></span> Memuat discovery...</div>', 'disc');
  const h = await api('/api/discovery');
  document.getElementById('c').innerHTML = '<div class="panel"><h4>Auto-Discovery <span class="sub">ping-sweep subnet</span></h4><div class="toolbar"><input id="ds" value="10.10.1"><input id="dl" value="30" style="width:80px"><button class="btn sm" onclick="runDisc()">Scan</button></div><table><tr><th>ID</th><th>Waktu</th><th>Subnet</th><th>Ditemukan</th></tr>' + h.map((x) => '<tr><td>' + x.id + '</td><td>' + esc(x.ts) + '</td><td>' + esc(x.subnet) + '</td><td>' + x.found + '</td></tr>').join('') + '</table></div>';
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
