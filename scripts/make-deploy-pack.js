'use strict';
/**
 * Generator paket deploy VPS Linux (Ubuntu/Debian).
 * Menghasilkan folder deploy/ berisi systemd unit + skrip installer.
 * Dipakai sekali: node scripts/make-deploy-pack.js
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'deploy');
fs.mkdirSync(DIR, { recursive: true });

const nmsService = `[Unit]
Description=NMS Monitoring - server API (port 3000)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nms
Group=nms
WorkingDirectory=/opt/nms
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=TOPO_WATCH=1
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
MemoryMax=512M
CPUQuota=80%
StandardOutput=append:/var/log/nms/server.log
StandardError=append:/var/log/nms/server.err.log

[Install]
WantedBy=multi-user.target
`;

const tunnelService = `[Unit]
Description=NMS Monitoring - Cloudflare Tunnel (publish ke internet)
After=network-online.target nms.service
Wants=network-online.target
Requires=nms.service

[Service]
Type=simple
User=nms
Group=nms
WorkingDirectory=/opt/nms
ExecStart=/opt/nms/scripts/tunnel-service.sh
Restart=always
RestartSec=10
StandardOutput=append:/var/log/nms/tunnel.log
StandardError=append:/var/log/nms/tunnel.err.log

[Install]
WantedBy=multi-user.target
`;

const files = {
  'nms.service': nmsService,
  'nms-tunnel.service': tunnelService,
};
for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(DIR, name), content, 'utf8');
  console.log('ditulis: deploy/' + name + ' (' + content.length + ' byte)');
}