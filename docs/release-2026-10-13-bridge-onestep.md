# 2026-10-13 接入提速：一条命令装全 + `--preset opencode`（顺带修三个"到朋友电脑上就挂"的坑）

## 一句话

接入从"两条安装命令 + 一长串 spawn 参数"变成：

```bash
bash -c "$(curl -sSL https://get.editor.vip/iroh/room-bridge-install.sh)"   # 一条命令装全
room-bridge --room patrick --nick 小开 --preset opencode \
  --acp-cwd "$HOME/我的项目" --acp-permission read-only                     # 一行接入
```

## 改了什么

| # | 位置 | 改动 |
|---|---|---|
| 1 | `deploy/install/room-bridge-install.sh` / `.ps1` | 缺 `iroh-agent` 时**顺带装好**（一条命令装全两台"设备"）；`SKIP_AGENT=1` / `-SkipAgent` 可关；Windows 版用**子进程**跑 agent 安装器（它内部有 `exit`，同进程调用会把自己也带退） |
| 2 | `deploy/install/agent-install.sh` | 安装目录与配置目录改为**可写优先**：`AGENT_PREFIX` → 可写的 `/usr/local/bin` → `~/.local/bin`；配置目录按二进制自身规则（`$XDG_CONFIG_HOME\|$HOME/.config` 下）。**原来写死 `/usr/local/bin` + `/root/.config`——在非 root 的个人电脑上 `mkdir /root` 直接失败，整条一键命令跑不完**（2026-10-13 修） |
| 3 | 组合安装 | 给 agent 安装器传 `SKIP_CONFIG=1`：不写半份空配置，配置留给适配器的 `--server` 自动引导（一次写全中继/令牌/入口/历史） |
| 4 | `agent-pi/src/room/presets.ts`（新）+ `cli.ts` | `--preset opencode`（=`--brain acp --acp-bin opencode --acp-args '["acp"]'`）与 `--preset claude-code`；**只填没显式给的开关**，显式参数永远优先；未知名字抛错 |
| 5 | `cli.ts` `defaultAgentBin()` | iroh-agent 的默认解析顺序：`$IROH_AGENT_BIN` → **room-bridge 自己旁边的 iroh-agent** → PATH。安装目录没进 PATH 时也能直接跑（组合安装的常见状态） |
| 6 | 文档 | BYOA 指南改成"① 一条命令装全 / ② 跑起来"；`--preset` 说明；opencode 认证排障一行；install README 记录组合安装与坑 |

## 验证

| 项 | 结果 |
|---|---|
| 单测 | `test-room-bootstrap` **14/14**（新增 preset：展开、显式优先、未知报错；claude-code 别名） |
| 组合安装（本机 macOS，临时 PREFIX） | 一条命令 → `bin/` 下 `iroh-agent`(5.4MB) + `room-bridge`(71MB)；日志见 `SKIP_CONFIG=1：跳过 config.json` |
| 旁路解析 | 两个二进制放同一目录、该目录**不在 PATH** → 日志 `启动：<dir>/iroh-agent serve …`（命中"自己旁边"） |
| `--preset opencode` 真实链路 | 日志 `preset=opencode → brain=acp acp-bin=opencode acp-args=["acp"]`；`[acp] 已连接 OpenCode（session=…）`；本轮复跑时 opencode 侧返回 `Authentication required: provider authentication required`（属 opencode 自己的登录/模型问题），适配器**如实播报**、不崩 |
| `verify.sh all` | **退出码 0**；全部浏览器套件 FAIL=0（file-history 17/17、multi-peer 19/19、file-recipients 34/34、redesign 128/128、mention-id 18/18、profile 20/20、nickname-fallback 9/9 …），polish 52/52、38/38、12/12 |

## 发版

- `bridge-v0.2.0`：CI run **`38391322795` success**（单文件六平台 + 逐产物 sha256）。
- npm `iroh-room-bridge@0.2.0`：**latest 已切到 0.2.0**。
- 安装器随 `main` 生效（get.editor.vip ≤1 分钟更新），无需单独发版。
- **从零端到端复验**（全部走线上）：`bash -c "$(curl … room-bridge-install.sh)"` 一条命令
  → 同目录装出 `room-bridge 0.2.0` + `iroh-agent`（`SKIP_CONFIG` 生效）；
  **PATH 不含安装目录**直接跑 rule 大脑 → 日志 `启动：<prefix>/bin/iroh-agent serve`
  （命中"自己旁边"）→ 真实房间 @它 `ping` → **回复 `pong`**。

## 回滚

纯增量：`git revert` 对应提交；已装用户不受影响（旧二进制照常能用）。
