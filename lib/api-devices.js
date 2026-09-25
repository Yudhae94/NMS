'use strict';
const { db } = require('./db');
function audit(msg, src) {
  try { db.prepare("INSERT INTO events(source,facility,severity,message) VALUES (?, 'audit','info',?)").run(src || 'system', msg); } catch {}
}
async function deviceRoutes(req, res, u, m, p, needAuth, send, getBody) {
  const dm = p.match(/^\/api\/devices\/(\d+)(\/metrics|\/interfaces)?$/);
  if (!dm) return false;
  const id = dm[1];
  const s = needAuth(req, res, dm[2] ? undefined : (m === 'GET' ? undefined : (m === 'DELETE' ? ['admin'] : ['admin', 'operator'])));
  if (!s) return true;
  if (m === 'GET' && !dm[2]) {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
    if (!d) { send(res, 404, { error: 'Not found' }); return true; }
    d.interfaces = db.prepare('SELECT * FROM interfaces WHERE device_id=?').all(id);
    send(res, 200, d); return true;
  }
  if ((m === 'PUT' || m === 'PATCH') && !dm[2]) {
    const b = await getBody(req);
    const allow = ['name', 'ip', 'type', 'vendor', 'snmp_version', 'snmp_community', 'snmp_protocol', 'status', 'monitored'];
    const sets = Object.keys(b).filter((k) => allow.includes(k));
    if (sets.length) db.prepare('UPDATE devices SET ' + sets.map((k) => k + '=?').join(',') + ' WHERE id=?').run(...sets.map((k) => b[k]), id);
    audit('Device #' + id + ' diubah', s.username);
    send(res, 200, { ok: true }); return true;
  }
  if (m === 'DELETE' && !dm[2]) {
    db.prepare('DELETE FROM devices WHERE id=?').run(id);
    audit('Device #' + id + ' dihapus', s.username);
    send(res, 200, { ok: true }); return true;
  }
  if (m === 'GET' && dm[2] === '/metrics') {
    const hours = Number(u.searchParams.get('hours') || 24);
    send(res, 200, db.prepare('SELECT * FROM metrics WHERE device_id=? AND ts>=? ORDER BY ts').all(id, Date.now() - hours * 3600e3)); return true;
  }
  if (m === 'GET' && dm[2] === '/interfaces') {
    send(res, 200, db.prepare('SELECT * FROM interfaces WHERE device_id=?').all(id)); return true;
  }
  return false;
}
module.exports = { deviceRoutes, audit };
