#!/usr/bin/env bash
# ============================================================================
# 本地编 Android .so（一般不需要 —— CI 已经代劳，见
# .github/workflows/build-android-so.yml）
#
# 什么时候用：
#   - 改了 Rust 核心、想在自己机器上先验证（不想等 CI）
#   - CI 挂了要复现
#
# 前置：Android NDK。装法（macOS）：
#     brew install --cask android-ndk          # 约 3-4 GB
#   或者从 https://developer.android.com/ndk/downloads 下 zip 解到任意位置，
#   然后 `export ANDROID_NDK_HOME=/path/to/ndk`。
#
# ⚠️ 不需要完整 Android Studio —— 只要有 NDK 的 clang 就能编出 .so。
#    （`ring` 是唯一一个需要 C 交叉编译的依赖。）
# ============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ABI="${ABI:-arm64-v8a}"
TARGET="${TARGET:-aarch64-linux-android}"
API="${API:-24}"

# --- 找 NDK ---------------------------------------------------------------
if [ -n "${ANDROID_NDK_HOME:-}" ]; then
  NDK="$ANDROID_NDK_HOME"
elif [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
  NDK="$(ls -d "$ANDROID_HOME/ndk"/* 2>/dev/null | sort -V | tail -1)"
elif [ -d /opt/homebrew/share/android-ndk ]; then
  NDK=/opt/homebrew/share/android-ndk
elif [ -d /usr/local/share/android-ndk ]; then
  NDK=/usr/local/share/android-ndk
else
  echo "❌ 找不到 NDK。装一个：" >&2
  echo "     brew install --cask android-ndk" >&2
  echo "   或下载后 export ANDROID_NDK_HOME=/path/to/ndk" >&2
  exit 1
fi

# NDK 的 prebuilt 目录名与宿主平台有关（linux-x86_64 / darwin-x86_64）
HOST_TAG="$(ls "$NDK/toolchains/llvm/prebuilt" 2>/dev/null | head -1)"
if [ -z "$HOST_TAG" ]; then
  echo "❌ NDK 结构不对：找不到 toolchains/llvm/prebuilt（NDK=$NDK）" >&2
  exit 1
fi
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"

CC="$TOOLCHAIN/bin/${TARGET}${API}-clang"
AR="$TOOLCHAIN/bin/llvm-ar"

# 不同 NDK 版本的 clang 命名略有差异（有的没有 API 后缀），兜底找一下
if [ ! -x "$CC" ]; then
  CC="$(ls "$TOOLCHAIN/bin/" 2>/dev/null | grep -E "^${TARGET}[0-9]+-clang$" | head -1)"
  CC="$TOOLCHAIN/bin/$CC"
fi

if [ ! -x "$CC" ]; then
  echo "❌ 找不到 ${TARGET} 的 clang（在 $TOOLCHAIN/bin）" >&2
  ls "$TOOLCHAIN/bin" | grep -E "clang$" | head -5 >&2
  exit 1
fi

echo "NDK       : $NDK"
echo "TOOLCHAIN : $TOOLCHAIN"
echo "CC        : $CC"
echo "ABI       : $ABI  TARGET: $TARGET  API: $API"
echo

# --- 编 -----------------------------------------------------------------
# ⚠️ 必须显式给 cc-rs 工具链，否则 ring 会去找 PATH 里的
#    `aarch64-linux-android-clang`（不存在）然后失败。
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC"
export CC_aarch64-linux-android="$CC"
export AR_aarch64-linux-android="$AR"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_AR="$AR"

cd "$ROOT/client-wasm"

rustup target add "$TARGET" >/dev/null 2>&1 || true

# 本地第一次编是联网拉依赖（CI 里才用 --offline --locked）
cargo build --release \
  --no-default-features --features cli \
  --target "$TARGET"

# --- 打包 ----------------------------------------------------------------
export ABI TARGET WORKSPACE="$ROOT"
bash "$ROOT/scripts/ci/pack-android-so.sh"

echo
echo "下一步（把 .so 放进模块）："
echo "  mkdir -p $ROOT/mobile/modules/iroh-native/android/src/main/jniLibs/$ABI"
echo "  cp $ROOT/client-wasm/out-android/libiroh_web-$ABI.so \\"
echo "     $ROOT/mobile/modules/iroh-native/android/src/main/jniLibs/$ABI/libiroh_web.so"
