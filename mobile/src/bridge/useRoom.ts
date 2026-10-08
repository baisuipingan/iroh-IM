/* ============================================================================
 * useRoom —— 把一个 Transport 的状态收敛成 UI 好用的形状
 *
 * 职责边界：
 *   - **它只管"把事件流变成可渲染的 state"**，不做协议、不做校验（那是 Rust 的事）
 *   - UI 组件不许直接碰 Transport，一律通过这个 hook —— 这样换掉
 *     MockTransport → NativeTransport 时，UI 一行都不用改
 *
 * ★ 三条不减的约束（都来自 Web 端踩过的坑）：
 *   1. **消息按 id 去重**。gossip 会重复投递；历史前插也可能撞上已有消息。
 *      不去重就会看到重复气泡（实测踩过）。
 *   2. **只认当前房间的事件**。换房瞬间旧房间的迟到事件会到；
 *      不核对 `room` 会让 B 房的消息跑进 A 房列表。
 *   3. **文件卡片不能被当成文本气泡**。带 `file` 的消息要单独归类，
 *      否则会渲染成一条空气泡（文案是"文件证明"里的 text，很丑）。
 * ==========================================================================*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, PeerInfo, RelayStatus, RoomEvent } from '../bridge/types';
import type { Transport } from '../bridge/transport';

export interface RoomState {
  /** 已按时间升序排好的消息 */
  messages: ChatMessage[];
  peers: PeerInfo[];
  relay: RelayStatus;
  joined: boolean;
  /** 最近一次错误（UI 提示用，处理后调用 clearError） */
  error: string | null;
}

export interface RoomActions {
  send: (text: string) => Promise<void>;
  clearError: () => void;
}

export function useRoom(
  transport: Transport | null,
  room: string | null,
): RoomState & RoomActions {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [relay, setRelay] = useState<RelayStatus>({ url: null, connected: false });
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 已见过的消息 id —— 去重用的（约束 1） */
  const seen = useRef(new Set<string>());
  /** 当前房间的"最新值"。
   *  ⚠️ 必须用 ref：事件回调是在 effect 里注册一次的，
   *     如果闭包捕获 room，换房后回调里还是旧房间名。 */
  const roomRef = useRef<string | null>(null);

  useEffect(() => {
    roomRef.current = room;
    // 换房就清空去重表与列表（否则新房间看到旧房间的消息）
    seen.current = new Set();
    setMessages([]);
    setPeers([]);
    setJoined(false);
  }, [room]);

  useEffect(() => {
    if (!transport || !room) return;

    setRelay(transport.relayStatus());

    const onEvent = (ev: RoomEvent): void => {
      // 约束 2：只处理当前房间的事件
      if ('room' in ev && ev.room !== roomRef.current) return;

      switch (ev.type) {
        case 'joined':
          setJoined(true);
          break;

        case 'relay':
          setRelay(ev.status);
          break;

        case 'history':
          // 历史是**整体替换**（首批）而不是追加：
          // 先按时间排序，再灌进去重表
          setMessages((_prev) => {
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
          // 约束 1：去重
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
          break;
      }
    };

    const unsub = transport.subscribe(onEvent);
    // 订阅期间补一次状态（可能已经连上了）
    const id = setInterval(() => setRelay(transport.relayStatus()), 5000);

    return () => {
      unsub();
      clearInterval(id);
    };
  }, [transport, room]);

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
    () => ({ messages, peers, relay, joined, error, send, clearError }),
    [messages, peers, relay, joined, error, send, clearError],
  );
}
