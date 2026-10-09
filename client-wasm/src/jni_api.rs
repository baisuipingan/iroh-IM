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

/* ============================================================================
 * ★★ Android Context 初始化 —— 不做这一步，真机上会 SIGABRT
 *
 * ## 现象（真机实测，非常难猜）
 *
 * App 装上能启动、`.so` 加载成功、`nativeCreate` 也调到了，然后**立刻崩溃**：
 *
 *     Abort message: 'android context was not initialized'
 *     #26 Java_…_IrohNative_nativeCreate+356
 *     signal 6 (SIGABRT)
 *
 * 崩溃栈里看不出任何关于 DNS / TLS 的线索 —— 很像是 iroh 内部的问题。
 *
 * ## 根因
 *
 * 依赖树里有两个东西**需要通过 JNI 拿到 Android 的 JavaVM 和 Context**：
 *
 *   1. `n0-dns-resolver`（iroh 的 DNS）：用 JNI 读系统的 DNS 配置
 *      （`ConnectivityManager.getLinkProperties`）来决定用哪些 nameserver
 *   2. `rustls-platform-verifier`：用 Android 系统信任库做 TLS 校验
 *
 * 两者都从 `ndk_context::android_context()` 取指针，而这个全局量**必须有人初始化**。
 * 上游文档写得很明确（n0-dns-resolver/src/system_config/android.rs）：
 *
 *   > Release builds let the panic propagate; uninitialized `ndk_context`
 *   > in production is a programming error and should surface loudly.
 *
 * 也就是说这不是"缺个可选优化"，而是**必须做的一步**。
 *
 * ## 为什么不能用 `JNI_OnLoad` 一步到位
 *
 * 上游文档给的示例是 `JNI_OnLoad(vm, res)` 里直接用 `res` 当 Context。
 * 但 `res` 是给 `JNI_OnLoad` 的**附加参数**，在 Android 上由
 * `System.loadLibrary` 触发时**是 NULL** —— 真拿它当 Context 会拿到空指针。
 *
 * 所以这里拆成两步（这也是各家 Android + JNI 项目的通行做法）：
 *
 *     Java/Kotlin 侧 System.loadLibrary("iroh_web")
 *        → JNI_OnLoad(vm, res)            ← 只存 JavaVM（vm 是真有的）
 *        → Kotlin 调 nativeInitContext(ctx)  ← Kotlin 提供真 Context
 *              → 此时两个全局量齐了，iroh 可以安全建节点
 *
 * ⚠️ Kotlin 侧**必须在 `nativeCreate` 之前**调 `nativeInitContext`，
 *    否则又会退回到 "android context was not initialized"。
 * ==========================================================================*/

/// `JNI_OnLoad`：库加载时由 JVM 调用，只做一件事 —— 记住 JavaVM。
///
/// ⚠️ `res` 在 Android 上通常为 NULL，**不要拿它当 Context**（见上方注释）。
///
/// ⚠️⚠️ 签名里的坑：`jni::sys::JavaVM` **本身已经是指针**
///      （`pub type JavaVM = *const JNIInvokeInterface_`）。
///      JNI 规范传进来的参数是 `JavaVM*`，也就是"指向这个指针类型的东西" ——
///      所以形参必须写 `JavaVM`（不带 `*mut`），写 `*mut JavaVM` 就多了一层。
///
/// # Safety
/// 由 JVM 调用，`vm` 保证有效。
#[allow(non_snake_case)]
#[no_mangle]
pub extern "system" fn JNI_OnLoad(
    vm: jni::sys::JavaVM,
    _res: *mut std::ffi::c_void,
) -> jni::sys::jint {
    // 只存指针，不解引用 —— 保存 JavaVM 供后续 `nativeInitContext` 使用。
    //
    // 用 AtomicUsize 存而不是 static mut：`JNI_OnLoad` 之后会被
    // Kotlin 协程线程读，裸 `static mut` 是 UB。
    JAVA_VM_PTR.store(vm as usize, std::sync::atomic::Ordering::Release);

    // 尽早把日志接到 logcat —— 之后所有 iroh 的输出才看得见
    init_android_logging();
    tracing::info!("libiroh_web 已加载（JNI_OnLoad 完成，日志已接 logcat）");

    jni::sys::JNI_VERSION_1_6
}

