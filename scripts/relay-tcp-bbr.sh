#!/usr/bin/env bash
# 给 iroh 中继（TCP 15443）单独套一层 BBR 策略路由——只影响"从 15443 发出的 TCP"，
# 全局拥塞算法保持 CUBIC 不动。
#
# 用法：relay-tcp-bbr.sh start | ensure | status | stop
#   start  一次性安装（已存在则拒绝，防覆盖）
#   ensure 幂等：已生效=静默退出 0；缺失=重新安装（给 systemd timer 每 2 分钟兜底用）
#   status 只检查（exit 0=生效中，1=失效）
#
# ⚠️ 2026-10-14 实录：systemd-networkd 默认会清理"外来"策略路由
#    （ManageForeignRoutingPolicyRules=yes）—— 每次重配置都会把我们这两条 rule
#    和 table 15443 一起删掉。实测"重启 networkd → 规则消失、优化静默失效"，
#    用户表现为"传输速度锯齿 + 中继频繁丢包/建连超时"。
#    根因修复=/etc/systemd/networkd.conf.d/95-manage-foreign.conf 里
#    ManageForeignRoutingPolicyRules=no + ManageForeignRoutes=no；
#    兜底=relay-tcp-bbr-check.timer 定期跑 `ensure`。
set -euo pipefail

PORT=15443
TABLE=15443
PRIORITY=15443

stop() {
  ip -4 rule del priority "$PRIORITY" ipproto tcp sport "$PORT" lookup "$TABLE" 2>/dev/null || true
  ip -4 rule del priority "$((PRIORITY - 1))" ipproto tcp sport "$PORT" lookup main suppress_prefixlength 0 2>/dev/null || true
  ip -4 route flush table "$TABLE" 2>/dev/null || true
}

# 是否完整生效（两条 rule + table 里的 congctl bbr 路由）
applied() {
  ip -4 rule show | grep -qE "^${PRIORITY}:" || return 1
  ip -4 rule show | grep -qE "^$((PRIORITY - 1)):" || return 1
  ip -4 route show table "$TABLE" | grep -q 'congctl bbr' || return 1
}

install_rules() {
  mapfile -t DEFAULTS < <(ip -4 route show default)
  if [[ "${#DEFAULTS[@]}" -ne 1 ]]; then
    echo 'Expected exactly one IPv4 default route; refusing to guess' >&2
    exit 1
  fi
  modprobe tcp_bbr
  read -r -a ROUTE <<< "${DEFAULTS[0]}"
  # ⚠️ 逐项幂等：每步先看存在与否再动手。别用"先 stop 再 add"——timer 的首次触发
  #    会和手工 ensure 并发（2026-10-14 演练时撞出 RTNETLINK "File exists"），
  #    幂等写法下两边怎么交错都能收敛。
  ip -4 route show table "$TABLE" | grep -q . || ip -4 route add table "$TABLE" "${ROUTE[@]}" congctl bbr
  ip -4 rule show | grep -qE "^$((PRIORITY - 1)):" || \
    ip -4 rule add priority "$((PRIORITY - 1))" ipproto tcp sport "$PORT" lookup main suppress_prefixlength 0
  ip -4 rule show | grep -qE "^${PRIORITY}:" || \
    ip -4 rule add priority "$PRIORITY" ipproto tcp sport "$PORT" lookup "$TABLE"
}

case "${1:-}" in
  stop) stop; exit 0 ;;
  status)
    if applied; then
      echo 'relay BBR: applied'
      exit 0
    fi
    echo 'relay BBR: MISSING' >&2
    exit 1
    ;;
  ensure)
    if applied; then exit 0; fi
    echo 'relay BBR missing; re-applying' >&2
    stop
    install_rules
    applied || { echo 're-apply did not take effect' >&2; exit 1; }
    echo 'relay BBR re-applied'
    exit 0
    ;;
  start) ;;
  *) echo 'Usage: relay-tcp-bbr.sh start|ensure|status|stop' >&2; exit 2 ;;
esac

# start：严格模式（已存在就拒绝，避免覆盖别的安排）
if ip -4 rule show | grep -Eq "^($PRIORITY|$((PRIORITY - 1))):"; then
  echo 'Policy priority already occupied; refusing to overwrite' >&2
  exit 1
fi
if [[ -n "$(ip -4 route show table "$TABLE" 2>/dev/null || true)" ]]; then
  echo 'Routing table already occupied; refusing to overwrite' >&2
  exit 1
fi
install_rules
ip -4 rule show
ip -4 route show table "$TABLE"
