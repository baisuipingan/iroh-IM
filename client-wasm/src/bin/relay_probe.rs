//! 原生验证客户端：在服务器上验证自建中继舰队（浏览器路径无法覆盖的 HTTPS/QAD 场景）。
//!
//! 用法：
//!   relay-probe <relay-url> [<relay-url>...]                          # 只连接并打印中继状态
//!   relay-probe <relay-url>... --listen <secs>                        # 常驻监听，打印收到的消息
//!   relay-probe <relay-url>... --dial <peer-id-hex>@<peer-relay-url> --text "hi"   # 发一条消息
//!
//! 例：中继舰队连通性
//!   relay-probe https://iroh1.editor.vip:8443 https://iroh2.editor.vip:8443
//! 例：跨中继投递（发送端在中继 B，对端在中继 A）
//!   relay-probe https://iroh2.editor.vip:8443 --dial <id>@https://iroh1.editor.vip:8443 --text hello

use std::time::Duration;

use anyhow::{bail, Context, Result};
use iroh_web::node::{NodeEvent, NodeOptions, WebNode};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut relays = Vec::new();
    let mut dial: Option<(String, String)> = None;
    let mut text = "hello from relay-probe".to_string();
    let mut listen_secs: u64 = 0;
    let mut online_timeout: u64 = 20;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--dial" => {
                let spec = args.get(i + 1).context("--dial 需要 <peer-id>@<relay-url>")?;
                let (id, relay) = spec
                    .split_once('@')
                    .context("--dial 格式应为 <peer-id>@<relay-url>")?;
                dial = Some((id.to_string(), relay.to_string()));
                i += 2;
            }
            "--text" => {
                text = args.get(i + 1).context("--text 需要内容")?.clone();
                i += 2;
            }
            "--listen" => {
                listen_secs = args
                    .get(i + 1)
                    .context("--listen 需要秒数")?
                    .parse()
                    .context("--listen 需要数字")?;
                i += 2;
            }
            "--timeout" => {
                online_timeout = args.get(i + 1).context("--timeout 需要秒数")?.parse()?;
                i += 2;
            }
            other if other.starts_with("--") => bail!("未知参数: {other}"),
            url => {
                relays.push(url.to_string());
                i += 1;
            }
        }
    }
    if relays.is_empty() {
        bail!("至少给一个中继 URL");
    }

    println!("== 中继名单 ==");
    for r in &relays {
        println!("   {r}");
    }

    let node = WebNode::start(NodeOptions::new(relays)).await?;
    println!("== 本节点 ID ==\n   {}", node.endpoint_id());

    // 事件打印
    {
        let rx = node.subscribe();
        tokio::spawn(async move {
            while let Ok(ev) = rx.recv().await {
                match ev {
                    NodeEvent::RelayStatus { relays } => {
                        let s = relays
                            .iter()
                            .map(|r| {
                                format!(
                                    "{} {}",
                                    r.url,
                                    if r.connected { "connected" } else { "NOT-connected" }
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(" | ");
                        println!("[relay] {s}");
                    }
                    NodeEvent::PeerConnected { from } => println!("[peer ] 连入 {from}"),
                    NodeEvent::Message { from, text } => {
                        println!("[msg  ] ← {}: {text}", &from[..12.min(from.len())])
                    }
                    NodeEvent::Error { message } => println!("[error] {message}"),
                }
            }
        });
    }

    print!("== 等待中继握手 ==");
    match tokio::time::timeout(Duration::from_secs(online_timeout), node.online()).await {
        Ok(()) => println!(" 在线"),
        Err(_) => println!(" 超时（{online_timeout}s 内没有中继完成握手）"),
    }
    println!("== 中继状态 ==");
    for r in node.relay_status() {
        println!(
            "   {} connected={} last_error={:?} auth_denied={:?}",
            r.url, r.connected, r.last_error, r.auth_denied
        );
    }

    if let Some((peer_id, peer_relay)) = dial {
        println!("== 向对端发送 ==");
        println!("   peer   = {peer_id}");
        println!("   relay  = {peer_relay}");
        println!("   text   = {text}");
        match tokio::time::timeout(
            Duration::from_secs(20),
            node.send(&peer_id, &peer_relay, &text),
        )
        .await
        {
            Ok(Ok(res)) => println!("   结果: {res}"),
            Ok(Err(e)) => println!("   失败: {e:#}"),
            Err(_) => println!("   失败: 20s 超时"),
        }
    }

    if listen_secs > 0 {
        println!("== 监听 {listen_secs}s（等待对端消息）==");
        tokio::time::sleep(Duration::from_secs(listen_secs)).await;
    }

    node.shutdown();
    tokio::time::sleep(Duration::from_millis(300)).await;
    println!("== 结束 ==");
    Ok(())
}
