#!/usr/bin/env bash
# 多中继语义实验矩阵：验证「两个端点必须共享中继吗 / 能否拨到对端所在中继」
# 用法: ./probe-relay-matrix.sh
set -uo pipefail

DOCTOR=/usr/local/bin/iroh-doctor
ROOT=/opt/iroh
NODE_ID=1d7f3bc99b6572ba37469241a23223edd4f56cd2e8f5261d05270d16efc58f6b
KEY=$(cat "$ROOT/key-accept.txt")

cleanup() { pkill -f "iroh-doctor --config" >/dev/null 2>&1; sleep 1; }

run_case() {
  local name="$1" accept_cfg="$2" dial_cfg="$3" dial_relay="$4"
  echo "===== $name ====="
  echo "    accept relay map : $accept_cfg"
  echo "    dialer relay map : $dial_cfg"
  echo "    dial --relay-url : $dial_relay"
  cleanup; rm -f /tmp/accept.log /tmp/connect.log
  nohup "$DOCTOR" --config "$ROOT/$accept_cfg/iroh.config.toml" accept \
      --secret-key "$KEY" --size 65536 --disable-address-lookup \
      > /tmp/accept.log 2>&1 &
  sleep 6
  local t0=$(date +%s%3N)
  timeout 45 "$DOCTOR" --config "$ROOT/$dial_cfg/iroh.config.toml" connect "$NODE_ID" \
      --relay-url "$dial_relay" --disable-address-lookup > /tmp/connect.log 2>&1
  local rc=$?
  local t1=$(date +%s%3N)
  if grep -q "Accepted connection" /tmp/accept.log; then
    echo "    RESULT: OK — 连接建立 (耗时 $((t1-t0)) ms)"
  else
    echo "    RESULT: FAIL — 未建立连接 (connect rc=$rc, 耗时 $((t1-t0)) ms)"
  fi
  grep -E "Accepted|error|Error" /tmp/accept.log | tail -2 | sed 's/^/    accept| /'
  tail -4 /tmp/connect.log | sed 's/^/    dialer| /'
  echo
  cleanup
}

run_case "E1 同中继 (对端@a, 拨号 map=[a], 指向 a)"      cfg-a cfg-a  "http://127.0.0.1:3340/"
run_case "E2 错配 (对端@a, 拨号 map=[b], 指向 b)"        cfg-a cfg-b  "http://127.0.0.1:3341/"
run_case "E3 指向对端中继a, 但拨号 map 只有 b"           cfg-a cfg-b  "http://127.0.0.1:3340/"
run_case "E4 拨号 map=[a,b], 却被指向 b"                 cfg-a cfg-ab "http://127.0.0.1:3341/"
run_case "E5 拨号 map=[a,b], 指向 a"                     cfg-a cfg-ab "http://127.0.0.1:3340/"

echo "实验结束。"
