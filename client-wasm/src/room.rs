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
    protocol::{AcceptError, DynProtocolHandler, ProtocolHandler, Router, RouterBuilder},
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
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tracing::{debug, info, warn};

use crate::filetransfer::{
    FileChunk, FileCtrl, FileMeta, FileService, SignedCtrl, FILE_ALPN,
};

/// 历史消息用的 ALPN（只有常驻节点会响应）。
pub const HISTORY_ALPN: &[u8] = b"editor.vip/iroh-history/1";

/// **rendezvous** 用的 ALPN：问"这个房间现在有哪些成员"。
///
/// ⚠️ 它与 [`HISTORY_ALPN`] 是**两个独立能力**（阶段 B′）：不同的开关、不同的资源闸门、
///    可以由**不同节点**提供。今天线上是同一个 roomd 同时装着这两个"插件"，
///    但代码里已经没有"常驻节点"这一个笼统概念了 —— 入口是入口，历史是历史。
pub const RENDEZVOUS_ALPN: &[u8] = b"editor.vip/iroh-rendezvous/1";

/// **加入声明**用的 ALPN：客户端说"我要用这个房间了"，服务端据此订阅该房间。
///
/// ⚠️ 在这条之前，"服务端订阅房间"是**靠拉一次历史的副作用**触发的
///    （客户端为了触发订阅而发 `fetch_history(room, 1)`，再把结果丢掉）——
///    把"读数据"当成"我来了"的信号，语义绕、还会白读一次数据库。
///    阶段 C′ 换成这条明确的声明（这也是阶段 E"多历史提供者"的前置：
///    每个提供者都能被单独告知）。
pub const ANNOUNCE_ALPN: &[u8] = b"editor.vip/iroh-announce/1";

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

/// 进房时"等第一个邻居"的默认预算（毫秒）。
///
/// ⚠️ 超时**不代表进房失败** —— 见 `RoomNode::join` 的降级逻辑。
/// 它只决定"用户要等多久才被告知：现在是孤立的"。
const DEFAULT_JOIN_TIMEOUT_MS: u64 = 8_000;

