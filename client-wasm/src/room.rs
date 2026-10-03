//! 群聊：基于 iroh-gossip 的房间模型。
//!
//! - **房间 = gossip topic**：topic id 由房间名派生（blake3），同名即同房间
//! - **消息用 ed25519 签名**：gossip 只保证送达，作者身份靠签名，转发者无法伪造
//! - **bootstrap = 常驻节点**：客户端只需要知道常驻节点一个地址，进房间后由 gossip
//!   自己的 HyParView/PlumTree 扩散发现其他成员
//! - **历史消息**：gossip 是短暂的，历史由常驻节点通过独立 ALPN 提供
//!
//! 浏览器限制：仍然只能走中继（不能打洞），所以一切流量经自建中继。

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use async_channel::{Receiver, Sender};
use iroh::{
    address_lookup::memory::MemoryLookup,
    endpoint::presets,
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, EndpointAddr, EndpointId, PublicKey, RelayMap, RelayMode, RelayUrl, SecretKey,
    Signature, TransportAddr, Watcher,
};
use iroh_gossip::{
    api::{Event as GossipEvent, GossipSender},
    net::{Gossip, GOSSIP_ALPN},
};
use n0_future::{
    task::{self, AbortOnDropHandle},
    time::Duration,
    StreamExt,
};
/// 原生才需要（wasm32-unknown-unknown 没有 `std::time` 实现，见 `now_ms`）
#[cfg(not(target_arch = "wasm32"))]
use std::time::SystemTime;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;
use tracing::{debug, info, warn};

use crate::filetransfer::{
    FileChunk, FileCtrl, FileMeta, FileService, SignedCtrl, FILE_ALPN,
};

/// 历史消息用的 ALPN（只有常驻节点会响应）。
pub const HISTORY_ALPN: &[u8] = b"editor.vip/iroh-history/1";

/// 房间名 → topic id 的命名空间。
const TOPIC_NS: &str = "editor.vip/room/1/";
/// gossip 单条消息上限。
///
/// `iroh-gossip` 的默认值是 **4096 字节**（见 `proto::DEFAULT_MAX_MESSAGE_SIZE`），
/// 对"聊天"来说太小了 —— 一张截图就远超。这里显式放宽。
///
/// 注意：**同一个房间里的所有节点应当用同一个值**（我们自己的客户端统一，
/// 但如果有第三方客户端，需要约定一致）。消息最终是经中继广播给每个成员的，
/// 所以这个值不要无脑调太大 —— 真要传大文件，应该走对象存储 + 链接，而不是塞进广播消息。
pub const MAX_MESSAGE_SIZE: usize = 512 * 1024;   // 512 KB

/// presence 广播间隔（成员心跳，决定"静默死亡"的检测粒度）。
///
/// ⚠️ 这个值不动是有意的：调小它会让"在线成员"列表因为丢一个包就闪"离线"，
/// 误判比慢更烦人。想让**文件过期**更快，走下面那条独立的文件清单心跳。
const PRESENCE_INTERVAL: Duration = Duration::from_secs(10);
/// 多久没 presence 就认为对端掉线。
///
/// 实际生效延迟是 **25~45 秒**，不是精确 35：
/// 计时从"最后一次心跳"起算（他可能刚发完就走，先白等最多 10 秒），
/// 而清理是每 10 秒一轮（再叠加最多 10 秒的检查粒度）。
const PRESENCE_TTL_MS: u64 = 35_000;
/// 文件能力清单的心跳间隔 —— **只在手里有文件时才发**。
/// 目的：把"发送方走了 → 文件过期"压缩到 ~10 秒（3s 间隔 + 10s TTL），
/// 同时完全不影响成员表的 10s/35s。
const FILE_HB_MS: u64 = 3_000;
// 注："文件清单多久算过期"是**接收侧**的判定，放在前端（FILE_TTL_MS）。
// 这里不定义，避免同一个数字在两边各写一份、日后漂移。
/// 心跳任务的内部 tick。1 秒一跳，用来分别给"成员心跳"和"文件心跳"计时。
const HB_TICK: Duration = Duration::from_secs(1);
/// 单条心跳最多携带多少个 file_id（防止清单无限增长把广播撑大）
pub const MAX_FILES_IN_HB: usize = 20;

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/// 「文件存在的证明」——**只记元信息，不含内容**。
///
/// 用途：文件邀约本来是"发送那一刻 broadcast 一次"的瞬时事件，后进房间的人
/// 完全收不到。把这条证明写进历史后，谁进来都能看到"这里曾经有过一个文件"，
/// 名字/大小作为上下文；能不能真接收要另外看发送方还在不在（见 `Presence::files`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileRef {
    pub file_id: String,
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mime: String,
}

/// 一条聊天消息。**签名字段 = 除 `sig` 外的每一个字段**（含 `id`）。
///
/// ## 协议版本 v3
///
/// 三处破坏性变更（合起来是 v3），按约定直接清旧历史，不做兼容：
///
/// 1. **编码换成无歧义的长度前缀**（[`sigfmt`]）。原来 `|` 拼接让
///    "昵称 `Alice` + 正文 `A|B`" 与 "昵称 `Alice|A` + 正文 `B`"
///    规范化成同一串字节 —— 签名有效但语义被改掉了。
/// 2. **`id` 纳入签名**。原来 `id` 不在签名载荷里，任何人拿到一条
///    有效签名消息后改 `id` 就能重放成多条（历史按 id 去重，等于凭空多发言）。
/// 3. **`id` 由签名载荷派生** —— 见 [`ChatMessage::compute_id`]。
///
/// v1 = 纯文本；v2 = 加了文件证明的 4 个字段；v3 = 本版。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: String,
    pub from: String,
    pub nickname: String,
    pub text: String,
    pub ts: u64,
    #[serde(default)]
    pub sig: String,
    /// `Some` = 这是一条「文件证明」，客户端应渲染成文件卡片而不是文本气泡
    #[serde(default)]
    pub file: Option<FileRef>,
}

impl ChatMessage {
    /// 参与签名的规范化字符串（收发双方必须完全一致）。
    ///
    /// **包含 `id`** —— 这一点是 v3 的核心：id 不在签名载荷里的话，
    /// 别人能拿着你的有效签名随便改 id 反复重放。
    /// 没有文件时那几个字段填空串/0（不搞"两种拼法"，验签处要分支就容易出 bug）。
    pub fn canonical(&self) -> String {
        let f = self.file.as_ref();
        let ts = self.ts.to_string();
        let size = f.map(|x| x.size).unwrap_or(0).to_string();
        crate::sigfmt::encode_fields(&[
            crate::sigfmt::PROTO_V3,
            "id",
            self.id.as_str(),
            "from",
            self.from.as_str(),
            "ts",
            ts.as_str(),
            "nick",
            self.nickname.as_str(),
            "text",
            self.text.as_str(),
            "file_id",
            f.map(|x| x.file_id.as_str()).unwrap_or(""),
            "name",
            f.map(|x| x.name.as_str()).unwrap_or(""),
            "size",
            size.as_str(),
            "mime",
            f.map(|x| x.mime.as_str()).unwrap_or(""),
        ])
    }

    /// 消息 id —— **由签名载荷派生**，所以它天然被签名覆盖。
    ///
    /// 为什么把 `file_id` 也算进去：文件证明的 `text` 是空的，
    /// 只按 (from, ts, text) 算的话，同一毫秒发的两个文件会撞成同一个 id，
    /// 而历史是"按 id 去重"的 —— 后一条会被静默丢掉。
    pub fn compute_id(from: &str, ts: u64, text: &str, file_id: &str) -> String {
        let ts_s = ts.to_string();
        let payload =
            crate::sigfmt::encode_fields(&["id0", from, ts_s.as_str(), text, file_id]);
        let h = blake3::hash(payload.as_bytes());
        hex::encode(&h.as_bytes()[..12])
    }

    /// 本消息的 id 是否与自己算出来的一致。
    ///
    /// 验签时**必须**一起核对：`verify()` 只证明"签名没被改"，
    /// 而签名载荷里已经包含 id 了，所以这里再比一次就能挡住
    /// "改 id 后重放"（签名仍然有效，但 id 对不上载荷）。
    pub fn id_matches(&self) -> bool {
        let f = self.file.as_ref();
        let want = Self::compute_id(
            &self.from,
            self.ts,
            &self.text,
            f.map(|x| x.file_id.as_str()).unwrap_or(""),
        );
        // 恒定时间比较不必要：id 不是秘密，只是完整性的一部分。
        self.id == want
    }

    pub fn verify(&self) -> bool {
        // id 必须与载荷一致，否则"签名有效"但 id 是被人换过的
        if !self.id_matches() {
            return false;
        }
        let Ok(pk) = PublicKey::from_str(&self.from) else {
            return false;
        };
        let Ok(raw) = hex::decode(&self.sig) else {
            return false;
        };
        let Ok(arr) = <[u8; 64]>::try_from(raw.as_slice()) else {
            return false;
        };
        pk.verify(self.canonical().as_bytes(), &Signature::from_bytes(&arr))
            .is_ok()
    }

    pub fn sign(mut self, key: &SecretKey) -> Self {
        // 先按载荷重算 id，保证 id 与签名永远自洽
        let f_id = self
            .file
            .as_ref()
            .map(|x| x.file_id.clone())
            .unwrap_or_default();
        self.id = Self::compute_id(&self.from, self.ts, &self.text, &f_id);
        let sig = key.sign(self.canonical().as_bytes());
        self.sig = hex::encode(sig.to_bytes());
        self
    }
}

/// 周期性"我在"心跳。签名覆盖 v3 版的 `from|ts|nickname|epoch|files...`。
///
/// 心跳同时承担**两件事**：
///  1. 成员表（谁在房间里）—— 收不到心跳超时即判定离开，这是**唯一的事实来源**
///  2. **文件能力清单**（`files`）—— "我此刻还能把哪些文件发出去"
///
/// 所以"发送方离开 → 他的文件都不可接收"不需要任何额外机制：
/// 他不再心跳 → 清单消失 → 那些文件自然变成"已过期"。
/// **事件（离开声明）只用来加速，不用来决定事实** —— 见 `Wire::Leave` 的注释。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Presence {
    pub from: String,
    pub nickname: String,
    pub ts: u64,
    pub sig: String,
    /// 我当前还持有、且愿意发出的 file_id 列表（**只记 id，不记名字**）。
    /// 名字走历史里的文件证明，避免每次心跳都重复带一堆文件名。
    #[serde(default)]
    pub files: Vec<String>,
    /// 单调递增序号。用于**丢弃乱序/重放的旧状态**：
    /// 只接受 epoch 更大的 presence，否则"一条迟到的旧心跳"会把刚更新的
    /// 文件清单打回旧值（gossip 不保证顺序）。
    #[serde(default)]
    pub epoch: u64,
}

impl Presence {
    pub fn canonical(&self) -> String {
        let ts = self.ts.to_string();
        let epoch = self.epoch.to_string();
        let n = self.files.len().to_string();
        // files **逐项独立编码**，不能用 join(",") ——
        // 那样 file_id 里含逗号时会和"两个 id"拼出同一串（歧义）。
        // 另外带上清单长度，让"少一项/多一项"也能被发现。
        let mut out = crate::sigfmt::encode_fields(&[
            "p3",
            "from",
            self.from.as_str(),
            "ts",
            ts.as_str(),
            "nick",
            self.nickname.as_str(),
            "epoch",
            epoch.as_str(),
            "nfiles",
            n.as_str(),
        ]);
        for f in &self.files {
            out.push_str(&crate::sigfmt::encode_fields(&[f.as_str()]));
        }
        out
    }

    /// 组装并签名。`files` 会被**排序**，保证同样的集合产生同样的签名串。
    pub fn signed(key: &SecretKey, nickname: &str, files: Vec<String>, epoch: u64) -> Self {
        let mut files = files;
        files.sort();
        files.dedup();
        let mut p = Self {
            from: key.public().to_string(),
            nickname: nickname.to_string(),
            ts: now_ms(),
            sig: String::new(),
            files,
            epoch,
        };
        let sig = key.sign(p.canonical().as_bytes());
        p.sig = hex::encode(sig.to_bytes());
        p
    }
    pub fn verify(&self) -> bool {
        let Ok(pk) = PublicKey::from_str(&self.from) else {
            return false;
        };
        let Ok(raw) = hex::decode(&self.sig) else {
            return false;
        };
        let Ok(arr) = <[u8; 64]>::try_from(raw.as_slice()) else {
            return false;
        };
        pk.verify(self.canonical().as_bytes(), &Signature::from_bytes(&arr))
            .is_ok()
    }
}

/// **离开房间声明**。签名覆盖 `l1|from|ts`。
///
/// ⚠️ 它**不是事实来源**，只是"加速器"。原因：
///  1. 最需要它的场景（刷新/关页/崩溃/断网）恰恰发不出去 —— 浏览器卸载时
///     给的时间极短，而一次广播要序列化+签名+QUIC 写+中继转发；
///  2. "声明"不等于"事实"：可能他声明走了却又回来（bfcache 恢复）；
///  3. 崩溃/断电根本没有发送方参与，**兜底机制无论如何都必须有**。
///
/// 所以事实永远由"心跳 + 超时"派生；这条消息只在**可靠的时机**发
/// —— 也就是"用户主动切到别的房间"：页面还活着、连接还在，一定发得出去。
/// 收到它就把该成员立刻从本地成员表移除（并丢弃他的文件清单 → 文件立刻过期），
/// 不必等 25~45 秒的心跳超时。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaveMsg {
    pub from: String,
    pub ts: u64,
    pub sig: String,
}

