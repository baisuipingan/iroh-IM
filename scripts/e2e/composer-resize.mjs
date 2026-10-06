import assert from 'node:assert/strict';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let passed = 0;
for (const engine of ['chrome', 'webkit']) {
  const browser = engine === 'chrome'
    ? await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    : await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const room = `composer-resize-${engine}-${Date.now()}`;
    await page.goto(`${process.env.E2E_SITE || 'http://127.0.0.1:8099'}/?autostart=1&room=${room}`);
    await page.waitForFunction(room => window.__state?.().joined === room, room, { timeout: 120000 });
    const draft = '这是一段用于测试窗口缩小后输入框自动换行的草稿。'.repeat(8);
    await page.locator('#input').fill(draft);
    const wideHeight = await page.locator('#input').evaluate(element => element.clientHeight);
    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForFunction(() => {
      const input = document.getElementById('input');
      return input.clientHeight >= input.scrollHeight || getComputedStyle(input).overflowY === 'auto';
    });
    assert.ok(await page.locator('#input').evaluate((element, height) => element.clientHeight > height, wideHeight));
    assert.equal(await page.locator('#input').inputValue(), draft);
    passed += 2;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(height => document.getElementById('input').clientHeight === height, wideHeight);
    passed++;
    await page.locator('#input').fill(`${draft}\n`.repeat(4));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('input')).overflowY === 'auto');
    passed++;
    await page.locator('#input').fill('短草稿');
    await page.waitForFunction(() => document.getElementById('input').clientHeight < 40);
    assert.deepEqual(errors, []);
    passed += 2;
    console.log(`PASS ${engine}/缩窄、放宽、保留草稿、长文滚动、短文收起、无页面异常`);
  } finally {
    await browser.close();
  }
}
console.log(`总计 PASS=${passed} FAIL=0`);
