#!/bin/bash
# Kirim aplikasi dari laptop ke VPS lalu restart service.
# Pakai: bash deploy/deploy-vps.sh root@1.2.3.4 [port]
set -euo pipefail
TARGET="${1:?contoh: root@1.2.3.4}"
PORT="${2:-22}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[deploy] menyalin aplikasi ke $TARGET (port $PORT)"
rsync -az --delete \
  --exclude 'data/' --exclude 'logs/' --exclude 'node_modules/' \
  --exclude '.git' --exclude '.wrangler' --exclude 'shots/' \
  --exclude '.chrome-qa*/' --exclude '.edge-cdp/' \
  -e "ssh -p $PORT" \
  "$HERE/" "$TARGET:/opt/nms/"

echo "[deploy] merapikan hak akses & restart service"
ssh -p "$PORT" "$TARGET" \
  'chown -R nms:nms /opt/nms 2>/dev/null || true; systemctl restart nms; sleep 3; systemctl restart nms-tunnel'

echo "[deploy] selesai. Cek:"
echo "  ssh -p $PORT $TARGET 'systemctl status nms --no-pager'"