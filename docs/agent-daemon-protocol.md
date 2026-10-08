# iroh-agent daemon 行协议

> **状态：Rust 侧 v1 已实现**（`agent.rs` 的 `serve` 子命令，2026-10-08）。
> 已实测：单进程协议冒烟（hello / reply / 错误码 / 优雅退出）与双进程真实收发
> （消息互收、presence 互见、peerUp/peerDown、退出码 0）。
> 待办：黄金转录回归（§12）与 TS/pi 适配器。
>
> 目标读者是两边的实现者：
> - Rust 侧：`agent.rs` 的 `serve`
> - TS 侧：`pi` 适配器（LLM 编排、工具、记忆）通过本协议与 Rust 进程对话
>
> 设计目标一句话：**Rust 只做搬运（协议/签名/gossip/文件），TS 只做智能（LLM/触发/记忆），
> 中间用 JSON Lines 解耦。** 协议层（含 `room.rs` 的签名与验签）不在 TS 里重新实现。

---

## 0. 为什么长这样

| 决策 | 理由 |
|---|---|
| 复用 `RoomNode`（原生编译同一份 `room.rs`） | 签名、验签、gossip 加入、历史、传输调优只有一份实现；避免第二份协议 |
| 行协议（stdin/stdout）做进程接口 | 仓库已有先例：主线程 ↔ Worker 的 postMessage RPC、JS ↔ wasm；崩溃隔离、语言边界清晰 |
| **stdout 只跑协议，日志一律 stderr** | 行协议最经典的坑：一条 `println!` 就能污染整个流 |
| 单进程 = 单房间 = 单身份 | 核心就是 `joined: Option<Joined>`（`room.rs:1375`），不发明核心没有的语义 |
| 历史走 pull 命令，不是事件 | 与浏览器一致：历史是 RPC `fetch_history`（`iroh-worker.js:900`），`RoomEvent::History` 在核心中**从未被 emit** |
| 事件负载 = `RoomEvent` 的 serde JSON 原样嵌入 | 一份定义两处消费；不做字段重命名，不做二次建模 |

---

## 1. 进程模型与拓扑

```
pi 适配器（TS，supervisor）
  ├── spawn: iroh-agent serve --room 派大星 --nick "小助手"
  │        stdin  ← 命令（JSON Lines，本协议）
  │        stdout → hello / reply / event（JSON Lines，本协议）
  │        stderr → tracing 日志（绝不进 stdout）
  ├── spawn: iroh-agent serve --room 另一个房间 ...   （多房间 = 多进程）
  └── …（每个进程独立管理：重启、退避、健康）
```

**身份约定**：一个进程 = 一个 `identity.key` = 房间里固定的"一个人"。

- ⚠️ **不要让两个 `serve` 进程共用同一个身份目录**：同 EndpointId 的两个端点同时在线，
  中继路由与房间里 presence 的 epoch 语义都会打架。要两个房间的"同一人格"，
  需要核心支持多房间（`joined` 改 `HashMap`，见 §11 待定 2），v1 不做。
- 建议每个 agent 人格一个目录：`IROH_AGENT_HOME=~/.config/iroh-agent/<人格名>`。

---

## 2. 帧规则

- UTF-8 JSON，**一行一个对象**，`\n` 结尾。JSON 会转义内部换行，帧边界永远安全。
- **单行上限 1 MiB**：超过则整行丢弃并回 `badRequest`（防止误把大文件贴进 stdin 打爆内存）。
- daemon 启动后**必须先发 `hello`**；客户端（TS）应在收到 hello 之后再发命令。
- 信封公共字段 `v`（协议版本，当前 `1`）。命令可省略（默认 1）；**不认识主版本号必须拒绝**，
  尤其 `chatProtocol`（聊天协议当前 v4）——跨版本互认的结果是验签失败静默丢消息。
- **stdout 写入策略**：专用线程 + `sync_channel(4096)` + 逐行 flush。队列满时：
  只允许丢 `fileProgress`；`reply` / `message` / 其它事件反压等待（宁可慢，不可丢）。
  真正的消费端卡死属于 TS 的 bug，不为此增加复杂度。
- 事件序列号 `seq` 从 1 单调递增，**跨重连/换房不重置**（TS 用它检测自己是否漏读）。

---

