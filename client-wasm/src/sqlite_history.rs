//! 历史存储的 SQLite 后端（**仅原生** roomd 使用）。
//!
//! ## 为什么换掉手写 jsonl
//!
//! 原来是「磁盘 `.jsonl` 只追加 + 启动时全读进内存 + 分页从内存切片」。
//! 由此有三个**真实缺陷**（不是风格问题）：
//!
//! 1. **内存上限 = 可读上限**：内存只留 16 MiB，磁盘写到 64 MiB 才压缩，
//!    中间那约 48 MiB **永久拉不到、且不报错** —— 用户看到"历史断了一截"。
//! 2. **每次请求 clone 整份列表**：历史越长，单次请求越贵。
//! 3. **磁盘无上限增长**：只追加、从不清理。
//!
//! 根因是"**没有索引**"，不是"用了文件"。换 SQLite 之后：
//!
//! - 分页走主键索引（`(room, ts, id)` 聚簇），**只读取这一页**
//! - 保留策略是一条 `DELETE`，磁盘有明确上限
//! - 内存不再需要装下全部历史
//!
//! ## 为什么消息存整条 JSON 而不是拆字段
//!
//! 拆字段意味着"**表结构 = 协议结构**" —— 以后协议一改就要改表，
//! v3→v4 那次破坏性变更就是这么踩的坑。这里把查询需要的
//! `room / ts / id` 提出来做索引，消息本体整条存 JSON：
//! **既是真索引，又不与协议耦合。**

use crate::room::{serialized_message_bytes, ChatMessage, MAX_HISTORY_LINE_BYTES};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use tracing::{debug, warn};

/// 每个房间保留的最近消息数。
///
/// ⚠️ 与旧的 `MAX_MEM_HISTORY` / `MAX_MEM_HISTORY_BYTES` 有本质区别：
/// 那两个是**内存**上限（超了就取不出来），这个是**磁盘**保留策略
/// （超了就删最旧的，删之前一直可查）。
///
/// 10 万条 × 实测平均 351 字节 ≈ **33.5 MiB/房间**；
/// 100 个房间 ≈ 3.3 GiB 磁盘。
pub const HISTORY_RETAIN_PER_ROOM: usize = 100_000;

/// 每积累这么多条写入，才做一次保留裁剪。
///
/// 每条消息都跑一次 `DELETE` 太浪费（且要扫索引），攒一批再删。
/// 代价是最坏情况下房间会短暂超出保留数 `TRIM_INTERVAL` 条 —— 可接受。
const TRIM_INTERVAL: usize = 1_000;

/// 带字节预算分页时的单批条数。
const BYTES_SCAN_BATCH: usize = 256;

pub struct SqliteHistory {
    conn: Connection,
    /// 自上次裁剪以来累计写入条数（按房间）
    since_trim: HashMap<String, usize>,
}

impl SqliteHistory {
    /// 打开（必要时创建）数据库并建表。
    pub fn open(path: &std::path::Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;

        // WAL：读不挡写、写不挡读。
        // `synchronous=NORMAL` 是 WAL 下的常规选择：崩溃最多丢最后几个事务，
        // 但不会损坏库 —— 对聊天历史足够。
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS messages (
              room TEXT    NOT NULL,
              ts   INTEGER NOT NULL,
              id   TEXT    NOT NULL,
              json BLOB    NOT NULL,
              PRIMARY KEY (room, ts, id)
            ) WITHOUT ROWID;
            "#,
        )?;

