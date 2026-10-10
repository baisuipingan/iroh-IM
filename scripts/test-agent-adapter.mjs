/* ============================================================================
 * agent-pi · ChatAdapter 的契约级单元测试（不跑网络、不起进程）
 *
 * 为什么单独写：这一层管着"谁能触发 agent、多快能触发、能往磁盘写多少"，
 * 全是**安全与成本**相关的不变量，但在这次加固之前它一条单测都没有 ——
 * 而它踩过的坑（冷却竞态、累计接收无上限）都是"看起来有防护、其实没生效"那种。
 *
 * 用法：node --experimental-strip-types --test scripts/test-agent-adapter.mjs
 *      （已并入根 package.json 的 npm test）
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ChatAdapter } from '../agent-pi/src/adapter.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个假的 AgentClient：只实现 adapter 会用到的那几个方法 */
function makeClient({ sayDelay = 50 } = {}) {
  const client = new EventEmitter();
  client.hello = { nickname: '小助手' };
  client.said = [];
  client.rejected = [];
  client.say = async (text) => {
    await sleep(sayDelay);
    client.said.push(text);
    return { id: String(client.said.length), ts: Date.now() };
  };
  client.rejectFile = async (fileId, reason) => {
    client.rejected.push({ fileId, reason });
  };
  client.acceptFile = async () => {
    throw new Error('本用例不该走到接收');
  };
  client.history = async () => ({ messages: [] });
  client.status = async () => ({});
  return client;
}

const message = (id, text, nickname = '甲') => ({
  type: 'message',
  room: 'r',
  mine: false,
  message: { id, from: `peer-${id}`, nickname, text, ts: Date.now(), sig: '', file: null },
});

const invite = (fileId, size, sender = 'peer-1') => ({
  type: 'fileInvite',
  room: 'r',
  meta: {
    file_id: fileId,
    name: `${fileId}.bin`,
    size,
    mime: 'application/octet-stream',
    sender,
    sender_relay: '',
    ts: Date.now(),
    chunk_size: 262144,
    root_hash: 'ab'.repeat(32),
  },
});

const makeAdapter = (client, opts = {}) =>
  new ChatAdapter({
    client,
    brain: { onMessage: async (msg) => msg.text },
    room: 'r',
    prefix: '!',
    log: () => {},
    ...opts,
  });

test('同一瞬间到达的多个触发只处理一轮（冷却必须在 await 之前占位）', async () => {
  const client = makeClient({ sayDelay: 120 });
  const adapter = makeAdapter(client, { cooldownMs: 3000 });
  adapter.start();

  // 回归的是一个真实缺陷：冷却原本在"回复发出后"才更新，
  // 而 #handle 在 await brain 处就让出了执行权 →
  // 同一批消息每一条都能通过检查，各打一次模型（实测两条回复间隔 0ms）。
  client.emit('event', message('1', '!一'));
  client.emit('event', message('2', '!二'));
  client.emit('event', message('3', '!三'));
  await sleep(500);

  assert.deepEqual(client.said, ['一'], '只应处理第一条');
});

test('上一轮还没结束时到达的触发被丢弃（不排队）', async () => {
  const client = makeClient({ sayDelay: 300 });
  const adapter = makeAdapter(client, { cooldownMs: 0 });
  adapter.start();

  client.emit('event', message('1', '!一'));
  await sleep(50); // 第一轮仍在飞
  client.emit('event', message('2', '!二'));
  await sleep(600);

  assert.deepEqual(client.said, ['一']);
});

test('冷却窗口内的后续触发被丢弃，窗口过后恢复', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 400 });
  adapter.start();

  client.emit('event', message('1', '!一'));
  await sleep(200); // 第一轮已结束，但仍在冷却窗口内
  client.emit('event', message('2', '!二'));
  await sleep(400); // 窗口已过
  client.emit('event', message('3', '!三'));
  await sleep(200);

  assert.deepEqual(client.said, ['一', '三'], '冷却期内的"二"应被丢弃，"三"应恢复');
});

test('同一 message.id 只处理一次（gossip 会重复投递）', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 0 });
  adapter.start();

  client.emit('event', message('same', '!一'));
  await sleep(100);
  client.emit('event', message('same', '!一'));
  await sleep(100);

  assert.deepEqual(client.said, ['一']);
});

test('累计接收超过上限时拒绝，并说明理由（单文件与并发都挡不住反复发）', async () => {
  const client = makeClient();
  let accepted = 0;
  client.acceptFile = async () => {
    accepted += 1;
    return { fileId: 'f', path: '/tmp/f', bytes: 800 };
  };
  const adapter = makeAdapter(client, {
    files: 'accept',
    filesMaxBytes: 1024,
    filesMaxTotalBytes: 1000,
    filesSaveDir: '/tmp',
  });
  adapter.start();

  client.emit('event', invite('f1', 800));
  await sleep(150);
  assert.equal(accepted, 1, '第一个文件（800B）应当被接收');
  assert.equal(client.rejected.length, 0);

  client.emit('event', invite('f2', 800));
  await sleep(150);
  assert.equal(accepted, 1, '第二个文件会突破累计上限，不该被接收');
  assert.equal(client.rejected.length, 1, '应当明确拒绝一次');
  assert.match(client.rejected[0].reason, /累计接收已达上限/);
});

test('单文件超限直接拒绝（不消耗累计额度）', async () => {
  const client = makeClient();
  let accepted = 0;
  client.acceptFile = async () => {
    accepted += 1;
    return { fileId: 'f', path: '/tmp/f', bytes: 10 };
  };
  const adapter = makeAdapter(client, {
    files: 'accept',
    filesMaxBytes: 100,
    filesMaxTotalBytes: 10 * 1024 * 1024,
    filesSaveDir: '/tmp',
  });
  adapter.start();

  client.emit('event', invite('big', 9999));
  await sleep(150);

  assert.equal(accepted, 0);
  assert.match(client.rejected[0]?.reason ?? '', /超过大小上限/);
});

test('白名单外的发送方被拒绝', async () => {
  const client = makeClient();
  let accepted = 0;
  client.acceptFile = async () => {
    accepted += 1;
    return { fileId: 'f', path: '/tmp/f', bytes: 10 };
  };
  const adapter = makeAdapter(client, {
    files: 'accept',
    filesAllowFrom: ['only-me'],
    filesSaveDir: '/tmp',
  });
  adapter.start();

  client.emit('event', invite('f1', 10, 'someone-else'));
  await sleep(150);

  assert.equal(accepted, 0);
  assert.match(client.rejected[0]?.reason ?? '', /白名单/);
});
