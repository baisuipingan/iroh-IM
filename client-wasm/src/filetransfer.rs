//! 文件传输：P2P 直连 + 流式落盘。
//!
//! ## 为什么不用 `iroh-blobs` 直接传
//!
//! `iroh-blobs` 在浏览器里**只有内存存储**（`store` 模块仅提供 `fs` / `mem` / `readonly_mem`）。
//! 官方 `browser-blobs` 示例用的是 `MemStore`，`download()` 把整个文件读进 wasm 内存，
//! `get()` 再拷一份到 JS 堆 —— wasm32 地址空间上限 4GB，实际 1~2GB 就不稳，10GB 不可能。
//!
//! 所以这里的做法是：**沿用 iroh-blobs 的格式（blake3 内容哈希 + 16KB 块），
//! 但数据面走自己的流式管道**。峰值内存 = 一块（16KB），与文件大小无关。
//!
//! ## 协议
//!
//! 控制面走 gossip（只带元信息，不含内容）：
//! ```text
//! Invite  发送方广播 → 文件名/大小/块大小/整文件哈希 + 自己的中继地址
//! Accept  接收方回应 → 同意 + 「已有块」位图（断点续传）+ 自己的中继地址
//! Reject  接收方回应 → 拒绝（可不回，发送方超时即可）
//! Done    接收方收完并校验后回报
//! ```
//!
//! 数据面是一条独立的 QUIC 双向流（ALPN = [`FILE_ALPN`]），由**发送方拨号发起**。
//! 帧格式：`[u8 kind][u32 len BE][payload]`
//! ```text
//! kind=1  header  JSON {"file_id","name","size","chunk_size","root_hash"}
//! kind=2  chunk   payload = [u32 seq BE][原始字节]
//! kind=3  done    JSON {"ok":bool,"reason":string}
//! ```
//!
//! ## 为什么是「发送方拨号」
//!
//! 我们的部署里**中继之间不互转**，拨号方必须知道对端**真实所在的中继**。
//! 所以 `Accept` 消息里必须带上接收方的中继地址，发送方据此拨号。
//! （这与聊天里"拨号要带 relay"是同一条约束。）

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use async_channel::{Receiver, Sender};
use iroh::{
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler},
    EndpointId, PublicKey, SecretKey, Signature,
};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

/// 测试钩子：>0 时发送方只发前 N 块就结束（验证断点续传用）。正常运行时为 0。
pub static STOP_AFTER_CHUNKS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 文件数据面用的 ALPN（与聊天/历史都不同，互不干扰）。
pub const FILE_ALPN: &[u8] = b"editor.vip/iroh-file/1";

/// 分块大小。与 `iroh-blobs` 的 `IROH_BLOCK_SIZE` 保持一致（16 KiB）。
///
/// 实测（2026-10-01）：把它放大到 256KB **对吞吐没有任何改善**
/// （16KB≈78 KB/s，256KB≈48 KB/s，都在噪声内）。所以慢的原因不是"每块开销"，
/// 调它没用。详见 docs 里关于浏览器中继吞吐的结论。
/// （真要改，必须同步改前端 `filetransfer.js` 里的 CHUNK 常量，两端必须一致。）
pub const CHUNK_SIZE: u32 = 16 * 1024;

/// 同时进行的入站接收上限（`Pending` 表大小）。
///
/// 每个待接收条目都会占两个通道 + 一份元信息；而 `file_id` 是广播出去的、
/// 数据流却是任何人可拨的，所以这张表必须有上限（F18 的资源面）。
pub const MAX_PENDING_RECV: usize = 32;

/// 单次入站数据流的**并发**上限（含还没读到 header 的连接）。
///
/// 关键点：这个计数在**读 header 之前**就检查，所以"连上不发数据"这种
/// 最廉价的占位手段也被它挡住 —— 不需要先通过任何身份校验。
pub const MAX_CONCURRENT_ACCEPTS: usize = 64;

/// 读 header / 等对方开流的超时。
///
/// 没有它的话，任何人拨通 `FILE_ALPN` 后发 0~4 字节就能把一条 accept 任务
/// **永久**钉住：iroh 强制开启 QUIC keep-alive（`iroh-1.3.0/src/endpoint/quic.rs:157`），
/// 所以"对端不发数据"并不会触发空闲超时把连接回收掉（F18）。
const HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 传输过程中**两块之间**的空闲超时。
///
/// 数值取得比 header 宽松：正常传输两块之间只会等毫秒级，
/// 但弱网重传时可能停顿较久，60 秒足够宽容，又不至于让"发一半就不发了"
/// 的连接一直占着资源。
const FRAME_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 在途入站流的计数守卫：`Drop` 时自动减一，
/// 这样任何提前 `return`（包括 `?`、deny、超时）都不会漏记。
struct InflightGuard(Arc<std::sync::atomic::AtomicUsize>);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 单帧上限（防止对端发超大帧打爆内存）。
pub const MAX_FRAME: usize = 1024 * 1024;

/// 块数上限（防御性）。
///
/// `size` / `chunk_size` 都是**对端自报**的。如果不设上限，一条
/// `size = 2^32, chunk_size = 1` 的邀约就能让接收方按"40 亿块"去分配位图
/// （JS 侧 `Uint8Array(n/8)` = 512MB），或者在 wasm32 上发生 `as usize` 截断
/// 把块数变成 0 —— 后者会让"块收齐了"的检查直接失效（见 F17）。
///
/// 4M 块 × 16KiB = 64 GiB，远超"浏览器传文件"的实际场景，又足以钉死最坏情况。
pub const MAX_CHUNKS: usize = 4 * 1024 * 1024;

/// 文件名长度上限（它会被塞进 UI / 保存对话框建议名）。
pub const MAX_NAME_LEN: usize = 255;

