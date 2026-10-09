//! 文件传输的**编排层**：把协议（`filetransfer`）和上层（浏览器 / CLI）串起来。
//!
//! ## 为什么需要"读/写"抽象
//!
//! 发送方的源可能是浏览器里的 `File`（用 `File.slice()` 分块读），
//! 接收方的目标可能是 `showSaveFilePicker()` 给的句柄（用 `createWritable()` 写），
//! 而在服务器上就是普通的文件 / 内存。
//!
//! 所以这里定义两个极简 trait，由各端自己实现：
//! - [`ChunkSource`]：能按序号读出一块
//! - [`ChunkSink`]：能按序号写一块 + 结束后校验
//!
//! 传输逻辑只依赖这两个 trait，**与平台无关**，于是同一份代码
//! 既能在浏览器（wasm）跑，也能在原生进程里跑（便于先验证协议）。

use std::sync::Arc;

use anyhow::{Context, Result};
/// 带生命周期的装箱 Future。
///
/// - 原生（`cli`）：需要 `Send`（trait object 要跨线程用）
/// - wasm：**不能**要求 `Send` —— `js_sys::Function` / `JsValue` 不是 `Send`，
///   而且浏览器是单线程，本来也不需要
///
/// 所以用条件编译给出两种定义。注意 `n0_future::boxed::BoxFuture` 是 `'static` 的，
/// 不接受借用，在这里用不了。
#[cfg(not(target_arch = "wasm32"))]
pub type LocalBoxFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

#[cfg(target_arch = "wasm32")]
pub type LocalBoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + 'a>>;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey};
use tracing::{debug, info};

use crate::filetransfer::{
    chunk_count, chunk_range, hex_encode, missing_chunks, new_file_id, read_json_frame,
    write_frame, write_json_frame, FileAck, FileChunk, FileHeader, FileMeta, SendEvent,
    CHUNK_SIZE, FRAME_CHUNK, FRAME_DONE, FRAME_HEADER,
};

/// 发送方：按块读数据。
///
/// 实现者**不应**把整个文件载入内存 —— 只按请求的那一块读。
pub trait ChunkSource: Send + Sync {
    /// 第 `seq` 块的**原始字节**（可能不足 `chunk_size`，最后一块）。
    ///
    /// 返回装箱 Future 是为了让 trait 保持 object-safe，
    /// 同时不引入 `async-trait` 这类额外依赖（`n0_future` 已是现成依赖）。
    fn read_chunk<'a>(&'a self, seq: u32, chunk_size: u32) -> LocalBoxFuture<'a, Result<Vec<u8>>>;
}

/// 接收方：按块写数据，并在结束时校验。
pub trait ChunkSink: Send + Sync {
    /// 写第 `seq` 块。实现可以跳过已存在的块（断点续传）。
    fn write_chunk<'a>(&'a self, seq: u32, bytes: &'a [u8]) -> LocalBoxFuture<'a, Result<()>>;
    /// 全部收完：做完整性校验（例如整文件 blake3）。
    /// 返回 `Err` 表示校验失败（会回报给发送方）。
    fn finish<'a>(&'a self) -> LocalBoxFuture<'a, Result<()>>;
    /// 放弃（用户取消 / 出错）。默认什么都不做。
    fn abort<'a>(&'a self, _reason: &'a str) -> LocalBoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    /// 已拥有哪些块（断点续传用）。默认全没有。
    fn have_bitmap(&self, _n_chunks: usize) -> Vec<u8> {
        Vec::new()
    }
}

/// 发送方：把一个已有的可读源（本地文件 / 内存）当 `ChunkSource`。
///
/// 浏览器里可以用 `File.slice()` 包一层；这里提供内存实现，CLI 与测试直接可用。
///
/// ⚠️ **整文件驻留内存** —— 只适合小文件。发大文件请用 [`FileSource`]
/// 或（Android）[`FdSource`]。
pub struct BytesSource {
    pub data: Vec<u8>,
}

impl ChunkSource for BytesSource {
    fn read_chunk<'a>(&'a self, seq: u32, chunk_size: u32) -> LocalBoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            let (start, end) = chunk_range(seq as usize, chunk_size, self.data.len() as u64);
            let s = start as usize;
            let e = (end as usize).min(self.data.len());
            if s >= self.data.len() {
                anyhow::bail!("块 {seq} 超出范围");
            }
            Ok(self.data[s..e].to_vec())
        })
    }
}

