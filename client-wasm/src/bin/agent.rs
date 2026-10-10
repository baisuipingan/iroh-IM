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

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use iroh::SecretKey;
use iroh_web::filetransfer::{
    bitmap_from_b64, chunk_count, hex_encode, new_file_id, FileMeta, CHUNK_SIZE,
};
use iroh_web::room::{now_ms, RoomEvent, RoomNode, RoomOptions};
use iroh_web::transfer_orchestrator::{ChunkSource, FileSink, LocalBoxFuture};
use n0_future::StreamExt;
use serde_json::json;
use tracing::{info, warn};

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
    /// 兼容字段：下面两个角色都没配时回退到它
    anchor_id: Option<String>,
    anchor_relay: Option<String>,
    /// **房间入口**（rendezvous）：进房时问它"这房间现在有谁"
    rendezvous_id: Option<String>,
    rendezvous_relay: Option<String>,
    /// **历史提供者**
    history_id: Option<String>,
    history_relay: Option<String>,
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
            rendezvous_id: v
                .get("rendezvous")
                .and_then(|a| a.get("id"))
                .and_then(|x| x.as_str())
                .map(str::to_string),
            rendezvous_relay: v
                .get("rendezvous")
                .and_then(|a| a.get("relay"))
                .and_then(|x| x.as_str())
                .map(str::to_string),
            history_id: v
                .get("history")
                .and_then(|a| a.get("id"))
                .and_then(|x| x.as_str())
                .map(str::to_string),
            history_relay: v
                .get("history")
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
    // 两个角色也可以各自用环境变量覆盖（部署时想指向不同节点就走这里）
    cfg.rendezvous_id = env_opt("IROH_AGENT_RENDEZVOUS_ID").or(cfg.rendezvous_id);
    cfg.rendezvous_relay = env_opt("IROH_AGENT_RENDEZVOUS_RELAY").or(cfg.rendezvous_relay);
    cfg.history_id = env_opt("IROH_AGENT_HISTORY_ID").or(cfg.history_id);
    cfg.history_relay = env_opt("IROH_AGENT_HISTORY_RELAY").or(cfg.history_relay);
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

/// `quiet`：serve 模式下 stdout 是协议流，**任何 println 都是污染** —— 改走 stderr 日志。
fn load_or_create_identity(quiet: bool) -> Result<SecretKey> {
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
                    if quiet {
                        tracing::info!("身份来自 {}", path.display());
                    } else {
                        println!("身份来自 {}", path.display());
                    }
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
    if quiet {
        tracing::info!("已生成新身份 {}", path.display());
    } else {
        println!("已生成新身份 {}", path.display());
    }
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
  iroh-agent serve [--room X] [--nick 名字]   # JSON Lines 行协议常驻（给程序/LLM 用）

选项：
  --room X        房间名
  --file PATH     要发的文件
  --expect N      等 N 个人接收完成就退出（send 默认 1）
  --timeout SEC   等待秒数上限（默认 1800）
  --nick NAME     房间里的显示名

注意：发布文件只是把文件\"摆上货架\"，每有人点一次接收就单独推一次。
      send 默认 --expect 1，即第一个人接收成功后本进程退出，之后其他人再点接收
      会推不动（文件卡片还在，推送端没了）。要让任意时刻任意人都能接收，请用 watch。

      serve 的 stdin/stdout 是 JSON Lines 协议流，日志在 stderr；
      `--room` 可省略（等客户端的 join 命令）。协议见 docs/agent-daemon-protocol.md。

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
        rendezvous_id: cfg.rendezvous_id.clone(),
        rendezvous_relay: cfg.rendezvous_relay.clone(),
        history_id: cfg.history_id.clone(),
        history_relay: cfg.history_relay.clone(),
        history_dir: None,
        serve_history: false,
        serve_rendezvous: false,
        join_timeout_ms: None,
    })
    .await
    .context("启动节点失败")?;
    // 测试钩子（沿用 filetransfer 的 STOP_AFTER_CHUNKS 惯例）：离线跑协议层测试
    // （黄金转录，见 tests/daemon-protocol.rs）时跳过"至少连上一台中继"的等待。
    // 正常部署绝不设置这个变量。
    if std::env::var_os("IROH_AGENT_SERVE_SKIP_ONLINE").is_none() {
        tokio::time::timeout(Duration::from_secs(30), node.online())
            .await
            .context("连接中继超时")?;
    }
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

// ============================================================ serve（JSON 行协议常驻）
//
// 给"程序化成员"用：TS/LLM 侧（pi 适配器）spawn 本进程，通过 stdin/stdout 的
// JSON Lines 对话。协议见 docs/agent-daemon-protocol.md。
//
// 三条铁律（改这个模式时别破坏）：
//   1. stdout 只跑协议；日志一律 stderr（分流在 main 里做）
//   2. stdin EOF = 退出信号（防孤儿）；异常退出前尽力发 fatal
//   3. 进度类事件可丢（try_send），reply / message 等关键行不可丢（阻塞入队）

