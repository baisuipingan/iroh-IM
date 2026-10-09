/* ============================================================================
 * iroh-native —— 本地 Expo 模块的 TS 门面
 *
 * Android 上把 Rust 核心（libiroh_web.so）包成 JS 可调的方法。
 *
 * ## 这一层只做"搬运"，不做业务
 *
 * 它负责三件事，**就三件**：
 *   1. 拿到原生模块（拿不到就报错，让上层的 NativeTransport 决定回退）
 *   2. 把 JSON 字符串解析成对象（Rust 侧边界统一传字符串，见 jni_api.rs）
 *   3. 把 camelCase 的 JS 参数转成原生签名要的顺序
 *
 * 事件循环、去重、房间核对这些**全在 useRoom / NativeTransport**，
 * 不在这里 —— 否则换实现时要把逻辑抄两遍。
 *
 * ## 与 mock 的关系
 *
 * `src/bridge/native.ts` 里的 `NativeTransport` 实现 `Transport` 接口，
 * 内部只调本文件。UI 完全不知道底下是 mock 还是原生。
 * ==========================================================================*/

import { requireOptionalNativeModule } from 'expo-modules-core';

/** 原生模块的返回形状（与 IrohNativeModule.kt 一一对应） */
interface IrohNativeModuleShape {
  getStatus(): { available: boolean; loadError: string | null };
  create(
    relays: string[],
    relayToken: string | null,
    anchorId: string | null,
    anchorRelay: string | null,
  ): Promise<number>;
  release(): Promise<void>;
  pollEvent(timeoutMs: number): Promise<string | null>;
  endpointId(): Promise<string>;
  relayStatus(): Promise<Record<string, unknown>[]>;
  online(): Promise<void>;
  join(room: string, nickname: string): Promise<void>;
  send(text: string): Promise<string>;
  setNickname(nickname: string): Promise<void>;
  leaveRoom(): Promise<void>;
  fetchHistory(
    room: string,
    limit: number,
    beforeTs: number,
    beforeId: string,
  ): Promise<string>;
}

/**
 * ⚠️ 用 `requireOptionalNativeModule` 而不是 `requireNativeModule`：
 * 后者在模块缺失时**直接抛异常**，而我们希望在 iOS / Expo Go / 未装 .so 时
 * 优雅回退到 mock，而不是白屏崩溃。
 */
const Native = requireOptionalNativeModule<IrohNativeModuleShape>('IrohNative');

/** 原生模块是否可用（含 .so 是否加载成功） */
export function nativeStatus(): { available: boolean; reason: string | null } {
  if (!Native) {
    return {
      available: false,
      reason: '原生模块未注册（iOS？Expo Go？或 prebuild 未重新生成 android/）',
    };
  }
  try {
    const s = Native.getStatus();
    return {
      available: s.available,
      reason: s.loadError,
    };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function isNativeAvailable(): boolean {
  return nativeStatus().available;
}

/* ============================================================================
 * 下面每个方法都假设调用方**已经确认可用**（见 assertReady）。
 * 不在这里静默回退：静默回退会让"以为在用真的、其实在用假的"变成常态。
 * ==========================================================================*/

function requireModule(): IrohNativeModuleShape {
  if (!Native) {
    throw new Error(
      '原生模块 IrohNative 不可用：需要 development build（Expo Go 里没有原生模块）',
    );
  }
  const s = Native.getStatus();
  if (!s.available) {
    throw new Error(`libiroh_web.so 加载失败：${s.loadError ?? '未知原因'}`);
  }
  return Native;
}

export const irohNative = {
  async create(opts: {
    relays: string[];
    relayToken?: string | null;
    anchorId?: string | null;
    anchorRelay?: string | null;
  }): Promise<number> {
    return requireModule().create(
      opts.relays,
      opts.relayToken ?? null,
      opts.anchorId ?? null,
      opts.anchorRelay ?? null,
    );
  },

  async release(): Promise<void> {
    if (!Native) return;
    await Native.release();
  },

  /**
   * 拉一条事件。无事件返回 null。
   *
   * ⚠️ 这是**阻塞**调用（最多 timeoutMs）。调用方负责在自己的循环里跑，
   *    并且**在 join 之前就要开始循环** —— joined/history 在 join 返回前就到。
   */
  async pollEvent(timeoutMs = 200): Promise<unknown | null> {
    const raw = await requireModule().pollEvent(timeoutMs);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      // 事件 JSON 解析失败不该让整个循环退出，返回 null 跳过这条
      return null;
    }
  },

  async endpointId(): Promise<string> {
    return requireModule().endpointId();
  },

  async relayStatus(): Promise<Record<string, unknown>[]> {
    return requireModule().relayStatus();
  },

  async online(): Promise<void> {
    await requireModule().online();
  },

  async join(room: string, nickname: string): Promise<void> {
    await requireModule().join(room, nickname);
  },

  async send(text: string): Promise<string> {
    return requireModule().send(text);
  },

  async setNickname(nickname: string): Promise<void> {
    await requireModule().setNickname(nickname);
  },

  async leaveRoom(): Promise<void> {
    await requireModule().leaveRoom();
  },

  /**
   * 拉历史。`beforeTs = -1` 表示取最新一页。
   *
   * 返回 `HistoryResponse`：
   *   { room, messages: ChatMessage[], snapshot: {…} | null }
   */
  async fetchHistory(
    room: string,
    limit = 50,
    beforeTs = -1,
    beforeId = '',
  ): Promise<{ room: string; messages: unknown[]; snapshot?: unknown }> {
    const raw = await requireModule().fetchHistory(room, limit, beforeTs, beforeId);
    return JSON.parse(raw) as { room: string; messages: unknown[]; snapshot?: unknown };
  },
};
