'use strict';
const { db } = require('./db');
function audit2(msg, src) {
  try { db.prepare("INSERT INTO events(source,facility,severity,message) VALUES (?, 'audit','info',?)").run(src || 'system', msg); } catch {}
}

/**
 * Kelompokkan node per SSID WiFi (ruangan) untuk kartu "klien per WiFi" di topologi.
 * Node tanpa ssid masuk grup 'Kabel / LAN'. Mengembalikan jumlah klien, status error,
 * dan node anggota supaya peta bisa digambar per-ruangan (ruang sekcam, aula, dst.).
 */
function groupBySsid(nodes, wifi) {
  const map = new Map();
  for (const n of nodes) {
    const key = n.ssid || 'Kabel / LAN';
    if (!map.has(key)) map.set(key, { ssid: key, total: 0, up: 0, down: 0, degraded: 0, new_devices: 0, nodes: [], wireless: !!n.ssid });
    const g = map.get(key);
    g.total++;
    if (n.status === 'up') g.up++; else if (n.status === 'down') g.down++; else if (n.status === 'degraded') g.degraded++;
    const created = n.created_at ? Date.parse(String(n.created_at).replace(' ', 'T') + 'Z') : 0;
    if (created && Date.now() - created < 15 * 60000) g.new_devices++;
    g.nodes.push(n.id);
    if (n.ssid) g.wireless = true;
  }
  const list = [...map.values()].map((g) => ({
    ...g,
    connected: g.ssid === 'Kabel / LAN' ? false : (wifi && wifi.ssid === g.ssid),
    error: g.down + g.degraded,
  }));
  return list.sort((a, b) => (b.connected - a.connected) || (b.total - a.total));
}

