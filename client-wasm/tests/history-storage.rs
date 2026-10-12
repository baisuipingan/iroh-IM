#![cfg(all(feature = "cli", not(target_arch = "wasm32")))]

use iroh::SecretKey;
use iroh_web::room::{ChatMessage, HistoryStore};
use iroh_web::sqlite_history::{SqliteHistory, HISTORY_RETAIN_PER_ROOM};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "iroh-history-tests-{}-{}",
            std::process::id(), NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn database(&self) -> PathBuf {
        self.0.join("history.db")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn message(key: &SecretKey, room: &str, timestamp: u64, text: String) -> ChatMessage {
    ChatMessage {
        id: String::new(), from: key.public().to_string(), nickname: "test".into(),
        text, ts: timestamp, sig: String::new(), file: None,
    }.sign(key, room)
}

fn seed(directory: &TestDirectory, room: &str, count: usize) {
    Connection::open(directory.database()).unwrap().execute(
        "WITH RECURSIVE sequence(number) AS
         (SELECT 1 UNION ALL SELECT number+1 FROM sequence WHERE number < ?2)
         INSERT INTO messages(room,ts,id,json)
         SELECT ?1,number,printf('seed-%06d',number),X'7B7D' FROM sequence",
        params![room, count as i64],
    ).unwrap();
}

#[test]
fn trim_removes_the_boundary_and_keeps_other_rooms() {
    let directory = TestDirectory::new();
    let mut database = SqliteHistory::open(&directory.database()).unwrap();
    seed(&directory, "large", HISTORY_RETAIN_PER_ROOM + 1);
    seed(&directory, "other", 2);
    assert_eq!(database.trim("large").unwrap(), 1);
    assert_eq!(database.count("large").unwrap(), HISTORY_RETAIN_PER_ROOM);
    assert_eq!(database.count("other").unwrap(), 2);
    let oldest: i64 = Connection::open(directory.database()).unwrap()
        .query_row("SELECT MIN(ts) FROM messages WHERE room='large'", [], |row| row.get(0)).unwrap();
    assert_eq!(oldest, 2);
}

#[test]
fn retention_survives_restarts_before_the_trim_interval() {
    let directory = TestDirectory::new();
    drop(SqliteHistory::open(&directory.database()).unwrap());
    seed(&directory, "restart", HISTORY_RETAIN_PER_ROOM);
    let key = SecretKey::generate();
    for cycle in 0..3u64 {
        let mut database = SqliteHistory::open(&directory.database()).unwrap();
        assert_eq!(database.count("restart").unwrap(), HISTORY_RETAIN_PER_ROOM);
        for index in 0..999u64 {
            let entry = message(&key, "restart", 200_000 + cycle * 999 + index, format!("{cycle}-{index}"));
            database.append("restart", &entry, &serde_json::to_vec(&entry).unwrap()).unwrap();
        }
        assert_eq!(database.count("restart").unwrap(), HISTORY_RETAIN_PER_ROOM + 999);
    }
    let database = SqliteHistory::open(&directory.database()).unwrap();
    assert_eq!(database.count("restart").unwrap(), HISTORY_RETAIN_PER_ROOM);
}

#[test]
fn periodic_trim_keeps_exactly_the_latest_records() {
    let directory = TestDirectory::new();
    let mut database = SqliteHistory::open(&directory.database()).unwrap();
    seed(&directory, "periodic", HISTORY_RETAIN_PER_ROOM);
    let key = SecretKey::generate();
    for index in 0..1000u64 {
        let entry = message(&key, "periodic", 200_000 + index, index.to_string());
        database.append("periodic", &entry, &serde_json::to_vec(&entry).unwrap()).unwrap();
    }
    assert_eq!(database.count("periodic").unwrap(), HISTORY_RETAIN_PER_ROOM);
    let oldest: i64 = Connection::open(directory.database()).unwrap()
        .query_row("SELECT MIN(ts) FROM messages WHERE room='periodic'", [], |row| row.get(0)).unwrap();
    assert_eq!(oldest, 1001);
}

#[test]
fn invalid_database_is_an_initialization_error() {
    let directory = TestDirectory::new();
    std::fs::write(directory.database(), "not a database").unwrap();
    assert!(HistoryStore::new(Some(directory.0.clone())).is_err());
    let roomd_history = directory.0.join("history");
    std::fs::create_dir_all(&roomd_history).unwrap();
    std::fs::write(roomd_history.join("history.db"), "not a database").unwrap();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_roomd"))
        .env("ROOMD_DATA_DIR", &directory.0)
        .env("ROOMD_RELAYS", "https://127.0.0.1:9")
        .env("ROOMD_ROOMS", "test")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("roomd 没有在数据库初始化失败后退出");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("打开历史数据库失败"));
}

