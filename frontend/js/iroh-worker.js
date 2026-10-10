/* ============================================================================
 * worker.js · 把 iroh 整个搬进 Web Worker
 *
 * ## 为什么要搬
 *
 * 实测（2026-10-01）：Chrome 把**隐藏标签页**的定时器从 20ms 压到 **1000ms**
 * （慢 50 倍），而 iroh 的 QUIC 栈（`n0-future`）**完全靠 setTimeout 驱动** ——
 * 发送节奏、ACK 处理、丢包检测全挂在上面。
 * 于是「点接收 → 切去干别的」会让吞吐掉到 1/50（实测 800+ KB/s → 几十 KB/s）。
 *
 * 而 **Worker 里的定时器不受页面可见性影响**（实测页面隐藏 45 秒后，
 * Worker 内 20ms 定时器仍是 21~30ms）。所以把 iroh 搬进来是**根治**。
 *
 * ## 数据路径（关键：每块数据都不经过 postMessage）
 *
 * ```
 * 主线程（UI）  --一次性传 File / 文件句柄-->  Worker（iroh + 读写）
 *      ^                                        |
 *      +--------只回进度百分比（~150ms 一次）-----+
 * ```
 *
 * 已实测：`File` 和 `FileSystemFileHandle` 都能 postMessage 进 Worker，
 * 且在 Worker 里能正常 `slice()` 读 / `createWritable()` 写。
 * 所以**块的读写全在 Worker 内部完成**，消息通道上只有元信息和进度。
 *
 * ## 分工边界
 *
 * | 事 | 在哪做 | 为什么 |
 * |---|---|---|
 * | `showSaveFilePicker` / `showOpenFilePicker` | **主线程** | 需要用户手势，Worker 里拿不到 |
 * | 算哈希（blake3）、invite、传数据 | Worker | 紧贴 iroh，避免跨线程 |
 * | 块的读（`File.slice`）/ 写（句柄 `createWritable`） | Worker | 零 postMessage |
 * | IndexedDB 断点位图 | Worker | 与续传逻辑在一起，避免来回同步 |
 * | 卡片渲染、按钮、提示 | 主线程 | DOM 只能在主线程 |
 * ==========================================================================*/

let wasm = null; // wasm 模块（含 RoomNode / JsHasher）
let node = null; // RoomNode 实例
let currentRoom = ''; // Rust 当前实际订阅的房间；文件清单必须按它隔离
let roomJoinGeneration = 0;
let roomSwitching = false;
let build = 'v1'; // wasm 构建号，用于破缓存
/** 测试模式：开启后把每次写入的块序号也回传（只回序号，不回数据） */
let testMode = false;

/* ---------------------------------------------------------------------------
 * 与主线程的通讯
 * ------------------------------------------------------------------------ */

const rpcSeq = 0;
const rpcPending = new Map(); // id -> {resolve, reject}

/** 主线程发来的 RPC：`{type:'rpc', id, method, args}` */
function rpcReply(id, ok, value, error) {
  self.postMessage({ type: 'rpc:reply', id, ok, value, error });
}

/** 主动推给主线程的事件（wasm 事件流 / 传输进度） */
function push(type, payload) {
  self.postMessage({ type, payload });
}

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------ */

async function boot(cfg) {
  build = cfg.build || 'v1';
  // ⚠️ Worker 里必须用**绝对 URL** 加载模块。
  // blob/module worker 的 `self.location` 是 worker 脚本自身，
  // 相对路径 `./pkg/...` 会报 "Failed to resolve module specifier"。
  const base = cfg.baseUrl || self.location.origin + '/';
  const pkgUrl = new URL('pkg/iroh_web.js', base).href;
  const wasmUrl = new URL(`pkg/iroh_web_bg.wasm?b=${build}`, base).href;

  wasm = await import(pkgUrl);
  await wasm.default(wasmUrl);

  node = await wasm.RoomNode.start(
    JSON.stringify({
      relays: cfg.relays,
      relay_token: cfg.relayToken ?? null,
      secret_key_hex: cfg.secretKeyHex,
      anchor_id: cfg.anchorId ?? null,
      anchor_relay: cfg.anchorRelay ?? null,
      rendezvous_id: cfg.rendezvousId ?? null,
      rendezvous_relay: cfg.rendezvousRelay ?? null,
      history_id: cfg.historyId ?? null,
      history_relay: cfg.historyRelay ?? null,
    }),
  );

  // wasm 事件流 → 原样转发给主线程（翻译逻辑留在主线程的 net.js，
  // 这样两边职责清晰：Worker 只管"搬运"，主线程管"语义"）
  const reader = node.events().getReader();
  (async () => {
    // ⚠️ 这个循环**必须有错误处理**（复检 P3-10）。
    //    没有 try/catch 时，流里任何一次错误都会让这个 IIFE 以
    //    "unhandled rejection" 结束 —— 之后**再也没有**任何
    //    message / presence / fileInvite 到达界面，而状态仍显示"在线"、
    //    发送路径（另一条 RPC 通道）照常工作。即"收不到但发得出、
    //    且毫无提示"的静默故障，最难排查。
    //    现在：报错交给主线程（net.js 会弹提示 + 可触发重连），并退出循环。
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        handleNodeEvent(value);
      }
      push('node:degraded', { reason: '事件流已结束' });
    } catch (e) {
      push('node:degraded', { reason: String(e?.message ?? e) });
    }
  })();

  return node.endpoint_id();
}

