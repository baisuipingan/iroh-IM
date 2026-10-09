/* ============================================================================
 * IrohNativeModule —— 把 IrohNative（JNI）包成 Expo Module，暴露给 JS
 *
 * ## 为什么要有这一层
 *
 * JS 不能直接调 JNI。Expo Modules 负责三件事：
 *   1. 注册到 RN 的模块表
 *   2. **协程调度**：所有阻塞调用挪到 Dispatchers.IO，不卡 UI 线程
 *   3. 类型转换（返回的 JSON 字符串由 TS 侧解析）
 *
 * ## ★★ 异步方法必须走 `SuspendBody`（真踩过，症状很迷惑）
 *
 * Expo Modules 的 `AsyncFunction` 有两套写法，**不能用错**：
 *
 *   // ❌ 这样写，lambda 是 crossinline 且非 suspend：
 *   AsyncFunction("send") { text: String ->
 *       withContext(Dispatchers.IO) { … }
 *   }
 *
 *   // ✅ 正确：SuspendBody 才提供 suspend 上下文
 *   AsyncFunction("send").SuspendBody<String, String> { text ->
 *       withContext(Dispatchers.IO) { … }
 *   }
 *
 * **症状**：11 个方法用同一种 ❌ 写法，真机上只报 1 个错 ——
 *
 *     IrohNativeModule.kt:172:13
 *     Suspend function 'withContext' can only be called from a coroutine
 *     or another suspend function.
 *
 * 根因是**重载解析**：lambda 最后一句返回 `Unit` 时，Kotlin 恰好选中一个
 * 能编过的重载；返回 `String` 时选中的另一个要求非 suspend。
 * 所以**不能因为"大部分编过了"就以为写法没问题** —— 必须统一成
 * `SuspendBody`。
 *
 * ⚠️ 泛型顺序是 `<R, P0, P1, …>` —— **返回类型在最前**，参数跟在后面。
 *    参数写在 `SuspendBody` 的 lambda 里，**不是**外层 lambda。
 *
 * ## 事件投递：JS 侧主动 poll，不用 emit
 *
 * Expo Modules 支持 `sendEvent` 推事件，但那需要 JS 一直在监听，
 * 且 App 进后台时事件会静默堆积。
 *
 * 这里改成**拉取**：TS 侧 `pollEvent()` → Kotlin `nativePollEvent(200)`，
 * 阻塞最多 200ms 返回一条或 null。好处是**背压天然成立** ——
 * JS 处理不过来时就不会调下一次 poll，Rust 侧的队列自然积压（不丢）。
 *
 * 见 client-wasm/src/jni_api.rs 顶部的「为什么不用回调」。
 * ==========================================================================*/

package vip.editor.irohchat.nativebridge

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** 所有原生调用前都先查句柄 —— Rust 侧对 0 会抛异常 */
private const val ERR_NO_NODE = "节点未创建"

class IrohNativeModule : Module() {

    /** 未创建时为 0 */
    private var ptr: Long = 0L

