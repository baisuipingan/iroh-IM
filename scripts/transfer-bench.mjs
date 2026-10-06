import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sizes = (process.env.BENCH_SIZES || '0.5,2,8').split(',').map(Number);
const minimum = Number(process.env.BENCH_MIN_KIBPS ?? 128);
const sink = process.env.BENCH_SINK || 'opfs';
assert.ok(sizes.every(size => Number.isFinite(size) && size > 0 && Number.isSafeInteger(size * 1048576)));
assert.ok(Number.isFinite(minimum) && minimum >= 0);
assert.ok(['opfs', 'noop'].includes(sink));
const output = process.env.E2E_OUTPUT || `output/playwright/transfer-bench-${Date.now()}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const room = `transfer-bench-${Date.now()}`;
const results = [];
const samples = [];
const logs = [];
try {
  const pages = [];
  for (const label of ['sender', 'receiver']) {
    const context = await browser.newContext();
    if (label === 'receiver') await context.route('**/js/iroh-worker.js', async route => {
      const response = await route.fetch();
      const original = await response.text();
      const target = "await writable.write({ type: 'write', position: seq * CHUNK, data: bytes });";
      assert.ok(original.includes(target), 'Worker write instrumentation target missing');
      const write = sink === 'opfs' ? target : '';
      const replacement = `const started = performance.now(); ${write} (globalThis.benchWrites ||= []).push({ seq, at: performance.now(), duration: performance.now() - started });`;
      await route.fulfill({ response, body: original.replace(target, replacement) });
    });
    const page = await context.newPage();
    page.on('console', event => logs.push({ label, at: Date.now(), text: event.text() }));
    page.on('pageerror', error => logs.push({ label, at: Date.now(), error: error.message }));
    await page.goto(`${process.env.E2E_SITE || 'http://127.0.0.1:8099'}/?autostart=1&room=${room}`);
    await page.waitForFunction(room => window.__state?.().joined === room, room, { timeout: 120000 });
    await page.evaluate(() => { window.__iroh_useOpfs = true; });
    pages.push(page);
  }
  const [sender, receiver] = pages;
  for (const sizeMiB of sizes) {
    const size = sizeMiB * 1048576;
    const name = `bench-${size}.bin`;
    const meta = await sender.evaluate(async ({ size, name, room }) => {
      const data = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += 16384) data.fill((offset / 16384) & 255, offset, Math.min(size, offset + 16384));
      return window.__iroh_sendFile(new File([data], name), room);
    }, { size, name, room });
    await receiver.waitForFunction(fileId => ['invited', 'archived'].includes(window.__iroh_transfers().find(entry => entry.file_id === fileId)?.state), meta.file_id, { timeout: 60000 });
    await receiver.evaluate(async fileId => {
      if (window.__iroh_transfers().find(entry => entry.file_id === fileId)?.state === 'archived') await window.__iroh_openArchived(fileId);
    }, meta.file_id);
    await receiver.waitForFunction(fileId => window.__iroh_transfers().find(entry => entry.file_id === fileId)?.state === 'invited', meta.file_id, { timeout: 60000 });
    for (const worker of receiver.workers()) await worker.evaluate(() => { globalThis.benchWrites = []; });
    const started = Date.now();
    let progressed = started;
    let lastDone = -1;
    await receiver.evaluate(fileId => { window.__iroh_acceptFile(fileId); }, meta.file_id);
    let received;
    while (Date.now() - started < 240000) {
      await new Promise(resolve => setTimeout(resolve, 300));
      received = await receiver.evaluate(fileId => window.__iroh_transfers().find(entry => entry.file_id === fileId), meta.file_id);
      const sent = await sender.evaluate(fileId => window.__iroh_transfers().find(entry => entry.file_id === fileId), meta.file_id);
      samples.push({ sizeMiB, elapsed: (Date.now() - started) / 1000, received, sent });
      assert.ok(received, 'Receiver transfer missing');
      if (received.done > lastDone) { lastDone = received.done; progressed = Date.now(); }
      if (received.state === 'done') break;
      assert.equal(received.state, 'active', JSON.stringify(received));
      assert.ok(Date.now() - progressed < 45000, 'Receiver made no progress for 45 seconds');
    }
    assert.equal(received.state, 'done', 'Transfer exceeded four minutes');
    const elapsed = (Date.now() - started) / 1000;
    await sender.waitForFunction(fileId => window.__iroh_transfers().find(entry => entry.file_id === fileId)?.peersDone === 1, meta.file_id, { timeout: 45000 });
    const verified = sink === 'opfs' ? await receiver.evaluate(({ name, size }) => window.__iroh_verifyOpfs(name, size, 16384), { name, size }) : null;
    if (verified) assert.ok(verified.ok, JSON.stringify(verified));
    const writes = [];
    for (const worker of receiver.workers()) writes.push(...await worker.evaluate(() => globalThis.benchWrites || []));
    const result = { sizeMiB, elapsed, KiBps: size / 1024 / elapsed, sink, verified, writes };
    results.push(result);
    console.log(JSON.stringify({ ...result, writes: writes.length }));
    assert.ok(result.KiBps >= minimum, `Throughput ${result.KiBps.toFixed(1)} KiB/s below ${minimum} KiB/s`);
  }
  console.log(sink === 'noop' ? 'PASS diagnostic only: no file delivery verified' : `PASS=${results.length} byte-verified deliveries`);
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ results, samples, logs }, null, 2));
  await browser.close();
}
