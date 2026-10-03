#!/usr/bin/env bash
# 实测 cert_mode = "Reloading" 期望的文件名（中继周期性重读证书，免重启）
# 逐个候选命名试启动，谁成功就用谁。用完即清理。
set -uo pipefail
DIR=/opt/iroh/reloadtest
IMG=n0computer/iroh-relay:v1.3.0
SRC=/etc/iroh-relay/certs

rm -rf "$DIR"; mkdir -p "$DIR"
CAND=("default.crt:default.key" "cert.pem:key.pem" "fullchain.pem:privkey.pem" "iroh1.editor.vip.crt:iroh1.editor.vip.key" "cert.pem:privkey.pem")

try() {
  local spec="$1" n="$2"
  local crt="${spec%%:*}" key="${spec##*:}"
  local d="$DIR/c$n"; mkdir -p "$d"
  cp "$SRC/fullchain.pem" "$d/$crt"; cp "$SRC/privkey.pem" "$d/$key"; chmod 644 "$d"/*
  cat > "$DIR/r$n.toml" <<TOML
enable_relay = true
http_bind_addr = "127.0.0.1:3347"
enable_quic_addr_discovery = false
enable_metrics = false
access = "everyone"

[tls]
https_bind_addr = "0.0.0.0:9444"
cert_mode = "Reloading"
cert_dir = "/etc/iroh-relay/certs"
TOML
  docker rm -f rt$n >/dev/null 2>&1
  docker run -d --name rt$n --network host \
    -v "$DIR/r$n.toml":/etc/iroh-relay/r.toml:ro \
    -v "$d":/etc/iroh-relay/certs:ro \
    $IMG --config-path /etc/iroh-relay/r.toml >/dev/null
  sleep 4
  if ss -tlnp 2>/dev/null | grep -q 9444; then
    echo "  ✅ $crt + $key  → 启动成功（这就是 Reloading 期望的命名）"
    docker rm -f rt$n >/dev/null 2>&1
    return 0
  fi
  echo "  ❌ $crt + $key  → $(docker logs rt$n 2>&1 | tail -2 | tr '\n' ' ')"
  docker rm -f rt$n >/dev/null 2>&1
  return 1
}

echo "########## 逐个候选命名测试 Reloading ##########"
i=0
for spec in "${CAND[@]}"; do
  i=$((i+1))
  if try "$spec" "$i"; then break; fi
done

rm -rf "$DIR"
echo "########## 清理完成 ##########"
