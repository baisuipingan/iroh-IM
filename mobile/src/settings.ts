/**
 * 本地设置（持久化）。
 *
 * ## 为什么用 AsyncStorage 而不是 expo-secure-store
 *
 * 这里存的是**偏好**（震动开不开、昵称默认值），不是秘密。
 * SecureStore 走 Keychain/Keystore，有大小限制、读写也更慢 ——
 * 用在偏好上是杀鸡用牛刀，而且它的 API 是同步阻塞感更强的。
 *
 * ## 为什么设置要集中在一个模块
 *
 * 设置项散落在各屏里读写，很快就变成"这个开关谁在读"没人知道。
 * 这里统一：**内存里一份权威副本**（`cache`），启动时读一次，
 * 改动立刻落盘 + 通知订阅者。
 *
 * ⚠️ 与 `useRoom` 同样的取舍：读取是异步的（AsyncStorage 是异步 API），
 *    但**组件不该为了一个布尔值去 await**。所以启动时预热一次，
 *    之后同步读缓存。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'iroh.settings.v1';

export interface Settings {
  /** 收到新消息时震动。默认开 —— 这是移动端最基础的"有动静"反馈 */
  hapticsOnMessage: boolean;
  /** 文件到达（邀约/完成）时震动。默认开 */
  hapticsOnFile: boolean;
  /** 进房成功/失败时震动。默认开 */
  hapticsOnJoin: boolean;
  /** 记住上次用的昵称，下次进房自动填上 */
  lastNickname: string;
  /** 记住上次进的房间 */
  lastRoom: string;
}

const DEFAULTS: Settings = {
  hapticsOnMessage: true,
  hapticsOnFile: true,
  hapticsOnJoin: true,
  lastNickname: '',
  lastRoom: '',
};

/** 内存里的权威副本（预热后同步读） */
let cache: Settings = { ...DEFAULTS };
let loaded = false;
const listeners = new Set<(s: Settings) => void>();

/** 启动时调一次。读失败就用默认值（偏好丢了不该让 App 起不来）。 */
export async function loadSettings(): Promise<Settings> {
  if (loaded) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      // 逐字段合并：将来加了新字段，老存档里没有也不会变成 undefined
      cache = { ...DEFAULTS, ...parsed };
    }
  } catch {
    // 存坏了 / 读不到 → 用默认值，别让用户卡在启动
    cache = { ...DEFAULTS };
  }
  loaded = true;
  return cache;
}

/** 同步读当前设置（**必须先 `loadSettings()`**，否则拿到的是默认值） */
export function getSettings(): Settings {
  return cache;
}

/**
 * 改设置：**先改内存并广播，再异步落盘**。
 *
 * 顺序很关键 —— 先广播让 UI 立刻响应（开关不会"点了半天才动"），
 * 落盘失败也只影响"下次启动记不住"，不影响本次使用。
 */
export function updateSettings(patch: Partial<Settings>): void {
  cache = { ...cache, ...patch };
  for (const fn of listeners) fn(cache);
  void AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => undefined);
}

/** 订阅设置变化（返回取消订阅） */
export function subscribeSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
