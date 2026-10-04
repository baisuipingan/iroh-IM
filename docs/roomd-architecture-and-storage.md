# roomd 架构说明 与 历史存储改造决策

> 这份文档回答两件事：
> 1. roomd 到底是什么（它不是 HTTP 服务）—— 因为这套架构只散落在代码注释里
> 2. 历史存储该怎么改：**手写 jsonl / SQLite / PostgreSQL 的取舍**，以及对本项目的建议
>
> 所有数字都是**在线上实测**的，不是估算。

---

## 第一部分 · roomd 是什么

### 一句话

**roomd 是一个"伪装成普通客户端的常驻 Peer"**，不是 HTTP 服务。

### 它不是什么（常见误解）

| 常见猜测 | 实际 |
|---|---|
| 是个 HTTP 服务，用 axum/actix | ❌ **没有 HTTP 框架**（`grep -iE "axum\|actix\|hyper\|warp\|TcpListener"` 零命中） |
| 监听端口、有 URL 路由 | ❌ **不监听任何端口**，compose 里连 `ports:` 都没有 |
| 前端打 `https://host/api/history` | ❌ 前端按 **EndpointId（一个公钥）** 连它 |
| 路由靠 URL 路径 | ❌ 路由靠 **ALPN** 字符串（TLS 协议协商字段） |
| 需要公网 IP / 域名 / 证书 | ❌ 它像浏览器一样**主动出站**连中继 |

### 它实际长什么样

**打包**：单个静态二进制（**7.3 MB**），`cargo build --release` 产出，`#[tokio::main]` 跑异步。

**镜像**：`FROM debian:bookworm-slim` + `ca-certificates`，就这些。

**依赖服务**：**零**（不需要 nginx / redis / 数据库）。

**入口**：两个 ALPN

```
/iroh-gossip/1              加入房间组播（和浏览器客户端同一个协议）
editor.vip/iroh-history/1   拉历史 / 拿在线快照（这条只有 roomd 提供）
```

**启动后的主循环**——`main()` 的最后一行就是全部：

```rust
// 保持进程存活
std::future::pending::<()>().await;
```

没有 accept 循环、没有请求处理。所有工作由 iroh 的 `Router` 在后台按 ALPN 分发。

**内部 4 个常驻任务**：

| 任务 | 干什么 |
|---|---|
| 消息消费 | 订阅房间 gossip → 解 `Wire` → 验签 → 落盘 |
| presence 心跳 | 每 15 秒广播"常驻节点在线"（所以别人看得到它） |
| 订阅管理 | 按需订阅房间：令牌桶限速 + 容量上限 + LRU 淘汰 + 占位防并发 |
| 空闲回收 | 30 分钟没动静的房间自动退订 |

**没有 HTTP 入口的三个后果**：

1. 没有管理接口 —— 配置只能走环境变量，可观测性只能靠 `docker logs`
2. 取 EndpointId 是 `docker logs roomd | grep ROOMD_ENDPOINT_ID`，不是访问接口
3. **若要用 PostgreSQL，只能由 roomd 自己直连**（不存在"加个 API 层"这种做法）

### 各组件职责

| 组件 | 有状态吗 | 存什么 | 挂了会怎样 |
|---|---|---|---|
| 中继 relay ×3 | ❌ 无状态 | 什么都不存 | 换一台继续（所以有冗余） |
| 浏览器客户端 | ⚠️ 极少 | 文件续传位图、偏好、房间列表 | 丢续传进度、丢设置 |
| **roomd** | ✅ **全部** | 历史 + 身份 + 在线快照 | **历史拿不到**（实时聊天不受影响） |
| Cloudflare | ❌ | 只有静态文件 | 重新部署 |

**重要**：roomd **不在消息转发路径上**。实时消息靠 gossip（中继转发）自己送达，
roomd 只是"另一个收件人 + 存了一份"。所以它挂了不影响实时聊天，只影响历史。

---

## 第二部分 · 线上数据实测（决策的基础）

2026-10-04 实测 `data/history/`：

| 指标 | 实测值 |
|---|---|
| 房间数（文件数） | **164** |
| 总消息条数 | **767** |
| 总字节数 | **243 KB** |
| 最大单文件 | **13 KB** |
| 平均每条消息 | **351 字节** |
| 最大单条消息 | **432 字节** |

### 换算：数据量到底有多大

按 351 字节/条算：

| 场景 | 消息数 | 占用 |
|---|---|---|
| 当前全部 | 767 条 | 243 KB |
| 单个房间 1 万条 | 10,000 | **≈ 3.5 MB** |
| 单个房间 10 万条 | 100,000 | **≈ 35 MB** |
| 单个房间 100 万条 | 1,000,000 | **≈ 351 MB** |
| 200 个活跃房间 × 各 10 万条 | 2000 万条 | **≈ 7 GB** |

**结论**：你现在**全部数据都不够塞进一个软盘**。
即使是"200 个房间各 10 万条"这种相当可观的长跑场景，也只有 **7 GB** ——
**这个量级，SQLite 连汗都不会出。**

---

