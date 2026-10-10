/* ============================================================================
 * 校验：前端 `net.js` 处理的事件名，必须都真实存在于协议里。
 *
 * ## 为什么前端需要单独一条检查
 *
 * 三端里只有 web 是**纯 JS**（没有类型系统），所以"生成 TS 类型"对它没有约束力 ——
 * 而事件名写错恰恰在这里真实发生过两次：
 *   · `case 'relay'` 而 Rust 发的是 `relayStatus` → 该分支**从来没命中**，
 *     中继状态只能靠轮询兜着（看着像正常工作，最难查）；
 *   · `peerUp` / `peerDown` 一度**完全没有 case**，掉线信息在 UI 上根本不存在。
 *
 * 这条检查补的就是 web 侧的等价保证：**不认识的事件名 = 红**。
 *
 * 判定分两档（方向很重要）：
 *   · net.js 里出现了协议里**不存在**的事件名 → ❌ 失败（一定是写错了/协议改名了）
 *   · 协议里有 net.js **没处理**的事件 → ⚠️ 只提示（可能是有意的，例如 history
 *     走 RPC 而不是事件流；是否有意应由人判断，不该由脚本拦）
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = resolve(ROOT, 'mobile/src/bridge/protocol.gen.ts');
const NET_JS = resolve(ROOT, 'frontend/js/net.js');

/** 不是协议事件、由前端/Worker 自己合成的类型（这里必须**逐条列出理由**） */
const LOCAL_ONLY = new Set([
  // Worker 在 wasm 事件流断掉时自己 push 的（见 frontend/js/iroh-worker.js）
  'node:degraded',
]);

const protocolTypes = new Set(
  [...readFileSync(GENERATED, 'utf8').matchAll(/"type":\s*"([A-Za-z]+)"/g)].map((m) => m[1]),
);
assert.ok(protocolTypes.size > 5, `没能从 ${GENERATED} 里解析出事件类型（生成物坏了？）`);

// 只取 `_dispatch` 里那段 switch（文件里别处也有 case，例如 Worker 消息分发）
const net = readFileSync(NET_JS, 'utf8');
const start = net.indexOf('_dispatch(ev)');
assert.ok(start > 0, 'net.js 里找不到 _dispatch');
const dispatch = net.slice(start, net.indexOf('\n  },', start));
const handled = new Set([...dispatch.matchAll(/case\s+'([A-Za-z:]+)'\s*:/g)].map((m) => m[1]));

const unknown = [...handled].filter((t) => !protocolTypes.has(t) && !LOCAL_ONLY.has(t));
const unhandled = [...protocolTypes].filter((t) => !handled.has(t));

console.log(`协议事件 ${protocolTypes.size} 个，net.js 处理 ${handled.size} 个`);
if (unhandled.length) {
  console.log(`⚠️  未在 net.js 处理（可能是有意的，例如走 RPC）：${unhandled.join(', ')}`);
}
if (unknown.length) {
  console.error(`❌ net.js 处理了协议里不存在的事件名：${unknown.join(', ')}`);
  console.error('   这一定是写错了或协议已改名 —— 写错的 case **永远不会命中**，而且不报错。');
  process.exit(1);
}
console.log('✅ web 处理的事件名都真实存在于协议里');
