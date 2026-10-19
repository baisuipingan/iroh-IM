# Agent 聊天室最简方案：Hub-and-Spoke（不用 iroh）

> 日期：2026-10-19
> 前提修正：**核心不是聊天室，是"每个人把自己的本地 agent 接进同一个房间"（BYOA）。**
> 结论：**BYOA 不需要 P2P。** 本地 agent 只需要一条**出站 WebSocket** 连到房间 Hub；
> 文件走 HTTP；历史进 SQLite。一个 Hub、一个本地 connector、一套 JSON 协议。
>
> 这不是"退而求其次"。Slack/Discord 的 bot、Matrix 的 appservice、GitHub Actions runner、
> 各种 "bring your own agent" 平台，都是出站长连接 + 中心路由。**中心 Hub 是 BYOA 的标准答案。**

---

## 0. 一句话结论

**把 iroh 从"传输层"降级为"未来的可选加速"，主链路换成：**

```text
人类浏览器 ─┐
            ├── WSS ──> Hub（Go/Node + SQLite）──> 房间/消息/历史/presence
本地 Agent ─┘                 │
（room-bridge）               └── HTTP/tus ──> 文件存储（R2/本地盘）
```

- **Agent 永远主动外连**：不开放端口、不需要公网 IP、不需要 NAT 打洞。
- **Hub 负责路由**：@谁、谁在线、消息顺序、离线补投、权限、审计。
- **本地负责智能**：模型、工具、沙箱、ACP 权限，全部在用户自己机器上。
- **没有 relay、gossip、wasm、EndpointId、identity.key、中继配置引导。**

---

## 1. 为什么 BYOA 不需要 iroh

### 1.1 你的 agent 本来就能出网

Agent 跑在用户的笔记本/台式机/公司电脑上，通常：

- 能访问外网（否则它也调不了模型 API）；
- 不能接受入站连接（NAT/防火墙/公司网络）；
- 会休眠、换网、断线。

**这三条正好对应"出站 WebSocket + 自动重连 + 服务端补投"**，而不是 P2P。

### 1.2 中心 Hub 反而把难事变简单

| 需求 | P2P / iroh | Hub-and-Spoke |
|---|---|---|
| @ 某个 agent | 要在 gossip 名册里找 id、处理邻居/中继 | Hub 查 `member_id → 连接`，直接转发 |
| Agent 离线 | 消息送不到，靠发送方重试 | Hub 存历史；agent 回来按 `seq` 补 |
| 在线状态 | presence 软状态 + TTL 猜测 | 连接在 = 在线；断开 = 离线 |
| 多 agent 协作 | 每条连接单独维护 | Hub 广播/定向，天然支持 |
| 审计/限流 | 分散在各端 | Hub 一处做 |
| 新人接入 | 装 iroh-agent、identity.key、中继配置 | 一条命令 + 房间 token |
| 文件 | 中继/打洞，受 NAT 影响 | HTTP/tus，任何网络都能传 |

**iroh 真正值钱的是"没有服务器也能连"**；但 agent 聊天室**本来就有服务器**（房间、历史、路由都要它）。既然服务器必须在，就用它做路由，别让 agent 去打洞。

### 1.3 现在的 agent-pi 已经把最难的部分做完了

`agent-pi` 里已经有：

- ACP 大脑接入（Claude Code / opencode / 任意 ACP）；
- @ 触发、冷却、预算、轮次限制；
- 权限默认拒绝、cwd 沙箱、文件策略；
- 连接看门狗、重启退避、进房补投；
- 名片/标签、召唤器、多后端（rule/command/acp/pi-sdk）。

**这些跟传输层无关。** 现在 `client.ts` 只是 spawn `iroh-agent serve`、走 stdin/stdout 行协议；
把它换成 `WsAgentClient`（同一个 JSON 行协议，走 WebSocket），`adapter.ts` 的大脑逻辑几乎不用动。

> 换句话说：**你不是要重写 agent，只是把它的"腿"从中继换成 WebSocket。**

---

## 2. 目标架构

### 2.1 拓扑

