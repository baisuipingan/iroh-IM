//! filetest · 原生端到端文件传输测试（两个进程互传）
//!
//! 用来在**套浏览器 UI 之前**把协议验通。两个进程在同一个房间里，
//! 一个当发送方，一个当接收方。
//!
//! ## 用法
//!
//! 接收方（先起）：
//! ```bash
//! FILETEST_ROLE=recv FILETEST_ROOM=fx FILETEST_OUT=/tmp/recv.bin ./filetest
//! ```
//! 发送方：
//! ```bash
//! FILETEST_ROLE=send FILETEST_ROOM=fx FILETEST_IN=/tmp/src.bin ./filetest
//! ```
//!
//! 环境变量：
//! - `FILETEST_RELAYS`   中继列表（默认 iroh1）
//! - `FILETEST_TOKEN`    中继 token
//! - `FILETEST_ROOM`     房间名（默认 filetest）
//! - `FILETEST_ANCHOR_ID` / `FILETEST_ANCHOR_RELAY`  常驻节点（用于 bootstrap）
//! - `FILETEST_SECONDS`  最长等待秒数（默认 180）
//! - `FILETEST_MAKE_MB`  发送方：若不给 `FILETEST_IN`，就现场生成这么大（MB）的随机文件
//! - `FILETEST_OUT`      接收方：落盘路径
//! - `FILETEST_RESUME`   接收方：若目标文件已存在，把已有部分当作"已收块"（测断点续传）

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use iroh::SecretKey;
use iroh_web::filetransfer::{bitmap_from_b64, bitmap_new, bitmap_set, chunk_count, hex_encode, FileMeta};
use iroh_web::room::{RoomEvent, RoomNode, RoomOptions};
use iroh_web::transfer_orchestrator::{meta_for_bytes, BytesSink, BytesSource};
use n0_future::StreamExt;

fn env_or(name: &str, def: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| def.to_string())
}
fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// 生成伪随机数据（可压缩性差，能暴露分块错误；用简单 LCG 避免额外依赖）
fn make_data(size: usize, seed: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(size);
    let mut x = seed | 1;
    for _ in 0..size {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        out.push((x >> 33) as u8);
    }
    out
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let role = env_or("FILETEST_ROLE", "send");
    let room = env_or("FILETEST_ROOM", "filetest");
    let seconds: u64 = env_or("FILETEST_SECONDS", "180").parse().unwrap_or(180);
    let relays: Vec<String> = env_or("FILETEST_RELAYS", "https://iroh1.editor.vip:15443")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let node = RoomNode::start(RoomOptions {
        relays,
        relay_token: env_opt("FILETEST_TOKEN"),
        secret_key_hex: None,
        anchor_id: env_opt("FILETEST_ANCHOR_ID"),
        anchor_relay: env_opt("FILETEST_ANCHOR_RELAY"),
        history_dir: None,
        rendezvous_id: None,
        rendezvous_relay: None,
        history_id: None,
        history_relay: None,
        serve_history: false,
        serve_rendezvous: false,
        join_timeout_ms: None,
    })
    .await?;

    println!("=== filetest · role={role} ===");
    println!("我的身份 : {}", node.endpoint_id());
    println!("房间     : {room}");

    tokio::time::timeout(Duration::from_secs(20), node.online())
        .await
        .context("等待中继握手超时")?;
    println!("✅ 已连上中继，本端中继地址 = {:?}", node.my_relay_url());

    // 事件消费
    let events = node.subscribe();
    let handle = tokio::spawn(async move {
        let events = events;
        n0_future::pin!(events);
        while let Some(ev) = events.next().await {
            match ev {
                RoomEvent::FileInvite { meta, .. } => {
                    println!(
                        "[事件] 收到文件邀约：{} ({} 字节, {} 块) id={}",
                        meta.name,
                        meta.size,
                        chunk_count(meta.size, meta.chunk_size),
                        meta.file_id
                    );
                }
                RoomEvent::FileAccepted { file_id, by, .. } => {
                    println!("[事件] 对方已接受 {file_id}（by {}）", &by[..8.min(by.len())]);
                }
                RoomEvent::FileRejected { file_id, reason, .. } => {
                    println!("[事件] 对方拒绝 {file_id}: {reason}");
                }
                RoomEvent::FileDone { file_id, ok, reason, .. } => {
                    println!("[事件] 传输结束 {file_id} ok={ok} {reason}");
                }
                _ => {}
            }
        }
    });

    // 进房间（anchor 不存在时也能靠房间名+已在线成员构成 swarm；
    // 单进程测试时会退化为"只有自己"，所以这条用例需要两个进程同时在线）
    match tokio::time::timeout(Duration::from_secs(100), node.join(&room, &role)).await {
        Ok(Ok(())) => println!("✅ 已进入房间 {room}"),
        Ok(Err(e)) => println!("⚠️ 进房间失败（可能是没有 anchor）: {e:#}"),
        Err(_) => println!("⚠️ 进房间超时（可能是没有 anchor）"),
    }

    let res = if role == "recv" {
        run_receiver(&node, seconds, &room).await
    } else {
        run_sender(&node, seconds, &room).await
    };

    handle.abort();
    node.shutdown();
    match res {
        Ok(msg) => {
            println!("\n✅ {msg}");
            Ok(())
        }
        Err(e) => {
            println!("\n❌ 失败：{e:#}");
            std::process::exit(1);
        }
    }
}