/// 行协议版本（hello 里的 `v`）。
const IPC_VERSION: u64 = 1;
/// stdin 单行上限：超过整行丢弃并回 badRequest（防误贴大文件把内存打爆）。
const IPC_MAX_LINE_BYTES: usize = 1024 * 1024;
/// `say` 文本上限（gossip 帧上限 512 KiB 是给整条 JSON 的，聊天用不着）。
const IPC_MAX_SAY_BYTES: usize = 32 * 1024;
/// stdout 写队列容量：满了只丢进度事件，其余阻塞等待。
const IPC_OUT_QUEUE: usize = 4096;

/// stdout 行写出器：专用线程 + 有界队列 + 逐行 flush。
///
/// 为什么不用 println：多条任务会并发写协议，println 的加锁是行级的但**不保证
/// 整行原子与顺序**（且没法做"队列满丢进度"的策略）；交给单一写线程最稳。
#[derive(Clone)]
struct Out {
    tx: Arc<Mutex<SyncSender<String>>>,
}

impl Out {
    fn start() -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(IPC_OUT_QUEUE);
        std::thread::spawn(move || {
            let stdout = std::io::stdout();
            let mut lock = stdout.lock();
            while let Ok(line) = rx.recv() {
                if lock.write_all(line.as_bytes()).is_err() || lock.write_all(b"\n").is_err() {
                    break; // 管道断了（父进程没了）：交给 stdin EOF 触发退出
                }
                let _ = lock.flush();
            }
        });
        Self {
            tx: Arc::new(Mutex::new(tx)),
        }
    }

    /// 关键行：队列满也等（宁可慢，不可丢）。
    fn emit(&self, v: serde_json::Value) {
        let _ = self.tx.lock().unwrap().send(v.to_string());
    }

    /// 可丢行：只用于进度类事件（可观测性，不是正确性；`fileDone` 才是权威终点）。
    fn emit_droppable(&self, v: serde_json::Value) {
        let _ = self.tx.lock().unwrap().try_send(v.to_string());
    }
}

/// 取一个非空字符串参数。
fn req_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// 最近收到的文件邀约（有上限）。
///
/// serve 收到 `FileInvite` 事件时把 meta 存这里；`accept_file` 命令靠它拿到
/// **完整 meta**（接收授权必须拿 meta.sender 核对数据流来源，只给 file_id
/// 等于放弃授权 —— 见 `RoomNode::accept_file` 的说明）。
///
/// 上限 64：长时间运行的常驻进程不能攒出一个无限表；满了丢最旧的。
/// 它是**缓存不是权威**：过期了让对端重发邀约即可（FileQueryAsked 会触发）。
struct Invites {
    map: HashMap<String, (FileMeta, String)>,
    order: VecDeque<String>,
}

impl Invites {
    fn put(&mut self, meta: FileMeta, room: String) {
        if self.map.insert(meta.file_id.clone(), (meta.clone(), room)).is_none() {
            self.order.push_back(meta.file_id);
        }
        while self.order.len() > 64 {
            if let Some(oldest) = self.order.pop_front() {
                self.map.remove(&oldest);
            }
        }
    }

    fn get(&self, file_id: &str) -> Option<(FileMeta, String)> {
        self.map.get(file_id).cloned()
    }

    fn remove(&mut self, file_id: &str) {
        self.map.remove(file_id);
        self.order.retain(|id| id != file_id);
    }
}

struct ServeCtx {
    node: Arc<RoomNode>,
    key: SecretKey,
    out: Out,
    seq: AtomicU64,
    started: Instant,
    /// 货架：file_id → (meta, path)。真相在这里，核心那边只是镜像。
    files: Mutex<HashMap<String, (FileMeta, PathBuf)>>,
    /// 最近收到的邀约（accept_file 的 meta 来源）
    invites: Mutex<Invites>,
    /// 正在接收的 file_id（同一文件并发 accept 只允许一条链路）
    accepting: Mutex<HashSet<String>>,
    /// 默认昵称（join 不带 nickname 时用；nick 命令会更新它）。
    default_nick: Mutex<String>,
    /// 上一个已进过的房间（用于判断"换房"→ 清空货架）。
    last_room: Mutex<Option<String>>,
    /// 在途命令 id（协议：同一 id 在上一条 reply 前不得重复）。
    inflight: Mutex<HashSet<String>>,
    /// 退出信号（shutdown 命令 / 信号 / stdin EOF 统一走这里）。
    stop_tx: tokio::sync::mpsc::Sender<String>,
    /// 串行化 join（`--room` 自动进房与 join 命令可能并发）。
    join_lock: tokio::sync::Mutex<()>,
}

impl ServeCtx {
    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn envelope(&self, event: serde_json::Value) -> serde_json::Value {
        json!({"v": IPC_VERSION, "type": "event", "seq": self.next_seq(), "event": event})
    }

    /// 关键事件（不可丢）。
    fn emit_event(&self, event: serde_json::Value) {
        self.out.emit(self.envelope(event));
    }

    /// 进度类事件（队列满可丢）。
    fn emit_progress_event(&self, event: serde_json::Value) {
        self.out.emit_droppable(self.envelope(event));
    }

    fn reply_ok(&self, id: &str, value: serde_json::Value) {
        self.out.emit(
            json!({"v": IPC_VERSION, "type": "reply", "id": id, "ok": true, "value": value}),
        );
        self.finish(id);
    }

