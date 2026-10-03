#!/usr/bin/env bash
# 验证新方案的两个关键假设（在服务器上跑，不碰现有中继实例）：
#   A. Docker + host 网络 + 官方镜像能跑起来
#   B. 关闭 QAD（不打洞就不需要 quic/7842）后，纯中继客户端仍能注册并收发消息
#   C. cert_mode = "Reloading" 期望的文件名（用于"1Panel 管证书、中继自动重载"）
#
# 用已有证书（对 iroh1.editor.vip 有效），换端口 9443 起临时实例。
set -uo pipefail

DIR=/opt/iroh/dockertest
PEER_RELAY=https://iroh1.editor.vip:8443
NEW_RELAY=https://iroh1.editor.vip:9443
BIN=/opt/iroh-build/client-wasm/target/release/relay-probe

rm -rf "$DIR"; mkdir -p "$DIR/certs"
cp /etc/iroh-relay/certs/fullchain.pem /etc/iroh-relay/certs/privkey.pem "$DIR/certs/"
chmod 644 "$DIR"/certs/*

cat > "$DIR/relay-nqad.toml" <<'TOML'
enable_relay = true
http_bind_addr = "127.0.0.1:3345"
enable_quic_addr_discovery = false
enable_metrics = true
metrics_bind_addr = "127.0.0.1:9099"
access = "everyone"

[tls]
https_bind_addr = "0.0.0.0:9443"
cert_mode = "Reloading"
cert_dir = "/etc/iroh-relay/certs"
TOML

echo "########## C: 先用 Reloading 模式试启动，看它期望什么文件名 ##########"
docker rm -f iroh-relay-nqad >/dev/null 2>&1
docker run -d --name iroh-relay-nqad --network host \
  -v "$DIR/relay-nqad.toml":/etc/iroh-relay/relay-nqad.toml:ro \
  -v "$DIR/certs":/etc/iroh-relay/certs:ro \
  n0computer/iroh-relay:v1.3.0 --config-path /etc/iroh-relay/relay-nqad.toml >/dev/null
sleep 5
docker logs iroh-relay-nqad 2>&1 | tail -8

echo
echo "########## 若 Reloading 文件名不对，退回 Manual 再试 ##########"
if ! ss -tlnp 2>/dev/null | grep -q 9443; then
  echo "（Reloading 没起来，改用 Manual）"
  sed -i 's/cert_mode = "Reloading"/cert_mode = "Manual"\nmanual_cert_path = "\/etc\/iroh-relay\/certs\/fullchain.pem"\nmanual_key_path = "\/etc\/iroh-relay\/certs\/privkey.pem"/; /cert_dir/d' "$DIR/relay-nqad.toml"
  docker rm -f iroh-relay-nqad >/dev/null 2>&1
  docker run -d --name iroh-relay-nqad --network host \
    -v "$DIR/relay-nqad.toml":/etc/iroh-relay/relay-nqad.toml:ro \
    -v "$DIR/certs":/etc/iroh-relay/certs:ro \
    n0computer/iroh-relay:v1.3.0 --config-path /etc/iroh-relay/relay-nqad.toml >/dev/null
  sleep 5
  docker logs iroh-relay-nqad 2>&1 | tail -8
fi

echo
echo "########## 监听与健康检查 ##########"
ss -tlnp | grep 9443 || echo "(9443 未监听)"
echo "--- UDP 7842 有没有被这个实例占用（应该没有）---"
ss -ulnp | grep 7842 || echo "(无 UDP 7842 监听，符合预期)"
curl -sS --max-time 8 "https://iroh1.editor.vip:9443/healthz"; echo

echo
echo "########## B: 无 QAD 的纯中继能不能承载 iroh 客户端 ##########"
rm -f /tmp/nqad-listener.log
nohup "$BIN" "$NEW_RELAY" --listen 45 > /tmp/nqad-listener.log 2>&1 &
LPID=$!
sleep 12
PEER=$(grep -A1 "本节点 ID" /tmp/nqad-listener.log | tail -1 | tr -d ' ')
echo "监听端(新实例) ID: $PEER"
grep -E "connected=" /tmp/nqad-listener.log | tail -2
echo "--- 从旧实例(8443)向新实例(9443)发消息（跨实例投递）---"
timeout 45 "$BIN" "$PEER_RELAY" --dial "$PEER@$NEW_RELAY" --text "no-QAD hello" 2>&1 | grep -E "结果|失败" | tail -3
echo "--- 监听端收到了什么 ---"
grep -E "\[msg|\[peer" /tmp/nqad-listener.log | tail -3
kill $LPID 2>/dev/null

echo
echo "########## 清理临时实例 ##########"
docker rm -f iroh-relay-nqad >/dev/null 2>&1 && echo "已删除容器（镜像保留，供正式部署用）"
docker images | grep -E "iroh-relay|REPOSITORY" | head -3
rm -rf "$DIR"
echo "########## 结束 ##########"
