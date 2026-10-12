# 2026-10-12 B3 + B4：ACP 后端（首个真实 agent 后端）+ 过程可见

## 一句话

给适配器加了 **`--brain acp`**：我们当 **ACP 客户端**，`claude-code-acp` 当 ACP agent ——
房间消息进 `session/prompt`，流式输出回房间，**工具调用与权限请求在房间里看得见**。
换 agent 只是换一份 spawn 配置（`--acp-bin/--acp-args`），`room/` 那半一行没动。

## 为什么这是"首选接入方式"

见方案 §1 ⑦。落到代码上就是三条：

1. **不写 per-agent 适配**：`claude-code-acp` / 它家的 ACP agent / 将来 pi 若有 ACP —— 都走同一个后端；
2. **模型/凭据/provider 全在 agent 那边**（决策⑥）：我们只在 spawn 时给 `cwd` 与环境，
   连"选模型"都不碰（ACP 里模型是 `configOptions` 的一项，由 agent 定义）；
3. **ACP 自带的能力直接用**：会话保活、取消、权限请求、工具调用可见 —— 不用自己发明。

## 做了什么（`agent-pi/src/agent-io/acp.ts`）

- **懒启动**：第一条消息才 spawn + `initialize` + `session/new`；进程死了下次说话自动重拉。
- **不声明 `fs/*` 与 `terminal/*` 能力**：声明了就得替 agent 读写文件/开终端，多一份攻击面；
  不声明它就用自己的工具（在 `cwd` 里干活）。**真实收到的未知方法一律回"不支持"**，
  不假装支持（假装会让它以为文件写成功了）。
- **权限（决策⑤）**：`--acp-permission=deny`（默认）一律选 `reject_*`；`allow-all` 才选 `allow_*`。
  **无论批不批都在房间里说出来**（"⚠️ 它想做：… —— 已拒绝（默认策略）"）。
- **过程可见（B4）**：`tool_call` → 房间里发一行 `🔧 Bash: echo hi`（同一工具调用 3 秒内只发一条，
  不把房间刷成日志）；`--acp-narrate=off` 可只发最终回复。
- **一轮硬超时**（默认 5 分钟）：超时发 `session/cancel`（**是通知，不带 id**；
  第一版当请求发，会永远等一个不会来的回执）并如实说明"这轮超时了，我先停下它"。
- 流式：`agent_message_chunk` 拼接成一条回复（`ctx.say` 用于过程播报，返回值是最终答复 ——
  正好是 `AgentBrain` 接口早就留好的两路）。

CLI：`--brain acp` + `--acp-bin` / `--acp-args` / `--acp-cwd` / `--acp-permission` /
`--acp-narrate` / `--acp-timeout-ms`；`allow-all` 启动时会打一条**显式警告**（别长期这么跑）。

## 测试

**假 ACP agent**（`agent-pi/examples/fake-acp-agent.mjs`，约 90 行）+
**契约级单测**（`scripts/test-acp-brain.mjs`，已并入 `npm test`）：

| 用例 | 断言 |
|---|---|
| 默认策略 | 流式拼成一条回复；工具调用播报 `🔧`；权限请求说出来且选 **reject_always** |
| `allow-all` | 选 `allow_always`，并说明"已按 allow-all 批准" |
| `narrate=off` | 不播报工具 |
| 超时 | 回"超时"、发 `session/cancel`（假 agent 侧可见收到） |
| 进程死了 | 这一次抛错（如实），下一次**自动重拉**并正常回答 |

> ⚠️ 写这套测试时踩到两个坑，都记在代码注释里：
> ① `URL.pathname` 会把路径里的中文变成百分号编码 → node 找不到假 agent、进程秒退
> （改用 `fileURLToPath`）；
> ② **失败时也必须 `close()`**（用 `t.after`）—— 否则假 agent 活着，整轮测试挂住、
> **连失败原因都打不出来**（第一版就是这样，查了很久）。

## 验证

| 项 | 结果 |
|---|---|
| `npm test` 里的适配器 + ACP 单测 | 11 + **5** 全过（ACP 那 5 条 0.5 秒跑完，不花模型额度） |
| `agent-pi` tsc / `biome lint` | 通过 / 干净 |
| `bash scripts/verify.sh local` | **退出码 0** |
| **真实 `claude-code-acp` 端到端** | 见下 |
| `bash scripts/verify.sh all` | **退出码 0**（干净整轮） |

