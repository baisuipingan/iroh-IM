#!/usr/bin/env node
/* ============================================================================
 * cli.ts · agent-pi 命令行入口
 *
 * 做三件事：拉起 iroh-agent serve（行协议）→ 组装 brain → 转发信号做优雅退出。
 * 用法见 README；协议见 docs/agent-daemon-protocol.md。
 * ==========================================================================*/

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { ChatAdapter } from './room/adapter.ts';
import type { AgentBrain } from './agent-io/index.ts';
import { AgentClient } from './room/client.ts';
import { CommandBrain } from './agent-io/command.ts';
import { defaultRules, parseRuleSpecs, RuleBrain } from './agent-io/rule.ts';
import { ensureLocalConfig } from './room/bootstrap.ts';
import { announceProfileOnJoin } from './room/profile.ts';

/**
 * 默认接入站点：本机缺配置时从这里拉 relay-config.json。
 * `--server off`（或空串）关闭引导；环境变量 `IROH_AGENT_SERVER` 可换默认值。
 */
const DEFAULT_SERVER = 'https://im.pinkstar.cc';

const USAGE = `agent-pi · 把 Agent 接进 iroh 聊天室（常驻成员）

用法：
  room-bridge --room <房间> [--nick 名字] [--brain rule|command|pi-sdk|acp] [选项]
  （仓库里跑同一条命令：node src/cli.ts --room <房间> …，参数完全一致）

常用：
  --room X              房间名（必填；房间名就是访问凭据）
  --nick NAME           房间里的显示名（同时作为默认 @提及名）
  --agent-bin PATH      iroh-agent 二进制（默认 $IROH_AGENT_BIN 或 PATH 里的 iroh-agent）
  --agent-args JSON     追加给 serve 的参数（如 '["--nick","覆盖名"]'）
  --brain rule|command|pi-sdk|acp
                        大脑类型（默认 rule）
  --mention NAME        @提及触发（默认用 --nick；--no-mention 关掉）
                        ⚠️ 触发方式只有 @ —— 原来的 ! 前缀已于 2026-10-12 删除
  --respond-to-all      所有消息都触发（噪音大，慎用）
  --cooldown-ms 3000    两次回复的最小间隔
  --ping-interval-ms 45000  serve 看门狗（0 = 关）

接入引导（第一次用建议带着）：
  --server URL          本机缺配置时，从这个站点拉 relay-config.json 自动补好
                        中继/令牌/入口/历史（默认 $IROH_AGENT_SERVER 或
                        https://im.pinkstar.cc；传 off 关闭）
  --refresh-config      强制重新拉取并覆盖中继/令牌/入口/历史（nickname 不动）

名片（房间里的人靠"名字 / 简介 / 发言"认识它）：
  --bio TEXT            一句话简介（≤160 字；换行压成空格）
  --tags a,b,c          标签（≤8 个，每个 ≤16 字）；进房后自动发布

文件接收策略：
  --files off|accept|reject  收到文件邀约怎么办（默认 off = 只记日志不接）
  --files-max-mb 64          accept 模式的大小上限（超过自动拒绝）
  --files-allow ID,ID        只接收这些发送方（EndpointId；不设 = 不限）
  --files-dir DIR            落盘目录（不设 = daemon 默认 <IROH_AGENT_HOME>/received/）
  --files-max-concurrent 2   并发接收上限（满了自动拒绝，让对端稍后重发）
  --files-max-total-mb 512   **累计**接收上限（单文件与并发都挡不住"反复发小文件"，
                             常驻 agent 长期跑必须靠它兜底；重启后重新计数）

rule brain：
  --rules PATH          规则文件（JSON，见 examples/rules.json；默认 ping→pong）

command brain（把消息交给任意命令，stdout 当回复）：
  --command CMD         要执行的命令（如 pi）
  --args JSON           参数数组，可含 {prompt} 占位（如 '["-p","{prompt}"]'）
  --prompt-template 'T' 提示词模板，默认 {text}；可用 {text}/{raw}/{nick}/{room}/{bot}
  --input stdin|arg     prompt 走 stdin（默认）还是替换进 --args
  --timeout-ms 120000   单条命令超时（SIGKILL 兜底）

pi-sdk 大脑（直接调 pi SDK；长会话，需 agent-pi 里装有 SDK）：
  --pi-system-prompt 'T' 覆盖默认人设（字面字符串）
  --pi-append-prompt 'T' 追加到人设之后的全局指令
  --pi-prompt-template 'T' 每条触发消息进模型的正文模板（默认 [{room}] {nick}：{text}）
  --pi-cwd DIR          会话工作目录（默认当前目录）
  --pi-tools VALUE      启用 pi 自带工具：none（默认）| read-only（read/grep/find/ls）| all | 逗号名单
                        ⚠️ bash/edit/write 有服务器执行权，房间内容不可信，慎开
  --pi-model provider/id     显式指定模型（如 hahacode/gpt-6.1-sol）；默认用 pi 的选择
  --tools weather,fetch_url 启用自定义工具（默认无）：
                        weather   查实时天气与预报（Open-Meteo，免 key）
                        fetch_url 抓取 https 链接文本（带 SSRF/体积/重定向防线）
  --fetch-allow a.com,b.com fetch_url 的域名白名单（不设 = 只靠内置防线）

acp 后端（首选接入口；agent 换一个 = 换一份 spawn 配置）：
  --acp-bin PATH        ACP agent 可执行文件（默认 claude-code-acp）
  --acp-args JSON       追加给它的参数
  --acp-cwd DIR         会话工作目录 = **沙箱边界**（必须绝对路径；给专用目录、低权限账号跑）
  --acp-permission deny|allow-all|allow-list|read-only
                        权限策略（C1，默认 deny）：allow-list 需配 --acp-allow；
                        read-only 只放行读类（kind=read/search/think 或 Read/Grep…）
  --acp-allow A,B       白名单（大小写不敏感；匹配工具名或标题子串）
  --acp-narrate tools|off  工具调用/权限请求是否在房间里播报（默认 tools）
  --acp-timeout-ms 300000  单轮 prompt 硬超时

成本闸门（C3，对所有 brain 生效）：
  --budget-turns N      滑动窗口内最多起几轮（默认 0 = 不限）
  --budget-window-min M 窗口长度（分钟，默认 60）

示例：
  # 第一次接入（本机没配置也能直接进房）
  node src/cli.ts --room 我的房间 --nick 小助手 --bio '会查代码' --tags ts,rust \\
    --brain acp --acp-bin claude-code-acp

  # 规则模式（最快冒烟）
  IROH_AGENT_HOME=~/.config/iroh-agent node src/cli.ts --room 我的房间 --nick 小助手 --rules examples/rules.json

  # pi print 模式（每次触发起一次 pi，取 stdout 当回复）
  node src/cli.ts --room 我的房间 --nick 小助手 --brain command --command pi --args '["-p","{prompt}"]'

  # pi SDK 模式（长会话有记忆；认证/模型走 ~/.pi/agent 的 models.json）
  node src/cli.ts --room 我的房间 --nick 小助手 --brain pi-sdk \
    --pi-model hahacode/gpt-6.1-sol
`;

