/* ============================================================================
 * useRoom —— 把一个 Transport 的状态收敛成 UI 好用的形状
 *
 * 职责边界：
 *   - **它只管"把事件流变成可渲染的 state"**，不做协议、不做校验（那是 Rust 的事）
 *   - UI 组件不许直接碰 Transport，一律通过这个 hook —— 这样换掉
 *     MockTransport → NativeTransport 时，UI 一行都不用改
 *
 * ★★ 最重要的设计：**join 由本 hook 提供，而不是让调用方去 await transport.join()**
 *
 *   踩过的坑（真机截图：卡在「正在进入房间…」，但成员数是 3）：
 *
 *     handleJoin() → await transport.join(...)   ← joined / history 在 await 期间就发了
 *                        ↓
 *                  setRoom(room)                  ← 状态这里才设
 *                        ↓
 *                  订阅才生效                     ← 太晚，事件已经过去
 *
 *   于是 `joined` 永远 false、历史一条不剩。**换成原生模块一样会中招**
 *   （真实现的 join 同样会在 await 期间吐事件），所以必须在协议适配层解决。
 *
 *   修法两条一起上：
 *     1. 订阅**不依赖 `room` 状态**，只要 transport 就位就订阅
 *     2. `roomRef` 在 **await 之前**同步赋值 —— 事件的房间核对才认得出它
 *
 * ★ 另三条不减的约束（都来自 Web 端踩过的坑）：
 *     3. 消息按 id 去重（gossip 会重复投递，历史前插也会撞）
 *     4. 只认当前房间的事件（换房瞬间旧房间的迟到事件会到）
 *     5. 带 `file` 的消息渲染成卡片，不是文本气泡
 * ==========================================================================*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { haptic } from '../haptics';
import type {
  ChatMessage,
  FileMeta,
  PeerInfo,
  RelayInfoLike,
  RelayStatus,
  RoomEvent,
} from '../bridge/types';
import type { RoomOptions, Transport } from '../bridge/transport';

export interface JoinParams {
  room: string;
  nickname: string;
}

/** 一个**我发出的**文件在 UI 上的状态 */
export interface OutFileState {
  meta: FileMeta;
  /** `publishing` = 正在算哈希+广播邀约；之后等对方点接收 */
  status: 'publishing' | 'offered' | 'sending' | 'done' | 'failed' | 'rejected';
  detail?: string;
}

export interface RoomState {
  /** 已按时间升序排好的消息 */
  messages: ChatMessage[];
  peers: PeerInfo[];
  relay: RelayStatus;
  /** 服务端确认进房（`joined` 事件）—— 不是"点了进房按钮" */
  joined: boolean;
  /** 当前房间（null = 还在进房页） */
  room: string | null;
  nickname: string;
  error: string | null;
  /** **全部**配置的中继及状态（状态页要列出来） */
  relayList: RelayInfoLike[];
  /** 收到的文件邀约：file_id → 状态（UI 据此渲染文件卡片与进度） */
  files: Record<string, FileInviteState>;
  /** **我发出的**文件：file_id → 状态（等对方接收 / 传输中 / 完成） */
  outFiles: Record<string, OutFileState>;
  /**
   * 暂时联系不上房间里的任何其他人（常驻节点重启中 / 那台中继不可达）。
   *
   * ⚠️ 与 `error` 是两回事：房间**已经进去了**，消息会排队等邻居。
   *   UI 该显示"正在重连"，而不是"进房失败"。
   */
  isolated: boolean;
  /**
   * **协议版本不一致**（v5 握手）：移动端与房间服务端谈的不是同一个版本。
   *
   * ⚠️ 这是**应用级**条件，不是房间级：可能在任何一次进房动作之前就到，
   *   所以先存下来、UI 一直显示 —— 它不会自愈，只能靠升级/刷新。
   *   `theirs` 为空串 = 对端响应里根本没这个字段（真正的旧版）。
   */
  protocolMismatch: { ours: string; theirs: string } | null;
}

export interface RoomActions {
  join: (p: JoinParams) => Promise<void>;
  leave: () => Promise<void>;
  send: (text: string) => Promise<void>;
  /**
   * 接收一个收到的文件（耗时操作，UI 要有"接收中"状态）。
   *
   * ★ 只传 `fileId`，**不要**传 meta —— 完整 meta 由本 hook 从
   *   `fileInvite` 事件缓存里取（见下面的实现）。
   *
   *   为什么不让调用方传：消息里的 `FileRef`（`ChatMessage.file`）与
   *   邀约里的 `FileMeta` **不是同一个东西** —— `FileRef` 少了
   *   `chunk_size` / `sender` / `sender_relay` / `ts` 四个字段，
   *   而 Rust 侧反序列化 `FileMeta` 时缺字段会直接失败。
   *
   *   ⚠️ 这个坑**类型系统拦不住**：`FileRef` 的字段是 `FileMeta` 的子集，
   *   TS 的结构化类型认为"字段更少的对象"可以赋给"字段更多的类型"
   *   （只要不缺必填项就兼容）—— 于是传 `FileRef` 编译通过、运行时才炸。
   *   真机上实测的报错：
   *     missing field `chunk_size` at line 1 column 102
   *   所以这里从**接口上**就不给传错的机会。
   */
  acceptFile: (fileId: string) => Promise<void>;
  /** 拒绝接收 */
  rejectFile: (fileId: string, reason: string) => Promise<void>;
  /**
   * 发布并发送一个文件：先广播邀约，**等对方点接收后自动推送数据**。
   *
   * 耗时操作（要先算 blake3）→ UI 要有"发布中"状态。
   * [uri] 来自 `expo-document-picker`。
   */
  publishFile: (uri: string, name: string, size: number, mime: string) => Promise<void>;
  /**
   * 改昵称（房间内生效）。
   *
   * 没进房时调它没有意义（Rust 侧会拒绝）—— 调用方自己判断。
   */
  setNickname: (name: string) => Promise<void>;
  clearError: () => void;
}