    override fun definition() = ModuleDefinition {
        Name("IrohNative")

        /* ---------------------------------------------------------------
         * ★★ 模块装载时立刻注入 Android Context
         *
         * 用 `OnCreate`：它在任何 function 被调用**之前**执行，
         * 正好满足 "必须早于 nativeCreate" 的要求。
         *
         * 不做这一步的后果（真机实测）：建节点时直接
         *     Abort message: 'android context was not initialized'
         *     signal 6 (SIGABRT)
         * 而且崩溃栈里看不出跟 DNS/TLS 有关，极难排查。
         * -------------------------------------------------------------*/
        OnCreate {
            // Expo 的 `reactContext` 就是 Android `Context`（可空），
            // 这是官方模块的标准取法（见 expo-file-system 的 FileSystemModule）。
            //
            // ⚠️ 别写 `?: appContext` 兜底 —— `appContext` 是 Expo 的
            //    `AppContext`，**不是** Android `Context`（两者无继承关系），
            //    那样写会报 "inferred type is 'AppContext', but 'Context' was expected"。
            //    真丢了 ReactContext 就没法初始化，让它抛出来更好。
            val ctx: android.content.Context =
                appContext.reactContext ?: throw Exceptions.AppContextLost()
            IrohNative.initContext(ctx)
        }

        /* ---------------------------------------------------------------
         * 能力查询（纯内存读，用同步 Function 即可）
         * -------------------------------------------------------------*/

        /**
         * 原生库是否可用 + 失败原因。
         *
         * TS 侧启动第一件事就是问这个：不可用就回退 mock，
         * 而不是一路调到 `nativeCreate` 才崩。
         */
        Function("getStatus") {
            mapOf(
                "available" to IrohNative.available,
                "loadError" to IrohNative.loadError,
            )
        }

        /* ---------------------------------------------------------------
         * 生命周期
         * -------------------------------------------------------------*/

        /**
         * 建节点 + 启动事件转发，返回句柄号。
         *
         * ⚠️ events 的开启顺序是敏感的（见 IrohNative.createAndStartEvents）。
         */
        AsyncFunction("create").SuspendBody<Long, List<String>, String?, String?, String?> {
                relays, relayToken, anchorId, anchorRelay ->
            withContext(Dispatchers.IO) {
                if (ptr != 0L) {
                    // 重复 create 会泄漏上一个节点（它的后台任务还在跑）
                    throw IllegalStateException("已有活动节点（ptr=$ptr），先调 release()")
                }
                ptr = IrohNative.createAndStartEvents(
                    relays = relays,
                    relayToken = relayToken,
                    anchorId = anchorId,
                    anchorRelay = anchorRelay,
                )
                ptr
            }
        }

        /** 释放节点。幂等。 */
        AsyncFunction("release").SuspendBody<Unit> {
            withContext(Dispatchers.IO) {
                if (ptr != 0L) {
                    IrohNative.nativeShutdown(ptr)
                    IrohNative.nativeFree(ptr)
                    ptr = 0L
                }
            }
        }

        /* ---------------------------------------------------------------
         * 事件拉取
         * -------------------------------------------------------------*/

        /**
         * 取一条事件（JSON 字符串）；无事件返回 null。
         *
         * ⚠️ 这是**阻塞**调用（最多 timeoutMs）。调用方要在自己的
         *    异步循环里跑，别在渲染路径上调。
         */
        AsyncFunction("pollEvent").SuspendBody<String?, Int> { timeoutMs ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) null
                else IrohNative.nativePollEvent(ptr, timeoutMs.toLong())
            }
        }

        /* ---------------------------------------------------------------
         * 动作
         * -------------------------------------------------------------*/

        AsyncFunction("endpointId").SuspendBody<String> {
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException(ERR_NO_NODE)
                IrohNative.nativeEndpointId(ptr)
            }
        }

        AsyncFunction("relayStatus").SuspendBody<List<Map<String, Any?>>> {
            withContext(Dispatchers.IO) {
                if (ptr == 0L) emptyList() else IrohNative.relayStatus(ptr)
            }
        }

        AsyncFunction("online").SuspendBody<Unit> {
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException(ERR_NO_NODE)
                IrohNative.nativeOnline(ptr)
            }
        }

        /**
         * 进房。
         *
         * ⚠️ `joined` / `history` 事件会在本调用**返回之前**变成可 poll 的
         *    （Rust 行为如此）。所以 TS 侧必须**先开 poll 循环再 join**。
         */
        AsyncFunction("join").SuspendBody<Unit, String, String> { room, nickname ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException(ERR_NO_NODE)
                IrohNative.nativeJoin(ptr, room, nickname)
            }
        }

        AsyncFunction("send").SuspendBody<String, String> { text ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException(ERR_NO_NODE)
                IrohNative.nativeSend(ptr, text)
            }
        }

        AsyncFunction("setNickname").SuspendBody<Unit, String> { nickname ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException(ERR_NO_NODE)
                IrohNative.nativeSetNickname(ptr, nickname)
            }
        }

        AsyncFunction("leaveRoom").SuspendBody<Unit> {
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException(ERR_NO_NODE)
                IrohNative.nativeLeaveRoom(ptr)
            }
        }

        /**
         * 拉历史。[beforeTs] = -1 取最新一页。
         *
         * ⚠️ 这个方法就是当初编译报错的那个（返回 String 而非 Unit，
         *    重载解析选中了非 suspend 的版本）。
         */
        AsyncFunction("fetchHistory")
            .SuspendBody<String, String, Int, Long, String> { room, limit, beforeTs, beforeId ->
                withContext(Dispatchers.IO) {
                    if (ptr == 0L) throw IllegalStateException(ERR_NO_NODE)
                    IrohNative.nativeFetchHistory(ptr, room, limit.toLong(), beforeTs, beforeId)
                }
            }

        /* ---- 文件接收 ---- */

        /**
         * 接收文件到公共 Downloads/iroh。
         *
         * [metaJson] 是 `fileInvite` 事件里的 `meta`（**原样**），
         * 但外面要包一层带上 `_room` —— Rust 侧要核对"是否还在邀约的房间"。
         * 由这一层组装，不用 JS 操心字段名。
         */
        AsyncFunction("acceptFile").SuspendBody<String, String, String, String> { fileId, metaJson, room ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException(ERR_NO_NODE)
                val ctx: Context = appContext.reactContext ?: throw Exceptions.AppContextLost()
                // 把 room 塞进 meta：Rust 侧统一从 meta._room 读（见 jni_api.rs 的说明）
                val withRoom = JSONObject(metaJson).apply { put("_room", room) }.toString()
                IrohNative.acceptFileToDownloads(ctx, ptr, fileId, withRoom)
            }
        }

        AsyncFunction("rejectFile").SuspendBody<Unit, String, String, String> { fileId, reason, room ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException(ERR_NO_NODE)
                IrohNative.nativeRejectFile(ptr, fileId, reason, room)
            }
        }
    }
}