const VALUE_FLAGS = new Set([
  'room',
  'nick',
  'agent-bin',
  'agent-args',
  'brain',
  'rules',
  'command',
  'args',
  'prompt-template',
  'input',
  'timeout-ms',
  'mention',
  'cooldown-ms',
  'max-reply-bytes',
  'ping-interval-ms',
  'pi-system-prompt',
  'pi-append-prompt',
  'pi-prompt-template',
  'pi-cwd',
  'acp-bin',
  'acp-args',
  'acp-cwd',
  'acp-permission',
  'acp-allow',
  'acp-narrate',
  'acp-timeout-ms',
  'budget-turns',
  'budget-window-min',
  'pi-tools',
  'pi-model',
  'tools',
  'fetch-allow',
  'server',
  'bio',
  'tags',
  'files',
  'files-max-mb',
  'files-allow',
  'files-dir',
  'files-max-concurrent',
  'files-max-total-mb',
]);
const BOOL_FLAGS = new Set(['no-mention', 'respond-to-all', 'help', 'refresh-config']);

interface Flags {
  room?: string;
  nick?: string;
  agentBin?: string;
  agentArgs?: string;
  brain?: string;
  rules?: string;
  command?: string;
  args?: string;
  promptTemplate?: string;
  input?: string;
  timeoutMs?: string;
  mention?: string;
  noMention?: boolean;
  respondToAll?: boolean;
  cooldownMs?: string;
  maxReplyBytes?: string;
  pingIntervalMs?: string;
  piSystemPrompt?: string;
  piAppendPrompt?: string;
  piPromptTemplate?: string;
  piCwd?: string;
  piTools?: string;
  piModel?: string;
  acpBin?: string;
  acpArgs?: string;
  acpCwd?: string;
  acpPermission?: string;
  acpAllow?: string;
  acpNarrate?: string;
  acpTimeoutMs?: string;
  budgetTurns?: string;
  budgetWindowMin?: string;
  tools?: string;
  fetchAllow?: string;
  server?: string;
  bio?: string;
  tags?: string;
  refreshConfig?: boolean;
  files?: string;
  filesMaxMb?: string;
  filesAllow?: string;
  filesDir?: string;
  filesMaxConcurrent?: string;
  filesMaxTotalMb?: string;
  help?: boolean;
}

