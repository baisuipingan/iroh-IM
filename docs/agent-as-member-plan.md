# 成员模型改造：房间是场地，成员是 agent

> **本文是这次改造的唯一权威出处。** 会话 goal 指向本文；每期开工前先读它，
> 收工前做最后一节的「反漂移自检」。本文与已发布的发版记录冲突时，以本文为准并更新它。

## 0. 为什么改（判断不了时按它推）

上一轮我们把"传输/能力"这一层做对了（roomd 退化成装了插件的常驻用户、协议 v5、
能力注册表、类型单一来源）。但**"房间里的人是什么"这件事一直没定**：
我一度把 agent 的工具做成了"房间级插件 + 工具清单"，方向错了 ——

- 工具属于每个 agent 自己（MCP / Skill / 直接 bash 调现成接口），**我们不该造轮子**；
- 房间不知道也不需要知道别人的工具清单；
- 人怎么认识一个群里的人？**看名字、看简介、翻他在这里说过的话**。agent 也一样。

所以这一轮定的是产品模型，不是技术花活：

**房间 = 场地（成员 / 消息 / 历史 / 治理）；成员 = 真人或 agent，一律对等；
能力发现靠"名字 + 名片 + 这个房间的聊天记录"；要调用谁，就 @ 谁。**

## 1. 终态（全部满足才算完成）

1. **房间只认识成员**：不登记工具、不做工具清单；`RoomCapability` 只服务"房间级能力"
   （history / rendezvous / announce / 将来的文件仓、活动流），**不是**个人工具的载体。
2. **@ 是唯一的定向寻址，底层是唯一 id**：昵称只用于 UI 选择与显示；
   `!` 前缀已删除且**不得回归**；`respondToAll` 只是显式开关。
3. **成员的暴露面只有三样**：名字、名片（简介/标签）、**在这个房间的历史发言**。
4. **名片 = 签名消息 + 快照聚合**（零协议变更）：改简介后，新进房的人**立刻**看得到。
5. **agent 通过适配器接入，语言不限**：`agent serve` 的 JSON-lines IPC 扶正为
   **官方适配器契约**；Rust 只是参考实现；至少有一个非 Rust（TS）的 supervisor 示例跑通。
6. **适配器内部形状**：`room side`（传输/身份/房间闸门）+ 可插 `agent-io`
   （`acp` 首选 / `command` 兜底 / `pi-sdk` 自有 / `rule` 测试替身）；
   **加一个 agent = 加一份 spawn 配置，不改房间侧**。
7. **ACP 是首选接入协议**：以 `claude-code-acp` 跑通第一个真实后端；
   工具调用与权限请求要**在房间里看得见**。
8. **模型 / 凭据 / provider 由每个 agent 自己维护**；bridge 只在 spawn 时注入配置，
   不做协议层的统一模型管理。
9. 每期都有：全绿回归证据 + 线上发版记录 + 明确的回滚路径。

## 2. 已拍板的决策（不许重议；要改先问）

| # | 决策 | 落地形态 |
|---|---|---|
| ① | **不做工具插件 / 工具清单** | 工具是每个 agent 的私事（MCP / Skill / bash）；房间不登记 |
| ② | **@ 只按 id 寻址** | 昵称不进协议；过渡期在**文本**里带 id token；结构化 `mentions` 留 v6 |
| ③ | **名片先走"签名消息 + 快照聚合"** | v6 再做正式的房间状态帧 |
| ④ | **agent 入房 = 常驻轻监听 + 被 @ 才起会话** | 监听层是适配器；重会话按需起 |
| ⑤ | **权限先全部放开**（把功能对出来） | 显式开关 `allow-all`，**默认仍拒绝**；约束另开一期（C） |
| ⑥ | **模型管理本次不做** | 模型/凭据/provider 归各 agent 自己 |

## 3. 已作废的设计（别照做）

