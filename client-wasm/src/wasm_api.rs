//! wasm 包装层：把 `node::WebNode`（点对点诊断）与 `room::RoomNode`（群聊）暴露给浏览器 JS。
//!
//! 官方不提供 npm 包，所以浏览器构建必须自己写这个 wrapper。

use async_channel::Receiver;
use serde::Serialize;
use wasm_bindgen::{prelude::wasm_bindgen, JsError};
use wasm_streams::{readable::sys::ReadableStream as JsReadableStream, ReadableStream};

use crate::node::{NodeOptions, WebNode as ProbeInner};
use crate::room::{RoomNode as RoomInner, RoomOptions};

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    // 日志级别默认 INFO。
    //
    // 为什么不是 DEBUG：wasm 里每次 `console.log` 都是同步的 JS 调用，
    // 传输时「每块一条进度日志」会直接把吞吐拖垮（实测 1MB 要十几秒）。
    // 需要排查时在 URL 上加 `?debug=1` 即可恢复 DEBUG。
    let want_debug = js_sys::Reflect::get(&js_sys::global(), &"location".into())
        .ok()
        .and_then(|l| js_sys::Reflect::get(&l, &"search".into()).ok())
        .and_then(|s| s.as_string())
        .map(|s| s.contains("debug=1"))
        .unwrap_or(false);
    let level = if want_debug {
        tracing::level_filters::LevelFilter::DEBUG
    } else {
        tracing::level_filters::LevelFilter::INFO
    };
    tracing_subscriber::fmt()
        .with_max_level(level)
        .with_writer(
            tracing_subscriber_wasm::MakeConsoleWriter::default()
                .map_trace_level_to(tracing::Level::DEBUG),
        )
        .without_time()
        .with_ansi(false)
        .init();
    tracing::info!("iroh-web ready (relay-only browser node)");
}

// ---------------------------------------------------------------------------
// 群聊节点
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct RoomNode {
    inner: RoomInner,
}

#[wasm_bindgen]
impl RoomNode {
    /// 启动。
    /// `opts_json` = `{"relays":[...],"secret_key_hex":"...","anchor_id":"...","anchor_relay":"..."}`
    pub async fn start(opts_json: String) -> Result<RoomNode, JsError> {
        let opts: RoomOptions = serde_json::from_str(&opts_json)
            .map_err(|e| JsError::new(&format!("配置解析失败: {e}")))?;
        let inner = RoomInner::start(opts).await.map_err(to_js_err)?;
        Ok(RoomNode { inner })
    }

    /// 本节点 ID（hex）。
    pub fn endpoint_id(&self) -> String {
        self.inner.endpoint_id()
    }

    /// 等待至少一台中继握手完成（JS 侧自行 race 超时）。
    pub async fn online(&self) {
        self.inner.online().await
    }

    /// 当前中继状态快照（JSON 字符串）。
    pub fn relay_status_json(&self) -> String {
        serde_json::to_string(&self.inner.relay_status()).unwrap_or_else(|_| "[]".into())
    }

    /// 事件流：joined / message / presence / peerUp / peerDown / history / relayStatus / error
    pub fn events(&self) -> Result<JsReadableStream, JsError> {
        Ok(into_js_readable_stream(self.inner.subscribe()))
    }

    /// 进房间（同名即同房间）。
    pub async fn join(&self, room: String, nickname: String) -> Result<(), JsError> {
        self.inner.join(&room, &nickname).await.map_err(to_js_err)
    }