function toCamel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function parseFlags(argv: string[]): Flags {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`);
    let name = arg.slice(2);
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (BOOL_FLAGS.has(name)) {
      flags[toCamel(name)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`未知参数：--${name}`);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined) throw new Error(`--${name} 缺值`);
      i += 1;
    }
    flags[toCamel(name)] = value;
  }
  return flags as Flags;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`数值参数非法：${value}`);
  return n;
}

function parseJsonArray(value: string, what: string): unknown[] {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${what} 必须是 JSON 数组`);
  return parsed;
}

/**
 * 加载 pi SDK 相关模块（`pi-sdk` / `tools`）。
 *
 * ⚠️ 这里**故意用"计算出来的"动态 import**（而不是字面量字符串），三条路都顾上：
 *   - 单文件版（bun --compile）构建时**看不到**这个依赖 ⇒ 不会把 pi SDK 打进单文件
 *     （它带原生模块 `*.node`，打进单文件不可靠、体积还要涨几十 MB）；
 *     运行时加载失败 → 抛出下面这句人话，而不是启动即崩。
 *   - 仓库版（`node --experimental-strip-types` 跑源码）→ 命中同目录的 `.ts`；
 *   - npm 版（`dist/cli.mjs`）→ 先试 `.ts`（node_modules 里禁用类型剥离，会失败），
 *     再命中同目录的编译产物 `.mjs`（npm 包里随包分发）。
 */
async function loadPiSdkModule(name: 'pi-sdk' | 'tools'): Promise<unknown> {
  const base = new URL('./agent-io/', import.meta.url);
  const failures: string[] = [];
  for (const ext of ['.ts', '.mjs']) {
    try {
      return await import(new URL(`${name}${ext}`, base).href);
    } catch (error) {
      failures.push(`${name}${ext}: ${(error as Error).message}`);
    }
  }
  throw new Error(
    `加载 ${name} 模块失败（pi-sdk 大脑需要 @earendil-works/pi-coding-agent）：` +
      `${failures.join('；')}。单文件版刻意不带它 —— ` +
      '改用 --brain acp / --brain command，或用仓库版（agent-pi 里先 npm ci）/ npm 版跑 pi-sdk',
  );
}