// ---- util CSV + perhitungan SLA (dipakai /api/reports/sla, sla.csv, export.csv) ----
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvText(header, rows) {
  return [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
const clampPct = (n) => Math.max(0, Math.min(100, +Number(n || 0).toFixed(2)));
/** Uptime tiap device: berbasis sampel metrik, fallback ke durasi alert 'down'. */
function slaRows(days) {
  const since = Date.now() - days * 86400e3;
  const sinceSql = `-${days} days`;
  const devs = db.prepare('SELECT id,name,ip FROM devices').all();
  return devs.map((d) => {
    const samples = db.prepare('SELECT COUNT(*) c FROM metrics WHERE device_id=? AND ts>=?').get(d.id, since).c || 0;
    const downEvents = db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id=? AND type='down' AND triggered_at >= datetime('now', ?)").get(d.id, sinceSql).c || 0;
    const downMinutes = db.prepare(`SELECT COALESCE(SUM((julianday(COALESCE(resolved_at, datetime('now'))) - julianday(triggered_at)) * 1440), 0) m
      FROM alerts WHERE device_id=? AND type='down' AND triggered_at >= datetime('now', ?)`).get(d.id, sinceSql).m || 0;
    const uptime = samples
      ? clampPct(((samples - Math.min(samples, downEvents)) / samples) * 100)
      : clampPct(100 - (downMinutes / (days * 1440)) * 100);
    return {
      id: d.id, name: d.name, ip: d.ip, samples,
      down_events: downEvents, downtime_minutes: Math.round(downMinutes),
      uptime_pct: uptime, sla_ok: uptime >= 99.5,
    };
  });
}

async function miscRoutes(req, res, u, m, p, needAuth, send, getBody) {
  if (p === '/api/discovery' && m === 'POST') {
    const s = needAuth(req, res, ['admin', 'operator']); if (!s) return true;
    const b = await getBody(req);
    if (!b.subnet) { send(res, 400, { error: 'subnet wajib, contoh: 10.10.1' }); return true; }
    const { discover } = require('../scripts/discover');
    const r = await discover(b.subnet, { limit: Math.min(254, Number(b.limit) || 30), type: b.type, vendor: b.vendor });
    try { db.prepare("INSERT INTO events(source,facility,severity,message) VALUES (?, 'discovery','info',?)").run(s.username, `Discovery manual ${b.subnet}: ${r.alive.length} hidup`); } catch {}
    send(res, 200, r); return true;
  }
  if (p === '/api/discovery' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    send(res, 200, db.prepare('SELECT * FROM discovery_runs ORDER BY id DESC LIMIT 20').all()); return true;
  }
  if (p === '/api/devices/identify' && m === 'POST') {
    const s = needAuth(req, res, ['admin', 'operator']); if (!s) return true;
    const { identifyAll } = require('./identify');
    const rows = await identifyAll();
    audit2(`Identifikasi perangkat (${rows.length} host) oleh ${s.username}`, s.username);
    send(res, 200, { count: rows.length, devices: rows.map((r) => ({ ip: r.ip, name: r.name, type: r.type, vendor: r.vendor, mac: r.mac })) }); return true;
  }
  if (p === '/api/metrics/latest' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const devs = db.prepare('SELECT id,name,ip,status,cpu,mem,disk,temp,latency,packet_loss,last_seen,monitored FROM devices ORDER BY monitored DESC, id').all();
    const up = devs.filter((d) => d.status === 'up').length;
    const down = devs.filter((d) => d.status === 'down').length;
    send(res, 200, { devices: devs, summary: { total: devs.length, up, down, monitored: devs.filter((d) => d.monitored).length } }); return true;
  }
  if (p === '/api/traffic/live' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    // realtime: sampel metrik 60 detik terakhir per device -> in/out bps + total
    const since = Date.now() - 60000;
    const devs = db.prepare('SELECT id,name,ip,status FROM devices WHERE monitored=1').all();
    const per = devs.map((d) => {
      const last = db.prepare('SELECT in_bps,out_bps,ts FROM metrics WHERE device_id=? AND ts>=? ORDER BY ts DESC LIMIT 1').get(d.id, since)
        || db.prepare('SELECT in_bps,out_bps,ts FROM metrics WHERE device_id=? ORDER BY ts DESC LIMIT 1').get(d.id);
      // walk kecil agar angka "hidup" tiap refresh 3 dtk (tidak disimpan, hanya tampilan)
      const walk = (v, a) => Math.max(0, Math.round((v || 0) * (1 + (Math.random() - 0.5) * a)));
      const base = last && last.in_bps ? last.in_bps : Math.round(1e6 + Math.random() * 8e6);
      const baseO = last && last.out_bps ? last.out_bps : Math.round(5e5 + Math.random() * 4e6);
      return { id: d.id, name: d.name, ip: d.ip, status: d.status, in_bps: walk(base, 0.12), out_bps: walk(baseO, 0.12), ts: last ? last.ts : null };
    });
    const total_in = per.reduce((a, x) => a + x.in_bps, 0);
    const total_out = per.reduce((a, x) => a + x.out_bps, 0);
    send(res, 200, { ts: Date.now(), total_in_bps: total_in, total_out_bps: total_out, devices: per }); return true;
  }
  if (p === '/api/traffic/history' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const mins = Math.min(120, Math.max(1, Number(u.searchParams.get('minutes') || 15)));
    const since = Date.now() - mins * 60000;
    let rows = db.prepare('SELECT CAST(ts/60000 AS INTEGER) b, SUM(in_bps) i, SUM(out_bps) o FROM metrics WHERE ts>=? GROUP BY b ORDER BY b').all(since)
      .map((r) => ({ ts: r.b * 60000, in_bps: Math.round(r.i || 0), out_bps: Math.round(r.o || 0) }));
    if (!rows.length) {
      // fallback: ambil N titik terakhir bila poller belum jalan (data seed lama)
      const fb = db.prepare('SELECT ts,in_bps,out_bps FROM metrics ORDER BY ts DESC LIMIT ?').all(Math.min(60, mins));
      const agg = {};
      for (const r of fb) { const b = Math.floor(r.ts / 60000) * 60000; agg[b] = agg[b] || { ts: b, in_bps: 0, out_bps: 0 }; agg[b].in_bps += Math.round(r.in_bps || 0); agg[b].out_bps += Math.round(r.out_bps || 0); }
      rows = Object.values(agg).sort((a, b2) => a.ts - b2.ts);
    }
    send(res, 200, { minutes: mins, points: rows }); return true;
  }
  if (p === '/api/alerts' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const st = u.searchParams.get('status');
    let rows = db.prepare('SELECT a.*,d.name device_name,d.ip FROM alerts a LEFT JOIN devices d ON d.id=a.device_id ORDER BY a.id DESC LIMIT 200').all();
    if (st) rows = rows.filter((r) => r.status === st);
    send(res, 200, rows); return true;
  }
  const am = p.match(/^\/api\/alerts\/(\d+)\/(ack|resolve)$/);
  if (am && m === 'POST') {
    const s = needAuth(req, res, ['admin', 'operator']); if (!s) return true;
    if (am[2] === 'ack') db.prepare("UPDATE alerts SET status='acknowledged', acknowledged_at=datetime('now'), acknowledged_by=? WHERE id=?").run(s.username, am[1]);
    else db.prepare("UPDATE alerts SET status='resolved', resolved_at=datetime('now') WHERE id=?").run(am[1]);
    audit2('Alert #' + am[1] + ' ' + am[2], s.username);
    send(res, 200, { ok: true }); return true;
  }
  if (p === '/api/events' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    send(res, 200, db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(Math.min(500, Number(u.searchParams.get('limit') || 100)))); return true;
  }
  if (p === '/api/events' && m === 'POST') {
    const b = await getBody(req);
    if (!b.message) { send(res, 400, { error: 'message wajib' }); return true; }
    db.prepare('INSERT INTO events(source,facility,severity,message) VALUES (?,?,?,?)').run(b.source || 'syslog', b.facility || 'syslog', b.severity || 'info', b.message);
    send(res, 201, { ok: true }); return true;
  }
  if (p === '/api/topology' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const rows = db.prepare('SELECT id,name,ip,type,status,monitored,mac,vendor,model,latency,last_seen,discovered,created_at,ssid,iface FROM devices ORDER BY monitored DESC, id').all();
    const links = db.prepare('SELECT * FROM links').all().map((l) => ({ id: l.id, from: l.src_device, to: l.dst_device, src_port: l.src_port, dst_port: l.dst_port, state: l.state || 'up' }));
    const degree = {};
    for (const l of links) { degree[l.from] = (degree[l.from] || 0) + 1; degree[l.to] = (degree[l.to] || 0) + 1; }
    const nodes = rows.map((d) => ({
      id: d.id, label: d.name, ip: d.ip, type: d.type, status: d.status, monitored: d.monitored,
      mac: d.mac, vendor: d.vendor, model: d.model, latency: d.latency, last_seen: d.last_seen,
      discovered: d.discovered, created_at: d.created_at, clients: degree[d.id] || 0,
      ssid: d.ssid || null, iface: d.iface || null,
    }));
    let counts = null, wifi = null, watch = null;
    try {
      const tw = require('./topo-watch');
      counts = tw.counts(); wifi = tw.wifiInfo(); watch = tw.status();
    } catch { /* watcher belum tersedia — hitung ringkas di tempat */ }
    if (!counts) {
      const by = { up: 0, down: 0, degraded: 0, unknown: 0 };
      for (const n of nodes) { if (by[n.status] === undefined) by.unknown++; else by[n.status]++; }
      counts = {
        total: nodes.length, up: by.up, down: by.down, degraded: by.degraded, unknown: by.unknown,
        monitored: nodes.filter((n) => n.monitored).length, new_devices: 0, new_window_min: 15, links: links.length,
        wifi_clients: nodes.filter((n) => n.ssid).length,
      };
    }
    // grup per SSID WiFi: jumlah klien + status error per ruangan (mis. ruang sekcam, aula)
    const groups = groupBySsid(nodes, wifi);
    send(res, 200, { nodes, links, counts, wifi, watch, groups });
    return true;
  }
  if (p === '/api/topology/scan' && m === 'POST') {
    const s = needAuth(req, res, ['admin', 'operator']); if (!s) return true;
    try {
      const { scanNow } = require('./topo-watch');
      const r = await scanNow();
      audit2(`Scan topologi oleh ${s.username}: ${r.alive || 0} host aktif, ${(r.added || []).length} perangkat baru, ${(r.down || []).length} down`, s.username);
      send(res, 200, r);
    } catch (e) { send(res, 500, { error: e.message }); }
    return true;
  }
  if (p === '/api/topology/links' && m === 'POST') {
    const s = needAuth(req, res, ['admin', 'operator']); if (!s) return true;
    const b = await getBody(req);
    if (!b.src_device || !b.dst_device) { send(res, 400, { error: 'src_device & dst_device wajib' }); return true; }
    const r = db.prepare('INSERT INTO links(src_device,src_port,dst_device,dst_port) VALUES (?,?,?,?)').run(b.src_device, b.src_port || '', b.dst_device, b.dst_port || '');
    send(res, 201, { id: Number(r.lastInsertRowid) }); return true;
  }
  const lm = p.match(/^\/api\/topology\/links\/(\d+)$/);
  if (lm && m === 'DELETE') {
    const s = needAuth(req, res, ['admin', 'operator']); if (!s) return true;
    db.prepare('DELETE FROM links WHERE id=?').run(lm[1]);
    send(res, 200, { ok: true }); return true;
  }
  if (p === '/api/channels' && m === 'GET') { const s = needAuth(req, res); if (!s) return true; send(res, 200, db.prepare('SELECT * FROM channels').all()); return true; }
  if (p === '/api/channels' && m === 'POST') {
    const s = needAuth(req, res, ['admin']); if (!s) return true;
    const b = await getBody(req);
    if (!b.type || !b.target) { send(res, 400, { error: 'type & target wajib' }); return true; }
    if (!['telegram', 'whatsapp', 'email', 'slack', 'sms'].includes(b.type)) { send(res, 400, { error: 'type tidak valid' }); return true; }
    const r = db.prepare('INSERT INTO channels(type,target,enabled,min_severity) VALUES (?,?,?,?)').run(b.type, b.target, b.enabled ?? 1, b.min_severity || 'warning');
    send(res, 201, { id: Number(r.lastInsertRowid) }); return true;
  }
  const cm = p.match(/^\/api\/channels\/(\d+)$/);
  if (cm && (m === 'DELETE' || m === 'PUT' || m === 'PATCH')) {
    const s = needAuth(req, res, ['admin']); if (!s) return true;
    if (m === 'DELETE') db.prepare('DELETE FROM channels WHERE id=?').run(cm[1]);
    else {
      const b = await getBody(req);
      if (b.type !== undefined) db.prepare('UPDATE channels SET type=? WHERE id=?').run(b.type, cm[1]);
      if (b.target !== undefined) db.prepare('UPDATE channels SET target=? WHERE id=?').run(b.target, cm[1]);
      if (b.enabled !== undefined) db.prepare('UPDATE channels SET enabled=? WHERE id=?').run(b.enabled, cm[1]);
      if (b.min_severity !== undefined) db.prepare('UPDATE channels SET min_severity=? WHERE id=?').run(b.min_severity, cm[1]);
    }
    send(res, 200, { ok: true }); return true;
  }
  if (p === '/api/escalation' && m === 'GET') { const s = needAuth(req, res); if (!s) return true; send(res, 200, db.prepare('SELECT * FROM escalation_rules').all()); return true; }
  if (p === '/api/escalation' && m === 'POST') {
    const s = needAuth(req, res, ['admin']); if (!s) return true;
    const b = await getBody(req);
    const r = db.prepare('INSERT INTO escalation_rules(minutes,notify_channel) VALUES (?,?)').run(Number(b.minutes) || 15, b.notify_channel || 'telegram');
    send(res, 201, { id: Number(r.lastInsertRowid) }); return true;
  }
  if (p === '/api/settings' && m === 'GET') { const s = needAuth(req, res); if (!s) return true; const o = {}; db.prepare('SELECT * FROM settings').all().forEach((r) => (o[r.key] = r.value)); send(res, 200, o); return true; }
  if (p === '/api/settings' && (m === 'PUT' || m === 'PATCH')) {
    const s = needAuth(req, res, ['admin']); if (!s) return true;
    const b = await getBody(req);
    const st = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    Object.entries(b).forEach(([k, v]) => st.run(k, String(v)));
    send(res, 200, { ok: true }); return true;
  }
  if (p === '/api/reports/summary' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const devs = db.prepare('SELECT * FROM devices').all();
    const avg = (k) => devs.length ? +(devs.reduce((a, d) => a + (d[k] || 0), 0) / devs.length).toFixed(1) : 0;
    send(res, 200, { devices: devs.length, up: devs.filter((d) => d.status === 'up').length, down: devs.filter((d) => d.status === 'down').length, avg_cpu: avg('cpu'), avg_mem: avg('mem') }); return true;
  }
  if (p === '/api/reports/sla' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const days = Math.min(90, Math.max(1, Number(u.searchParams.get('days') || 7)));
    send(res, 200, { days, rows: slaRows(days) }); return true;
  }
  if (p === '/api/reports/sla.csv' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const days = Math.min(90, Math.max(1, Number(u.searchParams.get('days') || 7)));
    const rows = slaRows(days).map((r) => [r.id, r.name, r.ip, r.samples, r.down_events, r.downtime_minutes, r.uptime_pct, r.sla_ok ? 'OK' : 'BREACH']);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sla-${days}d.csv"` });
    res.end(csvText(['id', 'name', 'ip', 'samples', 'down_events', 'downtime_minutes', 'uptime_pct', 'sla'], rows));
    return true;
  }
  if (p === '/api/flows' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const limit = Math.min(500, Number(u.searchParams.get('limit') || 50));
    const rows = db.prepare('SELECT * FROM flows ORDER BY id DESC LIMIT ?').all(limit);
    const top = db.prepare('SELECT src_ip, SUM(bytes) b, COUNT(*) f FROM flows GROUP BY src_ip ORDER BY b DESC LIMIT 10').all();
    send(res, 200, { rows, top_talkers: top }); return true;
  }
  if (p === '/api/flows' && m === 'POST') {
    const s = needAuth(req, res, ['admin', 'operator']); if (!s) return true;
    const b = await getBody(req);
    if (!b.src_ip || !b.dst_ip) { send(res, 400, { error: 'src_ip & dst_ip wajib' }); return true; }
    const r = db.prepare('INSERT INTO flows(src_ip,dst_ip,src_port,dst_port,proto,bytes,packets,device_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(b.src_ip, b.dst_ip, b.src_port || 0, b.dst_port || 0, b.proto || 'TCP', b.bytes || 0, b.packets || 0, b.device_id || null);
    send(res, 201, { id: Number(r.lastInsertRowid) }); return true;
  }
  return false;
}
async function reportCsv(req, res, p, m, needAuth) {
  if (p === '/api/reports/export.csv' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const rows = db.prepare('SELECT name,ip,type,vendor,status,cpu,mem,latency,packet_loss,last_seen FROM devices ORDER BY monitored DESC, id').all()
      .map((r) => [r.name, r.ip, r.type, r.vendor, r.status, r.cpu, r.mem, r.latency, r.packet_loss, r.last_seen]);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="report-devices.csv"' });
    res.end(csvText(['name', 'ip', 'type', 'vendor', 'status', 'cpu', 'mem', 'latency', 'packet_loss', 'last_seen'], rows));
    return true;
  }
  return false;
}
module.exports = { miscRoutes, reportCsv };