    /// 在房间里发言（自动签名）。
    /// 返回**整条消息的 JSON**（含 id / ts / sig），让前端可以立刻乐观渲染，
    /// 之后 gossip 回环回来的同一条消息按 id 去重即可。
    pub async fn send(&self, text: String) -> Result<String, JsError> {
        let m = self.inner.send(&text).await.map_err(to_js_err)?;
        serde_json::to_string(&m).map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn set_nickname(&self, name: String) {
        self.inner.set_nickname(&name);
    }

    /// **离开当前房间**（切到别的房间时调用）。
    ///
    /// ⚠️ 必须在"进入新房间之前"调用：它会在退订**之前**广播一条离开声明，
    /// 让房间里的人立刻把本端从成员表摘掉（文件也随之变过期），
    /// 而不是等 25~45 秒的心跳超时。这是唯一一个"离开声明"能可靠发出的时机。
    pub async fn leave_room(&self) {
        self.inner.leave_room().await;
    }

    /// 同步"我此刻还能发出的文件"清单（真身在 Worker 的 outFiles 里）。
    ///
    /// 传完整列表（幂等）。清单变化会立刻触发一次心跳广播，
    /// 让房间里的人马上看到"他又能发这个文件了"/"这个文件没了"。
    pub fn set_available_files(&self, ids: Vec<String>) {
        self.inner.set_available_files(ids);
    }

    /// 广播一条**可用性质询**：我点了某张卡但联系不上发送方，公开问一句。
    /// 若发送方还持有该文件，他会重播心跳来认领；沉默即视为过期。
    ///
    /// `room`：**必填** —— 质询只对"邀约所在的那个房间"有意义（F7）。
    pub async fn query_file(
        &self,
        file_id: String,
        want: String,
        room: String,
    ) -> Result<(), JsError> {
        self.inner
            .query_file(&file_id, &want, &room)
            .await
            .map_err(to_js_err)
    }

    // ---------------- 文件传输 ----------------

    /// 发起文件邀约。
    ///
    /// `meta_json` 由 [`RoomNode::file_meta`] 生成（它已经算好根哈希）。
    /// 这一步只广播元信息，**不传内容**；对方接受后才会真正开始传。
    /// `room` 是**发起时意图的房间**；与当前房间不一致时**拒绝发送**（报告 P1-7）。
    /// 上层算哈希要读整个文件，这期间用户可能已切房间。
    pub async fn invite_file(&self, meta_json: String, room: String) -> Result<(), JsError> {
        let meta: crate::filetransfer::FileMeta =
            serde_json::from_str(&meta_json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner
            .invite_file(&meta, &room)
            .await
            .map_err(to_js_err)
    }

    /// 生成文件元信息（含增量算出的根哈希）。
    ///
    /// `hasher` 由 JS 分块喂完数据后传入它的 `finish()` 结果——
    /// 这样 10GB 文件的哈希也不需要把文件读进内存。
    pub fn file_meta(
        &self,
        name: String,
        size: f64,
        mime: String,
        root_hash: String,
    ) -> Result<String, JsError> {
        let relay = self
            .inner
            .my_relay_url()
            .ok_or_else(|| JsError::new("本端还没有可用中继地址"))?;
        let meta = crate::filetransfer::FileMeta {
            file_id: crate::filetransfer::new_file_id(),
            name,
            size: size as u64,
            mime,
            chunk_size: crate::filetransfer::CHUNK_SIZE,
            root_hash,
            sender: self.inner.endpoint_id(),
            sender_relay: relay,
            ts: crate::room::now_ms(),
        };
        serde_json::to_string(&meta).map_err(|e| JsError::new(&e.to_string()))
    }

    /// 接受对方的文件并**把数据流交给 JS 写的 sink**。
    ///
    /// 参数：
    /// - `file_id` / `meta_json`：从 `FileInvite` 事件里拿
    /// - `have_b64`：本端已有的块位图（base64）；首次接收传空串
    /// - `write` / `finish` / `abort`：三个 JS 回调（见 `JsChunkSink` 的说明）
    ///
    /// 返回一个 Promise；完成时 resolve 一个 JSON 字符串（含收到的字节数）。
    pub async fn accept_and_receive(
        &self,
        file_id: String,
        meta_json: String,
        have_b64: String,
        room: String,
        write: js_sys::Function,
        finish: js_sys::Function,
        abort: Option<js_sys::Function>,
    ) -> Result<String, JsError> {
        let meta: crate::filetransfer::FileMeta =
            serde_json::from_str(&meta_json).map_err(|e| JsError::new(&e.to_string()))?;
        let have = crate::filetransfer::bitmap_from_b64(&have_b64);
        let my_relay = self
            .inner
            .my_relay_url()
            .ok_or_else(|| JsError::new("本端还没有可用中继地址"))?;

        // 先登记再广播（顺序不能反，否则数据会丢）
        let (rx, ack_tx) = self
            .inner
            .accept_file(&file_id, &meta_json, have, &my_relay, &room)
            .await
            .map_err(to_js_err)?;

        let sink: std::sync::Arc<dyn ChunkSink> = std::sync::Arc::new(JsChunkSink::new(
            write,
            finish,
            abort,
            meta.clone(),
            have_b64.clone(),
        ));

        let total = crate::filetransfer::chunk_count(meta.size, meta.chunk_size) as u64;
        let got = self
            .inner
            .receive_file_data(&meta, sink, rx, ack_tx, |done, tot, bytes| {
                tracing::debug!("接收进度 {done}/{tot}（{bytes} 字节）");
                let _ = (done, tot);
            })
            .await
            .map_err(to_js_err)?;
        let _ = total;
        Ok(serde_json::json!({ "bytes": got }).to_string())
    }

    /// 拒绝接收。
    ///
    /// `room`：**必填** —— `Reject` 会带上自由文本理由广播，发错房间等于
    /// 向无关的人泄露"我为什么不要这个文件"（F7）。
    pub async fn reject_file(
        &self,
        file_id: String,
        reason: String,
        room: String,
    ) -> Result<(), JsError> {
        self.inner
            .reject_file(&file_id, &reason, &room)
            .await
            .map_err(to_js_err)
    }

    /// **取消**一个正在进行的接收（切后台暂停 / 用户中断）。
    ///
    /// 与 `reject_file` 的区别：**不通知对端**，只是想停下这一侧、保留已收内容，
    /// 之后可以续传。它会真正让 wasm 侧的读流循环退出 ——
    /// 这是"暂停后再次 accept 不会把文件写坏"的前提。
    pub fn cancel_file(&self, file_id: String) {
        self.inner.cancel_file(&file_id);
    }

    /// 等到对方的 `Accept` 后，把文件数据发出去。
    ///
    /// `read`：JS 回调 `(seq, chunkSize) => Uint8Array`，典型实现是
    /// `file.slice(...)`。这样文件内容**不经过 WASM 内存**。
    ///
    /// `on_event`：进度回调，入参是 JSON 字符串：
    /// - `{"phase":"sending","done":n,"total":m,"bytes":b}` 传输中
    /// - `{"phase":"sent"}` 数据已全部发出，**正在等对方校验回执**
    ///
    /// 有了 `sent` 这个中间态，UI 才能把"我发完了"和"对方确认收到了"分开显示 ——
    /// 否则发送端只能一直显示"传输中"，直到回执回来才跳变（实测就是这个观感问题）。
    ///
    /// 返回收到的字节数（JSON）。
    pub async fn send_file_to(
        &self,
        meta_json: String,
        peer_id: String,
        peer_relay: String,
        have_b64: String,
        read: js_sys::Function,
        on_event: js_sys::Function,
    ) -> Result<String, JsError> {
        let meta: crate::filetransfer::FileMeta =
            serde_json::from_str(&meta_json).map_err(|e| JsError::new(&e.to_string()))?;
        let have = crate::filetransfer::bitmap_from_b64(&have_b64);
        let src = JsChunkSource::new(read);
        let emit = |json: String| {
            let _ = on_event.call1(&JsValue::NULL, &JsValue::from_str(&json));
        };
        let s = self
            .inner
            .send_file_data(&meta, &peer_id, &peer_relay, &src, have, |ev| {
                use crate::filetransfer::SendEvent;
                match ev {
                    SendEvent::Progress { done, total, bytes } => emit(
                        serde_json::json!({
                            "phase": "sending", "done": done, "total": total, "bytes": bytes
                        })
                        .to_string(),
                    ),
                    SendEvent::Finished => emit(r#"{"phase":"sent"}"#.to_string()),
                    _ => {}
                }
            })
            .await
            .map_err(to_js_err)?;
        Ok(serde_json::json!({ "bytes": s }).to_string())
    }

    /// 从常驻节点拉历史。返回 JSON 字符串：
    /// `{"room":..., "messages":[...], "snapshot":{...}|null}`
    ///
    /// `snapshot` 里带成员表与各人的文件清单 —— 顺带把"进房即刻看到屋里有什么"解决掉。
    /// 拉到快照后会就地并进本地成员表（只补没见过的人，不覆盖本地更新的信息）。
    ///
    /// `before` 是**复合游标 `"<ts>:<id>"`**：要更早的消息时传上一页最后一条的
    /// `ts + ':' + id`。空串 = 取最新 `limit` 条。
    ///
    /// ⚠️ 以前只传毫秒时间戳，会漏掉同一毫秒里的消息（游标边界把它们整体跳过）。
    pub async fn fetch_history(
        &self,
        room: String,
        limit: usize,
        before: String,
    ) -> Result<String, JsError> {
        // 解析 "<ts>:<id>"；格式不对就当"取最新"（别静默返回错数据）
        let before_opt = parse_before_cursor(&before);
        let resp = self
            .inner
            .fetch_history_before(&room, limit, before_opt)
            .await
            .map_err(to_js_err)?;
        if let Some(snap) = resp.snapshot.as_ref() {
            self.inner.apply_snapshot(snap, &room).await;
        }
        serde_json::to_string(&resp).map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
}

// ---------------------------------------------------------------------------
// 点对点诊断节点（保留：给排障页用）
// ---------------------------------------------------------------------------

/// 解析复合游标 `"<ts>:<id>"`。
///
/// 空串 → `None`（取最新）。格式不对 → `None`（并返回 None，
/// 宁可多给一页也不给一个错的位置）。
fn parse_before_cursor(s: &str) -> Option<(u64, String)> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let mut it = t.splitn(2, ':');
    let ts = it.next()?.trim().parse::<u64>().ok()?;
    let id = it.next()?.trim();
    if id.is_empty() {
        return None;
    }
    Some((ts, id.to_string()))
}

#[wasm_bindgen]
pub struct WebNode {
    inner: ProbeInner,
}

#[wasm_bindgen]
impl WebNode {
    pub async fn start(opts_json: String) -> Result<WebNode, JsError> {
        let opts: NodeOptions = serde_json::from_str(&opts_json)
            .map_err(|e| JsError::new(&format!("配置解析失败: {e}")))?;
        let inner = ProbeInner::start(opts).await.map_err(to_js_err)?;
        Ok(WebNode { inner })
    }

    pub fn endpoint_id(&self) -> String {
        self.inner.endpoint_id()
    }

    pub async fn online(&self) {
        self.inner.online().await
    }

    pub fn relay_status_json(&self) -> String {
        serde_json::to_string(&self.inner.relay_status()).unwrap_or_else(|_| "[]".into())
    }

    pub fn events(&self) -> Result<JsReadableStream, JsError> {
        Ok(into_js_readable_stream(self.inner.subscribe()))
    }

    pub async fn send(
        &self,
        peer_id_hex: String,
        peer_relay: String,
        text: String,
    ) -> Result<String, JsError> {
        self.inner
            .send(&peer_id_hex, &peer_relay, &text)
            .await
            .map_err(to_js_err)
    }

    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
}

// ---------------------------------------------------------------------------

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}

fn into_js_readable_stream<T: Serialize + 'static>(rx: Receiver<T>) -> JsReadableStream {
    let stream = n0_future::StreamExt::map(rx, |event| {
        Ok(serde_wasm_bindgen::to_value(&event).unwrap())
    });
    ReadableStream::from_stream(stream).into_raw()
}


// ---------------------------------------------------------------------------
// 浏览器侧的文件读写
//
// 关键设计：**读写由 JS 完成，传输留在 Rust**。
// - 10GB 文件不可能进 WASM 内存（wasm32 上限 4GB，实际 1~2GB 就不稳）
// - 所以 Rust 只负责"要第 N 块"和"写第 N 块"，真正的 I/O 交给浏览器：
//   读取用 `File.slice()`，写入用 `showSaveFilePicker()` 的 `createWritable()`
// - 块数据经 `Uint8Array` 过界，每次只有一块（默认 16KB），内存恒定
// ---------------------------------------------------------------------------

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::transfer_orchestrator::{ChunkSink, ChunkSource, LocalBoxFuture};

/// 由 JS 回调提供的读取源。
///
/// JS 侧传一个 `(seq: number, size: number) => Promise<Uint8Array>`，
/// 典型实现是 `(seq, size) => file.slice(seq*size, (seq+1)*size).arrayBuffer().then(b => new Uint8Array(b))`
#[wasm_bindgen]
pub struct JsChunkSource {
    /// JS 函数：`(seq, chunkSize) => Uint8Array | Promise<Uint8Array>`
    read: js_sys::Function,
}

#[wasm_bindgen]
impl JsChunkSource {
    #[wasm_bindgen(constructor)]
    pub fn new(read: js_sys::Function) -> Self {
        Self { read }
    }
}

impl ChunkSource for JsChunkSource {
    fn read_chunk<'a>(&'a self, seq: u32, chunk_size: u32) -> LocalBoxFuture<'a, anyhow::Result<Vec<u8>>> {
        Box::pin(async move {
            let args = js_sys::Array::new();
            args.push(&JsValue::from_f64(seq as f64));
            args.push(&JsValue::from_f64(chunk_size as f64));
            let ret = self
                .read
                .apply(&JsValue::NULL, &args)
                .map_err(|e| anyhow::anyhow!("JS 读取回调抛错: {e:?}"))?;
            let val = JsFuture::from(js_sys::Promise::resolve(&ret))
                .await
                .map_err(|e| anyhow::anyhow!("JS 读取 Promise 失败: {e:?}"))?;
            let arr = js_sys::Uint8Array::new(&val);
            Ok(arr.to_vec())
        })
    }
}

