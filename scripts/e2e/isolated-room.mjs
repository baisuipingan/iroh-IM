/* ============================================================================
 * 孤立进房回归：常驻节点联系不上时，**不该**把人挡在房外。
 *
 * 旧行为（本次重构前的回归目标）：`join` 重试 4×20 秒后失败，
 * 界面停在「进房间失败：连接常驻节点超时」——
 * 于是 roomd 一挂，整个房间的人都进不去，哪怕彼此都在线、中继也好好的。
 *
 * 现在要求：
 *   ① 常驻节点不可达时**进房成功**、输入框可用（消息会排队等邻居）
 *   ② 如实提示"暂时联系不上其他人"，而不是让人以为房间本来就没人
 *   ③ 不能说成"进房间失败"
 *   ④ 对照组：常驻节点可达时，不该出现孤立提示
 *
 * 手法：拦截 `relay-config.json` 把 anchor.id 换成合法但**不存在**的 id
 *      —— 只改这一个 context 的响应，不碰磁盘上的配置文件（与 relay-enabled.mjs 同款）。
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const configPath = new URL('../../frontend/relay-config.json', import.meta.url);
const original = await readFile(configPath);
const config = JSON.parse(original);
assert.ok(config.anchor?.id, 'relay-config.json 里应当配了 anchor.id');
const site = process.env.E2E_SITE || 'http://127.0.0.1:8099';

/**
 * 一个**格式合法但没人应答**的 EndpointId。
 *
 * ⚠️ 不能随便凑 64 位 hex：`EndpointId` 是 ed25519 公钥，
 *    Rust 侧解析时会校验它是不是合法的曲线点 —— 随手写 `'ab'.repeat(32)`
 *    会直接让**节点启动**失败（"anchor id 解析失败"），
 *    那就不是在测"进房降级"了（实测踩过这个）。
 *    所以这里真生成一对密钥，只用公钥：格式一定合法，而私钥没人持有。
 */
const DEAD_ANCHOR = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
});

let passed = 0;
const check = (name, condition, detail) => {
  assert.ok(condition, `${name}${detail ? `: ${JSON.stringify(detail)}` : ''}`);
  passed += 1;
  console.log(`PASS ${name}`);
};

const liveNote = (page) => page.locator('.tl-note--live').textContent().catch(() => '');

try {
  /* ---------------------------------------------------------------- 孤立 */
  {
    const context = await browser.newContext();
    try {
      await context.route('**/relay-config.json', (route) =>
        route.fulfill({
          json: {
            ...config,
            // ⚠️ 三个角色**都要**指向死节点：阶段 B′ 之后客户端优先用 `rendezvous`，
            //    只把 `anchor` 换掉的话它仍然连得上（那是拆分生效的表现，
            //    但测不到"谁都不在"这条路径 —— 实测就是这么发现的）。
            anchor: { ...config.anchor, id: DEAD_ANCHOR },
            rendezvous: config.rendezvous ? { ...config.rendezvous, id: DEAD_ANCHOR } : null,
            history: config.history ? { ...config.history, id: DEAD_ANCHOR } : null,
          },
        }),
      );
      const page = await context.newPage();
      const room = `isolated-${Date.now()}`;
      await page.goto(`${site}/?autostart=1&room=${room}`);

      // ① 必须进房成功。旧行为在这里永远等不到（会一直停在"进房间失败"）
      await page.waitForFunction(() => window.__state?.().joined, undefined, { timeout: 90000 });
      const state = await page.evaluate(() => ({
        joined: window.__state().joined,
        composerEnabled: window.__state().composerEnabled,
        canSend: window.__state().canSend,
      }));
      check('常驻节点不可达时仍然进房成功', state.joined === room, state);
      check('输入框保持可用（消息会排队等邻居，不是失败）', state.composerEnabled === true, state);

      // ② 如实说明孤立，而不是留一句"已进入"让人以为一切正常
      await page.waitForFunction(
        () => document.querySelector('.tl-note--live')?.textContent?.includes('暂时联系不上'),
        undefined,
        { timeout: 20000 },
      );
      const note = await liveNote(page);
      check('提示"暂时联系不上其他人"', note.includes('暂时联系不上'), note);
      // ③ 措辞不能是故障
      check('没有说成"进房间失败"', !note.includes('进房间失败'), note);

      // ④ 消息仍然发得出去（排进 gossip 队列）：本地回显应当立刻出现
      await page.locator('#input').fill('孤立时发的消息');
      await page.locator('#send').click();
      await page
        .locator('.msg')
        .filter({ has: page.locator('.bubble').filter({ hasText: '孤立时发的消息' }) })
        .first()
        .waitFor({ timeout: 15000 });
      check('孤立时仍能发出消息（本地回显）', true);
    } finally {
      await context.close();
    }
  }

  /* ---------------------------------------------------------------- 对照 */
  {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const room = `reachable-${Date.now()}`;
      await page.goto(`${site}/?autostart=1&room=${room}`);
      await page.waitForFunction(() => window.__state?.().joined, undefined, { timeout: 90000 });
      // 给孤立事件留出到达窗口（它会在 join 期间/之后立刻发）
      await page.waitForTimeout(4000);
      const note = await liveNote(page);
      check('常驻节点可达时不出现孤立提示', !note.includes('暂时联系不上'), note);
    } finally {
      await context.close();
    }
  }

  check('测试不修改磁盘上的 relay 配置', original.equals(await readFile(configPath)));
  console.log(`总计 PASS=${passed} FAIL=0`);
} finally {
  await browser.close();
}
