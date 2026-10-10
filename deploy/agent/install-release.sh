#!/usr/bin/env bash
# 从 GitHub Release 安装 iroh-agent 二进制到 /opt/iroh-agent/bin/agent。
#
# 这是"用户实际会走的分发链"：releases/download/<tag>/<asset> + 逐产物 sha256。
# 等待资产出现是给"刚打完 tag、CI 还在构建"的场景用的。
#
# 可覆盖的环境变量：VERSION（默认 agent-v1.2.0）、OSNAME/ARCH、BIN_DIR
#
# ⚠️ 默认值必须**跟着协议走**：v1.1.0 是 v4 协议，对着已切到 v5 的 roomd
#    收发全是静默丢消息（实测）。协议 bump 时这里要一起改。
set -euo pipefail

VERSION="${VERSION:-agent-v1.2.0}"
OSNAME="${OSNAME:-linux}"
ARCH="${ARCH:-amd64}"
EXT=tar.gz
BIN_DIR="${BIN_DIR:-/opt/iroh-agent/bin}"

ASSET="iroh-agent-$OSNAME-$ARCH.$EXT"
URL="https://github.com/baisuipingan/iroh-IM/releases/download/$VERSION/$ASSET"
TMP=$(mktemp -d)

for i in $(seq 1 120); do
  if curl -fsSL --retry 2 --connect-timeout 10 -o "$TMP/$ASSET" "$URL" \
     && curl -fsSL --retry 2 --connect-timeout 10 -o "$TMP/$ASSET.sha256" "$URL.sha256"; then
    echo "资产已就绪（第 $i 次尝试）"
    break
  fi
  echo "等待 release 资产…（第 $i 次，10s 后重试）"
  sleep 10
done
[ -s "$TMP/$ASSET" ] || { echo "超时：release 资产一直不可用"; exit 1; }

cd "$TMP"
sha256sum -c "$ASSET.sha256"
tar -xzf "$ASSET"
install -m 755 iroh-agent "$BIN_DIR/agent"
"$BIN_DIR/agent" help | head -2 || true
echo "install-ok $(sha256sum "$BIN_DIR/agent" | cut -c1-16)"
