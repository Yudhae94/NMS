#!/bin/bash
# Installer NMS Monitoring untuk VPS Linux (Ubuntu/Debian).
#
# Pakai di VPS:  sudo bash setup-vps.sh "<TUNNEL_TOKEN>" "/path/sumber/app"
#
# Yang dikerjakan:
#   1. pasang Node.js 22
#   2. buat user khusus "nms" (bukan root)
#   3. salin aplikasi ke /opt/nms
#   4. pasang cloudflared + systemd service (server & tunnel)
#   5. nyalakan keduanya dengan auto-restart
set -euo pipefail

TUNNEL_TOKEN="${1:-}"
APP_SRC="${2:-.}"
NODE_MAJOR=22

log() { echo "[setup] $*"; }
die() { echo "[setup] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "jalankan dengan sudo"
[ -n "$TUNNEL_TOKEN" ] || die "TUNNEL_TOKEN wajib (Cloudflare Zero Trust > Networks > Tunnels > nms > token)"

log "1/6 memasang paket dasar & Node.js $NODE_MAJOR"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync >/dev/null
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "     Node.js $(node -v)"

log "2/6 membuat user 'nms'"
id -u nms >/dev/null 2>&1 || useradd -r -m -d /home/nms -s /bin/bash nms

log "3/6 menyalin aplikasi ke /opt/nms"
mkdir -p /opt/nms
if [ ! -f "$APP_SRC/package.json" ]; then
  die "sumber aplikasi tidak ditemukan: $APP_SRC"
fi
for item in server.js poller.js worker.js package.json wrangler.jsonc public lib scripts deploy; do
  [ -e "$APP_SRC/$item" ] && cp -r "$APP_SRC/$item" /opt/nms/ || true
done
mkdir -p /opt/nms/data /opt/nms/logs /var/log/nms
chown -R nms:nms /opt/nms /var/log/nms

log "4/6 memasang cloudflared"
if [ ! -x /usr/local/bin/cloudflared ]; then
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
fi
log "5/6 memasang systemd service"
install -m 0644 "$APP_SRC/deploy/nms.service" /etc/systemd/system/nms.service
install -m 0644 "$APP_SRC/deploy/nms-tunnel.service" /etc/systemd/system/nms-tunnel.service

# skrip wrapper tunnel: membaca token dari /etc/nms/tunnel-token (0600, milik nms)
cat > /opt/nms/scripts/tunnel-service.sh <<'WRAP'
#!/bin/bash
set -euo pipefail
exec /usr/local/bin/cloudflared tunnel --no-autoupdate run --token "$(cat /etc/nms/tunnel-token)"
WRAP
chmod 0755 /opt/nms/scripts/tunnel-service.sh
chown nms:nms /opt/nms/scripts/tunnel-service.sh

install -d -o nms -g nms -m 0700 /etc/nms
printf '%s' "$TUNNEL_TOKEN" > /etc/nms/tunnel-token
chmod 0600 /etc/nms/tunnel-token
chown nms:nms /etc/nms/tunnel-token

systemctl daemon-reload
systemctl enable nms.service >/dev/null
systemctl enable nms-tunnel.service >/dev/null

log "6/6 menyalakan service"
systemctl restart nms.service
sleep 6
systemctl restart nms-tunnel.service
sleep 4

echo ""
echo "  NMS terpasang di VPS."
echo "  Status : systemctl status nms nms-tunnel --no-pager"
echo "  Log    : journalctl -u nms -f   atau   tail -f /var/log/nms/server.log"
echo "  Restart: systemctl restart nms"