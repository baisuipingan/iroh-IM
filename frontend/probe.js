/**
 * iroh 中继预探测模块（无依赖，浏览器/Worker 通用）
 *
 * 干什么：在启动 iroh wasm 端点之前，先量出每台中继的"干净 RTT"，给出排序。
 * 为什么需要：iroh 内核自己也会探测（net_report）并选延迟最低者作为 home relay，
 *   但如果候选名单里混着已经挂掉/异常慢的中继，注册阶段会被拖慢。
 *   预探测的作用是"剔除死的、把明显的次优项排后面"，把前 K 台交给 iroh。
 *
 * ===== 关键实测结论（2026-09-29，务必遵守）=====
 * 1) iroh-relay 的 `GET /ping` 自身开销可忽略（复用连接后 0.1～0.3ms），
 *    且**允许跨域读**（response.type == "cors"、status 200），所以它可以直接当浏览器探针。
 * 2) 但新建 TLS 连接要付 2～3 个 RTT 的握手成本：
 *    香港 → 欧洲机房：新建连接 754ms，复用连接后真实 RTT 只有 233ms（ICMP 250ms）。
 *    → 绝不能拿"首次请求的耗时"当延迟指标，必须先预热。
 * 3) 中继**不发 `Timing-Allow-Origin`**，跨域资源计时的明细字段被浏览器清零
 *    （requestStart / responseStart / connectStart 全为 0），**只有 `duration` 可用**。
 *    → 实现见 measureRtt()：有明细用明细，没有就用 duration。
 */

const PROBE_PATH = '/ping';

/** 带超时的 fetch，超时即判死。 */
async function timedFetch(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
    return res.ok;
  } finally {
    clearTimeout(t);
  }
}

/** 取最近一次该 origin 的资源计时（最好在 fetch 之后立刻调用）。 */
function lastTiming(origin) {
  const entries = performance.getEntriesByType('resource').filter((e) => e.name.startsWith(origin));
  return entries.length ? entries[entries.length - 1] : null;
}

/**
 * 从 Resource Timing 条目里取"最接近 1 个 RTT"的数值。
 *
 * 实测（2026-09-29）：iroh-relay 的 /ping 允许跨域读（response.type == "cors"，status 200），
 * 但它不发 `Timing-Allow-Origin`，于是跨域资源计时的明细字段全被清零
 * （requestStart / responseStart / connectStart 都是 0），**只有 `duration` 与 `responseEnd` 可用**。
 * 所以策略是：有明细就用明细（排除握手），没有就用 duration（依赖"先预热"保证连接已建立）。
 */
function measureRtt(entry) {
  if (!entry) return null;
  if (entry.requestStart > 0 && entry.responseStart > 0) {
    return entry.responseStart - entry.requestStart;
  }
  if (entry.duration > 0) return entry.duration;
  return null;
}

/**
 * 探测单台中继，返回质量指标。
 * @returns {Promise<{id:string,url:string,ok:boolean,rtt:number|null,handshake:number|null,samples:number[]}>}
 */
export async function probeRelay(relay, { samples = 3, timeoutMs = 2500, warmup = true } = {}) {
  const target = relay.url.replace(/\/$/, '') + PROBE_PATH;
  const base = { id: relay.id, url: relay.url, ok: false, rtt: null, handshake: null, samples: [], error: null };

  try {
    if (warmup) await timedFetch(target, timeoutMs); // 预热：建立 TCP + TLS
  } catch (e) {
    // 注意：如果中继不发 CORS 头，跨域 fetch 会以 TypeError 失败——这不代表中继不可达
    return { ...base, error: String(e?.message ?? e) };
  }

  const rtts = [];
  for (let i = 0; i < samples; i++) {
    try {
      await timedFetch(target, timeoutMs);
      const rtt = measureRtt(lastTiming(relay.url));
      if (rtt !== null) rtts.push(rtt);
    } catch (e) {
      return { ...base, failedAt: i, error: String(e?.message ?? e) };
    }
  }
  if (!rtts.length) {
    return { ...base, ok: true, rtt: null, note: '可达但读不到计时（缺 Timing-Allow-Origin 且 duration 也为 0）' };
  }
  rtts.sort((a, b) => a - b);

  const handshakeEntry = lastTiming(relay.url);
  return {
    ...base,
    ok: true,
    rtt: rtts[Math.floor(rtts.length / 2)], // 中位数
    min: rtts[0],
    handshake: handshakeEntry ? handshakeEntry.connectEnd : null,
    samples: rtts,
  };
}