/// 校验**邀约元信息**是否可用于接收。
///
/// 这是在"信任边界"上做的一次**权威校验**：`FileMeta` 全部字段都来自对端
/// （只保证 `sender` 等于签名者），所以在把任何东西写进表、分配内存、显示卡片之前
/// 必须逐项检查。返回 `Err` 表示**必须拒收这条邀约**。
///
/// 检查项与理由：
/// - `file_id`：非空、ASCII 十六进制风格、有长度上限。它会被用作 map 键、
///   IndexedDB 键，以及前端 `querySelector([data-file-id=...])` 的一部分 ——
///   放任任意字符串会造成选择器注入与状态错乱。
/// - `name`：非空、有长度上限、不含控制字符。
/// - `chunk_size`：必须**恰好**等于协议约定的 [`CHUNK_SIZE`]。
///   允许对端自定义会让"块序号 × 块大小 = 写盘偏移"这套算法失去共同基准。
/// - `root_hash`：必须是 **blake3 的 64 位 hex**。空哈希等于放弃内容校验
///   （这正是 F17 要堵的洞：空 `root_hash` 会让浏览器端静默跳过校验并报成功）。
/// - `size` 与块数：块数必须落在 `1..=MAX_CHUNKS`（`size == 0` 的空文件按 1 块处理，
///   与 `chunk_count` 的语义保持一致，见下）。
/// - `sender`：非空（授权登记靠它）。
pub fn validate_meta(m: &FileMeta) -> std::result::Result<(), String> {
    // file_id：ASCII 字母数字/_/-，1..=64
    if m.file_id.is_empty() || m.file_id.len() > 64 {
        return Err(format!("file_id 长度非法（{}）", m.file_id.len()));
    }
    if !m
        .file_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("file_id 含非法字符（只允许 ASCII 字母数字/-/_）".into());
    }
    // name
    if m.name.is_empty() || m.name.len() > MAX_NAME_LEN {
        return Err(format!("文件名长度非法（{}）", m.name.len()));
    }
    if m.name.chars().any(|c| c.is_control()) {
        return Err("文件名含控制字符".into());
    }
    // chunk_size：必须与协议一致
    if m.chunk_size != CHUNK_SIZE {
        return Err(format!(
            "chunk_size 非法（{}，协议要求 {CHUNK_SIZE}）",
            m.chunk_size
        ));
    }
    // root_hash：必须是 64 位 hex（blake3）
    let h = m.root_hash.trim();
    if h.len() != 64 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "root_hash 非法（需要 64 位 hex，实际 {} 位）",
            h.len()
        ));
    }
    // sender
    if m.sender.is_empty() {
        return Err("sender 为空".into());
    }
    // 块数：
    //  - `size > 0` 却算出 0 块 ⇒ 说明发生了 `as usize` 截断（wasm32 上 usize 是 32 位，
    //    `size / chunk_size` 超过 u32::MAX 时归 0）。这时"块收齐了"的检查会**永远通过**，
    //    再叠加上面/下面的校验分支就可能产出"零校验的成功"——必须拒。
    //  - 空文件（size == 0）本身就是 0 块，合法：它的整文件哈希就是空串的 blake3，
    //    仍然会被 finish() 正常校验。
    let n = chunk_count(m.size, m.chunk_size);
    if m.size > 0 && n == 0 {
        return Err(format!(
            "块数算成 0（size={} chunk_size={}，疑似整数截断）",
            m.size, m.chunk_size
        ));
    }
    if n > MAX_CHUNKS {
        return Err(format!(
            "块数超上限（size={} chunk_size={} → {n} 块，上限 {MAX_CHUNKS}）",
            m.size, m.chunk_size
        ));
    }
    Ok(())
}

// 帧类型
pub const FRAME_HEADER: u8 = 1;
pub const FRAME_CHUNK: u8 = 2;
pub const FRAME_DONE: u8 = 3;

// ---------------------------------------------------------------------------
// 控制面消息
// ---------------------------------------------------------------------------

/// 文件元信息（邀约里带的全部内容，不含文件本身）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    /// 本次传输的随机 id（16 hex）
    pub file_id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub chunk_size: u32,
    /// 整个文件的 blake3（hex），接收方据此校验
    pub root_hash: String,
    /// 发送方 EndpointId
    pub sender: String,
    /// 发送方的 home 中继地址（接收方要连它，必须知道）
    pub sender_relay: String,
    pub ts: u64,
}

/// 控制面动作。
#[derive(Debug, Clone)]
pub enum FileCtrl {
    Invite(FileMeta),
    /// 同意接收。`have` 是「已拥有块」的位图（base64），支持断点续传。
    Accept {
        file_id: String,
        have: String,
        receiver_relay: String,
    },
    Reject {
        file_id: String,
        reason: String,
    },
    /// 接收方收完并校验后的回报。
    Done {
        file_id: String,
        ok: bool,
        reason: String,
    },
}

impl FileCtrl {
    pub fn file_id(&self) -> &str {
        match self {
            FileCtrl::Invite(m) => &m.file_id,
            FileCtrl::Accept { file_id, .. } => file_id,
            FileCtrl::Reject { file_id, .. } => file_id,
            FileCtrl::Done { file_id, .. } => file_id,
        }
    }

    /// 参与签名的规范化字符串。**收发双方必须用完全相同的拼法。**
    ///
    /// 用**无歧义的长度前缀编码**（`crate::sigfmt`），不用 `|` 拼接 ——
    /// 昵称/文件名里含分隔符时，两组不同字段会拼出同一串字节，
    /// 签名有效但语义被改掉。
    ///
    /// ⚠️ `Invite` 的签名**包含 `sender`**（发送方 EndpointId）。
    ///    这不是冗余：文件流的授权完全建立在"我接受的那个邀约来自
    ///    真正的发送方"之上，而 `sender` 是接收侧登记期待发送者时用的字段。
    ///    它不参与签名，就等于可以被改（改成别人的 id 也不影响验签）。
    fn canonical(&self, from: &str, ts: u64) -> String {
        use crate::sigfmt::encode_fields;
        let ts_s = ts.to_string();
        match self {
            FileCtrl::Invite(m) => {
                let size = m.size.to_string();
                let chunk = m.chunk_size.to_string();
                encode_fields(&[
                    "f2",
                    "invite",
                    "from",
                    from,
                    "ts",
                    ts_s.as_str(),
                    "file_id",
                    m.file_id.as_str(),
                    "name",
                    m.name.as_str(),
                    "size",
                    size.as_str(),
                    "mime",
                    m.mime.as_str(),
                    "chunk_size",
                    chunk.as_str(),
                    "root_hash",
                    m.root_hash.as_str(),
                    // 关键：发送方身份进签名
                    "sender",
                    m.sender.as_str(),
                    "sender_relay",
                    m.sender_relay.as_str(),
                ])
            }
            FileCtrl::Accept {
                file_id,
                have,
                receiver_relay,
            } => encode_fields(&[
                "f2",
                "accept",
                "from",
                from,
                "ts",
                ts_s.as_str(),
                "file_id",
                file_id.as_str(),
                "have",
                have.as_str(),
                "receiver_relay",
                receiver_relay.as_str(),
            ]),
            FileCtrl::Reject { file_id, reason } => encode_fields(&[
                "f2",
                "reject",
                "from",
                from,
                "ts",
                ts_s.as_str(),
                "file_id",
                file_id.as_str(),
                "reason",
                reason.as_str(),
            ]),
            FileCtrl::Done { file_id, ok, reason } => {
                let ok_s = if *ok { "1" } else { "0" };
                encode_fields(&[
                    "f2",
                    "done",
                    "from",
                    from,
                    "ts",
                    ts_s.as_str(),
                    "file_id",
                    file_id.as_str(),
                    "ok",
                    ok_s,
                    "reason",
                    reason.as_str(),
                ])
            }
        }
    }
}

/// 带签名的控制消息（防止他人伪造"我同意发文件"）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedCtrl {
    pub from: String,
    pub ts: u64,
    pub sig: String,
    /// 序列化后的 FileCtrl（自描述，避免手写 tag）
    pub body: CtrlBody,
}

/// `FileCtrl` 的可序列化镜像（`FileCtrl` 本身不带 serde 派生，便于手写 canonical）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum CtrlBody {
    Invite(FileMeta),
    Accept {
        file_id: String,
        have: String,
        receiver_relay: String,
    },
    Reject {
        file_id: String,
        reason: String,
    },
    Done {
        file_id: String,
        ok: bool,
        reason: String,
    },
}

impl From<&FileCtrl> for CtrlBody {
    fn from(c: &FileCtrl) -> Self {
        match c {
            FileCtrl::Invite(m) => CtrlBody::Invite(m.clone()),
            FileCtrl::Accept {
                file_id,
                have,
                receiver_relay,
            } => CtrlBody::Accept {
                file_id: file_id.clone(),
                have: have.clone(),
                receiver_relay: receiver_relay.clone(),
            },
            FileCtrl::Reject { file_id, reason } => CtrlBody::Reject {
                file_id: file_id.clone(),
                reason: reason.clone(),
            },
            FileCtrl::Done { file_id, ok, reason } => CtrlBody::Done {
                file_id: file_id.clone(),
                ok: *ok,
                reason: reason.clone(),
            },
        }
    }
}

