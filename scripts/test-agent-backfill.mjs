/* ============================================================================
 * agent-pi · 进房补投回归（attachJoinBackfill）
 *
 * 场景（2026-10-15 用户实测）：重启 room-bridge 的那几秒里用户在房间里 @ 它，
 * 消息进了历史，但适配器是之后才进房的 —— gossip 不补历史，这条 @ 永远丢失，
 * 用户看到的是"@ 了等了半天没反应"。
 *
 * 补投规则（全都锁在这里，改规则先改测试）：
 *   1. 每次 `joined` 拉一页历史，只补「窗口内 + 没见过 + 不是我发的」；
 *   2. 按 ts 升序、以与实时消息完全相同的事件形状重放；
 *   3. 去重是**持久化**的（<stateDir>/room-seen.json）—— 进程重启也不重复回复；
 *   4. 窗口外的旧消息不补（不翻旧账），但同样记进"见过"；
 *   5. ageMs=0 整个关掉；history 失败只记日志，绝不抛。
 *
 * 用法：node --experimental-strip-types --test scripts/test-agent-backfill.mjs
 *      （已并入根 package.json 的 npm test）
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attachJoinBackfill } from '../agent-pi/src/room/backfill.ts';

const NOW = 1_760_000_000_000; // 固定"现在"，用例不依赖真实时钟
const ME = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 等补投的异步链（history await + emit）走完 */
const settle = () => sleep(20);

let seq = 0;
function msg(over = {}) {
  seq += 1;
  return {
    id: over.id ?? `id-${seq}`,
    from: over.from ?? OTHER,
    nickname: over.nickname ?? '用户A',
    text: over.text ?? '你好',
    ts: over.ts ?? NOW,
    sig: '',
    file: null,
    ...(over.mentions ? { mentions: over.mentions } : {}),
  };
}

class FakeClient extends EventEmitter {
  constructor({ messages = [], endpointId = ME, failHistory = false } = {}) {
    super();
    this.hello = {
      v: 1,
      type: 'hello',
      agent: 'fake/1',
      endpointId,
      chatProtocol: 'v6',
      nickname: '我',
      relay: null,
    };
    this.messages = messages;
    this.failHistory = failHistory;
    this.historyCalls = 0;
  }

  async history(limit) {
    this.historyCalls += 1;
    if (this.failHistory) throw new Error('history boom');
    return { room: 'r', messages: this.messages.slice(0, limit) };
  }
}

function newStateDir() {
  return mkdtempSync(join(tmpdir(), 'iroh-backfill-'));
}

function collectEvents(client) {
  const got = [];
  client.on('event', (ev) => {
    if (ev.type === 'message') got.push(ev);
  });
  return got;
}

test('进房补投：窗口内、别人发的会按 ts 升序重放（mine=false，原样 message）', async () => {
  const a = msg({ id: 'a', ts: NOW - 60_000, text: '@我 晚点回你' });
  const b = msg({ id: 'b', ts: NOW - 90_000, text: '@我 更早的一条' });
  const client = new FakeClient({ messages: [b, a] }); // 历史乱序：先新后旧
  const seen = collectEvents(client);
  const detach = attachJoinBackfill(client, { stateDir: newStateDir(), now: () => NOW, log: () => {} });
  client.emit('event', { type: 'joined', room: 'r' });
  await settle();
  detach();

  assert.equal(seen.length, 2, '两条窗口内消息都应补投');
  assert.deepEqual(seen.map((ev) => ev.message.id), ['b', 'a'], '按 ts 升序重放');
  assert.equal(seen[0].room, 'r');
  assert.equal(seen[0].mine, false, '形状必须与实时事件一致（mine=false）');
  assert.deepEqual(seen[0].message, b, 'message 原样透传');
});

test('窗口外的旧消息不补投（但记进见过，下一轮 joined 也不补）', async () => {
  const old = msg({ id: 'old', ts: NOW - 10 * 60_000 });
  const fresh = msg({ id: 'fresh', ts: NOW - 5_000 });
  const client = new FakeClient({ messages: [old, fresh] });
  const seen = collectEvents(client);
  const dir = newStateDir();
  const detach = attachJoinBackfill(client, { stateDir: dir, now: () => NOW, log: () => {} });
  client.emit('event', { type: 'joined', room: 'r' });
  await settle();
  client.emit('event', { type: 'joined', room: 'r' });
  await settle();
  detach();

  assert.deepEqual(seen.map((ev) => ev.message.id), ['fresh']);
});