function buildBrain(flags: Flags, log: (line: string) => void): AgentBrain {
  const kind = flags.brain ?? 'rule';
  if (kind === 'rule') {
    let rules = defaultRules();
    if (flags.rules) {
      rules = parseRuleSpecs(JSON.parse(readFileSync(flags.rules, 'utf8')));
      log(`[cli] 已加载 ${rules.length} 条规则：${flags.rules}`);
    }
    return new RuleBrain(rules);
  }
  if (kind === 'command') {
    if (!flags.command) throw new Error('--brain command 需要 --command（要执行的程序）');
    return new CommandBrain({
      command: flags.command,
      args: flags.args ? (parseJsonArray(flags.args, '--args') as string[]) : [],
      promptTemplate: flags.promptTemplate,
      input: flags.input === 'arg' ? 'arg' : 'stdin',
      timeoutMs: num(flags.timeoutMs, 120_000),
    });
  }
  if (kind === 'pi-sdk') {
    // pi-sdk 是 async 工厂（创建 SDK 会话），单独走 AsyncBrain 包装
    return new AsyncBrain(async () => {
      const { createPiSdkBrain } = (await loadPiSdkModule(
        'pi-sdk',
      )) as typeof import('./agent-io/pi-sdk.ts');
      const { buildCustomTools, CUSTOM_TOOL_NAMES } = (await loadPiSdkModule(
        'tools',
      )) as typeof import('./agent-io/tools.ts');

      const tools = parsePiTools(flags.piTools);
      const wanted = (flags.tools ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const name of wanted) {
        if (!(CUSTOM_TOOL_NAMES as readonly string[]).includes(name)) {
          throw new Error(`未知自定义工具：${name}（可选：${CUSTOM_TOOL_NAMES.join(' | ')}）`);
        }
      }
      const customTools = buildCustomTools(wanted, {
        fetchAllow: flags.fetchAllow
          ? flags.fetchAllow
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        log: (...args2: unknown[]) => log(args2.map(String).join(' ')),
      });
      log(
        `[cli] pi-sdk 大脑：tools=${Array.isArray(tools) ? tools.join(',') : tools}` +
          `${wanted.length ? ` +自定义[${wanted.join(',')}]` : ''} ` +
          `model=${flags.piModel ?? '默认选择'} 人设=${flags.piSystemPrompt ? '自定义' : '默认'} cwd=${flags.piCwd ?? '当前目录'}`,
      );
      return await createPiSdkBrain({
        agentNick: flags.nick,
        // ⚠️ 这里**不要**传 `room`：`PiSdkBrainOptions` 没有这个字段
        //    （房间名来自每条消息，见 renderTemplate 的 {room}）。
        //    以前传了一个不存在的键 —— JS 不报错、TS 那时也没检查，纯属噪音。
        systemPrompt: flags.piSystemPrompt,
        appendSystemPrompt: flags.piAppendPrompt ? [flags.piAppendPrompt] : undefined,
        promptTemplate: flags.piPromptTemplate,
        cwd: flags.piCwd,
        tools,
        customTools,
        model: flags.piModel,
        log: (...args2: unknown[]) => log(args2.map(String).join(' ')),
      });
    });
  }
  if (kind === 'acp') {
    // ACP 后端（首选接入方式，见 docs/agent-as-member-plan.md §1 ⑦）：
    // 我们是 ACP 客户端，agent 是 ACP 服务端 —— 换 agent 只换这一份 spawn 配置。
    return new AsyncBrain(async () => {
      // ⚠️ 动态 import：没装 ACP agent 时，其它三条路照常能用
      const { createAcpBrain } = await import('./agent-io/acp.ts');
      const cwd = flags.acpCwd ?? process.cwd();
      // C1：四种策略；拼错/没给一律落回最安全的 deny
      const permission =
        (['allow-all', 'allow-list', 'read-only'] as const).find(
          (mode) => flags.acpPermission === mode,
        ) ?? 'deny';
      const allowList = flags.acpAllow
        ? flags.acpAllow
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      if (permission === 'allow-list' && !allowList.length) {
        throw new Error('--acp-permission=allow-list 需要 --acp-allow（如 --acp-allow Read,Grep）');
      }
      if (permission === 'allow-all') {
        // 不阻止（用户明确要求），但必须说出来 —— 房间里任何人都可能诱导它执行命令
        log(
          '[cli] ⚠️ --acp-permission=allow-all：agent 的工具调用**一律放行**。' +
            '这只适合"把功能对出来"，长期跑请改用 allow-list / read-only（C1）',
        );
      }
      log(
        `[cli] acp 后端：bin=${flags.acpBin ?? 'claude-code-acp'} cwd=${cwd} ` +
          `permission=${permission}${permission === 'allow-list' ? `（白名单：${allowList.join(',')}）` : ''} ` +
          `narrate=${flags.acpNarrate === 'off' ? 'off' : 'tools'}`,
      );
      return await createAcpBrain({
        bin: flags.acpBin ?? 'claude-code-acp',
        args: flags.acpArgs ? (parseJsonArray(flags.acpArgs, '--acp-args') as string[]) : [],
        cwd,
        permission,
        allowList,
        narrate: flags.acpNarrate === 'off' ? 'off' : 'tools',
        promptTimeoutMs: num(flags.acpTimeoutMs, 5 * 60 * 1000),
        log: (...args2: unknown[]) => log(args2.map(String).join(' ')),
      });
    });
  }
  throw new Error(`未知 brain：${kind}（支持 rule | command | pi-sdk | acp）`);
}

