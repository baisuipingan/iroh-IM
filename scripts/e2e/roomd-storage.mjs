import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = process.env.E2E_SITE || 'http://127.0.0.1:8099';
const output = process.env.E2E_OUTPUT || 'output/playwright/roomd-storage';
const room = `storage-${Date.now()}`;
const results = [];
const errors = [];
const browsers = [];
const pages = [];
await mkdir(output, { recursive: true });
const check = (name, condition) => { assert.ok(condition, name); results.push(name); console.log(`PASS ${name}`); };
const join = page => page.waitForFunction(room => window.__state?.().joined === room, room, { timeout: 120000 });
const bubble = (page, text) => page.locator('.bubble').filter({ hasText: text });
const boot = async browser => {
  const context = await browser.newContext();
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${site}/?autostart=1&room=${room}`);
  await join(page);
  return page;
};
const history = page => page.evaluate(async room => {
  const { cursorOf } = await import('./js/util.js');
  const messages = [];
  let cursor = '';
  let requests = 0;
  while (true) {
    const page = await window.__net.history(room, 50, cursor);
    requests++;
    if (!page.length) break;
    messages.unshift(...page);
    const next = cursorOf(page[0]);
    if (next === cursor || requests > 20) throw new Error('历史游标未前进');
    cursor = next;
  }
  return { messages, requests };
}, room);
const waitForHistory = (page, count) => page.waitForFunction(async ({ room, count }) => {
  try { return (await window.__net.history(room, 1000)).length === count; }
  catch { return false; }
}, { room, count }, { timeout: 60000 });

try {
  const chrome = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  browsers.push(chrome);
  const users = [];
  for (let index = 0; index < 3; index++) users.push(await boot(chrome));
  const identities = await Promise.all(users.map(page => page.evaluate(() => window.__state().myId)));
  check('三份独立存储对应三个不同身份', new Set(identities).size === 3);
  for (let index = 0; index < users.length; index++) {
    await users[index].waitForFunction(async peers => {
      const { sidebar } = await import('./js/ui/sidebar.js');
      return peers.every(id => sidebar.peers.some(peer => peer.id === id));
    }, identities.filter((_, peer) => peer !== index), { timeout: 60000 });
  }
  check('三人互相可见', true);
  const initial = users.map((_, index) => `initial-user-${index}`);
  for (let index = 0; index < users.length; index++) await users[index].evaluate(text => window.__sendText(text), initial[index]);
  for (let index = 0; index < users.length; index++) {
    for (const text of initial) await bubble(users[index], text).waitFor({ timeout: 60000 });
    const state = await users[index].evaluate(() => window.__state());
    check(`用户${index + 1}自己的消息居右、他人居左`, state.mine.includes(initial[index]) && initial.filter((_, peer) => peer !== index).every(text => state.messages.includes(text)));
  }
  await waitForHistory(users[0], 3);
  const safari = await webkit.launch();
  browsers.push(safari);
  const late = await boot(safari);
  for (const text of initial) await bubble(late, text).waitFor({ timeout: 60000 });
  check('WebKit 第四人晚加入恢复前三条历史', true);
  await users[0].evaluate(async () => {
    for (let index = 0; index < 60; index++) await window.__sendText(`paging-${String(index).padStart(2, '0')}`);
  });
  await waitForHistory(users[0], 63);
  await bubble(users[2], 'paging-59').waitFor({ timeout: 60000 });
  check('多人连续发送与接收仍正常', true);
  await late.evaluate(() => window.__sendText('late-user-live'));
  for (const page of users) await bubble(page, 'late-user-live').waitFor({ timeout: 60000 });
  await waitForHistory(users[0], 64);
  const beforeRestart = await history(users[0]);
  check('50 条分页跨页读回全部 64 条', beforeRestart.messages.length === 64 && beforeRestart.requests === 3);
  check('分页没有重复或漏掉消息', new Set(beforeRestart.messages.map(message => message.id)).size === 64 && initial.every(text => beforeRestart.messages.some(message => message.text === text)));
  check('分页按时间和消息 ID 全序排列', beforeRestart.messages.every((message, index, list) => index === 0 || list[index - 1].ts < message.ts || (list[index - 1].ts === message.ts && list[index - 1].id < message.id)));
  await users[0].reload();
  await join(users[0]);
  await bubble(users[0], 'paging-59').waitFor({ timeout: 60000 });
  await bubble(users[0], 'late-user-live').waitFor({ timeout: 60000 });
  const refreshed = await users[0].evaluate(() => window.__state());
  check('刷新后自己的历史居右、第四人居左', refreshed.myId === identities[0] && refreshed.mine.includes('paging-59') && refreshed.messages.includes('late-user-live'));
  await users[0].screenshot({ path: `${output}/before-restart.png` });
  await writeFile(`${output}/restart-ready.json`, JSON.stringify({ room, count: 64, ids: beforeRestart.messages.map(message => message.id) }, null, 2));
  if (process.env.E2E_RESTART === '1') {
    console.log(`等待后端重启；完成后写入 ${output}/restart-complete.json`);
    const deadline = Date.now() + 240000;
    while (true) {
      try {
        const checkpoint = JSON.parse(await readFile(`${output}/restart-complete.json`, 'utf8'));
        if (checkpoint.ok) break;
      } catch {}
      if (Date.now() >= deadline) throw new Error('等待后端重启超时');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    for (const browser of browsers) for (const context of browser.contexts()) await context.close();
    const fresh = await boot(chrome);
    const restored = await history(fresh);
    check('后端重启后新浏览器读回完整历史', JSON.stringify(restored.messages.map(message => message.id)) === JSON.stringify(beforeRestart.messages.map(message => message.id)));
    await fresh.evaluate(() => window.__sendText('after-server-restart'));
    await waitForHistory(fresh, 65);
    check('后端重启后新消息继续持久化', (await history(fresh)).messages.some(message => message.text === 'after-server-restart'));
    await fresh.screenshot({ path: `${output}/after-restart.png` });
  }
  check('无未处理页面异常', errors.length === 0);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  const states = [];
  for (const page of pages) {
    try { states.push(await page.evaluate(() => window.__state?.())); } catch {}
  }
  await writeFile(`${output}/failure-states.json`, JSON.stringify(states, null, 2));
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ room, results, errors, success: !process.exitCode }, null, 2));
  await Promise.all(browsers.map(browser => browser.close()));
  console.log(`总计 PASS=${results.length} FAIL=${process.exitCode ? 1 : 0}`);
}
