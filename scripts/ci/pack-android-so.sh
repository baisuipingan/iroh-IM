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
# ⚠️⚠️ 四个坑，全是踩出来的：
#
#   1. **搜索顺序必须是「NDK 优先」**，不能先 `command -v strip`。
#      CI（ubuntu）上 PATH 里有 GNU binutils 的 `strip`，它**读不了 ARM ELF**：
#          strip: Unable to recognise the format of the input file '…arm64-v8a.so'
#      必须用 NDK 自带的 `llvm-strip`（支持多架构）。
#      这是真实翻过的一次车 —— 我一开始写 `for c in llvm-strip strip`，
#      在 macOS 上恰好命中 llvm-strip（没事），到 CI 上命中了 GNU strip（红）。
#
#   2. **找到之后要试一下能不能用**，别只看"文件存在"。工具在 PATH 上 ≠
#      这个工具认得我们的目标格式。
#
#   3. **不用 `|| true` 吞掉失败** —— strip 失败通常意味着拿错工具或二进制有问题，
#      静默吞掉等于把问题推到手机上去发现。（上面那次的报错就是这条帮忙暴露的。）
#
#   4. `--strip-unneeded` 是共享库该用的级别。
#      （实测更正：我原先注释说"`--strip-all` 会删掉动态符号表"——**不准确**。
#        llvm-strip 对 `.so` 用 `--strip-all` 实测**仍保留** `.dynsym` 里的
#        13 个 JNI 符号，因为 `.so` 必须留动态符号表才能被 dlopen。
#        差别只在体积：`--strip-all` 会多剥掉一些 `.symtab` 里的东西。
#        选 `--strip-unneeded` 是因为它对共享库是**语义正确**的选项、
#        且足够激进；不是因为 `--strip-all` 会坏事。别再照着错的说法推理。）

# 候选顺序：显式指定 → NDK → PATH 上叫 llvm-strip 的 → 系统 strip（最后手段）
#
# ⚠️⚠️ `-type f` **绝对不能加**，这是真实踩到的坑。
#    NDK 的 `bin/` 里几乎全是**符号链接**（`aarch64-linux-android24-clang`
#    指向 `clang-18`，`llvm-strip` 指向 `llvm-objcopy`……）。
#    写成 `-type f` 会把它们全部排除 → 一个都找不到 → 回落到系统 strip → 报错。
#    （brew 装的 llvm 也一样：/opt/homebrew/opt/llvm/bin/llvm-strip 是个链接。）
#    所以这里**不限制类型**，让下一段的"真跑一次试试"来决定它能不能用。
STRIP_CANDIDATES=""
[ -n "${STRIP:-}" ] && STRIP_CANDIDATES="$STRIP"
if [ -n "${ANDROID_NDK_HOME:-}" ]; then
  ndk_strip="$(find "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" \
    -maxdepth 3 -name 'llvm-strip' 2>/dev/null | head -1)"
  [ -n "$ndk_strip" ] && STRIP_CANDIDATES="$STRIP_CANDIDATES $ndk_strip"
fi
STRIP_CANDIDATES="$STRIP_CANDIDATES $(command -v llvm-strip 2>/dev/null || true)"
STRIP_CANDIDATES="$STRIP_CANDIDATES $(command -v strip 2>/dev/null || true)"

# 逐个试：能真正处理这个文件的才算数（`--version` 不报错 ≠ 认得 ARM ELF）
STRIP_BIN=""
for cand in $STRIP_CANDIDATES; do
  [ -x "$cand" ] || continue
  # 复制一份去试，避免反复改动真产物
  probe="$OUT_DIR/.strip-probe"
  cp "$OUT_DIR/$ASSET" "$probe"
  if "$cand" --strip-unneeded "$probe" >/dev/null 2>&1; then
    STRIP_BIN="$cand"
    rm -f "$probe"
    break
  fi
  rm -f "$probe"
done

BEFORE=$(wc -c < "$OUT_DIR/$ASSET" | tr -d ' ')
if [ -n "$STRIP_BIN" ]; then
  "$STRIP_BIN" --strip-unneeded "$OUT_DIR/$ASSET"
  AFTER=$(wc -c < "$OUT_DIR/$ASSET" | tr -d ' ')
  echo "🔻 strip: $((BEFORE / 1024 / 1024)) MB → $((AFTER / 1024 / 1024)) MB  ($STRIP_BIN)"
else
  echo "⚠️  没找到能处理 ARM ELF 的 strip 工具，保留调试符号（体积会大一倍左右）"
  echo "      试过的候选：$STRIP_CANDIDATES"
  echo "      CI 上应设 ANDROID_NDK_HOME 指向 NDK；它会用自带的 llvm-strip"

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
