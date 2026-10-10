#!/usr/bin/env bash
# ==========================================================================
# roomd 看门狗 —— **为什么必须有它**
#
# Docker 的 `healthcheck` 只负责**标记** unhealthy，**不会重启容器**。
# `restart: unless-stopped` 也只在「进程退出」时生效。
#
# 于是"进程活着但网络废了"这种状态（本项目 2026-10-10 真事：
# 服务器重启后 roomd 到中继的 TCP 卡在 SYN_SENT，整整 8.7 小时
# 一条日志都没写、CPU 0.04%）**没有任何东西会去救它**。
#
# 这个脚本就是那个"东西"：定时看一眼健康状态，unhealthy 就重启。
#
# ## 为什么用 `docker inspect` 而不是自己再判一次
#
# 判据写在 `docker-compose.yml` 的 `healthcheck` 里（读 /proc/net/tcp 找
# ESTABLISHED 到 15443）。**判据只能有一处** —— 这里再写一份，
# 两边迟早会漂移（改了一处忘了另一处，就会出现"看门狗说健康、
# Docker 说不健康"这种互相打脸的状态）。
#
# ## 重启计数与告警
#
# 重启后写一行日志（带累计次数）。**如果短时间内反复重启**，
# 说明不是偶发，而是配置/网络真的坏了 —— 那时重启治不了本，
# 日志里的次数就是给人看的信号。
#
# 用法（配 systemd timer 或 cron 每 1~2 分钟跑一次）：
#   roomd-watchdog.sh
#
# 退出码：0 = 检查过（含"健康，不需要动"）
#        1 = 参数/环境有问题（找不到容器）
#        2 = 执行了重启
# ==========================================================================
set -uo pipefail

CONTAINER="${ROOMD_CONTAINER:-roomd}"
STATE_FILE="${ROOMD_WATCHDOG_STATE:-/var/lib/roomd-watchdog/restarts}"

log() { logger -t roomd-watchdog -- "$*" 2>/dev/null || echo "[roomd-watchdog] $*"; }

if ! command -v docker >/dev/null 2>&1; then
  log "找不到 docker，退出"
  exit 1
fi

# 容器不在（或没起）→ 不归本脚本管（那是 restart 策略的事）
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  log "容器 $CONTAINER 不存在，退出"
  exit 1
fi

status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)"

case "$status" in
  healthy)
    exit 0
    ;;
  none)
    # 没配 healthcheck（旧版本 compose 或没重建过）→ 明确说出来，
    # 别静默通过（那会让人以为"看门狗在管"，其实什么都没管）
    log "容器 $CONTAINER 没有 healthcheck（compose 需要重建：docker compose up -d）"
    exit 0
    ;;
  starting)
    # 启动宽限期内，正常
    exit 0
    ;;
  unhealthy)
    ;;
  *)
    log "未知健康状态 '$status'，跳过本次"
    exit 0
    ;;
esac

# ---- 到这里说明 unhealthy：重启 ----
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
n=0
[ -f "$STATE_FILE" ] && n="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
n=$((n + 1))
printf '%s' "$n" > "$STATE_FILE" 2>/dev/null || true

# 把最后一次失败的探针输出记下来 —— **重启会让证据消失**，
# 先落盘再动手（否则事后只剩"重启过一次"，不知道为什么）
detail="$(docker inspect --format '{{if .State.Health}}{{range .State.Health.Log}}{{.Output}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null | tail -c 400)"
log "检测到 unhealthy（累计第 $n 次），准备重启。最后探针输出：${detail:-（无）}"

docker restart "$CONTAINER" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  log "已重启 $CONTAINER"
  exit 2
fi

log "重启失败（rc=$rc），需要人工介入"
exit 1