        Ok(Self {
            conn,
            since_trim: HashMap::new(),
        })
    }

    /// 追加一条（**已验签**的）消息。返回是否真的写入了（重复消息返回 false）。
    ///
    /// ⚠️ 调用方必须先验签 —— 这里的 `INSERT OR IGNORE` 只管去重，
    /// 不管消息是否可信。兜底验签在 `HistoryStore::append` 里。
    pub fn append(
        &mut self,
        room: &str,
        msg: &ChatMessage,
        encoded: &[u8],
    ) -> rusqlite::Result<bool> {
        // 主键是 `(room, ts, id)`，`INSERT OR IGNORE` 天然去重。
        // 旧实现在内存里线性扫 `list.iter().any(|m| m.id == msg.id)`，
        // 这里是索引查找，且不再需要那个扫描。
        let affected = self.conn.execute(
            "INSERT OR IGNORE INTO messages (room, ts, id, json) VALUES (?1, ?2, ?3, ?4)",
            params![room, msg.ts as i64, msg.id, encoded],
        )?;
        if affected == 0 {
            return Ok(false);
        }

        let counter = self.since_trim.entry(room.to_string()).or_insert(0);
        *counter += 1;
        if *counter >= TRIM_INTERVAL {
            *counter = 0;
            if let Err(e) = self.trim(room) {
                // 裁剪失败不该影响写入本身（历史只是"多留点"）
                warn!("裁剪房间 {room} 的历史失败：{e}");
            }
        }
        Ok(true)
    }

    /// 裁掉超出保留数的最旧消息，返回删掉的条数。
    ///
    /// ⚠️ 不要写 `DELETE ... WHERE (ts,id) NOT IN (SELECT ...)` ——
    /// 在大表上 SQLite 要**物化整份子查询**，很慢。
    /// 这里先用 `LIMIT 1 OFFSET N` 找到"保留区间"的下界，再按它做
    /// **主键范围删除**，两步都走索引。
    pub fn trim(&mut self, room: &str) -> rusqlite::Result<usize> {
        let boundary: Option<(i64, String)> = self
            .conn
            .query_row(
                "SELECT ts, id FROM messages WHERE room = ?1
                 ORDER BY ts DESC, id DESC LIMIT 1 OFFSET ?2",
                params![room, HISTORY_RETAIN_PER_ROOM as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        // 没有"第 N+1 条" → 还没超，不用删
        let Some((bts, bid)) = boundary else {
            return Ok(0);
        };

        let deleted = self.conn.execute(
            "DELETE FROM messages WHERE room = ?1 AND (ts, id) < (?2, ?3)",
            params![room, bts, bid],
        )?;
        if deleted > 0 {
            debug!(
                "房间 {room} 超过保留数 {HISTORY_RETAIN_PER_ROOM}，裁掉 {deleted} 条最旧消息"
            );
        }
        Ok(deleted)
    }

    /// 取 `before` 之前（不含）的最近 `limit` 条，返回**正序**（旧→新）。
    ///
    /// 游标是 `(ts, id)` 复合键（与表主键同序），所以走索引范围扫描。
    pub fn recent_before(
        &self,
        room: &str,
        before: Option<(u64, String)>,
        limit: usize,
    ) -> rusqlite::Result<Vec<ChatMessage>> {
        let mut out = Vec::new();
        if let Some((bts, bid)) = before {
            let mut stmt = self.conn.prepare_cached(
                "SELECT json FROM messages
                 WHERE room = ?1 AND (ts, id) < (?2, ?3)
                 ORDER BY ts DESC, id DESC LIMIT ?4",
            )?;
            let rows = stmt.query_map(params![room, bts as i64, bid, limit as i64], |row| {
                row.get::<_, Vec<u8>>(0)
            })?;
            for r in rows {
                if let Ok(m) = serde_json::from_slice::<ChatMessage>(&r?) {
                    out.push(m);
                }
            }
        } else {
            let mut stmt = self.conn.prepare_cached(
                "SELECT json FROM messages WHERE room = ?1
                 ORDER BY ts DESC, id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![room, limit as i64], |row| {
                row.get::<_, Vec<u8>>(0)
            })?;
            for r in rows {
                if let Ok(m) = serde_json::from_slice::<ChatMessage>(&r?) {
                    out.push(m);
                }
            }
        }
        out.reverse(); // 数据库给的是新→旧，翻成正序
        Ok(out)
    }

    /// 带字节预算的分页。
    ///
    /// ⚠️ 为什么不能只按条数限制：单条消息最大 `MAX_MESSAGE_SIZE` = 512 KB，
    /// 1000 条最坏 ≈ 512 MB，而收发两端的 `read_all` 在 8 MB 就报错。
    /// 所以必须在服务端就按字节截断。
    pub fn recent_before_bounded(
        &self,
        room: &str,
        before: Option<(u64, String)>,
        limit: usize,
        max_bytes: usize,
    ) -> rusqlite::Result<Vec<ChatMessage>> {
        let mut selected: Vec<ChatMessage> = Vec::new();
        let mut used_bytes = 0usize;
        let mut cursor = before;

        // 分批向数据库要，边取边算字节，够了就停。
        'outer: loop {
            let page = self.recent_before(room, cursor.clone(), BYTES_SCAN_BATCH)?;
            if page.is_empty() {
                break;
            }
            // page 是正序（旧→新）；要从新往旧累加，所以反向遍历
            for msg in page.iter().rev() {
                if selected.len() >= limit {
                    break 'outer;
                }
                let bytes = serialized_message_bytes(msg);
                // 至少留一条：否则一条超大消息就能让整页为空，翻页永远卡住
                if !selected.is_empty() && used_bytes.saturating_add(bytes) > max_bytes {
                    break 'outer;
                }
                used_bytes = used_bytes.saturating_add(bytes);
                selected.push(msg.clone());
            }
            // 下一页的游标 = 本页最旧那条
            let oldest = page.first().expect("page 非空");
            let next = (oldest.ts, oldest.id.clone());
            if cursor.as_ref() == Some(&next) {
                break; // 防御：游标没前进就别死循环
            }
            cursor = Some(next);
            if page.len() < BYTES_SCAN_BATCH {
                break;
            }
        }

        selected.reverse();
        Ok(selected)
    }

    pub fn count(&self, room: &str) -> rusqlite::Result<usize> {
        let n: i64 = self.conn.query_row(
            "SELECT count(*) FROM messages WHERE room = ?1",
            params![room],
            |row| row.get(0),
        )?;
        Ok(n as usize)
    }
}

/// 让 `MAX_HISTORY_LINE_BYTES` 在这个模块里可见（供编译期断言/文档用）。
#[allow(dead_code)]
const _MAX_LINE: usize = MAX_HISTORY_LINE_BYTES;
