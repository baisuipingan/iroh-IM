/**
 * @typedef {object} Relay
 * @property {string} [id]
 * @property {string} url
 * @property {string} [region]
 * @property {boolean} [enabled]
 * @property {number} [quic_port]
 *
 * @typedef {object} RelayConfig
 * @property {Relay[]} relays
 * @property {{id: string, relay?: string}} [anchor]
 * @property {string} [relay_token]
 *
 * @typedef {{url: string, connected: boolean}} RelayStatus
 * @typedef {{url: string, ok: boolean, rtt: number|null, error?: string}} RelayProbe
 */

export function normalizeRelayUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function validRelayUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  } catch {
    return false;
  }
}

/** @returns {RelayConfig} */
export function validateRelayConfig(config) {
  if (
    !config ||
    typeof config !== 'object' ||
    !Array.isArray(config.relays) ||
    !config.relays.length
  ) {
    throw new Error('中继配置缺少 relays 列表');
  }
  const urls = new Set();
  const ids = new Set();
  for (const relay of config.relays) {
    if (!relay || !validRelayUrl(relay.url))
      throw new Error('中继配置中的 url 必须为有效 HTTPS 地址');
    const url = normalizeRelayUrl(relay.url);
    if (urls.has(url)) throw new Error('中继配置包含重复 URL');
    urls.add(url);
    if (relay.id !== undefined) {
      if (typeof relay.id !== 'string' || !relay.id.trim() || ids.has(relay.id))
        throw new Error('中继配置中的 id 必须为唯一非空字符串');
      ids.add(relay.id);
    }
    if (relay.enabled !== undefined && typeof relay.enabled !== 'boolean')
      throw new Error('中继配置中的 enabled 必须为布尔值');
    if (
      relay.quic_port !== undefined &&
      (!Number.isInteger(relay.quic_port) || relay.quic_port < 1 || relay.quic_port > 65535)
    )
      throw new Error('中继配置中的 quic_port 必须为有效端口');
  }
  if (config.anchor !== undefined && config.anchor !== null) {
    if (!/^[0-9a-f]{64}$/i.test(config.anchor.id || ''))
      throw new Error('常驻节点配置中的 id 必须为 64 位十六进制身份');
    if (config.anchor.relay !== undefined && !validRelayUrl(config.anchor.relay))
      throw new Error('常驻节点的 relay 必须为有效 HTTPS 地址');
  }
  if (
    config.relay_token !== undefined &&
    config.relay_token !== null &&
    typeof config.relay_token !== 'string'
  )
    throw new Error('中继配置中的 relay_token 必须为字符串');
  return config;
}

/**
 * @param {RelayConfig|null} config
 * @param {RelayStatus[]} runtime
 * @param {RelayProbe[]} probes
 */
export function collectRelayModel(config, runtime = [], probes = []) {
  const statusByUrl = new Map(runtime.map((relay) => [normalizeRelayUrl(relay.url), relay]));
  const probeByUrl = new Map(probes.map((probe) => [normalizeRelayUrl(probe.url), probe]));
  const items = [];
  const seen = new Set();
  for (const relay of [...(config?.relays || []), ...runtime]) {
    const url = normalizeRelayUrl(relay.url);
    if (seen.has(url)) continue;
    seen.add(url);
    const enabled = relay.enabled !== false;
    items.push({
      id: relay.id || url.replace(/^https?:\/\//, ''),
      region: relay.region || '',
      url: relay.url,
      enabled,
      connected: enabled ? (statusByUrl.get(url)?.connected ?? null) : null,
      probe: enabled ? probeByUrl.get(url) || null : null,
    });
  }
  const home = items.find((relay) => relay.connected === true) || null;
  return {
    items,
    home,
    standbys: items.filter((relay) => relay !== home),
    okCount: items.filter((relay) => relay.connected === true).length,
    cfgCount: config?.relays?.length || 0,
  };
}

/** @param {RelayProbe|null|undefined} probe */
export function probeLatency(probe) {
  if (!probe) return { text: '—', milliseconds: null, reachable: null };
  if (!probe.ok) return { text: '不可达', milliseconds: null, reachable: false };
  const milliseconds = Number.isFinite(probe.rtt) && probe.rtt >= 0 ? Math.round(probe.rtt) : null;
  return {
    text: milliseconds === null ? '可达' : `${milliseconds}ms`,
    milliseconds,
    reachable: true,
  };
}