#[test]
fn database_errors_are_not_empty_pages_and_queries_can_recover() {
    let directory = TestDirectory::new();
    let store = HistoryStore::new(Some(directory.0.clone())).unwrap();
    let key = SecretKey::generate();
    let entry = message(&key, "query", 1, "saved".into());
    assert!(store.append("query", entry.clone()));
    let connection = Connection::open(directory.database()).unwrap();
    connection.execute("UPDATE messages SET json=?1", params![b"bad JSON".as_slice()]).unwrap();
    assert!(store.recent_before_bounded("query", None, 50, 1024 * 1024).is_err());
    connection.execute("UPDATE messages SET json=?1", params![serde_json::to_vec(&entry).unwrap()]).unwrap();
    assert_eq!(store.recent("query", 50).unwrap(), vec![entry]);
    connection.execute_batch("DROP TABLE messages").unwrap();
    assert!(store.recent("query", 50).is_err());
    assert!(store.count("query").is_err());
    connection.execute_batch(
        "CREATE TABLE messages (room TEXT NOT NULL,ts INTEGER NOT NULL,id TEXT NOT NULL,json BLOB NOT NULL,PRIMARY KEY(room,ts,id)) WITHOUT ROWID",
    ).unwrap();
    assert!(store.recent("query", 50).unwrap().is_empty());
}

#[test]
fn timestamp_range_is_checked_for_messages_and_cursors() {
    let directory = TestDirectory::new();
    let store = HistoryStore::new(Some(directory.0.clone())).unwrap();
    let key = SecretKey::generate();
    let invalid = message(&key, "timestamp", i64::MAX as u64 + 1, "invalid".into());
    assert!(!invalid.verify("timestamp"));
    assert!(!store.append("timestamp", invalid.clone()));
    let mut database = SqliteHistory::open(&directory.database()).unwrap();
    assert!(database.append("timestamp", &invalid, &serde_json::to_vec(&invalid).unwrap()).is_err());
    for timestamp in [1, i64::MAX as u64] {
        assert!(store.append("timestamp", message(&key, "timestamp", timestamp, timestamp.to_string())));
    }
    let page = store.recent("timestamp", 50).unwrap();
    assert_eq!(page.iter().map(|entry| entry.ts).collect::<Vec<_>>(), [1, i64::MAX as u64]);
    assert!(store.recent_before("timestamp", Some((u64::MAX, "id".into())), 50).is_err());
    assert!(database.recent_before("timestamp", Some((u64::MAX, "id".into())), 50).is_err());
}

