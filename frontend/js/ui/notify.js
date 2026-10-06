/* ============================================================================
 * ui/notify.js · 桌面通知（设置页「通知」组）
 *
 * ## 为什么单独一个模块
 *
 * 它要读的东西和聊天的其它部分都不一样：`document.visibilityState`、
 * `Notification.permission`、消息事件 —— 混进 sidebar/composer 都会让
 * 那两个本来就大的模块更难读。
 *
 * ## 三条设计原则
 *
 * 1. **默认关闭。** 打开会弹一次系统授权框，这属于用户可见的行为变化，
 *    不该由代码替他决定默认值。
 * 2. **只在"看不到的时候"提醒。** 页面在前台时本来就有气泡和提示音，
 *    再弹一条系统通知是打扰。判据是 `document.hidden`。
 * 3. **权限被拒就把开关退回去。** 最常见的坑是"开关显示已开、
 *    但系统里一直是拒绝" —— 用户以为开了，其实永远收不到。
 *    拿不到 `granted` 就不写偏好，并明确告诉他去哪儿改。
 *
 * ## 通知里的内容
 *
 * 由 `prefs.notifyContent` 控制（默认显示）。不显示时只写「新消息」。
 * 无论哪种，正文都截断到 ~60 字 —— 系统通知不负责展示长消息，
 * 而且有些平台会直接截断得很丑。
 * ==========================================================================*/

import { bus, EV } from '../bus.js';
import { store } from '../store.js';

/** 通知正文的最大长度（超过就省略号） */
const MAX_BODY = 60;

/** 当前浏览器是否**能**发通知（能力，不考虑权限） */
export function canNotify() {
  return typeof Notification !== 'undefined';
}

/** 当前权限：'granted' | 'denied' | 'default' | 'unsupported' */
export function permission() {
  if (!canNotify()) return 'unsupported';
  return Notification.permission || 'default';
}

export const notify = {
  init() {
    bus.on(EV.MSG, ({ room, message, mine, isHistory }) => {
      if (mine || isHistory) return;               // 自己发的不提醒，历史回填更不提醒
      if (!document.hidden) return;                // 页面在前台 → 有气泡 + 提示音，够了
      if (store.prefs().notify !== true) return;
      if (permission() !== 'granted') return;      // 权限被撤了就静默跳过（别弹错）
      this.fire(room, message);
    });
  },

  /**
   * 申请权限并落盘偏好。
   * @returns Promise<boolean> 是否真的开成了
   */
  async enable() {
    if (!canNotify()) {
      bus.emit(EV.TIP, '这个浏览器不支持桌面通知');
      return false;
    }
    let perm = Notification.permission;
    if (perm !== 'granted') {
      try {
        // ⚠️ 现代浏览器返回 Promise；老 Safari 只有回调式签名（返回 undefined）。
        perm = await Notification.requestPermission();
      } catch {
        perm = Notification.permission;
      }
    }
    if (perm !== 'granted') {
      bus.emit(EV.TIP, perm === 'denied'
        ? '浏览器拒绝了通知权限，请在地址栏左侧的站点设置里允许后再打开'
        : '没有拿到通知权限，暂时收不到桌面通知');
      return false;
    }
    store.setPref('notify', true);
    bus.emit(EV.TIP, '桌面通知已开启（切走页面时提醒）');
    return true;
  },

  close() {
    store.setPref('notify', false);
    bus.emit(EV.TIP, '桌面通知已关闭');
  },

  /**
   * 通知的标题与正文。
   *
   * 抽成纯函数是为了**能被测**：正文里到底放不放消息内容，是这一块唯一
   * 真正有隐私含义的决定，必须能用断言钉死（见 `redesign.py`），
   * 而不是"看着代码好像是对的"。
   */
  bodyFor(room, message, prefs = store.prefs()) {
    const alias = room ? store.room(room)?.alias || '' : '';
    const title = alias || room || '新消息';
    const nick = message?.nickname || '有人';
    const text = String(message?.text || '').slice(0, MAX_BODY);
    const body = prefs.notifyContent === false || !text ? '新消息' : `${nick}: ${text}`;
    return { title, body };
  },

  /** 真的弹一条 */
  fire(room, message) {
    const { title, body } = this.bodyFor(room, message);
    try {
      // `tag` 让同一房间的多条通知互相覆盖，而不是把通知中心刷满。
      const n = new Notification(title, { body, tag: room || 'iroh', renotify: false });
      n.onclick = () => {
        try {
          window.focus();
          // 点通知 → 直接进那个房间（房间里已经在了就只是聚焦）
          if (room && room !== _lastOpened) {
            _lastOpened = room;
            bus.emit(EV.ROOM_OPEN, room);
            setTimeout(() => { _lastOpened = ''; }, 3000);
          }
        } catch { /* 有些环境不允许 window.focus()，忽略 */ }
        n.close();
      };
    } catch {
      /* 构造通知也可能抛（比如权限在毫秒之间被撤），静默即好 */
    }
    // 支持震动的设备（主要是移动端 Chrome）顺带震一下
    try { navigator.vibrate?.(60); } catch { /* 不支持就算了 */ }
  },
};

/** 防抖：连续几条通知时不要反复触发同一个进房请求 */
let _lastOpened = '';