### 真实端到端（本机临时房间，不碰线上）

跑法：本机编一份 macOS 的 `iroh-agent`（房间搬运侧）→ 起 bridge：

```
node --experimental-strip-types agent-pi/src/cli.ts \
  --room <临时房> --nick ACP助手 --brain acp \
  --acp-bin <claude-code-acp> --acp-cwd /tmp/<沙箱> \
  --acp-permission allow-all --agent-bin <本机 iroh-agent>
```

然后用浏览器 @ 它一句"用 ls 看看当前目录，然后一句话概括"，预期：
1. 房间里出现 `🔧 …` 的工具调用行（B4）；
2. 出现一条"⚠️ 它想做：…（已按 allow-all 批准）"；
3. 最后是它的中文答复。

**结果（2026-10-12，本机 `claude-code-acp` 0.16.2 + 本机编的 macOS `iroh-agent`）**：

```
提示 ①：@95e3c45f 用 ls 看看当前目录有什么，然后一句话概括
  → 🔧 Terminal
  → 答复："Empty workspace with two tiny files (README.txt and note.md)."   （它真的跑了 ls）

提示 ②：@95e3c45f 在这个目录里创建一个 hello.txt，内容写 hi，然后一句话告诉我你做了什么
  → 🔧 Write
  → ⚠️ 它想做：Write /private/tmp/acp-room2/workspace/hello.txt —— 已按 allow-all 批准
  → 沙箱里**真的出现了 hello.txt（内容 hi）**  ← 批准真的流回了 agent
```

也就是说整条链都通了：房间消息 → 适配器 → ACP `session/prompt` → 工具调用 →
权限请求（房间可见）→ 我们的批准 → 工具真的执行 → 答复回房间。

> ⚠️ **本机验证踩到的两个坑**（写下来免得下次再花时间）：
> ① **本地配置文件必须有房间入口**（`anchor` / `rendezvous`）：少了它就是**孤立进房** ——
>    房间进得去、但谁都看不见它（浏览器等 90 秒也等不到它出现在名册里）。服务器上那份
>    `/opt/iroh-agent/home/config.json` 一直有，所以这个坑只在"自己手写 config"时出现。
> ② **不要用同一个身份目录起第二个进程**：中继会报
>    `Another endpoint connected with the same endpoint id`，把前一个**踢下线**
>    （我拿它当"探针"时把自己正在测的 bridge 踹了，白查了半天）。验证时用独立目录。

> 另：整轮 `verify.sh all` 中间撞过一次**内存雪崩**（前面 5 个套件连着 CRASH ——
> 崩掉的那个留下浏览器进程 → 内存更紧 → 下一个也崩）。当时本机空闲内存只剩 ~120MB
> （用户自己的 Chrome/微信/Codex 应用占着 16G 的大部分）。**五个套件单跑全绿**
> （4/0、1/0、4/0、4/0、7/0），随后重跑整轮 **退出码 0**。

## 发版与回滚

- **本轮不上线**：这是"多了一种可选后端"，线上那个 `服务器助手` 仍然跑 `--brain pi-sdk`
  （换不换是产品决定，见决策⑥：模型/凭据归 agent 自己；换成 ACP 需要那台机器有自己的
  Claude 凭据）。
- 因此回滚 = 什么都不用做（线上行为未变）；代码侧回滚 = `git revert` 这一提交。

## 反漂移自检（方案 §8 逐条）

1. **有没有让"房间只是场地"变差？** 没有：ACP 后端只跟"一个成员"打交道，房间不认识它用什么协议。
2. **有没有把昵称当寻址依据？** 没有：触发仍由 `room/adapter.ts` 的 `@<id8>` 判定。
3. **新增 agent 接入要不要改房间侧？** 不用：这一期**只加了一个文件** `agent-io/acp.ts`
   \+ CLI 的 spawn 配置分支，`room/` 零改动（这就是 B2 拆分的验收标准）。
4. **能不能单独回滚？** 能：它没上线，回滚就是 revert。
5. **有没有已拍板决策与现实冲突？** 没有；决策⑤（权限先放开）用**显式开关**落实，默认仍是拒绝。
