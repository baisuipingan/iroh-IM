#!/usr/bin/env bash
# 跑浏览器端到端回归。
#
# ## 前置（缺一不可）
#   1) 本地静态服务：python3 scripts/dev-serve.py 8099   （服务 frontend/，强制不缓存）
#   2) 带 CDP 的 Chrome：--headless=new --remote-debugging-port=9222 --no-sandbox
#      ⚠️ 必须 --no-sandbox：本环境里 Chrome 自带沙箱初始化会失败并让主进程退出。
#   3) 本机端口要清代理，否则被沙箱代理拦成 502：
#      env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy NO_PROXY=127.0.0.1,localhost
#
# ## ⚠️ 为什么每个用例之前都要清存储
#   这些用例用**固定房名 + 固定身份 key**，上一轮留在 IndexedDB（库 `iroh-transfers`，
#   断点位图）与 localStorage（持久化邀约）里的数据会污染下一轮 ——
#   表现为"进不了房"或 `done=0`。单独跑就过、连跑就挂，极易误判成代码 bug。
#
# 用法：bash scripts/e2e/run.sh [用例名...]   （默认全部）
set -uo pipefail
cd "$(dirname "$0")/../.."
PY="${PY:-/Users/patrick/.workbuddy/binaries/python/versions/3.13.12/bin/python3}"
CLEAN=(-u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy)
export NO_PROXY=127.0.0.1,localhost

# 用例：脚本名 → 说明
# 每个用例的**完整输出**都落一份日志 —— 只打一行结果的话，失败时没法诊断
# （踩过：套件里某个用例偶发 CRASH，只看到"CRASH"却无处看详情）。
LOG_DIR="${E2E_LOG_DIR:-/tmp/e2e-logs}"

SUMMARY_PY='import sys
lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().splitlines()
total = next((l.strip() for l in reversed(lines) if l.startswith("总计")), "")
if total:
    print(total); sys.exit(0)
err = [l for l in lines if l.startswith(("Traceback", "TimeoutError", "urllib", "  File"))]
print("CRASH  " + sys.argv[1])
for l in err[-3:]:
    print("    " + l.strip()[:150])'

run_case() {            # <显示名> <脚本路径>
  local name="$1" file="$2"
  [ -f "$file" ] || { printf "%-18s (脚本不存在: %s)\n" "$name" "$file"; return 0; }
  env "${CLEAN[@]}" "$PY" scripts/e2e/clear-storage.py >/dev/null 2>&1
  mkdir -p "$LOG_DIR"
  local log="$LOG_DIR/$name.log"
  env "${CLEAN[@]}" "$PY" "$file" > "$log" 2>&1
  printf "%-18s " "$name"
  "$PY" -c "$SUMMARY_PY" "$log"
}

if [ "$#" -gt 0 ]; then
  for n in "$@"; do
    for cand in "$n" "/tmp/$n.py" "/tmp/$n-test.py" "scripts/e2e/$n.py"; do
      [ -f "$cand" ] && { run_case "$n" "$cand"; break; }
    done
  done
  exit 0
fi

# 全部用例都在本目录（原来散在 /tmp，重启即丢；搬进来才受版本控制）
run_case "file-history"    scripts/e2e/file-history.py
run_case "multi-peer"      scripts/e2e/multi-peer.py
run_case "review-frontend" scripts/e2e/review-frontend.py
run_case "dm-removed"      scripts/e2e/dm-removed.py
run_case "stale"           scripts/e2e/stale.py
run_case "offline-room"    scripts/e2e/offline-room.py
run_case "refresh"         scripts/e2e/refresh.py
run_case "leave-cancel"    scripts/e2e/leave-cancel.py
run_case "room-isolation"  scripts/e2e/room-isolation.py
run_case "card-revive"     scripts/e2e/card-revive.py
run_case "sidebar-pages"   scripts/e2e/sidebar-pages.py
run_case "relay-enabled"   scripts/e2e/relay-enabled.py   # ⚠️ 会临时改 relay-config.json（自动还原）
