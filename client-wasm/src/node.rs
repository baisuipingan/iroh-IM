//! 与平台无关的核心逻辑（浏览器和目标机共用）。
//!
//! 在浏览器里只连自建中继；在原生环境里同一份代码也能跑，用于验证中继舰队。
//! 浏览器硬限制：不能发 UDP → 无法打洞 → 所有流量必经中继。

use std::str::FromStr;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use async_channel::{Receiver, Sender};
use iroh::{
    endpoint::{presets, Connection, RelayStatus},
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey, Watcher,
};
use n0_future::{task, StreamExt};
use serde::{Deserialize, Serialize};

/// 聊天协议标识。
pub const ALPN: &[u8] = b"editor.vip/iroh-chat/1";

#[derive(Debug, Clone, Deserialize)]
pub struct NodeOptions {
    /// 中继 URL 列表，如 ["https://iroh1.editor.vip:8443"]
    pub relays: Vec<String>,
    /// 中继的共享 token（可选）
    #[serde(default)]
    pub relay_token: Option<String>,
    /// 身份私钥（hex，32 字节）。不传则随机生成（浏览器侧应持久化，否则每次刷新换身份）。
    pub secret_key_hex: Option<String>,
}

impl NodeOptions {
    pub fn new(relays: Vec<String>) -> Self {
        Self {
            relays,
            relay_token: None,
            secret_key_hex: None,
        }
    }
    pub fn with_secret_key(mut self, hex: impl Into<String>) -> Self {
        self.secret_key_hex = Some(hex.into());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NodeEvent {
    /// 中继连接状态快照（状态变化时推送）
    RelayStatus { relays: Vec<RelayInfo> },
    /// 有对端连入
    PeerConnected { from: String },
    /// 收到一条聊天消息
    Message { from: String, text: String },
    /// 错误
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub url: String,
    pub connected: bool,
    /// 最近一次连接失败的错误（连上时为 None）
    pub last_error: Option<String>,
    /// 被中继拒绝鉴权的原因（重试无用，需要人工处理）
    pub auth_denied: Option<String>,
}

impl From<&RelayStatus> for RelayInfo {
    fn from(s: &RelayStatus) -> Self {
        Self {
            url: s.url().to_string(),
            connected: s.is_connected(),
            last_error: s.last_error().map(|e| e.to_string()),
            auth_denied: s.auth_denied_reason().map(|r| r.to_string()),
        }
    }
}

#[derive(Debug, Clone)]
struct ChatProtocol {
    events: Sender<NodeEvent>,
}

impl ProtocolHandler for ChatProtocol {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let from = connection.remote_id().to_string();
        self.events
            .send(NodeEvent::PeerConnected { from: from.clone() })
            .await
            .ok();

        let (mut send, mut recv) = connection.accept_bi().await?;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match recv.read(&mut chunk).await.map_err(AcceptError::from_err)? {
                Some(0) | None => break,
                Some(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        let _ = send.write_all(b"ok").await;
        let _ = send.finish();

        let text = String::from_utf8_lossy(&buf).to_string();
        self.events.send(NodeEvent::Message { from, text }).await.ok();

        connection.closed().await;
        Ok(())
    }
}

pub struct WebNode {
    endpoint: Endpoint,
    _router: Router,
    latest_status: Arc<Mutex<Vec<RelayInfo>>>,
    events_tx: Sender<NodeEvent>,
    events_rx: Receiver<NodeEvent>,
}

impl WebNode {
    /// 按给定中继列表绑定端点，并开始观察中继状态。
    pub async fn start(opts: NodeOptions) -> Result<Self> {
        if opts.relays.is_empty() {
            anyhow::bail!("中继列表为空：RelayMode::Custom 至少需要一台中继");
        }
        let relay_urls: Vec<RelayUrl> = opts
            .relays
            .iter()
            .map(|u| RelayUrl::from_str(u).with_context(|| format!("中继 URL 无法解析: {u}")))
            .collect::<Result<_, _>>()?;

        let mut builder = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Custom({
                let mut m = RelayMap::from_iter(relay_urls);
                if let Some(t) = opts.relay_token.as_ref().filter(|t| !t.is_empty()) {
                    m = m.with_auth_token(t.clone());
                }
                m
            }))
            .alpns(vec![ALPN.to_vec()]);

        if let Some(hex) = &opts.secret_key_hex {
            let key = SecretKey::from_str(hex).context("私钥解析失败（需要 64 位 hex）")?;
            builder = builder.secret_key(key);
        }

        let endpoint = builder.bind().await?;
        let (events_tx, events_rx) = async_channel::unbounded::<NodeEvent>();
        let latest_status = Arc::new(Mutex::new(Vec::new()));

        {
            let endpoint = endpoint.clone();
            let events = events_tx.clone();
            let latest = latest_status.clone();
            task::spawn(async move {
                let mut stream = endpoint.home_relay_status().stream();
                while let Some(statuses) = stream.next().await {
                    let infos: Vec<RelayInfo> = statuses.iter().map(RelayInfo::from).collect();
                    *latest.lock().unwrap() = infos.clone();
                    if events.send(NodeEvent::RelayStatus { relays: infos }).await.is_err() {
                        break;
                    }
                }
            });
        }

        let router = Router::builder(endpoint.clone())
            .accept(ALPN, ChatProtocol { events: events_tx.clone() })
            .spawn();

        Ok(Self {
            endpoint,
            _router: router,
            latest_status,
            events_tx,
            events_rx,
        })
    }

    /// 本节点 ID（hex）。发给别人，对方才能连你。
    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// 等待至少一台中继完成握手（注册成功）。调用方自行加超时。
    pub async fn online(&self) {
        self.endpoint.online().await
    }

    /// 当前中继状态快照。
    pub fn relay_status(&self) -> Vec<RelayInfo> {
        self.latest_status.lock().unwrap().clone()
    }

    /// 事件订阅（中继状态 / 连入 / 消息 / 错误）。
    pub fn subscribe(&self) -> Receiver<NodeEvent> {
        self.events_rx.clone()
    }

    /// 给对端发一条消息。
    ///
    /// `peer_relay` 必须是对端**当前真实所在**的中继 URL：中继之间不互转，
    /// 填错会超时失败（实测 13s 超时）。
    pub async fn send(&self, peer_id_hex: &str, peer_relay: &str, text: &str) -> Result<String> {
        let id = EndpointId::from_str(peer_id_hex).context("对端 ID 解析失败")?;
        let relay = RelayUrl::from_str(peer_relay).context("对端中继 URL 解析失败")?;

        let conn = self
            .endpoint
            .connect(EndpointAddr::new(id).with_relay_url(relay), ALPN)
            .await
            .context("连接对端失败")?;

        let (mut send, mut recv) = conn.open_bi().await.context("打开流失败")?;
        send.write_all(text.as_bytes()).await.context("写入失败")?;
        send.finish().context("finish 失败")?;

        let mut ack = [0u8; 8];
        let n = recv.read(&mut ack).await?;
        let acked = matches!(n, Some(n) if n > 0);
        conn.close(0u8.into(), b"done");
        Ok(if acked { "delivered".into() } else { "sent-no-ack".into() })
    }

    pub fn shutdown(&self) {
        // close() 是异步的：必须真正调度它，否则端点不会被关闭
        let endpoint = self.endpoint.clone();
        task::spawn(async move { endpoint.close().await });
        self.events_tx.close();
    }
}
