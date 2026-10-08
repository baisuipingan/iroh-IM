//! iroh-agent · 无头命令行客户端
//!
//! 让**没有浏览器、没有 Node** 的机器（CI、agent、服务器）以一个普通成员的身份进入聊天室：
//! 发文字、发文件，并等对方点"接收"。
//!
//! 与浏览器那个人**完全同构** —— 同一个 crate 的同一个 `RoomNode`、同一套签名与传输协议，
//! 所以房间里其他人看到的也是一个"人"（有身份、显示昵称、消息归属规则一致）。
//!
//! ## 子命令
//!
//! ```text
//! iroh-agent whoami                            # 打印本机身份（首次运行会生成并保存）
//! iroh-agent say   --room X "文本"              # 发一句话就退出
//! iroh-agent send  --room X --file Y            # 发布文件 → 等到 1 个人接收完成 → 退出
//! iroh-agent send  --room X --file Y --expect 3 --timeout 3600
//! iroh-agent watch --room X                    # 常驻：敲文字就说话，`send <路径>` 就发文件
//! ```
//!
//! ## 多接收者语义（重要）
//!
//! 发布文件**不会**让任何人自动拿到 —— 发送端只是把文件"摆上货架"（房间里会多出一张文件卡片）。
//! **每有人点一次接收，发送端就单独推一次给他**（`FileAccepted` 事件，各方状态互不影响）。
//!
//! 所以 `--expect N` 的语义是"等到 N 个人接收完成就退出"：
//!
//! - `--expect 1`（默认）：第一个人接收成功后本进程退出。**此后其他人再点接收会推不动**
//!   （文件卡片还在，推送端没了）。要"任意时刻、任意多人"都能接收，用 `watch` 常驻。
//!
//! ## 配置
//!
//! `~/.config/iroh-agent/config.json`（环境变量可覆盖，优先级更高）：
//!
//! ```json
//! {
//!   "relays": ["https://iroh1.editor.vip:15443"],
//!   "relay_token": "…",
//!   "anchor": { "id": "…", "relay": "https://iroh1.editor.vip:15443" },
//!   "nickname": "构建机"
//! }
//! ```
//!
//! 环境变量：`IROH_AGENT_RELAY`（逗号分隔）、`IROH_AGENT_TOKEN`、`IROH_AGENT_ANCHOR_ID`、
//! `IROH_AGENT_ANCHOR_RELAY`、`IROH_AGENT_NICK`、`IROH_AGENT_HOME`。
//!
//! 身份：首次运行生成 `~/.config/iroh-agent/identity.key`（0600）并**持久复用**
//! —— 它在房间里是"固定的那个人"，你能认出它。

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use iroh::SecretKey;
use iroh_web::filetransfer::{
    bitmap_from_b64, chunk_count, hex_encode, new_file_id, FileMeta, CHUNK_SIZE,
};
use iroh_web::room::{now_ms, RoomEvent, RoomNode, RoomOptions};
use iroh_web::transfer_orchestrator::{ChunkSource, LocalBoxFuture};
use n0_future::StreamExt;

// ============================================================ 配置 / 身份

/// 配置与身份的存放目录。
///
/// ⚠️ Windows 上**不能**用 `HOME`：那里通常没有这个变量，取不到就会掉进
///   `"/root/.config"` 这种 POSIX 路径 —— 在 Windows 上要么建到盘根、要么直接失败。
///   所以 Windows 走 `%APPDATA%\\iroh-agent`，POSIX 走 `$XDG_CONFIG_HOME` 或 `$HOME/.config`。
///   `IROH_AGENT_HOME` 在任何平台都优先（CI 里最常用）。
fn home() -> PathBuf {
    if let Some(dir) = std::env::var("IROH_AGENT_HOME").ok().filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        let base = std::env::var("APPDATA")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                // 没有 APPDATA（极少见的服务环境）时退到用户目录下的 AppData
                let h = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
                format!("{h}\\AppData\\Roaming")
            });
        PathBuf::from(base).join("iroh-agent")
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                let h = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
                format!("{h}/.config")
            });
        PathBuf::from(base).join("iroh-agent")
    }
}

fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

#[derive(Clone, Default)]
struct Config {
    relays: Vec<String>,
    relay_token: Option<String>,
    anchor_id: Option<String>,
    anchor_relay: Option<String>,
    nickname: String,
}

fn load_config() -> Config {
    let mut cfg = std::fs::read_to_string(home().join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .map(|v| Config {
            relays: v
                .get("relays")
                .and_then(|r| r.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            relay_token: v
                .get("relay_token")
                .and_then(|x| x.as_str())
                .map(str::to_string),
            anchor_id: v
                .get("anchor")
                .and_then(|a| a.get("id"))
                .and_then(|x| x.as_str())
                .map(str::to_string),
            anchor_relay: v
                .get("anchor")
                .and_then(|a| a.get("relay"))
                .and_then(|x| x.as_str())
                .map(str::to_string),
            nickname: v
                .get("nickname")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .unwrap_or_default();

    if let Some(v) = env_opt("IROH_AGENT_RELAY") {
        cfg.relays = v
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }
    cfg.relay_token = env_opt("IROH_AGENT_TOKEN").or(cfg.relay_token);
    cfg.anchor_id = env_opt("IROH_AGENT_ANCHOR_ID").or(cfg.anchor_id);
    cfg.anchor_relay = env_opt("IROH_AGENT_ANCHOR_RELAY").or(cfg.anchor_relay);
    if let Some(v) = env_opt("IROH_AGENT_NICK") {
        cfg.nickname = v;
    }
    if cfg.nickname.is_empty() {
        cfg.nickname = "命令行成员".to_string();
    }
    if cfg.relays.is_empty() {
        cfg.relays = vec!["https://iroh1.editor.vip:15443".to_string()];
    }
    cfg
}

#[cfg(unix)]
fn set_mode_600(p: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}
#[cfg(not(unix))]
fn set_mode_600(_p: &Path) -> Result<()> {
    Ok(())
}

fn load_or_create_identity() -> Result<SecretKey> {
    let dir = home();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("创建 {}", dir.display()))?;
    let path = dir.join("identity.key");
    if let Ok(text) = std::fs::read_to_string(&path) {
        let text = text.trim();
        if !text.is_empty() {
            match hex::decode(text) {
                Ok(bytes) if bytes.len() == 32 => {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&bytes);
                    println!("身份来自 {}", path.display());
                    return Ok(SecretKey::from_bytes(&arr));
                }
                Ok(bytes) => {
                    tracing::warn!("{} 长度异常（{} 字节），重新生成", path.display(), bytes.len());
                }
                Err(_) => tracing::warn!("{} 不是合法 hex，重新生成", path.display()),
            }
        }
    }
    let key = SecretKey::generate();
    let tmp = path.with_extension("key.tmp");
    std::fs::write(&tmp, hex_encode(key.to_bytes()))?;
    set_mode_600(&tmp)?;
    std::fs::rename(&tmp, &path)?;
    println!("已生成新身份 {}", path.display());
    Ok(key)
}

// ============================================================ 文件源（流式）

/// `ChunkSource` 的磁盘实现：按需 open + seek 读第 `seq` 块。
///
/// ★ 为什么不能直接用 `BytesSource`：它是整块 `Vec<u8>`，
///   打包一个大项目会**整个文件进内存**。这里每次只读一块（16 KiB）。
struct FileSource {
    path: PathBuf,
}

impl FileSource {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl ChunkSource for FileSource {
    fn read_chunk<'a>(&'a self, seq: u32, chunk_size: u32) -> LocalBoxFuture<'a, Result<Vec<u8>>> {
        let path = self.path.clone();
        Box::pin(async move {
            use std::io::{Read, Seek, SeekFrom};
            let mut f = std::fs::File::open(&path)
                .with_context(|| format!("打开 {}", path.display()))?;
            f.seek(SeekFrom::Start(seq as u64 * chunk_size as u64))?;
            let mut buf = vec![0u8; chunk_size as usize];
            let mut filled = 0usize;
            while filled < buf.len() {
                match f.read(&mut buf[filled..]) {
                    Ok(0) => break,
                    Ok(n) => filled += n,
                    Err(e) => return Err(e.into()),
                }
            }
            buf.truncate(filled);
            Ok(buf)
        })
    }
}

/// 流式算 blake3 根哈希（文件不整体进内存）+ 生成 `FileMeta`。
fn meta_for_file(
    path: &Path,
    mime: &str,
    sender: &SecretKey,
    self_relay: &str,
) -> Result<FileMeta> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).with_context(|| format!("打开 {}", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    Ok(FileMeta {
        file_id: new_file_id(),
        name,
        size,
        mime: mime.to_string(),
        chunk_size: CHUNK_SIZE,
        root_hash: hex_encode(hasher.finalize().as_bytes()),
        sender: sender.public().to_string(),
        sender_relay: self_relay.to_string(),
        ts: now_ms(),
    })
}

// ============================================================ 参数

struct Args {
    cmd: String,
    room: String,
    file: Option<PathBuf>,
    text: Option<String>,
    expect: usize,
    timeout: u64,
    nick: Option<String>,
}

fn parse_args() -> Result<Args> {
    let mut it = std::env::args().skip(1);
    let mut a = Args {
        cmd: it.next().unwrap_or_else(|| "help".into()),
        room: String::new(),
        file: None,
        text: None,
        expect: 1,
        timeout: 1800,
        nick: None,
    };
    let rest: Vec<String> = it.collect();
    let mut i = 0usize;
    while i < rest.len() {
        match rest[i].as_str() {
            "--room" => {
                a.room = rest.get(i + 1).cloned().ok_or_else(|| anyhow!("--room 缺值"))?;
                i += 2;
            }
            "--file" => {
                a.file = Some(PathBuf::from(
                    rest.get(i + 1).cloned().ok_or_else(|| anyhow!("--file 缺值"))?,
                ));
                i += 2;
            }
            "--expect" => {
                a.expect = rest.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(1);
                i += 2;
            }
            "--timeout" => {
                a.timeout = rest.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(1800);
                i += 2;
            }
            "--nick" => {
                a.nick = Some(rest.get(i + 1).cloned().ok_or_else(|| anyhow!("--nick 缺值"))?);
                i += 2;
            }
            other => {
                if a.text.is_none() && !other.starts_with('-') {
                    a.text = Some(other.to_string());
                }
                i += 1;
            }
        }
    }
    Ok(a)
}

const USAGE: &str = "\
iroh-agent · 无头命令行聊天室成员

用法：
  iroh-agent whoami
  iroh-agent say   --room X \"文本\"
  iroh-agent send  --room X --file Y [--expect N] [--timeout 秒]
  iroh-agent watch --room X [--nick 名字]

选项：
  --room X        房间名
  --file PATH     要发的文件
  --expect N      等 N 个人接收完成就退出（send 默认 1）
  --timeout SEC   等待秒数上限（默认 1800）
  --nick NAME     房间里的显示名

注意：发布文件只是把文件\"摆上货架\"，每有人点一次接收就单独推一次。
      send 默认 --expect 1，即第一个人接收成功后本进程退出，之后其他人再点接收
      会推不动（文件卡片还在，推送端没了）。要让任意时刻任意人都能接收，请用 watch。

配置：~/.config/iroh-agent/config.json
      环境变量可覆盖：IROH_AGENT_RELAY / IROH_AGENT_TOKEN / IROH_AGENT_ANCHOR_ID /
      IROH_AGENT_ANCHOR_RELAY / IROH_AGENT_NICK / IROH_AGENT_HOME
";

// ============================================================ 节点

async fn start_node(cfg: &Config, key: &SecretKey) -> Result<Arc<RoomNode>> {
    let node = RoomNode::start(RoomOptions {
        relays: cfg.relays.clone(),
        relay_token: cfg.relay_token.clone(),
        secret_key_hex: Some(hex_encode(key.to_bytes())),
        anchor_id: cfg.anchor_id.clone(),
        anchor_relay: cfg.anchor_relay.clone(),
        history_dir: None,
        serve_history: false,
    })
    .await
    .context("启动节点失败")?;
    tokio::time::timeout(Duration::from_secs(30), node.online())
        .await
        .context("连接中继超时")?;
    Ok(Arc::new(node))
}

fn banner(node: &RoomNode, cfg: &Config, room: &str, role: &str) {
    println!("=== iroh-agent · {role} ===");
    println!("  身份    : {}", node.endpoint_id());
    println!("  昵称    : {}", cfg.nickname);
    println!("  房间    : {room}");
    println!("  当前中继: {:?}", node.my_relay_url());
    let _ = std::io::stdout().flush();
}

async fn enter_room(node: &RoomNode, room: &str, nick: &str) -> Result<()> {
    if !nick.is_empty() {
        node.set_nickname(nick);
    }
    match tokio::time::timeout(Duration::from_secs(30), node.join(room, nick)).await {
        Ok(Ok(())) => println!("✅ 已进入房间 {room}"),
        Ok(Err(e)) => println!("⚠️  进房失败（可能没有锚点）: {e:#}"),
        Err(_) => println!("⚠️  进房超时（可能没有锚点）"),
    }
    Ok(())
}

// ============================================================ 发送文件的核心循环

/// 把 `meta` 对应的文件发给每一个点"接收"的人，直到完成 `expect` 个。
/// `pending` 里存的是"我已经摆上货架、正在等人接收"的文件。
async fn serve_accepts(
    node: &RoomNode,
    events: &mut std::pin::Pin<Box<async_channel::Receiver<RoomEvent>>>,
    pending: &Arc<Mutex<HashMap<String, (FileMeta, PathBuf)>>>,
    expect: usize,
    timeout: u64,
    interactive: bool,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    let mut done = 0usize;
    loop {
        if done >= expect {
            break;
        }
        let ev = match tokio::time::timeout_at(deadline, events.next()).await {
            Ok(Some(ev)) => ev,
            Ok(None) => {
                println!("事件流结束");
                break;
            }
            Err(_) => {
                println!("⏳ 等待超时（{timeout}s），已推送 {done} 个");
                if done == 0 {
                    println!("    文件卡片仍在房间里，但本进程退出后没人能再推 —— 需要接收请重跑一次。");
                }
                break;
            }
        };
        match ev {
            RoomEvent::FileAccepted {
                file_id,
                have,
                receiver_relay,
                by,
                ..
            } => {
                let Some((meta, path)) = pending.lock().unwrap().get(&file_id).cloned() else {
                    continue;
                };
                println!(
                    "📥 {} 已被接收 → 开始推送（{}）",
                    &by[..8.min(by.len())],
                    meta.name
                );
                let src = FileSource::new(path.clone());
                let name = meta.name.clone();
                let t0 = std::time::Instant::now();
                let r = node
                    .send_file_data(&meta, &by, &receiver_relay, &src, bitmap_from_b64(&have), |ev| {
                        if let iroh_web::filetransfer::SendEvent::Progress { done: d, total: t, bytes } = ev {
                            if t > 0 && (d % 64 == 0 || d == t) {
                                println!(
                                    "   {name} 进度 {d}/{t} 块（{}）",
                                    iroh_web::filetransfer::human_size(bytes)
                                );
                            }
                        }
                    })
                    .await;
                match r {
                    Ok(sent) => {
                        done += 1;
                        let secs = t0.elapsed().as_secs_f64().max(0.001);
                        println!(
                            "✅ 完成 {done}/{expect}：{} → {}（{:.1?}，{}）",
                            &by[..8.min(by.len())],
                            sent,
                            t0.elapsed(),
                            format!("{}/s", iroh_web::filetransfer::human_size((sent as f64 / secs) as u64))
                        );
                    }
                    Err(e) => println!("❌ 推送失败：{e:#}（继续等其他人）"),
                }
            }
            RoomEvent::FileRejected {
                file_id, reason, ..
            } => {
                if pending.lock().unwrap().contains_key(&file_id) {
                    println!("⚠️  有人拒绝接收：{reason}（继续等其他人）");
                }
            }
            RoomEvent::Message { message, .. } => {
                if interactive {
                    let who = if message.nickname.is_empty() {
                        message.from.clone()
                    } else {
                        message.nickname.clone()
                    };
                    println!("💬 {who}：{}", message.text);
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// ============================================================ 子命令

async fn cmd_whoami(cfg: &Config, key: &SecretKey) -> Result<()> {
    println!("身份 ID    : {}", key.public());
    println!("配置目录   : {}", home().display());
    println!("中继       : {}", cfg.relays.join(", "));
    println!("锚点       : {}", cfg.anchor_id.clone().unwrap_or_else(|| "（未配置）".into()));
    let node = start_node(cfg, key).await?;
    println!("已连上中继，当前中继地址 = {:?}", node.my_relay_url());
    node.shutdown();
    Ok(())
}

async fn cmd_say(node: &RoomNode, text: &str) -> Result<()> {
    let msg = node.send(text).await.context("发送失败")?;
    println!("已发送 id={}", msg.id);
    Ok(())
}

async fn cmd_send(
    node: &RoomNode,
    key: &SecretKey,
    room: &str,
    path: &Path,
    expect: usize,
    timeout: u64,
) -> Result<()> {
    let my_relay = node
        .my_relay_url()
        .ok_or_else(|| anyhow!("本端没有可用中继地址"))?;
    let meta = meta_for_file(path, "application/octet-stream", key, &my_relay)?;
    println!(
        "文件 {}（{}，{} 块）",
        meta.name,
        meta.size,
        chunk_count(meta.size, meta.chunk_size)
    );
    println!("根哈希 {}", &meta.root_hash[..16.min(meta.root_hash.len())]);

    let mut events = Box::pin(node.subscribe());
    let pending: Arc<Mutex<HashMap<String, (FileMeta, PathBuf)>>> = Arc::new(Mutex::new(HashMap::new()));
    pending
        .lock()
        .unwrap()
        .insert(meta.file_id.clone(), (meta.clone(), path.to_path_buf()));
    node.set_available_files(vec![meta.file_id.clone()]);
    node.invite_file(&meta, room).await?;

    println!("📤 已发布到房间，等待接收（目标 {expect} 人，最多等 {timeout}s）…");
    serve_accepts(node, &mut events, &pending, expect, timeout, false).await?;
    Ok(())
}

async fn cmd_watch(node: &Arc<RoomNode>, key: &SecretKey, room: &str) -> Result<()> {
    let mut events = Box::pin(node.subscribe());
    let pending: Arc<Mutex<HashMap<String, (FileMeta, PathBuf)>>> = Arc::new(Mutex::new(HashMap::new()));

    // stdin 用独立线程读（cli feature 没开 tokio 的 io 特性，不能用异步读）
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.lock().read_line(&mut line) {
                Ok(0) | Err(_) => break, // EOF
                Ok(_) => {
                    let t = line.trim().to_string();
                    if !t.is_empty() && tx.send(t).is_err() {
                        break;
                    }
                }
            }
        }
    });

    println!();
    println!("已进入房间。直接敲字回车 = 发消息；`send <文件路径>` = 发文件；`quit` 退出。");
    println!("—————————————————————————————");

    let mut send_tasks = Vec::new();
    loop {
        tokio::select! {
            Some(ev) = events.next() => {
                match ev {
                    RoomEvent::FileAccepted { file_id, have, receiver_relay, by, .. } => {
                        let Some((meta, path)) = pending.lock().unwrap().get(&file_id).cloned() else { continue };
                        println!("📥 {} 接收了 {}，推送中…", &by[..8.min(by.len())], meta.name);
                        let n = Arc::clone(node);
                        let src = FileSource::new(path);
                        send_tasks.push(tokio::spawn(async move {
                            if let Err(e) = n.send_file_data(&meta, &by, &receiver_relay, &src,
                                                        bitmap_from_b64(&have), |_| {}).await {
                                println!("❌ 推送失败：{e:#}");
                            } else {
                                println!("✅ {} 已拿到 {}", meta.name, &by[..8.min(by.len())]);
                            }
                        }));
                    }
                    RoomEvent::FileRejected { file_id, reason, .. } => {
                        println!("⚠️  有人拒绝接收 {}：{reason}", &file_id[..8.min(file_id.len())]);
                    }
                    RoomEvent::FileInvite { meta, .. } => {
                        println!("📨 有人送来文件：{}（{} 字节，接收请在聊天窗口点『接收』）", meta.name, meta.size);
                    }
                    RoomEvent::Message { message, mine, .. } => {
                        let who = if message.nickname.is_empty() {
                            message.from.clone()
                        } else {
                            message.nickname.clone()
                        };
                        println!("💬 {who}：{}", message.text);
                        if mine {
                            println!("   （这是我自己发的）");
                        }
                    }
                    RoomEvent::FileDone { file_id, ok, reason, .. } => {
                        println!("{} 传输完成 ok={ok} {reason}", &file_id[..8.min(file_id.len())]);
                    }
                    _ => {}
                }
            }
            Some(line) = rx.recv() => {
                let line = line.trim();
                if line.is_empty() { continue }
                if line == "quit" || line == "exit" { println!("再见"); break }
                if let Some(path) = line.strip_prefix("send ") {
                    let path = PathBuf::from(path.trim());
                    let Some(relay_url) = node.my_relay_url() else {
                println!("❌ 本端没有可用中继地址");
                continue;
            };
            match meta_for_file(&path, "application/octet-stream", key, &relay_url) {
                        Ok(meta) => {
                            println!("📤 发布 {}（{} 字节）…", meta.name, meta.size);
                            pending.lock().unwrap()
                                .insert(meta.file_id.clone(), (meta.clone(), path));
                            node.set_available_files(pending.lock().unwrap().keys().cloned().collect());
                            if let Err(e) = node.invite_file(&meta, room).await {
                                println!("❌ 发布失败：{e:#}");
                            }
                        }
                        Err(e) => println!("❌ 读文件失败：{e:#}"),
                    }
                } else {
                    match node.send(line).await {
                        Ok(m) => println!("   已发送 {}", &m.id[..8.min(m.id.len())]),
                        Err(e) => println!("❌ 发送失败：{e:#}"),
                    }
                }
            }
            else => break,
        }
    }
    Ok(())
}

// ============================================================ main

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let args = parse_args()?;
    if matches!(args.cmd.as_str(), "help" | "-h" | "--help") {
        println!("{USAGE}");
        return Ok(());
    }

    let cfg = load_config();
    let key = load_or_create_identity()?;

    if args.cmd == "whoami" {
        return cmd_whoami(&cfg, &key).await;
    }

    if args.room.is_empty() {
        println!("缺少 --room。\n\n{USAGE}");
        std::process::exit(2);
    }
    let cfg = Config {
        nickname: args.nick.clone().unwrap_or(cfg.nickname),
        ..cfg
    };

    let node = start_node(&cfg, &key).await?;
    banner(&node, &cfg, &args.room, &args.cmd);
    enter_room(&node, &args.room, &cfg.nickname).await?;
    tokio::time::sleep(Duration::from_millis(800)).await;

    let result = match args.cmd.as_str() {
        "say" => {
            let text = args.text.clone().unwrap_or_default();
            cmd_say(&node, &text).await
        }
        "send" => {
            let Some(path) = args.file.clone() else {
                println!("缺少 --file。\n\n{USAGE}");
                std::process::exit(2);
            };
            cmd_send(&node, &key, &args.room, &path, args.expect, args.timeout).await
        }
        "watch" => cmd_watch(&node, &key, &args.room).await,
        other => {
            println!("未知子命令 {other}\n\n{USAGE}");
            std::process::exit(2);
        }
    };

    node.shutdown();
    // `RoomNode::shutdown()` 只是把 `endpoint.close()` spawn 出去就返回，
    // CLI 紧接着就退出的话，close 还没跑完 —— iroh 会在日志里报
    // "Endpoint dropped without calling `Endpoint::close`"（功能没问题，但难看）。
    // 给它 300ms。
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    result
}