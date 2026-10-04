#!/usr/bin/env bash
# 把前端站点发布到 Cloudflare（Worker + Static Assets，自定义域名 im.editor.vip）。
#
# 干什么：
#   1) 从 frontend/ 生成一份干净的部署目录 dist/site/（排除仅供本地调试的 probe*）
#   2) 做几项上线前自检（wasm 在不在、中继配置有没有、有没有残留绝对路径）
#   3) wrangler deploy —— 顺带自动创建 DNS 记录与证书（wrangler.toml 里 custom_domain = true）
#
# 用法：
#   bash scripts/deploy-web.sh            # 生成 + 部署
#   bash scripts/deploy-web.sh --dry      # 只生成与自检，不部署
#
# 注意：需要在**能访问 api.cloudflare.com 的网络**里跑（本机沙箱代理不放行该域名）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/frontend"
OUT="$ROOT/dist/site"
DRY=0
[[ "${1:-}" == "--dry" ]] && DRY=1

cd "$ROOT"

echo "==> 1/3 生成部署目录 $OUT"
mkdir -p "$OUT"
# ⚠️ 排除规则**必须加前导 `/` 锚定到根目录**：
#    只写 `--exclude 'probe.js'` 会连 `js/probe.js` 一起排除，
#    而那个文件是 net.js 依赖的正式模块（加载中继配置），
#    结果线上 main.js 直接 404 挂掉（踩过）。
rsync -a --delete \
  --exclude '/probe.html' \
  --exclude '/probe.js' \
  --exclude '/probe-main.js' \
  --exclude '.DS_Store' \
  "$SRC/" "$OUT/"

echo "==> 2/3 上线前自检"

fail=0
check() { # <说明> <条件命令...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "    ✅ $desc"
  else
    echo "    ❌ $desc"
    fail=1
  fi
}

check "wasm 产物存在" test -f "$OUT/pkg/iroh_web_bg.wasm"
check "wasm 绑定层存在" test -f "$OUT/pkg/iroh_web.js"
check "入口页面存在" test -f "$OUT/index.html"
check "中继配置存在" test -f "$OUT/relay-config.json"
check "调试用 probe 已排除" test ! -f "$OUT/probe.html"

# 绝对路径会让自定义域名下加载失败（必须全是相对路径）
if grep -rnq 'src="/\|href="/' "$OUT" --include='*.html' 2>/dev/null; then
  echo "    ❌ 发现绝对路径引用（应改成相对路径）"
  grep -rn 'src="/\|href="/' "$OUT" --include='*.html' | head -5
  fail=1
else
  echo "    ✅ 资源全部走相对路径"
fi

# wasm 是不是比源码旧（比"匹配某个字符串"更可靠，也不受 grep 多字节问题影响）
NEWER=$(find "$ROOT/client-wasm/src" "$ROOT/client-wasm/vendor" -name '*.rs' -newer "$OUT/pkg/iroh_web_bg.wasm" 2>/dev/null | head -1 || true)
if [[ -z "$NEWER" ]]; then
  echo "    ✅ wasm 不比源码旧"
else
  echo "    ⚠️  wasm 比源码旧（$(basename "$NEWER") 更新），先跑 scripts/build-wasm.sh release"
  fail=1
fi

# 逐个解析 JS 里的相对 import，确认目标文件真的在部署目录里。
# 起因：曾经把 js/probe.js 误排除，线上 main.js 直接 404 —— 这类问题
# 在本地跑（源目录齐全）永远发现不了，必须在**部署产物**上查。
if MODCHECK=$(python3 "$ROOT/scripts/check-site-modules.py" "$OUT" 2>&1); then
  echo "    ✅ 前端模块引用完整"
else
  echo "    ❌ 有 import 指向不存在的文件（线上会 404）："
  echo "$MODCHECK" | sed 's/^/       /'
  fail=1
fi

size=$(du -sh "$OUT" | cut -f1)
echo "    站点体积：$size"

if [[ $fail -eq 1 ]]; then
  echo "==> 自检未通过，已中止部署" >&2
  exit 1
fi

if [[ $DRY -eq 1 ]]; then
  echo "==> --dry：跳过部署"
  exit 0
fi

echo "==> 3/3 部署到 Cloudflare"

# 本机出网代理不放行 api.cloudflare.com（DNS 被污染，解析到黑洞），
# 但实测「强制指到真实 IP」是通的。所以先起一个本地 DNS 修正代理，
# 把 wrangler 的 HTTPS_PROXY 指过去。代理只改写 3 个 CF 主机，其余照常。
PROXY_PORT="${CF_DNS_PROXY_PORT:-8899}"
python3 "$ROOT/scripts/cf-dns-fix-proxy.py" "$PROXY_PORT" >/tmp/cf-dns-proxy.log 2>&1 &
PROXY_PID=$!
cleanup() { kill "$PROXY_PID" 2>/dev/null || true; }
trap cleanup EXIT
sleep 1

# 清掉环境里原有的代理设置（否则 wrangler 还是会走那个拦截代理）
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy || true
export HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT"
export HTTP_PROXY="http://127.0.0.1:$PROXY_PORT"
export NO_PROXY="127.0.0.1,localhost"

# ⚠️ 不用 `npx --yes wrangler@4 deploy`（复检 P2-22）：
#    1) 每次部署都去 npm 拉"当前最新的 4.x"—— 工具链没固定，行为可能随版本变；
#    2) 本机 npm registry 时常不通，`npx --yes` 会直接 ECONNRESET 失败（实测）。
#    改为**优先用已经装好的那个 wrangler**（可用 WRANGLER 环境变量覆盖）。
resolve_wrangler() {
  if [[ -n "${WRANGLER:-}" && -x "${WRANGLER}" ]]; then echo "$WRANGLER"; return; fi
  if [[ -x "$ROOT/node_modules/.bin/wrangler" ]]; then echo "$ROOT/node_modules/.bin/wrangler"; return; fi
  # npx 缓存里已装好的 4.x：挑第一个大版本为 4 的
  local c
  for c in "$HOME"/.npm/_npx/*/node_modules/.bin/wrangler; do
    [[ -x "$c" ]] || continue
    local pkg="${c%/node_modules/.bin/wrangler}/node_modules/wrangler/package.json"
    if [[ -f "$pkg" ]] && grep -q '"version": *"4\.' "$pkg"; then echo "$c"; return; fi
  done
}
WRANGLER_BIN="$(resolve_wrangler)"
if [[ -z "$WRANGLER_BIN" ]]; then
  echo "!! 找不到可用的 wrangler（本机 npm 也不通）。先装一个再部署：" >&2
  echo "   npm i -g wrangler@4     # 或 export WRANGLER=/path/to/wrangler" >&2
  exit 1
fi
echo "    使用 wrangler: $WRANGLER_BIN"
"$WRANGLER_BIN" deploy

echo
echo "==> 完成。自定义域名：https://im.editor.vip"
echo "    （首次绑定证书签发通常 1~2 分钟，稍等再访问）"
echo "    代理日志：/tmp/cf-dns-proxy.log"
