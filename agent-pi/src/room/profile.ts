/* ============================================================================
 * profile.ts · 进房后自动发布名片（简介 / 标签）
 *
 * 为什么需要：房间里的人（和 agent）靠**名字 + 简介 + 这个房间的发言**认识彼此
 * （见 docs/agent-as-member-plan.md §1 ③）。真人用浏览器在花名册里写简介，
 * 无头接入的 agent 也得有同一条路 —— 否则它出现在名册里只有名字，别人不知道它能干什么。
 *
 * 形态：监听 `joined` 事件（含 serve 崩溃重启后的自动重进房），发布一次名片。
 * 名片是 V6.2 的**状态帧**（不进聊天历史、常驻节点直记账），所以重复发布无副作用。
 *
 * 归一化与读取侧一致：简介 160 字（换行压成空格）、标签 8 个 × 16 字、去重。
 * ==========================================================================*/

import type { AgentClient } from './client.ts';
import type { RoomEvent } from './protocol.ts';

export interface ProfileAnnounceOptions {
  bio?: string;
  tags?: string[];
  log?: (line: string) => void;
  /** 失败重试次数（默认 4 —— serve 重启/进房竞态都能覆盖） */
  attempts?: number;
  retryDelayMs?: number;
}

/** 与前端 `profile.js` / Rust `parse_profile` 同一套上限。 */
export function normalizeProfileInput(
  bio?: string,
  tags?: string[],
): { bio: string; tags: string[] } {
  const cleanBio = String(bio ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 160);
  const seen = new Set<string>();
  const cleanTags: string[] = [];
  for (const raw of tags ?? []) {
    const tag = String(raw ?? '').trim().slice(0, 16);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    cleanTags.push(tag);
    if (cleanTags.length >= 8) break;
  }
  return { bio: cleanBio, tags: cleanTags };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ProfileClient = Pick<AgentClient, 'on' | 'off' | 'request'>;

/**
 * 绑定"进房即发布名片"；返回解绑函数。
 * 没给 bio/tags 时**什么都不做**（不订阅、不发请求）—— 保持旧部署行为不变。
 */
export function announceProfileOnJoin(
  client: ProfileClient,
  opts: ProfileAnnounceOptions,
): () => void {
  const { bio, tags } = normalizeProfileInput(opts.bio, opts.tags);
  if (!bio && !tags.length) return () => {};
  const log = opts.log ?? ((line: string): void => console.error(line));
  let publishing = false;

  const publish = async (): Promise<void> => {
    const attempts = Math.max(1, opts.attempts ?? 4);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const value = (await client.request('profile', { bio, tags }, 15_000)) as {
          bio?: string;
          tags?: string[];
        };
        const gotBio = typeof value?.bio === 'string' ? value.bio : bio;
        const gotTags = Array.isArray(value?.tags) ? value.tags : tags;
        log(
          `[cli] 名片已发布：bio=${JSON.stringify(gotBio)}` +
            `${gotTags.length ? ` tags=${JSON.stringify(gotTags)}` : ''}`,
        );
        return;
      } catch (error) {
        const code = (error as { code?: string }).code ?? '';
        if (code === 'unsupportedCmd') {
          // 老二进制没有 profile 命令：重试没意义，把升级方式说清楚
          log(
            '[cli] ⚠️ 这枚 iroh-agent 太老（没有 profile 命令），名片没发出去；' +
              '升级后重跑一次即可（见 docs/bring-your-own-agent.md）',
          );
          return;
        }
        if (attempt === attempts) {
          log(`[cli] ⚠️ 名片发布失败（不影响对话）：${(error as Error).message}`);
          return;
        }
        await sleep((opts.retryDelayMs ?? 800) * attempt);
      }
    }
  };

  const onEvent = (event: RoomEvent): void => {
    if (event?.type !== 'joined' || publishing) return;
    publishing = true;
    void publish().finally(() => {
      publishing = false;
    });
  };

  client.on('event', onEvent);
  return () => client.off('event', onEvent);
}
