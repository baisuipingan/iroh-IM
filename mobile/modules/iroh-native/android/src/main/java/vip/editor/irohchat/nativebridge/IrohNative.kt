/* ============================================================================
 * IrohNative —— Rust 核心（libiroh_web.so）的 JNI 桥
 *
 * ⚠️⚠️ **包名 + 类名 + 方法名都不能改**。Rust 侧的导出符号是按
 * `Java_<包名下划线>_<类名>_<方法名>` 生成的：
 *
 *     package vip.editor.irohchat.nativebridge
 *     object  IrohNative
 *       ↓
 *     Java_vip_editor_irohchat_nativebridge_IrohNative_nativeCreate
 *
 * 改名字 → 符号对不上 → `UnsatisfiedLinkError`，而且报错只说
 * "找不到 nativeCreate"，不会告诉你名字拼错了。
 * 校验方式：scripts/check-jni-symbols.mjs（把 Rust 与 Kotlin 两侧的
 * 清单对撞，不一致就直接失败）。
 *
 * ## 线程模型
 *
 * 所有 `native*` 都是**同步阻塞**的（Rust 内部 block_on）。所以：
 *   - connect / join / send / fetchHistory **必须挂 Dispatchers.IO**
 *   - 绝不能在主线程调：网络往返可能几秒 → ANR
 *
 * 事件用**拉取**而非回调：`pollEvent` 阻塞最多 200ms，
 * 有事件返回 JSON，没有返回 null。Kotlin 在 IO 线程循环拉，转交上层。
 *
 * 为什么不用 Rust→Kotlin 回调：那要处理 JavaVM 缓存、线程 attach/detach、
 * GlobalRef 生命周期 —— 三件都**无法在没有真机时验证**。
 * 单向拉取的边界小得多。详见 client-wasm/src/jni_api.rs 顶部。
 * ==========================================================================*/

package vip.editor.irohchat.nativebridge

import org.json.JSONArray
import org.json.JSONObject

object IrohNative {

    /**
     * 动态库是否可用。
     *
     * 加载失败**不抛异常，只置 flag** —— 让上层能在 UI 上给出明确提示
     * （"原生模块不可用"），而不是一进 App 就崩。用 mock 开发时也靠它判断。
     */
    var available: Boolean = false
        private set
    var loadError: String? = null
        private set

    init {
        try {
            System.loadLibrary("iroh_web")
            available = true
        } catch (e: UnsatisfiedLinkError) {
            // 常见原因：① .so 没进 jniLibs/ ② ABI 不匹配
            // （只编了 arm64 而设备/模拟器是 x86_64）
            loadError = e.message ?: "UnsatisfiedLinkError"
        }
    }

    /* ---- 生命周期 ---- */

    /**
     * 建节点。返回句柄（0 = 失败，已抛异常）。
     *
     * [optsJson] 字段与浏览器侧 relay-config 对齐：
     *   {"relays":["https://…"], "relayToken":"…", "anchorId":"…",
     *    "anchorRelay":"…", "secretKeyHex":null, "historyDir":null,
     *    "serveHistory":false}
     */
    external fun nativeCreate(optsJson: String): Long

    /**
     * 启动事件转发。
     *
     * ⚠️ **必须在 join 之前调用**：`joined` / `history` 在 join 调用返回
     * **之前**就产生了，晚了这些事件永久丢失 —— 表现为"进了房却看不到历史，
     * 且一直显示未加入"。（TS 侧踩过同一个坑，见 useRoom.ts 注释。）
     */
    external fun nativeStartEvents(ptr: Long): Boolean

    /**
     * 取一条事件（JSON）。最多阻塞 [timeoutMs]；无事件返回 null。
     *
     * 返回的是 RoomEvent 的 JSON，形状与浏览器/Rust 一致：
     *   {"type":"message","room":"…","message":{…},"mine":true}
     *
     * ⚠️ 注意 **`type` 是 camelCase，而 message 内的字段是 snake_case**
     *    （`file_id` / `root_hash`）—— 这是 Rust 侧 serde 注解不统一造成的，
     *    **不要在这层"顺手统一"**，否则与浏览器端的事件形状就不一致了。
     */
    external fun nativePollEvent(ptr: Long, timeoutMs: Long): String?

    external fun nativeEndpointId(ptr: Long): String

    /** 中继状态（JSON 数组） */
    external fun nativeRelayStatus(ptr: Long): String

    external fun nativeShutdown(ptr: Long)

    /** 释放句柄。幂等（传 0 直接返回）。释放后句柄不可再用。 */
    external fun nativeFree(ptr: Long)

    /* ---- 动作（全是阻塞调用，挂 IO 线程）---- */

    external fun nativeOnline(ptr: Long)

    external fun nativeJoin(ptr: Long, room: String, nickname: String)

    /** 发文本，返回消息 id */
    external fun nativeSend(ptr: Long, text: String): String

    external fun nativeSetNickname(ptr: Long, nickname: String)

    external fun nativeLeaveRoom(ptr: Long)

    /**
     * 拉历史。返回 HistoryResponse 的 JSON：
     *   {"room":"…","messages":[…],"snapshot":{…}|null}
     *
     * [beforeTs] 传 **-1** = 取最新一页；否则从该时间戳往前取
     * （配合 [beforeId] 组成 `(ts, id)` 复合游标，用于上拉加载更多）。
     */
    external fun nativeFetchHistory(
        ptr: Long,
        room: String,
        limit: Long,
        beforeTs: Long,
        beforeId: String,
    ): String

    /* =======================================================================
     * 便捷封装
     * =====================================================================*/

    /**
     * 建节点 + 启动事件转发，返回句柄。
     *
     * ⚠️ 顺序不能反（先 events 再 join，见 [nativeStartEvents] 说明）。
     */
    fun createAndStartEvents(
        relays: List<String>,
        relayToken: String? = null,
        anchorId: String? = null,
        anchorRelay: String? = null,
    ): Long {
        val opts = JSONObject().apply {
            put("relays", JSONArray(relays))
            put("serveHistory", false)
            relayToken?.let { put("relayToken", it) }
            anchorId?.let { put("anchorId", it) }
            anchorRelay?.let { put("anchorRelay", it) }
        }
        val ptr = nativeCreate(opts.toString())
        if (ptr == 0L) throw IllegalStateException("nativeCreate 返回 0（详见 logcat）")
        nativeStartEvents(ptr)
        return ptr
    }

    /** 中继状态解析成 List<Map>，给上层直接喂 JS */
    fun relayStatus(ptr: Long): List<Map<String, Any?>> {
        val arr = JSONArray(nativeRelayStatus(ptr))
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            buildMap { o.keys().forEach { k -> put(k, o.opt(k)) } }
        }
    }
}