/// 孤立进房后，后台重连的间隔（起始值 → 上限，指数退避）。
const RELINK_MIN: Duration = Duration::from_secs(5);
const RELINK_MAX: Duration = Duration::from_secs(60);

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
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
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
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
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
    pub fn canonical(&self, room: &str) -> String {
        let f = self.file.as_ref();
        let ts = self.ts.to_string();
        let size = f.map(|x| x.size).unwrap_or(0).to_string();
        crate::sigfmt::encode_fields(&[
            crate::sigfmt::PROTO_V5,
            // ⚠️ **房间标识必须进签名载荷**（v4，缺陷 F6）。
            //    否则任何能进目标房间 B 的人，都能把他在房间 A 抓到的
            //    **合法签名消息原样转发进 B** —— 接收方验签通过、id 校验通过，
            //    于是原作者"在从未进过的房间里说了话"。
            //    Presence/Leave/FileQuery/FileCtrl 同理（见下）。
            "room",
            room,
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
    pub fn compute_id(from: &str, ts: u64, text: &str, file_id: &str, room: &str) -> String {
        let ts_s = ts.to_string();
        // 把 room 一起算进去：id 应当是"被签名的那条完整陈述"的派生值，
        // 而 v4 起陈述里包含房间（F6）。
        let payload =
            crate::sigfmt::encode_fields(&["id1", room, from, ts_s.as_str(), text, file_id]);
        let h = blake3::hash(payload.as_bytes());
        hex::encode(&h.as_bytes()[..12])
    }

    /// 本消息的 id 是否与自己算出来的一致。
    ///
    /// 验签时**必须**一起核对：`verify()` 只证明"签名没被改"，
    /// 而签名载荷里已经包含 id 了，所以这里再比一次就能挡住
    /// "改 id 后重放"（签名仍然有效，但 id 对不上载荷）。
    pub fn id_matches(&self, room: &str) -> bool {
        let f = self.file.as_ref();
        let want = Self::compute_id(
            &self.from,
            self.ts,
            &self.text,
            f.map(|x| x.file_id.as_str()).unwrap_or(""),
            room,
        );
        // 恒定时间比较不必要：id 不是秘密，只是完整性的一部分。
        self.id == want
    }

    pub fn verify(&self, room: &str) -> bool {
        // id 必须与载荷一致，否则"签名有效"但 id 是被人换过的
        if self.ts > i64::MAX as u64 || !self.id_matches(room) {
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
        pk.verify(self.canonical(room).as_bytes(), &Signature::from_bytes(&arr))
            .is_ok()
    }

    pub fn sign(mut self, key: &SecretKey, room: &str) -> Self {
        // 先按载荷重算 id，保证 id 与签名永远自洽
        let f_id = self
            .file
            .as_ref()
            .map(|x| x.file_id.clone())
            .unwrap_or_default();
        self.id = Self::compute_id(&self.from, self.ts, &self.text, &f_id, room);
        let sig = key.sign(self.canonical(room).as_bytes());
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
    pub fn canonical(&self, room: &str) -> String {
        let ts = self.ts.to_string();
        let epoch = self.epoch.to_string();
        let n = self.files.len().to_string();
        // files **逐项独立编码**，不能用 join(",") ——
        // 那样 file_id 里含逗号时会和"两个 id"拼出同一串（歧义）。
        // 另外带上清单长度，让"少一项/多一项"也能被发现。
        let mut out = crate::sigfmt::encode_fields(&[
            crate::sigfmt::PROTO_V5,
            // 房间进载荷（F6）：否则 A 房间的合法心跳可以被搬进 B 房间，
            // 让某人"在 B 房间里在线、并声称持有某些文件"。
            "room",
            room,
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
    pub fn signed(
        key: &SecretKey,
        nickname: &str,
        files: Vec<String>,
        epoch: u64,
        room: &str,
    ) -> Self {
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
        let sig = key.sign(p.canonical(room).as_bytes());
        p.sig = hex::encode(sig.to_bytes());
        p
    }
    pub fn verify(&self, room: &str) -> bool {
        let Ok(pk) = PublicKey::from_str(&self.from) else {
            return false;
        };
        let Ok(raw) = hex::decode(&self.sig) else {
            return false;
        };
        let Ok(arr) = <[u8; 64]>::try_from(raw.as_slice()) else {
            return false;
        };
        pk.verify(self.canonical(room).as_bytes(), &Signature::from_bytes(&arr))
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
    pub fn canonical(&self, room: &str) -> String {
        let ts = self.ts.to_string();
        // 房间进载荷（F6）：否则 A 房间的"我走了"可以被重放成"他刚离开 B"，
        // 让 B 房间的人立刻把他摘出成员表、他的文件随之显示过期。
        crate::sigfmt::encode_fields(&[
            crate::sigfmt::PROTO_V5,
            "room",
            room,
            "from",
            self.from.as_str(),
            "ts",
            ts.as_str(),
        ])
    }
    pub fn signed(key: &SecretKey, room: &str) -> Self {
        let mut m = Self {
            from: key.public().to_string(),
            ts: now_ms(),
            sig: String::new(),
        };
        let sig = key.sign(m.canonical(room).as_bytes());
        m.sig = hex::encode(sig.to_bytes());
        m
    }
    pub fn verify(&self, room: &str) -> bool {
        let Ok(pk) = PublicKey::from_str(&self.from) else {
            return false;
        };
        let Ok(raw) = hex::decode(&self.sig) else {
            return false;
        };
        let Ok(arr) = <[u8; 64]>::try_from(raw.as_slice()) else {
            return false;
        };
        pk.verify(self.canonical(room).as_bytes(), &Signature::from_bytes(&arr))
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
    pub fn canonical(&self, room: &str) -> String {
        let ts = self.ts.to_string();
        crate::sigfmt::encode_fields(&[
            crate::sigfmt::PROTO_V5,
            "room",
            room,
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
    pub fn signed(key: &SecretKey, file_id: &str, want: &str, room: &str) -> Self {
        let mut q = Self {
            from: key.public().to_string(),
            ts: now_ms(),
            file_id: file_id.to_string(),
            want: want.to_string(),
            sig: String::new(),
        };
        let sig = key.sign(q.canonical(room).as_bytes());
        q.sig = hex::encode(sig.to_bytes());
        q
    }
    pub fn verify(&self, room: &str) -> bool {
        let Ok(pk) = PublicKey::from_str(&self.from) else {
            return false;
        };
        let Ok(raw) = hex::decode(&self.sig) else {
            return false;
        };
        let Ok(arr) = <[u8; 64]>::try_from(raw.as_slice()) else {
            return false;
        };
        pk.verify(self.canonical(room).as_bytes(), &Signature::from_bytes(&arr))
            .is_ok()
    }
}

/// 编码一条签名的 presence（常驻节点也要"在线"给别人看）。
pub fn encode_presence(key: &SecretKey, nickname: &str, room: &str) -> Vec<u8> {
    serde_json::to_vec(&Wire::Presence {
        p: Presence::signed(key, nickname, Vec::new(), 0, room),
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
    /// 本端协议版本（服务端据此在日志里发现"还有旧客户端在说话"）
    #[serde(default)]
    pub protocol: String,
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

/// rendezvous 请求：`{"room":"..."}`（就一个字段 —— 入口只需要知道"问哪个房间"）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RendezvousRequest {
    pub room: String,
    /// 本端协议版本（同上：给服务端留证据）
    #[serde(default)]
    pub protocol: String,
}

/// rendezvous 响应：当前已知的房间成员。
///
/// ⚠️ **只回 EndpointId**，不回昵称/文件清单/在线时长 ——
///    入口的职责是"让你找得到人"，其余信息进房后由 presence 自然获得。
///    这样响应很小、也不需要额外授权判断（与历史同一条边界：房名即凭据）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RendezvousResponse {
    /// 服务端协议版本（握手用；缺失 = 对端是旧版）
    #[serde(default)]
    pub protocol: String,
    /// 成员 EndpointId（hex），客户端拿它当 gossip 的候选 bootstrap
    pub members: Vec<String>,
    /// 是否因为超过上限被截断（客户端据此知道"还有人，但没全给我"）
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HistoryResponse {
    pub room: String,
    /// **服务端自己的协议版本**（阶段 v5 的握手，见 [`crate::sigfmt::PROTO_V5`]）。
    ///
    /// 客户端拿它和自己比：不一致就**明确提示刷新**，而不是让消息静默验签失败。
    /// `#[serde(default)]` 是为了让"新客户端 × 旧服务端"这种情况能解析出来 ——
    /// 字段缺失即"对端是旧版"（这正是我们要能识别的情形）。
    #[serde(default)]
    pub protocol: String,
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
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub url: String,
    pub connected: bool,
    pub last_error: Option<String>,
    pub auth_denied: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
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
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
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
    /// 本端**暂时联系不上房间里的任何其他人**（孤立）。
    ///
    /// 典型场景：常驻节点正在重启、或它所在的那台中继不可达。
    ///
    /// ⚠️ 这**不是错误**，别当"进房失败"处理：
    ///   房间进得去、消息也发得出去（gossip 会排队到有邻居为止），
    ///   只是此刻看不到别人、别人也看不到你。
    ///
    /// `isolated: false` 表示**已经重新接上**（后台重连成功），
    /// 收到它时 UI 应该补拉一次历史 —— 孤立期间漏掉的东西在那边。
    Isolated { room: String, isolated: bool },
    /// **协议版本不一致**（v5 的握手）。
    ///
    /// ⚠️ 这条是给**新客户端**用的：它发现服务端（或对端）还是旧版时，明确告诉用户
    ///    "请刷新"，而不是让消息静默验签失败（改造前就是这样，极难排查）。
    ///    真正的旧客户端没有这段代码 —— 它们只能靠服务端日志发现。
    ProtocolMismatch { room: String, ours: String, theirs: String },
    /// **插件自定义事件**（终态 ③ 的扩展点）。
    ///
    /// ⚠️ 加这个变体是为了**不再为每个新能力改这张枚举**：核心只负责把插件的消息
    ///    原样端给 UI，怎么解释由插件那侧决定。既有事件一个都没动（强类型全部保留）。
    ///
    /// 边界：**消息格式与签名是协议底座，不是插件** —— 需要签名/验签的东西
    /// 必须走 `Wire` 那一套，不能从这里绕过去。
    Plugin {
        name: String,
        #[cfg_attr(feature = "ts-export", ts(type = "unknown"))]
        payload: serde_json::Value,
    },
    RelayStatus { relays: Vec<RelayInfo> },
    Error { message: String },
}

/// 文件控制消息的**新鲜度窗口**（毫秒）。
///
/// `Accept` / `Reject` / `Done` 都是广播消息，签名里带 `ts` 但没人校验它 ——
/// 于是房间成员可以把抓到的 `Accept` 原样重放，让发送方**为每条重放重传一次整个文件**
/// （缺陷 F19：一条小消息换一次全量上传）。
///
/// ## 为什么给到 15 分钟这么宽（重要）
///
/// 这个检查是**纵深防御，不是主控制**：主要防线是 Worker 侧按
/// `(file_id, peer)` 去重 —— 重放同一条 `Accept` 不会再起第二条上传流。
/// 新鲜度这一层只负责"事后重放"（把很久以前抓到的消息再放一遍）。
///
/// 而它有一个真实的误伤面：`ts` 来自**发送方的墙上时钟**，
/// 接收方拿自己的时钟比。只要双方时钟偏差超过窗口，**完全正常**的
/// `Accept`/`Reject` 就会被丢掉 —— 用户看到的是"传输停在等待确认"，
/// 且没有任何提示（只有服务端日志）。所以窗口取 15 分钟：
/// 足够覆盖现实中可能出现的时钟偏差，又足以让"昨天的 Accept"失效。
pub const FILE_CTRL_MAX_AGE_MS: u64 = 15 * 60 * 1000;

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
    /// **兼容字段**：`rendezvous_*` / `history_*` 没配时，两者都回退到它。
    ///
    /// ⚠️ 阶段 B′ 之前"常驻节点"是一个笼统概念（既当房间入口又供历史）。
    ///    现在拆成两个角色，这个字段只为老配置继续可用。
    #[serde(default)]
    pub anchor_id: Option<String>,
    #[serde(default)]
    pub anchor_relay: Option<String>,
    /// **rendezvous（房间入口 + 成员目录）**：进房时问它"这房间现在有谁"。
    #[serde(default)]
    pub rendezvous_id: Option<String>,
    #[serde(default)]
    pub rendezvous_relay: Option<String>,
    /// **历史提供者**：拉历史走它。可以与 rendezvous 是同一个节点（今天就是）。
    #[serde(default)]
    pub history_id: Option<String>,
    #[serde(default)]
    pub history_relay: Option<String>,
    /// 是否注册 **rendezvous** 服务 ALPN（与 `serve_history` 独立开关）
    #[serde(default)]
    pub serve_rendezvous: bool,
    /// 常驻节点：历史落盘目录（浏览器不传）
    #[serde(default)]
    pub history_dir: Option<String>,
    /// 常驻节点：是否注册历史服务 ALPN
    #[serde(default)]
    pub serve_history: bool,
    /// 进房时"等第一个邻居"的预算（毫秒，默认 8000）。
    ///
    /// 存在的意义是别让用户在"谁都联系不上"时干等一分半。
    /// 超时**不再让进房失败** —— 降级为孤立进房 + 后台重连。
    /// 测试用它把等待压到几百毫秒。
    #[serde(default)]
    pub join_timeout_ms: Option<u64>,
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
    if s.members.iter().any(|member| member.id == m.id && member.epoch > m.epoch) {
        return;
    }
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
    let mut members = Vec::new();
    let mut used_bytes = 0usize;
    for member in s.members.iter().rev() {
        if members.len() >= HISTORY_SNAPSHOT_MAX_MEMBERS {
            break;
        }
        let member_bytes = serde_json::to_vec(member)
            .map(|bytes| bytes.len())
            .unwrap_or(usize::MAX);
        if member_bytes > HISTORY_SNAPSHOT_MEMBER_MAX_BYTES {
            continue;
        }
        if used_bytes.saturating_add(member_bytes) > HISTORY_SNAPSHOT_MAX_BYTES {
            break;
        }
        used_bytes += member_bytes;
        members.push(member.clone());
    }
    if members.is_empty() {
        return None;
    }
    members.reverse();
    Some(RoomSnapshot { at: now, members })
}

// ---------------------------------------------------------------------------
// 历史存储（常驻节点）
// ---------------------------------------------------------------------------

// 说明：原来这里有个 `room_hash()`（房间名 → 文件名的映射）与 `RoomHeader`
// （jsonl 首行的自校验头）。**改用 SQLite 后两者都不需要了**：
// 表里 `room` 是**原始的房间名**，不再是"经过有损映射的文件名"，
// 所以"从文件名反推房间名"这个问题从根上消失了。
// （那段历史：旧实现用 `sanitize()` 把非 ASCII 换成 `_`，
//  导致 `研发群`/`产品群` 映射到同一个文件、历史混在一起 —— 复检 P1-6。）

/// **内存后端**（wasm，或原生降级）每个房间保留的最大条数。
///
/// ⚠️ 原生 roomd 走 SQLite 时**不使用**这两个常量 ——
/// 它的保留策略是 `sqlite_history::HISTORY_RETAIN_PER_ROOM`（10 万条，磁盘）。
/// 这里只给"浏览器端"和"原生打开数据库失败而降级"那种情况兜底。
///
/// （旧实现里这两个是**主**上限，且会导致"内存装不下就取不出来"——
///  那正是本次改造要修的缺陷之一。）
pub const MAX_MEM_HISTORY: usize = 5000;
/// **内存后端**每个房间保留的最大序列化字节数（同上，仅 wasm / 降级用）。
pub const MAX_MEM_HISTORY_BYTES: usize = 16 * 1024 * 1024;
/// 单条消息写入历史的上限（防异常大消息）。
pub(crate) const MAX_HISTORY_LINE_BYTES: usize = MAX_MESSAGE_SIZE;
/// 历史请求的输入上限。
const MAX_HISTORY_REQUEST_BYTES: usize = 64 * 1024;
/// 历史请求中房间名和游标 id 的字段上限。
const MAX_HISTORY_ROOM_BYTES: usize = 256;
const MAX_HISTORY_CURSOR_ID_BYTES: usize = 256;
/// 历史服务最多同时处理的连接数。
const MAX_HISTORY_CONCURRENT: usize = 64;
const HISTORY_PAGE_MAX: usize = 1000;
const HISTORY_SNAPSHOT_MAX_BYTES: usize = 256 * 1024;
const HISTORY_SNAPSHOT_MAX_MEMBERS: usize = 128;
const HISTORY_SNAPSHOT_MEMBER_MAX_BYTES: usize = 2 * 1024;
const HISTORY_ACCEPT_TIMEOUT: Duration = Duration::from_secs(10);
const HISTORY_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

// ---- rendezvous 的闸门（**与历史各管各的**，不共用信号量/超时/上限）----
/// 同时处理的 rendezvous 连接数上限
const MAX_RENDEZVOUS_CONCURRENT: usize = 32;
/// 单个 rendezvous 请求的字节上限（就一个房间名，给足余量即可）
const MAX_RENDEZVOUS_REQUEST_BYTES: usize = 1024;
const RENDEZVOUS_ACCEPT_TIMEOUT: Duration = Duration::from_secs(5);
const RENDEZVOUS_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const RENDEZVOUS_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);
const RENDEZVOUS_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
/// 一次最多回多少成员：它是"入口"不是通讯录导出，响应要小
const MAX_RENDEZVOUS_MEMBERS: usize = 64;
/// 读 rendezvous **响应**的字节上限（64 个 hex id ≈ 4.4 KB，给足余量）
const MAX_RENDEZVOUS_RESPONSE_BYTES: usize = 16 * 1024;

// ---- 加入声明的闸门（同样与其它能力各管各的）----
const MAX_ANNOUNCE_CONCURRENT: usize = 64;
const MAX_ANNOUNCE_REQUEST_BYTES: usize = 1024;
const ANNOUNCE_ACCEPT_TIMEOUT: Duration = Duration::from_secs(5);
const ANNOUNCE_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const ANNOUNCE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);
const ANNOUNCE_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const HISTORY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const HISTORY_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn serialized_message_bytes(msg: &ChatMessage) -> usize {
    serde_json::to_vec(msg)
        .map(|line| line.len().saturating_add(1))
        .unwrap_or(usize::MAX)
}

/// 按条数和序列化字节数双重裁剪，始终优先保留最新消息。
fn cap_history_in_place(list: &mut Vec<ChatMessage>, max_count: usize, max_bytes: usize) {
    if list.is_empty() {
        return;
    }
    let mut used_bytes = 0usize;
    let mut keep_from = list.len();
    for (index, msg) in list.iter().enumerate().rev() {
        let count = list.len() - index;
        let bytes = serialized_message_bytes(msg);
        if count > max_count
            || (used_bytes.saturating_add(bytes) > max_bytes && keep_from < list.len())
        {
            break;
        }
        used_bytes = used_bytes.saturating_add(bytes);
        keep_from = index;
    }
    if keep_from > 0 {
        list.drain(0..keep_from);
    }
}

fn valid_history_room(room: &str) -> bool {
    !room.is_empty()
        && room.len() <= MAX_HISTORY_ROOM_BYTES
        && !room.chars().any(char::is_control)
}

fn valid_history_request(request: &HistoryRequest) -> bool {
    valid_history_room(&request.room)
        && request.before.as_ref().is_none_or(|(timestamp, id)| {
            *timestamp <= i64::MAX as u64
                && !id.is_empty()
                && id.len() <= MAX_HISTORY_CURSOR_ID_BYTES
                && !id.chars().any(char::is_control)
        })
}

/// **服务端侧**的版本握手（v5）：记下对端报来的协议版本，不一致就 `warn!`。
///
/// 为什么只记日志、**不拒绝**：v5 的破坏性在于签名载荷里的版本串变了，
/// 旧客户端发来的消息会在**别的端**验签失败。服务端自己只是转发者 + 存储者，
/// 拒掉它对谁都没好处，反而会把"有一个旧客户端在说话"这条线索一起吞掉。
/// 我们要的是**可见**，不是拦截。
///
/// 每个 (能力, 版本) 只报一次 —— 旧客户端每次开页面都会敲三下，
/// 不去的重会把日志刷成噪音，而"是不是还有旧版在跑"这个判断一次就够。
fn note_client_protocol(theirs: &str, capability: &str) {
    if theirs == crate::sigfmt::PROTO_V5 {
        return;
    }
    static SEEN: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    let seen = SEEN.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    if !seen
        .lock()
        .unwrap()
        .insert(format!("{capability}\u{1}{theirs}"))
    {
        return;
    }
    let label = if theirs.is_empty() { "未上报（旧版）" } else { theirs };
    warn!(
        "{capability}: 对端协议版本是 {label}（本端 {}）—— 它发来的消息在别的端会验签失败",
        crate::sigfmt::PROTO_V5
    );
}

/// 历史存储。
///
/// **两个后端，按 target 分流**：
///
/// | target | 后端 | 说明 |
/// |---|---|---|
/// | 原生（roomd） | **SQLite** | 持久化 + 索引 + 保留策略，见 [`crate::sqlite_history`] |
/// | wasm（浏览器） | 内存 `mem` | 浏览器端**不存历史**（`dir` 恒为 `None`） |
///
/// ⚠️ 浏览器端从来不需要历史存储 —— 历史由常驻节点提供，
/// 所以 wasm 走内存分支是**设计如此**，不是降级。
#[derive(Clone, Default)]
pub struct HistoryStore {
    dir: Option<std::path::PathBuf>,
    /// 原生：SQLite 连接（`None` = 显式选择内存存储）
    #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
    db: Option<Arc<Mutex<crate::sqlite_history::SqliteHistory>>>,
    /// wasm（以及显式选择临时存储的原生客户端）：内存后端
    mem: Arc<Mutex<HashMap<String, Vec<ChatMessage>>>>,
    /// 内存分支的写锁（原生走 SQLite 时不需要）
    append_lock: Arc<Mutex<()>>,
}

impl std::fmt::Debug for HistoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HistoryStore")
            .field("dir", &self.dir)
            .field("mem_rooms", &self.mem.lock().map(|m| m.len()).unwrap_or(0))
            .finish_non_exhaustive()
    }
}

impl HistoryStore {
    pub fn new(dir: Option<std::path::PathBuf>) -> Result<Self> {
        // ⚠️ 只有"原生 + 给了目录"才用 SQLite。浏览器传 `None`，走内存分支。
        #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
        let db = match &dir {
            Some(directory) => {
                let history = crate::sqlite_history::SqliteHistory::open(&directory.join("history.db"))
                    .with_context(|| format!("打开历史数据库失败：{}/history.db", directory.display()))?;
                info!("历史存储：SQLite（{}/history.db）", directory.display());
                Some(Arc::new(Mutex::new(history)))
            }
            None => None,
        };

        #[cfg(not(all(not(target_arch = "wasm32"), feature = "cli")))]
        anyhow::ensure!(dir.is_none(), "当前构建不支持持久化历史，请启用 cli feature");

        Ok(Self {
            dir,
            #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
            db,
            mem: Arc::new(Mutex::new(HashMap::new())),
            append_lock: Arc::new(Mutex::new(())),
        })
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
        let _append_guard = self.append_lock.lock().unwrap();
        // ⚠️ 兜底：签名无效 / id 与载荷不符的消息**一律不进历史**。
        //    返回 false 让调用方能察觉（便于测试与排查）。
        if !msg.verify(room) {
            warn!(
                "拒绝写入历史：验签失败 room={room} id={} from={}",
                msg.id,
                &msg.from[..msg.from.len().min(12)]
            );
            return false;
        }
        let Ok(encoded) = serde_json::to_vec(&msg) else {
            warn!("拒绝写入历史：消息序列化失败 room={room}");
            return false;
        };
        if encoded.len() > MAX_HISTORY_LINE_BYTES {
            warn!("拒绝写入历史：消息超过 {MAX_HISTORY_LINE_BYTES} 字节 room={room}");
            return false;
        }

        // ---- 原生：走 SQLite（持久化 + 索引 + 保留策略）----
        #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
        if let Some(db) = &self.db {
            let mut guard = db.lock().unwrap();
            return match guard.append(room, &msg, &encoded) {
                Ok(_) => true, // 重复消息返回 false 也算成功（已存在）
                Err(e) => {
                    warn!("写入历史库失败 room={room}: {e}");
                    false
                }
            };
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
            cap_history_in_place(list, MAX_MEM_HISTORY, MAX_MEM_HISTORY_BYTES);
        }
        true
    }

    pub async fn append_async(&self, room: String, message: ChatMessage) -> bool {
        #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
        if self.db.is_some() {
            let store = self.clone();
            return match tokio::task::spawn_blocking(move || store.append(&room, message)).await {
                Ok(stored) => stored,
                Err(error) => {
                    warn!("历史写入任务失败：{error}");
                    false
                }
            };
        }
        self.append(&room, message)
    }

    pub fn recent(&self, room: &str, limit: usize) -> Result<Vec<ChatMessage>> {
        self.recent_before(room, None, limit)
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
    ) -> Result<Vec<ChatMessage>> {
        self.recent_before_bounded(room, before, limit, usize::MAX)
    }

    pub fn recent_before_bounded(
        &self,
        room: &str,
        before: Option<(u64, String)>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Vec<ChatMessage>> {
        anyhow::ensure!(
            before.as_ref().is_none_or(|(timestamp, _)| *timestamp <= i64::MAX as u64),
            "历史游标时间戳超出范围"
        );
        // ---- 原生：走 SQLite ----
        #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
        if let Some(db) = &self.db {
            let guard = db.lock().map_err(|_| anyhow::anyhow!("历史数据库锁已失效"))?;
            return guard
                .recent_before_bounded(room, before, limit, max_bytes)
                .with_context(|| format!("查询历史库失败 room={room}"));
        }

        let map = self.mem.lock().unwrap();
        let Some(list) = map.get(room) else {
            return Ok(Vec::new());
        };
        let mut selected = Vec::new();
        let mut used_bytes = 0usize;
        for msg in list.iter().rev() {
            if let Some((before_ts, before_id)) = &before {
                if (msg.ts, &msg.id) >= (*before_ts, before_id) {
                    continue;
                }
            }
            if selected.len() >= limit {
                break;
            }
            let message_bytes = serde_json::to_vec(msg).map(|line| line.len() + 1).unwrap_or(0);
            if !selected.is_empty() && used_bytes.saturating_add(message_bytes) > max_bytes {
                break;
            }
            used_bytes = used_bytes.saturating_add(message_bytes);
            selected.push(msg.clone());
        }
        selected.reverse();
        Ok(selected)
    }

    pub async fn recent_before_bounded_async(
        &self,
        room: String,
        before: Option<(u64, String)>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Vec<ChatMessage>> {
        #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
        if self.db.is_some() {
            let store = self.clone();
            return tokio::task::spawn_blocking(move || {
                store.recent_before_bounded(&room, before, limit, max_bytes)
            })
            .await
            .context("历史查询任务失败")?;
        }
        self.recent_before_bounded(&room, before, limit, max_bytes)
    }

    pub fn count(&self, room: &str) -> Result<usize> {
        #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
        if let Some(db) = &self.db {
            let guard = db.lock().map_err(|_| anyhow::anyhow!("历史数据库锁已失效"))?;
            return guard.count(room).context("统计历史条数失败");
        }
        Ok(self.mem.lock().unwrap().get(room).map(|v| v.len()).unwrap_or(0))
    }

    /// 启动时载入历史。
    ///
    /// SQLite 后端在 `HistoryStore::new()` 里就打开了数据库，数据按需从库读（分页走索引），
    /// 不再需要"启动时全量载入内存"。
    ///
    /// 这里额外做一件事：**提醒用户旧 jsonl 已被弃用**。
    /// 本次改造不做数据迁移（开发阶段，破坏性变更可接受），
    /// 旧文件不会被读取 —— 但也不该悄悄留着让人以为是数据。
    ///
    /// ⚠️ 为什么不自动删：删数据这种事不该由程序在启动时替人决定。
    ///    部署时手工 `rm -f data/history/*.jsonl`（**保留 identity.key**）。
    #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
    pub fn load_from_disk(&self) {
        let Some(dir) = &self.dir else { return };

        // 是否在用 SQLite？在的话，旧 jsonl 就是纯粹的历史包袱。
        if self.db.is_some() {
            let has_jsonl = std::fs::read_dir(dir)
                .map(|it| {
                    it.flatten()
                        .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
                })
                .unwrap_or(false);
            if has_jsonl {
                warn!(
                    "{} 里有旧的 .jsonl 历史文件，**已不再读取**（现在用 history.db）。\
                     可以安全删除：rm -f {}\\*.jsonl",
                    dir.display(),
                    dir.display()
                );
            }
        }
    }

    /// wasm 下没有文件系统，载入是空操作（保持调用点不变）。
    #[cfg(target_arch = "wasm32")]
    pub fn load_from_disk(&self) {}

    #[cfg(all(not(target_arch = "wasm32"), not(feature = "cli")))]
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

/// 加入声明：`{"room":"..."}`。
///
/// 它是**声明**不是查询：服务端收到就订阅这个房间（并把它算作"有人在用"），
/// 返回一个极小的 ack（客户端一般不等它）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnounceRequest {
    pub room: String,
    /// 本端协议版本（同上：给服务端留证据）
    #[serde(default)]
    pub protocol: String,
}

/// 加入声明的回执（字段留白给以后扩展；现在是"我收到了"）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AnnounceResponse {
    /// 服务端协议版本（握手用；缺失 = 对端是旧版）
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub ok: bool,
}

/// 历史服务（常驻节点侧）：收到请求 → 返回该房间最近 N 条；顺带通知订阅该房间。
#[derive(Clone, Debug)]
pub struct HistoryService {
    store: HistoryStore,
    join_tx: Sender<String>,
    snaps: Snapshots,
    permits: Arc<Semaphore>,
}

impl HistoryService {
    /// 常驻节点用：store 提供历史，join_tx 用于把"第一次见到的房间"通知给订阅任务，
    /// snaps 提供房间快照（成员表 + 文件清单）。
    pub fn new(store: HistoryStore, join_tx: Sender<String>, snaps: Snapshots) -> Self {
        Self {
            store,
            join_tx,
            snaps,
            permits: Arc::new(Semaphore::new(MAX_HISTORY_CONCURRENT)),
        }
    }
}

impl ProtocolHandler for HistoryService {
    async fn accept(
        &self,
        connection: iroh::endpoint::Connection,
    ) -> std::result::Result<(), AcceptError> {
        let Ok(_permit) = self.permits.clone().try_acquire_owned() else {
            connection.close(0u8.into(), b"history busy");
            return Ok(());
        };
        let accepted = n0_future::time::timeout(HISTORY_ACCEPT_TIMEOUT, connection.accept_bi()).await;
        let (mut send, mut recv) = match accepted {
            Ok(Ok(streams)) => streams,
            Ok(Err(error)) => return Err(AcceptError::from_err(error)),
            Err(_) => {
                connection.close(0u8.into(), b"history accept timeout");
                return Ok(());
            }
        };
        let request = n0_future::time::timeout(
            HISTORY_REQUEST_TIMEOUT,
            read_all_bounded(&mut recv, MAX_HISTORY_REQUEST_BYTES),
        )
        .await;
        let req_bytes = match request {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => {
                warn!("拒绝历史请求: {error}");
                connection.close(0u8.into(), b"invalid history request");
                return Ok(());
            }
            Err(_) => {
                connection.close(0u8.into(), b"history request timeout");
                return Ok(());
            }
        };
        let req: HistoryRequest = match serde_json::from_slice(&req_bytes) {
            Ok(r) => r,
            Err(e) => {
                warn!("历史请求解析失败: {e}");
                connection.close(0u8.into(), b"invalid history request");
                return Ok(());
            }
        };
        if !valid_history_request(&req) {
            warn!("拒绝无效历史请求（字段超出限制或包含控制字符）");
            connection.close(0u8.into(), b"invalid history request");
            return Ok(());
        }
        debug!("历史请求 room={} limit={}", req.room, req.limit);
        note_client_protocol(&req.protocol, "history");

        // 第一次见到这个房间 → 让 controller 去订阅（常驻节点自动看住每个被访问的房间）
        let _ = self.join_tx.try_send(req.room.clone());

        let snapshot = snapshot_get(&self.snaps, &req.room);
        let message_budget = if snapshot.is_some() {
            HISTORY_RESPONSE_MAX_BYTES
                .saturating_sub(HISTORY_SNAPSHOT_MAX_BYTES + 4096)
        } else {
            HISTORY_RESPONSE_MAX_BYTES
        };
        let messages = n0_future::time::timeout(
            HISTORY_REQUEST_TIMEOUT,
            self.store.recent_before_bounded_async(
                req.room.clone(), req.before, req.limit.min(HISTORY_PAGE_MAX), message_budget,
            ),
        ).await;
        let messages = match messages {
            Ok(Ok(messages)) => messages,
            Ok(Err(error)) => {
                warn!("历史存储不可用 room={}: {error:#}", req.room);
                connection.close(0u8.into(), b"history storage unavailable");
                return Ok(());
            }
            Err(_) => {
                connection.close(0u8.into(), b"history query timeout");
                return Ok(());
            }
        };
        let resp = HistoryResponse {
            room: req.room.clone(),
            protocol: crate::sigfmt::PROTO_V5.to_string(),
            messages,
            // 顺带把房间快照给客户端 —— 他进房就能看到"屋里都有谁、谁能提供哪些文件"
            snapshot,
        };
        let body = serde_json::to_vec(&resp).map_err(AcceptError::from_err)?;
        match n0_future::time::timeout(HISTORY_RESPONSE_TIMEOUT, send.write_all(&body)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(AcceptError::from_err(error)),
            Err(_) => {
                connection.close(0u8.into(), b"history response timeout");
                return Ok(());
            }
        }
        send.finish()?;
        if n0_future::time::timeout(HISTORY_CLOSE_TIMEOUT, connection.closed())
            .await
            .is_err()
        {
            connection.close(0u8.into(), b"history close timeout");
        }
        Ok(())
    }
}

/// **加入声明服务**：收到 `{room}` → 让 controller 订阅它，并回一个 ack。
///
/// 谁装它：**任何房间级服务端能力**（历史 / 入口 …）。今天 roomd 三样都装。
/// 语义上它属于"服务端能力"这一侧，所以与 `serve_history`/`serve_rendezvous` 一起开关，
/// 不单独设一个 flag（装了就说明这个节点在乎"谁在用哪个房间"）。
#[derive(Clone, Debug)]
pub struct AnnounceService {
    join_tx: Sender<String>,
    permits: Arc<Semaphore>,
}

impl AnnounceService {
    pub fn new(join_tx: Sender<String>) -> Self {
        Self {
            join_tx,
            permits: Arc::new(Semaphore::new(MAX_ANNOUNCE_CONCURRENT)),
        }
    }
}

impl ProtocolHandler for AnnounceService {
    async fn accept(
        &self,
        connection: iroh::endpoint::Connection,
    ) -> std::result::Result<(), AcceptError> {
        let Ok(_permit) = self.permits.clone().try_acquire_owned() else {
            connection.close(0u8.into(), b"announce busy");
            return Ok(());
        };
        let accepted = n0_future::time::timeout(ANNOUNCE_ACCEPT_TIMEOUT, connection.accept_bi()).await;
        let (mut send, mut recv) = match accepted {
            Ok(Ok(streams)) => streams,
            Ok(Err(error)) => return Err(AcceptError::from_err(error)),
            Err(_) => {
                connection.close(0u8.into(), b"announce accept timeout");
                return Ok(());
            }
        };
        let request = n0_future::time::timeout(
            ANNOUNCE_REQUEST_TIMEOUT,
            read_all_bounded(&mut recv, MAX_ANNOUNCE_REQUEST_BYTES),
        )
        .await;
        let req_bytes = match request {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => {
                debug!("拒绝加入声明: {error}");
                connection.close(0u8.into(), b"invalid announce");
                return Ok(());
            }
            Err(_) => {
                connection.close(0u8.into(), b"announce timeout");
                return Ok(());
            }
        };
        let req: AnnounceRequest = match serde_json::from_slice(&req_bytes) {
            Ok(r) => r,
            Err(e) => {
                debug!("加入声明解析失败: {e}");
                connection.close(0u8.into(), b"invalid announce");
                return Ok(());
            }
        };
        if !valid_history_room(&req.room) {
            connection.close(0u8.into(), b"invalid announce");
            return Ok(());
        }
        debug!("收到加入声明 room={}", req.room);
        note_client_protocol(&req.protocol, "announce");
        // 这就是全部：让 controller 去订阅（其余能力自己会被触发）
        let _ = self.join_tx.try_send(req.room.clone());

        let body = serde_json::to_vec(&AnnounceResponse {
            protocol: crate::sigfmt::PROTO_V5.to_string(),
            ok: true,
        })
        .map_err(AcceptError::from_err)?;
        match n0_future::time::timeout(ANNOUNCE_RESPONSE_TIMEOUT, send.write_all(&body)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(AcceptError::from_err(error)),
            Err(_) => {
                connection.close(0u8.into(), b"announce response timeout");
                return Ok(());
            }
        }
        send.finish()?;
        if n0_future::time::timeout(ANNOUNCE_CLOSE_TIMEOUT, connection.closed())
            .await
            .is_err()
        {
            connection.close(0u8.into(), b"announce close timeout");
        }
        Ok(())
    }
}

/// **rendezvous 服务**（房间入口侧）：收到 `{room}` → 回当前已知成员。
///
/// 与 [`HistoryService`] **完全独立**：自己的信号量、自己的超时、自己的字节上限。
/// 两者今天跑在同一个进程里（roomd 同时装这两个"插件"），但**没有任何共享状态** ——
/// 要拆成两台机器，只改配置即可（`rendezvous_*` / `history_*` 指向不同节点）。
impl ProtocolHandler for RendezvousService {
    async fn accept(
        &self,
        connection: iroh::endpoint::Connection,
    ) -> std::result::Result<(), AcceptError> {
        // 闸门① 并发：超了直接关，不排队 —— 入口被拖住会连带所有人的进房变慢
        let Ok(_permit) = self.permits.clone().try_acquire_owned() else {
            connection.close(0u8.into(), b"rendezvous busy");
            return Ok(());
        };
        // 闸门② accept 超时
        let accepted =
            n0_future::time::timeout(RENDEZVOUS_ACCEPT_TIMEOUT, connection.accept_bi()).await;
        let (mut send, mut recv) = match accepted {
            Ok(Ok(streams)) => streams,
            Ok(Err(error)) => return Err(AcceptError::from_err(error)),
            Err(_) => {
                connection.close(0u8.into(), b"rendezvous accept timeout");
                return Ok(());
            }
        };
        // 闸门③ 请求体上限 + 读超时
        let request = n0_future::time::timeout(
            RENDEZVOUS_REQUEST_TIMEOUT,
            read_all_bounded(&mut recv, MAX_RENDEZVOUS_REQUEST_BYTES),
        )
        .await;
        let req_bytes = match request {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => {
                debug!("拒绝 rendezvous 请求: {error}");
                connection.close(0u8.into(), b"invalid rendezvous request");
                return Ok(());
            }
            Err(_) => {
                connection.close(0u8.into(), b"rendezvous request timeout");
                return Ok(());
            }
        };
        let req: RendezvousRequest = match serde_json::from_slice(&req_bytes) {
            Ok(r) => r,
            Err(e) => {
                debug!("rendezvous 请求解析失败: {e}");
                connection.close(0u8.into(), b"invalid rendezvous request");
                return Ok(());
            }
        };
        // 闸门④ 房间名合法性（与历史用**同一条**规则，不是各写一遍）
        if !valid_history_room(&req.room) {
            connection.close(0u8.into(), b"invalid rendezvous request");
            return Ok(());
        }
        debug!("rendezvous 请求 room={}", req.room);
        note_client_protocol(&req.protocol, "rendezvous");

        // "有人来问这个房间"就是最自然的加入信号：让 controller 去订阅它。
        // （历史那边是靠"第一次被拉历史"触发订阅；入口被问到时同样该订阅。）
        let _ = self.join_tx.try_send(req.room.clone());

        let snapshot = snapshot_get(&self.snaps, &req.room);
        let all: Vec<String> = snapshot
            .map(|s| s.members.iter().map(|m| m.id.clone()).collect())
            .unwrap_or_default();
        // 闸门⑤ 响应规模：只回前 N 个，并如实告知被截断
        let truncated = all.len() > MAX_RENDEZVOUS_MEMBERS;
        let members: Vec<String> = all.into_iter().take(MAX_RENDEZVOUS_MEMBERS).collect();

        let body = serde_json::to_vec(&RendezvousResponse {
            protocol: crate::sigfmt::PROTO_V5.to_string(),
            members,
            truncated,
        })
            .map_err(AcceptError::from_err)?;
        match n0_future::time::timeout(RENDEZVOUS_RESPONSE_TIMEOUT, send.write_all(&body)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(AcceptError::from_err(error)),
            Err(_) => {
                connection.close(0u8.into(), b"rendezvous response timeout");
                return Ok(());
            }
        }
        send.finish()?;
        if n0_future::time::timeout(RENDEZVOUS_CLOSE_TIMEOUT, connection.closed())
            .await
            .is_err()
        {
            connection.close(0u8.into(), b"rendezvous close timeout");
        }
        Ok(())
    }
}

/// rendezvous 服务本体（与 `HistoryService` 并列，互不依赖）。
#[derive(Clone, Debug)]
pub struct RendezvousService {
    join_tx: Sender<String>,
    snaps: Snapshots,
    permits: Arc<Semaphore>,
}

impl RendezvousService {
    pub fn new(join_tx: Sender<String>, snaps: Snapshots) -> Self {
        Self {
            join_tx,
            snaps,
            permits: Arc::new(Semaphore::new(MAX_RENDEZVOUS_CONCURRENT)),
        }
    }
}

// ---------------------------------------------------------------------------
// 房间能力（"万物皆插件"的落点）
// ---------------------------------------------------------------------------

/// 一个**房间级能力**：一个 ALPN + 一组自己的闸门 + 一个处理句柄。
///
/// ⚠️ 终态 ③ 就是这一层：**加一个新能力 = 写一个实现 + 注册它**，
///    既不用改 gossip 消费循环，也不用改 `Router` 的组装代码 ——
///    核心只认识这个 trait，不认识"历史"或"入口"具体是什么。
///
/// 边界（与方案的硬约束一致）：
///   · 能被插件化的只有**传输之上的能力**（历史 / 入口 / 文件 / 加入声明 …）；
///     消息格式与签名是协议底座，**不是**插件。
///   · 每个能力自带资源闸门（并发 / 字节 / 超时），不许绕过。
pub trait RoomCapability: Send + Sync + std::fmt::Debug + 'static {
    /// 这个能力用哪个 ALPN 接连接（同一节点内必须唯一）
    fn alpn(&self) -> &'static [u8];
    /// 名字（启动日志 / 诊断用）
    fn name(&self) -> &'static str;
    /// 装箱成 iroh 的 dyn 句柄（实现通常一行：`Box::new(self.clone())`）
    fn handler(&self) -> Box<dyn DynProtocolHandler>;
}

/// 已注册能力的集合 —— **整份代码里唯一**知道"一共有几种能力"的地方。
#[derive(Debug, Default)]
pub struct CapabilityRegistry {
    entries: Vec<(&'static [u8], &'static str, Box<dyn DynProtocolHandler>)>,
}

impl CapabilityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<C: RoomCapability>(&mut self, capability: C) {
        self.entries.push((capability.alpn(), capability.name(), capability.handler()));
    }

    /// 并入另一份注册表（`start_with` 的插件入口用）
    pub fn merge(&mut self, other: CapabilityRegistry) {
        self.entries.extend(other.entries);
    }

    /// 已注册能力的名字（启动日志、诊断用）
    pub fn names(&self) -> Vec<&'static str> {
        self.entries.iter().map(|(_, name, _)| *name).collect()
    }

    /// 装进 Router：**只有这里知道"能力"这回事**。
    /// 核心的其它部分（gossip 消费、事件分发、房间订阅）对具体能力一无所知。
    pub fn install(self, mut builder: RouterBuilder) -> RouterBuilder {
        for (alpn, name, handler) in self.entries {
            debug!("注册房间能力 {name}（alpn={}）", String::from_utf8_lossy(alpn));
            builder = builder.accept(alpn, handler);
        }
        builder
    }
}

impl RoomCapability for crate::filetransfer::FileService {
    fn alpn(&self) -> &'static [u8] {
        crate::filetransfer::FILE_ALPN
    }
    fn name(&self) -> &'static str {
        "files"
    }
    fn handler(&self) -> Box<dyn DynProtocolHandler> {
        Box::new(self.clone())
    }
}

impl RoomCapability for RendezvousService {
    fn alpn(&self) -> &'static [u8] {
        RENDEZVOUS_ALPN
    }
    fn name(&self) -> &'static str {
        "rendezvous"
    }
    fn handler(&self) -> Box<dyn DynProtocolHandler> {
        Box::new(self.clone())
    }
}

impl RoomCapability for HistoryService {
    fn alpn(&self) -> &'static [u8] {
        HISTORY_ALPN
    }
    fn name(&self) -> &'static str {
        "history"
    }
    fn handler(&self) -> Box<dyn DynProtocolHandler> {
        Box::new(self.clone())
    }
}

impl RoomCapability for AnnounceService {
    fn alpn(&self) -> &'static [u8] {
        ANNOUNCE_ALPN
    }
    fn name(&self) -> &'static str {
        "announce"
    }
    fn handler(&self) -> Box<dyn DynProtocolHandler> {
        Box::new(self.clone())
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
    /// **房间入口**（rendezvous）：进房时问它"这房间现在有谁"，它自己也当候选。
    rendezvous: Option<(EndpointId, RelayUrl)>,
    /// **历史提供者**：拉历史连它。与 `rendezvous` 可以是同一个节点，也可以是另一台。
    history: Option<(EndpointId, RelayUrl)>,
    /// 本节点是否响应 rendezvous 请求（与 `serve_history` **独立**的开关）
    serve_rendezvous: bool,
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
    /// 房间快照表。**只有本节点提供服务端能力**（`serve_history` 或 `serve_rendezvous`）
    /// 时才维护它 —— 普通客户端不维护（避免白记账；入口靠它回答"这房间有谁"）。
    snaps: Snapshots,
    /// 本节点是否响应历史请求
    serve_history: bool,
    /// 进房时等第一个邻居的预算（见 `RoomOptions::join_timeout_ms`）。
    join_timeout: Duration,
    /// 已经报过"协议不一致"的对端版本 —— 同一个版本只提示一次
    /// （否则每次拉历史都会重复弹）。
    reported_protocols: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl RoomNode {
    pub async fn start(opts: RoomOptions) -> Result<Self> {
        Self::start_with(opts, CapabilityRegistry::new()).await
    }

    /// 同 [`RoomNode::start`]，但允许调用方**追加自定义房间能力**（插件入口）。
    ///
    /// 这是"万物皆插件"的接入点：新能力不需要改核心的 dispatch ——
    /// 注册进来，它的 ALPN 就会被服务，其余部分（gossip 消费、事件、订阅）一无所知。
    pub async fn start_with(opts: RoomOptions, extra: CapabilityRegistry) -> Result<Self> {
        let store = HistoryStore::new(opts.history_dir.as_ref().map(std::path::PathBuf::from))?;
        if opts.history_dir.is_some() {
            store.load_from_disk();
        }
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

        // 阶段 B′：把原来笼统的"常驻节点"拆成两个**角色**。
        //
        // ⚠️ 老字段 `anchor_*` 仍然生效，作为两者的**共同回退** ——
        //    部署上今天还是同一个 roomd，所以老配置的行为一模一样；
        //    但代码里已经没有"一个常驻节点"这个概念了（各有各的开关与闸门）。
        let parse_role = |id: &Option<String>, relay: &Option<String>, role: &str| -> Result<Option<(EndpointId, RelayUrl)>> {
            match (id, relay) {
                (Some(id), Some(relay)) => Ok(Some((
                    EndpointId::from_str(id).with_context(|| format!("{role} id 解析失败"))?,
                    RelayUrl::from_str(relay).with_context(|| format!("{role} relay 解析失败"))?,
                ))),
                (None, None) => Ok(None),
                // 半配等于没配，但**不静默**：这类配置错误会让"谁都不在"变得莫名其妙
                _ => anyhow::bail!("{role} 必须同时提供 id 与 relay"),
            }
        };
        let anchor = parse_role(&opts.anchor_id, &opts.anchor_relay, "anchor")?;
        let rendezvous = parse_role(&opts.rendezvous_id, &opts.rendezvous_relay, "rendezvous")?
            .or_else(|| anchor.clone());
        let history = parse_role(&opts.history_id, &opts.history_relay, "history")?
            .or_else(|| anchor.clone());

        // 关掉外部地址发现，靠内存地址表 dial by id
        let memory = MemoryLookup::new();
        for target in [&rendezvous, &history].into_iter().flatten() {
            memory.add_endpoint_info(EndpointAddr {
                id: target.0,
                addrs: [TransportAddr::Relay(target.1.clone())].into_iter().collect(),
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
        // ★ 能力注册表：核心只认识"一个能力"，不认识"历史"或"入口"具体是什么。
        //   gossip 是**底座**（消息怎么传），不是能力（见 `Wire`/`RoomEvent` 的注释）。
        let mut capabilities = CapabilityRegistry::new();
        // 所有端都有：文件（数据面 ALPN）
        capabilities.register(file_service.clone());
        // 两个服务端能力**各自的开关**：谁开谁装，互不牵连。
        // （今天 roomd 两个都开；将来想只做入口、不存历史，把 serve_history 关掉即可。）
        if opts.serve_rendezvous {
            capabilities.register(RendezvousService::new(join_tx.clone(), snaps.clone()));
        }
        let join_rx = if opts.serve_history {
            capabilities.register(HistoryService::new(store.clone(), join_tx.clone(), snaps.clone()));
            Some(join_rx)
        } else {
            None
        };
        // "在乎谁在用哪个房间"的节点才需要听加入声明（服务端能力 = 两者任一开着）
        if opts.serve_history || opts.serve_rendezvous {
            capabilities.register(AnnounceService::new(join_tx.clone()));
        }
        // 调用方追加的能力（插件）：核心在这里**原样收下**，不做任何判断
        capabilities.merge(extra);
        info!("房间能力：{:?}", capabilities.names());
        let router = capabilities
            .install(Router::builder(endpoint.clone()).accept(GOSSIP_ALPN, gossip.clone()))
            .spawn();

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
            rendezvous,
            history,
            serve_rendezvous: opts.serve_rendezvous,
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
            join_timeout: Duration::from_millis(
                opts.join_timeout_ms.unwrap_or(DEFAULT_JOIN_TIMEOUT_MS),
            ),
            reported_protocols: Arc::new(Mutex::new(std::collections::HashSet::new())),
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

    /// 中继状态（**实时**，不是缓存快照）。
    ///
    /// ⚠️⚠️ 为什么必须实时查，不能读 `latest_status`：
    ///
    /// `latest_status` 是 watcher（`endpoint.home_relay_status().stream()`）
    /// 刷出来的，而**那个流只在状态"变化"时推新值**。
    /// 断网时 `is_connected()` 未必变 —— iroh 的 relay-actor 会自己重试，
    /// 从它的视角"这条会话还在"，于是**不再推新值**，快照就永远停在
    /// 最后一次推的 `connected: true` 上。
    ///
    /// 真机实测（2026-10-09）：断网 25 秒后 UI 仍显示「在线」，
    /// 而 Rust 侧一条中继日志都没有 —— 界面在骗人，掉线重连也因此不触发。
    ///
    /// `.get()` 是**当场查当前状态**（与 `my_relay_url()` 同一个做法，
    /// 那边的注释早就写了"不要读 latest_status 快照"）。
    ///
    /// `latest_status` 仍然保留：它给**事件推送**用（`RelayStatus` 事件），
    /// 那条路要的是"变化通知"，与"现在到底连没连上"是两件事。
    pub fn relay_status(&self) -> Vec<RelayInfo> {
        let live: Vec<RelayInfo> = self
            .endpoint
            .home_relay_status()
            .get()
            .into_iter()
            .map(|s| RelayInfo {
                url: s.url().to_string(),
                connected: s.is_connected(),
                last_error: s.last_error().map(|e| e.to_string()),
                auth_denied: s.auth_denied_reason().map(|r| r.to_string()),
            })
            .collect();
        // 一台都没查到（还没建联 / 已释放）→ 退回快照，别把状态"清空"成"没中继"
        if live.is_empty() {
            return self.latest_status.lock().unwrap().clone();
        }
        live
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

    /// 本节点**固有的**候选邻居：入口 + 历史提供者（不含"房间里已知的其他人"）。
    fn bootstrap_ids(&self) -> Vec<EndpointId> {
        let mut ids = Vec::new();
        for target in [&self.rendezvous, &self.history].into_iter().flatten() {
            if !ids.contains(&target.0) {
                ids.push(target.0);
            }
        }
        ids
    }

    /// gossip bootstrap 列表 = 入口报的成员 + 固有候选。
    async fn bootstrap_candidates(&self, room: &str) -> Vec<EndpointId> {
        let mut ids = self.rendezvous_candidates(room).await;
        for id in self.bootstrap_ids() {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids
    }

    /// 问入口："这个房间现在有谁？"
    ///
    /// **尽力而为**：连不上 / 超时 / 解析失败都只记 debug 并返回空 ——
    /// 入口慢不该把进房拖住，更不该让进房失败（阶段 A 定下的语义）。
    ///
    /// 超时预算取进房预算的 1/4（默认约 2 秒，下限 200ms）：它是"锦上添花"的一步，
    /// 拿不到成员就退化成"只连入口自己"，再不行就是孤立进房。
    ///
    /// 向每个服务端角色声明"我要用这个房间了"（阶段 C′ 的显式加入声明）。
    ///
    /// **尽力而为**：任何失败（连不上 / 超时）只记 debug 并继续 ——
    /// 声明丢了最坏结果是"服务端晚一点才知道这个房间"，绝不该让进房失败或明显变慢。
    ///
    /// 预算：**每个目标** `join_timeout / 8`（下限 150ms），两个目标合计 ≤ 进房预算的 1/4。
    /// 同一节点同时扮演两个角色时只发一次（按 EndpointId 去重）。
    async fn announce_room(&self, room: &str) {
        let mut targets: Vec<&(EndpointId, RelayUrl)> = Vec::new();
        for target in [&self.rendezvous, &self.history].into_iter().flatten() {
            if !targets.iter().any(|t| t.0 == target.0) {
                targets.push(target);
            }
        }
        let budget = (self.join_timeout / 8).max(Duration::from_millis(150));
        for (id, relay) in targets {
            let sent = n0_future::time::timeout(budget, async {
                let conn = self
                    .endpoint
                    .connect(EndpointAddr::new(*id).with_relay_url(relay.clone()), ANNOUNCE_ALPN)
                    .await
                    .context("连接服务端能力失败")?;
                let (mut send, mut recv) = conn.open_bi().await?;
                let req = AnnounceRequest {
                    room: room.to_string(),
                    protocol: crate::sigfmt::PROTO_V5.to_string(),
                };
                send.write_all(&serde_json::to_vec(&req)?).await?;
                send.finish()?;
                // 读掉 ack（有界），让对端写完、连接干净收尾。
                // 顺带把版本读出来做握手 —— 这条是最早能发现"服务端是旧版"的时机。
                // 解析不出来不算错（ack 的字段以后还可能加），按"未上报"处理。
                let bytes = read_all_bounded(&mut recv, MAX_RENDEZVOUS_RESPONSE_BYTES).await?;
                let ack: AnnounceResponse = serde_json::from_slice(&bytes).unwrap_or_default();
                anyhow::Ok(ack)
            })
            .await;
            match sent {
                Ok(Ok(ack)) => {
                    self.note_peer_protocol(&ack.protocol, room).await;
                    debug!("已向服务端声明加入房间 {room}");
                }
                Ok(Err(e)) => debug!("加入声明失败（继续进房）: {e:#}"),
                Err(_) => debug!("加入声明超时（继续进房）"),
            }
        }
    }

    /// 顺带一个副作用：入口收到请求就会去订阅这个房间（同历史那条路），
    /// 所以这一问本身也是"有人来了"的信号。
    async fn rendezvous_candidates(&self, room: &str) -> Vec<EndpointId> {
        let Some((id, relay)) = &self.rendezvous else {
            return Vec::new();
        };
        let budget = (self.join_timeout / 4).max(Duration::from_millis(200));
        let query = n0_future::time::timeout(budget, async {
            let conn = self
                .endpoint
                .connect(EndpointAddr::new(*id).with_relay_url(relay.clone()), RENDEZVOUS_ALPN)
                .await
                .context("连接房间入口失败")?;
            let (mut send, mut recv) = conn.open_bi().await?;
            let req = RendezvousRequest {
                room: room.to_string(),
                protocol: crate::sigfmt::PROTO_V5.to_string(),
            };
            send.write_all(&serde_json::to_vec(&req)?).await?;
            send.finish()?;
            let bytes = read_all_bounded(&mut recv, MAX_RENDEZVOUS_RESPONSE_BYTES).await?;
            let resp: RendezvousResponse = serde_json::from_slice(&bytes)?;
            anyhow::Ok(resp)
        })
        .await;
        match query {
            Ok(Ok(resp)) => {
                // v5 握手：入口是"进房第一个会见到的服务端"，版本对不上在这里就能发现
                self.note_peer_protocol(&resp.protocol, room).await;
                let ids: Vec<EndpointId> = resp
                    .members
                    .iter()
                    .filter_map(|m| EndpointId::from_str(m).ok())
                    .collect();
                if resp.truncated {
                    debug!("入口报的成员被截断（只用了前 {MAX_RENDEZVOUS_MEMBERS} 个）");
                }
                debug!("入口为房间 {room} 报了 {} 个成员", ids.len());
                ids
            }
            Ok(Err(e)) => {
                debug!("入口查询失败（继续进房）: {e:#}");
                Vec::new()
            }
            Err(_) => {
                debug!("入口查询超时（继续进房）");
                Vec::new()
            }
        }
    }

    /// 进入房间。重复进入同一房间只更新昵称。
    pub async fn join(&self, room: &str, nickname: &str) -> Result<()> {
        anyhow::ensure!(valid_history_room(room), "房间名必须为 1–256 UTF-8 字节且不能包含控制字符");
        let topic = topic_id(room);
        let same = {
            let g = self.inner.lock().unwrap();
            g.joined.as_ref().map(|j| j.topic == topic).unwrap_or(false)
        };
        if same {
            if let Some(j) = self.inner.lock().unwrap().joined.as_mut() {
                if j.nickname != nickname {
                    j.nickname = nickname.to_string();
                    j.epoch = now_ms().max(j.epoch.saturating_add(1));
                }
            }
            let sender = self.inner.lock().unwrap().joined.as_ref().map(|j| j.sender.clone());
            if let Some(sender) = sender {
                sender.lock().await.join_peers(self.bootstrap_ids()).await?;
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

        // 阶段 B′ 的关键一步：**候选取自入口，而不是写死的某个节点**。
        //
        // 先问 rendezvous "这房间现在有谁"，把那些人也当候选 ——
        // 入口只是"你总能找到的第一个人"，不是唯一能连的人。
        // 拿不到候选也照样往下走（阶段 A 的降级：孤立进房 + 后台重连）。
        let bootstrap: Vec<EndpointId> = self.bootstrap_candidates(room).await;

        // ★ 显式加入声明（阶段 C′）：告诉每个服务端角色"我要用这个房间了"。
        //
        // 以前这件事是**靠拉一次历史的副作用**做的（`fetch_history(room, 1)` 再把结果丢掉）——
        // 把"读数据"当成"我来了"的信号，语义绕，还会白读一次数据库。
        // 现在是一条明确的声明，且**尽力而为**：发不出去只记 debug，绝不影响进房。
        //
        // ⚠️ 成员/文件快照不再在这里顺手拿：应用层进房后那次**真正的**历史请求会带回它
        //    （两条路都走 `apply_snapshot`，语义一致），这里省掉一次多余的查询。
        self.announce_room(room).await;

        // ⚠️ 关键：`subscribe()` 不等 bootstrap 连上就返回；若那次拨号失败，本端会永远孤岛
        //    （实测：两个浏览器同时进房，一个收到消息、另一个什么也收不到）。
        //    所以有 bootstrap 时用 `subscribe_and_join()`（等至少一个连接建立）。
        //
        // ★★ 但它**不再重试到死、也不再失败**。
        //
        //    旧写法：4 次 × 20 秒，全失败就 `bail!("进房间失败")`。
        //    后果是常驻节点成了进房的**硬前置**：它一挂（或它那台中继不可达），
        //    房间里所有人一起被挡在门外 —— 哪怕彼此都在线、中继也好好的。
        //
        //    新写法：给这次等待一个**预算**，超时就降级为「孤立进房」——
        //      · 房间进得去（`subscribe` 不要求有邻居）
        //      · 消息发得出去（gossip 会把它们排队，等有邻居时投递）
        //      · 起一个后台任务继续重连，接上后自动解除孤立（见下面的 t3）
        //    于是 roomd 从"进房必需"降级成"房间里一个恰好常在线的用户"。
        let (gossip_topic, isolated) = if bootstrap.is_empty() {
            (self.gossip.subscribe(topic, vec![]).await?, false)
        } else {
            match n0_future::time::timeout(
                self.join_timeout,
                self.gossip.subscribe_and_join(topic, bootstrap.clone()),
            )
            .await
            {
                Ok(Ok(t)) => {
                    info!("已进入房间 {room}（至少连上一个成员）");
                    (t, false)
                }
                Ok(Err(e)) => {
                    warn!("进房没能连上任何成员（{e}）→ 孤立进房，后台继续重连");
                    (self.gossip.subscribe(topic, vec![]).await?, true)
                }
                Err(_) => {
                    warn!(
                        "进房等待邻居超时（{}ms）→ 孤立进房，后台继续重连",
                        self.join_timeout.as_millis()
                    );
                    (self.gossip.subscribe(topic, vec![]).await?, true)
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
            let key = self.secret_key.clone();
            // 收到"可用性质询"时，若我就是被问的人、且手里还有这个文件，
            // 需要立刻重播一次心跳来"认领" —— 那要用到私钥签名
            // 常驻节点才有值：收到心跳时顺手更新房间快照。
            // （普通客户端不记账 —— 快照对它没用，维护它纯属浪费。）
            let snaps_t = if self.serve_history || self.serve_rendezvous {
                Some(self.snaps.clone())
            } else {
                None
            };
            let mut receiver = receiver;
            async move {
                while let Some(ev) = receiver.next().await {
                    if inner.lock().unwrap().joined.as_ref().map(|j| j.room.as_str()) != Some(room_s.as_str()) {
                        break;
                    }
                    match ev {
                        Ok(GossipEvent::Received(msg)) => {
                            let Ok(wire) = serde_json::from_slice::<Wire>(&msg.content) else {
                                continue;
                            };
                            match wire {
                                Wire::Message { m } => {
                                    // ⚠️ 必须传**本房间**：v4 起房间进了签名载荷，
                                    //    这样"从别的房间搬过来的消息"会验签失败（F6）。
                                    if !m.verify(&room_s) {
                                        warn!("签名无效的消息，丢弃（或来自其它房间）");
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
                                    if let Some(ctrl) = c.verify(&room_s) {
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
                                    if !p.verify(&room_s) {
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
                                    if !l.verify(&room_s) {
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
                                    if !q.verify(&room_s) {
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
                            broadcast_presence_now(&key, &inner).await;
                        }
                        Ok(GossipEvent::NeighborDown(id)) => {
                            debug!("邻居下线 {id}");
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
            let bootstrap = bootstrap.clone();
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
                        if member_due && !bootstrap.is_empty() {
                            let _ = sender.lock().await.join_peers(bootstrap.clone()).await;
                        }
                        // 心跳也要绑定房间（F6）
                        let p = Presence::signed(&key, &nickname, files, epoch, &room_s);
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
                    {
                        let mut g = inner.lock().unwrap();
                        g.peers.retain(|_, i| now.saturating_sub(i.last_seen_ms) < PRESENCE_TTL_MS);
                    }
                    {
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

        // 孤立进房：如实告诉 UI，并起后台重连。
        //
        // 顺序有讲究 —— `Joined` 必须先发（UI 先认为"进房成功"），
        // 再发 `Isolated`（再补一句"只是暂时看不到别人"）。
        if isolated {
            self.events_tx
                .send(RoomEvent::Isolated { room: room.to_string(), isolated: true })
                .await
                .ok();
            self.spawn_relink_task(room, bootstrap.clone());
        }
        Ok(())
    }

    /// 孤立进房后的后台重连：周期性把种子重新交给 gossip，直到看见人。
    ///
    /// 为什么只需要"重新 `join_peers`"就够了：
    /// `iroh-gossip` 会把没有邻居时发的消息**排队**（见 vendor 里
    /// `subscribe_with_opts` 的文档），所以一旦这一敲成功，
    /// 之前发出去的 presence / 消息会自己流过去 —— 不需要我们重放。
    ///
    /// 判定"接上了"用的是**收到过任何人的 presence**（`inner.peers` 非空）：
    /// 这是最诚实的信号 —— 能看见人，就不再是孤岛。
    fn spawn_relink_task(&self, room: &str, seeds: Vec<EndpointId>) {
        if seeds.is_empty() {
            return;
        }
        let inner = self.inner.clone();
        let events = self.events_tx.clone();
        let room_s = room.to_string();
        let t = task::spawn(async move {
            let mut wait = RELINK_MIN;
            loop {
                n0_future::time::sleep(wait).await;
                // 已经离开 / 换了房间 → 收工（旧房间的重连不该拖累新房间）
                let sender = {
                    let g = inner.lock().unwrap();
                    match g.joined.as_ref() {
                        Some(j) if j.room == room_s => j.sender.clone(),
                        _ => break,
                    }
                };
                if sender.lock().await.join_peers(seeds.clone()).await.is_err() {
                    break;   // 通道关了 = 节点已释放
                }
                if !inner.lock().unwrap().peers.is_empty() {
                    info!("孤立结束：已重新接上房间 {room_s} 的成员");
                    events
                        .send(RoomEvent::Isolated { room: room_s.clone(), isolated: false })
                        .await
                        .ok();
                    break;
                }
                wait = wait.saturating_mul(2).min(RELINK_MAX);
            }
        });
        let mut g = self.inner.lock().unwrap();
        if let Some(j) = g.joined.as_mut() {
            j._tasks.push(AbortOnDropHandle::new(t));
        }
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
                    j.epoch = now_ms().max(j.epoch.saturating_add(1));
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
                        j.epoch = now_ms().max(j.epoch.saturating_add(1));
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
        // 房间名也要取出来：离开声明从 v4 起绑定房间（F6）
        let (sender, room) = {
            let g = self.inner.lock().unwrap();
            match g.joined.as_ref() {
                Some(j) => (j.sender.clone(), j.room.clone()),
                None => return,
            }
        };
        let l = LeaveMsg::signed(&self.secret_key, &room);
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
            id: ChatMessage::compute_id(&from, ts, text, "", &room),
            from,
            nickname,
            text: text.to_string(),
            ts,
            sig: String::new(),
            // 普通文本消息没有文件证明
            file: None,
        }
        .sign(&self.secret_key, &room);

        let bytes = serde_json::to_vec(&Wire::Message { m: msg.clone() })?;
        anyhow::ensure!(bytes.len() < MAX_MESSAGE_SIZE.saturating_sub(1024), "消息过长，请缩短文本或作为文件发送");
        sender.lock().await.broadcast(bytes.into()).await?;
        // 自己刚签的消息必然验得过；忽略返回值（失败也会有 warn）
        let _ = self.store.append_async(room, msg.clone()).await;
        Ok(msg)
    }

    /// 从常驻节点拉历史消息。
    pub async fn fetch_history(&self, room: &str, limit: usize) -> Result<HistoryResponse> {
        self.fetch_history_before(room, limit, None).await
    }

    /// **协议版本握手**（v5）：对端报来的版本和我方不一致就明确告诉 UI。
    ///
    /// 为什么非要有这条：v5 之前，版本不匹配的表现是**消息静默验签失败**
    /// （只有日志，用户侧什么都看不到）—— 用户看到的是"消息丢了"，排查时
    /// 也拿不到任何线索。现在每个服务端能力的响应都带上自己的版本，
    /// 客户端一比就知道"有一端是旧的"，于是能直接提示刷新。
    ///
    /// ⚠️ 这条只有**新客户端**能报（旧客户端里根本没有这段代码）；它反过来
    /// 只能靠服务端日志被发现（见 [`HistoryService`] 那侧的 `note_client_protocol`）。
    ///
    /// 同一个版本只报一次：拉历史/问入口都是高频动作，重复提示会变成噪音。
    async fn note_peer_protocol(&self, theirs: &str, room: &str) {
        let ours = crate::sigfmt::PROTO_V5;
        if theirs == ours {
            return;
        }
        {
            let mut seen = self.reported_protocols.lock().unwrap();
            if !seen.insert(theirs.to_string()) {
                return;
            }
        }
        // 空串 = 对端响应里**根本没有这个字段**（真正的旧版），如实区分开，
        // 免得日志里显示成"对方版本是空字符串"这种没法行动的信息。
        let label = if theirs.is_empty() { "未上报（旧版）" } else { theirs };
        warn!("协议版本不一致 room={room}：本端 {ours}，对端 {label}");
        self.events_tx
            .send(RoomEvent::ProtocolMismatch {
                room: room.to_string(),
                ours: ours.to_string(),
                theirs: theirs.to_string(),
            })
            .await
            .ok();
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
        // ⚠️ 这里连的是**历史提供者**，不是入口。两者今天指向同一个 roomd，
        //    但语义已经分开：入口管"找谁"，历史管"看过什么"。
        //    只配了入口（老配置的场景）时回退到入口 —— 行为与 B′ 之前一致。
        let Some((id, relay)) = self.history.as_ref().or(self.rendezvous.as_ref()) else {
            return Ok(HistoryResponse {
                room: room.to_string(),
                // 本端版本（没有对端可比 —— 这条路径是"根本没配置历史提供者"）
                protocol: crate::sigfmt::PROTO_V5.to_string(),
                messages: Vec::new(),
                snapshot: None,
            });
        };
        let body = n0_future::time::timeout(Duration::from_secs(20), async {
            let conn = self
                .endpoint
                .connect(EndpointAddr::new(*id).with_relay_url(relay.clone()), HISTORY_ALPN)
                .await
                .context("连接常驻节点失败")?;
            let result = async {
                let (mut send, mut recv) = conn.open_bi().await?;
                let req = HistoryRequest {
                    room: room.to_string(),
                    protocol: crate::sigfmt::PROTO_V5.to_string(),
                    limit,
                    before,
                };
                send.write_all(&serde_json::to_vec(&req)?).await?;
                send.finish()?;
                read_all(&mut recv).await
            }.await;
            conn.close(0u8.into(), b"done");
            result
        }).await.context("拉取历史超时，请重试")??;
        let mut resp: HistoryResponse =
            serde_json::from_slice(&body).context("历史响应解析失败")?;
        anyhow::ensure!(resp.room == room, "历史响应房间不匹配");
        // v5 握手：对端（历史提供者）版本不一致就提示刷新，别让它变成静默丢消息
        self.note_peer_protocol(&resp.protocol, room).await;
        // ⚠️ 历史消息**必须逐条验签**（缺陷 F8）。
        //
        // 常驻节点是转发者，而签名机制的意义正是"转发者无法伪造作者身份"。
        // 原来客户端直接 `from_slice` 就返回，等于把这条性质丢在读路径上：
        // 一个被改过的 `.jsonl`（或一个被替换的锚点）能凭空造出
        // "某人在某个房间说过的话"，而客户端完全无法察觉。
        // 顺带也把"新旧协议混跑"的历史挡在 UI 之外（v2 消息在这里验不过）。
        let before = resp.messages.len();
        // v4：历史消息也必须绑定**本房间**（F6）——顺带把"从别的房间搬来的"挡掉
        resp.messages.retain(|m| m.verify(room));
        let dropped = before - resp.messages.len();
        if dropped > 0 {
            warn!("历史响应里有 {dropped} 条验签失败的消息，已丢弃（共 {before} 条）");
        }
        // ★ 拿到快照就**并进成员表** —— 不管走的是哪条路。
        //
        // 阶段 C′ 把"进房时那一敲"换成了显式加入声明，于是**进房不再顺手拉一次历史**，
        // 这条就成了"新进房的人立刻看到屋里有哪些人（以及谁还能提供哪些文件）"的唯一来源。
        // （wasm 那侧本来就在外面手动调过一次；现在统一在这里做，外面那次已删。）
        if let Some(snapshot) = resp.snapshot.clone() {
            self.apply_snapshot(&snapshot, room).await;
        }
        Ok(resp)
    }

    /// 把历史响应里的**房间快照**并进本地成员表。
    ///
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
                let age = snap.at.saturating_sub(m.last_seen_ms);
                if age >= PRESENCE_TTL_MS {
                    continue;
                }
                let observed_at = now.saturating_sub(age);
                if let Some(peer) = g.peers.get_mut(&m.id) {
                    if peer.epoch > m.epoch {
                        continue;
                    }
                    peer.last_seen_ms = peer.last_seen_ms.max(observed_at);
                    if peer.epoch == m.epoch {
                        continue;
                    }
                }
                g.peers.insert(
                    m.id.clone(),
                    PeerInfo {
                        id: m.id.clone(),
                        nickname: m.nickname.clone(),
                        last_seen_ms: observed_at,
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
        let signed = SignedCtrl::sign(&self.secret_key, ctrl, now_ms(), expect_room);
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
            id: ChatMessage::compute_id(&from, ts, "", &meta.file_id, &room),
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
        .sign(&self.secret_key, &room);
        let bytes = serde_json::to_vec(&Wire::Message { m: msg.clone() })?;
        sender.lock().await.broadcast(bytes.into()).await?;
        let _ = self.store.append_async(room, msg).await;
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
        let q = FileQuery::signed(&self.secret_key, file_id, want, expect_room);
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
    let (nickname, files, epoch, sender, room) = {
        let g = inner.lock().unwrap();
        match g.joined.as_ref() {
            Some(j) => (
                j.nickname.clone(),
                j.files.clone(),
                j.epoch,
                j.sender.clone(),
                j.room.clone(),
            ),
            None => return,
        }
    };
    let p = Presence::signed(key, &nickname, files, epoch, &room);
    if let Ok(bytes) = serde_json::to_vec(&Wire::Presence { p }) {
        let _ = sender.lock().await.broadcast(bytes.into()).await;
    }
}

/// 读到流结束（带回读缓冲和调用方指定的硬上限）。
async fn read_all_bounded(
    recv: &mut iroh::endpoint::RecvStream,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match recv.read(&mut chunk).await? {
            Some(0) | None => break,
            Some(n) => {
                if buf.len().saturating_add(n) > max_bytes {
                    anyhow::bail!("报文过大");
                }
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    }
    Ok(buf)
}

async fn read_all(recv: &mut iroh::endpoint::RecvStream) -> Result<Vec<u8>> {
    read_all_bounded(recv, 8 * 1024 * 1024).await
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

    /// v4：签名载荷绑定房间，测试统一用这个房间名
    const ROOM: &str = "test-room";

    fn kp() -> SecretKey {
        SecretKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn older_presence_cannot_roll_back_anchor_snapshot() {
        let snapshots = new_snapshots();
        let member = MemberSnapshot {
            id: kp().public().to_string(),
            nickname: "new".into(),
            last_seen_ms: now_ms(),
            files: vec!["available".into()],
            epoch: 20,
        };
        snapshot_upsert(&snapshots, ROOM, member.clone());
        snapshot_upsert(&snapshots, ROOM, MemberSnapshot {
            nickname: "old".into(),
            files: Vec::new(),
            epoch: 10,
            ..member
        });
        let snapshot = snapshot_get(&snapshots, ROOM).unwrap();
        assert_eq!(snapshot.members[0].nickname, "new");
        assert_eq!(snapshot.members[0].files, vec!["available"]);
        assert!(snapshot.at >= snapshot.members[0].last_seen_ms);
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
        .sign(&k, ROOM)
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
            a.canonical(ROOM),
            b.canonical(ROOM),
            "长度前缀编码没能消除分隔符歧义"
        );
        assert!(!b.verify(ROOM), "改了字段却仍然通过验签");
    }

    #[test]
    fn 消息内容被改动后验签失败() {
        let m = msg("Alice", "hello");
        let mut tampered = m.clone();
        tampered.text = "hello2".into();
        assert!(!tampered.verify(ROOM));
    }

    #[test]
    fn 昵称被改动后验签失败() {
        let m = msg("Alice", "hi");
        let mut tampered = m.clone();
        tampered.nickname = "Bob".into();
        assert!(!tampered.verify(ROOM));
    }

    // ── P1-2：消息 id 必须在签名载荷里 ──────────────────────────────
    #[test]
    fn 改消息id无法重放() {
        let m = msg("Alice", "hi");
        assert!(m.verify(ROOM));
        // 只改 id：签名仍然"有效"（载荷里 id 也变了 → canonical 变了 → 其实会失败），
        // 但 id_matches() 也会先挡住，双保险
        let mut forged = m.clone();
        forged.id = "deadbeefdeadbeefdeadbeefdeadbeef".into();
        assert!(!forged.verify(ROOM), "改了 id 竟然还能通过验签");
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
        .sign(&k, ROOM);
        assert!(!m.id.is_empty());
        assert!(m.id_matches(ROOM));
        assert!(m.verify(ROOM));
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
            .sign(&k, ROOM)
        };
        assert_ne!(mk("f1").id, mk("f2").id);
    }

    // ── 存储后端：房间隔离与保留策略（SQLite）──────────────────────
    //
    // 这三个替换了原来验证 jsonl 的测试（`room_hash` / `RoomHeader` / 文件压缩）。
    // 那些机制在 SQLite 后端里**从根上不需要**：表里 `room` 直接是原始房间名，
    // 不存在"文件名有损映射"的问题。这里改成验证新后端真正要保证的事。

    #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
    #[test]
    fn 不同房间的历史互不串味() {
        // 旧实现用 sanitize() 把非 ASCII 都换成 `_`，导致
        // `研发群` / `产品群` 落到同一个文件、历史混在一起（复检 P1-6）。
        // 现在 `room` 是表里的一个字段，原始名直接比较，不可能串。
        let dir = std::env::temp_dir().join(format!("iroh-rooms-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = HistoryStore::new(Some(dir.clone())).unwrap();

        let key = kp();
        for (room, text) in [("研发群", "engineering"), ("产品群", "product"), ("team_a", "u")] {
            let m = ChatMessage {
                id: String::new(),
                from: key.public().to_string(),
                nickname: "n".into(),
                text: text.into(),
                ts: 1,
                sig: String::new(),
                file: None,
            }
            .sign(&key, room);
            assert!(store.append(room, m));
        }

        for (room, text) in [("研发群", "engineering"), ("产品群", "product"), ("team_a", "u")] {
            let got = store.recent(room, 10).unwrap();
            assert_eq!(got.len(), 1, "{room} 应该有且只有 1 条");
            assert_eq!(got[0].text, text, "{room} 拿到了别的房间的消息");
        }
        // 形近的房间名也不能互相污染
        assert_eq!(store.count("team-a").unwrap(), 0, "team-a 不该有内容（只有 team_a 有）");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
    #[test]
    fn 重启后历史仍在且能分页读回() {
        // 这是 SQLite 相比内存后端最核心的价值：进程重启不丢历史。
        let dir = std::env::temp_dir().join(format!("iroh-persist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let key = kp();
        {
            let store = HistoryStore::new(Some(dir.clone())).unwrap();
            for i in 0..30u64 {
                let m = ChatMessage {
                    id: String::new(),
                    from: key.public().to_string(),
                    nickname: "n".into(),
                    text: format!("m{i:02}"),
                    ts: i,
                    sig: String::new(),
                    file: None,
                }
                .sign(&key, ROOM);
                assert!(store.append(ROOM, m));
            }
        }
        // 新进程（新 HistoryStore）—— 模拟 roomd 重启
        let store = HistoryStore::new(Some(dir.clone())).unwrap();
        store.load_from_disk();
        assert_eq!(store.count(ROOM).unwrap(), 30, "重启后历史应完整保留");

        // 分页：取最新的 10 条，游标继续往前
        let page1 = store.recent_before_bounded(ROOM, None, 10, usize::MAX).unwrap();
        assert_eq!(page1.len(), 10);
        assert_eq!(page1.last().unwrap().text, "m29", "最后一页的最后一条应是最新消息");
        let (ts, id) = (page1[0].ts, page1[0].id.clone());
        let page2 = store.recent_before_bounded(ROOM, Some((ts, id)), 10, usize::MAX).unwrap();
        assert_eq!(page2.len(), 10);
        assert_eq!(page2.last().unwrap().text, "m19", "第二页应接在第一页之前");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
    #[test]
    fn 超过保留数后裁掉最旧的() {
        // 保留策略：只留最近 N 条，且**裁的是最旧的**（不是随机删）。
        // 直接调 SqliteHistory::trim，避开"要写 10 万条才触发"的等待。
        let dir = std::env::temp_dir().join(format!("iroh-trim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mut db =
            crate::sqlite_history::SqliteHistory::open(&dir.join("history.db")).unwrap();
        let key = kp();
        // 插 20 条，然后手工把保留数当成 10 来验（trim 用常量，这里改不了，
        // 所以改为验证"trim 之后条数 ≤ 保留数、且留下的都是最新的"）
        for i in 0..20u64 {
            let m = ChatMessage {
                id: String::new(),
                from: key.public().to_string(),
                nickname: "n".into(),
                text: format!("t{i:02}"),
                ts: i,
                sig: String::new(),
                file: None,
            }
            .sign(&key, ROOM);
            let enc = serde_json::to_vec(&m).unwrap();
            assert_eq!(db.append(ROOM, &m, &enc).unwrap(), true);
        }
        // 20 条远小于 10 万，trim 不该删任何东西
        assert_eq!(db.trim(ROOM).unwrap(), 0, "没超过保留数时不该删消息");
        assert_eq!(db.count(ROOM).unwrap(), 20);

        // 去重：同一条消息重复写入不该增加计数
        let m = ChatMessage {
            id: String::new(),
            from: key.public().to_string(),
            nickname: "n".into(),
            text: "dup".into(),
            ts: 100,
            sig: String::new(),
            file: None,
        }
        .sign(&key, ROOM);
        let enc = serde_json::to_vec(&m).unwrap();
        assert_eq!(db.append(ROOM, &m, &enc).unwrap(), true);
        assert_eq!(db.append(ROOM, &m, &enc).unwrap(), false, "重复消息应被忽略");
        assert_eq!(db.count(ROOM).unwrap(), 21);
        let _ = std::fs::remove_dir_all(dir);
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
        let bad = SignedCtrl::sign(&k, &FileCtrl::Invite(mk("someone-else")), now, "room-a");
        let bad = bad.verify("room-a").expect("签名本身应当是合法的");
        // ……但映射结果必须是 None（丢这一条），而不是 panic / 终止。
        assert!(
            ctrl_event(bad, &me, "room-a", now).is_none(),
            "sender 与签名者不一致的邀约必须被丢弃"
        );

        // ② 同一房间里紧接着的正常邀约仍要正常映射 ——
        //    这正是"循环没有被结束"的行为证据（F1）。
        let good = SignedCtrl::sign(&k, &FileCtrl::Invite(mk(&me)), now, "room-a");
        let good = good.verify("room-a").expect("签名合法");
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
            "room-a",
        );
        let replayed = replayed.verify("room-a").expect("签名合法");
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
            m = m.sign(&k, ROOM);
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

    #[test]
    fn 历史内存同时受条数与字节上限约束() {
        let store = HistoryStore::new(None).unwrap();
        let key = kp();
        for index in 0..45 {
            let message = ChatMessage {
                id: String::new(),
                from: key.public().to_string(),
                nickname: "n".into(),
                text: format!("{index:02}{}", "x".repeat(400 * 1024)),
                ts: index,
                sig: String::new(),
                file: None,
            }
            .sign(&key, ROOM);
            assert!(store.append(ROOM, message));
        }

        let retained = store.recent(ROOM, MAX_MEM_HISTORY).unwrap();
        let retained_bytes = retained.iter().map(serialized_message_bytes).sum::<usize>();
        assert!(retained.len() < 45, "字节上限应先于消息条数上限生效");
        assert!(retained_bytes <= MAX_MEM_HISTORY_BYTES);
        assert!(retained.last().unwrap().text.starts_with("44"));
    }

    #[test]
    fn 历史请求分页在克隆前受字节预算约束() {
        let store = HistoryStore::new(None).unwrap();
        let key = kp();
        for index in 0..10 {
            let message = ChatMessage {
                id: String::new(),
                from: key.public().to_string(),
                nickname: "n".into(),
                text: format!("{index:02}{}", "x".repeat(100 * 1024)),
                ts: index,
                sig: String::new(),
                file: None,
            }
            .sign(&key, ROOM);
            assert!(store.append(ROOM, message));
        }

        let page = store.recent_before_bounded(ROOM, None, 1000, 250 * 1024).unwrap();
        let page_bytes = page.iter().map(serialized_message_bytes).sum::<usize>();
        assert_eq!(page.len(), 2);
        assert!(page_bytes <= 250 * 1024);
        assert_eq!(&page.last().unwrap().text.as_bytes()[..2], b"09");
    }

    #[test]
    fn 历史请求字段限制拒绝控制字符与过长游标() {
        let valid = HistoryRequest {
            room: "room".into(),
            protocol: crate::sigfmt::PROTO_V5.into(),
            limit: usize::MAX,
            before: Some((1, "id".into())),
        };
        assert!(valid_history_request(&valid));

        let mut invalid_room = valid_history_request_fixture();
        invalid_room.room.push('\n');
        assert!(!valid_history_request(&invalid_room));

        let mut invalid_cursor = valid_history_request_fixture();
        invalid_cursor.before = Some((1, "x".repeat(MAX_HISTORY_CURSOR_ID_BYTES + 1)));
        assert!(!valid_history_request(&invalid_cursor));

        let mut invalid_timestamp = valid_history_request_fixture();
        invalid_timestamp.before = Some((u64::MAX, "id".into()));
        assert!(!valid_history_request(&invalid_timestamp));
    }

    #[test]
    fn 房间快照按成员数与字节预算裁剪() {
        let snapshots = new_snapshots();
        for index in 0..200 {
            snapshot_upsert(
                &snapshots,
                ROOM,
                MemberSnapshot {
                    id: format!("peer-{index}"),
                    nickname: "n".into(),
                    last_seen_ms: now_ms(),
                    files: vec![format!("file-{index}"); MAX_FILES_IN_HB],
                    epoch: index,
                },
            );
        }

        let snapshot = snapshot_get(&snapshots, ROOM).unwrap();
        let member_bytes = snapshot
            .members
            .iter()
            .map(|member| serde_json::to_vec(member).unwrap().len())
            .sum::<usize>();
        assert!(snapshot.members.len() <= HISTORY_SNAPSHOT_MAX_MEMBERS);
        assert!(member_bytes <= HISTORY_SNAPSHOT_MAX_BYTES);
    }

    fn valid_history_request_fixture() -> HistoryRequest {
        HistoryRequest {
            room: "room".into(),
            protocol: crate::sigfmt::PROTO_V5.into(),
            limit: 50,
            before: None,
        }
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
        .sign(&kp(), ROOM);
        assert!(m.verify(ROOM), "正常消息应当通过");
        m.text = "hello!".into(); // 篡改正文（id 及其签名随之失效）
        assert!(!m.verify(ROOM), "被改过的历史记录必须被筛掉");
    }

    // ── Presence：文件清单不能被分隔符歧义篡改 ─────────────────────
    #[test]
    fn 文件清单的分隔符注入不产生相同载荷() {
        let k = kp();
        let a = Presence::signed(&k, "n", vec!["x,y".into()], 1, ROOM);
        let b = Presence::signed(&k, "n", vec!["x".into(), "y".into()], 1, ROOM);
        assert_ne!(
            a.canonical(ROOM),
            b.canonical(ROOM),
            "清单项的分隔符歧义没有消除"
        );
    }

    #[test]
    fn 心跳被改字段后验签失败() {
        let k = kp();
        let p = Presence::signed(&k, "n", vec!["a".into()], 1, ROOM);
        assert!(p.verify(ROOM));
        let mut t = p.clone();
        t.nickname = "m".into();
        assert!(!t.verify(ROOM));
        let mut t2 = p.clone();
        t2.files.push("b".into());
        assert!(!t2.verify(ROOM));
        let mut t3 = p;
        t3.epoch += 1;
        assert!(!t3.verify(ROOM));
    }

    // ── Leave / FileQuery ─────────────────────────────────────────
    #[test]
    fn 离开声明被改后验签失败() {
        let m = LeaveMsg::signed(&kp(), ROOM);
        assert!(m.verify(ROOM));
        let mut t = m;
        t.ts += 1;
        assert!(!t.verify(ROOM));
    }

    #[test]
    fn 质询被改后验签失败() {
        let m = FileQuery::signed(&kp(), "fid", "want", ROOM);
        assert!(m.verify(ROOM));
        let mut t = m;
        t.want = "someone-else".into();
        assert!(!t.verify(ROOM));
    }
    // ── F6：签名载荷绑定房间 —— 跨房间重放必须失败 ──────────────────
    //
    // 这是 v4 的核心性质：把 A 房间抓到的合法签名消息**原样**搬进 B 房间，
    // 接收方必须验签失败。没有这条测试，v4 就只是"改了格式"。
    #[test]
    fn 跨房间重放的消息验签失败() {
        let m = msg("Alice", "hello");
        assert!(m.verify(ROOM), "本房间内应当通过");
        // 字节完全没变，只换房间名 —— 必须验不过
        assert!(!m.verify("another-room"), "A 房间的消息不能在 B 房间通过验签");
        // id 也绑定了房间（id 由包含 room 的载荷派生）
        assert!(m.id_matches(ROOM));
        assert!(!m.id_matches("another-room"));
    }

    #[test]
    fn 跨房间重放的心跳与离开也验签失败() {
        let k = kp();
        let p = Presence::signed(&k, "n", vec!["f".into()], 1, ROOM);
        assert!(p.verify(ROOM));
        assert!(!p.verify("another-room"), "心跳不能被搬进别的房间");

        let l = LeaveMsg::signed(&k, ROOM);
        assert!(l.verify(ROOM));
        assert!(!l.verify("another-room"), "离开声明不能被搬进别的房间");

        let q = FileQuery::signed(&k, "fid", "want", ROOM);
        assert!(q.verify(ROOM));
        assert!(!q.verify("another-room"), "质询不能被搬进别的房间");
    }
}

#[cfg(all(test, feature = "cli", not(target_arch = "wasm32")))]
mod multi_peer_tests {
    use super::*;
    use std::collections::HashSet;

    async fn node(anchor: Option<&RoomNode>) -> Result<RoomNode> {
        let node = RoomNode::start(RoomOptions {
            relays: vec!["https://127.0.0.1:9".into()],
            relay_token: None,
            secret_key_hex: None,
            anchor_id: anchor.map(RoomNode::endpoint_id),
            anchor_relay: anchor.map(|_| "https://127.0.0.1:9".into()),
            rendezvous_id: None,
            rendezvous_relay: None,
            history_id: None,
            history_relay: None,
            history_dir: None,
            // 测试里的"锚点"节点同时演入口与历史：这正是线上 roomd 的形态
            serve_history: anchor.is_none(),
            serve_rendezvous: anchor.is_none(),
            join_timeout_ms: None,
        }).await?;
        if let Some(anchor) = anchor {
            node.memory.add_endpoint_info(anchor.endpoint.addr());
        }
        Ok(node)
    }

    /// ★ 常驻节点联系不上时，**不该**把用户挡在房外。
    ///
    /// 回归的是旧行为：`join` 重试 4×20 秒后 `bail!`
    /// （"进房间失败：连接常驻节点超时"）。于是 roomd 一挂，
    /// 整个房间的人都进不去 —— 哪怕彼此都在线、中继也好好的。
    ///
    /// 现在应当降级为「孤立进房」：进得去、发得出，并如实报告状态。
    #[tokio::test]
    async fn unreachable_anchor_degrades_to_isolated_instead_of_failing() -> Result<()> {
        let node = RoomNode::start(RoomOptions {
            relays: vec!["https://127.0.0.1:9".into()],
            relay_token: None,
            secret_key_hex: None,
            // 一个**不存在**的常驻节点：id 随机、中继也不可达
            anchor_id: Some(SecretKey::generate().public().to_string()),
            anchor_relay: Some("https://127.0.0.1:9".into()),
            rendezvous_id: None,
            rendezvous_relay: None,
            history_id: None,
            history_relay: None,
            history_dir: None,
            serve_history: false,
            serve_rendezvous: false,
            join_timeout_ms: Some(300),   // 别让测试等默认的 8 秒
        })
        .await?;
        let events = node.subscribe();

        // ① 进房必须**成功** —— 旧行为在这里返回 Err
        node.join("isolated-room", "甲").await?;
        assert_eq!(node.current_room().as_deref(), Some("isolated-room"));

        // ② 必须如实报告"联系不上别人"，而不是让 UI 以为房间里本来就没人
        let mut saw_joined = false;
        let mut saw_isolated = false;
        while !saw_isolated {
            match n0_future::time::timeout(Duration::from_secs(5), events.recv()).await {
                Ok(Ok(RoomEvent::Joined { room })) => {
                    assert_eq!(room, "isolated-room");
                    saw_joined = true;
                }
                Ok(Ok(RoomEvent::Isolated { isolated, .. })) => {
                    assert!(isolated, "孤立状态必须是 true");
                    saw_isolated = true;
                }
                Ok(Ok(_)) => {}   // relayStatus 之类，不关心
                Ok(Err(_)) => panic!("事件通道提前关闭"),
                Err(_) => panic!("等 Isolated 事件超时"),
            }
        }
        assert!(saw_joined, "应该先收到 Joined 再收到 Isolated");
        node.shutdown();
        Ok(())
    }

    /// 测试用的基础配置：只给一个中继占位，其余全默认
    /// （新增 RoomOptions 字段时只改这一处，不必每条测试都改）
    fn base_options() -> RoomOptions {
        RoomOptions {
            relays: vec!["https://127.0.0.1:9".into()],
            relay_token: None,
            secret_key_hex: None,
            anchor_id: None,
            anchor_relay: None,
            rendezvous_id: None,
            rendezvous_relay: None,
            history_id: None,
            history_relay: None,
            history_dir: None,
            serve_history: false,
            serve_rendezvous: false,
            join_timeout_ms: None,
        }
    }

    /// 等入口的成员表里出现足够多的人（presence 是异步到的）
    async fn wait_members(snaps: &Snapshots, room: &str, want: usize) -> Result<()> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if snapshot_get(snaps, room).map(|s| s.members.len()).unwrap_or(0) >= want {
                return Ok(());
            }
            if std::time::Instant::now() > deadline {
                anyhow::bail!("等成员表超时（想要 {want} 个）");
            }
            n0_future::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    /// ★ 阶段 B′：**入口与历史是两个独立能力**。
    ///
    /// 只开入口的节点能回答"这房间里现在有谁"，但**装不了**历史 ——
    /// 客户端拉历史必须**明确失败**（而不是悄悄返回空页，让人以为"这房间没聊过"）。
    /// 这条测的就是"拆分"本身：一个开关不该牵连另一个。
    #[tokio::test]
    async fn rendezvous_and_history_are_independent_capabilities() -> Result<()> {
        // 只做入口、不存历史
        let entry = RoomNode::start(RoomOptions {
            relays: vec!["https://127.0.0.1:9".into()],
            relay_token: None,
            secret_key_hex: None,
            anchor_id: None,
            anchor_relay: None,
            rendezvous_id: None,
            rendezvous_relay: None,
            history_id: None,
            history_relay: None,
            history_dir: None,
            serve_history: false,
            serve_rendezvous: true,
            join_timeout_ms: Some(1_000),
        })
        .await?;
        entry.join("caps-room", "入口").await?;

        // 客户端：两个角色都回退到这个入口（老配置的形态）
        let client = node(Some(&entry)).await?;
        client.join("caps-room", "甲").await?;
        // ⚠️ 快照只记**别人**（自己不需要记在成员表里）：入口这一侧应当出现 1 个成员
        wait_members(&entry.snaps, "caps-room", 1).await?;

        // ① 入口能回答"这房间里有谁"：报出刚进来的成员
        let members = client.rendezvous_candidates("caps-room").await;
        assert!(
            members.contains(&client.endpoint.id()),
            "入口应当报出刚进房的成员，实际拿到 {members:?}"
        );

        // ② 组合出的候选里，**入口自己**也必须在 —— 否则会出现"问到了别人，却连不上入口"
        let candidates = client.bootstrap_candidates("caps-room").await;
        assert!(
            candidates.contains(&entry.endpoint.id()),
            "固有候选必须包含入口自己（它是你总能找到的第一个人）"
        );
        assert!(
            candidates.contains(&client.endpoint.id()),
            "候选里应当带上入口报的成员"
        );

        // ② 但历史能力没装 → 拉历史**必须报错**
        let history = client.fetch_history("caps-room", 10).await;
        assert!(history.is_err(), "没装历史能力时拉历史应当明确失败，而不是返回空页");

        client.shutdown();
        entry.shutdown();
        Ok(())
    }

    /// ★ 阶段 C′（终态 ③）：**新能力 = 新增一个实现，不改核心 dispatch**。
    ///
    /// 这里注册一个核心完全不认识的能力，验证两件事：
    ///   ① 它的 ALPN 真的被服务（除了"注册"这一步，核心一行没改）；
    ///   ② 它能通过 `RoomEvent::Plugin` 把消息端给 UI（核心不理解内容，只负责转）。
    #[tokio::test]
    async fn a_custom_capability_is_served_and_can_emit_plugin_events() -> Result<()> {
        /// 一个第三方能力：收到什么就把什么回显，并且顺手推一条插件事件
        #[derive(Debug, Clone)]
        struct EchoCapability {
            events: Sender<RoomEvent>,
        }
        impl ProtocolHandler for EchoCapability {
            async fn accept(
                &self,
                connection: iroh::endpoint::Connection,
            ) -> std::result::Result<(), AcceptError> {
                let (mut send, mut recv) = connection.accept_bi().await.map_err(AcceptError::from_err)?;
                // ⚠️ `AcceptError::from_err` 只认 `std::error::Error`，而 `read_all_bounded`
                //    返回的是 `anyhow::Error`（没实现它）—— 转成字符串即可。
                let bytes = read_all_bounded(&mut recv, 1024)
                    .await
                    .map_err(|e| AcceptError::from_err(std::io::Error::other(e.to_string())))?;
                let got = String::from_utf8_lossy(&bytes).to_string();
                // ★ 插件自定义事件：核心不知道 "echo" 是什么，只负责原样转发
                let _ = self
                    .events
                    .send(RoomEvent::Plugin {
                        name: "echo".into(),
                        payload: serde_json::json!({ "got": got, "len": bytes.len() }),
                    })
                    .await;
                send.write_all(b"ok").await.map_err(AcceptError::from_err)?;
                send.finish()?;
                // ⚠️ 与内置能力同款：写完**等对端读完再放掉连接**。
                //    直接 return 会把连接立刻关掉，对端读到的可能是 "closed by peer"
                //    而不是我们刚写的内容（这个坑在测试里第一次就踩到了）。
                let _ = n0_future::time::timeout(Duration::from_secs(5), connection.closed()).await;
                Ok(())
            }
        }
        impl RoomCapability for EchoCapability {
            fn alpn(&self) -> &'static [u8] {
                ECHO_ALPN
            }
            fn name(&self) -> &'static str {
                "echo"
            }
            fn handler(&self) -> Box<dyn DynProtocolHandler> {
                Box::new(self.clone())
            }
        }
        const ECHO_ALPN: &[u8] = b"test/echo/1";

        let (tx, rx) = async_channel::bounded::<RoomEvent>(4);
        let mut extra = CapabilityRegistry::new();
        extra.register(EchoCapability { events: tx });
        // 服务端：装着那个自定义能力
        let server = RoomNode::start_with(base_options(), extra).await?;
        // 客户端：另一个节点（iroh 不允许连自己）
        let client = node(Some(&server)).await?;

        // 客户端按这个能力的 ALPN 连上去（核心的 Router 已经把它服务起来了）
        let conn = client
            .endpoint
            .connect(server.endpoint.addr(), ECHO_ALPN)
            .await
            .context("连接自定义能力失败")?;
        {
            let (mut send, mut recv) = conn.open_bi().await?;
            send.write_all(b"hello-capability").await?;
            send.finish()?;
            let ack = read_all_bounded(&mut recv, 64).await?;
            assert_eq!(&ack, b"ok", "能力自己写的响应应当被读回来");
        }

        // 插件事件原样到达 UI 那侧
        let event = n0_future::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .context("等插件事件超时")?
            .context("插件事件通道关闭")?;
        match event {
            RoomEvent::Plugin { name, payload } => {
                assert_eq!(name, "echo");
                assert_eq!(payload["got"], "hello-capability");
            }
            other => panic!("应当是 Plugin 事件，实际 {other:?}"),
        }

        // ★ 反向对照：**没注册的能力，ALPN 就不该被服务**。
        //
        // 少了这一半，"注册表"就有可能是个摆设 —— 只要核心（或某个兜底 handler）
        // 对着任意 ALPN 都应答，上面那条正向断言照样绿，而"新能力必须显式注册"
        // 这个约束其实没被证明。验收条件里那句"只有装了它的 peer 响应其 ALPN"
        // 要的正是这一条。
        let unregistered = client
            .endpoint
            .connect(server.endpoint.addr(), b"test/never-registered/1")
            .await;
        match unregistered {
            // 握手阶段就被拒 —— 预期
            Err(_) => {}
            // 少数实现会先建连、随后关掉：那样也必须是**不可用**的
            Ok(conn) => assert!(
                conn.open_bi().await.is_err(),
                "没注册的 ALPN 不该能开出流来（核心里有兜底 handler？）"
            ),
        }
        client.shutdown();
        server.shutdown();
        Ok(())
    }

    /// ★ v5 握手：对端还是**旧版**时，新客户端必须**明确知道**，而不是让消息静默丢掉。
    ///
    /// 复刻的是切换期最容易踩的状态："新前端 × 旧 roomd"。改造前这种情况唯一的
    /// 表现是**消息验签失败**（只有一行日志），用户看到的是"消息没了" —— 极难排查。
    /// 现在每次拉历史都会比对服务端报的版本，不一致就发一条事件给 UI。
    ///
    /// 这里用**假的历史提供者**而不是改真服务的常量：要测的是"对端报了个我不认识的
    /// 版本时客户端怎么办"，而不是"我把常量改对了没有"—— 后者改错一次就白测了。
    #[tokio::test]
    async fn stale_history_provider_is_reported_as_protocol_mismatch_exactly_once() -> Result<()> {
        /// 一个旧版历史服务：响应里**根本没有** `protocol` 字段（正是旧二进制的形态）
        #[derive(Debug, Clone)]
        struct StaleHistoryProvider;
        impl ProtocolHandler for StaleHistoryProvider {
            async fn accept(
                &self,
                connection: iroh::endpoint::Connection,
            ) -> std::result::Result<(), AcceptError> {
                let (mut send, mut recv) =
                    connection.accept_bi().await.map_err(AcceptError::from_err)?;
                let bytes = read_all_bounded(&mut recv, MAX_HISTORY_REQUEST_BYTES)
                    .await
                    .map_err(|e| AcceptError::from_err(std::io::Error::other(e.to_string())))?;
                // 原样回房间名，免得测试替身自己引入"房间不匹配"的失败
                let room: String = serde_json::from_slice::<serde_json::Value>(&bytes)
                    .ok()
                    .and_then(|v| v["room"].as_str().map(str::to_string))
                    .unwrap_or_default();
                let body = serde_json::to_vec(&serde_json::json!({
                    "room": room,
                    "messages": [],
                }))
                .map_err(AcceptError::from_err)?;
                send.write_all(&body).await.map_err(AcceptError::from_err)?;
                send.finish()?;
                // 与内置能力同款：写完等对端读完，别把连接提前掐掉
                let _ = n0_future::time::timeout(Duration::from_secs(5), connection.closed()).await;
                Ok(())
            }
        }
        impl RoomCapability for StaleHistoryProvider {
            fn alpn(&self) -> &'static [u8] {
                HISTORY_ALPN
            }
            fn name(&self) -> &'static str {
                "stale-history-fake"
            }
            fn handler(&self) -> Box<dyn DynProtocolHandler> {
                Box::new(self.clone())
            }
        }

        // 只装这个假能力（`base_options` 里 serve_* 全关，真历史服务不会来抢 ALPN）
        let mut extra = CapabilityRegistry::new();
        extra.register(StaleHistoryProvider);
        let server = RoomNode::start_with(base_options(), extra).await?;
        let client = node(Some(&server)).await?;
        let events = client.subscribe();

        // ① 旧版对端 → 必须报出来，且如实区分"没上报"与"报了个别的版本"
        let resp = client.fetch_history("mismatch-room", 10).await?;
        assert!(resp.messages.is_empty());
        let mismatch = n0_future::time::timeout(Duration::from_secs(10), async {
            while let Ok(ev) = events.recv().await {
                if let RoomEvent::ProtocolMismatch { ours, theirs, room } = ev {
                    return (ours, theirs, room);
                }
            }
            panic!("事件通道提前关闭");
        })
        .await
        .context("等「协议不一致」事件超时")?;
        assert_eq!(mismatch.0, crate::sigfmt::PROTO_V5, "本端版本应当是当前协议");
        assert_eq!(mismatch.1, "", "旧版对端根本没上报版本，不要凭空造一个");
        assert_eq!(mismatch.2, "mismatch-room");

        // ② 同一个对端版本只提示一次 —— 拉历史是高频动作，重复弹会变成噪音
        client.fetch_history("mismatch-room", 10).await?;
        let again = n0_future::time::timeout(Duration::from_millis(600), async {
            while let Ok(ev) = events.recv().await {
                if matches!(ev, RoomEvent::ProtocolMismatch { .. }) {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(!again, "同一个旧版本不应反复提示");

        client.shutdown();
        server.shutdown();
        Ok(())
    }

    /// ★ 阶段 C′：**显式加入声明**取代了"靠拉一次历史的副作用触发订阅"。
    ///
    /// 复刻 roomd 的形态：一个**只按需订阅**的服务端（controller 从 `join_rx` 收房间名），
    /// 客户端进房发一条声明 → 服务端订阅该房间 → 消息进历史；
    /// 后进房的人因此看得到。**全程没有"为了触发订阅而拉历史"的调用。**
    #[tokio::test]
    async fn join_announcement_subscribes_the_provider() -> Result<()> {
        let mut provider = node(None).await?; // 同时提供入口与历史（roomd 的形态）
        let join_rx = provider.take_join_receiver().context("服务端应当带订阅请求通道")?;
        let provider = Arc::new(provider);
        let store = provider.history();

        // roomd 的 controller：谁被声明过就订阅谁
        let controller = {
            let provider = provider.clone();
            tokio::spawn(async move {
                while let Ok(room) = join_rx.recv().await {
                    let _ = provider.join(&room, "常驻节点").await;
                }
            })
        };
        // roomd 的消费循环：收到的消息写进历史
        let sink = {
            let provider = provider.clone();
            let store = store.clone();
            tokio::spawn(async move {
                let events = provider.subscribe();
                while let Ok(event) = events.recv().await {
                    if let RoomEvent::Message { room, message, mine: false } = event {
                        store.append_async(room, message).await;
                    }
                }
            })
        };

        let client = node(Some(provider.as_ref())).await?;
        let room = "announce-room";
        // ⚠️ 这一步只发**加入声明**（阶段 C′）：没有任何"读一次历史来触发订阅"
        client.join(room, "甲").await?;

        // 服务端应当因为那条声明而订阅了这个房间
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while provider.current_room().as_deref() != Some(room) {
            if std::time::Instant::now() > deadline {
                anyhow::bail!("服务端没有因为加入声明而订阅房间");
            }
            n0_future::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        client.send("hello-from-announce").await?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while store.count(room).unwrap_or(0) < 1 {
            if std::time::Instant::now() > deadline {
                anyhow::bail!("声明的房间里的消息没有进历史");
            }
            n0_future::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        // 后进房的人拉历史能看到它 —— 这就是"声明"存在的意义
        let late = node(Some(provider.as_ref())).await?;
        let history = late.fetch_history(room, 10).await?;
        assert!(
            history.messages.iter().any(|m| m.text == "hello-from-announce"),
            "后进房的人应当能看到声明期间的消息"
        );

        controller.abort();
        sink.abort();
        late.shutdown();
        client.shutdown();
        Ok(())
    }

    #[tokio::test]
    async fn history_storage_errors_reach_the_client_and_can_be_retried() -> Result<()> {
        let directory = std::env::temp_dir().join(format!("iroh-history-service-{}-{}", std::process::id(), now_ms()));
        let anchor = RoomNode::start(RoomOptions {
            relays: vec!["https://127.0.0.1:9".into()],
            relay_token: None,
            secret_key_hex: None,
            anchor_id: None,
            anchor_relay: None,
            rendezvous_id: None,
            rendezvous_relay: None,
            history_id: None,
            history_relay: None,
            history_dir: Some(directory.to_string_lossy().into_owned()),
            serve_history: true,
            serve_rendezvous: false,
            join_timeout_ms: None,
        }).await?;
        let client = node(Some(&anchor)).await?;
        let room = "history-service-errors";
        let author = SecretKey::generate();
        let message = ChatMessage {
            id: String::new(), from: author.public().to_string(), nickname: "author".into(),
            text: "persisted".into(), ts: 1, sig: String::new(), file: None,
        }.sign(&author, room);
        assert!(anchor.store.append_async(room.into(), message.clone()).await);
        assert_eq!(client.fetch_history(room, 50).await?.messages, vec![message.clone()]);
        let connection = rusqlite::Connection::open(directory.join("history.db"))?;
        connection.execute("UPDATE messages SET json=?1", rusqlite::params![b"invalid JSON".as_slice()])?;
        assert!(client.fetch_history(room, 50).await.is_err());
        connection.execute("UPDATE messages SET json=?1", rusqlite::params![serde_json::to_vec(&message)?])?;
        assert_eq!(client.fetch_history(room, 50).await?.messages, vec![message]);
        assert!(client.fetch_history_before(room, 50, Some((u64::MAX, "id".into()))).await.is_err());
        drop(connection);
        drop(client);
        drop(anchor);
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[tokio::test]
    async fn three_users_exchange_messages_and_late_joiner_gets_history() -> Result<()> {
        let anchor = node(None).await?;
        let anchor_events = anchor.subscribe();
        let store = anchor.history();
        let recorder = task::spawn(async move {
            while let Ok(event) = anchor_events.recv().await {
                if let RoomEvent::Message { room, message, .. } = event {
                    store.append(&room, message);
                }
            }
        });
        let recorder = AbortOnDropHandle::new(recorder);
        let first = node(Some(&anchor)).await?;
        let second = node(Some(&anchor)).await?;
        let third = node(Some(&anchor)).await?;
        let users = [&first, &second, &third];
        let events: Vec<_> = users.iter().map(|user| user.subscribe()).collect();
        let room = "three-user-regression";
        anchor.join(room, "anchor").await?;
        first.join(room, "first").await?;
        second.join(room, "second").await?;
        assert!(first.send(&"长".repeat(180_000)).await.is_err());
        assert!(first.send(&"\u{0001}".repeat(MAX_MESSAGE_SIZE / 5)).await.is_err());
        assert!(second.join(&"长".repeat(90), "second").await.is_err());
        assert_eq!(second.current_room().as_deref(), Some(room));
        let initial_epoch = first.inner.lock().unwrap().joined.as_ref().unwrap().epoch;
        first.set_nickname("first-renamed");
        let renamed_epoch = first.inner.lock().unwrap().joined.as_ref().unwrap().epoch;
        assert!(renamed_epoch > initial_epoch);
        first.set_available_files(vec!["1".repeat(32)]);
        assert!(first.inner.lock().unwrap().joined.as_ref().unwrap().epoch > renamed_epoch);
        let initial = first.send("before-third").await?;
        tokio::time::timeout(Duration::from_secs(10), async {
            while anchor.store.count(room).unwrap() < 1 || snapshot_get(&anchor.snaps, room).map(|s| s.members.len()).unwrap_or(0) < 2 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await?;
        third.join(room, "third").await?;
        let history = third.fetch_history(room, 50).await?;
        assert!(history.messages.iter().any(|message| message.id == initial.id));
        for other in [&first, &second] {
            assert!(third.inner.lock().unwrap().peers.contains_key(&other.endpoint_id()));
        }
        let mut sent = Vec::new();
        for user in users {
            sent.push(user.send(&format!("from-{}", user.endpoint_id())).await?);
        }
        for (index, receiver) in events.iter().enumerate() {
            let expected: HashSet<_> = sent.iter().enumerate()
                .filter(|(sender, _)| *sender != index)
                .map(|(_, message)| message.id.clone()).collect();
            tokio::time::timeout(Duration::from_secs(10), async {
                let mut received = HashSet::new();
                while received.len() < expected.len() {
                    if let Ok(RoomEvent::Message { message, .. }) = receiver.recv().await {
                        if expected.contains(&message.id) {
                            received.insert(message.id);
                        }
                    }
                }
            }).await?;
        }
        second.leave_room().await;
        let after_leave = first.send("remaining-users").await?;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(RoomEvent::Message { message, .. }) = events[2].recv().await {
                    if message.id == after_leave.id { break; }
                }
            }
        }).await?;
        for user in users { user.shutdown(); }
        anchor.shutdown();
        drop(recorder);
        Ok(())
    }
}
