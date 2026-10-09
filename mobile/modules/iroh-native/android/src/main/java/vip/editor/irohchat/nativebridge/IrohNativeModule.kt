/* ============================================================================
 * IrohNativeModule —— 把 IrohNative（JNI）包成 Expo Module，暴露给 JS
 *
 * ## 为什么要有这一层
 *
 * JS 不能直接调 JNI。Expo Modules 负责三件事：
 *   1. 注册到 RN 的模块表（`NativeModulesProxy.IrohNative`）
 *   2. **协程调度**：所有阻塞调用挪到 Dispatchers.IO，不卡 UI 线程
 *   3. 类型转换（JSON 字符串 ↔ JS 对象由 TS 侧负责）
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

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class IrohNativeModule : Module() {

    /** 未创建时为 0。所有方法都先检查它 —— Rust 侧对 0 会抛异常。 */
    private var ptr: Long = 0L

    override fun definition() = ModuleDefinition {
        Name("IrohNative")

        /* ---------------------------------------------------------------
         * 能力查询
         * -------------------------------------------------------------*/

        /**
         * 原生库是否可用 + 失败原因。
         *
         * TS 侧启动时第一件事就是问这个：不可用就回退到 mock，
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
         * 建节点 + 启动事件转发。
         *
         * ⚠️ 内部会把 events 打开（顺序敏感，见 IrohNative）。
         * 返回值是句柄号，TS 侧要持有它并传给后续所有调用。
         */
        AsyncFunction("create") { relays: List<String>, relayToken: String?, anchorId: String?, anchorRelay: String? ->
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
        AsyncFunction("release") {
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
         * ⚠️ 这是**阻塞**调用（最多 timeoutMs），调用方必须在
         *    自己的异步循环里跑，别在渲染路径上调。
         */
        AsyncFunction("pollEvent") { timeoutMs: Int ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) return@withContext null
                IrohNative.nativePollEvent(ptr, timeoutMs.toLong())
            }
        }

        /* ---------------------------------------------------------------
         * 动作
         * -------------------------------------------------------------*/

        AsyncFunction("endpointId") {
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException("节点未创建")
                IrohNative.nativeEndpointId(ptr)
            }
        }

        AsyncFunction("relayStatus") {
            withContext(Dispatchers.IO) {
                if (ptr == 0L) emptyList<Map<String, Any?>>()
                else IrohNative.relayStatus(ptr)
            }
        }

        AsyncFunction("online") {
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException("节点未创建")
                IrohNative.nativeOnline(ptr)
            }
        }

        /**
         * 进房。
         *
         * ⚠️ `joined` / `history` 事件会在本调用**返回之前**经 pollEvent 可读
         *    （Rust 行为如此）。所以 TS 侧必须**先开 poll 循环再 join**。
         */
        AsyncFunction("join") { room: String, nickname: String ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException("节点未创建")
                IrohNative.nativeJoin(ptr, room, nickname)
            }
        }

        AsyncFunction("send") { text: String ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException("节点未创建")
                IrohNative.nativeSend(ptr, text)
            }
        }

        AsyncFunction("setNickname") { nickname: String ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException("节点未创建")
                IrohNative.nativeSetNickname(ptr, nickname)
            }
        }

        AsyncFunction("leaveRoom") {
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException("节点未创建")
                IrohNative.nativeLeaveRoom(ptr)
            }
        }

        /**
         * 拉历史。[beforeTs] = -1 取最新一页。
         */
        AsyncFunction("fetchHistory") { room: String, limit: Int, beforeTs: Long, beforeId: String ->
            withContext(Dispatchers.IO) {
                if (ptr == 0L) throw IllegalStateException("节点未创建")
                IrohNative.nativeFetchHistory(ptr, room, limit.toLong(), beforeTs, beforeId)
            }
        }
    }
}