impl From<&CtrlBody> for FileCtrl {
    fn from(b: &CtrlBody) -> Self {
        match b {
            CtrlBody::Invite(m) => FileCtrl::Invite(m.clone()),
            CtrlBody::Accept {
                file_id,
                have,
                receiver_relay,
            } => FileCtrl::Accept {
                file_id: file_id.clone(),
                have: have.clone(),
                receiver_relay: receiver_relay.clone(),
            },
            CtrlBody::Reject { file_id, reason } => FileCtrl::Reject {
                file_id: file_id.clone(),
                reason: reason.clone(),
            },
            CtrlBody::Done { file_id, ok, reason } => FileCtrl::Done {
                file_id: file_id.clone(),
                ok: *ok,
                reason: reason.clone(),
            },
        }
    }
}

impl SignedCtrl {
    pub fn sign(key: &SecretKey, ctrl: &FileCtrl, ts: u64) -> Self {
        let from = key.public().to_string();
        let canon = ctrl.canonical(&from, ts);
        let sig = key.sign(canon.as_bytes());
        Self {
            from,
            ts,
            sig: hex_encode(sig.to_bytes()),
            body: ctrl.into(),
        }
    }

    /// 验签并还原。失败返回 None（调用方应丢弃）。
    pub fn verify(&self) -> Option<FileCtrl> {
        let pk = PublicKey::from_str(&self.from).ok()?;
        let raw = hex_decode(&self.sig).ok()?;
        let arr = <[u8; 64]>::try_from(raw.as_slice()).ok()?;
        let ctrl: FileCtrl = (&self.body).into();
        let canon = ctrl.canonical(&self.from, self.ts);
        if pk
            .verify(canon.as_bytes(), &Signature::from_bytes(&arr))
            .is_err()
        {
            return None;
        }
        Some(ctrl)
    }
}

// ---------------------------------------------------------------------------
// 位图（断点续传：记录哪些块已经有了）
// ---------------------------------------------------------------------------

/// 收到一块数据时的**准入判定**（纯逻辑，便于回归测试）。
///
/// 返回 `Err(原因)` = 必须拒收这一块。规则与理由：
///
/// 1. **序号越界** → 拒。越界序号会让写入方按 `seq * chunk_size` 定位到
///    目标文件之外的位置。
/// 2. **已经收到的块（位图已置位）= 重复块** → 拒。
///    ⚠️ 这一条必须发生在**写盘之前**：否则发送方可以在哈希校验完成之后
///    再补发一块内容不同的"同序号块"，把落盘内容改掉而哈希照样通过
///    （复检 P3-19：被校验的内容 ≠ 盘上的内容）。
/// 3. **整收时要求严格连续**（`seq == next_seq`）：数据面是单条顺序 QUIC 流、
///    发送方也是按 `need` 升序发，不连续说明流本身有问题；增量哈希也需要按序喂。
/// 4. ⚠️ **续传时绝不能要求连续**：续传本轮只发"缺哪些补哪些"
///    （`need = missing_chunks(have, n)`），第一个到来的块序号就是第一个缺失块
///    （比如 32），而 `next_seq` 是从 0 开始的。
///    这里曾经写成"无条件要求 `seq == next_seq`"，导致**浏览器端断点续传必然失败**
///    （第一块就报"块乱序：期望 seq=0，收到 32"）。
///    原生 `BytesSink` 没有顺序要求，所以这个缺陷只在浏览器路径上、单测看不出来 ——
///    这也是它必须有独立纯函数 + 回归测试的原因。
pub fn check_chunk_admission(
    seq: u32,
    total_chunks: usize,
    resumed_blocks: u32,
    next_seq: u32,
    already_have: bool,
) -> std::result::Result<(), String> {
    if seq as usize >= total_chunks {
        return Err(format!("块序号越界：seq={seq}，总块数={total_chunks}"));
    }
    if already_have {
        return Err(format!("重复块 seq={seq}（该块已收过，拒绝覆盖已校验内容）"));
    }
    if resumed_blocks == 0 && seq != next_seq {
        return Err(format!("块序号不连续：期望 seq={next_seq}，收到 {seq}"));
    }
    Ok(())
}

/// 一个文件有多少块。
pub fn chunk_count(size: u64, chunk_size: u32) -> usize {
    if chunk_size == 0 {
        return 0;
    }
    ((size + chunk_size as u64 - 1) / chunk_size as u64) as usize
}

/// 新建全 0 位图。
pub fn bitmap_new(n_chunks: usize) -> Vec<u8> {
    vec![0u8; (n_chunks + 7) / 8]
}

pub fn bitmap_get(bm: &[u8], i: usize) -> bool {
    bm.get(i / 8).map(|b| b & (1 << (i % 8)) != 0).unwrap_or(false)
}

pub fn bitmap_set(bm: &mut [u8], i: usize) {
    if let Some(b) = bm.get_mut(i / 8) {
        *b |= 1 << (i % 8);
    }
}

pub fn bitmap_count_set(bm: &[u8]) -> usize {
    bm.iter().map(|b| b.count_ones() as usize).sum()
}

pub fn bitmap_to_b64(bm: &[u8]) -> String {
    base64_encode(bm)
}

pub fn bitmap_from_b64(s: &str) -> Vec<u8> {
    base64_decode(s).unwrap_or_default()
}

/// 把位图补齐到 n_chunks 需要的长度（对端可能给的是旧长度）。
pub fn bitmap_resize(bm: &mut Vec<u8>, n_chunks: usize) {
    let need = (n_chunks + 7) / 8;
    if bm.len() < need {
        bm.resize(need, 0);
    }
}

// ---------------------------------------------------------------------------
// 数据面帧
// ---------------------------------------------------------------------------

/// 数据流头（发送方在流开头发给接收方）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHeader {
    pub file_id: String,
    pub name: String,
    pub size: u64,
    pub chunk_size: u32,
    pub root_hash: String,
    /// ⚠️ 必须带上 mime：少了它，接收方就少了一项能用来核对发送方的字段。
    /// 旧协议没这个字段，新旧**不兼容**（按约定直接清，不做兼容分支）。
    #[serde(default)]
    pub mime: String,
}

/// 核对数据流的 header 与**邀约元信息**是否一致。
///
/// 只在 `expect()` 之后、数据进上层之前调用。任何一项不符都拒收整条流 ——
/// 头部是发送方自报的内容，如果不核对，它就能报一个"我是另一个文件"，
/// 骗过按 file_id 派发的通道。
fn header_matches(h: &FileHeader, m: &FileMeta) -> Result<(), String> {
    if h.file_id != m.file_id {
        return Err(format!("file_id 不符：{} vs {}", h.file_id, m.file_id));
    }
    if h.size != m.size {
        return Err(format!("size 不符：{} vs {}", h.size, m.size));
    }
    if h.chunk_size != m.chunk_size {
        return Err(format!("chunk_size 不符：{} vs {}", h.chunk_size, m.chunk_size));
    }
    if h.name != m.name {
        return Err(format!("name 不符：{} vs {}", h.name, m.name));
    }
    if !h.mime.is_empty() && h.mime != m.mime {
        return Err(format!("mime 不符：{} vs {}", h.mime, m.mime));
    }
    // ⚠️ 根哈希必须一致 —— 接收端最终要靠它校验内容（见 JsChunkSink::finish）。
    //    这里先对一遍，是为了让"头里报 A 的哈希、实际发 B 的内容"在开头就被拒。
    if !h.root_hash.is_empty() && !m.root_hash.is_empty() && h.root_hash != m.root_hash {
        return Err("root_hash 不符".into());
    }
    Ok(())
}