/// 从**文件路径**按块读（每次只读一块 = 16 KiB，内存恒定）。
///
/// 与 `agent.rs` 里那个同名的内部类型等价，提到库里是为了让 JNI 也能用。
#[cfg(not(target_arch = "wasm32"))]
pub struct FileSource {
    path: std::path::PathBuf,
}

#[cfg(not(target_arch = "wasm32"))]
impl FileSource {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl ChunkSource for FileSource {
    fn read_chunk<'a>(&'a self, seq: u32, chunk_size: u32) -> LocalBoxFuture<'a, Result<Vec<u8>>> {
        let path = self.path.clone();
        Box::pin(async move {
            use std::io::{Read, Seek, SeekFrom};
            let mut f =
                std::fs::File::open(&path).with_context(|| format!("打开 {}", path.display()))?;
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

/// 从**已打开的句柄**按块读（Android MediaStore 那条路）。
///
/// 为什么不用路径：Android 10+ 选文件走 SAF，拿到的是 `Uri` + fd，
/// **没有可用的文件系统路径**（见 `FileSink::from_file` 的同款说明）。
///
/// 句柄必须可读**且可 seek** —— 按 `seq * chunk_size` 定位取块。
/// 每次只读一块，内存恒定，与文件大小无关。
///
/// ⚠️ 内部用 `Mutex` 串行化 seek+read：两个线程同时 seek 同一个 fd
///    会互相踩（seek 到 A、还没读就被 seek 到 B）→ 读到错块。
///    **不能用 `try_clone`** —— 那只是 dup 文件描述符，
///    dup 出来的 fd **共享同一个文件偏移**，照样踩。
#[cfg(not(target_arch = "wasm32"))]
pub struct FdSource {
    file: std::sync::Mutex<std::fs::File>,
}

#[cfg(not(target_arch = "wasm32"))]
impl FdSource {
    /// 接管这个句柄的所有权（`File` 的 Drop 会关它，调用方别再关）。
    pub fn new(file: std::fs::File) -> Self {
        Self {
            file: std::sync::Mutex::new(file),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl ChunkSource for FdSource {
    fn read_chunk<'a>(&'a self, seq: u32, chunk_size: u32) -> LocalBoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            use std::io::{Read, Seek, SeekFrom};
            let mut f = self
                .file
                .lock()
                .map_err(|_| anyhow::anyhow!("文件句柄锁已失效"))?;
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

/// 流式算一个**已打开句柄**的 blake3（不整体进内存），返回 `(size, hex_hash)`。
///
/// 发大文件前必须算根哈希（协议要求），而整读会吃满内存 ——
/// 这里用 1 MiB 缓冲流式算。
///
/// 读完把位置还原到 0：调用方多半接下来要按块读，从中间开始会读到错数据。
#[cfg(not(target_arch = "wasm32"))]
pub fn hash_reader(file: &mut std::fs::File) -> Result<(u64, String)> {
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    file.seek(SeekFrom::Start(0))?;
    Ok((size, hex_encode(hasher.finalize().as_bytes())))
}

/// 纯内存接收端（CLI / 测试用；浏览器里换成写文件句柄的版本）。
///
/// 注意：它会持有一份完整数据，所以**只适合小文件或验证协议**。
pub struct BytesSink {
    pub data: tokio::sync::Mutex<Vec<u8>>,
    pub size: u64,
    pub root_hash: String,
    /// ⚠️ 必须与发送方一致。**不能硬编码 `CHUNK_SIZE`**：
    /// 偏移是按 `seq * chunk_size` 算的，块大小不一致会写错位置。
    pub chunk_size: u32,
}

impl ChunkSink for BytesSink {
    fn write_chunk<'a>(&'a self, seq: u32, bytes: &'a [u8]) -> LocalBoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut d = self.data.lock().await;
            let off = seq as usize * self.chunk_size as usize;
            let need = off + bytes.len();
            if d.len() < need {
                d.resize(need, 0);
            }
            d[off..need].copy_from_slice(bytes);
            Ok(())
        })
    }

    fn finish<'a>(&'a self) -> LocalBoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let d = self.data.lock().await;
            if d.len() as u64 != self.size {
                anyhow::bail!("大小不符：期望 {}，实际 {}", self.size, d.len());
            }
            let got = hex_encode(&blake3::hash(&d).as_bytes()[..]); // 完整哈希，便于排查
            let want = self.root_hash.clone();
            if !got.starts_with(&want[..want.len().min(got.len())]) {
                anyhow::bail!("哈希不符：期望 {want}，实际 {got}");
            }
            Ok(())
        })
    }

    fn have_bitmap(&self, n_chunks: usize) -> Vec<u8> {
        // 内存实现假定每次都从头传（断点续传的实现在浏览器侧用 IndexedDB）
        crate::filetransfer::bitmap_new(n_chunks)
    }
}

