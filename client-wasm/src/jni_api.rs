//! Android JNI 桥 —— 把 `RoomNode` 暴露给 React Native
//!
//! ## 为什么走 JNI + JSON（三条路比较过）
//!
//! | 方案 | 问题 |
//! |---|---|
//! | uniffi | 体验最好，但要**新增依赖**；本项目构建全走 `--locked --offline`，加依赖要动 Cargo.lock |
//! | 复用 `agent serve` 行协议 | RN **不能 spawn 子进程**，整条路在手机上不存在 |
//! | **JNI + JSON**（本方案） | `jni` crate **已在依赖树里**（`rustls-platform-verifier` 带进来的 0.22.4）；边界只传 JSON 字符串 |
//!
//! ## ★ 事件投递用「阻塞式拉取」，不用 Rust→Java 回调
//!
//! 回调那条路要处理三件麻烦事：缓存 `JavaVM`、每个线程 attach/detach、
//! `GlobalRef` 生命周期 —— **这些在没有真机的情况下都无法验证**。
//!
//! 改成单向数据流：
//!
//! ```text
//!   转发线程 ──push──▶ VecDeque + Condvar ◀──pop(阻塞 ≤ timeoutMs)── Kotlin 协程
//! ```
//!
//! Kotlin 在 `Dispatchers.IO` 上循环调 `nativePollEvent(ptr, 200)`：
//! 有事件立刻返回，没有就阻塞到超时返回 null（**不空转、不烧电**）。
//! 延迟 = 事件到达时间，毫秒级，聊天场景完全无感。
//!
//! ## ★★ 线程模型（这里错了会很难查）
//!
//! - `RoomNode::start` 与后续所有调用都是 async 的，而 JNI 是同步的
//!   → 每个 Node 持有一个 **多线程 tokio 运行时**，用 `block_on` 驱动
//! - ⚠️ **运行时必须与 Node 同生命周期**。`room.rs` 里用的是
//!   `n0_future::task::spawn`，任务挂在**当前环境**的执行器上；
//!   runtime 一 drop，所有后台任务（心跳、gossip、中继重连）立刻消失 ——
//!   现象是"能进房但收不到任何消息"，且不报错。
//! - 所以 `NodeHandle` 里存 `Runtime`，只在 `nativeFree` 时随句柄一起释放。
//!
//! ## 与其它两个前端的关系（三端同一份核心）
//!
//! ```text
//!                  client-wasm/src/room.rs  ← RoomNode（唯一真源）
//!                 /          |           \
//!    wasm_api.rs          bin/agent.rs        jni_api.rs（本文件）
//!    （浏览器）            （CLI / serve）      （Android RN）
//! ```
//!
//! 三个适配层都只做"转格式"；签名 / gossip / 历史 / 传输全在 `room.rs`。
//! **改协议只改 room.rs，三端同时生效。**

#![cfg(any(target_os = "android", feature = "jni-bridge"))]

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JObject, JString};
use jni::strings::JNIString;
use jni::sys::{jboolean, jlong, jstring};
use jni::{jni_str, EnvUnowned};
use tokio::runtime::Runtime;

use crate::room::{RoomNode, RoomOptions};

/// 事件暂存队列：转发线程 push，Kotlin 侧 pop。
///
/// ⚠️ **不设上限**是有意的：聊天事件是用户可感知的数据，丢掉会变成
/// "消息偶发不出现"这种极难排查的问题。队列只有在 Kotlin 侧停止拉取时
/// （App 进后台）才会涨，每条是几百字节的 JSON，可以接受。
struct EventQueue {
    items: Mutex<VecDeque<String>>,
    cv: Condvar,
}

impl EventQueue {
    fn new() -> Self {
        Self {
            items: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
        }
    }

    fn push(&self, json: String) {
        if let Ok(mut q) = self.items.lock() {
            q.push_back(json);
            self.cv.notify_one();
        }
    }

    /// 阻塞到有事件或超时。None = 超时（调用方回头检查是否该退出）。
    fn pop_timeout(&self, timeout: Duration) -> Option<String> {
        let mut q = self.items.lock().ok()?;
        if q.is_empty() {
            let (guard, _) = self.cv.wait_timeout(q, timeout).ok()?;
            q = guard;
        }
        q.pop_front()
    }
}