impl LeaveMsg {
    pub fn canonical(&self) -> String {
        let ts = self.ts.to_string();
        crate::sigfmt::encode_fields(&["l2", "from", self.from.as_str(), "ts", ts.as_str()])
    }
    pub fn signed(key: &SecretKey) -> Self {
        let mut m = Self {
            from: key.public().to_string(),
            ts: now_ms(),
            sig: String::new(),
        };
        let sig = key.sign(m.canonical().as_bytes());
        m.sig = hex::encode(sig.to_bytes());
        m
    }
    pub fn verify(&self) -> bool {
        let Ok(pk) = PublicKey::from_str(&self.from) else {
            return false;
        };
        let Ok(raw) = hex::decode(&self.sig) else {
            return false;
        };
        let Ok(arr) = <[u8; 64]>::try_from(raw.as_slice()) else {
            return false;
        };
        pk.verify(self.canonical().as_bytes(), &Signature::from_bytes(&arr))
            .is_ok()
    }
}

/// **可用性质询**：我点了某张文件卡片，但联系不上发送方，公开问一句"谁还能提供它"。
/// 签名覆盖 v3 版的 `from|ts|file_id|want`。
///
/// 为什么用"质询 + 认领"而不是"接收方单方面宣布过期"：
/// **我连不上发送方，可能只是我自己网络的问题**，单方面广播会误伤别人。
/// 把判定交回给唯一有权确认的人（发送方）—— 他若还持有这个文件，
/// 就重播一次心跳来"认领"（不需要专门的新消息类型，复用 presence 即可）；
/// **沉默才等于过期**。而"过期"本身是可逆的派生状态，清单再出现就恢复。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileQuery {
    pub from: String,
    pub ts: u64,
    pub file_id: String,
    /// 期望的提供者（发送方 EndpointId）
    pub want: String,
    pub sig: String,
}

impl FileQuery {
    pub fn canonical(&self) -> String {
        let ts = self.ts.to_string();
        crate::sigfmt::encode_fields(&[
            "q2",
            "from",
            self.from.as_str(),
            "ts",
            ts.as_str(),
            "file_id",
            self.file_id.as_str(),
            "want",
            self.want.as_str(),
        ])
    }
    pub fn signed(key: &SecretKey, file_id: &str, want: &str) -> Self {
        let mut q = Self {
            from: key.public().to_string(),
            ts: now_ms(),
            file_id: file_id.to_string(),
            want: want.to_string(),
            sig: String::new(),
        };
        let sig = key.sign(q.canonical().as_bytes());
        q.sig = hex::encode(sig.to_bytes());
        q
    }
    pub fn verify(&self) -> bool {
        let Ok(pk) = PublicKey::from_str(&self.from) else {
            return false;
        };
        let Ok(raw) = hex::decode(&self.sig) else {
            return false;
        };
        let Ok(arr) = <[u8; 64]>::try_from(raw.as_slice()) else {
            return false;
        };
        pk.verify(self.canonical().as_bytes(), &Signature::from_bytes(&arr))
            .is_ok()
    }
}

/// 编码一条签名的 presence（常驻节点也要"在线"给别人看）。
pub fn encode_presence(key: &SecretKey, nickname: &str) -> Vec<u8> {
    serde_json::to_vec(&Wire::Presence {
        p: Presence::signed(key, nickname, Vec::new(), 0),
    })
    .unwrap_or_default()
}

/// 解析 gossip 收到的字节。
pub fn decode_wire(bytes: &[u8]) -> Option<Wire> {
    serde_json::from_slice(bytes).ok()
}

