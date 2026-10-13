/* ============================================================================
 * agent-io/acp.ts · ACP 后端（**首选**接入方式）
 *
 * ## 它做什么
 *
 * 把一个**说 ACP（Agent Client Protocol）的 agent 进程**接进房间：
 * 我们当 **ACP 客户端**，它当 ACP agent。房间消息 → `session/prompt`；
 * agent 的流式输出 → 房间回复；工具调用与权限请求 → **在房间里看得见**（B4）。
 *
 * 为什么这是首选（见 docs/agent-as-member-plan.md §1 ⑦）：
 *   · 每接一个 agent 只是**换一份 spawn 配置**（`claude-code-acp`、它家自己的 ACP agent…），
 *     我们不用为每个框架写适配；
 *   · 模型/凭据/provider 全在 agent 那边（我们只在 spawn 时注入环境），符合决策⑥；
 *   · ACP 自带会话保活、取消、权限请求、工具调用可见 —— 这些不用我们自己发明。
 *
 * ## 边界（别越）
 *
 * · **不实现 `fs/*` 与 `terminal/*`**：`initialize` 里我们**不声明**这些能力，
 *   agent 就会用它自己的工具（在 `cwd` 沙箱里干活）。声明了反而要替它读写文件，
 *   多一份攻击面。
 * · **权限默认拒绝**（决策⑤）；C1 起有四种策略（`deny` / `allow-all` / `allow-list` /
 *   `read-only`，见 `AcpBrainOptions.permission`）。无论批不批，都会在房间里说出来
 *   （不能偷偷拒绝），而且**说出理由**（命中白名单哪条 / 只读策略为什么放行）。
 * · 一轮 prompt 有硬超时（默认 5 分钟）：超时就 `session/cancel` 并如实说明，
 *   不把"卡住"伪装成"没回答"。
 *
 * ## 实测过的对端（2026-10-12）
 *
 * `@zed-industries/claude-code-acp` 0.16.2（ACP SDK 0.14.1）：
 * `initialize` / `session/new` / `session/prompt` / `session/update`（`agent_message_chunk`、
 * `tool_call`）/ `session/request_permission` 都验证过。它没有实现 `providers/*`（还是 UNSTABLE）。
 * ==========================================================================*/

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AgentBrain, ChatContext, IncomingMessage } from './index.ts';

export interface AcpBrainOptions {
  /** ACP agent 可执行文件（默认 `claude-code-acp`，走 PATH / node_modules/.bin） */
  bin: string;
  /** 追加给它的参数 */
  args?: string[];
  /** 会话工作目录（agent 的"地面"；必须是绝对路径） */
  cwd: string;
  /**
   * 权限策略（C1）：
   *   `deny`（默认）—— 一律选 `reject_*`（决策⑤：默认拒绝）
   *   `allow-all`   —— 一律选 `allow_*`（**只为把功能对出来**，别长期这么跑）
   *   `allow-list`  —— 只批 `allowList` 命中的工具（固定白名单）
   *   `read-only`   —— 只批"读"类：`kind=read/search/think`，或名字/标题命中内置只读表
   */
  permission?: 'deny' | 'allow-all' | 'allow-list' | 'read-only';
  /** `allow-list` 的白名单（大小写不敏感；匹配工具 `name` 全等或 `title` 子串） */
  allowList?: string[];
  /**
   * 过程可见（B4）：
   *   `tools`（默认）—— 每个工具调用在房间里发一行（同名 3 秒内合并）
   *   `off`           —— 只发最终回复
   */
  narrate?: 'tools' | 'off';
  /** 一轮 prompt 的硬超时（毫秒，默认 5 分钟） */
  promptTimeoutMs?: number;
  /**
   * 指定会话使用的模型（`provider/model`，如 `opencode-go/deepseek-v4-flash`）。
   * 不指定就用 agent 自己的默认 —— 但**会把当前模型打进日志**，省掉
   * "接上了却不回"时的一半排查（比如某个模型临时不可用）。
   */
  model?: string;
  log?: (line: string) => void;
}

interface Pending {
  resolve: (frame: any) => void;
}

/** 当前这一轮 prompt 的状态（流式文本 + 往哪个房间播报 + 被取消时的出口） */
interface Turn {
  chunks: string[];
  ctx: ChatContext;
  done?: (reason: string) => void;
}

/** C1 只读预设：ACP 工具 kind 里的"读"类 */
const READ_KINDS = new Set(['read', 'search', 'think']);
/** C1 只读预设的内置工具名（兜底：有些 agent 不填 kind；匹配 name 全等或 title 子串） */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'List', 'NotebookRead'];

