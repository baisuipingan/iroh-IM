//! 黄金转录：冻结 `iroh-agent serve` 的对外协议行为（命令 → reply、错误码、事件信封）。
//!
//! 设计要点（都是踩出来的，别改回去）：
//!
//! - **离线运行**：靠 `IROH_AGENT_SERVE_SKIP_ONLINE` 跳过"等中继"（测试钩子），
//!   不碰网络、不依赖线上环境；身份写进临时目录。
//! - **驱动式**：发一条、等到它的 reply 再发下一条。serve 里 join/say/history/leave
//!   都是 spawn 的 —— "一次全灌进 stdin"会让 reply 顺序随机（实测同一个 id 的
//!   reply 与后续命令的 reply 会颠倒），转录必然抖动。
//! - **归一化**：endpointId / 消息 id / ts / seq / relay 状态等易变字段替换成占位符；
//!   `relayStatus` 事件随环境出现、条数不定，整类过滤（它的语义由单测覆盖）。
//! - **比较前排序**：事件与 reply 的先后由两条任务竞争产生，**不是协议契约**；
//!   真正的顺序契约（事件 seq 严格递增）在下面单独断言。
//! - 有意改协议时：`UPDATE_GOLDEN=1 cargo test --offline --locked --no-default-features
//!   --features cli --test daemon-protocol` 重写 fixture，**review diff 后再提交**。
#![cfg(feature = "cli")]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_secs(20);
const IPC_MAX_LINE_BYTES: usize = 1024 * 1024;

/// 子进程守卫：测试失败/panic 时也保证进程被回收。
struct Guard(Child);

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Session {
    child: Guard,
    stdin: ChildStdin,
    rx: Receiver<String>,
    /// 收到过的全部原始行（按到达顺序）
    lines: Vec<String>,
}

impl Session {
    fn next(&mut self, timeout: Duration) -> Option<String> {
        match self.rx.recv_timeout(timeout) {
            Ok(line) => {
                self.lines.push(line.clone());
                Some(line)
            }
            Err(_) => None,
        }
    }