- ~~「工具清单」随 `announce` 广播（`tools: []`）~~ —— **作废**（决策①）。
- ~~「房间级工具插件」`iroh-tools/1` ALPN~~ —— **作废**（决策①）。
- ~~"做一个天气工具当样板"~~ —— **作废**：agent 自己会用 bash / MCP。

`frontend/js/plugins.js`（前端插件通道）**保留**，但定位改了：
它是"房间级服务 / 适配器把自定义事件端给 UI"的通道（例如"agent 正在用工具"），
**不是**工具清单的载体。

## 4. 分期与顺序（不许跳步）

### R · 成员模型

**R1 · @ 按 id 寻址（本期的地基）**
- **规范 token**：`@<id8>`，`id8` = 成员 `EndpointId` 的前 8 位小写 hex。
  为什么不用昵称：同名 / 改名 / 昵称为空都会错；id 唯一且稳定。
  为什么放文本里：结构化 `mentions` 要改签名载荷（破坏性）⇒ 留 v6。
- **解析规则（三端必须一致）**：
  1. `@` + 8 位 hex ⇒ 提及；在当前房间成员里按 id8 唯一匹配；
  2. 匹配不到（人已离线/换房）⇒ 渲染成"@未知成员(id8)"，**不报错**；
  3. 裸 `@昵称` **不作为寻址依据**，但 UI 在**发送时**解析一次：
     唯一匹配 ⇒ 替换成 token；歧义或无匹配 ⇒ 原样当普通文本（并给可见提示）。
- **UI**：输入框打 `@` 出在场成员补全（昵称 + id8 尾巴）；选中插入 token；
  时间线把 token 渲染成 `@昵称` 芯片（**按 id 现算** ⇒ 改名后历史立即显示新名）；
  被 @ 时高亮 + 通知 + 未读。
- **agent 侧**：认领 = `@<自己的 id8>`；昵称匹配只作兼容兜底（可关）。
- **验收（e2e，必须有）**：两个**同名**成员时 @ 到指定的那个、另一个不触发；
  成员改昵称后历史 chip 显示新昵称；无关消息不触发；token 重新加载历史后仍解析出 chip。

**R2 · 名片（签名消息 + 快照聚合）**
- 约定一条**签名消息**：`{"t":"profile","bio":"…","tags":["…"]}`（零协议变更，天然进历史）。
- 常驻节点从历史学到每人最新名片 ⇒ **放进房间快照**（`RoomSnapshot` 加字段，`serde(default)` 可扩）
  ⇒ 新进房的人**即刻**拿到，不用翻页。
- UI：点成员看名片（名字 / 简介 / 标签）+ 入口"他在这房间说过什么"。
- 验收：改简介后新进房的人立刻看到新名片；旧的仍在历史里可追；agent 也能有名片。

**R3 · `!` 前缀删除** ✅ 已完成（`9fda7c2`，含端到端验证）。**不得回归**。

### B · 适配器与语言无关

- **B1** 把 `agent serve` 的 JSON-lines IPC **扶正为官方适配器契约**：
  更新 `docs/agent-daemon-protocol.md`（清掉过时的"待办 TS 适配器"状态），补**契约一致性测试**。
- **B2** `agent-pi` → **room-bridge 形状**（**机械拆分，行为不变**）：
  `room side`（client / adapter / 房间闸门）与 `agent-io` 接口（brain 抽象已存在，只需归位）。
  拆分本身零行为变化 —— 测试全绿才算过。
- **B3** 加 **`acp` 后端**（首选）：spawn `claude-code-acp`，实现
  `initialize` / `session/new` / `session/prompt` / `session/update` / `session/set_model` / `session/cancel`；
  权限用显式开关（**默认拒绝**，`allow-all` 供对功能用）；工作目录沙箱化。
- **B4** **过程可见**：ACP 的 `session/update`（工具调用 / 计划 / 权限请求）→
  房间消息或 `Plugin` 事件（复用 R0 已补的前端插件通道）。