## 3. hello（daemon → 客户端，握手）

```json
{"v":1,"type":"hello","agent":"iroh-agent/1.1.0","endpointId":"<64位hex>",
 "chatProtocol":"v4","nickname":"小助手",
 "relay":{"url":"https://iroh1.editor.vip:15443","connected":true}}
```

| 字段 | 说明 |
|---|---|
| `agent` | 二进制版本（npm 包/安装脚本据此做兼容检查） |
| `endpointId` | 本身份公钥（展示"它是谁"；也是签名验证的公钥） |
| `chatProtocol` | 聊天协议版本（`sigfmt::PROTO_V4`）。不匹配 → TS 应拒绝启动并提示升级 |
| `relay` | 当前 home relay（可能为 `null`，还没握手完成） |

---

## 4. 命令（stdin，TS → daemon）

通用信封，每个命令**恰好一个 reply**（可能很晚；事件与 reply 会交错，按 `id` 关联）：

```json
{"v":1,"id":"c1","cmd":"say","text":"你好"}
```

- `id`：字符串，TS 自己生成（建议单调递增）。缺失 → `badRequest`；
  在同一 id 的 reply 未发出前重复使用 → `badRequest`。

| cmd | 参数 | reply.value | 说明 |
|---|---|---|---|
| `join` | `{room, nickname?}` | `{room}` | 进房/换房。成功后另有 `joined` 事件；**状态以事件为准** |
| `say` | `{text}` | `{id, ts}` | 文本消息（自动签名）。`id` 即消息 id，用于回环去重 |
| `send_file` | `{path, name?, mime?}` | `{fileId, name, size, chunkSize, rootHash}` | 发布文件（整读算 blake3 后广播邀约）；有人接收后 daemon **自动推送** |
| `unpublish` | `{fileId}` | `{}` | 从"可提供"清单撤下（更新心跳）；已在途的推送不中断 |
| `list_files` | `{}` | `{files:[{fileId,name,size}]}` | 当前货架 |
| `nick` | `{nickname}` | `{}` | 改名（立刻重播 presence） |
| `history` | `{limit?, before?}` | `{messages, snapshot?}` | **拉取**历史。`before` = `"<ts>:<id>"` 复合游标（空 = 最新一页） |
| `status` | `{}` | `{endpointId, room, relays, peers, files, uptimeMs}` | 诊断/外部健康检查 |
| `leave` | `{}` | `{}` | 广播离开声明并退订当前房间（进程保持存活） |
| `shutdown` | `{reason?}` | `{}` | 优雅退出：leave → close → `bye` → exit 0 |
| `ping` | `{}` | `{ts}` | 活性探测 |

细则：

- `say` 文本上限建议 **32 KiB**（gossip 帧上限 512 KiB 是给整条 JSON 的，聊天用不着；
  超限回 `tooLarge`，不要让 gossip 层去报错）。
- `send_file` 的 `name` 默认取路径 basename，`mime` 默认 `application/octet-stream`。
  每次调用生成**新** `fileId`（`new_file_id()`）——重复发布同一路径会得到两张卡片。
- `history` 的 `snapshot` 复用 `HistoryResponse.snapshot`（成员表 + 各人文件清单），
  与浏览器进房时拿到的是同一份东西，可直接作为 LLM 的"开场上下文"。
- **换房（join 到不同房间）时 daemon 自动清空货架**，并在 `joined` 事件里带
  `clearedFiles:[...]`。理由：文件清单按房间隔离（F7 那类缺陷的教训），
  心照不宣地保留会产生"在 A 房广播 B 房文件"的错位。

---

## 5. 事件（stdout，daemon → TS）

```json
{"v":1,"type":"event","seq":42,
 "event":{"type":"message","room":"派大星","mine":false,"message":{"id":"…","from":"…","nickname":"…","text":"…","ts":0}}}
```

- `event` 字段是 **`RoomEvent` 的 serde JSON 原样嵌入**：variant 名是 camelCase（`message`、
  `fileAccepted`…），负载字段沿用核心序列化（`file_id`、`receiver_relay` 等 snake_case）。
  **TS 侧不要做字段名转换**，直接透传/读取 —— 字段名以核心为准，避免两套命名漂移。

---

## 6a. RoomEvent → 协议事件映射表

