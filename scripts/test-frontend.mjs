import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectRelayModel,
  probeLatency,
  validateRelayConfig,
} from '../frontend/js/relay-model.js';
import { withTimeout } from '../frontend/js/util.js';
import { loadRelayConfig, probeRelay } from '../frontend/js/probe.js';

const relay = { id: 'hk-1', url: 'https://relay.example:15443', enabled: true };
const config = { relays: [relay], anchor: { id: 'a'.repeat(64) } };

test('relay configuration accepts optional fields and explicit disabled entries', () => {
  assert.equal(validateRelayConfig(config), config);
  assert.ok(validateRelayConfig({ relays: [{ url: relay.url, enabled: false }] }));
});

test('relay configuration rejects invalid shape, endpoints and coercion', () => {
  for (const invalid of [
    null,
    {},
    { relays: [] },
    { relays: [null] },
    { relays: [{ ...relay, url: 'http://relay.example' }] },
    { relays: [{ ...relay, url: 'https://user:secret@relay.example' }] },
    { relays: [{ ...relay, url: 'https://relay.example/path' }] },
    { relays: [{ ...relay, enabled: 'false' }] },
    { relays: [{ ...relay, quic_port: -1 }] },
    { relays: [relay, { ...relay, url: `${relay.url}/` }] },
    { relays: [relay, { ...relay, url: 'https://other.example' }] },
    { ...config, anchor: { id: 'invalid' } },
    { ...config, relay_token: 1 },
  ])
    assert.throws(() => validateRelayConfig(invalid));
});

test('relay model merges URL variants and retains runtime-only nodes without duplicates', () => {
  const model = collectRelayModel(
    config,
    [
      { url: `${relay.url}/`, connected: true },
      { url: 'https://new.example/', connected: false },
    ],
    [{ url: relay.url, ok: true, rtt: 0 }],
  );
  assert.equal(model.home.id, 'hk-1');
  assert.equal(model.home.probe.rtt, 0);
  assert.equal(model.items.length, 2);
  assert.equal(model.okCount, 1);
  assert.equal(model.standbys[0].id, 'new.example');
});

test('disabled relays cannot masquerade as an active path via stale status', () => {
  const model = collectRelayModel(
    { relays: [{ ...relay, enabled: false }] },
    [{ url: relay.url, connected: true }],
    [{ url: relay.url, ok: true, rtt: 10 }],
  );
  assert.equal(model.home, null);
  assert.equal(model.okCount, 0);
  assert.equal(model.items[0].probe, null);
});

test('latency distinguishes unavailable, reachable without timing and zero milliseconds', () => {
  assert.equal(probeLatency(null).reachable, null);
  assert.equal(probeLatency({ ok: false, rtt: 25 }).text, '不可达');
  assert.equal(probeLatency({ ok: true, rtt: null }).text, '可达');
  assert.equal(probeLatency({ ok: true, rtt: 0 }).text, '0ms');
  assert.equal(probeLatency({ ok: true, rtt: NaN }).milliseconds, null);
});

test('timeout settles success, preserves rejection and reports deadline', async () => {
  assert.equal(await withTimeout(Promise.resolve('ready'), 10000), 'ready');
  const original = new Error('original');
  await assert.rejects(withTimeout(Promise.reject(original), 10000), (error) => error === original);
  await assert.rejects(withTimeout(new Promise(() => {}), 1, '测试'), /测试超时/);
});

test('relay HTTP errors are unavailable during warmup and subsequent samples', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    const warmup = await probeRelay(relay, { samples: 1 });
    assert.equal(warmup.ok, false);
    assert.match(warmup.error, /HTTP 503/);
    let calls = 0;
    globalThis.fetch = async () => (++calls === 1 ? { ok: true } : { ok: false, status: 429 });
    const sample = await probeRelay(relay, { samples: 1 });
    assert.equal(sample.ok, false);
    assert.equal(sample.failedAt, 0);
    assert.match(sample.error, /HTTP 429/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('configuration fallback validates both network and cache without caching malformed data', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => config });
    assert.deepEqual(await loadRelayConfig('https://config.example', 'test.config'), config);
    assert.equal(values.get('test.config'), JSON.stringify(config));
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ relays: 'invalid' }) });
    assert.deepEqual(await loadRelayConfig('https://config.example', 'test.config'), config);
    assert.equal(values.get('test.config'), JSON.stringify(config));
    values.set('test.config', '{invalid json');
    await assert.rejects(
      loadRelayConfig('https://config.example', 'test.config'),
      /中继配置加载失败/,
    );
    assert.equal(values.has('test.config'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});
