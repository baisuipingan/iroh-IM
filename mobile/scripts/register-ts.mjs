/* ============================================================================
 * Node 侧的 TS 解析钩子 —— **只给测试用**，不影响 App 打包
 *
 * 为什么需要：
 *   源码里写的是 Metro 风格的无扩展名导入（`from './types'`），Metro 能解析。
 *   但 Node 22 的 `--experimental-strip-types` **只剥类型、不做扩展名补全**
 *   （`--experimental-resolve-ts` 是 Node 23 才有的），所以直接 `node xxx.test.ts`
 *   会报 ERR_MODULE_NOT_FOUND。
 *
 *   与其为了跑测试去改源码风格（加 .ts 后缀），不如在测试侧挂个解析钩子 ——
 *   源码保持 App 该有的样子，测试也能跑。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs src/bridge/mock.test.ts
 * ==========================================================================*/

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(pathToFileURL('./scripts/ts-resolve-hook.mjs'));
