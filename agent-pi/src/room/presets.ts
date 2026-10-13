/* ============================================================================
 * presets.ts · 常用接入的"预设"——把一长串 spawn 配置压成一个名字
 *
 * 背景：接 opencode 要写 `--brain acp --acp-bin opencode --acp-args '["acp"]'`，
 * 记参数比记名字费劲，也容易抄错（尤其 args 的 JSON 引号）。
 * 预设只填**用户没显式给**的开关——显式参数永远优先（比如 `--preset opencode
 * --acp-permission read-only` 里权限照你说的算）。
 *
 * ⚠️ 新增预设 = 在这个表里加一行；不要在 cli.ts 里散落 if。
 * ==========================================================================*/

/** cli 的 flags 里与预设相关的子集（结构化类型，避免把 cli 的内部类型拖进来）。 */
export interface PresetFlags {
  preset?: string;
  brain?: string;
  acpBin?: string;
  acpArgs?: string;
}

export interface PresetSpec {
  /** 等价参数的人类可读形式（日志/文档用） */
  summary: string;
  brain: string;
  acpBin?: string;
  acpArgs?: string;
}

export const PRESETS: Record<string, PresetSpec> = {
  opencode: {
    summary: `--brain acp --acp-bin opencode --acp-args '["acp"]'`,
    brain: 'acp',
    acpBin: 'opencode',
    acpArgs: '["acp"]',
  },
  'claude-code': {
    summary: '--brain acp --acp-bin claude-code-acp',
    brain: 'acp',
    acpBin: 'claude-code-acp',
  },
};

/**
 * 把 `--preset NAME` 展开进 flags（就地修改），返回命中的预设名。
 * 返回 `null` = 没给 preset；未知名字抛错（配置错误要响亮，别静默忽略）。
 */
export function applyPreset(flags: PresetFlags): string | null {
  const name = flags.preset;
  if (!name) return null;
  const spec = PRESETS[name];
  if (!spec) {
    throw new Error(`未知 preset：${name}（支持：${Object.keys(PRESETS).join(' | ')}）`);
  }
  if (flags.brain === undefined) flags.brain = spec.brain;
  if (flags.acpBin === undefined && spec.acpBin) flags.acpBin = spec.acpBin;
  if (flags.acpArgs === undefined && spec.acpArgs) flags.acpArgs = spec.acpArgs;
  return name;
}
