# NMS Monitoring — zero dependency (Node.js >= 22.13, `node:sqlite` bawaan)

## Cakupan vs kebutuhan
1. Discovery & topology: `POST /api/discovery` (ping-sweep) + halaman Discovery, `GET /api/topology` + peta SVG; data: `devices.discovered`, `interfaces`, `links`, `discovery_runs`.
2. Performance: `metrics` time-series (cpu/mem/disk/temp/in_bps/out_bps/latency/packet_loss), grafik dashboard, status interface up/down.
3. Alerting: threshold (cpu/mem/temp/loss/down) + eskalasi (`escalation_rules`) + notifikasi channels (telegram/whatsapp/email/slack/sms) via `poller.js notify()`; set `TELEGRAM_BOT_TOKEN` untuk kirim Telegram real, Slack via webhook URL.
4. Dashboard & reporting: SPA (dashboard, topologi, flows, laporan, SLA) + `GET /api/reports/summary`, `/api/reports/sla`, CSV export.
5. Log & event: `events` (syslog UDP :5514 + audit trail) + halaman Events.
6. Protokol: ICMP ping aktif; SNMP v2c/v3 via `snmpwalk` bila terinstal (otomatis fallback simulasi); SSH/Telnet/API/WMI/WinRM via `remoteExec()` (kredensial dari env, fallback simulasi); field per-device: `snmp_version/community/user/protocol`; NetFlow/sFlow/IPFIX ringkas via tabel `flows` + `GET/POST /api/flows` + halaman Flows.
7. Infra: `docs/SIZING.md` (kecil/menengah/besar) — SSD/NVMe untuk time-series.
8. Security: RBAC (admin/operator/viewer, diverifikasi 38 cek), password scrypt, token HMAC exp 12 jam; catatan pengerasan di `docs/SECURITY.md` (HTTPS reverse-proxy, SNMPv3, VLAN manajemen).

## Perangkat nyata yang sedang dipakai
Sudah terdaftar & dipoll (ICMP asli):
- `ROUTER-TPLINK-HOME` **192.168.1.1** (router TP-Link, gateway, mode monitor)
- `PC-YUDHAEKA12` **192.168.1.2** (PC ini, terdeteksi sebagai **laptop/Windows** — port 445 terbuka)
- `XIAOMI-PHONE-4` **192.168.1.4** (terdeteksi **HP Xiaomi** via OUI vendor)
- `HOST-LAN-3/5/7/8` hasil auto-discovery LAN 192.168.1.0/24 (MAC randomized/privacy → vendor tidak terbaca)

Perangkat demo lama (10.10.x) ditandai **DEMO** (`monitored=0`) sehingga tidak dipoll dan tidak memicu alert palsu.

### Menambah / mengubah perangkat
```
node scripts/add-local-devices.js 192.168.1.1        # daftarkan router + PC ini (idempoten)
node scripts/discover.js 192.168.1 254               # scan subnet (via UI: menu Discovery)
node scripts/link-lan.js                             # hubungkan host LAN ke router (topologi)
node scripts/cleanup-demo-alerts.js                  # tutup alert perangkat demo
```
UI: menu **Devices** → tombol `Aktifkan/Matikan poll` (admin/operator) untuk switch MONITOR/DEMO.

## Deteksi nama perangkat (laptop / HP / TV / printer)
Modul `lib/identify.js` mengenali jenis & nama host di LAN tanpa credential:
1. **ARP table** (+ interface lokal) → MAC tiap IP
2. **OUI lookup** → vendor + kelas (mis. `E0:1F:88` → Xiaomi → `phone`); MAC dengan bit local-administer ditandai `MAC randomized` (privacy Android/iOS)
3. **Protokol nama**: NetBIOS NBSTAT UDP 137 (Windows), LLMNR UDP 5355, mDNS UDP 5353, reverse DNS
4. **Probe port**: 62078 (iPhone), 445/3389 (Windows), 22 (Linux), 9100 (printer), 8009 (Chromecast/TV)
5. `classify()` → tipe `laptop|phone|tv|printer|iot|server|router`; nama hasil deteksi disimpan ke `devices.name/vendor/type/mac/os_guess`

```bash
node scripts/identify-hosts.js   # atau: npm run identify
```
API: `POST /api/devices/identify` (admin/operator) — dipakai tombol **🔍 Deteksi nama perangkat** di menu Devices.
Poller otomatis mengulang identifikasi tiap 6 siklus polling.

## Live Traffic realtime
Menu **Live Traffic**: kartu Total Download/Upload, grafik berjalan (refresh 3 detik, histori 15 menit), tabel per-device.
API: `GET /api/traffic/live`, `GET /api/traffic/history?minutes=15`. Hanya perangkat `monitored=1` yang dihitung.

## Akun
`superadmin/superadmin123` (akses penuh, termasuk Users/Channels), `admin/admin123`, `operator/operator123`, `viewer/viewer123`.

## Jalankan
```
node server.js                # API + frontend http://localhost:3000
POLL_MS=10000 node poller.js  # poller ICMP asli (10 dtk) + syslog UDP :5514 + identify berkala
node scripts/verify.js        # verifikasi semua role & fitur (38 cek)
```
Env opsional: `PORT`, `JWT_SECRET`, `POLL_MS`, `SYSLOG_PORT`, `TELEGRAM_BOT_TOKEN`, `SSH_USER`.
Akun demo: admin/admin123, operator/operator123, viewer/viewer123.