    fn reply_err(&self, id: &str, code: &str, message: &str) {
        self.out.emit(json!({
            "v": IPC_VERSION, "type": "reply", "id": id, "ok": false,
            "error": {"code": code, "message": message},
        }));
        self.finish(id);
    }

    /// 标记一个命令 id 开始处理；`false` = 重复 id（上一次还没回复完）。
    fn begin(&self, id: &str) -> bool {
        let mut g = self.inflight.lock().unwrap();
        if g.contains(id) {
            return false;
        }
        g.insert(id.to_string());
        true
    }

    /// 命令已回复：从在途表里摘掉。
    fn finish(&self, id: &str) {
        self.inflight.lock().unwrap().remove(id);
    }

    fn files_list(&self) -> Vec<serde_json::Value> {
        self.files
            .lock()
            .unwrap()
            .values()
            .map(|(m, _)| json!({"fileId": m.file_id, "name": m.name, "size": m.size}))
            .collect()
    }

    /// 把货架同步给核心（心跳会带出去；清单没变时核心自身会跳过广播）。
    fn set_files_now(&self) {
        let ids: Vec<String> = self.files.lock().unwrap().keys().cloned().collect();
        self.node.set_available_files(ids);
    }

    fn status_value(&self) -> serde_json::Value {
        json!({
            "endpointId": self.node.endpoint_id(),
            "room": self.node.current_room(),
            "relays": self.node.relay_status(),
            "peers": self.node.peers_snapshot(),
            "files": self.files_list(),
            "uptimeMs": self.started.elapsed().as_millis() as u64,
        })
    }
}

/// 没有可用 id（解析失败等）时的错误回复，不做在途记录。
fn reply_err_raw(out: &Out, id: Option<&str>, code: &str, message: &str) {
    out.emit(json!({
        "v": IPC_VERSION, "type": "reply", "id": id, "ok": false,
        "error": {"code": code, "message": message},
    }));
}

// ---------------------------------------------------------- 命令分派（stdin）

/// 解析并分派一行命令。慢命令（join/say/send_file/history/leave）各自 spawn，
/// 保证控制循环不被阻塞；reply 顺序因此不保证 —— 协议用 `id` 关联，不依赖顺序。
fn serve_handle_line(ctx: &Arc<ServeCtx>, line: String) {
    if line.len() > IPC_MAX_LINE_BYTES {
        reply_err_raw(&ctx.out, None, "badRequest", "命令行超过 1 MiB 上限");
        return;
    }
    let v: serde_json::Value = match serde_json::from_str(&line) {
        Ok(v) => v,
        Err(e) => {
            reply_err_raw(&ctx.out, None, "badRequest", &format!("不是合法 JSON：{e}"));
            return;
        }
    };
    if !v.is_object() {
        reply_err_raw(&ctx.out, None, "badRequest", "命令必须是 JSON 对象");
        return;
    }
    let id = v.get("id").and_then(|x| x.as_str()).map(str::to_string);
    let ver = v.get("v").and_then(|x| x.as_u64()).unwrap_or(IPC_VERSION);
    if ver != IPC_VERSION {
        reply_err_raw(
            &ctx.out,
            id.as_deref(),
            "unsupportedVersion",
            &format!("仅支持 v{IPC_VERSION}，收到 v{ver}"),
        );
        return;
    }
    let Some(id) = id else {
        reply_err_raw(&ctx.out, None, "badRequest", "缺少 id");
        return;
    };
    let Some(cmd) = v.get("cmd").and_then(|x| x.as_str()).map(str::to_string) else {
        reply_err_raw(&ctx.out, Some(&id), "badRequest", "缺少 cmd");
        return;
    };
    if !ctx.begin(&id) {
        reply_err_raw(&ctx.out, Some(&id), "badRequest", "id 重复（上一次还未回复完成）");
        return;
    }

    match cmd.as_str() {
        // ---- 同步短路（都很便宜，不 spawn）----
        "ping" => ctx.reply_ok(&id, json!({"ts": now_ms()})),
        "status" => {
            let s = ctx.status_value();
            ctx.reply_ok(&id, s);
        }
        "list_files" => {
            let files = ctx.files_list();
            ctx.reply_ok(&id, json!({"files": files}));
        }
        "unpublish" => match req_str(&v, "fileId") {
            Some(file_id) => {
                ctx.files.lock().unwrap().remove(&file_id);
                ctx.set_files_now();
                ctx.reply_ok(&id, json!({}));
            }
            None => ctx.reply_err(&id, "badRequest", "缺少 fileId"),
        },
        "nick" => match req_str(&v, "nickname") {
            Some(nick) => {
                *ctx.default_nick.lock().unwrap() = nick.clone();
                if ctx.node.current_room().is_some() {
                    ctx.node.set_nickname(&nick);
                }
                ctx.reply_ok(&id, json!({}));
            }
            None => ctx.reply_err(&id, "badRequest", "缺少 nickname"),
        },
        "shutdown" => {
            let reason = req_str(&v, "reason").unwrap_or_else(|| "收到 shutdown 命令".into());
            ctx.reply_ok(&id, json!({}));
            let _ = ctx.stop_tx.try_send(reason);
        }

        // ---- 慢命令：spawn ----
        "join" => {
            let Some(room) = req_str(&v, "room") else {
                ctx.reply_err(&id, "badRequest", "缺少 room");
                return;
            };
            let nickname = req_str(&v, "nickname");
            let c = ctx.clone();
            tokio::spawn(async move { serve_do_join(c, id, room, nickname).await });
        }
        "say" => {
            let Some(text) = v.get("text").and_then(|x| x.as_str()).map(str::to_string) else {
                ctx.reply_err(&id, "badRequest", "缺少 text");
                return;
            };
            let c = ctx.clone();
            tokio::spawn(async move { serve_do_say(c, id, text).await });
        }
        "send_file" => {
            let Some(path) = req_str(&v, "path") else {
                ctx.reply_err(&id, "badRequest", "缺少 path");
                return;
            };
            let name = req_str(&v, "name");
            let mime = req_str(&v, "mime").unwrap_or_else(|| "application/octet-stream".into());
            let c = ctx.clone();
            tokio::spawn(async move { serve_do_send_file(c, id, PathBuf::from(path), name, mime).await });
        }
        "history" => {
            let limit = v.get("limit").and_then(|x| x.as_u64()).map(|n| n as usize);
            let before = req_str(&v, "before");
            let c = ctx.clone();
            tokio::spawn(async move { serve_do_history(c, id, limit, before).await });
        }
        "leave" => {
            let c = ctx.clone();
            tokio::spawn(async move { serve_do_leave(c, id).await });
        }
        "accept_file" => {
            let Some(file_id) = req_str(&v, "fileId") else {
                ctx.reply_err(&id, "badRequest", "缺少 fileId");
                return;
            };
            let save_path = req_str(&v, "savePath");
            let c = ctx.clone();
            tokio::spawn(async move { serve_do_accept_file(c, id, file_id, save_path).await });
        }
        "reject_file" => {
            let Some(file_id) = req_str(&v, "fileId") else {
                ctx.reply_err(&id, "badRequest", "缺少 fileId");
                return;
            };
            let reason = req_str(&v, "reason");
            let c = ctx.clone();
            tokio::spawn(async move { serve_do_reject_file(c, id, file_id, reason).await });
        }
        other => ctx.reply_err(&id, "unsupportedCmd", &format!("未知命令 {other}")),
    }
}

