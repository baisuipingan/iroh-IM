# 改造方案：历史存储从手写 jsonl 换成 SQLite

> 状态：**已确认，准备开工**
>
> 用户决策（2026-10-04）：
> | 项 | 决定 |
> |---|---|
> | 保留条数 | **100,000 条/房间** |
> | 页大小 | **保持 50**（不改） |
> | 旧数据 | **直接删除，不做迁移**（开发阶段，破坏性变更可接受） |
> 前置调研见 [`roomd-architecture-and-storage.md`](roomd-architecture-and-storage.md)
> 与 [`message-storage-design.md`](message-storage-design.md)

---

## 一、为什么改（三个已存在的缺陷）

现在的实现是「手写 jsonl + 全量进内存」：

```
磁盘 data/history/<hash>.jsonl（只追加、从不清理）
    ↓ 启动时全读进内存（被裁到 16 MiB）
内存 HashMap<room, Vec<ChatMessage>>   ← 分页查询从这里切片
```

由此产生三个**真实缺陷**（不是风格问题）：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | **内存上限 = 可读上限** | 内存留 16 MiB、磁盘写到 64 MiB 才压缩 → **中间约 48 MiB 永久拉不到、且不报错**。用户看到"历史断了一截" |
| 2 | **每次请求 clone 整份列表** | `recent_before_bounded` 持锁遍历 + 逐条 `clone()`；历史越长单次请求越贵 |
| 3 | **磁盘无上限增长** | 只追加、无保留策略 |

**根因是"没有索引"**，不是"用了文件"。

另有一个相关但独立的问题：`append_lock` 是**全局一把锁**（所有房间共用），
且**持锁期间做文件 I/O** —— 会阻塞同一 tokio 工作线程上的其他任务。

---

## 二、目标与非目标

### 目标

1. **可查范围 = 磁盘上的范围**（消灭"静默丢历史"）
2. **真分页**：`LIMIT` 查询，不再全量进内存、不再 clone 整表
3. **明确的保留策略**：替掉 16 MiB / 64 MiB 两个互相打架的上限
4. ~~默认页大小 50 → 20~~ —— **用户确认保持 50，不改**
5. **不改变部署形态**（仍单容器、单二进制、零外部服务）
6. **不影响 wasm 产物**（浏览器端不引入 SQLite）

### 非目标（明确不做）

- ❌ 不做多机/多进程共享（那才需要 PG/Turso）
- ❌ 不做服务端加密（E2EE 是独立课题，见 `message-storage-design.md`）
- ❌ 不改协议、不动签名、不动 `Wire` 格式
- ❌ 不改前端（除页大小常量）

---

## 三、方案选型（已定）

**`rusqlite` + `bundled` 特性。**

| 候选 | 结论 |
|---|---|
| **rusqlite + bundled** | ✅ **选它**。SQLite 源码内置在 crate 里一起编译、静态链接进二进制、运行时无需任何 SQLite 库；SQLite 是 public domain |
| PostgreSQL | ❌ 数据量差 2~3 个数量级（现在全部 243 KB）；多一个要运维/备份的服务和故障点 |
| Turso / libSQL | ❌ 卖点是边缘副本 + 多机复制，本项目一个都用不上；且官方已把方向转向未 1.0 的 Rust 重写版 |
| 继续用 jsonl + 手工偏移索引 | ❌ 在手工造存储引擎，做完还是要换 |

**已实测**：构建机 `/usr/bin/cc` 与 `/usr/bin/gcc` **都已存在**，
所以 `bundled` 需要 C 编译器这一条**不构成障碍**。

---

## 四、改动范围

### 4.1 依赖（1 行）

```toml
# client-wasm/Cargo.toml
rusqlite = { version = "0.3x", features = ["bundled"], optional = true }
```

设为 `optional`，只在 `cli`（原生）feature 下启用 —— **wasm 构建不会拉它**。