// ---------------------------------------------------------------------------
// 接收侧：落盘 sink（仅原生；wasm 侧由 JS 回调写 OPFS / 文件句柄）
// ---------------------------------------------------------------------------

/// 把块**流式写入磁盘**的接收端：内存占用 = 一块（16 KiB），与文件大小无关。
///
/// - 按 `seq * chunk_size` 偏移定位写入（容忍乱序/重试；不会把文件写坏）
/// - `finish` 时重新流式读回算整文件 blake3，与邀约里的 `root_hash` 核对
/// - 失败/中断时**保留半成品文件**（便于排查；v1 不做自动续传）
///
/// ## 两种构造方式
///
/// - [`FileSink::open`]：给定路径（CLI / agent 用）—— 哈希校验时**按路径重开**
/// - [`FileSink::from_file`]：给定**已打开的句柄**（Android MediaStore 用）
///
/// ⚠️ 为什么需要 `from_file`：Android 10+ 往公共目录写文件必须走 MediaStore，
/// 它只给 `Uri`/文件描述符，**没有可用的文件系统路径**。
/// 所以校验时不能"按路径重开"，必须**复用同一个句柄** seek 回 0 再读。
///
/// `label` 只用于错误信息（fd 场景下没有路径可显示，传个描述串）。
#[cfg(not(target_arch = "wasm32"))]
pub struct FileSink {
    /// 展示用的名字（路径或一句描述）。仅用于报错，**不**参与 IO。
    label: String,
    size: u64,
    root_hash: String,
    chunk_size: u32,
    file: tokio::sync::Mutex<std::fs::File>,
}

