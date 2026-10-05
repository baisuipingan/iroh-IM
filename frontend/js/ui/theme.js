/* ============================================================================
 * ui/theme.js · 主题
 *
 * ## 三种偏好
 *
 * | 取值 | 含义 |
 * |---|---|
 * | `'auto'`（**默认**） | 跟随系统（`prefers-color-scheme`），系统切了跟着切 |
 * | `'dark'` | 强制深色 |
 * | `'light'` | 强制浅色 |
 *
 * 偏好存 `localStorage['iroh.theme']`，**`index.html` 里的内联脚本也会读它**
 * （为了在首帧绘制前把 `data-theme` 定下来，避免闪烁）——
 * 改 key 名要两处一起改。
 *
 * ## 为什么 `init()` 不直接 apply(store.theme())
 *
 * 内联脚本已经把 `data-theme` 设好了（且比这里更早）。`init()` 只要：
 *   1. 把内部状态与 DOM 对齐（不要反过来覆盖 DOM）
 *   2. 绑定按钮与系统主题变化监听
 * 这样即使 JS 加载很慢，用户看到的首屏主题也是**正确的那个**。
 * ==========================================================================*/

import { store } from '../store.js';

const MOON = '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.8 6.8 0 0 0 10.8 10.8Z"/>';
const SUN =
  '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>';

/** 系统是否偏好深色（不支持 `matchMedia` 时按深色处理，与旧行为一致） */
function systemPrefersDark() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true;
}

/** 由「偏好」算出「实际用哪个主题」 */
export function resolveTheme(pref) {
  if (pref === 'dark' || pref === 'light') return pref;
  return systemPrefersDark() ? 'dark' : 'light';
}

export const theme = {
  /** 用户的偏好：'auto' | 'dark' | 'light' */
  pref: 'auto',
  /** 实际生效的主题：'dark' | 'light'（auto 时由系统决定） */
  current: 'dark',

  /**
   * 设置**偏好**并立即生效。
   * @param {'auto'|'dark'|'light'} pref
   */
  apply(pref) {
    this.pref = pref === 'dark' || pref === 'light' ? pref : 'auto';
    this.current = resolveTheme(this.pref);

    const html = document.documentElement;
    html.dataset.theme = this.current;
    // ⚠️ 名字不能是 `themePref`（→ 属性 `data-theme-pref`）——
    //    设置页那个 `<select data-theme-pref>` 会与 `<html>` 撞名，
    //    导致 `querySelector('[data-theme-pref]')` 拿到 `<html>`。
    html.dataset.themeSetting = this.pref;
    store.setTheme(this.pref);

    this._paintButton();
    document.dispatchEvent(
      new CustomEvent('themechange', { detail: { pref: this.pref, theme: this.current } }),
    );
  },

  /**
   * 快捷切换：在 auto 下点击按钮 = 切到"与当前相反"的固定主题。
   *
   * 为什么这么设计：按钮只有一个，而偏好有三种。让点击的结果**可预期**——
   * 看到深色就切浅色、看到浅色就切深色。想回到跟随系统去设置页选。
   */
  toggle() {
    this.apply(this.current === 'dark' ? 'light' : 'dark');
  },

  /** 按钮图标跟随**实际主题**（而不是偏好）—— 用户看到什么就是什么 */
  _paintButton() {
    const btn = document.getElementById('btn-theme');
    if (!btn) return;
    const svg = btn.querySelector('svg');
    if (svg) svg.innerHTML = this.current === 'dark' ? MOON : SUN;
    btn.title =
      this.pref === 'auto'
        ? `跟随系统（当前${this.current === 'dark' ? '深色' : '浅色'}）· 点击切换`
        : this.current === 'dark'
          ? '切换到浅色'
          : '切换到深色';
  },

  init() {
    // 内联脚本已经按「偏好 + 系统」在首帧前算好了。这里**重算一遍并比对**：
    //
    //   · 一致（正常情况）→ 不动 DOM，零重绘、零闪烁
    //   · 不一致 → 纠正
    //
    // ⚠️ 为什么必须有"不一致就纠正"这条兜底：如果内联脚本**根本没跑**，
    //    DOM 上可能是 `<html>` 完全没有 `data-theme`（或残留旧值），
    //    此时"只读 DOM 不纠正"会让页面永远停在错误主题。
    //    内联脚本可能不跑的真实原因：CSP 禁止内联脚本、浏览器缓存了旧版 HTML、
    //    或用户用了会剥离内联脚本的扩展。
    const pref = store.theme();
    const want = resolveTheme(pref);
    this.pref = pref;
    this.current = want;
    if (document.documentElement.dataset.theme !== want) {
      document.documentElement.dataset.theme = want;
    }
    document.documentElement.dataset.themeSetting = pref;
    this._paintButton();

    document.getElementById('btn-theme').onclick = () => this.toggle();

    // ---- 跟随系统：系统主题变了要实时跟（否则 auto 只在打开页面那一刻生效）
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        if (this.pref !== 'auto') return;   // 用户明确选了深/浅，别覆盖他
        this.current = systemPrefersDark() ? 'dark' : 'light';
        document.documentElement.dataset.theme = this.current;
        this._paintButton();
        document.dispatchEvent(
          new CustomEvent('themechange', { detail: { pref: this.pref, theme: this.current } }),
        );
      };
      // `addEventListener` 在新浏览器可用；Safari < 14 只有已废弃的 addListener
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  },
};
