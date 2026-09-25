'use strict';
const { db } = require('../lib/db');
db.prepare("UPDATE devices SET status='up', last_seen=datetime('now')").run();
console.log('restored up =', db.prepare("SELECT COUNT(*) c FROM devices WHERE status='up'").get().c);
console.log('alerts =', db.prepare('SELECT COUNT(*) c FROM alerts').get().c);