/** `--pi-tools` 解析：none / read-only / all / 逗号名单（如 read,weather）。 */
function parsePiTools(value: string | undefined): 'none' | 'read-only' | 'all' | string[] {
  if (!value || value === 'none') return 'none';
  if (value === 'read-only' || value === 'all') return value;
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : 'none';
}

/**
 * 把 async 工厂包成 AgentBrain：第一次 onMessage 时才创建底层 brain
 * （启动失败会在第一条消息时暴露，日志能看到原因）。
 */
class AsyncBrain implements AgentBrain {
  #factory: () => Promise<AgentBrain>;
  #inner: Promise<AgentBrain> | null = null;

  constructor(factory: () => Promise<AgentBrain>) {
    this.#factory = factory;
  }

  async #ensure(): Promise<AgentBrain> {
    if (!this.#inner) {
      this.#inner = this.#factory().catch((error) => {
        // 创建失败不要把 rejected promise 永久缓存住：清掉，下一条消息可重试
        // （典型场景：models.json 没配好，改完不用重启适配器）
        this.#inner = null;
        throw error;
      });
    }
    return this.#inner;
  }

  async onMessage(
    msg: Parameters<AgentBrain['onMessage']>[0],
    ctx: Parameters<AgentBrain['onMessage']>[1],
  ) {
    const inner = await this.#ensure();
    return await inner.onMessage(msg, ctx);
  }

  async close(): Promise<void> {
    if (!this.#inner) return;
    try {
      const inner = await this.#inner;
      await inner.close?.();
    } catch (error) {
      console.error(`[agent-pi] brain 清理失败：${(error as Error).message}`);
    }
  }
}

