# Deploy NMS ke VPS Linux 24/7

Tujuan: `https://nms-monitoring.yudhaekapratamay.workers.dev` tetap hidup
**walaupun laptop mati/offline**.

## Kenapa perlu VPS

```
Sebelum:  Browser → Cloudflare Edge → tunnel → LAPTOP (server.js + nms.db)
Sesudah:  Browser → Cloudflare Edge → tunnel → VPS 24/7 (server.js + nms.db)
```

Data monitoring ikut pindah ke VPS (folder `data/` tidak ikut di-rsync,
jadi database VPS mulai bersih lalu terisi sendiri).

## 1. Pilih VPS gratis

Opsi yang umum dipakai (pilih salah satu):

| Provider | Gratis | Catatan |
|---|---|---|
| **Oracle Cloud Always Free** | 2 VM (1 GB RAM) selamanya | Registration agak tricky (kartu kredit dicek, tapi tidak ditagih) |
| **Google Cloud Free Tier** | e2-micro 0,5 GB, region `us-west1` | 12 bulan, perlu set billing |
| **Vultr / DigitalOcean** |credit awal ~$25 | Kartu kredit, berakhir setelah credit habis |
| **IDCloudHost / Niagahost** | Ada paket promo/trial | Pilih yang support Linux + SSH |

Rekomendasi: **Google Cloud `us-west1`** (paling mudah) atau
**Oracle Always Free** (benar-benar selamanya).

> ⚠️ VPS harus **Linux** (Ubuntu 22.04/24.04). Kode sudah mendukung Linux
> (`ping -c`, `ip neigh`, `nmcli`), tapi **scan WiFi via `netsh` tidak ada** —
> itu fitur Windows. Di Linux butuh `NetworkManager` (`nmcli`) atau WiFi USB adapter.

## 2. Siapkan token tunnel (di dashboard Cloudflare)

1. Buka **Cloudflare Zero Trust → Networks → Tunnels**
2. Tunnel **nms** sudah ada (saya buat sebelumnya). Klik **Configure**
3. Salin **Token** (bukan Tunnel ID)

> Kalau tunnel `nms` belum ada, buat dulu, lalu ambil tokennya.

## 3. Upload aplikasi ke VPS

Dari **laptop** (butuh `rsync` + `ssh`, sudah ada di Git Bash/WSL):

```bash
bash deploy/deploy-vps.sh root@IP_VPS_ANDA
```

Perintah ini menyalin kode ke `/opt/nms`, lalu di VPS:

```bash
cd /opt/nms
sudo bash deploy/setup-vps.sh "TOKEN_TUNNEL_ANDA" "/opt/nms"
```

Selesai. `setup-vps.sh` akan:
- pasang Node.js 22
- buat user `nms` (bukan root)
- pasang `cloudflared`
- daftarkan `nms.service` + `nms-tunnel.service` (auto-restart, auto-boot)

## 4. Arahkan Worker ke VPS

Tunnel baru punya URL sendiri, misal
`https://abc-def.trycloudflare.com` (atau domain yang Anda set di Zero Trust).

Lalu di **laptop**:

```bash
# 1. tulis ORIGIN_URL ke wrangler.jsonc
node -e "const fs=require('fs');let t=fs.readFileSync('wrangler.jsonc','utf8');t=t.replace(/\"ORIGIN_URL\":\s*\"[^\"]*\"/,'\"ORIGIN_URL\": \"https://URL_TUNNEL_VPS\"');fs.writeFileSync('wrangler.jsonc',t,'utf8')"

# 2. deploy worker
npm run deploy
```

## 5. Update kode di masa depan

```bash
bash deploy/deploy-vps.sh root@IP_VPS_ANDA
```

Otomatis copy + restart. Data (`data/nms.db`) tidak tertimpa.

## Troubleshooting

```bash
# di VPS
systemctl status nms --no-pager
systemctl status nms-tunnel --no-pager
journalctl -u nms -f                # log server
tail -f /var/log/nms/tunnel.err.log # log tunnel
curl localhost:3000/api/health       # cek server lokal
```

| Gejala | Penyebab & Solusi |
|---|---|
| `Failed to start service: Permission denied` | `chown -R nms:nms /opt/nms` |
| Tunnel `Registered tunnel connection` takmuncul | Token salah / belum diisi |
| Worker 502 setelah update | `ORIGIN_URL` di `wrangler.jsonc` belum di-deploy |
| WiFi scan kosong di Linux | Perlu `sudo apt install network-manager` |
| RAM habis | `MemoryMax=512M` sudah dipasang di service |

## Perintah-packed

```bash
node scripts/make-deploy-pack.js   # regenerate unit systemd
node scripts/deploy-check.js       # validasi paket (45 cek)
```