/** 大小写不敏感：`name` 全等 或 `title` 子串 就命中；返回命中的那条（给播报用） */
function hitsTool(patterns: string[], tool: { name: string; title: string }): string | null {
  const name = tool.name.trim().toLowerCase();
  const title = tool.title.toLowerCase();
  for (const raw of patterns) {
    const pat = String(raw ?? '').trim().toLowerCase();
    if (!pat) continue;
    if ((name && name === pat) || title.includes(pat)) return raw;
  }
  return null;
}

export class AcpBrain implements AgentBrain {
  #opts: Required<Omit<AcpBrainOptions, 'args' | 'log' | 'model'>> &
    Pick<AcpBrainOptions, 'args' | 'log' | 'model'>;
  /** ⚠️ 不是 `ChildProcessWithoutNullStreams`：stderr 是 `inherit`（agent 日志直接进我们这侧） */
  #proc: ChildProcessByStdio<Writable, Readable, null> | null = null;
  #lines: Interface | null = null;
  #sessionId: string | null = null;
  #agentName = 'ACP agent';
  #nextId = 1;
  #pending = new Map<number, Pending>();
  /** 当前这一轮：攒流式文本 + 记住往哪个房间说话（工具调用要 narrate 进去） */
  #turn: Turn | null = null;
  /** 同名工具调用的最近一次播报时间（避免一次思考刷屏） */
  #narrated = new Map<string, number>();

