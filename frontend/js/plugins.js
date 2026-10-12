/* ============================================================================
 * plugins.js · 前端侧的「房间能力」注册表
 *
 * ## 它补的是哪半截
 *
 * Rust 侧的能力（`RoomCapability`）已经能发 `RoomEvent::Plugin { name, payload }`，
 * 但事件到了浏览器**没人认领** —— `net.js` 里没有 `case 'plugin'`，
 * 于是任何新能力想显示点东西，都得去改核心的几个文件。这个模块就是那个缺的注册点：
 *
 *     // 插件作者只需要写这一行（自己那侧注册，核心一无所知）
 *     roomPlugins.register('vote', { onEvent: (payload) => { … } });
 *
 * 没注册的名字**不是错误**（对端可能有我们没有的能力），所以只计数 + 打一条 debug，
 * 既不会弹错、也不静默丢掉诊断信息（`unhandled()` 能看到"谁在发没人认领的事件"）。
 *
 * ## 边界（与 Rust 侧同一条，别越）
 *
 * **消息格式与签名不是插件** —— 那是协议底座，必须走 `Wire` 那一套。
 * 这里只承载"能力自己定义的事件"，核心不解释内容。
 *
 * ⚠️ `RoomEvent::Plugin` 目前**不带房间字段**（节点同时只进一个房间，所以隐含是当前房间）。
 *    插件若需要区分房间，请把房间放进自己的 payload。
 * ==========================================================================*/

import { bus, EV } from './bus.js';

/** name → 插件注册的处理器 */
const handlers = new Map();
/** name → 收到过多少条"没人认领"的事件（诊断用） */
const unclaimed = new Map();

export const roomPlugins = {
  /**
   * 注册一个插件的事件处理器。
   * @param {string} name       与 Rust 侧 `RoomEvent::Plugin.name` 一致
   * @param {{onEvent?: (payload: unknown, meta: {name: string}) => void}} hooks
   * @returns {() => void} 取消注册（界面上"卸载插件"时用）
   */
  register(name, hooks = {}) {
    if (!name || typeof name !== 'string') throw new Error('插件名必须是非空字符串');
    handlers.set(name, hooks);
    unclaimed.delete(name);   // 注册即认领，之前积的计数不再有意义
    return () => {
      if (handlers.get(name) === hooks) handlers.delete(name);
    };
  },

  /** 已注册的插件名（诊断/设置页展示用） */
  list() {
    return [...handlers.keys()];
  },

  /** 收到过但没人认领的：`{ name: 条数 }` */
  unhandled() {
    return Object.fromEntries(unclaimed);
  },
};

// 唯一的订阅点：核心的事件总线上接一下，按名字分发给插件。
bus.on(EV.PLUGIN, ({ name, payload }) => {
  const hooks = handlers.get(name);
  if (!hooks) {
    unclaimed.set(name, (unclaimed.get(name) || 0) + 1);
    console.debug('[plugin] 收到没人认领的事件:', name);
    return;
  }
  try {
    hooks.onEvent?.(payload, { name });
  } catch (e) {
    // 一个插件抛错不该影响别的插件，也不该把整个事件循环带崩
    console.error(`[plugin] "${name}" 的事件处理器抛错`, e);
  }
});
