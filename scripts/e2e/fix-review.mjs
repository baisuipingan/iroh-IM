import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = process.env.E2E_SITE || 'http://127.0.0.1:8099';
const room = `fix-review-${Date.now()}`;
const output = process.env.E2E_OUTPUT || 'output/playwright/fix-review';
const results = [];
const errors = [];
const browsers = [];
await mkdir(output, { recursive: true });
const check = (name, condition) => { assert.ok(condition, name); results.push(name); console.log(`PASS ${name}`); };
const joined = (page, target = room) => page.waitForFunction(target => window.__state?.().joined === target, target, { timeout: 60000 });
const send = async (page, text) => { await page.locator('#input').fill(text); await page.locator('#send').click(); };
const received = (page, text) => page.locator('.bubble').filter({ hasText: text }).waitFor({ timeout: 45000 });
const chooseFile = async (page, file) => {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#tb-file').click();
  await (await chooser).setFiles(file);
};
const boot = async (browser, options = {}, target = room) => {
  const context = await browser.newContext(options);
  if (process.env.E2E_ANCHOR) await context.route('**/relay-config.json', async route => {
    const response = await route.fetch();
    const config = await response.json();
    config.anchor.id = process.env.E2E_ANCHOR;
    await route.fulfill({ json: config });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${site}/?autostart=1&room=${encodeURIComponent(target)}`);
  await joined(page, target);
  return page;
};

try {
  const chrome = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  const safariEngine = await webkit.launch();
  browsers.push(chrome, safariEngine);
  const sender = await boot(chrome);
  const receiver = await boot(chrome);
  await send(sender, 'before-webkit');
  await received(receiver, 'before-webkit');
  const webkitPage = await boot(safariEngine);
  await received(webkitPage, 'before-webkit');
  check('第三人历史加载', true);
  for (const [index, page] of [sender, receiver, webkitPage].entries()) await send(page, `live-${index}`);
  for (const page of [sender, receiver, webkitPage]) for (const index of [0, 1, 2]) await received(page, `live-${index}`);
  check('Chrome/独立Chrome/WebKit三方互发', true);
  await receiver.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  await send(sender, 'hidden-current-room');
  await received(receiver, 'hidden-current-room');
  check('当前房隐藏状态累计未读', await receiver.evaluate(() => window.__state().unread) > 0);
  await receiver.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  check('恢复可见清除未读', await receiver.evaluate(() => window.__state().unread) === 0);

  const identity = await sender.evaluate(() => window.__state().myId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now();
    await sender.reload();
    await joined(sender);
    check(`同身份刷新${attempt + 1}恢复（${Date.now() - started}ms）`, await sender.evaluate(() => window.__state().myId) === identity);
    await send(sender, `after-refresh-${attempt}`);
    await received(receiver, `after-refresh-${attempt}`);
  }

  const rejected = await sender.evaluate(async () => {
    try { await window.__net.send('长'.repeat(180000)); return false; }
    catch (error) { return /消息过长/.test(error.message); }
  });
  check('Rust拒绝超限完整报文', rejected);
  await send(sender, '健康消息-after-large');
  await received(receiver, '健康消息-after-large');
  check('超限后通信仍健康', true);
  await send(sender, '长'.repeat(180000));
  check('前端超限保留原文', (await sender.locator('#input').inputValue()).length === 180000);
  await sender.locator('#input').fill('');

  await sender.evaluate(() => {
    window.__originalSend = window.__net.send;
    window.__net.send = async function(...args) { const result = await window.__originalSend.apply(this, args); await new Promise(resolve => { window.__releaseSend = resolve; }); return result; };
  });
  await send(sender, 'first-draft');
  await sender.locator('#input').fill('next-draft');
  await chooseFile(sender, { name: 'new-attachment.txt', mimeType: 'text/plain', buffer: Buffer.from('new attachment') });
  await sender.waitForFunction(() => !!window.__releaseSend);
  await sender.evaluate(() => window.__releaseSend());
  await sender.waitForFunction(() => document.getElementById('send').textContent === '发送');
  check('异步发送保留新草稿与新附件', await sender.locator('#input').inputValue() === 'next-draft' && await sender.locator('.pending__item').count() === 1);
  await sender.evaluate(() => { window.__net.send = window.__originalSend; });
  await sender.evaluate(() => {
    window.__net.send = () => new Promise((resolve, reject) => { window.__failSend = () => reject(new Error('模拟失败')); });
  });
  await sender.locator('.pending__x').click();
  await send(sender, 'failed-original');
  await sender.locator('#input').fill('new-after-failure');
  await sender.waitForFunction(() => !!window.__failSend);
  await sender.evaluate(() => window.__failSend());
  await sender.waitForFunction(() => document.getElementById('send').textContent === '发送');
  check('异步失败不覆盖新草稿', await sender.locator('#input').inputValue() === 'new-after-failure');
  await sender.evaluate(() => { window.__net.send = window.__originalSend; });
  await chooseFile(sender, { name: 'room-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('room draft') });
  await sender.locator('#input').fill('room-A-draft');
  await sender.evaluate(target => window.__openRoom(target), `${room}-other`);
  await joined(sender, `${room}-other`);
  check('切房不泄露草稿/附件', await sender.locator('#input').inputValue() === '' && await sender.locator('.pending__item').count() === 0);
  await sender.locator('#input').fill('room-B-draft');
  await sender.evaluate(target => window.__openRoom(target), room);
  await joined(sender);
  check('回房恢复原草稿/附件', await sender.locator('#input').inputValue() === 'room-A-draft' && await sender.locator('.pending__item').count() === 1);
  await sender.locator('.pending__x').click();
  await sender.locator('#input').fill('');

  await sender.locator('#btn-new').click();
  await sender.locator('#dlg-input').fill('长'.repeat(90));
  await sender.locator('#dlg-ok').click();
  check('非法房名不发起网络且保留对话框', await sender.locator('#modal').evaluate(element => element.classList.contains('is-on')) && await sender.evaluate(() => window.__state().joined) === room);
  await sender.locator('#dlg-cancel').click();
  await sender.locator('#room-title').click();
  for (let count = 0; count < 12; count++) { await sender.keyboard.press('Tab'); check(`模态焦点约束${count}`, await sender.evaluate(() => !!document.activeElement.closest('#modal'))); }
  await sender.keyboard.press('Escape');
  check('关闭恢复焦点', await sender.evaluate(() => document.activeElement.id) === 'room-title');

  const bubble = receiver.locator('.bubble').filter({ hasText: '健康消息-after-large' });
  await bubble.click({ button: 'right' });
  await receiver.getByRole('button', { name: '删除（仅本地）', exact: true }).click();
  await receiver.reload();
  await joined(receiver);
  await received(receiver, 'before-webkit');
  check('本地隐藏刷新后持续生效', await receiver.locator('.bubble').filter({ hasText: '健康消息-after-large' }).count() === 0);

  await chooseFile(sender, { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  check('空文件明确提示', /空文件/.test(await sender.locator('#composer-tip').innerText()));
  const image = Buffer.from(await sender.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 600;
    const context = canvas.getContext('2d');
    context.fillStyle = '#28a745';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await chooseFile(sender, { name: 'preview.png', mimeType: 'image/png', buffer: image });
  await sender.locator('#send').click();
  await receiver.locator('.msg--img').waitFor({ timeout: 30000 });
  await webkitPage.locator('.msg--img').waitFor({ timeout: 30000 });
  const fileId = await receiver.locator('.msg--img').getAttribute('data-file-id');
  check('WebKit禁用接收并保留拒绝', await webkitPage.locator('.msg--img').getByText('接收需 Chrome / Edge').count() === 1 && await webkitPage.locator('button[title="接收（会弹出保存位置）"]').count() === 0);
  await webkitPage.locator('.msg--img').getByRole('button', { name: '拒绝', exact: true }).click();
  await receiver.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException('permission denied', 'NotAllowedError'); }; });
  await receiver.locator('.msg--img button[title="接收（会弹出保存位置）"]').click();
  await receiver.waitForFunction(() => document.querySelector('.msg--img button[title="接收（会弹出保存位置）"]')?.disabled === false && document.getElementById('composer-tip').textContent.includes('无法选择保存位置'));
  check('保存位置异常恢复接收控件', /无法选择保存位置/.test(await receiver.locator('#composer-tip').innerText()));
  await receiver.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException('cancelled', 'AbortError'); }; });
  await receiver.locator('.msg--img button[title="接收（会弹出保存位置）"]').click();
  await receiver.waitForFunction(fileId => window.__transfers().find(transfer => transfer.file_id === fileId)?.state === 'cancelled', fileId);
  await sender.waitForFunction(() => window.__transfers().some(transfer => transfer.direction === 'send' && transfer.peersCancelled === 1 && transfer.peersRejected === 1));
  check('取消保存与明确拒绝分开统计', true);
  check('取消保存清掉旧权限错误', await receiver.locator('.msg--img .filecard__err').count() === 0);
  await sender.locator('.msg--img button[title^="重新邀请"]').click();
  await receiver.locator('.msg--img button[title="接收（会弹出保存位置）"]').waitFor();
  check('重邀取消者恢复接收入口', true);
  await receiver.evaluate(() => { window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('preview.png', { create: true }); });
  await receiver.locator('.msg--img button[title="接收（会弹出保存位置）"]').click();
  await receiver.waitForFunction(fileId => window.__transfers().find(transfer => transfer.file_id === fileId)?.state === 'done', fileId, { timeout: 60000 });
  await receiver.locator('.imgcard__ph img').waitFor();
  await sender.locator('.imgcard__ph img').waitFor();
  check('真实文件传输后双方图片预览', true);
  for (const [label, page] of [['发送端', sender], ['接收端', receiver]]) {
    const fits = await page.locator('.msg--img').evaluate(async card => {
      const image = card.querySelector('.imgcard__ph img');
      await image.decode();
      const picture = image.getBoundingClientRect();
      const frame = card.querySelector('.imgcard__ph').getBoundingClientRect();
      const footer = card.querySelector('.imgcard__foot').getBoundingClientRect();
      return Math.abs(picture.width / picture.height - 2 / 3) < 0.01 && Math.abs(frame.height - picture.height) < 1 && footer.top >= picture.bottom;
    });
    check(`${label}真实竖图按比例撑开预览且不遮挡底栏`, fits);
  }
  await receiver.locator('.imgcard__ph button').click();
  await receiver.keyboard.press('Escape');
  check('图片可放大并Esc关闭', !await receiver.locator('.lightbox').evaluate(element => element.classList.contains('is-on')));

  await receiver.setViewportSize({ width: 320, height: 700 });
  if (await receiver.locator('#panel').evaluate(element => element.classList.contains('is-open'))) {
    await receiver.locator('#panel-scrim').click({ position: { x: 20, y: 500 } });
    await receiver.waitForFunction(() => !document.getElementById('panel').classList.contains('is-open'));
  }
  await receiver.locator('#tb-emoji').click();
  const bounds = await receiver.locator('#emoji-pop').boundingBox();
  check('320px表情面板完整可见', bounds.x >= 0 && bounds.x + bounds.width <= 320);
  await receiver.screenshot({ path: `${output}/mobile.png` });

  const storageContext = await chrome.newContext();
  await storageContext.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; });
  const storagePage = await storageContext.newPage();
  storagePage.on('pageerror', error => errors.push(error.message));
  await storagePage.goto(`${site}/`);
  await storagePage.getByText('临时存储模式', { exact: true }).waitFor({ timeout: 60000 });
  check('存储失败仍启动并明确临时模式', await storagePage.evaluate(() => window.__state().phase) === 'online');
  await storagePage.screenshot({ path: `${output}/storage.png` });

  await sender.evaluate(() => {
    const rooms = Array.from({ length: 40 }, (_, index) => ({ name: `seed-${index}`, pinned: index === 39, last: index }));
    localStorage.setItem('iroh.rooms', JSON.stringify(rooms));
  });
  await sender.locator('#btn-new').click();
  await sender.locator('#dlg-input').fill('forty-first');
  await sender.locator('#dlg-ok').click();
  check('列表满时不丢置顶项并提示', await sender.evaluate(() => JSON.parse(localStorage.getItem('iroh.rooms')).some(item => item.name === 'seed-39')) && /列表已满/.test(await sender.locator('#composer-tip').innerText()));
  await sender.locator('#dlg-cancel').click();
  await sender.locator('#tab-settings').click();
  await sender.locator('[data-pref="density"]').selectOption('compact');
  await sender.locator('[data-act="clearlocal"]').click();
  await sender.locator('#dlg-ok').click();
  await sender.waitForFunction(() => window.__state().joined === null && window.__state().room === '');
  check('清本地即时恢复默认偏好并退出', await sender.evaluate(() => document.documentElement.dataset.density) === 'cozy' && await sender.evaluate(() => window.__state().rooms.length) === 0);
  const invitationOrdering = await receiver.evaluate(async () => {
    const { fileTransfer } = await import('./js/ui/filetransfer.js');
    const room = window.__state().joined;
    const sender = 'a'.repeat(64);
    const states = [];
    for (const isHistory of [false, true]) {
      const fileId = `proof-order-${isHistory}`;
      fileTransfer._onFileProof(room, { id: fileId, ts: Date.now(), from: sender, file: { file_id: fileId, name: 'order.txt', size: 32 } }, isHistory);
      fileTransfer._onInvite(room, { file_id: fileId, name: 'order.txt', size: 32, sender, chunk_size: 16384, root_hash: 'b'.repeat(64) });
      states.push(window.__transfers().find(transfer => transfer.file_id === fileId).state);
    }
    return states;
  });
  check('实时文件证明先到不吞掉新邀约', invitationOrdering[0] === 'invited');
  check('历史文件不被他人查询广播劫持', invitationOrdering[1] === 'archived');
  for (const mode of ['worker-error', 'boot-timeout']) {
    const context = await chrome.newContext();
    if (mode === 'worker-error') await context.route('**/iroh-worker.js', route => route.abort('failed'));
    else {
      await context.route('**/iroh-worker.js', route => route.fulfill({ contentType: 'text/javascript', body: 'self.onmessage = () => {};' }));
      await context.addInitScript(() => {
        if (sessionStorage.getItem('startup-test-recovered')) return;
        const original = window.setTimeout.bind(window);
        window.setTimeout = (callback, delay, ...args) => original(callback, delay === 45000 ? 100 : delay, ...args);
      });
    }
    const page = await context.newPage();
    await page.goto(`${site}/`);
    await page.locator('#btn-boot-retry').waitFor({ timeout: 10000 });
    check(`${mode}显示启动失败和重试入口`, await page.evaluate(() => window.__state().node) === '节点启动失败');
    await context.unroute('**/iroh-worker.js');
    await page.evaluate(() => sessionStorage.setItem('startup-test-recovered', '1'));
    await page.locator('#btn-boot-retry').click();
    await page.waitForFunction(() => window.__state?.().phase === 'online', undefined, { timeout: 60000 });
    check(`${mode}点击重新启动可恢复`, true);
    await context.close();
  }
  await receiver.context().route('**/stalled-config.json', () => {});
  const configTimeout = await receiver.evaluate(async () => {
    const { loadRelayConfig } = await import('./js/probe.js');
    const { store } = await import('./js/store.js');
    const cacheKey = 'iroh.config-timeout-test';
    store.setValue(cacheKey, JSON.stringify({ version: 987, relays: [] }));
    const cached = await loadRelayConfig('./stalled-config.json', cacheKey);
    store.setValue(cacheKey, null);
    try { await loadRelayConfig('./stalled-config.json', cacheKey); return [cached.version, false]; }
    catch (error) { return [cached.version, /no cache/.test(error.message)]; }
  });
  check('配置请求超时回落已有缓存', configTimeout[0] === 987);
  check('配置请求超时无缓存明确失败', configTimeout[1]);
  await receiver.context().unroute('**/stalled-config.json');
  check('无未处理页面异常', errors.length === 0);
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors, success: !process.exitCode }, null, 2));
  await Promise.all(browsers.map(browser => browser.close()));
  console.log(`总计 PASS=${results.length} FAIL=${process.exitCode ? 1 : 0}`);
}