/* ---------------------------------------------------------------------------
 * 节点事件：既转发给 UI，也驱动文件传输
 * ------------------------------------------------------------------------ */

function handleNodeEvent(ev) {
  // 文件相关的状态变化要在这里顺手处理掉（因为 read/write 都在这边）
  switch (ev.type) {
    case 'fileAccepted':
      // 诊断：记录每一条收到的 Accept（谁、何时）。多接收方排查用。
      accLog.push({ t: Date.now(), file_id: ev.file_id ?? ev.fileId, by: ev.by });
      if (accLog.length > 50) accLog.shift();
      // 对方点了 ✓ —— 立刻开始传数据。**这一步在主线程是看不到数据的**。
      onAccepted(ev).catch((e) => {
        push('transfer:peer-error', { file_id: ev.file_id, peer: ev.by, error: String(e?.message ?? e) });
      });
      break;
    case 'fileRejected': {
      const fileId = ev.file_id ?? ev.fileId;
      const peer = ev.by;
      const file = outFiles.get(fileId);
      if (peer && file && ev.room === file.room) {
        const k = okey(fileId, peer);
        const o = outgoing.get(k);
        if (o?.state !== 'done') {
          const reason = ev.reason || '用户拒绝';
          const recipient = o || { file_id: fileId, room: file.room, peer, done: 0, total: file.total, bytes: 0 };
          recipient.state = ['已取消保存', '已暂停接收', '对方刷新或关闭了页面'].includes(reason) ? 'cancelled' : 'rejected';
          recipient.error = reason;
          outgoing.set(k, recipient);
          pushOutgoing(fileId);
        }
      }
      break;
    }
    case 'fileQueryAsked': {
      // 有人点了**历史里的文件卡片**，问"你现在还能提供这个文件吗"。
      //
      // 回应方式选的是**重发一次邀约**，而不是只再播一次心跳：
      // 对方直接拿到一张可接收的卡片（走已经验证过的接收流程），
      // 而心跳只能告诉他"文件还在"，他还得再猜怎么开始。
      //
      // 顺带 syncAvailableFiles() 让心跳也更新一次，房间里其他人
      // 那些"已过期"的卡片也会跟着翻回可接收。
      const fid = ev.file_id ?? ev.fileId;
      const t = outFiles.get(fid);
      if (!roomSwitching && t && ev.room === currentRoom && t.room === ev.room) {
        // ⚠️ 必须带 t.room：重发也要落在文件原本所属的房间。
        //    不带的话会用节点当前房间 —— 切过房间就会把重发发到别处。
        node.invite_file(JSON.stringify(t.meta), t.room || '').catch(() => {});
        syncAvailableFiles();
      }
      break;
    }
    default:
      break;
  }
  push('event', ev);
}

/** 诊断：收到的 Accept 流水（多接收方排查用） */
const accLog = [];

/* ---------------------------------------------------------------------------
 * 文件传输（发送侧）—— 一个文件可以发给多个接收方
 *
 * ## 关键：把「文件」和「传输」拆开
 *
 * 一份文件可能同时发给多个人。之前用 `file_id` 做 key，两处就打架了：
 * - `peer` 被后接受的人覆盖
 * - 第一个收完后 `delete` 条目，第二个还在读 → "读取第 N 块失败"
 *
 * 所以拆成两个 Map：
 * - `outFiles`：`file_id → { file, meta, room }` —— **只描述文件本身**，
 *   与发给谁无关，传输过程中**永不删除**
 * - `outgoing`：`file_id:peer → { state, done, ... }` —— 每条"传给某人"
 *   的通道各自独立：**某人刷新/失败只影响他那一条，别人照传**
 * ------------------------------------------------------------------------ */

const outFiles = new Map(); // file_id -> { file, meta, room }
/** `${file_id}:${peer}` → 单条出站传输的进度与状态 */
const outgoing = new Map();

const okey = (fileId, peer) => `${fileId}:${peer}`;

/* ---------------------------------------------------------------------------
 * 「我还能发出哪些文件」—— 保留策略
 *
 * 用户要的语义是：**发送方不刷新页面，别人就还能收**。
 * 所以不能像以前那样"这轮所有人都收完就删"，得把文件留到刷新。
 *
 * ⚠️ 但"留"的代价极不对称，必须分两类记账：
 *   · 从磁盘选的文件 / 拖进来的文件 → 只是一个指向磁盘的引用，几乎不占内存
 *   · **粘贴的截图** → `new File([...])` 造出来的，数据就在内存里
 *     （见 composer.js 的粘贴分支），留多久就占多久
 * 所以两个上限各管一段：总量 1GB 只是"文件预算"，内存类单独 100MB 才是真的防爆。
 *
 * 淘汰 = 从清单里消失 = 别人那边的卡片自动变"已过期"，**不需要额外通知**。
 * ------------------------------------------------------------------------ */
const OUT_TOTAL_CAP = 1024 * 1024 * 1024; // 1GB：所有保留文件大小之和
const OUT_MEM_CAP = 100 * 1024 * 1024;    // 100MB：仅"内存类"文件（粘贴的图）
/** 心跳里最多带多少个 file_id（太多会把广播撑大；更老的靠历史里的名字仍可见） */
const OUT_HB_MAX = 20;

