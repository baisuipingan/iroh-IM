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
import { ChatAdapter } from '../agent-pi/src/room/adapter.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个假的 AgentClient：只实现 adapter 会用到的那几个方法 */
function makeClient({ sayDelay = 50 } = {}) {
  const client = new EventEmitter();
  // `endpointId` 是 @ 规范寻址的底层（R1）：id8 = 前 8 位
  client.hello = { nickname: '小助手', endpointId: `9b45b7ef${'00'.repeat(28)}` };
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
  message: { id, from: `peer-${id}`, nickname, text, ts: Date.now(), sig: '', file: null, mentions: [] },
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
    mention: '小助手',
    log: () => {},
    ...opts,
  });

test('默认规则真的能用：ping → pong（曾经因为 /…/ 没被解析而永远不触发）', async () => {
  const { defaultRules, RuleBrain } = await import('../agent-pi/src/agent-io/rule.ts');
  const brain = new RuleBrain(defaultRules());
  const msg = {
    room: 'r', id: 'm1', from: 'd'.repeat(64), nickname: '人',
    text: 'ping', ts: 1, agentNick: '小助手', raw: {},
  };
  assert.equal(await brain.onMessage(msg), 'pong');
  assert.equal(await brain.onMessage({ ...msg, text: 'PING' }), 'pong');
  assert.equal(await brain.onMessage({ ...msg, text: '没什么' }), null);
});

test('同一瞬间到达的多个触发只处理一轮（冷却必须在 await 之前占位）', async () => {
  const client = makeClient({ sayDelay: 120 });
  const adapter = makeAdapter(client, { cooldownMs: 3000 });
  adapter.start();

  // 回归的是一个真实缺陷：冷却原本在"回复发出后"才更新，
  // 而 #handle 在 await brain 处就让出了执行权 →
  // 同一批消息每一条都能通过检查，各打一次模型（实测两条回复间隔 0ms）。
  client.emit('event', message('1', '@小助手 一'));
  client.emit('event', message('2', '@小助手 二'));
  client.emit('event', message('3', '@小助手 三'));
  await sleep(500);

  assert.deepEqual(client.said, ['一'], '只应处理第一条');
});

test('brain 失败：房间里如实说一句（限频 120s，不刷屏）', async () => {
  const client = makeClient();
  const attempts = [];
  const adapter = makeAdapter(client, {
    cooldownMs: 0,
    brain: {
      onMessage: async (msg) => {
        attempts.push(msg.text);
        throw new Error('ACP 这一轮失败：Authentication required: provider authentication required');
      },
    },
  });
  adapter.start();
  client.emit('event', message('f1', '@小助手 你好'));
  await sleep(150);
  assert.equal(client.said.length, 1, `失败应当播报一次：${JSON.stringify(client.said)}`);
  assert.match(client.said[0], /⚠️ 我这轮没处理成功/);
  assert.match(client.said[0], /Authentication required/);
  client.emit('event', message('f2', '@小助手 再试'));
  await sleep(150);
  assert.equal(client.said.length, 1, '120s 窗口内不重复播报');
  assert.equal(attempts.length, 2, '但每次触发都真的试过了');
  await adapter.stop();
});

test('上一轮还没结束时到达的触发被丢弃（不排队）', async () => {
  const client = makeClient({ sayDelay: 300 });
  const adapter = makeAdapter(client, { cooldownMs: 0 });
  adapter.start();

  client.emit('event', message('1', '@小助手 一'));
  await sleep(50); // 第一轮仍在飞
  client.emit('event', message('2', '@小助手 二'));
  await sleep(600);

  assert.deepEqual(client.said, ['一']);
});

test('冷却窗口内的后续触发被丢弃，窗口过后恢复', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 400 });
  adapter.start();

  client.emit('event', message('1', '@小助手 一'));
  await sleep(200); // 第一轮已结束，但仍在冷却窗口内
  client.emit('event', message('2', '@小助手 二'));
  await sleep(400); // 窗口已过
  client.emit('event', message('3', '@小助手 三'));
  await sleep(200);

  assert.deepEqual(client.said, ['一', '三'], '冷却期内的"二"应被丢弃，"三"应恢复');
});

test('同一 message.id 只处理一次（gossip 会重复投递）', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 0 });
  adapter.start();

  client.emit('event', message('same', '@小助手 一'));
  await sleep(100);
  client.emit('event', message('same', '@小助手 一'));
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

test('`!前缀` 已整个删除：它不再是触发方式', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 0 });
  adapter.start();

  // 旧写法：删掉之前这两条都会触发
  client.emit('event', message('1', '!一'));
  client.emit('event', message('2', '!ping'));
  await sleep(200);
  assert.deepEqual(client.said, [], '`!` 开头的消息不该再触发 agent');

  // 真人聊天里的感叹号也不该被误当成命令（这正是删掉前缀的动机之一）
  client.emit('event', message('3', '！这也太离谱了'));
  await sleep(200);
  assert.deepEqual(client.said, []);

  // @ 照常触发，且 @ 之后的内容原样交给 brain
  client.emit('event', message('4', '@小助手 你好'));
  await sleep(200);
  assert.deepEqual(client.said, ['你好']);
});

