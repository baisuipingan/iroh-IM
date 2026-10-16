import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireProcessLock } from '../agent-pi/src/room/process-lock.ts';

test('同一身份目录只允许一个 room-bridge，释放后可重新获取', () => {
  const home = mkdtempSync(join(tmpdir(), 'room-bridge-lock-'));
  const first = acquireProcessLock(home);
  assert.throws(() => acquireProcessLock(home), /已有 room-bridge 在运行/);
  first.release();

  const second = acquireProcessLock(home);
  assert.ok(second.path.endsWith('.room-bridge.lock'));
  second.release();
});

test('损坏或遗留的锁文件不会永久阻塞启动', () => {
  const home = mkdtempSync(join(tmpdir(), 'room-bridge-stale-lock-'));
  writeFileSync(join(home, '.room-bridge.lock'), '{not-json');
  const lock = acquireProcessLock(home);
  lock.release();
});
