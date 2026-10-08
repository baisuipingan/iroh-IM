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
import type { ChatMessage, PeerInfo, RelayStatus, RoomEvent } from '../bridge/types';
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
}

export interface RoomActions {
  join: (p: JoinParams) => Promise<void>;
  leave: () => Promise<void>;
  send: (text: string) => Promise<void>;
  clearError: () => void;
}

export function useRoom(transport: Transport | null, defaultNickname = '匿名'): RoomState & RoomActions {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [relay, setRelay] = useState<RelayStatus>({ url: null, connected: false });
  const [joined, setJoined] = useState(false);
  const [room, setRoom] = useState<string | null>(null);
  const [nickname, setNickname] = useState(defaultNickname);
  const [error, setError] = useState<string | null>(null);

  /** 已见过的消息 id —— 去重用的（约束 3） */
  const seen = useRef(new Set<string>());
  /**
   * 当前房间的"最新值"。
   * ⚠️ 必须是 ref 且**在 await 之前同步赋值**（见文件头说明）：
   *    - 用 state 的话，join() 期间的事件会被"房间核对"挡掉
   *    - 闭包捕获更糟：换房后回调里还是旧房名
   */
  const roomRef = useRef<string | null>(null);

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

        case 'error':
          setError(ev.message);
          break;

        default:
          // 文件类事件 v1 暂不处理（接收功能待原生模块接入）
          break;
      }
    };

    const unsub = transport.subscribe(onEvent);
    const id = setInterval(() => setRelay(transport.relayStatus()), 5000);

    return () => {
      unsub();
      clearInterval(id);
    };
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
      }
    },
    [transport, defaultNickname],
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

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || !transport) return;
      try {
        await transport.send(body);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [transport],
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
      join,
      leave,
      send,
      clearError,
    }),
    [messages, peers, relay, joined, room, nickname, error, join, leave, send, clearError],
  );
}
