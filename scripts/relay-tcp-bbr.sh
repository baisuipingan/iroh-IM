#!/usr/bin/env bash
set -euo pipefail

PORT=15443
TABLE=15443
PRIORITY=15443

stop() {
  ip -4 rule del priority "$PRIORITY" ipproto tcp sport "$PORT" lookup "$TABLE" 2>/dev/null || true
  ip -4 rule del priority "$((PRIORITY - 1))" ipproto tcp sport "$PORT" lookup main suppress_prefixlength 0 2>/dev/null || true
  ip -4 route flush table "$TABLE" 2>/dev/null || true
}

case "${1:-}" in
  stop) stop; exit 0 ;;
  start) ;;
  *) echo 'Usage: relay-tcp-bbr.sh start|stop' >&2; exit 2 ;;
esac

if ip -4 rule show | grep -Eq "^($PRIORITY|$((PRIORITY - 1))):"; then
  echo 'Policy priority already occupied; refusing to overwrite' >&2
  exit 1
fi
if [[ -n "$(ip -4 route show table "$TABLE" 2>/dev/null || true)" ]]; then
  echo 'Routing table already occupied; refusing to overwrite' >&2
  exit 1
fi
mapfile -t DEFAULTS < <(ip -4 route show default)
if [[ "${#DEFAULTS[@]}" -ne 1 ]]; then
  echo 'Expected exactly one IPv4 default route; refusing to guess' >&2
  exit 1
fi
modprobe tcp_bbr
read -r -a ROUTE <<< "${DEFAULTS[0]}"
trap stop ERR
ip -4 route add table "$TABLE" "${ROUTE[@]}" congctl bbr
ip -4 rule add priority "$((PRIORITY - 1))" ipproto tcp sport "$PORT" lookup main suppress_prefixlength 0
ip -4 rule add priority "$PRIORITY" ipproto tcp sport "$PORT" lookup "$TABLE"
ip -4 rule show
ip -4 route show table "$TABLE"
