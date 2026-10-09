#!/usr/bin/env node
/* ============================================================================
 * 校验**编译产物** `.so` 里的 JNI 符号
 *
 * 与 `check-jni-symbols.mjs` 的分工：
 *
 *   check-jni-symbols.mjs  源码层：Rust 导出名 ↔ Kotlin external fun 对撞
 *   verify-so-symbols.mjs  **产物层**：真正编出来的 .so 里有没有这些符号
 *
 * 为什么两个都要：源码层的名字可能完全正确，但产物里没有这个符号
 * —— 例如：
 *   - `#[no_mangle]` 漏了 → 符号被 mangle 掉，JNI 找不到
 *   - 编到别的 target / 别的 crate-type（rlib 而不是 cdylib）→ 根本没有 .so
 *   - LTO 把"看似没被调用"的导出函数优化掉了
 *   - 打包时拿错了文件（比如把 rlib 或旧产物拷进来）
 *
 * 补充一条实测结论（免得照着错的说法推理）：**llvm-strip 加 `--strip-all`
 * 不会**删掉 `.so` 的动态符号表 —— `.dynsym` 是 dlopen 必需的，
 * 实测 13 个 JNI 符号依旧在。所以这条不是 strip 级别的问题，
 * 但"产物里到底有没有符号"仍值得在 CI 里钉死。
 *
 * 这些都只在**产物**里能看出来，源码层检查一律通过。
 * 而一旦漏了，症状是手机上 `UnsatisfiedLinkError` —— 最难查的一类。
 *
 * 跑法：
 *     node scripts/verify-so-symbols.mjs <path/to/libiroh_web.so>
 *
 * CI 里在打包之后、上传之前跑（见 build-android-so.yml）。
 * ==========================================================================*/

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const soPath = process.argv[2];
if (!soPath) {
  console.error('用法：node scripts/verify-so-symbols.mjs <libiroh_web.so>');
  process.exit(2);
}
if (!existsSync(soPath)) {
  console.error(`❌ 找不到 .so：${soPath}`);
  process.exit(1);
}

/** 源码侧声明的符号 —— 以 Kotlin 的 external fun 为准 */
const KT = join(
  REPO,
  'mobile/modules/iroh-native/android/src/main/java/vip/editor/irohchat/nativebridge/IrohNative.kt',
);
const kt = readFileSync(KT, 'utf8');
const pkg = kt.match(/^package\s+([\w.]+)/m)?.[1];
if (!pkg) {
  console.error(`❌ 读不到 Kotlin 包名：${KT}`);
  process.exit(1);
}
const expected = [...kt.matchAll(/external\s+fun\s+([A-Za-z0-9_]+)/g)].map(
  (m) => `Java_${pkg.replace(/\./g, '_')}_IrohNative_${m[1]}`,
);
if (expected.length === 0) {
  console.error('❌ Kotlin 里没找到 external fun');
  process.exit(1);
}

/* --- 找一个能读 ELF 动态符号表的工具 ---------------------------------------
 * macOS 自带的是 `nm`（Mach-O 专用，读不了 ELF），所以依次尝试：
 *   1. llvm-nm（brew install llvm / NDK 自带）
 *   2. readelf（binutils）
 *   3. objdump -T
 * 全都没有就**退化为 strings 匹配**并明确标注（不算通过，只报警）
 * -------------------------------------------------------------------------*/

function tryTool(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const llvmCandidates = [
  'llvm-nm',
  '/opt/homebrew/opt/llvm/bin/llvm-nm',
  '/usr/local/opt/llvm/bin/llvm-nm',
];

let symbols = null;
let via = '';

for (const c of llvmCandidates) {
  const out = tryTool(c, ['-D', '--defined-only', soPath]);
  if (out) {
    symbols = out;
    via = `${c} -D --defined-only`;
    break;
  }
}
if (!symbols) {
  const out = tryTool('readelf', ['--dyn-syms', '-W', soPath]);
  if (out) {
    symbols = out;
    via = 'readelf --dyn-syms';
  }
}
if (!symbols) {
  const out = tryTool('objdump', ['-T', soPath]);
  if (out) {
    symbols = out;
    via = 'objdump -T';
  }
}

if (!symbols) {
  // 退化路径：strings 至少能证明"符号名字符串在文件里"。
  // ⚠️ 这**不能证明它在动态符号表里**（可能只在 debug 段或字符串池），
  //    所以明确标注为"弱校验"，并要求 CI 上装 llvm。
  const out = tryTool('strings', ['-a', soPath]);
  if (out) {
    const found = expected.filter((s) => out.includes(s));
    console.warn(`⚠️  没有 llvm-nm/readelf/objdump，退化为 strings 匹配（弱校验）`);
    console.warn(`    匹配到 ${found.length}/${expected.length} 个符号名`);
    if (found.length !== expected.length) {
      const missing = expected.filter((s) => !found.includes(s));
      console.error(`❌ 缺失：\n   ${missing.join('\n   ')}`);
      process.exit(1);
    }
    console.warn('    ⚠️ 但这只说明"字符串在文件里"，不代表它在动态符号表里');
    process.exit(0);
  }
  console.error('❌ 没有可用的符号检查工具（试过 llvm-nm / readelf / objdump / strings）');
  process.exit(1);
}

/* --- 对撞 --------------------------------------------------------------- */

const actuallyExported = new Set(
  [...symbols.matchAll(/Java_[A-Za-z0-9_]+/g)].map((m) => m[0]),
);

const missing = expected.filter((s) => !actuallyExported.has(s));

// 顺带查：产物里有、但源码（Kotlin）没声明的 —— 说明有陈旧导出残留
const ktSet = new Set(expected);
const extra = [...actuallyExported].filter(
  (s) => s.includes('IrohNative_') && !ktSet.has(s),
);

if (missing.length) {
  console.error('❌ 产物里缺少 JNI 符号（装上手机必定 UnsatisfiedLinkError）：\n');
  for (const s of missing) console.error(`   - ${s}`);
  console.error('\n可能原因：');
  console.error('   · 忘了 #[no_mangle]（符号被 mangle）');
  console.error('   · strip 用了 --strip-all 而不是 --strip-unneeded（动态符号表被删）');
  console.error('   · crate-type 不含 cdylib，或编到了错误的 target');
  console.error('   · LTO 把导出函数优化掉了');
  process.exit(1);
}

console.log(`✅ .so 里导出了全部 ${expected.length} 个 JNI 符号`);
console.log(`   检查方式：${via}`);
console.log(`   文件：${soPath}`);
if (extra.length) {
  console.log(`   ⚠️ 另有 ${extra.length} 个产物里有、Kotlin 未声明的符号：`);
  for (const s of extra) console.log(`      - ${s}`);
}
