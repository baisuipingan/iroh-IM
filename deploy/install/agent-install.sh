#!/usr/bin/env bash
# ============================================================================
#  iroh-agent · 无头命令行聊天室成员 · 一台机器的全部安装
#
#  用法（新机器上一条命令）：
#     bash -c "$(curl -sSL https://get.editor.vip/iroh/agent-install.sh)"
#  卸载：
#     bash -c "$(curl -sSL …/agent-install.sh)" remove
#
#  它是什么：一个静态二进制，**没有运行时依赖**（只用 libc/libm/libgcc）。
#  不需要 Node、不需要浏览器、不需要 wasm 运行时。装完就能在终端里作为
#  一个普通成员进聊天室 —— 发文字、发文件，并等对方点"接收"。
#
#  设计原则：
#   - 身份持久化在 ~/.config/iroh-agent/identity.key（0600），
#     所以它在房间里是"固定的那个人"，你能认出它。
#   - 配置与前端同一套字段（relays / relay_token / anchor），
#     也可用 IROH_AGENT_RELAY / IROH_AGENT_TOKEN 等环境变量覆盖。
#   - 私钥/令牌文件一律 0600。
#
#  非交互（CI/批量）：
#     RELAY=https://iroh1.editor.vip:15443 \
#     TOKEN=… ANCHOR_ID=… CONFIRM=yes bash agent-install.sh
# ============================================================================
set -euo pipefail

BIN=iroh-agent
DIR="${AGENT_DIR:-/root/.config/iroh-agent}"
PREFIX="${AGENT_PREFIX:-/usr/local/bin}"
REPO="${AGENT_REPO:-baisuipingan/iroh-IM}"
# 可自建镜像地址（把 Release 里的二进制挂上去也行）
BASE_URL="${AGENT_RELEASE_BASE:-https://github.com/$REPO/releases/latest/download}"
VERSION="${AGENT_VERSION:-}"
CONFIRM="${CONFIRM:-}"

# ⚠️ set -u 下**每一个**被读的变量都必须先有默认值。
# 漏一个就像踩陷阱：`[ -n "$ANCHOR_RELAY" ]` 在调用方没传这个变量时
# 会报 "ANCHOR_RELAY: unbound variable" 并**直接终止脚本** —— 配置根本没写出来，
# 但用户已经看到"已安装二进制"，很容易以为装完了。
RELAY="${RELAY:-https://iroh1.editor.vip:15443}"
ANCHOR_RELAY="${ANCHOR_RELAY:-}"
TOKEN="${TOKEN:-}"
ANCHOR_ID="${ANCHOR_ID:-}"
NICK="${NICK:-命令行成员}"

c()  { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
ok()  { c '0;32' "  ✅ $*"; }
wa()  { c '0;33' "  ⚠️  $*"; }
er()  { c '0;31' "  ❌ $*" >&2; }
die() { er "$*"; exit 1; }

uninstall() {
  rm -f "$PREFIX/$BIN"
  c '0;33' "已删除二进制 $PREFIX/$BIN"
  if [ -d "$DIR" ]; then
    if [ -n "$CONFIRM" ]; then rm -rf "$DIR"; c '0;33' "已删除配置与身份 $DIR"
    else wa "保留了 ${DIR}（含身份密钥），要一起删：CONFIRM=yes $0 remove"; fi
  fi
  exit 0
}

# ---------------------------------------------------------------- 平台检测
# 返回 "os-arch"，例如 linux-amd64 / darwin-arm64 / windows-amd64
detect() {
  local raw os arch
  raw="$(uname -s)"
  os="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  # Git Bash / MSYS / Cygwin / WSL 之外还有 MSYS 的 "MINGW64_NT-…" 之类
  case "$raw" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT*) os=windows ;;
    Darwin*)  os=darwin ;;
    Linux*)   os=linux ;;
    *) wa "未识别的系统 '$raw'，按 linux 处理" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *)
      # Git Bash 的 uname -m 也可能是 x86_64
      arch="$(printf '%s' "${PROCESSOR_ARCHITECTURE:-}" | tr '[:upper:]' '[:lower:]')"
      case "$arch" in
        amd64|x86_64) arch=amd64 ;;
        arm64)        arch=arm64 ;;
        *) die "不支持的架构 $(uname -m)" ;;
      esac
      ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

