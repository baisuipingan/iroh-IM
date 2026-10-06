#!/usr/bin/env bash
# 跑全套安全回归（用原始攻击脚本验证修复）。
set -uo pipefail
cd "$(dirname "$0")/../../client-wasm"
export PATH="$HOME/.cargo/bin:$PATH"

fail=0
for ex in attack-verify attack-stream; do
  echo "========== $ex =========="
  if cargo run --offline --locked --no-default-features --features cli --example "$ex" 2>&1 | tail -20; then
    :
  else
    fail=1
  fi
  echo
done

if [ "$fail" -ne 0 ]; then
  echo "!! 有攻击未被挡住 —— 见上面输出" >&2
  exit 1
fi
echo "全部攻击均被挡住 ✅"
