//! roomtest · 原生进房测试（排除浏览器这个变量）
//!
//! 用途：用同一份 `RoomNode` 逻辑，在原生环境下进房间并观察
//!   1) 中继连接（含 token 鉴权）
//!   2) 常驻节点（anchor）可达性
//!   3) 历史消息拉取
//!   4) 在线成员（presence）
//!
//! 用法：
//!   ROOMTEST_RELAYS=https://iroh1.editor.vip:15443 \
//!   ROOMTEST_TOKEN=xxx \
//!   ROOMTEST_ANCHOR_ID=5bcc... \
//!   ROOMTEST_ANCHOR_RELAY=https://iroh1.editor.vip:15443 \
//!   ROOMTEST_ROOM=lobby ROOMTEST_SECONDS=40 \
//!   ./roomtest

use std::time::Duration;

use iroh_web::room::{RoomEvent, RoomNode, RoomOptions};
use n0_future::StreamExt;

fn env_or(name: &str, def: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| def.to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let relays: Vec<String> = env_or("ROOMTEST_RELAYS", "https://iroh1.editor.vip:15443")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let room = env_or("ROOMTEST_ROOM", "lobby");
    let nick = env_or("ROOMTEST_NICK", "native-tester");
    let seconds: u64 = env_or("ROOMTEST_SECONDS", "40").parse().unwrap_or(40);
    let token = std::env::var("ROOMTEST_TOKEN").ok().filter(|t| !t.is_empty());
    let anchor_id = std::env::var("ROOMTEST_ANCHOR_ID").ok().filter(|t| !t.is_empty());
    let anchor_relay = std::env::var("ROOMTEST_ANCHOR_RELAY").ok().filter(|t| !t.is_empty());

    println!("=== 配置 ===");
    println!("中继      : {relays:?}");
    println!("token     : {}", token.as_ref().map(|_| "已提供").unwrap_or("无"));
    println!("房间      : {room}");
    println!("anchor id : {}", anchor_id.as_deref().unwrap_or("（无）"));
    println!("anchor 中继: {}", anchor_relay.as_deref().unwrap_or("（无）"));

    let node = RoomNode::start(RoomOptions {
        relays,
        relay_token: token,
        secret_key_hex: None,
        anchor_id,
        anchor_relay,
        history_dir: None,
        serve_history: false,
    })
    .await?;

    println!("\n=== 我的身份 ===");
    println!("{}", node.endpoint_id());

    println!("\n=== 等中继握手（最多 20s）===");
    match tokio::time::timeout(Duration::from_secs(20), node.online()).await {
        Ok(()) => println!("✅ 已连上至少一台中继"),
        Err(_) => {
            println!("❌ 20s 内没有中继完成握手");
            for r in node.relay_status() {
                println!("   {} connected={} err={:?} denied={:?}", r.url, r.connected, r.last_error, r.auth_denied);
            }
            return Ok(());
        }
    }
    for r in node.relay_status() {
        println!("   {} connected={} denied={:?}", r.url, r.connected, r.auth_denied);
    }

    // 事件消费
    let events = node.subscribe();
    let handle = tokio::spawn(async move {
        // async_channel 的 Stream 需要 pin 住（不是 Unpin）
        let events = events;
        n0_future::pin!(events);
        while let Some(ev) = events.next().await {
            match ev {
                RoomEvent::Joined { room } => println!("[事件] 已进入房间 {room}"),
                RoomEvent::Message { message, mine, .. } => {
                    println!("[消息] {}{}: {}", if mine { "(我) " } else { "" }, message.nickname, message.text)
                }
                RoomEvent::Presence { peers, .. } => {
                    let names: Vec<String> = peers.iter().map(|p| p.nickname.clone()).collect();
                    println!("[在线] {} 人: {:?}", names.len(), names);
                }
                RoomEvent::PeerUp { id } => println!("[邻居上线] {id}"),
                RoomEvent::PeerDown { id } => println!("[邻居下线] {id}"),
                RoomEvent::History { messages, .. } => println!("[历史] {} 条", messages.len()),
                RoomEvent::RelayStatus { relays } => {
                    for r in relays {
                        println!("[中继] {} connected={} denied={:?}", r.url, r.connected, r.auth_denied);
                    }
                }
                RoomEvent::Error { message } => println!("[错误] {message}"),
                RoomEvent::FileInvite { meta, .. } => {
                    println!("[文件邀约] {} ({} 字节, id={})", meta.name, meta.size, meta.file_id)
                }
                RoomEvent::FileAccepted { file_id, .. } => println!("[文件已接受] {file_id}"),
                RoomEvent::FileRejected { file_id, reason, .. } => {
                    println!("[文件被拒] {file_id}: {reason}")
                }
                RoomEvent::FileDone { file_id, ok, reason, .. } => {
                    println!("[文件结束] {file_id} ok={ok} {reason}")
                }
                RoomEvent::FileProgress { file_id, direction, done_chunks, total_chunks, .. } => {
                    println!("[进度] {file_id} {direction} {done_chunks}/{total_chunks}")
                }
                // 有人问"你还能提供这个文件吗"（点了历史里的文件卡片）。
                // 这个 CLI 不做文件传输，忽略即可。
                RoomEvent::FileQueryAsked { file_id, .. } => {
                    println!("[被问及文件] {file_id}")
                }
            }
        }
    });

    println!("\n=== 进房间「{room}」（含 anchor 唤醒 + subscribe_and_join，最多约 90s）===");
    let joined = tokio::time::timeout(Duration::from_secs(100), node.join(&room, &nick)).await;
    match joined {
        Ok(Ok(())) => println!("✅ join() 成功"),
        Ok(Err(e)) => println!("❌ join() 失败: {e:#}"),
        Err(_) => println!("❌ join() 100s 超时"),
    }

    println!("\n=== 观察 {seconds}s ===");
    tokio::time::sleep(Duration::from_secs(seconds)).await;

    println!("\n=== 主动拉一次历史 ===");
    match tokio::time::timeout(Duration::from_secs(25), node.fetch_history(&room, 20)).await {
        Ok(Ok(msgs)) => {
            println!("✅ 历史 {} 条", msgs.messages.len());
            for m in msgs.messages.iter().take(5) {
                println!("   {} : {}", m.nickname, m.text);
            }
        }
        Ok(Err(e)) => println!("❌ 拉历史失败: {e:#}"),
        Err(_) => println!("❌ 拉历史 25s 超时"),
    }

    println!("\n=== 发一条消息试试 ===");
    match tokio::time::timeout(Duration::from_secs(15), node.send("hello from native roomtest")).await {
        Ok(Ok(m)) => println!("✅ 已广播，id={} ts={}", m.id, m.ts),
        Ok(Err(e)) => println!("❌ 发送失败: {e:#}"),
        Err(_) => println!("❌ 发送 15s 超时"),
    }

    // 大消息测试：证明 max_message_size 确实放宽了（默认只有 4KB）
    if let Ok(kb) = std::env::var("ROOMTEST_BIG_KB").map(|v| v.parse::<usize>().unwrap_or(0)) {
        if kb > 0 {
            let size = kb * 1024;
            println!("\n=== 大消息测试：{kb}KB ===");
            let payload = "X".repeat(size);
            let t0 = std::time::Instant::now();
            match tokio::time::timeout(Duration::from_secs(60), node.send(&payload)).await {
                Ok(Ok(m)) => println!(
                    "✅ {kb}KB 发送成功，耗时 {:?}，id={}",
                    t0.elapsed(),
                    m.id
                ),
                Ok(Err(e)) => println!("❌ {kb}KB 发送失败: {e:#}"),
                Err(_) => println!("❌ {kb}KB 发送 60s 超时"),
            }
            // 再拉一次历史，确认真的进了房间（并且经过了常驻节点）
            tokio::time::sleep(Duration::from_secs(3)).await;
            match tokio::time::timeout(Duration::from_secs(30), node.fetch_history(&room, 5)).await {
                Ok(Ok(msgs)) => {
                    let big = msgs.messages.iter().find(|m| m.text.len() >= size);
                    match big {
                        Some(m) => println!("✅ 历史里能查到这条大消息（长度 {} 字节）", m.text.len()),
                        None => println!(
                            "⚠️ 历史里没找到大消息（最近 {} 条里最大 {} 字节）",
                            msgs.messages.len(),
                            msgs.messages.iter().map(|m| m.text.len()).max().unwrap_or(0)
                        ),
                    }
                }
                Ok(Err(e)) => println!("❌ 拉历史失败: {e:#}"),
                Err(_) => println!("❌ 拉历史超时"),
            }
        }
    }

    tokio::time::sleep(Duration::from_secs(3)).await;
    handle.abort();
    node.shutdown();
    println!("\n=== 结束 ===");
    Ok(())
}
