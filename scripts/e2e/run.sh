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
run_case() {            # <显示名> <脚本路径>
  local name="$1" file="$2"
  [ -f "$file" ] || { printf "%-18s (脚本不存在: %s)\n" "$name" "$file"; return 0; }
  env "${CLEAN[@]}" "$PY" scripts/e2e/clear-storage.py >/dev/null 2>&1
  printf "%-18s " "$name"
  env "${CLEAN[@]}" "$PY" "$file" 2>&1 | "$PY" -c "
import sys
last=''
for line in sys.stdin:
    if line.startswith('总计'): last=line.rstrip()
    elif 'Traceback' in line: last='CRASH（见完整输出）'
print(last or '(无结果)')
"
}

if [ "$#" -gt 0 ]; then
  for n in "$@"; do
    for cand in "$n" "/tmp/$n.py" "/tmp/$n-test.py" "scripts/e2e/$n.py"; do
      [ -f "$cand" ] && { run_case "$n" "$cand"; break; }
    done
  done
  exit 0
fi

# 默认：主测试在 /tmp（历史上放在那儿），新增的两个在本目录
run_case "file-history"   /tmp/file-history-test.py
run_case "review-frontend" /tmp/review-frontend.py
run_case "dm-removed"     /tmp/dm-removed-test.py
run_case "stale"          /tmp/stale-test.py
run_case "offline-room"   /tmp/offline-room-test.py
run_case "refresh"        /tmp/refresh-test.py
run_case "leave-cancel"   /tmp/leave-cancel-test.py
run_case "room-isolation" scripts/e2e/room-isolation.py
run_case "card-revive"    scripts/e2e/card-revive.py
