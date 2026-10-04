import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = process.env.E2E_SITE || 'http://127.0.0.1:8099';
const output = process.env.E2E_OUTPUT || 'output/playwright/message-ownership';
const results = [];
const browsers = [];
const errors = [];
await mkdir(output, { recursive: true });
const check = (name, condition, details) => { assert.ok(condition, `${name}${details ? `: ${JSON.stringify(details)}` : ''}`); results.push(name); console.log(`PASS ${name}`); };
const joined = (page, room) => page.waitForFunction(room => window.__state?.().joined === room, room, { timeout: 90000 });
const send = async (page, text) => { await page.locator('#input').fill(text); await page.locator('#send').click(); };
const bubble = (page, text) => page.locator('.msg').filter({ has: page.locator('.bubble').filter({ hasText: text }) });
const ownership = async (page, text, mine) => {
  const message = bubble(page, text);
  await message.waitFor({ timeout: 45000 });
  return message.evaluate((element, mine) => {
    const row = element.getBoundingClientRect();
    const timeline = document.getElementById('timeline').getBoundingClientRect();
    return element.classList.contains('msg--me') === mine && (mine ? Math.abs(row.right - timeline.right) < 40 : Math.abs(row.left - timeline.left) < 40);
  }, mine);
};

try {
  for (const engine of ['chrome', 'webkit']) {
    const browser = engine === 'chrome'
      ? await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
      : await webkit.launch();
    browsers.push(browser);
    const room = `ownership-${engine}-${Date.now()}`;
    const context = await browser.newContext();
    const otherContext = await browser.newContext();
    const page = await context.newPage();
    const other = await otherContext.newPage();
    for (const current of [page, other]) current.on('pageerror', error => errors.push(error.message));
    for (const current of [page, other]) {
      await current.goto(`${site}/?autostart=1&room=${room}`);
      await joined(current, room);
    }
    const identity = await page.evaluate(() => window.__state().myId);
    const mine = `own-message-${engine}`;
    const theirs = `other-message-${engine}`;
    await send(page, mine);
    await send(other, theirs);
    check(`${engine}/首次发送居右`, await ownership(page, mine, true));
    check(`${engine}/他人消息居左`, await ownership(page, theirs, false));
    await page.waitForFunction(({ room, texts }) => window.__net.history(room, 50).then(messages => texts.every(text => messages.some(message => message.text === text))), { room, texts: [mine, theirs] }, { timeout: 45000 });

    for (let attempt = 0; attempt < 2; attempt++) {
      let releaseWorker;
      const gate = new Promise(resolve => { releaseWorker = resolve; });
      await page.route('**/iroh-worker.js', async route => { await gate; await route.continue(); });
      try {
        await page.goto(site);
        await page.locator(`.row[data-room="${room}"]`).click();
        check(`${engine}/刷新${attempt + 1}启动中可选房`, await page.evaluate(() => window.__state().myId === '' && window.__state().room) === room);
      } finally { releaseWorker(); }
      await joined(page, room);
      const state = await page.evaluate(async () => ({ identity: window.__state().myId, timelineIdentity: (await import('./js/ui/timeline.js')).timeline.me }));
      check(`${engine}/刷新${attempt + 1}身份先于进房初始化`, state.identity === identity && state.timelineIdentity === identity, state);
      check(`${engine}/刷新${attempt + 1}自己的历史居右`, await ownership(page, mine, true));
      check(`${engine}/刷新${attempt + 1}他人历史仍居左`, await ownership(page, theirs, false));
      await page.unroute('**/iroh-worker.js');
      const next = `own-after-refresh-${engine}-${attempt}`;
      await send(page, next);
      check(`${engine}/刷新${attempt + 1}新消息居右`, await ownership(page, next, true));
    }
    await page.evaluate(room => window.__openRoom(room), `${room}-other`);
    await joined(page, `${room}-other`);
    await page.evaluate(room => window.__openRoom(room), room);
    await joined(page, room);
    check(`${engine}/切房返回仍居右`, await ownership(page, mine, true));
    check(`${engine}/切房返回他人仍居左`, await ownership(page, theirs, false));
    await page.goto(site);
    await page.waitForFunction(() => window.__state?.().phase === 'online', undefined, { timeout: 90000 });
    await page.locator(`.row[data-room="${room}"]`).click();
    await joined(page, room);
    check(`${engine}/等待启动后选房自己的历史居右`, await ownership(page, mine, true));
    check(`${engine}/等待启动后选房他人居左`, await ownership(page, theirs, false));
    await page.screenshot({ path: `${output}/${engine}.png` });

    if (engine === 'chrome') {
      for (const current of [page, other]) await current.evaluate(() => { window.__useOpfs = true; });
      for (const filename of ['ownership.txt', 'ownership.png']) {
        const meta = await page.evaluate(async ({ room, filename }) => {
          let file;
          if (filename.endsWith('.png')) {
            const canvas = document.createElement('canvas');
            canvas.width = 80;
            canvas.height = 120;
            canvas.getContext('2d').fillRect(0, 0, 80, 120);
            file = new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], filename, { type: 'image/png' });
          } else file = new File(['ownership-transfer'], filename, { type: 'text/plain' });
          return window.__sendFile(file, room);
        }, { room, filename });
        await other.waitForFunction(fileId => window.__transfers().some(transfer => transfer.file_id === fileId), meta.file_id, { timeout: 45000 });
        await other.evaluate(async fileId => {
          const { fileTransfer } = await import('./js/ui/filetransfer.js');
          if (window.__transfers().find(transfer => transfer.file_id === fileId).state === 'archived') await fileTransfer.openArchived(fileId);
        }, meta.file_id);
        await other.waitForFunction(fileId => window.__transfers().find(transfer => transfer.file_id === fileId)?.state === 'invited', meta.file_id, { timeout: 45000 });
        await other.evaluate(fileId => window.__acceptFile(fileId), meta.file_id);
        await other.waitForFunction(fileId => window.__transfers().find(transfer => transfer.file_id === fileId)?.state === 'done', meta.file_id, { timeout: 60000 });
        for (const [label, current, sent] of [['发送端', page, true], ['接收端', other, false]]) {
          const card = current.locator(`.msg--file[data-file-id="${meta.file_id}"]`);
          check(`${filename}/${label}按发送身份左右对齐`, await card.evaluate((element, sent) => element.classList.contains('msg--me') === sent && element.dataset.dir === (sent ? 'send' : 'recv'), sent));
        }
      }
      await page.evaluate(room => window.__openRoom(room), `${room}-other`);
      await joined(page, `${room}-other`);
      await page.evaluate(room => window.__openRoom(room), room);
      await joined(page, room);
      check('文件/图片切房重建保持右侧', await page.locator('.msg--file[data-dir="send"]').evaluateAll(cards => cards.length === 2 && cards.every(card => card.classList.contains('msg--me'))));
    }
    await context.close();
    await otherContext.close();
  }
  check('无未处理页面异常', errors.length === 0, errors);
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors, success: !process.exitCode }, null, 2));
  await Promise.all(browsers.map(browser => browser.close()));
  console.log(`总计 PASS=${results.length} FAIL=${process.exitCode ? 1 : 0}`);
}
