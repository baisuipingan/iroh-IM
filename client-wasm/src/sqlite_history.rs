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

use crate::room::{ChatMessage, MAX_HISTORY_LINE_BYTES};
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

        let rooms = conn
            .prepare("SELECT DISTINCT room FROM messages")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut history = Self {
            conn,
            since_trim: HashMap::new(),
        };
        for room in rooms {
            history.trim(&room)?;
        }
        Ok(history)
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
            params![room, sql_timestamp(msg.ts)?, msg.id, encoded],
        )?;
        if affected == 0 {
            return Ok(false);
        }

        let counter = self.since_trim.entry(room.to_string()).or_insert(0);
        *counter += 1;
        if *counter >= TRIM_INTERVAL {
            if let Err(e) = self.trim(room) {
                // 裁剪失败不该影响写入本身（历史只是"多留点"）
                warn!("裁剪房间 {room} 的历史失败：{e}");
            } else {
                self.since_trim.insert(room.to_string(), 0);
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
            "DELETE FROM messages WHERE room = ?1 AND (ts, id) <= (?2, ?3)",
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
        self.recent_before_bounded(room, before, limit, usize::MAX)
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
        let cursor = before
            .map(|(timestamp, id)| sql_timestamp(timestamp).map(|timestamp| (timestamp, id)))
            .transpose()?;
        if limit == 0 {
            return Ok(Vec::new());
        }
        let sql_limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let mut statement = if cursor.is_some() {
            self.conn.prepare_cached(
                "SELECT json FROM messages WHERE room = ?1 AND (ts, id) < (?2, ?3)
                 ORDER BY ts DESC, id DESC LIMIT ?4",
            )?
        } else {
            self.conn.prepare_cached(
                "SELECT json FROM messages WHERE room = ?1
                 ORDER BY ts DESC, id DESC LIMIT ?2",
            )?
        };
        let mut rows = match cursor {
            Some((timestamp, id)) => statement.query(params![room, timestamp, id, sql_limit])?,
            None => statement.query(params![room, sql_limit])?,
        };
        let mut selected = Vec::new();
        let mut used_bytes = 0usize;
        while let Some(row) = rows.next()? {
            let encoded = row.get_ref(0)?.as_blob()?;
            if encoded.len() > MAX_HISTORY_LINE_BYTES {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Blob,
                    "历史记录超过消息大小上限".into(),
                ));
            }
            let bytes = encoded.len().saturating_add(1);
            if !selected.is_empty() && used_bytes.saturating_add(bytes) > max_bytes {
                break;
            }
            let message = serde_json::from_slice(encoded).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Blob,
                    Box::new(error),
                )
            })?;
            used_bytes = used_bytes.saturating_add(bytes);
            selected.push(message);
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

fn sql_timestamp(timestamp: u64) -> rusqlite::Result<i64> {
    i64::try_from(timestamp)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}