- **B5** 一个**非 Rust（TS）的 supervisor 示例**，证明"不绑死语言"：不依赖 Rust 绑定，
  只按契约驱动 `agent serve` 之类的侧车进程。

### A · 入房与生命周期治理

**A1 · 常驻轻监听 + 被 @ 才起会话** —— ✅ 形态由 B3 落地（常驻监听在适配器；重会话按需起一轮）。
agent-pi 的其余后端（pi-sdk / rule / command）同一形态。不另做。

**A2 · 邀请制（召唤器）** —— ✅ `agent-pi/src/summoner.ts`（单测 `scripts/test-summoner.mjs` 9/9；
端到端 `scripts/e2e/summoner.py` 全绿）。两件"要定"的事：

- **谁提供**：agent **所有者**在自己的机器上跑（凭据/沙箱在那边）。召唤器本身是房间里的普通成员
  （默认昵称"召唤器"，`respondToAll` 看所有消息，过滤在它自己内部做）。
- **谁有权**：v1 = 房间里任何成员（与"知道房名就能进"一致）；`--summon-from <id8,…>` 可收窄。
  **无论如何只能召唤注册表里列出的名字** —— 不能召唤任意程序（最重要的一道闸门）。
- **闸门**：`--max-live` / `--cooldown-ms` / `--idle-ms` / `--summon-from` / 注册表 / `--rooms`；
  全部超限**如实说一句**，不静默丢弃。空闲回收看"互动"（没人叫、它也没说话），不是"进程活着"。
- **转交（relay）**：被召唤者看不到 @ 它的旧消息（gossip 不补历史）⇒ 等它出现在**名册**里，
  再用**规范 token `@<id8>`** 把请求重说一遍。两条寻址：`@注册名`（人手打的；名字后不接
  ASCII 字母/数字/下划线，CJK 可直接接）与 `@<id8>`（回复旧消息 / 空闲后再叫 —— 对照表从名册
  懒学习，不持久化；转交时用**它当前在名册里的** id8，换身份也命中）。

**A3 · 多房间 / 多会话映射** —— ✅ 结论：**一房一会话、按房串行**。

- 一个进程盯一个房间：CLI 强制（`--rooms` 只收一个并直接拒绝多值）。理由是仓库里早就写死的事实：
  同一个 `IROH_AGENT_HOME`（身份目录）不能给两个 `serve` 进程共用（端点/中继会互相踢）。
  要同时盯多个房间 = 起多个召唤器进程，各自身份目录。
- 同一房间内**会话串行**：`ChatAdapter` 一轮未结束（或冷却窗口内）时新触发直接丢弃（不排队 ——
  聊天室场景里过期的回复比不回更糟）。

**A4 · 成员状态在花名册可见** —— ✅ 零协议变更：

- **在线** = presence 软状态（此刻在场）；**忙碌** = 名片标签里的约定 `忙碌`（签名消息，天然进历史，
  零协议变更）；**离线** = 最近说过话但不在场（本地历史窗口推导，卡片上如实说明它不是权威名册）。
- 离线成员的「@他」插入带 `#id8` 的草稿（发送前由 `resolveDraft` 归一成规范 token）——
  房间里有召唤器时，发送即把人叫回来（A2×A4 闭环）。e2e：`profile` 21/21（含 6 条 A4 断言）。

### C · 约束与安全（权限/沙箱/成本）

**C1 · ACP 权限策略** —— ✅ 四种策略（`--acp-permission`）：

- `deny`（默认，决策⑤不变）/ `allow-all`（只配把功能对出来）/
  `allow-list`（固定白名单：`--acp-allow Read,Grep`；匹配工具 `name` 全等或 `title` 子串）/
  `read-only`（只读工具集：`kind=read/search/think`，或名字/标题命中内置只读表
  Read/Glob/Grep/LS/List/NotebookRead）。
- **无论批不批都在房间里说，而且说出理由**（命中白名单哪条 / 只读策略为什么拒绝）。
- 「房间外你批」**留待 C-next**（需要一个审批通道：本地提示 / CLI）；先落"白名单 + 只读"
  两种**可自动判定**的策略 —— 它们已覆盖"公开房间的陌生人别把 agent 当命令执行器"这个主要风险。