/**
 * 这条出站记录对应的 `File` 数据是不是在**内存**里。
 *
 * ⚠️ 为什么必须由调用方显式告诉我们：`File` 是**结构化克隆**过来的，
 * 挂在它身上的自定义属性**会丢失**（试过 `file.__inMemory = true`，到 Worker 这边是 undefined）。
 * 而这件事又没法从 File 本身推出来 —— `new File([...])` 造的也有名字、有 size、
 * 有 lastModified，和磁盘文件长得一样。
 *
 * 所以判据来自 composer：**粘贴的内容（截图）一定是内存里的**，
 * 从系统文件管理器拖进来的走磁盘引用。
 * （局限：从网页里拖一张图过来其实也是内存数据，会被我们算成"磁盘"。
 *   影响有限 —— 总量 1GB 的上限仍然管着它，只是没有那 100MB 的额外保护。） */
function isMemoryBacked(entry) {
  return !!(entry && entry.mem);
}

/**
 * 按上限淘汰最老的条目。`outFiles` 的 Map 保持"插入顺序"，
 * 每次访问（重发/被接受）会把条目挪到末尾 —— 也就是 LRU。
 */
function evictOutFiles() {
  if (outFiles.size <= 1) return [];
  const dropped = [];
  const total = () => [...outFiles.values()].reduce((a, v) => a + (v.file?.size || 0), 0);
  const mem = () =>
    [...outFiles.values()]
      .filter((v) => isMemoryBacked(v))
      .reduce((a, v) => a + (v.file?.size || 0), 0);
  // 从最老的开始丢，直到两个上限都满足
  for (const [id, v] of [...outFiles]) {
    const over = total() > OUT_TOTAL_CAP || mem() > OUT_MEM_CAP;
    if (!over) break;
    if (outFiles.size <= 1) break; // 至少留一个
    outFiles.delete(id);
    dropped.push(id);
    pushOutgoing(id, v.room);
  }
  return dropped;
}

/** 把"当前还能发出的文件"同步给 Rust —— 心跳会广播它，别人据此判断
 *  历史里那个文件此刻能不能收。淘汰掉的自然就从清单里消失了。 */
function syncAvailableFiles(room = currentRoom) {
  if (roomSwitching) return;
  try {
    // 最新在前：`outFiles` 是插入序，倒过来就是"最近发的优先"。
    // 关键是只广播当前房间的文件，切房后不能把旧房间的 file_id 泄露出去。
    const ids = [...outFiles.entries()]
      .filter(([, entry]) => entry.room === room)
      .map(([id]) => id)
      .reverse()
      .slice(0, OUT_HB_MAX);
    node.set_available_files(ids);
  } catch {
    /* 节点还没起来：起来后 join 那一步会补一次 */
  }
}

/** 某文件当前的出站汇总（给 UI 用） */
function outgoingSummary(fileId, room = '') {
  const items = [...outgoing.values()].filter((x) => x.file_id === fileId);
  const total = items.length;
  const done = items.filter((x) => x.state === 'done').length;
  const failed = items.filter((x) => x.state === 'failed').length;
  const sending = items.filter((x) => x.state === 'sending').length;
  const rejected = items.filter((x) => x.state === 'rejected').length;
  const cancelled = items.filter((x) => x.state === 'cancelled').length;
  // 进度取"所有接收方的已完成块数之和 / 每人都收完所需块数之和"
  const sumDone = items.reduce((a, x) => a + x.done, 0);
  const sumNeed = items.reduce((a, x) => a + x.total, 0);
  return {
    room: outFiles.get(fileId)?.room || items[0]?.room || room,
    available: outFiles.has(fileId),
    peers: total,
    done,
    failed,
    sending,
    rejected,
    cancelled,
    doneChunks: sumDone,
    totalChunks: sumNeed,
    bytes: items.reduce((a, x) => a + x.bytes, 0),
    recipients: items.map((recipient) => ({
      id: recipient.peer,
      state: recipient.state,
      done: recipient.done,
      total: recipient.total,
      bytes: recipient.bytes,
      error: recipient.error,
    })),
  };
}

/** 汇总推送（每次某条进度变化都推一次，主线程只按 file_id 更新卡片） */
function pushOutgoing(fileId, room = '') {
  const s = outgoingSummary(fileId, room);
  push('transfer:send', { file_id: fileId, ...s });
}

/** 哈希切片大小：4MB。按块大小（16KB）切会有 2.4 万次跨边界调用，太慢。 */
const HASH_SLICE = 4 * 1024 * 1024;

/**
 * 回读**已落盘**的文件算 BLAKE3（hex）。
 *
 * 为什么需要：断点续传时 Rust 侧只拿到"本轮补的那些块"，
 * 算不出整文件哈希，所以 `wasm_api.rs` 的 `finish()` 在续传分支里
 * **明确跳过了整文件校验**。那半边只能由这里补上 —— 否则"续传"
 * 就等于"关掉内容校验"，产出一个静默损坏却显示成功的文件（缺陷 F5）。
 *
 * 顺带返回真实大小，调用方要拿它和邀约里的 `size` 对齐。
 */