| `RoomEvent`（`room.rs:562`） | event.type | 负载（同核心） | TS 用途 / 注意 |
|---|---|---|---|
| `Joined{room}` | `joined` | `{room, clearedFiles?}` | 进房确认。与 join 的 reply 双通道，以事件为准 |
| `Message{room,message,mine}` | `message` | `{room,mine,message:{id,from,nickname,text,ts,sig?,file?}}` | LLM 输入的唯一来源。**必须按 `id` 去重**（自己发的会回环，`mine=true`）；`file:Some` 是文件证明，不是内容 |
| `Presence{room,peers}` | `presence` | `{room,peers:[{id,nickname,lastSeenMs,files,epoch}]}` | "谁在线/谁有文件"；@触发判断的成员来源 |
| `PeerUp{id}` / `PeerDown{id}` | `peerUp` / `peerDown` | `{id}` | **gossip 邻居**变化，不等于成员进出（成员看 presence） |
| `History{…}` | — | — | ⚠️ 核心**从未 emit** 此变体；历史统一走 `history` 命令（pull） |
| `FileInvite{room,meta}` | `fileInvite` | `{room,meta}` | 别人发文件。daemon 目前**不能接收**（见 §11 待定 4），TS 可选择忽略 |
| `FileAccepted{room,file_id,have,receiver_relay,by}` | `fileAccepted` | 同左 | daemon **自动**开始推送；TS 只观察/记录 |
| `FileRejected{room,file_id,reason,by}` | `fileRejected` | 同左 | 记录，降噪 |
| `FileDone{room,file_id,ok,reason}` | `fileDone` | 同左 | 协议级传输结束（收发两向都会收到） |
| `FileQueryAsked{room,file_id,by}` | `fileQueryAsked` | 同左 | 有人点了历史卡片问文件；**daemon 应自动重发邀约回应**（对齐 wasm worker 行为，agent 当前缺失） |
| `RelayStatus{relays}` | `relayStatus` | `{relays:[{url,connected,lastError,authDenied}]}` | 健康诊断。`authDenied` = 重试无用，需要人工处理 |
| `Error{message}` | `error` | `{message}` | 非致命播报（对照 reply 的 error.code） |

## 6b. SendEvent → 协议事件（进度类，daemon 自产）

进度**不是** `RoomEvent` 直通——与 `wasm_api.rs:290` 同款做法，daemon 从
`send_file_data(..., on_event)` 的 `SendEvent` 生成（`filetransfer.rs:620`）：

| `SendEvent` | event.type | 负载 | 说明 |
|---|---|---|---|
| `Started{need}` | `fileSendStarted` | `{fileId, peer, needChunks}` | 接收方已连上，给了断点位图 |
| `Progress{done,total,bytes}` | `fileProgress` | `{fileId, peer, direction:"send", doneChunks, totalChunks, bytes}` | 高频；TS 可采样，勿触发 LLM |
| `Finished` | `fileSendFinished` | `{fileId, peer}` | 本端已发完（回执另见 `fileDone`） |
| `Failed{reason}` | `fileSendFailed` | `{fileId, peer, reason}` | 推送失败 |
| `Ack{..}` | —（不暴露） | — | 与 `fileDone` 重复；v1 不加，需要时按"加字段/加事件不破坏兼容"补 |

## 6c. daemon 自产的生命周期事件（不在 RoomEvent 里）

| type | 负载 | 说明 |
|---|---|---|
| `fatal` | `{reason}` | 不可恢复（事件流结束/端点关闭）；发完即退出非零 |
| `bye` | `{reason}` | 优雅退出完成（`shutdown` 的终点） |

两者与普通事件**同信封**（`{"v":1,"type":"event","seq":N,"event":{...}}`）；`fatal` 在
启动失败时 `seq` 可能为 0。

---

## 7. reply 与错误码

```json
{"v":1,"type":"reply","id":"c1","ok":false,
 "error":{"code":"roomMismatch","message":"当前房间 派大星，命令意图 蟹堡王"}}
```

