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
import type { ChatMessage, FileMeta, PeerInfo, RelayStatus, RoomEvent } from '../bridge/types';
import type { RoomOptions, Transport } from '../bridge/transport';

export interface JoinParams {
  room: string;
  nickname: string;
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
  /** 收到的文件邀约：file_id → 状态（UI 据此渲染文件卡片与进度） */
  files: Record<string, FileInviteState>;
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
  const [joined, setJoined] = useState(false);
  const [room, setRoom] = useState<string | null>(null);
  const [nickname, setNickname] = useState(defaultNickname);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileInviteState>>({});

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

  /* ---- 订阅：只依赖 transport，**不依赖 room** ---- */
  useEffect(() => {
    if (!transport) return;

    setRelay(transport.relayStatus());

    const onEvent = (ev: RoomEvent): void => {
      // 约束 4：只处理当前房间的事件
      if ('room' in ev && ev.room !== roomRef.current) return;

      switch (ev.type) {
        case 'joined':
          setJoined(true);
          break;

        case 'relay':
          setRelay(ev.status);
          break;

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

        case 'fileRejected':
          // 对方拒绝了**我们**发的文件 —— v1 只能发不能收，这里只记一条提示。
          setError(`对方拒绝接收文件：${ev.reason || '未说明原因'}`);
          break;

        case 'error':
          setError(ev.message);
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
      setRelay(transport.relayStatus());
    };
    void tick(); // 立刻来一次（别等 5 秒）
    const id = setInterval(() => void tick(), 2000);

    return () => {
      unsub();
      clearInterval(id);
    };
  }, [transport]);

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
      setPeers([]);
      setJoined(false);
      setError(null);

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
      joined,
      room,
      nickname,
      error,
      files,
      join,
      leave,
      send,
      acceptFile,
      rejectFile,
      clearError,
    }),
    [
      messages,
      peers,
      relay,
      joined,
      room,
      nickname,
      error,
      files,
      join,
      leave,
      send,
      acceptFile,
      rejectFile,
      clearError,
    ],
  );
}
