#!/usr/bin/env bash
# 幂等安装 iroh-relay 实例。
#   ./install-relay.sh            # 安装并启动 relay-a + relay-b
#   ./install-relay.sh a          # 只安装/启动 relay-a
#   IROH_RELAY_VERSION=1.3.0 ./install-relay.sh
# 约定：配置在 /etc/iroh-relay/relay-<name>.toml，systemd 模板单元 iroh-relay@<name>
set -euo pipefail

VERSION="${IROH_RELAY_VERSION:-1.3.0}"
BIN=/usr/local/bin/iroh-relay
CONF_DIR=/etc/iroh-relay
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTANCES=("$@")
[ ${#INSTANCES[@]} -eq 0 ] && INSTANCES=(a b)

case "$(uname -m)" in
  x86_64)        TRIPLE=x86_64-unknown-linux-musl ;;
  aarch64|arm64) TRIPLE=aarch64-unknown-linux-musl ;;
  *) echo "unsupported arch: $(uname -m)"; exit 1 ;;
esac

# 1. 二进制（版本不匹配才重新下载）
if [ ! -x "$BIN" ] || ! "$BIN" --version 2>/dev/null | grep -q "$VERSION"; then
  echo "==> installing iroh-relay $VERSION ($TRIPLE)"
  tmp=$(mktemp -d)
  url="https://github.com/n0-computer/iroh/releases/download/v${VERSION}/iroh-relay-v${VERSION}-${TRIPLE}.tar.gz"
  curl -sSL --retry 3 --max-time 300 -o "$tmp/relay.tar.gz" "$url"
  tar xzf "$tmp/relay.tar.gz" -C "$tmp"
  install -m 755 "$tmp/iroh-relay" "$BIN"
  rm -rf "$tmp"
else
  echo "==> iroh-relay $VERSION already installed"
fi
"$BIN" --version

# 2. 运行用户
id -u iroh-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin iroh-relay

# 3. 配置
install -d -m 755 "$CONF_DIR"
for i in "${INSTANCES[@]}"; do
  src="$SRC_DIR/relay-$i.toml"
  [ -f "$src" ] || { echo "missing config: $src"; exit 1; }
  install -m 644 "$src" "$CONF_DIR/relay-$i.toml"
done

# 4. systemd 模板单元
install -m 644 "$SRC_DIR/iroh-relay@.service" /etc/systemd/system/iroh-relay@.service
systemctl daemon-reload

# 5. 放行端口（按各自配置里**真正对外**的端口）
#
# ⚠️ 必须读 `[tls]` 段的 `https_bind_addr`，不是 `http_bind_addr`（复检缺陷 F10）。
#    实测：`relay-a.toml` 里 `http_bind_addr = "127.0.0.1:3340"` 是**只监听回环**的
#    内部端口，`https_bind_addr = "0.0.0.0:15443"` 才是客户端唯一入口。
#    旧脚本按 http 那行放行，于是：
#      · 放行了一个外部根本连不上的 3340/tcp；
#      · 真正需要的 15443/tcp **从没被放行** → 外部客户端全部被丢；
#      · 收尾校验 grep 3340 还打印"成功"。
# 用 `sed -E`（ERE）而不是 BRE 的 `\+`：后者只有 GNU sed 支持，
# 在 BSD/macOS 上会静默匹配失败（排障时很容易以为是配置没读到）。
PORTS=$(grep -hoE 'https_bind_addr *= *"[^"]*"' "$CONF_DIR"/relay-*.toml | sed -E 's/.*:([0-9]+)".*/\1/' | sort -u)
for p in $PORTS; do
  ufw status | grep -q "^$p/tcp" || ufw allow "$p/tcp" >/dev/null
done
# QUIC 只在**开了 QAD** 的配置里才有意义；没开就别白开一个 UDP 口。
if grep -hq 'enable_quic_addr_discovery *= *true' "$CONF_DIR"/relay-*.toml; then
  QUIC=$(grep -hoE 'quic_bind_addr *= *"[^"]*"' "$CONF_DIR"/relay-*.toml | sed -E 's/.*:([0-9]+)".*/\1/' | sort -u)
  for p in $QUIC; do
    ufw status | grep -q "^$p/udp" || ufw allow "$p/udp" >/dev/null
  done
fi
echo "==> ufw:"; ufw status | grep -E "15443|7842|3340|3341" || true

# 6. 启动
for i in "${INSTANCES[@]}"; do
  systemctl enable --now "iroh-relay@$i" >/dev/null
done
sleep 2
for i in "${INSTANCES[@]}"; do
  systemctl --no-pager --lines=0 status "iroh-relay@$i" | head -3 || true
done
# 校验**对外**端口真的在监听（以前只 grep 3340，回环端口在不在监听都不能说明外部可用）
echo "==> listening:"; ss -tlnp | grep -E "15443|7842" || echo "(not listening on the public port!)"