// ---------------------------------------------------------- 命令实现

async fn serve_do_join(ctx: Arc<ServeCtx>, id: String, room: String, nickname: Option<String>) {
    // 与自动进房串行，避免两个 join 并发把核心的状态机搅乱
    let _guard = ctx.join_lock.lock().await;
    let nick = nickname.unwrap_or_else(|| ctx.default_nick.lock().unwrap().clone());
    // 核心进房自带 4×(20s)+退避 的重试，外层给足余量
    match tokio::time::timeout(Duration::from_secs(120), ctx.node.join(&room, &nick)).await {
        Ok(Ok(())) => ctx.reply_ok(&id, json!({"room": room})),
        Ok(Err(e)) => ctx.reply_err(&id, "joinFailed", &format!("{e:#}")),
        Err(_) => ctx.reply_err(&id, "joinFailed", "进房超时（核心已重试 4 次）"),
    }
}

async fn serve_do_say(ctx: Arc<ServeCtx>, id: String, text: String) {
    if text.len() > IPC_MAX_SAY_BYTES {
        ctx.reply_err(
            &id,
            "tooLarge",
            &format!("文本 {} 字节，超过上限 {IPC_MAX_SAY_BYTES}", text.len()),
        );
        return;
    }
    if ctx.node.current_room().is_none() {
        ctx.reply_err(&id, "notJoined", "还没进房间（先发 join）");
        return;
    }
    match ctx.node.send(&text).await {
        Ok(m) => ctx.reply_ok(&id, json!({"id": m.id, "ts": m.ts})),
        Err(e) => ctx.reply_err(&id, "internal", &format!("{e:#}")),
    }
}

async fn serve_do_send_file(
    ctx: Arc<ServeCtx>,
    id: String,
    path: PathBuf,
    name: Option<String>,
    mime: String,
) {
    let Some(room) = ctx.node.current_room() else {
        ctx.reply_err(&id, "notJoined", "还没进房间（先发 join）");
        return;
    };
    let Some(relay) = ctx.node.my_relay_url() else {
        ctx.reply_err(&id, "noRelay", "本端还没有可用中继地址");
        return;
    };
    // 整读算 blake3 可能几十秒（大文件）：丢到阻塞线程池，别占 runtime
    let key = ctx.key.clone();
    let hash_path = path.clone();
    let hashed =
        tokio::task::spawn_blocking(move || meta_for_file(&hash_path, &mime, &key, &relay)).await;
    let mut meta = match hashed {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => {
            ctx.reply_err(&id, "fileReadFailed", &format!("{e:#}"));
            return;
        }
        Err(e) => {
            ctx.reply_err(&id, "internal", &format!("哈希任务失败：{e}"));
            return;
        }
    };
    if let Some(n) = name {
        meta.name = n;
    }
    // 算哈希期间用户可能已切房（与核心 invite_file 的 expect_room 校验呼应）
    if ctx.node.current_room().as_deref() != Some(room.as_str()) {
        ctx.reply_err(&id, "roomMismatch", "算哈希期间房间已切换，本次发布取消");
        return;
    }
    ctx.files
        .lock()
        .unwrap()
        .insert(meta.file_id.clone(), (meta.clone(), path));
    ctx.set_files_now();
    match ctx.node.invite_file(&meta, &room).await {
        Ok(()) => ctx.reply_ok(
            &id,
            json!({
                "fileId": meta.file_id, "name": meta.name, "size": meta.size,
                "chunkSize": meta.chunk_size, "rootHash": meta.root_hash,
            }),
        ),
        Err(e) => {
            // 邀约没广播出去就不该留在货架上（否则心跳会广播一个没人能收的文件）
            ctx.files.lock().unwrap().remove(&meta.file_id);
            ctx.set_files_now();
            ctx.reply_err(&id, "internal", &format!("广播邀约失败：{e:#}"));
        }
    }
}