/// JavaVM 指针（由 `JNI_OnLoad` 写入）。
static JAVA_VM_PTR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/* ============================================================================
 * ★ 日志桥接到 logcat
 *
 * **为什么必须做这件事**：没有它，`adb logcat` 里**看不到任何 Rust 侧输出** ——
 * iroh 连中继失败、鉴权被拒、DNS 解析异常，全都静默无闻。
 * 这一点在真机调试时反复咬人：服务端一切正常，App 却一直"正在连接中继"，
 * 而**没有任何一处能告诉你为什么**。
 *
 * ## ⚠️ 一个实测踩过的错误假设
 *
 * 第一版我写了 `tracing_subscriber::fmt()` 用**默认 writer**（即 stdout），
 * 理由是"Android 上 stdout 会被转进 logcat"。
 * **实测不成立** —— 装到真机后 logcat 里一个字都没有，
 * `adb logcat -s stdout` 也是空的。
 *
 * 所以这里**显式调用 libc 的 `__android_log_write`**（`<android/log.h>`，
 * 由 Android 的 libc 直接提供，**不需要新增任何 crate**）。
 * ==========================================================================*/

/// logcat 里的 tag（`adb logcat -s iroh_web` 就能只看我们）
const LOGCAT_TAG: &str = "iroh_web";

/// 日志是否已初始化（避免重复装 subscriber）
static LOG_INIT: std::sync::Once = std::sync::Once::new();

unsafe extern "C" {
    /// Android libc 提供的日志写入（声明即可，链接时自动解析）
    fn __android_log_write(prio: i32, tag: *const u8, text: *const u8) -> i32;
}

/// ANDROID_LOG_INFO / ERROR
const ANDROID_LOG_INFO: i32 = 4;
const ANDROID_LOG_ERROR: i32 = 6;

/// 把一行写到 logcat（CString 处理内嵌 NUL 的问题）
fn logcat(prio: i32, msg: &str) {
    // 带 NUL 结尾；消息里若含 NUL 会被截断 —— 我们自己拼的串不含
    let Ok(cmsg) = std::ffi::CString::new(msg) else {
        return;
    };
    let Ok(ctag) = std::ffi::CString::new(LOGCAT_TAG) else {
        return;
    };
    // SAFETY: 两个指针都指向有效的 NUL 结尾 C 串，且在调用期间存活
    unsafe {
        __android_log_write(prio, ctag.as_ptr() as *const u8, cmsg.as_ptr() as *const u8);
    }
}

/// `MakeWriter`：把 `tracing` 的输出重定向到 logcat。
///
/// 不用 `android_logger` crate —— 那要改 Cargo.lock，而 libc 这个函数
/// 本来就能直接用。
struct LogcatWriter;

impl std::io::Write for LogcatWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // tracing 会分多次 write（前缀 / 消息 / 换行），这里逐块转；
        // 用 lossy 避免非法 UTF-8 直接吞掉整条日志
        logcat(ANDROID_LOG_INFO, &String::from_utf8_lossy(buf));
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// 供 `tracing_subscriber::fmt().with_writer(...)` 用的构造函数
fn logcat_writer() -> LogcatWriter {
    LogcatWriter
}

/// 初始化 Rust 侧日志 → logcat。幂等。
fn init_android_logging() {
    LOG_INIT.call_once(|| {
        #[cfg(debug_assertions)]
        let level = tracing::level_filters::LevelFilter::TRACE;
        #[cfg(not(debug_assertions))]
        let level = tracing::level_filters::LevelFilter::DEBUG;

        let ok = tracing_subscriber::fmt()
            .with_max_level(level)
            .with_writer(logcat_writer) // ★ 关键：写入 logcat，不是 stdout
            .without_time() // logcat 自带时间戳
            .with_ansi(false) // logcat 不解析 ANSI 转义
            .try_init()
            .is_ok();

        // 用裸 logcat 报一句，避免"日志系统自己没起来"时彻底静默
        logcat(
            ANDROID_LOG_INFO,
            if ok {
                "[iroh_web] 日志已接入 logcat"
            } else {
                "[iroh_web] 日志 subscriber 已存在（跳过）"
            },
        );
    });
}

