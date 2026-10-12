# 2026-10-12 B1 + B2 + B5：适配器契约扶正 + room/agent-io 拆分 + 最小示例

## 一句话

把"`agent serve` 的 JSON-lines IPC"**扶正为官方适配器契约**（任何语言写个 supervisor
就能让那个 agent 成为房间成员），把适配器内部**机械拆成 `room/`（房间侧）与
`agent-io/`（可插后端）**，并补一个 **40 行、不 import 仓库任何代码的最小示例**来证明
契约够用。

## B1 · 契约扶正

`docs/agent-daemon-protocol.md` 从"某个内部协议"改写成**适配器契约**：

- 标题与开篇明确：这是"怎么把任意 agent 接进房间"的官方契约；**Rust 只是参考实现**，
  不为任何语言造 iroh 绑定（硬约束）。
- 状态更新（原来写着"待办：黄金转录回归与 TS 适配器"——**两件都早已落地**）：
  黄金转录 `client-wasm/tests/daemon-protocol.rs`；TS 侧 `agent-pi/`。
- 新增一节 **「契约里什么是必须，什么是自由」**（两栏表）：

| 必须做（违反即不兼容） | 实现自由（写 agent 的人自己定） |
|---|---|
| 先等 `hello` 并校验 `chatProtocol`（不匹配拒绝启动） | 触发策略（被 @ 才答/全答/冷却） |
| **stdout 只跑协议**，日志走 stderr | prompt 组织、带不带历史 |
| 每条命令的 `id` 必须在 `reply` 里回同一个 | 模型与工具（MCP/Skill/bash 是私事） |
| 事件 `seq` 单调递增 | 记忆/状态放哪（内存/文件/DB） |
| 单行 ≤ 1 MiB | 会话怎么保活（一次性/常驻/后台） |
| 不绕过服务端资源闸门 | 语言与运行时 |

## B2 · room/agent-io 拆分（**零行为变化**）

```
src/
├── room/                     ← 房间侧：传输 + 成员策略（不认识具体是哪个 agent）
│   ├── protocol.ts           行协议类型与错误码
│   ├── protocol.gen.ts       由 Rust 生成（**不要手改**）
│   ├── client.ts             子进程 + 行协议客户端（看门狗/自动重启）
│   └── adapter.ts            触发（@id8 / @昵称 / respondToAll）、去重、冷却、文件闸门
└── agent-io/                 ← agent 侧：换 agent = 换一份 spawn 配置
    ├── index.ts              `AgentBrain` 接口
    ├── rule.ts               规则后端（**测试替身**）
    ├── command.ts            子进程后端（**兜底**，与框架无关）
    ├── pi-sdk.ts             pi SDK 长会话后端
    └── tools.ts              pi-sdk 的工具
```

- 全部用 `git mv` 搬（历史保留）；只改 import 路径与 `mod.ts` 的导出。
- 顺带修掉两处**已经过时的注释**：`adapter.ts` 头部还写着"触发规则：1. 前缀 `!ping`" ——
  `!` 早在 R3 就删了（现在写清"@id8 / @昵称兜底 / respondToAll"，并注明**别再加回前缀**）。
- `agent-pi/README.md` 补上这张结构图 + 一句验收标准：
  **加一个 agent 应该只动 `agent-io/`，`room/` 那半不该有任何改动。**
- 闸门同步改路径：`scripts/gen-protocol-types.sh`、`scripts/check-protocol-types.sh`、
  `scripts/test-agent-adapter.mjs` 的 import、`docs/deploy.md` 与方案文档里的引用。

## B5 · 最小示例（提前做了，因为它是契约的**证据**）

`agent-pi/examples/minimal-supervisor.ts`：**40 行左右、不 import 仓库任何代码**，
只按契约做四件事 —— 起 `iroh-agent serve`、等 `hello`（校验 `chatProtocol`）、
收到 `@<我的 id8>` 就回一条、收到信号优雅退出。

> 为什么提前做：B1 的主张是"任何语言写个 supervisor 就能接入"。没有这个小例子，
> 这句话只能靠我们的实现来"背书"；有了它，别的语言照着 40 行移植即可。

## 验证

| 项 | 结果 |
|---|---|
| `agent-pi` tsc | 通过（新路径下编译干净） |
| `scripts/test-agent-adapter.mjs` | **11/11** |
| `scripts/check-protocol-types.sh` | ✅（含新路径 `agent-pi/src/room/protocol.gen.ts`） |
| `biome lint frontend agent-pi` | 干净（顺手修掉 R2a 留下的两条提示：正则里的多余转义、`let`→`const`） |
| 浏览器回归 `mention-id` / `profile` | **18/18** / **15/15**（lint 修复后复跑，没被改坏） |
| **活体验证 ①（B2）**：部署后的 agent-pi | 从**部署目录**起一个临时成员（rule 后端）→ 浏览器用规范 token `@c2e39961 ping` → 回 `pong` ✅ |
| **活体验证 ②（B5）**：最小示例 | 只按契约的 40 行示例起在另一个房间 → `@89cc2cec ping` → 回 `收到：ping` ✅ |
| `bash scripts/verify.sh all` | **退出码 0**（干净整轮：Rust / 安全攻击 / 4 组 Node 套件 / 17 组浏览器套件） |

## 发版与回滚

- 适配器：`rsync --delete` 整个 `src/` 到 `/opt/iroh-agent/agent-pi/src/`（**必须带
  `--delete`**：旧布局的文件留在那儿会让 Node 解析到两份模块），再 `systemctl restart`。
  重启后日志：`已就绪：mention=服务器助手（触发方式只有 @）` + `已进入房间 patrick`。
- 回滚：`git checkout <上一个提交> -- agent-pi/src` 后重新 rsync + 重启
  （纯源码，无数据面改动）。
- roomd / wasm **本轮未动**。前端那一处改动（两条 lint 修复，语义完全等价）已随本轮发版：
  CF **`93aebfeb-9d9d-4dc0-908d-919238bae8a8`**，线上哈希与本地一致：
  `js/ui/composer.js` `10f83ea16373ec4e`、`js/ui/roster.js` `2bbfe92f680b8abe`、
  `pkg/iroh_web_bg.wasm` `c2a9957bf92f5a3e`（**与上一版逐字节相同** —— 见下）。
  ⚠️ 发版自检又报了一次"wasm 比源码旧"（`ts_export.rs` 只改了**注释**，mtime 变新），
  按仓库既定做法重编后**哈希不变**，证明是假警报。

## 反漂移自检（方案 §8 逐条）

1. **有没有让"房间只是场地"变差？** 没有：这期只动了适配器的**内部形状**与文档。
2. **有没有把昵称当寻址依据？** 没有：两种后端的触发都只认 `@<id8>`（昵称兜底仍可关）。
3. **新增 agent 接入要不要改房间侧？** 不用：最小示例与三个后端都只碰 `agent-io/` 这一侧。
4. **能不能单独回滚？** 能：适配器是纯源码，回滚 = 换回上一个提交的 `src/` 重启。
5. **有没有已拍板决策与现实冲突？** 有一处**顺序**调整：B5 提前到 B3/B4 之前做，
   原因是"契约够用"这句话需要一个不看我们实现的证据。已在此记录，不是静默改序。
