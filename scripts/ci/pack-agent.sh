#!/usr/bin/env bash
# 把构建产物打包成发布用的压缩包 + 校验和。
#
# 用法：
#   pack-agent.sh <target-triple> <osname> <arch> <ext>
# 例：
#   pack-agent.sh aarch64-apple-darwin darwin arm64 tar.gz
#   pack-agent.sh x86_64-pc-windows-msvc windows amd64 zip
#
# 环境变量：
#   WORKSPACE  —— 仓库根目录（CI 里是 $GITHUB_WORKSPACE，默认取脚本上两级）
#   OUTDIR     —— 产物输出目录（默认 $WORKSPACE/client-wasm/out）
#
# 为什么把这段从 workflow 里搬出来：它原本是内联在 YAML 里的多行脚本，
# 里面有 heredoc 的 Python，**缩进稍有不慎就会把 YAML 结构与 heredoc 一起搞坏**，
# 而且完全没法在本地跑。抽成文件后既能本地验证，YAML 里也只剩一行调用。
#
# 这里集中了四个真踩过的坑（每一个都对应一次失败）：
#   1. 产物名叫 `agent`，但四个安装脚本都按 `iroh-agent` 找 → 必须改名再打包
#   2. 必须传 --target，否则产物落在 target/release/ 且架构是 runner 自己的
#      → 交叉产物会**静默装错架构**（check-arch.py 负责拦住）
#   3. Windows runner 的 Git Bash 里**没有 zip 命令** → 三级降级
#   4. 校验和输出格式必须是 "<hash>  <file>"，安装脚本按这个解析
set -euo pipefail

TARGET="${1:?用法: pack-agent.sh <target> <osname> <arch> <ext>}"
OSNAME="${2:?缺少 osname}"
ARCH="${3:?缺少 arch}"
EXT="${4:?缺少 ext}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${WORKSPACE:-$(cd "$HERE/../.." && pwd)}"
OUTDIR="${OUTDIR:-$WORKSPACE/client-wasm/out}"

NAME=iroh-agent
REL="$WORKSPACE/client-wasm/target/$TARGET/release"
ASSET="$NAME-$OSNAME-$ARCH.$EXT"
PLATFORM="$OSNAME-$ARCH"

mkdir -p "$OUTDIR"

# ---- 1. 产物必须存在（不存在就是 --target 漏了）----
# ⚠️⚠️ **不要用 `[ -f ... ]` 去"探测"产物叫什么名字** —— 在 Git Bash（MSYS2）里
#      它会**自动补 `.exe` 后缀**：`[ -f "$REL/agent" ]` 在只有 `agent.exe` 时
#      也返回真。于是 `-f agent || -f agent.exe` 这种回退根本不会触发，
#      接着 Python（原生 Windows 进程，不做这个补全）打开 `agent` 直接
#      FileNotFoundError —— 两个 Windows job 就是这么挂的。
#      正确做法是**按目标平台直接推导**文件名（cargo 的规则是确定的：
#      windows 目标产 `agent.exe`，其它产 `agent`），并且用 Python 判存在性。
if [ "$OSNAME" = windows ]; then
  BINPATH="$REL/agent.exe"
else
  BINPATH="$REL/agent"
fi

if ! python3 -c "import os, sys; sys.exit(0 if os.path.isfile(sys.argv[1]) else 1)" "$BINPATH"; then
  {
    echo "❌ 找不到产物：$BINPATH"
    echo "   构建大概率没带 --target（不带时产物会落在 target/release/）"
    echo "   target/ 下现有目录："
    ls -1 "$WORKSPACE/client-wasm/target" 2>/dev/null || true
  } >&2
  exit 1
fi

# ---- 2. 架构断言（拦"静默装错架构"）----
python3 "$HERE/check-arch.py" "$BINPATH" "$PLATFORM"

# ---- 3. 改名后打包（安装脚本按 iroh-agent 找）----
case "$EXT" in
  zip) EXE="$NAME.exe" ;;
  *)   EXE="$NAME" ;;
esac
cp "$BINPATH" "$OUTDIR/$EXE"

cd "$OUTDIR"
if [ "$EXT" = zip ]; then
  # ⚠️ Windows runner 的 Git Bash 里没有 zip；bsdtar 在 Windows 上通常有；
  #    python 在所有 GitHub runner 上都有。三级降级，总能打出来。
  if command -v zip >/dev/null 2>&1; then
    zip -q -j "$ASSET" "$EXE"
    echo "  打包方式：zip"
  elif command -v bsdtar >/dev/null 2>&1; then
    bsdtar --format zip -cf "$ASSET" "$EXE"
    echo "  打包方式：bsdtar --format zip"
  else
    python3 - "$ASSET" "$EXE" <<'PY'