#[cfg(not(target_arch = "wasm32"))]
impl FileSink {
    /// 打开（必要时创建父目录并截断）目标文件。
    pub fn open(path: impl Into<std::path::PathBuf>, meta: &FileMeta) -> Result<Self> {
        let path = path.into();
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).with_context(|| format!("创建目录 {}", dir.display()))?;
        }
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .with_context(|| format!("打开 {}", path.display()))?;
        Ok(Self {
            label: path.display().to_string(),
            size: meta.size,
            root_hash: meta.root_hash.clone(),
            chunk_size: meta.chunk_size,
            file: tokio::sync::Mutex::new(file),
        })
    }

    /// 从**已打开的句柄**构造（Android MediaStore 那条路）。
    ///
    /// 句柄必须可读可写**且可 seek** —— `write_chunk` 靠 `seq * chunk_size`
    /// 偏移定位，`finish` 靠 seek 回 0 重读校验。
    /// MediaStore 的 `openFileDescriptor("rw")` 满足这些要求。
    ///
    /// ⚠️ 调用方要保证这个 fd **独占**且生命周期覆盖整个接收过程；
    ///    Rust 侧用 `File::from_raw_fd` 接管后由它负责关闭。
    pub fn from_file(file: std::fs::File, meta: &FileMeta, label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            size: meta.size,
            root_hash: meta.root_hash.clone(),
            chunk_size: meta.chunk_size,
            file: tokio::sync::Mutex::new(file),
        }
    }

    /// 展示用的名字（路径或描述）。仅用于日志/报错。
    pub fn label(&self) -> &str {
        &self.label
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl ChunkSink for FileSink {
    fn write_chunk<'a>(&'a self, seq: u32, bytes: &'a [u8]) -> LocalBoxFuture<'a, Result<()>> {
        Box::pin(async move {
            use std::io::{Seek, SeekFrom, Write};
            let mut f = self.file.lock().await;
            f.seek(SeekFrom::Start(seq as u64 * self.chunk_size as u64))?;
            f.write_all(bytes)?;
            Ok(())
        })
    }

    fn finish<'a>(&'a self) -> LocalBoxFuture<'a, Result<()>> {
        Box::pin(async move {
            use std::io::{Read, Seek, SeekFrom, Write};

            // ⚠️ 两件事必须在**同一个锁内**做完：flush + 校验读取。
            //    分开拿锁的话，写入侧可能在两次之间插进来改内容。
            //
            // ⚠️ 校验一律**复用同一个句柄** seek 回 0 读，不走"按路径重开"：
            //    fd 场景（MediaStore）根本没有路径可开。
            //    有路径时"重开"其实也是多此一举 —— 同一个文件的另一个句柄
            //    看到的内容完全一样。
            let mut f = self.file.lock().await;
            f.flush()?;

            // 大小校验：用句柄自己的 metadata（fd 场景没有路径可 stat）
            let actual = f.metadata()?.len();
            if actual != self.size {
                anyhow::bail!(
                    "大小不符：期望 {}，实际 {}（{}）",
                    self.size,
                    actual,
                    self.label
                );
            }

            // 流式重读算哈希（1 MiB 缓冲），大文件也不吃内存
            f.seek(SeekFrom::Start(0))?;
            let mut hasher = blake3::Hasher::new();
            let mut buf = vec![0u8; 1024 * 1024];
            let mut remaining = self.size;
            while remaining > 0 {
                let want = remaining.min(buf.len() as u64) as usize;
                let n = f.read(&mut buf[..want])?;
                if n == 0 {
                    anyhow::bail!("校验读取提前结束（还剩 {remaining} 字节，{}）", self.label);
                }
                hasher.update(&buf[..n]);
                remaining -= n as u64;
            }
            let got = hex_encode(hasher.finalize().as_bytes());
            let want = self.root_hash.as_str();
            // 与 BytesSink 同款宽容比较：任一方可能是被截断的短哈希
            if !got.starts_with(&want[..want.len().min(got.len())]) {
                anyhow::bail!("哈希不符：期望 {want}，实际 {got}（{}）", self.label);
            }
            Ok(())
        })
    }

    fn have_bitmap(&self, n_chunks: usize) -> Vec<u8> {
        // v1 不做续传：始终从空位图开始（要续传需要扫描已有文件，另立项）
        crate::filetransfer::bitmap_new(n_chunks)
    }
}

// ---------------------------------------------------------------------------
// 发送侧编排
// ---------------------------------------------------------------------------

