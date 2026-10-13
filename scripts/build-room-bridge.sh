#!/usr/bin/env bash
# 把 agent-pi 编成**单文件可执行**（bun --compile）——"下载一个文件就能跑"的那份适配器。
#
# 用法：
#   bash scripts/build-room-bridge.sh                 # 只编当前平台 → dist/room-bridge/
#   bash scripts/build-room-bridge.sh --all           # 六个平台全编（CI/发版用）
#   bash scripts/build-room-bridge.sh --target bun-darwin-arm64
#
# 产物：dist/room-bridge/room-bridge-<os>-<arch>[.exe] (+ .sha256)
#
# 设计口径：
#   · **不含 pi-sdk**：cli.ts 里那两处动态 import 是"计算出来的"（见 loadPiSdkModule），
#     打包器看不到 ⇒ 不会把 pi SDK 带进来（它带原生模块 .node，打进单文件不可靠、
#     体积还要涨几十 MB）。rule / command / acp 三条路完整；pi-sdk 用仓库版 / npm 版跑，
#     在单文件里报错也是人话。
#   · 依赖 `iroh-agent` 二进制在 PATH（和仓库版一样），本脚本不打包它。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/room-bridge"
BUN="${BUN:-bun}"
MINIFY=1

TARGETS=()
MODE=local
for arg in "$@"; do
  case "$arg" in
    --all) MODE=all ;;
    --target) MODE=target ;;
    bun-*) TARGETS+=("$arg") ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

command -v "$BUN" >/dev/null 2>&1 || {
  echo "❌ 找不到 bun。装一个：curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

os_of() { case "$1" in bun-darwin-*) echo darwin ;; bun-linux-*) echo linux ;; bun-windows-*) echo windows ;; *) echo "$1" ;; esac; }
arch_of() { case "$1" in *-arm64) echo arm64 ;; *-x64) echo amd64 ;; *) echo "?" ;; esac; }

case "$MODE" in
  local)
    t="bun-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
    TARGETS=("$t")
    ;;
  all)
    TARGETS=(bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64 bun-windows-arm64)
    ;;
esac

mkdir -p "$OUT"
for t in "${TARGETS[@]}"; do
  ext=""; [ "$(os_of "$t")" = windows ] && ext=".exe"
  out="$OUT/room-bridge-$(os_of "$t")-$(arch_of "$t")$ext"
  echo "==> $t → $(basename "$out")"
  "$BUN" build --compile ${MINIFY:+--minify} \
    --target "$t" \
    "$ROOT/agent-pi/src/cli.ts" \
    --outfile "$out"
  # 反"静默错架构"（release-agent 那边踩过的同类坑：交叉编译没生效的产物
  # 能解压、能过校验和，唯独在目标机上跑不起来）——file 会如实显示 Mach-O/ELF/PE 架构
  if command -v file >/dev/null 2>&1; then
    desc="$(file -b "$out")"
    case "$(arch_of "$t")" in
      arm64) echo "$desc" | grep -qiE 'arm64|aarch64' || { echo "❌ $out 不是 arm64：$desc" >&2; exit 1; } ;;
      amd64) echo "$desc" | grep -qiE 'x86[_-]?64' || { echo "❌ $out 不是 x86_64：$desc" >&2; exit 1; } ;;
    esac
  fi
  if command -v shasum >/dev/null 2>&1; then
    (cd "$(dirname "$out")" && shasum -a 256 "$(basename "$out")" | awk '{print $1}' > "$(basename "$out").sha256")
  else
    (cd "$(dirname "$out")" && sha256sum "$(basename "$out")" | awk '{print $1}' > "$(basename "$out").sha256")
  fi
done
echo "✅ 产物在 $OUT"
ls -lh "$OUT"
