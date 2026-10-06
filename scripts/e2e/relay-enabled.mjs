import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const configPath = new URL('../../frontend/relay-config.json', import.meta.url);
const original = await readFile(configPath);
const config = JSON.parse(original);
assert.ok(config.relays.some(relay => relay.id === 'fr-1'));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
let passed = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  passed++;
  console.log(`PASS ${name}`);
};
try {
  for (const allDisabled of [false, true]) {
    const context = await browser.newContext();
    try {
      await context.route('**/relay-config.json', route => route.fulfill({ json: {
        ...config,
        relays: config.relays.map(relay => ({ ...relay, enabled: !allDisabled && relay.id !== 'fr-1' })),
      } }));
      const page = await context.newPage();
      await page.goto(`${process.env.E2E_SITE || 'http://127.0.0.1:8099'}/?autostart=1&room=relay-review-${Date.now()}`);
      if (allDisabled) {
        await page.waitForFunction(() => window.__state?.().node?.includes('启动失败'));
        check('全部禁用时不会进房', !await page.evaluate(() => window.__state().joined));
        check('全部禁用时明确提示启动失败', (await page.evaluate(() => window.__state().node)).includes('启动失败'));
      } else {
        await page.waitForFunction(() => window.__state?.().joined, undefined, { timeout: 120000 });
        await page.locator('#tab-status').click();
        await page.waitForFunction(() => document.querySelectorAll('#panel-body .relay').length === 3);
        const states = await page.locator('#panel-body .relay').evaluateAll(rows => Object.fromEntries(rows.map(row => [
          row.querySelector('.relay__id').textContent,
          row.querySelector('.relay__state').textContent,
        ])));
        check('被禁用的中继标为已禁用', states['fr-1'] === '已禁用');
        check('启用的中继不标为已禁用', states['hk-1'] !== '已禁用' && states['eu-1'] !== '已禁用');
        check('探测排除禁用中继', !await page.evaluate(() => window.__iroh_net.probes.some(probe => probe.id === 'fr-1')));
      }
    } finally {
      await context.close();
    }
  }
  check('测试不修改磁盘配置', original.equals(await readFile(configPath)));
  console.log(`总计 PASS=${passed} FAIL=0`);
} finally {
  await browser.close();
}