/// 发送一个文件。
///
/// `have`：接收方已有的块位图（空 = 全都要）。
/// `on_event`：进度/结束回调，UI 用来更新。
pub async fn send_file<S, F>(
    endpoint: &Endpoint,
    peer: EndpointId,
    peer_relay: &RelayUrl,
    meta: &FileMeta,
    source: &S,
    have: &[u8],
    mut on_event: F,
) -> Result<u64>
where
    S: ChunkSource + ?Sized,
    F: FnMut(SendEvent),
{
    let n_chunks = chunk_count(meta.size, meta.chunk_size);
    let need = missing_chunks(have, n_chunks);
    on_event(SendEvent::Started { need: need.clone() });
    info!(
        "开始发送 {}：共 {} 块，需要补发 {} 块",
        meta.name,
        n_chunks,
        need.len()
    );

    let addr = EndpointAddr::new(peer).with_relay_url(peer_relay.clone());
    let conn = endpoint
        .connect(addr, crate::filetransfer::FILE_ALPN)
        .await
        .context("连接接收方失败")?;
    let (mut send, mut recv) = conn.open_bi().await.context("打开文件流失败")?;

    // ① 头部 —— 每一项都会被接收方与邀约逐项核对（见 header_matches）
    let header = FileHeader {
        file_id: meta.file_id.clone(),
        name: meta.name.clone(),
        size: meta.size,
        chunk_size: meta.chunk_size,
        root_hash: meta.root_hash.clone(),
        mime: meta.mime.clone(),
    };
    write_json_frame(&mut send, FRAME_HEADER, &header).await?;

    // ② 逐块发送（每块读出来立刻写走，读一块、发一块，内存恒定）
    //
    // 测试钩子：`STOP_AFTER_CHUNKS > 0` 时只发前 N 块就主动收尾，
    // 用来在真机上制造"半途中断"，从而验证接收方的断点续传。
    // 生产环境该值为 0，走下面完全一样的路径。
    let stop_after = crate::filetransfer::STOP_AFTER_CHUNKS
        .load(std::sync::atomic::Ordering::Relaxed);
    if stop_after > 0 {
        info!("[测试钩子] 只发送前 {stop_after} 块");
    }

    let mut sent_bytes: u64 = 0;
    // 耗时分解（诊断吞吐用）：把时间分别算在「读源文件」和「写网络」上。
    // 慢的时候能一眼看出是卡在 JS 读回调，还是 QUIC 写（流控/往返）。
    let t_loop = crate::room::now_ms();
    let mut t_read_ms: u64 = 0;
    let mut t_write_ms: u64 = 0;
    for (i, seq) in need.iter().enumerate() {
        if stop_after > 0 && i >= stop_after {
            // ⚠️ 不能直接 `conn.close()`：QUIC 里已写入但未 flush 的数据会被丢弃，
            //    接收方连 header 都读不到（实测 "文件流头部解析失败"、0 块）。
            //    正确做法是照常走 `send.finish()`（flush + 正常 EOF），
            //    让**接收方**通过「实际块数 < 声明块数」自己发现传输不完整 ——
            //    这也正是真实弱网/中断后要面对的判定逻辑。
            info!("[测试钩子] 只发送 {stop_after} 块，正常收尾（数据不完整）");
            break;
        }

        let t0 = crate::room::now_ms();
        let bytes = source
            .read_chunk(*seq, meta.chunk_size)
            .await
            .with_context(|| format!("读取第 {seq} 块失败"))?;
        t_read_ms += crate::room::now_ms().saturating_sub(t0);

        let mut payload = Vec::with_capacity(4 + bytes.len());
        payload.extend_from_slice(&seq.to_be_bytes());
        payload.extend_from_slice(&bytes);

        let t1 = crate::room::now_ms();
        // ------------------------------------------------------------------
        // ⚠️ 单块写超时：**这是"发送端自己发现对端没了"的根治手段之一**
        //
        // 对端刷新/关页面后，往流里写数据**不会立刻报错**（实测两分多钟都没
        // 抛错）：接收方消失后中继只是把包丢掉，发送方收不到 ACK、流控窗口
        // 很快耗尽，于是 `write_frame` 一直**阻塞在等窗口**上，既不成功也不失败。
        //
        // 应用层的"无进度看门狗"（JS 侧）能兜住 UI，但 Rust 这个任务会一直
        // 挂着、继续占着连接。这里给单块写设上限，让卡死的任务自己退出。
        //
        // 余量：正常链路写一块 16KB 远小于 1 秒（中继实测 600+ KB/s）。
        // 要 30 秒都写不进一块，等效吞吐已低到 0.5 KB/s —— 那就是断了。
        // 对照实测（2026-10-02）：带/不带这个超时，吞吐在噪声内无差异。
        // ------------------------------------------------------------------
        match n0_future::time::timeout(
            std::time::Duration::from_secs(30),
            write_frame(&mut send, FRAME_CHUNK, &payload),
        )
        .await
        {
            Ok(r) => r?,
            Err(_) => anyhow::bail!("对端长时间无响应（可能已离开或刷新了页面）"),
        }
        t_write_ms += crate::room::now_ms().saturating_sub(t1);

        // 诊断：周期性打印 QUIC 连接统计（RTT / 拥塞窗口 / 丢包 / 在途字节）。
        // 这是判断"慢"到底卡在拥塞窗口还是带宽的唯一直接证据。
        if i % 128 == 0 {
            let mut parts: Vec<String> = Vec::new();
            for p in &conn.paths() {
                let id = p.id();
                let rtt = conn
                    .rtt(id)
                    .map(|d| format!("{:.0}ms", d.as_secs_f64() * 1000.0))
                    .unwrap_or_else(|| "?".into());
                parts.push(format!("path{id:?} rtt={rtt}"));
            }
            info!(
                "[stats] 第 {i} 块 | {} | {:?}",
                parts.join(" | "),
                conn.stats()
            );
        }

        sent_bytes += bytes.len() as u64;

        if i % 64 == 0 || i + 1 == need.len() {
            on_event(SendEvent::Progress {
                done: (i + 1) as u64,
                total: need.len() as u64,
                bytes: sent_bytes,
            });
        }
    }
    let t_total = crate::room::now_ms().saturating_sub(t_loop);
    let kbps = if t_total > 0 {
        (sent_bytes / 1024) as u128 * 1000 / t_total as u128
    } else {
        0
    };
    info!(
        "发送耗时分解：共 {t_total}ms（读源 {t_read_ms}ms / 写网络 {t_write_ms}ms），\
         {} 字节 ≈ {kbps} KB/s",
        sent_bytes
    );
    send.finish().context("关闭发送流失败")?;
    on_event(SendEvent::Finished);
    info!("已发完 {} 字节，等待接收方回执…", sent_bytes);

    // ③ 等接收方回执
    //
    // ⚠️ 必须用 `n0_future::time::timeout`，**不能用 `tokio::time`**：
    //    wasm 上没有 tokio 运行时/计时器，`tokio::time::timeout` 既不触发超时、
    //    也永远不返回 —— 表现就是发送端永远停在"传输中"。
    //    （接收侧 `filetransfer.rs` 一直用的就是 n0_future，所以只有发送端中招。）
    let ack: FileAck = match n0_future::time::timeout(
        std::time::Duration::from_secs(120),
        read_json_frame(&mut recv, FRAME_DONE),
    )
    .await
    {
        Ok(Ok(a)) => a,
        Ok(Err(e)) => FileAck {
            ok: false,
            reason: format!("读取回执失败: {e:#}"),
        },
        Err(_) => FileAck {
            ok: false,
            reason: "等待回执超时".into(),
        },
    };
    info!("收到回执：ok={} {}", ack.ok, ack.reason);
    on_event(SendEvent::Ack {
        ok: ack.ok,
        reason: ack.reason.clone(),
    });
    conn.close(0u8.into(), b"done");

    if !ack.ok {
        on_event(SendEvent::Failed {
            reason: ack.reason.clone(),
        });
        anyhow::bail!("接收方校验失败：{}", ack.reason);
    }
    info!("发送完成 {}：{} 字节", meta.name, sent_bytes);
    Ok(sent_bytes)
}