/**
 * 并发探测全部中继，返回按质量排序的结果。
 * 排序键：可用性 → 延迟中位数；并保留带权重的原始顺序作为 tie-break。
 */
export async function probeAll(relays, opts = {}) {
  const alive = relays.filter((r) => r.enabled !== false);
  const results = await Promise.all(alive.map((r) => probeRelay(r, opts)));
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return (a.rtt ?? Infinity) - (b.rtt ?? Infinity);
  });
}

/**
 * 从探测结果生成交给 iroh 的候选中继名单（RelayMode::Custom 的输入）。
 *
 * @param results probeAll 的返回
 * @param k 只放前 K 台进 RelayMap（默认 3）。**只放 1 台 = 强制指定该中继**，
 *          但会失去自动故障切换能力，仅在排障时用。
 * @param fallback 探测全失败时的兜底名单（应为配置里的全部中继）。
 *          探测失败常见原因：中继没发 CORS 头时浏览器会拦截跨域 fetch —— 
 *          这不等于中继不可达，此时应把名单全给 iroh，让它自己去连。
 *
 * 现实约束（实测）：拨号方必须知道对端"真实所在"的中继 URL，中继之间不互转；
 * 若某台对端所在的中继不在自己的 RelayMap 里，仍可连通（URL 正确即可），
 * 但把它放进名单能保证自己也能被发现。
 */
export function buildRelayMap(results, { k = 3, fallback = [] } = {}) {
  const alive = results.filter((r) => r.ok && r.rtt !== null);
  const chosen = alive.length ? alive.slice(0, k) : fallback.length ? fallback : results.filter((r) => r.ok);
  return chosen.map((r) => ({ url: r.url, quic_port: r.quic_port ?? 7842 }));
}

/** 滞回判定：只有备选明显更优、或当前中继已死，才建议切换（防止抖动导致反复重连）。 */
export function shouldSwitch(current, best, { margin = 0.2 } = {}) {
  if (!best || !best.ok) return false;
  if (!current || !current.ok) return true;
  return best.rtt < current.rtt * (1 - margin);
}

/** 拉取中继名单：先网络，失败回落到本地缓存。 */
export async function loadRelayConfig(url, cacheKey = 'iroh.relay-config') {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const cfg = await res.json();
    localStorage.setItem(cacheKey, JSON.stringify(cfg));
    return cfg;
  } catch {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
    throw new Error('relay config unavailable and no cache');
  }
}

/**
 * 诊断单台探测为何拿不到延迟：看 CORS 头与 Resource Timing 明细。
 * 用途：排障 / 决定是否需要给中继加 CORS 与 Timing-Allow-Origin。
 */
export async function diagnoseRelay(relay, timeoutMs = 3000) {
  const url = relay.url.replace(/\/$/, '') + PROBE_PATH;
  const out = { url };
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    out.ok = res.ok;
    out.status = res.status;
    out.type = res.type; // basic=同源 / cors=拿到 CORS 头 / opaque=被拦
    out.acao = res.headers.get('access-control-allow-origin');
    out.tao = res.headers.get('timing-allow-origin');
  } catch (e) {
    out.error = String(e?.message ?? e);
  }
  const entries = performance.getEntriesByType('resource').filter((x) => x.name.startsWith(relay.url));
  const e = entries.pop();
  out.timing = e
    ? {
        nextHopProtocol: e.nextHopProtocol,
        connectStart: Math.round(e.connectStart),
        connectEnd: Math.round(e.connectEnd),
        requestStart: Math.round(e.requestStart),
        responseStart: Math.round(e.responseStart),
        responseEnd: Math.round(e.responseEnd),
        duration: Math.round(e.duration),
        transferSize: e.transferSize,
      }
    : null;
  return out;
}
