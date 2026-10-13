/* ============================================================================
 * agent-pi · AgentClient 退出速度回归
 *
 * 真实踩到的问题：Ctrl-C 会发给整个**进程组**，`iroh-agent serve` 常常比适配器先退；
 * 旧 `stop()` 在这种情况下还会 `once(child,'close')` —— 事件早就放过了，于是白等
 * 满 5s、再 SIGKILL、再等 2s，退出要 ~7 秒（用户："这个后台怎么退出这么慢"）。
 *
 * 用法：node --experimental-strip-types --test scripts/test-agent-client.mjs
 *      （已并入根 package.json 的 npm test）
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentClient } from '../agent-pi/src/room/client.ts';

const FAKE_SRC = `
const mode = process.env.FAKE_MODE ?? 'stay';
const hello = { v: 1, type: 'hello', agent: 'fake/1', endpointId: 'c'.repeat(64),
                chatProtocol: 'v6', nickname: 't', relay: null };
process.stdout.write(JSON.stringify(hello) + '\\n');
if (mode === 'die') setTimeout(() => process.exit(0), 300);
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.cmd === 'shutdown') {
    process.stdout.write(JSON.stringify({ v: 1, id: m.id, ok: true, type: 'reply', value: {} }) + '\\n');
    setTimeout(() => process.exit(0), 30);
  }
});
`;

function makeClient(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agent-'));
  const fake = join(dir, 'fake-agent.cjs');
  writeFileSync(fake, FAKE_SRC);
  // AgentClient 会拼 `serve` + args 作为 argv；用一层 shell 包装忽略掉
  const wrapper = join(dir, 'fake-agent');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${fake}\n`);
  chmodSync(wrapper, 0o755);
  return new AgentClient({
    bin: wrapper,
    env: { FAKE_MODE: mode },
    pingIntervalMs: 0,
    restartBackoffMs: [60_000], // 测试窗口内不要自动重启
    log: () => {},
  });
}

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
