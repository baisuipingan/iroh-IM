# 2026-10-10 阶段 D：协议单一来源（Rust 生成三端类型）

## 一句话

同一套协议以前在 Rust / 移动端 / agent-pi **各写一遍**，现在只剩 Rust 一份，
其余生成；`verify.sh` 每次重新生成并比对，不一致直接红。

## 为什么要做（不是洁癖，是已经发生的缺陷）

手抄的代价不是"多打几个字"，而是**静默漂移**：类型看着对、运行期读到 `undefined`、
还不报错。这次接上生成类型后，**当场被编译器抓出 5 处**：

| # | 漂移 | 后果 |
|---|---|---|
| 1 | 移动端 `RoomEvent` 写的是 `{ type: 'relay'; status }` —— Rust 实际发 `relayStatus{relays}` | 「中继状态事件」**从来没被处理过**；UI 靠 2 秒轮询兜着，看着像正常工作 |
| 2 | `PeerInfo.last_seen_ms` —— Rust 实际发 `lastSeenMs`（带名字段吃 `rename_all`） | 该字段运行期**永远是 undefined**（连接状态页显示不出"多久没出声"） |
| 3 | 移动端 `FileRef` 多带 `root_hash`（Rust 的 `FileRef` 只有 4 个字段，`root_hash` 属于 `FileMeta`） | 本地回显与服务器历史**形状不同**（重载后同一个文件卡片数据不一致） |
| 4 | `mock.test.ts` 里有一条断言**把漂移当成契约**（断言 `root_hash` 必须存在） | 测试在"守护错误" |
| 5 | `agent-pi` 往 `PiSdkBrainOptions` 传了一个不存在的 `room` | 纯噪音；且 agent-pi **此前完全没有类型检查**（Node 类型剥离只剥不查） |

## 做法

- **导出**：`client-wasm/src/ts_export.rs` 用 `ts-rs` 把 6 个客户端可见类型
  （`FileRef` / `FileMeta` / `ChatMessage` / `PeerInfo` / `RelayInfo` / `RoomEvent`）
  与**协议版本常量**一起渲染成单个 TS 文件；`scripts/gen-protocol-types.sh` 写盘。
- **两个必须记住的细节**（都在代码注释里）：
  1. `rename_all` 只作用**变体名与带名字段**，匿名字段保持 snake_case ——
     实测 ts-rs 的 serde-compat 处理**正确**（`{"type":"fileAccepted", file_id}`），
     并加了测试 `generated_ts_uses_serde_key_names` 钉死它（防生成器某天改行为）。
  2. ts-rs 默认把 `u64` 映射成 **`bigint`**，而 `JSON.parse` 给的是 `number` ——
     必须 `with_large_int("number")`，否则生成的类型与真实数据不符。
- **门控**：新增 optional 依赖 + `ts-export` feature，**只在导出时编译**。
  已用 `cargo tree` 实证：`ts-rs` **不在** wasm 依赖图、也不在默认依赖图里。
- **校验**：`scripts/check-protocol-types.sh` 重新生成到 `target/` 再逐字节比对，
  已并入 `scripts/verify.sh local`。
- **web 侧（纯 JS，没有类型系统）**：新增 `scripts/check-web-event-names.mjs` ——
  校验 `net.js` 的每个 `case '<事件名>'` 都真实存在于生成物里（**反向只提示不拦**：
  "协议里有、net 没处理"可能是有意的，例如 `history` 走 RPC）。
  已用**负向测试**证明它会红：注入 `case 'relay'` 后退出码 1 并指名道姓。
- **agent-pi 首次有类型检查**：`agent-pi/tsconfig.json`（借移动端那份 typescript/@types/node），
  也并入 `verify.sh`（缺依赖时**明确告警跳过**，不是静默跳过）。
- **移动端中继配置改为运行期拉取**（`mobile/src/config/relay-config.ts`）：
  启动拉 `https://im.pinkstar.cc/relay-config.json`，失败退**内置兜底**并把原因显示在进房页。
  以前是手抄副本 ⇒ 换中继/轮换 token 必须重新发版 App，现在不用。

## 同一次发版里顺带修掉的真实缺陷：窄屏抽屉盖住聊天区

验证阶段发现 `composer-resize` / `image-layout` **偶发**飘红，追下去是**两个真问题 + 一个测试自身的问题**：

1. **窄屏进房后侧栏抽屉盖住输入框（真 bug）**：`≤760px` 时侧栏是抽屉（CSS 断点），
   而 `chats.js` 只在"**点**列表里的房间"时收起它 —— **程序化进房**（`?autostart=1`、
   深链、测试钩子）这条路没有。实测 `elementFromPoint(input 中心)` 命中的是 `panel-body`，
   也就是**用户点不到输入框**。
   修法：`openRoom` 里按同一个断点收一次抽屉（`util.js` 新增 `NARROW_QUERY`/`isNarrow()`，
   顺手把原来散落的 `'(max-width: 760px)'` 魔法字符串收敛成一处）。