/// 供 Kotlin 调用的初始化：把 Application Context 交给 Rust。
///
/// Kotlin 侧这样调（**必须在 `nativeCreate` 之前**）：
///
/// ```kotlin
/// object IrohNative {
///     init { System.loadLibrary("iroh_web") }   // 触发 JNI_OnLoad
///     /** [appContext] 传 `context.applicationContext`（别传 Activity） */
///     fun initContext(appContext: android.content.Context) = nativeInitContext(appContext)
/// }
/// ```
///
/// # 为什么用 `applicationContext` 而不是 Activity
///
/// Activity 会被销毁重建、指针随即失效；而 `ndk_context` 的约定是
/// **两个指针必须活到进程结束**（见上游 Safety 注释）。
/// Application 是进程级的，正好满足。
///
/// # 为什么直接调 `ndk_context` 而不是 `iroh::dns::install_android_jni_context`
///
/// iroh 的那个重导出带 `#[cfg(any(target_os = "android", doc))]` ——
/// **在 macOS/Linux 上根本不存在**，用它就等于放弃"本机能做类型检查"
/// （一试就知道：报 `cannot find function ... in module iroh::dns`）。
///
/// 而 `ndk_context::initialize_android_context` 没有 cfg 限制，
/// 本机就能编过 —— 这让我们能在**没有真机**的情况下也挡住笔误。
///
/// 两者做的是同一件事（iroh 的实现也只是转调 `n0_dns_resolver`，
/// 最终同样落到 `ndk_context`），所以直接调不损失任何东西。
///
/// # Safety
/// 由 JNI 调用；`context` 必须是有效的 Android `Context`。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeInitContext(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    context: JObject<'_>,
) {
    // ⚠️ 错误要用 `jni::errors::Error`（`ThrowRuntimeExAndDefault` 只认
    //    `std::error::Error`，而 `anyhow::Error` 没实现它 —— 试过，编不过）。
    //    需要自定义文案时走下面的 `err_to_msg` 兜底。
    let vm_ptr = JAVA_VM_PTR.load(std::sync::atomic::Ordering::Acquire);
    if vm_ptr == 0 {
        throw_void(
            &mut env,
            "JNI_OnLoad 未被调用（JavaVM 指针为空）—— 检查 System.loadLibrary(\"iroh_web\") 是否已执行",
        );
        return;
    }

    // 固定 Context 引用 + 注入（都在 with_env 里做，避免把裸 Env 泄漏到外面）
    let outcome = env.with_env(|e| -> std::result::Result<(), jni::errors::Error> {
        // 用 GlobalRef 固定住 Context：局部引用在 JNI 调用返回后即失效，
        // 而 ndk_context 要求它活到**进程结束**。
        let global = e.new_global_ref(&context)?;
        let ctx_ptr = global.as_raw() as *mut std::ffi::c_void;

        // ⚠️ 必须交出去（forget），不能让它 drop —— 否则引用计数归零，
        //    iroh 之后用这个指针会拿到悬垂引用。这是 ndk_context 的
        //    设计约定：指针活到进程结束。故意泄漏，且只初始化一次。
        std::mem::forget(global);

        // 记两条日志：一条在注入前（万一后面 panic，知道走到哪了），
        // 一条在注入后（成功）。logcat 里靠它确认注入是否真的发生。
        tracing::info!("nativeInitContext 开始（准备注入 Application Context）");

        // 这一句之后，iroh 的 DNS 与 reqwest 的 TLS 校验都能拿到 Android 上下文。
        //
        // ⚠️ 真实 API 就是这一个函数 —— 它内部 `assert!(previous.is_none())`，
        //    **重复调用会 panic**。Kotlin 侧保证只调一次（IrohNative 的 init 块）。
        unsafe {
            ndk_context::initialize_android_context(vm_ptr as *mut std::ffi::c_void, ctx_ptr);
        }

        tracing::info!("Android context 已注入（iroh DNS + reqwest TLS 可用）");
        Ok(())
    });

    // VM 指针为 0 时上面已 return；其余错误（如 new_global_ref 失败）
    // 由 resolve 抛出 RuntimeException 给 Kotlin。
    let _ = outcome.resolve::<ThrowRuntimeExAndDefault>();
}

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
        Ok(Ok(ptr)) => {
            tracing::info!("nativeCreate 成功，句柄={ptr}");
            ptr
        }
        Ok(Err(e)) => {
            // ★ 建节点失败的原因**必须**落在 logcat 里。
            //   这一句是排查"连不上中继"时最有用的一条 —— 之前完全静默。
            let msg = format!("{e:#}");
            logcat(ANDROID_LOG_ERROR, &format!("[iroh_web] nativeCreate 失败：{msg}"));
            tracing::error!("nativeCreate 失败：{msg}");
            thrown_long(&mut env, &msg)
        }
        Err(_) => {
            logcat(ANDROID_LOG_ERROR, "[iroh_web] nativeCreate 发生 panic");
            thrown_long(&mut env, "nativeCreate 发生 panic")
        }
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

