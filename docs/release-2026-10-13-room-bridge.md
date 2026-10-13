# 2026-10-13 room-bridge 单文件适配器：一条命令下载 + 顺手修两个静默问题

## 一句话

BYOA 的"装适配器"这一步从"clone 仓库 + Node"变成**一条命令下载一个文件**：

```bash
bash -c "$(curl -sSL https://get.editor.vip/iroh/room-bridge-install.sh)"   # macOS/Linux
room-bridge --room patrick --nick 小派 --bio '会查代码' --tags ts,rust --brain acp --acp-bin claude-code-acp
```

顺带发现并修掉两个**静默失效**（都是"看起来正常、实际没生效"那类）：

1. **`get.editor.vip/iroh/agent-install.sh` 一直是 404** —— 文档从 2026-10-09 起就在
   宣传这条一键安装命令，但 `get.editor.vip` 的 Worker 只服务了中继安装脚本
   （`deploy/install/worker.js` 里只有 `iroh-relay-install` 一条上游）。本次把
   agent / room-bridge 四条路径补上并重新部署（`b0441930-…`）。
2. **`--brain rule` 的默认规则永远不触发** —— `defaultRules()` 返回的是**没解析**的
   原始串 `'/^ping\\b/i'`，而 `RuleBrain` 只对 `parseRuleSpecs()` 的结果做 `/…/` 正则解析，
   于是它去字面匹配 `"/^ping\b/i"` 这个字符串本身。README 却一直写着 `ping → pong`
   （只有显式 `--rules` 时才成立）。单文件版冒烟时抓到。

## 改了什么

| # | 位置 | 改动 |
|---|---|---|
| 1 | `scripts/build-room-bridge.sh`（新） | `bun build --compile` 单文件：默认本平台 / `--all` 六平台 / `--target` 指定；逐产物 sha256；**`file` 架构复核**（防"静默错架构"——release-agent 踩过同类坑） |
| 2 | `agent-pi/src/cli.ts` | pi-sdk 加载改为**计算式动态 import**（`loadPiSdkModule`）：打包器看不到 ⇒ 单文件不带 pi SDK（原生依赖、几十 MB）；仓库版命中 `.ts`、npm 版回退 `.mjs`；失败给人话（"改用 --brain acp / command 或仓库/npm 版"） |
| 3 | `agent-pi/src/agent-io/rule.ts` | `defaultRules()` 返回**已解析**的 `RegExp`（修上面第 2 个静默问题）；`test-agent-adapter.mjs` 加回归断言 |
| 4 | `deploy/install/room-bridge-install.sh`（新） | 一键安装：平台检测、按 `bridge-v*` 前缀取最新 Release、逐产物 sha256 校验（**拿不到校验和就拒绝安装**）、智能选 `$PREFIX`（可写的 `/usr/local/bin` → 否则 `~/.local/bin`）、提示 `iroh-agent` 是否已装、`remove` |
| 5 | `deploy/install/room-bridge-install.ps1`（新） | Windows 版（`%LOCALAPPDATA%\Programs`，Get-FileHash 校验） |
| 6 | `deploy/install/worker.js` | get.editor.vip 改为**多脚本路由**：中继 / agent(.sh+.ps1) / room-bridge(.sh+.ps1)；`/iroh/` 首页列出全部；保持每分钟换上游绕 CDN 缓存的策略 |
| 7 | `.github/workflows/release-room-bridge.yml`（新） | tag `bridge-v*` → ubuntu 上交叉构建六平台 → linux-amd64 真跑冒烟 → 合并 SHA256SUMS → 发 Release |
| 8 | `scripts/e2e/byoa-join.py` | 支持 `BRIDGE_BIN=` 切换"仓库版 / 单文件版"跑同一套首接验收 |
| 9 | 文档 | `bring-your-own-agent.md` 改成"单文件版（推荐）+ 仓库版（pi-sdk/改代码）"；README / agent-pi README / e2e README 同步 |

## 验证

| 项 | 结果 |
|---|---|
| 本机六平台构建 + `file` 架构复核 | 全部通过（darwin/linux/windows × arm64/amd64，含 windows-arm64） |
| **单文件版首接 e2e**（真实链路） | `byoa-join.py` with `BRIDGE_BIN=dist/room-bridge/room-bridge-darwin-arm64`：**6/6**（引导配置 / 名片发布 / 第二身份快照验收 / SIGTERM 退出码 0） |
| 单文件版 rule 路径 | 假 daemon 驱动：收到 `ping` 真的回 `SAY pong`（默认规则修复后） |
| 单文件版 pi-sdk 路径 | 报错为人话（"单文件版刻意不带它 —— 改用 --brain acp / command…"），**启动不崩** |
| 默认规则回归 | `test-agent-adapter.mjs` 新增"ping→pong 真的触发"断言（含大小写、不匹配返回 null） |
| get.editor.vip 部署 | 重新部署（`b0441930-dc78-4fd8-a63b-37e60b2f0919`）：`/healthz`、`/iroh/install.sh`、`/iroh/agent-install.sh`、`/iroh/agent-install.ps1` 均 **200**；room-bridge 两条路径在脚本推送进 main 后复验 |
| `verify.sh all` | 全部浏览器套件绿：file-history 17/17、multi-peer 19/19、review-frontend 19/19、dm-removed 15/15、redesign **128/128**、mention-id 18/18、profile 20/20、nickname-fallback 9/9、plugin-channel 11/11 …；`file-recipients` 首轮偶发超时（与本次改动面无关的已知抖动），**单跑复验 34/34** |
| npm 包（预演） | `scripts/build-room-bridge-npm.sh` 产出 20.7 kB tarball；本机 `npm i <tarball>` 后 `room-bridge --help` 正常，且用它跑 `byoa-join.py` **6/6**（真实链路） |

## 发版与回滚

- **GitHub Release `bridge-v0.1.0`**（六平台单文件 + 逐产物 sha256 + SHA256SUMS.txt）——
  由 CI `release-room-bridge`（tag `bridge-v*`）构建。
- **npm 分发（`iroh-room-bridge`）已备好**：本地预演全过；正式发布需要 npm 账号
  （本机 registry 现指向 npmmirror 镜像，发布要切回 registry.npmjs.org）。
- 无需前端/roomd 改动；get.editor.vip Worker 已部署新版本。
- 回滚：Worker = 回上一版本（或把 `UPSTREAMS` 改回单条）；脚本 = `git revert`；
  Release 产物可保留（旧版本仍可按 `VERSION=` 钉住安装）。
