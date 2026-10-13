/**
 * get.editor.vip · iroh 安装脚本分发（中继 / iroh-agent / room-bridge）
 *
 *   bash -c "$(curl -sSL https://get.editor.vip/iroh/install.sh)"                  # 自建中继
 *   bash -c "$(curl -sSL https://get.editor.vip/iroh/agent-install.sh)"            # 无头成员
 *   bash -c "$(curl -sSL https://get.editor.vip/iroh/room-bridge-install.sh)"      # 单文件适配器
 *
 * 为什么要这一层（而不直接用 GitHub raw）：
 *   1. 好记、稳定的 URL（换仓库/换分支不用改用户命令）
 *   2. raw.githubusercontent.com 有自己的 CDN 缓存，改完脚本几分钟内仍是旧版。
 *      这里每分钟换一个上游 URL 绕开它，所以脚本更新最多 1 分钟就生效。
 *
 * ⚠️ 每条路径是**独立上游**：中继安装器在 iroh-relay-install 仓库，
 *    agent/room-bridge 在 iroh-IM 仓库 —— 别把上游统一成同一个前缀。
 */

const UPSTREAMS = {
  '/iroh/install.sh':
    'https://raw.githubusercontent.com/baisuipingan/iroh-relay-install/main/install.sh',
  '/iroh/agent-install.sh':
    'https://raw.githubusercontent.com/baisuipingan/iroh-IM/main/deploy/install/agent-install.sh',
  '/iroh/agent-install.ps1':
    'https://raw.githubusercontent.com/baisuipingan/iroh-IM/main/deploy/install/agent-install.ps1',
  '/iroh/room-bridge-install.sh':
    'https://raw.githubusercontent.com/baisuipingan/iroh-IM/main/deploy/install/room-bridge-install.sh',
  '/iroh/room-bridge-install.ps1':
    'https://raw.githubusercontent.com/baisuipingan/iroh-IM/main/deploy/install/room-bridge-install.ps1',
};

const INDEX = [
  'get.editor.vip · iroh 安装脚本',
  '',
  '  /iroh/install.sh                 自建中继一键安装（macOS/Linux）',
  '  /iroh/agent-install.sh           iroh-agent 无头成员（macOS/Linux）',
  '  /iroh/agent-install.ps1          iroh-agent 无头成员（Windows）',
  '  /iroh/room-bridge-install.sh     room-bridge 单文件适配器（macOS/Linux）',
  '  /iroh/room-bridge-install.ps1    room-bridge 单文件适配器（Windows）',
  '',
  '文档：https://github.com/baisuipingan/iroh-IM/blob/main/docs/bring-your-own-agent.md',
  '',
].join('\n');

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
    }

    if (pathname === '/' || pathname === '/iroh' || pathname === '/iroh/') {
      return new Response(INDEX, {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60' },
      });
    }

    const upstreamUrl = UPSTREAMS[pathname];
    if (!upstreamUrl) {
      return new Response(`404 —— 可用脚本：\n\n${INDEX}`, {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // 每分钟换一个上游 URL，绕开 raw 的 CDN 缓存
    const bust = Math.floor(Date.now() / 60000);
    const upstream = await fetch(`${upstreamUrl}?v=${bust}`, {
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