function waitForSignal(): Promise<string> {
  return new Promise((resolve) => {
    let fired = false;
    const onSignal = (name: string): void => {
      if (fired) {
        // 重复信号（典型来源：pi SDK 依赖的 signal-exit 清理后会向自己重抛 SIGTERM）
        // —— 忽略即可，此时它的重抛只会打到我们，不会再触发默认动作。
        console.error(`[agent-pi] [cli] 忽略重复的 ${name}`);
        return;
      }
      fired = true;
      resolve(name);
    };
    // ⚠️ 用 `on` 而不是 `once`：pi SDK（signal-exit）会在 import 时注册自己的
    //    SIGTERM/SIGINT 监听，收到信号清理后**向自己重抛同一信号**。
    //    若我们用的是 once，第一个信号就把监听消费掉了，重抛命中"无人监听"
    //    → 进程被信号直接杀死（实测：退出码 -15，优雅收尾日志丢失）。
    //    保持常驻监听 = 默认动作永远不触发；重复信号在这里被显式忽略。
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const room = flags.room ?? '';
  if (!room) throw new Error(`缺少 --room（房间名就是访问凭据）\n\n${USAGE}`);

  const log = (line: string): void => console.error(`[agent-pi] ${line}`);
  const nick = flags.nick;
  const bin = flags.agentBin ?? process.env.IROH_AGENT_BIN ?? 'iroh-agent';
  const serveArgs = ['--room', room, ...(nick ? ['--nick', nick] : [])];
  if (flags.agentArgs) {
    serveArgs.push(...(parseJsonArray(flags.agentArgs, '--agent-args') as string[]));
  }

  // 接入引导：本机缺配置时从站点补一份 relay-config.json 里的必要字段。
  // ⚠️ 放在 spawn 之前 —— serve 一启动就会读 `<home>/config.json`。
  const server = flags.server ?? process.env.IROH_AGENT_SERVER?.trim() ?? DEFAULT_SERVER;
  const bootstrap = await ensureLocalConfig({
    server,
    refresh: flags.refreshConfig === true,
    log,
  });
  if (bootstrap.action === 'fetched') {
    log(`[cli] 已从 ${server} 引导配置（补上：${bootstrap.filled.join('、')}）→ ${bootstrap.path}`);
  } else if (bootstrap.action === 'failed') {
    log(`[cli] ⚠️ 配置引导失败：${bootstrap.reason}`);
    log('[cli]    继续启动；若进房后看不见别人，检查本机配置，或用 --server 指定站点');
  }

  const client = new AgentClient({
    bin,
    args: serveArgs,
    pingIntervalMs: num(flags.pingIntervalMs, 45_000),
    log,
  });
  // 名片：进房即发布（没给 --bio/--tags 就不订阅、不发请求，行为与以前一致）
  const detachProfile = announceProfileOnJoin(client, {
    bio: flags.bio,
    tags: flags.tags
      ? flags.tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    log,
  });
  const hello = await client.start();
  const relay = hello.relay
    ? `${hello.relay.url}${hello.relay.connected ? '' : '（未连接）'}`
    : '（无）';
  log(
    `[cli] hello：endpointId=${hello.endpointId} chatProtocol=${hello.chatProtocol} ` +
      `nick=${hello.nickname} relay=${relay}`,
  );

  const brain = buildBrain(flags, log);
  // 默认 @昵称触发（用 --nick）；没有 --nick 就不开提及触发
  const mention = flags.noMention ? null : (flags.mention ?? nick ?? null);
  // 文件策略：只认 accept/reject，其余（含拼错）一律当 off（默认最安全）
  const filesMode = flags.files === 'accept' || flags.files === 'reject' ? flags.files : 'off';
  const adapter = new ChatAdapter({
    client,
    brain,
    room,
    mention,
    respondToAll: flags.respondToAll === true,
    cooldownMs: num(flags.cooldownMs, 3_000),
    maxReplyBytes: num(flags.maxReplyBytes, 30_000),
    files: filesMode,
    filesMaxBytes: num(flags.filesMaxMb, 64) * 1024 * 1024,
    filesAllowFrom: flags.filesAllow
      ? flags.filesAllow
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    filesSaveDir: flags.filesDir,
    filesMaxConcurrent: num(flags.filesMaxConcurrent, 2),
    filesMaxTotalBytes: num(flags.filesMaxTotalMb, 512) * 1024 * 1024,
    log: (...args) => log(args.map(String).join(' ')),
  });
  adapter.start();
  if (filesMode === 'accept' && !flags.filesAllow) {
    // 不阻止启动（很多人就是这么用的），但必须说出来：房间里**任何人**都能发文件过来。
    log(
      '[cli] ⚠️ --files accept 未配 --files-allow：房间里任何人都能给你发文件' +
        '（受单文件 / 并发 / 累计三道闸门约束，但请确认落盘目录所在分区够用、账号权限够低）',
    );
  }
  log(
    `[cli] 已就绪：mention=${mention ?? '关'}（触发方式只有 @）` +
      `files=${filesMode}${filesMode === 'accept' ? `（上限 ${num(flags.filesMaxMb, 64)} MiB）` : ''}`,
  );

  const signal = await waitForSignal();
  log(`[cli] 收到 ${signal}，优雅退出中…`);
  detachProfile();
  await adapter.stop();
  await client.stop();
  log('[cli] 已退出');
  // 依赖（pi SDK/signal-exit 等）可能留下未清理的句柄；给 2 秒排水后强制退出，
  // 别让服务管理器对着一个"收尾完了但不退场"的进程干等。unref：正常空转时它不影响退出。
  setTimeout(() => process.exit(0), 2000).unref();
}

main().catch((error: unknown) => {
  console.error(`[agent-pi] 启动失败：${(error as Error).message}`);
  process.exit(1);
});