async function hashFileHandle(handle) {
  const file = await handle.getFile();
  const hasher = new wasm.JsHasher();
  let off = 0;
  while (off < file.size) {
    const end = Math.min(off + HASH_SLICE, file.size);
    const buf = await file.slice(off, end).arrayBuffer();
    hasher.update(new Uint8Array(buf));
    off = end;
  }
  return { hash: hasher.finish(), size: file.size };
}

async function pickAndSend({ file, room, mem }) {
  const CHUNK = 16 * 1024;
  const total = Math.ceil(file.size / CHUNK);

  // 增量算根哈希（不把文件读进内存）
  const hasher = new wasm.JsHasher();
  let off = 0;
  while (off < file.size) {
    const end = Math.min(off + HASH_SLICE, file.size);
    const buf = await file.slice(off, end).arrayBuffer();
    hasher.update(new Uint8Array(buf));
    off = end;
    push('transfer:hash', { name: file.name, pct: Math.round((off / file.size) * 100) });
  }
  const rootHash = hasher.finish();

  const meta = JSON.parse(node.file_meta(file.name, file.size, file.type || '', rootHash));
  outFiles.set(meta.file_id, { file, meta, room, total, mem: !!mem });
  // 先按上限淘汰（粘贴的截图可能好几个），再把最终清单同步给 Rust。
  // Rust 那侧一变就立刻广播心跳 → 房间里的人马上看到"又有新文件可收了"。
  evictOutFiles();
  syncAvailableFiles();
  // ⚠️ 传 room：算哈希可能读了好几秒，期间用户可能已切房间。
  //    Rust 会核对"发起时意图的房间 == 当前房间"，不一致直接失败 ——
  //    宁可不发，也不要把私密文件的邀约发到别的房间（报告 P1-7）。
  //    失败时把这个文件从清单里摘掉，否则心跳会一直对外声称"还能发它"。
  try {
    await node.invite_file(JSON.stringify(meta), room);
  } catch (e) {
    outFiles.delete(meta.file_id);
    syncAvailableFiles();
    const why = String(e?.message ?? e);
    push('transfer:send-failed', { file_id: meta.file_id, name: meta.name, reason: why });
    throw new Error(`房间已切换，文件未发送（${why}）。请切回原房间后重试。`);
  }
  return { meta, total, summary: outgoingSummary(meta.file_id) };
}

async function onAccepted(ev) {
  const fileId = ev.file_id ?? ev.fileId;
  const peer = ev.by;
  const relay = ev.receiver_relay ?? ev.receiverRelay;
  const have = ev.have || '';

  // ⚠️ 文件本身找不到才真的没法传（正常情况下 outFiles 不会被删）
  const t = outFiles.get(fileId);
  if (!t) {
    push('transfer:peer-error', { file_id: fileId, peer, error: '文件已不在内存（可能页面重载过）' });
    return;
  }

  // ⚠️ 房间必须对得上（F7）：Accept 是广播消息，可能来自用户已经离开的房间。
  //    放过去的话，发送方会往一个"自己已经不在那儿"的房间对应的接收方传数据。
  if (ev.room && t.room && ev.room !== t.room) {
    push('transfer:peer-error', {
      file_id: fileId,
      peer,
      error: `忽略来自其它房间（${ev.room}）的 Accept`,
    });
    return;
  }

  const k = okey(fileId, peer);
  let o = outgoing.get(k);
  if (o && o.state === 'sending') {
    // ⚠️ 同一个人已经有一条在传了：**直接忽略这条重复的 Accept**（F19）。
    //
    //    原来这里把旧的那条标成 failed 然后**新起一条流**，
    //    于是"重放 N 次 Accept"就等于"N 份并发上传"——
    //    一条小消息换一次整文件上传，是很好用的放大攻击。
    //    Rust 侧还有一道新鲜度窗口（`FILE_CTRL_MAX_AGE_MS`）挡老消息重放，
    //    这里挡的是"窗口内的重复投递"。
    if (!ev.retry) {
      push('transfer:peer-error', { file_id: fileId, peer, error: '已在传输中，忽略重复的 Accept' });
      return;
    }
    o.state = 'failed';
    o.error = '已被新的请求取代';
  }
  o = { file_id: fileId, room: t.room, peer, relay, state: 'sending', done: 0, total: t.total, bytes: 0, error: '' };
  outgoing.set(k, o);
  pushOutgoing(fileId);

  const { file, meta } = t;

  // ⚠️ 读回调在这里，用 File.slice() —— 数据不经过 WASM 内存，也不经过 postMessage
  const read = async (seq, size) => {
    if (outgoing.get(k) !== o || o.state !== 'sending') throw new Error('接收已停止');
    const buf = await file.slice(seq * size, (seq + 1) * size).arrayBuffer();
    return new Uint8Array(buf);
  };

  const onEvent = (json) => {
    let e;
    try {
      e = JSON.parse(json);
    } catch {
      return;
    }
    if (e.phase === 'sending') {
      const base = Math.max(0, t.total - e.total);
      const cur = outgoing.get(k);
      if (cur !== o || cur.state !== 'sending') return;
      cur.done = base + e.done;
      cur.bytes = e.bytes;
      cur.lastProgressAt = Date.now(); // 喂看门狗
      pushOutgoing(fileId);
    }
  };

  // ⚠️ 「无进度看门狗」——对某一条出站传输的**静默死亡**做检测。
  //
  // 为什么需要：对端刷新/关页面后，QUIC 不一定会立刻报错（可能在等 ACK 超时），
  // 实测**两分钟都没抛错**，于是那条 outgoing 永远挂在 `sending`，
  // 汇总里 `sending > 0` ⇒ 卡片永远是"传输中"，用户无从下手。
  //
  // 判据：超过 STALL_MS 没有任何字节推进，就认为这条断了。
  // （正常传输时每块都会 `lastProgressAt`，不会误杀。）
  const STALL_MS = 45_000;
  const cur0 = outgoing.get(k);
  cur0.lastProgressAt = Date.now();
  const watchdog = setInterval(() => {
    const cur = outgoing.get(k);
    if (cur !== o || cur.state !== 'sending') {
      clearInterval(watchdog);
      return;
    }
    if (Date.now() - (cur.lastProgressAt || 0) > STALL_MS) {
      clearInterval(watchdog);
      cur.state = 'failed';
      cur.error = '对方长时间没有响应（可能已离开或刷新了页面）';
      pushOutgoing(fileId);
    }
  }, 5000);

  try {
    const res = await node.send_file_to(JSON.stringify(meta), peer, relay, have, read, onEvent);
    clearInterval(watchdog);
    const { bytes } = JSON.parse(res);
    const cur = outgoing.get(k);
    // ⚠️ 只有当这条还处于 `sending` 时才认这个"成功"。
    //
    // 为什么：看门狗（或对端的 Reject）可能**早就**把这条标失败了，
    // 而 `send_file_to` 是"卡在对端身上"的 —— 它往往要过很久才返回
    // （实测对端消失后 2 分钟才抛错；若对端只是走了而连接未断，
    //  它甚至可能以"发完了"的姿态返回，因为数据被写进了本地缓冲）。
    //
    // 不判状态的话，会把已经判定为"对方失联"的通道**改回 done**，
    // 于是汇总里 failed 消失、卡片从"失败"跳回"已完成" —— 与事实相反。
    if (cur === o && cur.state === 'sending') {
      cur.state = 'done';
      cur.done = t.total;
      cur.bytes = bytes;
      cur.error = '';
    }
    pushOutgoing(fileId);
  } catch (e) {
    clearInterval(watchdog);
    const cur = outgoing.get(k);
    // 同上：已经被判失败的不要再覆盖（保留更准确的原因，比如"对方刷新了"）
    if (cur === o && cur.state === 'sending') {
      cur.state = 'failed';
      cur.error = String(e?.message ?? e);
    }
    pushOutgoing(fileId);
  }
}

