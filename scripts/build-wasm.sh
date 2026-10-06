#!/usr/bin/env bash
# 在构建机上编译 wasm 包与原生验证客户端，并把产物拉回本地。
#
# 为什么在服务器上编：本地拉 GitHub / crates.io 大依赖不稳，且 ring 需要 clang，
# 构建机（Linux）一次装好最省事。产物是平台无关的，拉回来即可用。
#
# 用法：
#   ./scripts/build-wasm.sh            # 只编 wasm（--dev 快速迭代）
#   ./scripts/build-wasm.sh release    # 编 release（体积/性能优化）
#   ./scripts/build-wasm.sh native     # 编原生 relay-probe 到 dist/
#
# 环境变量：
#   IROH_BUILD_HOST  构建机，默认 root@189.24.70.253
#   IROH_BUILD_PORT  SSH 端口，默认 22
#   IROH_BUILD_KEY   SSH 私钥，默认 ~/Desktop/ssh/mindcrew/codex
#   IROH_BUILD_DIR   构建机上的目录，默认 /opt/iroh-build/client-wasm
set -euo pipefail

MODE="${1:-dev}"
HOST="${IROH_BUILD_HOST:-root@189.24.70.253}"
PORT="${IROH_BUILD_PORT:-22}"
KEY="${IROH_BUILD_KEY:-$HOME/Desktop/ssh/mindcrew/codex}"
DIR="${IROH_BUILD_DIR:-/opt/iroh-build/client-wasm}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -i "$KEY" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 "$HOST")
# ⚠️ `-p` 必须加：scp 默认**不保留时间戳**，拉回来的产物 mtime 是"传输时刻"，
#    于是下面那句"产物必须比源码新"的自检**恒为通过**（源码总是更早），
#    等于把"这次构建到底有没有生效"的唯一自动判据废掉了（复检 P3-12）。
SCP=(scp -p -i "$KEY" -P "$PORT" -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)

echo "==> 检查 $HOST 的构建工具链"
"${SSH[@]}" 'for tool in /opt/iroh-build/cargo/bin/cargo /opt/iroh-build/cargo/bin/rustc /opt/iroh-build/cargo/bin/wasm-pack; do
  if [ ! -x "$tool" ]; then
    echo "缺少构建工具: $tool；请先迁移或安装工具链，当前服务器只能运行已有产物。" >&2
    exit 1
  fi
done'

echo "==> 同步源码到 $HOST:$DIR"
"${SSH[@]}" "mkdir -p $DIR/src/bin"
# ⚠️ 必须用 rsync 全量同步整个 src/ —— 之前是逐个 scp 指定文件，
# 结果新增的 filetransfer.rs / room.rs / transfer_orchestrator.rs 忘了加进去，
# 构建机上常年跑旧代码（表现为「改了源码但行为不变」，极难排查）。
# 用 rsync --delete 保证远端与本地完全一致。
rsync -az --delete -e "ssh -i $KEY -p $PORT -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3" \
  "$ROOT/client-wasm/src/" "$HOST:$DIR/src/"
rsync -az --delete -e "ssh -i $KEY -p $PORT -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3" \
  "$ROOT/client-wasm/vendor/" "$HOST:$DIR/vendor/"
# ⚠️ `Cargo.lock` **必须一起同步**，并且构建要加 `--locked`（复检缺陷 F9）。
#    只同步 Cargo.toml 的话，远端那份 lock 会自己漂移，
#    `cargo` 于是"按语义化版本允许范围"重新解析依赖 —— 上线的那份 wasm
#    来自由**没人审查过**的依赖图，而且失败是无声的（构建成功、行为不同）。
#    这与"P2-11 把 Cargo.lock 修同步"的初衷是矛盾的：锁了，但构建路径绕过了它。
"${SCP[@]}" "$ROOT/client-wasm/Cargo.toml" "$ROOT/client-wasm/Cargo.lock" "$HOST:$DIR/"

BUILD_ENV='export CARGO_HOME=/opt/iroh-build/cargo RUSTUP_HOME=/opt/iroh-build/rustup PATH=/opt/iroh-build/cargo/bin:$PATH'

# ⚠️ 远程命令必须 `set -o pipefail`。
#    之前写的是 `wasm-pack build ... 2>&1 | tail -20`，而远程 shell 没开 pipefail，
#    管道的退出码取自 `tail`（永远 0）→ **编译失败也被当成成功**，
#    脚本继续把**旧产物**拉回来，还打印"完成"。
#    后果：源码改了、构建"成功"了、行为却不变，极难排查。
REMOTE_PIPEFAIL='set -o pipefail'

case "$MODE" in
  release)
    echo "==> wasm-pack build (release)"
    "${SSH[@]}" "$REMOTE_PIPEFAIL; cd $DIR && $BUILD_ENV && wasm-pack build --target web --release --out-dir pkg -- --locked 2>&1 | tail -20"
    ;;
  dev)
    echo "==> wasm-pack build (dev)"
    "${SSH[@]}" "$REMOTE_PIPEFAIL; cd $DIR && $BUILD_ENV && wasm-pack build --target web --dev --out-dir pkg -- --locked 2>&1 | tail -20"
    ;;
  native)
    echo "==> cargo build --release --features cli（原生 relay-probe + roomd）"
    "${SSH[@]}" "$REMOTE_PIPEFAIL; cd $DIR && $BUILD_ENV && cargo build --release --locked --no-default-features --features cli 2>&1 | tail -20"
    mkdir -p "$ROOT/dist"
    # ⚠️ roomd 也必须一起拉回来（复检缺陷 F3）：
    #    deploy/roomd/Dockerfile 是 `COPY roomd /usr/local/bin/roomd`，
    #    而这个模式原来**只**拉 relay-probe —— 于是 deploy/roomd/README.md 里
    #    那句 `scp ... dist/roomd ...` 根本找不到文件，而仓库里那份旧二进制
    #    会让 `docker compose up -d --build` 悄悄上线几天前的锚点。
    "${SCP[@]}" "$HOST:$DIR/target/release/relay-probe" "$HOST:$DIR/target/release/roomd" "$ROOT/dist/"
    echo "==> 产物：$ROOT/dist/relay-probe 与 $ROOT/dist/roomd（x86_64 Linux）"
    exit 0
    ;;
  *)
    echo "未知模式: $MODE（可选 dev | release | native）" >&2
    exit 1
    ;;
esac

mkdir -p "$ROOT/frontend/pkg"
echo "==> 拉回 wasm 产物到 frontend/pkg"
"${SCP[@]}" -r "$HOST:$DIR/pkg/." "$ROOT/frontend/pkg/"

# 收尾自检：产物必须**比源码新**，否则说明这次构建其实没生效（防上面那类静默失败）
NEWER=$(find "$ROOT/client-wasm/src" "$ROOT/client-wasm/vendor" -name '*.rs' -newer "$ROOT/frontend/pkg/iroh_web_bg.wasm" 2>/dev/null | head -1 || true)
if [[ -n "$NEWER" ]]; then
  echo "!! 警告：wasm 比源码旧（$(basename "$NEWER") 更新），本次构建很可能没生效" >&2
  exit 1
fi

ls -lh "$ROOT/frontend/pkg" | head -12
echo "==> 完成（wasm 已确认比源码新）"