/* ===========================================================================
 * 文件接收
 *
 * 设计参考 `bin/agent.rs` 的 `serve_do_accept_file` / `serve_receive_file`
 * —— 那条路已经跑通（CLI 用同一套 Rust 核心接收文件到磁盘）。
 *
 * ## 与 agent / wasm 的差异只有一处：落盘目标由 **fd** 传入
 *
 * Android 10+ 往公共目录写文件必须走 MediaStore，它只给 `Uri`/文件描述符，
 * **没有可用的文件系统路径**。所以 `FileSink::from_file` 从已打开的句柄构造
 * （见 transfer_orchestrator.rs 的说明）。
 *
 * ## 为什么 meta 由 JS 传进来，而不是在 Rust 侧缓存邀约
 *
 * agent.rs 维护了一份 `Invites` 缓存（收到 `FileInvite` 时存下，accept 时取用）。
 * 这里**不这么做**，原因有两条：
 *
 * 1. JS 侧本来就有 meta —— `fileInvite` 事件里带着完整 `meta`，
 *    UI 渲染文件名/大小用的就是它（`FileCard`）。让 JS 原样传回，
 *    比在 Rust 侧再存一份、还要处理缓存失效与淘汰，简单得多。
 * 2. **单一真相源**：两份缓存迟早不同步（JS 显示的和 Rust 接受的可能是
 *    不同版本的 meta）。让 accept 用 JS 手里那一份，就不会出现
 *    "界面显示 A、实际按 B 校验"这种极难排查的错位。
 *
 * `accept_file` 内部仍会校验 meta 与 file_id 一致、走 `validate_meta`、
 * 以及房间匹配 —— 传进来的 meta **不是**无条件的信任输入。
 * ========================================================================*/