/* ---------------------------------------------------------------------------
 * 文件传输（接收侧）
 *
 * 主线程弹保存对话框拿到句柄后传进来；之后每块的写入都在这里做。
 * ------------------------------------------------------------------------ */

const inTransfers = new Map(); // file_id -> { meta, handle, have, writable, ... }

const DB_NAME = 'iroh-transfers';
const DB_STORE = 'bitmaps';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const r = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return undefined;
  }
}

async function idbPut(key, value) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 配额/隐私模式失败就算了，降级为不可用 */
  }
}

async function idbDel(key) {
  try {
    const db = await idb();
    await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {
    /* ignore */
  }
}

/* 位图工具（与 Rust 侧语义一致：每字节 8 块，LSB 在前） */
const POP = new Uint8Array(256);
for (let i = 0; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1];

const bitmap = {
  new: (n) => new Uint8Array(Math.ceil(n / 8)),
  get: (bm, i) => (bm[i >> 3] & (1 << (i & 7))) !== 0,
  set: (bm, i) => {
    bm[i >> 3] |= 1 << (i & 7);
  },
  count: (bm) => {
    let n = 0;
    for (const b of bm) n += POP[b];
    return n;
  },
  toB64: (bm) => {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bm.length; i += chunk) {
      s += String.fromCharCode(...bm.subarray(i, i + chunk));
    }
    return btoa(s);
  },
  fromB64: (b64) => {
    if (!b64) return new Uint8Array(0);
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  },
};

/** 探测目标文件当前大小。拿不到返回 null。 */
async function probeHandleSize(handle) {
  try {
    if (typeof handle.getFile === 'function') {
      const f = await handle.getFile();
      return f.size;
    }
    return null;
  } catch {
    return null;
  }
}

