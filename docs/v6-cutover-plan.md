# V6 切割方案：结构化 mentions + 名片房间状态（一次切）

> 方案 §V6 的落地说明。**这是破坏性升级**：签名载荷版本 v5→v6，
> 按 v4→v5 的先例，roomd / 前端 / agent **必须同时升级**。
> 本文给出精确改动面、切割顺序、验证与回滚、以及**待拍板的三个决定**。

## 1. 改动面（代码级，全部核实过）

### 1.1 Rust 核心 `client-wasm/`（一处改，四处生效：web wasm / agent / roomd / android .so）

| 改动 | 位置 | 说明 |
|---|---|---|
| `PROTO_V5` → `PROTO_V6` | `src/sigfmt.rs:84` `pub const PROTO_V5` | **任何签名串改动必须 bump**（文件头注释：否则新旧签名互相误认） |
| `ChatMessage` 加 `mentions` | `src/room.rs:142` 结构体 | `#[serde(default)] mentions: Vec<String>`（端点 id；**规范化：去重+排序**后进签名） |
| `canonical()` 载荷加 mentions 段 | `src/room.rs:161` | 在 `text` 段后加 `"mentions"` 段（长度前缀编码，无歧义） |
| `compute_id()` 并入 mentions | `src/room.rs:196` | 否则"同文本不同 mentions"会撞 id（历史按 id 去重→静默丢消息） |
| 常量引用点 | `room.rs` 18 处、`filetransfer.rs` 4 处、`bin/agent.rs` 1 处 | 全是版本串；presence/leave/file 族的载荷都带它 → 一起换 |
| 版本协商 | `room.rs` `note_client_protocol`（~1190） | 服务端只记日志不拒绝（既有设计）；旧客户端靠 hello/响应里的版本号提示"刷新" |
| **V6.2 名片状态帧** | `room.rs` + `sqlite_history.rs` | `{"t":"profile"}` 从"约定消息"升为**权威状态帧**：成员改名片→直接广播状态帧；roomd 快照（`bio/tags/profile_ts`，R2b 已有）为权威来源；迁移期双读历史里的 v5 名片消息（`messages_with_text_prefix` 的 SQL 扫描保留一个版本后退役） |

### 1.2 前端 `frontend/`

| 改动 | 位置 | 说明 |
|---|---|---|
| 发送产出结构化 mentions | `js/mention.js` `resolveDraft()`（:127） | 现在只回 `{text}`（token 写进文本）；v6 回 `{text, mentions: [endpointId…]}`，**文本不再需要 token** |
| 携带 mentions 发送 | `js/ui/composer.js`（:451/:543）、`js/net.js`（:650 `call('send')`）、`js/iroh-worker.js` | `send(text, mentions)` 一路传到 wasm |
| 渲染：优先结构化 | `js/mention.js` `segments()`（:57） | `message.mentions` 存在→直接画 chip；不存在→**回退解析文本 token**（读 v5 历史/双读期） |
| 通知 | `js/ui/notify.js`（:118 `mentionsMe`） | 改读结构化 mentions |
| 版本提示 | `js/net.js`（:436 `protocolMismatch`） | 已有："你是旧版，请刷新"——切割时正好用上 |

### 1.3 agent-pi（**官方适配器契约**，`docs/agent-daemon-protocol.md`）

| 改动 | 位置 | 说明 |
|---|---|---|
| `say(text, mentions?)` | `src/room/client.ts` + `src/room/protocol.gen.ts`（重新生成） | IPC 契约加可选字段；事件里的 `message.mentions` 同步 |
| 触发改读结构化 | `src/room/adapter.ts` `#extract()` | `mentions` 含我的 id → 触发；**过渡期**文本 `@<id8>` 兜底（一个版本窗口） |
| 契约样例跟着 v6 | `examples/minimal-supervisor.ts`、`docs/agent-daemon-protocol.md`（:116 say 行） | 40 行样例是契约的"证据"，必须同步 |
| 召唤器的 relay 文案 | `src/summoner.ts` | 转交时说 `@<id8>` 文本 → v6 改成携带 mentions 发送（文本里可留人话） |

