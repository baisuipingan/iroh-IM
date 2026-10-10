#!/usr/bin/env bash
# ============================================================================
# 下载 Android .so 到本地模块的 jniLibs
#
# 跑法：
#     bash scripts/fetch-android-so.sh            # 取 latest
#     bash scripts/fetch-android-so.sh android-v1.0.0
#
# 为什么要这个脚本：`.so` 是**编译产物、不入库**（几十 MB，且每个人的机器
# 都可能不同）。开发者 checkout 之后必须下载一次才能编 Android。
# 手工下载容易出错且漏校验，所以固化成脚本。
#
# ⚠️ 校验和**必须验**。它是唯一能发现"下载被中间人替换/截断"的手段。
#    历史上这里有过一次"脚本静默跳过校验"的设计缺陷（见 release-agent.yml
#    的注释），别重蹈覆辙 —— 拿不到 .sha256 就直接失败，不要"跳过"。
# ============================================================================

set -euo pipefail
TAG="${1:-latest}"
ABI="${ABI:-arm64-v8a}"

REPO="baisuipingan/iroh-IM"
ASSET="libiroh_web-$ABI.so"

# ⚠️ `latest` 必须按**本产物族的 tag 前缀**解析，**不能**用 GitHub 的 `releases/latest`。
#
# 这个仓库有两条产物线（`agent-v*` 与 `android-v*`），而 GitHub 的 Latest **全局只有一个**：
# 谁最后发布谁就是 Latest，另一条线立刻 404。2026-10-10 就真踩到了 —— 发了
# `agent-v1.2.0` 之后，这条脚本默认路径开始找不到 `.so`（反过来也一样）。
# 所以这里查一次 releases 列表，取**最新的 android-* **。
resolve_latest_tag() {   # $1 = tag 前缀
  curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null \
    | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"\(.*\)"/\1/' \
    | grep "^$1" | head -1
}

if [ "$TAG" = "latest" ]; then
  TAG="$(resolve_latest_tag android-)"
  [ -n "$TAG" ] || { echo "❌ 没能从 GitHub 解析出 android 的 Release tag（网络？）—— 也可以显式指定：bash $0 android-v0.2.0" >&2; exit 1; }
  echo "ℹ️  latest → $TAG"
fi
BASE="https://github.com/$REPO/releases/download/$TAG"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HERE/../mobile/modules/iroh-native/android/src/main/jniLibs/$ABI"
DEST="$DEST_DIR/$ASSET"

# 目标里 .so 的文件名是固定的 `libiroh_web.so`（Android 按这个名字 dlopen）
TARGET_NAME="libiroh_web.so"

echo "⬇️  $BASE/$ASSET"
mkdir -p "$DEST_DIR"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ⚠️ curl -o 失败时**不会清空**已存在的文件。先删，否则会把上次的残留
#    当成"下载成功"（这个坑在别处误判过一次：多个文件算出同一个哈希）
rm -f "$TMP/$ASSET" "$TMP/$ASSET.sha256"

curl -sSL --fail -o "$TMP/$ASSET" "$BASE/$ASSET"
curl -sSL --fail -o "$TMP/$ASSET.sha256" "$BASE/$ASSET.sha256"

echo "🔐 校验"
EXPECTED="$(awk '{print $1}' "$TMP/$ASSET.sha256")"
if [ -z "$EXPECTED" ]; then
  echo "❌ .sha256 是空的 —— 拒绝继续（不做"跳过校验"的降级）" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
else
  ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "❌ 校验和不匹配！" >&2
  echo "   期望：$EXPECTED" >&2
  echo "   实际：$ACTUAL" >&2
  exit 1
fi

install -m 644 "$TMP/$ASSET" "$DEST_DIR/$TARGET_NAME"

SIZE=$(wc -c < "$DEST_DIR/$TARGET_NAME" | tr -d ' ')
echo "✅ 已安装 $DEST_DIR/$TARGET_NAME  ($((SIZE / 1024 / 1024)) MB)"
echo
echo "下一步： cd mobile && npx expo prebuild -p android && npx expo run:android"
echo "（或交给 EAS Build，见 mobile/README.md）"
