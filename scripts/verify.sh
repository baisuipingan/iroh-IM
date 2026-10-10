#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-local}"
case "$MODE" in local|browser|all) ;; *) echo 'Usage: bash scripts/verify.sh [local|browser|all]' >&2; exit 2 ;; esac

npm run lint
npm test
npm run check:modules
# 协议类型必须与 Rust 定义一致（漂移是静默的：编译通过、运行期 undefined）
bash scripts/check-protocol-types.sh
# web 是纯 JS、没有类型系统 —— 用"事件名必须真实存在"补等价保证
node scripts/check-web-event-names.mjs
# agent-pi 的类型检查（它此前完全没有；typescript 借用移动端那份）
if [ -x mobile/node_modules/.bin/tsc ]; then
  (cd agent-pi && ../mobile/node_modules/.bin/tsc --noEmit -p tsconfig.json)
else
  echo "⚠️  跳过 agent-pi 类型检查：先 (cd mobile && npm ci) —— 它提供 typescript/@types/node" >&2
fi
git diff --check -- frontend scripts deploy docs README.md package.json package-lock.json biome.json
if [ "$MODE" = local ] || [ "$MODE" = all ]; then
  cargo test --manifest-path client-wasm/Cargo.toml --offline --locked --no-default-features --features cli
  bash scripts/security/run.sh
fi
if [ "$MODE" = browser ] || [ "$MODE" = all ]; then
  node scripts/smoke.mjs
  bash scripts/e2e/run.sh
  npm run test:polish
  # 常驻节点联系不上时必须仍能进房（降级为"孤立"），不能报"进房间失败"
  node scripts/e2e/isolated-room.mjs
  # 阶段 B′：入口与历史是两个独立能力（去掉 anchor、把 history 指死也不能影响进房）
  node scripts/e2e/rendezvous-split.mjs
  node scripts/e2e/history-scroll.mjs
  node scripts/e2e/theme-sync.mjs
  node scripts/e2e/image-layout.mjs
  node scripts/e2e/fix-review.mjs
  node scripts/e2e/message-ownership.mjs
  node scripts/e2e/roomd-storage.mjs
fi
