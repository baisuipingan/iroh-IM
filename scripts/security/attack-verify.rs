//! 用**报告原来的攻击代码**验证修复是否生效。
//!
//! 每一段都对照 /tmp/iroh-review-native.rs 的原始攻击：
//! 原来 `assert!` 的是"攻击成功"，这里 `assert!` 的是"攻击被挡住"。

use iroh::SecretKey;

/// v4：签名载荷绑定房间，测试统一用这个房间名
const ROOM: &str = "attack-room";
use iroh_web::filetransfer::{CtrlBody, FileCtrl, FileMeta, SignedCtrl};
use iroh_web::room::{ChatMessage, HistoryStore};

fn message(key: &SecretKey, nickname: &str, text: &str, ts: u64, room: &str) -> ChatMessage {
    ChatMessage {
        id: String::new(),
        from: key.public().to_string(),
        nickname: nickname.to_string(),
        text: text.to_string(),
        ts,
        sig: String::new(),
        file: None,
    }
    .sign(key, room)
}

fn main() {
    let author = SecretKey::generate();
    let mut pass = 0;
    let mut fail = 0;
    macro_rules! check {
        ($name:expr, $cond:expr) => {
            if $cond { pass += 1; println!("  ✅ {}", $name); }
            else { fail += 1; println!("  ❌ {}", $name); }
        };
    }

    // ── 攻击 1：改昵称+正文，签名仍然有效（分隔符歧义）──────────────
    println!("\n【攻击 1】分隔符歧义：昵称 Alice + 正文 A|B → 昵称 Alice|A + 正文 B");
    let original = message(&author, "Alice", "A|B", 123, ROOM);
    check!("原始消息本身验签通过", original.verify(ROOM));
    let mut modified = original.clone();
    modified.nickname = "Alice|A".to_string();
    modified.text = "B".to_string();
    check!("规范化串**不再相同**（歧义已消除）", original.canonical(ROOM) != modified.canonical(ROOM));
    check!("改过的消息**验签失败**（攻击被挡住）", !modified.verify(ROOM));

    // ── 攻击 2：改 id 重放 ────────────────────────────────────────
    println!("\n【攻击 2】改 id 重放：同一条签名消息换个 id 塞两次");
    let mut cloned = original.clone();
    cloned.id = "replacement-id".to_string();
    check!("改 id 后**验签失败**", !cloned.verify(ROOM));
    let memory = HistoryStore::new(None);
    memory.append(ROOM, original.clone());
    memory.append(ROOM, cloned);
    check!("历史里只有 1 条（重放被去重挡下）", memory.count(ROOM) == 1);

    // ── 攻击 3：房间名落盘冲突 ────────────────────────────────────
    println!("\n【攻击 3】房间名映射不可逆：team_a / 研发群 / 产品群 是否互相混");
    let root = std::path::PathBuf::from(format!("/tmp/iroh-attack-verify-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    {
        let persisted = HistoryStore::new(Some(root.clone()));
        persisted.append("team_a", message(&author, "Alice", "underscore-only", 1, "team_a"));
        persisted.append("研发群", message(&author, "Alice", "engineering-only", 2, "研发群"));
        persisted.append("产品群", message(&author, "Alice", "product-only", 3, "产品群"));
    }
    let loaded = HistoryStore::new(Some(root.clone()));
    loaded.load_from_disk();
    check!("team_a 的历史**还在自己房里**（没被改成 team-a）", loaded.count("team_a") == 1);
    check!("不存在伪造的 team-a 房间", loaded.count("team-a") == 0);
    check!("研发群 的历史在自己的房里", loaded.count("研发群") == 1);
    check!("产品群 的历史在自己的房里", loaded.count("产品群") == 1);
    check!("不存在混合房间 ---", loaded.count("---") == 0);
    let _ = std::fs::remove_dir_all(&root);

    // ── 攻击 4：Invite 的 sender 与 ts 被改 ───────────────────────
    println!("\n【攻击 4】改邀约里的 sender —— 数据流授权完全建立在这上面");
    let metadata = FileMeta {
        file_id: "file-id".to_string(),
        name: "file.bin".to_string(),
        size: 8,
        mime: "application/octet-stream".to_string(),
        chunk_size: 4,
        root_hash: "expected-hash".to_string(),
        sender: author.public().to_string(),
        sender_relay: "https://relay.invalid".to_string(),
        ts: 1,
    };
    let mut control = SignedCtrl::sign(&author, &FileCtrl::Invite(metadata), 1, ROOM);
    check!("原始邀约验签通过", control.verify(ROOM).is_some());
    if let CtrlBody::Invite(m) = &mut control.body {
        m.sender = SecretKey::generate().public().to_string();
        m.ts = 999_999;
    }
    check!("改 sender / ts 后**验签失败**（攻击被挡住）", control.verify(ROOM).is_none());

    // ── 攻击 5：同一毫秒 51 条消息翻页漏最后一条 ──────────────────
    println!("\n【攻击 5】同一毫秒 51 条消息，翻页是否会漏掉第 51 条");
    let paged = HistoryStore::new(None);
    for index in 0..51u32 {
        paged.append(
            "burst",
            message(&author, "Alice", &format!("burst-{index}"), 123, "burst"),
        );
    }
    let latest = paged.recent_before("burst", None, 50);
    check!("首页拿到 50 条", latest.len() == 50);
    let oldest = latest.first().expect("首页不该为空");
    // 新游标是 (ts, id)；改用复合游标继续翻
    let cursor = (oldest.ts, oldest.id.clone());
    let next = paged.recent_before("burst", Some(cursor), 50);
    check!("用 (ts,id) 游标翻页能拿到剩下的 1 条（不再漏）", next.len() == 1);

    // ── 攻击 6：Presence 文件清单分隔符歧义 ───────────────────────
    println!("\n【攻击 6】心跳里的文件清单：[\"x,y\"] 与 [\"x\",\"y\"] 是否同一载荷");
    use iroh_web::room::Presence;
    let a = Presence::signed(&author, "n", vec!["x,y".into()], 1, ROOM);
    let b = Presence::signed(&author, "n", vec!["x".into(), "y".into()], 1, ROOM);
    check!("两种清单的规范化串**不同**", a.canonical(ROOM) != b.canonical(ROOM));

    // ── 攻击 7：改 Leave / FileQuery 字段 ─────────────────────────
    println!("\n【攻击 7】改离开声明 / 可用性质询的字段");
    use iroh_web::room::{FileQuery, LeaveMsg};
    let leave = LeaveMsg::signed(&author, ROOM);
    let mut l = leave.clone();
    l.ts += 1;
    check!("改 Leave.ts 后**验签失败**", !l.verify(ROOM));
    let q = FileQuery::signed(&author, "fid", "want", ROOM);
    let mut qq = q.clone();
    qq.want = "someone-else".into();
    check!("改 FileQuery.want 后**验签失败**", !qq.verify(ROOM));

    println!("\n总计 PASS={pass} FAIL={fail}");
    if fail > 0 { std::process::exit(1); }
}