async fn serve_do_history(
    ctx: Arc<ServeCtx>,
    id: String,
    limit: Option<usize>,
    before: Option<String>,
) {
    let Some(room) = ctx.node.current_room() else {
        ctx.reply_err(&id, "notJoined", "还没进房间（先发 join）");
        return;
    };
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let before = match before.as_deref() {
        None => None,
        Some(s) => match s.split_once(':') {
            Some((ts, mid)) if !mid.is_empty() => match ts.parse::<u64>() {
                Ok(ts) => Some((ts, mid.to_string())),
                Err(_) => {
                    ctx.reply_err(&id, "badRequest", "before 游标格式应为 \"<ts>:<id>\"");
                    return;
                }
            },
            _ => {
                ctx.reply_err(&id, "badRequest", "before 游标格式应为 \"<ts>:<id>\"");
                return;
            }
        },
    };
    match ctx.node.fetch_history_before(&room, limit, before).await {
        Ok(resp) => {
            let value = serde_json::to_value(&resp).unwrap_or_else(|_| json!({}));
            ctx.reply_ok(&id, value);
        }
        Err(e) => ctx.reply_err(&id, "internal", &format!("{e:#}")),
    }
}

async fn serve_do_leave(ctx: Arc<ServeCtx>, id: String) {
    // 没进房时 leave_room 会直接返回（幂等）
    ctx.node.leave_room().await;
    ctx.reply_ok(&id, json!({}));
}

/// 接一个文件：拿邀约 meta → 登记接收 → 广播 Accept → 落盘 → 校验 → 回执。
///
/// 与浏览器接收流程完全同款（`accept_file` → `receive_file_data`），区别只在
/// sink：浏览器写 OPFS/文件句柄，这里写磁盘（`FileSink`，内存恒定）。
async fn serve_do_accept_file(
    ctx: Arc<ServeCtx>,
    id: String,
    file_id: String,
    save_path: Option<String>,
) {
    if ctx.node.current_room().is_none() {
        ctx.reply_err(&id, "notJoined", "还没进房间（先发 join）");
        return;
    }
    let Some((meta, room)) = ctx.invites.lock().unwrap().get(&file_id) else {
        ctx.reply_err(&id, "noInvite", "没有这个邀约（没收到过、或缓存已过期）");
        return;
    };
    if ctx.node.current_room().as_deref() != Some(room.as_str()) {
        ctx.reply_err(&id, "roomMismatch", &format!("邀约来自 {room}，当前不在该房间"));
        return;
    }
    if !ctx.accepting.lock().unwrap().insert(file_id.clone()) {
        ctx.reply_err(&id, "badRequest", "该文件正在接收中");
        return;
    }

    let result = serve_receive_file(&ctx, &meta, &room, save_path).await;
    ctx.accepting.lock().unwrap().remove(&file_id);

    match result {
        Ok((path, bytes)) => {
            ctx.invites.lock().unwrap().remove(&file_id);
            ctx.reply_ok(
                &id,
                json!({
                    "fileId": meta.file_id, "path": path.display().to_string(), "bytes": bytes,
                }),
            );
        }
        Err((code, message)) => ctx.reply_err(&id, &code, &message),
    }
}