/// 传输结束后接收方的回执（走同一条流）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileAck {
    pub ok: bool,
    pub reason: String,
}

/// 接收侧上层拿到的东西。
#[derive(Debug, Clone)]
pub enum FileChunk {
    /// 一块数据（seq 是块序号，从 0 开始）
    Data { seq: u32, bytes: Vec<u8> },
    /// 传输结束
    End { ok: bool, reason: String },
}

/// 发送侧上层能看到的事件。
#[derive(Debug, Clone)]
pub enum SendEvent {
    /// 接收方已连上并给了位图（可以算出需要补发哪些块）
    Started { need: Vec<u32> },
    /// 进度（done/total 块，bytes 已发字节）
    Progress { done: u64, total: u64, bytes: u64 },
    /// 全部发完
    Finished,
    /// 收到回执
    Ack { ok: bool, reason: String },
    Failed { reason: String },
}

// ---------------------------------------------------------------------------
// 接收侧：文件服务
// ---------------------------------------------------------------------------

/// 接收方的文件服务。
///
/// 它只做一件事：把进来的数据流按 `file_id` 派发给"上层预先登记好的通道"。
/// 上层（浏览器里是 JS）在发出 `Accept` **之前**调用 `expect()` 拿到接收端，
/// 这样数据到达时不会丢。
#[derive(Clone, Debug, Default)]
pub struct FileService {
    /// file_id → (块派发通道, 回执通道)
    ///
    /// 分成两个通道是因为**回执必须由上层产生**：只有上层知道
    /// 文件是否真的写盘成功、哈希是否对得上。服务层只管收发字节。
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    /// 在途的入站流数量（见 [`MAX_CONCURRENT_ACCEPTS`]）。
    inflight: Arc<std::sync::atomic::AtomicUsize>,
    /// 登记代次计数器（见 [`Pending::gen`]）。
    gen_counter: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Clone, Debug)]
pub struct Pending {
    pub chunks: Sender<FileChunk>,
    pub ack: Sender<FileAck>,
    /// `accept()` 用这个等上层校验结果
    pub ack_rx: Receiver<FileAck>,
    /// 被 [`FileService::cancel`] 置为 true 时，正在跑的读流循环应尽快退出。
    ///
    /// 用 `Arc<AtomicBool>` 而不是"靠 drop sender 让 send 失败"，
    /// 因为 `accept()` 里的 `tx` 是克隆出来的，摘表项管不着它。
    pub cancelled: Arc<std::sync::atomic::AtomicBool>,
    /// **我期待的发送方**（邀约里的 `FileMeta.sender`，且已核对等于签名者）。
    /// 实际连上来的 `connection.remote_id()` 必须等于它，否则整条流拒收。
    pub expect_sender: String,
    /// 邀约里的完整元信息 —— 用来核对 header 报的 size/name/chunk_size。
    pub meta: FileMeta,
    /// 登记代次。清理时用它确认"要摘掉的还是当初那一条"：
    /// 用户续传会在 `cancel` 之后重新 `expect` 一条新记录，
    /// 若旧数据流的清理守卫无条件按 file_id 删除，就会把**新的**那条误删，
    /// 于是续传的数据流到达时被判"接收方未准备好"（复检 P3-20）。
    pub gen: u64,
}

/// 在途 `Pending` 条目的清理守卫。
///
/// `Drop` 时把**自己那一条**（按 `gen` 比对）从表里摘掉 ——
/// 这样任何提前 `return`（身份不符、头部不符、越界块、长度不符、读失败、超时）
/// 都不会在表里留下一条"接收端已消失"的陈旧记录。
/// 旧实现只在**正常完成**那一处删除，其余 6 条退出路径全都漏了（复检 P3-20）。
struct PendingGuard {
    map: Arc<Mutex<HashMap<String, Pending>>>,
    file_id: String,
    gen: u64,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = self.map.lock() {
            // 只在"还是我这一代"时才删 —— 见 `Pending::gen` 的说明
            if m.get(&self.file_id).map(|p| p.gen) == Some(self.gen) {
                m.remove(&self.file_id);
            }
        }
    }
}

impl FileService {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一个待接收文件。
    ///
    /// 返回 `(块接收端, 回执发送端)`：
    /// - 块接收端交给 [`crate::transfer_orchestrator::receive_into_sink`] 消费
    /// - 校验完成后，用回执发送端告诉服务层"成功/失败"，它会转达给发送方
    ///
    /// **必须在广播 `Accept` 之前调用**，否则数据来了会被丢弃。
    ///
    /// ## `meta` 不是可选的 —— 它是**授权凭据**
    ///
    /// 登记时把邀约的完整元信息（含 `sender`）存下来，入站数据流逐项核对：
    ///
    /// 1. `connection.remote_id()` 必须等于 `meta.sender`
    /// 2. header 报的 `file_id` / `size` / `name` / `chunk_size` 必须与邀约一致
    /// 3. 块序号必须在 `[0, 总块数)` 内，且每块长度符合 `chunk_size`（末块除外）
    ///
    /// 只靠 `file_id` 路由是不够的 —— **file_id 在房间邀约里是公开广播的**，
    /// 任何知道它的人都能连上来往你的保存目标注入字节。
    pub fn expect(
        &self,
        file_id: &str,
        meta: FileMeta,
    ) -> Result<(Receiver<FileChunk>, Sender<FileAck>)> {
        // 登记前再校验一次元信息（真正的闸门在 `RoomNode::accept_file`，
        // 那里可以 `bail`；这里只留痕，便于排查"为什么数据流全被拒"）。
        if let Err(why) = validate_meta(&meta) {
            warn!("登记接收时元信息非法（{why}）file_id={file_id}");
        }
        {
            // 表大小上限：`file_id` 是广播的，数据流却是任何人可拨的，
            // 不设上限就等于让对端决定我们分配多少通道（F18）。
            let table = self.pending.lock().unwrap();
            if !table.contains_key(file_id) && table.len() >= MAX_PENDING_RECV {
                anyhow::bail!(
                    "待接收文件已达上限 {MAX_PENDING_RECV}，拒绝登记（先处理或取消已有的接收）"
                );
            }
        }
        let (chunk_tx, chunk_rx) = async_channel::bounded(64); // 有界：形成背压
        let (ack_tx, ack_rx) = async_channel::bounded(1);
        let gen = self
            .gen_counter
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        self.pending.lock().unwrap().insert(
            file_id.to_string(),
            Pending {
                chunks: chunk_tx,
                ack: ack_tx.clone(),
                ack_rx,
                cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                expect_sender: meta.sender.clone(),
                meta,
                gen,
            },
        );
        Ok((chunk_rx, ack_tx))
    }

