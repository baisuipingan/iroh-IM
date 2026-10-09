//! iroh-web：自建中继舰队上的浏览器/原生 iroh 端点。
//!
//! - `node`：点对点的诊断用节点（relay-probe 用）
//! - `room`：群聊房间（iroh-gossip，topic = 房间；消息 ed25519 签名；历史走常驻节点）
//! - `filetransfer`：P2P 文件传输协议（控制面走 gossip，数据面走独立 QUIC 流）
//! - `transfer_orchestrator`：传输编排（`ChunkSource`/`ChunkSink` 抽象，浏览器与原生共用）
//! - `wasm_api`（feature = wasm）：暴露给浏览器 JS
//! - `bin/roomd`（feature = cli）：常驻节点，做历史 / 在线状态 / 房间锚点

pub mod filetransfer;
pub mod transfer_orchestrator;
pub mod node;
pub mod room;
/// 历史存储的 SQLite 后端（**仅原生** roomd）。
///
/// ⚠️ 必须 `cfg` 掉 wasm：`rusqlite` 是 optional 依赖，只在 `cli` feature 下启用，
///    而 wasm 构建用的是默认 feature。浏览器端不需要历史存储
///    （历史由常驻节点提供），所以这里整个模块在 wasm 下不存在。
#[cfg(all(not(target_arch = "wasm32"), feature = "cli"))]
pub mod sqlite_history;
pub mod sigfmt;

#[cfg(feature = "wasm")]
mod wasm_api;
#[cfg(feature = "wasm")]
pub use wasm_api::{RoomNode, WebNode};

/// Android JNI 桥：把 `RoomNode` 暴露给 React Native。
///
/// 编译条件：**Android target**（正式构建）或 **`jni-bridge` feature**
/// （在 macOS/Linux 上做纯类型检查，不需要 NDK —— 见 Cargo.toml 的注释）。
///
/// 与 `wasm_api`（浏览器）、`bin/agent.rs`（CLI）并列的**第三个适配层**：
/// 三者都只做"转格式"，协议本体全在 `room.rs`。
#[cfg(any(target_os = "android", feature = "jni-bridge"))]
pub mod jni_api;
