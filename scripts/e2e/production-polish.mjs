import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = process.env.E2E_SITE || 'http://127.0.0.1:8099';
const output = process.env.E2E_OUTPUT || 'output/playwright/production-polish';
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
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${site}/?autostart=1&room=polish-${engine}-${Date.now()}`);
    await page.waitForFunction(() => window.__state?.().joined, undefined, { timeout: 120000 });
    await page.evaluate(async () => {
      const { store } = await import('./js/store.js');
      window.Notification = class {
        static permission = 'denied';
      };
      store.setPref('notify', true);
      window.__iroh_openSettings();
      window.dispatchEvent(new Event('focus'));
    });
    assert.equal(
      await page.locator('[data-toggle="notify"]').getAttribute('aria-checked'),
      'false',
    );
    assert.equal(await page.evaluate(() => window.__state().ui.notifyOn), false);
    passed += 2;
    await page.evaluate(async () => {
      const { dialog } = await import('./js/ui/dialog.js');
      dialog.open({
        title: '异步操作测试',
        body: '<input id="polish-draft" value="保留输入" />',
        onOk: async () => {
          throw new Error('模拟操作失败');
        },
      });
    });
    await page.locator('#dlg-ok').click();
    await page.locator('#dlg-error').waitFor();
    assert.equal(await page.locator('#dlg-error').innerText(), '模拟操作失败');
    assert.equal(await page.locator('#polish-draft').inputValue(), '保留输入');
    assert.equal(await page.locator('#dlg-ok').isEnabled(), true);
    await page.locator('#dlg-cancel').click();
    passed += 3;
    await page.screenshot({ path: `${output}/${engine}-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => innerWidth === 390 && innerHeight === 844);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/${engine}-mobile.png` });
    passed++;
    await page.locator('#panel-scrim').click({ position: { x: 380, y: 400 } });
    assert.equal(await page.locator('#panel-scrim').isVisible(), false);
    passed++;
    await page.setViewportSize({ width: 1280, height: 720 });
    const cloneFailure = await page.evaluate(async () => {
      const client = window.__iroh_net.client;
      const result = client.call('online', () => {});
      const id = client.seq;
      const name = await result.catch((error) => error.name);
      return { name, leaked: client.pending.has(id) };
    });
    assert.equal(cloneFailure.name, 'DataCloneError');
    assert.equal(cloneFailure.leaked, false);
    passed += 2;
    await page.locator('#tab-chats').click();
    await page.evaluate(async () => {
      const { fileTransfer } = await import('./js/ui/filetransfer.js');
      const room = window.__state().joined;
      const receiver = {
        file_id: 'worker-recv',
        name: 'partial.txt',
        size: 100,
        sender: 'b'.repeat(64),
        chunk_size: 10,
      };
      fileTransfer.handle({ type: 'fileInvite', room, meta: receiver });
      Object.assign(fileTransfer.transfers.get(receiver.file_id), { state: 'active', done: 4 });
      const recipients = [
        { id: 'done-peer', state: 'done', done: 10, total: 10 },
        { id: 'rejected-peer', state: 'rejected', done: 0, total: 10 },
        { id: 'sending-peer', state: 'sending', done: 4, total: 10 },
      ];
      const sender = {
        meta: { ...receiver, file_id: 'worker-send', sender: window.__state().myId },
        room,
        direction: 'send',
        state: 'active',
        available: true,
        recipients,
      };
      fileTransfer.transfers.set(sender.meta.file_id, sender);
      fileTransfer.rebuildCardsForRoom(room);
      const client = window.__iroh_net.client;
      window.pendingResult = client.call('online').then(
        () => 'unexpected success',
        (error) => error.message,
      );
      window.onlineResult = window.__iroh_net._goOnline();
      client.worker.onerror({ message: 'simulated worker failure' });
      client.worker.onmessage({
        data: {
          type: 'transfer:recv',
          payload: { file_id: receiver.file_id, done: 10, total: 10 },
        },
      });
    });
    assert.match(await page.evaluate(() => window.pendingResult), /simulated worker failure/);
    assert.equal(await page.evaluate(() => window.__iroh_net.client.pending.size), 0);
    assert.equal(await page.evaluate(() => window.__iroh_net.canSend), false);
    assert.equal(await page.locator('#input').isDisabled(), true);
    const later = await page.evaluate(() =>
      window.__iroh_net.client.call('send', 'x', 'room').catch((error) => error.message),
    );
    assert.match(later, /simulated worker failure/);
    passed += 5;
    await page.evaluate(() => window.onlineResult);
    assert.equal(await page.evaluate(() => window.__iroh_net.phase), 'offline');
    assert.equal(await page.evaluate(() => window.__iroh_net._retryTimer), null);
    const cards = await page.evaluate(async () => {
      const { fileTransfer } = await import('./js/ui/filetransfer.js');
      return {
        recv: fileTransfer.transfers.get('worker-recv'),
        send: fileTransfer.transfers.get('worker-send'),
      };
    });
    assert.equal(cards.recv.state, 'failed');
    assert.equal(cards.recv.done, 4);
    assert.equal(cards.send.available, false);
    assert.deepEqual(
      cards.send.recipients.map((recipient) => recipient.state),
      ['done', 'rejected', 'failed'],
    );
    assert.match(
      await page.locator('.msg--file[data-file-id="worker-recv"]').innerText(),
      /后台线程已停止/,
    );
    assert.match(
      await page.locator('.msg--file[data-file-id="worker-send"]').innerText(),
      /已停止分享/,
    );
    passed += 8;
    assert.deepEqual(errors, []);
    passed++;
    await context.close();

    const invalid = await browser.newContext();
    await invalid.route('**/relay-config.json', (route) =>
      route.fulfill({ json: { relays: 'bad' } }),
    );
    const invalidPage = await invalid.newPage();
    const invalidErrors = [];
    invalidPage.on('pageerror', (error) => invalidErrors.push(error.message));
    await invalidPage.goto(site);
    await invalidPage.waitForFunction(() =>
      document.body.innerText.includes('中继配置缺少 relays 列表'),
    );
    assert.deepEqual(invalidErrors, []);
    passed += 2;
    await invalid.close();
    console.log(`PASS ${engine}/权限撤回、Worker崩溃、无溢出、错误配置反馈`);
  } finally {
    await browser.close();
  }
}
console.log(`总计 PASS=${passed} FAIL=0`);
