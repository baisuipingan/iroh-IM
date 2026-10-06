/* ============================================================================
 * ui/primitives.js · 跨视图共享的渲染原语
 *
 * ## 为什么单独成文件
 *
 * `avatar()` / `ico()` / `regionLabel()` 原来都住在 `sidebar.js` 里，
 * 但 `timeline.js` 和 `topology.js` 都要用 —— 于是形成了
 * **timeline → sidebar**、**topology → sidebar** 这两条横向依赖。
 * 一个"会话列表"模块成了所有视图的公共依赖提供者，边界就拉歪了。
 *
 * 把它们挪到这里之后，依赖方向恢复成单向：
 *
 *     main → ui/{sidebar,timeline,topology,motion,...} → primitives → util
 *     （sidebar 不再是别人家的地基）
 *
 * 这个文件里只放**纯函数**：给定输入返回 HTML 字符串，无副作用、不碰状态。
 * ==========================================================================*/

import * as U from '../util.js';

/* --------------------------------------------------------------------------
 * 小图标（内联 SVG）
 *
 * 设计稿用的是 Material Symbols 字体（Google CDN）。本项目**不引外部字体**：
 * 图标走内联 SVG，零网络依赖、也免得国内首屏卡在字体请求上。
 * ------------------------------------------------------------------------*/
const ICON = {
  sensors: '<circle cx="12" cy="12" r="2.4"/><path d="M7.4 16.6a6.5 6.5 0 0 1 0-9.2M16.6 7.4a6.5 6.5 0 0 1 0 9.2M4.4 19.6a10.8 10.8 0 0 1 0-15.2M19.6 4.4a10.8 10.8 0 0 1 0 15.2"/>',
  door: '<path d="M5.5 20.5V5.2A1.7 1.7 0 0 1 7.2 3.5h8A1.7 1.7 0 0 1 16.9 5.2v15.3"/><path d="M3.5 20.5h17"/><circle cx="13.6" cy="12" r=".9"/>',
  people: '<path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7.5" r="3.5"/><path d="M22 20v-1.5a4 4 0 0 0-3-3.87"/>',
  radar: '<path d="M12 12 19 5"/><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/><path d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5"/><circle cx="12" cy="12" r="1.1"/>',
  shield: '<path d="M12 3.6 19 6.1v5.4c0 4.3-2.9 7.6-7 8.6-4.1-1-7-4.3-7-8.6V6.1Z"/><path d="m9 12 2.2 2.2L15.4 10"/>',
  key: '<circle cx="8" cy="12" r="3.2"/><path d="M11.2 12H20M17 12v2.8M14 12v2.3"/>',
  anchor: '<circle cx="12" cy="5" r="2.2"/><path d="M12 7.2V21"/><path d="M5 13H3.6A8.4 8.4 0 0 0 12 21a8.4 8.4 0 0 0 8.4-8H19"/><path d="M8.6 10h6.8"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 4.2v5h-5"/>',
  bell: '<path d="M18 16.5V11a6 6 0 1 0-12 0v5.5L4.5 18.5h15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 10 2.5 2.5L7 15M12.5 15H17"/>',
  card: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9.5" cy="11" r="2"/><path d="M6.4 16.6a3.5 3.5 0 0 1 6.2 0M14.2 10h3.3M14.2 13.5h3.3"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 2-1.9 0-1-.7-1.4-.7-2.2 0-.9.8-1.6 1.8-1.6h1.3c2.2 0 3.9-1.8 3.9-3.9A8.5 8.5 0 0 0 12 3.5Z"/><circle cx="8" cy="10.4" r="1.1"/><circle cx="12" cy="7.9" r="1.1"/><circle cx="15.7" cy="10.7" r="1.1"/>',
  download: '<path d="M12 4v10"/><path d="m8 10.4 4 4 4-4"/><path d="M4.5 17.4v1.7a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.7"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.4 12 2.5 2.5L15.6 9.5"/>',
  speaker: '<path d="M11 5 6.5 8.6H3v6.8h3.5L11 19Z"/><path d="M15.5 8.8a4.5 4.5 0 0 1 0 6.4"/><path d="M18.4 5.9a8.6 8.6 0 0 1 0 12.2"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4.2v4.6h4.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  home: '<path d="M4 10.6 12 4l8 6.6"/><path d="M6.2 9.5V20h11.6V9.5"/>',
  dns: '<rect x="3.5" y="4.5" width="17" height="6" rx="2"/><rect x="3.5" y="13.5" width="17" height="6" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.6"/><path d="M5.2 9v9.2a1.8 1.8 0 0 0 1.8 1.8h10a1.8 1.8 0 0 0 1.8-1.8V9"/><path d="M10 13h4"/>',
  wave: '<path d="M2.5 12c2 0 2-4 4-4s2 8 4 8 2-8 4-8 2 4 4 4"/><path d="M2.5 18.5c2 0 2-3 4-3s2 6 4 6 2-6 4-6 2 3 4 3"/>',
};

/** 包一个图标（设计稿的图标都装在一个小圆角色块里） */
export function ico(name, cls = 'stat__ico') {
  return `<span class="${cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg></span>`;
}

/**
 * 中继的区域代码 → 人话。
 *
 * ⚠️ 设计稿把中继叫「香港海沟中继 / 亚特兰蒂斯洋脊」—— 那些是**氛围文案**。
 *    这里如实按 `relay-config.json` 的 `region` 字段映射；不认识的代码原样显示，
 *    绝不为了好听给一台中继编一个不存在的名字（用户会拿它排查问题）。
 *    `HK` 按国标写法是「中国香港」。
 */
const REGION_LABEL = { HK: '中国香港', EU: '欧洲', FR: '法国', SG: '新加坡', JP: '日本', US: '美国' };
export const regionLabel = (code) => REGION_LABEL[String(code || '').toUpperCase()] || String(code || '');

/**
 * 主题壁纸的可选项。
 * 设计稿只给了 3 档（海绵暖阳 / 珊瑚海湾 / 水母平原），**没有"关"这一档** ——
 * 而壁纸是新增功能，默认必须是"什么都不改"（否则老用户一升级画布就变了）。
 * 所以自行补了 `none`，凑成 2×2。
 */
export const WALLPAPERS = [
  { id: 'none', label: '纯净海面' },
  { id: 'sun', label: '海绵暖阳' },
  { id: 'reef', label: '珊瑚海沟' },
  { id: 'jelly', label: '水母平原' },
];
export const WALLPAPER_IDS = WALLPAPERS.map((w) => w.id);

/** 头像元素（色块 + 首字母），颜色由名字稳定推导 */
export function avatar(name, extraClass = '') {
  return `<div class="avatar ${extraClass}" style="background:${U.colorOf(name)}">${U.esc(U.initial(name))}</div>`;
}