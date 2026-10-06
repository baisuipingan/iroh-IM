import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = process.env.E2E_SITE || 'http://127.0.0.1:8099';
const output = process.env.E2E_OUTPUT || 'output/playwright/image-layout';
const results = [];
const browsers = [];
await mkdir(output, { recursive: true });
const check = (name, condition, detail) => { assert.ok(condition, detail ? `${name}: ${JSON.stringify(detail)}` : name); results.push(name); console.log(`PASS ${name}`); };
const shapes = [
  { name: 'portrait', width: 600, height: 900 },
  { name: 'landscape', width: 900, height: 450 },
  { name: 'square', width: 480, height: 480 },
  { name: 'tall', width: 80, height: 1200 },
  { name: 'wide', width: 1200, height: 80 },
];

try {
  for (const engine of ['chrome', 'webkit']) {
    const browser = engine === 'chrome'
      ? await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
      : await webkit.launch();
    browsers.push(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(site);
    await page.waitForFunction(() => !!window.__state, undefined, { timeout: 60000 });
    await page.evaluate(async shapes => {
      const { timeline } = await import('./js/ui/timeline.js');
      timeline.open('image-layout-rendering', 'layout-user');
      for (const [index, shape] of shapes.entries()) {
        const canvas = document.createElement('canvas');
        canvas.width = shape.width;
        canvas.height = shape.height;
        const paint = canvas.getContext('2d');
        paint.fillStyle = '#259c66';
        paint.fillRect(0, 0, canvas.width, canvas.height);
        paint.fillStyle = '#81c9f2';
        paint.fillRect(canvas.width / 4, canvas.height / 4, canvas.width / 2, canvas.height / 2);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const url = URL.createObjectURL(blob);
        for (const direction of ['send', 'recv']) {
          timeline.pushFileCard({ room: timeline.room, meta: { file_id: `${shape.name}-${direction}`, name: `${shape.name}.png`, size: blob.size, mime: blob.type, chunk_size: 16384 }, direction, state: direction === 'send' ? 'shared' : 'done', previewUrl: url, ts: Date.now() + index });
        }
      }
      timeline.pushFileCard({ room: timeline.room, meta: { file_id: 'pending', name: 'pending.png', size: 128, mime: 'image/png', chunk_size: 16384 }, direction: 'recv', state: 'invited' });
    }, shapes);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width === 320 && await page.locator('#panel-scrim').isVisible()) await page.locator('#panel-scrim').click();
        for (const shape of shapes) for (const direction of ['send', 'recv']) {
          const fileId = `${shape.name}-${direction}`;
          const card = page.locator(`.msg--img[data-file-id="${fileId}"]`);
          await card.scrollIntoViewIfNeeded();
          await card.locator('img').evaluate(async image => { image.loading = 'eager'; await image.decode(); });
          const metrics = await card.evaluate(card => {
            const bounds = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; };
            return { image: bounds(card.querySelector('img')), frame: bounds(card.querySelector('.imgcard__ph')), footer: bounds(card.querySelector('.imgcard__foot')), card: bounds(card.querySelector('.imgcard')), scrollWidth: document.getElementById('timeline').scrollWidth, clientWidth: document.getElementById('timeline').clientWidth };
          });
          const { image, frame, footer } = metrics;
          check(`${engine}/${theme}/${width}/${fileId}`, image.width > 0 && image.height > 0 && Math.abs(image.width / image.height - shape.width / shape.height) < 0.02 && image.left >= frame.left - 1 && image.right <= frame.right + 1 && image.top >= frame.top - 1 && image.bottom <= frame.bottom + 1 && Math.abs(frame.height - image.height) <= 1 && footer.top >= frame.bottom && image.height <= 220.1 && metrics.scrollWidth <= metrics.clientWidth + 1, metrics);
        }
        const pending = await page.locator('.msg--img[data-file-id="pending"] .imgcard__ph').boundingBox();
        check(`${engine}/${theme}/${width}/未接收占位框`, Math.abs(pending.height - 116) < 1);
        const portrait = page.locator('.msg--img[data-file-id="portrait-recv"]');
        await portrait.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${engine}-${theme}-${width}.png` });
      }
    }
    const portrait = page.locator('.msg--img[data-file-id="portrait-recv"]');
    await portrait.getByRole('button', { name: '放大图片', exact: true }).click();
    check(`${engine}/图片仍可放大`, await page.locator('.lightbox').evaluate(element => element.classList.contains('is-on')));
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const { timeline } = await import('./js/ui/timeline.js');
      timeline.updateFileCard({ file_id: 'portrait-recv', previewUrl: null });
    });
    check(`${engine}/释放预览恢复占位`, await portrait.locator('.imgcard__ph').innerText() === '图片预览已释放，文件仍保存在本地' && Math.abs((await portrait.locator('.imgcard__ph').boundingBox()).height - 116) < 1);
    check(`${engine}/无页面异常`, errors.length === 0);
    await context.close();
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ results, success: !process.exitCode }, null, 2));
  await Promise.all(browsers.map(browser => browser.close()));
  console.log(`总计 PASS=${results.length} FAIL=${process.exitCode ? 1 : 0}`);
}
