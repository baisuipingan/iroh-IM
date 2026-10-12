/* ============================================================================
 * mod.ts · 库入口（给"自己不写 CLI、直接嵌进 pi 的 SDK 会话"的用法）
 *
 * 例：
 *   import { AgentClient, ChatAdapter } from './agent-pi/src/mod.ts';
 *   const client = new AgentClient({ bin: 'iroh-agent', args: ['--room','X','--nick','小助手'] });
 *   await client.start();
 *   const adapter = new ChatAdapter({ client, brain: myPiBrain, room: 'X' });
 *   adapter.start();
 * ==========================================================================*/

// room side：传输（行协议 + 子进程）与成员策略（触发/闸门）
export * from './room/protocol.ts';
export * from './room/client.ts';
export * from './room/adapter.ts';
// agent-io：可插的 agent 接口与后端（acp 首选 / command 兜底 / pi-sdk / rule 测试替身）
export * from './agent-io/index.ts';
export * from './agent-io/rule.ts';
export * from './agent-io/command.ts';
export * from './agent-io/tools.ts';