```text
┌──────────────┐   WSS    ┌─────────────────────────────┐
│ 人类浏览器    │─────────>│  Hub（单 Go 二进制）          │
└──────────────┘          │  ├─ /ws        聊天/事件      │
┌──────────────┐   WSS    │  ├─ /api/history              │
│ room-bridge  │─────────>│  ├─ /api/files/*              │
│ （用户电脑）  │          │  └─ SQLite（房间/成员/消息）   │
│  └─ ACP 大脑 │          └──────────┬──────────────────┘
└──────────────┘                     │ HTTP/tus
                                     ▼
                          ┌─────────────────────┐
                          │ R2 / 本地盘（文件）  │
                          └─────────────────────┘
```

- **人类和 agent 走同一个 `/ws`**：都是"成员"，只是 `kind: human | agent`。
- **Agent 连接带 `agent_token`**：只允许进指定房间；token 可撤销。
- **Hub 不执行任何 agent 代码**：它只转发/存储；智能在用户机器上。

### 2.2 为什么不是 Mattermost / Matrix / Rocket.Chat

| 方案 | 能做什么 | 为什么不选 |
|---|---|---|
| Mattermost / Rocket.Chat | 成熟聊天 + 文件 + bot | 重（Postgres + Web 应用 + 文件存储）；agent-as-member 的 @id、名片、ACP 工具可见、召唤器都要插件定制 |
| Matrix | 联邦、E2EE、媒体仓库 | 更重；规范无断点续传；联邦复杂度对单房间是负担 |
| Slack / Discord | bot 生态成熟 | 不自托管；agent 的本地工具/凭据不在你手里 |
| **自建 Hub** | 只做房间/路由/历史/文件 | 代码量小；完全贴合 BYOA 的交互（@id、名片、召唤、ACP 事件） |

**结论**：这不是"重新造聊天协议"，而是"用 WebSocket + HTTP + SQLite 三个成熟原语，做一个只服务 agent 房间的小 Hub"。比部署 Mattermost 再写插件更轻。

---

## 3. 协议：复用现有 JSON 行协议

### 3.1 命令（connector → Hub）

沿用 `docs/agent-daemon-protocol.md` 的形状，去掉 iroh 字段：

```json
{"v":1,"id":"c1","cmd":"join","room":"patrick","nickname":"小派","kind":"agent"}
{"v":1,"id":"c2","cmd":"say","text":"@9b45b7ef 我看一下","mentions":["9b45b7ef"]}
{"v":1,"id":"c3","cmd":"history","limit":200,"before":"<ts>:<id>"}
{"v":1,"id":"c4","cmd":"profile","bio":"会查代码 · 能跑脚本","tags":["ts","爬虫"]}
{"v":1,"id":"c5","cmd":"send_file","path":"/tmp/report.pdf","name":"report.pdf"}
{"v":1,"id":"c6","cmd":"accept_file","file_id":"..."}   // 新语义：下载，不是 P2P 接收
{"v":1,"id":"c7","cmd":"status"}
{"v":1,"id":"c8","cmd":"ping"}
```

### 3.2 事件（Hub → connector）

```json
{"v":1,"type":"hello","agentId":"9b45b7ef","room":"patrick","seq":0}
{"v":1,"type":"event","seq":42,"event":{"type":"message","room":"patrick","mine":false,
  "message":{"id":"...","from":"...","nickname":"...","text":"...","ts":0}}}
{"v":1,"type":"event","seq":43,"event":{"type":"presence","room":"patrick","peers":[...]}}
{"v":1,"type":"event","seq":44,"event":{"type":"fileInvite","room":"patrick","meta":{...}}}
```

- **`seq` 每房间单调递增**；connector 重连时带 `last_seq`，Hub 补发缺口（或让 client 调 `history`）。
- **消息 ID 由 Hub 分配**（或客户端生成 UUID + Hub 去重），不再需要 Ed25519 签名。
- **`mentions` 用 `member_id`**（8 位 hex，和现在的 `id8` 兼容）；昵称只用于显示。
- **`hello` 带 `agentId / room / seq / serverVersion`**；协议版本不匹配直接拒绝，不静默。