struct NodeHandle {
    /// ⚠️ 字段顺序有意义：Rust 按声明顺序 drop。
    ///    runtime 必须在 node **之后**释放（node 的任务跑在它上面）。
    ///    实际上两者都在 `nativeFree` 里显式处理，这里保持顺序只为表意清晰。
    runtime: Option<Runtime>,
    node: Arc<RoomNode>,
    queue: Arc<EventQueue>,
    stop: Arc<Mutex<bool>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl NodeHandle {
    fn rt(&self) -> Result<&Runtime> {
        self.runtime.as_ref().context("运行时已释放")
    }
}

/// 从 Java 的 `long` 还原句柄引用（不取所有权）
unsafe fn handle_ref<'a>(ptr: jlong) -> Option<&'a NodeHandle> {
    if ptr == 0 {
        return None;
    }
    Some(&*(ptr as *const NodeHandle))
}

/// 把闭包放进 jni 0.22 的 `with_env`（拿到可用 `Env`），错误按策略抛 RuntimeException。
///
/// ⚠️ jni 0.22 起，native 方法首参是 `EnvUnowned`（只是一个裸 JNIEnv 指针），
///    直接调 `new_string/throw_new/get_string` 都不存在 —— 必须先 `with_env`。
///    闭包返回 `Err`/panic 时由 `ThrowRuntimeExAndDefault` 统一抛给 Kotlin。
fn ret_str(env: &mut EnvUnowned<'_>, s: String) -> jstring {
    env.with_env(|e| -> std::result::Result<jstring, jni::errors::Error> {
        Ok(match e.new_string(s) {
            Ok(js) => js.into_raw(),
            // 与原实现一致：建串失败返回 null、不抛（例如 OOM 场景）
            Err(_) => std::ptr::null_mut(),
        })
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

/// 统一错误出口：抛 Java 异常（Kotlin 侧 try/catch）。
///
/// 比"返回错误码"更难被漏判 —— 返回码很容易被静默忽略。
fn throw(env: &mut EnvUnowned<'_>, msg: &str) -> jstring {
    throw_void(env, msg);
    std::ptr::null_mut()
}

/// `jlong` 版的 throw
fn thrown_long(env: &mut EnvUnowned<'_>, msg: &str) -> jlong {
    throw_void(env, msg);
    0
}

/// 只抛异常、不关心返回值（`nativeStartEvents` / `nativeJoin` 等中间错误点用）。
fn throw_void(env: &mut EnvUnowned<'_>, msg: &str) {
    let _ = env
        .with_env(|e| -> std::result::Result<(), jni::errors::Error> {
            // 0.22 的 throw_new 要 `Desc<JClass>` + `AsRef<JNIStr>`：
            // 类名用编译期 `jni_str!`，动态消息包成 `JNIString`。
            e.throw_new(
                jni_str!("java/lang/RuntimeException"),
                JNIString::from(msg),
            )
        })
        .resolve::<ThrowRuntimeExAndDefault>();
}

fn read_jstring(env: &mut EnvUnowned<'_>, s: &JString<'_>) -> Result<String> {
    // 读失败返回 None（而不是让 resolve 抛），保持原语义：
    // 由调用方统一 throw("读参数失败")。get_string 失败时 JVM 里不会有挂起异常。
    // （0.22 起 `Env::get_string` 已废弃，用 `JString::mutf8_chars`。）
    let value: Option<String> = env
        .with_env(|e| -> std::result::Result<Option<String>, jni::errors::Error> {
            Ok(s.mutf8_chars(e).ok().map(String::from))
        })
        .resolve::<ThrowRuntimeExAndDefault>();
    value.context("读 Java 字符串失败")
}

// ===========================================================================
// 生命周期
// ===========================================================================

/// 建节点。`opts_json` = `RoomOptions` 的 JSON（与浏览器侧同构）。
/// 返回句柄；失败抛异常并返回 0。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeCreate(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    opts_json: JString<'_>,
) -> jlong {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<jlong> {
        let raw = read_jstring(&mut env, &opts_json)?;
        let opts: RoomOptions =
            serde_json::from_str(&raw).with_context(|| format!("RoomOptions 解析失败：{raw}"))?;

        // 多线程运行时：iroh 的 endpoint / gossip / 心跳都会 spawn 到这上面。
        // **不能 drop**（见文件头「线程模型」）。
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("iroh-node")
            .build()
            .context("建 tokio runtime 失败")?;

        let node = rt
            .block_on(async { RoomNode::start(opts).await })
            .context("RoomNode::start 失败")?;

        let handle = Box::new(NodeHandle {
            runtime: Some(rt),
            node: Arc::new(node),
            queue: Arc::new(EventQueue::new()),
            stop: Arc::new(Mutex::new(false)),
            thread: None,
        });
        Ok(Box::into_raw(handle) as jlong)
    }));

    match r {
        Ok(Ok(ptr)) => ptr,
        Ok(Err(e)) => thrown_long(&mut env, &format!("{e:#}")),
        Err(_) => thrown_long(&mut env, "nativeCreate 发生 panic"),
    }
}

/// 启动事件转发。**必须在 nativeJoin 之前调用** ——
/// `joined` / `history` 在 join 返回前就产生，晚了会全丢
/// （TS 侧刚踩过一次，见 mobile/src/bridge/useRoom.ts 的注释）。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeStartEvents(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
) -> jboolean {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        throw_void(&mut env, "节点未创建");
        return false;
    };
    if h.rt().is_err() {
        throw_void(&mut env, "运行时已释放");
        return false;
    }

    let node = Arc::clone(&h.node);
    let queue = Arc::clone(&h.queue);
    let stop = Arc::clone(&h.stop);

    let spawned = std::thread::Builder::new()
        .name("iroh-events".into())
        .spawn(move || {
            // ⚠️ `subscribe()` 是**同步**的（返回 async_channel::Receiver），
            //    不需要 runtime 上下文 —— 早先版本用 block_on 包它是多余的。
            let events = node.subscribe();

            // ⚠️ **不要用 `recv_blocking()`**：它没有超时版本，会一直阻塞，
            //    而 `nativeFree` 要 `join` 这个线程 → **死锁**。
            //    （async-channel 2.5 只提供 try_recv / recv_blocking，
            //      没有带 timeout 的阻塞收。）
            //    改用「try_recv + 短睡」：50ms 一轮，对聊天完全够，
            //    且每轮都能看到 stop 旗标，退出及时。
            loop {
                if stop.lock().map(|s| *s).unwrap_or(true) {
                    break;
                }
                match events.try_recv() {
                    Ok(ev) => {
                        match serde_json::to_string(&ev) {
                            Ok(json) => queue.push(json),
                            // 序列化失败只丢这一条，不中断转发
                            Err(e) => tracing::warn!("事件序列化失败（丢弃）：{e}"),
                        }
                        // 有事件时不睡：把积压的一条条尽快倒出来
                        continue;
                    }
                    Err(async_channel::TryRecvError::Empty) => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    // channel 关了 = 节点已释放
                    Err(async_channel::TryRecvError::Closed) => break,
                }
            }
        })
        .ok();

    // thread 只在启动时写一次
    let h = unsafe { &mut *(ptr as *mut NodeHandle) };
    h.thread = spawned;
    true
}