**C2 · 沙箱姿态** —— ✅ 最小可验证面：

- ACP 的 `cwd` 就是沙箱边界：构造时**必须是绝对路径**（构造即拒）；真正拉起前校验
  **目录真实存在**，报错说人话（不给 `ENOENT` 天书）。
- 与 C1 叠：不声明 `fs/*`/`terminal/*` 能力（agent 用自己的工具在 cwd 里干活）+ 权限策略
  是文件面的第一道闸门；文件接收面的既有闸门（off/大小/并发/累计）不变。
- 部署建议（专用目录、低权限账号、容器可选）写在发版记录里。

**C3 · 成本闸门** —— ✅ `--budget-turns N` + `--budget-window-min M`（ChatAdapter 层，全后端通用）：

- **滑动窗口**内最多起 N 轮（默认 0 = 不限）；超限**不触模型**、在房间里如实说一句
  （每分钟最多一条，别刷屏）。
- 与既有闸门叠成一条链：去重（message.id）→ 冷却（频率）→ 忙碌（串行）→ 预算（总量）；
  单轮时间上限用各后端自己的（ACP `--acp-timeout-ms`）。token 计量在 agent 自己那边（决策⑥）。

**C4 · 谁能召唤谁** —— ✅ 两道名单（"与"的关系，两道都过才叫得动）：

- 全局 `--summon-from <id8,…>`；按名字的注册表 `allowFrom`（只允许某些人召唤某一个名字）。
- 被拒时**如实说明是哪一道挡的**。

C 期显式未做（记录在案，不许静默缩范围）：房间外你批（审批通道）；容器级沙箱（部署侧选项）。

### V6 · 破坏性（攒一次切）

**V6.1 · 结构化 mentions** —— ✅ 已完成并上线（2026-10-12，见
[`docs/release-2026-10-12-protocol-v6.md`](release-2026-10-12-protocol-v6.md)）：

- `ChatMessage` 载荷加 `mentions: [EndpointId]`（去重+排序后进签名）；文本 `@<id8>` 降级为
  **渲染锚点**。**只有它的标签升 v6**（presence/文件族载荷没变 → 保持 v5，过渡期双向互通）。
- **双读**：验证先 v6 后 v5 —— 旧消息/旧历史照常可读，**没有清历史**（与 v4→v5 不同）。
- 三端接线：agent-pi 结构化触发 + `say(mentions)`；前端 `resolveDraft→mentions`；召唤器转交带 mentions。
- 切割执行记录（cutover 文档 [`docs/v6-cutover-plan.md`](v6-cutover-plan.md) 的落地版）：
  roomd → 前端 → agent 一次窗口；`verify.sh all` 退出码 0。

**V6.2 · 名片升为房间状态帧** —— ✅ 已完成并上线（2026-10-12，见
[`docs/release-2026-10-12-profile-state-frame.md`](release-2026-10-12-profile-state-frame.md)）：

- 名片 = 签名的 `Wire::Profile` 帧：**广播即达、不进聊天历史**（旧的名片消息仍双读，
  按 `ts` 与帧档案合并取新）；常驻节点**直接记账**（SQLite `profiles` 表）并继续做
  "新人补全"的快照权威；前端「我的名片」走帧、进房重播一次兜底。
- 兼容：旧端忽略未知帧（无害）；旧版 agent 二进制**无需重发**（已核实）。

**V6.3 · 可选加密** —— 📄 威胁模型已写：[`docs/threat-model-room-encryption.md`](threat-model-room-encryption.md)。
**建议暂不做**（理由与"若要做需要改什么"都在文里）；实现与否留给所有者拍板。

## 5. 每期完成定义（DoD，缺一不可）

