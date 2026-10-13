/* ============================================================================
 * 首次接入的两个新模块的单测（不跑网络、不建真文件系统之外的东西）
 *
 *   · room/bootstrap.ts —— 本机缺配置时从站点 relay-config.json 补配置
 *   · room/profile.ts   —— 进房后自动发布名片（简介/标签）
 *
 * 为什么值得测：这两块是"朋友第一次接入"的唯一路径 ——
 * 引导写错字段 = 孤立进房（进得去、谁都看不见），名片没发出去 = 名册里
 * 只有名字没有能力信息。都是"看起来没报错、实际没生效"那类坑。
 *
 * 用法：node --experimental-strip-types --test scripts/test-room-bootstrap.mjs
 *      （已并入根 package.json 的 npm test）
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentHomeDir, ensureLocalConfig, parseSiteConfig } from '../agent-pi/src/room/bootstrap.ts';
import { announceProfileOnJoin, normalizeProfileInput } from '../agent-pi/src/room/profile.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(10);
  }
  return fn();
}

const ID = (ch) => ch.repeat(64);
const SITE = {
  version: 1,
  relays: [
    { url: 'https://r1.example:15443', enabled: true },
    { url: 'https://r2.example:15443', enabled: false },
    'https://r3.example:15443',
  ],
  relay_token: 'tok-123',
  anchor: { id: ID('a'), relay: 'https://r1.example:15443' },
  rendezvous: { id: ID('b'), relay: 'https://r1.example:15443' },
  history: { id: ID('c'), relay: 'https://r1.example:15443' },
};

function siteFetch(urls = []) {
  return async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => SITE };
  };
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'iroh-boot-'));
}

function readCfg(home) {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
}

/* ---------------------------------------------------------------- bootstrap */

test('首次运行（空目录）：从站点补配置并写 0600 的 config.json', async () => {
  const home = freshHome();
  const urls = [];
  const result = await ensureLocalConfig({
    server: 'https://agentchat.stream',
    homeDir: home,
    env: {},
    fetchImpl: siteFetch(urls),
  });
  assert.equal(result.action, 'fetched');
  assert.deepEqual(urls, ['https://agentchat.stream/relay-config.json']);
  assert.deepEqual(result.filled.sort(), ['anchor', 'history', 'relay_token', 'relays', 'rendezvous']);
  const cfg = readCfg(home);
  // enabled: false 的中继必须被剔除（和浏览器读同一份配置的语义一致）
  assert.deepEqual(cfg.relays, ['https://r1.example:15443', 'https://r3.example:15443']);
  assert.equal(cfg.relay_token, 'tok-123');
  assert.equal(cfg.rendezvous.id, ID('b'));
  assert.equal(cfg.history.id, ID('c'));
  assert.equal(cfg.anchor.id, ID('a'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600, '配置含令牌，必须 0600');
  }
});

test('已有完整配置：跳过且不拉取（网络都不用碰）', async () => {
  const home = freshHome();
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      relays: ['https://mine.example:15443'],
      relay_token: 'my-token',
      rendezvous: { id: ID('d'), relay: 'https://mine.example:15443' },
      history: { id: ID('e'), relay: 'https://mine.example:15443' },
      nickname: '我的名字',
    }),
  );
  const before = readFileSync(join(home, 'config.json'), 'utf8');
  const result = await ensureLocalConfig({
    server: 'https://agentchat.stream',
    homeDir: home,
    env: {},
    fetchImpl: async () => {
      throw new Error('有完整配置时不该发起拉取');
    },
  });
  assert.equal(result.action, 'skipped');
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
});

test('安装脚本留下的半成品（空 token/空 anchor）：只补缺的，不覆盖已有的', async () => {
  const home = freshHome();
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      relays: ['https://mine.example:15443'],
      relay_token: '',
      anchor: { id: '', relay: 'https://mine.example:15443' },
      nickname: '构建机',
    }),
  );
  const result = await ensureLocalConfig({
    server: 'https://agentchat.stream',
    homeDir: home,
    env: {},
    fetchImpl: siteFetch(),
  });
  assert.equal(result.action, 'fetched');
  const cfg = readCfg(home);
  assert.deepEqual(cfg.relays, ['https://mine.example:15443'], '已有的 relays 不能被覆盖');
  assert.equal(cfg.relay_token, 'tok-123', '缺的 token 要补上');
  assert.equal(cfg.rendezvous.id, ID('b'), '缺的入口要补上');
  assert.equal(cfg.history.id, ID('c'), '缺的历史要补上');
  assert.equal(cfg.nickname, '构建机', 'nickname 不是引导的职责，必须原样保留');
});

test('环境变量已提供中继/入口：跳过且不写任何文件', async () => {
  const home = freshHome();
  const result = await ensureLocalConfig({
    server: 'https://agentchat.stream',
    homeDir: home,
    env: { IROH_AGENT_RELAY: 'https://env.example:15443' },
    fetchImpl: async () => {
      throw new Error('env 已提供配置时不该拉取');
    },
  });
  assert.equal(result.action, 'skipped');
  assert.throws(() => readFileSync(join(home, 'config.json')), '不该写文件');
});

test('拉取失败/站点坏形状：failed，且不动本机文件', async () => {
  const home = freshHome();
  const boom = await ensureLocalConfig({
    server: 'https://agentchat.stream',
    homeDir: home,
    env: {},
    fetchImpl: async () => {
      throw new Error('网络炸了');
    },
  });
  assert.equal(boom.action, 'failed');
  assert.match(boom.reason, /网络炸了/);
  const http500 = await ensureLocalConfig({
    server: 'https://agentchat.stream',
    homeDir: home,
    env: {},
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(http500.action, 'failed');
  const empty = await ensureLocalConfig({
    server: 'https://agentchat.stream',
    homeDir: home,
    env: {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ relays: [] }) }),
  });
  assert.equal(empty.action, 'failed');
  assert.throws(() => readFileSync(join(home, 'config.json')), '失败时不该落任何文件');
});