/// 真正的接收流程（在 accept_file 的并发保护内执行）。
/// 返回 (落盘路径, 收到字节数)；错误是 (协议错误码, 人类可读消息)。
async fn serve_receive_file(
    ctx: &Arc<ServeCtx>,
    meta: &FileMeta,
    room: &str,
    save_path: Option<String>,
) -> Result<(PathBuf, u64), (String, String)> {
    let my_relay = ctx
        .node
        .my_relay_url()
        .ok_or_else(|| ("noRelay".to_string(), "本端没有可用中继地址".to_string()))?;
    let path = resolve_save_path(save_path, meta);
    let meta_json = serde_json::to_string(meta)
        .map_err(|e| ("internal".to_string(), format!("meta 序列化失败：{e}")))?;

    // ⚠️ 顺序：先登记（`accept_file` 内部完成 expect）再广播 Accept —— 反了数据会丢。
    //    have 传空位图：v1 不做断点续传（见 FileSink 注释）。
    let (rx, ack_tx) = ctx
        .node
        .accept_file(&meta.file_id, &meta_json, Vec::new(), &my_relay, room)
        .await
        .map_err(|e| ("internal".to_string(), format!("登记/广播 Accept 失败：{e:#}")))?;

    let sink = FileSink::open(&path, meta)
        .map_err(|e| ("fileReadFailed".to_string(), format!("打不开落盘路径：{e:#}")))?;
    ctx.emit_event(json!({
        "type": "fileRecvStarted",
        "fileId": meta.file_id, "peer": meta.sender, "room": room,
        "path": path.display().to_string(), "size": meta.size,
    }));

    let last = std::sync::Arc::new(std::sync::Mutex::new(0u64));
    let got = ctx
        .node
        .receive_file_data(meta, std::sync::Arc::new(sink), rx, ack_tx, {
            let ctx = ctx.clone();
            let last = last.clone();
            let fid = meta.file_id.clone();
            let peer = meta.sender.clone();
            move |done, total, bytes| {
                // 合并进度：每 64 块或结束时发一条（可丢事件，别把 stdout 淹了）
                let mut l = last.lock().unwrap();
                if done == total || done.saturating_sub(*l) >= 64 {
                    *l = done;
                    ctx.emit_progress_event(json!({
                        "type": "fileProgress", "fileId": fid, "peer": peer,
                        "direction": "recv", "doneChunks": done, "totalChunks": total, "bytes": bytes,
                    }));
                }
            }
        })
        .await;

    match got {
        Ok(bytes) => {
            ctx.emit_event(json!({
                "type": "fileRecvFinished", "fileId": meta.file_id, "peer": meta.sender,
                "path": path.display().to_string(), "bytes": bytes,
            }));
            Ok((path, bytes))
        }
        Err(e) => {
            ctx.emit_event(json!({
                "type": "fileRecvFailed", "fileId": meta.file_id, "peer": meta.sender,
                "reason": format!("{e:#}"),
            }));
            Err(("internal".to_string(), format!("接收失败：{e:#}")))
        }
    }
}

/// 拒绝一个文件（广播 Reject 带理由；房间核对防 F7）。
async fn serve_do_reject_file(
    ctx: Arc<ServeCtx>,
    id: String,
    file_id: String,
    reason: Option<String>,
) {
    if ctx.node.current_room().is_none() {
        ctx.reply_err(&id, "notJoined", "还没进房间（先发 join）");
        return;
    }
    let Some((_meta, room)) = ctx.invites.lock().unwrap().get(&file_id) else {
        ctx.reply_err(&id, "noInvite", "没有这个邀约（没收到过、或缓存已过期）");
        return;
    };
    if ctx.node.current_room().as_deref() != Some(room.as_str()) {
        ctx.reply_err(&id, "roomMismatch", &format!("邀约来自 {room}，当前不在该房间"));
        return;
    }
    let reason = reason.unwrap_or_else(|| "用户拒绝".to_string());
    match ctx.node.reject_file(&file_id, &reason, &room).await {
        Ok(()) => {
            ctx.invites.lock().unwrap().remove(&file_id);
            ctx.reply_ok(&id, json!({}));
        }
        Err(e) => ctx.reply_err(&id, "internal", &format!("广播 Reject 失败：{e:#}")),
    }
}

/// 落盘路径：`savePath` 是目录就拼文件名；没给就放 `<agent home>/received/`。
fn resolve_save_path(requested: Option<String>, meta: &FileMeta) -> PathBuf {
    let safe_name = sanitize_file_name(&meta.name);
    match requested {
        Some(p) if !p.trim().is_empty() => {
            let path = PathBuf::from(p);
            if path.is_dir() {
                path.join(safe_name)
            } else {
                path
            }
        }
        _ => home().join("received").join(safe_name),
    }
}

/// 只取 basename、去控制字符 —— 文件名来自对端，**不能**让它带路径分量（防穿越）。
fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("file").trim();
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "file".to_string()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------- 事件转发（stdout）

/// 订阅 RoomEvent，转成协议事件；顺带做两件自动动作（与浏览器 Worker 对齐）：
/// - `fileAccepted` → 自动开始推送（cmd_watch 同款）
/// - `fileQueryAsked` → 自动重发一次邀约（agent 原来缺这个行为）
async fn serve_forward_events(ctx: Arc<ServeCtx>) {
    let mut events = Box::pin(ctx.node.subscribe());
    while let Some(ev) = events.next().await {
        let mut json_ev = match serde_json::to_value(&ev) {
            Ok(v) => v,
            Err(e) => {
                warn!("事件序列化失败（丢弃）：{e}");
                continue;
            }
        };
        match &ev {
            RoomEvent::Joined { room } => {
                // 换房 = 清空货架（文件归属按房间隔离 —— F7 那类缺陷的教训）。
                // 同房间重复 join（只更新昵称）不清。
                let cleared = {
                    let mut last = ctx.last_room.lock().unwrap();
                    let cleared = if last.as_deref().map_or(false, |prev| prev != room) {
                        let mut files = ctx.files.lock().unwrap();
                        let ids: Vec<String> = files.keys().cloned().collect();
                        files.clear();
                        ids
                    } else {
                        Vec::new()
                    };
                    *last = Some(room.clone());
                    cleared
                };
                if !cleared.is_empty() {
                    ctx.set_files_now();
                    if let Some(obj) = json_ev.as_object_mut() {
                        obj.insert("clearedFiles".into(), json!(cleared));
                    }
                }
            }
            RoomEvent::FileAccepted {
                file_id,
                have,
                receiver_relay,
                by,
                room,
            } => {
                serve_start_push(&ctx, file_id, have, receiver_relay, by, room);
            }
            RoomEvent::FileInvite { room, meta } => {
                // 存下来供 accept_file 用（有上限的缓存；meta 完整才可能通过授权核对）
                ctx.invites
                    .lock()
                    .unwrap()
                    .put(meta.clone(), room.clone());
            }
            RoomEvent::FileQueryAsked { room, file_id, .. } => {
                // 有人点了历史卡片问文件：手里还有就重播一次邀约（只在同一房间）
                let entry = ctx.files.lock().unwrap().get(file_id).cloned();
                if let Some((meta, _path)) = entry {
                    let node = ctx.node.clone();
                    let room = room.clone();
                    tokio::spawn(async move {
                        if node.current_room().as_deref() == Some(room.as_str()) {
                            if let Err(e) = node.invite_file(&meta, &room).await {
                                warn!("重发邀约失败：{e:#}");
                            }
                        }
                    });
                }
            }
            _ => {}
        }
        ctx.emit_event(json_ev);
    }
    // 事件流结束 = 端点死了（degraded）。这是不可恢复的，按协议发 fatal 后退出。
    ctx.emit_event(json!({"type": "fatal", "reason": "事件流已结束"}));
    tokio::time::sleep(Duration::from_millis(250)).await; // 尽量让 fatal 刷出去
    std::process::exit(3);
}

