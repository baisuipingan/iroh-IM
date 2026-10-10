#!/usr/bin/env bash
# 生成三端共用的协议类型。**唯一的定义在 Rust 里**（client-wasm/src/{room,filetransfer}.rs）。
#
# 为什么要有这一步：改造前同一套协议在 Rust / mobile / agent-pi 各写一遍，
# 已经真实漂移过（Rust 发 `relayStatus{relays}`，移动端声明成 `relay{status}`，
# 类型看着对、运行期读 undefined，还不报错）。现在只留 Rust 一份，其余生成。
#
# 用法：bash scripts/gen-protocol-types.sh
# 校验：bash scripts/check-protocol-types.sh（已并入 scripts/verify.sh）
set -euo pipefail
cd "$(dirname "$0")/.."

cargo run --quiet --manifest-path client-wasm/Cargo.toml \
  --offline --locked --no-default-features --features "cli ts-export" \
  --bin export-protocol -- \
  mobile/src/bridge/protocol.gen.ts \
  agent-pi/src/protocol.gen.ts