test('--refresh-config：覆盖这几组，但其它键（nickname 等）原样保留', async () => {
  const home = freshHome();
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      relays: ['https://old.example:15443'],
      relay_token: 'old-token',
      rendezvous: { id: ID('d'), relay: 'https://old.example:15443' },
      history: { id: ID('e'), relay: 'https://old.example:15443' },
      nickname: '旧名字',
      keepMe: true,
    }),
  );
  const result = await ensureLocalConfig({
    server: 'https://agentchat.stream',
    homeDir: home,
    env: {},
    refresh: true,
    fetchImpl: siteFetch(),
  });
  assert.equal(result.action, 'fetched');
  const cfg = readCfg(home);
  assert.deepEqual(cfg.relays, ['https://r1.example:15443', 'https://r3.example:15443']);
  assert.equal(cfg.relay_token, 'tok-123');
  assert.equal(cfg.nickname, '旧名字');
  assert.equal(cfg.keepMe, true);
});

test('parseSiteConfig：坏形状返回 null（调用方走 failed，不炸）', () => {
  assert.equal(parseSiteConfig(null), null);
  assert.equal(parseSiteConfig({ relays: [] }), null);
  assert.equal(parseSiteConfig({ relays: [{ url: 'https://x', enabled: false }] }), null);
  assert.equal(parseSiteConfig({ relays: ['ftp://nope'] }), null);
});

test('agentHomeDir：IROH_AGENT_HOME 优先（与 Rust 侧 home() 一致）', () => {
  assert.equal(agentHomeDir({ IROH_AGENT_HOME: '/tmp/custom-home' }), '/tmp/custom-home');
});

/* ------------------------------------------------------------------ profile */

test('名片：joined 事件触发发布（换行压空格、标签去重、发一次）', async () => {
  const client = new EventEmitter();
  const calls = [];
  client.request = async (cmd, params) => {
    calls.push([cmd, params]);
    return { bio: params.bio, tags: params.tags };
  };
  const logs = [];
  const detach = announceProfileOnJoin(client, {
    bio: '  会查代码\n能跑脚本  ',
    tags: ['ts', ' ts ', 'rust', '', 'rust'],
    log: (line) => logs.push(line),
  });
  client.emit('event', { type: 'joined', room: 'r1' });
  assert.ok(await waitFor(() => calls.length === 1), '应当发布一次名片');
  assert.deepEqual(calls[0], ['profile', { bio: '会查代码 能跑脚本', tags: ['ts', 'rust'] }]);
  assert.ok(logs.some((line) => line.includes('名片已发布')));
  detach();
  client.emit('event', { type: 'joined', room: 'r2' });
  await sleep(50);
  assert.equal(calls.length, 1, '解绑后不该再发布');
});

test('名片：进房竞态失败会重试，成功后停', async () => {
  const client = new EventEmitter();
  let attempts = 0;
  client.request = async () => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error('notJoined: 还没进房间');
      err.code = 'notJoined';
      throw err;
    }
    return { bio: 'x', tags: [] };
  };
  announceProfileOnJoin(client, { bio: 'x', tags: [], attempts: 3, retryDelayMs: 1 });
  client.emit('event', { type: 'joined', room: 'r1' });
  assert.ok(await waitFor(() => attempts === 2), `应当重试并成功（实际尝试 ${attempts} 次）`);
  await sleep(50);
  assert.equal(attempts, 2, '成功后不该继续重试');
});

test('名片：老二进制没有 profile 命令 → 不重试，直接提示升级', async () => {
  const client = new EventEmitter();
  let attempts = 0;
  client.request = async () => {
    attempts += 1;
    const err = new Error('unsupportedCmd: 未知命令 profile');
    err.code = 'unsupportedCmd';
    throw err;
  };
  const logs = [];
  announceProfileOnJoin(client, { bio: 'x', tags: [], attempts: 5, retryDelayMs: 1, log: (l) => logs.push(l) });
  client.emit('event', { type: 'joined', room: 'r1' });
  assert.ok(await waitFor(() => attempts >= 1));
  await sleep(50);
  assert.equal(attempts, 1, 'unsupportedCmd 不该重试');
  assert.ok(logs.some((line) => line.includes('太老')), logs.join('\n'));
});

test('名片：没给 --bio/--tags → 完全不订阅、不发请求（旧行为不变）', async () => {
  const client = new EventEmitter();
  let called = false;
  client.request = async () => {
    called = true;
    return {};
  };
  const detach = announceProfileOnJoin(client, {});
  assert.equal(typeof detach, 'function');
  client.emit('event', { type: 'joined', room: 'r1' });
  await sleep(30);
  assert.equal(called, false);
});

test('normalizeProfileInput：160 字 / 8×16 字上限与去重', () => {
  const { bio, tags } = normalizeProfileInput('字'.repeat(200), [
    'a'.repeat(20),
    'b',
    'b',
    ...Array.from({ length: 10 }, (_, i) => `t${i}`),
  ]);
  assert.equal([...bio].length, 160);
  assert.equal(tags.length, 8);
  assert.equal([...tags[0]].length, 16);
  assert.equal(tags.filter((t) => t === 'b').length, 1);
});