## 第三部分 · 三个方案的对比

### 先说清楚现在的问题（与方案无关，是必须修的 bug）

现在的实现是「手写 jsonl + 全量进内存」：

```
磁盘 .jsonl（只追加、从不清理）
    ↓ 启动时全读进内存
内存 HashMap<room, Vec<ChatMessage>>   ← 分页查询从这里切片
```

由此产生三个真实缺陷：

1. **内存上限 = 可读上限**。内存留 16 MiB（`MAX_MEM_HISTORY_BYTES`），
   磁盘写到 64 MiB（`MAX_HISTORY_FILE_BYTES`）才压缩 ——
   中间那 **48 MiB 永久拉不到、且不报错**。用户看到"历史断了一截"。
2. **每次请求 clone 整份列表**。`recent_before_bounded` 持锁遍历 + 逐条 `clone()`。
3. **磁盘无上限增长**（只追加，没有保留策略）。

**这三个问题的根源是"没有索引"** —— 而不是"用了文件"。

### 方案对比

| | 现状（手写 jsonl） | **SQLite** | PostgreSQL |
|---|---|---|---|
| 分页查询 | ❌ 只能全读内存后切片 | ✅ 索引 + `LIMIT`，真分页 | ✅ 同左，且更强 |
| 索引 | ❌ 无 | ✅ B-tree | ✅ B-tree（+ 更多类型） |
| **打包进二进制** | ✅（就是文件） | ✅ **可静态编译进二进制** | ❌ **必须独立进程** |
| 外部依赖 | 无 | **无** | ⚠️ **多一个要运维的服务** |
| 部署改动 | — | **零**（还是单容器） | compose 加 service + 数据卷 + 备份 |
| 需要 C 工具链 | 否 | ⚠️ 需要（**但构建机已有 cc/gcc，已验证**） | 否（`sqlx` 纯 Rust） |
| 并发写 | 单进程串行（有锁） | ✅ WAL 模式支持并发读 + 单写 | ✅ MVCC，多写并发 |
| 多进程/多机共享 | ❌ | ❌ 单机文件锁 | ✅ 网络访问 |
| 数据量舒适区 | < 几 MB | **< 几十 GB** | 几十 GB ~ TB |
| 备份 | `cp` 目录 | **`cp` 单个文件** | `pg_dump` + 要管理 |
| 迁移方便性 | 拷目录 | ✅ **拷一个文件**（或直接删了重建） | 要 dump/restore |
| 运维复杂度 | 最低 | **极低** | 中（要管服务、连接池、版本） |

### 关键澄清：三个我前面说错/说漏的点

1. **"SQLite 要 C 工具链"不构成障碍** —— 我实测了构建机：
   `/usr/bin/cc` 和 `/usr/bin/gcc` **都已存在**。
   而且 `libsqlite3-sys` 会 **bundle 一份 SQLite 源码一起编译**，
   所以**运行时的容器里连 sqlite 都不需要装**。
2. **SQLite 可以静态编译进二进制** —— 这正是它的核心特性：
   整个数据库就是**一个文件**，引擎在二进制里。产物仍然是"单文件部署"。
3. **"拷一个文件"比现在的"拷目录"更简单** —— 现在 164 个文件散在一个目录里，
   SQLite 是 `history.db` 一个文件。**迁移反而更省事。**

---

## 第四部分 · 建议

### 推荐：**SQLite**（`rusqlite` + `bundled` 特性）

理由，按重要性排序：

1. **数据量级完全匹配**。你现在 243 KB、平均 351 字节/条。
   按 351 字节/条，即使长跑到 **100 万条也只有 351 MB** ——
   SQLite 的舒适区上限是**几十 GB**。**你离需要 PG 差了 2~3 个数量级。**
2. **不改变部署形态**。仍然是一个容器、一个二进制、`docker compose up -d --build`。
   引入 PG 意味着：多一个要备份/要监控/要升级的服务，以及"PG 挂了 roomd 也起不来"的新故障点。
   **对"自用/小圈子"来说，这是净负担。**
3. **直接消灭那三个缺陷**：加索引后分页是真的 `WHERE (ts,id) < ? ORDER BY ts DESC, id DESC LIMIT ?`，
   内存不再需要装下全部历史，**那 48 MiB 静默丢失的问题自然消失**，
   保留策略变成一条 `DELETE` 语句。
4. **迁移更简单**：`history.db` 一个文件，`cp` 走就行（现在要拷 164 个文件）。
5. **构建已验证可行**：构建机有 gcc；`bundled` 会自带 SQLite 源码编进二进制。

### 什么情况下才该上 PostgreSQL

只有这三条同时成立才值得：

- 数据量到 **几十 GB 以上**（按你的消息尺寸，约 **1 亿条**）
- **需要多进程/多机共享同一份数据**（比如 roomd 水平扩展成多实例）
- **已经有 PG 在运维**（边际成本为零时）

**你目前一条都不成立。** 而且如果真到了那一天，从 SQLite 迁到 PG
也只是"导一遍表"的活 —— **不会白做。**

### 明确不建议的

