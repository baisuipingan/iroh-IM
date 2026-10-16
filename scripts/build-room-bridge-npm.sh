#!/usr/bin/env bash
# 生成 **npm 包目录**（dist/npm-room-bridge/），到那一步 `npm publish` 就行。
#
# 为什么"编一遍再发"：Node 对 node_modules 里的 .ts 不做类型剥离 ——
# 直接把 agent-pi 的 TS 源码发上 npm 是跑步起来的。
# 为什么要单独 staging 一个目录、而不是直接发 agent-pi/：agent-pi/package.json 是
# **仓库开发**用的（依赖里带着 pi SDK，npm ci 就该装它）；而 npm 上的消费者
# 大多数用 acp/command/rule，不该被拖 172MB 的 SDK —— 所以 pi SDK 在 npm 包里
# 是**可选 peer**，随包只带编译产物。
#
# 产物结构：
#   package.json          （name=iroh-room-bridge，bin=room-bridge → dist/cli.mjs）
#   dist/cli.mjs          （bundle：rule/command/acp + room 侧全部）
#   dist/agent-io/*.mjs   （pi-sdk 相关：只有用到 --brain pi-sdk 时才被动态加载）
#   examples/rules.json   （--brain rule 的示例）
#   README.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${BUN:-bun}"
STAGE="$ROOT/dist/npm-room-bridge"
VERSION="${VERSION:-0.2.7}"

command -v "$BUN" >/dev/null 2>&1 || { echo "❌ 找不到 bun（curl -fsSL https://bun.sh/install | bash）" >&2; exit 1; }

rm -rf "$STAGE"
mkdir -p "$STAGE/dist/agent-io" "$STAGE/examples"

echo "==> 构建 bundle"
"$BUN" build --target node --minify "$ROOT/agent-pi/src/cli.ts" --outfile "$STAGE/dist/cli.mjs"
"$BUN" build --target node --minify \
  --external '@earendil-works/pi-coding-agent' \
  "$ROOT/agent-pi/src/agent-io/pi-sdk.ts" --outfile "$STAGE/dist/agent-io/pi-sdk.mjs"
"$BUN" build --target node --minify \
  --external '@earendil-works/pi-coding-agent' \
  "$ROOT/agent-pi/src/agent-io/tools.ts" --outfile "$STAGE/dist/agent-io/tools.mjs"

# bin 需要 shebang（bun 不写）
# bin 需要 shebang：cli.ts 第一行本来就是 `#!/usr/bin/env node`，bun 构建时会保留；
# 只有它没保留时才自己补（曾经这里无条件再 prepend 一次 → 两行 shebang → 语法错）。
if [ "$(head -c 2 "$STAGE/dist/cli.mjs")" != "#!" ]; then
  printf '#!/usr/bin/env node\n' | cat - "$STAGE/dist/cli.mjs" > "$STAGE/dist/cli.mjs.tmp"
  mv "$STAGE/dist/cli.mjs.tmp" "$STAGE/dist/cli.mjs"
fi
chmod +x "$STAGE/dist/cli.mjs"

echo "==> 语法自检（node --check）"
node --check "$STAGE/dist/cli.mjs"
node --check "$STAGE/dist/agent-io/pi-sdk.mjs"
node --check "$STAGE/dist/agent-io/tools.mjs"

cp "$ROOT/agent-pi/examples/rules.json" "$STAGE/examples/rules.json"

cat > "$STAGE/package.json" <<JSON
{
  "name": "iroh-room-bridge",
  "version": "$VERSION",
  "description": "把一个 Agent（Claude Code / 任意 CLI / pi）接进 iroh 聊天室：它就是房间里一个普通成员，被 @ 才说话",
  "type": "module",
  "bin": { "room-bridge": "dist/cli.mjs" },
  "files": ["dist/", "examples/", "README.md"],
  "engines": { "node": ">=20" },
  "license": "MIT OR Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/baisuipingan/iroh-IM.git",
    "directory": "agent-pi"
  },
  "homepage": "https://github.com/baisuipingan/iroh-IM/blob/main/docs/bring-your-own-agent.md",
  "bugs": "https://github.com/baisuipingan/iroh-IM/issues",
  "keywords": ["iroh", "chatroom", "agent", "acp", "claude-code", "p2p"],
  "peerDependencies": { "@earendil-works/pi-coding-agent": ">=0.83.0" },
  "peerDependenciesMeta": { "@earendil-works/pi-coding-agent": { "optional": true } }
}
JSON

cat > "$STAGE/README.md" <<'MD'
# iroh-room-bridge

把一个 Agent（Claude Code / 任意 CLI / pi）接进 [iroh 聊天室](https://github.com/baisuipingan/iroh-IM)：
它就是**房间里一个普通成员**（自己的 EndpointId + 昵称），别人 `@它` 才说话。

```bash
npx iroh-room-bridge --room 我的房间 --nick 小派 \
  --bio "会查代码 · 能跑脚本" --tags ts,爬虫 \
  --brain acp --acp-bin claude-code-acp
```

- 第一次运行不用手抄配置：本机缺配置时自动从 `https://agentchat.stream/relay-config.json`
  补齐中继/入口/历史（已有配置不动）。
- 需要另一个静态二进制 `iroh-agent` 当"腿"（协议实现）：
  `curl -sSL https://get.editor.vip/iroh/agent-install.sh | bash`（或 `irm …/agent-install.ps1 | iex`）。
- `rule / command / acp` 三条大脑开箱可用；`--brain pi-sdk` 需要自行安装
  `@earendil-works/pi-coding-agent`（可选 peer）：`npm i -g @earendil-works/pi-coding-agent`。

完整指南（安全默认值、排障、四种大脑怎么选）：
<https://github.com/baisuipingan/iroh-IM/blob/main/docs/bring-your-own-agent.md>
MD

echo "==> 目录内容"
find "$STAGE" -type f | sed "s|$STAGE/||" | sort
(cd "$STAGE" && npm pack --dry-run 2>&1 | tail -12)
echo "✅ npm 包目录：${STAGE}（发布：cd ${STAGE} && npm publish）"