# Windows 走 PowerShell 版：bash 能认出来，但装 .exe / 配 PATH / 设 ACL 都该由 PowerShell 做
if [ "$(detect | cut -d- -f1)" = windows ]; then
  c '0;33' "检测到 Windows —— 改用 PowerShell 版安装器（它会处理 .exe、PATH 与文件权限）"
  echo
  echo "    irm https://get.editor.vip/iroh/agent-install.ps1 | iex"
  echo
  if command -v pwsh >/dev/null 2>&1; then
    wa "检测到 pwsh，直接调用仓库里的 agent-install.ps1："
    exit 0
  fi
  exit 0
fi

install_binary() {
  local plat tarball tmp sum
  plat="$(detect)"
  mkdir -p "$PREFIX"
  # Windows 产物打包成 zip —— PowerShell 5.1 自带的 Expand-Archive 只认 zip
  case "$plat" in
    windows-*) ext=zip ;;
    *)         ext=tar.gz ;;
  esac
  tarball="$BIN-$plat.$ext"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN

  if [ -n "$VERSION" ]; then
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
  fi
  c '0;36' "  下载 $BASE_URL/$tarball"
  if ! curl -fsSL --retry 3 -o "$tmp/$tarball" "$BASE_URL/$tarball"; then
    wa "下载失败（还没发布 Release？）"
    wa "可以在这台机器上直接从源码构建（需要 Rust）："
    wa "  git clone https://github.com/$REPO && cd client-wasm"
    wa "  cargo build --release --offline --locked --no-default-features --features cli --bin $BIN"
    wa "  install -m 755 target/release/$BIN $PREFIX/$BIN"
    return 1
  fi
  # 有 .sha256 就校验
  if curl -fsSL -o "$tmp/sum" "$BASE_URL/$tarball.sha256" 2>/dev/null; then
    sum="$(cut -d' ' -f1 < "$tmp/sum" | tr -d '\r')"
    if command -v sha256sum >/dev/null; then
      echo "$sum  $tmp/$tarball" | sha256sum -c - >/dev/null || die "校验和不匹配"
    elif command -v shasum >/dev/null; then
      [ "$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')" = "$sum" ] || die "校验和不匹配"
    fi
    ok "校验和通过"
  fi
  tar -xzf "$tmp/$tarball" -C "$tmp"   # GNU tar 与 bsdtar 都能解 .tar.gz
  install -m 0755 "$tmp/$BIN" "$PREFIX/$BIN"
  ok "已安装 $PREFIX/$BIN"
}

write_config() {
  mkdir -p "$DIR"; chmod 700 "$DIR"
  local relay="${RELAY:-https://iroh1.editor.vip:15443}"
  [ -n "$ANCHOR_RELAY" ] && relay="$ANCHOR_RELAY"
  cat > "$DIR/config.json" <<JSON
{
  "relays": ["$relay"],
  "relay_token": "${TOKEN:-}",
  "anchor": { "id": "${ANCHOR_ID:-}", "relay": "$relay" },
  "nickname": "${NICK:-命令行成员}"
}
JSON
  chmod 600 "$DIR/config.json"
  ok "配置已写入 $DIR/config.json（0600）"
  if [ -z "$ANCHOR_ID" ]; then
    wa "没给 ANCHOR_ID —— 不配锚点的话进房可能失败（收不到历史、也难被发现）"
  fi
  if [ -z "$TOKEN" ]; then
    wa "没给 TOKEN —— 中继开了鉴权的话会连不上"
  fi
}

case "${1:-install}" in
  remove|uninstall) uninstall ;;
  install) ;;
  *) die "用法：bash $0 [install|remove]" ;;
esac

c '0;36' "== iroh-agent · 无头命令行聊天室成员 =="
detect >/dev/null && ok "平台 $(detect)"
if install_binary; then
  write_config
  echo
  ok "完成。试试："
  echo "     $BIN whoami"
  echo "     $BIN say   --room 我的项目 '构建完成'"
  echo "     $BIN send  --room 我的项目 --file /tmp/pkg.tar.gz"
  echo "     $BIN watch --room 我的项目"
  echo
  wa "发布新版本：在仓库里为该平台构建 $BIN-<os>-<arch>.tar.gz 并上传到 Release。"
else
  c '0;33' "没装上，但你可以直接从源码构建（见上面的命令）。"
  exit 1
fi