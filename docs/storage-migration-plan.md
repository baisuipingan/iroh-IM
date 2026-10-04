# 改造方案：历史存储从手写 jsonl 换成 SQLite

> 状态：**待确认**（未开工）
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
4. **默认页大小 50 → 20**（用户要求）
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
pub const HISTORY_RETAIN_PER_ROOM: usize = 50_000;
```

```sql
DELETE FROM messages
WHERE room = ?1
  AND (ts, id) NOT IN (
    SELECT ts, id FROM messages WHERE room = ?1 ORDER BY ts DESC, id DESC LIMIT ?2
  );
```

⚠️ 保留 5 万条 × 351 字节 ≈ **17 MB/房间**。100 个房间 ≈ **1.7 GB 磁盘** ——
比现在"无上限增长"可控得多。这个数**可以调**，建议先按 5 万条上线观察。

### 4.6 数据迁移（自动，无需停机）

`load_from_disk()` 里做一次性迁移：

```
发现 history.db 不存在
  且 history/*.jsonl 存在
  → 建表 → 逐个 jsonl 读入 → 批量插入（一个事务）
  → 迁移完成后把 *.jsonl 改名为 *.jsonl.migrated（保留，不删）
  → 记录日志："已从 164 个 jsonl 迁移 N 条消息"
```

**要点**：
- **不删原文件**（改名保留），出问题可回退
- 迁移在**一个事务**里完成（快，且原子）
- 空库 + 无 jsonl → 直接建表，什么都不做
- 现有数据只有 **243 KB / 767 条**，迁移是**毫秒级**

### 4.7 前端（1 个常量）

```js
// frontend/js/ui/timeline.js
const PAGE = 50;   →   const PAGE = 20;
```

⚠️ 改完要跑 `scripts/e2e/run.sh`：有几个用例可能依赖"一页能装下 50 条"
（例如 `file-history` 在测试里断言过历史条数），需要核对。

---

## 五、实施顺序（每步都可独立验证）

| 步 | 做什么 | 验证 |
|---|---|---|
| 1 | 加依赖 + `HistoryStore` 双实现骨架（wasm 仍走内存） | `cargo check --locked` 两个 target 都过 |
| 2 | 实现 SQLite 的 `append` / `recent_before_bounded` / `count` | 单元测试（新增，覆盖分页边界、游标、字节预算） |
| 3 | 实现保留策略 | 单元测试：插入超量后确认裁到保留数 |
| 4 | 实现自动迁移 | 用现有 164 个 jsonl 做真实迁移测试 |
| 5 | 页大小 50 → 20 | `bash scripts/e2e/run.sh`（全部 13 个用例） |
| 6 | 部署 roomd + 观察 | 线上回归 + `docker logs` 看迁移日志 |

**注意**：roomd 的部署仍需走 `deploy/roomd/README.md` 的流程
（`docker compose up -d --build` + **验证容器内二进制**）。

---

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| **wasm 产物被污染**（体积暴增或编译失败） | SQLite 全部 `#[cfg(not(wasm32))]`；**构建后必须对比 wasm 体积**（当前 3.78 MB） |
| 迁移出错导致历史丢失 | 原 `.jsonl` **只改名不删除**；迁移单事务；先在**本地**用真实数据演练 |
| 页大小改 20 影响既有 e2e | 先跑一遍全量 e2e，逐个核对失败的用例 |
| roomd 镜像变大 | bundled SQLite 会增加几百 KB；镜像已经是 ~80 MB（debian-slim），可接受 |
| 二进制大小 | 当前 7.3 MB，预计 +0.5~1 MB |
| 我改的和你未提交的改动冲突 | 你手上有未提交的 `timeline.js` / `main.js` / `scripts/e2e/message-ownership.mjs`；**先提交或明确我能否覆盖 `timeline.js`** |

---

## 七、需要你确认的四件事

1. **保留策略取多少条？** 我建议 **5 万条/房间**（≈17 MB）。
   100 个房间 ≈ 1.7 GB。可以调。
2. **页大小 20 还是 50？** 你说过要 20（"默认加载20条，下拉刷新"）——
   但**现在已经是分页的**（50/页），改 20 只是把每页变小。确认要走 20？
3. **你手上未提交的改动怎么办？**
   我有 `timeline.js`（页大小在那儿）和 `main.js` 的冲突风险。
   建议你先提交，或者告诉我能否直接改。
4. **旧 jsonl 迁移后怎么处理？** 我建议**改名保留**（`*.jsonl.migrated`），
   不自动删除。确认？

---

## 附：改造后能顺带做的事（现在做不到）

- 历史条数/未读数等运维指标（`SELECT count(*)`）
- 按时间范围清理（`DELETE WHERE ts < ?`）
- 将来要加全文搜索，SQLite 的 FTS5 直接可用
- 真并发读（WAL），不再被一把全局锁串起来
