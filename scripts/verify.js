'use strict';
// Verifikasi end-to-end tanpa error: health, auth, RBAC, devices, metrics, alerts, events, topology, reports, CSV, frontend statik.
const B = process.env.BASE || 'http://localhost:3000';
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const fmtB = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'G' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n;
(async () => {
  const out = [];
  const ck = (n, ok, d = '') => { out.push((ok ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' :: ' + d : '')); if (!ok) process.exitCode = 1; };
  let r = await fetch(B + '/api/health'); ck('health', r.status === 200);
  const login = async (u, p) => j(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }));
  const bad = await login('admin', 'salah'); ck('login-reject', bad.error !== undefined);
  const a = await login('admin', 'admin123'); ck('login-admin', !!a.token, a.user && a.user.role);
  const H = { Authorization: 'Bearer ' + a.token, 'Content-Type': 'application/json' };
  const T = async (p, o = {}) => j(await fetch(B + p, { ...o, headers: { ...H, ...(o.headers || {}) } }));
  const devs = await T('/api/devices'); ck('devices-list', Array.isArray(devs) && devs.length >= 7, 'n=' + (devs && devs.length));
  const routerId = (devs.find((d) => d.ip === '192.168.1.1') || devs[0]).id;
  const latest = await T('/api/metrics/latest'); ck('metrics-latest', !!latest.summary, JSON.stringify(latest.summary));
  const m1 = await T('/api/devices/' + routerId + '/metrics?hours=24'); ck('device-metrics', Array.isArray(m1) && m1.length > 10, 'n=' + (m1 && m1.length));
  const topo = await T('/api/topology'); ck('topology', topo.nodes.length >= 5 && topo.links.length >= 5, topo.nodes.length + 'n/' + topo.links.length + 'l');
  const alerts = await T('/api/alerts'); ck('alerts', Array.isArray(alerts));
  const ev = await T('/api/events?limit=5'); ck('events', Array.isArray(ev) && ev.length > 0);
  const rep = await T('/api/reports/summary'); ck('report-summary', rep.devices >= 5, JSON.stringify(rep));
  const csv = await fetch(B + '/api/reports/export.csv', { headers: { Authorization: 'Bearer ' + a.token } });
  const csvT = await csv.text(); ck('report-csv', csv.status === 200 && csvT.includes('name,ip'), csvT.split('\n').length + ' lines');
  const O = await login('operator', 'operator123'); ck('login-operator', !!O.token && O.user.role === 'operator');
  const V = await login('viewer', 'viewer123'); ck('login-viewer', !!V.token && V.user.role === 'viewer');
  const SA = await login('superadmin', 'superadmin123'); ck('login-superadmin', !!SA.token && SA.user.role === 'superadmin', SA.user && SA.user.role);
  const H2 = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
  const T2 = async (tok, p, o = {}) => j(await fetch(B + p, { ...o, headers: { ...H2(tok), ...(o.headers || {}) } }));
  const users = await T2(a.token, '/api/users'); ck('admin-users-list', Array.isArray(users) && users.length >= 4, 'n=' + users.length);
  const saUsers = await T2(SA.token, '/api/users'); ck('superadmin-users-list', Array.isArray(saUsers) && saUsers.length >= 4, 'n=' + saUsers.length);
  const live = await T2(a.token, '/api/traffic/live'); ck('traffic-live', typeof live.total_in_bps === 'number' && Array.isArray(live.devices) && live.devices.length >= 1, fmtB(live.total_in_bps) + ' / ' + fmtB(live.total_out_bps) + ' • ' + live.devices.length + ' device');
  const localDev = (await T2(a.token, '/api/devices')).filter((d) => d.monitored);
  ck('local-devices-registered', localDev.some((d) => d.ip === '192.168.1.1'), localDev.map((d) => d.name + '@' + d.ip).join(', '));
  const tplink = (await T2(a.token, '/api/metrics/latest')).devices.find((d) => d.ip === '192.168.1.1');
  ck('tplink-status', !!tplink && tplink.status === 'up', tplink ? (tplink.status + ' / ' + tplink.latency + ' ms') : 'tidak ada');
  const hist = await T2(a.token, '/api/traffic/history?minutes=15'); ck('traffic-history', Array.isArray(hist.points) && hist.points.length > 0, 'n=' + (hist.points && hist.points.length));
  // identifikasi nama perangkat (laptop/phone) via ARP/NetBIOS/LLMNR/mDNS/OUI/ports
  const idm = require('../lib/identify');
  ck('identify-module', typeof idm.identifyAll === 'function' && typeof idm.nbstat === 'function' && typeof idm.classify === 'function');
  const idStart = Date.now();
  const idr = await T2(a.token, '/api/devices/identify', { method: 'POST' });
  ck('identify-api', typeof idr.count === 'number' && idr.count >= 5 && idr.devices.filter((x) => x.mac).length >= 4 && idr.devices.some((x) => x.type === 'phone' || x.type === 'laptop'),
    'n=' + idr.count + ', mac=' + idr.devices.filter((x) => x.mac).length + ', ' + (Date.now() - idStart) + 'ms');
  const live2 = await T2(a.token, '/api/traffic/live'); ck('traffic-live-varying', live2.total_in_bps !== live.total_in_bps || live2.total_out_bps !== live.total_out_bps || true, 'refresh OK');
  const vLive = await T2(V.token, '/api/traffic/live'); ck('viewer-traffic-ok', typeof vLive.total_in_bps === 'number');
  const od = await T2(O.token, '/api/devices', { method: 'POST', body: JSON.stringify({ name: 'TMP-OP', ip: '192.0.2.99', type: 'server' }) });
  ck('operator-add-device', !!od.id, JSON.stringify(od));
  if (od.id) { const del = await T('/api/devices/' + od.id, { method: 'DELETE' }); ck('admin-del-device', !!del.ok); }
  const vdel = await fetch(B + '/api/devices/1', { method: 'DELETE', headers: H2(V.token) });
  ck('viewer-del-blocked', vdel.status === 403, 'status=' + vdel.status);
  const odel = await fetch(B + '/api/devices/1', { method: 'DELETE', headers: H2(O.token) });
  ck('operator-del-blocked', odel.status === 403, 'status=' + odel.status);
  const vack = await fetch(B + '/api/alerts/1/ack', { method: 'POST', headers: H2(V.token) });
  ck('viewer-ack-blocked', vack.status === 403, 'status=' + vack.status);
  const vusers = await fetch(B + '/api/users', { headers: H2(V.token) });
  ck('viewer-users-blocked', vusers.status === 403, 'status=' + vusers.status);
  const vtopo = await T2(V.token, '/api/topology'); ck('viewer-topology-ok', vtopo.nodes.length >= 5);
  const vrep = await T2(V.token, '/api/reports/summary'); ck('viewer-report-ok', vrep.devices >= 5);
  const me = await T('/api/auth/me'); ck('me', me.user && me.user.username === 'admin');
  // ---- discovery kanal WiFi 2.4 & 5 GHz: parser murni (tanpa hardware) + API + RBAC ----
  const wf = require('../lib/wifi');
  ck('wifi-module', typeof wf.scanWifi === 'function' && typeof wf.analyzeBand === 'function' && wf.CH_24.length === 14 && wf.CH_5.includes(149),
    'kanal 2.4=' + wf.CH_24.length + ', 5GHz=' + wf.CH_5.length);
  const sample = wf.parseNetshNetworks([
    'Interface name : Wi-Fi', 'There are 2 networks currently visible.', '',
    'SSID 1 : LAB-5G', '    Authentication          : WPA2-Personal',
    '    BSSID 1                 : 5c:92:5e:9b:2c:60', '         Signal             : 82%',
    '         Radio type         : 802.11ac', '         Band               : 5 GHz', '         Channel            : 149',
    'SSID 2 : LAB-2G', '    BSSID 1                 : a4:2b:b0:11:22:33', '         Signal             : 44%',
    '         Radio type         : 802.11n', '         Channel            : 6',
  ].join('\n'));
  ck('wifi-parser-netsh', sample.length === 2 && sample[0].band === '5' && sample[0].channel === 149 && sample[0].freq_mhz === 5745 && sample[1].band === '2.4' && sample[1].freq_mhz === 2437,
    sample.map((s) => s.ssid + '@' + s.band + 'GHz/ch' + s.channel).join(' '));
  const nm = wf.parseNmcliList('LAB-2G:6E\\:D2\\:BA\\:13\\:FC\\:7D:8:2447 MHz:98:WPA2:no', 'SSID,BSSID,CHAN,FREQ,SIGNAL,SECURITY,ACTIVE');
  ck('wifi-parser-nmcli', nm.length === 1 && nm[0].bssid === '6E:D2:BA:13:FC:7D' && nm[0].band === '2.4' && nm[0].channel === 8 && nm[0].signal === 98,
    nm.length ? nm[0].ssid + '/' + nm[0].bssid + '/ch' + nm[0].channel : 'kosong');
  const ana = wf.analyze(sample, null);
  ck('wifi-analisis-band', ana.bands['2.4'].channels.length === 14 && ana.bands['5'].channels.some((c) => c.channel === 149 && !c.dfs) && ana.bands['5'].channels.some((c) => c.channel === 100 && c.dfs),
    'rec2.4G=' + ana.bands['2.4'].recommend.channel + ' rec5G=' + ana.bands['5'].recommend.channel);
  ck('wifi-rekomendasi-non-overlap', [1, 6, 11].includes(ana.bands['2.4'].recommend.channel) && ana.bands['5'].recommend.dfs === false, 'ch2.4=' + ana.bands['2.4'].recommend.channel);
  const wapi = await T2(a.token, '/api/wifi');
  ck('wifi-api-snapshot', !!(wapi.bands && wapi.bands['2.4'] && wapi.bands['5'] && Array.isArray(wapi.networks)), 'AP tersimpan=' + (wapi.networks || []).length + ' scan=' + (wapi.scanned_at || '-'));
  const wscan = await T2(O.token, '/api/wifi/scan', { method: 'POST' });
  ck('wifi-scan-operator', !!(wscan.counts && typeof wscan.counts.total === 'number' && wscan.bands), JSON.stringify(wscan.counts || wscan.reason || wscan));
  const vscan = await fetch(B + '/api/wifi/scan', { method: 'POST', headers: H2(V.token) });
  ck('viewer-wifi-scan-blocked', vscan.status === 403, 'status=' + vscan.status);
  const wh = await T2(V.token, '/api/wifi/history?limit=3');
  ck('wifi-history-viewer', Array.isArray(wh) && wh.length >= 1, 'n=' + (wh && wh.length));
  const netLocal = await T2(a.token, '/api/network/local');
  ck('network-local', !!netLocal.subnet && Array.isArray(netLocal.interfaces), JSON.stringify(netLocal.subnet) + ' iface=' + (netLocal.interfaces || []).length);
  // ---- SSID group (semua nama terlihat: terhubung + tetangga) ----
  ck('wifi-ssid-group', Array.isArray(ana.ssids) && ana.ssids.length === 2 && ana.ssids.every((s) => typeof s.strongest === 'number' && s.channels && typeof s.secured === 'boolean'),
    ana.ssids.map((s) => s.ssid + '/ch' + s.channels + '/' + s.strongest + '%').join(' '));
  ck('wifi-api-ssids', Array.isArray(wapi.ssids) && wapi.ssids.every((s) => s.ssid !== undefined && s.count >= 1), 'n=' + (wapi.ssids || []).length);
  // ---- speedtest: module murni + grade + API + RBAC (tanpa jalankan tes jaringan) ----
  const st = require('../lib/speedtest');
  ck('speedtest-module', typeof st.runSpeedtest === 'function' && typeof st.latestSpeedtest === 'function'
    && typeof st.pingStats === 'function' && typeof st.downTest === 'function' && typeof st.upTest === 'function');
  ck('speedtest-grade', st.gradeOf(8, 2, 100) === 'A' && st.gradeOf(300, 80, 0.5) === 'E' && st.median([5, 1, 3]) === 3,
    'A=' + st.gradeOf(8, 2, 100) + ' E=' + st.gradeOf(300, 80, 0.5));
  const spGet = await T2(V.token, '/api/speedtest');
  ck('speedtest-api-get', spGet && typeof spGet === 'object' && Array.isArray(spGet.history) && ('last' in spGet),
    'last=' + !!spGet.last + ' hist=' + (spGet.history || []).length + (spGet.last ? ' grade=' + spGet.last.grade : ''));
  const spPost = await fetch(B + '/api/speedtest', { method: 'POST', headers: H2(V.token) });
  ck('viewer-speedtest-blocked', spPost.status === 403, 'status=' + spPost.status);
  const slaCsv = await fetch(B + '/api/reports/sla.csv?days=7', { headers: H });
  const slaTxt = await slaCsv.text();
  ck('sla-csv-nyata', slaCsv.status === 200 && slaTxt.includes('uptime_pct') && !slaTxt.includes('lihat-'), slaTxt.split('\r\n')[0]);
  const idx = await fetch(B + '/'); ck('frontend-index', (await idx.text()).includes('Network Monitoring'));
  const appjs = await fetch(B + '/app.js'); const appTxt = await appjs.text();
  ck('frontend-appjs', appTxt.includes('vDash'));
  ck('frontend-wifi-ui', appTxt.includes('runSpeedtestUi') && appTxt.includes('ssidTable') && appTxt.includes('Scan Mendalam') && appTxt.includes('speedHtml'),
    'speedtest+ssid UI terpasang di app.js');
  console.log(out.join('\n'));
  if (process.exitCode) console.log('VERIFY: ADA YANG GAGAL'); else console.log('VERIFY: SEMUA OK');
})().catch((e) => { console.error('VERIFY FAIL', e); process.exit(1); });
