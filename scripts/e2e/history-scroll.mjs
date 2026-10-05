import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.E2E_OUTPUT || 'output/playwright/history-scroll';
const results = [];
await mkdir(output, { recursive: true });
for (const engine of ['chrome', 'webkit']) {
  const browser = engine === 'chrome'
    ? await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    : await webkit.launch();
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto(process.env.E2E_SITE || 'http://127.0.0.1:8099');
      await page.waitForFunction(() => !!window.__state);
      for (const scenario of ['page', 'moving', 'empty', 'error', 'file']) {
        const metrics = await page.evaluate(async scenario => {
          const { timeline } = await import('./js/ui/timeline.js');
          const { net } = await import('./js/net.js');
          const original = net.history;
          const viewport = document.getElementById('timeline');
          const frames = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
          const offset = element => element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
          let release;
          let reject;
          try {
            timeline.open(`scroll-${scenario}`, 'me');
            for (let index = 50; index < 100; index++) timeline.push({ id: `message-${index}`, ts: 1700000000000 + index * 600000, from: 'other', nickname: 'Reader', text: `Message ${index}\n${'variable length text '.repeat(index % 5 + 1)}` }, false, true);
            await frames();
            net.history = () => new Promise((resolve, fail) => { release = resolve; reject = fail; });
            viewport.scrollTop = 0;
            timeline.atBottom = false;
            const anchor = document.querySelector('.msg[data-id="message-50"]');
            const beforeHint = offset(anchor);
            const loading = timeline.loadOlder();
            const afterHint = offset(anchor);
            let reader = anchor;
            if (scenario === 'moving') {
              viewport.scrollTop = 700;
              await frames();
              reader = [...document.querySelectorAll('.msg[data-ts]')].find(element => element.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top);
            }
            const before = offset(reader);
            if (scenario === 'error') {
              reject(new Error('test failure'));
              await loading;
            } else {
              release(scenario === 'empty' ? [] : Array.from({ length: 50 }, (_, index) => ({ id: `older-${index}`, ts: 1700000000000 - (50 - index) * 600000, from: 'other', nickname: 'History', text: `Older ${index}\n${'long history '.repeat(index % 4 + 1)}` })));
              await loading;
            }
            if (scenario === 'file') {
              timeline.pushFileCard({ room: timeline.room, meta: { file_id: 'historical-file', name: 'old.txt', size: 10, chunk_size: 16384 }, direction: 'recv', state: 'archived', ts: 1699999999999 });
            }
            if (scenario === 'empty') await new Promise(resolve => setTimeout(resolve, 1600));
            await frames();
            return { beforeHint, afterHint, before, after: offset(reader), scrollTop: viewport.scrollTop, rows: document.querySelectorAll('.msg').length };
          } finally {
            net.history = original;
            timeline.close();
          }
        }, scenario);
        assert.ok(Math.abs(metrics.beforeHint - metrics.afterHint) <= 2 && Math.abs(metrics.before - metrics.after) <= 2, `${engine}/${width}/${scenario}: ${JSON.stringify(metrics)}`);
        results.push({ engine, width, scenario, metrics });
        console.log(`PASS ${engine}/${width}/${scenario}`);
      }
      await page.close();
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
console.log(`PASS=${results.length}`);