- 改动最小，沿用现有代码与注释风格（**这个仓库的注释是资产，要写"为什么"**）。
- 新增/修改的行为必须有测试（含**端到端**）；测试要能复现"改之前的错"。
- `bash scripts/verify.sh all` 全绿。
- 涉前端 → Cloudflare 发版并**核对线上哈希**；涉 native/agent → 重建并安装，必要时出 Release。
- 写 `docs/release-YYYY-MM-DD-*.md`：版本号、验证数字、回滚方式。
- 发版前必须存在可回滚点。

## 6. 硬约束（违反即视为失败）

- **不把消息格式与签名插件化**（会让验签与跨版本互认碎掉）；**不做动态库加载式插件**。
- 每个能力/插件自带资源闸门（roomd 的容量上限 / LRU / 限速 / 空闲回收是样板）。
- 不许"改了源码但产物没重建"就发版。
- 不许动 `.workbuddy/memory/**`（用户数据）。
- 不许让服务器上跑的二进制处在"不属于任何 Release"的状态。
- **不许要求"每端都必须 Rust"**：浏览器走 wasm 桥接；其它端走"协议 + 侧车进程"
  （`agent serve` 之类的 daemon），**不为任何语言造绑定**。
- 不许把"连不上任何节点"当错误处理（阶段 A 定下的语义必须保住）。

## 7. 不做（防范围蔓延，除非明确要求）

工具清单 / 工具插件（①）；协议层的统一模型管理（⑥）；端到端加密历史；
iOS 端实现；UI 改版；性能压测；把 `!` 加回来（任何形式）。

## 8. 反漂移自检（每期收工前逐条回答；答不上就是偏了）

1. 这一期有没有让"房间只是场地"这条**变差**（比如往房间里塞了工具/清单）？
2. 有没有把"昵称"当成寻址依据（而不是显示）？
3. 新增的 agent 接入，是不是"加一份 spawn 配置"就够了？还是要改房间侧代码？
4. 这一期能不能**单独回滚**？回滚步骤写下来了吗？
5. 如果某条已拍板决策与现实冲突，**停下来报告并等决定**，不要静默改方向。

## 9. 环境事实与已知前提（新会话直接用，不要重新侦察）

- **服务器 / 构建机同一台**：地址 / 端口 / 私钥路径写在**本机的 `scripts/build.env`**
  （`.gitignore` 已排除，不入库）。构建 wasm：`bash scripts/build-wasm.sh release`；
  原生：`native`（产出 `dist/roomd`、`dist/relay-probe`）。前端发版：`bash scripts/deploy-web.sh`。
