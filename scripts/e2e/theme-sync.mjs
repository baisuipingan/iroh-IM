import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.E2E_OUTPUT || 'output/playwright/theme-sync';
const results = [];
await mkdir(output, { recursive: true });
for (const engine of ['chrome', 'webkit']) {
  const browser = engine === 'chrome'
    ? await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    : await webkit.launch();
  try {
    const page = await browser.newPage({ colorScheme: 'light' });
    await page.goto(process.env.E2E_SITE || 'http://127.0.0.1:8099');
    await page.waitForFunction(() => window.__iroh_net?.endpoint_id(), undefined, { timeout: 90000 });
    await page.evaluate(() => { window.__iroh_theme('auto'); window.__iroh_openSettings(); });
    await page.locator('select[data-theme-pref]').evaluate(element => { window.themeSelectBefore = element; });
    const check = async (name, pref, current, hint) => {
      await page.waitForFunction(({ pref, current, hint }) => {
        const select = document.querySelector('select[data-theme-pref]');
        const state = window.__iroh_theme();
        return state.pref === pref && state.current === current && select?.value === pref &&
          select.closest('.set-row').querySelector('.set-row__hint').textContent === hint;
      }, { pref, current, hint });
      assert.ok(await page.evaluate(() => window.themeSelectBefore === document.querySelector('select[data-theme-pref]')));
      results.push(`${engine}/${name}`);
      console.log(`PASS ${engine}/${name}`);
    };
    await check('初始跟随系统', 'auto', 'light', '跟随系统 · 当前浅色');
    await page.emulateMedia({ colorScheme: 'dark' });
    await check('系统切深色同步说明', 'auto', 'dark', '跟随系统 · 当前深色');
    await page.locator('#btn-theme').click();
    await check('快捷按钮同步偏好', 'light', 'light', '始终浅色');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await check('固定主题不被系统覆盖', 'light', 'light', '始终浅色');
    await page.locator('select[data-theme-pref]').selectOption('auto');
    await check('选择跟随系统不重建控件', 'auto', 'dark', '跟随系统 · 当前深色');
    await page.emulateMedia({ colorScheme: 'light' });
    await check('重新跟随系统浅色', 'auto', 'light', '跟随系统 · 当前浅色');
    await page.locator('select[data-theme-pref]').selectOption('dark');
    await check('选择固定深色同步说明', 'dark', 'dark', '始终深色');
    assert.equal(await page.evaluate(() => localStorage.getItem('iroh.theme')), 'dark');
    await page.reload();
    await page.waitForFunction(() => window.__iroh_net?.endpoint_id(), undefined, { timeout: 90000 });
    await page.evaluate(() => window.__iroh_openSettings());
    assert.equal(await page.locator('select[data-theme-pref]').inputValue(), 'dark');
    assert.equal(await page.evaluate(() => window.__iroh_theme().current), 'dark');
    results.push(`${engine}/刷新保留偏好`);
    console.log(`PASS ${engine}/刷新保留偏好`);
  } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
console.log(`PASS=${results.length}`);
