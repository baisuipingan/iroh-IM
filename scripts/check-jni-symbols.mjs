#!/usr/bin/env node
/* ============================================================================
 * 校验 JNI 符号名：Rust 导出的 ↔ Kotlin 声明的
 *
 * ## 为什么需要这个脚本
 *
 * JNI 的符号名是**按包名/类名/方法名拼出来的**：
 *
 *     Java_<包名下划线>_<类名>_<方法名>
 *
 * 任何一处改名（包、类、方法）都会让匹配失败，而失败**只在运行时**才暴露：
 * `UnsatisfiedLinkError`，报错只说"找不到 xxx"，**不会告诉你名字拼错了**。
 * 在 CI 上编过、装到手机上才崩，是最浪费时间的一种失败。
 *
 * 所以把这件事变成**构建前的静态检查**：两侧清单对撞，不一致就退出码非 0。
 *
 * 跑法：node scripts/check-jni-symbols.mjs
 * ==========================================================================*/

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本脚本在 <repo>/scripts/ 下，所以仓库根是上一级 */
const REPO = resolve(HERE, '..');

const RUST_FILE = join(REPO, 'client-wasm/src/jni_api.rs');
const KT_FILE = join(
  REPO,
  'mobile/modules/iroh-native/android/src/main/java/vip/editor/irohchat/nativebridge/IrohNative.kt',
);

/** Kotlin 包名 + 类名 —— 必须与 Rust 侧的符号前缀一致 */
const PKG = 'vip.editor.irohchat.nativebridge';
const CLS = 'IrohNative';
const PREFIX = `Java_${PKG.replaceAll('.', '_')}_${CLS}_`;

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const rust = readFileSync(RUST_FILE, 'utf8');
const kt = readFileSync(KT_FILE, 'utf8');

/* --- 1. Kotlin 的 package 与 object 名 --- */
const pkgMatch = kt.match(/^package\s+([\w.]+)/m);
if (!pkgMatch) fail(`Kotlin 文件里找不到 package 声明：${KT_FILE}`);
if (pkgMatch[1] !== PKG) {
  fail(`Kotlin 包名是「${pkgMatch[1]}」，但 Rust 侧符号写死了「${PKG}」。\n` +
    '   两边必须一致，否则 UnsatisfiedLinkError。');
}

if (!new RegExp(`^object\\s+${CLS}\\b`, 'm').test(kt)) {
  fail(`Kotlin 里找不到「object ${CLS}」（Rust 侧符号用的是这个类名）`);
}

/* --- 2. Rust 导出的符号 --- */
const rustSyms = new Set(
  [...rust.matchAll(/fn\s+(Java_[A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]),
);
if (rustSyms.size === 0) fail(`Rust 侧没找到任何 Java_* 导出函数：${RUST_FILE}`);

const rustShort = new Set(
  [...rustSyms].map((s) => {
    if (!s.startsWith(PREFIX)) {
      fail(`Rust 导出的符号「${s}」前缀不对。\n` +
        `   期望前缀：${PREFIX}\n` +
        `   实际对应 Kotlin 的 ${PKG}.${CLS}。`);
    }
    return s.slice(PREFIX.length);
  }),
);

/* --- 3. Kotlin 声明的 external fun --- */
const ktSyms = new Set(
  [...kt.matchAll(/external\s+fun\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
);
if (ktSyms.size === 0) fail(`Kotlin 侧没找到任何 external fun：${KT_FILE}`);

/* --- 4. 对撞 --- */
const onlyRust = [...rustShort].filter((s) => !ktSyms.has(s)).sort();
const onlyKt = [...ktSyms].filter((s) => !rustShort.has(s)).sort();

if (onlyRust.length || onlyKt.length) {
  console.error('❌ JNI 符号不匹配（运行时会 UnsatisfiedLinkError）：\n');
  if (onlyRust.length) {
    console.error(`  只在 Rust 侧存在（Kotlin 没声明，JS 永远调不到）：`);
    for (const s of onlyRust) console.error(`    - ${s}`);
  }
  if (onlyKt.length) {
    console.error(`\n  只在 Kotlin 侧声明（Rust 没导出，一调就崩）：`);
    for (const s of onlyKt) console.error(`    - ${s}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`✅ JNI 符号一致（${rustShort.size} 个）：`);
console.log(`   ${[...rustShort].sort().join(', ')}`);
