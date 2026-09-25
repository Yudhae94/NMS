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

  const insDev = db.prepare(`INSERT INTO devices(name,ip,type,vendor,snmp_version,snmp_community,snmp_user,snmp_protocol,status,cpu,mem,disk,temp,uptime,monitored)
    VALUES (@name,@ip,@type,@vendor,@snmp_version,@snmp_community,@snmp_user,@snmp_protocol,'up',@cpu,@mem,@disk,@temp,@uptime,0)`);
  const devs = [
    { name: 'GW-CORE-01', ip: '10.10.0.1', type: 'router', vendor: 'Cisco', cpu: 22, mem: 41, disk: 15, temp: 44, uptime: '31d 4h' },
    { name: 'GW-CORE-02', ip: '10.10.0.2', type: 'router', vendor: 'MikroTik', cpu: 35, mem: 55, disk: 22, temp: 48, uptime: '12d 9h' },
    { name: 'SW-DIST-01', ip: '10.10.1.10', type: 'switch', vendor: 'Cisco', cpu: 18, mem: 38, disk: 10, temp: 39, uptime: '55d 1h' },
    { name: 'SW-DIST-02', ip: '10.10.1.11', type: 'switch', vendor: 'HP', cpu: 14, mem: 30, disk: 8, temp: 36, uptime: '55d 1h' },
    { name: 'SW-ACC-01', ip: '10.10.2.21', type: 'switch', vendor: 'TP-Link', cpu: 9, mem: 24, disk: 5, temp: 33, uptime: '7d 16h' },
    { name: 'FW-EDGE-01', ip: '10.10.0.254', type: 'firewall', vendor: 'Fortinet', cpu: 47, mem: 62, disk: 30, temp: 52, uptime: '88d 3h' },
    { name: 'SRV-PROD-01', ip: '10.10.3.10', type: 'server', vendor: 'Dell', cpu: 58, mem: 71, disk: 48, temp: 58, uptime: '20d 11h' },
    { name: 'SRV-DB-01', ip: '10.10.3.11', type: 'server', vendor: 'HP', cpu: 66, mem: 78, disk: 61, temp: 61, uptime: '20d 11h' },
    { name: 'AP-OFFICE-01', ip: '10.10.4.5', type: 'ap', vendor: 'Ubiquiti', cpu: 12, mem: 28, disk: 6, temp: 37, uptime: '3d 2h' },
  ];
  const ids = {};
  for (const d of devs) ids[d.name] = insDev.run(d).lastInsertRowid;

  const insIf = db.prepare('INSERT INTO interfaces(device_id,name,status,speed_mbps,in_bps,out_bps) VALUES (?,?,?,?,?,?)');
  const ifaces = {
    'GW-CORE-01': ['Gi0/0', 'Gi0/1', 'Gi0/2', 'Te1/0'],
    'GW-CORE-02': ['ether1', 'ether2', 'ether3'],
    'SW-DIST-01': ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Te1/1'],
    'SW-DIST-02': ['Gi1/0/1', 'Gi1/0/2', 'Te1/1'],
    'SW-ACC-01': ['Gi0/1', 'Gi0/2', 'Gi0/3'],
    'FW-EDGE-01': ['WAN1', 'LAN1', 'DMZ1'],
    'SRV-PROD-01': ['eno1', 'eno2'],
    'SRV-DB-01': ['eno1'],
    'AP-OFFICE-01': ['eth0'],
  };
  for (const [name, ports] of Object.entries(ifaces)) {
    for (const p of ports) {
      const down = (name === 'SW-ACC-01' && p === 'Gi0/3'); // contoh port down
      insIf.run(ids[name], p, down ? 'down' : 'up', 1000,
        down ? 0 : Math.round(2e6 + Math.random() * 4e7),
        down ? 0 : Math.round(1e6 + Math.random() * 3e7));
    }
  }

  const insLink = db.prepare('INSERT INTO links(src_device,src_port,dst_device,dst_port) VALUES (?,?,?,?)');
  insLink.run(ids['FW-EDGE-01'], 'LAN1', ids['GW-CORE-01'], 'Gi0/0');
  insLink.run(ids['FW-EDGE-01'], 'DMZ1', ids['GW-CORE-02'], 'ether1');
  insLink.run(ids['GW-CORE-01'], 'Gi0/1', ids['SW-DIST-01'], 'Te1/1');
  insLink.run(ids['GW-CORE-02'], 'ether2', ids['SW-DIST-02'], 'Te1/1');
  insLink.run(ids['SW-DIST-01'], 'Gi1/0/1', ids['SW-ACC-01'], 'Gi0/1');
  insLink.run(ids['SW-DIST-01'], 'Gi1/0/2', ids['SRV-PROD-01'], 'eno1');
  insLink.run(ids['SW-DIST-02'], 'Gi1/0/1', ids['SRV-DB-01'], 'eno1');
  insLink.run(ids['SW-DIST-02'], 'Gi1/0/2', ids['AP-OFFICE-01'], 'eth0');
  const insF = db.prepare('INSERT INTO flows(src_ip,dst_ip,src_port,dst_port,proto,bytes,packets,device_id) VALUES (?,?,?,?,?,?,?,?)');
  const talkers = [['10.10.3.10', '8.8.8.8', 443], ['10.10.3.11', '10.10.3.10', 3306], ['10.10.2.21', '10.10.1.10', 80], ['10.10.0.1', '10.10.0.254', 22]];
  for (let i = 0; i < 60; i++) {
    const t = talkers[i % talkers.length];
    insF.run(t[0], t[1], 10000 + i, t[2], i % 3 ? 'TCP' : 'UDP', Math.round(1e6 + Math.random() * 5e8), Math.round(1e3 + Math.random() * 5e5), ids['GW-CORE-01']);
  }

  db.prepare('INSERT INTO channels(type,target,min_severity) VALUES (?,?,?)').run('telegram', '-100200300:EXAMPLE_CHAT', 'warning');
  db.prepare('INSERT INTO channels(type,target,min_severity) VALUES (?,?,?)').run('email', 'noc@nms.local', 'critical');

  db.prepare(`INSERT INTO events(source,facility,severity,message) VALUES ('system','audit','info','Database diinisialisasi dengan 9 perangkat demo')`).run();

  // seed history metrik 24 jam terakhir (5 menit interval) agar grafik langsung terisi
  const insM = db.prepare('INSERT INTO metrics(device_id,ts,cpu,mem,disk,temp,in_bps,out_bps,latency,packet_loss) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const now = Date.now();
  for (const d of devs) {
    for (let h = 288; h >= 0; h--) {
      const t = now - h * 5 * 60 * 1000;
      const wave = (i, p, a) => i + a * Math.sin(h / 40 + p) + (Math.random() - 0.5) * a;
      insM.run(ids[d.name], t,
        Math.max(2, Math.min(99, wave(d.cpu, 1, 8))),
        Math.max(5, Math.min(99, wave(d.mem, 2, 5))),
        d.disk,
        Math.max(20, Math.min(85, wave(d.temp, 3, 2))),
        Math.round(Math.max(0, wave(25e6, 1.2, 12e6))),
        Math.round(Math.max(0, wave(15e6, 2.1, 9e6))),
        Math.max(0.3, wave(8, 0.5, 3)),
        Math.max(0, Math.min(4, wave(0.4, 4, 0.3))));
    }
  }
}

