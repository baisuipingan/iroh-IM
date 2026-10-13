/* ============================================================================
 * bootstrap.ts · 首次接入的配置引导（把"手抄中继 / 入口 / 历史"这一步干掉）
 *
 * 新朋友第一次接入时机器上通常什么都没有：没有 `~/.config/iroh-agent/config.json`，
 * 也没有 `IROH_AGENT_*` 环境变量。以前他得手抄 relays / relay_token / anchor，
 * 抄错一个字段的表现是**进房成功、谁都看不见**（孤立进房）——很难查。
 *
 * 现在：适配器启动时发现本机"缺配置"，就从站点拉公开的 `relay-config.json`
 * （浏览器进房读的就是同一份），把缺的字段补进 config.json。
 *
 * 三条边界（别越界）：
 *   1. **只补缺的、非空的字段**（relays / relay_token / rendezvous / history，外加
 *      兼容用的 anchor）；已有值一律不覆盖，`--refresh-config` 才强制重写这几组。
 *   2. **不碰 nickname** —— 那是每次运行 `--nick` 的事。
 *   3. 环境变量里已有中继/入口配置（CI、召唤器注入）⇒ 直接跳过，**不写任何文件**。
 * ==========================================================================*/

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

export interface EnsureLocalConfigOptions {
  /** 站点根地址（如 https://im.pinkstar.cc）；空串或 `off` = 关闭引导 */
  server: string;
  /** 强制重新拉取并覆盖 relays/token/入口/历史（nickname 与其它键不动） */
  refresh?: boolean;
  log?: (line: string) => void;
  /** 测试注入：默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 测试注入：默认按 iroh-agent 的规则推导（IROH_AGENT_HOME 优先） */
  homeDir?: string;
  /** 测试注入：默认 process.env */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface EnsureLocalConfigResult {
  action: 'disabled' | 'skipped' | 'fetched' | 'failed';
  /** config.json 的目标路径（无论有没有真的写） */
  path: string;
  /** 本次补上的字段名 */
  filled: string[];
  reason?: string;
}

/**
 * iroh-agent 的配置/身份目录 —— 必须与 Rust 侧 `home()` 的规则一致，
 * 否则引导写了一个文件、agent 却读另一个（那就白引导了）。
 */
export function agentHomeDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.IROH_AGENT_HOME?.trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    const base = env.APPDATA?.trim() || join(env.USERPROFILE?.trim() || '.', 'AppData', 'Roaming');
    return join(base, 'iroh-agent');
  }
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || '/root', '.config');
  return join(base, 'iroh-agent');
}

interface SiteEntry {
  id: string;
  relay: string;
}

interface SiteConfig {
  relays: string[];
  relayToken: string;
  rendezvous: SiteEntry | null;
  history: SiteEntry | null;
  anchor: SiteEntry | null;
}

function asEntry(value: unknown): SiteEntry | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === 'string' ? v.id.trim() : '';
  const relay = typeof v.relay === 'string' ? v.relay.trim() : '';
  return id ? { id, relay } : null;
}

/** 把站点 relay-config.json 归一化成"补配置"要用的形状；形状不对返回 null（不抛）。 */
export function parseSiteConfig(raw: unknown): SiteConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const relays = Array.isArray(v.relays)
    ? v.relays
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && (item as { enabled?: unknown }).enabled !== false) {
            const url = (item as { url?: unknown }).url;
            return typeof url === 'string' ? url : '';
          }
          return '';
        })
        .map((url) => url.trim())
        .filter((url) => url.startsWith('https://') || url.startsWith('http://'))
    : [];
  if (!relays.length) return null;
  return {
    relays,
    relayToken: typeof v.relay_token === 'string' ? v.relay_token : '',
    rendezvous: asEntry(v.rendezvous),
    history: asEntry(v.history),
    anchor: asEntry(v.anchor),
  };
}

type LocalConfig = Record<string, unknown>;

function relaysOf(cfg: LocalConfig): string[] {
  return Array.isArray(cfg.relays)
    ? cfg.relays.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
}

function entryOk(cfg: LocalConfig, key: string): boolean {
  const e = cfg[key];
  return !!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' && !!(e as { id: string }).id;
}

