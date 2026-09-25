'use strict';
const http = require('node:http');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, hash, verifyPw } = require('./lib/db');
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'nms-dev-secret-change-me';
const b64u = {
  enc: (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
};
function sign(p, expH = 12) {
  const b = b64u.enc(JSON.stringify({ ...p, exp: Date.now() + expH * 3600e3 }));
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verify(t) {
  try {
    const [b, s] = t.split('.');
    const e = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
    const p = JSON.parse(b64u.dec(b));
    if (p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function getBody(req) {
  return new Promise((res) => {
    let d = ''; req.on('data', (c) => (d += c));
    req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { res({}); } });
  });
}
function needAuth(req, res, roles) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) { send(res, 401, { error: 'Unauthorized' }); return null; }
  const p = verify(t);
  if (!p) { send(res, 401, { error: 'Token invalid' }); return null; }
  if (roles && !roles.includes(p.role)) {
    // superadmin boleh lewat semua proteksi role
    if (p.role !== 'superadmin') { send(res, 403, { error: 'Forbidden' }); return null; }
  }
  return p;
}
function audit(msg, src) {
  try { db.prepare("INSERT INTO events(source,facility,severity,message) VALUES (?, 'audit','info',?)").run(src || 'system', msg); } catch {}
}
async function router(req, res) {
  const u = new URL(req.url, 'http://x');
  const m = req.method; const p = u.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (m === 'GET' && (p === '/' || p === '/index.html' || p === '/app.js' || p === '/style.css')) {
    const f = p === '/' ? '/public/index.html' : '/public' + p;
    const fp = path.join(__dirname, f);
    try {
      if (fs.existsSync(fp)) {
        const data = fs.readFileSync(fp);
        const ct = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(fp)] || 'text/plain';
        res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
        res.end(data);
        return;
      }
    } catch (e) { return send(res, 500, { error: 'Gagal baca file statik' }); }
  }
  if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, time: new Date().toISOString() });
  if (m === 'POST' && p === '/api/auth/login') {
    const { username, password } = await getBody(req);
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!user || !verifyPw(password || '', user.password)) return send(res, 401, { error: 'Kredensial salah' });
    const token = sign({ id: user.id, username: user.username, role: user.role });
    audit('Login sukses: ' + username, username);
    return send(res, 200, { token, user: { id: user.id, username: user.username, role: user.role } });
  }
  if (m === 'GET' && p === '/api/auth/me') {
    const s = needAuth(req, res); if (!s) return;
    return send(res, 200, { user: db.prepare('SELECT id,username,role,email FROM users WHERE id=?').get(s.id) });
  }
  if (p === '/api/users' && m === 'GET') {
    const s = needAuth(req, res, ['admin']); if (!s) return;
    return send(res, 200, db.prepare('SELECT id,username,role,email,created_at FROM users').all());
  }
  if (p === '/api/users' && m === 'POST') {
    const s = needAuth(req, res, ['admin']); if (!s) return;
    const b = await getBody(req);
    if (!b.username || !b.password) return send(res, 400, { error: 'username & password wajib' });
    if (b.role && !['superadmin', 'admin', 'operator', 'viewer'].includes(b.role)) return send(res, 400, { error: 'role tidak valid' });
    try {
      const r = db.prepare('INSERT INTO users(username,password,role,email) VALUES (?,?,?,?)').run(b.username, hash(b.password), b.role || 'viewer', b.email || null);
      audit('User dibuat: ' + b.username, s.username);
      return send(res, 201, { id: Number(r.lastInsertRowid) });
    } catch { return send(res, 400, { error: 'Username sudah ada' }); }
  }
  const um = p.match(/^\/api\/users\/(\d+)$/);
  if (um) {
    const s = needAuth(req, res, ['admin']); if (!s) return;
    const uid = um[1];
    if (m === 'PUT' || m === 'PATCH') {
      const b = await getBody(req);
      if (b.role && !['superadmin', 'admin', 'operator', 'viewer'].includes(b.role)) return send(res, 400, { error: 'role tidak valid' });
      if (b.username) db.prepare('UPDATE users SET username=? WHERE id=?').run(b.username, uid);
      if (b.role) db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, uid);
      if (b.email !== undefined) db.prepare('UPDATE users SET email=? WHERE id=?').run(b.email, uid);
      if (b.password) db.prepare('UPDATE users SET password=? WHERE id=?').run(hash(b.password), uid);
      audit('User #' + uid + ' diubah', s.username);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      if (Number(uid) === s.id) return send(res, 400, { error: 'Tidak bisa hapus akun sendiri' });
      db.prepare('DELETE FROM users WHERE id=?').run(uid);
      audit('User #' + uid + ' dihapus', s.username);
      return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/devices' && m === 'GET') {
    const s = needAuth(req, res); if (!s) return;
    const q = (u.searchParams.get('q') || '').toLowerCase();
    let rows = db.prepare('SELECT * FROM devices ORDER BY monitored DESC, id').all();
    if (q) rows = rows.filter((d) => ((d.name || '') + (d.ip || '') + (d.type || '')).toLowerCase().includes(q));
    return send(res, 200, rows);
  }
  if (p === '/api/devices' && m === 'POST') {
    const s = needAuth(req, res, ['admin', 'operator']); if (!s) return;
    const b = await getBody(req);
    if (!b.name || !b.ip) return send(res, 400, { error: 'name & ip wajib' });
    const r = db.prepare('INSERT INTO devices(name,ip,type,vendor,snmp_version,snmp_community,snmp_protocol,status,monitored) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(b.name, b.ip, b.type || 'server', b.vendor || '', b.snmp_version || 'v2c', b.snmp_community || 'public', b.snmp_protocol || 'ssh', 'unknown', b.monitored === undefined ? 1 : (b.monitored ? 1 : 0));
    audit('Device ditambah: ' + b.name, s.username);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  // ROUTES2
  const { deviceRoutes } = require('./lib/api-devices');
  const { miscRoutes, reportCsv } = require('./lib/api-misc');
  if (await deviceRoutes(req, res, u, m, p, needAuth, send, getBody)) return;
  if (await miscRoutes(req, res, u, m, p, needAuth, send, getBody)) return;
  if (await reportCsv(req, res, p, m, needAuth)) return;
  return send(res, 404, { error: 'Not found' });
}
const server = http.createServer(router);
if (require.main === module) server.listen(PORT, () => console.log('[NMS API] http://localhost:' + PORT));
module.exports = { server, sign, verify };