/// 接收一个文件到给定的 fd。
///
/// `fd` 由 Kotlin 侧从 `MediaStore.openFileDescriptor("rw")` 取来。
/// **本函数接管它的所有权**（`File::from_raw_fd`），成功失败都会在结束时关闭
/// —— Kotlin 侧**不要**再关一次（会 double-close）。
///
/// 阻塞直到收完（310 MB 这种可能几十秒到几分钟）→ 必须挂 IO 线程。
///
/// 返回收到的字节数（字符串）；失败抛异常。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeAcceptFile(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
    file_id: JString<'_>,
    meta_json: JString<'_>,
    room: JString<'_>,
    fd: jni::sys::jint,
) -> jstring {
    // ⚠️ **第一件事就是接管 fd**，早于任何参数校验。
    //
    // 为什么顺序重要：下面每一条 `return throw(...)` 都是一次提前退出。
    // 如果接管放在校验之后，那么"节点未创建""读参数失败""运行时已释放"
    // 这几条路径下那个 fd 就**永远不会被关闭** —— 每失败一次泄漏一个，
    // 几十次后进程里 `open` 直接 EMFILE。
    //
    // 反过来，先把所有权收进来，`file` 就是本函数的局部变量，
    // **任何**提前 return（包括 panic 展开）都会走它的 Drop 把 fd 关掉。
    //
    // SAFETY: `fd` 由 Kotlin 侧从 ParcelFileDescriptor 取得并已 detach
    //（保证没有别人会关它）；由此处起由本 File 独占。
    let file = if fd >= 0 {
        use std::os::fd::FromRawFd;
        Some(unsafe { std::fs::File::from_raw_fd(fd) })
    } else {
        None
    };

    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        return throw(&mut env, "节点未创建");
    };
    let (Ok(file_id), Ok(meta_json), Ok(room)) = (
        read_jstring(&mut env, &file_id),
        read_jstring(&mut env, &meta_json),
        read_jstring(&mut env, &room),
    ) else {
        return throw(&mut env, "读取参数失败");
    };
    let Some(file) = file else {
        return throw(&mut env, "无效的文件描述符");
    };
    let Ok(rt) = h.rt() else {
        return throw(&mut env, "运行时已释放");
    };

    let result: Result<u64> = rt.block_on(async {
        let meta: crate::filetransfer::FileMeta = serde_json::from_str(&meta_json)
            .with_context(|| format!("邀约元信息解析失败：{meta_json}"))?;
        let my_relay = h
            .node
            .my_relay_url()
            .context("本端还没有可用中继地址")?;

        // ⚠️ 先登记（`accept_file` 内部 expect）**再**广播 Accept ——
        //    顺序不能反，否则对端立刻开始发数据时我们还没准备好接收，
        //    那些块会直接丢（agent.rs 里有同样的注释）。
        let (rx, ack_tx) = h
            .node
            .accept_file(&file_id, &meta_json, Vec::new(), &my_relay, &room)
            .await
            .context("登记/广播 Accept 失败")?;

        let sink = std::sync::Arc::new(crate::transfer_orchestrator::FileSink::from_file(
            file,
            &meta,
            format!("{}({} 字节)", meta.name, meta.size),
        ));

        h.node
            .receive_file_data(&meta, sink, rx, ack_tx, |done, total, bytes| {
                tracing::debug!("接收进度 {done}/{total}（{bytes} 字节）");
            })
            .await
    });

    match result {
        Ok(bytes) => {
            tracing::info!("文件接收完成：{file_id}（{bytes} 字节）");
            ret_str(&mut env, bytes.to_string())
        }
        Err(e) => {
            let msg = format!("{e:#}");
            logcat(ANDROID_LOG_ERROR, &format!("[iroh_web] 文件接收失败：{msg}"));
            throw(&mut env, &msg)
        }
    }
}

/// 拒绝接收某个文件。
///
/// `room` **必填**：`Reject` 会带自由文本理由广播，
/// 发错房间等于向无关的人泄露"我为什么不要这个文件"。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativeRejectFile(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
    file_id: JString<'_>,
    reason: JString<'_>,
    room: JString<'_>,
) {
    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        throw_void(&mut env, "节点未创建");
        return;
    };
    let (Ok(file_id), Ok(reason), Ok(room)) = (
        read_jstring(&mut env, &file_id),
        read_jstring(&mut env, &reason),
        read_jstring(&mut env, &room),
    ) else {
        throw_void(&mut env, "读取参数失败");
        return;
    };
    let Ok(rt) = h.rt() else {
        throw_void(&mut env, "运行时已释放");
        return;
    };
    if let Err(e) = rt.block_on(async { h.node.reject_file(&file_id, &reason, &room).await }) {
        let msg = format!("拒绝接收失败：{e:#}");
        tracing::warn!("{msg}");
        throw_void(&mut env, &msg);
    }
}

