/* ============================================================================
 * ui/theme.js · 主题
 * ==========================================================================*/

import { store } from '../store.js';

const MOON = '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.8 6.8 0 0 0 10.8 10.8Z"/>';
const SUN =
  '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>';

export const theme = {
  current: 'dark',

  apply(name) {
    this.current = name === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = this.current;
    store.setTheme(this.current);

    // 深色时显示月亮（表示"点我切浅色"的反面），图标跟随当前状态
    const btn = document.getElementById('btn-theme');
    if (btn) {
      btn.querySelector('svg').innerHTML = this.current === 'dark' ? MOON : SUN;
      btn.title = this.current === 'dark' ? '切换到浅色' : '切换到深色';
    }
    document.dispatchEvent(new CustomEvent('themechange', { detail: this.current }));
  },

  toggle() {
    this.apply(this.current === 'dark' ? 'light' : 'dark');
  },

  init() {
    this.apply(store.theme());
    document.getElementById('btn-theme').onclick = () => this.toggle();
  },
};
