/* ============================================================================
 * agent-pi · Summoner（A2 邀请制/召唤器）的契约级单测（不起网络、不拉真进程）
 *
 * 钉住的是"谁能把谁叫进房间"这条链上的安全与资源不变量：
 *   · 只认注册表里的名字（不能召唤任意程序）
 *   · --summon-from 白名单
 *   · 冷却 / max-live / 已在场不重复拉起
 *   · 转交必须用规范 token（@<id8>），而且**只在被召唤者真的出现在名册后**
 *   · @<id8> 也能把离开的成员叫回来（原话重说）
 *   · 忙着的成员不被空闲回收收走；收掉后 live 计数归零
 *
 * 用法：node --experimental-strip-types --test scripts/test-summoner.mjs
 *      （已并入根 package.json 的 npm test）
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Summoner, mentionsName } from '../agent-pi/src/summoner.ts';

const id64 = (id8) => `${id8}${'0'.repeat(64 - id8.length)}`;
const peer = (id8, nickname) => ({ id: id64(id8), nickname, lastSeenMs: 0, files: [], epoch: 1 });

const REGISTRY = {
  研究助手: { bin: 'node', args: ['cli.ts', '--nick', '研究助手'] },
  服务器助手: { bin: 'node', args: ['cli.ts', '--nick', '服务器助手'] },
};

const ROOM = '测试房';
const FROM = id64('aa000001');

/** 假的 Summoner：spawnFn 换成记账用的桩（onExit 由用例手动触发 = "它自己退了"） */
function makeSummoner(opts = {}) {
  const spawned = [];
  const stopped = [];
  const lines = [];
  const summoner = new Summoner({
    registry: REGISTRY,
    cooldownMs: 0,
    maxLive: 3,
    idleMs: 600_000,
    log: (line) => lines.push(line),
    spawnFn: (room, name, spec, onExit) => {
      spawned.push({ room, name, spec, onExit });
      return { stop: () => stopped.push(name) };
    },
    ...opts,
  });
  return { summoner, spawned, stopped, lines };
}

function makeSay() {
  const said = [];
  const sent = [];
  return {
    said,
    sent,
    say: async (text, mentions) => {
      said.push(text);
      sent.push({ text, mentions });
      return { id: `m${said.length}`, ts: Date.now() };
    },
  };
}

test('@注册名 拉起成员；转交必须等它出现在名册，且用 @<id8> 而不是昵称', async () => {
  const { summoner, spawned } = makeSummoner();
  const { said, say } = makeSay();

  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 帮我查下天气' }, say);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].name, '研究助手');
  assert.equal(spawned[0].room, ROOM);
  assert.deepEqual(spawned[0].spec, REGISTRY['研究助手'], 'spawn 配置原样来自注册表');
  assert.deepEqual(said, ['🫡 去叫「研究助手」了'], '先只说"去叫了"');

  // 名册里出现了别人 → 不能瞎转交
  await summoner.onRoster(ROOM, [peer('bb111111', '路人甲')], say);
  assert.equal(said.length, 1, '同名的还没出现，不能瞎转交');

  // 被召唤者出现 → 用规范 token（id8）重说请求
  await summoner.onRoster(ROOM, [peer('bb111111', '路人甲'), peer('cc222222', '研究助手')], say);
  assert.equal(said.length, 2);
  assert.equal(said[1], '@cc222222 帮我查下天气');
  assert.ok(!said[1].includes('研究助手'), '转交用 id8，不用昵称');

  // 心跳会反复来：同一次请求只转交一次
  await summoner.onRoster(ROOM, [peer('cc222222', '研究助手')], say);
  assert.equal(said.length, 2, '转交只发生一次');
});

test('只认注册表里的名字（不能召唤任意程序）', async () => {
  const { summoner, spawned } = makeSummoner();
  const { said, say } = makeSay();

  await summoner.onMessage(ROOM, { from: FROM, text: '@路人甲 你好' }, say);
  await summoner.onMessage(ROOM, { from: FROM, text: '研究助手 你好（没带 @）' }, say);
  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 你好', mine: true }, say);

  assert.equal(spawned.length, 0);
  assert.equal(said.length, 0, '不是召唤动作就一个字都不说');
});

test('--summon-from 白名单：名单外的成员叫不动（如实说原因，不静默）', async () => {
  const { summoner, spawned } = makeSummoner({ summonFrom: ['aa000001'] });
  const { said, say } = makeSay();

  await summoner.onMessage(ROOM, { from: id64('dd999999'), text: '@研究助手 来一下' }, say);
  assert.equal(spawned.length, 0);
  assert.match(said[0] ?? '', /不能替你叫「研究助手」/);
  assert.match(said[0] ?? '', /dd999999/);

  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 来一下' }, say);
  assert.equal(spawned.length, 1, '名单内的成员照常能叫');
});

test('冷却：同一名字两次召唤要隔 --cooldown-ms；过后恢复', async () => {
  const { summoner, spawned } = makeSummoner({ cooldownMs: 300 });
  const { said, say } = makeSay();

  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 一' }, say);
  assert.equal(spawned.length, 1);

  spawned[0].onExit(null, null); // 它自己退了（名额空出来）
  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 二' }, say);
  assert.equal(spawned.length, 1, '冷却期内不该重复拉起');
  assert.match(said.at(-1) ?? '', /刚被叫过/);

  await new Promise((resolve) => setTimeout(resolve, 320));
  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 三' }, say);
  assert.equal(spawned.length, 2, '冷却过后恢复');
});