/// 取一条事件 JSON；最多阻塞 `timeoutMs` 毫秒。无事件返回 null（**不是错误**）。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativePollEvent(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
    timeout_ms: jlong,
) -> jstring {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        return throw(&mut env, "节点未创建");
    };
    // 负数当 0（立即返回）；上限 5s，防止误传大值把 IO 线程挂死
    let ms = timeout_ms.clamp(0, 5000) as u64;
    match h.queue.pop_timeout(Duration::from_millis(ms)) {
        Some(json) => ret_str(&mut env, json),
        None => std::ptr::null_mut(),
    }
}

// ===========================================================================
// 查询
// ===========================================================================

#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeEndpointId(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
) -> jstring {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        return throw(&mut env, "节点未创建");
    };
    ret_str(&mut env, h.node.endpoint_id())
}

#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeRelayStatus(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
) -> jstring {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        return throw(&mut env, "节点未创建");
    };
    let json = serde_json::to_string(&h.node.relay_status()).unwrap_or_else(|_| "[]".into());
    ret_str(&mut env, json)
}

// ===========================================================================
// 动作（同步阻塞在 IO 线程上，别在主线程调）
// ===========================================================================

#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeOnline(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
) {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        throw_void(&mut env, "节点未创建");
        return;
    };
    match h.rt() {
        Ok(rt) => rt.block_on(async { h.node.online().await }),
        Err(e) => {
            throw_void(&mut env, &format!("{e:#}"));
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeJoin(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
    room: JString<'_>,
    nickname: JString<'_>,
) {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        throw_void(&mut env, "节点未创建");
        return;
    };
    let (Ok(room), Ok(nick)) = (read_jstring(&mut env, &room), read_jstring(&mut env, &nickname))
    else {
        throw_void(&mut env, "读参数失败");
        return;
    };
    let Ok(rt) = h.rt() else {
        throw_void(&mut env, "运行时已释放");
        return;
    };
    if let Err(e) = rt.block_on(async { h.node.join(&room, &nick).await }) {
        throw_void(&mut env, &format!("进房失败：{e:#}"));
    }
}

#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeSend(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
    text: JString<'_>,
) -> jstring {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        return throw(&mut env, "节点未创建");
    };
    let Ok(text) = read_jstring(&mut env, &text) else {
        return throw(&mut env, "读 text 失败");
    };
    let Ok(rt) = h.rt() else {
        return throw(&mut env, "运行时已释放");
    };
    match rt.block_on(async { h.node.send(&text).await }) {
        Ok(m) => ret_str(&mut env, m.id),
        Err(e) => throw(&mut env, &format!("发送失败：{e:#}")),
    }
}