import sys
import zipfile

asset, exe = sys.argv[1], sys.argv[2]
# ZIP_DEFLATED 需要 zlib；没有就退到 STORED（只影响体积，不影响可解压）
try:
    z = zipfile.ZipFile(asset, "w", zipfile.ZIP_DEFLATED)
except RuntimeError:
    z = zipfile.ZipFile(asset, "w", zipfile.ZIP_STORED)
with z:
    z.write(exe, exe)
print(f"  打包方式：python zipfile")
PY
  fi
else
  chmod 755 "$EXE"
  tar -czf "$ASSET" "$EXE"
  echo "  打包方式：tar -czf"
fi
rm -f "$EXE"

# ---- 4. 列出包内容：命名错误要在这里暴露，而不是等用户装不上 ----
#     ⚠️ 这里刻意**不用** `INNER="$(case ... esac)"` 那种写法：
#     外层引号 + case + 内层 python -c 的引号会互相打架，bash 直接报
#     `syntax error near unexpected token`（踩过）。分成两步最稳。
echo "--- $ASSET 内容 ---"
case "$EXT" in
  zip)
    python3 - "$ASSET" <<'PY'
import sys
import zipfile

for n in zipfile.ZipFile(sys.argv[1]).namelist():
    print("   ", n)
PY
    ;;
  *)
    tar -tzf "$ASSET" | sed 's/^/    /'
    ;;
esac

# 包里必须只有一个文件，且名字就是安装脚本要找的那个
if [ "$EXT" = zip ]; then
  INNER="$(python3 -c 'import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).namelist()[0])' "$ASSET")"
else
  INNER="$(tar -tzf "$ASSET" | head -1)"
fi
case "$INNER" in
  "$NAME" | "$NAME.exe") ;;
  *)
    echo "❌ 包内文件是 '$INNER'，但安装脚本要找 '$NAME'（或 $NAME.exe）" >&2
    exit 1
    ;;
esac
echo "  ✅ 包内文件名正确：$INNER"

# ---- 5. 能原生运行的产物，顺手验一下真的起得来 ----
#     ⚠️ 这里必须同时看**压缩格式**和**目标三元组**，不能只看三元组：
#        - zip 包要用 unzip/zipfile 解，用 `tar -xzf` 会失败；
#        - zip 包里文件名带 .exe，硬找 "iroh-agent" 会找不到（踩过）。
#     只有 linux-arm64 是真正的交叉产物（runner 是 x86_64），只验格式。
CAN_RUN=1
case "$TARGET" in
  aarch64-unknown-linux-gnu) CAN_RUN=0 ;;   # 交叉：x86_64 runner 跑不了 arm64
esac

if [ "$CAN_RUN" = 1 ]; then
  rm -f "$INNER"
  if [ "$EXT" = zip ]; then
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall()' "$ASSET"
  else
    tar -xzf "$ASSET"
  fi
  if [ ! -f "$INNER" ]; then
    echo "❌ 解包后没找到 $INNER" >&2
    exit 1
  fi
  # Windows 上 Git Bash 能直接执行 .exe
  if ./"$INNER" --help >/dev/null 2>&1; then
    echo "  ✅ 二进制可执行（原生验证：./$INNER --help）"
  else
    echo "❌ 产物无法执行：./$INNER --help 失败" >&2
    exit 1
  fi
  rm -f "$INNER"
else
  echo "  ⏭  交叉产物（${TARGET}），只验格式不做执行验证"
fi

# ---- 6. 校验和（格式必须统一，安装脚本按 "<hash>  <file>" 解析）----
#     ⚠️ 同样不能假设某个命令一定存在：Windows 的 Git Bash 里 sha256sum/shasum
#     都不保证有。python3 在所有 GitHub runner 上都有，兜底最稳。
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ASSET" > "$ASSET.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$ASSET" > "$ASSET.sha256"
else
  python3 - "$ASSET" <<'PY'
import hashlib
import sys

name = sys.argv[1]
# 分块读，避免大文件一次性进内存
h = hashlib.sha256()
with open(name, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
# 格式必须与 sha256sum 一致："<hash>  <file>"（两个空格）
with open(name + ".sha256", "w") as out:
    out.write(f"{h.hexdigest()}  {name}\n")
print("  校验和：python hashlib")
PY
fi
cat "$ASSET.sha256"
echo "  ✅ 完成：$OUTDIR/$ASSET"
