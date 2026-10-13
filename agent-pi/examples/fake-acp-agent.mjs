#!/usr/bin/env node
/* ============================================================================
 * fake-acp-agent.mjs · 一个**最小的 ACP agent**（只为测客户端，不接任何模型）
 *
 * 为什么要有它：ACP 客户端的逻辑（流式拼接、工具调用播报、权限决策、超时取消、
 * 进程死了重建）如果只能靠真实 agent 来测，那就**又慢又贵还不可控**。
 * 这个假 agent 把它们变成确定性的单测（`scripts/test-acp-test` 那套：
 * `scripts/test-acp-brain.mjs`）。
 *
 * 行为（判据全在 prompt 文本里，方便测试挑）：
 *   · initialize → 回 protocolVersion + agentInfo
 *   · session/new → 回 sessionId
 *   · session/prompt →
 *       1) 流式发两条 agent_message_chunk
 *       2) 发一个 tool_call（客户端应当播报）
 *       3) 反向请求 session/request_permission（客户端必须回 outcome）
 *       4) 把它的决定**写进回复文本**（`（权限=…）`），这样测试只用看返回值
 *       5) 回 {stopReason:'end_turn'}
 *   · prompt 含 `__die__` → 直接退出（测"下次说话时重新拉起"）
 *   · prompt 含 `__slow__` → 一直不回；收到 `session/cancel` 后回 cancelled 并说明
 * ==========================================================================*/
import { createInterface } from 'node:readline';

let nextId = 1;
const pending = new Map();
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

const SESSION = 'fake-session-1';
let cancelled = false;
// `--acp-model` 单测用：session/new 报一个默认模型，set_config_option 改它，
// 之后的回复把当前模型带出来 —— 这样测试断言的是"真的切了"，不是"发了个请求"。
let model = 'fake/model-default';

async function prompt(params) {
  const text = String(params?.prompt?.[0]?.text ?? '');
  if (text.includes('__die__')) {
    process.stderr.write('[fake-acp] 按指示退出\n');
    process.exit(3);
  }
  const chunk = (t) =>
    notify('session/update', { sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } });

  if (text.includes('__slow__')) {
    cancelled = false;
    while (!cancelled) await new Promise((r) => setTimeout(r, 50));
    chunk('（已按取消停止）');
    return { stopReason: 'cancelled' };
  }

  chunk('你好，');
  chunk('我是假 agent。');
  chunk(`（model=${model}）`);
  notify('session/update', {
    sessionId: SESSION,
    update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash: echo hi', name: 'Bash', status: 'pending' },
  });
  // C1 策略单测用：prompt 里带 `__perm:Write hello.txt__` / `__kind:edit__` 就换这条权限请求
  // 的工具（默认还是 Bash: echo hi）—— 这样不必再写第二个假 agent。
  const permTitle = text.match(/__perm:(.*?)__/)?.[1]?.trim() || 'Bash: echo hi';
  const permKind = text.match(/__kind:([a-z_]+)__/)?.[1] ?? '';
  const toolCall = { toolCallId: 't1', title: permTitle, name: permTitle.split(/[:\s]/)[0] || permTitle };
  if (permKind) toolCall.kind = permKind;
  const permission = await request('session/request_permission', {
    sessionId: SESSION,
    toolCall,
    options: [
      { optionId: 'a1', name: '允许一次', kind: 'allow_once' },
      { optionId: 'a2', name: '总是允许', kind: 'allow_always' },
      { optionId: 'r1', name: '拒绝一次', kind: 'reject_once' },
      { optionId: 'r2', name: '总是拒绝', kind: 'reject_always' },
    ],
  });
  const outcome = permission?.result?.outcome ?? permission?.outcome ?? {};
  chunk(`（权限=${outcome.outcome === 'selected' ? outcome.optionId : outcome.outcome ?? '无'}）`);
  return { stopReason: 'end_turn' };
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  // 我们发出去的请求的回执
  if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined) && pending.has(Number(frame.id))) {
    pending.get(Number(frame.id))(frame);
    pending.delete(Number(frame.id));
    return;
  }
  if (frame.method === 'session/cancel') {
    cancelled = true;
    process.stderr.write('[fake-acp] 收到 session/cancel\n');
    return;
  }
  if (frame.method === 'initialize') {
    send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp', version: '1' }, agentCapabilities: {} } });
    return;
  }
  if (frame.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: frame.id,
      result: {
        sessionId: SESSION,
        configOptions: [
          { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
            options: [{ value: 'fake/model-default', name: 'default' }, { value: 'fake/model-x', name: 'x' }] },
        ],
      },
    });
    return;
  }
  if (frame.method === 'session/set_config_option') {
    // opencode v2 用的就是这条；老 `session/set_model` 已废弃（Method not found）
    if (frame.params?.configId === 'model') model = String(frame.params?.value ?? model);
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    return;
  }
  if (frame.method === 'session/prompt') {
    const result = await prompt(frame.params);
    send({ jsonrpc: '2.0', id: frame.id, result });
    return;
  }
  send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `不认识 ${frame.method}` } });
});