  constructor(opts: AcpBrainOptions) {
    // C2：cwd 就是 agent 的"地面"（沙箱边界）—— 必须是绝对路径（相对路径会让
    // spawn 以"适配器进程当时的 cwd"为基准悄悄跑偏，那种漂移最难查）
    if (!isAbsolute(opts.cwd)) {
      throw new Error(`ACP cwd 必须是绝对路径（收到：${opts.cwd}）—— 见 --acp-cwd`);
    }
    this.#opts = {
      bin: opts.bin,
      cwd: opts.cwd,
      permission: opts.permission ?? 'deny',
      allowList: opts.allowList ?? [],
      narrate: opts.narrate ?? 'tools',
      promptTimeoutMs: opts.promptTimeoutMs ?? 5 * 60 * 1000,
      args: opts.args,
      model: opts.model,
      log: opts.log,
    };
  }

  #log(line: string) {
    this.#opts.log?.(line);
  }

  /* ------------------------------------------------------------ 懒启动 */

  async #ensure(): Promise<void> {
    if (this.#proc && this.#sessionId) return;
    // C2：沙箱目录不在就明确拒绝 —— 别让 spawn 抛一个只带 ENOENT 的天书错误
    if (!existsSync(this.#opts.cwd) || !statSync(this.#opts.cwd).isDirectory()) {
      throw new Error(
        `ACP 沙箱目录不存在或不是目录：${this.#opts.cwd}` +
          '（--acp-cwd 指到专用目录；建议低权限账号/容器里跑，见 deploy/agent/README.md）',
      );
    }
    const child = spawn(this.#opts.bin, this.#opts.args ?? [], {
      cwd: this.#opts.cwd,
      // stdout 只跑 ACP 协议；它的日志走 stderr（继承到我们这一侧）
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.#proc = child;
    child.on('exit', (code, signal) => {
      this.#log(`[acp] agent 进程退出 code=${code} signal=${signal}（下次说话时会重新拉起）`);
      this.#proc = null;
      this.#sessionId = null;
      this.#lines?.close();
      this.#lines = null;
      for (const p of this.#pending.values()) p.resolve({ error: { message: 'agent 进程已退出' } });
      this.#pending.clear();
      this.#turn?.done?.('cancelled');
      this.#turn = null;
    });
    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on('line', (line) => this.#onLine(line));

    const init = await this.#request('initialize', {
      protocolVersion: 1,
      // ⚠️ 刻意**不声明** fs / terminal 能力：那些要我们替 agent 读写文件/开终端，
      //    多一份攻击面；不声明它就用自己的工具（在 cwd 里）。见文件头"边界"。
      clientCapabilities: {},
      clientInfo: { name: 'iroh-room-bridge', version: '1' },
    });
    if (init.error) throw new Error(`ACP initialize 失败：${init.error.message ?? JSON.stringify(init.error)}`);
    this.#agentName = init.result?.agentInfo?.name ?? 'ACP agent';

    const session = await this.#request('session/new', { cwd: this.#opts.cwd, mcpServers: [] });
    if (session.error || !session.result?.sessionId) {
      throw new Error(`ACP session/new 失败：${session.error?.message ?? '没有 sessionId'}`);
    }
    this.#sessionId = session.result.sessionId as string;
    this.#log(`[acp] 已连接 ${this.#agentName}（session=${String(this.#sessionId).slice(0, 8)}…，cwd=${this.#opts.cwd}）`);

    // 模型：ACP 用 config options 表达（opencode v2 只认 `session/set_config_option`；
    // 老的 `session/set_model` 已废弃、会回 Method not found —— 2026-10-13 实测）。
    const modelOption = (
      session.result?.configOptions as
        | Array<{ id?: string; category?: string; currentValue?: string }>
        | undefined
    )?.find((o) => o?.category === 'model' || o?.id === 'model');
    if (this.#opts.model) {
      const res = await this.#request('session/set_config_option', {
        sessionId: this.#sessionId,
        configId: modelOption?.id ?? 'model',
        value: this.#opts.model,
      });
      if (res.error) {
        throw new Error(
          `ACP 切换模型失败（--acp-model ${this.#opts.model}）：${res.error.message ?? JSON.stringify(res.error)}`,
        );
      }
      this.#log(`[acp] 已指定模型：${this.#opts.model}`);
    } else if (modelOption?.currentValue) {
      this.#log(
        `[acp] 当前模型：${modelOption.currentValue}（要换：--acp-model <provider/model>；` +
          '可用模型列表用 agent 自己的命令查，如 opencode models）',
      );
    }
  }

  /* -------------------------------------------------------- JSON-RPC 收发 */

  #request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    const id = this.#nextId++;
    const proc = this.#proc;
    if (!proc) return Promise.resolve({ error: { message: 'agent 未启动' } });
    return new Promise((resolve) => {
      this.#pending.set(id, { resolve });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      if (timeoutMs) {
        // ⚠️ 必须 `unref()`：否则这一轮已经答完之后，这个计时器还会把事件循环多留
        //    `timeoutMs`（默认 5 分钟！）—— 表现为"测试/进程迟迟不退出"（实测踩到）。
        const timer = setTimeout(() => {
          if (!this.#pending.has(id)) return;
          this.#pending.delete(id);
          resolve({ error: { message: `等待 ${method} 超时（${Math.round(timeoutMs / 1000)}s）` } });
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  #respond(id: number, result: unknown) {
    this.#proc?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  /**
   * 发**通知**（没有 id、不等回执）。
   *
   * ⚠️ `session/cancel` 在 ACP 里是 notification（见 CancelNotification 的定义）——
   * 当成请求发会永远等不到回执，白挂一个 pending（第一版就是这么写的）。
   */
  #notify(method: string, params: unknown) {
    this.#proc?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #respondError(id: number, code: number, message: string) {
    this.#proc?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  #onLine(line: string) {
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // 不是 JSON 就不是协议帧（正常不该出现：stdout 只跑协议）
    }
    // ① 我们发出去的请求的回执
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const pending = this.#pending.get(Number(frame.id));
      if (pending) {
        this.#pending.delete(Number(frame.id));
        pending.resolve(frame);
      }
      return;
    }
    // ② 通知：流式输出与工具调用
    if (frame.method === 'session/update') {
      this.#onUpdate(frame.params ?? {});
      return;
    }
    // ③ agent 反过来请求我们（权限 / fs / 终端 …）
    if (frame.id !== undefined && frame.method) {
      if (frame.method === 'session/request_permission') {
        this.#onPermissionRequest(frame);
        return;
      }
      // 没声明对应能力却收到了：**如实回"不支持"**，别假装支持（假装会让它以为文件写成功了）
      this.#respondError(Number(frame.id), -32601, `客户端不提供 ${frame.method}`);
    }
  }

  #onUpdate(params: any) {
    const update = params.update ?? {};
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.type === 'text' ? String(update.content.text ?? '') : '';
      if (text) this.#turn?.chunks.push(text);
      return;
    }
    if (update.sessionUpdate === 'tool_call') {
      this.#narrateTool(String(update.title ?? update.name ?? '工具'), update.toolCallId);
    }
  }

  /** 工具调用播报（B4）：同名 3 秒内只发一条，别把房间刷成日志 */
  #narrateTool(title: string, toolCallId?: string) {
    if (this.#opts.narrate !== 'tools' || !this.#turn?.ctx) return;
    const key = `${toolCallId ?? title}`;
    const now = Date.now();
    if (now - (this.#narrated.get(key) ?? 0) < 3000) return;
    this.#narrated.set(key, now);
    void this.#turn.ctx.say(`🔧 ${title}`).catch(() => {});
  }

  /** 权限请求（B4 + C1）：**无论批不批都在房间里说出来，且说出理由** */
  #onPermissionRequest(frame: any) {
    const options: any[] = frame.params?.options ?? [];
    const tool = {
      name: String(frame.params?.toolCall?.name ?? ''),
      title: String(frame.params?.toolCall?.title ?? ''),
      kind: String(frame.params?.toolCall?.kind ?? ''),
    };
    const title = tool.title || tool.name || '一个操作';
    const { allow, verdict } = this.#decide(tool);
    const wanted = allow ? ['allow_always', 'allow_once'] : ['reject_always', 'reject_once'];
    const picked = wanted.map((kind) => options.find((o) => o.kind === kind)).find(Boolean) ?? options[0];
    if (this.#turn?.ctx) {
      void this.#turn.ctx.say(`⚠️ 它想做：${title} —— ${verdict}`).catch(() => {});
    }
    if (!picked) {
      this.#respond(Number(frame.id), { outcome: { outcome: 'cancelled' } });
      return;
    }
    this.#respond(Number(frame.id), { outcome: { outcome: 'selected', optionId: picked.optionId } });
  }

  /** C1：权限策略的唯一决策点 —— 放不放行 + 给人看的理由（理由一律进房间） */
  #decide(tool: { name: string; title: string; kind: string }): { allow: boolean; verdict: string } {
    switch (this.#opts.permission) {
      case 'allow-all':
        return { allow: true, verdict: '已按 allow-all 批准' };
      case 'allow-list': {
        const hit = hitsTool(this.#opts.allowList, tool);
        return hit
          ? { allow: true, verdict: `已按白名单批准（命中「${hit}」）` }
          : { allow: false, verdict: '已拒绝（不在白名单）' };
      }
      case 'read-only': {
        const kind = tool.kind.trim().toLowerCase();
        if (READ_KINDS.has(kind)) {
          return { allow: true, verdict: `已按只读策略批准（kind=${kind}）` };
        }
        const hit = hitsTool(READ_ONLY_TOOLS, tool);
        return hit
          ? { allow: true, verdict: `已按只读策略批准（命中「${hit}」）` }
          : { allow: false, verdict: '已拒绝（只读策略只放行读类操作）' };
      }
      default:
        return { allow: false, verdict: '已拒绝（默认策略）' };
    }
  }

  /* ------------------------------------------------------------- 对外接口 */

  async onMessage(msg: IncomingMessage, ctx: ChatContext): Promise<string | null> {
    const text = String(msg.text ?? '').trim();
    if (!text) return null;
    await this.#ensure();

    const turn: Turn = { chunks: [], ctx };
    this.#turn = turn;
    const timeoutMs = this.#opts.promptTimeoutMs;
    const response = await new Promise<any>((resolve) => {
      turn.done = () => resolve({ error: { message: '这一轮被取消' } });
      this.#request('session/prompt', {
        sessionId: this.#sessionId,
        prompt: [{ type: 'text', text }],
      }, timeoutMs).then(resolve);
    });
    if (this.#turn === turn) this.#turn = null;

    const answer = turn.chunks.join('').trim();
    if (response.error) {
      const why = String(response.error.message ?? '未知错误');
      // 超时：主动取消，别让它继续在那边跑（也顺便把"卡住"变成一句人话）
      if (/超时/.test(why)) {
        this.#notify('session/cancel', { sessionId: this.#sessionId });
        return answer ? `${answer}\n\n（上面这轮还没答完就超时了，我先把它停住）` : `这轮超时了（${why}），我先停下它。`;
      }
      if (answer) return answer;
      throw new Error(`ACP 这一轮失败：${why}`);
    }
    return answer || null;
  }

  async close(): Promise<void> {
    if (this.#sessionId) this.#notify('session/cancel', { sessionId: this.#sessionId });
    this.#lines?.close();
    this.#proc?.stdin.end();
    this.#proc?.kill('SIGTERM');
    // 给它 1.5s 体面退出，然后强杀（别让退出流程卡住 systemd）
    const proc = this.#proc;
    setTimeout(() => proc?.kill('SIGKILL'), 1500).unref?.();
    this.#proc = null;
    this.#sessionId = null;
  }
}

export async function createAcpBrain(opts: AcpBrainOptions): Promise<AcpBrain> {
  if (!opts.cwd?.startsWith('/')) throw new Error('--acp-cwd 必须是绝对路径');
  return new AcpBrain(opts);
}