| code | 触发 | TS 建议动作 |
|---|---|---|
| `badRequest` | JSON 解析失败 / 缺字段 / id 缺失或重复 / 超行上限 | 修复调用方；不重启 |
| `unsupportedCmd` / `unsupportedVersion` | 未知 cmd / v 不匹配 | 升级适配器或二进制；不重启 |
| `notJoined` | 未进房就 `say`/`send_file` | 先 join |
| `roomMismatch` | 换房过程中的竞态命令（核心 `invite_file` 带 `expect_room`） | 丢弃该次操作 |
| `tooLarge` | 文本超上限 | 拒绝，不重试 |
| `fileReadFailed` | 路径不可读 | 修路径；重试无意义 |
| `noRelay` | 本端没有可用中继地址（`my_relay_url()` = None） | 等 `relayStatus` 恢复后重试 |
| `joinFailed` | 进房失败（核心已内建 4 次/20s 重试，`room.rs:1690`） | 退避重试，message 里有原因 |
| `internal` | 其它 | 记日志；连续出现考虑重启进程 |

约定：`message` 给人看，`code` 给程序判断；**未知 code 一律按 `internal` 处理**。

---

## 8. 生命周期与 supervisor 约定

- **stdin EOF = 退出信号**：TS 没了，daemon 自行走优雅退出（防孤儿进程）。
- **信号**：`SIGTERM`/`SIGINT` → 同 gracefully shutdown（先 leave 再关）。
- **崩溃恢复归 TS**：daemon 不自重启；异常退出前尽力发 `fatal`，退出码非 0。
  TS 用退避重启，重启后重新 `join`（和 `scripts/…/agent-install` 无关，属于适配器逻辑）。
- **中继断线**由 iroh 端点内部重连，daemon 不重建端点；期间通过 `relayStatus` 反映。
  端点彻底死亡（事件流结束）→ `fatal`。
- **重启后的文件**：不自动重发（整读算哈希；且新 `fileId` 会让接收方断点失效）。
  需要"重启后继续服务"就重新 `send_file`；"同一 fileId 跨重启续传"见 §11 待定 3。
- **优雅退出顺序**：reply(shutdown) → `leave_room()` → `endpoint.close()` → `bye` → exit 0。
  close 后留 300ms（与现有 `main()` 相同处理，`agent.rs:736`）。

---

## 9. 安全边界（协议的一部分）

- **stdin 是可信输入**：命令来自父进程，同机同权限，协议不做鉴权（做了也没意义）。
- **房间内容是不可信输入**：daemon 只搬运、不基于内容做任何动作。LLM 侧的 prompt injection
  防线（工具白名单、人工确认、成本上限）必须在 TS，**协议刻意不提供"自动执行"**。
- **`send_file` 无沙箱**：daemon 以运行用户身份读任意路径。要收窄请在部署层做
  （专用系统用户 / 容器只挂载工作目录），不要在协议里假装有权限系统。
- **stdout 污染 = 协议损坏**：`serve` 模式下所有 `println!` 与 tracing 必须走 stderr。
  ⚠️ 现有 CLI 的 tracing 默认输出 stdout —— 这是实现时第一个要修的点。

---

## 10. 示例会话（黄金转录的雏形）

```
daemon → {"v":1,"type":"hello","agent":"iroh-agent/1.1.0","endpointId":"ab12…","chatProtocol":"v4","nickname":"小助手","relay":{"url":"https://iroh1.editor.vip:15443","connected":true}}
TS     → {"v":1,"id":"1","cmd":"join","room":"派大星","nickname":"小助手"}
daemon → {"v":1,"type":"reply","id":"1","ok":true,"value":{"room":"派大星"}}
daemon → {"v":1,"type":"event","seq":1,"event":{"type":"joined","room":"派大星","clearedFiles":[]}}
daemon → {"v":1,"type":"event","seq":2,"event":{"type":"presence","room":"派大星","peers":[{"id":"cd34…","nickname":"海绵宝宝","lastSeenMs":1728…,"files":[],"epoch":1728…}]}}
daemon → {"v":1,"type":"event","seq":3,"event":{"type":"message","room":"派大星","mine":false,"message":{"id":"9f8e…","from":"cd34…","nickname":"海绵宝宝","text":"小助手在吗","ts":1728…}}}
TS     → {"v":1,"id":"2","cmd":"say","text":"在的，有什么可以帮你？"}
daemon → {"v":1,"type":"reply","id":"2","ok":true,"value":{"id":"a1b2…","ts":1728…}}
daemon → {"v":1,"type":"event","seq":4,"event":{"type":"message","room":"派大星","mine":true,"message":{"id":"a1b2…","from":"ab12…","nickname":"小助手","text":"在的，有什么可以帮你？","ts":1728…}}}
TS     → {"v":1,"id":"3","cmd":"shutdown","reason":"收到终止信号"}
daemon → {"v":1,"type":"reply","id":"3","ok":true,"value":{}}
daemon → {"v":1,"type":"event","seq":5,"event":{"type":"bye","reason":"收到终止信号"}}
```

