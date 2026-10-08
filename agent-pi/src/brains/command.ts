/* ============================================================================
 * brains/command.ts · 子进程大脑 —— 把每条消息交给一个命令行程序，取 stdout 当回复
 *
 * 这是**与具体 agent 框架无关**的接法，也是接 pi 的最短路径（print 模式）：
 *   node src/cli.ts --room X --nick 小助手 \
 *     --brain command --command pi --args '["-p","{prompt}"]'
 *
 * 另一种接法（pi 的 SDK）不需要这个类：直接 import ChatAdapter 自己写 main，
 * 在 onMessage 里调 SDK —— 见 README「接 pi」。
 *
 * 设计取舍：
 * - **串行化**：消息密集时排队而不是并发起一堆进程（agent 会话天然有状态）
 * - **超时必杀**：SIGKILL 兜底，绝不留下挂死的子进程
 * - **输出截断**：stdout 只留前 N 字节，避免一个失控命令把内存吃光
 * ==========================================================================*/

import { spawn } from 'node:child_process';
import process from 'node:process';
import { renderTemplate } from '../brain.ts';
import type { AgentBrain, ChatContext, IncomingMessage } from '../brain.ts';

export interface CommandBrainOptions {
  command: string;
  args?: string[];
  /** {text}/{raw}/{nick}/{room}/{bot} 模板；默认 `{text}`（触发后的文本）。 */
  promptTemplate?: string;
  /** `stdin`（默认）：prompt 写进标准输入；`arg`：替换 args 里的 `{prompt}` 占位符。 */
  input?: 'stdin' | 'arg';
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  maxOutputBytes?: number;
}

export class CommandBrain implements AgentBrain {
  #command: string;
  #args: string[];
  #promptTemplate: string;
  #input: 'stdin' | 'arg';
  #timeoutMs: number;
  #cwd: string | undefined;
  #env: Record<string, string | undefined> | undefined;
  #maxOutputBytes: number;
  /** 串行链：上一条处理完才起下一条进程 */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(opts: CommandBrainOptions) {
    this.#command = opts.command;
    this.#args = opts.args ?? [];
    this.#promptTemplate = opts.promptTemplate ?? '{text}';
    this.#input = opts.input ?? 'stdin';
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
    this.#cwd = opts.cwd;
    this.#env = opts.env;
    this.#maxOutputBytes = opts.maxOutputBytes ?? 32 * 1024;
  }

  onMessage(msg: IncomingMessage, ctx: ChatContext): Promise<string | null> {
    const prompt = renderTemplate(this.#promptTemplate, { ...msg, rawText: msg.raw.text });
    const run = this.#chain.then(() => this.#run(prompt, ctx));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  #run(prompt: string, ctx: ChatContext): Promise<string | null> {
    return new Promise((resolve) => {
      let args = [...this.#args];
      if (this.#input === 'arg') {
        let replaced = false;
        args = args.map((arg) => {
          if (!arg.includes('{prompt}')) return arg;
          replaced = true;
          return arg.replaceAll('{prompt}', prompt);
        });
        if (!replaced) args.push(prompt);
      }

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.#command, args, {
          cwd: this.#cwd,
          env: { ...process.env, ...this.#env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        ctx.log(`[command] 启动失败：${(e as Error).message}`);
        resolve(null);
        return;
      }

      let stdout = '';
      let stderr = '';
      let overflowed = false;
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, this.#timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length >= this.#maxOutputBytes * 2) {
          overflowed = true;
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        ctx.log(`[command] ${this.#command} 出错：${e.message}`);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          ctx.log(`[command] ${this.#command} 超时（${this.#timeoutMs}ms），已杀`);
          resolve(null);
          return;
        }
        if (code !== 0) {
          ctx.log(`[command] ${this.#command} 退出码 ${code}：${stderr.trim().slice(0, 500)}`);
          resolve(null);
          return;
        }
        const text = stdout.trim();
        if (!text) {
          resolve(null);
          return;
        }
        if (Buffer.byteLength(text, 'utf8') > this.#maxOutputBytes || overflowed) {
          // 截断交给适配器（那里有 UTF-8 安全的 truncateUtf8）——这里先截个大概
          resolve(text.slice(0, this.#maxOutputBytes));
          return;
        }
        resolve(text);
      });

      if (this.#input === 'stdin') {
        child.stdin?.write(prompt);
      }
      child.stdin?.end();
    });
  }
}