- **本地回归前置**（缺一不可，重启过多次）：
  - `python3 scripts/dev-serve.py 8099`（必须跑在**常驻会话**里）
  - 带 CDP 的 Chrome：`--headless=new --remote-debugging-port=9222 --no-sandbox
    --no-first-run --disable-gpu --no-proxy-server --proxy-bypass-list='*'`
  - 运行测试时清代理：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy
    NO_PROXY=127.0.0.1,localhost …`
  - 套件：`bash scripts/e2e/run.sh`（14 个 python 用例，含新加的 `plugin-channel`）、
    `node scripts/smoke.mjs`、`bash scripts/verify.sh all`。
- **常驻 agent**：~~`iroh-agent-pi.service`（非 root，房间 `patrick`，昵称"服务器助手"）~~
  —— **2026-10-13 所有者要求下线，已完整移除**（服务/单元/`/opt/iroh-agent`/系统账号全清）。
  想让 agent 再进房间：走 BYOA（[`bring-your-own-agent.md`](bring-your-own-agent.md)），
  或按 [`deploy/agent/README.md`](../deploy/agent/README.md) 的蓝图重新部署。
  适配器代码在 `/opt/iroh-agent/agent-pi/`（**部署 = scp `agent-pi/src/*.ts` + `systemctl restart`**）。
  ⚠️ **原生 agent 连中继需要 token**：写在 `/opt/iroh-agent/home/config.json`
  （临时起第二个 agent 时必须带上它，否则"连接中继超时"）。
- **ACP 生态现状（2026-10-12 实测）**：
  - `@zed-industries/claude-code-acp` **0.16.2**（Zed 维护，非 Anthropic 官方）：
    bin `claude-code-acp`，是**可直接运行的 ACP agent 服务端**；真正的运行时在依赖
    `@anthropic-ai/claude-agent-sdk`（自带 `cli.js`，74M）；认 `CLAUDE_CONFIG_DIR` /
    `CLAUDE_CODE_EXECUTABLE` 两个环境变量。
  - 它实现的方法：`initialize` / `newSession` / `loadSession` / `listSessions` / `forkSession` /
    `resumeSession` / `prompt` / `cancel` / `setSessionMode` / `setSessionModel` / `readTextFile` / `writeTextFile`。
  - 本机实测：模型列表 `default / opus / opus[1m] / haiku`（Claude Code 内置别名，**不是**第三方网关动态枚举），
    当前 `opus`；一轮 prompt 正常返回、`stopReason=end_turn`。
  - ACP 规范（`@agentclientprotocol/sdk` **1.8.0**）：模型选择是 `configOptions` 里
    `category:"model"`（新）/ `models.availableModels`（0.14 旧形态），切换用
    `session/set_config_option`（新）/ `session/set_model`（旧）；
    `providers/list|set|disable` 存在但标注 **UNSTABLE**，且 claude-code-acp **未实现**
    ⇒ **模型/凭据/provider 只能由 agent 自己维护**（决策⑥）。
- **发版顺序与回滚点约定**：roomd → 前端 → agent；回滚副本固定写成
  `<二进制>.bak-<时间戳>`，数据备份走 `systemctl start roomd-backup.service`。

## 10. 进度台账

| 期 | 状态 | 证据 |
|---|---|---|
| R3（`!` 前缀删除） | ✅ 已完成 | `9fda7c2`；单元测试 8/8；真实端到端：`!ping` 不触发、`@检查助手 ping` 回 `pong` |
| 前端插件通道（R/B 都要用） | ✅ 已完成 | `docs/release-2026-10-12-plugin-channel.md`；CF `2909e983-…`；新用例 `plugin-channel` 11/11 |
| R1（@ 按 id 寻址） | ✅ 已完成 | `docs/release-2026-10-12-mention-by-id.md`；新用例 `mention-id` **18/18**（含三层：纯函数 / 三成员同名消歧 / 改名重画 / 补全）；agent-pi 单测 11/11；线上 7 个文件哈希逐一相等；CF `05829de2-…`。顺带修掉一个真 bug：chip 上"我自己"的名字曾取自 localStorage（多标签会串） |
| R2a（名片：客户端侧） | ✅ 已完成 | `docs/release-2026-10-12-profile-r2a.md`；名片 = 约定格式的**签名消息**（`{"t":"profile",…}`）+ 本地聚合；新用例 `profile` **11/11**（含验收标准：新进房的人立刻看得到）；花名册（简介/标签/最近说过/一键 @）；CF `443786c0-…`。顺带修掉"自己改完名片自己看不见"的真 bug |
| R2b（名片进快照） | ✅ 已完成 | `docs/release-2026-10-12-profile-r2b.md`；常驻节点在**首次拉历史**时把"每人最新名片"填进 `RoomSnapshot`（`bio`/`tags`/`profile_ts`，全 `serde(default)` ⇒ 非破坏）；新事件 `RoomEvent::Profiles`；Rust 72 + history-storage 9；e2e `profile` **15/15**（含"名片被挤出首页后新人仍看得到"的验收）；`verify.sh all` **退出码 0**；roomd `b64e61f9…`、前端 `786ab6d6-…`。顺带修掉一个**静默失效**的真 bug：`LIKE` 扫被转义的 JSON 永远返回空（已钉成回归断言） |
| **R（成员模型）整期** | ✅ 已完成 | R1（@ by id）+ R2（名片：客户端聚合 + 快照聚合）都上线；`verify.sh all` 退出码 0 |
| B1（契约扶正） | ✅ 已完成 | `docs/release-2026-10-12-adapter-contract-split.md`；`docs/agent-daemon-protocol.md` 改成**适配器契约**（"必须做/实现自由"两栏表；状态更新为"黄金转录 + TS 适配器都已落地"） |
| B2（room / agent-io 拆分） | ✅ 已完成 | 全部 `git mv`（保历史）：`src/room/`（协议+客户端+成员策略）与 `src/agent-io/`（`index.ts` 接口 + rule/command/pi-sdk/tools）；零行为变化（tsc / 11 项单测 / 协议闸门 / 活体验证全过）；顺带修掉 `adapter.ts` 里"还写着 `!` 前缀"的过时注释 |
| B5（非 Rust 示例） | ✅ 已完成（提前） | `agent-pi/examples/minimal-supervisor.ts`：**40 行、不 import 仓库任何代码**，只按契约起 daemon/等 hello/校验版本/@id8 回话；活体验证：另一个房间 `@89cc2cec ping` → 回 `收到：ping` |
| B3（ACP 后端）+ B4（过程可见） | ✅ 已完成 | `docs/release-2026-10-12-acp-backend.md`；`agent-io/acp.ts` + `--brain acp`（spawn 配置一组开关）；权限默认**拒绝**、`allow-all` 显式开；工具调用/权限请求**在房间里看得见**；假 ACP agent + 5 条确定性单测；**真实 `claude-code-acp` 端到端**：`🔧 Terminal`→答复、`🔧 Write`→`⚠️ 已按 allow-all 批准`→沙箱里真的出现 `hello.txt`；`verify.sh all` 退出码 0。**未上线**（线上仍是 pi-sdk；换不换是产品决定） |
| B 期收尾 | ✅ 已完成 | B1/B2/B5/B3/B4 全部完成 → **B 期结束** |
| A（入房与生命周期） | ✅ 已完成 | `docs/release-2026-10-12-invite-summoner.md`；A2 召唤器（单测 9/9；真端到端 `scripts/e2e/summoner.py`：人类 @注册名 → 🫡 → 成员进名册 → **@id8 转交** → 成员答复 → 收摊无残留）；A3 一房一会话（CLI 拒 `--rooms a,b`）；A4 花名册状态（`profile` e2e **21/21**，含在线/忙碌/离线）；`verify.sh all` 退出码 0；前端 CF `41bff1e1-…` |
| C（约束与安全） | ✅ 已完成（v1） | `docs/release-2026-10-12-acp-constraints.md`；单测 **32/32**（新增：C1 权限策略 ×3、C2 沙箱 ×1、C3 成本闸门 ×2、C4 召唤治理 ×2）；**真实 claude-code-acp 端到端**：`read-only` 下 Write 被拒且文件不存在；`verify.sh all` 退出码 0 |
| V6.1（结构化 mentions：进签名 + 双读 + 握手 v6） | ✅ 已完成并上线 | `docs/release-2026-10-12-protocol-v6.md`；Rust 75 库测试 + golden 全绿；agent-pi 14/14 + 11/11 + 8/8；前端 10/10；召唤器真端到端（v6·真实中继）；`verify.sh all` 退出码 0；roomd `84264e32…`、CF `888adb02-…`、agent Release `agent-v1.3.0`（两侧哈希/安装校验一致）；**历史未清**（v5 旧消息实测仍可读） |
| V6.2（名片状态帧） | ✅ 已完成并上线 | `docs/release-2026-10-12-profile-state-frame.md`；Rust 77 库测试 + SQLite 持久化新测；`profile` e2e **20/20**（帧语义重写：不进历史/实时/快照权威）；`verify.sh all` 退出码 0；roomd `0529e182…`、CF `a4e14e36-…` |
| V6.3（可选加密） | 📄 已评估（建议暂不做） | `docs/threat-model-room-encryption.md`；实现与否由所有者拍板 |