/// 接收方：等邀约 → 自动接受 → 落盘 → 校验 → 回报
async fn run_receiver(node: &RoomNode, seconds: u64, room: &str) -> Result<String> {
    let out = PathBuf::from(env_or("FILETEST_OUT", "/tmp/filetest-recv.bin"));
    let resume = std::env::var("FILETEST_RESUME").is_ok();

    println!("\n=== 接收方就绪，等待邀约（最多 {seconds}s）===");
    println!("落盘路径 : {}", out.display());

    let events = node.subscribe();
    n0_future::pin!(events); // async_channel 的 Stream 不是 Unpin，必须 pin
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);

    loop {
        let ev = tokio::time::timeout_at(deadline, events.next())
            .await
            .context("等待邀约超时")?
            .context("事件流已结束")?;

        let meta = match ev {
            RoomEvent::FileInvite { meta, .. } => meta,
            _ => continue,
        };

        println!("\n收到邀约：{} ({} 字节)", meta.name, meta.size);
        let n = chunk_count(meta.size, meta.chunk_size);

        // 断点续传：如果目标文件已存在且是同一个文件，就把已有的完整块标记为"已有"
        let mut have = bitmap_new(n);
        let mut preloaded: Vec<u8> = Vec::new();
        if resume && out.exists() {
            let existing = std::fs::read(&out).unwrap_or_default();
            if !existing.is_empty() && existing.len() as u64 <= meta.size {
                preloaded = existing;
                let full = preloaded.len() as u64 / meta.chunk_size as u64;
                for i in 0..full as usize {
                    bitmap_set(&mut have, i);
                }
                println!(
                    "断点续传：本地已有 {} 字节（{} 个完整块），将从第 {} 块继续",
                    preloaded.len(),
                    full,
                    full
                );
            }
        }

        let my_relay = node.my_relay_url().context("本端没有可用中继地址")?;
        // ⚠️ 必须传完整 meta：接收侧要靠 meta.sender 核对"连上来的到底是不是
        //    真正的发送方"（只给 file_id 等于放弃授权）。
        let (rx, ack_tx) = node
            .accept_file(
                &meta.file_id,
                &serde_json::to_string(&meta)?,
                have.clone(),
                &my_relay,
                &room,
            )
            .await?;
        println!("✅ 已接受，等待发送方拨号传数据…");

        // sink：把已预载的部分放进内存，后续块按偏移写入
        let mut initial = preloaded.clone();
        initial.resize(meta.size as usize, 0);
        let sink = Arc::new(BytesSink {
            data: tokio::sync::Mutex::new(initial),
            size: meta.size,
            root_hash: meta.root_hash.clone(),
            chunk_size: meta.chunk_size,
        });

        let t0 = std::time::Instant::now();
        let last = std::sync::Arc::new(std::sync::Mutex::new((0u64, 0u64)));
        let last_c = last.clone();
        let r = node
            .receive_file_data(
                &meta,
                sink.clone(),
                rx,
                ack_tx.clone(),
                move |done, total, bytes| {
                    // 每 1% 或每 64 块打一次，避免刷屏
                    let mut l = last_c.lock().unwrap();
                    if done == total || done - l.0 >= 64.max(total / 100) {
                        println!(
                            "  进度 {done}/{total} 块（{}）",
                            iroh_web::filetransfer::human_size(bytes)
                        );
                        *l = (done, bytes);
                    }
                },
            )
            .await;

        match r {
            Ok(bytes) => {
                // 落盘
                let data = sink.data.lock().await;
                if let Some(dir) = out.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                std::fs::write(&out, &data[..])?;
                let got = hex_encode(&blake3::hash(&data[..]).as_bytes()[..]);
                println!("   实际写入 {} 字节", data.len());
                println!("   根哈希  发送方={}…", &meta.root_hash[..16.min(meta.root_hash.len())]);
                println!("   根哈希  本地  ={}…", &got[..16.min(got.len())]);
                return Ok(format!(
                    "接收完成：{} 字节 → {}（耗时 {:?}）",
                    bytes,
                    out.display(),
                    t0.elapsed()
                ));
            }
            Err(e) => return Err(e),
        }
    }
}

