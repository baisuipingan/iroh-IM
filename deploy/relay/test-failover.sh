#!/usr/bin/env bash
# 中继故障切换测试：客户端配置 [a,b]，观察 a 挂掉后是否自动切到 b
# 用法: ./test-failover.sh   （在服务器上运行）
set -uo pipefail

DOCTOR=/usr/local/bin/iroh-doctor
ROOT=/opt/iroh
KEY=$(cat "$ROOT/key-accept.txt")
PAT='iroh-[d]octor'

cleanup() { pkill -f "$PAT" >/dev/null 2>&1; sleep 1; }

show() {
  echo "  --- 客户端到中继的 TCP 连接:"
  ss -tnp | grep -E ':(3340|3341)' | awk '{print "      "$5}' | sort | uniq -c | sed 's/^/     /' || true
  for p in 9097 9098; do
    echo "  --- 中继 metrics :$p"
    curl -s --max-time 4 "http://127.0.0.1:$p/metrics" \
      | grep -E 'unique_client_keys_total|accepts_total|disconnects_total' | sed 's/^/      /' \
      || echo "      (不可达)"
  done
}

cleanup
nohup "$DOCTOR" --config "$ROOT/cfg-ab/iroh.config.toml" accept \
    --secret-key "$KEY" --disable-address-lookup > /tmp/failover.log 2>&1 &
sleep 10

echo "########## 阶段1: 中继 a + b 均在线 ##########"
show
echo "########## 阶段2: 停掉中继 a ##########"
systemctl stop iroh-relay@a
sleep 25
show
echo "  --- accept 日志:"
tail -4 /tmp/failover.log | sed 's/^/      /'
echo "########## 阶段3: 恢复中继 a ##########"
systemctl start iroh-relay@a
sleep 10
show
systemctl is-active iroh-relay@a | sed 's/^/  relay-a: /'
cleanup
echo "测试结束。"
