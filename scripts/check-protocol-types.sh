#!/usr/bin/env bash
# 校验"提交的协议类型 == Rust 定义生成出来的"。
#
# 为什么要单独一条检查：类型漂移是**静默**的（编译通过、运行期 undefined），
# 只有把"重新生成再比对"做成常规闸门才挡得住。
set -euo pipefail
cd "$(dirname "$0")/.."

# 用 target/ 下的固定目录，避免污染工作区
OUT="client-wasm/target/protocol-check"
mkdir -p "$OUT"

cargo run --quiet --manifest-path client-wasm/Cargo.toml \
  --offline --locked --no-default-features --features "cli ts-export" \
  --bin export-protocol -- "$OUT/mobile.ts" "$OUT/agent-pi.ts" >/dev/null

fail=0
for pair in "mobile/src/bridge/protocol.gen.ts:$OUT/mobile.ts" "agent-pi/src/protocol.gen.ts:$OUT/agent-pi.ts"; do
  committed="${pair%%:*}"; generated="${pair##*:}"
  if cmp -s "$committed" "$generated"; then
    echo "    ✅ $committed 与 Rust 定义一致"
  else
    echo "    ❌ $committed 与 Rust 定义**不一致** —— 跑 bash scripts/gen-protocol-types.sh 后提交"
    diff -u "$committed" "$generated" | head -30 || true
    fail=1
  fi
done
exit "$fail"