/// 发送方：生成/读取文件 → 邀约 → 等 Accept → 传数据
async fn run_sender(node: &RoomNode, seconds: u64, room: &str) -> Result<String> {
    let (data, name) = if let Some(p) = env_opt("FILETEST_IN") {
        let d = std::fs::read(&p).with_context(|| format!("读不到 {p}"))?;
        let n = PathBuf::from(&p)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "file.bin".into());
        (d, n)
    } else {
        let mb: usize = env_or("FILETEST_MAKE_MB", "8").parse().unwrap_or(8);
        let size = mb * 1024 * 1024;
        println!("\n现场生成 {mb}MB 测试数据（伪随机，可压缩性差）…");
        (make_data(size, 0x1234_5678_9abc_def0), "generated.bin".into())
    };
    let n_chunks = chunk_count(data.len() as u64, iroh_web::filetransfer::CHUNK_SIZE);
    println!("\n=== 发送方 ===");
    println!("文件     : {name}");
    println!("大小     : {}（{} 字节，{} 块）", iroh_web::filetransfer::human_size(data.len() as u64), data.len(), n_chunks);

    let my_relay = node.my_relay_url().context("本端没有可用中继地址")?;
    let meta: FileMeta = meta_for_bytes(&name, "application/octet-stream", &data, &SecretKey::generate(), &my_relay);
    // 注意：meta_for_bytes 里用自己的临时 key 算 sender，这里改成真实身份
    let meta = FileMeta {
        sender: node.endpoint_id(),
        ..meta
    };

    println!("广播邀约 id={} 根哈希={}…", meta.file_id, &meta.root_hash[..16]);
    // 也要传房间：核对"发起时意图的房间 == 当前房间"（报告 P1-7）
    node.invite_file(&meta, &room).await?;

    // 等对方 Accept
    println!("等待对方接受（最多 {seconds}s）…");
    let events = node.subscribe();
    n0_future::pin!(events);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    let (peer_id, peer_relay, have) = loop {
        let ev = tokio::time::timeout_at(deadline, events.next())
            .await
            .context("等待 Accept 超时")?
            .context("事件流结束")?;
        match ev {
            RoomEvent::FileAccepted {
                file_id,
                have,
                receiver_relay,
                by,
                ..
            } if file_id == meta.file_id => {
                let have_bytes = bitmap_from_b64(&have);
                break (by, receiver_relay, have_bytes);
            }
            RoomEvent::FileRejected { file_id, reason, .. } if file_id == meta.file_id => {
                anyhow::bail!("对方拒绝：{reason}");
            }
            _ => {}
        }
    };

    println!("✅ 对方已接受：id={} relay={}", &peer_id[..8], peer_relay);
    let src = BytesSource { data };
    let t0 = std::time::Instant::now();
    let sent = node
        .send_file_data(&meta, &peer_id, &peer_relay, &src, have, |ev| match ev {
            iroh_web::filetransfer::SendEvent::Progress { done, total, bytes } => {
                println!("  进度 {done}/{total} 块（{}）", iroh_web::filetransfer::human_size(bytes));
            }
            iroh_web::filetransfer::SendEvent::Ack { ok, reason } => {
                println!("  对方回执：ok={ok} {reason}");
            }
            _ => {}
        })
        .await?;

    Ok(format!(
        "发送完成：{} 字节（耗时 {:?}，速率 {}）",
        sent,
        t0.elapsed(),
        {
            let secs = t0.elapsed().as_secs_f64().max(0.001);
            format!("{}/s", iroh_web::filetransfer::human_size((sent as f64 / secs) as u64))
        }
    ))
}
