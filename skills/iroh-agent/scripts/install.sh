#!/usr/bin/env bash
# iroh-agent · Skill 自带的安装脚本（macOS / Linux）
#
# 自包含：只依赖 curl + tar，可以连整个 skills/iroh-agent/ 目录一起复制到任何机器。
# 与 deploy/install/agent-install.sh 是**同一套产物命名约定**的两份实现：
#   - 那份给人和运维（功能更全，支持非交互参数）
#   - 这份随 Skill 分发，逻辑更短
# 改一处时记得同步另一处，以及 .github/workflows/release-agent.yml 的矩阵。
set -euo pipefail

BIN=iroh-agent
REPO="${AGENT_REPO:-baisuipingan/iroh-IM}"
DIR="${AGENT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/iroh-agent}"
PREFIX="${AGENT_PREFIX:-/usr/local/bin}"
BASE_URL="${AGENT_RELEASE_BASE:-}"
VERSION="${AGENT_VERSION:-}"
CONFIRM="${CONFIRM:-}"

# ⚠️ set -u 下**每一个**被读的变量都必须先有默认值。
# 漏一个就像踩陷阱：`[ -n "$ANCHOR_RELAY" ]` 在调用方没传这个变量时
# 会报 "ANCHOR_RELAY: unbound variable" 并**直接终止脚本**（配置根本没写出来）。
RELAY="${RELAY:-https://iroh1.editor.vip:15443}"
ANCHOR_RELAY="${ANCHOR_RELAY:-}"
TOKEN="${TOKEN:-}"
ANCHOR_ID="${ANCHOR_ID:-}"
NICK="${NICK:-命令行成员}"

c()  { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
ok() { c '0;32' "  ✅ $*"; }
wa() { c '0;33' "  ⚠️  $*"; }
die(){ c '0;31' "  ❌ $*" >&2; exit 1; }

plat() {
  local raw os arch
  raw="$(uname -s)"
  case "$raw" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT*) os=windows ;;
    Darwin*) os=darwin ;;
    *)       os=linux ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "不支持的架构 $(uname -m)" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

remove() {
  rm -f "$PREFIX/$BIN"
  ok "已删除 $PREFIX/$BIN"
  if [ -d "$DIR" ]; then
    if [ -n "$CONFIRM" ]; then rm -rf "$DIR"; ok "已删除配置与身份 $DIR"
    else wa "保留了 ${DIR}（含身份密钥）。要一起删：CONFIRM=yes $0 remove"; fi
  fi
}

case "${1:-install}" in
  remove) remove; exit 0 ;;
  install) ;;
  *) die "用法：bash $0 [install|remove]" ;;
esac

P="$(plat)"
case "$P" in windows-*)
  c '0;33' "检测到 Windows —— 请改用 PowerShell 版："
  echo "    powershell -ExecutionPolicy Bypass -File scripts/install.ps1"
  exit 0 ;;
esac
ok "平台 $P"

# ⚠️ "latest" 必须按**本产物族的 tag 前缀**解析，不能用 GitHub 的 `releases/latest`。
# 这个仓库有两条产物线（`agent-v*` / `android-v*`），而 GitHub 的 Latest 全局只有一个：
# 谁最后发布谁就是 Latest，另一条线立刻 404（2026-10-10 真踩到：发了 `agent-v1.2.0`
# 之后 `fetch-android-so.sh` 的默认路径就找不到 `.so` 了，反过来同理）。
latest_tag() {   # $1 = tag 前缀
  curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null \
    | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"\(.*\)"/\1/' \
    | grep "^$1" | head -1
}

[ -n "$BASE_URL" ] || {
  if [ -n "$VERSION" ]; then
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
  else
    V="$(latest_tag agent-v)"
    [ -n "$V" ] || die "没能从 GitHub 解析出 agent 的 Release（网络？）—— 也可以显式指定：AGENT_VERSION=agent-v1.2.0 $0"
    c '0;36' "  latest → $V"
    BASE_URL="https://github.com/$REPO/releases/download/$V"
  fi
}
ASSET="$BIN-$P.tar.gz"
URL="$BASE_URL/$ASSET"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
c '0;36' "  下载 $URL"
if ! curl -fsSL --retry 3 -o "$tmp/$ASSET" "$URL"; then
  wa "下载失败（Release 里还没有这个平台的产物？）"
  wa "可以从源码构建（需要 Rust）："
  wa "  git clone https://github.com/$REPO && cd client-wasm"
  # ⚠️ cargo 里的 bin 名字是 `agent`（不是安装后的 iroh-agent）。
  #    故意不加 --offline —— 那是依赖已在本地缓存时才有用的开关，
  #    首次构建加了会因为缓存是空的而失败。
  wa "  cargo build --release --locked --no-default-features --features cli --bin agent"
  wa "  install -m 755 target/release/agent $PREFIX/$BIN"
  exit 1
fi

if curl -fsSL -o "$tmp/sum" "$BASE_URL/$ASSET.sha256" 2>/dev/null; then
  want="$(cut -d' ' -f1 < "$tmp/sum" | tr -d '\r')"
  have="$(shasum -a 256 "$tmp/$ASSET" 2>/dev/null | awk '{print $1}' || sha256sum "$tmp/$ASSET" | awk '{print $1}')"
  [ "$want" = "$have" ] || die "校验和不匹配（期望 $want 实际 ${have}）"
  ok "校验和通过"
else
  wa "没拿到 .sha256，跳过校验"
fi

mkdir -p "$PREFIX"
tar -xzf "$tmp/$ASSET" -C "$tmp"
install -m 0755 "$tmp/$BIN" "$PREFIX/$BIN"
ok "已安装 $PREFIX/$BIN"

mkdir -p "$DIR"; chmod 700 "$DIR"
[ -n "$ANCHOR_RELAY" ] && RELAY="$ANCHOR_RELAY"
cat > "$DIR/config.json" <<JSON
{
  "relays": ["$RELAY"],
  "relay_token": "$TOKEN",
  "anchor": { "id": "$ANCHOR_ID", "relay": "$RELAY" },
  "nickname": "$NICK"
}
JSON
chmod 600 "$DIR/config.json"
ok "配置已写入 $DIR/config.json（0600）"
[ -n "$ANCHOR_ID" ] || wa "没给 ANCHOR_ID —— 不配锚点的话进房可能失败（收不到历史、也难被发现）"
[ -n "$TOKEN" ]      || wa "没给 TOKEN —— 中继开了鉴权的话会连不上"

echo
ok "完成。验证一下（这一步会真的连中继）："
echo "     $BIN whoami"
echo "     $BIN say   --room 我的项目 '构建完成'"
echo "     $BIN send  --room 我的项目 --file /tmp/pkg.tar.gz"
echo "     $BIN watch --room 我的项目"
