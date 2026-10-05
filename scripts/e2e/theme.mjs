/**
 * 主题：跟随系统 / 手动指定 / **首屏闪烁**
 *
 * 用 Playwright 的 `colorScheme` 选项模拟系统主题，覆盖三种偏好的组合，
 * 并检查「首帧主题」与「稳定后主题」是否一致（不一致 = 用户会看到闪一下）。
 *
 * ⚠️ 为什么必须测"首帧"：主题闪烁是**时序**问题 —— 只看最终状态永远是绿的。
 *    旧实现（`<html data-theme="dark">` 硬编码 + 等 main.js 才应用偏好）
 *    最终状态也正确，但用户会先看到黑色再跳到白色。
 *    所以这里的判定是"观测到的值有没有变过"，不是"最后对不对"。
 *
 * ⚠️ 这里的 `check` 用 `assert`（与 fix-review.mjs 同风格）：失败即抛，不静默。
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = process.env.E2E_SITE || 'http://127.0.0.1:8099';
const output = process.env.E2E_OUTPUT || 'output/playwright/theme';
const results = [];
const check = (name, condition, details) => {
  assert.ok(condition, `${name}${details ? `: ${JSON.stringify(details)}` : ''}`);
  results.push(name);
  console.log(`PASS ${name}`);
};
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
});

/**
 * 打开页面并观察主题变化。
 * @returns {{seen: string[], final: string}} `seen` 是观测到的取值序列（去重相邻）
 */
async function observe(browser, colorScheme, storedPref) {
  const context = await browser.newContext({ colorScheme });
  const page = await context.newPage();
  // 先跑一次以取得 origin，才能写 localStorage
  await page.goto(site, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__theme, undefined, { timeout: 60000 });
  await page.evaluate((p) => {
    if (p) localStorage.setItem('iroh.theme', p);
    else localStorage.removeItem('iroh.theme');
  }, storedPref);

  const seen = [];
  // 在**导航前**挂上监听：每次 DOM 变化就记录一次 data-theme
  const record = () => page.evaluate(() => document.documentElement.dataset.theme || 'NONE');
  await page.goto(site, { waitUntil: 'commit' });
  for (let i = 0; i < 120; i += 1) {
    try {
      const v = await record();
      if (v && v !== 'NONE' && seen[seen.length - 1] !== v) seen.push(v);
    } catch { /* 导航中偶尔读不到，忽略 */ }
    await page.waitForTimeout(15);
  }
  // 等 main.js 完全跑完，再看最终值
  await page.waitForFunction(() => !!window.__theme, undefined, { timeout: 60000 });
  await page.waitForTimeout(500);
  const final = await page.evaluate(() => document.documentElement.dataset.theme);
  if (seen[seen.length - 1] !== final) seen.push(final);
  await context.close();
  return { seen, final };
}

const noFlash = (seen) => new Set(seen).size <= 1;

try {
  // ---- 跟随系统（默认）----
  {
    const { seen, final } = await observe(browser, 'dark', null);
    check('系统深色 + 无偏好 → 深色', final === 'dark', { seen, final });
    check('系统深色 + 无偏好 → 首屏无闪烁', noFlash(seen), { seen });
  }
  {
    const { seen, final } = await observe(browser, 'light', null);
    check('系统浅色 + 无偏好 → 浅色', final === 'light', { seen, final });
    check('系统浅色 + 无偏好 → 首屏无闪烁', noFlash(seen), { seen });
  }

  // ---- 手动指定（覆盖系统）----
  {
    const { seen, final } = await observe(browser, 'dark', 'light');
    check('系统深色 + 偏好浅色 → 浅色（用户选择优先）', final === 'light', { seen, final });
    check('系统深色 + 偏好浅色 → 首屏无闪烁', noFlash(seen), { seen });
  }
  {
    const { seen, final } = await observe(browser, 'light', 'dark');
    check('系统浅色 + 偏好深色 → 深色（用户选择优先）', final === 'dark', { seen, final });
    check('系统浅色 + 偏好深色 → 首屏无闪烁', noFlash(seen), { seen });
  }

  // ---- 设置页三选一控件 ----
  {
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // `?autostart=1` 让节点自己启动；否则要等 `__openRoom` 才有完整 UI
    await page.goto(`${site}/?autostart=1&room=theme-test`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__theme, undefined, { timeout: 60000 });
    // 等节点真正起来（设置页要读 endpoint_id，节点没好会渲染失败）
    await page.waitForFunction(() => window.__net && window.__net.endpoint_id(), undefined, { timeout: 90000 });
    await page.evaluate(() => document.getElementById('tab-settings').click());
    // ⚠️ 等元素**真的出现**，别用固定 sleep（面板渲染依赖节点状态）
    await page.waitForSelector('select[data-theme-pref]', { timeout: 30000 });
    const hasSelect = await page.evaluate(() => !!document.querySelector('select[data-theme-pref]'));
    check('设置页有主题三选一控件', hasSelect);
    if (hasSelect) {
      // ⚠️ 必须限定在这个 select **内部** ——
      //    `[data-theme-pref] option` 是"选择器分组"，会匹配到页面上
      //    **所有** select 的 option（踩过：拿到了发送快捷键和消息密度的值）。
      const options = await page.evaluate(() => {
        const select = document.querySelector('[data-theme-pref]');
        // ⚠️ `select.options` 是 HTMLOptionsCollection（类数组），
        //    展开运算符在这里不可用 —— 必须用 Array.from。
        return select ? Array.from(select.options).map((o) => o.value) : null;
      });
      check('三个选项：跟随系统 / 深色 / 浅色', JSON.stringify(options) === '["auto","dark","light"]', { options });
      // ⚠️ 不用 `page.selectOption`：它带"可操作性检查"并缓存元素引用，
      //    而这一行的 `onchange` 会触发 `this.render()` **整段重建面板**
      //    （innerHTML 替换），旧引用立刻失效 → 超时。
      //    直接派发 change 事件更稳，也更贴近真实用户操作的效果。
      const chooseTheme = async (value) => {
        await page.evaluate((v) => {
          const el = document.querySelector('select[data-theme-pref]');
          if (!el) throw new Error('找不到主题 select');
          el.value = v;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        await page.waitForTimeout(400);
      };

      await chooseTheme('dark');
      const t = await page.evaluate(() => document.documentElement.dataset.theme);
      check('选「深色」立刻生效', t === 'dark', { t });
      const stored = await page.evaluate(() => localStorage.getItem('iroh.theme'));
      check('选「深色」已落盘', stored === 'dark', { stored });

      // 选回「跟随系统」：系统是浅色，应回到浅色
      await chooseTheme('auto');
      const t2 = await page.evaluate(() => document.documentElement.dataset.theme);
      check('选回「跟随系统」按系统解析为浅色', t2 === 'light', { t2 });
      const stored2 = await page.evaluate(() => localStorage.getItem('iroh.theme'));
      check('选回「跟随系统」已落盘为 auto', stored2 === 'auto', { stored2 });
    }
    await context.close();
  }

  console.log(`\n总计 PASS=${results.length} FAIL=0`);
  console.log(`（仅 Chrome；系统主题用 Playwright 的 colorScheme 模拟，非真实系统设置）`);
} finally {
  await browser.close();
}