### 4.2 核心：只改 `HistoryStore` 的内部实现

`HistoryStore` 共 **7 个公开方法**，**签名全部不变**：

```rust
impl HistoryStore {
    pub fn new(dir: Option<PathBuf>) -> Self        // 签名不变
    pub fn append(&self, room: &str, msg: ChatMessage) -> bool
    pub fn recent(&self, room: &str, limit: usize) -> Vec<ChatMessage>
    pub fn recent_before(&self, room: &str, before: Option<(u64, String)>, limit: usize) -> Vec<ChatMessage>
    pub fn recent_before_bounded(&self, room: &str, before: Option<(u64,String)>, limit: usize, max_bytes: usize) -> Vec<ChatMessage>
    pub fn count(&self, room: &str) -> usize
    pub fn load_from_disk(&self)                     // 变成"打开库 + 必要时迁移"
}
```

**关键结构变化**：

```rust
pub struct HistoryStore {
    dir: Option<PathBuf>,
    /// 原生：SQLite 连接。wasm：永远为 None
    #[cfg(not(target_arch = "wasm32"))]
    db: Option<Arc<Mutex<rusqlite::Connection>>>,
    /// wasm 仍然用内存 HashMap 当"历史"（浏览器端本来就不落盘）
    mem: Arc<Mutex<HashMap<String, Vec<ChatMessage>>>>,
}
```

⚠️ **wasm 侧必须完全不受影响**：
`room.rs` 要编译到 wasm，但浏览器端**不存历史**（`history_dir` 传 `None`，
`load_from_disk` 是空操作）。所以 SQLite 相关代码全部用
`#[cfg(not(target_arch = "wasm32"))]` 隔离，
**现有代码已经在用这个模式**（`write_history_file_atomic` 就是这么写的），照抄即可。

### 4.3 表结构

```sql
CREATE TABLE IF NOT EXISTS messages (
  room  TEXT    NOT NULL,   -- 原始房间名（不是 blake3 哈希）
  ts    INTEGER NOT NULL,   -- 毫秒
  id    TEXT    NOT NULL,   -- 消息 id（参与签名）
  json  BLOB    NOT NULL,   -- 完整 ChatMessage（含 sig）
  PRIMARY KEY (room, ts, id)
) WITHOUT ROWID;

PRAGMA journal_mode = WAL;    -- 并发读 + 单写
PRAGMA synchronous  = NORMAL; -- WAL 下的常规选择
```

**为什么存整条 JSON 而不是拆字段**：拆字段意味着"表结构 = 协议结构"，
以后协议一改就要改表 —— **v3→v4 那次破坏性变更**就是这么来的坑。
存整条 JSON + 把查询要用的 `room/ts/id` 提出来做索引，
**既是真索引，又不与协议耦合**。

`WITHOUT ROWID` + 主键 `(room, ts, id)`：按主键聚簇，
**范围扫描（翻页）和保留策略裁剪都走主键**，次序天然是我们要的。

### 4.4 查询改写

```sql
-- 替代 recent_before_bounded
SELECT json FROM messages
WHERE room = ?1
  AND (?2 IS NULL OR (ts, id) < (?2, ?3))   -- 游标
ORDER BY ts DESC, id DESC
LIMIT ?4;
-- 然后按字节预算从下往上截（保留现有语义），再反转成正序返回
```

**不再需要**：全量 `clone()`、内存上限、`cap_history_in_place`。

### 4.5 保留策略（替掉两个打架的上限）

新增一个明确的常量，例如：

```rust
/// 每个房间保留的最近消息数。超出的在 append 后按批裁掉。
/// 10 万条 × 351 字节 ≈ 33.5 MiB/房间（磁盘），100 房间 ≈ 3.3 GiB。
pub const HISTORY_RETAIN_PER_ROOM: usize = 100_000;
```

