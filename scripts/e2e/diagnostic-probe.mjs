import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = process.env.E2E_SITE || 'http://127.0.0.1:8099';
const output = process.env.E2E_OUTPUT || 'output/playwright/diagnostic-probe';
await mkdir(output, { recursive: true });
let passed = 0;
for (const engine of ['chrome', 'webkit']) {
  const browser =
    engine === 'chrome'
      ? await chromium.launch({
          executablePath:
            process.env.CHROME_PATH ||
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        })
      : await webkit.launch();
  try {
    const context = await browser.newContext();
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${site}/probe.html`);
    await page.waitForFunction(() => document.getElementById('peer-relay').value);
    await page.locator('#btn-start').click();
    await page.waitForFunction(
      () => document.getElementById('node-state').textContent === '在线',
      undefined,
      { timeout: 45000 },
    );
    assert.match(await page.locator('#my-id').innerText(), /^[0-9a-f]{64}$/);
    assert.equal(await page.locator('#btn-send').isEnabled(), true);
    passed += 2;
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error('模拟复制被拒绝');
      };
    });
    await page.locator('#btn-copy').click();
    await page.waitForFunction(() => document.getElementById('log').innerText.includes('复制失败'));
    assert.deepEqual(errors, []);
    passed++;
    await page.screenshot({ path: `${output}/${engine}-probe.png` });
    await page.locator('#btn-stop').click();
    assert.equal(await page.locator('#node-state').innerText(), '已关闭');
    assert.equal(await page.locator('#btn-start').isEnabled(), true);
    passed += 2;
    await context.close();

    for (const mode of ['invalid', 'disabled']) {
      const isolated = await browser.newContext();
      await isolated.route('**/relay-config.json', async (route) => {
        if (mode === 'invalid') return route.fulfill({ json: { relays: 'invalid' } });
        const config = await (await route.fetch()).json();
        for (const relay of config.relays) relay.enabled = false;
        await route.fulfill({ json: config });
      });
      const target = await isolated.newPage();
      target.on('pageerror', (error) => errors.push(error.message));
      await target.goto(`${site}/probe.html?autostart=1`);
      const text = mode === 'invalid' ? '中继配置加载失败' : '所有中继都已禁用';
      await target.waitForFunction(
        (text) => document.getElementById('log').innerText.includes(text),
        text,
      );
      assert.equal(await target.locator('#my-id').innerText(), '—');
      assert.equal(await target.locator('#btn-start').isEnabled(), true);
      assert.deepEqual(errors, []);
      passed += 3;
      await isolated.close();
    }
    console.log(`PASS ${engine}/诊断页真实鉴权连接、复制反馈、关闭、无效及禁用配置`);
  } finally {
    await browser.close();
  }
}
console.log(`总计 PASS=${passed} FAIL=0`);