    /// 在途入站流数量（诊断/测试用）。
    pub fn inflight(&self) -> usize {
        self.inflight.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 放弃接收（用户点了叉 / 超时）。
    ///
    /// 注意：这只是把条目从表里摘掉。如果此刻**正在有一条数据流在跑**
    /// （`accept()` 的读流循环），它的 `tx` 是我们克隆出来的一份 sender ——
    /// 摘掉表项**不会**让那份 sender 失效，循环仍会继续推块。
    /// 要真正中止在跑的接收，用 [`cancel`](Self::cancel)。
    pub fn forget(&self, file_id: &str) {
        self.pending.lock().unwrap().remove(file_id);
    }

    /// **真正取消**一个正在进行的接收。
    ///
    /// 和 `forget` 的区别：`forget` 只摘表项，而本函数通过
    /// [`Pending::cancelled`] 标志让**正在跑的读流循环主动退出**。
    ///
    /// 为什么需要：切到后台时我们要暂停接收（已收的块落盘 + 存位图），
    /// 回到前台再由用户/自动流程重新 `expect()` 一个新条目。
    /// 如果旧循环没退出，就会出现**两条链路并行往同一个文件写** ——
    /// 实测表现为"已收块数超过总块数"（8MB 收成 1024/512），文件被写坏。
    ///
    /// 实现要点：**不能只靠 drop sender**。`accept()` 里的 `tx` 是克隆出来的，
    /// 摘表项不影响它。所以用一个共享的原子标志，循环每块检查一次。
    pub fn cancel(&self, file_id: &str) {
        let removed = self.pending.lock().unwrap().remove(file_id);
        if let Some(p) = removed {
            p.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
            debug!("已请求取消接收 file_id={file_id}");
        }
    }

    fn take(&self, file_id: &str) -> Option<Pending> {
        self.pending.lock().unwrap().get(file_id).cloned()
    }
}

/// 拒绝一条文件流，并把原因**确实送达**对端。
///
/// ## 为什么不能只 `write_json_frame` + `return`
///
/// 写完就走的话，`send` / `recv` 两个流随函数返回一起 drop，
/// QUIC 连接被带走 —— 对端只看到 `connection lost`，
/// **根本读不到那条回执**（实测：冒充者拿到的错误就是 "connection lost"）。
/// 对端于是无从知道"我是被拒了"还是"网络抖了"，只能盲猜重试。
///
/// 所以这里写完回执后**等对端把接收方向关掉**（它读完就会关），
/// 再返回。等待设上限，避免对端故意拖着不关。
async fn deny(
    send: &mut iroh::endpoint::SendStream,
    recv: &mut iroh::endpoint::RecvStream,
    reason: &str,
) {
    let _ = write_json_frame(
        send,
        FRAME_DONE,
        &FileAck {
            ok: false,
            reason: reason.to_string(),
        },
    )
    .await;
    // 把发送方向正常收尾（对端读到 EOF 就知道没有后续了）
    let _ = send.finish();
    // 给对端一点时间读完；最多等 2 秒，不阻塞其他连接
    let _ = n0_future::time::timeout(n0_future::time::Duration::from_secs(2), async {
        let mut buf = [0u8; 64];
        while let Ok(Some(_)) = recv.read(&mut buf).await {}
    })
    .await;
}

impl ProtocolHandler for FileService {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        // ═══════════════════════════════════════════════════════════════
        // 并发闸门（关键）：**在读任何字节之前**就限流。
        //
        // 这一段是**预鉴权**的：此时我们还不知道对面是谁、要什么文件。
        // 所以"连上、什么都不发"是最廉价的占位手段 —— 而 iroh 强制 keep-alive，
        // 空闲超时不会替我们回收连接。没有这道闸，任何人靠一堆空连接
        // 就能把任务/socket 堆到内存耗尽（F18）。
        //
        // 超限直接关闭连接，**一个字节都不读**。
        // ═══════════════════════════════════════════════════════════════
        let n = self
            .inflight
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        if n > MAX_CONCURRENT_ACCEPTS {
            self.inflight
                .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            warn!("入站文件流并发超限（{n} > {MAX_CONCURRENT_ACCEPTS}），直接关闭该连接");
            connection.close(1u8.into(), b"busy");
            return Ok(());
        }
        // 守卫：无论从哪条路径返回（含 `?`、deny、超时），都会把计数减回去
        let _inflight_guard = InflightGuard(self.inflight.clone());

        // 发送方拨号过来，开一条双向流
        //
        // ⚠️ 也要有超时：对端可以连上却一直不开流。
        let (mut send, mut recv) =
            match n0_future::time::timeout(HEADER_TIMEOUT, connection.accept_bi()).await {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => {
                    return Err(AcceptError::from_err(std::io::Error::other(e.to_string())))
                }
                Err(_) => {
                    debug!("等对方开流超时（{}s），关闭连接", HEADER_TIMEOUT.as_secs());
                    connection.close(2u8.into(), b"idle");
                    return Ok(());
                }
            };

        // 第一帧：header
        //
        // ⚠️ 必须有超时：否则"连上 + 发 0~4 字节 + 不发"就能永久钉住本任务（F18）。
        let header = match n0_future::time::timeout(
            HEADER_TIMEOUT,
            read_json_frame::<FileHeader>(&mut recv, FRAME_HEADER),
        )
        .await
        {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => {
                warn!("文件流头部解析失败: {e:#}");
                return Ok(());
            }
            Err(_) => {
                warn!(
                    "读文件流头部超时（{}s，对端发得又慢又少），关闭连接",
                    HEADER_TIMEOUT.as_secs()
                );
                connection.close(2u8.into(), b"idle");
                return Ok(());
            }
        };
        debug!(
            "收到文件流 file_id={} name={} size={}",
            header.file_id, header.name, header.size
        );

        let Some(pending) = self.take(&header.file_id) else {
            // 上层没有登记（可能已取消），礼貌拒绝
            deny(&mut send, &mut recv, "接收方未准备好").await;
            return Ok(());
        };

        // ═══════════════════════════════════════════════════════════════
        // 授权校验（关键）：**file_id 不是授权凭据**
        //
        // file_id 随房间邀约**公开广播**，任何在场的人都知道。
        // 只按 file_id 派发的话，他们就能连上我的 QUIC 流，往我已选好的
        // 保存目标里注入字节（旧实现就是这样，报告 P1-3 已实测复现）。
        //
        // 所以这里逐项核对"连上来的到底是不是我等的那个人、送的到底是不是
        // 我答应的那个文件"：
        //   1. 连接的真实对端 == 邀约里的 sender（且 sender 已核对等于签名者）
        //   2. header 的 file_id / size / name / chunk_size 与邀约一致
        // ═══════════════════════════════════════════════════════════════
        // ⚠️ 从这里开始，无论走哪条路径退出，都要把自己这条登记摘掉（复检 P3-20）。
        //    旧实现只在"正常收完"那一处 remove，其余 6 条退出路径全都漏了 ——
        //    于是表里会留一条"接收端已消失"的陈旧记录：发送方重试同一 file_id 时
        //    会命中它，`tx.send` 失败 → 卡在等回执处最长 600 秒。
        let _pending_guard = PendingGuard {
            map: self.pending.clone(),
            file_id: header.file_id.clone(),
            gen: pending.gen,
        };

        let remote = connection.remote_id();
        // ⚠️ **失败关闭**：期望发送方为空 = 这条登记没有授权信息，
        //    一律拒绝（复检 P3-21）。旧写法是 `!empty && 不等` ——
        //    空值直接**跳过**身份校验，等于把授权关掉了。
        //    `validate_meta` 现在也要求 sender 非空，这里是授权表这一侧的兜底。
        if pending.expect_sender.is_empty() || remote.to_string() != pending.expect_sender {
            warn!(
                "拒绝文件流：连接对端 {remote} 不是期望的发送方 {:?}（file_id={}）",
                pending.expect_sender, header.file_id
            );
            deny(&mut send, &mut recv, "发送方身份不匹配，已拒绝").await;
            return Ok(());
        }

        if let Err(why) = header_matches(&header, &pending.meta) {
            warn!(
                "拒绝文件流：头部与邀约不符（{why}）file_id={} 发送方={remote}",
                header.file_id
            );
            deny(&mut send, &mut recv, "文件信息与邀约不符，已拒绝").await;
            return Ok(());
        }

