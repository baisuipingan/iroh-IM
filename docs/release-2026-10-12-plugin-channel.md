# 2026-10-12 补上「万物皆插件」的客户端半边：前端插件通道

## 一句话

Rust 侧的能力早就能发 `RoomEvent::Plugin{name,payload}` 了，但**前端没有 case 接它** ——
事件到了浏览器直接掉进 `net.js` 的 default 被丢掉。于是"加一个能力"总还得改核心几个文件，
"插件"名不副实。这次把注册点补上。

## 之前到底断在哪

| 层 | 之前的状态 |
|---|---|
| Rust 能力（`RoomCapability`） | ✅ 注册即被服务；`Plugin` 事件能发（测试里已证） |
| 协议类型 | ✅ 由 Rust 生成、有闸门（事件名录里有 `plugin`） |
| **浏览器** | ❌ `net.js` 没有 `case 'plugin'`、`bus.js` 没有 `EV.PLUGIN`、没有任何渲染注册点 |
| **移动端** | ⚠️ 掉进 `useRoom` 的 `default` 被静默吞掉（加插件时会误判成"事件没发出来"） |

`scripts/check-web-event-names.mjs` 一直在提示这件事：它列出"协议里有、net.js 未处理"
的事件，`plugin` 长期在那张名单上。**这次让它从名单上消失了**（处理数 13 → 14）。

## 改了什么

1. **`frontend/js/plugins.js`（新）**：前端插件宿主 —— 一个 `name → {onEvent}` 的注册表，
   在模块里订阅一次总线，把 `EV.PLUGIN` 按名字分发出去。
   - 没注册的名字**不是错误**（对端可能有我们没有的能力）：只计数 + 一条 `console.debug`，
     `unhandled()` 能看到"谁在发没人认领的事件"（诊断不丢）。
   - 某个插件处理器抛错只影响它自己（其余插件照常收到）。
   - `register()` 返回注销函数（"卸载插件"这条路是通的）。
2. **`frontend/js/bus.js`**：新增 `EV.PLUGIN`，并把边界写在注释里 ——
   **消息格式与签名不是插件**（协议底座），这里只承载"能力自定义事件"。
3. **`frontend/js/net.js`**：`case 'plugin'` → 原样转发到总线（核心不解释内容）。
4. **`frontend/main.js`**：启动时 `import './js/plugins.js'` 装配插件宿主。
   ⚠️ 特意**不**把它挂进 `test-hooks.js` —— 那样"去掉测试钩子"会顺手把产品能力也拆掉。
5. **移动端 `useRoom.ts`**：显式 `case 'plugin'` 接住 + 日志（先把"静默吞掉"变成"有据可查"，
   插件渲染注册点等真有插件 UI 时再挂）。

## 现在的写法（插件作者视角）

```js
// 你自己的插件那侧，一行注册；核心与其它插件一无所知
import { roomPlugins } from '../plugins.js';
roomPlugins.register('vote', { onEvent: (payload) => renderVote(payload) });
```

配套的 Rust 侧不变（`RoomCapability` 三个方法 + `RoomEvent::Plugin`）。

## 已知限制（写下来免得下次踩）

- `RoomEvent::Plugin` **不带房间字段**（节点同时只进一个房间，隐含是当前房间）。
  插件需要区分房间时，把房间放进自己的 payload。
- 前端只解决了"收与分发"：真正的 UI 渲染由插件自己实现，核心不提供组件体系。

## 验证

| 项 | 结果 |
|---|---|
| 新增用例 `scripts/e2e/plugin-channel.py` | **11 项全绿**。走的是真路径（`net._dispatch`，即 Worker 事件到达时那条），覆盖：注册后收到 payload+name／没人认领只计数不报错／别人的插件抛错不影响我／注销后回到未认领／列表正确 |
| `check-web-event-names.mjs` | 处理数 13 → 14，**`plugin` 从未处理名单消失** |
| 冒烟 | 通过（29 个钩子齐全、无页面异常） |
| `bash scripts/verify.sh all` | **退出码 0** |

## 发版与回滚

- 前端：Cloudflare Worker `iroh-chatroom` → **`2909e983-6d44-44f4-9a36-a6fe3e3712bf`**；
  线上哈希与本地逐一相等：`main.js` `606a7ec4f1519200`、`js/net.js` `0f608eafea8d5430`、
  `js/bus.js` `3ca24bcbf42928a2`、`js/plugins.js` `9637569e4f949980`（新文件，已上线）。
- 回滚：切回上一个 CF 版本 **`fec066c5-fe64-476c-9549-ae3370bf75ea`**。纯前端变更，无数据影响。