seed();

try {
  // perangkat demo (10.10.x) tidak dipoll ping; hanya perangkat nyata yang dipantau
  db.prepare("UPDATE devices SET monitored=0 WHERE ip LIKE '10.10.%'").run();
  const fc = db.prepare('SELECT COUNT(*) c FROM flows').get().c;
  if (!fc) {
    const gid = db.prepare("SELECT id FROM devices WHERE name='GW-CORE-01'").get();
    const insF = db.prepare('INSERT INTO flows(src_ip,dst_ip,src_port,dst_port,proto,bytes,packets,device_id) VALUES (?,?,?,?,?,?,?,?)');
    const talkers = [['10.10.3.10', '8.8.8.8', 443], ['10.10.3.11', '10.10.3.10', 3306], ['10.10.2.21', '10.10.1.10', 80], ['10.10.0.1', '10.10.0.254', 22]];
    for (let i = 0; i < 60; i++) {
      const t = talkers[i % talkers.length];
      insF.run(t[0], t[1], 10000 + i, t[2], i % 3 ? 'TCP' : 'UDP', Math.round(1e6 + Math.random() * 5e8), Math.round(1e3 + Math.random() * 5e5), gid ? gid.id : null);
    }
  }
} catch {}

module.exports = { db, hash, verifyPw };
