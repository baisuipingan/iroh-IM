/* relay-config 的单元测试：只测**纯逻辑**（校验 + 回退），不真的联网。 */

import assert from 'node:assert/strict';
import { BUILTIN_RELAY_CONFIG } from './relay-config.builtin';
import { loadRelayConfig, parseRelayConfig, RELAY_CONFIG_URL } from './relay-config';

const good = {
  relays: [
    { id: 'a', url: 'https://r1.example.com:15443', enabled: true },
    { id: 'b', url: 'https://r2.example.com:15443', enabled: false },
  ],
  anchor: { id: 'ab'.repeat(32), relay: 'https://r1.example.com:15443' },
  relay_token: 'tok',
};

const rejects = (name: string, raw: unknown) => {
  let threw = false;
  try {
    parseRelayConfig(raw);
  } catch {
    threw = true;
  }
  assert.ok(threw, `应当拒绝：${name}`);
  console.log(`✅ 拒绝 ${name}`);
};

// ① 正常配置
const parsed = parseRelayConfig(good);
assert.equal(parsed.relays.length, 2);
assert.equal(parsed.relays[0]?.url, 'https://r1.example.com:15443');
assert.equal(parsed.anchor?.id, 'ab'.repeat(32));
console.log('✅ 正常配置解析');

// ② 各种坏配置都必须被拒（宁可回退，也不半信）
rejects('非对象', 'x');
rejects('relays 为空', { relays: [] });
rejects('relay url 非 https', { relays: [{ url: 'http://r.example.com' }] });
rejects('relay url 非法', { relays: [{ url: 'not a url' }] });
rejects('全部中继被禁用', { relays: [{ url: 'https://r.example.com', enabled: false }] });
rejects('anchor.id 不是 64 位 hex', { ...good, anchor: { id: 'zz', relay: 'https://r.example.com' } });
rejects('anchor 只有 id 没有 relay', { ...good, anchor: { id: 'ab'.repeat(32) } });
console.log('✅ 坏配置全部被拒');

// ③ 没有 anchor 是合法的（不配常驻节点也能连）
const noAnchor = parseRelayConfig({ relays: good.relays });
assert.equal(noAnchor.anchor, undefined);
console.log('✅ 允许不配 anchor');

// ④ 拉取失败 → 回退内置兜底，并且**不抛异常**（离线也要能用）
const offline = await loadRelayConfig(async () => {
  throw new Error('network down');
});
assert.equal(offline.source, 'builtin');
assert.match(offline.error ?? '', /network down/);
assert.deepEqual(offline.config, BUILTIN_RELAY_CONFIG);
console.log('✅ 拉取失败回退到内置兜底');

// ⑤ HTTP 非 2xx 也要回退（不能把 404 页面当成配置）
const bad = await loadRelayConfig(async () => new Response('nope', { status: 404 }));
assert.equal(bad.source, 'builtin');
assert.match(bad.error ?? '', /404/);
console.log('✅ 非 2xx 回退');

// ⑥ 拉取成功 → 用远端那份，并打到正确的地址
let seen = '';
const ok = await loadRelayConfig(async (input) => {
  seen = String(input);
  return new Response(JSON.stringify(good), { status: 200 });
});
assert.equal(ok.source, 'remote');
assert.equal(seen, RELAY_CONFIG_URL);
assert.equal(ok.config.relays[1]?.enabled, false, '远端里被禁用的中继要如实带过来');
console.log('✅ 远端配置生效');

console.log('✅ relay-config 契约全部通过');