    /// 读到第一个满足 `pred` 的行；沿途的行照样进 `lines`。
    fn wait_line<F: Fn(&Value) -> bool>(&mut self, pred: F, what: &str) -> Value {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let remain = deadline.saturating_duration_since(Instant::now());
            let Some(line) = self.next(remain) else {
                panic!(
                    "等待 {what} 超时；已收到 {} 行：\n{}",
                    self.lines.len(),
                    self.lines.join("\n")
                );
            };
            let value: Value = serde_json::from_str(&line)
                .unwrap_or_else(|e| panic!("stdout 混入非 JSON 行（协议被污染）：{line}（{e}）"));
            if pred(&value) {
                return value;
            }
        }
    }

    fn send(&mut self, line: &str) {
        self.stdin.write_all(line.as_bytes()).unwrap();
        self.stdin.write_all(b"\n").unwrap();
        self.stdin.flush().unwrap();
    }

    /// 发一条命令并等它 id 对应的 reply。
    fn send_cmd(&mut self, id: &str, cmd: &str, extra: Value) -> Value {
        let mut obj = json!({ "v": 1, "id": id, "cmd": cmd });
        if let Value::Object(map) = extra {
            for (k, v) in map {
                obj[k] = v;
            }
        }
        self.send(&obj.to_string());
        let want = id.to_string();
        self.wait_line(
            move |v| v["type"] == "reply" && v["id"] == Value::String(want.clone()),
            &format!("reply {id}"),
        )
    }

    /// 发一行"原始"输入（坏 JSON / 超长行等），等一个 id 为 null 的 reply。
    fn send_raw_and_wait_reply(&mut self, line: &str) -> Value {
        self.send(line);
        self.wait_line(
            |v| v["type"] == "reply" && v["id"] == Value::Null,
            "reply(id=null)",
        )
    }

    fn wait_exit(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.0.try_wait().unwrap() {
                return status.code();
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn drain(&mut self) {
        while let Ok(line) = self.rx.try_recv() {
            self.lines.push(line);
        }
    }
}

fn expect_error(reply: &Value, code: &str) {
    assert_eq!(reply["ok"], false, "期望错误 reply，实际：{reply}");
    assert_eq!(reply["error"]["code"], code, "错误码不符：{reply}");
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn spawn_serve() -> Session {
    let home =
        std::env::temp_dir().join(format!("iroh-agent-golden-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let mut child = Command::new(env!("CARGO_BIN_EXE_agent"))
        // 不传 --room：自动进房是并发的，会与脚本里的命令竞争（不确定性来源）。
        // 自动进房有真实链路的 e2e 脚本覆盖（scripts/e2e/）。
        .args(["serve", "--nick", "录音机"])
        .env("IROH_AGENT_SERVE_SKIP_ONLINE", "1")
        .env("IROH_AGENT_HOME", &home)
        .env("IROH_AGENT_RELAY", "http://127.0.0.1:1")
        .env("IROH_AGENT_TOKEN", "golden")
        .env("RUST_LOG", "warn")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 agent serve 失败");
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    Session {
        child: Guard(child),
        stdin,
        rx,
        lines: Vec::new(),
    }
}

/// 易变字段 → 占位符；relayStatus 事件整类丢弃（返回 None）。
fn normalize_line(line: &str) -> Option<String> {
    let mut value: Value = serde_json::from_str(line).ok()?;
    if value["type"] == "event" && value["event"]["type"] == "relayStatus" {
        return None;
    }
    normalize_value(&mut value);
    Some(value.to_string())
}

fn normalize_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                match key.as_str() {
                    // 身份公钥 / 端点 id / 消息作者
                    "endpointId" | "from" | "by" | "sender" if val.as_str().is_some_and(|s| is_hex(s, 64)) => {
                        *val = json!("<id>");
                    }
                    "agent" if val.as_str().is_some_and(|s| s.starts_with("iroh-agent/")) => {
                        *val = json!("<agent>");
                    }
                    // 中继地址与状态：内容随环境（连没连上、报什么错）
                    "relay" => *val = json!("<relay>"),
                    "relays" => *val = json!("<relays>"),
                    "ts" | "lastSeenMs" | "uptimeMs" => *val = json!(0),
                    "seq" => *val = json!(0),
                    // 消息 id（24 位 hex，blake3 截断）；命令 id（"1".."18"）不会命中
                    "id" if val.as_str().is_some_and(|s| is_hex(s, 24)) => {
                        *val = json!("<msgid>");
                    }
                    _ => normalize_value(val),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_value(item);
            }
        }
        _ => {}
    }
}

#[test]
fn serve_黄金转录不漂移() {
    let mut s = spawn_serve();

    // ---- hello ----
    let hello = s.wait_line(|v| v["type"] == "hello", "hello");
    assert_eq!(hello["chatProtocol"], "v4");
    assert_eq!(hello["nickname"], "录音机");
    assert_eq!(hello["v"], 1);

    // ---- 协议外壳：坏输入 / 版本 / 未知命令 / 超长行 ----
    expect_error(&s.send_raw_and_wait_reply("这不是 JSON"), "badRequest");
    expect_error(&s.send_raw_and_wait_reply(r#"{"v":1,"cmd":"ping"}"#), "badRequest");
    // 版本不匹配：回错要带**命令自己的 id**（能关联才有意义）
    expect_error(
        &s.send_cmd("v1", "ping", json!({ "v": 99 })),
        "unsupportedVersion",
    );
    expect_error(&s.send_cmd("c1", "nope", json!({})), "unsupportedCmd");
    let oversize = "x".repeat(IPC_MAX_LINE_BYTES + 16);
    expect_error(&s.send_raw_and_wait_reply(&oversize), "badRequest");

    // ---- 环境无关的同步命令 ----
    let ping = s.send_cmd("2", "ping", json!({}));
    assert_eq!(ping["ok"], true);
    assert!(ping["value"]["ts"].is_u64());

    let status = s.send_cmd("3", "status", json!({}));
    assert_eq!(status["ok"], true);
    assert_eq!(status["value"]["room"], Value::Null);
    assert_eq!(status["value"]["peers"], json!([]));
    assert_eq!(status["value"]["files"], json!([]));

    // ---- 未进房时各命令的错误码 ----
    expect_error(&s.send_cmd("4", "say", json!({"text": "你好"})), "notJoined");
    expect_error(
        &s.send_cmd("5", "send_file", json!({"path": "/nonexistent"})),
        "notJoined",
    );
    expect_error(&s.send_cmd("6", "history", json!({"limit": 3})), "notJoined");

    // ---- 进房（离线：无 anchor，gossip 本地订阅即可）----
    let join = s.send_cmd("7", "join", json!({"room": "golden-room", "nickname": "录音机"}));
    assert_eq!(join["ok"], true);
    assert_eq!(join["value"]["room"], "golden-room");
    // joined / presence 事件此刻已（或即将）到达；由结尾的归一化转录检查，
    // 这里额外确认它们出现过。
    s.wait_line(
        |v| v["type"] == "event" && v["event"]["type"] == "joined",
        "joined 事件",
    );
    s.wait_line(
        |v| v["type"] == "event" && v["event"]["type"] == "presence",
        "presence 事件",
    );

    // ---- 进房后的收发与历史 ----
    let say = s.send_cmd("8", "say", json!({"text": "你好，黄金转录"}));
    assert_eq!(say["ok"], true);
    assert!(say["value"]["id"].is_string());
    assert!(say["value"]["ts"].is_u64());

    let too_large = "x".repeat(32 * 1024 + 1024);
    expect_error(&s.send_cmd("9", "say", json!({"text": too_large})), "tooLarge");

    let history = s.send_cmd("10", "history", json!({"limit": 3}));
    assert_eq!(history["ok"], true);
    assert_eq!(history["value"]["room"], "golden-room");
    assert_eq!(history["value"]["messages"], json!([]));
    assert_eq!(history["value"]["snapshot"], Value::Null);

    expect_error(
        &s.send_cmd("11", "history", json!({"before": "bad-cursor"})),
        "badRequest",
    );

    // ---- 昵称 / 货架 / 离开 ----
    let nick = s.send_cmd("12", "nick", json!({"nickname": "录音机2"}));
    assert_eq!(nick["ok"], true);

    let list = s.send_cmd("13", "list_files", json!({}));
    assert_eq!(list["ok"], true);
    assert_eq!(list["value"]["files"], json!([]));

    expect_error(&s.send_cmd("14", "unpublish", json!({})), "badRequest");
    let unpublish = s.send_cmd("15", "unpublish", json!({"fileId": "not-there"}));
    assert_eq!(unpublish["ok"], true);

    let leave = s.send_cmd("16", "leave", json!({}));
    assert_eq!(leave["ok"], true);

    // ---- 优雅退出 ----
    let shutdown = s.send_cmd("17", "shutdown", json!({"reason": "golden"}));
    assert_eq!(shutdown["ok"], true);
    let bye = s.wait_line(
        |v| v["type"] == "event" && v["event"]["type"] == "bye",
        "bye 事件",
    );
    assert_eq!(bye["event"]["reason"], "golden");
    let code = s.wait_exit(TIMEOUT).expect("进程没有在超时内退出");
    assert_eq!(code, 0, "优雅退出码应为 0");
    s.drain();

    // ---- 顺序契约：事件 seq 严格递增且不重复（这是真契约，不是转录内容）----
    let mut seqs = Vec::new();
    for line in &s.lines {
        let v: Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("非 JSON 行：{line}（{e}）"));
        if v["type"] == "event" {
            seqs.push(v["seq"].as_u64().expect("事件缺 seq"));
        }
    }
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(seqs, sorted, "seq 必须严格递增且不重复：{seqs:?}");

    // ---- 黄金转录比对（归一化 + 排序；顺序由上面的 seq 断言负责）----
    let mut normalized: Vec<String> = s.lines.iter().filter_map(|l| normalize_line(l)).collect();
    normalized.sort();
    let actual = format!("{}\n", normalized.join("\n"));

    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/serve-golden.jsonl");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(fixture.parent().unwrap()).unwrap();
        std::fs::write(&fixture, &actual).unwrap();
        eprintln!("已更新黄金转录（请 review diff）：{}", fixture.display());
        return;
    }
    let expected = std::fs::read_to_string(&fixture).unwrap_or_else(|e| {
        panic!(
            "读不到 {}：{e}。首次生成：UPDATE_GOLDEN=1 cargo test --offline --locked \
             --no-default-features --features cli --test daemon-protocol",
            fixture.display()
        )
    });
    assert_eq!(
        actual.trim_end(),
        expected.trim_end(),
        "黄金转录漂移：serve 的协议输出变了。\n\
         若是有意变更：review 下面的 diff 后跑 `UPDATE_GOLDEN=1 cargo test ... --test daemon-protocol` \
         重写 fixture 并提交。\n\
         —— 实际输出 ——\n{actual}\n—— 期望（fixture）——\n{expected}"
    );
}
