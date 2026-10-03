#!/usr/bin/env bash
# 把 acme.sh / certbot 签发的证书同步到 /etc/iroh-relay/certs/，证书变了才重启中继。
# 幂等，可被 systemd timer 反复调用，也适合放进 certbot/acme.sh 的续期钩子。
#
# 用法: ./sync-cert.sh <源 fullchain> <源 privkey> <systemd 单元名>
set -euo pipefail

SRC_CHAIN="${1:?需要 fullchain 路径}"
SRC_KEY="${2:?需要 privkey 路径}"
UNIT="${3:?需要 systemd 单元名}"

DST_DIR=/etc/iroh-relay/certs
DST_CHAIN="$DST_DIR/fullchain.pem"
DST_KEY="$DST_DIR/privkey.pem"

install -d -m 755 "$DST_DIR"

sum() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

before_chain=$(sum "$DST_CHAIN" || echo none)

if ! openssl x509 -in "$SRC_CHAIN" -noout 2>/dev/null; then
  echo "源证书不可读或格式错误: $SRC_CHAIN" >&2
  exit 1
fi

install -m 644 "$SRC_CHAIN" "$DST_CHAIN"
install -m 640 "$SRC_KEY" "$DST_KEY"
chown -R root:iroh-relay "$DST_DIR"

after_chain=$(sum "$DST_CHAIN")

if [ "$before_chain" != "$after_chain" ]; then
  echo "证书已更新，重启 $UNIT"
  systemctl restart "$UNIT"
  sleep 2
  systemctl is-active "$UNIT"
else
  echo "证书无变化，无需重启"
fi