/// 收到某人的 `fileAccepted`：把文件推给他。进度走可丢事件；失败尽力告知。
fn serve_start_push(
    ctx: &Arc<ServeCtx>,
    file_id: &str,
    have: &str,
    receiver_relay: &str,
    by: &str,
    room: &str,
) {
    let Some((meta, path)) = ctx.files.lock().unwrap().get(file_id).cloned() else {
        return;
    };
    // 控制消息带着来源房间；不对其他房间的卡片动手（F7）
    if ctx.node.current_room().as_deref() != Some(room) {
        warn!("丢弃跨房间的 fileAccepted（事件来自 {room}）");
        return;
    }
    let c = ctx.clone();
    let fid = file_id.to_string();
    let peer = by.to_string();
    let relay = receiver_relay.to_string();
    let have = bitmap_from_b64(have);
    tokio::spawn(async move {
        let src = FileSource::new(path);
        let result = c
            .node
            .send_file_data(&meta, &peer, &relay, &src, have, |sev| {
                use iroh_web::filetransfer::SendEvent;
                let event = match sev {
                    SendEvent::Started { need } => {
                        json!({"type":"fileSendStarted","fileId":fid,"peer":peer,"needChunks":need.len()})
                    }
                    SendEvent::Progress { done, total, bytes } => {
                        json!({"type":"fileProgress","fileId":fid,"peer":peer,"direction":"send","doneChunks":done,"totalChunks":total,"bytes":bytes})
                    }
                    SendEvent::Finished => {
                        json!({"type":"fileSendFinished","fileId":fid,"peer":peer})
                    }
                    SendEvent::Failed { reason } => {
                        json!({"type":"fileSendFailed","fileId":fid,"peer":peer,"reason":reason})
                    }
                    // Ack 与 gossip 的 fileDone 重复，不单独暴露（协议 §6b）
                    SendEvent::Ack { .. } => return,
                };
                c.emit_progress_event(event);
            })
            .await;
        if let Err(e) = result {
            warn!("推送 {fid} 给 {peer} 失败：{e:#}");
            c.emit_progress_event(
                json!({"type":"fileSendFailed","fileId":fid,"peer":peer,"reason":format!("{e:#}")}),
            );
        }
    });
}

// ---------------------------------------------------------- stdin / 信号 / 主循环

/// stdin 逐行读（独立线程：cli feature 没开 tokio 的 io 特性，不能用异步读）。
/// 读到 EOF 就关闭通道 —— 主循环把"通道关闭"当作退出信号（防孤儿）。
fn spawn_stdin_lines() -> tokio::sync::mpsc::UnboundedReceiver<String> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.lock().read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let t = line.trim().to_string();
                    if t.is_empty() {
                        continue;
                    }
                    if tx.send(t).is_err() {
                        break;
                    }
                }
            }
        }
    });
    rx
}

/// SIGINT / SIGTERM → 退出信号（跨平台：ctrl_c；unix 另加 SIGTERM，systemd/docker stop 发它）。
fn spawn_signal_watcher(stop_tx: tokio::sync::mpsc::Sender<String>) {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            match signal(SignalKind::terminate()) {
                Ok(mut term) => {
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => { let _ = stop_tx.send("收到 SIGINT".into()).await; }
                        _ = term.recv() => { let _ = stop_tx.send("收到 SIGTERM".into()).await; }
                    }
                }
                Err(e) => {
                    warn!("监听 SIGTERM 失败（仍监听 SIGINT）：{e}");
                    if tokio::signal::ctrl_c().await.is_ok() {
                        let _ = stop_tx.send("收到 SIGINT".into()).await;
                    }
                }
            }
        }
        #[cfg(not(unix))]
        {
            if tokio::signal::ctrl_c().await.is_ok() {
                let _ = stop_tx.send("收到中断信号".to_string()).await;
            }
        }
    });
}