async function acceptFile(file_id, meta, handle, wantResume, useOpfs, room) {
  const total = Math.ceil(meta.size / meta.chunk_size);
  const key = `${meta.root_hash}:${meta.size}`;

  // 测试用：不开对话框、也不依赖主线程传句柄，
  // 直接在 Worker 里用 OPFS 造一个真实句柄（同类型，天然可克隆）
  if (useOpfs) {
    const root = await navigator.storage.getDirectory();
    const safe = meta.name.replace(/[^\w.-]/g, '_');
    // ⚠️ **不能每次 accept 都删文件**。
    //    删了就等价于"每次都从头开始"，断点续传永远测不出来
    //    （表现为第 1 轮收的块在第 2 轮消失、最终文件前段是 0）。
    //    清理交给 `resetOpfs` RPC，由测试在**开测前**调一次。
    handle = await root.getFileHandle(safe, { create: true });
  }

  // ── 断点续传：旧位图**必须能证明它对应这个文件**，否则宁可从头收 ──
  //
  // 报告 P1-4 复现过的坑：旧逻辑只判断 `existingSize < meta.size`
  // 就继承位图，而**空文件也满足**（0 < 1MB）。于是"换了个保存位置、
  // 选了个空文件"也会被当成半截文件 → 发送方被告知"第 0 块已有"、
  // 只补第 1 块 → 最终文件缺了开头却显示成功。
  //
  // 现在要求三条同时成立，缺一条就从头收（代价只是重传一次，
  // 而错误续传会产出**静默损坏的文件**）：
  //   1. 旧位图记的**文件名**与本次一致（同一份元信息才谈得上续传）
  //   2. 目标文件大小 **> 0**（空文件一律从头收）
  //   3. 目标文件大小 **恰好等于 "已收块数 × 块大小"**
  //      —— 少了说明内容不全（不能只补缺块），多了说明是别的文件
  let have = bitmap.new(total);
  let resumed = 0;
  let resumeNote = '';
  if (wantResume) {
    const prev = await idbGet(key);
    if (prev && prev.have) {
      const existingSize = await probeHandleSize(handle);
      const cand = bitmap.fromB64(prev.have);
      const candCount = bitmap.count(cand);
      if (candCount <= 0) {
        resumeNote = '旧位图为空，从头收';
      } else if (existingSize === null) {
        // 读不出大小 = 无法证明，保守从头收
        resumeNote = '读不出目标文件大小，从头收';
      } else if (existingSize === 0) {
        // ⚠️ 这就是报告复现的那一步：空文件绝不能当"半截文件"
        resumeNote = '目标文件是空的，从头收';
        await idbDel(key);
      } else if (prev.name !== meta.name) {
        resumeNote = '旧位图属于另一个文件，从头收';
        await idbDel(key);
      } else {
        const expectPartial = candCount * meta.chunk_size;
        if (existingSize !== expectPartial) {
          // 3 的反面：大小对不上"已收块数"，说明落盘内容与位图已脱节
          resumeNote = `目标文件大小 ${existingSize} 与位图预期 ${expectPartial} 不符，从头收`;
          await idbDel(key);
        } else if (existingSize >= meta.size) {
          resumeNote = '目标文件已完整，从头收';
          await idbDel(key);
        } else {
          have = cand;
          resumed = candCount;
        }
      }
    }
  }
  if (resumeNote) push('transfer:note', { file_id, note: resumeNote });

  // ⚠️ keepExistingData 必须传：默认 false 会丢弃文件已有内容，
  //    断点续传补出来的文件就是坏的。
  const writable = await handle.createWritable({ keepExistingData: resumed > 0 });
  const CHUNK = meta.chunk_size;

  let doneCount = resumed;
  let dirtySince = resumed;
  let lastEmit = 0;
  let pendingSave = null;
  // 内容校验失败等"断点已不可信"的失败原因。
  // 非 null 时 abort 会**丢弃位图**而不是保存（见 finish / abort）。
  let fatal = null;

  const write = async (seq, bytes) => {
    await writable.write({ type: 'write', position: seq * CHUNK, data: bytes });
    if (!bitmap.get(have, seq)) {
      bitmap.set(have, seq);
      doneCount++;
    }
    // 测试钩子：只在"记录写入日志"打开时回传块序号（**不回传数据**，
    // 所以消息通道上仍然只有元信息）。生产路径不会开这个开关。
    if (testMode) push('transfer:chunk', { file_id, seq });
    const now = Date.now();
    if (now - lastEmit >= 150) {
      lastEmit = now;
      push('transfer:recv', {
        file_id,
        done: doneCount,
        total,
        bytes: Math.min(doneCount * CHUNK, meta.size),
      });
    }
    if (doneCount - dirtySince >= 64) {
      dirtySince = doneCount;
      pendingSave = idbPut(key, {
        have: bitmap.toB64(have),
        name: meta.name,
        size: meta.size,
        ts: Date.now(),
      });
    }
  };

  const finish = async () => {
    if (pendingSave) await pendingSave.catch(() => {});
    await writable.close();

    // ⚠️ **续传的内容校验在这里做**（缺陷 F5）。
    //    Rust 侧在 `resumed > 0` 时算不出整文件哈希、已明确跳过校验，
    //    所以整份文件的校验只能由持有文件句柄的这一侧补上。
    //    不做的话，"续传"就是"关掉内容校验"：只要落盘的前缀不对
    //    （用户选了同名同大小的另一个文件、半截文件被改过、同步工具动过……），
    //    产出的就是静默损坏、却报"已完成"的文件。
    if (resumed > 0) {
      const want = String(meta.root_hash || '').trim().toLowerCase();
      const { hash, size } = await hashFileHandle(handle);
      if (size !== meta.size) {
        fatal = `内容校验失败：落盘大小 ${size} 与邀约 ${meta.size} 不符`;
        throw new Error(fatal);
      }
      if (!want || hash.toLowerCase() !== want) {
        fatal =
          `内容校验失败：整文件 BLAKE3 与邀约不符` +
          `（期望 ${want.slice(0, 16) || '(空)'}…，实际 ${hash.slice(0, 16)}…）`;
        throw new Error(fatal);
      }
      push('transfer:verified', { file_id, resumed });
    }

    await idbDel(key);
    inTransfers.delete(file_id);
    // ⚠️ 末尾块通常不满 CHUNK，直接乘会多报，必须夹到 meta.size（P3-1）
    push('transfer:done', {
      file_id,
      direction: 'recv',
      bytes: Math.min(doneCount * CHUNK, meta.size),
      total,
    });
  };

  const abort = async (reason) => {
    if (pendingSave) await pendingSave.catch(() => {});
    // ⚠️ 不要调 writable.abort()：它会把已写入内容**回滚丢弃**，
    //    而我们要的正是"把已下载的部分留在磁盘上，下次接着传"。
    try {
      await writable.close();
    } catch {
      /* 可能已经关了 */
    }
    if (fatal) {
      // 内容校验失败 ⇒ 断点**已经不可信**，必须丢掉位图。
      // 这里不能沿用下面那条 `idbPut`：否则坏前缀会被原样保留，
      // 用户下次"继续接收"又会在同一个坏前缀上续传（F5 的原始问题）。
      await idbDel(key);
      inTransfers.delete(file_id);
      push('transfer:error', { file_id, error: fatal });
      return;
    }
    await idbPut(key, {
      have: bitmap.toB64(have),
      name: meta.name,
      size: meta.size,
      ts: Date.now(),
    });
    push('transfer:paused', { file_id, reason, done: doneCount, total });
  };

  // ⚠️ 传 room：`Accept` 是广播消息，必须发进**邀约所在的那个房间**。
  //    Rust 侧会核对"期望房间 == 当前房间"，不一致直接失败（F7）——
  //    否则会出现在 B 房间广播 Accept、而发送方在 A 房间永远收不到、
  //    接收侧永久卡住的情况（F13）。
  await node.accept_and_receive(
    file_id,
    JSON.stringify(meta),
    bitmap.toB64(have),
    room,
    write,
    finish,
    abort,
  );
  return { resumed, total };
}