        let tx = pending.chunks.clone();
        let cancelled = pending.cancelled.clone();
        // 块数与块大小来自**已核对的元信息**，用于逐块校验
        let total_chunks = chunk_count(pending.meta.size, pending.meta.chunk_size) as u32;
        let chunk_size = pending.meta.chunk_size as usize;

        // 逐块转发给上层
        loop {
            // ⚠️ 每块检查一次"是否被取消"。
            //    没有这一步，`cancel()` 摘掉表项也拦不住这个循环 ——
            //    它的 tx 是克隆出来的，仍会继续推块，
            //    于是新一轮接收会和它并行写同一个文件（实测把文件写坏）。
            if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                debug!("接收已被取消，读流循环退出 file_id={}", header.file_id);
                // 不往上层发 End（那会被当成"正常收完"）——
                // 让上层的通道自然关闭即可，它会走 abort 分支保留已收内容。
                return Ok(());
            }
            match n0_future::time::timeout(FRAME_IDLE_TIMEOUT, read_frame(&mut recv)).await {
                // 读超时：对端发了头就停住不发数据（或中途僵死）。
                // 必须主动结束，否则这条连接会一直挂着（F18）。
                Err(_) => {
                    let reason = format!(
                        "接收停顿超过 {}s，已中断",
                        FRAME_IDLE_TIMEOUT.as_secs()
                    );
                    warn!("{reason} file_id={}", header.file_id);
                    let _ = tx
                        .send(FileChunk::End {
                            ok: false,
                            reason: reason.clone(),
                        })
                        .await;
                    let _ = tx.close();
                    return Ok(());
                }
                Ok(Ok(Some((kind, payload)))) => {
                    if kind == FRAME_CHUNK {
                        if payload.len() < 4 {
                            continue;
                        }
                        let seq = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
                        // ⚠️ 块序号与块长度都必须核对。
                        //    越界的 seq 会让上层按 `seq * chunk_size` 定位写盘，
                        //    等于往目标文件的**任意偏移**写数据（报告 P1-3 实测过
                        //    序号 900000 原样进到上层）。长度不对则会在最后一块
                        //    之后越界，或让哈希校验拿不到正确内容。
                        if seq >= total_chunks {
                            warn!("拒绝越界块序号 seq={seq}（总块数 {total_chunks}）");
                            let _ = tx
                                .send(FileChunk::End {
                                    ok: false,
                                    reason: format!("块序号越界：{seq} ≥ {total_chunks}"),
                                })
                                .await;
                            let _ = write_json_frame(
                                &mut send,
                                FRAME_DONE,
                                &FileAck { ok: false, reason: "块序号越界".into() },
                            )
                            .await;
                            let _ = send.finish();
                            return Ok(());
                        }
                        let is_last = seq + 1 == total_chunks;
                        let expect_len = if is_last {
                            let rem = pending.meta.size as usize % chunk_size;
                            if rem == 0 { chunk_size } else { rem }
                        } else {
                            chunk_size
                        };
                        if payload.len() - 4 != expect_len {
                            warn!(
                                "拒绝长度不符的块 seq={seq}：期望 {expect_len}，实际 {}",
                                payload.len() - 4
                            );
                            let _ = tx
                                .send(FileChunk::End {
                                    ok: false,
                                    reason: format!(
                                        "第 {seq} 块长度不符：期望 {expect_len}，实际 {}",
                                        payload.len() - 4
                                    ),
                                })
                                .await;
                            let _ = write_json_frame(
                                &mut send,
                                FRAME_DONE,
                                &FileAck { ok: false, reason: "块长度不符".into() },
                            )
                            .await;
                            let _ = send.finish();
                            return Ok(());
                        }
                        let bytes = payload[4..].to_vec();
                        if tx.send(FileChunk::Data { seq, bytes }).await.is_err() {
                            // 上层不收了（可能用户取消）
                            break;
                        }
                    } else {
                        debug!("文件流里出现未知帧 kind={kind}，忽略");
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(e)) => {
                    let reason = format!("读取失败: {e:#}");
                    let _ = tx.send(FileChunk::End { ok: false, reason }).await;
                    return Ok(());
                }
            }
        }

        // 全部收完（流被对端 finish）：通知上层，然后**等它校验完**再回执。
        // 只有上层知道文件是否真的写盘成功、哈希对不对 —— 服务层不能替它下结论。
        let _ = tx.send(FileChunk::End { ok: true, reason: String::new() }).await;

        let ack = match n0_future::time::timeout(
            std::time::Duration::from_secs(600), // 大文件校验可能耗时（10GB 算 blake3）
            pending.ack_rx.recv(),
        )
        .await
        {
            Ok(Ok(a)) => a,
            _ => FileAck {
                ok: false,
                reason: "上层未在时限内确认".into(),
            },
        };

        let _ = write_json_frame(&mut send, FRAME_DONE, &ack).await;
        let _ = send.finish();
        connection.closed().await;
        // 表项由 `_pending_guard` 在函数返回时摘掉（按代次比对，
        // 不会误删用户续传时新建的那一条）
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 帧读写
// ---------------------------------------------------------------------------

pub async fn write_frame(send: &mut iroh::endpoint::SendStream, kind: u8, payload: &[u8]) -> Result<()> {
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.push(kind);
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(payload);
    send.write_all(&buf).await.context("写帧失败")?;
    Ok(())
}

pub async fn write_json_frame<T: Serialize>(
    send: &mut iroh::endpoint::SendStream,
    kind: u8,
    value: &T,
) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    write_frame(send, kind, &body).await
}

/// 读一帧；流正常结束返回 `Ok(None)`。
pub async fn read_frame(recv: &mut iroh::endpoint::RecvStream) -> Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    let mut filled = 0;
    while filled < 5 {
        match recv.read(&mut head[filled..]).await? {
            Some(0) | None => {
                return if filled == 0 { Ok(None) } else { anyhow::bail!("帧头被截断") }
            }
            Some(n) => filled += n,
        }
    }
    let kind = head[0];
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        anyhow::bail!("帧超过上限: {len} > {MAX_FRAME}");
    }
    let mut payload = vec![0u8; len];
    let mut got = 0;
    while got < len {
        match recv.read(&mut payload[got..]).await? {
            Some(0) | None => anyhow::bail!("帧体被截断"),
            Some(n) => got += n,
        }
    }
    Ok(Some((kind, payload)))
}

pub async fn read_json_frame<T: for<'de> Deserialize<'de>>(
    recv: &mut iroh::endpoint::RecvStream,
    expect_kind: u8,
) -> Result<T> {
    let (kind, payload) = read_frame(recv)
        .await?
        .context("流在读到期望的帧之前就结束了")?;
    if kind != expect_kind {
        anyhow::bail!("帧类型不符：期望 {expect_kind}，实际 {kind}");
    }
    Ok(serde_json::from_slice(&payload)?)
}