```sql
DELETE FROM messages
WHERE room = ?1
  AND (ts, id) NOT IN (
    SELECT ts, id FROM messages WHERE room = ?1 ORDER BY ts DESC, id DESC LIMIT ?2
  );
```

**用户选定 100,000 条/房间**（核对过：33.47 MiB/房间，100 房间 ≈ **3.27 GiB 磁盘**）。

⚠️ 注意这是**磁盘**占用，不是内存 —— 换到 SQLite 后不再有"内存装不下就取不出来"的问题。
所以取大写是安全的。

### 4.6 旧数据：**直接删除，不迁移**

用户明确：开发阶段，**不需要兼容老数据**，破坏性变更可接受。

所以**不写迁移逻辑**，部署时手工清一次：

```bash
# 部署新 roomd 之前（或之后）执行一次
ssh root@<host> 'rm -f /opt/iroh/roomd/data/history/*.jsonl'
# ⚠️ 绝不动 identity.key —— 丢了 EndpointId 就变，前端配置要跟着改
```

新代码启动时检测到库不存在就建表，**空库开始**。

> 好处：省掉一整块"读 jsonl → 写 SQLite → 校验"的代码与它的出错面。
> 这属于**一次性的开发期便利**；将来若真需要迁移，再单独写工具。

### 4.7 前端：**不改**

用户确认页大小保持 **50**（当前值）。前端零改动。

---

## 五、实施顺序（每步都可独立验证）

| 步 | 做什么 | 验证 |
|---|---|---|
| 1 | 加依赖 + `HistoryStore` 双实现骨架（wasm 仍走内存） | `cargo check --locked` 两个 target 都过 |
| 2 | 实现 SQLite 的 `append` / `recent_before_bounded` / `count` | 单元测试（新增，覆盖分页边界、游标、字节预算） |
| 3 | 实现保留策略 | 单元测试：插入超量后确认裁到保留数 |
| 4 | 删旧数据（一次性） | 部署前 `rm data/history/*.jsonl`，**保留 identity.key** |
| 5 | 部署 roomd + 观察 | 走 `deploy/roomd/README.md` 流程 + **验证容器内二进制**；线上跑回归 |

**注意**：roomd 的部署仍需走 `deploy/roomd/README.md` 的流程
（`docker compose up -d --build` + **验证容器内二进制**）。

---

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| **wasm 产物被污染**（体积暴增或编译失败） | SQLite 全部 `#[cfg(not(wasm32))]`；**构建后必须对比 wasm 体积**（当前 3.78 MB） |
| 旧数据被误删 | 本次是**有意删除**（开发阶段）；仍建议删前 `cp` 一份到 `/tmp` 兜底 |
| roomd 镜像变大 | bundled SQLite 会增加几百 KB；镜像已经是 ~80 MB（debian-slim），可接受 |
| 删旧数据后历史为空 | 符合预期（开发阶段）；新消息会立即开始入库 |
| 二进制大小 | 当前 7.3 MB，预计 +0.5~1 MB |
| 我改的和你未提交的改动冲突 | 你手上有未提交的 `timeline.js` / `main.js` / `scripts/e2e/message-ownership.mjs`；**先提交或明确我能否覆盖 `timeline.js`** |

---

## 七、已确认的决策

| 问题 | 决定 |
|---|---|
| 保留条数 | **100,000 条/房间**（33.47 MiB/房间，100 房间 ≈ 3.27 GiB 磁盘） |
| 页大小 | **保持 50，不改**（前端零改动） |
| 改动归属 | 手上未提交的改动已代提交为 `494b4e7` |
| 旧数据 | **直接删除，不迁移**（开发阶段，破坏性变更可接受） |

---

## 附：改造后能顺带做的事（现在做不到）

- 历史条数/未读数等运维指标（`SELECT count(*)`）
- 按时间范围清理（`DELETE WHERE ts < ?`）
- 将来要加全文搜索，SQLite 的 FTS5 直接可用
- 真并发读（WAL），不再被一把全局锁串起来
