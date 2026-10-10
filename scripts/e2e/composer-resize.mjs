import assert from 'node:assert/strict';

/**
 * 窄屏（≤760px）侧栏是抽屉，会**拦截点击**。
 *
 * ⚠️ 光"点一下遮罩"不够：关闭是有动画的，动画期间 `#panel` 仍带 `is-open`，
 *    于是紧接着的 fill/click 会撞上 "subtree intercepts pointer events" ——
 *    这是**整链跑时才会偶发**的时序问题（单独跑从来不出现，实测过），
 *    所以这里要一直等到它真的关上再往下走。
 */
async function ensureDrawerClosed(page) {
  // ⚠️ **不要用"点遮罩"**来关：窄屏下遮罩可能被抽屉整个盖住（z-index 更低），
  //    Playwright 点到的是抽屉本身，于是"关闭"静默失败、后面的点击全被拦截 ——
  //    这是这个用例此前偶发飘红的真实原因（实测：`elementFromPoint` 落在 panel-body）。
  //    直接调应用自己的 API 才是确定的。
  await page.evaluate(async () => {
    const { sidebar } = await import('./js/ui/sidebar.js');
    sidebar.closePanel();
  });
  // 关不上就让用例**响亮地失败**，别把问题推到后面那次莫名其妙的点击超时上
  await page.waitForFunction(
    () => !document.getElementById('panel')?.classList.contains('is-open'),
    undefined,
    { timeout: 5000 },
  );
}

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
    // 启动尾巴跑完再操作：否则 `sidebar.show('chats')` 可能在窄屏重新打开抽屉（见 test-hooks.js）
    await page.waitForFunction(() => window.__iroh_booted === true, undefined, { timeout: 60000 });
    const draft = '这是一段用于测试窗口缩小后输入框自动换行的草稿。'.repeat(8);
    await page.locator('#input').fill(draft);
    const wideHeight = await page.locator('#input').evaluate(element => element.clientHeight);
    await page.setViewportSize({ width: 720, height: 900 });
    // 720px 已进入抽屉布局（CSS 断点 760px）—— 抽屉开着会拦住下面的 fill
    await ensureDrawerClosed(page);
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