/** 一个文件邀约在 UI 上的状态 */
export interface FileInviteState {
  meta: FileMeta;
  /** 来自哪个房间（拒绝时要带上，见 Rust 侧 `reject_file` 的说明） */
  room: string;
  status: 'invited' | 'receiving' | 'done' | 'failed';
  /** 收完后的落盘描述（`Download/iroh`），或失败原因 */
  detail?: string;
}

/**
 * 进房时拉多少条历史。
 *
 * 与 Web 端保持一致（`frontend/js/ui/timeline.js` 的 `PAGE`）。
 * 更大不是更好：这是**一屏的初始内容**，不是全部历史；
 * 往上翻由分页（`fetchHistory` 带游标）继续取。
 */
const HISTORY_PAGE = 50;

export function useRoom(transport: Transport | null, defaultNickname = '匿名'): RoomState & RoomActions {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [relay, setRelay] = useState<RelayStatus>({ url: null, connected: false });
  const [relayList, setRelayList] = useState<RelayInfoLike[]>([]);
  const [joined, setJoined] = useState(false);
  const [room, setRoom] = useState<string | null>(null);
  const [nickname, setNickname] = useState(defaultNickname);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileInviteState>>({});
  const [outFiles, setOutFiles] = useState<Record<string, OutFileState>>({});
  const [isolated, setIsolated] = useState(false);
  const [protocolMismatch, setProtocolMismatch] = useState<{ ours: string; theirs: string } | null>(
    null,
  );

  /** 已见过的消息 id —— 去重用的（约束 3） */
  const seen = useRef(new Set<string>());
  /**
   * 当前房间的"最新值"。
   * ⚠️ 必须是 ref 且**在 await 之前同步赋值**（见文件头说明）：
   *    - 用 state 的话，join() 期间的事件会被"房间核对"挡掉
   *    - 闭包捕获更糟：换房后回调里还是旧房名
   */
  const roomRef = useRef<string | null>(null);
  /**
   * 当前昵称的"最新值"。
   * `send` 的依赖只有 transport（不想每次改昵称都重建回调），
   * 所以读 state 会拿到旧值 —— 用 ref 拿最新。
   */
  const nicknameRef = useRef<string>(defaultNickname);
  nicknameRef.current = nickname;

  /**
   * 文件邀约的"最新值"。
   *
   * `acceptFile` 的依赖只有 transport（不想每次 files 变化都重建回调），
   * 所以闭包里的 `files` 会是旧值 —— 而"点了接收时用的 meta"必须是**当下**
   * 这条邀约的完整 meta。用 ref 拿最新。
   *
   * ⚠️ 这里存的是 `fileInvite` 事件里的**完整 `FileMeta`**，
   *    不是消息里的 `FileRef`（少了 4 个字段，传下去 Rust 会拒）。
   */
  const filesRef = useRef<Record<string, FileInviteState>>({});
  filesRef.current = files;

  /**
   * **我发出的**文件（最新值）。
   *
   * 用途一：`fileAccepted` 事件来了要判断"这是我们发的文件吗"——
   * 接收方也会收到这个广播事件，不能无脑推。
   * 用途二：推送中/完成后更新 UI 状态。
   *
   * 和 `filesRef` 同理：订阅回调的闭包是旧的，必须用 ref 读最新。
   */
  const outFilesRef = useRef<Record<string, OutFileState>>({});
  outFilesRef.current = outFiles;

  /**
   * 把"我此刻还能发出的文件"清单同步给 Rust（心跳会把它广播出去）。
   *
   * ## 为什么**必须**接上（不是可选优化）
   *
   * Rust 收到"有人问某文件还在不在"（`fileQueryAsked`）时，会先检查
   * `j.files.iter().any(|f| f == &q.file_id)` —— **清单里没有这个 file_id
   * 就根本不通知我们**（见 `room.rs` 里 `should_claim` 的判断）。
   *
   * 所以不调这个方法的后果是：**别人点历史卡片问文件，我们永远不会被问到，
   * 也就永远没机会重发邀约** —— 那张卡片在对方那里永远救不回来。
   *
   * ## 清单里放什么
   *
   * 「我还能提供」= 我发出的、且**没有失败/被拒**的文件。
   * 失败或对方拒收的留着没意义（重发邀约也没人接）。
   *
   * ⚠️ Rust 那边只做**镜像**、不做淘汰决策（注释明确写了"真相在 JS 这边"），
   *    所以淘汰策略归这里管。上限交给 Rust 侧（它自己会裁剪）。
   */
  useEffect(() => {
    if (!transport) return;
    const ids = Object.values(outFiles)
      .filter((f) => f.status !== 'failed' && f.status !== 'rejected')
      .map((f) => f.meta.file_id);
    // 失败也不打扰用户：这只是"公告"，同步不上去顶多少一次救援机会
    void transport.setAvailableFiles(ids).catch(() => undefined);
  }, [transport, outFiles]);

  /* ---- 订阅：只依赖 transport，**不依赖 room** ---- */
  useEffect(() => {
    if (!transport) return;

    setRelay(transport.relayStatus());

    const onEvent = (ev: RoomEvent): void => {
      /* ★ 数据面存活：**任何**事件都算"我还连着"。
       *
       * 放在最前面 —— 一个事件被后面哪个分支 return 掉都不影响这条。
       * 这是断线判定的唯一可靠信号（`relay.connected` 断网时仍是 true，
       * 见 `lastRoomDataAt` 的说明）。
       *
       * ⚠️ 别只挑 presence 更新：消息、文件事件同样是"链路活着"的证据，
       *    只认心跳会让阈值退化成"必须有别人在持续说话"。
       */
      lastRoomDataAt.current = Date.now();

      // 约束 4：只处理当前房间的事件
      if ('room' in ev && ev.room !== roomRef.current) return;

      switch (ev.type) {
        case 'joined':
          setJoined(true);
          break;

        // ⚠️ 事件真名是 `relayStatus`（Rust `RoomEvent::RelayStatus{relays}`）。
        //    改造前这里写的是 `'relay'` + `ev.status` —— 类型不报错（当时是手抄的联合类型），
        //    但**从来没匹配上过**，于是中继状态只能靠 2 秒轮询兜着。
        //    现在类型来自 Rust，写错就编译不过；这里按真实形状取第一台。
        case 'relayStatus': {
          const first = ev.relays[0];
          setRelayList(ev.relays);
          setRelay({
            url: first?.url ?? null,
            connected: Boolean(first?.connected),
            rtt_ms: null, // HTTP 探测的延迟不在协议里，见 native.ts 的说明
          });
          break;
        }

        case 'history':
          // 历史是**整体替换**（首批）而不是追加
          setMessages(() => {
            const deduped: ChatMessage[] = [];
            for (const m of ev.messages) {
              if (seen.current.has(m.id)) continue;
              seen.current.add(m.id);
              deduped.push(m);
            }
            return deduped.sort((a, b) => a.ts - b.ts);
          });
          break;

        case 'message': {
          // 约束 3：去重
          if (seen.current.has(ev.message.id)) return;
          seen.current.add(ev.message.id);
          setMessages((prev) => [...prev, ev.message].sort((a, b) => a.ts - b.ts));
          // ⚠️ 只震"别人的消息"：自己的消息是本地回显插进来的（不走这个 case），
          //    但**别的设备**上如果是自己发的（比如 Web 端同账号），
          //    `ev.mine` 也会是 true —— 那时震一下就很多余。
          if (!ev.mine) haptic('message');
          break;
        }

        case 'presence':
          setPeers(ev.peers);
          break;

        case 'peerUp':
        case 'peerDown':
          // 成员增删的权威来源是 presence（软状态），peerUp/Down 只加速。
          // 这里不单独处理，避免与 presence 打架产生"幽灵成员"。
          break;

        /* ---- 文件 ---- */

        case 'fileInvite':
          // 有人发文件过来 → 记一条"待接收"，UI 渲染卡片与「接收」按钮。
          //
          // ⚠️ 不自动接收：接收要写公共目录（用户可见的副作用），
          //    必须由用户点确认。这与 Web 端一致。
          //
          // ⚠️ **必须核对房间**：事件是广播的，换房瞬间可能收到旧房的事件。
          //    不核对的话，新房间里会冒出一张旧房的文件卡片，
          //    而那个文件在当前房间根本收不到（Rust 侧 accept_file 会因
          //    房间不符拒绝）。这类"看得见却点不动"最难排查。
          if (ev.room !== roomRef.current) break;
          // 有文件来 → 震（节奏与普通消息不同，不看屏也知道是文件）
          haptic('file');
          setFiles((prev) => ({
            ...prev,
            [ev.meta.file_id]: {
              meta: ev.meta,
              room: ev.room,
              status: prev[ev.meta.file_id]?.status === 'done' ? 'done' : 'invited',
              detail: prev[ev.meta.file_id]?.detail,
            },
          }));
          break;

        case 'fileDone': {
          // 收完（或失败）。ok=false 时把原因写在卡片上，别只吞掉。
          // ⚠️ 同样核对房间（见 fileInvite 的说明）
          if (ev.room !== roomRef.current) break;
          setFiles((prev) => {
            const cur = prev[ev.file_id];
            if (!cur) return prev; // 不是我们正在收的文件（可能是对端视角的另一条链路）
            return {
              ...prev,
              [ev.file_id]: {
                ...cur,
                status: ev.ok ? 'done' : 'failed',
                detail: ev.ok ? cur.detail : ev.reason || '传输失败',
              },
            };
          });
          break;
        }

        case 'fileAccepted':
          /* 对方点了接收 → **我们**要把数据推过去。
           *
           * ⚠️ **先核对房间**：`fileAccepted` 是广播事件，
           *    别的房间的文件被接收时我们也会收到。不核对就会拿本房间的
           *    中继信息去推一个不属于这里的文件。
           *
           * ⚠️ 这是**发送方**才该处理的事件。接收方也会收到这个事件
           *    （协议是广播的），但那时 `file_id` 不在我们的"货架"里，
           *    原生侧会因"货架里没有这个 id"而失败 —— 所以这里先
           *    用 `outFiles` 过滤一道，避免无谓的原生调用与报错。
           *
           * ⚠️ `by` 是**接受方的 EndpointId**，`receiver_relay` 是他那台中继。
           *    推送必须拨**他**（不能靠猜 peers —— 房间人多时会猜错）。
           */
          if (ev.room !== roomRef.current) break;
          if (!outFilesRef.current[ev.file_id]) break;
          void pushToPeerRef.current(ev.file_id, ev.have, ev.by, ev.receiver_relay);
          break;

        case 'fileRejected': {
          // 对方拒绝了**我们**发的文件 —— 更新卡片状态
          // ⚠️ 同样核对房间（见 fileInvite 的说明）
          if (ev.room !== roomRef.current) break;
          const meta = outFilesRef.current[ev.file_id];
          if (meta) {
            setOutFiles((prev) => {
              const cur = prev[ev.file_id];
              if (!cur) return prev;
              return {
                ...prev,
                [ev.file_id]: { ...cur, status: 'rejected', detail: ev.reason || '对方拒绝了' },
              };
            });
          } else {
            setError(`对方拒绝接收文件：${ev.reason || '未说明原因'}`);
          }
          break;
        }

        case 'fileQueryAsked':
          /* 有人点了**历史里的文件卡片**，问"你还能提供这个文件吗"。
           *
           * 只有被问到的那个发送方会收到（Rust 侧按 `want == me` 过滤）。
           * 我们如果手里还留着，就**重发一次邀约**作为回应 ——
           * 对方直接拿到可接收的卡片，比"再播一次心跳"明确。
           *
           * ⚠️ 手里没有就**什么都不做**（`reofferFile` 返回 false）。
           *    沉默是协议认可的语义：沉默即视为该文件已过期。
           *    千万别报错打扰用户 —— 这是正常情况（比如文件已随货架淘汰）。
           */
          if (ev.room !== roomRef.current) break;
          void transport.reofferFile(ev.file_id).catch(() => undefined);
          break;

        case 'error':
          setError(ev.message);
          break;

        // 孤立 → 接回来了。
        //
        // ⚠️ 刻意**不写进 `error`**：进房是成功的，这是一个会自愈的状态。
        //   `isolated: false` 时补拉一次历史 —— 孤立期间漏掉的消息
        //   在常驻节点那边。复用重连那条路径（同一套去重 + 合并逻辑）。
        case 'isolated':
          setIsolated(ev.isolated);
          if (!ev.isolated && roomRef.current) void loadHistoryRef.current(roomRef.current);
          break;

        // 协议版本不一致（v5 握手）：服务端在响应里带了自己的版本，一比就知道。
        //
        // ⚠️ 不写进 `error`：这不是"操作失败"，而是"这一端该升级了"。
        //   也**不按房间过滤**：它与哪个房间无关，且只提示一次就够（Rust 侧去重）。
        case 'protocolMismatch':
          setProtocolMismatch({ ours: ev.ours, theirs: ev.theirs });
          break;

        default:
          // fileAccepted / fileQueryAsked 是**发送方**才关心的（谁接受了我发的文件）。
          // v1 移动端只能收，不处理。
          break;
      }
    };

    const unsub = transport.subscribe(onEvent);

    // ★ 中继状态刷新。
    //
    // ⚠️ 必须**先 await 刷新、再读缓存**：`relayStatus()` 是同步方法，
    //    它读的是 transport 内部的缓存；真实数据要异步问 Rust。
    //    不刷新的话进房页会永远停在「正在连接中继…」（真踩过）。
    //
    // 用 optional 调用而非原型判断：MockTransport 没有这个方法，
    // 它自己的 relayStatus 已经返回合理值。
    const tick = async (): Promise<void> => {
      const t = transport as { refreshRelayStatus?: () => Promise<void> };
      await t.refreshRelayStatus?.();
      const now = transport.relayStatus();
      setRelay(now);
      // 全量清单：状态页要列"配了几台、各自什么状态"
      setRelayList(transport.relayList());
      // 走 ref：effect 的依赖只有 transport，不该因为回调重建而重订阅
      onRelaySampleRef.current(now);
    };
    void tick(); // 立刻来一次（别等 5 秒）
    const id = setInterval(() => void tick(), 2000);

    return () => {
      unsub();
      clearInterval(id);
      // ★ 重连定时器也要清：不清的话组件卸载后它还会触发，
      //   去操作一个已经 shutdown 的节点（报错刷屏，且没有任何意义）。
      if (rejoinTimer.current) {
        clearTimeout(rejoinTimer.current);
        rejoinTimer.current = null;
      }
      rejoining.current = false;
      wasOnline.current = false;
      rejoinAttempt.current = 0;
    };
  }, [transport]);

  /* ==========================================================================
   * ★ 断线重连
   *
   * ## 为什么要自己写（Rust 侧不管这件事）
   *
   * iroh 的 endpoint 会自己重连中继、自己重建 gossip 邻居 —— 但**进房
   * 状态不会自动恢复**：掉线期间房间的订阅断了，恢复后没人替我们重新
   * `join()`，界面就永久停在"在房间里但收不到任何消息"。
   *
   * 浏览器的等价物在 `frontend/js/net.js` 的 `_goOnline()`：
   * 中继恢复后**自动回到刚才那个房间**（注释里那句"掉线重连后要自己回到
   * 刚才那个房间，否则用户发现消息全没了"）。这里按同样的思路做。
   *
   * ## 触发条件：relay 从「连上过」变成「断了」
   *
   * ⚠️ 不能只看 `!connected` 就去重连 —— App 刚启动、还没连上中继时
   *    也是 `connected: false`。那种情况由启动流程管，不该在这里插一脚。
   *    所以要看**状态迁移**：先见过 `connected: true`，之后才把
   *    `false` 当成"掉线"。
   *
   * ## 单飞 + 退避
   *
   * 中继抖动可能让 `connected` 反复跳；没有守卫就会连环重进房间
   *（每次进房都会重新拉历史、重订阅，反而更糟）。
   * 所以：同时在跑的重连**只允许一个**，且失败后按退避重试。
   * ======================================================================*/
  const wasOnline = useRef(false);
  const rejoining = useRef(false);
  const rejoinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rejoinAttempt = useRef(0);

  /**
   * **最后收到任何房间数据**的时刻（心跳 / 消息 / 文件事件都算）。
   *
   * ## 为什么不能只看 `relay.connected`（真机教训）
   *
   * 断网 25 秒后 `relay.connected` **仍然是 true** —— iroh 的 relay-actor
   * 会自己重试，从它视角"这条会话还在"。它是**传输层**的状态，
   * 不等于"网络可用"。
   *
   * ## 数据面信号：心跳
   *
   * 房间里只要**有别人**，他的 presence 心跳每 `PRESENCE_INTERVAL = 10s`
   * 来一次（见 `client-wasm/src/room.rs`）。所以：
   *
   *   有 peer 存在 + 长时间收不到任何东西 = 我和网络脱节了
   *
   * 阈值取 **30 秒**（= 3 个心跳周期）：足够容忍丢一两个包，
   * 又能比 Rust 侧自己的 `PRESENCE_TTL_MS = 35s` 早一点发现 ——
   * 早一点没坏处（重连是幂等的），晚一点用户就要多等。
   *
   * ## 只在"房间里确实有人"时才判定
   *
   * ⚠️ 空房间里本来就没有心跳来源，拿它判掉线会**永远误报**。
   *    所以先看 `peersRef.current.length > 0`。
   *    （自己一个人的时候，掉线与否确实无从判断 —— 这时靠 relay 状态兜底，
   *      它虽然不精确，但至少是唯一能用的信号。两层判据是叠加的。）
   */
  const lastRoomDataAt = useRef<number>(Date.now());
  const peersRef = useRef<PeerInfo[]>([]);
  // 数据面判据要用它（订阅回调里的闭包是旧的 → 必须走 ref）
  peersRef.current = peers;

  /** 静默多久算掉线（毫秒）。见 `lastRoomDataAt` 的说明。 */
  const SILENCE_MS = 30_000;

  /**
   * `loadHistory` 的最新值。
   *
   * 重连成功要拉一次历史补上掉线期间的消息，但 `loadHistory` 定义在后面，
   * 而它自己又依赖 `transport` —— 用 ref 转一手避免"定义顺序 + 循环依赖"
   * 两个问题（同 `pushToPeerRef` 的既有模式）。
   */
  const loadHistoryRef = useRef<(room: string) => Promise<void>>(async () => undefined);

  /**
   * 每次 relay 采样后的回调 —— 断线重连的入口。
   *
   * ⚠️ 必须是 **ref 转手**：这个函数在 `useEffect` 的 2s 定时器里被调用，
   *    而那个 effect 的依赖只有 `transport`。直接引用会让 effect 每次
   *    重建（进而重订阅 → 冷启动丢消息，这条本项目已踩过）。
   */
  const onRelaySampleRef = useRef<(s: RelayStatus) => void>(() => undefined);

  const onRelaySample = useCallback(
    (s: RelayStatus) => {
      if (!transport) return;
      const wantRoom = roomRef.current;
      const wantNick = nicknameRef.current;

      /* ---- 判据一：数据面静默（可靠）----
       *
       * 房间里有别人、但 30 秒没收到任何事件 → 我和网络脱节了。
       * 这是**唯一能识破"物理断网但 iroh 还以为在线"**的信号。
       */
      const hasPeers = peersRef.current.length > 0;
      const silentMs = Date.now() - lastRoomDataAt.current;
      const dataPlaneDead = hasPeers && silentMs > SILENCE_MS;

      /* ---- 判据二：中继状态（兜底）----
       *
       * 只在"房间里没有别人"时用 —— 那时没有心跳可依赖。
       * 它不精确（断网时可能仍是 true），但聊胜于无。
       *
       * ⚠️ 不把两个判据写成 `||` 的无脑组合：数据面说活着（刚收到东西）
       *    就不该因为 relay 报 false 去重连 —— 那会打断正常的会话。
       */
      const relayDead = !s.connected;
      const dead = dataPlaneDead || (!hasPeers && relayDead);

      if (!dead) {
        // 活着：重置退避，并记下"确实在线过"
        wasOnline.current = true;
        rejoinAttempt.current = 0;
        return;
      }

      // 从未连上过 → 还在启动阶段，不归这里管
      if (!wasOnline.current) return;
      // 没在房间里 → 没有要恢复的会话
      if (!wantRoom) return;
      // 已经在重连了（单飞）
      if (rejoining.current || rejoinTimer.current) return;

      /* 退避：1s → 2s → 4s → 8s，封顶 8s。
       *
       * ⚠️ 不等太久：中继恢复通常很快（iroh 自己会重连），
       *    我们要做的是"它好了就赶紧回房"，不是跟它比谁有耐心。
       *    但也要给一点延迟 —— `relayStatus` 是 2s 采样一次，
       *    刚断开那一下可能只是抖动，立刻重进纯属浪费。 */
      const delay = Math.min(1000 * 2 ** rejoinAttempt.current, 8000);
      rejoinAttempt.current += 1;

      rejoinTimer.current = setTimeout(() => {
        rejoinTimer.current = null;
        // 进房前再看一眼：可能在这段延迟里已经好了。
        // ⚠️ 同样要看**数据面** —— 刚收到过东西就说明已经恢复，
        //    这时不该再重进房间（重进会重拉历史，白闪一下）。
        const stillSilent =
          peersRef.current.length > 0 &&
          Date.now() - lastRoomDataAt.current > SILENCE_MS;
        const stillRelayDead = !transport.relayStatus().connected;
        if (!stillSilent && !(peersRef.current.length === 0 && stillRelayDead)) {
          wasOnline.current = true;
          rejoinAttempt.current = 0;
          return;
        }
        const room = roomRef.current;
        if (!room) return;

        rejoining.current = true;
        console.log(
          `[rejoin] 判定掉线（${dataPlaneDead ? `数据面静默 ${Math.round(silentMs / 1000)}s` : '中继断开'}），重新进入房间 ${room}`,
        );
        /* ⚠️ 走 `transport.join` 而**不是** `join()`，两者差别很关键：
         *
         *   `join()`（本 hook 的那个）会先 `setMessages([])` / `setOutFiles({})`
         *   / `setPeers([])` —— 那是**换房**语义。
         *   重连是**同一个房间**：把消息全清掉再拉回来，用户会看到
         *   整屏内容闪一下（而且历史只拉最近一页，更早的就真没了）。
         *
         *   所以只重订底层会话，UI 状态原样留着；
         *   重连后 `history` 事件会把最新一页合并进来（它自带去重）。 */
        transport
          .join({ room, nickname: nicknameRef.current })
          .then(() => {
            console.log(`[rejoin] 已重新进入 ${room}`);
            // 拉一次历史补上掉线期间错过的消息（去重逻辑与事件路径相同）
            void loadHistoryRef.current(room);
          })
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`[rejoin] 重新进房失败：${msg}`);
          })
          .finally(() => {
            rejoining.current = false;
          });
      }, delay);
    },
    // ⚠️ 依赖只有 transport：它跑在 2s 定时的闭包里，
    //    加别的依赖会让定时器反复重建（历史踩过：effect 重订阅丢消息）
    [transport],
  );
  onRelaySampleRef.current = onRelaySample;

  /**
   * 拉取某个房间的最新一页历史。
   *
   * 拉回来的消息走和 `<history>` 事件**完全相同**的去重 + 整体替换逻辑 ——
   * 两条路径（事件 / 主动拉）必须收敛到同一个结果，
   * 否则同一批消息会因为来源不同而表现不一致。
   */
  const loadHistory = useCallback(
    async (roomName: string) => {
      if (!transport) return;
      try {
        const page = await transport.fetchHistory(HISTORY_PAGE);
        // 期间换房了 → 丢弃（否则会把旧房的记录塞进新房）
        if (roomRef.current !== roomName) return;
        setMessages(() => {
          const deduped: ChatMessage[] = [];
          for (const m of page.messages) {
            if (seen.current.has(m.id)) continue;
            seen.current.add(m.id);
            deduped.push(m);
          }
          return deduped.sort((a, b) => a.ts - b.ts);
        });
      } catch (e) {
        // 历史拉不到不该挡住聊天 —— 只记一条错误，房间照常可用
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [transport],
  );

  const leave = useCallback(async () => {
    roomRef.current = null;
    setRoom(null);
    setJoined(false);
    setIsolated(false);
    setMessages([]);
    setPeers([]);
    seen.current = new Set();
    await transport?.leaveRoom().catch(() => undefined);
  }, [transport]);

  /* ---- join：**先同步安置状态，再 await** ---- */
  const join = useCallback(
    async (p: JoinParams) => {
      if (!transport) return;

      const roomName = p.room.trim();
      const nick = p.nickname.trim() || defaultNickname;

      // ① 同步：重置列表与去重表（换房不能看到旧房间的消息）
      seen.current = new Set();
      setMessages([]);
      // 换房要清掉"我发出的文件"状态 —— 那是**上一个房间**的会话状态。
      // 不清的话，新房间里会显示旧房的发送进度，而且 fileAccepted 的
      // "是我们发的吗"判断会被旧条目误命中。
      setOutFiles({});
      setPeers([]);
      setJoined(false);
      setError(null);
      setIsolated(false);

      // ② 同步：把房间"钉"进 ref —— 紧随其后的 joined/history 才认得出它
      roomRef.current = roomName;
      setRoom(roomName);
      setNickname(nick);

      // ③ 最后才 await：此时订阅已就位、roomRef 已就位，事件一条都不会丢
      try {
        await transport.join({ room: roomName, nickname: nick });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        roomRef.current = null;
        setRoom(null);
        return;
      }

      /* ---- ④ 拉历史（进房后补上"这间屋子之前说过什么"）----
       *
       * ★ 这一步**必须显式做**，不能指望进房时自动带回来。
       *
       *   Rust 的 `RoomNode::join()` 内部**确实**会调一次
       *   `fetch_history(room, 1)`，但那是为了"敲一下常驻节点让它订阅本房间"
       *   （见 room.rs 里 "已通知常驻节点订阅房间" 那条 log），
       *   **只取 `snapshot`，`messages` 直接丢弃** —— limit=1 也说明它
       *   压根没打算显示历史。
       *
       *   症状就是：房间明明有 4 条历史（服务端 SQLite 里查得到），
       *   但进房后界面永远是「还没有消息，说什么吧」。
       *   真机上排查了很久 —— 连接、TLS、ALPN 全正常，快照也回来了
       *   （所以能看到"2 人"），就是消息空着。
       *
       *   Web 端有这一步（frontend/js/ui/timeline.js 的 `_loadLatest`：
       *   `net.history(room, PAGE, '')`，空游标 = 取最新一页），移动端漏了。
       *
       * ⚠️ 用 await 而不是并发：历史要**先于**实时消息落定，
       *    否则新消息会被随后的整体替换冲掉。
       */
      await loadHistory(roomName);
    },
    [transport, defaultNickname, loadHistory],
  );
  // 重连成功后要用它补拉历史（见 onRelaySample）
  loadHistoryRef.current = loadHistory;

  /**
   * 改昵称。
   *
   * ⚠️ 顺序：**先发原生、成功后才改本地**。
   *    反过来的话，原生失败（比如没进房）时界面已经显示新名字了，
   *    而房间里别人看到的还是旧的 —— 两边不一致比"没改成"更难查。
   */
  const changeNickname = useCallback(
    async (name: string) => {
      if (!transport) return;
      const nick = name.trim() || defaultNickname;
      try {
        await transport.setNickname(nick);
        setNickname(nick);
      } catch (e) {
        setError(`改昵称失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [transport, defaultNickname],
  );

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || !transport) return;
      try {
        const id = await transport.send(body);
        // ★ 本地回显（自己的消息自己显示）。
        //
        // ⚠️ 为什么必须在这里做：Rust 的 `RoomNode::send()` **只广播 + 写本地历史，
        //    不会给订阅者发 `RoomEvent::Message`** —— 那是**有意为之**的一致性设计，
        //    远端消息才走 gossip 事件那条路。
        //    Web 端同样在 JS 侧回显（见 frontend/js/ui/composer.js 里
        //    `bus.emit(EV.MSG, { …, mine: true })`）。
        //
        //    少了这一步的症状：消息**真的发出去了**（gossip 层能看到
        //    多出一条 Broadcast），但自己界面上一片空白 ——
        //    "发出去了却看不见"，真机上卡了很久才定位。
        const mine: ChatMessage = {
          id,
          from: transport.endpointId,
          nickname: nicknameRef.current,
          text: body,
          ts: Date.now(),
          sig: '',
          file: null,
        };
        if (seen.current.has(id)) return; // 万一某天 Rust 也回推了同一条，别重复
        seen.current.add(id);
        setMessages((prev) => [...prev, mine].sort((a, b) => a.ts - b.ts));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [transport],
  );

  /* ---- 文件接收 ---- */

  /**
   * 把数据推给某个接收方（收到 `fileAccepted` 后调）。
   *
   * ⚠️ **不能并发推同一个 file_id**：两条链路会往同一个对端重复发数据。
   *    这里用状态位挡（`sending` / `done` 直接返回）。
   */
  const pushToPeer = useCallback(
    async (fileId: string, have: string, peerId: string, peerRelay: string) => {
      if (!transport) return;
      const cur = outFilesRef.current[fileId];
      if (!cur) return;
      // 已经在推 / 推完了 → 不重复（同一个文件可能被多个人接收，
      // 那种情况是**不同的事件**，`peerId` 不同，各自推各自的）
      if (cur.status === 'sending' || cur.status === 'done') return;

      setOutFiles((prev) => {
        const c = prev[fileId];
        if (!c) return prev;
        return { ...prev, [fileId]: { ...c, status: 'sending', detail: '正在发送…' } };
      });
      try {
        const bytes = await transport.pushFile(fileId, have, peerId, peerRelay);
        setOutFiles((prev) => {
          const c = prev[fileId];
          if (!c) return prev;
          return { ...prev, [fileId]: { ...c, status: 'done', detail: `已发送 ${bytes} 字节` } };
        });
        // 推完了从原生货架移除（不能重复推；也让货架不涨）
        await transport.forgetShelf(fileId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setOutFiles((prev) => {
          const c = prev[fileId];
          if (!c) return prev;
          return { ...prev, [fileId]: { ...c, status: 'failed', detail: msg } };
        });
        setError(`发送文件失败：${msg}`);
      }
    },
    [transport],
  );

  /** subscriber 里要调它，但它是 useCallback 定义的 —— 用 ref 转一手避免循环依赖 */
  const pushToPeerRef = useRef(pushToPeer);
  pushToPeerRef.current = pushToPeer;

  /**
   * 发布并发送一个文件：广播邀约 → 等对方点接收 → 自动推送数据。
   *
   * ⚠️ 这是**两段式**的：本方法只完成第一段（发布邀约），
   *    第二段（推数据）由 `fileAccepted` 事件触发（见订阅回调）。
   */
  const publishFile = useCallback(
    async (uri: string, name: string, size: number, mime: string) => {
      if (!transport) return;
      try {
        const meta = await transport.publishFile(uri, name, size, mime);
        setOutFiles((prev) => ({
          ...prev,
          [meta.file_id]: {
            meta,
            status: 'offered',
            detail: '已发出，等对方接收…',
          },
        }));

        /* ★ 本地回显：自己的文件卡片自己显示。
         *
         * ⚠️ 为什么必须在这里做：Rust 的 `invite_file()` 会调
         *    `send_file_proof()` 广播一条带 `FileRef` 的消息（这样后进房间的
         *    人也能看到"这里曾经有过这个文件"），但它和 `send()` 一样
         *    **只广播 + 写本地历史，不给订阅者发 `RoomEvent::Message`**。
         *
         *    症状与 `send()` 完全一样：文件**真的发出去了**（对方能看到卡片），
         *    但自己界面上一片空白 —— "发出去了却看不见"。
         *
         *    真机实测确认过：发布成功（logcat 有「已发布文件：s1.png」），
         *    但消息流里找不到它。
         */
        const id = `local-file-${meta.file_id}`;
        if (seen.current.has(id)) return;
        seen.current.add(id);
        const mine: ChatMessage = {
          id,
          from: transport.endpointId,
          nickname: nicknameRef.current,
          text: '',
          ts: meta.ts || Date.now(),
          sig: '',
          // ⚠️ 这里只需要 `FileRef` 的 5 个字段（消息内嵌用），
          //    不是完整 `FileMeta` —— 完整 meta 在 `outFiles` 里
          //    （UI 渲染卡片读的是 `message.file` + `outFiles[file_id]`）。
          file: {
            file_id: meta.file_id,
            name: meta.name,
            size: meta.size,
            mime: meta.mime,
          },
        };
        setMessages((prev) => [...prev, mine].sort((a, b) => a.ts - b.ts));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`发布文件失败：${msg}`);
      }
    },
    [transport],
  );

  /**
   * 接收一个文件。
   *
   * ⚠️ 这是个**长耗时**操作（310 MB 可能几分钟），且原生侧是阻塞调用。
   *    所以：先同步把状态置成 `receiving`（UI 立刻有反馈），再 await。
   *    这与 `join()` 的处理方式一致 —— 见文件头「先同步安置状态，再 await」。
   */
  const acceptFile = useCallback(
    async (fileId: string) => {
      if (!transport) return;

      // ★ 完整 meta 从**邀约缓存**里取，不从调用方传。
      //
      //   消息里的 `ChatMessage.file` 是 `FileRef` —— 只有 file_id/name/size/
      //   mime/root_hash，**没有** chunk_size/sender/sender_relay/ts。
      //   拿它当 `FileMeta` 传给 Rust 会在反序列化时失败（真机实测：
      //   `missing field \`chunk_size\``）。详见 RoomActions.acceptFile 的注释。
      //
      //   从 ref 读而不是从 state 读：`files` state 在闭包里可能是旧值
      //   （这个 hook 的既有约束 —— 见文件头「先同步安置状态，再 await」）。
      const meta = filesRef.current[fileId]?.meta;
      if (!meta) {
        // 没有邀约 = 这条是历史消息（发送方早就不在了），如实告诉用户
        setError('这条是历史记录，发送方已不在线，无法接收');
        return;
      }

      setFiles((prev) => {
        const cur = prev[fileId];
        // 已经收完或正在收 → 不重复发起（重复调会让两条链路写同一个文件）
        if (!cur || cur.status === 'receiving' || cur.status === 'done') return prev;
        return { ...prev, [fileId]: { ...cur, status: 'receiving', detail: undefined } };
      });
      try {
        const saved = await transport.acceptFile(fileId, meta);
        setFiles((prev) => {
          const cur = prev[fileId];
          if (!cur) return prev;
          return {
            ...prev,
            [fileId]: {
              ...cur,
              status: 'done',
              detail: `已保存到 ${saved.location}/${saved.name}`,
            },
          };
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setFiles((prev) => {
          const cur = prev[fileId];
          if (!cur) return prev;
          return { ...prev, [fileId]: { ...cur, status: 'failed', detail: msg } };
        });
        setError(`接收文件失败：${msg}`);
      }
    },
    [transport],
  );

  const rejectFile = useCallback(
    async (fileId: string, reason: string) => {
      if (!transport) return;
      const cur = files[fileId];
      try {
        await transport.rejectFile(fileId, reason);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      // 无论拒绝是否成功，本地都把这条移出待办（用户意图是"不要了"）
      void cur;
      setFiles((prev) => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
    },
    [transport, files],
  );

  const clearError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      messages,
      peers,
      relay,
      relayList,
      joined,
      isolated,
      protocolMismatch,
      room,
      nickname,
      error,
      files,
      outFiles,
      join,
      leave,
      send,
      acceptFile,
      rejectFile,
      publishFile,
      setNickname: changeNickname,
      clearError,
    }),
    [
      messages,
      peers,
      relay,
      relayList,
      joined,
      isolated,
      protocolMismatch,
      room,
      nickname,
      error,
      files,
      outFiles,
      join,
      leave,
      send,
      acceptFile,
      rejectFile,
      publishFile,
      changeNickname,
      clearError,
    ],
  );
}