// ---------------------------------------------------------------------------
// 接收侧编排
// ---------------------------------------------------------------------------

/// 接收侧的空闲超时：多久没有任何"块 / 结束"事件到达就判失败。
///
/// ## 为什么必须有（缺陷 F16）
///
/// 发送方可能"答应了但从不拨号"—— 例如 `Accept` 被发进了错误的房间
/// （F13 修好之前是必然），或者对端直接崩了。那种情况下
/// `FileService` 的读流循环根本不会启动，`rx` 永远不会有任何事件：
/// 没有这个超时，`receive_file` 会永久挂起 → `accept` 这个 RPC 永不 resolve
/// → UI 永久停在"传输中 0%"。
///
/// 数值比 `filetransfer.rs` 的 `FRAME_IDLE_TIMEOUT`（60s）宽松：
/// 那条管"传输中停顿"，这条管"连开始都没开始"。
pub const RECV_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// 接收一个文件：消费 `FileService` 派发过来的块流，写进 `sink`，
/// 校验后把结果通过 `ack_tx` 回给服务层（服务层再转达给发送方）。
///
/// **调用顺序很重要**：
/// 1. 先 `file_service.expect(file_id)` → 拿到 `(rx, ack_tx)`
/// 2. 再广播 `Accept`
/// 3. 再调用本函数消费 `rx`
///
/// 这样数据到达时一定有接收方，不会丢。
pub async fn receive_file<F>(
    meta: &FileMeta,
    sink: Arc<dyn ChunkSink>,
    rx: async_channel::Receiver<FileChunk>,
    ack_tx: async_channel::Sender<FileAck>,
    mut on_progress: F,
) -> Result<u64>
where
    F: FnMut(u64, u64, u64),
{
    let n_chunks = chunk_count(meta.size, meta.chunk_size) as u64;
    let mut done: u64 = 0;
    let mut got_bytes: u64 = 0;
    let mut failed: Option<String> = None;

    loop {
        // 空闲超时兜底（见 `RECV_IDLE_TIMEOUT`）：`Ok(Err(_))` = 通道关闭
        // （正常结束 / 被 cancel），`Err(_)` = 超时。
        let chunk = match n0_future::time::timeout(RECV_IDLE_TIMEOUT, rx.recv()).await {
            Ok(Ok(c)) => c,
            Ok(Err(_)) => break,
            Err(_) => {
                failed = Some(format!(
                    "等待数据超时：{}s 内没有任何进展（发送方可能没有开始传输）",
                    RECV_IDLE_TIMEOUT.as_secs()
                ));
                break;
            }
        };
        match chunk {
            FileChunk::Data { seq, bytes } => {
                if let Err(e) = sink.write_chunk(seq, &bytes).await {
                    failed = Some(format!("写入失败: {e:#}"));
                    break;
                }
                done += 1;
                got_bytes += bytes.len() as u64;
                on_progress(done, n_chunks, got_bytes);
            }
            FileChunk::End { ok, reason } => {
                if !ok {
                    failed = Some(reason);
                }
                break;
            }
        }
    }

    // 先自己校验（整文件 blake3），再把结论交给服务层
    let ack = match failed {
        Some(reason) => FileAck { ok: false, reason },
        None => match sink.finish().await {
            Ok(()) => FileAck {
                ok: true,
                reason: String::new(),
            },
            Err(e) => FileAck {
                ok: false,
                reason: format!("校验失败: {e:#}"),
            },
        },
    };

    // 服务层在等这个（它会转达给发送方）
    let _ = ack_tx.send(ack.clone()).await;

    if !ack.ok {
        let _ = sink.abort(&ack.reason).await;
        anyhow::bail!("接收失败：{}", ack.reason);
    }
    debug!("接收完成 {}：{} 字节", meta.name, got_bytes);
    Ok(got_bytes)
}