test('自己发的消息不补投', async () => {
  const mine = msg({ id: 'mine', from: ME, ts: NOW - 5_000 });
  const theirs = msg({ id: 'theirs', ts: NOW - 5_000 });
  const client = new FakeClient({ messages: [mine, theirs] });
  const seen = collectEvents(client);
  const detach = attachJoinBackfill(client, { stateDir: newStateDir(), now: () => NOW, log: () => {} });
  client.emit('event', { type: 'joined', room: 'r' });
  await settle();
  detach();
  assert.deepEqual(seen.map((ev) => ev.message.id), ['theirs']);
});

test('去重持久化：预置 room-seen.json 的 id 在"重启"后的新进程里不再补投', async () => {
  const dir = newStateDir();
  writeFileSync(join(dir, 'room-seen.json'), JSON.stringify({ rooms: { r: ['seen-1'] } }));
  const client = new FakeClient({
    messages: [msg({ id: 'seen-1', ts: NOW - 1_000 }), msg({ id: 'new-2', ts: NOW - 1_000 })],
  });
  const seen = collectEvents(client);
  const detach = attachJoinBackfill(client, { stateDir: dir, now: () => NOW, log: () => {} });
  client.emit('event', { type: 'joined', room: 'r' });
  await settle();
  detach();
  assert.deepEqual(seen.map((ev) => ev.message.id), ['new-2'], '只有没见过的才补');
});

test('实时收到的消息也会立刻进"见过"，随后的 joined 不重复补投；状态会落盘', async () => {
  const dir = newStateDir();
  const live = msg({ id: 'live-1', ts: NOW - 1_000 });
  const client = new FakeClient({ messages: [live] });
  const seen = collectEvents(client);
  const detach = attachJoinBackfill(client, { stateDir: dir, now: () => NOW, log: () => {} });
  // 实时路径：与 client.ts 推事件完全相同的形状
  client.emit('event', { type: 'message', room: 'r', mine: false, message: live });
  client.emit('event', { type: 'joined', room: 'r' });
  await settle();
  assert.equal(seen.length, 1, '实时那条只算一次，joined 补投不得重复');
  await sleep(3_200); // saveSoon 的 3s 防抖
  const saved = JSON.parse(readFileSync(join(dir, 'room-seen.json'), 'utf8'));
  assert.ok(saved.rooms.r.includes('live-1'), '去重状态已写入 room-seen.json');
  detach();
});

test('ageMs=0 彻底关掉（不拉历史）；坏 seen 文件不挡补投', async () => {
  const client = new FakeClient({ messages: [msg({ ts: NOW })] });
  const off = attachJoinBackfill(client, { ageMs: 0, stateDir: newStateDir(), now: () => NOW, log: () => {} });
  client.emit('event', { type: 'joined', room: 'r' });
  await settle();
  assert.equal(client.historyCalls, 0, 'ageMs=0 不应发 history 请求');
  off();

  const dir = newStateDir();
  writeFileSync(join(dir, 'room-seen.json'), '{ 这不是 JSON');
  const client2 = new FakeClient({ messages: [msg({ id: 'ok-1', ts: NOW })] });
  const seen = collectEvents(client2);
  const detach = attachJoinBackfill(client2, { stateDir: dir, now: () => NOW, log: () => {} });
  client2.emit('event', { type: 'joined', room: 'r' });
  await settle();
  detach();
  assert.deepEqual(seen.map((ev) => ev.message.id), ['ok-1'], '坏文件当空的，照常补投');
});

test('history 失败只记日志、不抛、不重放', async () => {
  const logs = [];
  const client = new FakeClient({ failHistory: true });
  const seen = collectEvents(client);
  const detach = attachJoinBackfill(client, {
    stateDir: newStateDir(),
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  client.emit('event', { type: 'joined', room: 'r' });
  await settle();
  detach();
  assert.equal(seen.length, 0);
  assert.ok(logs.some((l) => l.includes('拉历史失败')), '失败要有日志');
});