#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeSetNickname(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
    nickname: JString<'_>,
) {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        throw_void(&mut env, "节点未创建");
        return;
    };
    if let Ok(nick) = read_jstring(&mut env, &nickname) {
        h.node.set_nickname(&nick);
    }
}

#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeLeaveRoom(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
) {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        throw_void(&mut env, "节点未创建");
        return;
    };
    if let Ok(rt) = h.rt() {
        rt.block_on(async { h.node.leave_room().await });
    }
}

/// 拉历史：返回 `HistoryResponse` 的 JSON（含 `messages` 与可选 `snapshot`）。
///
/// `beforeTs` / `beforeId` 是本项目历史游标：**`before = Some(ts)` 时返回更早的消息**
/// （见 `room.rs` 的 `fetch_history_before`）。`beforeTs < 0` = 取最新一页。
/// 两者要一起给（游标是 `(ts, id)` 复合键）。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeFetchHistory(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
    room: JString<'_>,
    limit: jlong,
    before_ts: jlong,
    before_id: JString<'_>,
) -> jstring {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        return throw(&mut env, "节点未创建");
    };
    let Ok(room) = read_jstring(&mut env, &room) else {
        return throw(&mut env, "读 room 失败");
    };
    let before_id = read_jstring(&mut env, &before_id).unwrap_or_default();
    let before = if before_ts < 0 {
        None
    } else {
        Some((before_ts as u64, before_id))
    };
    let Ok(rt) = h.rt() else {
        return throw(&mut env, "运行时已释放");
    };

    match rt.block_on(async {
        h.node
            .fetch_history_before(&room, limit.max(1) as usize, before)
            .await
    }) {
        Ok(resp) => match serde_json::to_string(&resp) {
            Ok(json) => ret_str(&mut env, json),
            Err(e) => throw(&mut env, &format!("历史序列化失败：{e}")),
        },
        Err(e) => throw(&mut env, &format!("拉历史失败：{e:#}")),
    }
}

#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeShutdown(
    _env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
) {
    if let Some(h) = unsafe { handle_ref(ptr) } {
        h.node.shutdown();
    }
}

/// 释放句柄（幂等：传 0 直接返回）。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeFree(
    _env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
) {
    if ptr == 0 {
        return;
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut handle = unsafe { Box::from_raw(ptr as *mut NodeHandle) };

        // ① 先让转发线程退出（否则它会往即将释放的队列里写）
        if let Ok(mut s) = handle.stop.lock() {
            *s = true;
        }
        handle.queue.cv.notify_all(); // 唤醒正在 wait_timeout 的拉取者
        if let Some(t) = handle.thread.take() {
            let _ = t.join();
        }

        // ② 停掉节点自身的任务
        handle.node.shutdown();

        // ③ **最后**才 drop runtime —— node 的任务跑在它上面
        handle.runtime = None;
        drop(handle);
    }));
}
