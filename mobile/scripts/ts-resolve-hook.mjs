/* ============================================================================
 * 解析钩子：把无扩展名的相对导入补成 `.ts` / `.tsx`
 *
 * 只补相对路径（./ 或 ../），且只在默认解析失败后兜底 ——
 * 这样它绝不会改到 node_modules 里的解析行为。
 * ==========================================================================*/

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = ['.ts', '.tsx', '.js', '.mjs'];

export async function resolve(specifier, context, nextResolve) {
  // 先按原样解析；成功就直接返回（绝大多数导入走这条）
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!specifier.startsWith('.')) throw err;

    const base = context.parentURL ? new URL(specifier, context.parentURL) : null;
    if (!base) throw err;

    const basePath = fileURLToPath(base);
    for (const ext of CANDIDATES) {
      const withExt = `${basePath}${ext}`;
      if (existsSync(withExt)) {
        return { url: `${base.href}${ext}`, shortCircuit: true };
      }
      // 目录导入（./foo → ./foo/index.ts）
      const indexPath = `${basePath}/index${ext}`;
      if (existsSync(indexPath)) {
        return { url: `${base.href}/index${ext}`, shortCircuit: true };
      }
    }
    throw err;
  }
}