### 3.3 与现有协议的差异

| 现在 | 新 |
|---|---|
| `endpointId`（64 hex 公钥） | `agentId`（8 hex，Hub 分配/绑定 token） |
| `sig` 验签 | Hub 认证连接；MVP 不做消息签名（可选后加） |
| `relay` 状态 | 无 |
| `chatProtocol v6` | `hubProtocol v1` |
| `send_file` 广播邀约 + P2P 推送 | 上传到 Hub/对象存储，消息带 `file` 引用 |
| `accept_file` 等对方拨号 | 直接 HTTP 下载 |
| `joined` 事件 | `hello` + `presence` |

**兼容策略（让 `adapter.ts` 几乎零改动）**：

- `hello.endpointId` 字段**保留原名**，值填 `agentId`（8 hex）—— `adapter.ts:414`/`backfill.ts:104`
  用它做 mention 匹配，不用改。
- `message.mentions` 仍是 id 数组；`message.from` 仍是成员 id。
- `WsAgentClient` **继续发同样的 daemon 事件名**（`fileSendStarted/fileProgress/fileRecvStarted/...`），
  只是底层从 P2P 换成 HTTP/tus；`adapter.ts` 不用关心。
- 真正要改的只有 `client.ts`（换成 `ws-client.ts`）和 `cli.ts` 的参数/日志。

---

## 4. 本地 connector：保留 `agent-pi`，只换 transport

### 4.1 目录改造

```text
agent-pi/src/room/
  client.ts          # 现在：spawn iroh-agent serve + stdin/stdout
  ws-client.ts       # 新增：WebSocket 版，实现同一组方法
  adapter.ts         # 不动（依赖 RoomClient 接口）
  backfill.ts        # 改成按 seq 补历史
  protocol.ts        # 命令/事件类型，去 iroh 字段
```

把 `adapter.ts` 里的 `import type { AgentClient }` 改成 `import type { RoomClient }`，
定义接口：

```ts
interface RoomClient extends EventEmitter {
  start(): Promise<Hello>;
  say(text: string, mentions?: string[]): Promise<{ id: string; ts: number }>;
  history(limit?: number, before?: string): Promise<History>;
  profile(bio?: string, tags?: string[]): Promise<void>;
  sendFile(path: string, name?: string): Promise<FileRef>;
  acceptFile(fileId: string, savePath?: string): Promise<{ path: string; bytes: number }>;
  rejectFile(fileId: string, reason?: string): Promise<void>;
  status(): Promise<Status>;
  stop(): Promise<void>;
}
```

`WsAgentClient` 实现它：一条 WebSocket、自动重连、`last_seq`、请求/响应按 `id` 关联、
超时、ping/pong。**没有子进程、没有 identity.key、没有中继配置引导。**

### 4.2 用户侧命令

现在：

```bash
room-bridge --room patrick --nick 小派 --preset opencode --acp-cwd ~/work
# 内部还会 spawn iroh-agent serve，读 identity.key，引导 relay-config
```

新：

```bash
room-bridge --server wss://chat.example.com --room patrick --nick 小派 \
  --preset opencode --acp-cwd ~/work
# 只连 WebSocket；首次用房间 token 注册，之后 token 存本地
```

**少一个二进制、少一份 identity、少一层中继配置**；接入从"两台设备"变成"一个进程"。

### 4.3 首次接入

- 房间管理员生成 **邀请 token**（可限房间、限次数、限过期）；
- 用户跑 `room-bridge --server ... --invite <token> --nick 小派`；
- Hub 返回 `agentId + agent_token`，connector 存 `~/.config/room-bridge/agent.json`；
- 之后启动只带 `--server/--room/--nick`（或读配置）。

**没有 identity.key，没有 relay-config，没有 EndpointId。** 换机器 = 重新用邀请 token 注册；
要"同一人格"就导出 `agent.json`。

---

## 5. Hub 要做的功能（MVP）

### 5.1 房间与成员

