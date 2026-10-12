# 2026-10-12 C 期：约束与安全 —— 权限策略 / 沙箱姿态 / 成本闸门 / 召唤治理

## 一句话

把"先把功能对出来"的开放姿态收进四道**显式闸门**：ACP 权限从两档扩到四种策略
（默认仍是拒绝）；agent 的 `cwd` 成为被校验的沙箱边界；所有 brain 多了滑动窗口式
**轮数预算**；召唤器支持按名字收窄"谁能召唤谁"。

## C1 · ACP 权限策略（四种，`--acp-permission`）

- `deny`（**默认**，决策⑤不变）/ `allow-all`（只配把功能对出来）/
  `allow-list`（固定白名单：`--acp-allow Read,Grep`；大小写不敏感，匹配工具 `name`
  全等或 `title` 子串）/ `read-only`（只读工具集：`kind=read/search/think`，
  或名字/标题命中内置只读表 `Read/Glob/Grep/LS/List/NotebookRead`）。
- **无论批不批都在房间里说，而且说出理由**（"命中「Read」" / "不在白名单" /
  "只读策略只放行读类操作"）。
- 「房间外你批」**显式留待 C-next**（需要审批通道：本地提示 / CLI）。先落"白名单 + 只读"
  两种**可自动判定**的策略 —— 已覆盖主要风险：公开房间的陌生人别把 agent 当命令执行器。

## C2 · 沙箱姿态（最小可验证面）

- `--acp-cwd` 就是沙箱边界：**构造时必须绝对路径**（构造即拒）；真正拉起前校验
  **目录真实存在**，报错说人话（不给 `ENOENT` 天书）。相对路径会让 spawn 以
  "适配器进程当时的 cwd"为基准悄悄跑偏 —— 那种漂移最难查，所以直接拒。
- 与 C1 叠：不声明 `fs/*`/`terminal/*` 能力（agent 用自己的工具在 cwd 里干活），
  权限策略是文件面的第一道闸门；文件接收面的既有闸门（off/大小/并发/累计）不变。
- 部署建议（专用目录、低权限账号、容器可选）写进 `deploy/agent/README.md` 运维表。

## C3 · 成本闸门（全后端通用，`--budget-turns N --budget-window-min M`）

- **滑动窗口**内最多起 N 轮（默认 0 = 不限）；超限**不触模型**、在房间里如实说一句
  （每分钟最多一条，别刷屏）。
- 与既有闸门叠成一条链：去重（`message.id`）→ 冷却（频率）→ 忙碌（串行）→ **预算（总量）**；
  单轮时间上限用各后端自己的（ACP `--acp-timeout-ms`）。token 计量在 agent 自己那边（决策⑥）。
- 用滑动窗口而不是"每小时整点清零"：后者的边界会让两倍额度挤在窗口交叠处。

## C4 · 谁能召唤谁（召唤器治理）

- 两道名单是"**与**"：全局 `--summon-from <id8,…>` 与注册表里按名字的 `allowFrom`
  （只允许某些人召唤**某一个**名字）。两道都过才叫得动。
- 被拒时如实说明是**哪一道**挡的（"房主没把 X 加进召唤名单" / "「名字」只接受名单内成员的召唤"）。

## 验证

| 项 | 结果 |
|---|---|
| agent-pi tsc / `biome lint frontend agent-pi` | 通过 / 干净 |
| 单测 `npm test`（含新用例） | **32/32**：adapter 13（新增 C3×2）、acp-brain 8（新增 C1×3 + C2×1）、summoner 11（新增 C4×2） |
| **真实 claude-code-acp 端到端**（本机真实模型，`read-only` 策略） | ✅ 读放行、写被拒、文件不存在（原文见下） |
| 浏览器回归 `profile` 等全部套件 | 照常全绿（C 期只碰 agent-pi，未动前端） |
| `bash scripts/verify.sh all` | **退出码 0** |

真实端到端原文（截）：

```
[acp] 已连接 @zed-industries/claude-code-acp（session=…，cwd=/tmp/acp-c1-sandbox）
[房间] 🔧 Read File
== R1（读）== 这个文件写了一句沙箱环境的问候语，说明这是一个只读测试。
[房间] 🔧 Write
[房间] ⚠️ 它想做：Write /private/tmp/acp-c1-sandbox/write-test.txt —— 已拒绝（只读策略只放行读类操作）
write-test.txt 是否存在（应为 false）： false
```

（顺带拿到一条真实数据：claude-code-acp 的权限请求 `title` 里带**绝对路径**
（`Write /private/tmp/…`），我们的匹配式"name 全等或 title 子串"对它成立。）

## 发版与回滚

- **服务器**：`rsync --delete agent-pi/src/ → /opt/iroh-agent/agent-pi/src/` +
  `systemctl restart iroh-agent-pi.service`；重启后日志正常（hello + `已进入房间 patrick`）。
  四个文件哈希两侧一致：`agent-io/acp.ts` `6f88f70b…`、`room/adapter.ts` `10edf88e…`、
  `cli.ts` `8938ff68…`、`summoner.ts` `6b4d3061…`。
  对**正在运行的服务**无行为变化（它跑 pi-sdk；`budgetTurns` 默认 0，C1/C2 只在 ACP 后端生效）。
- **前端 / roomd / wasm / 协议**：本轮未动（C 期只碰 agent-pi）。
- **回滚**：`git revert <本提交>` 后重新 rsync + `systemctl restart iroh-agent-pi`（纯源码，无数据面改动）。

## 反漂移自检（方案 §8 逐条）

1. **房间只是场地，没变差**：是 —— 四道闸门全在 agent/所有者侧，房间协议零改动。
2. **昵称没被当寻址依据**：是 —— 本期不涉及寻址。
3. **加 agent = 加 spawn 配置**：是 —— C1/C2 就是 spawn 配置里的开关，房间侧零改动。
4. **可单独回滚**：是 —— 见上。
5. **决策与现实冲突**：无。一处**显式取舍**：「房间外你批」没做（需要审批通道），
   先落两种可自动判定的策略；已写进方案 §C，不是静默缩范围。