#[test]
fn byte_budget_pages_cover_equal_timestamps_without_duplicates() {
    let directory = TestDirectory::new();
    let mut database = SqliteHistory::open(&directory.database()).unwrap();
    let key = SecretKey::generate();
    let mut expected = Vec::new();
    for index in 0..300 {
        let entry = message(&key, "paging", 42, index.to_string());
        expected.push(entry.id.clone());
        database.append("paging", &entry, &serde_json::to_vec(&entry).unwrap()).unwrap();
    }
    let mut cursor = None;
    let mut received = Vec::new();
    loop {
        let page = database.recent_before_bounded("paging", cursor, 37, 1400).unwrap();
        if page.is_empty() { break; }
        assert!(page.len() <= 37);
        assert!(page.iter().map(|entry| serde_json::to_vec(entry).unwrap().len() + 1).sum::<usize>() <= 1400);
        cursor = Some((page[0].ts, page[0].id.clone()));
        received.extend(page.into_iter().map(|entry| entry.id));
    }
    expected.sort();
    received.sort();
    assert_eq!(received, expected);
    assert!(database.recent_before_bounded("paging", None, 0, 1).unwrap().is_empty());
    assert_eq!(database.recent_before_bounded("paging", None, 50, 1).unwrap().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn locked_database_does_not_block_async_timers() {
    let directory = TestDirectory::new();
    let store = HistoryStore::new(Some(directory.0.clone())).unwrap();
    let path = directory.database();
    let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let connection = Connection::open(path).unwrap();
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        ready_sender.send(()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(250));
        connection.execute_batch("ROLLBACK").unwrap();
    });
    ready_receiver.recv().unwrap();
    let key = SecretKey::generate();
    let started = std::time::Instant::now();
    let (stored, timer_elapsed) = tokio::join!(
        store.append_async("locked".into(), message(&key, "locked", 1, "saved".into())),
        async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            started.elapsed()
        },
    );
    assert!(stored);
    assert!(timer_elapsed < std::time::Duration::from_millis(150), "{timer_elapsed:?}");
    writer.join().unwrap();
}

/// ★ R2b：常驻节点"从历史里挑出名片"是**两层过滤**——
/// `messages_like` 只做粗筛（`LIKE` 匹配 json 文本），真正的判定在 `is_profile_text`
/// （必须是**开头**就是那个前缀）。这条用例把两层都钉住：粗筛可以多，判定不能漏也不能多。
#[test]
fn profile_lookup_is_a_two_stage_filter() {
    let directory = TestDirectory::new();
    let key = SecretKey::generate();
    let mut database = SqliteHistory::open(&directory.database()).unwrap();
    let profile = r#"{"t":"profile","v":1,"bio":"能查代码","tags":["ts"]}"#;

    for (ts, text) in [
        (1u64, "普通消息"),
        (2, profile),
        (3, "又说一句"),
        // ⚠️ 这条**碰巧在正文中间**含那个前缀：`LIKE` 会把它粗筛出来，
        //    但 Rust 侧的前缀判定必须把它挡掉（否则任何引用都能伪造一张名片）
        (4, r#"看这个 {"t":"profile" 是不是很像"#),
    ] {
        let entry = message(&key, "room", ts, text.to_string());
        database.append("room", &entry, &serde_json::to_vec(&entry).unwrap()).unwrap();
    }
    // 别的房间的名片不该被带出来
    let other = message(&key, "other", 5, profile.to_string());
    database.append("other", &other, &serde_json::to_vec(&other).unwrap()).unwrap();

    let coarse = database
        .messages_with_text_prefix("room", iroh_web::room::PROFILE_PREFIX)
        .unwrap();
    // ★ 回归：**不能**用 `CAST(json AS TEXT) LIKE '%{"t":"profile"%'` ——
    //   `text` 在整条消息 JSON 里是被转义的（实际是 `{\"t\":...`），那条 SQL
    //   永远返回空、而且不报错（实测踩到：名片查询一直是空的，没人发现）。
    //   下面这条断言把这个存储格式假设钉住：**如果它不再为 0，说明格式变了**，
    //   得重新审视 `messages_with_text_prefix` 的实现。
    let naive: i64 = Connection::open(directory.database())
        .unwrap()
        .query_row(
            "SELECT count(*) FROM messages WHERE room='room' AND CAST(json AS TEXT) LIKE ?1",
            params![format!("%{}%", iroh_web::room::PROFILE_PREFIX)],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(naive, 0, "存储格式变了：`text` 不再被转义，请重新审视这个查询");
    assert_eq!(coarse.len(), 2, "粗筛会连'碰巧含有前缀'的那条一起捞出来：{coarse:?}");

    let mut folded = iroh_web::room::latest_profiles_from(&coarse);
    folded.retain(|p| !p.bio.is_empty() || !p.tags.is_empty());
    assert_eq!(folded.len(), 1, "判定层必须只留下真名片：{folded:?}");
    assert_eq!(folded[0].bio, "能查代码");
    assert_eq!(folded[0].tags, vec!["ts".to_string()]);
    assert_eq!(folded[0].ts, 2);
}
