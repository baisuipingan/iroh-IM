/* ============================================================================
 * tools.ts · 给 pi-sdk 大脑用的自定义工具（安全优先）
 *
 * 两个内置工具：
 *   - `weather`   ：查实时天气/短期预报（Open-Meteo，免 key）
 *   - `fetch_url` ：抓取一个网页/接口的文本（带 SSRF/体积/重定向防线）
 *
 * 为什么不用 pi 的自带工具（read/bash/...）当默认：房间内容是不可信输入，
 * `bash` 等于把服务器的命令执行权交给任何知道房名的人。自带工具要不要开由
 * 操作者用 `--pi-tools` 显式决定；这里只提供**参数收窄、副作用有限**的工具。
 *
 * ⚠️ 两个实现细节：
 *   1. TypeBox schema 在运行时就是普通 JSON Schema —— `typebox` 包在本项目里
 *      被嵌套在 pi-coding-agent 的 node_modules 下、顶层不可解析（shrinkwrap），
 *      所以这里直接手写 JSON Schema 字面量（defineTool 是 no-op 包装，不挑来源）。
 *   2. `fetch_url` 的 SSRF 防线是**基本**防线（字面 IP / DNS 解析结果 / 手动的
 *      重定向逐跳检查）。DNS rebinding 的 TOCTOU 无法在纯 fetch 层根除 ——
 *      高敏感环境请用 `--fetch-allow` 白名单把目标域钉死。
 * ==========================================================================*/

import { Buffer } from 'node:buffer';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { defineTool } from '@earendil-works/pi-coding-agent';

export const CUSTOM_TOOL_NAMES = ['weather', 'fetch_url'] as const;
export type CustomToolName = (typeof CUSTOM_TOOL_NAMES)[number];

export interface CustomToolOptions {
  /** `fetch_url` 的域名白名单（子域自动放行）；不设 = 只靠内置防线 */
  fetchAllow?: string[];
  log?: (...args: unknown[]) => void;
}

export function buildCustomTools(names: string[], opts: CustomToolOptions = {}): unknown[] {
  const tools: unknown[] = [];
  for (const name of names) {
    if (name === 'weather') tools.push(makeWeatherTool());
    if (name === 'fetch_url') tools.push(makeFetchTool(opts));
  }
  return tools;
}

// --------------------------------------------------------------------------- 天气

const WMO_ZH: Record<number, string> = {
  0: '晴',
  1: '基本晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '毛毛雨（弱）',
  53: '毛毛雨（中）',
  55: '毛毛雨（强）',
  56: '冻毛毛雨（弱）',
  57: '冻毛毛雨（强）',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨（弱）',
  67: '冻雨（强）',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨（弱）',
  81: '阵雨（中）',
  82: '阵雨（强）',
  85: '阵雪（弱）',
  86: '阵雪（强）',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
};

function weatherZh(code: number | undefined): string {
  if (code === undefined) return '未知';
  return WMO_ZH[code] ?? `天气代码 ${code}`;
}

