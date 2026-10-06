#!/usr/bin/env node
/* ============================================================================
 * scripts/smoke.mjs · 前端冒烟：页面 JS 有没有挂
 *
 * ## 为什么需要它
 *
 * 改前端模块时，一个未定义的引用就会让**整个 main.js 挂掉**，
 * 表现是 `window.__state` 为 undefined、页面停在"启动中"。
 * 这时跑 e2e 得到的全是 `TimeoutError: 等待超时` —— 每个用例都崩，
 * 但**崩溃信息完全指不到真正的错**（实测踩过：`test-hooks.js` 里一个
 * 悬空的 `openRoomFn`，26 个用例全 CRASH，跑了 21 分钟才发现）。
 *
 * 所以：改完前端先跑这个（~6 秒），钩子在、console 干净，再去跑 e2e。
 *
 * 用法：
 *   node scripts/smoke.mjs[端口，默认 8099]
 * 前置：dev-serve.py + 带 CDP 的 Chrome（9222）
 * ==========================================================================*/

const PORT = process.argv[2] || '8099';
const CDP = 'http://127.0.0.1:9222';
const KEY = 'a'.repeat(64);

/** 至少要有这些钩子，缺一个e2e 就一定崩 */
const REQUIRED = ['__state', '__iroh_net', '__iroh_openRoom', '__iroh_sendText', '__iroh_theme'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打开一个标签并返回 { id, ws } */
async function openPage(url) {
  const created = await (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const target = targets.find((t) => t.id === created.id);
  if (!target) throw new Error('标签没出现在 /json/list 里');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket 连不上'));
  });
  return { id: created.id, ws };
}

async function main() {
  const url = `http://127.0.0.1:${PORT}/?autostart=1&room=smoke-room&key=${KEY}&testid=1`;
  const { id, ws } = await openPage(url);

  let seq = 0;
  const pending = new Map();
  const errors = [];
  const warns = [];

  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++seq;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(`${d.exception?.description || d.text}`);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (m.params.type === 'error') errors.push(text);
      else if (m.params.type === 'warning') warns.push(text);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push(m.params.entry.text);
    }
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  // 等 wasm 起来（节点就绪后钩子才装得上）
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500);
    const r = await send('Runtime.evaluate', {
      expression: 'typeof window.__state',
      returnByValue: true,
    });
    ready = r.result?.value === 'function';
  }

  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hooks: Object.keys(window).filter(k => k.startsWith('__')),
      node: document.querySelector('#node-pill .pill__text')?.textContent,
      phase: window.__iroh_net?.phase ?? null,
      joined: window.__state ? window.__state().joined : null,
    })`,
    returnByValue: true,
  });

  let info = {};
  try {
    info = JSON.parse(probe.result?.value || '{}');
  } catch {
    /* 页面还没到能求值的程度 */
  }

  await fetch(`${CDP}/json/close/${id}`);
  ws.close();

  /* ---- 判定 ---- */
  const missing = REQUIRED.filter((h) => !info.hooks?.includes(h));

  console.log('钩子：', info.hooks?.length ?? 0, '个');
  console.log('节点：', info.node, '| phase：', info.phase, '| joined：', info.joined);
  if (errors.length) {
    console.log('\n❌ 页面错误：');
    for (const e of errors) console.log('  ' + e.split('\n').slice(0, 4).join('\n  '));
  }
  if (warns.length) {
    console.log(`\n⚠️  警告 ${warns.length} 条（不阻塞）`);
  }
  if (!ready || missing.length) {
    console.log('\n❌ 冒烟失败：钩子没装上 —— main.js 很可能抛异常了（见上面的错误）');
    process.exit(1);
  }
  if (errors.length) {
    console.log('\n❌ 冒烟失败：有页面错误');
    process.exit(1);
  }
  console.log('\n✅ 冒烟通过：钩子齐全、无页面错误。可以跑 e2e 了。');
  process.exit(0);
}

main().catch((e) => {
  console.error('冒烟脚本本身失败：', e.message);
  process.exit(2);
});