/// 由 JS 回调提供的写入端。
///
/// JS 侧传三个函数：
/// - `write(seq, bytes)` —— 把这一块写到目标（追加或按偏移写）
/// - `finish()` —— 收完时收尾（**先校验再 close**，见下）
/// - `abort(reason)` —— 中断时收尾
///
/// ## 为什么校验必须在这里做，而不是"信任 QUIC"
///
/// 原生 `BytesSink` 会比对最终 BLAKE3，但**生产环境走的是这条 JS 路径**，
/// 而它以前只查"位图齐不齐"就把 `root_hash` 丢掉了（`let _ = (...)`）。
/// 也就是说线上从来没执行过内容校验 —— 位图只说明"每块都写过"，
/// 不说明"内容正确、长度正确、没有空洞"。
///
/// 现在 `write_chunk` 里做两件事：
/// 1. **块序号与长度校验** —— 越界 seq 会让 JS 按 `seq * chunk_size` 定位，
///    等于往目标文件任意偏移写。
/// 2. **增量 BLAKE3** —— 只有按序到达的完整文件才能算出正确哈希。
///
/// ⚠️ 哈希只能对**顺序写**的流增量计算。所以 `write_chunk` 还要求块**连续到达**
/// （乱序到达直接报错）—— 数据流本来就是顺序的，乱序说明有问题。
#[wasm_bindgen]
pub struct JsChunkSink {
    write: js_sys::Function,
    finish: js_sys::Function,
    abort: Option<js_sys::Function>,
    /// 邀约里的完整元信息（期望大小、块大小、根哈希都在这里）
    meta: crate::filetransfer::FileMeta,
    /// 已收到的块（用于「是否收齐」校验 —— 缺块必须判失败，
    /// 否则会把半个文件当成功交付，这是实测踩到的真 bug）
    have: std::sync::Mutex<ReceiveState>,
}

