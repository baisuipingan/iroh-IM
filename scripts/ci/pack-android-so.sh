#!/usr/bin/env bash
# ============================================================================
# 打包 Android .so + 校验和
#
# 跑法（CI 里由 build-android-so.yml 调）：
#     ABI=arm64-v8a TARGET=aarch64-linux-android bash scripts/ci/pack-android-so.sh
#
# 产物落在 `client-wasm/out-android/`：
#     libiroh_web-arm64-v8a.so
#     libiroh_web-arm64-v8a.so.sha256
#
# ⚠️ 与 pack-agent.sh 保持同样的三条纪律：
#   1. 产物目录先清空（否则上一轮的残留会被当成新产物上传）
#   2. **逐产物**生成 .sha256（下载脚本按 `<file>.sha256` 取）
#   3. 找不到源文件就立刻失败，不要产出空包
# ============================================================================

set -euo pipefail

ABI="${ABI:?ABI 未设置（如 arm64-v8a）}"
TARGET="${TARGET:?TARGET 未设置（如 aarch64-linux-android）}"
WORKSPACE="${WORKSPACE:-$(pwd)}"

SRC_DIR="$WORKSPACE/client-wasm/target/$TARGET/release"
OUT_DIR="$WORKSPACE/client-wasm/out-android"

# ⚠️ Rust 把 cdylib 命名成 libiroh_web.so（下划线是 crate 名 iroh-web 的连字符转换）
SRC="$SRC_DIR/libiroh_web.so"

if [ ! -f "$SRC" ]; then
  echo "❌ 找不到 $SRC" >&2
  echo "   该 target 编出来的东西（供排查）：" >&2
  ls -1 "$SRC_DIR" 2>/dev/null | head -20 >&2 || echo "   （目录不存在：$SRC_DIR）" >&2
  exit 1
fi

# Android 侧的文件名必须带 ABI 标识（jniLibs 按 ABI 目录放，但产物名也带上
# 便于人工辨认是哪一份 —— 之前有过"把 arm64 的包发成了 x86_64 名字"的事故）
ASSET="libiroh_web-$ABI.so"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cp "$SRC" "$OUT_DIR/$ASSET"

# strip 调试符号：Release 构建里符号占大头，剥掉后体积能小一半以上。
#
# ⚠️ 三件事都要注意：
#   1. **找不到 strip 工具时必须自己去找** —— `llvm-strip` 在 CI 里不在 PATH 上，
#      它在 NDK 的 toolchains/llvm/prebuilt/<host>/bin/ 下。原先只 `command -v`，
#      结果 CI 上静默跳过 strip，产物体积翻倍而没有任何提示。
#   2. **不用 `|| true` 吞掉失败** —— strip 失败通常意味着二进制有问题
#      （格式不对 / 架构不匹配），静默吞掉等于把问题推迟到手机上去发现。
#   3. `--strip-unneeded` 才是对共享库正确的级别（`--strip-all` 会连
#      动态符号表一起删，`.so` 直接加载不了）。
STRIP_BIN="${STRIP:-}"
if [ -z "$STRIP_BIN" ]; then
  for c in llvm-strip strip; do
    if command -v "$c" >/dev/null 2>&1; then STRIP_BIN="$c"; break; fi
  done
fi
if [ -z "$STRIP_BIN" ] && [ -n "${ANDROID_NDK_HOME:-}" ]; then
  found="$(find "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" -maxdepth 2 -name 'llvm-strip' -type f 2>/dev/null | head -1)"
  [ -n "$found" ] && STRIP_BIN="$found"
fi

BEFORE=$(wc -c < "$OUT_DIR/$ASSET" | tr -d ' ')
if [ -n "$STRIP_BIN" ]; then
  "$STRIP_BIN" --strip-unneeded "$OUT_DIR/$ASSET"
  AFTER=$(wc -c < "$OUT_DIR/$ASSET" | tr -d ' ')
  echo "🔻 strip: $((BEFORE / 1024 / 1024)) MB → $((AFTER / 1024 / 1024)) MB  ($STRIP_BIN)"
else
  echo "⚠️  没找到 strip 工具，保留调试符号（体积会大一倍左右）"
  echo "     CI 上应设 ANDROID_NDK_HOME，或在 workflow 里把 llvm-strip 加进 PATH"
fi

SIZE=$(wc -c < "$OUT_DIR/$ASSET" | tr -d ' ')
echo "📦 $ASSET  ($((SIZE / 1024 / 1024)) MB)"

# ⚠️ 逐产物校验和，命名必须是 `<asset>.sha256`（下载脚本按这个 URL 取）
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "$ASSET" > "$ASSET.sha256")
else
  # macOS 本地跑时没有 sha256sum
  (cd "$OUT_DIR" && shasum -a 256 "$ASSET" > "$ASSET.sha256")
fi

echo "✅ 产物："
ls -la "$OUT_DIR"
cat "$OUT_DIR/$ASSET.sha256"
