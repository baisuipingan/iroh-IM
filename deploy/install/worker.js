/**
 * get.editor.vip · iroh 中继安装脚本分发
 *
 *   bash -c "$(curl -sSL https://get.editor.vip/iroh/install.sh)"
 *
 * 为什么要这一层（而不直接用 GitHub raw）：
 *   1. 好记、稳定的 URL（换仓库/换分支不用改用户命令）
 *   2. raw.githubusercontent.com 有自己的 CDN 缓存，改完脚本几分钟内仍是旧版。
 *      这里每分钟换一个上游 URL 绕开它，所以脚本更新最多 1 分钟就生效。
 */

const GH_RAW =
  'https://raw.githubusercontent.com/baisuipingan/iroh-relay-install/main/install.sh';

const OK_PATHS = new Set(['/', '/iroh', '/iroh/', '/install.sh', '/iroh/install.sh']);

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
    }

    if (!OK_PATHS.has(pathname)) {
      return new Response('iroh relay installer → /iroh/install.sh\n', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // 每分钟换一个上游 URL，绕开 raw 的 CDN 缓存
    const bust = Math.floor(Date.now() / 60000);
    const upstream = await fetch(`${GH_RAW}?v=${bust}`, {
      cf: { cacheTtl: 60, cacheEverything: true },
    });

    if (!upstream.ok) {
      return new Response('upstream error\n', { status: 502 });
    }

    return new Response(upstream.body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=60',
      },
    });
  },
};