/// 从接收状态里取出增量哈希器的结果（hex）。
///
/// `blake3::Hasher` 的 `finalize()` 是 `&self`，所以不用把 hasher 移出来。
/// 拿锁失败时返回一个"必然不匹配"的串 —— 此时应该判失败而不是静默通过。
fn st_hasher_finish(st: &std::sync::Mutex<ReceiveState>) -> String {
    match st.lock() {
        Ok(g) => hex::encode(g.hasher.finalize().as_bytes()),
        // 拿锁失败：返回一个长度正确但内容必然不匹配的串（→ 判失败）
        Err(_) => "00".repeat(32),
    }
}

/// 接收过程中累积的校验状态。
struct ReceiveState {
    bitmap: Vec<u8>,
    /// 增量哈希器（blake3 支持一次喂任意长度切片）
    hasher: blake3::Hasher,
    /// 已按序喂给 hasher 的字节数
    hashed: u64,
    /// 期望"下一块"的序号 —— 用它检测乱序/空洞
    next_seq: u32,
    /// 本次会话开始时位图里已置位的块数（断点续传的那部分，**不在**本次流里）
    resumed_blocks: u32,
}

// ⚠️ 这里**不能**用 `#[wasm_bindgen] impl` + `constructor`：
//    那样 `new` 只能收 `FromWasmAbi` 的类型，而 `FileMeta` 是自定义 struct，
//    wasm_bindgen 不会为它生成转换（编译报 `FileMeta: FromWasmAbi is not satisfied`）。
//    `JsChunkSink` 是纯内部对象（从 `accept_and_receive` 里构造后直接用），
//    本来就不需要暴露给 JS，所以整个 impl 都不导出。
impl JsChunkSink {
    pub fn new(
        write: js_sys::Function,
        finish: js_sys::Function,
        abort: Option<js_sys::Function>,
        meta: crate::filetransfer::FileMeta,
        have_b64: String,
    ) -> Self {
        let size = meta.size;
        let chunk_size = meta.chunk_size;
        let n = crate::filetransfer::chunk_count(size, chunk_size);
        // ⚠️ 初始位图必须带上「断点续传时已拥有的块」。
        //    只统计本轮收到的块会误判为"缺块"→ 明明收齐了却报失败
        //    （实测：第 2 轮补完 32 块后状态仍是 failed）。
        let mut bitmap = crate::filetransfer::bitmap_new(n);
        let prev = crate::filetransfer::bitmap_from_b64(&have_b64);
        let mut resumed_blocks = 0u32;
        for i in 0..n {
            if i < prev.len() * 8 && crate::filetransfer::bitmap_get(&prev, i) {
                crate::filetransfer::bitmap_set(&mut bitmap[..], i);
                resumed_blocks += 1;
            }
        }
        Self {
            write,
            finish,
            abort,
            meta,
            have: std::sync::Mutex::new(ReceiveState {
                bitmap,
                hasher: blake3::Hasher::new(),
                hashed: 0,
                next_seq: 0,
                resumed_blocks,
            }),
        }
    }
}