/* ---------------------------------------------------------------------------
 * 消息入口
 * ------------------------------------------------------------------------ */

self.onmessage = async (e) => {
  const m = e.data;

  if (m.type === 'boot') {
    try {
      const id = await boot(m.cfg);
      push('booted', { endpointId: id });
    } catch (err) {
      push('boot:error', { error: String(err?.message ?? err) });
    }
    return;
  }

  if (m.type === 'rpc') {
    const { id, method, args = [] } = m;
    try {
      let value;
      switch (method) {
        case 'endpointId':
          value = node.endpoint_id();
          break;
        case 'online':
          await node.online();
          value = null;
          break;
        case 'join':
          {
            const generation = ++roomJoinGeneration;
            const joiningRoom = String(args[0] || '');
            roomSwitching = true;
            try {
              await node.join(joiningRoom, args[1]);
              if (generation === roomJoinGeneration) {
                currentRoom = joiningRoom;
                roomSwitching = false;
                // Rust 侧 join 会清空本地文件清单；只补回新房间所属文件。
                syncAvailableFiles();
              }
            } catch (error) {
              if (generation === roomJoinGeneration) {
                currentRoom = '';
                roomSwitching = false;
                syncAvailableFiles();
              }
              throw error;
            }
          }
          value = null;
          break;
        case 'leaveRoom':
          // 切房间时**先广播"我离开了"再退订**（在 net.js 的 joinRoom 里调用）。
          // 这是唯一能可靠发出离开声明的时机，别人不用等 25~45 秒的心跳超时。
          {
            const generation = ++roomJoinGeneration;
            roomSwitching = true;
            try {
              await node.leave_room();
              if (generation === roomJoinGeneration) {
                currentRoom = '';
                roomSwitching = false;
                syncAvailableFiles();
              }
            } catch (error) {
              if (generation === roomJoinGeneration) {
                roomSwitching = false;
                syncAvailableFiles();
              }
              throw error;
            }
          }
          value = null;
          break;
        case 'queryFile':
          // 点了联系不上的文件卡片 → 广播质询，让还在持有的发送方重播心跳认领。
          // ⚠️ args[2] 是房间：质询只能发进"卡片所属的那个房间"（F7）。
          await node.query_file(String(args[0]), String(args[1]), String(args[2]));
          value = null;
          break;
        case 'setNickname':
          node.set_nickname(args[0]);
          value = null;
          break;
        case 'send':
          value = await node.send(args[0]);
          break;
        case 'history':
          // ⚠️ 第三个参数是**复合游标** `"<ts>:<id>"`（字符串），不是毫秒时间戳。
          //    只传时间戳会漏掉同一毫秒里的消息 —— 游标边界把它们整体跳过了。
          value = await node.fetch_history(args[0], args[1], String(args[2] ?? ''));
          break;
        case 'relayStatus':
          value = node.relay_status_json();
          break;
        case 'pickAndSend':
          value = JSON.stringify(
            await pickAndSend({ file: args[0], room: args[1], mem: args[2] }),
          );
          break;
        case 'resend': {
          // 重新发起邀约（用在"某个接收方刷新了/断了"之后）。
          //
          // 参数：`fileId`，以及可选的 `peer`（只想重发给某个人时）。
          // 复用同一个 `file_id`：接收端靠它找回断点位图，这样对方接受后
          // 是**断点续传**而不是从头再来。
          const fid = String(args[0]);
          const wantPeer = args[1] ? String(args[1]) : '';
          const t = outFiles.get(fid);
          if (!t) throw new Error('文件已不在内存（页面重载过），请重新选择文件');
          await node.invite_file(JSON.stringify(t.meta), t.room || '');
          for (const recipient of outgoing.values()) {
            if (recipient.file_id !== fid || (wantPeer && recipient.peer !== wantPeer)) continue;
            if (recipient.state !== 'failed' && recipient.state !== 'cancelled') continue;
            recipient.state = 'waiting';
            recipient.error = '';
          }
          pushOutgoing(fid);
          value = null;
          break;
        }
        case 'accept':
          // args: [file_id, meta, handle, wantResume, useOpfs]
          // args[5] = 房间（见 acceptFile 里对 accept_and_receive 的说明）
          value = JSON.stringify(
            await acceptFile(args[0], args[1], args[2], args[3], args[4], args[5]),
          );
          break;
        case 'reject':
          // ⚠️ args[2] 是房间：Reject 带自由文本理由，发错房间会向无关的人泄露（F7）
          await node.reject_file(args[0], args[1], String(args[2]));
          value = null;
          break;
        case 'cancel':
          node.cancel_file(args[0]);
          value = null;
          break;
        case 'clearBitmaps': {
          const db = await idb();
          await new Promise((resolve) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).clear();
            tx.oncomplete = resolve;
            tx.onerror = resolve;
          });
          value = null;
          break;
        }
        case 'pendingBitmaps': {
          // 测试用：列出当前 IndexedDB 里的断点续传 key
          const db = await idb();
          value = await new Promise((resolve) => {
            const r = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAllKeys();
            r.onsuccess = () => resolve(JSON.stringify(r.result));
            r.onerror = () => resolve('[]');
          });
          break;
        }
        case 'setTestMode': {
          testMode = !!args[0];
          value = null;
          break;
        }
        case 'outgoingDetail': {
          // 诊断：把每条出站通道（file_id:peer）的原始状态摊开。
          // 汇总数字（peers=1 却两个人都接受了）看不出问题在哪，需要这个。
          const fid = args[0] ? String(args[0]) : null;
          value = JSON.stringify(
            [...outgoing.entries()]
              .filter(([, o]) => !fid || o.file_id === fid)
              .map(([k, o]) => ({
                key: k,
                peer: o.peer.slice(0, 12),
                state: o.state,
                done: o.done,
                total: o.total,
                bytes: o.bytes,
                error: o.error,
                since: Date.now() - (o.lastProgressAt || 0),
              })),
          );
          break;
        }
        case 'outFiles': {
          // 诊断：内存里还留着哪些文件的引用（该删没删 = 泄漏）
          value = JSON.stringify(
            [...outFiles.entries()].map(([id, t]) => ({
              file_id: id,
              name: t.meta?.name,
              size: t.meta?.size,
              total: t.total,
            })),
          );
          break;
        }
        case 'accLog': {
          // 诊断：收到的 Accept 流水
          value = JSON.stringify(accLog);
          break;
        }
        case 'resetOpfs': {
          // 测试用：清掉 OPFS 里的目标文件（**只在开测前调一次**）。
          const root = await navigator.storage.getDirectory();
          const safe = String(args[0]).replace(/[^\w.-]/g, '_');
          try {
            await root.removeEntry(safe);
          } catch {
            /* 不存在就算了 */
          }
          value = null;
          break;
        }
        case 'readOpfsFile': {
          // 测试用：把 OPFS 里收到的文件读回来做**逐字节校验**。
          // 只回结论（不 ok 就带上出错位置），不回整个文件 —— 避免消息通道传大块数据。
          const root = await navigator.storage.getDirectory();
          const safe = String(args[0]).replace(/[^\w.-]/g, '_');
          const fh = await root.getFileHandle(safe);
          const f = await fh.getFile();
          const buf = new Uint8Array(await f.arrayBuffer());
          const expectSize = Number(args[1]);
          const chunkSize = Number(args[2]);
          let bad = null;
          if (buf.length !== expectSize) {
            bad = { ok: false, reason: `大小不符 ${buf.length} != ${expectSize}` };
          } else {
            for (let i = 0; i < buf.length; i++) {
              const want = ((i / chunkSize) | 0) & 0xff;
              if (buf[i] !== want) {
                bad = { ok: false, reason: `字节不符 @${i}`, at: i, got: buf[i], want };
                break;
              }
            }
          }
          value = JSON.stringify(bad ?? { ok: true, size: buf.length });
          break;
        }
        default:
          throw new Error(`未知的 RPC 方法: ${method}`);
      }
      rpcReply(id, true, value);
    } catch (err) {
      rpcReply(id, false, null, String(err?.message ?? err));
    }
    return;
  }

  if (m.type === 'stopAfterChunks') {
    // 测试钩子：让发送方只发前 N 块就断（验证断点续传）
    wasm.set_stop_after_chunks(m.n);
    return;
  }
};

/** 给主线程准备的 RPC 调用器（主线程侧实现，这里只是文档）
 *  主线程：`{type:'rpc', id, method, args}` → 回 `{type:'rpc:reply', id, ok, value, error}`
 */
void rpcSeq;
void rpcPending;
