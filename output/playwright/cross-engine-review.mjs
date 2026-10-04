import { chromium, webkit } from '/Users/patrick/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';

const room = `review-webkit-${Date.now()}`;
const results = [];
const browsers = [];
try {
  for (const [label, engine, options] of [
    ['Chromium', chromium, { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }],
    ['WebKit', webkit, {}],
  ]) {
    const browser = await engine.launch({ headless: true, ...options });
    browsers.push(browser);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:8099/');
    await page.locator('#node-pill.is-ok').waitFor({ timeout: 60000 });
    await page.locator('#btn-new').click();
    await page.locator('#dlg-input').fill(room);
    await page.locator('#dlg-ok').click();
    await page.waitForFunction(() => window.__state?.().composerEnabled, { timeout: 60000 });
    await page.locator('#panel-scrim').click({ position: { x: 350, y: 100 } });
    await page.locator('#input').fill(`来自${label}的中文测试 🧪`);
    await page.locator('#input').press('Enter');
    await page.waitForFunction(() => document.getElementById('send').textContent === '发送');
    const picker = page.waitForEvent('filechooser');
    await page.locator('#tb-file').click();
    await (await picker).setFiles('/Users/patrick/WorkBuddy/iroh聊天室/output/playwright/fixture.txt');
    const modal = await page.locator('#modal').evaluate(element => element.classList.contains('is-on'));
    results.push({ label, userAgent: await page.evaluate(() => navigator.userAgent), fileSupport: await page.evaluate(() => typeof showSaveFilePicker), modal, fileMessage: modal ? await page.locator('#dlg-body').innerText() : '', errors });
    if (modal) await page.locator('#dlg-cancel').click();
  }
  const pages = browsers.map(browser => browser.contexts()[0].pages()[0]);
  for (const page of pages) {
    await page.locator('.bubble').filter({ hasText: '来自WebKit的中文测试' }).waitFor({ timeout: 45000 });
    await page.locator('.bubble').filter({ hasText: '来自Chromium的中文测试' }).waitFor({ timeout: 45000 });
    await page.locator('#tab-people').click();
    results.push({ label: await page.evaluate(() => navigator.userAgent), members: await page.locator('#panel-body').innerText(), state: await page.evaluate(() => window.__state()) });
  }
  for (const page of pages) await page.locator('#panel-scrim').click({ position: { x: 350, y: 100 } });
  await pages[0].locator('#send').click();
  await pages[1].locator('.msg--file').waitFor({ timeout: 30000 });
  await pages[1].locator('button[title="接收（会弹出保存位置）"]').click();
  await pages[1].waitForTimeout(300);
  results.push({
    case: 'WebKit 接收实际文件邀约',
    card: await pages[1].locator('.msg--file').innerText(),
    buttons: await pages[1].locator('.msg--file button').evaluateAll(buttons => buttons.map(button => ({ text: button.innerText, disabled: button.disabled }))),
    tip: await pages[1].locator('#composer-tip').innerText(),
  });
  await pages[1].screenshot({ path: 'output/playwright/review-webkit-receive.png' });
} catch (error) {
  results.push({ error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile('output/playwright/cross-engine-results.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await Promise.all(browsers.map(browser => browser.close()));
}