function makeWeatherTool(): unknown {
  return defineTool({
    name: 'weather',
    label: '查天气',
    description:
      '查询某个城市的实时天气与未来几天预报（数据源 Open-Meteo，免费免 key）。' +
      '当用户问天气、气温、是否下雨时使用。',
    promptSnippet: 'weather(city, days?)：查实时天气与预报',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，中文或英文均可，如 上海 / Tokyo' },
        days: { type: 'number', description: '预报天数 1-7，默认 3' },
      },
      required: ['city'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: { city: string; days?: number }) {
      const days = Math.min(Math.max(Math.trunc(params.days ?? 3) || 3, 1), 7);
      const timeout = () => AbortSignal.timeout(10_000);

      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(params.city)}&count=1&language=zh&format=json`,
        { signal: timeout() },
      );
      const geo = (await geoRes.json()) as {
        results?: Array<{
          name: string;
          latitude: number;
          longitude: number;
          country?: string;
          admin1?: string;
        }>;
      };
      const place = geo.results?.[0];
      if (!place) throw new Error(`找不到城市「${params.city}」，换个写法再试`);

      const forecastRes = await fetch(
        'https://api.open-meteo.com/v1/forecast?' +
          `latitude=${place.latitude}&longitude=${place.longitude}` +
          '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
          '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
          `&timezone=auto&forecast_days=${days}`,
        { signal: timeout() },
      );
      const fc = (await forecastRes.json()) as {
        current?: {
          temperature_2m: number;
          relative_humidity_2m: number;
          apparent_temperature: number;
          weather_code: number;
          wind_speed_10m: number;
        };
        daily?: {
          time: string[];
          weather_code: number[];
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          precipitation_probability_max?: Array<number | null>;
        };
      };

      const where = [place.country, place.admin1, place.name].filter(Boolean).join(' / ');
      const lines: string[] = [];
      if (fc.current) {
        lines.push(
          `${where} 当前：${weatherZh(fc.current.weather_code)}，` +
            `气温 ${fc.current.temperature_2m}°C（体感 ${fc.current.apparent_temperature}°C），` +
            `湿度 ${fc.current.relative_humidity_2m}%，风 ${fc.current.wind_speed_10m} km/h`,
        );
      }
      const d = fc.daily;
      if (d?.time?.length) {
        lines.push(`未来 ${d.time.length} 天：`);
        for (let i = 0; i < d.time.length; i += 1) {
          const rain = d.precipitation_probability_max?.[i];
          lines.push(
            `- ${d.time[i]}：${weatherZh(d.weather_code[i])}，` +
              `${d.temperature_2m_min[i]}~${d.temperature_2m_max[i]}°C` +
              (rain === null || rain === undefined ? '' : `，降水概率 ${rain}%`),
          );
        }
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { city: where, latitude: place.latitude, longitude: place.longitude, days },
      };
    },
  } as never);
}

// --------------------------------------------------------------------------- 抓网页

/** 内网/保留地址判断（字面 IP）。域名要等到 DNS 解析后再判断。 */
function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped（::ffff:a.b.c.d）→ 拆出 v4 部分再判
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower)
    );
  }
  return true; // 不认识的一律当危险
}

async function assertUrlAllowed(raw: URL, allow: string[]): Promise<void> {
  if (raw.protocol !== 'https:') throw new Error('只允许 https:// 链接');
  const host = raw.hostname.toLowerCase();
  if (allow.length > 0) {
    const ok = allow.some((d) => host === d || host.endsWith(`.${d}`));
    if (!ok) throw new Error(`域名不在白名单：${host}`);
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许访问本机/内网地址');
  }
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (isPrivateIp(bare)) throw new Error('不允许访问内网地址');
    return;
  }
  // 域名：把解析到的**每一个**地址都检查一遍
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new Error(`域名解析失败：${host}`);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error('域名解析到内网地址，已拦截');
  }
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

function makeFetchTool(opts: CustomToolOptions): unknown {
  const allow = (opts.fetchAllow ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  return defineTool({
    name: 'fetch_url',
    label: '抓取网页',
    description:
      '抓取一个 https 链接的文本内容（网页/JSON 接口）。返回前会截断到指定字符数。' +
      '当用户给了链接、或需要查网页上的实时信息时使用。',
    promptSnippet: 'fetch_url(url, max_chars?)：抓取 https 链接的文本',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'https:// 开头的完整链接' },
        max_chars: {
          type: 'number',
          description: '返回给模型的最大字符数（200-20000，默认 4000）',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(
      _toolCallId: string,
      params: { url: string; max_chars?: number },
      signal: AbortSignal | undefined,
    ) {
      const maxChars = Math.min(
        Math.max(Math.trunc(params.max_chars ?? 4000) || 4000, 200),
        20_000,
      );
      let current = new URL(params.url);

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await assertUrlAllowed(current, allow);
        const res = await fetch(current, {
          redirect: 'manual',
          signal: signal ?? AbortSignal.timeout(15_000),
          headers: { 'user-agent': 'iroh-agent/0.2 (chatroom assistant)' },
        });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const loc = res.headers.get('location');
          if (!loc) throw new Error(`重定向缺少 location（${res.status}）`);
          current = new URL(loc, current);
          continue;
        }
        if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);

        const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
        const isText =
          ctype.startsWith('text/') ||
          ctype.includes('json') ||
          ctype.includes('xml') ||
          ctype.startsWith('application/javascript');
        if (!isText) throw new Error(`只抓文本类内容，对方返回 ${ctype || '未知类型'}`);

        // 流式读、硬截断，避免大响应打爆内存
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        let truncated = false;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (received > MAX_BODY_BYTES) {
              await reader.cancel().catch(() => {});
              truncated = true;
              break;
            }
            chunks.push(value);
          }
        }
        const text = Buffer.concat(chunks).toString('utf8');
        const clipped = text.slice(0, maxChars);
        opts.log?.(`[tools] fetch_url ${current.href} → HTTP ${res.status}，${received} 字节`);
        return {
          content: [
            {
              type: 'text',
              text: clipped + (text.length > clipped.length || truncated ? '\n…（已截断）' : ''),
            },
          ],
          details: {
            url: current.href,
            status: res.status,
            contentType: ctype,
            bytes: received,
            truncated: truncated || text.length > clipped.length,
          },
        };
      }
      throw new Error('重定向次数过多');
    },
  } as never);
}