// ---------------------------------------------------------------------------
// base64 / hex（不引额外依赖，自己写最小实现）
// ---------------------------------------------------------------------------

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn base64_decode(s: &str) -> Result<Vec<u8>> {
    let mut rev = [255u8; 256];
    for (i, &c) in B64.iter().enumerate() {
        rev[c as usize] = i as u8;
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| *b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for c in bytes.chunks(4) {
        let mut n = 0u32;
        for i in 0..4 {
            let v = *c.get(i).map(|b| &rev[*b as usize]).unwrap_or(&0);
            if v == 255 {
                anyhow::bail!("base64 含非法字符");
            }
            n = (n << 6) | v as u32;
        }
        let take = c.len() - 1;
        out.push((n >> 16) as u8);
        if take >= 2 {
            out.push((n >> 8) as u8);
        }
        if take >= 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

const HEX: &[u8] = b"0123456789abcdef";

pub fn hex_encode(data: impl AsRef<[u8]>) -> String {
    let d = data.as_ref();
    let mut s = String::with_capacity(d.len() * 2);
    for b in d {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

pub fn hex_decode(s: &str) -> Result<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        anyhow::bail!("hex 长度必须是偶数");
    }
    let mut out = Vec::with_capacity(b.len() / 2);
    for pair in b.chunks(2) {
        let hi = (pair[0] as char).to_digit(16).context("hex 非法")?;
        let lo = (pair[1] as char).to_digit(16).context("hex 非法")?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

/// 生成一个随机的 file_id（16 hex 字符）。
///
/// ⚠️ **不能依赖 `std::process::id()`**（wasm 下 panic：`no pids on this platform`），
/// 也不能依赖 `std::time`（wasm 下 panic：`time not implemented`）。
/// 这里只用 **time（分平台取）+ 一段自增计数 + 内存地址**，够用且绝对安全。
pub fn new_file_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = format!(
        "{}-{}-{}",
        crate::room::now_ms(),
        n,
        &COUNTER as *const _ as usize
    );
    let h = blake3::hash(seed.as_bytes());
    hex_encode(&h.as_bytes()[..8])
}

/// 计算一块数据的哈希（用于分块校验；整文件哈希由上层算）。
pub fn chunk_hash(bytes: &[u8]) -> String {
    hex_encode(&blake3::hash(bytes).as_bytes()[..8])
}

/// 增量计算整文件 blake3（大文件不能一次性读进内存）。
///
/// 用法：`let mut h = Hasher::new(); h.update(chunk); ... h.finish()`
/// 这样算 10GB 文件的哈希，内存占用与块大小同量级。
#[derive(Clone, Debug)]
pub struct Hasher {
    inner: blake3::Hasher,
}

impl Hasher {
    pub fn new() -> Self {
        Self {
            inner: blake3::Hasher::new(),
        }
    }
    pub fn update(&mut self, bytes: &[u8]) {
        self.inner.update(bytes);
    }
    /// 返回完整哈希（64 hex），与 `meta.root_hash` 直接可比。
    pub fn finish(&self) -> String {
        hex_encode(self.inner.finalize().as_bytes())
    }
}

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}

/// 便捷：某文件第 i 块的字节范围。
pub fn chunk_range(i: usize, chunk_size: u32, total: u64) -> (u64, u64) {
    let start = i as u64 * chunk_size as u64;
    let end = ((i + 1) as u64 * chunk_size as u64).min(total);
    (start, end)
}

/// 从位图算出需要补发的块序号。
pub fn missing_chunks(have: &[u8], n_chunks: usize) -> Vec<u32> {
    (0..n_chunks as u32)
        .filter(|i| !bitmap_get(have, *i as usize))
        .collect()
}

/// 给上层用的描述性字符串（日志/UI 里显示传输进度）。
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

/// 供日志用：把 EndpointId 缩短。
pub fn short(id: &EndpointId) -> String {
    let s = id.to_string();
    s.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitmap_roundtrip() {
        let mut bm = bitmap_new(20);
        bitmap_set(&mut bm, 0);
        bitmap_set(&mut bm, 7);
        bitmap_set(&mut bm, 19);
        assert!(bitmap_get(&bm, 0));
        assert!(bitmap_get(&bm, 7));
        assert!(bitmap_get(&bm, 19));
        assert!(!bitmap_get(&bm, 1));
        assert_eq!(bitmap_count_set(&bm), 3);
        assert_eq!(missing_chunks(&bm, 20).len(), 17);
    }

    #[test]
    fn b64_roundtrip() {
        for n in [0usize, 1, 2, 3, 16, 100] {
            let data: Vec<u8> = (0..n).map(|i| (i * 7 % 251) as u8).collect();
            assert_eq!(base64_decode(&base64_encode(&data)).unwrap(), data);
        }
    }

    #[test]
    fn chunks_math() {
        assert_eq!(chunk_count(0, 16), 0);
        assert_eq!(chunk_count(1, 16), 1);
        assert_eq!(chunk_count(16, 16), 1);
        assert_eq!(chunk_count(17, 16), 2);
        assert_eq!(chunk_range(0, 16, 20), (0, 16));
        assert_eq!(chunk_range(1, 16, 20), (16, 20));
    }

    #[test]
    fn human() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(2048), "2.0 KB");
        assert_eq!(human_size(10 * 1024 * 1024 * 1024), "10.0 GB");
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;

    fn meta() -> FileMeta {
        FileMeta {
            file_id: "abc123".into(),
            name: "doc.pdf".into(),
            size: 1000,
            mime: "application/pdf".into(),
            chunk_size: 100,
            root_hash: "deadbeef".into(),
            sender: "发送方EndpointId".into(),
            sender_relay: "https://relay/".into(),
            ts: 1,
        }
    }

    fn header() -> FileHeader {
        let m = meta();
        FileHeader {
            file_id: m.file_id.clone(),
            name: m.name.clone(),
            size: m.size,
            chunk_size: m.chunk_size,
            root_hash: m.root_hash.clone(),
            mime: m.mime.clone(),
        }
    }

    // ── P1-3：头部必须与邀约逐项一致 ────────────────────────────────
    #[test]
    fn 头部与邀约一致时通过() {
        assert!(header_matches(&header(), &meta()).is_ok());
    }

    #[test]
    fn 头部文件id不符被拒() {
        let mut h = header();
        h.file_id = "other".into();
        assert!(header_matches(&h, &meta()).is_err());
    }

    #[test]
    fn 头部大小不符被拒() {
        let mut h = header();
        h.size = 999_999;
        assert!(header_matches(&h, &meta()).is_err());
    }

    #[test]
    fn 头部块大小不符被拒() {
        let mut h = header();
        h.chunk_size = 4096;
        assert!(header_matches(&h, &meta()).is_err());
    }

    #[test]
    fn 头部文件名不符被拒() {
        let mut h = header();
        h.name = "other.pdf".into();
        assert!(header_matches(&h, &meta()).is_err());
    }

    #[test]
    fn 头部根哈希不符被拒() {
        let mut h = header();
        h.root_hash = "00000000".into();
        assert!(header_matches(&h, &meta()).is_err());
    }

    #[test]
    fn 头部mime不符被拒() {
        let mut h = header();
        h.mime = "text/html".into();
        assert!(header_matches(&h, &meta()).is_err());
    }

    // ── P1-3：块数计算（越界判断的依据）───────────────────────────
    #[test]
    fn 块数按上取整计算() {
        assert_eq!(chunk_count(1000, 100), 10);
        assert_eq!(chunk_count(1001, 100), 11);
        assert_eq!(chunk_count(0, 100), 0);
        // 除零保护
        assert_eq!(chunk_count(100, 0), 0);
    }

    // ── P1-3：Invite 的 sender 必须进签名 ──────────────────────────
    #[test]
    fn 改sender不影响验签说明它没进签名_已修复则应失败() {
        let k = SecretKey::from_bytes(&[9u8; 32]);
        let mut m = meta();
        m.sender = k.public().to_string();
        let signed = SignedCtrl::sign(&k, &FileCtrl::Invite(m.clone()), 100);
        assert!(signed.verify().is_some());

        // 改 sender 后必须验不过（sender 已进签名载荷）
        let mut body = signed.clone();
        if let crate::filetransfer::CtrlBody::Invite(ref mut im) = body.body {
            im.sender = "别人的EndpointId".into();
        }
        assert!(body.verify().is_none(), "改 sender 竟然还能验签通过");
    }

    #[test]
    fn 文件名含分隔符不产生歧义() {
        let k = SecretKey::from_bytes(&[11u8; 32]);
        let mut m = meta();
        m.name = "a|b.pdf".into();
        let signed = SignedCtrl::sign(&k, &FileCtrl::Invite(m), 100);
        assert!(signed.verify().is_some());
    }

    // ── F17：邀约元信息必须逐项校验（失败关闭）────────────────────
    //
    // 这些字段全部来自对端。放行任何一个，接收端就可能陷入
    // "无法校验的内容"或"按 40 亿块分配内存"的境地。
    fn good_meta() -> FileMeta {
        FileMeta {
            file_id: "0123456789abcdef".into(),
            name: "doc.pdf".into(),
            size: 1000,
            mime: "application/pdf".into(),
            chunk_size: CHUNK_SIZE,
            root_hash: "ab".repeat(32), // 64 位 hex
            sender: "sender-id".into(),
            sender_relay: "https://relay/".into(),
            ts: 1,
        }
    }

    #[test]
    fn 合法元信息通过校验() {
        assert!(validate_meta(&good_meta()).is_ok());
        // 空文件（0 块）也应合法：它的整文件哈希就是空串的 blake3
        let mut m = good_meta();
        m.size = 0;
        assert!(validate_meta(&m).is_ok());
    }

    #[test]
    fn 空或非法_root_hash_被拒() {
        // 空哈希 = 放弃内容校验（F17 的原始缺陷）
        let mut m = good_meta();
        m.root_hash = String::new();
        assert!(validate_meta(&m).is_err(), "空 root_hash 必须被拒");

        let mut m = good_meta();
        m.root_hash = "abc".into();
        assert!(validate_meta(&m).is_err(), "长度不对的 root_hash 必须被拒");

        let mut m = good_meta();
        m.root_hash = "z".repeat(64);
        assert!(validate_meta(&m).is_err(), "非 hex 的 root_hash 必须被拒");
    }

    #[test]
    fn 非约定块大小被拒() {
        let mut m = good_meta();
        m.chunk_size = 1; // 会同时让块数与写盘偏移失去共同基准
        assert!(validate_meta(&m).is_err());
        let mut m = good_meta();
        m.chunk_size = 0;
        assert!(validate_meta(&m).is_err());
    }

    #[test]
    fn 超大块数被拒() {
        let mut m = good_meta();
        // 4GiB / 16KiB = 262144 块，合法；这里直接构造超过上限的规模
        m.size = (MAX_CHUNKS as u64 + 1) * CHUNK_SIZE as u64;
        assert!(validate_meta(&m).is_err(), "超过 MAX_CHUNKS 必须被拒");
    }

    #[test]
    fn file_id_不能是任意字符串() {
        // 它会被用作 map/IndexedDB 键，以及前端 CSS 选择器的一部分
        for bad in ["", "a\"]", "with space", "中文", &"x".repeat(65)] {
            let mut m = good_meta();
            m.file_id = bad.to_string();
            assert!(validate_meta(&m).is_err(), "file_id={bad:?} 应被拒");
        }
    }

    #[test]
    fn 文件名过长或含控制字符被拒() {
        let mut m = good_meta();
        m.name = "x".repeat(MAX_NAME_LEN + 1);
        assert!(validate_meta(&m).is_err());
        let mut m = good_meta();
        m.name = "a\u{0}b".into();
        assert!(validate_meta(&m).is_err());
        let mut m = good_meta();
        m.name = String::new();
        assert!(validate_meta(&m).is_err());
    }

    #[test]
    fn sender_为空被拒() {
        // 授权完全建立在 expect_sender 上，空值等于关闭鉴权
        let mut m = good_meta();
        m.sender = String::new();
        assert!(validate_meta(&m).is_err());
    }

    // ── F18：待接收表必须有上限，且"已存在的 id 可以重新登记" ────────
    #[test]
    fn 待接收表有上限且允许重复登记同一条() {
        let svc = FileService::new();
        assert_eq!(svc.inflight(), 0);

        let mut ids = Vec::new();
        for i in 0..MAX_PENDING_RECV {
            let mut m = good_meta();
            m.file_id = format!("f{i:016x}");
            let id = m.file_id.clone();
            assert!(svc.expect(&id, m).is_ok(), "第 {i} 条应当登记成功");
            ids.push(id);
        }

        // 已存在同一个 file_id：**允许**（这正是"暂停后继续接收"的路径），
        // 不能因为表满就把用户自己的续传挡掉。
        let mut again = good_meta();
        again.file_id = ids[0].clone();
        assert!(
            svc.expect(&ids[0], again).is_ok(),
            "同一个 file_id 重新登记应当被允许"
        );

        // 新的 file_id：必须被拒（否则这张表可以被对端无限撑大）
        let mut extra = good_meta();
        extra.file_id = "ffffffffffffffff".into();
        assert!(
            svc.expect("ffffffffffffffff", extra).is_err(),
            "超过 MAX_PENDING_RECV 必须拒绝登记"
        );
    }

    // ── F18：并发计数守卫在正常路径上必须归零（不漏记）────────────
    #[test]
    fn 在途计数初始为零() {
        let svc = FileService::new();
        assert_eq!(svc.inflight(), 0, "新建的 FileService 不应有在途流");
        // 计数是 Arc 共享的：clone 出去看到的必须是同一个数
        let c = svc.clone();
        assert_eq!(c.inflight(), 0);
    }
    // ── 收块准入：续传必须能跳跃，重复块必须在写盘前被拒 ─────────────
    //
    // 这一组对应一个**只在浏览器路径上出现**的真实回归：把"增量哈希必须按序"
    // 和"块序号必须连续"混成一件事之后，续传时本轮第一个块（例如 seq=32）
    // 会被判成"块乱序：期望 seq=0"，于是断点续传**必然失败**。
    // 原生 BytesSink 没有顺序要求，所以单测当时看不出来。
    #[test]
    fn 续传时块序号允许跳跃() {
        // 已拥有前 32 块，本轮第一个到达的就是 32
        assert!(
            check_chunk_admission(32, 64, 32, 0, false).is_ok(),
            "续传本轮只补缺失块，序号天然跳跃，不能要求连续"
        );
        // 最后一块
        assert!(check_chunk_admission(63, 64, 32, 31, false).is_ok());
    }

    #[test]
    fn 整收时块序号必须连续() {
        assert!(check_chunk_admission(0, 8, 0, 0, false).is_ok());
        assert!(check_chunk_admission(1, 8, 0, 1, false).is_ok());
        assert!(
            check_chunk_admission(3, 8, 0, 1, false).is_err(),
            "整收时跳跃说明流本身有问题，必须拒"
        );
    }

    #[test]
    fn 重复块在写盘前就被拒() {
        // 两条路径都要拒：整收里重发，和续传里补发已拥有的块
        assert!(check_chunk_admission(0, 8, 0, 1, true).is_err());
        assert!(check_chunk_admission(5, 8, 4, 0, true).is_err());
    }

    #[test]
    fn 越界块序号被拒() {
        assert!(check_chunk_admission(8, 8, 0, 0, false).is_err());
        assert!(check_chunk_admission(0, 0, 0, 0, false).is_err());
    }
}
