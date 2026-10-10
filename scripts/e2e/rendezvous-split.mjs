/* ============================================================================
 * 阶段 B′ 回归：**入口（rendezvous）与历史（history）是两个独立能力**。
 *
 * 手法：把 `history` 指向一个**合法但不存在**的节点，`rendezvous` 指向真 roomd，
 *      并把兼容字段 `anchor` 整个去掉。
 *
 * 断言（每一条都对应拆分里的一个性质）：
 *   ① 仍然进得了房 —— 而且是**通过入口**连上了人（不是孤立进房）。
 *      这一条同时证明"入口这条路真的被用上了"：anchor 去掉后，若客户端没用
 *      rendezvous 当候选，就一个人都连不上 → 界面会显示"暂时联系不上其他人"。
 *   ② 两个人能互发消息 —— 历史提供者**挂着**也不影响房间里的实时通信。
 *   ③ 没有"连不上别人"的孤立提示。
 *
 * 反例价值：如果哪天有人把两个角色又合成一个（或 rendezvous 被忽略），
 * 去掉 anchor 后 ① 立刻失败。
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const configPath = new URL('../../frontend/relay-config.json', import.meta.url);
const original = await readFile(configPath);
const config = JSON.parse(original);
assert.ok(config.rendezvous?.id, 'relay-config.json 里应当有 rendezvous 段');
const site = process.env.E2E_SITE || 'http://127.0.0.1:8099';

/** 合法但无人持有的 EndpointId（历史提供者"挂了"） */
const DEAD_HISTORY = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
});

let passed = 0;
const check = (name, ok, detail) => {
  assert.ok(ok, `${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  passed += 1;
  console.log(`PASS ${name}`);
};

try {
  // ⚠️ 两个用户必须用**独立 context**（各自身份）——
  //    同一个 context 是同一个身份，两条客户端会互相认为"这是我发的"，
  //    消息永远送不到对面（实测踩过）。
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const intercept = (context) =>
    context.route('**/relay-config.json', (route) =>
      route.fulfill({
        json: {
          ...config,
          // ⚠️ 故意把兼容字段去掉：这样"能不能连上人"就**只**取决于 rendezvous
          anchor: null,
          rendezvous: config.rendezvous,
          history: { id: DEAD_HISTORY, relay: config.rendezvous.relay },
        },
      }),
    );
  try {
    await intercept(contextA);
    await intercept(contextB);
    const room = `split-${Date.now()}`;
    const a = await contextA.newPage();
    await a.goto(`${site}/?autostart=1&room=${room}`);
    await a.waitForFunction(() => window.__state?.().joined, undefined, { timeout: 90000 });

    // ① 入口可用：连上了人（没退化成孤立）—— anchor 已被去掉，只能靠 rendezvous
    await a.waitForTimeout(6000);
    const note = await a.locator('.tl-note--live').textContent().catch(() => '');
    check('去掉 anchor 后仍能通过入口进房（未孤立）', !note.includes('暂时联系不上'), note);
    check('输入框可用', await a.evaluate(() => window.__state().composerEnabled));

    // ② 第二个人进来 + 互发消息（历史提供者挂着也不影响实时通信）
    const b = await contextB.newPage();
    await b.goto(`${site}/?autostart=1&room=${room}`);
    await b.waitForFunction(() => window.__state?.().joined, undefined, { timeout: 90000 });
    const text = `split-msg-${Date.now()}`;
    await a.locator('#input').fill(text);
    await a.locator('#send').click();
    await b
      .locator('.msg')
      .filter({ has: b.locator('.bubble').filter({ hasText: text }) })
      .first()
      .waitFor({ timeout: 45000 });
    check('历史提供者挂着时，实时消息照样送达', true);

    // ③ 双方都不该出现孤立提示
    const noteA = await a.locator('.tl-note--live').textContent().catch(() => '');
    const noteB = await b.locator('.tl-note--live').textContent().catch(() => '');
    check('发送端没有孤立提示', !noteA.includes('暂时联系不上'), noteA);
    check('接收端没有孤立提示', !noteB.includes('暂时联系不上'), noteB);
  } finally {
    await contextA.close();
    await contextB.close();
  }

  check('测试不修改磁盘上的 relay 配置', original.equals(await readFile(configPath)));
  console.log(`总计 PASS=${passed} FAIL=0`);
} finally {
  await browser.close();
}