// ---------------------------------------------------------------------------
// 构造元信息
// ---------------------------------------------------------------------------

/// 从数据算出 `FileMeta`（小文件用；大文件应流式算根哈希）。
pub fn meta_for_bytes(
    name: &str,
    mime: &str,
    data: &[u8],
    secret: &SecretKey,
    self_relay: &str,
) -> FileMeta {
    let root = hex_encode(&blake3::hash(data).as_bytes()[..]);
    FileMeta {
        file_id: new_file_id(),
        name: name.to_string(),
        size: data.len() as u64,
        mime: mime.to_string(),
        chunk_size: CHUNK_SIZE,
        root_hash: root,
        sender: secret.public().to_string(),
        sender_relay: self_relay.to_string(),
        ts: crate::room::now_ms(),
    }
}

/// 保存我方"正在进行的传输"的状态（供 UI 查询 / 断点续传）。
#[derive(Clone, Debug, Default)]
pub struct TransferRegistry {
    inner: Arc<std::sync::Mutex<Vec<TransferInfo>>>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub file_id: String,
    pub name: String,
    pub size: u64,
    /// "send" | "recv"
    pub direction: String,
    /// "pending" | "active" | "done" | "failed" | "rejected"
    pub state: String,
    pub done_chunks: u64,
    pub total_chunks: u64,
    pub received_bytes: u64,
    pub message: String,
}

impl TransferRegistry {
    pub fn upsert(&self, info: TransferInfo) {
        let mut v = self.inner.lock().unwrap();
        if let Some(x) = v.iter_mut().find(|x| x.file_id == info.file_id) {
            *x = info;
        } else {
            v.push(info);
        }
    }

    pub fn update<F: FnOnce(&mut TransferInfo)>(&self, file_id: &str, f: F) {
        let mut v = self.inner.lock().unwrap();
        if let Some(x) = v.iter_mut().find(|x| x.file_id == file_id) {
            f(x);
        }
    }

