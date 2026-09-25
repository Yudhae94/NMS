# NMS Monitoring — zero dependency (Node.js >= 22.13, `node:sqlite` bawaan)

## Cakupan vs kebutuhan
1. Discovery & topology: `POST /api/discovery` (ping-sweep) + halaman Discovery, `GET /api/topology` + peta SVG; data: `devices.discovered`, `interfaces`, `links`, `discovery_runs`.
2. Performance: `metrics` time-series (cpu/mem/disk/temp/in_bps/out_bps/latency/packet_loss), grafik dashboard, status interface up/down.
3. Alerting: threshold (cpu/mem/temp/loss/down) + eskalasi (`escalation_rules`) + notifikasi channels (telegram/whatsapp/email/slack/sms) via `poller.js notify()`; set `TELEGRAM_BOT_TOKEN` untuk kirim Telegram real, Slack via webhook URL.
4. Dashboard & reporting: SPA (dashboard, topologi, flows, laporan, SLA) + `GET /api/reports/summary`, `/api/reports/sla`, CSV export.
5. Log & event: `events` (syslog UDP :5514 + audit trail) + halaman Events.
6. Protokol: ICMP ping aktif; SNMP v2c/v3 via `snmpwalk` bila terinstal (otomatis fallback simulasi); SSH/Telnet/API/WMI/WinRM via `remoteExec()` (kredensial dari env, fallback simulasi); field per-device: `snmp_version/community/user/protocol`; NetFlow/sFlow/IPFIX ringkas via tabel `flows` + `GET/POST /api/flows` + halaman Flows.
7. Infra: `docs/SIZING.md` (kecil/menengah/besar) — SSD/NVMe untuk time-series.
8. Security: RBAC (admin/operator/viewer, diverifikasi 26 cek), password scrypt, token HMAC exp 12 jam; catatan pengerasan di `docs/SECURITY.md` (HTTPS reverse-proxy, SNMPv3, VLAN manajemen).

## Perangkat nyata yang sedang dipakai
Sudah terdaftar & dipoll (ICMP asli):
- `ROUTER-TPLINK-HOME` **192.168.1.1** (router TP-Link, gateway, mode monitor)
- `PC-YUDHAEKA12` **192.168.1.2** (PC ini)
- `HOST-LAN-3/4/5/7/8` hasil auto-discovery LAN 192.168.1.0/24

Perangkat demo lama (10.10.x) ditandai **DEMO** (`monitored=0`) sehingga tidak dipoll dan tidak memicu alert palsu.

### Menambah / mengubah perangkat
```
node scripts/add-local-devices.js 192.168.1.1        # daftarkan router + PC ini (idempoten)
node scripts/discover.js 192.168.1 254               # scan subnet (via UI: menu Discovery)
node scripts/link-lan.js                             # hubungkan host LAN ke router (topologi)
node scripts/cleanup-demo-alerts.js                  # tutup alert perangkat demo
```
UI: menu **Devices** → tombol `Aktifkan/Matikan poll` (admin/operator) untuk switch MONITOR/DEMO.

## Live Traffic realtime
Menu **Live Traffic**: kartu Total Download/Upload, grafik berjalan (refresh 3 detik, histori 15 menit), tabel per-device.
API: `GET /api/traffic/live`, `GET /api/traffic/history?minutes=15`. Hanya perangkat `monitored=1` yang dihitung.

## Akun
`superadmin/superadmin123` (akses penuh, termasuk Users/Channels), `admin/admin123`, `operator/operator123`, `viewer/viewer123`.

## Jalankan
```
node server.js                # API + frontend http://localhost:3000
POLL_MS=10000 node poller.js  # poller ICMP asli (10 dtk) + syslog UDP :5514
node scripts/verify.js        # verifikasi semua role & fitur
```
Env opsional: `PORT`, `JWT_SECRET`, `POLL_MS`, `SYSLOG_PORT`, `TELEGRAM_BOT_TOKEN`, `SSH_USER`.
Akun demo: admin/admin123, operator/operator123, viewer/viewer123.

