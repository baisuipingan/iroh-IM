/* ============================================================================
 * 移动端主题 —— 从 `frontend/css/tokens.css` 移植
 *
 * 原则：**色值不许自己发明**。颜色全部从 Web 端的令牌搬过来，
 * 保证同一个人在两端的观感一致（金色气泡是品牌标识，必须认得出来）。
 *
 * 两处**有意偏离** Web 端，理由写在各自位置：
 *   1. 深色主题暂不实现（Web 端是"跟随系统 + 三选一"，移动端 v1 先做浅色）
 *   2. `--bb-meta` 在移动端**没用** —— Web 端时间戳用 #90A4AE（2.3:1，
 *      当时就是有意不照抄设计稿的），移动端统一走可读的 `textMuted`
 * ==========================================================================*/

export const colors = {
  /* ---- 品牌色（直接搬 Web 端）---- */
  gold: '#fdd835',
  goldDim: '#e8c41d',
  goldSoft: '#ffe16e',
  /** 金色底上的文字：不要用纯黑，留一点蓝调 */
  onGold: '#1a252c',

  coral: '#f2646e',
  coralSoft: '#fbdada',
  onCoral: '#721322',

  cyan: '#26c6da',
  /** 白底上可读的青色（对比度 3.2:1） */
  cyanDeep: '#0e93a6',
  onCyan: '#006a75',

  /** 在线光点 */
  emerald: '#00e676',
  /** 白底上的"在线"文字 */
  emeraldText: '#00a854',

  navy: '#0e2439',
  navy2: '#1d3247',
  slate: '#263238',

  /* ---- 表面 ---- */
  seafoam: '#f0f7f6',
  seafoam2: '#e8f3f1',
  canvas: '#f9fafb',
  outline: '#cfc6ac',

  /* ---- 文字（移动端统一用这三档，见文件头说明 2）---- */
  text: '#263238',
  textMuted: '#5f6f76',
  textFaint: '#8d9ba1',

  /** 我的气泡底色（金色），文字用 onGold */
  bubbleMine: '#fdd835',
  /** 别人气泡底色（白）+ 描边 */
  bubbleOther: '#ffffff',
} as const;

/** 尺寸 —— 与 Web 端同一套比例语言，但按手机触控放宽 */
export const sizes = {
  /** 顶栏高度（Web 端 56px，移动端保持） */
  headerH: 56,
  /** 输入区最小高度 */
  composerMinH: 48,
  /** 圆角：气泡用的比 Web 端更大一点，手机上更贴手 */
  radiusBubble: 18,
  radiusCard: 12,
  /** 最小可点区域（Apple HIG 建议 44） */
  touchTarget: 44,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

/** 字号 —— 手机上正文 16 是舒适区（比 Web 端的 14 大） */
export const font = {
  xs: 11,
  sm: 13,
  body: 16,
  title: 17,
  large: 20,
} as const;

/**
 * 昵称 → 头像底色。
 *
 * ⚠️ 必须**纯函数且稳定**：同一个人每次都要同色，否则消息列表滚动时
 * 同一个人的头像会换色（看起来像不同的人）。
 * 用 id 的字符和取模，不用随机数。
 */
const AVATAR_COLORS = [
  '#26c6da',
  '#f2646e',
  '#7e57c2',
  '#26a69a',
  '#ffa726',
  '#42a5f5',
  '#ec407a',
  '#66bb6a',
] as const;

export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? '#26c6da';
}

/** 取昵称首字（中文取第一个字，英文取首字母大写） */
export function avatarText(nickname: string): string {
  const t = nickname.trim();
  if (!t) return '?';
  const first = [...t][0] ?? '?';
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}
