#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-local}"
case "$MODE" in local|browser|all) ;; *) echo 'Usage: bash scripts/verify.sh [local|browser|all]' >&2; exit 2 ;; esac

npm run lint
npm test
npm run check:modules
git diff --check -- frontend scripts deploy docs README.md package.json package-lock.json biome.json
if [ "$MODE" = local ] || [ "$MODE" = all ]; then
  cargo test --manifest-path client-wasm/Cargo.toml --offline --locked --no-default-features --features cli
  bash scripts/security/run.sh
fi
if [ "$MODE" = browser ] || [ "$MODE" = all ]; then
  node scripts/smoke.mjs
  bash scripts/e2e/run.sh
  npm run test:polish
  node scripts/e2e/history-scroll.mjs
  node scripts/e2e/theme-sync.mjs
  node scripts/e2e/image-layout.mjs
  node scripts/e2e/fix-review.mjs
  node scripts/e2e/message-ownership.mjs
  node scripts/e2e/roomd-storage.mjs
fi
