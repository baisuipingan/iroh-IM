#![cfg(all(feature = "cli", not(target_arch = "wasm32")))]

use iroh::SecretKey;
use iroh_web::room::ChatMessage;
use iroh_web::sqlite_history::SqliteHistory;
use rusqlite::{params, Connection};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct MeasuredAllocator;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn add_bytes(size: usize) {
    let current = LIVE.fetch_add(size, Ordering::Relaxed) + size;
    PEAK.fetch_max(current, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for MeasuredAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = System.alloc(layout);
        if !pointer.is_null() { add_bytes(layout.size()); }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        System.dealloc(pointer, layout);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let result = System.realloc(pointer, layout, size);
        if !result.is_null() {
            if size >= layout.size() { add_bytes(size - layout.size()); }
            else { LIVE.fetch_sub(layout.size() - size, Ordering::Relaxed); }
        }
        result
    }
}

#[global_allocator]
static ALLOCATOR: MeasuredAllocator = MeasuredAllocator;

#[test]
fn sqlite_page_heap_is_bounded_before_deserialization() {
    let directory = std::env::temp_dir().join(format!("iroh-budget-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("history.db");
    let database = SqliteHistory::open(&path).unwrap();
    let mut connection = Connection::open(&path).unwrap();
    let transaction = connection.transaction().unwrap();
    let key = SecretKey::generate();
    for index in 0..256u64 {
        let entry = ChatMessage {
            id: String::new(), from: key.public().to_string(), nickname: "test".into(),
            text: "x".repeat(400 * 1024), ts: index, sig: String::new(), file: None,
        }.sign(&key, "large");
        transaction.execute("INSERT INTO messages VALUES(?1,?2,?3,?4)",
            params!["large", index as i64, entry.id, serde_json::to_vec(&entry).unwrap()],
        ).unwrap();
    }
    transaction.commit().unwrap();
    drop(connection);
    for limit in [1, 50] {
        let baseline = LIVE.load(Ordering::Relaxed);
        PEAK.store(baseline, Ordering::Relaxed);
        let page = database.recent_before_bounded("large", None, limit, 1024 * 1024).unwrap();
        let extra = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
        println!("limit={limit}, Rust heap peak extra={extra} bytes");
        assert_eq!(page.len(), if limit == 1 { 1 } else { 2 });
        assert!(extra < 3 * 1024 * 1024, "allocated {extra} bytes");
        assert_eq!(page.last().unwrap().ts, 255);
    }
    drop(database);
    std::fs::remove_dir_all(directory).unwrap();
}
