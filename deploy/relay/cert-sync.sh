#!/usr/bin/env bash
# 把外部签发的证书同步成中继 Reloading 模式期望的命名（default.crt / default.key）。
# 中继会**周期性自动重读**，所以证书续期后**不需要重启**，连接不中断。
#
# 实测（2026-09-29）：cert_mode = "Reloading" 期望的文件名就是 default.crt + default.key；
#   1Panel 输出的是 fullchain.pem/privkey.pem，名字对不上会直接启动失败——所以要有这一步改名。
#
# 由 cron 定时跑（建议每 6 小时），或放进 1Panel 的「计划任务」：
#   0 */6 * * * /opt/iroh/relay/cert-sync.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/.env" ]; then
  set -a; . "$HERE/.env"; set +a
fi

SRC="${CERT_SRC_DIR:?需要 CERT_SRC_DIR（见 .env）}"
SRC_CRT="${CERT_SRC_CRT:-fullchain.pem}"
SRC_KEY="${CERT_SRC_KEY:-privkey.pem}"
DST="$HERE/certs"
RESTART_ON_CHANGE="${RESTART_ON_CHANGE:-0}"

mkdir -p "$DST"
chmod 755 "$DST"

for f in "$SRC/$SRC_CRT" "$SRC/$SRC_KEY"; do
  [ -r "$f" ] || { echo "读不到源文件: $f" >&2; exit 1; }
done

# 源证书要能解析，避免半途写入的文件被同步过去
openssl x509 -in "$SRC/$SRC_CRT" -noout >/dev/null 2>&1 || { echo "源证书格式异常: $SRC/$SRC_CRT" >&2; exit 1; }

sum() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || echo none; }
BEFORE="$(sum "$DST/default.crt")"

install -m 644 "$SRC/$SRC_CRT" "$DST/default.crt"
install -m 644 "$SRC/$SRC_KEY" "$DST/default.key"
AFTER="$(sum "$DST/default.crt")"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "证书无变化"
  exit 0
fi

echo "证书已更新 → $DST/default.crt"
if [ "$RESTART_ON_CHANGE" = "1" ]; then
  echo "（Manual 模式）重启容器 ${CONTAINER_NAME:-iroh-relay}"
  docker restart "${CONTAINER_NAME:-iroh-relay}"
  docker ps --filter "name=^${CONTAINER_NAME:-iroh-relay}$" --format '{{.Names}} {{.Status}}'
else
  echo "（Reloading 模式）中继会自动重读，无需重启"
fi
