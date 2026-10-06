import assert from 'node:assert/strict';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let passed = 0;
for (const engine of ['chrome', 'webkit']) {
  const browser = engine === 'chrome'
    ? await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    : await webkit.launch();
  try {
    const page = await browser.newPage();
    await page.goto(process.env.E2E_SITE || 'http://127.0.0.1:8099');
    await page.waitForFunction(() => window.__iroh_net?.endpoint_id(), undefined, { timeout: 90000 });
    await page.evaluate(() => window.__iroh_openSettings());
    const sound = page.locator('[data-toggle="sound"]');
    const before = await sound.getAttribute('aria-checked');
    await sound.evaluate(element => { window.soundToggleBefore = element; });
    await page.locator('#btn-head-sound').click();
    assert.equal(await sound.getAttribute('aria-checked'), String(before !== 'true'));
    assert.equal(await sound.evaluate(element => element.classList.contains('is-on')), before !== 'true');
    assert.ok(await page.evaluate(() => window.soundToggleBefore === document.querySelector('[data-toggle="sound"]')));
    await sound.click();
    assert.equal(await page.locator('#btn-head-sound').evaluate(element => element.classList.contains('is-off')), before !== 'true');
    console.log(`PASS ${engine}/提示音双向同步且快捷操作不重建设置`);
    passed++;
    await page.locator('#btn-head-lock').click();
    const privacy = await page.locator('#dlg-body').innerText();
    assert.ok(privacy.includes('读取并保存') && privacy.includes('没有额外的静态加密'));
    assert.ok(!privacy.includes('加密存储'));
    await page.locator('#dlg-ok').click();
    assert.ok((await page.locator('#panel-body').innerText()).includes('历史数据库未做额外静态加密'));
    console.log(`PASS ${engine}/常驻节点权限与静态加密说明准确`);
    passed++;
    await page.evaluate(async () => {
      const { topology } = await import('./js/ui/topology.js');
      const { sidebar } = await import('./js/ui/sidebar.js');
      const { net } = await import('./js/net.js');
      const { bus, EV } = await import('./js/bus.js');
      topology.show('topology');
      const count = () => document.querySelector('[data-metric="gossip"] .topo-card__num').textContent;
      const previous = sidebar.neighbors.size;
      bus.emit(EV.PEER_UP, { id: 'regression-peer' });
      if (count() !== String(previous + 1)) throw new Error('邻居上线未刷新');
      bus.emit(EV.PEER_DOWN, { id: 'regression-peer' });
      if (count() !== String(previous)) throw new Error('邻居下线未刷新');
      const relayStatus = net.relayStatus;
      try {
        net.relayStatus = () => [];
        topology.paint();
        if (topology._model().home !== null) throw new Error('候选被误认为已连接');
        const panel = document.getElementById('topology');
        if (!panel.textContent.includes('还没有接入任何中继') || !panel.textContent.includes('HTTP 探测延迟')) throw new Error('断线或探测文案错误');
        if (!panel.querySelector('.topo-link.is-dead')) throw new Error('断线链路仍亮起');
      } finally {
        net.relayStatus = relayStatus;
        topology.paint();
      }
    });
    console.log(`PASS ${engine}/邻居实时刷新、断线不冒充主链路、HTTP探测语义`);
    passed++;
  } finally {
    await browser.close();
  }
}
console.log(`PASS=${passed}`);
