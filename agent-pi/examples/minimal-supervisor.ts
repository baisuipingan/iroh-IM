#!/usr/bin/env node
/* ============================================================================
 * minimal-supervisor.ts · **适配器契约**的最小示例（别的语言照着移植即可）
 *
 * 它只做四件事，而且**不 import 仓库里任何代码** —— 目的正是证明：
 * 把一个 agent 接进房间需要的**只有那份行协议**，既不需要我们的 TS 实现，
 * 更不需要"每个语言都有 iroh 绑定"（见 docs/agent-as-member-plan.md 硬约束）。
 *
 *   1. 起 `iroh-agent serve`（搬运侧），stdin/stdout 按行读写 JSON
 *   2. 等 hello，并校验 chatProtocol（契约：不匹配就拒绝启动）
 *   3. 收到 **@<我的 id8>** 的消息 → 回一条文本
 *   4. 收到 SIGINT/SIGTERM → 优雅退出
 *
 * 跑法（PATH 里有 iroh-agent，或用 IROH_AGENT_BIN 指）：
 *
 *   IROH_AGENT_BIN=/opt/iroh-agent/bin/agent \
 *   node --experimental-strip-types agent-pi/examples/minimal-supervisor.ts \
 *     --room 我的房间 --nick 最小助手
 *
 * ⚠️ 这只是"最小可跑"，没有冷却/去重/文件闸门 —— 那些是**成员策略**，
 *    要长期跑请用 agent-pi（`src/room/` 里是同一套契约的完整实现）。
 * ==========================================================================*/
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
};

const bin = process.env.IROH_AGENT_BIN ?? 'iroh-agent';
const room = arg('room', 'lobby');
const nick = arg('nick', '最小助手');
const SUPPORTED = 'v6'; // 这份示例支持的聊天协议版本（Rust 侧 sigfmt::PROTO_V6）

const child = spawn(bin, ['serve', '--room', room, '--nick', nick], {
  stdio: ['pipe', 'pipe', 'inherit'],   // 日志走 stderr（继承），stdout 只跑协议
});
const say = (text: string) =>
  child.stdin.write(`${JSON.stringify({ v: 1, id: String(++seq), cmd: 'say', text })}\n`);

let seq = 0;
let myId = '';
let myId8 = '';

createInterface({ input: child.stdout }).on('line', (line) => {
  let frame: any;
  try {
    frame = JSON.parse(line);
  } catch {
    return; // 不是协议帧就忽略（正常情况不会出现：stdout 只跑协议）
  }

  if (frame.type === 'hello') {
    // 契约第一条：先握手，版本不匹配就拒绝启动（宁可起不来，也别在房间里"半死不活"）
    if (frame.chatProtocol !== SUPPORTED) {
      console.error(`[最小示例] 协议不匹配：agent 报 ${frame.chatProtocol}，本示例只支持 ${SUPPORTED}`);
      child.kill();
      process.exit(1);
    }
    myId = String(frame.endpointId);
    myId8 = myId.slice(0, 8).toLowerCase();
    console.error(`[最小示例] 就绪：${frame.nickname}（@${myId8}）已在房间 ${room}`);
    return;
  }

  if (frame.type === 'reply' && frame.ok === false) {
    console.error('[最小示例] 命令被拒：', frame.error?.message ?? frame.error);
    return;
  }

  if (frame.type === 'event' && frame.event?.type === 'message') {
    const m = frame.event.message ?? {};
    const text = String(m.text ?? '');
    // 触发：**先看结构化 mentions（V6 的寻址真相）**，其次才是文本 `@<我的 id8>`
    // （v5 消息 / 人手打的 token）。昵称只给人看 —— 见方案 §4 R1。
    const mentions = Array.isArray(m.mentions) ? m.mentions : [];
    const hit = (myId && mentions.includes(myId)) || (myId8 && text.includes(`@${myId8}`));
    if (m.mine || !hit) return;
    const body = myId8 ? text.replace(`@${myId8}`, '').trim() : text.trim();
    say(body ? `收到：${body}` : '收到');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // 优雅退出：先请 daemon 收摊，再把它带走
    child.stdin.write(`${JSON.stringify({ v: 1, id: String(++seq), cmd: 'shutdown', reason: signal })}\n`);
    setTimeout(() => {
      child.kill(signal);
      process.exit(0);
    }, 300);
  });
}
child.on('exit', (code) => {
  console.error(`[最小示例] agent 进程退出 code=${code}`);
  process.exit(code ?? 0);
});
