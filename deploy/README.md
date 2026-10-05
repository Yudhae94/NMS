# Isi folder ini

| File | Fungsi |
|---|---|
| `VPS-GUIDE.md` | Panduan lengkap: pilih VPS → upload → pasang Worker |
| `setup-vps.sh` | Installer di VPS (Node.js 22, user `nms`, cloudflared, systemd) |
| `deploy-vps.sh` | Kirim kode dari laptop ke VPS via rsync (data tidak ditimpa) |
| `nms.service` | systemd unit untuk server API |
| `nms-tunnel.service` | systemd unit untuk Cloudflare Tunnel |

## Urutan singkat

```bash
# 1. Dari laptop: buat VM Oracle (perlu OCI CLI + kredensial)
node scripts/oci-create-vm.js --name nms-vps --ssh-key ./deploy/id_rsa.pub

# 2. Dari laptop: upload kode ke VPS
bash deploy/deploy-vps.sh root@IP_VPS

# 3. Di VPS: pasang service
cd /opt/nms && sudo bash deploy/setup-vps.sh "TOKEN_TUNNEL"

# 4. Dari laptop: arahkan Worker ke tunnel VPS
npm run deploy
```

## Catatan keamanan

- `id_rsa` / `id_rsa.pem` **tidak boleh** masuk git (sudah di-ignore)
- token tunnel disimpan di `/etc/nms/tunnel-token` dengan izin `0600`
- service berjalan sebagai user non-root `nms`
- VPS dibatasi `MemoryMax=512M` dan `CPUQuota=80%`

## Troubleshooting

Kunci privat SSH untuk akses VPS NMS.
JANGAN pernah di-commit berkas ini (sudah masuk .gitignore).