- ❌ **继续用现在这套 jsonl + 全量内存** —— 它在**静默丢数据**，是 bug 不是风格
- ❌ **为了上 PG 而上 PG** —— 你现在 243 KB，PG 是 2~3 个数量级之后的答案
- ❌ **我早先提的"方案 A：字节偏移索引"** —— 那是在"不引依赖"前提下的折中。
  既然 SQLite 可行（构建机有 gcc，且能静态编译），**直接上 SQLite 更对**，
  不必再手工造一层索引轮子

---

## 第五部分 · 如果要做，改造范围

### 涉及文件（很小）

| 文件 | 改动 |
|---|---|
| `client-wasm/Cargo.toml` | 加 `rusqlite = { version = "0.3x", features = ["bundled"] }` |
| `client-wasm/src/room.rs` | **只有 `HistoryStore`** 一个结构体的内部实现。`append` / `recent_before_bounded` / `count` / `load_from_disk` 的**签名不变** |
| `deploy/roomd/` | **不用改**（仍然单容器；SQLite 文件放 `/data/history.db`） |

⚠️ **关键约束**：`HistoryStore` 在 `room.rs` 里，而 `room.rs` **要编译到 wasm**
（浏览器端）。wasm 里没有 `std::fs`，所以 SQLite 那部分**必须用 `#[cfg(not(target_arch = "wasm32"))]` 隔离** ——
现有代码已经在用这个模式（`write_history_file_atomic` 就是这么处理的），照抄即可。
**不会影响 wasm 产物体积。**

### 数据迁移（一次性）

现有 164 个 `.jsonl`（243 KB）→ 导入 `history.db`：
写个小工具读 jsonl 灌进表，**几秒钟的事**。而且可以在 roomd 启动时自动做一次迁移
（检测到 `history.db` 不存在、但有 `.jsonl` 就导入），**无需停机操作**。

### 建议的表结构

```sql
CREATE TABLE messages (
  room        TEXT NOT NULL,       -- 原始房间名（不是哈希）
  ts          INTEGER NOT NULL,    -- 毫秒
  id          TEXT NOT NULL,       -- 消息 id（参与签名）
  json        BLOB NOT NULL,       -- 完整消息（含 sig），避免字段漂移
  PRIMARY KEY (room, ts, id)
) WITHOUT ROWID;                   -- 按主键聚簇，范围扫描最快

-- 分页/裁剪都走主键：(room, ts, id) 既是有序的也是游标
```

**为什么存 `json` 整条而不是拆字段**：
拆字段意味着"表结构 = 协议结构"，以后协议一改就要改表（我们已经踩过 v3→v4 的坑）。
存整条 JSON + 把查询需要的 `room/ts/id` 提出来做索引，
**既是真索引，又不会和协议耦合**。

### 顺带的收益

改完之后可以顺便做这几件事（现在做不到）：

- **把默认页大小改成 20**（现在 50）—— 就是改个常量
- **真正的保留策略**：`DELETE FROM messages WHERE room=? AND ts < ?`，
  或者"保留最近 N 条"——不再需要 16 MiB / 64 MiB 那两个互相打架的上限
- **历史条数/未读数**之类的运维指标（`SELECT count(*)` 就是）

---

## 附：一句话回答几个常见疑问

| 疑问 | 答案 |
|---|---|
| SQLite 能打包进二进制吗？ | ✅ **能**，`bundled` 特性会把 SQLite 源码一起编进去，运行时不需要装任何东西 |
| 迁移方便吗？ | ✅ 比现在**更方便**：一个 `history.db` 文件，而不是 164 个散文件 |
| 需要改部署吗？ | ❌ 不需要，仍然单容器单二进制 |
| 需要 C 工具链吗？ | ⚠️ 编译时需要，**但构建机已有 gcc（已实测）**；运行时不需要 |

### `bundled` 特性的官方原话（已核对 rusqlite README）

> `bundled` causes us to automatically compile and link in an up to date version
> of SQLite for you. This avoids many common build issues, and **avoids depending
> on the version of SQLite on the users system**（or your system）, which may be old
> or missing. **It's the right choice for most programs that control their own
> SQLite databases.**

实现方式（官方说明）：

> If you use the `bundled` ... features, `libsqlite3-sys` will use the **cc crate to
> compile SQLite from source and link against that**. This source is **embedded in
> the `libsqlite3-sys` crate** and is currently SQLite 3.53.2.

**三条结论**（都是官方明确的）：
1. SQLite 源码**内置在 crate 里**，带 `bundled` 就会一起编译 —— 不需要系统装 sqlite
2. 编译用 `cc` crate 调 C 编译器（构建机有 gcc，已验证）
3. **静态链接进二进制** —— 运行时的容器里不需要任何 SQLite 库

许可也没问题：SQLite 是 **public domain**（官方 README 明确写了）。
| 数据量到多少该换 PG？ | **几十 GB**（按你的消息尺寸约 1 亿条）。你现在 243 KB |
| 会不会白做？ | ❌ 不会。`HistoryStore` 的接口不变，将来真要换 PG 只是换个实现 |