impl ChunkSink for JsChunkSink {
    fn write_chunk<'a>(&'a self, seq: u32, bytes: &'a [u8]) -> LocalBoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            // ① 块范围与长度校验（必须在调 JS 之前 —— 否则已经写进去了）
            let total_chunks = crate::filetransfer::chunk_count(self.meta.size, self.meta.chunk_size);
            if seq as usize >= total_chunks {
                anyhow::bail!(
                    "块序号越界：seq={seq}，总块数={total_chunks}（meta.size={} chunk={}）",
                    self.meta.size,
                    self.meta.chunk_size
                );
            }
            let cs = self.meta.chunk_size as usize;
            let is_last = seq as usize + 1 == total_chunks;
            let expect_len = if is_last {
                let rem = (self.meta.size as usize) % cs;
                if rem == 0 { cs } else { rem }
            } else {
                cs
            };
            if bytes.len() != expect_len {
                anyhow::bail!(
                    "第 {seq} 块长度不符：期望 {expect_len}，实际 {}",
                    bytes.len()
                );
            }

            // ② 顺序与重复检查 —— **必须在调 JS 写盘之前**。
            //
            //    ⚠️ 这里有两个坑，都是"顺序规则"与"增量哈希"绑在一起造成的：
            //
            //    (a) **续传时绝不能用 `next_seq` 要求连续。**
            //        续传本轮只发"缺哪些补哪些"（见 `send_file` 里
            //        `need = missing_chunks(have, n)`），所以本次流的第一个块
            //        序号就是第一个缺失块（例如 32）；而 `next_seq` 从 0 起，
            //        于是旧代码会在**第一块**就报"块乱序：期望 seq=0，收到 32"
            //        —— 浏览器端断点续传**必然失败**。
            //        原生 `BytesSink` 只按 `seq * chunk_size` 写、没有顺序要求，
            //        所以这个缺陷**只在浏览器路径上**，单测看不出来。
            //        续传本就算不出整文件哈希（缺前缀字节），因此这里不做顺序
            //        要求、也不喂 hasher；整文件校验由 JS 侧回读完成（F5）。
            //
            //    (b) **重复块必须判失败，且要在写盘之前拦。**
            //        旧代码把 `seq < next_seq` 当"重发"容忍，可那时**已经写进磁盘**了：
            //        于是发送方能在哈希完成后再补发一块内容不同的"同序号块"，
            //        把落盘内容改掉而哈希照样通过（P3-19）。
            let mut st = self.have.lock().unwrap();
            // 判定逻辑抽在 `check_chunk_admission` 里（可被单测覆盖）
            let already_have = (seq as usize) < st.bitmap.len() * 8
                && crate::filetransfer::bitmap_get(&st.bitmap, seq as usize);
            if let Err(why) = crate::filetransfer::check_chunk_admission(
                seq,
                total_chunks,
                st.resumed_blocks,
                st.next_seq,
                already_have,
            ) {
                anyhow::bail!("{why}");
            }