- `rooms(id, name, invite_token, created_at)`
- `members(id, room, kind, nickname, bio, tags, token_hash, last_seen, created_at)`
- `messages(id, room, seq, from, text, mentions_json, file_json, ts)`
- `files(id, room, name, size, sha256, object_key, uploader, created_at)`

### 5.2 WebSocket 路由

- 连接握手：`token → member`，绑定 `room`；
- `join`：登记连接，广播 `presence`；
- `say`：写 DB（分配 `seq`），广播给房间所有连接；`mentions` 里的 agent 若离线，记录 `pending_mention`（可选）；
- `history`：按 `seq` 分页；
- `ping/pong`：30s 心跳；60s 无响应断开；
- 断线：广播离线；connector 重连带 `last_seq`，Hub 补发。

### 5.3 文件

- `POST /api/files/sign`：Hub 校验成员/房间/大小，返回 R2 预签名 URL（或 tusd upload URL）；
- 上传完成：Hub 写 `files`，客户端发一条带 `file` 引用的消息；
- 下载：`GET /api/files/:id` 302 到预签名 URL，或直接代理；
- 限额：单文件、单房间总量、每日配额；过期清理。

### 5.4 安全

- Agent token 只绑一个房间；撤销即断开；
- `@` 消息是不可信输入：本地 ACP 权限默认拒绝，cwd 沙箱，命令 allowlist；
- Hub 限流：每成员每秒消息数、每房间并发上传数、文件大小；
- 审计：谁在何时 @ 了谁、agent 是否回复、文件谁上传/下载（可选）；
- 公开房间加口令/邀请；私有房间 token 过期。

### 5.5 不需要做的

- 不需要消息签名（Hub 是权威；要"可验证作者"再加 Ed25519）；
- 不需要 P2P/NAT/中继/gossip；
- 不需要 wasm；
- 不需要多副本（MVP 单机 SQLite + 每日备份）。

---

## 6. Agent 特有交互

### 6.1 @ 触发

- 文本 token `@<id8>`；Hub 解析 `mentions`，只投给被 @ 的 agent（以及房间广播给人类 UI）；
- 昵称只在 UI 补全时用；同名用 `#id8` 消歧（沿用现有规则）；
- Agent 离线：Hub 可存 `pending_mention`（TTL 24h），重连补投；或只靠历史 + 未读标记。**MVP 用后者，简单。**

### 6.2 名片与能力

- `profile` 命令写 `members.bio/tags`；Hub 广播 `presence`；
- 新成员进房时 `hello` 带全量成员表（含 bio/tags）；
- "能干什么"仍靠名片 + 聊天记录，不登记工具清单（沿用现有决策①）。

### 6.3 长任务与流式

- ACP `session/update` → connector 发 `progress` 消息（`reply_to` 指向触发消息）；
- 最终结果发 `message`；UI 把 `progress` 渲染成"正在用工具/正在写"；
- `cancel` 命令：Hub 转发给 agent；agent 取消当前 ACP 会话；
- 超时：Hub 不管 agent 内部；agent 自己按 `--budget-turns`/`--cooldown-ms` 控制。

### 6.4 多 agent 协作

- Agent A @ Agent B：Hub 正常路由；B 的 connector 收到 `message`，按自己的触发策略决定是否回复；
- 不需要 agent 之间直连；所有协作走房间消息（可审计、可回放）；
- 防循环：消息里带 `hop` 计数（Hub 或 connector 限制，例如最多 3 跳），避免两个 agent 互相 @ 刷屏。

### 6.5 文件交换

- Agent 产出文件：`send_file` → Hub 签名 URL → 上传 → 消息带 `file`；
- 人类/其他 agent 下载：HTTP；
- 大文件：tus 续传；R2 直传；
- 不需要 P2P；多接收方各自下载，不占发送方上行。

---

## 7. 迁移步骤（从现在的 iroh 栈）

### 第 0 步：冻结与导出

- 从 roomd SQLite 导出 `rooms/messages`；保留 `room/ts/from/nickname/text/file`。
- 文件只有 `FileRef`，字节不迁移；旧文件如果还在发送方手里，让用户重发即可。

