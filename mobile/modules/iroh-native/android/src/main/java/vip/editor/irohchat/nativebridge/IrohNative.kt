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

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
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

    /* =======================================================================
     * ★★ Android Context 注入 —— 不做这一步，真机上必然 SIGABRT
     *
     * 现象（真机实测）：
     *     Abort message: 'android context was not initialized'
     *     #26 Java_…_IrohNative_nativeCreate+356
     *     signal 6 (SIGABRT)
     *
     * 崩溃栈里完全看不出跟 DNS / TLS 有关，像是 iroh 内部出了问题。
     *
     * 根因：依赖树里有两个东西**需要通过 JNI 拿 Android 的 JavaVM 与 Context**：
     *   1. iroh 的 DNS 解析（读系统 nameserver，而不是用写死的 fallback）
     *   2. reqwest 的 TLS 校验（rustls-platform-verifier，用系统信任库）
     * 两者都从 `ndk_context::android_context()` 取指针，而那个全局量必须有人初始化。
     * 上游文档原话：uninitialized ndk_context in production is a programming
     * error and should surface loudly.
     * =====================================================================*/

    /** 是否已注入 Context。`initialize_android_context` 重复调用会 panic，靠它防重。 */
    private var ctxInjected = false

    /**
     * 注入 Application Context。**必须在任何 [nativeCreate] 之前调用一次。**
     *
     * ⚠️ 传 `context.applicationContext`，**不要传 Activity**：
     *    ndk_context 要求指针活到进程结束，而 Activity 会被销毁重建。
     *
     * ⚠️ 幂等保护是必须的：Rust 侧 `initialize_android_context` 内部
     *    `assert!(previous.is_none())`，**第二次调用直接 panic（SIGABRT）**。
     */
    @Synchronized
    fun initContext(context: Context) {
        if (!available) return
        if (ctxInjected) return
        // applicationContext：进程级生命周期，符合 ndk_context 的要求
        nativeInitContext(context.applicationContext)
        ctxInjected = true
    }

    /**
     * 把 JavaVM 与 Context 交给 Rust（实现在 src/jni_api.rs）。
     *
     * JavaVM 那一半由 `JNI_OnLoad` 在 `System.loadLibrary` 时就存好了，
     * 这个调用补上 Context 那一半。
     */
    private external fun nativeInitContext(context: Context)

    /* ---- 生命周期 ---- */

    /**
     * 建节点。返回句柄（0 = 失败，已抛异常）。
     *
     * ⚠️ 调用前必须已经 [initContext]，否则 Rust 侧一进 DNS 就 abort。
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

    /* ---- 文件接收 ---- */

    /**
     * 接收一个文件，直接写进给定的 fd。
     *
     * ⚠️ **这个 fd 会被 Rust 接管并负责关闭**（内部包成 `File`，
     *    Drop 时 close）。调用方**不要**再关一次 —— double-close 会误关
     *    别的线程刚拿到的同号 fd，是极难排查的一类 bug。
     *    传之前用 `ParcelFileDescriptor.detachFd()` 交出所有权。
     *
     * ⚠️ **阻塞**，直到整个文件收完。310 MB 这种可能要几分钟 →
     *    必须挂 `Dispatchers.IO`（模块层已经这么做了）。
     *
     * [fileId] 邀约里的 id；[metaJson] 是 `fileInvite` 事件里的完整 `meta`
     * 序列化结果；[room] 邀约所在的房间（Rust 侧会核对）。
     *
     * 返回收到的字节数（字符串）。失败抛异常、logcat 有 `文件接收失败`。
     */
    external fun nativeAcceptFile(
        ptr: Long,
        fileId: String,
        metaJson: String,
        room: String,
        fd: Int,
    ): String

    /**
     * 拒绝接收某个文件。
     *
     * [room] **必填**：拒绝理由会广播，发错房间会泄露给无关的人。
     */
    external fun nativeRejectFile(ptr: Long, fileId: String, reason: String, room: String)

    /* ---- 文件发送 ---- */

    /**
     * 发布一个文件（广播邀约）。**不发送数据** —— 等对方点接收。
     *
     * [fd] 由 `contentResolver.openFileDescriptor(uri, "r")` 取来并 **detachFd**。
     * **Rust 侧接管并关闭它** —— 调用方不要再关。
     *
     * ⚠️ **阻塞**（要先流式算 blake3，大文件几十秒）→ 必须挂 `Dispatchers.IO`。
     *
     * 返回 `FileMeta` 的 JSON，调用方存进货架，收到 `fileAccepted` 后原样传给
     * [nativePushFile]。
     */
    external fun nativePublishFile(
        ptr: Long,
        fd: Int,
        name: String,
        mime: String,
    ): String

    /**
     * 收到 `fileAccepted` 后把数据推给接收方。
     *
     * [metaJson] 是 [nativePublishFile] 的返回值（原样）。
     * [fd] 是**重新打开**的句柄（发布时那个已被关闭）—— 同样 detachFd 交所有权。
     * [haveB64] 是对方已有块的位图（`fileAccepted` 事件里 `have` 字段）；
     * 传空串表示对方什么都没有。
     *
     * ⚠️ **阻塞**直到传完 → 必须挂 `Dispatchers.IO`。
     *
     * 返回实际发出的字节数。
     */
    external fun nativePushFile(
        ptr: Long,
        metaJson: String,
        receiverId: String,
        receiverRelay: String,
        haveB64: String,
        fd: Int,
    ): String

    /**
     * 重发一次邀约（回应"有人问这个文件还在不在"）。
     *
     * 别人点了历史卡片 → 广播 `fileQueryAsked` → 我们如果还留着这个文件
     * （在货架上），就重发邀约让他拿到可接收的卡片。
     *
     * [metaJson] 必须是**完整 `FileMeta`**（从货架取）。
     *
     * ⚠️ 阻塞（写 gossip）→ 挂 `Dispatchers.IO`。返回是否成功。
     */
    external fun nativeReofferFile(ptr: Long, metaJson: String): Boolean

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
        // ⚠️⚠️ 键名必须是 **snake_case**，与 Rust 的 `RoomOptions` 字段名逐字一致。
        //
        //    `RoomOptions` 上**没有** `#[serde(rename_all = "camelCase")]`
        //    （它只有 #[serde(default)]），所以 Rust 只认 `relay_token` /
        //    `anchor_id` / `anchor_relay` / `secret_key_hex`。
        //
        //    写成 camelCase 的后果是**静默丢弃** —— serde 对未知字段不报错，
        //    于是这些参数变成 None：token 丢了 → 中继鉴权失败 →
        //    "The relay denied our authentication (not authorized)"。
        //    这个 bug 真机上耗了很久才定位（真踩过）。
        //
        //    注意区分：`RelayInfo`（状态上报）**有** rename_all="camelCase"，
        //    所以那边反而是 camelCase 对。**两边规则不同，别互相推。**
        val opts = JSONObject().apply {
            put("relays", JSONArray(relays))
            put("serve_history", false)
            relayToken?.let { put("relay_token", it) }
            anchorId?.let { put("anchor_id", it) }
            anchorRelay?.let { put("anchor_relay", it) }
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

    /* =======================================================================
     * 文件接收：MediaStore 建文件 → 拿 fd → 交给 Rust
     * =====================================================================*/

    /**
     * 把文件收进**公共 Downloads/iroh** 目录，返回落盘后的展示名。
     *
     * ## 为什么必须走 MediaStore
     *
     * Android 10（API 29）起，App 往公共目录写文件**不能再用裸路径** ——
     * `/sdcard/Download/...` 直接 open 会 `EACCES`。
     * 正路是 `MediaStore.Downloads`：先 insert 一条记录拿到 `Uri`，
     * 再用它 open 出 fd 写入。好处是**不需要任何存储权限**
     * （`WRITE_EXTERNAL_STORAGE` 在 API 29+ 已废弃）。
     *
     * ## 为什么传 fd 而不是路径
     *
     * MediaStore 只给 `Uri`，**没有可用的文件系统路径**
     * （`/sdcard/Download/xxx` 那种拼出来的路径在 scoped storage 下不可写）。
     * 所以把 `ParcelFileDescriptor` 的 fd 交给 Rust，
     * Rust 用 `File::from_raw_fd` 接管 —— 零额外拷贝，310 MB 也不会翻倍占空间。
     *
     * ## IS_PENDING 的意义（必须正确使用）
     *
     * 建记录时置 `IS_PENDING=1`：**其它 App 看不到这个半成品**。
     * 收完再置 0 让它可见。中途失败就删掉记录 —— 否则公共目录里
     * 会留下一个永远不完整、用户也打不开的文件。
     */
    private fun receiveToDownloads(
        context: Context,
        displayName: String,
        mime: String,
        sizeHint: Long,
    ): Int {
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, displayName)
            put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/iroh")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }

        val uri = resolver.insert(collection, values)
            ?: throw IllegalStateException("MediaStore 拒绝创建文件（$displayName）")

        // openFileDescriptor("rw") 才能既可写（放数据）又可读（finish 重算哈希）
        val pfd = resolver.openFileDescriptor(uri, "rw")
            ?: run {
                resolver.delete(uri, null, null)
                throw IllegalStateException("打不开刚创建的文件（$displayName）")
            }

        // detachFd()：把 fd 的所有权交出去，之后 pfd.close() **不会**关它。
        // 这正是 Rust 侧要的语义（由 Rust 的 File 负责关闭）。
        val fd = pfd.detachFd()
        lastUri = uri
        return fd
    }

    /**
     * 接收完成后把记录转为可见（`IS_PENDING=0`）。
     * 失败时删除记录（不留下半成品）。
     */
    private fun finishDownloads(context: Context, ok: Boolean) {
        val uri = lastUri ?: return
        lastUri = null
        val resolver = context.contentResolver
        if (ok) {
            resolver.update(uri, ContentValues().apply {
                put(MediaStore.Downloads.IS_PENDING, 0)
            }, null, null)
        } else {
            // 收失败：删掉记录，别在用户 Downloads 里留个打不开的残file
            resolver.delete(uri, null, null)
        }
    }

    /** 最近一次建的 MediaStore 记录（成功后置 0 可见 / 失败删除）。 */
    private var lastUri: android.net.Uri? = null

    /* =======================================================================
     * 文件发送
     * =====================================================================*/

    /**
     * 货架：`file_id → (metaJson, uri)`。
     *
     * ## 为什么需要它
     *
     * 发送是**两段式**的，中间隔着"对方什么时候点接收"：
     *
     *   ① publish：算哈希 → 造 meta → 广播邀约（此时才知道 file_id）
     *   ② push：收到 `fileAccepted` 事件后，用 meta + 文件句柄把数据推过去
     *
     * ②的触发点是**事件**（可能几秒后、也可能几分钟后），必须有人记住
     * ①的产物 —— 就是这张表。
     *
     * ## 为什么存在 Kotlin 而不是 Rust
     *
     * Rust 核心库不该知道 `Uri` 这种 Android 概念（它还要编成 wasm）。
     * 表里存 `Uri` 而不是 fd 也是同一个理由：**fd 不能长期持有**
     *（进程文件描述符有限、系统也可能回收），push 时按 `Uri` 重新 open 更稳。
     *
     * ⚠️ 只增不减会涨内存：上限 32 条，超了淘汰最旧的。
     *    被淘汰的文件再有人来接收就推不动了（卡片还在但推不了）——
     *    这是可接受的：正常使用不会同时挂着几十个待接收文件。
     */
    private val shelf = LinkedHashMap<String, Pair<String, String>>() // fileId -> (metaJson, uriString)

    /**
     * JS 入口：发布文件（广播邀约，不传数据）。
     *
     * [uriString] 是 SAF 选文件返回的 `content://` URI。
     *
     * 返回**完整 `FileMeta` 的 JSON**（rust 侧原样给出）——
     * JS 拿它显示文件卡片（大小/名字）。push 时**不需要**把它传回来：
     * 那边按 `fileId` 从货架取自己那份（单一真相源，避免两份不一致）。
     */
    fun publishFile(context: Context, ptr: Long, uriString: String, name: String, mime: String): String {
        val uri = android.net.Uri.parse(uriString)

        // 先拿一个 fd 算哈希（Rust 接管并关闭它）
        val fd = openFdOrThrow(context, uri, "r")
        val metaJson = nativePublishFile(ptr, fd, name, mime)
        val meta = JSONObject(metaJson)
        val fileId = meta.getString("file_id")

        // 存进货架：push 时按 Uri 重新 open
        synchronized(shelf) {
            shelf[fileId] = metaJson to uriString
            while (shelf.size > MAX_SHELF) {
                val oldest = shelf.keys.firstOrNull() ?: break
                shelf.remove(oldest)
            }
        }

        return metaJson
    }

    /**
     * JS 入口：收到 `fileAccepted` 后推送数据。
     *
     * 从货架取 meta（`metaJson` 由调用方传回也行 —— 二者应一致，
     * 这里以货架为准，避免调用方传了别的文件的 meta）。
     *
     * 返回实际发出的字节数（字符串）。
     */
    fun pushFile(
        context: Context,
        ptr: Long,
        fileId: String,
        haveB64: String,
        receiverId: String,
        receiverRelay: String,
    ): String {
        val entry = synchronized(shelf) { shelf[fileId] }
            ?: throw IllegalStateException("货架里没有 $fileId（可能已淘汰或未发布过）")
        val (metaJson, uriString) = entry

        // 重新 open 一个 fd（发布时那个已被 Rust 关闭）。
        // Rust 接管这个新的并负责关闭。
        val fd = openFdOrThrow(context, android.net.Uri.parse(uriString), "r")
        return nativePushFile(ptr, metaJson, receiverId, receiverRelay, haveB64, fd)
    }

    /** 推送结束后从货架移除（发送完成 / 失败都清，避免重复推）。 */
    fun forgetShelf(fileId: String) {
        synchronized(shelf) { shelf.remove(fileId) }
    }

    /**
     * 回应"有人问这个文件还在不在"：手里有就重发一次邀约。
     *
     * 返回是否真的重发了（false = 货架里没有，或重发失败）。
     *
     * ⚠️ **货架里没有就什么都不做** —— 静默是协议认可的语义
     *    （沉默即视为该文件已过期）。别报错、别打扰用户。
     */
    fun reofferFile(ptr: Long, fileId: String): Boolean {
        val metaJson = synchronized(shelf) { shelf[fileId]?.first } ?: return false
        return try {
            nativeReofferFile(ptr, metaJson)
        } catch (e: Throwable) {
            // 重发失败不影响任何既有会话（对方那张卡片本来也是过期状态）
            android.util.Log.w("IrohNative", "重发邀约失败：$fileId", e)
            false
        }
    }

    /**
     * 按 Uri 打开文件描述符并 **detachFd**（把所有权交给 Rust）。
     *
     * ⚠️ 用 detachFd 而不是 `pfd.close()`：后者会关掉那个 fd，
     *    而 Rust 侧正要接管它。detach 之后由 Rust 的 `File` 负责关闭。
     */
    private fun openFdOrThrow(context: Context, uri: android.net.Uri, mode: String): Int {
        val pfd = context.contentResolver.openFileDescriptor(uri, mode)
            ?: throw IllegalStateException("打不开选中的文件（$uri）")
        return try {
            pfd.detachFd()
        } catch (e: Throwable) {
            pfd.close()
            throw e
        }
    }

    /** 货架容量上限（见 `shelf` 的说明）。 */
    private val MAX_SHELF = 32

    /**
     * JS 入口：接收文件。
     *
     * 返回落盘信息（JSON 字符串）：`{"bytes":"…","name":"…","location":"Downloads/iroh"}`
     */
    fun acceptFileToDownloads(
        context: Context,
        ptr: Long,
        fileId: String,
        metaJson: String,
        room: String,
    ): String {
        if (room.isBlank()) throw IllegalArgumentException("room 为空（邀约所在房间必填）")

        // 从 meta 里取文件名/mime/大小 —— meta 由 JS 原样传来（见 jni_api.rs 的说明）
        val meta = JSONObject(metaJson)
        val rawName = meta.optString("name").ifBlank { "file" }
        val mime = meta.optString("mime")
        val size = meta.optLong("size", 0L)
        val safeName = sanitizeDisplayName(rawName)

        // API 28 及以下没有 MediaStore.Downloads，退回 App 私有目录
        //（v1 只考虑了 29+；老设备走另一条路，见下面的分支）
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return acceptFileToPrivate(context, ptr, fileId, metaJson, safeName, room)
        }

        val fd = receiveToDownloads(context, safeName, mime, size)
        var ok = false
        try {
            val bytes = nativeAcceptFile(ptr, fileId, metaJson, room, fd)
            ok = true
            return JSONObject().apply {
                put("bytes", bytes)
                put("name", safeName)
                put("location", "${Environment.DIRECTORY_DOWNLOADS}/iroh")
            }.toString()
        } finally {
            finishDownloads(context, ok)
        }
    }

    /**
     * API < 29 的退路：写 App 私有外部目录（`getExternalFilesDir`），
     * **不需要任何权限**。这类设备上用户拿文件要靠分享/导出。
     */
    private fun acceptFileToPrivate(
        context: Context,
        ptr: Long,
        fileId: String,
        metaJson: String,
        safeName: String,
        room: String,
    ): String {
        val dir = File(context.getExternalFilesDir(null), "received").apply { mkdirs() }
        val target = File(dir, safeName)
        // 用 ParcelFileDescriptor.open 拿 fd：与上面 MediaStore 那条路**同一种类型**
        //（`Int`），两条路给 Rust 的东西完全一致。
        //
        // 试过 `Os.dup(out.fd)` —— 它返回的是 `FileDescriptor` 对象，
        // 不是要给 Rust 的 `Int`，还得再转一次，多此一举。
        val mode = android.os.ParcelFileDescriptor.MODE_READ_WRITE or
            android.os.ParcelFileDescriptor.MODE_CREATE or
            android.os.ParcelFileDescriptor.MODE_TRUNCATE
        val pfd = android.os.ParcelFileDescriptor.open(target, mode)
        val fd = try {
            pfd.detachFd()
        } catch (e: Throwable) {
            pfd.close()
            throw e
        }
        val bytes = nativeAcceptFile(ptr, fileId, metaJson, room, fd)
        return JSONObject().apply {
            put("bytes", bytes)
            put("name", safeName)
            put("location", target.absolutePath)
        }.toString()
    }
}

/**
 * 清理文件名：只取 basename、去掉控制字符与路径分隔符。
 *
 * ⚠️ 文件名**来自对端**，绝不能让 `../../foo` 这种带路径分量的名字
 *    逃出目标目录（目录穿越）。MediaStore 的 DISPLAY_NAME 相对宽松，
 *    但仍要在这里挡住。
 */
private fun sanitizeDisplayName(name: String): String {
    val base = name.substringAfterLast('/').substringAfterLast('\\')
    val cleaned = base.filter { it.code >= 0x20 && it != '\u007f' }.trim()
    val fallback = "file"
    if (cleaned.isEmpty()) return fallback
    // 挡住 "." / ".." 这类纯点名字
    if (cleaned.all { it == '.' }) return fallback
    return cleaned
}