---

## 11. 待定（需要拍板）

1. **命名**：`serve` / `daemon` / `bridge`（草案用 `serve`）。
2. **多房间同人格**：核心单房间是硬约束。要么进程=人格=房间（v1），要么先做
   `RoomCtx` 重构把 `joined` 变 `HashMap`（见 `room.rs:1375`），再谈多房间。
3. **`fileId` 跨重启稳定**：是否让 daemon 缓存 `(path,size,mtime)→meta`（存
   `~/.config/iroh-agent/files/`）？有缓存才能大文件跨重启续传，但要定义失效判定。
4. **接收能力**：原生侧已有完整接收（`receive_file_data` + `filetest`），补一个
   `accept_file {fileId, savePath}` 命令 + 落盘 sink 就能让 agent 也收文件。进不进 v1？
5. **presence 标记**：先用昵称约定（`[bot] 小助手`），不动协议（v5 的代价见前文）。
6. **稳定性承诺**：v1 期间允许"加可选字段/加新事件"，不允许"改字段语义/删字段"。

---

## 12. 实现清单（给编码的人）

Rust 侧 v1 已完成：

- [x] `agent.rs`：新增 `serve` 子命令（复用 `start_node`）
- [x] serve 模式：tracing writer 改 **stderr**；`load_or_create_identity` 等既有
      `println!` 路径改走 stderr（`quiet` 参数）——⚠️ 这是实现时的第一个坑：
      生成身份的 `println!` 直接污染了协议流，冒烟脚本当场抓到
- [x] stdout 写线程（`sync_channel(4096)`、逐行 flush、只丢进度类事件）
- [x] 命令解析/分派：id 关联、错误码、未知 cmd/v 不崩、超行上限
- [x] RoomEvent 转发任务（`subscribe()` 扇出 + `seq`）
- [x] `SendEvent` → `fileSendStarted/fileProgress/...`；`FileQueryAsked` → 自动重发邀约
- [x] `history` ← `fetch_history_before`（复合游标 `"<ts>:<id>"`）
- [x] stdin EOF / SIGTERM / SIGINT → 优雅退出（`biased` 保证显式退出优先于 EOF）
- [x] 本文件 + README 索引一行
- [x] `Cargo.toml`：cli feature 加 `tokio/signal`（`signal-hook-registry` 已在锁里，`--locked` 无影响）

还没做：

- [ ] 黄金转录回归（`client-wasm/tests/`，固定 fixture，忽略 ts/seq 等易变字段）
- [ ] daemon 版 e2e（⚠️ 独立 `IROH_AGENT_HOME`，别和别的进程共用身份）
- [ ] 接收能力（`accept_file`，见 §11 待定 4）

TS 侧（`agent-pi/`，已完成 v0.1；`pi-sdk` 大脑 v0.2）：

- [x] `AgentClient`：行协议请求/事件、看门狗、崩溃指数退避自动重启
- [x] `ChatAdapter`：前缀/@提及触发、去重、冷却、UTF-8 安全截断
- [x] `RuleBrain`（规则文件）与 `CommandBrain`（子进程，可直接接 `pi -p`）
- [x] `PiSdkBrain`：pi SDK 长会话（默认人设 + 注入防线、`noTools:'all'`、inMemory 会话、
      认证走 `~/.pi/agent`）；faux 冒烟已过（会话连续性/错误路径/工厂响应）
- [x] CLI 与库入口；已过真实链路 e2e（触发/非触发/提及/杀进程自愈/SIGTERM 退出码 0）
- [ ] pi-sdk × 真实 LLM 的房间级 e2e（待本机 3050 代理在跑时实测）

---

*依据代码：`agent.rs` / `room.rs` @ `cc4091f`（2026-10-08）；`serve` 已在该提交之后的工作树中实现并实测。行号会漂移，引用处已尽量带符号名。*