2. **理论上"点遮罩关闭"在 320px 上根本点不到**：抽屉宽 264px + 左栏 56px = 正好占满 320px，
   遮罩（z-index 更低）被完全盖住 —— 点遮罩命中的是抽屉本身。
   修法：CSS 里给抽屉**留 28px 可点窄条**（`calc(100vw - var(--rail-w) - 28px)`），否则
   最窄设备上抽屉"打不开也关不掉"。测试侧同时改成**调应用 API**（`sidebar.closePanel()`）
   而不是点遮罩 —— 后者在窄屏会被静默吞掉（Playwright 点到面板，`.catch()` 把它咽了）。
3. **测试自己抢时序（测试 bug，也是飘红的直接原因）**：用例只等 `window.__state`（钩子装好那刻），
   而启动流程**还要继续跑** —— 启动尾巴那句 `sidebar.show('chats')` 会在窄屏把抽屉重新打开，
   正好盖住后面要点的元素。实测抓到调用栈：`main.js:488 → sidebar.show → openPanel`。
   修法：`test-hooks.js` 增加明确的 `window.__iroh_booted`（由 main.js 在启动尾巴置位），
   两个用例改成等它。改完**连跑 5 轮全绿**（此前约 1/3 概率飘红）。
4. **另一条防线自己的判据太宽（测试 bug）**：`redesign.py` 的"拓扑不含设计稿编造的量"
   按**子串**匹配裸 `"256"`，于是真实探测延迟 `256 ms` 被误判成"照抄了 256 Bit" ——
   这条本该防编造，却成了噪音。改为按词匹配 `256 Bit`，并且**报出命中了什么**
   （原来只打印"发现编造量"，根本没法排查）。

## 验证

| 项 | 结果 |
|---|---|
| `bash scripts/verify.sh all` | **退出码 0**（下面全是它的组成部分） |
| 生成物一致性 | 两个消费文件均与 Rust 定义一致 |
| Rust 单元/集成 | 69 通过（含新增 3 条：字段名契约、导出清单、协议版本常量） |
| agent-pi 类型检查 | 通过（新增；此前没有这一步） |
| 移动端 `typecheck` / `npm test` | 通过 / 15 项断言通过（新增 relay-config 契约 7 项） |
| agent-pi faux 冒烟 | 通过 |
| `bash scripts/verify.sh local` | 全绿（lint / npm test / 模块检查 / 协议一致性 / agent-pi tsc / Rust / 安全 18 项） |
| web 事件名与协议一致 | 通过（并做了**负向测试**：注入 `case 'relay'` 会红） |
| 浏览器回归合计 | **594 项通过**（CDP 主套件 265、polish 90、孤立进房 7、历史滚动 20、主题同步 16、图片布局 94、修复回归 52、消息归属 38、存储与第四人 12） |
| 线上（`im.pinkstar.cc`） | 孤立进房 7/7；`composer-resize` 12/12；`image-layout` 94/94 |
| 线上 6 个产物 SHA-256 | 与本地逐一致（`main.js`、`js/util.js`、`js/test-hooks.js`、`js/ui/sidebar/chats.js`、`css/layout.css`、`pkg/iroh_web_bg.wasm`） |
| 线上 agent | 已同步并重启：`active`，hello 正常、进入房间 `patrick` |

## 发布

- 前端：Cloudflare Worker `iroh-chatroom`，版本 **`77f83798-6860-4181-a52b-8ec9ef1bd458`**。
  本次**重建了 wasm**（`room.rs` 等被改过；`deploy-web.sh` 的"wasm 不比源码旧"是硬闸门），
  6 个产物更新。
- 关于 `ts-rs`：它**不在 wasm 也不在默认依赖图**（`cargo tree` 实证），所以生成类型这套东西
  不会进任何已部署产物的编译路径 —— 重建只是为了满足"产物必须比源码新"这条规则。
- agent-pi 已 rsync 到服务器并重启（`src/protocol.gen.ts` 是运行时 import）。
- roomd 未动。

## 仍手写、留待后续的部分（诚实记账）

- **行协议信封**（`HelloFrame` / `ReplyFrame` / `EventFrame` / `IPC_VERSION`）：
  它们在 `client-wasm/src/bin/agent.rs` 里是 `json!` 拼的，Rust 侧没有强类型可导出。
  要么先给它们定义 Rust 结构（顺带获得类型安全），要么继续手写 + 文档同步。
- daemon 自产的 camelCase 事件（`fileSendStarted` 等）同上。

## 回滚

本轮不动协议、不动数据。两个层面都可单独回滚：
- 前端：Cloudflare 控制台切回上一个版本（`57368978-…`），或在工作树还原
  `frontend/{main.js,js/util.js,js/test-hooks.js,js/ui/sidebar/chats.js,css/layout.css}` 后重新 `deploy-web.sh`。
- 类型/工具：还原 `mobile/src/bridge/{types,protocol.gen}.ts`、`agent-pi/src/{protocol.ts,protocol.gen.ts}`、
  `mobile/src/config/*`、`scripts/*protocol*|check-*` 并把 agent-pi 重新 rsync 回去。