    pub fn get(&self, file_id: &str) -> Option<TransferInfo> {
        self.inner.lock().unwrap().iter().find(|x| x.file_id == file_id).cloned()
    }

    pub fn all(&self) -> Vec<TransferInfo> {
        self.inner.lock().unwrap().clone()
    }

    pub fn json(&self) -> String {
        serde_json::to_string(&self.all()).unwrap_or_else(|_| "[]".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filetransfer::{bitmap_get, bitmap_new, bitmap_set, chunk_count};

    #[test]
    fn source_reads_in_chunks() {
        let src = BytesSource {
            data: (0..100u8).collect(),
        };
        let rt = tokio_test_block(async {
            let a = src.read_chunk(0, 16).await.unwrap();
            let b = src.read_chunk(5, 16).await.unwrap();
            (a, b)
        });
        assert_eq!(rt.0.len(), 16);
        assert_eq!(rt.0[0], 0);
        assert_eq!(rt.1.len(), 16);
        assert_eq!(rt.1[0], 80);
    }

    /// 写进 BytesSink 并按块大小切分，返回是否校验通过。
    fn roundtrip_with_chunk_size(data: &[u8], chunk_size: u32) -> bool {
        let root = hex_encode(&blake3::hash(data).as_bytes()[..]);
        let sink = BytesSink {
            data: tokio::sync::Mutex::new(Vec::new()),
            size: data.len() as u64,
            root_hash: root,
            chunk_size,
        };
        tokio_test_block(async {
            for seq in 0..chunk_count(data.len() as u64, chunk_size) as u32 {
                let (s, e) = chunk_range(seq as usize, chunk_size, data.len() as u64);
                sink.write_chunk(seq, &data[s as usize..e as usize]).await.unwrap();
            }
            sink.finish().await.is_ok()
        })
    }

    #[test]
    fn sink_verifies_hash() {
        // 整块整除
        let data: Vec<u8> = (0..64u8).collect();
        assert!(roundtrip_with_chunk_size(&data, 16), "整除情况应通过");
    }

    #[test]
    fn sink_handles_partial_last_chunk() {
        // 最后一块不足 chunk_size（真实场景：10GB 文件最后一块几乎总是不足）
        let data: Vec<u8> = (0..70u8).collect();
        assert!(roundtrip_with_chunk_size(&data, 16), "末块不足时应通过");
        // 非 16 整除的块大小
        let data2: Vec<u8> = (0..100u8).collect();
        assert!(roundtrip_with_chunk_size(&data2, 7), "非整除块大小应通过");
    }

    #[test]
    fn sink_detects_wrong_chunk_offset() {
        // 故意用错块大小写盘 → 位置错乱 → 校验必须失败（防止"静默写坏文件"）
        let data: Vec<u8> = (0..64u8).collect();
        let root = hex_encode(&blake3::hash(&data).as_bytes()[..]);
        let sink = BytesSink {
            data: tokio::sync::Mutex::new(Vec::new()),
            size: data.len() as u64,
            root_hash: root,
            chunk_size: 8, // 与实际发送时的 16 不一致
        };
        let ok = tokio_test_block(async {
            for seq in 0..4u32 {
                let (s, e) = chunk_range(seq as usize, 16, 64);
                sink.write_chunk(seq, &data[s as usize..e as usize]).await.unwrap();
            }
            sink.finish().await.is_ok()
        });
        assert!(!ok, "块大小不一致时校验应当失败");
    }

    #[test]
    fn sink_rejects_wrong_hash() {
        let sink = BytesSink {
            data: tokio::sync::Mutex::new(Vec::new()),
            size: 16,
            root_hash: "deadbeef".into(),
            chunk_size: 16,
        };
        let ok = tokio_test_block(async {
            sink.write_chunk(0, &[0u8; 16]).await.unwrap();
            sink.finish().await.is_ok()
        });
        assert!(!ok, "哈希不符应当失败");
    }

    #[test]
    fn bitmap_helpers_used_here() {
        let mut bm = bitmap_new(3);
        bitmap_set(&mut bm, 1);
        assert!(bitmap_get(&bm, 1));
        assert!(!bitmap_get(&bm, 0));
    }

    /// 极简的"阻塞式跑异步"（测试里用，避免引入额外依赖）。
    fn tokio_test_block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }
}