/* ===========================================================================
 * 文件发送
 *
 * 参考 `bin/agent.rs` 的 `serve_do_send_file` / `serve_start_push` ——
 * 那条路已经跑通（CLI 用同一套核心发文件）。
 *
 * ## 为什么分成两步（publish + push），而不是一个方法搞定
 *
 * 文件发送**天然是异步的两段**，中间隔着"对方什么时候点接收"：
 *
 *   ① publish：算哈希 → 造 meta → 广播邀约（`invite_file`）
 *   ② push：收到对方的 `FileAccepted` 事件后，才拨号把数据推过去
 *
 * ②的触发点是**事件**（`fileAccepted`），不是调用方的动作 ——
 * 所以不可能塞进一个阻塞方法里。这里暴露成两个 JNI 方法：
 * `nativePublishFile` 由用户点"发送"时调；
 * `nativePushFile` 由 Kotlin 侧在收到 `fileAccepted` 事件时调。
 *
 * ## 货架（shelf）：谁记得"我有哪些文件能发"
 *
 * push 时需要 meta（root_hash / chunk_size…）和 fd。两者都在 publish 时
 * 拿到过 —— 存在 `RoomNode` 里会污染核心库（它不该知道 Android 概念），
 * 所以放在 Kotlin 侧（`FileShelf`），push 时再传下来。
 * ========================================================================*/

/// 发布一个文件（广播邀约）。**不发送数据** —— 等对方点接收。
///
/// `fd` 由 Kotlin 侧从 SAF 的 `openFileDescriptor` 取来。
/// **本函数不接管它**（只是读一下算哈希）—— 调用方负责关。
///
/// 阻塞直到哈希算完（大文件几十秒）→ 必须挂 IO 线程。
///
/// 返回 `FileMeta` 的 JSON（Kotlin/JS 存进"货架"，push 时再传回来）。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativePublishFile(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
    fd: jni::sys::jint,
    name: JString<'_>,
    mime: JString<'_>,
) -> jstring {
    // 先接管 fd（同 nativeAcceptFile：放在所有提前 return 之前，避免泄漏）。
    //
    // ⚠️ 与 acceptFile 语义一致：**本函数负责关闭它**。
    //    Kotlin 侧用 detachFd() 交出所有权，别自己再关。
    //
    //    为什么 publish 也需要 fd：要先流式算 blake3 才能造 meta。
    //    push 时**另开一个 fd**（SAF 的 Uri 可以重复 open）——
    //    两个阶段各自管好自己那个，比"借来借去 + ManuallyDrop"清楚得多。
    let file = if fd >= 0 {
        use std::os::fd::FromRawFd;
        Some(unsafe { std::fs::File::from_raw_fd(fd) })
    } else {
        None
    };

    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        return throw(&mut env, "节点未创建");
    };
    let (Ok(name), Ok(mime)) = (
        read_jstring(&mut env, &name),
        read_jstring(&mut env, &mime),
    ) else {
        return throw(&mut env, "读取参数失败");
    };
    let Some(mut file) = file else {
        return throw(&mut env, "无效的文件描述符");
    };
    let Ok(rt) = h.rt() else {
        return throw(&mut env, "运行时已释放");
    };

    let result: Result<String> = rt.block_on(async {
        let room = h.node.current_room().context("还没进房间")?;
        let my_relay = h.node.my_relay_url().context("本端还没有可用中继地址")?;

        // ① 流式算 blake3（不整读内存）—— 大文件要靠这一步不炸
        let (size, root_hash) = crate::transfer_orchestrator::hash_reader(&mut file)
            .context("计算文件哈希失败")?;
        if size == 0 {
            anyhow::bail!("空文件暂不支持（协议要求至少 1 块）");
        }

        let meta = crate::filetransfer::FileMeta {
            file_id: crate::filetransfer::new_file_id(),
            name: name.clone(),
            size,
            mime: mime.clone(),
            chunk_size: crate::filetransfer::CHUNK_SIZE,
            root_hash,
            sender: h.node.endpoint_id().to_string(),
            sender_relay: my_relay,
            ts: crate::room::now_ms(),
        };

        // ② 算哈希期间用户可能切了房 —— 与 invite_file 的 expect_room 校验呼应
        anyhow::ensure!(
            h.node.current_room().as_deref() == Some(room.as_str()),
            "算哈希期间房间已切换，本次发布取消"
        );

        h.node
            .invite_file(&meta, &room)
            .await
            .context("广播邀约失败")?;

        serde_json::to_string(&meta).context("meta 序列化失败")
    });

    match result {
        Ok(json) => {
            tracing::info!("已发布文件：{name}（{} 字节）", json.len());
            ret_str(&mut env, json)
        }
        Err(e) => {
            let msg = format!("{e:#}");
            logcat(
                ANDROID_LOG_ERROR,
                &format!("[iroh_web] 发布文件失败：{msg}"),
            );
            throw(&mut env, &msg)
        }
    }
}