/// 有 `--room` 时的自动进房：不阻塞命令循环；失败只发 error 事件（没有命令 id 可回）。
fn serve_spawn_auto_join(ctx: Arc<ServeCtx>, room: String) {
    tokio::spawn(async move {
        let _guard = ctx.join_lock.lock().await;
        let nick = ctx.default_nick.lock().unwrap().clone();
        match tokio::time::timeout(Duration::from_secs(120), ctx.node.join(&room, &nick)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => ctx.emit_event(
                json!({"type":"error","message":format!("自动进房失败：{e:#}")}),
            ),
            Err(_) => ctx.emit_event(
                json!({"type":"error","message":"自动进房超时（核心已重试 4 次）"}),
            ),
        }
    });
}

/// `serve` 主入口：起节点 → hello → 事件转发 + 命令循环 → 优雅退出。
async fn cmd_serve(cfg: &Config, key: &SecretKey, auto_room: &str) -> Result<()> {
    let out = Out::start();

    let node = match start_node(cfg, key).await {
        Ok(n) => n,
        Err(e) => {
            // 启动失败也要走协议告知（TS 看得到原因，而不是只留下 stderr）
            out.emit(json!({
                "v": IPC_VERSION, "type": "event", "seq": 0,
                "event": {"type": "fatal", "reason": format!("{e:#}")},
            }));
            tokio::time::sleep(Duration::from_millis(100)).await;
            return Err(e);
        }
    };

    // 协议握手的第一行：hello
    let relay = node
        .my_relay_url()
        .map(|url| json!({"url": url, "connected": true}));
    out.emit(json!({
        "v": IPC_VERSION,
        "type": "hello",
        "agent": format!("iroh-agent/{}", env!("CARGO_PKG_VERSION")),
        "endpointId": node.endpoint_id(),
        "chatProtocol": iroh_web::sigfmt::PROTO_V5,
        "nickname": cfg.nickname,
        "relay": relay,
    }));

    let (stop_tx, mut stop_rx) = tokio::sync::mpsc::channel::<String>(8);
    let ctx = Arc::new(ServeCtx {
        node: node.clone(),
        key: key.clone(),
        out: out.clone(),
        seq: AtomicU64::new(0),
        started: Instant::now(),
        files: Mutex::new(HashMap::new()),
        invites: Mutex::new(Invites {
            map: HashMap::new(),
            order: VecDeque::new(),
        }),
        accepting: Mutex::new(HashSet::new()),
        default_nick: Mutex::new(cfg.nickname.clone()),
        last_room: Mutex::new(None),
        inflight: Mutex::new(HashSet::new()),
        stop_tx: stop_tx.clone(),
        join_lock: tokio::sync::Mutex::new(()),
    });

    tokio::spawn(serve_forward_events(ctx.clone()));
    spawn_signal_watcher(stop_tx);
    if !auto_room.is_empty() {
        serve_spawn_auto_join(ctx.clone(), auto_room.to_string());
    }

    // 命令循环：stdin 一行一条；EOF / shutdown 命令 / 信号都会退出
    let reason = {
        let mut lines = spawn_stdin_lines();
        loop {
            // biased：显式退出（shutdown/信号）优先于 EOF —— 否则"shutdown 后调用方
            // 立刻关管道"这种正常收尾会随机把退出原因记成"stdin 已关闭"（实测踩到）。
            tokio::select! {
                biased;
                r = stop_rx.recv() => break r.unwrap_or_else(|| "shutdown".to_string()),
                line = lines.recv() => match line {
                    Some(line) => serve_handle_line(&ctx, line),
                    None => break "stdin 已关闭".to_string(),
                },
            }
        }
    };
    info!("serve 退出：{reason}");

    // 优雅退出：leave → close → bye → 退出
    let _ = tokio::time::timeout(Duration::from_secs(5), ctx.node.leave_room()).await;
    ctx.node.shutdown();
    tokio::time::sleep(Duration::from_millis(300)).await;
    ctx.emit_event(json!({"type": "bye", "reason": reason}));
    tokio::time::sleep(Duration::from_millis(150)).await; // 给写线程留出刷盘时间
    Ok(())
}

// ============================================================ main

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    if matches!(args.cmd.as_str(), "help" | "-h" | "--help") {
        println!("{USAGE}");
        return Ok(());
    }

    // ⚠️ serve 的 stdout 是**协议流**：日志必须走 stderr —— tracing 默认输出 stdout，
    //    与行协议冲突（一行日志就污染协议）。这个分流必须在 init 时决定。
    if args.cmd == "serve" {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
            )
            .with_target(false)
            .with_writer(std::io::stderr)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
            )
            .with_target(false)
            .init();
    }

    let cfg = load_config();
    let key = load_or_create_identity(args.cmd == "serve")?;

    if args.cmd == "whoami" {
        return cmd_whoami(&cfg, &key).await;
    }

    // serve 自己管进房（`--room` 只是"自动进房"的输入，可为空 = 等 join 命令）
    if args.cmd == "serve" {
        let cfg = Config {
            nickname: args.nick.clone().unwrap_or(cfg.nickname),
            ..cfg
        };
        return cmd_serve(&cfg, &key, &args.room).await;
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
