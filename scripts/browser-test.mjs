#!/usr/bin/env node
/**
 * 无头浏览器验证脚本（零依赖，用 Node 内置 WebSocket 直连 Chrome DevTools Protocol）
 *
 * 干什么：打开前端页面（?autostart=1），等 wasm 端点连上自建中继，
 * 把页面上的「中继状态 / 本机 ID / 控制台日志」抓回来。
 *
 * 用法：
 *   node scripts/browser-test.mjs [页面 URL] [等待秒数]
 * 前置：
 *   1) 前端目录起了静态服务（默认 http://127.0.0.1:8099/）
 *   2) Chrome 带 --remote-debugging-port=9222 启动，并且打开了目标页面
 */

const PAGE_URL = process.argv[2] ?? 'http://127.0.0.1:8099/';
const WAIT_SECONDS = Number(process.argv[3] ?? 25);
const CDP = 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  return list.find((t) => t.type === 'page');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('CDP 连接失败: ' + (e.message ?? e)));
  });
}

function rpc(ws, id, method, params = {}) {
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        resolve(msg.result ?? msg.error);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const logs = [];

async function main() {
  const target = await findPageTarget();
  if (!target) throw new Error('Chrome 里没有页面 target');
  const ws = await connect(target.webSocketDebuggerUrl);

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push(`[${msg.params.type}] ${text}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${msg.params.exceptionDetails?.text} ${msg.params.exceptionDetails?.exception?.description ?? ''}`);
    }
  });

  let id = 1;
  await rpc(ws, id++, 'Runtime.enable');
  await rpc(ws, id++, 'Page.enable');
  await rpc(ws, id++, 'Page.navigate', { url: PAGE_URL });

  // 轮询页面状态直到节点在线或超时
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let state = '';
  while (Date.now() < deadline) {
    await sleep(1000);
    const res = await rpc(ws, id++, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        node: document.getElementById('node-state')?.textContent,
        myId: document.getElementById('my-id')?.textContent,
        probe: document.getElementById('probe-state')?.textContent,
        status: document.getElementById('status-rows')?.innerText,
        relayRows: document.getElementById('relay-rows')?.innerText,
        log: document.getElementById('log')?.innerText
      })`,
      returnByValue: true,
    });
    try {
      const parsed = JSON.parse(res.result.value);
      state = parsed.node;
      if (parsed.node === '在线' || parsed.node === '失败') {
        report(parsed);
        await rpc(ws, id++, 'Browser.close').catch(() => {});
        return;
      }
    } catch {
      /* 页面还没加载完 */
    }
  }

  // 超时：把当前 DOM 抓回来看看卡在哪
  const res = await rpc(ws, id++, 'Runtime.evaluate', {
    expression: `JSON.stringify({
      node: document.getElementById('node-state')?.textContent,
      myId: document.getElementById('my-id')?.textContent,
      probe: document.getElementById('probe-state')?.textContent,
      status: document.getElementById('status-rows')?.innerText,
      relayRows: document.getElementById('relay-rows')?.innerText,
      log: document.getElementById('log')?.innerText
    })`,
    returnByValue: true,
  });
  console.log(`\n!! 超时（${WAIT_SECONDS}s 内未上线，最后状态：${state || '未知'}）`);
  report(JSON.parse(res.result.value));
  await rpc(ws, id++, 'Browser.close').catch(() => {});
}

function report(p) {
  console.log('=========== 页面状态 ===========');
  console.log('节点状态 :', p.node);
  console.log('本机 ID  :', p.myId);
  console.log('探测状态 :', p.probe);
  console.log('--- 中继探测 ---\n' + (p.relayRows ?? '').trim());
  console.log('--- 中继连接状态 ---\n' + (p.status ?? '').trim());
  console.log('--- 页面日志 ---\n' + (p.log ?? '').trim());
  console.log('=========== 浏览器控制台 ===========');
  console.log(logs.slice(-40).join('\n') || '(无)');
}

main().catch((e) => {
  console.error('测试失败:', e.message);
  process.exit(1);
});
