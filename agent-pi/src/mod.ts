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

export * from './protocol.ts';
export * from './brain.ts';
export * from './client.ts';
export * from './adapter.ts';
export * from './brains/rule.ts';
export * from './brains/command.ts';
