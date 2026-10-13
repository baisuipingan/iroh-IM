# 2026-10-13 ACP 选模型：`--acp-model`（opencode v2 实测解锁）

## 一句话

opencode v2 接进房间后 "@ 它不回"，终端报 `Authentication required: provider authentication required`
（或 `opencode run` 报 `Upstream request failed: Endpoint is unavailable.`）——
**根因是模型**：opencode 当前默认的 `opencode-go/claude-haiku-5-5` 临时不可用，
换一个模型（如 `opencode-go/deepseek-v4-flash`）立刻能答。适配器现在支持
`--acp-model provider/model` 指定会话模型，并把"当前模型"打进日志。

## 根因证据（本机 opencode v2.0.24 实测）

- `opencode auth list` → 两个 integration 都是 `stored`（登录没问题）。
- `opencode run --standalone "…"` → `Endpoint is unavailable.`（默认模型）
- `opencode run --standalone -m opencode-go/deepseek-v4-flash "…"` → 正常回答"好"。
- 原始 ACP 探测：`session/set_model` → **`Method not found`**；
  `session/set_config_option {configId:"model", value:…}` → 成功，之后 prompt 正常。

## 改了什么

| # | 位置 | 改动 |
|---|---|---|
| 1 | `agent-pi/src/agent-io/acp.ts` | `session/new` 之后读 `configOptions`；给了 `model` 就发 `session/set_config_option`（失败明确抛错）；没给就**播报当前模型**（排查不用猜） |
| 2 | `agent-pi/src/cli.ts` | 新开关 `--acp-model ID`；启动日志带上 `model=` |
| 3 | 假 ACP agent + 单测 | 假 agent 实现 `session/set_config_option` 并让回复带出当前模型；新增 2 条用例（真的切了 / 默认播报） |
| 4 | 文档 | BYOA 指南 opencode 例子加 `--acp-model`；FAQ 换成"先查模型"；agent-pi README 表格补一行 |

## 验证

| 项 | 结果 |
|---|---|
| 单测 `test-acp-brain.mjs` | **10/10**（新增 2 条：`--acp-model` 真的生效、默认模型被播报） |
| 真实链路（推荐组合） | `--preset opencode --acp-model opencode-go/deepseek-v4-flash`：日志 `已指定模型：…` → 房间内 @它 → 回复"我是 DeepSeek V4 Flash…" |
| 发版 | `bridge-v0.2.1`：CI run **`38393012417` success**，Release 13 个资产齐全；npm `iroh-room-bridge@0.2.1` 已发布（`latest`=0.2.1）；从 registry 装出的 0.2.1 `--help` 里有 `--acp-model ID` |

## 回滚

纯增量：不传 `--acp-model` 的行为与 0.2.0 一致（只是多一行"当前模型"日志）。
