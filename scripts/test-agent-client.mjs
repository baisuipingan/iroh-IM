/* ============================================================================
 * agent-pi · AgentClient 稳定性回归（退出速度 + 连接看门狗）
 *
 * 两个真实踩到的坑：
 *   1. Ctrl-C 会发给整个**进程组**，`iroh-agent serve` 常常比适配器先退；旧
 *      `stop()` 还在等一个永远不会再触发的 close 事件 → 白等 5s+SIGKILL+2s，
 *      退出要 ~7 秒（用户："这个后台怎么退出这么慢"）。
 *   2. 笔记本睡一晚后 gossip/中继连接没恢复：**进程活着、ping 也通**（那只是同一
 *      进程的 stdin/stdout），但再也收不到任何房间消息（用户："打开它好像不行了"）→
 *      新增"连接看门狗"：进房后长时间没有事件就重启 serve 重连。
 *
 * 用法：node --experimental-strip-types --test scripts/test-agent-client.mjs
 *      （已并入根 package.json 的 npm test）
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentClient } from '../agent-pi/src/room/client.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_SRC = `
const fs = require('node:fs');
const mode = process.env.FAKE_MODE ?? 'stay';
const countPath = process.env.FAKE_COUNT_FILE;
const priorStarts = countPath && fs.existsSync(countPath)
  ? fs.readFileSync(countPath, 'utf8').trim().split('\\n').filter(Boolean).length
  : 0;
if (countPath) fs.appendFileSync(countPath, mode + '\\n');
const eventPath = process.env.FAKE_EVENT_FILE;
let active = 0;
if (eventPath) {
  const statePath = eventPath + '.active';
  active = Number(fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : 0) + 1;
  fs.writeFileSync(statePath, String(active));
  fs.appendFileSync(eventPath, '+' + active + '\\n');
  process.on('exit', () => {
    const current = Number(fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : 1);
    fs.writeFileSync(statePath, String(Math.max(0, current - 1)));
    fs.appendFileSync(eventPath, '-' + Math.max(0, current - 1) + '\\n');
  });
}
const hello = { v: 1, type: 'hello', agent: 'fake/1', endpointId: 'c'.repeat(64),
                chatProtocol: 'v6', nickname: 't', relay: null };
if (mode !== 'restart-race' || priorStarts === 0) process.stdout.write(JSON.stringify(hello) + '\\n');
if (mode === 'die') setTimeout(() => process.exit(0), 300);
if (mode === 'restart-race') setTimeout(() => process.exit(0), priorStarts === 0 ? 120 : 80);
if (mode === 'restart-after-hello') setTimeout(() => process.exit(0), 80);
const ev = (seq, event) => process.stdout.write(JSON.stringify({ v: 1, type: 'event', seq, event }) + '\\n');
if (mode === 'quiet' || mode === 'healthy' || mode === 'relay-spam' || mode === 'relay-dead') {
  setTimeout(() => ev(1, { type: 'joined', room: 'r' }), 20);
  setTimeout(() => ev(2, { type: 'presence', room: 'r', peers: [] }), 40);
}
if (mode === 'healthy') {
  let n = 3;
  setInterval(() => ev(n++, { type: 'presence', room: 'r', peers: [] }), 100);
}
if (mode === 'relay-spam' || mode === 'relay-dead') {
  // 复刻真实场景：家庭中继在 iroh1/2/3 之间横跳，relayStatus 几秒一条 —— 但它
  // **不证明房间连通**；旧版把任何事件都当心跳，于是看门狗被骗过。
  let n = 3;
  setInterval(() => ev(n++, { type: 'relayStatus', relays: [{ url: 'https://r.example:15443', connected: mode !== 'relay-dead' }] }), 100);
}
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.cmd === 'shutdown') {
    process.stdout.write(JSON.stringify({ v: 1, id: m.id, ok: true, type: 'reply', value: {} }) + '\\n');
    setTimeout(() => process.exit(0), 30);
  }
});
`;

function makeClient(mode, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agent-'));
  const fake = join(dir, 'fake-agent.cjs');
  writeFileSync(fake, FAKE_SRC);
  // AgentClient 会拼 `serve` + args 作为 argv；用一层 shell 包装忽略掉
  const wrapper = join(dir, 'fake-agent');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${fake}\n`);
  chmodSync(wrapper, 0o755);
  const env = { FAKE_MODE: mode };
  if (opts.countFile) env.FAKE_COUNT_FILE = opts.countFile;
  if (opts.eventFile) env.FAKE_EVENT_FILE = opts.eventFile;
  return new AgentClient({
    bin: wrapper,
    pingIntervalMs: 0,
    restartBackoffMs: [60_000], // 默认测试窗口内不要自动重启
    log: () => {},
    ...opts,
    env,
  });
}

const startsOf = (countFile) =>
  readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean).length;

/* ------------------------------------------------------------ 退出速度 */

test('正常退出：发 shutdown → 子进程退出 → stop() 快速返回', async () => {
  const client = makeClient('stay');
  await client.start();
  const t0 = Date.now();
  await client.stop();
  const dt = Date.now() - t0;
  assert.ok(dt < 1500, `stop() 应当快（实际 ${dt}ms）`);
});