test('@ 按 id 寻址：@<我的 id8> 触发，别人的 id8 不触发（R1）', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 0 });
  adapter.start();

  // 别人的 id8：绝不该触发（同名/改名都挡不住的那种误触发，靠这条挡）
  client.emit('event', message('1', '@deadbeef 你好'));
  await sleep(150);
  assert.deepEqual(client.said, [], '别人的 id8 不该触发我');

  // 我的 id8：触发，且 token 被剥掉，brain 拿到的是纯文本
  client.emit('event', message('2', '@9b45b7ef 你好'));
  await sleep(150);
  assert.deepEqual(client.said, ['你好']);
});

test('@<我的 id8> 不依赖昵称：关掉 --mention 也照样触发（R1）', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 0, mention: null });
  adapter.start();

  // 昵称兜底被关掉 → 裸 @昵称 不再是提及
  client.emit('event', message('1', '@小助手 你好'));
  await sleep(150);
  assert.deepEqual(client.said, [], '关掉昵称兜底后，@昵称 不该触发');

  // 但规范的 id 寻址照常工作 —— 这才是"改名/同名都不受影响"的基础
  client.emit('event', message('2', '@9b45b7ef 在吗'));
  await sleep(150);
  assert.deepEqual(client.said, ['在吗']);
});

test('id8 必须是完整 8 位：长 id 的前缀不会误触发（边界）', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 0, mention: null });
  adapter.start();

  // `@9b45b7ef123` 是**更长的 id**（第 9 位仍是 hex）→ 不是我的 token
  client.emit('event', message('1', '@9b45b7ef123 你好'));
  await sleep(150);
  assert.deepEqual(client.said, [], '9 位以上 hex 不该被截成 8 位来匹配');
});

test('成本闸门（C3）：窗口内的轮数用尽就拦住，并在房间里如实说一句', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 0, budgetTurns: 2, budgetWindowMs: 60_000 });
  adapter.start();

  client.emit('event', message('1', '@小助手 一'));
  await sleep(120);
  client.emit('event', message('2', '@小助手 二'));
  await sleep(120);
  client.emit('event', message('3', '@小助手 三'));
  await sleep(150);

  const replies = client.said.filter((t) => !t.includes('预算用尽'));
  assert.deepEqual(replies, ['一', '二'], '窗口内只该放两轮（第三轮不许打到模型）');
  assert.ok(
    client.said.some((t) => t.includes('预算用尽')),
    `超限必须如实说一句：${JSON.stringify(client.said)}`,
  );
});


test('V6 结构化 mentions：命中我的 id 就触发（文本里没有 token 也行）', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 0, mention: null });
  adapter.start();

  // 我的完整 EndpointId（hello.endpointId）
  const myId = client.hello.endpointId;
  const ev = message('1', '这条没有 token，只有结构化 mentions');
  ev.message.mentions = [myId];
  client.emit('event', ev);
  await sleep(150);
  assert.deepEqual(client.said, ['这条没有 token，只有结构化 mentions'], '结构化 mentions 必须触发');

  // 别人被 @（mentions 里没有我）→ 不触发
  const other = message('2', '叫的是别人');
  other.message.mentions = ['deadbeef'.repeat(8)];
  client.emit('event', other);
  await sleep(150);
  assert.deepEqual(client.said, ['这条没有 token，只有结构化 mentions'], '别人的 mentions 不该触发我');

  // 命中 + 带渲染锚点 token：token 要被剥掉，brain 拿纯正文
  const anchored = message('3', `@${myId.slice(0, 8)} 你好呀`);
  anchored.message.mentions = [myId];
  client.emit('event', anchored);
  await sleep(150);
  assert.deepEqual(client.said.at(-1), '你好呀', '锚点 token 要剥掉');
});

test('成本闸门（C3）：窗口滑过之后恢复', async () => {
  const client = makeClient({ sayDelay: 10 });
  const adapter = makeAdapter(client, { cooldownMs: 0, budgetTurns: 1, budgetWindowMs: 500 });
  adapter.start();

  client.emit('event', message('1', '@小助手 一'));
  await sleep(150);
  client.emit('event', message('2', '@小助手 二'));
  await sleep(150);
  assert.deepEqual(
    client.said.filter((t) => !t.includes('预算用尽')),
    ['一'],
    '窗口内只放一轮',
  );

  await sleep(500); // 500ms 窗口滑过
  client.emit('event', message('3', '@小助手 三'));
  await sleep(150);
  assert.deepEqual(
    client.said.filter((t) => !t.includes('预算用尽')),
    ['一', '三'],
    '窗口滑过后恢复',
  );
});
