#!/usr/bin/env bash
# ============================================================================
#  room-bridge · 单文件适配器安装 / 卸载
#
#  用法（新机器上一条命令）：
#     bash -c "$(curl -sSL https://get.editor.vip/iroh/room-bridge-install.sh)"
#  卸载：
#     bash -c "$(curl -sSL …/room-bridge-install.sh)" remove
#
#  它是什么：agent-pi 编成的**单文件可执行**（bun --compile）——不需要 Node、
#  不需要 clone 仓库。rule / command / acp 三条大脑可用；pi-sdk 需要 Node 版
#  （npm / 仓库），在单文件里会给一句人话提示。
#
#  ⚠️ 它只是"手"，还需要 `iroh-agent` 这个"腿"（另一个静态二进制，负责协议）。
#     没装的话脚本会提示那条一行命令。
#
#  可覆盖的环境变量：VERSION（默认取最新 bridge-v*）、PREFIX、REPO、
#  BASE_URL。非交互：VERSION=bridge-v0.1.0 CONFIRM=yes bash room-bridge-install.sh
# ============================================================================
set -euo pipefail

BIN=room-bridge
REPO="${REPO:-baisuipingan/iroh-IM}"
VERSION="${VERSION:-}"
BASE_URL="${BASE_URL:-}"
CONFIRM="${CONFIRM:-}"
EXPLICIT_PREFIX="${PREFIX:-}"

c()  { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
ok()  { c '0;32' "  ✅ $*"; }
wa()  { c '0;33' "  ⚠️  $*"; }
er()  { c '0;31' "  ❌ $*" >&2; }
die() { er "$*"; exit 1; }

# ---------------------------------------------------------------- 平台检测
detect() {
  local raw os arch
  raw="$(uname -s)"
  os="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT*) os=windows ;;
    Darwin*)  os=darwin ;;
    Linux*)   os=linux ;;
    *) wa "未识别的系统 '$raw'，按 linux 处理" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "不支持的架构 $(uname -m)" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

if [ "$(detect | cut -d- -f1)" = windows ]; then
  c '0;33' "检测到 Windows —— 改用 PowerShell 版安装器："
  echo
  echo "    irm https://get.editor.vip/iroh/room-bridge-install.ps1 | iex"
  echo
  exit 0
fi

# 安装目录：显式 PREFIX > 系统可写的 /usr/local/bin > ~/.local/bin
pick_prefix() {
  if [ -n "$EXPLICIT_PREFIX" ]; then printf '%s' "$EXPLICIT_PREFIX"; return; fi
  if [ -w /usr/local/bin ] 2>/dev/null; then printf '%s' "/usr/local/bin"; return; fi
  printf '%s' "$HOME/.local/bin"
}
PREFIX="$(pick_prefix)"

latest_tag() {   # $1 = tag 前缀；GitHub 的 releases/latest 在这里不可用（两条产物线）
  curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null \
    | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"\(.*\)"/\1/' \
    | grep "^$1" | head -1
}

uninstall() {
  local target
  for target in "/usr/local/bin/$BIN" "$HOME/.local/bin/$BIN"; do
    [ -e "$target" ] && { rm -f "$target"; c '0;33' "已删除 $target"; }
  done
  [ -n "$EXPLICIT_PREFIX" ] && [ -e "$EXPLICIT_PREFIX/$BIN" ] && rm -f "$EXPLICIT_PREFIX/$BIN"
  c '0;33' "（不碰 iroh-agent 与身份目录）"
  exit 0
}

case "${1:-install}" in
  remove|uninstall) uninstall ;;
  install) ;;
  *) die "用法：bash $0 [install|remove]" ;;
esac

c '0;36' "== room-bridge · 单文件适配器 =="
PLAT="$(detect)"
ok "平台 $PLAT"

if [ -n "$VERSION" ]; then
  BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
elif [ -z "$BASE_URL" ]; then
  V="$(latest_tag bridge-v)"
  [ -n "$V" ] || die "没能从 GitHub 解析出 bridge 的 Release（网络？）——可显式指定：VERSION=bridge-v0.1.0 $0"
  ok "latest → $V"
  BASE_URL="https://github.com/$REPO/releases/download/$V"
fi

ASSET="$BIN-$PLAT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
c '0;36' "  下载 $BASE_URL/$ASSET"
if ! curl -fsSL --retry 3 -o "$TMP/$ASSET" "$BASE_URL/$ASSET"; then
  wa "下载失败（还没发布 Release？也可以自己编：bash scripts/build-room-bridge.sh）"
  exit 1
fi
if curl -fsSL -o "$TMP/$ASSET.sha256" "$BASE_URL/$ASSET.sha256" 2>/dev/null; then
  sum="$(cut -d' ' -f1 < "$TMP/$ASSET.sha256" | tr -d '\r')"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$sum  $TMP/$ASSET" | sha256sum -c - >/dev/null || die "校验和不匹配"
  elif command -v shasum >/dev/null 2>&1; then
    [ "$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')" = "$sum" ] || die "校验和不匹配"
  fi
  ok "校验和通过"
else
  die "拿不到 $ASSET.sha256 —— 供应链校验失败，拒绝安装"
fi

mkdir -p "$PREFIX"
install -m 0755 "$TMP/$ASSET" "$PREFIX/$BIN"
ok "已安装 $PREFIX/$BIN"

# 它需要 iroh-agent（协议实现，"腿"）——缺了就**顺带装好**：
# 一条命令装全两台"设备"。只想要适配器：SKIP_AGENT=1；自建镜像：AGENT_SCRIPT_URL=...
if [ "${SKIP_AGENT:-}" = "1" ]; then
  wa "SKIP_AGENT=1：跳过 iroh-agent 的检查与安装"
elif command -v iroh-agent >/dev/null 2>&1 || [ -x "$PREFIX/iroh-agent" ] || [ -x "$HOME/.local/bin/iroh-agent" ]; then
  ok "iroh-agent 已在（腿有了）"
else
  wa "没装 iroh-agent（room-bridge 只是适配器，协议在它那里）——顺带装上："
  if curl -fsSL --retry 2 -o "$TMP/agent-install.sh" \
       "${AGENT_SCRIPT_URL:-https://get.editor.vip/iroh/agent-install.sh}" \
     && SKIP_CONFIG=1 AGENT_PREFIX="$PREFIX" bash "$TMP/agent-install.sh"; then
    ok "iroh-agent 已装到 $PREFIX"
  else
    er "iroh-agent 自动安装失败（网络？）——手动补上这一条后重跑本命令："
    echo '     bash -c "$(curl -sSL https://get.editor.vip/iroh/agent-install.sh)"'
    exit 1
  fi
fi

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) wa "$PREFIX 不在 PATH 里，把它加进去：export PATH=\"$PREFIX:\$PATH\"（写进 ~/.zshrc / ~/.bashrc）" ;;
esac

echo
ok "完成。试试："
echo "     $BIN --room 我的房间 --nick 小派 --bio '会查代码' --tags ts,rust --brain acp --acp-bin claude-code-acp"
echo "     $BIN --help"
echo
wa "需要 Node 的 pi-sdk 大脑不在这份单文件里（npm/仓库版支持）。"