test('max-live：满了如实拒绝，不硬拉', async () => {
  const { summoner, spawned } = makeSummoner({ maxLive: 1 });
  const { said, say } = makeSay();

  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 一' }, say);
  await summoner.onMessage(ROOM, { from: FROM, text: '@服务器助手 二' }, say);
  assert.equal(spawned.length, 1);
  assert.match(said.at(-1) ?? '', /最多带 1 个助手/);
});

test('已在场：不重复拉起；被 @ 或被自己说话都刷新回收计时', async () => {
  const { summoner, spawned, stopped } = makeSummoner({ idleMs: 60_000 });
  const { said, say } = makeSay();

  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 一' }, say);
  await summoner.onRoster(ROOM, [peer('cc222222', '研究助手')], say);
  said.length = 0;

  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 还在吗' }, say);
  assert.equal(spawned.length, 1, '已在场，不该再拉一个');
  assert.equal(said.length, 0, '已在场就安静待着（它自己看得见消息）');

  const t = Date.now();
  assert.deepEqual(summoner.reapIdle(t + 59_000), [], '还没到线，不能收');

  // 它自己在说话 = 在忙 → 计时刷新
  await summoner.onMessage(ROOM, { from: id64('cc222222'), text: '正在算，稍等' }, say);
  assert.deepEqual(summoner.reapIdle(t + 59_000), [], '自己说话也算活跃');

  assert.deepEqual(summoner.reapIdle(Date.now() + 60_001), ['研究助手'], '都没动静了才收');
  assert.deepEqual(stopped, ['研究助手']);
  assert.equal(summoner.liveCount, 0);
});

test('@<id8> 再召唤：名册里学到的对照表，离开后照样叫得回来（原话重说）', async () => {
  const { summoner, spawned } = makeSummoner();
  const { said, sent, say } = makeSay();

  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 帮我查一下' }, say);
  await summoner.onRoster(ROOM, [peer('cc222222', '研究助手')], say); // 学到 cc222222 → 研究助手
  spawned[0].onExit(null, null);
  said.length = 0;

  await summoner.onMessage(ROOM, { from: FROM, text: '@cc222222 接着查' }, say);
  assert.equal(spawned.length, 2, '@<id8> 也应当能把它叫回来');

  // 没见过的 id：什么都做不了（不瞎拉人）
  await summoner.onMessage(ROOM, { from: FROM, text: '@dd000000 在吗' }, say);
  assert.equal(spawned.length, 2);

  // 原话重说：token 不变（身份没变就还能命中）
  await summoner.onRoster(ROOM, [peer('cc222222', '研究助手')], say);
  assert.equal(said.at(-1), '@cc222222 接着查');
  assert.deepEqual(
    sent.at(-1).mentions,
    [id64('cc222222')],
    '转交必须带结构化 mentions（V6 的寻址真相）',
  );
});

test('一条消息能叫多个注册名（各自一条"去叫了"）', async () => {
  const { summoner, spawned } = makeSummoner();
  const { said, say } = makeSay();

  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 和 @服务器助手 都来' }, say);
  assert.deepEqual(
    spawned.map((s) => s.name),
    ['研究助手', '服务器助手'],
  );
  assert.deepEqual(said, ['🫡 去叫「研究助手」了', '🫡 去叫「服务器助手」了']);
});

test('@名字 的边界与转义：中文不打空格也认、@助手2 不误触、正则元字符不炸', () => {
  assert.equal(mentionsName('@研究助手 帮我查', '研究助手'), true);
  assert.equal(mentionsName('@研究助手帮我查', '研究助手'), true, '中文直接接也算（常不打空格）');
  assert.equal(mentionsName('@研究助手，你好', '研究助手'), true);
  assert.equal(mentionsName('麻烦@研究助手一下', '研究助手'), true);
  assert.equal(mentionsName('@研究助手2', '研究助手'), false, '后面接数字 = 另一个名字，不误触');
  assert.equal(mentionsName('@a.b 在吗', 'a.b'), true, '名字里的正则元字符必须转义');
  assert.equal(mentionsName('@axb 在吗', 'a.b'), false);
});

test('C4：注册表 allowFrom 按名字收窄（谁有权召唤**这一个**名字）', async () => {
  const { summoner, spawned } = makeSummoner({
    registry: {
      研究助手: { ...REGISTRY['研究助手'], allowFrom: ['aa000001'] },
    },
  });
  const { said, say } = makeSay();

  await summoner.onMessage(ROOM, { from: id64('dd999999'), text: '@研究助手 来一下' }, say);
  assert.equal(spawned.length, 0, '不在该名字的专属名单里，叫不动');
  assert.match(said[0] ?? '', /只接受名单内成员的召唤/);

  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 来一下' }, say);
  assert.equal(spawned.length, 1, '名单内的成员照常能叫');
});

test('C4：全局名单与专属名单同时生效（两道都过才叫得动）', async () => {
  const { summoner, spawned } = makeSummoner({
    summonFrom: ['bb000002'],
    registry: {
      研究助手: { ...REGISTRY['研究助手'], allowFrom: ['aa000001'] },
    },
  });
  const { said, say } = makeSay();

  // aa000001 过了专属名单，但没过全局 → 仍然叫不动
  await summoner.onMessage(ROOM, { from: FROM, text: '@研究助手 来一下' }, say);
  assert.equal(spawned.length, 0);
  assert.match(said[0] ?? '', /没把 aa000001 加进召唤名单/);

  // bb000002 过了全局，但没过专属 → 也叫不动
  await summoner.onMessage(ROOM, { from: id64('bb000002'), text: '@研究助手 来一下' }, say);
  assert.equal(spawned.length, 0, '专属名单同样要过');
  assert.match(said[1] ?? '', /只接受名单内成员的召唤/);
});
