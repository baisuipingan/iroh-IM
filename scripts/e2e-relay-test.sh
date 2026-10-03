#!/usr/bin/env bash
# 端到端验证：两台自建中继的 HTTPS 路径 + 跨中继投递语义（在服务器上跑）
#
#   A: 单台中继能否握手成功
#   B: 两台都在名单里时选哪台做 home relay
#   C1: 发送端在中继1、对端在中继2，拨号时指向对端真实所在的中继 → 应成功
#   C2: 拨号时指向错误的中继（对端不在那台） → 应超时失败
set -uo pipefail

BIN=/opt/iroh-build/client-wasm/target/release/relay-probe
R1=https://iroh1.editor.vip:8443
R2=https://iroh2.editor.vip:8443

echo "############ 测试B：两台都放进名单，看选哪台做 home relay ############"
RUST_LOG=iroh=info timeout 60 "$BIN" "$R1" "$R2" 2>&1 \
  | grep -E "^==|^    |home is now|connected=" | tail -20

echo
echo "############ 测试C：跨中继投递 ############"
rm -f /tmp/listener.log
nohup "$BIN" "$R2" --listen 60 > /tmp/listener.log 2>&1 &
LPID=$!
sleep 12
PEER=$(grep -A1 "本节点 ID" /tmp/listener.log | tail -1 | tr -d ' ')
echo "监听端 ID: $PEER"
echo "监听端中继状态:"
grep -E "connected=" /tmp/listener.log | tail -2

echo
echo "--- C1: 指向对端真实所在的中继（$R2）→ 期望 delivered ---"
timeout 45 "$BIN" "$R1" --dial "$PEER@$R2" --text "cross-relay hello" 2>&1 \
  | grep -E "结果|失败|connected=" | tail -4

echo
echo "--- C2: 指向错误的中继（$R1，对端不在那台）→ 期望超时失败 ---"
timeout 45 "$BIN" "$R1" --dial "$PEER@$R1" --text "wrong relay" 2>&1 \
  | grep -E "结果|失败|connected=" | tail -4

echo
echo "--- 监听端收到了什么 ---"
grep -E "\[msg|\[peer" /tmp/listener.log | tail -5

kill $LPID 2>/dev/null
echo "############ 结束 ############"