/// 收到 `fileAccepted` 后，把文件数据推给接收方。
///
/// `meta_json` 是 `nativePublishFile` 返回的那份（原样传回）。
/// `fd` 同样是 publish 时那个句柄的**新副本**（Kotlin 侧重新 open 一个，
/// 见 `IrohNative.pushFile` 的说明 —— 这样两边各自管好自己的关闭时机）。
///
/// **本函数接管 fd**（`FdSource` 内部持有，结束时随 Drop 关闭）。
///
/// 阻塞直到传完 → 必须挂 IO 线程。
///
/// 返回实际发出的字节数。
#[no_mangle]
pub extern "system" fn Java_vip_editor_irohchat_nativebridge_IrohNative_nativePushFile(
    mut env: EnvUnowned<'_>,
    _this: JObject<'_>,
    ptr: jlong,
    meta_json: JString<'_>,
    receiver_id: JString<'_>,
    receiver_relay: JString<'_>,
    have_b64: JString<'_>,
    fd: jni::sys::jint,
) -> jstring {
    // 先接管 fd（同 nativeAcceptFile：放在所有提前 return 之前，避免泄漏）
    let file = if fd >= 0 {
        use std::os::fd::FromRawFd;
        Some(unsafe { std::fs::File::from_raw_fd(fd) })
    } else {
        None
    };

    let Some(h) = (unsafe { handle_ref(ptr) }) else {
        return throw(&mut env, "节点未创建");
    };
    let (Ok(meta_json), Ok(peer), Ok(relay), Ok(have_b64)) = (
        read_jstring(&mut env, &meta_json),
        read_jstring(&mut env, &receiver_id),
        read_jstring(&mut env, &receiver_relay),
        read_jstring(&mut env, &have_b64),
    ) else {
        return throw(&mut env, "读取参数失败");
    };
    let Some(file) = file else {
        return throw(&mut env, "无效的文件描述符");
    };
    let Ok(rt) = h.rt() else {
        return throw(&mut env, "运行时已释放");
    };

    let result: Result<u64> = rt.block_on(async {
        let meta: crate::filetransfer::FileMeta =
            serde_json::from_str(&meta_json).with_context(|| "meta 解析失败")?;
        let have = crate::filetransfer::bitmap_from_b64(&have_b64);
        let source = crate::transfer_orchestrator::FdSource::new(file);

        h.node
            .send_file_data(&meta, &peer, &relay, &source, have, |ev| {
                use crate::filetransfer::SendEvent;
                match ev {
                    SendEvent::Progress { done, total, bytes } => {
                        tracing::debug!("发送进度 {done}/{total}（{bytes} 字节）");
                    }
                    SendEvent::Finished => tracing::info!("文件发送完成：{}", meta.file_id),
                    SendEvent::Failed { reason } => {
                        tracing::warn!("文件发送失败：{}（{reason}）", meta.file_id)
                    }
                    _ => {}
                }
            })
            .await
    });

    match result {
        Ok(bytes) => ret_str(&mut env, bytes.to_string()),
        Err(e) => {
            let msg = format!("{e:#}");
            logcat(
                ANDROID_LOG_ERROR,
                &format!("[iroh_web] 推送文件失败：{msg}"),
            );
            throw(&mut env, &msg)
        }
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
