# iroh 聊天室 · 移动客户端（Expo + React Native）

Android / iOS 原生客户端。**核心价值：能打洞直连** —— Web 端永久 relay-only
（浏览器发不了 UDP），原生端可以 P2P，中继只做兜底。

## 现在能跑什么

**UI 已经能跑在手机上**（用 mock 数据），通信层还是假的 —— 这是刻意的：
UI 有 ~7000 行的活，而 Rust 产物还没编出来，两边并行不互相等。

```
src/bridge/transport.ts    ← 唯一契约（Mock 与 Native 都实现它）
src/bridge/mock.ts         ← 现在在用：假数据，自带"假队友"会回话
src/bridge/native.ts       ← 待补：调 Rust 编出的 .so
```

替换只需改 `App.tsx` 里的一行（见该文件注释）。

## 跑起来

```bash
cd mobile
npm install

# 方式 A：Expo Go（最快，但**用不了原生模块**，只能看 UI）
npm run start:go

# 方式 B：development build（要装原生模块时用这个）
npx expo run:android      # 需要 Android SDK + NDK
```

> ⚠️ **Expo Go 只够看 UI**。一旦接上 Rust 原生模块就必须用 development build
> （自己编的 APK），因为原生模块是**已编译的二进制**，没法在运行时下载进 Expo Go。

## 目录

| 路径 | 职责 |
|---|---|
| `src/bridge/types.ts` | 与 Rust 一一对应的类型。**命名不统一，见该文件顶部说明** |
| `src/bridge/transport.ts` | `Transport` 接口 —— UI 与实现之间的唯一契约 |
| `src/bridge/mock.ts` | 假实现（含边界测试数据：长文本/emoji/跨天/文件卡片） |
| `src/bridge/useRoom.ts` | 事件流 → 可渲染 state（去重、房间核对） |
| `src/screens/` | 进房页 / 聊天页 |
| `src/components/` | 消息气泡 / 文件卡片 |
| `src/theme/tokens.ts` | 配色令牌，**从 `frontend/css/tokens.css` 移植** |

## 三条不减的约束（都在 `useRoom.ts` 里注释了原因）

1. 消息**按 id 去重** —— gossip 会重复投递，历史前插也会撞
2. **只认当前房间**的事件 —— 换房瞬间旧房间的迟到事件会到
3. 带 `file` 的消息渲染成**卡片**，不是文本气泡

## 与 Web 端的差异

| 维度 | Web 端 | 移动端 |
|---|---|---|
| 传输 | wasm | 原生 .so/.aar |
| 打洞 | ❌ 永久 relay-only | ✅ **可以直连** |
| 拥塞控制 | BBR3 + 2MB 初窗 | 同（该调优在 `RoomNode::start` 里，无平台门禁） |
| 文件落盘 | File System Access API | 平台文件 API（待接） |
| 深色主题 | ✅ 三选一 | ⏳ v1 只做浅色 |

## 下一步（按优先级）

1. **CI 编 Android `.so`** —— `ring` 需要 NDK 的 clang，本地可以不装、交给 CI
2. 写 `native.ts`，实现 `Transport` 接口
3. 文件接收（`accept_file` 已在 Rust 侧实现，RN 侧要走平台落盘）
4. 深色主题（令牌已按 Web 端同色相准备）

## 已知限制

- **不能接收文件**（UI 上按钮是 disabled 的，并写明了原因——比点了没反应诚实）
- 单进程单房间（多房间 = 多实例，各用独立身份目录）
- 消息列表的"贴底"逻辑是简化版；Web 端在这里踩过滚动锚定的坑，
  移动端等真机验证后再补