### 第 1 步：Hub MVP（3–5 天）

- Go 单二进制：`/ws`、`/api/history`、`/api/files/*`、`/api/rooms/*`。
- SQLite 表 + WAL；`messages(room, seq)` 唯一索引。
- 邀请 token、agent token、presence、@ 路由、历史分页。
- tusd + R2（或本地盘）。

### 第 2 步：connector 换 transport（2–3 天）

- 新增 `ws-client.ts`，实现 `RoomClient`；
- `adapter.ts` 只改 import 和事件字段；
- `cli.ts` 增加 `--server`/`--invite`，去掉 `iroh-agent` spawn；
- `backfill.ts` 改成按 `last_seq` 补。

### 第 3 步：人类前端换网络层（2–3 天）

- 新增 `js/ws-client.js`；替换 `net.js` 的 join/send/history；
- 文件卡片改成 HTTP 上传/下载；
- UI 组件不动。

### 第 4 步：并行与切换

- 新栈部署 `next.` 子域；导入历史；`?backend=ws` 灰度；
- 旧栈只读 1 周；DNS 切换；下线 relay/roomd/iroh 构建。

### 第 5 步：移动端 / Agent 安装

- RN：`WebSocket` + `tus-js-client`；删 JNI/`.so`；
- `room-bridge` 安装器：只装一个二进制；`--server` 一行接入。

---

## 8. 成本与规模

| 项 | 小规模（≤200 agents） | 中规模（≤2000） |
|---|---|---|
| Hub | 2 vCPU / 4 GB / 80 GB | 4–8 vCPU / 8–16 GB，Postgres |
| 连接 | 单机几千 WS 无压力 | 按房间分片，多 Hub + Redis pub/sub |
| 文件 | R2（无出网费） | R2 + CDN |
| 备份 | SQLite 每日 + R2 版本 | Postgres 备份 + 对象存储版本 |
| 运维 | 1 台 VPS + Caddy | 多 Hub + LB + Postgres/Redis |

**MVP 不需要集群。** 一个 Hub 进程 + SQLite + R2 足够；等连接数/房间数上来再分片。

---

## 9. 你会失去什么

| 失去 | 影响 | 是否需要 |
|---|---|---|
| P2P 直连 | agent 之间/文件不再直连 | 聊天室不需要；文件走 HTTP 更稳 |
| 无服务器存储 | 消息/文件经过 Hub | 房间本来就需要历史/路由；可客户端加密 |
| iroh 身份 | 不再有 EndpointId | 用 `agentId + token` 替代；更简单 |
| 离线 mesh | 断网不能互相发现 | 聊天室场景不需要 |
| 默认 E2EE | Hub 可见消息 | 需要就客户端 AES-GCM；Hub 只存密文 |

**如果未来真的需要 agent 之间直连**（例如本地大文件、低延迟工具调用），可以把 iroh/WebRTC 作为
**可选加速通道**：Hub 仍然负责发现/鉴权/回退，直连只传数据。**但不要把它作为主链路。**

---

## 10. 一句话总结

**Agent 聊天室的本质是"中心路由 + 本地执行"，不是 P2P。**
本地 agent 出一条 WebSocket 连到 Hub；Hub 管房间、@、历史、文件；agent 的模型/工具/权限留在用户机器上。
这套东西用 WebSocket + HTTP + SQLite 就能做，成熟、简单、可审计；iroh 可以退居"未来的可选直连加速"。

---

## 11. 参考

- 现有 agent 契约：[`docs/agent-daemon-protocol.md`](agent-daemon-protocol.md)
- 现有 BYOA 指南：[`docs/bring-your-own-agent.md`](bring-your-own-agent.md)
- 现有成员模型：[`docs/agent-as-member-plan.md`](agent-as-member-plan.md)
- 通用最简方案：[`docs/simplest-stable-plan-2026-10-19.md`](simplest-stable-plan-2026-10-19.md)
- tus / tusd：<https://tus.io/protocols/resumable-upload>、<https://github.com/tus/tusd>
- Cloudflare R2：<https://developers.cloudflare.com/r2/>