/** 缺哪些"进房必需"的组。入口按 rendezvous/anchor 任一算数（兼容旧二进制）。 */
function missingGroups(cfg: LocalConfig): string[] {
  const miss: string[] = [];
  if (!relaysOf(cfg).length) miss.push('relays');
  if (!(typeof cfg.relay_token === 'string' && cfg.relay_token.trim())) miss.push('relay_token');
  if (!entryOk(cfg, 'rendezvous') && !entryOk(cfg, 'anchor')) miss.push('rendezvous');
  if (!entryOk(cfg, 'history')) miss.push('history');
  return miss;
}

function readLocal(path: string): { cfg: LocalConfig; corrupt: boolean } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { cfg: {}, corrupt: false }; // 不存在是最常见的情况
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { cfg: parsed as LocalConfig, corrupt: false };
    }
    return { cfg: {}, corrupt: true };
  } catch {
    return { cfg: {}, corrupt: true };
  }
}

/**
 * 保证本机有一份"能进房"的配置。返回结果**不抛异常** —— 引导失败只是少了一层
 * 便利，适配器仍按本机现状启动（失败原因交给调用方如实打出来）。
 */
export async function ensureLocalConfig(
  opts: EnsureLocalConfigOptions,
): Promise<EnsureLocalConfigResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((): void => {});
  const server = (opts.server ?? '').trim();
  const home = opts.homeDir ?? agentHomeDir(env);
  const path = join(home, 'config.json');

  if (!server || server === 'off') return { action: 'disabled', path, filled: [] };

  // 环境变量已提供中继/入口（CI、召唤器注入的 env）⇒ 我们不写文件、不覆盖
  for (const key of ['IROH_AGENT_RELAY', 'IROH_AGENT_RENDEZVOUS_ID', 'IROH_AGENT_ANCHOR_ID']) {
    if (env[key]?.trim()) {
      return { action: 'skipped', path, filled: [], reason: `环境变量 ${key} 已提供配置` };
    }
  }

  const { cfg, corrupt } = readLocal(path);
  if (corrupt) {
    // 坏文件不静默重建：先留备份（用户/别的工具可能在意里面的内容）
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, backup);
      log(`[bootstrap] ⚠️ ${path} 不是合法 JSON，已备份到 ${backup}，将重建`);
    } catch {
      log(`[bootstrap] ⚠️ ${path} 不是合法 JSON 且备份失败，将直接重建`);
    }
  }

  const miss = missingGroups(cfg);
  if (!miss.length && !opts.refresh) {
    return { action: 'skipped', path, filled: [], reason: '本机已有可用配置' };
  }

  const url = `${server.replace(/\/+$/, '')}/relay-config.json`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let site: SiteConfig | null;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return { action: 'failed', path, filled: [], reason: `${url} 返回 HTTP ${res.status}` };
    site = parseSiteConfig(await res.json());
  } catch (error) {
    return {
      action: 'failed',
      path,
      filled: [],
      reason: `${url} 拉取失败（${(error as Error).message}）`,
    };
  }
  if (!site) return { action: 'failed', path, filled: [], reason: `${url} 里没有可用中继` };

  const next: LocalConfig = { ...cfg };
  const filled: string[] = [];
  const want = (key: string): boolean => opts.refresh === true || miss.includes(key);
  if (want('relays')) {
    next.relays = site.relays;
    filled.push('relays');
  }
  if (want('relay_token') && site.relayToken) {
    next.relay_token = site.relayToken;
    filled.push('relay_token');
  }
  if (want('rendezvous') && site.rendezvous) {
    next.rendezvous = site.rendezvous;
    filled.push('rendezvous');
  }
  if (want('history') && site.history) {
    next.history = site.history;
    filled.push('history');
  }
  if ((opts.refresh === true || !entryOk(next, 'anchor')) && site.anchor) {
    next.anchor = site.anchor;
    filled.push('anchor');
  }
  if (!filled.length) return { action: 'skipped', path, filled: [], reason: '拉到的字段本机都已存在' };

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } catch (error) {
    return { action: 'failed', path, filled: [], reason: `写入 ${path} 失败（${(error as Error).message}）` };
  }
  return { action: 'fetched', path, filled };
}
