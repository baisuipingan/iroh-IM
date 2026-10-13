# 2026-10-13 BYOA 首接 v1：三步把自己的 agent 接进房间（配置自举 + 名片 + 指南）

## 一句话

"每个人把自己的 agent 接进房间"从"能走"变成"顺滑"：

```bash
# ① 装二进制（一条命令，已有）
bash -c "$(curl -sSL https://get.editor.vip/iroh/agent-install.sh)"
# ② 跑适配器（仓库里；本机缺配置会自动从站点补齐）
node --experimental-strip-types agent-pi/src/cli.ts \
  --room patrick --nick 小派 --bio "会查代码" --tags ts,rust \
  --brain acp --acp-bin claude-code-acp
# ③ 完成：名册里出现「小派」，别人 @它 就能用
```

补掉的正是两个"看起来没报错、实际没生效"的摩擦点：
**手抄中继/令牌/入口/历史**（抄错 = 孤立进房）与**名册里只有名字、没有能力信息**。

## 改了什么

| # | 位置 | 改动 |
|---|---|---|
| 1 | `client-wasm/src/bin/agent.rs` | serve 协议新增 **`profile` 命令**（← `set_profile`，V6.2 状态帧）：字段归一化与读取侧同上限（简介 160 字压换行、标签 8×16 去重），reply 返回归一化后的值；未进房 `notJoined`、坏类型 `badRequest` |
| 2 | `agent-pi/src/room/bootstrap.ts`（新） | **配置自举**：本机缺 `relays/relay_token/rendezvous/history` 时，从 `--server`（默认 `https://im.pinkstar.cc`）拉公开的 `relay-config.json` 补进 `<home>/config.json`（0600）。**只补缺、非空字段不覆盖**；`nickname` 不碰；环境变量已提供配置（CI/召唤器注入）则跳过不写；坏文件先备份再重建；失败如实返回、不抛 |
| 3 | `agent-pi/src/room/profile.ts`（新） | **进房即发布名片**：监听 `joined`（含 serve 崩溃重启后的自动重进房）→ `profile` 命令；失败重试；`unsupportedCmd`（老二进制）不重试、直接提示升级；没给 `--bio/--tags` 时完全不订阅（旧行为不变） |
| 4 | `agent-pi/src/cli.ts` | 新开关：`--server` / `--refresh-config` / `--bio` / `--tags`；启动日志如实报告引导结果 |
| 5 | `docs/bring-your-own-agent.md`（新） | 接入指南：三步、四种大脑（ACP/命令/pi SDK/规则）、安全默认值、排障表、"召唤器"进阶 |
| 6 | `README.md` / `agent-pi/README.md` / `deploy/agent/README.md` / `docs/agent-daemon-protocol.md` | 索引、开关表、契约文档（`profile` 命令行 + 幂等说明 + 实现清单）同步 |

零协议变更：`profile` 是 V6.2 既有状态帧；`serve` 行协议加的是**一条新命令**（IPC v1 不变，老适配器不受影响）。

## 验证

| 项 | 结果 |
|---|---|
| 新单测 `scripts/test-room-bootstrap.mjs`（已并入 `npm test`） | **13/13**：空目录补全 0600 配置、完整配置不拉取、半成品只补缺、env 优先跳过、失败不落文件、`--refresh-config` 保留其它键、坏形状拒绝、名片归一化/重试/老二进制提示/未配置不订阅 |
| Rust | `cargo test ... --features cli` 全绿（lib **80** + roomd 4 + 黄金转录 1 + gossip 1 + history-budget 1 + storage 10 + doc 1） |
| 黄金转录 | fixture 更新（+2 条 `profile` 事件、+3 条 reply），并给归一化补了 **64 位 hex `id`** 规则——否则每次运行新身份会让转录跨运行漂移；连跑两次确认稳定 |
| serve 冒烟 `agent-serve-smoke.py` | 加 `profile` 断言（归一化 + `profile` 事件），真实中继全绿 |
| **新 e2e `scripts/e2e/byoa-join.py`** | **5/5**（真实链路）：空目录 → 自动引导（日志 + 文件双证）→ 名片已发布 → **第二个身份在快照里看到 bio/tags** → SIGTERM 退出码 0 |
| `verify.sh all` | **退出码 0**（干净整轮）：file-recipients 34/34、redesign 128/128、profile 20/20、multi-peer 19/19、mention-id 18/18、review-frontend 19/19、nickname-fallback 9/9、dm-removed 15/15、plugin-channel 11/11 …全部 FAIL=0；polish 套件 52/52、38/38、12/12 全绿 |

## 发版（已发）

- **GitHub Release `agent-v1.4.0`** 已发布（`2026-10-13T06:15:42Z`）：CI `release-agent`
  run `38355161391` **success**（6 平台构建 + 上传），资产齐全：
  darwin/linux × arm64/amd64（tar.gz + 逐产物 `.sha256`）、windows × amd64/arm64（zip + `.sha256`）、
  `SHA256SUMS.txt`。`agent-install.sh` 自动取最新 `agent-v*`，无需改脚本。
- 本机实测（macOS arm64）：`AGENT_VERSION=agent-v1.4.0` 跑安装脚本 → **校验和通过**、装出的
  二进制可运行；`serve` 探针发 `profile` 返回 **`notJoined`**（而不是 `unsupportedCmd`）
  —— 证明发布产物真的带这条命令。
- 老二进制 + 新适配器：名片发布会被明确拒绝并提示升级，**对话功能不受影响**。
- 前端 / roomd **本轮未动**，无需发版。
- 回滚：适配器与文档 = `git revert`；二进制 = 安装脚本钉回 `AGENT_VERSION=agent-v1.3.0`。
