/* ============================================================================
 * agent-pi · AcpBrain 的契约级单测（不起网络、不接模型）
 *
 * 用一个**假的 ACP agent**（agent-pi/examples/fake-acp-agent.mjs）当对端，
 * 把 ACP 客户端那侧的逻辑全钉住：
 *   · 流式拼接（多条 agent_message_chunk → 一条回复）
 *   · 工具调用播报（B4：房间里看得见）
 *   · 权限请求（决策⑤：默认拒绝 / allow-all 才放行，且**无论批不批都说出来**）
 *   · 超时 → 发 session/cancel（是**通知**，不是请求）并如实说明
 *   · agent 进程死了 → 下次说话时重新拉起（不崩、不静默吞）
 *
 * 用法：node --experimental-strip-types --test scripts/test-acp-brain.mjs
 *      （已并入根 package.json 的 npm test）
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpBrain } from '../agent-pi/src/agent-io/acp.ts';

// ⚠️ 必须 `fileURLToPath`：`.pathname` 会把路径里的非 ASCII 变成百分号编码
//    （本仓库路径里有中文），node 于是找不到文件、进程秒退（第一版就是这么挂的）
const FAKE = fileURLToPath(new URL('../agent-pi/examples/fake-acp-agent.mjs', import.meta.url));

/** 一个假的 ChatContext：只记 say 出去的文本（就是"房间里看得见"的那些行） */
function makeCtx() {
  const said = [];
  return {
    said,
    ctx: {
      say: async (text) => {
        said.push(text);
        return { id: `m${said.length}`, ts: Date.now() };
      },
      history: async () => ({ messages: [] }),
      status: async () => ({}),
      log: () => {},
    },
  };
}

const message = (text) => ({
  room: 'r', id: 'm1', from: 'peer-1', nickname: '甲', text, ts: Date.now(), agentNick: '小助手', raw: {},
});

const brainWith = (opts = {}) =>
  new AcpBrain({ bin: process.execPath, args: [FAKE], cwd: process.cwd(), ...opts });

test('流式输出拼成一条回复；工具调用与权限请求都在房间里说出来（默认拒绝）', async (t) => {
  const brain = brainWith({ promptTimeoutMs: 15_000 });
  t.after(() => brain.close());   // 失败也必须收摊，否则假 agent 活着把整轮挂住
  const { ctx, said } = makeCtx();
  const reply = await brain.onMessage(message('你好'), ctx);

  assert.match(reply ?? '', /你好，/, `回复应当是流式拼接的结果：${reply}`);
  assert.match(reply ?? '', /我是假 agent/);
  assert.match(reply ?? '', /（权限=r2）/, '默认策略必须选 reject_*（优先 reject_always，决策⑤：默认拒绝）');
  assert.ok(said.some((t) => t.includes('🔧') && t.includes('Bash')), `应当播报工具调用：${JSON.stringify(said)}`);
  assert.ok(said.some((t) => t.includes('⚠️') && t.includes('已拒绝')), `权限请求必须说出来：${JSON.stringify(said)}`);
});

test('allow-all 才放行（显式开关），并且也在房间里说明', async (t) => {
  const brain = brainWith({ permission: 'allow-all', promptTimeoutMs: 15_000 });
  t.after(() => brain.close());   // 失败也必须收摊，否则假 agent 活着把整轮挂住
  const { ctx, said } = makeCtx();
  const reply = await brain.onMessage(message('你好'), ctx);

  assert.match(reply ?? '', /（权限=a2）/, 'allow-all 应当选 allow_*（优先 allow_always）');
  assert.ok(said.some((t) => t.includes('已按 allow-all 批准')), `要说清楚它被放行了：${JSON.stringify(said)}`);
});

test('narrate=off：只发最终回复，不播报工具调用', async (t) => {
  const brain = brainWith({ narrate: 'off', promptTimeoutMs: 15_000 });
  t.after(() => brain.close());   // 失败也必须收摊，否则假 agent 活着把整轮挂住
  const { ctx, said } = makeCtx();
  await brain.onMessage(message('你好'), ctx);
  assert.equal(said.filter((t) => t.includes('🔧')).length, 0, `不该播报工具：${JSON.stringify(said)}`);
});

test('一轮超时：发 session/cancel 并如实说明，不把"卡住"伪装成"没回答"', async (t) => {
  const brain = brainWith({ promptTimeoutMs: 400 });
  t.after(() => brain.close());   // 失败也必须收摊，否则假 agent 活着把整轮挂住
  const { ctx } = makeCtx();
  const reply = await brain.onMessage(message('__slow__ 请慢慢想'), ctx);
  assert.match(reply ?? '', /超时/, `超时必须说出来：${reply}`);
});

test('agent 进程死了：下次说话重新拉起（不崩、不静默吞）', async (t) => {
  const brain = brainWith({ promptTimeoutMs: 15_000 });
  t.after(() => brain.close());   // 失败也必须收摊，否则假 agent 活着把整轮挂住
  const { ctx } = makeCtx();
  // 第一次让它自杀：应当抛错（这一次确实没答出来）
  await assert.rejects(() => brain.onMessage(message('__die__'), ctx));
  // 第二次应当自己把进程重新拉起来并正常回答
  const reply = await brain.onMessage(message('你好'), ctx);
  assert.match(reply ?? '', /你好，/, `重启后应当能正常回答：${reply}`);
});
