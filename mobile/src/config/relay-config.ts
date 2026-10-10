/* ============================================================================
 * relay-config.ts · 中继/常驻节点配置的来源
 *
 * 改造前：`App.tsx` 里**手抄**了一份 relay URL / token / anchor id，
 * 与 `frontend/relay-config.json` 是两份。后果是换中继或轮换 token 时
 * 必须**重新发版 App**，否则线上那台改了名/下线了，移动端还在连旧地址
 * （这类漂移在网页端不存在，因为网页每次加载都重新拉配置）。
 *
 * 现在：启动时拉一次线上配置，失败就用**内置兜底**（离线/被墙/接口挂了也要能连），
 * 并把"用的是哪一份"如实告诉 UI —— 排查"连不上"时第一个要看的就是它。
 *
 * ⚠️ 内置兜底与 `frontend/relay-config.json` 仍是人工同步的（它是"最后一道防线"，
 *    只在拉取失败时才生效）。兜底本身不追求新鲜，追求**一定能连上**。
 * ==========================================================================*/

import { BUILTIN_RELAY_CONFIG } from './relay-config.builtin';

/** 配置来源（会显示在连接状态页：排查"连不上"时第一个要看的东西） */
export type RelayConfigSource = 'remote' | 'builtin';

export interface RelayConfigEntry {
  id: string;
  url: string;
  enabled?: boolean;
  region?: string;
}

export interface RelayConfig {
  relays: RelayConfigEntry[];
  /**
   * **兼容字段**：`rendezvous` / `history` 都没配时，两者都回退到它。
   *
   * ⚠️ 阶段 B′ 之后，服务端把"常驻节点"拆成了两个角色（房间入口 rendezvous /
   *    历史提供者 history）。移动端**目前仍只把 `anchor` 传下去** ——
   *    Android 桥（Kotlin）的参数是一个个搬运的，还没有这两个角色的入口；
   *    Rust 侧对缺省值的处理就是回退到 `anchor`，所以行为与拆分前**完全一致**。
   *    等 C′ 把 Android 桥改成"直传 RoomOptions JSON"时一并接上（已记在架构方案里）。
   */
  anchor?: { id?: string; relay?: string };
  /** **房间入口**：进房时问它"这个房间现在有谁"（校验但不传给原生，见上） */
  rendezvous?: { id?: string; relay?: string };
  /** **历史提供者**：拉历史走它（校验但不传给原生，见上） */
  history?: { id?: string; relay?: string };
  relay_token?: string;
}

export interface LoadedRelayConfig {
  config: RelayConfig;
  source: RelayConfigSource;
  /** 拉取/校验失败的原因（source === 'builtin' 时一定有） */
  error?: string;
}

/** 线上配置地址。**只有这一处**写域名（内置兜底里不再重复写一份列表） */
export const RELAY_CONFIG_URL = 'https://im.pinkstar.cc/relay-config.json';
/** 拉取超时：进房页不该为了一个配置文件卡住 */
export const RELAY_CONFIG_TIMEOUT_MS = 5000;

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * 校验远端配置。**宁可回退也不半信** —— 一份"看着能解析、其实 anchor 是空的"
 * 配置会让 App 静默退化成没有历史/没有常驻节点的状态，比直接回退更难查。
 */
export function parseRelayConfig(raw: unknown): RelayConfig {
  if (!raw || typeof raw !== 'object') throw new Error('配置不是对象');
  const obj = raw as Record<string, unknown>;
  const relays = obj.relays;
  if (!Array.isArray(relays) || relays.length === 0) throw new Error('relays 为空');
  const parsed: RelayConfigEntry[] = [];
  for (const entry of relays) {
    if (!entry || typeof entry !== 'object') throw new Error('relays 里有非对象项');
    const r = entry as Record<string, unknown>;
    if (typeof r.url !== 'string' || !r.url) throw new Error('relay 缺少 url');
    try {
      const u = new URL(r.url);
      if (u.protocol !== 'https:') throw new Error('非 https');
    } catch {
      throw new Error(`relay url 非法：${String(r.url)}`);
    }
    parsed.push({
      id: typeof r.id === 'string' && r.id ? r.id : r.url,
      url: r.url,
      enabled: r.enabled !== false,
      region: typeof r.region === 'string' ? r.region : undefined,
    });
  }
  if (!parsed.some((r) => r.enabled !== false)) throw new Error('所有中继都被禁用');

  const config: RelayConfig = { relays: parsed };
  const token = obj.relay_token;
  if (typeof token === 'string' && token) config.relay_token = token;

  // 三个角色用**同一条规则**：可选，但给了就必须两半都合法（只有一个等于没有）
  const parseNode = (raw: unknown, field: 'anchor' | 'rendezvous' | 'history') => {
    if (!raw || typeof raw !== 'object') return undefined;
    const n = raw as Record<string, unknown>;
    const id = typeof n.id === 'string' ? n.id : '';
    const relay = typeof n.relay === 'string' ? n.relay : '';
    if (!id && !relay) return undefined;
    if (!HEX64.test(id)) throw new Error(`${field}.id 不是 64 位 hex`);
    if (!relay) throw new Error(`${field} 缺少 relay`);
    return { id, relay };
  };
  const anchor = parseNode(obj.anchor, 'anchor');
  if (anchor) config.anchor = anchor;
  const rendezvous = parseNode(obj.rendezvous, 'rendezvous');
  if (rendezvous) config.rendezvous = rendezvous;
  const history = parseNode(obj.history, 'history');
  if (history) config.history = history;
  return config;
}

/**
 * 拉取配置；任何失败都退回内置兜底（**不抛异常**）。
 *
 * `fetchImpl` 可注入，便于测试（默认就是全局 fetch）。
 */
export async function loadRelayConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedRelayConfig> {
  try {
    const res = await fetchImpl(RELAY_CONFIG_URL, {
      signal: AbortSignal.timeout(RELAY_CONFIG_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { config: parseRelayConfig(await res.json()), source: 'remote' };
  } catch (e) {
    return {
      config: BUILTIN_RELAY_CONFIG,
      source: 'builtin',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