/// gossip 承载的消息：聊天 / 在线 / 文件控制。
///
/// 文件**内容**不走这里，只有元信息与控制信号（见 `filetransfer`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum Wire {
    #[serde(rename = "m")]
    Message { m: ChatMessage },
    #[serde(rename = "p")]
    Presence { p: Presence },
    #[serde(rename = "f")]
    File { c: crate::filetransfer::SignedCtrl },
    /// 离开房间的**加速声明**（只在"主动切房间"这种可靠时机发，见 `LeaveMsg`）
    #[serde(rename = "l")]
    Leave { l: LeaveMsg },
    /// 文件可用性质询（点了一张卡但联系不上发送方时广播，见 `FileQuery`）
    #[serde(rename = "q")]
    FileQuery { q: FileQuery },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HistoryRequest {
    pub room: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// 复合游标 `(ts, id)`：只要 `(msg.ts, msg.id)` 严格小于它的消息。
    ///
    /// 为什么带 id：时间戳只到**毫秒**，同一毫秒的多条消息会撞在游标边界上，
    /// 只用 `ts < before` 会把"边界那批"整体跳过 —— 它们永远取不到。
    /// `None` = 最新 N 条。
    #[serde(default)]
    pub before: Option<(u64, String)>,
}
fn default_limit() -> usize {
    200
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HistoryResponse {
    pub room: String,
    pub messages: Vec<ChatMessage>,
    /// **房间快照**（常驻节点维护）。让新进房间的人**进房即刻**就有正确视图：
    /// 现在要等最多 10 秒才能从心跳里知道"屋里都有谁"，而文件能不能收
    /// 还要再等一轮。有了快照，拉历史的同时就把成员表和文件清单拿到手。
    ///
    /// ⚠️ 它是**快照**不是权威：客户端仍以自己的软状态（心跳+超时）为准，
    /// 常驻节点挂了也不影响正确性，只是回退到"等心跳"。
    #[serde(default)]
    pub snapshot: Option<RoomSnapshot>,
}

/// 常驻节点维护的"房间当前状态"快照
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub at: u64,
    pub members: Vec<MemberSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSnapshot {
    pub id: String,
    pub nickname: String,
    pub last_seen_ms: u64,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub epoch: u64,
}

// ---------------------------------------------------------------------------
// 对 JS 暴露的事件与状态
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub url: String,
    pub connected: bool,
    pub last_error: Option<String>,
    pub auth_denied: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub id: String,
    pub nickname: String,
    pub last_seen_ms: u64,
    /// 他此刻还能提供的 file_id（来自他的心跳）。**只记 id，名字在历史里。**
    /// 前端据此判断"历史里那个文件现在能不能收"。
    #[serde(default)]
    pub files: Vec<String>,
    /// 他最后上报的单调序号，用于丢弃乱序的旧心跳
    #[serde(default)]
    pub epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RoomEvent {
    Joined { room: String },
    Message { room: String, message: ChatMessage, mine: bool },
    Presence { room: String, peers: Vec<PeerInfo> },
    PeerUp { id: String },
    PeerDown { id: String },
    History { room: String, messages: Vec<ChatMessage> },
    /// 收到文件邀约（UI 应显示文件名/大小 + ✓/✗）
    FileInvite { room: String, meta: FileMeta },
    /// 对方拒绝接收（或中途主动取消）。
    ///
    /// `by` 是拒绝方的 EndpointId。**一个文件可能同时发给多个人**，
    /// 没有这个字段，发送端无从知道该把哪一条出站通道标失败 ——
    /// 只能把整份文件的传输都判死（实测踩到：一个接收方刷新，
    /// 发送端把另一条还在正常传的通道也一起放弃）。
    ///
    /// `room`：这条控制消息实际来自哪个房间。UI 必须核对它，
    /// 否则 B 房间收到的控制流会去改 A 房间的卡片状态（F7）。
    FileRejected {
        room: String,
        file_id: String,
        reason: String,
        by: String,
    },
    /// 对方已接受，开始传输。
    /// `by` 是接受方的 EndpointId（发送方据此拨号 —— 不能靠猜 peers，房间大时会猜错）
    FileAccepted {
        room: String,
        file_id: String,
        have: String,
        receiver_relay: String,
        by: String,
    },
    /// 传输结束（两个方向都会收到）
    FileDone {
        room: String,
        file_id: String,
        ok: bool,
        reason: String,
    },
    /// 有人点了**历史里的文件卡片**，问"你现在还能提供这个文件吗"。
    ///
    /// 只有被问到的那个发送方会收到。他需要用**重发一次邀约**来回应 ——
    /// 而元信息（chunk_size / root_hash）在 JS 的 `outFiles` 里，
    /// 所以这里只把消息转给 Worker，由它去重发。
    FileQueryAsked {
        room: String,
        file_id: String,
        by: String,
    },
    /// 传输进度（本地产生，不来自网络）
    FileProgress {
        file_id: String,
        direction: String,
        done_chunks: u64,
        total_chunks: u64,
        received_bytes: u64,
        total_bytes: u64,
    },
    RelayStatus { relays: Vec<RelayInfo> },
    Error { message: String },
}

/// 文件控制消息的**新鲜度窗口**（毫秒）。
///
/// `Accept` / `Reject` / `Done` 都是广播消息，签名里带 `ts` 但没人校验它 ——
/// 于是房间成员可以把抓到的 `Accept` 原样重放，让发送方**为每条重放重传一次整个文件**
/// （缺陷 F19：一条小消息换一次全量上传）。这里给一个宽松但有效的窗口：
/// 时钟偏差几秒没关系，几分钟前的老消息则一律丢弃。
pub const FILE_CTRL_MAX_AGE_MS: u64 = 5 * 60 * 1000;

/// 把一条**已验签**的文件控制消息映射成 UI 事件；返回 `None` = 丢弃这条消息。
///
/// ## 为什么单独抽成一个纯函数（缺陷 F1 的回归防线）
///
/// 这个映射原来内联在 gossip 消费任务的 `match` 里，而"`meta.sender` 与签名者不一致"
/// 那个分支写的是 **`return`**。它不在闭包里，而是直接位于
/// `async move { while let Some(ev) = receiver.next().await { … } }`（见 [`RoomNode::subscribe_room`]）
/// 的任务体内 —— 于是 `return` **结束了整个消费任务**：
/// 该房间的聊天、心跳、离开、文件控制从此**全部不再被处理**，
/// 而发送方向仍正常，受害者自己看不出任何异常。
///
/// 触发成本极低：`sender` 本身就在签名载荷里（见 `FileCtrl::canonical`），
/// 所以任何在场的人都能自己签一条 `meta.sender` 不等于自己的合法邀约。
///
/// 抽成纯函数之后：
/// 1. 调用点只能"`if let Some(ev)` 才发事件"，**结构上不可能**再误用 `return` 结束循环；
/// 2. 这个分支的行为可以直接被单元测试盯住（见 `security_tests::非法邀约只丢弃不终止循环`）。
fn ctrl_event(
    ctrl: crate::filetransfer::FileCtrl,
    signer: &str,
    room: &str,
    ts: u64,
) -> Option<RoomEvent> {
    use crate::filetransfer::FileCtrl;
    // 新鲜度：丢弃过老（重放）或过远未来（时钟异常）的控制消息。
    // 允许的偏差取得很宽松，正常使用碰不到；目的是让"重放昨天的 Accept"失效。
    let now = now_ms() as i64;
    let age = now - ts as i64;
    if age > FILE_CTRL_MAX_AGE_MS as i64 || age < -(FILE_CTRL_MAX_AGE_MS as i64) {
        warn!("丢弃过期的文件控制消息（ts={ts}，距今 {age}ms）");
        return None;
    }
    match ctrl {
        FileCtrl::Invite(m) => {
            // ⚠️ `meta.sender` 必须等于**签名者**。
            //    它是接收侧登记"我期待的发送方"的依据，数据流授权完全建立在这上面。
            //    不一致 = 有人在拿别人的签名发自己的文件 id，或者 sender 字段被改过
            //    —— 两种都必须拒（**只丢这一条**）。
            if m.sender != signer {
                warn!(
                    "丢弃邀约：meta.sender={} 与签名者={} 不一致",
                    m.sender, signer
                );
                return None;
            }
            // ⚠️ 元信息合法性也要在**显示卡片之前**校验（F17）：
            //    非法的 `chunk_size`/超大块数/空 `root_hash` 都会让后续流变成
            //    "无法校验的内容"，所以连卡片都不该弹出来让用户点。
            if let Err(why) = crate::filetransfer::validate_meta(&m) {
                warn!("丢弃邀约：元信息非法（{why}）file_id={}", m.file_id);
                return None;
            }
            Some(RoomEvent::FileInvite {
                room: room.to_string(),
                meta: m,
            })
        }
        FileCtrl::Accept {
            file_id,
            have,
            receiver_relay,
        } => Some(RoomEvent::FileAccepted {
            room: room.to_string(),
            file_id,
            have,
            receiver_relay,
            by: signer.to_string(),
        }),
        FileCtrl::Reject { file_id, reason } => Some(RoomEvent::FileRejected {
            room: room.to_string(),
            file_id,
            reason,
            by: signer.to_string(),
        }),
        FileCtrl::Done {
            file_id,
            ok,
            reason,
        } => Some(RoomEvent::FileDone {
            room: room.to_string(),
            file_id,
            ok,
            reason,
        }),
    }
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct RoomOptions {
    pub relays: Vec<String>,
    #[serde(default)]
    pub secret_key_hex: Option<String>,
    /// 中继的共享 token（浏览器走 ?token= 查询参数）
    #[serde(default)]
    pub relay_token: Option<String>,
    #[serde(default)]
    pub anchor_id: Option<String>,
    #[serde(default)]
    pub anchor_relay: Option<String>,
    /// 常驻节点：历史落盘目录（浏览器不传）
    #[serde(default)]
    pub history_dir: Option<String>,
    /// 常驻节点：是否注册历史服务 ALPN
    #[serde(default)]
    pub serve_history: bool,
}

/// 房间快照缓存：`room -> 成员表（含各人的文件清单）`。
///
/// 谁维护：**常驻节点**。它一直在房间里、本来就收得到所有人的心跳，
/// 顺手把"当前成员 + 各自还能提供哪些文件"记下来即可。
/// 谁使用：新进房间的人 —— 拉历史时顺带拿到，**进房即刻就有正确视图**，
/// 不用干等最多 10 秒的第一轮心跳（否则他会觉得"这房间是空的"）。
///
/// ⚠️ 它是**快照，不是权威**：客户端仍以自己的软状态（心跳 + 超时）为准，
/// 常驻节点挂了只是回退到"等心跳"，正确性不受影响。
pub type Snapshots = Arc<Mutex<HashMap<String, RoomSnapshot>>>;

pub fn new_snapshots() -> Snapshots {
    Arc::new(Mutex::new(HashMap::new()))
}

/// 记一个人（或刷新他的状态），并顺手清掉已经超时的成员。
pub fn snapshot_upsert(snaps: &Snapshots, room: &str, m: MemberSnapshot) {
    let now = now_ms();
    let mut g = snaps.lock().unwrap();
    let s = g.entry(room.to_string()).or_default();
    s.at = now;
    s.members
        .retain(|x| x.id != m.id && now.saturating_sub(x.last_seen_ms) < PRESENCE_TTL_MS);
    s.members.push(m);
}

/// 某人声明离开 / 被判定超时 → 从快照里摘掉（他的文件也随之不再出现在快照里）
pub fn snapshot_drop(snaps: &Snapshots, room: &str, id: &str) {
    let mut g = snaps.lock().unwrap();
    if let Some(s) = g.get_mut(room) {
        s.members.retain(|x| x.id != id);
        s.at = now_ms();
    }
}

/// 取快照（顺手清理超时成员；空则返回 None，避免回一个空壳让客户端误以为"房间没人"）
pub fn snapshot_get(snaps: &Snapshots, room: &str) -> Option<RoomSnapshot> {
    let now = now_ms();
    let mut g = snaps.lock().unwrap();
    let s = g.get_mut(room)?;
    s.members
        .retain(|x| now.saturating_sub(x.last_seen_ms) < PRESENCE_TTL_MS);
    if s.members.is_empty() {
        return None;
    }
    Some(s.clone())
}

// ---------------------------------------------------------------------------
// 历史存储（常驻节点）
// ---------------------------------------------------------------------------

/// 落盘文件的**首行**（不是一条消息）：记录这个文件属于哪个房间。
///
/// 有了它，加载时就不必从文件名反推房间名 —— 也就不会出现
/// "文件名被换成别的房间、于是两间房的历史混在一起"。
#[derive(Serialize, Deserialize)]
struct RoomHeader {
    /// 固定标识，防止把普通消息行误当头部。
    marker: String,
    /// 写入时的原始房间名（**原样保存，不做任何替换**）。
    room: String,
    /// `blake3(room)` 的前 16 字节 hex —— 必须与文件名一致。
    /// 不一致说明文件被挪过位置或改名，直接拒绝加载。
    hash: String,
}

impl RoomHeader {
    const MARKER: &'static str = "iroh-room-v1";

    fn new(room: &str) -> Self {
        Self {
            marker: Self::MARKER.to_string(),
            room: room.to_string(),
            hash: room_hash(room),
        }
    }

    fn matches(&self, room: &str) -> bool {
        self.marker == Self::MARKER && self.hash == room_hash(room)
    }
}

/// 房间名 → 落盘文件名的**稳定映射**。
///
/// ## 为什么不能再用"把非法字符替换成 `_`"
///
/// 旧实现是 `sanitize()`：非 ASCII 字母数字一律换成 `_`。
/// 这是**多对一**映射，且信息在加载侧还被二次破坏（加载时又把 `_` 换成 `-`）：
///
/// ```text
/// 研发群  -> ___.jsonl ┐ 两个不同房间共用一个文件
/// 产品群  -> ___.jsonl ┘ 重启后两间房的历史混在一起
/// team_a  -> team_a.jsonl ，加载时变成 team-a
/// ```
///
/// 现在改成 **blake3(room) 的 hex**：一一对应、无特殊字符、跨平台一致，
/// 原始房间名在文件头里原样保存。
fn room_hash(room: &str) -> String {
    hex::encode(&blake3::hash(room.as_bytes()).as_bytes()[..16])
}

#[derive(Clone, Debug, Default)]
pub struct HistoryStore {
    dir: Option<std::path::PathBuf>,
    mem: Arc<Mutex<HashMap<String, Vec<ChatMessage>>>>,
}

impl HistoryStore {
    pub fn new(dir: Option<std::path::PathBuf>) -> Self {
        Self {
            dir,
            mem: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 追加一条消息到历史（内存 + 落盘）。
    ///
    /// ## 为什么这里自己验签，而不是"信任调用方验过了"
    ///
    /// 常驻节点在收到 gossip 消息时**确实**先 `verify()` 再调本函数。
    /// 但把校验放在调用方有个真实缺口（用报告的攻击脚本测出来的）：
    /// **只要有一条路径忘了验，被篡改的消息就直接进历史与磁盘**。
    /// 实测：拿一条有效消息改掉 `id` 后塞进来，内存计数会变成 2 ——
    /// 等于凭空多一条"原作者发言"。
    ///
    /// 历史是**持久化**的：一旦写进去，以后每次重启都会加载出来。
    /// 所以这里做一次兜底校验，代价可以忽略（ed25519 验签 ~50µs）。
    pub fn append(&self, room: &str, msg: ChatMessage) -> bool {
        // ⚠️ 兜底：签名无效 / id 与载荷不符的消息**一律不进历史**。
        //    返回 false 让调用方能察觉（便于测试与排查）。
        if !msg.verify() {
            warn!(
                "拒绝写入历史：验签失败 room={room} id={} from={}",
                msg.id,
                &msg.from[..msg.from.len().min(12)]
            );
            return false;
        }
        {
            let mut map = self.mem.lock().unwrap();
            let list = map.entry(room.to_string()).or_default();
            if list.iter().any(|m| m.id == msg.id) {
                return true; // 已存在（重复消息），不算失败
            }
            list.push(msg.clone());
            // ⚠️ 排序键必须与分页契约一致（(ts, id)）。
            //    只按 ts 排的话，同一毫秒的两条消息在内存里的先后
            //    依赖插入顺序，而 `recent_before` 又按 (ts, id) 过滤 ——
            //    页边界落在这两条之间时可能重复或漏掉一条（复检 P3-3）。
            list.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
            if list.len() > 5000 {
                let drop = list.len() - 5000;
                list.drain(0..drop);
            }
        }
        // 落盘只在原生做：wasm 下发没有 std::fs，
        // 靠 `if let Some(dir)` 判断是"运行时守规矩"，这里加编译期保护更稳。
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(dir) = &self.dir {
            if std::fs::create_dir_all(dir).is_ok() {
                let path = dir.join(format!("{}.jsonl", room_hash(room)));
                if let Ok(line) = serde_json::to_string(&msg) {
                    use std::io::Write;
                    let mut f = match std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&path)
                    {
                        Ok(f) => f,
                        Err(e) => {
                            // 内存已经写进去了，只是这次没落盘 —— 不算失败，
                            // 但必须留痕（否则表现为"重启后消息莫名少了"）。
                            warn!("打开历史文件失败 {}: {e}", path.display());
                            return true;
                        }
                    };
                    // ⚠️ 只在**文件为空**时写头部 —— 追加时绝不能重复写，
                    //    否则每条消息后面都跟一个头部，加载时会被当成消息解析失败。
                    //    用 `metadata().len() == 0` 判断"这是刚创建的空文件"。
                    if f.metadata().map(|m| m.len() == 0).unwrap_or(false) {
                        match serde_json::to_string(&RoomHeader::new(room)) {
                            Ok(h) => {
                                let _ = writeln!(f, "{h}");
                            }
                            Err(e) => {
                                // 头部写不进去就别写这条消息了 —— 没有头部的文件
                                // 加载时会被整份跳过（比丢一条消息更糟）。
                                warn!("序列化历史文件头失败，本次不落盘: {e}");
                                return true;
                            }
                        }
                    }
                    let _ = writeln!(f, "{line}");
                }
            }
        }
        true
    }

    pub fn recent(&self, room: &str, limit: usize) -> Vec<ChatMessage> {
        let map = self.mem.lock().unwrap();
        let mut list = map.get(room).cloned().unwrap_or_default();
        list.sort_by_key(|m| m.ts);
        let n = list.len();
        if n > limit {
            list.split_off(n - limit)
        } else {
            list
        }
    }

    /// 取 `before` 之前（不含）的最近 limit 条，按 `(ts, id)` 复合游标翻页。
    ///
    /// ## 为什么不能只用时间戳
    ///
    /// 时间戳是**毫秒**级。同一毫秒内的多条消息（`split_off` 正好切在中间、
    /// 或批量导入）会让首页取走 50 条、第 51 条与第 50 条同 `ts`，
    /// 下一页用 `ts < before` 就把第 51 条一起跳过了 —— **永久取不到**。
    ///
    /// 现在游标是 `(ts, id)`，排序也用它，所以同一毫秒内的消息有确定全序，
    /// 翻页既不漏也不重复。`before=None` 表示取最新 limit 条。
    pub fn recent_before(
        &self,
        room: &str,
        before: Option<(u64, String)>,
        limit: usize,
    ) -> Vec<ChatMessage> {
        let map = self.mem.lock().unwrap();
        let mut list: Vec<ChatMessage> = map.get(room).cloned().unwrap_or_default();
        // 稳定全序：先 ts 再 id。id 由签名载荷派生，等于给同毫秒消息一个稳定次序。
        list.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
        if let Some((bts, bid)) = before {
            list.retain(|m| (m.ts, &m.id) < (bts, &bid));
        }
        let n = list.len();
        if n > limit {
            list.split_off(n - limit)
        } else {
            list
        }
    }

    pub fn count(&self, room: &str) -> usize {
        self.mem.lock().unwrap().get(room).map(|v| v.len()).unwrap_or(0)
    }

    /// 启动时从磁盘载入（仅原生；浏览器没有文件系统）。
    #[cfg(not(target_arch = "wasm32"))]
    pub fn load_from_disk(&self) {
        let Some(dir) = &self.dir else { return };
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut map = self.mem.lock().unwrap();
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            // ⚠️ 房间名**从文件头里读**，不靠文件名反推。
            //    文件名只是 `blake3(room)` 的哈希（不可逆），强行还原就等于
            //    又做了一遍有损映射 —— 那正是"研发群/产品群 混进同一房间"的成因。
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let mut it = text.lines();
            let Some(first) = it.next() else { continue };
            let Ok(hdr) = serde_json::from_str::<RoomHeader>(first) else {
                warn!(
                    "历史文件 {} 没有可识别的头部，跳过（不猜房间名）",
                    path.display()
                );
                continue;
            };
            // 文件名哈希必须与头部里的房间名一致 —— 不一致说明文件被挪动或改名，
            // 这时**宁可不加载**，也不能把 A 房的历史塞进 B 房。
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if stem != hdr.hash {
                warn!(
                    "历史文件 {} 的文件名与头部房间不匹配（{} vs {}），跳过",
                    path.display(), stem, hdr.hash
                );
                continue;
            }
            // 头部自校验：marker 与哈希都要对得上才算数
            if !hdr.matches(&hdr.room.clone()) {
                warn!("历史文件 {} 的头部自校验失败，跳过", path.display());
                continue;
            }
            let room = hdr.room.clone();
            let list = map.entry(room.clone()).or_default();
            let mut skipped = 0usize;
            for line in it {
                if let Ok(m) = serde_json::from_str::<ChatMessage>(line) {
                    // ⚠️ **落盘的历史也必须验签**（缺陷 F8）。
                    //
                    // 写路径有兜底校验（`append`），但读路径原来把每一行可解析的
                    // 都收进来 —— 于是任何改动过 `.jsonl` 的事情（有 shell 权限的人、
                    // 备份恢复、早期有 bug 的构建）都会在重启后变成
                    // "看起来已签名"的聊天记录，而客户端从不重新验签、无法察觉。
                    // 签名机制的意义就是在持久化边界上也要成立。
                    if m.verify() {
                        list.push(m);
                    } else {
                        skipped += 1;
                    }
                }
            }
            if skipped > 0 {
                warn!(
                    "历史文件 {} 里有 {skipped} 条验签失败的记录，已丢弃",
                    path.display()
                );
            }
            list.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
            info!("已载入房间 {} 的历史 {} 条", room, list.len());
        }
    }

    /// wasm 下没有文件系统，载入是空操作（保持调用点不变）。
    #[cfg(target_arch = "wasm32")]
    pub fn load_from_disk(&self) {}
}



/// 历史响应的**字节预算**（序列化后的 body 上限）。
///
/// ## 为什么不能只按条数限制（缺陷 F4）
///
/// 服务端原来按条数取上限（`limit.min(1000)`），而单条消息最大
/// `MAX_MESSAGE_SIZE` = 512KB —— 最坏情况 1000 × 512KB ≈ **512MB**，
/// 而收发的 `read_all` 在 **8MB** 就报错（"报文过大"）。
/// 结果：房间里只要累积约 17 条接近上限的大消息，
/// 之后**所有客户端在这个房间的翻页都会失败**（任何包含它们的页都读不回来），
/// 常驻节点还要先把这 512MB 序列化进内存。
///
/// 1MB 的预算：正常聊天一页几十条远不到，又留足了余量。
pub const HISTORY_RESPONSE_MAX_BYTES: usize = 1024 * 1024;

/// 按字节预算裁剪历史页：**保留最新的一批**，从最旧的开始丢。
///
/// 抽成纯函数便于测试（缺陷 F4）：边界条件是"必须至少留 1 条"——
/// 否则一条超大消息就能让这一页变成空的，客户端翻页会永远卡在同一处。
pub fn cap_history_by_bytes(mut msgs: Vec<ChatMessage>, max_bytes: usize) -> Vec<ChatMessage> {
    let mut budget = max_bytes;
    let mut keep_from = msgs.len();
    for (i, m) in msgs.iter().enumerate().rev() {
        // +1 是行分隔/数组逗号的粗略开销
        let n = serde_json::to_vec(m).map(|v| v.len()).unwrap_or(0) + 1;
        // 至少留一条：即使它自己就超预算（否则这一页会空，翻页无法推进）
        if n > budget && keep_from < msgs.len() {
            break;
        }
        budget = budget.saturating_sub(n);
        keep_from = i;
    }
    msgs.split_off(keep_from)
}

/// 历史服务（常驻节点侧）：收到请求 → 返回该房间最近 N 条；顺带通知订阅该房间。
#[derive(Clone, Debug)]
pub struct HistoryService {
    store: HistoryStore,
    join_tx: Sender<String>,
    snaps: Snapshots,
}

impl HistoryService {
    /// 常驻节点用：store 提供历史，join_tx 用于把"第一次见到的房间"通知给订阅任务，
    /// snaps 提供房间快照（成员表 + 文件清单）。
    pub fn new(store: HistoryStore, join_tx: Sender<String>, snaps: Snapshots) -> Self {
        Self {
            store,
            join_tx,
            snaps,
        }
    }
}

impl ProtocolHandler for HistoryService {
    async fn accept(
        &self,
        connection: iroh::endpoint::Connection,
    ) -> std::result::Result<(), AcceptError> {
        let (mut send, mut recv) = connection.accept_bi().await?;
        let req_bytes = read_all(&mut recv)
            .await
            .map_err(|e| AcceptError::from_err(std::io::Error::other(e.to_string())))?;
        let req: HistoryRequest = match serde_json::from_slice(&req_bytes) {
            Ok(r) => r,
            Err(e) => {
                warn!("历史请求解析失败: {e}");
                return Ok(());
            }
        };
        debug!("历史请求 room={} limit={} 现有={}", req.room, req.limit, self.store.count(&req.room));

        // 第一次见到这个房间 → 让 controller 去订阅（常驻节点自动看住每个被访问的房间）
        let _ = self.join_tx.try_send(req.room.clone());

        let resp = HistoryResponse {
            room: req.room.clone(),
            messages: cap_history_by_bytes(
                self.store.recent_before(&req.room, req.before, req.limit.min(1000)),
                HISTORY_RESPONSE_MAX_BYTES,
            ),
            // 顺带把房间快照给客户端 —— 他进房就能看到"屋里都有谁、谁能提供哪些文件"
            snapshot: snapshot_get(&self.snaps, &req.room),
        };
        let body = serde_json::to_vec(&resp).map_err(AcceptError::from_err)?;
        send.write_all(&body).await.map_err(AcceptError::from_err)?;
        send.finish()?;
        connection.closed().await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// RoomNode
// ---------------------------------------------------------------------------

struct Joined {
    room: String,
    topic: iroh_gossip::proto::TopicId,
    sender: Arc<AsyncMutex<GossipSender>>,
    nickname: String,
    /// **我此刻还能发出的 file_id 列表**（最新在前）。
    ///
    /// 真相在 JS 那边（Worker 的 outFiles 才是文件的真正持有者），
    /// Rust 只是**镜像**它：JS 每次变动就调 `set_available_files()` 同步过来，
    /// 心跳再把这份清单广播出去。所以这里不做任何淘汰决策，只是被动记录。
    files: Vec<String>,
    /// **单调**序号（取墙钟毫秒），每次清单/改名发生变化就更新。
    ///
    /// 用途：让接收方丢弃乱序/重放的旧心跳（gossip 不保证顺序）。
    /// ⚠️ 必须**跨页面刷新也单调**，所以用墙钟而不是从 0 开始的计数器 ——
    /// 计数器方案会踩到"刷新后重置为 0 → 被对端当成旧消息丢弃 → 永远显示还在线"。
    epoch: u64,
    _tasks: Vec<AbortOnDropHandle<()>>,
}

struct Inner {
    joined: Option<Joined>,
    peers: HashMap<String, PeerInfo>,
}

pub struct RoomNode {
    endpoint: Endpoint,
    _router: Router,
    gossip: Gossip,
    secret_key: SecretKey,
    memory: MemoryLookup,
    anchor: Option<(EndpointId, RelayUrl)>,
    key_hex: String,
    store: HistoryStore,
    events_tx: Sender<RoomEvent>,
    /// 订阅者列表。`async_channel` 的多个 receiver 是**竞争**关系（一条消息只给一个），
    /// 所以不能直接把 `events_rx.clone()` 给出去 —— 那样两个订阅者会互相抢事件。
    /// 这里做一层**扇出**：内部单一消费者读事件，再分发给所有订阅者。
    subscribers: Arc<Mutex<Vec<Sender<RoomEvent>>>>,
    latest_status: Arc<Mutex<Vec<RelayInfo>>>,
    inner: Arc<Mutex<Inner>>,
    join_rx: Option<Receiver<String>>,
    /// 文件接收服务（数据面）。控制面走 gossip，见 `Wire::File`。
    file_service: FileService,
    /// 房间快照表。只有本节点充当常驻节点（`serve_history`）时才会被更新 ——
    /// 普通客户端不维护它（避免白记账）。
    snaps: Snapshots,
    /// 本节点是否充当常驻节点（在 `serve_history` 为真时才维护快照）
    serve_history: bool,
}

impl RoomNode {
    pub async fn start(opts: RoomOptions) -> Result<Self> {
        let secret_key = match &opts.secret_key_hex {
            Some(hex) => SecretKey::from_str(hex).context("私钥解析失败（需要 64 位 hex）")?,
            None => SecretKey::generate(),
        };
        let key_hex = hex::encode(secret_key.to_bytes());

        let relay_urls: Vec<RelayUrl> = opts
            .relays
            .iter()
            .map(|u| RelayUrl::from_str(u).with_context(|| format!("中继 URL 无法解析: {u}")))
            .collect::<Result<_, _>>()?;
        if relay_urls.is_empty() {
            anyhow::bail!("中继列表为空");
        }

        let anchor = match (&opts.anchor_id, &opts.anchor_relay) {
            (Some(id), Some(relay)) => Some((
                EndpointId::from_str(id).context("anchor id 解析失败")?,
                RelayUrl::from_str(relay).context("anchor relay 解析失败")?,
            )),
            _ => None,
        };

        // 关掉外部地址发现，靠内存地址表 dial by id
        let memory = MemoryLookup::new();
        if let Some((id, relay)) = &anchor {
            memory.add_endpoint_info(EndpointAddr {
                id: *id,
                addrs: [TransportAddr::Relay(relay.clone())].into_iter().collect(),
            });
        }

        // ------------------------------------------------------------------
        // 传输层调优：这是"传文件慢"的关键修复，务必别删。
        //
        // 实测（2026-10-01）：浏览器版 iroh 经中继传文件只有 ~50 KB/s，
        // 而同一路径普通 HTTP 有 630 KB/s。抓 `conn.stats()` + `conn.rtt()` 发现：
        // **拥塞窗口一直停在初始值**，没有增长；RTT 还从 180ms 涨到 1807ms。
        //
        // 根因（与 iroh 上游实测一致，见 n0-computer/iroh#4286）：
        //   1) noq 默认拥塞控制是 **CUBIC**（基于丢包），在高延迟链路上表现极差，
        //      上游实测 CUBIC 比 BBR 慢最多约 30 倍；
        //   2) 默认 **初始拥塞窗口只有 14720 字节（≈10 个包）**，
        //      在 320ms 往返的链路上，14720B ÷ 0.32s ≈ 46 KB/s —— 正好是我们观测到的速度。
        //
        // 修法：换 BBR3（模型驱动、不靠丢包探测）+ 调大初始窗口。
        // 调大后不必等慢启动，开局就能跑满。
        // ------------------------------------------------------------------
        const INITIAL_CWND: u64 = 2 * 1024 * 1024; // 2MB：实测最优，见下方注释
        let transport = {
            let mut bbr = noq_proto::congestion::Bbr3Config::default();
            // 2MB ÷ 0.26s ≈ 7.8 MB/s 起步；且不会大到把中继链路灌爆
            bbr.initial_window(INITIAL_CWND);
            // 只改拥塞控制与初始窗口，**其余窗口保持 iroh 默认**。
            // （试过把 stream/receive 窗口也放大到 8MB/64MB，反而在 8MB 传输时
            //   让接收端 failed —— wasm 内存吃紧，先不动它们。）
            iroh::endpoint::QuicTransportConfig::builder()
                .congestion_controller_factory(std::sync::Arc::new(bbr))
                .build()
        };

        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(secret_key.clone())
            .relay_mode(RelayMode::Custom({
                // 必须在这里调用 with_auth_token：它是就地修改 RelayMap 里已有的条目
                let mut m = RelayMap::from_iter(relay_urls);
                if let Some(t) = opts.relay_token.as_ref().filter(|t| !t.is_empty()) {
                    m = m.with_auth_token(t.clone());
                }
                m
            }))
            .address_lookup(memory.clone())
            .transport_config(transport)
            .alpns(vec![
                GOSSIP_ALPN.to_vec(),
                HISTORY_ALPN.to_vec(),
                FILE_ALPN.to_vec(),
            ])
            .bind()
            .await?;

        let gossip = Gossip::builder()
        .max_message_size(MAX_MESSAGE_SIZE)
        .spawn(endpoint.clone());

        let store = HistoryStore::new(opts.history_dir.as_ref().map(std::path::PathBuf::from));
        if opts.history_dir.is_some() {
            store.load_from_disk();
        }
        // 房间快照表：本节点若充当常驻节点（serve_history），就顺手维护它，
        // 让新进者拉历史时能立刻拿到"屋里都有谁 + 各自能提供哪些文件"。
        let snaps = new_snapshots();

        let (events_tx, events_rx) = async_channel::unbounded::<RoomEvent>();
        let subscribers: Arc<Mutex<Vec<Sender<RoomEvent>>>> = Arc::new(Mutex::new(Vec::new()));

        // 扇出任务：从内部通道读事件，复制给每一个订阅者。
        // 订阅者断开（浏览器刷新 / 任务被 abort）就自动剔除。
        {
            let subs = subscribers.clone();
            let rx = events_rx.clone();
            task::spawn(async move {
                while let Ok(ev) = rx.recv().await {
                    let mut list = subs.lock().unwrap();
                    list.retain(|tx| !tx.is_closed() && tx.try_send(ev.clone()).is_ok());
                }
            });
        }

        let latest_status = Arc::new(Mutex::new(Vec::new()));
        let inner = Arc::new(Mutex::new(Inner {
            joined: None,
            peers: HashMap::new(),
        }));

        // Router：gossip + 文件服务 +（可选）历史服务
        //
        // 订阅请求通道**有界**：请求来自任意 peer，"房间名"就是全部凭据。
        // `unbounded` 会让请求速率直接等于内存增速；满了就丢（`try_send`），
        // 只影响那一次自动订阅，历史照常返回。
        let (join_tx, join_rx) = async_channel::bounded::<String>(1024);
        let file_service = FileService::new();
        let mut builder = Router::builder(endpoint.clone())
            .accept(GOSSIP_ALPN, gossip.clone())
            .accept(FILE_ALPN, file_service.clone());
        let join_rx = if opts.serve_history {
            builder =
                builder.accept(HISTORY_ALPN, HistoryService::new(store.clone(), join_tx, snaps.clone()));
            Some(join_rx)
        } else {
            None
        };
        let router = builder.spawn();

        // 中继状态观察
        {
            let endpoint = endpoint.clone();
            let events = events_tx.clone();
            let latest = latest_status.clone();
            task::spawn(async move {
                let mut stream = endpoint.home_relay_status().stream();
                while let Some(statuses) = stream.next().await {
                    let infos: Vec<RelayInfo> = statuses
                        .iter()
                        .map(|s| RelayInfo {
                            url: s.url().to_string(),
                            connected: s.is_connected(),
                            last_error: s.last_error().map(|e| e.to_string()),
                            auth_denied: s.auth_denied_reason().map(|r| r.to_string()),
                        })
                        .collect();
                    *latest.lock().unwrap() = infos.clone();
                    if events.send(RoomEvent::RelayStatus { relays: infos }).await.is_err() {
                        break;
                    }
                }
            });
        }

        Ok(Self {
            endpoint,
            _router: router,
            gossip,
            secret_key,
            memory: memory.clone(),
            anchor,
            key_hex,
            store,
            events_tx,
            subscribers,
            latest_status,
            inner,
            join_rx,
            file_service,
            snaps,
            serve_history: opts.serve_history,
        })
    }

    /// 常驻节点专用：拿到"被请求但未订阅"的房间名。
    pub fn take_join_receiver(&mut self) -> Option<Receiver<String>> {
        self.join_rx.take()
    }

    pub fn history(&self) -> HistoryStore {
        self.store.clone()
    }

    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    pub fn secret_key_hex(&self) -> String {
        self.key_hex.clone()
    }

    pub async fn online(&self) {
        self.endpoint.online().await
    }

    pub fn relay_status(&self) -> Vec<RelayInfo> {
        self.latest_status.lock().unwrap().clone()
    }

    /// 订阅房间事件。
    ///
    /// **每个调用者拿到独立的事件流**（真正的广播语义）：
    /// 内部只有一个消费者读原始通道，再由扇出任务复制给所有订阅者。
    /// 这样 UI、日志、传输逻辑可以各订阅一份，互不抢事件。
    pub fn subscribe(&self) -> Receiver<RoomEvent> {
        let (tx, rx) = async_channel::unbounded();
        self.subscribers.lock().unwrap().push(tx);
        rx
    }

    pub fn remember_peer(&self, id_hex: &str, relay: &str) {
        let (Ok(id), Ok(relay)) = (EndpointId::from_str(id_hex), RelayUrl::from_str(relay)) else {
            return;
        };
        self.memory.add_endpoint_info(EndpointAddr {
            id,
            addrs: [TransportAddr::Relay(relay)].into_iter().collect(),
        });
    }

    pub fn current_room(&self) -> Option<String> {
        self.inner.lock().unwrap().joined.as_ref().map(|j| j.room.clone())
    }

    /// 进入房间。重复进入同一房间只更新昵称。
    pub async fn join(&self, room: &str, nickname: &str) -> Result<()> {
        let topic = topic_id(room);
        let same = {
            let g = self.inner.lock().unwrap();
            g.joined.as_ref().map(|j| j.topic == topic).unwrap_or(false)
        };
        if same {
            if let Some(j) = self.inner.lock().unwrap().joined.as_mut() {
                j.nickname = nickname.to_string();
            }
            self.broadcast_presence().await;
            return Ok(());
        }

        // 离开旧房间（AbortOnDropHandle 会随 Joined 一起被丢弃而中止任务）
        {
            let mut g = self.inner.lock().unwrap();
            g.joined = None;
            g.peers.clear();
        }

        let bootstrap: Vec<EndpointId> = self.anchor.iter().map(|(id, _)| *id).collect();

        // ⚠️ 先"敲一下"常驻节点：它是按需订阅房间的（收到历史请求才订阅）。
        //    不先敲，就会出现死锁：客户端等 anchor 进房间，anchor 等客户端来要历史。
        if !bootstrap.is_empty() {
            match n0_future::time::timeout(Duration::from_secs(10), self.fetch_history(room, 1)).await {
                Ok(Ok(_)) => info!("已通知常驻节点订阅房间 {room}"),
                Ok(Err(e)) => warn!("通知常驻节点失败（继续尝试进房）: {e}"),
                Err(_) => warn!("通知常驻节点超时（继续尝试进房）"),
            }
        }

        // ⚠️ 关键：`subscribe()` 不等 bootstrap 连上就返回；若那次拨号失败，本端会永远孤岛
        //    （实测：两个浏览器同时进房，一个收到消息、另一个什么也收不到）。
        //    有 bootstrap 时用 `subscribe_and_join()`（等至少一个连接建立），并带重试。
        let gossip_topic = if bootstrap.is_empty() {
            self.gossip.subscribe(topic, vec![]).await?
        } else {
            let mut last_err: Option<anyhow::Error> = None;
            let mut topic_opt = None;
            for attempt in 1..=4 {
                match n0_future::time::timeout(
                    Duration::from_secs(20),
                    self.gossip.subscribe_and_join(topic, bootstrap.clone()),
                )
                .await
                {
                    Ok(Ok(t)) => {
                        info!("第 {attempt} 次进入房间 {room} 成功（已连上至少一个成员）");
                        topic_opt = Some(t);
                        break;
                    }
                    Ok(Err(e)) => {
                        warn!("第 {attempt} 次 join 失败: {e}");
                        last_err = Some(e.into());
                    }
                    Err(_) => {
                        warn!("第 {attempt} 次 join 超时（20s 内没连上常驻节点）");
                        last_err = Some(anyhow::anyhow!("连接常驻节点超时"));
                    }
                }
                n0_future::time::sleep(Duration::from_secs(2)).await;
            }
            match topic_opt {
                Some(t) => t,
                None => {
                    let msg = last_err
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "未知错误".into());
                    self.events_tx
                        .send(RoomEvent::Error {
                            message: format!("进房间失败（连不上常驻节点）：{msg}"),
                        })
                        .await
                        .ok();
                    anyhow::bail!("进房间失败：{msg}");
                }
            }
        };
        let (sender, receiver) = gossip_topic.split();
        let sender = Arc::new(AsyncMutex::new(sender));

        {
            let mut g = self.inner.lock().unwrap();
            g.joined = Some(Joined {
                room: room.to_string(),
                topic,
                sender: sender.clone(),
                nickname: nickname.to_string(),
                // 进房时还没同步过文件清单，等 JS 调 `set_available_files()` 补上
                files: Vec::new(),
                // ⚠️ 用**墙钟毫秒**当起点，不能用 0。
                //
                // 这是一次真实踩到的坑：刷新页面后 epoch 从 0 重新开始，而对方
                // 存的是刷新前的高位值 → 刷新者之后发的每一条心跳都被判成
                // "乱序旧消息"直接丢弃 → 他在别人眼里**永远是"还在线、还能发文件"**，
                // 文件到期判定彻底失效（实测：刷新 20 秒后对方仍显示"可接收"）。
                // 墙钟跨刷新单调，天然解决。
                epoch: now_ms(),
                _tasks: Vec::new(),
            });
        }
        info!("已订阅房间 {room}");

        // 任务 1：消费 gossip 事件
        let t1 = task::spawn({
            let inner = self.inner.clone();
            let events = self.events_tx.clone();
            let room_s = room.to_string();
            let me = self.endpoint.id().to_string();
            // 收到"可用性质询"时，若我就是被问的人、且手里还有这个文件，
            // 需要立刻重播一次心跳来"认领" —— 那要用到私钥签名
            // 常驻节点才有值：收到心跳时顺手更新房间快照。
            // （普通客户端不记账 —— 快照对它没用，维护它纯属浪费。）
            let snaps_t = if self.serve_history {
                Some(self.snaps.clone())
            } else {
                None
            };
            let mut receiver = receiver;
            async move {
                while let Some(ev) = receiver.next().await {
                    match ev {
                        Ok(GossipEvent::Received(msg)) => {
                            let Ok(wire) = serde_json::from_slice::<Wire>(&msg.content) else {
                                continue;
                            };
                            match wire {
                                Wire::Message { m } => {
                                    if !m.verify() {
                                        warn!("签名无效的消息，丢弃");
                                        continue;
                                    }
                                    let mine = m.from == me;
                                    let current = inner
                                        .lock()
                                        .unwrap()
                                        .joined
                                        .as_ref()
                                        .map(|j| j.room.clone());
                                    if current.as_deref() != Some(room_s.as_str()) {
                                        continue; // 已经切走了
                                    }
                                    events
                                        .send(RoomEvent::Message {
                                            room: room_s.clone(),
                                            message: m,
                                            mine,
                                        })
                                        .await
                                        .ok();
                                }
                                Wire::File { c } => {
                                    // 文件控制消息：验签后转成 UI 事件（内容走独立数据流）
                                    if let Some(ctrl) = c.verify() {
                                        // ⚠️ **只用 `if let Some(...)` 跳过非法消息**。
                                        //    这里绝不能出现 `return` —— 它位于消费任务的
                                        //    `async move` 体内，`return` 会结束整个房间的
                                        //    gossip 循环（缺陷 F1）。合法性判断全部在
                                        //    `ctrl_event` 里，并已被回归测试覆盖。
                                        if let Some(ev) = ctrl_event(ctrl, &c.from, &room_s, c.ts) {
                                            events.send(ev).await.ok();
                                        }
                                    }
                                }
                                Wire::Presence { p } => {
                                    if !p.verify() {
                                        continue;
                                    }
                                    let changed = {
                                        let mut g = inner.lock().unwrap();
                                        let prev = g.peers.get(&p.from).cloned();
                                        // ⚠️ 丢弃乱序/重放的旧心跳。
                                        //    gossip 不保证顺序，一条迟到的旧心跳会把刚更新的
                                        //    文件清单打回旧值 —— 表现为"卡片明明能收了又变回过期"。
                                        if let Some(x) = prev.as_ref() {
                                            if p.epoch < x.epoch {
                                                continue;
                                            }
                                        }
                                        // 变化了就推事件：昵称变了、**文件清单变了**、或是新人。
                                        // 文件清单也算变化，否则前端看不到"他刚又能发了"，
                                        // 卡片的"已过期 → 可接收"就翻不过来。
                                        let changed = prev
                                            .as_ref()
                                            .map(|x| x.nickname != p.nickname || x.files != p.files)
                                            .unwrap_or(true);
                                        g.peers.insert(
                                            p.from.clone(),
                                            PeerInfo {
                                                id: p.from.clone(),
                                                nickname: p.nickname.clone(),
                                                last_seen_ms: now_ms(),
                                                files: p.files.clone(),
                                                epoch: p.epoch,
                                            },
                                        );
                                        changed
                                    };
                                    // 常驻节点顺手把这条心跳记进房间快照
                                    if let Some(sn) = &snaps_t {
                                        snapshot_upsert(
                                            sn,
                                            &room_s,
                                            MemberSnapshot {
                                                id: p.from.clone(),
                                                nickname: p.nickname.clone(),
                                                last_seen_ms: now_ms(),
                                                files: p.files.clone(),
                                                epoch: p.epoch,
                                            },
                                        );
                                    }
                                    if changed {
                                        let peers: Vec<PeerInfo> = inner
                                            .lock()
                                            .unwrap()
                                            .peers
                                            .values()
                                            .cloned()
                                            .collect();
                                        events
                                            .send(RoomEvent::Presence {
                                                room: room_s.clone(),
                                                peers,
                                            })
                                            .await
                                            .ok();
                                    }
                                }
                                // 对方**主动离开房间**（切到别的房间时发的加速声明）。
                                // 这是"加速器"：立刻把他从成员表摘掉 → 他的文件随之变过期，
                                // 不用等 25~45 秒的心跳超时。事实仍以心跳为准。
                                Wire::Leave { l } => {
                                    if !l.verify() {
                                        continue;
                                    }
                                    let removed = {
                                        let mut g = inner.lock().unwrap();
                                        g.peers.remove(&l.from).is_some()
                                    };
                                    if let Some(sn) = &snaps_t {
                                        snapshot_drop(sn, &room_s, &l.from);
                                    }
                                    if removed {
                                        debug!("[{}] {} 声明离开房间", room_s, l.from);
                                        let peers: Vec<PeerInfo> = inner
                                            .lock()
                                            .unwrap()
                                            .peers
                                            .values()
                                            .cloned()
                                            .collect();
                                        events
                                            .send(RoomEvent::Presence {
                                                room: room_s.clone(),
                                                peers,
                                            })
                                            .await
                                            .ok();
                                    }
                                }
                                // 收到"可用性质询"：**只有被问的那个人**需要回应。
                                // 回应方式就是重播一次心跳（带上我的文件清单），
                                // 不需要专门设计一条应答消息 —— 复用同一条软状态通道。
                                // 若我确实已经没有这个文件了，就**什么都不做**（沉默 = 过期）。
                                Wire::FileQuery { q } => {
                                    if !q.verify() {
                                        continue;
                                    }
                                    let should_claim = q.want == me
                                        && {
                                            let g = inner.lock().unwrap();
                                            match g.joined.as_ref() {
                                                Some(j) => {
                                                    j.room == room_s
                                                        && j.files.iter().any(|f| f == &q.file_id)
                                                }
                                                None => false,
                                            }
                                        };
                                    if should_claim {
                                        debug!("[{}] 被问及文件可用性 {}，转给 Worker 重发邀约", room_s, q.file_id);
                                        // 交给 Worker：只有它手里有完整的 FileMeta，
                                        // 而**重发一次邀约**是比"再播一次心跳"更明确的回应
                                        // （对方直接拿到可接收的卡片）。
                                        events
                                            .send(RoomEvent::FileQueryAsked {
                                                room: room_s.clone(),
                                                file_id: q.file_id.clone(),
                                                by: q.from.clone(),
                                            })
                                            .await
                                            .ok();
                                    }
                                }
                            }
                        }
                        Ok(GossipEvent::NeighborUp(id)) => {
                            debug!("邻居上线 {id}");
                            events.send(RoomEvent::PeerUp { id: id.to_string() }).await.ok();
                        }
                        Ok(GossipEvent::NeighborDown(id)) => {
                            debug!("邻居下线 {id}");
                            {
                                let mut g = inner.lock().unwrap();
                                g.peers.remove(&id.to_string());
                            }
                            events.send(RoomEvent::PeerDown { id: id.to_string() }).await.ok();
                        }
                        Ok(GossipEvent::Lagged) => warn!("gossip 落后，丢弃了部分事件"),
                        Err(e) => {
                            warn!("gossip 事件错误: {e}");
                            break;
                        }
                    }
                }
            }
        });

        // 任务 2：心跳（成员 + 文件清单，两种节奏）+ 清理超时成员
        //
        // 用一个 1 秒的细 tick 分别给两条心跳计时，而不是开两个任务：
        //   · 成员心跳：每 10 秒一次，恒定发（不管手里有没有文件）
        //   · 文件清单心跳：**只有手里有文件时**才每 3 秒发一次
        //
        // 为什么要拆成两种节奏：成员表为了不误判（丢包就闪离线）必须保守，
        // 但"文件能不能收"是用户点一下就立刻想知道的事 —— 用同一条慢心跳
        // 会让文件过期判定拖到 25~45 秒。所以给文件单独一条快心跳，
        // 代价是"有文件在手时才多发一条"，没文件时增量为 0。
        let t2 = task::spawn({
            let inner = self.inner.clone();
            let events = self.events_tx.clone();
            let key = self.secret_key.clone();
            let room_s = room.to_string();
            async move {
                let mut ticker = n0_future::time::interval(HB_TICK);
                let mut last_member: u64 = 0;
                let mut last_file: u64 = 0;
                loop {
                    ticker.tick().await;
                    let (nickname, files, epoch, sender) = {
                        let g = inner.lock().unwrap();
                        match g.joined.as_ref() {
                            Some(j) if j.room == room_s => (
                                j.nickname.clone(),
                                j.files.clone(),
                                j.epoch,
                                j.sender.clone(),
                            ),
                            // 已经离开这个房间 → 任务收尾
                            _ => break,
                        }
                    };
                    let now = now_ms();
                    let member_due = now.saturating_sub(last_member) >= PRESENCE_INTERVAL.as_millis() as u64;
                    let file_due = !files.is_empty()
                        && now.saturating_sub(last_file) >= FILE_HB_MS;
                    if member_due || file_due {
                        let p = Presence::signed(&key, &nickname, files, epoch);
                        if let Ok(bytes) = serde_json::to_vec(&Wire::Presence { p }) {
                            let _ = sender.lock().await.broadcast(bytes.into()).await;
                        }
                        if member_due {
                            last_member = now;
                        }
                        if file_due {
                            last_file = now;
                        }
                    }
                    // 清理超时成员：只在成员心跳那一拍做（10 秒一轮）
                    if !member_due {
                        continue;
                    }
                    let changed = {
                        let mut g = inner.lock().unwrap();
                        let before = g.peers.len();
                        g.peers.retain(|_, i| now.saturating_sub(i.last_seen_ms) < PRESENCE_TTL_MS);
                        before != g.peers.len()
                    };
                    if changed {
                        let peers: Vec<PeerInfo> =
                            inner.lock().unwrap().peers.values().cloned().collect();
                        events
                            .send(RoomEvent::Presence {
                                room: room_s.clone(),
                                peers,
                            })
                            .await
                            .ok();
                    }
                }
            }
        });

        // 把任务句柄挂到 Joined 上：离开房间（或 node 被 drop）时自动中止
        {
            let mut g = self.inner.lock().unwrap();
            if let Some(j) = g.joined.as_mut() {
                j._tasks.push(AbortOnDropHandle::new(t1));
                j._tasks.push(AbortOnDropHandle::new(t2));
            }
        }

        self.events_tx.send(RoomEvent::Joined { room: room.to_string() }).await.ok();
        self.broadcast_presence().await;
        Ok(())
    }

    async fn broadcast_presence(&self) {
        broadcast_presence_now(&self.secret_key, &self.inner).await;
    }

    /// 改名：**立即广播**，不再等下一轮心跳。
    ///
    /// 以前 `set_nickname` 只改本地字段，靠 10 秒后的心跳带出去 ——
    /// 改个名字要等最多 10 秒别人才看到，没道理。取名时同步 bump 一次 epoch，
    /// 让接收方即使收到乱序的旧心跳也不会把名字打回旧值。
    pub fn set_nickname(&self, name: &str) {
        let changed = {
            let mut g = self.inner.lock().unwrap();
            match g.joined.as_mut() {
                Some(j) if j.nickname != name => {
                    j.nickname = name.to_string();
                    j.epoch = now_ms();   // 单调：见 Joined::epoch 的说明
                    true
                }
                _ => false,
            }
        };
        if changed {
            // 这是同步接口，只能 spawn 出去广播；失败也无所谓（下一轮心跳会带上）
            let key = self.secret_key.clone();
            let inner = self.inner.clone();
            task::spawn(async move { broadcast_presence_now(&key, &inner).await });
        }
    }

    /// JS 侧同步"我此刻还能发出的文件"清单（真身在 Worker 的 outFiles 里）。
    ///
    /// 每次变动调用一次，传入完整列表（幂等，不做增量）。内部会 bump epoch。
    /// 清单变了就**立刻广播一次**，这样"新发了一个文件"能马上被房间里的人看到，
    /// 不用等文件心跳的那 3 秒。
    pub fn set_available_files(&self, ids: Vec<String>) {
        let changed = {
            let mut g = self.inner.lock().unwrap();
            match g.joined.as_mut() {
                Some(j) => {
                    if j.files == ids {
                        // ⚠️ 清单没变就**不要**动 epoch，但也不能什么都不做：
                        //    刷新后进房时 files 本来就是空的，此时 sync 空清单
                        //    会因为"没变化"而跳过 —— 那正好，因为进房那一步
                        //    已经用新 epoch 广播过一次了。
                        false
                    } else {
                        j.files = ids;
                        j.epoch = now_ms();   // 单调：见 Joined::epoch 的说明
                        true
                    }
                }
                None => false,
            }
        };
        if changed {
            let key = self.secret_key.clone();
            let inner = self.inner.clone();
            task::spawn(async move { broadcast_presence_now(&key, &inner).await });
        }
    }

    /// **离开当前房间**（不发 Reject、也不关节点，只是退订）。
    ///
    /// 顺序很关键：**先广播"我走了"，再退订**。
    /// 这是整套设计里唯一一个"离开声明"能可靠发出去的时机 ——
    /// 页面还活着、连接还在、有充足时间完成序列化→签名→QUIC 写。
    /// 收到的人会立刻把本端从成员表移除（他的文件也随之变过期），
    /// 不必等 25~45 秒的心跳超时。
    ///
    /// ⚠️ 刷新/关页/崩溃走不到这里（前端调不到），那些场景由心跳超时兜底 ——
    /// 这正是"不把离开声明当事实来源"的原因。
    pub async fn leave_room(&self) {
        let sender = {
            let g = self.inner.lock().unwrap();
            match g.joined.as_ref() {
                Some(j) => j.sender.clone(),
                None => return,
            }
        };
        let l = LeaveMsg::signed(&self.secret_key);
        if let Ok(bytes) = serde_json::to_vec(&Wire::Leave { l }) {
            let _ = sender.lock().await.broadcast(bytes.into()).await;
        }
        // 再退订（drop Joined 会 abort 掉两个后台任务）
        {
            let mut g = self.inner.lock().unwrap();
            g.joined = None;
            g.peers.clear();
        }
    }

    /// 广播一条消息（自动签名、自动存本地历史）。
    pub async fn send(&self, text: &str) -> Result<ChatMessage> {
        let (nickname, sender, room) = {
            let g = self.inner.lock().unwrap();
            match g.joined.as_ref() {
                Some(j) => (j.nickname.clone(), j.sender.clone(), j.room.clone()),
                None => anyhow::bail!("还没进房间"),
            }
        };
        let ts = now_ms();
        let from = self.endpoint.id().to_string();
        let msg = ChatMessage {
            id: ChatMessage::compute_id(&from, ts, text, ""),
            from,
            nickname,
            text: text.to_string(),
            ts,
            sig: String::new(),
            // 普通文本消息没有文件证明
            file: None,
        }
        .sign(&self.secret_key);

        let bytes = serde_json::to_vec(&Wire::Message { m: msg.clone() })?;
        sender.lock().await.broadcast(bytes.into()).await?;
        // 自己刚签的消息必然验得过；忽略返回值（失败也会有 warn）
        let _ = self.store.append(&room, msg.clone());
        Ok(msg)
    }

    /// 从常驻节点拉历史消息。
    pub async fn fetch_history(&self, room: &str, limit: usize) -> Result<HistoryResponse> {
        self.fetch_history_before(room, limit, None).await
    }

    /// before = Some(ts) 时返回更早的消息（上拉加载更多用）。
    ///
    /// 返回值里除了消息，还带一份**房间快照**（成员表 + 各人的文件清单）。
    /// 这样新进房间的人**进房即刻**就知道屋里都有谁、谁能提供哪些文件，
    /// 不用干等最多 10 秒的第一轮心跳。快照只是提示，真事实仍是心跳。
    pub async fn fetch_history_before(
        &self,
        room: &str,
        limit: usize,
        before: Option<(u64, String)>,
    ) -> Result<HistoryResponse> {
        let Some((id, relay)) = &self.anchor else {
            return Ok(HistoryResponse {
                room: room.to_string(),
                messages: Vec::new(),
                snapshot: None,
            });
        };
        let conn = self
            .endpoint
            .connect(EndpointAddr::new(*id).with_relay_url(relay.clone()), HISTORY_ALPN)
            .await
            .context("连接常驻节点失败")?;
        let (mut send, mut recv) = conn.open_bi().await?;
        let req = HistoryRequest {
            room: room.to_string(),
            limit,
            before,
        };
        send.write_all(&serde_json::to_vec(&req)?).await?;
        send.finish()?;
        let body = read_all(&mut recv).await?;
        conn.close(0u8.into(), b"done");
        let mut resp: HistoryResponse =
            serde_json::from_slice(&body).context("历史响应解析失败")?;
        // ⚠️ 历史消息**必须逐条验签**（缺陷 F8）。
        //
        // 常驻节点是转发者，而签名机制的意义正是"转发者无法伪造作者身份"。
        // 原来客户端直接 `from_slice` 就返回，等于把这条性质丢在读路径上：
        // 一个被改过的 `.jsonl`（或一个被替换的锚点）能凭空造出
        // "某人在某个房间说过的话"，而客户端完全无法察觉。
        // 顺带也把"新旧协议混跑"的历史挡在 UI 之外（v2 消息在这里验不过）。
        let before = resp.messages.len();
        resp.messages.retain(|m| m.verify());
        let dropped = before - resp.messages.len();
        if dropped > 0 {
            warn!("历史响应里有 {dropped} 条验签失败的消息，已丢弃（共 {before} 条）");
        }
        Ok(resp)
    }

    /// 把历史响应里的**房间快照**并进本地成员表。
    ///
    /// ⚠️ 只用于"补上我还没见过的人"：已经在本地表里的一律以本地心跳为准
    /// （本地那份更新），避免用快照把一个正在正常心跳的人覆盖成旧状态。
    /// 补进来的条目按"现在刚见到"记账，所以如果对方其实已经走了，
    /// 最多 35 秒后被常规超时清理掉 —— 和整套设计的检测延迟一致，
    /// 而且点击时还有质询式补偿兜底。
    pub async fn apply_snapshot(&self, snap: &RoomSnapshot, room: &str) {
        let added = {
            let mut g = self.inner.lock().unwrap();
            // 只在这个快照属于当前房间时才采纳
            let same_room = g
                .joined
                .as_ref()
                .map(|j| j.room == room)
                .unwrap_or(false);
            if !same_room {
                return;
            }
            let now = now_ms();
            let mut added = 0usize;
            for m in &snap.members {
                if m.id == self.endpoint.id().to_string() {
                    continue; // 自己不用进成员表
                }
                if g.peers.contains_key(&m.id) {
                    continue; // 本地已有更新鲜的信息
                }
                g.peers.insert(
                    m.id.clone(),
                    PeerInfo {
                        id: m.id.clone(),
                        nickname: m.nickname.clone(),
                        last_seen_ms: now,
                        files: m.files.clone(),
                        epoch: m.epoch,
                    },
                );
                added += 1;
            }
            added
        };
        if added > 0 {
            debug!("从房间快照补进 {added} 个成员");
            let peers: Vec<PeerInfo> = self.inner.lock().unwrap().peers.values().cloned().collect();
            self.events_tx
                .send(RoomEvent::Presence {
                    room: room.to_string(),
                    peers,
                })
                .await
                .ok();
        }
    }

    // -----------------------------------------------------------------------
    // 文件传输
    // -----------------------------------------------------------------------

    /// 广播一条文件控制消息（走 gossip）。
    ///
    /// `expect_room` 是**必填**参数 —— 所有文件控制消息都必须在广播瞬间
    /// 仍处于"它本来该在的那个房间"。
    ///
    /// ⚠️ 这里刻意不做成 `Option`：缺陷 F7 的根因就是"有一条不限定房间的
    /// `send_ctrl` 入口"，于是 `Accept`/`Reject`/`Query` 都从那里漏了出去。
    /// 现在**没有任何调用方可以忘记传房间**（类型上就不允许）。
    ///
    /// 这是**发送侧的最后一个安全闸**：从这里到 `broadcast()` 之间虽然只有几行，
    /// 但 gossip 的锁是 `async` 的，足够让一次 `join` 插进来，所以下面还要再核一次。
    async fn send_ctrl_in(&self, ctrl: &FileCtrl, expect_room: &str) -> Result<()> {
        let (sender, room) = {
            let g = self.inner.lock().unwrap();
            match g.joined.as_ref() {
                Some(j) => (j.sender.clone(), j.room.clone()),
                None => anyhow::bail!("还没进房间"),
            }
        };
        if room != expect_room {
            anyhow::bail!("房间已改变（期望 {expect_room}，当前 {room}），消息未发出");
        }
        let signed = SignedCtrl::sign(&self.secret_key, ctrl, now_ms());
        let bytes = serde_json::to_vec(&Wire::File { c: signed })?;
        sender.lock().await.broadcast(bytes.into()).await?;
        debug!("[{}] 已广播文件控制：{}", room, ctrl.file_id());
        Ok(())
    }

    /// 发起文件邀约（只发元信息；这一步不会传任何内容）。
    ///
    /// 对方接受后会广播 `Accept`，届时调用 [`RoomNode::send_file_data`] 才真正传。
    ///
    /// ## `expect_room` 不是可选的（报告 P1-7）
    ///
    /// 上层算文件哈希要读整个文件，大文件要好几秒。这期间用户可以切房间，
    /// 而广播用的是**节点此刻所在的房间** —— 于是"本来要发给 A 房"的
    /// 邀约被发到了 B 房，私密文件的元信息（文件名/大小）就泄露给了 B 房成员，
    /// 他们点接受还能真的拿到内容。
    ///
    /// 这里把"发起时意图的房间"传下来，与当前房间比对：不一致就
    /// **直接失败**，让上层提示用户重新发送。
    /// 宁可不发，也不要发错房间。
    pub async fn invite_file(&self, meta: &FileMeta, expect_room: &str) -> Result<()> {
        {
            let g = self.inner.lock().unwrap();
            let cur = g.joined.as_ref().map(|j| j.room.as_str()).unwrap_or("");
            if cur != expect_room {
                anyhow::bail!(
                    "房间已改变（期望 {expect_room}，当前 {}），文件未发出",
                    if cur.is_empty() { "（未进房间）" } else { cur }
                );
            }
        }
        self.send_ctrl_in(&FileCtrl::Invite(meta.clone()), expect_room)
            .await?;
        // 同时广播一条「文件存在的证明」。
        //
        // 为什么这么做：邀约走的是"发送那一刻 broadcast 一次"的瞬时控制消息，
        // **后进房间的人完全收不到**（既看不到卡片，也无从接收）。
        // 把证明当普通消息发出去，它就会被常驻节点按普通消息存进历史 ——
        // 于是谁进来都能看到"这里曾经有过一个文件"。
        //
        // ⚠️ 这是"证明"不是"内容"：只有 file_id / 名字 / 大小，几十字节。
        //    而且它带的是**发送方自己的签名**，常驻节点只是转发+存储，
        //    无法伪造"某人发过某个文件"。
        //
        // 失败不影响传输本身（对方已经能看到实时卡片），所以只记警告。
        if let Err(e) = self.send_file_proof(meta, expect_room).await {
            warn!("文件证明广播失败（不影响传输本身）: {e:#}");
        }
        Ok(())
    }

    /// 广播一条「文件证明」（不限定房间）。
    ///
    /// ⚠️ 调用方要清楚自己在给**哪个房间**发证明 —— 文件证明是"这里曾经有过
    /// 一个文件"的公开声明，发错房间等于泄露文件名与大小。
    pub async fn send_file_proof_any_room(&self, meta: &FileMeta) -> Result<()> {
        let room = {
            let g = self.inner.lock().unwrap();
            match g.joined.as_ref() {
                Some(j) => j.room.clone(),
                None => anyhow::bail!("还没进房间"),
            }
        };
        self.send_file_proof(meta, &room).await
    }

    /// 广播一条「文件证明」消息。`text` 留空 —— 卡片由 `file` 字段渲染，
    /// 不污染聊天正文。
    pub async fn send_file_proof(&self, meta: &FileMeta, expect_room: &str) -> Result<()> {
        let (nickname, sender, room) = {
            let g = self.inner.lock().unwrap();
            match g.joined.as_ref() {
                Some(j) => (j.nickname.clone(), j.sender.clone(), j.room.clone()),
                None => anyhow::bail!("还没进房间"),
            }
        };
        // 文件证明同样不能发错房间 —— 它公开声明"这里有过这个文件（名字+大小）"。
        if room != expect_room {
            anyhow::bail!("房间已改变（期望 {expect_room}，当前 {room}），文件证明未发出");
        }
        let ts = now_ms();
        let from = self.endpoint.id().to_string();
        let msg = ChatMessage {
            // id 里带上 file_id，保证同一毫秒发的两个文件不会撞 id
            id: ChatMessage::compute_id(&from, ts, "", &meta.file_id),
            from,
            nickname,
            text: String::new(),
            ts,
            sig: String::new(),
            file: Some(FileRef {
                file_id: meta.file_id.clone(),
                name: meta.name.clone(),
                size: meta.size,
                mime: meta.mime.clone(),
            }),
        }
        .sign(&self.secret_key);
        let bytes = serde_json::to_vec(&Wire::Message { m: msg.clone() })?;
        sender.lock().await.broadcast(bytes.into()).await?;
        let _ = self.store.append(&room, msg);
        Ok(())
    }

    /// 广播一条**可用性质询**（点了一张联系不上的文件卡片时用）。
    ///
    /// 语义：公开问"`want` 这个人现在还能提供 `file_id` 吗"。
    /// 他若还持有，会重播心跳（带文件清单）来认领，所有人的卡片随之恢复可用；
    /// 沉默即视为过期。**不需要专门的应答消息** —— 复用同一套软状态。
    ///
    /// `expect_room`：**必填**。与 `invite_file` 同理（报告 P1-7 的另一半，缺陷 F7）：
    /// 卡片可能在别的房间被点，而这条质询只对"邀约所在的那个房间"有意义。
    pub async fn query_file(&self, file_id: &str, want: &str, expect_room: &str) -> Result<()> {
        let (sender, room) = {
            let g = self.inner.lock().unwrap();
            match g.joined.as_ref() {
                Some(j) => (j.sender.clone(), j.room.clone()),
                None => anyhow::bail!("还没进房间"),
            }
        };
        if room != expect_room {
            anyhow::bail!("房间已改变（期望 {expect_room}，当前 {room}），质询未发出");
        }
        let q = FileQuery::signed(&self.secret_key, file_id, want);
        let bytes = serde_json::to_vec(&Wire::FileQuery { q })?;
        // 与 send_ctrl_in 同理：broadcast 之前最后一刻再核一次
        // （gossip 的锁是 async 的，检查与发送之间足够插进一次 join）
        {
            let g = self.inner.lock().unwrap();
            match g.joined.as_ref() {
                Some(j) if j.room == expect_room => {}
                Some(j) => anyhow::bail!(
                    "房间已改变（期望 {expect_room}，当前 {}），质询未发出",
                    j.room
                ),
                None => anyhow::bail!("还没进房间"),
            }
        }
        sender.lock().await.broadcast(bytes.into()).await?;
        Ok(())
    }

    /// 接受对方的文件邀约。
    ///
    /// **必须在广播 `Accept` 之前**拿到返回的接收端（这样数据来了不会丢）：
    /// 先调用它拿到 `rx`，再把 `rx` 交给 `crate::transfer_orchestrator::receive_file`。
    ///
    /// `have`：本端已拥有的块位图（断点续传），没有就传空。
    ///
    /// `meta_json`：**邀约里的完整元信息**（JSON 串）。它不是可选的 ——
    /// 登记时会把 `meta.sender` 记成"我期待的发送方"，入站数据流要拿它跟
    /// 真实连接对端核对。只给 file_id 的话等于放弃授权，第三方就能顶替发送方。
    ///
    /// `expect_room`：**必填**。`Accept` 是广播消息，而卡片可能在别的房间被点
    /// （`restoreInvites` 曾经不看房间）—— 不绑定房间就会出现
    /// "Accept 发进了 B 房间、发送方在 A 房间永远收不到、接收侧永久卡住"（缺陷 F7/F13）。
    pub async fn accept_file(
        &self,
        file_id: &str,
        meta_json: &str,
        have: Vec<u8>,
        receiver_relay: &str,
        expect_room: &str,
    ) -> Result<(Receiver<FileChunk>, Sender<crate::filetransfer::FileAck>)> {
        let meta: FileMeta = serde_json::from_str(meta_json)
            .map_err(|e| anyhow::anyhow!("邀约元信息解析失败: {e}"))?;
        if meta.file_id != file_id {
            anyhow::bail!(
                "元信息与 file_id 不符：{} vs {file_id}",
                meta.file_id
            );
        }
        // ⚠️ **失败关闭**：元信息非法就绝不登记、绝不广播 Accept。
        //    空 `root_hash`、非约定的 `chunk_size`、超大块数都属于这一类 ——
        //    它们会让接收端"无法校验内容"，而无法校验的内容不该被接受（F17）。
        //    上游 `ctrl_event` 已经在显示卡片前拦过一道，这里是授权表这一侧的兜底。
        crate::filetransfer::validate_meta(&meta).map_err(|why| {
            anyhow::anyhow!("邀约元信息非法，拒绝接收：{why}")
        })?;
        // ⚠️ 先确认还在邀约所在的那个房间 —— 不满足就**不登记**（避免表里留下
        //    一条永远等不到数据流的条目）。
        {
            let g = self.inner.lock().unwrap();
            match g.joined.as_ref() {
                Some(j) if j.room == expect_room => {}
                Some(j) => anyhow::bail!(
                    "房间已改变（期望 {expect_room}，当前 {}），未接受该文件",
                    j.room
                ),
                None => anyhow::bail!("还没进房间"),
            }
        }
        // ⚠️ 关键：**先把可能还在跑的旧接收任务取消掉**，再登记新条目。
        //
        // 场景：切后台时我们暂停了接收（但旧的数据流可能还在跑），
        //      回到前台又调一次 accept。若不取消，新旧两条链路会
        //      **并行往同一个文件写** —— 实测把 8MB 写成 1024/512 块。
        self.file_service.cancel(file_id);

        // 再登记（拿到块流与回执端），然后广播 —— 顺序不能反，否则数据来了会丢
        let (rx, ack_tx) = self.file_service.expect(file_id, meta.clone())?;
        let ctrl = FileCtrl::Accept {
            file_id: file_id.to_string(),
            have: crate::filetransfer::bitmap_to_b64(&have),
            receiver_relay: receiver_relay.to_string(),
        };
        if let Err(e) = self.send_ctrl_in(&ctrl, expect_room).await {
            self.file_service.forget(file_id);
            return Err(e);
        }
        Ok((rx, ack_tx))
    }

    /// **取消**一个正在进行的接收（切后台暂停 / 用户主动中断）。
    ///
    /// 与 `reject_file` 的区别：这个不发 Reject 给对端 ——
    /// 我们只是想停下这一侧，保留已收内容，之后可以由用户或自动流程续传。
    pub fn cancel_file(&self, file_id: &str) {
        self.file_service.cancel(file_id);
    }

    /// 拒绝接收。
    ///
    /// `expect_room`：**必填**。原因同 `accept_file`：`Reject` 会带着自由文本
    /// 理由广播出去，发错房间等于把"我为什么不要这个文件"泄露给无关的人（F7）。
    pub async fn reject_file(&self, file_id: &str, reason: &str, expect_room: &str) -> Result<()> {
        self.file_service.forget(file_id);
        self.send_ctrl_in(
            &FileCtrl::Reject {
                file_id: file_id.to_string(),
                reason: reason.to_string(),
            },
            expect_room,
        )
        .await
    }

    /// 本端的中继地址（要告诉对方，对方才能拨号过来 —— 中继之间不互转）。
    ///
    /// ⚠️ 不要读 `latest_status` 快照：那是 watcher 异步刷新的，
    /// 握手刚完成时可能还是空的（实测会拿到 `None`，导致对方拨号无门）。
    /// 这里直接问 endpoint 要当前地址，实时且可靠。
    pub fn my_relay_url(&self) -> Option<String> {
        // `home_relay_status()` 是 watcher，`.get()` 拿到的是**当前所有中继的状态列表**。
        // 优先取"已连上"的那台（那就是对方来找我时该连的）。
        // ⚠️ 不能只读我们缓存的 `latest_status` 快照 —— 它异步刷新，握手刚完成时可能是空的。
        for st in self.endpoint.home_relay_status().get() {
            if st.is_connected() {
                return Some(st.url().to_string());
            }
        }
        // 还没连上时退一步：用配置里第一台中继（对方连它也能找到我）
        self.endpoint
            .addr()
            .addrs
            .iter()
            .find_map(|a| match a {
                TransportAddr::Relay(u) => Some(u.to_string()),
                _ => None,
            })
    }

    /// 用一条已建立的连接把文件数据发出去（发送方调用）。
    ///
    /// 调用前应先收到对方的 `Accept`（里面带 `receiver_relay`），
    /// 因为中继不互转，必须知道对方真实所在的中继才能拨号。
    pub async fn send_file_data<S>(
        &self,
        meta: &FileMeta,
        receiver_id: &str,
        receiver_relay: &str,
        source: &S,
        have: Vec<u8>,
        on_event: impl FnMut(crate::filetransfer::SendEvent),
    ) -> Result<u64>
    where
        S: crate::transfer_orchestrator::ChunkSource + ?Sized,
    {
        let peer = EndpointId::from_str(receiver_id).context("接收方 id 解析失败")?;
        let relay = RelayUrl::from_str(receiver_relay).context("接收方中继解析失败")?;
        // 说明：这里不往 memory 里加地址也应当能连（EndpointAddr 里带了 relay_url），
        // 但顺手登记一下，便于后续复用连接。
        self.memory.add_endpoint_info(EndpointAddr {
            id: peer,
            addrs: [TransportAddr::Relay(relay.clone())].into_iter().collect(),
        });
        crate::transfer_orchestrator::send_file(
            &self.endpoint,
            peer,
            &relay,
            meta,
            source,
            &have,
            on_event,
        )
        .await
    }

    /// 把收到的块流写进 sink（接收方调用）。
    ///
    /// 需要一条"发送方拨进来的连接"。调用方从 `FileService` 拿到 `rx` 后，
    /// 用 [`RoomNode::take_file_connection`] 取连接，再交给这里。
    pub async fn receive_file_data(
        &self,
        meta: &FileMeta,
        sink: std::sync::Arc<dyn crate::transfer_orchestrator::ChunkSink>,
        rx: Receiver<FileChunk>,
        ack_tx: Sender<crate::filetransfer::FileAck>,
        on_progress: impl FnMut(u64, u64, u64),
    ) -> Result<u64> {
        crate::transfer_orchestrator::receive_file(meta, sink, rx, ack_tx, on_progress).await
    }

    /// 供接收方在收到 `Accept` 之后、由发送方拨号时使用：
    /// 取一条入站连接（由 `FileService` 已经建立并读走 header）。
    pub fn file_service(&self) -> FileService {
        self.file_service.clone()
    }

    /// 当前房间 + 发送方 id → 帮助 UI 找到发邀约的人。
    pub fn peer_relay_hint(&self) -> Option<String> {
        self.my_relay_url()
    }

    /// 房间里目前已知的成员 id 快照（不含自己）。
    ///
    /// 用于"收到 Accept 后，推断是谁接受的"——`Accept` 消息本身不带发送者 id
    /// （它由 gossip 消息的签名给出 `from`，但事件层为了简洁没有透出）。
    /// 若要更精确，可在 `SignedCtrl` 里显出 `from`。
    pub fn peers_snapshot(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap()
            .peers
            .keys()
            .cloned()
            .collect()
    }

    pub fn shutdown(&self) {
        let endpoint = self.endpoint.clone();
        task::spawn(async move { endpoint.close().await });
        self.events_tx.close();
    }
}

/// 组装并广播一条 presence（心跳 / 改名 / 文件清单变化 / 质询认领都要用）。
///
/// 抽成自由函数是因为 `set_nickname` / `set_available_files` 是**同步**接口
/// （wasm 导出不能是 async 的任意签名），只能 spawn 一个任务来广播。
async fn broadcast_presence_now(key: &SecretKey, inner: &Arc<Mutex<Inner>>) {
    let (nickname, files, epoch, sender) = {
        let g = inner.lock().unwrap();
        match g.joined.as_ref() {
            Some(j) => (j.nickname.clone(), j.files.clone(), j.epoch, j.sender.clone()),
            None => return,
        }
    };
    let p = Presence::signed(key, &nickname, files, epoch);
    if let Ok(bytes) = serde_json::to_vec(&Wire::Presence { p }) {
        let _ = sender.lock().await.broadcast(bytes.into()).await;
    }
}

/// 读到流结束（带回读缓冲）。
async fn read_all(recv: &mut iroh::endpoint::RecvStream) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match recv.read(&mut chunk).await? {
            Some(0) | None => break,
            Some(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 8 * 1024 * 1024 {
                    anyhow::bail!("报文过大");
                }
            }
        }
    }
    Ok(buf)
}

pub fn topic_id(room: &str) -> iroh_gossip::proto::TopicId {
    let h = blake3::hash(format!("{TOPIC_NS}{room}").as_bytes());
    iroh_gossip::proto::TopicId::from_bytes(*h.as_bytes())
}

/// 当前时间（Unix 毫秒）。
///
/// ⚠️ **wasm32-unknown-unknown 没有 `std::time` 实现**：
/// 直接调 `SystemTime::now()` 会 panic（`time not implemented on this platform`），
/// 而且 wasm 里 panic 转成 JS 只是一句 `unreachable`，**极难定位**。
/// 所以浏览器走 `js_sys::Date::now()`。
#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

// ---------------------------------------------------------------------------
// 签名与持久化的回归测试
//
// 这些测试是为了**锁住报告里那 11 条修复**，防止以后改回去。
// 每一个都对应一个具体的、可复现的缺陷。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod security_tests {
    use super::*;

    fn kp() -> SecretKey {
        SecretKey::from_bytes(&[7u8; 32])
    }

    fn msg(nick: &str, text: &str) -> ChatMessage {
        let k = kp();
        ChatMessage {
            id: String::new(),
            from: k.public().to_string(),
            nickname: nick.to_string(),
            text: text.to_string(),
            ts: 1_700_000_000_000,
            sig: String::new(),
            file: None,
        }
        .sign(&k)
    }

    // ── P1-1：分隔符歧义 ────────────────────────────────────────────
    #[test]
    fn 分隔符注入无法伪造出相同载荷() {
        // 这两条语义完全不同，但旧的 `|` 拼接会产出完全相同的字节
        let a = msg("Alice", "A|B");
        let mut b = msg("Alice|A", "B");
        b.id = a.id.clone();
        b.sig = a.sig.clone();
        assert_ne!(
            a.canonical(),
            b.canonical(),
            "长度前缀编码没能消除分隔符歧义"
        );
        assert!(!b.verify(), "改了字段却仍然通过验签");
    }

    #[test]
    fn 消息内容被改动后验签失败() {
        let m = msg("Alice", "hello");
        let mut tampered = m.clone();
        tampered.text = "hello2".into();
        assert!(!tampered.verify());
    }

    #[test]
    fn 昵称被改动后验签失败() {
        let m = msg("Alice", "hi");
        let mut tampered = m.clone();
        tampered.nickname = "Bob".into();
        assert!(!tampered.verify());
    }

    // ── P1-2：消息 id 必须在签名载荷里 ──────────────────────────────
    #[test]
    fn 改消息id无法重放() {
        let m = msg("Alice", "hi");
        assert!(m.verify());
        // 只改 id：签名仍然"有效"（载荷里 id 也变了 → canonical 变了 → 其实会失败），
        // 但 id_matches() 也会先挡住，双保险
        let mut forged = m.clone();
        forged.id = "deadbeefdeadbeefdeadbeefdeadbeef".into();
        assert!(!forged.verify(), "改了 id 竟然还能通过验签");
    }

    #[test]
    fn sign会自动填出与载荷一致的id() {
        let k = kp();
        let m = ChatMessage {
            id: String::new(),
            from: k.public().to_string(),
            nickname: "N".into(),
            text: "T".into(),
            ts: 123,
            sig: String::new(),
            file: None,
        }
        .sign(&k);
        assert!(!m.id.is_empty());
        assert!(m.id_matches());
        assert!(m.verify());
    }

    #[test]
    fn 同一毫秒的两个文件证明id不冲突() {
        // 文件证明的 text 是空的 —— 只按 (from, ts, text) 算会撞 id
        let k = kp();
        let mk = |fid: &str| {
            ChatMessage {
                id: String::new(),
                from: k.public().to_string(),
                nickname: "N".into(),
                text: String::new(),
                ts: 555,
                sig: String::new(),
                file: Some(FileRef {
                    file_id: fid.into(),
                    name: "a.bin".into(),
                    size: 10,
                    mime: String::new(),
                }),
            }
            .sign(&k)
        };
        assert_ne!(mk("f1").id, mk("f2").id);
    }

    // ── P1-6：房间名落盘必须一一对应 ────────────────────────────────
    #[test]
    fn 不同房间不会落到同一个历史文件() {
        // 旧的 sanitize() 会把这两个房间都变成 ___
        let a = room_hash("研发群");
        let b = room_hash("产品群");
        assert_ne!(a, b, "两个房间映射到了同一个文件名");
        assert_ne!(room_hash("team_a"), room_hash("team-a"));
    }

    #[test]
    fn 房间名到文件名不含路径分隔符() {
        // 文件名会直接拼进路径，不能带 / 或 ..
        for r in ["../../etc/passwd", "a/b", "..", "x\\y"] {
            let h = room_hash(r);
            assert!(!h.contains('/'), "{r} 的文件名含 /");
            assert!(!h.contains('\\'), "{r} 的文件名含 \\");
            assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn 房间头能自校验() {
        let h = RoomHeader::new("研发群");
        assert!(h.matches("研发群"));
        // 换了房间名就不匹配（防止文件被改名/挪走后仍被加载）
        assert!(!h.matches("产品群"));
    }

    // ── F1：非法邀约只能丢弃这一条，绝不能终止整个房间的消费循环 ────
    //
    // 这一条对应"修 P1-3 时引入的回归"：原来那个判断分支写的是 `return`，
    // 而它位于 gossip 消费任务的 `async move` 体内 —— 于是一条畸形邀约
    // 就能让该房间所有后续消息（聊天/心跳/文件）永久不再被处理。
    //
    // 现在判断逻辑被抽到纯函数 `ctrl_event` 里，调用点只能 `if let Some` 发事件，
    // 结构上不可能再误用 `return`；这里再从行为上把两个方向都钉死。
    #[test]
    fn 非法邀约只丢弃不终止循环() {
        use crate::filetransfer::{FileCtrl, FileMeta, SignedCtrl};
        let k = kp();
        let me = k.public().to_string();
        let mk = |sender: &str| FileMeta {
            file_id: "f".repeat(16),
            name: "a.bin".into(),
            size: 1024,
            mime: "application/octet-stream".into(),
            chunk_size: 16 * 1024,
            root_hash: "ab".repeat(32),
            sender: sender.to_string(),
            sender_relay: "https://relay.example".into(),
            ts: 1,
        };

        // 控制消息带 `ts` 且要过新鲜度窗口，所以测试统一用"现在"
        let now = now_ms();

        // ① 攻击者自己签一条 sender 写成别人的邀约：签名完全合法……
        let bad = SignedCtrl::sign(&k, &FileCtrl::Invite(mk("someone-else")), now);
        let bad = bad.verify().expect("签名本身应当是合法的");
        // ……但映射结果必须是 None（丢这一条），而不是 panic / 终止。
        assert!(
            ctrl_event(bad, &me, "room-a", now).is_none(),
            "sender 与签名者不一致的邀约必须被丢弃"
        );

        // ② 同一房间里紧接着的正常邀约仍要正常映射 ——
        //    这正是"循环没有被结束"的行为证据（F1）。
        let good = SignedCtrl::sign(&k, &FileCtrl::Invite(mk(&me)), now);
        let good = good.verify().expect("签名合法");
        match ctrl_event(good, &me, "room-a", now) {
            Some(RoomEvent::FileInvite { room, meta }) => {
                assert_eq!(room, "room-a");
                assert_eq!(meta.sender, me);
            }
            other => panic!("正常邀约应映射成 FileInvite，实际：{other:?}"),
        }

        // ③ 其余三种控制消息都带着签名者与房间（F7），
        //    发送端才能分辨"是谁、在哪个房间"回的。
        for ctrl in [
            FileCtrl::Accept {
                file_id: "x".into(),
                have: String::new(),
                receiver_relay: "https://relay.example".into(),
            },
            FileCtrl::Reject {
                file_id: "x".into(),
                reason: "不想要".into(),
            },
            FileCtrl::Done {
                file_id: "x".into(),
                ok: false,
                reason: "校验失败".into(),
            },
        ] {
            match ctrl_event(ctrl, &me, "room-a", now) {
                Some(RoomEvent::FileAccepted { room, by, .. })
                | Some(RoomEvent::FileRejected { room, by, .. }) => {
                    assert_eq!(room, "room-a", "事件必须带上房间");
                    assert_eq!(by, me, "事件必须带上签名者");
                }
                Some(RoomEvent::FileDone { room, .. }) => {
                    assert_eq!(room, "room-a", "事件必须带上房间");
                }
                other => panic!("常规控制消息不应被丢弃，实际：{other:?}"),
            }
        }

        // ④ 重放：过期的控制消息必须被丢弃（F19）——
        //    否则房间成员可以把抓到的 Accept 重放 N 次，
        //    让发送方为每条重放重传一次整个文件。
        let old = now - FILE_CTRL_MAX_AGE_MS - 1;
        let replayed = SignedCtrl::sign(
            &k,
            &FileCtrl::Accept {
                file_id: "x".into(),
                have: String::new(),
                receiver_relay: "https://relay.example".into(),
            },
            old,
        );
        let replayed = replayed.verify().expect("签名合法");
        assert!(
            ctrl_event(replayed, &me, "room-a", old).is_none(),
            "过期的 Accept 必须被丢弃（防重放放大）"
        );
    }

    // ── F4：历史页必须按字节裁剪，且至少留一条 ────────────────────
    #[test]
    fn 历史页按字节裁剪且至少留一条() {
        let k = kp();
        let mut msgs = Vec::new();
        for i in 0..50 {
            let mut m = ChatMessage {
                id: String::new(),
                from: k.public().to_string(),
                nickname: "n".into(),
                text: "x".repeat(1000),
                ts: 1_700_000_000_000 + i,
                sig: String::new(),
                file: None,
            };
            m = m.sign(&k);
            msgs.push(m);
        }
        // 预算很小 → 只能留少数几条，且必须是**最新**的那些
        let capped = cap_history_by_bytes(msgs.clone(), 2000);
        assert!(capped.len() < msgs.len(), "预算不足时必须裁剪");
        assert!(!capped.is_empty(), "至少要留一条，否则翻页无法推进");
        assert_eq!(
            capped.last().unwrap().ts,
            msgs.last().unwrap().ts,
            "保留的必须是最新的一批（老的丢掉）"
        );

        // 预算充足 → 一条都不动
        let all = cap_history_by_bytes(msgs.clone(), 10 * 1024 * 1024);
        assert_eq!(all.len(), msgs.len());

        // 极端：单条就超预算，也必须留下这一条（不能返回空页）
        let one = cap_history_by_bytes(vec![msgs[0].clone()], 1);
        assert_eq!(one.len(), 1, "单条超预算也要留下，否则这一页永远是空的");
    }

    // ── F8：落盘历史也要验签 ───────────────────────────────────────
    #[test]
    fn 历史读路径只认验签通过的记录() {
        // 直接验证"验签是筛子"这一性质：改一个字段就应当被筛掉
        let mut m = ChatMessage {
            id: String::new(),
            from: kp().public().to_string(),
            nickname: "n".into(),
            text: "hello".into(),
            ts: 1_700_000_000_000,
            sig: String::new(),
            file: None,
        }
        .sign(&kp());
        assert!(m.verify(), "正常消息应当通过");
        m.text = "hello!".into(); // 篡改正文（id 及其签名随之失效）
        assert!(!m.verify(), "被改过的历史记录必须被筛掉");
    }

    // ── Presence：文件清单不能被分隔符歧义篡改 ─────────────────────
    #[test]
    fn 文件清单的分隔符注入不产生相同载荷() {
        let k = kp();
        let a = Presence::signed(&k, "n", vec!["x,y".into()], 1);
        let b = Presence::signed(&k, "n", vec!["x".into(), "y".into()], 1);
        assert_ne!(
            a.canonical(),
            b.canonical(),
            "清单项的分隔符歧义没有消除"
        );
    }

    #[test]
    fn 心跳被改字段后验签失败() {
        let k = kp();
        let p = Presence::signed(&k, "n", vec!["a".into()], 1);
        assert!(p.verify());
        let mut t = p.clone();
        t.nickname = "m".into();
        assert!(!t.verify());
        let mut t2 = p.clone();
        t2.files.push("b".into());
        assert!(!t2.verify());
        let mut t3 = p;
        t3.epoch += 1;
        assert!(!t3.verify());
    }

    // ── Leave / FileQuery ─────────────────────────────────────────
    #[test]
    fn 离开声明被改后验签失败() {
        let m = LeaveMsg::signed(&kp());
        assert!(m.verify());
        let mut t = m;
        t.ts += 1;
        assert!(!t.verify());
    }

    #[test]
    fn 质询被改后验签失败() {
        let m = FileQuery::signed(&kp(), "fid", "want");
        assert!(m.verify());
        let mut t = m;
        t.want = "someone-else".into();
        assert!(!t.verify());
    }
}