            let u8arr = js_sys::Uint8Array::from(bytes);
            let args = js_sys::Array::new();
            args.push(&JsValue::from_f64(seq as f64));
            args.push(&u8arr);
            let ret = self
                .write
                .apply(&JsValue::NULL, &args)
                .map_err(|e| anyhow::anyhow!("JS 写入回调抛错: {e:?}"))?;
            JsFuture::from(js_sys::Promise::resolve(&ret))
                .await
                .map_err(|e| anyhow::anyhow!("JS 写入 Promise 失败: {e:?}"))?;

            // ③ 只有真正写成功才记进位图 / 喂哈希
            if (seq as usize) < st.bitmap.len() * 8 {
                crate::filetransfer::bitmap_set(&mut st.bitmap[..], seq as usize);
            }
            // 增量哈希只在整收路径上做（续传缺前缀，算不出整文件哈希 —— 见 F5）
            if st.resumed_blocks == 0 {
                st.hasher.update(bytes);
                st.hashed += bytes.len() as u64;
                st.next_seq += 1;
            }
            Ok(())
        })
    }

    fn finish<'a>(&'a self) -> LocalBoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            let n_chunks = crate::filetransfer::chunk_count(self.meta.size, self.meta.chunk_size);
            let st = self.have.lock().unwrap();
            let have = st.bitmap.clone();
            let hashed = st.hashed;
            let resumed = st.resumed_blocks;
            drop(st);

            // ① 先确认**块收齐了**。
            //    对端正常 EOF ≠ 数据完整 —— 发送方只发一半就 EOF 的情况实测踩过：
            //    接收方把半个文件当成功交付，既不报错、还把断点位图删了。
            let missing = crate::filetransfer::missing_chunks(&have, n_chunks);
            if !missing.is_empty() {
                anyhow::bail!(
                    "数据不完整：共 {n_chunks} 块，缺 {} 块（首个缺失 #{:?}）",
                    missing.len(),
                    missing.first()
                );
            }

            // ② 比对**整文件哈希**（原来是 `let _ = (...)`，等于完全没校验）。
            //
            //    ⚠️ 这个判定必须是**穷尽**的（F17）：以前写成
            //    `if resumed == 0 && hashed == size && !root_hash.is_empty()` +
            //    `else if resumed > 0`，于是"`root_hash` 为空且不是续传"这种情况
            //    **两个分支都不进**，直接落到 ③ 报成功 —— 一条空哈希的邀约就能
            //    把"内容校验"整体关掉。所以现在：
            //      · 整收（resumed == 0）：**必须**能校验，缺哈希/字节数对不上都判失败；
            //      · 续传（resumed > 0）：Rust 侧拿不到前缀字节，**算不出**整文件哈希
            //        → 交给 JS 侧回读落盘文件校验（见 `iroh-worker.js` 的 finish），
            //        这里明确标注"未校验"，而不是静默通过。
            if resumed == 0 {
                if self.meta.root_hash.trim().is_empty() {
                    anyhow::bail!("邀约没有 root_hash，无法校验内容，拒绝交付");
                }
                if hashed != self.meta.size {
                    anyhow::bail!(
                        "已哈希字节数与文件大小不符（{hashed} != {}），拒绝交付",
                        self.meta.size
                    );
                }
                let got = st_hasher_finish(&self.have);
                let want = self.meta.root_hash.trim();
                // blake3 是 32 字节 → 64 个 hex 字符。发送方给的就是这个长度。
                // 比对前先规整大小写（有的实现用大写），长度不符直接判失败 ——
                // 长度不对说明根本不是同一种哈希，比逐字符比更有信息量。
                if got.len() != want.len() {
                    anyhow::bail!(
                        "哈希长度不符：期望 {} 位，实际 {} 位",
                        want.len(),
                        got.len()
                    );
                }
                if !got.eq_ignore_ascii_case(want) {
                    anyhow::bail!("哈希不符：期望 {want}，实际 {got}");
                }
            } else {
                // 续传：由 JS 侧的 finish 回调回读整份文件做校验。
                // 这里只记一条日志；**真正决定成败的是 JS 那边抛不抛错**
                // （抛错 → 本函数返回 Err → 不会发 ok:true 回执）。
                tracing::warn!(
                    "断点续传（已有 {resumed} 块）：Rust 侧跳过哈希，改由 JS 回读整文件校验"
                );
            }

            // ③ 让 JS 收尾（flush + close）
            let ret = self
                .finish
                .call0(&JsValue::NULL)
                .map_err(|e| anyhow::anyhow!("JS 收尾回调抛错: {e:?}"))?;
            JsFuture::from(js_sys::Promise::resolve(&ret))
                .await
                .map_err(|e| anyhow::anyhow!("JS 收尾 Promise 失败: {e:?}"))?;
            Ok(())
        })
    }

    fn abort<'a>(&'a self, reason: &'a str) -> LocalBoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            if let Some(f) = &self.abort {
                let args = js_sys::Array::new();
                args.push(&JsValue::from_str(reason));
                if let Ok(ret) = f.apply(&JsValue::NULL, &args) {
                    let _ = JsFuture::from(js_sys::Promise::resolve(&ret)).await;
                }
            }
            Ok(())
        })
    }
}

/// **测试专用**：让发送方只发前 N 块后停止，用于验证断点续传。
/// 传 0 恢复正常。生产代码不会被调用。
#[wasm_bindgen]
pub fn set_stop_after_chunks(n: usize) {
    crate::filetransfer::STOP_AFTER_CHUNKS.store(n, std::sync::atomic::Ordering::Relaxed);
}

/// 给 JS 的增量哈希器（算大文件根哈希用，避免一次性读进内存）。
#[wasm_bindgen]
pub struct JsHasher {
    inner: crate::filetransfer::Hasher,
}

#[wasm_bindgen]
impl JsHasher {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: crate::filetransfer::Hasher::new(),
        }
    }
    pub fn update(&mut self, bytes: &[u8]) {
        self.inner.update(bytes);
    }
    pub fn finish(&self) -> String {
        self.inner.finish()
    }
}

impl Default for JsHasher {
    fn default() -> Self {
        Self::new()
    }
}
