# iroh-native —— Android 原生模块

把 Rust 核心（`libiroh_web.so`）通过 JNI 暴露给 JS。

## ★ 三个"改了会静默失效"的地方

这三个坑都真踩过，共同特点是**不报错**，只是行为不对。

### 1. `expo-module.config.json` 的 `android.modules` 不能少

```jsonc
{
  "platforms": ["android"],
  "android": {
    // ★ 必须有！写的是 Kotlin 类的全限定名
    "modules": ["vip.editor.irohchat.nativebridge.IrohNativeModule"]
  }
}
```

**只写 `platforms` 的后果**：模块能编进 APK、`.so` 也能加载，
但 JS 侧 `requireOptionalNativeModule('IrohNative')` 返回 `null` ——
界面显示「原生模块未注册」，一路走假数据。

这个症状**极具误导性**：日志里没有任何错误，`System.loadLibrary` 也成功。
第一版就是漏了这个数组，白屏排查绕了一大圈。

### 2. 包名 + 类名 + 方法名 = JNI 符号名，改名就 `UnsatisfiedLinkError`

```
package vip.editor.irohchat.nativebridge
object  IrohNative
  ↓
Java_vip_editor_irohchat_nativebridge_IrohNative_nativeCreate
```

校验：`node ../scripts/check-jni-symbols.mjs`（源码层）
      `node ../scripts/verify-so-symbols.mjs <path.so>`（产物层）

### 3. 异步方法必须 `SuspendBody`

```kotlin
// ❌ withContext 不能这么用（lambda 是 crossinline 且非 suspend）
AsyncFunction("send") { text: String -> withContext(Dispatchers.IO) { … } }

// ✅
AsyncFunction("send").SuspendBody<String, String> { text ->
    withContext(Dispatchers.IO) { … }
}
```

⚠️ 泛型顺序是 `<R, P0, P1, …>` —— **返回类型在最前**。

**症状**：11 个方法同一种错写法，**只报 1 个错**（重载解析在
返回 `Unit` 时恰好选中能编过的那个）。不能因为"大部分编过了"就以为对。

## `build.gradle` 里两处必须写

- `versionCode` / `versionName` —— **library 模块也要**，否则
  `expo-module-gradle-plugin` 在配置阶段就失败
  （`'android.defaultConfig.versionName' is not defined`）
- `ndk { abiFilters 'arm64-v8a' }` —— CI 只为 arm64 编 `.so`

## 快速验证（别每次都编整包）

```bash
cd android

# 改 Kotlin 后先跑这个：13 秒
./gradlew :iroh-native:compileDebugKotlin

# 通过之后再跑整包：几分钟
./gradlew :app:assembleRelease
```

## 真机运行时怎么确认走的是真链路

界面**顶部没有珊瑚色横幅** = 真链路。
有横幅 = 假数据，且横幅上会写明原因（模块未注册 / `.so` 加载失败）。
