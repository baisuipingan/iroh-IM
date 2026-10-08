/* ============================================================================
 * MockTransport 的时序契约测试
 *
 * 跑法：
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        src/bridge/mock.test.ts
 *
 * ## 为什么要有这个测试
 *
 * 第一版 mock 是"join 返回之后再延时 1200ms 发事件"，结果把 `useRoom` 里的
 * 一个**真实竞态 bug** 掩盖掉了 —— 真机（Android）上表现为：
 *
 *     卡在「正在进入房间…」，但右上角成员数已经显示 3
 *
 * 根因：调用方 `await transport.join()` 之后再 `setRoom()`，订阅才生效，
 * 而 `joined`/`history` 早在 await 期间就发完了 —— 全丢。
 * 换成真实原生模块**一样会中招**（Rust 的 `RoomNode::join` 同样在 await 期间吐事件）。
 *
 * ## 所以这里钉死两条契约
 *
 *   1. **事件必须在 `join()` resolve 之前发出** —— 否则"先订阅再 join"的
 *      正确接线也救不回来（这正是原 bug 的形态）
 *   2. **每个带 room 的事件都要带对房间名** —— `useRoom` 的房间核对依赖它
 *
 * ⚠️ 断言 1 是**反向**的：如果在 join resolve 之后才收到事件，测试必须失败。
 *    所以这里绝不 await joinPromise 再检查 —— 那样等于什么都没验。
 * ==========================================================================*/

import assert from 'node:assert/strict';
// @ts-expect-error -- Node 跑测试要显式 .ts 后缀（tsc 默认不允许）；
// Metro 打包不经过这个文件，所以对 App 无影响
import { MockTransport } from './mock.ts';
import type { RoomEvent } from './types.ts';

const received: RoomEvent[] = [];
/** 每条事件到达时，"join 是否已经 resolve"—— 这是本测试的核心取证 */
const resolvedWhenReceived: boolean[] = [];

let joinResolved = false;

const t = new MockTransport();
t.subscribe((ev) => {
  received.push(ev);
  // ⚠️ 必须在**收到的那一刻**记录，不能在轮询结束后回看 ——
  //    后者会因为 join 早已自然 resolve 而恒为 true，断言就失去意义。
  resolvedWhenReceived.push(joinResolved);
});

await t.online();

/* ---------------------------------------------------------------------------
 * 契约 1：事件在 join() resolve 之前到达
 * -------------------------------------------------------------------------*/

const joinPromise = t.join({ room: '比奇堡', nickname: '派崔克' }).then(() => {
  joinResolved = true;
});

// 轮询等到三个关键事件都到齐（别死等固定时长）
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const kinds = new Set(received.map((e) => e.type));
  if (kinds.has('joined') && kinds.has('history') && kinds.has('presence')) break;
  await new Promise((r) => setTimeout(r, 20));
}

const arrivedBeforeResolve = new Set(
  received.filter((_, i) => resolvedWhenReceived[i] === false).map((e) => e.type),
);
const allKinds = [...new Set(received.map((e) => e.type))];

// ★ 核心断言：这三件事必须在 join resolve **之前**就到。
//    否则 UI 的"先订阅再 join"也救不回来 —— 那正是一开始的真机 bug。
for (const need of ['joined', 'history', 'presence'] as const) {
  assert.ok(
    arrivedBeforeResolve.has(need),
    `${need} 到达时 join() 已经 resolve 了 —— 事件发得太晚，` +
      `UI 先订阅再 join 也会全部丢掉（这就是那次真机 bug 的形态）。` +
      `全部事件：[${allKinds.join(', ')}]，resolve 前到达的：[${[...arrivedBeforeResolve].join(', ')}]`,
  );
}

await joinPromise;

/* ---------------------------------------------------------------------------
 * 契约 2：事件带正确的 room（useRoom 的房间核对依赖它）
 * -------------------------------------------------------------------------*/

for (const ev of received) {
  if ('room' in ev) {
    assert.equal(ev.room, '比奇堡', `${ev.type} 事件的 room 字段不对`);
  }
}

/* ---------------------------------------------------------------------------
 * 契约 3：带 file 的消息字段是 **snake_case**
 *   （Rust 侧 ChatMessage/FileMeta 没有 rename_all，而 RoomEvent 有 —— 不统一的）
 * -------------------------------------------------------------------------*/

const history = received.find((e) => e.type === 'history');
assert.ok(history && history.type === 'history', '必须收到 history');
const withFile = history.messages.find((m) => m.file);
assert.ok(withFile, '预置历史里必须有一条带 file 的消息（用于测文件卡片渲染）');
assert.equal(typeof withFile.file?.file_id, 'string', 'file_id 必须是 snake_case');
assert.equal(typeof withFile.file?.root_hash, 'string', 'root_hash 必须是 snake_case');
assert.equal(
  Object.prototype.hasOwnProperty.call(withFile.file ?? {}, 'fileId'),
  false,
  '不该出现 camelCase 的 fileId —— 真实现的 JSON 里没有这个键',
);

/* ---------------------------------------------------------------------------
 * 契约 4：send 后立刻回显（mine=true），且有队友后续消息（mine=false）
 * -------------------------------------------------------------------------*/

const before = received.length;
await t.send('在吗');
const afterSend = received.slice(before).map((e) => e.type);
assert.ok(afterSend.includes('message'), 'send 后应立刻收到自己的回显');

await new Promise((r) => setTimeout(r, 2600));
const msgEvents = received.filter(
  (e): e is Extract<RoomEvent, { type: 'message' }> => e.type === 'message',
);
assert.ok(msgEvents.some((e) => e.mine), '应至少有一条 mine=true');
assert.ok(msgEvents.some((e) => !e.mine), '应至少有一条 mine=false（假队友回话）');

/* ---------------------------------------------------------------------------
 * 契约 5：房间核对能挡住"旧房间的迟到事件"
 *   换房后 roomRef 指向新房间，旧事件必须被识别出来（这里验 mock 的字段是对的，
 *   过滤逻辑在 useRoom 里）
 * -------------------------------------------------------------------------*/

await t.join({ room: '蟹堡王', nickname: '派崔克' });
const afterSwitch = received.slice(received.findIndex((e) => 'room' in e && e.room === '蟹堡王'));
assert.ok(afterSwitch.length > 0, '换房后应收到新房间的事件');
assert.ok(
  afterSwitch.every((e) => !('room' in e) || e.room === '蟹堡王'),
  '换房后不该再收到旧房间的事件',
);

await t.shutdown();

console.log('✅ mock 时序契约全部通过：');
console.log(`   ① join resolve 前收到：${[...arrivedBeforeResolve].join(', ')}`);
console.log(`   ② 带 file 的历史消息：${withFile.file?.name}（snake_case 字段已确认）`);
console.log(`   ③ 消息事件 ${msgEvents.length} 条（mine/非 mine 都有）`);
console.log('   ④ 换房后无旧房间事件泄漏');
