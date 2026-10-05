'use strict';
/**
 * REST API discovery kanal WiFi + info jaringan lokal + speedtest.
 *  GET  /api/wifi                 -> snapshot scan terakhir (kanal 2.4 & 5 GHz + rekomendasi)
 *  POST /api/wifi/scan            -> jalankan pemindaian baru (admin/operator, deep=0|1)
 *  GET  /api/wifi/history?limit=  -> riwayat scan
 *  GET  /api/wifi/networks?band=  -> daftar AP/BSSID terakhir
 *  GET  /api/network/local        -> interface & subnet lokal (dipakai default halaman Discovery)
 *  GET  /api/speedtest            -> hasil speedtest terakhir + riwayat
 *  POST /api/speedtest            -> jalankan speedtest (admin/operator, target=/pings opsional)
 */
const { db } = require('./db');
const { localIfaces, localSubnet } = require('./net-scan');

function audit(msg, src) {
  try { db.prepare("INSERT INTO events(source,facility,severity,message) VALUES (?, 'audit','info',?)").run(src || 'system', msg); } catch {}
}

async function wifiRoutes(req, res, u, m, p, needAuth, send, getBody) {
  if (p === '/api/wifi' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const { latestAnalysis } = require('./wifi');
    send(res, 200, latestAnalysis()); return true;
  }
  if (p === '/api/wifi/scan' && m === 'POST') {
    const s = needAuth(req, res, ['admin', 'operator']); if (!s) return true;
    const { scanWifi, analyze, saveScan } = require('./wifi');
    const b = await getBody(req).catch(() => ({}));
    const scan = await scanWifi({ deep: b.deep === true || b.deep === 1 || u.searchParams.get('deep') === '1' });
    const full = { ...scan, ...analyze(scan.networks, scan.connected) };
    if (scan.ok) {
      saveScan(full);
      audit(`Scan kanal WiFi${scan.deep ? ' mendalam' : ''} oleh ${s.username}: ${scan.counts.total} AP (2.4GHz ${scan.counts.b24}, 5GHz ${scan.counts.b5})`, s.username);
    }
    send(res, 200, full); return true;
  }
  if (p === '/api/wifi/history' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const limit = Math.min(100, Math.max(1, Number(u.searchParams.get('limit') || 20)));
    send(res, 200, db.prepare('SELECT id,ts,platform,adapter,source,total,n24,n5 FROM wifi_scans ORDER BY id DESC LIMIT ?').all(limit)); return true;
  }
  if (p === '/api/wifi/networks' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const band = u.searchParams.get('band');
    const rows = band
      ? db.prepare('SELECT * FROM wifi_networks WHERE band=? ORDER BY channel, signal DESC').all(band)
      : db.prepare('SELECT * FROM wifi_networks ORDER BY band, channel, signal DESC').all();
    send(res, 200, rows); return true;
  }
  if (p === '/api/network/local' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const ifaces = localIfaces();
    send(res, 200, { subnet: localSubnet(), interfaces: ifaces }); return true;
  }
  if (p === '/api/speedtest' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const { latestSpeedtest } = require('./speedtest');
    send(res, 200, latestSpeedtest()); return true;
  }
  if (p === '/api/speedtest' && m === 'POST') {
    const s = needAuth(req, res); if (!s) return true;
    const b = await getBody(req).catch(() => ({}));
    const { runSpeedtest } = require('./speedtest');
    const r = await runSpeedtest({ pings: b.pings, bytesDown: b.bytesDown, bytesUp: b.bytesUp, target: b.target });
    if (r.ok) audit(`Speedtest oleh ${s.username} (${s.role}): ${r.iface || ''} ${r.local_ip || ''} ping ${r.ping.avg} ms jitter ${r.ping.jitter} ms down ${r.down.mbps} Mbps up ${r.up.mbps} Mbps`, s.username);
    send(res, 200, r); return true;
  }
  // ---- alat diagnostik: boleh semua role (viewer included) ----
  if (p === '/api/net/ping' && m === 'POST') {
    const s = needAuth(req, res); if (!s) return true;
    const b = await getBody(req).catch(() => ({}));
    const { pingTool } = require('./net-tools');
    const r = await pingTool(b.target || b.ip || '8.8.8.8', b.count);
    audit(`Ping ${r.target || '?'} oleh ${s.username} (${s.role}): ` + (r.stats ? `${r.stats.received}/${r.count} ok, avg ${r.stats.avg} ms` : (r.error || 'gagal')), s.username);
    send(res, 200, r); return true;
  }
  if (p === '/api/net/trace' && m === 'POST') {
    const s = needAuth(req, res); if (!s) return true;
    const b = await getBody(req).catch(() => ({}));
    const { traceTool } = require('./net-tools');
    const r = await traceTool(b.target || b.ip || '8.8.8.8', b.max_hops);
    audit(`Traceroute ${r.target || '?'} oleh ${s.username} (${s.role})`, s.username);
    send(res, 200, r); return true;
  }
  if (p === '/api/net/routes' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const { routePrint } = require('./net-tools');
    send(res, 200, await routePrint()); return true;
  }
  if (p === '/api/net/active' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return true;
    const { activeConn } = require('./net-tools');
    send(res, 200, await activeConn()); return true;
  }
  return false;
}

module.exports = { wifiRoutes };
