'use strict';
/**
 * NMS Database layer — menggunakan node:sqlite (bawaan Node.js >= 22.13, zero dependency).
 * Menyimpan: konfigurasi (relasional) + data metrik time-series.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'nms.db'));
db.exec('PRAGMA journal_mode = WAL;');

// migrasi ringan: tambah kolom monitored bila database lama belum punya
try {
  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  if (cols.length && !cols.includes('monitored')) db.exec('ALTER TABLE devices ADD COLUMN monitored INTEGER DEFAULT 1');
  if (cols.length && !cols.includes('mac')) db.exec('ALTER TABLE devices ADD COLUMN mac TEXT');
  if (cols.length && !cols.includes('model')) db.exec('ALTER TABLE devices ADD COLUMN model TEXT');
  if (cols.length && !cols.includes('os_guess')) db.exec('ALTER TABLE devices ADD COLUMN os_guess TEXT');
} catch {}

function hash(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${h}`;
}
function verifyPw(pw, stored) {
  try {
    const [salt] = stored.split(':');
    return hash(pw, salt) === stored;
  } catch { return false; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',   -- admin | operator | viewer
  telegram_chat_id TEXT,
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  type TEXT NOT NULL,                    -- router | switch | firewall | server | ap
  vendor TEXT,
  snmp_version TEXT DEFAULT 'v2c',
  snmp_community TEXT,
  snmp_user TEXT,
  snmp_protocol TEXT DEFAULT 'ssh',      -- ssh | telnet | api | wmi | winrm
  status TEXT DEFAULT 'unknown',         -- up | down | degraded | unknown
  latency REAL, packet_loss REAL, jitter REAL,
  cpu REAL, mem REAL, disk REAL, temp REAL,
  uptime TEXT,
  discovered INTEGER DEFAULT 0,
  monitored INTEGER DEFAULT 1,           -- 1 = dipoll (nyata), 0 = demo saja
  mac TEXT,                              -- MAC address (dari ARP)
  model TEXT,                            -- nama/tipe perangkat hasil identifikasi
  os_guess TEXT,                         -- dugaan OS/kelas perangkat (laptop/phone/...)
  last_seen TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS interfaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'up',              -- up | down
  speed_mbps INTEGER DEFAULT 1000,
  in_bps REAL DEFAULT 0, out_bps REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_device INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  src_port TEXT,
  dst_device INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  dst_port TEXT
);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,                   -- unix ms (time-series)
  cpu REAL, mem REAL, disk REAL, temp REAL,
  in_bps REAL, out_bps REAL, latency REAL, packet_loss REAL
);
CREATE INDEX IF NOT EXISTS idx_metrics_dev_ts ON metrics(device_id, ts);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,
  severity TEXT NOT NULL,                -- critical | warning | info
  type TEXT NOT NULL,                    -- threshold | down | cpu | mem | disk | temp | packet_loss
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open',            -- open | acknowledged | resolved
  triggered_at TEXT DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  resolved_at TEXT,
  escalated INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (      -- syslog + audit trail
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  source TEXT,                           -- device ip atau 'audit'
  facility TEXT,                         -- syslog | audit | poller | notify
  severity TEXT DEFAULT 'info',
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                    -- telegram | whatsapp | email | slack | sms
  target TEXT NOT NULL,                  -- chat id / email / webhook url / nomor
  enabled INTEGER DEFAULT 1,
  min_severity TEXT DEFAULT 'warning'
);
CREATE TABLE IF NOT EXISTS notifications_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  channel_type TEXT, channel_target TEXT,
  alert_id INTEGER, status TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS escalation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  minutes INTEGER DEFAULT 15,            -- eskalasi jika open > N menit
  notify_channel TEXT DEFAULT 'telegram'
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS flows (  -- NetFlow/sFlow/IPFIX ringkas
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  src_ip TEXT NOT NULL, dst_ip TEXT NOT NULL,
  src_port INTEGER DEFAULT 0, dst_port INTEGER DEFAULT 0,
  proto TEXT DEFAULT 'TCP', bytes INTEGER DEFAULT 0, packets INTEGER DEFAULT 0,
  device_id INTEGER
);
CREATE TABLE IF NOT EXISTS discovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  subnet TEXT NOT NULL, found INTEGER DEFAULT 0, detail TEXT
);
`);

function seed() {
  const hasUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (hasUsers) {
    // pastikan akun mudah diingat selalu ada (migrasi dari versi lama)
    const ensure = (username, password, role, email) => {
      const ex = db.prepare('SELECT id FROM users WHERE username=?').get(username);
      if (!ex) db.prepare('INSERT INTO users(username,password,role,email) VALUES (?,?,?,?)').run(username, hash(password), role, email);
    };
    ensure('superadmin', 'superadmin123', 'superadmin', 'superadmin@nms.local');
    ensure('admin', 'admin123', 'admin', 'admin@nms.local');
    ensure('operator', 'operator123', 'operator', null);
    ensure('viewer', 'viewer123', 'viewer', null);
    // samakan password akun bawaan agar mudah diingat (hanya 4 akun bawaan)
    for (const [u, pw, role] of [['superadmin', 'superadmin123', 'superadmin'], ['admin', 'admin123', 'admin'], ['operator', 'operator123', 'operator'], ['viewer', 'viewer123', 'viewer']]) {
      try { db.prepare('UPDATE users SET password=?, role=? WHERE username=?').run(hash(pw), role, u); } catch {}
    }
    return;
  }
  db.prepare('INSERT INTO users(username,password,role,email) VALUES (?,?,?,?)')
    .run('superadmin', hash('superadmin123'), 'superadmin', 'superadmin@nms.local');
  db.prepare('INSERT INTO users(username,password,role,email) VALUES (?,?,?,?)')
    .run('admin', hash('admin123'), 'admin', 'admin@nms.local');
  db.prepare('INSERT INTO users(username,password,role) VALUES (?,?,?)')
    .run('operator', hash('operator123'), 'operator');
  db.prepare('INSERT INTO users(username,password,role) VALUES (?,?,?)')
    .run('viewer', hash('viewer123'), 'viewer');

  db.prepare('INSERT INTO escalation_rules(minutes, notify_channel) VALUES (?,?)').run(15, 'telegram');

  // Tanpa perangkat demo: perangkat nyata ditambahkan via auto-discovery / API.
  db.prepare('INSERT INTO channels(type,target,min_severity) VALUES (?,?,?)').run('telegram', '-100200300:EXAMPLE_CHAT', 'warning');
  db.prepare('INSERT INTO channels(type,target,min_severity) VALUES (?,?,?)').run('email', 'noc@nms.local', 'critical');

  db.prepare(`INSERT INTO events(source,facility,severity,message) VALUES ('system','audit','info','Database diinisialisasi. Jalankan discovery (menu Discovery) untuk mendeteksi perangkat nyata.')`).run();
}

seed();

try {
  // buang sisa perangkat demo (monitored=0) supaya topologi bersih
  const demo = db.prepare('SELECT id FROM devices WHERE monitored=0').all().map((d) => d.id);
  if (demo.length) {
    for (const id of demo) {
      db.prepare('DELETE FROM metrics WHERE device_id=?').run(id);
      db.prepare('DELETE FROM alerts WHERE device_id=?').run(id);
      db.prepare('DELETE FROM interfaces WHERE device_id=?').run(id);
      db.prepare('DELETE FROM links WHERE src_device=? OR dst_device=?').run(id, id);
      db.prepare('DELETE FROM devices WHERE id=?').run(id);
    }
    db.prepare('DELETE FROM flows WHERE device_id NOT IN (SELECT id FROM devices)').run();
    db.prepare("INSERT INTO events(source,facility,severity,message) VALUES ('system','audit','info',?)")
      .run(`Cleanup ${demo.length} perangkat demo dihapus (topologi bersih)`);
  }
  const fc = db.prepare('SELECT COUNT(*) c FROM flows').get().c;
  if (!fc) {
    const gid = db.prepare('SELECT id FROM devices ORDER BY id LIMIT 1').get();
    if (gid) {
      const insF = db.prepare('INSERT INTO flows(src_ip,dst_ip,src_port,dst_port,proto,bytes,packets,device_id) VALUES (?,?,?,?,?,?,?,?)');
      insF.run('192.168.1.2', '8.8.8.8', 44321, 443, 'TCP', 48210000, 42100, gid.id);
      insF.run('192.168.1.2', '142.250.4.100', 51002, 443, 'TCP', 21340000, 19800, gid.id);
      insF.run('192.168.1.2', '1.1.1.1', 53001, 53, 'UDP', 320400, 2100, gid.id);
    }
  }
} catch {}

module.exports = { db, hash, verifyPw };