### 1.4 roomd（服务器）

- 同一份 lib 重建（`dist/roomd` → scp → `docker compose up -d --build`，备份 `roomd.bak-<时间戳>`）。
- **无 schema 迁移**：SQLite `messages` 表把整条消息存 `json` 列（`sqlite_history.rs:69`），
  加字段 = serde `#[serde(default)]` 读旧行；快照字段同样 `serde(default)`。

### 1.5 Android

- `.so`：`.github/workflows/build-android-so.yml`（CI）重出；
- **APK**：`android-v0.2.0` 是已发产物——不重出的话它进不了 v6 房间（协议不匹配）。
  取舍见 §4 决定 2。

## 2. 切割顺序（**一次切**；任一步失败 → 整体回滚，见 §3）

1. 拍板 §4 的三个决定（历史策略 / Android / 切点）；
2. 实现（建议分支 `codex/v6-cutover`，main 保持绿）：Rust 核心 → 前端 → agent-pi → 契约文档；
3. 本地验证：`cargo test`（goldens 重生 + 新增 v6 转录）、agent-pi 单测、`check-protocol-types.sh`；
   ⚠️ 浏览器 e2e 连的是**生产 roomd**：切之前跑旧版绿；**切之后再跑**（那时生产已经是 v6）；
4. 打 tag `agent-v1.3.0` → CI 出多平台产物 → 服务器 `deploy/agent/install-release.sh` 安装；
5. 服务器 roomd 更新（先备份）；
6. 前端 CF 发布（`scripts/deploy-web.sh`）；
7. 线上 smoke：进房 / 收发 / @（结构化）/ 名片 / 历史 / 文件；核对哈希与服务状态；
8. 收尾：`verify.sh all` 全绿、发版记录 `docs/release-2026-10-1X-protocol-v6.md`、台账更新；
   Android 按决定 2 处理。

## 3. 回滚

- **可回滚点**：切之前 main 的提交 + 三个旧产物（旧 CF 版本、`roomd.bak-*`、服务器现装的
  agent Release `agent-v1.2.0`）。回滚 = 三者一起退回去（缺一即半切，比不切更糟）。
- 双读策略（决定 1 推荐）下，**历史不受切割影响** —— 回滚也不丢历史。

## 4. 待拍板的三个决定（按推荐度排序）

**决定 1 · 历史策略** —— 推荐：**验证双读**（v6 端收到旧签名也能验过，历史与旧端只读兼容）。

- 背景：签名载荷里带版本串（`v5`/`v6`），验证方**可以**先用 v6 规范试、失败再按 v5 规范试
  —— 这就是"双读"。代价：验签路径多一条回退分支（5 个消息族都要试两种）。
- 备选：**干净切**（v4→v5 的先例：旧历史验不过 → 视为丢失）。实现更简单，但用户的历史
  与旧标签页会一起消失。
- 推荐双读的理由：本项目已经上线给人用（im.pinkstar.cc），历史不是测试数据；实现增量小。

**决定 2 · Android** —— 推荐：**web + agent 先切，APK 另排**（.so 走 CI 顺手出好）。

- 备选 A：同批出 APK（如果 APK 构建链路在本仓/CI 可跑）；备选 B：接受旧 APK 断代。

**决定 3 · 切点** —— 推荐：**决定 1/2 拍完就切**（V6.1+V6.2 一批）。

- 备选：等 V6.3（可选加密）先写威胁模型、一起攒——"攒一次切"的距离由所有者定；
  若要等，本文档仍适用（加密是**加法**，不改签名载荷结构）。

## 5. 反漂移核对（相对方案 §1/§2）

- 不把消息格式/签名插件化：V6 是**原生化**改动（签名载荷里加字段），没有引入插件层 ✓
- @ 仍只按 id 寻址：结构化 mentions 里存的就是 EndpointId，昵称仍然只给人看 ✓
- 加 agent = 加 spawn 配置：agent-pi 侧改动只在 room/ 契约层，agent-io 不动 ✓
- 模型/凭据仍归各 agent：本方案不碰 ✓