test('子进程先退出（Ctrl-C 进程组场景）：stop() 不再白等 5s+2s', async () => {
  const client = makeClient('die');
  await client.start();
  await once(client, 'exit'); // 子进程自己退了（模拟 Ctrl-C 打到整个进程组）
  const t0 = Date.now();
  await client.stop();
  const dt = Date.now() - t0;
  assert.ok(dt < 1000, `子进程已退出时 stop() 应立刻返回（实际 ${dt}ms；旧代码 ~7000ms）`);
});

/* -------------------------------------------------------- 连接看门狗 */

test('连接看门狗：进房后长时间没有事件 → 重启 serve 重连（睡一晚失联场景）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stale-'));
  const count = join(dir, 'count.txt');
  const logs = [];
  const client = makeClient('quiet', {
    countFile: count,
    staleRestartMs: 400,
    restartBackoffMs: [200],
    log: (l) => logs.push(l),
  });
  await client.start();
  await sleep(3000);
  assert.ok(startsOf(count) >= 3, `重启成功后看门狗仍应继续工作（实际启动 ${startsOf(count)} 次）`);
  assert.ok(
    logs.some((l) => l.includes('强制重启 agent 进程重连')),
    `应有明确的"重启"日志：${logs.join(' | ')}`,
  );
  await client.stop();
});

test('并发 start 只允许一个 serve 子进程，避免同一身份互相顶掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'single-start-'));
  const count = join(dir, 'count.txt');
  const client = makeClient('stay', { countFile: count });
  const first = client.start();
  await assert.rejects(client.start(), /已有 agent 子进程在运行/);
  await first;
  assert.equal(startsOf(count), 1, '并发 start 不能留下第二个 serve');
  await client.stop();
});

test('重启子进程在握手前崩溃：不会因旧 hello 状态启动第二条重启循环', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-race-'));
  const count = join(dir, 'count.txt');
  const events = join(dir, 'events.txt');
  const client = makeClient('restart-race', {
    countFile: count,
    eventFile: events,
    restartBackoffMs: [100],
  });
  await client.start();
  await once(client, 'exit');
  await sleep(1200);
  await client.stop();

  const lifecycle = readFileSync(events, 'utf8').trim().split('\\n').filter(Boolean);
  let current = 0;
  let maxConcurrent = 0;
  for (const entry of lifecycle) {
    current += entry.startsWith('+') ? 1 : -1;
    maxConcurrent = Math.max(maxConcurrent, current);
  }
  assert.ok(startsOf(count) >= 3, `应当持续串行重试（实际启动 ${startsOf(count)} 次）`);
  assert.equal(maxConcurrent, 1, `同一时刻只能有一个 serve：${lifecycle.join(',')}`);
});

test('重启子进程刚握手就退出：不会吞掉下一轮重启', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-after-hello-'));
  const count = join(dir, 'count.txt');
  const events = join(dir, 'events.txt');
  const client = makeClient('restart-after-hello', {
    countFile: count,
    eventFile: events,
    restartBackoffMs: [100],
  });
  await client.start();
  await sleep(900);
  await client.stop();

  const lifecycle = readFileSync(events, 'utf8').trim().split('\n').filter(Boolean);
  let current = 0;
  let maxConcurrent = 0;
  for (const entry of lifecycle) {
    current += entry.startsWith('+') ? 1 : -1;
    maxConcurrent = Math.max(maxConcurrent, current);
  }
  assert.ok(startsOf(count) >= 3, `应当继续重启（实际启动 ${startsOf(count)} 次）`);
  assert.equal(maxConcurrent, 1, `同一时刻只能有一个 serve：${lifecycle.join(',')}`);
});

test('连接看门狗：relayStatus 刷屏 ≠ 连通（中继横跳骗过看门狗的那次）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relayspam-'));
  const count = join(dir, 'count.txt');
  const logs = [];
  const client = makeClient('relay-spam', {
    countFile: count,
    staleRestartMs: 400,
    restartBackoffMs: [200],
    log: (l) => logs.push(l),
  });
  await client.start();
  await sleep(3000);
  assert.ok(
    startsOf(count) >= 2,
    `relayStatus 刷屏也应当判定失联并重启（实际启动 ${startsOf(count)} 次）`,
  );
  assert.ok(
    logs.some((l) => l.includes('强制重启 agent 进程重连') && l.includes('relayStatus')),
    `日志应说明中继事件不算数：${logs.join(' | ')}`,
  );
  await client.stop();
});

test('连接看门狗：中继全断（硬证据）→ 不到 staleMs 也提前重启', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relaydead-'));
  const count = join(dir, 'count.txt');
  const client = makeClient('relay-dead', {
    countFile: count,
    staleRestartMs: 6000, // 主阈值 6s；中继全断的早退阈值 = max(5s, 3s) = 5s
    restartBackoffMs: [200],
  });
  await client.start();
  await sleep(9000);
  assert.ok(startsOf(count) >= 2, `中继全断应触发重启（实际启动 ${startsOf(count)} 次）`);
  await client.stop();
});

test('连接看门狗：事件持续正常 → 不误杀', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'healthy-'));
  const count = join(dir, 'count.txt');
  const client = makeClient('healthy', {
    countFile: count,
    staleRestartMs: 400,
    restartBackoffMs: [200],
  });
  await client.start();
  await sleep(2500);
  assert.equal(startsOf(count), 1, '事件不断流就不该重启');
  await client.stop();
});
