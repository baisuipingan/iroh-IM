#!/usr/bin/env bash
# 实测中继「自带 ACME 签发」是否可用（cert_mode = "LetsEncrypt"）
# 目的：给没有 1Panel 的服务器一条零外部依赖的证书路线。
#
# 安全设计：用 Let's Encrypt **staging** 环境 + 保留域名邮箱（example.invalid），
#   拿到的是不受信任的证书，但**签发流程完全一致**；不消耗生产配额、不占用任何人的邮箱。
#
# 前提：该机器的 80 端口空闲（HTTP-01 挑战要让 LE 从公网访问）。
set -uo pipefail
DIR=/opt/iroh/letest
IMG=n0computer/iroh-relay:v1.3.0
DOMAIN="${1:?用法: $0 <已解析到本机的域名>}"

rm -rf "$DIR"; mkdir -p "$DIR"
cat > "$DIR/relay.toml" <<TOML
enable_relay = true
http_bind_addr = "0.0.0.0:80"
enable_quic_addr_discovery = false
enable_metrics = false
access = "everyone"

[tls]
https_bind_addr = "0.0.0.0:9443"
cert_mode = "LetsEncrypt"
hostname = "$DOMAIN"
contact = "iroh-relay-test@example.invalid"
cert_dir = "/etc/iroh-relay/letest"
prod_tls = false
TOML

echo "########## 80 端口是否空闲 ##########"
ss -tlnp | grep -E ':80 ' && { echo "!! 80 被占用，LetsEncrypt 模式无法用"; exit 1; } || echo "80 空闲 ✅"

echo "########## 启动（staging ACME）##########"
docker rm -f letest >/dev/null 2>&1
docker run -d --name letest --network host \
  -v "$DIR/relay.toml":/etc/iroh-relay/relay.toml:ro \
  -v "$DIR":/etc/iroh-relay/letest \
  $IMG --config-path /etc/iroh-relay/relay.toml >/dev/null

for i in $(seq 1 12); do
  sleep 5
  if ss -tlnp 2>/dev/null | grep -q ':9443'; then
    echo "第 $((i*5))s：HTTPS 已监听 ✅"
    break
  fi
  echo "第 $((i*5))s：等待中…"
done

echo "########## 结果 ##########"
ss -tlnp | grep -E ':80 |:9443' || true
echo "--- 日志 ---"
docker logs letest 2>&1 | tail -15
echo "--- 生成的证书文件 ---"
ls -la "$DIR"/*.crt "$DIR"/*.key "$DIR"/*.pem 2>/dev/null || ls -la "$DIR" | tail -5
echo "--- 证书签发者（staging CA 属正常）---"
for f in "$DIR"/*.crt "$DIR"/*.pem; do [ -f "$f" ] && openssl x509 -in "$f" -noout -issuer -dates 2>/dev/null && break; done
echo "--- 健康检查（-k 因为 staging 证书不受信任）---"
curl -sSk --max-time 8 "https://$DOMAIN:9443/healthz" || echo "(未响应)"

echo "########## 清理 ##########"
docker rm -f letest >/dev/null 2>&1
rm -rf "$DIR"
echo "已删除测试容器与证书目录（现有 8443 中继与 nginx 未受影响）"
