# 架构重构方案：房间为一等公民，能力即插件

> **本文是这次重构的唯一权威出处。** 会话 goal 指向本文；每期开工前先读它，
> 收工前做最后一节的「反漂移自检」。本文与已发布的发版记录冲突时，以本文为准并更新它。

## 0. 为什么改（判断不了时按它推）

产物要的是：**任何一个人（包括常驻节点）掉线，都不该影响别人进房和收发；
加一个新能力应该是"写一个插件"，而不是"改核心的分发表"。**
架构上宁可少一个花活，也不要多一处隐式耦合。

改造前的实际形态恰好相反：`join()` 连不上常驻节点就直接失败 —— 于是 roomd
从"房间里一个恰好常在线的用户"变成了**进房必经的基础设施**；同时核心把
`accept(GOSSIP/FILE/HISTORY)` 写死，三端协议类型各抄一份。

## 1. 终态（全部满足才算完成）

1. **进房不依赖任何特定节点**：连不上任何人也能进房、能发（消息排队等邻居），
   后台自动重连并在接上后补历史。"连不上常驻节点就报进房间失败"不得回归。
2. **roomd 退化为"装 history 插件的常驻 peer"**；rendezvous 与 history 是
   **两个独立插件**：不同 ALPN、不同开关、不同资源闸门、配置分两段。
3. **核心不再硬编码能力**：启动时的 accept 表来自运行时注册的插件列表；
   新增能力 = 新增一个 `RoomCapability` 实现，不改核心 dispatch（有测试证明）。
4. **协议只有一份定义**：web / mobile / agent 三端的 TS 类型由 Rust 生成，
   CI 校验"生成物与提交物一致"，禁止任何手抄镜像。
5. **线协议已切到 v5 且全网一致**：旧客户端被**显式**告知需要刷新，不再静默丢消息。
6. 每期都有：全绿回归证据 + 线上发版记录 + 明确的回滚路径。

## 2. 已拍板的决策（不许重议；要改先问）

| # | 决策 | 落地形态 |
|---|---|---|
| ① | rendezvous 与 history **拆开** | 同进程双插件，**不新增部署单元**（要物理分离再说） |
| ② | 历史保持**明文**存储 | 不做端到端加密历史；"常驻节点能读到文本"这条边界写进文档 |
| ③ | 事件面**保留强类型** | 另加通用 `Plugin{name,payload}` 变体给第三方能力用 |
| ④ | 协议走**破坏性** bump v4→v5 | 切换时清历史（**清之前必须备份**） |
| ⑤ | **每期一发** | 不攒大版本；每期独立回滚 |

> ④ 与 ⑤ 的张力已在顺序里解决：B′/C′ 全部按**增量**开发（新旧端互通照常），
> v5 标记只在第 4 步翻**一次** —— 既每期一发，又只破坏一次。

## 3. 现状 → 目标（差距清单）

| 现状 | 目标 | 归属 |
|---|---|---|
| 进房必须连上 roomd，否则 `bail!`（`client-wasm/src/room.rs` join） | 连不上也能进房，降级 + 后台重连 | **阶段 A ✅ 已上线** |
| 用 `fetch_history(room,1)` 的**副作用**让 roomd 订阅房间 | 显式的 Announce 控制帧 | 阶段 C′ |
| 核心写死 `accept(GOSSIP/FILE/HISTORY)` | 能力注册表：ALPN → 插件 | 阶段 C′ |
| 三份手抄协议（Rust serde / `mobile/src/bridge/types.ts` / `agent-pi/src/protocol.ts`），已漂过（`relay` vs `relayStatus`） | 单一来源生成 TS | 阶段 D |
| relay 配置两份（`frontend/relay-config.json` + `mobile/App.tsx` 硬编码） | 运行期拉取 + 内置兜底 | 阶段 D |
| roomd 同时是入口与历史提供者，不可拆 | 两个独立插件 | 阶段 B′ |
| 历史只有 roomd 一个来源 | 多提供者 | 阶段 E（暂缓） |

## 4. 分期与顺序（不许跳步，每期做完发一版）

| 顺序 | 内容 | 破坏性 | 状态 |
|---|---|---|---|
| 0 | 独立小修：agent 冷却竞态 / 接收累计上限 / 低权限运行 | 否 | ✅ 已完成（2026-10-10） |
| 1 | **阶段 D**：协议单一来源（Rust→TS）+ relay 配置运行期拉取 | 否 | ✅ 已完成（2026-10-10） |
| 2 | **阶段 B′**：rendezvous 与 history 拆成同进程双插件 | 否（增量） | ✅ 已完成（2026-10-10） |
| 3 | **阶段 C′**：能力注册表 + `Plugin` 事件变体 + `Announce` 帧 | 否（增量） | ✅ 已完成（2026-10-10） |
| 4 | **v5 切换**：bump + 版本握手 + 清历史（先备份） | **是** | ✅ 已完成（2026-10-10） |
| 5 | **阶段 E**：多历史提供者 | 否 | 暂缓，需先确认隐私边界 |

### 阶段 D — 协议单一来源
- Rust 侧用 `ts-rs`（或等价物）在构建时生成 `mobile/src/bridge/protocol.gen.ts`
  与前端用的 `.d.ts`；三端改 import，删掉手抄文件。
- `verify.sh` 增加"生成物与提交物一致"检查（不一致直接红）。
- 移动端不再硬编码 relay 配置：启动时拉 `https://im.pinkstar.cc/relay-config.json`，内置兜底。
- 先做它的理由：后面 C′ 与 v5 的协议改动会自动同步到三端类型，显著降低返工与漂移。
- **实际结果**：接上后编译器当场抓出 5 处手抄漂移（详情见该发版记录）。
- **尚未生成、仍手写的部分**：行协议信封（`HelloFrame`/`ReplyFrame`/`EventFrame`）与
  `IPC_VERSION` —— 它们在 `bin/agent.rs` 里是 `json!` 拼的，要先有 Rust 强类型才能导出。
  列为阶段 C′ 的顺带项（给它们定义结构体，同时获得类型安全）。
- **B′ 的遗留（记在 C′）**：Android 桥仍是"一个个参数搬运"（`relays/relayToken/anchorId/anchorRelay`），
  没法把 `rendezvous`/`history` 两个角色传进原生层；移动端目前靠 Rust 的 anchor 回退，行为等价。
  C′ 把 Android 桥改成**直传 RoomOptions JSON** 时一并接上 —— 那样以后协议加字段也不用再改 Kotlin。

### 阶段 B′ — rendezvous / history 双插件
- 新 ALPN（如 `editor.vip/iroh-rendezvous/1`）：请求 `{room}` → 返回当前成员 EndpointId 列表
  （从 roomd 已有的 presence 快照取）。
- 客户端进房：先问 rendezvous 拿候选（**可选**、超时不影响）→ `subscribe_and_join(topic, 候选+缓存)`
  → 失败走阶段 A 的降级。roomd 未配置时一切照旧。
- 两个插件各自的开关与资源闸门独立（容量 / 速率 / 空闲回收都要有）。

### 阶段 C′ — 能力注册表
```rust
trait RoomCapability: Send + Sync {
    fn alpn(&self) -> &'static [u8];
    fn name(&self) -> &'static str;              // 诊断页显示
    fn limits(&self) -> CapabilityLimits;        // 每插件自己的闸门
    fn on_room_joined(&self, room: &str);        // 可选：房间订阅时的副作用
    fn handle(&self, conn: Connection);          // Router 分发
}
```
浏览器 = Gossip + Files；roomd = Gossip + History（+ Rendezvous）；agent = Gossip + Files。
同时把"敲门 `fetch_history`"换成**显式的加入声明**，让"服务端订阅房间"不再依赖数据请求 ——
这也是阶段 E 的前置。

> ⚠️ **实现偏离（2026-10-10 已落地，记录原因）**：本节原来写的是
> 「换成显式 `Wire::Announce { room }`（**签名广播**）」。实际实现成了
> **独立 ALPN 的显式声明**（`editor.vip/iroh-announce/1`，客户端**直连**每个服务端角色发 `{room}`）。
> 原因是**签名广播到不了尚未订阅该房间的服务端** —— 服务端没订阅这个 topic，就收不到里面的广播，
> 于是"声明"永远无法让它开始订阅（鸡生蛋）。直连声明没有这个问题，而且与 B′ 的入口查询同构、
> 天然支持"每个服务端角色被单独告知"（阶段 E 需要）。
> 方向没变（都是"用显式声明取代读数据的副作用"），只是载体从 gossip 广播换成了点对点请求。
> 详见 `docs/release-2026-10-10-capability-registry.md`。
验收要有"注册一个假插件，只有装了它的 peer 响应其 ALPN"的用例。

### v5 切换（唯一一次破坏性发布）
- `sigfmt::PROTO_V4` → v5；加**版本握手**：旧端拿到明确提示（"版本过旧，请刷新"），
  而不是静默丢消息。
- 清 roomd 历史：**先做 SQLite 一致性备份**，再清；回滚步骤写进发版记录。
- 顺序：roomd / agent 先升，再上前端；同一窗口内完成。

> **实现结果（2026-10-10）**：见 `docs/release-2026-10-10-protocol-v5.md`。
> 两件值得写进正文的事：
> ① "统一版本串"让**新旧混跑时消息全线被丢**（两个方向都是），所以这四件
>    （roomd / 前端 / agent 二进制 / agent-pi 适配器）**必须同一窗口**换完 ——
>    实测确认过，不是纸面风险。
> ② 握手字段必须 `#[serde(default)]`：旧端**不发**这个字段 ⇒ 读到空串 = 旧版，
>    这正是客户端能识别"对端是旧的"的依据。

## 5. 每期完成定义（DoD，缺一不可）

- 改动最小，沿用现有代码与注释风格（**这个仓库的注释是资产，要写"为什么"**）。
- 新增/修改的行为必须有测试；测试要能复现"改之前的错"。
- `bash scripts/verify.sh all` 全绿（Rust 单测+集成 / 安全攻击回归 / 浏览器回归）。
- 涉前端 → Cloudflare 发版并**核对线上哈希**；涉 native → 重建并在服务器安装，必要时出 Release。
- 写 `docs/release-YYYY-MM-DD-*.md`：版本号、验证数字、回滚方式。
- 发版前必须存在可回滚点（SQLite 备份 / 上一个 CF 版本 / 旧二进制副本）。

## 6. 硬约束（违反即视为失败）

- **不把消息格式与签名插件化**（会让验签与跨版本互认碎掉）；**不做动态库加载式插件**。
- 插件不许绕过自己的资源闸门（roomd 现有的容量上限 / LRU / 限速 / 空闲回收是样板）。
- 不许"改了源码但产物没重建"就发版：wasm 与 native 必须比源码新。
- 不许把"连不上任何节点"当错误处理（阶段 A 定下的语义必须保住）。
- 不许动 `.workbuddy/memory/**`（用户数据）。
- 不许让服务器上跑的二进制处在"不属于任何 Release"的状态。

## 7. 不做（防范围蔓延，除非明确要求）

端到端加密历史 / 多历史提供者（阶段 E）/ iOS 端实现 / UI 改版 / 性能压测。

## 8. 反漂移自检（每期收工前逐条回答；答不上就是偏了）

1. 这一期有没有让"任何 peer 掉线不影响别人"这条**变差**？
2. 核心的能力分发表是变小了、更通用了，还是**又多了一个 if**？
3. 协议类型是不是仍然**只有一份来源**？（有没有又手抄一份）
4. 这一期能不能**单独回滚**？回滚步骤写下来了吗？
5. 如果某条已拍板决策与现实冲突（做不了 / 代价远超预期），
   **停下来报告并等决定**，不要静默改方向。

## 9. 环境事实与踩过的坑（新会话直接用，不要重新侦察）

- **服务器 / 构建机同一台**：地址 / 端口 / 私钥路径写在**本机的 `scripts/build.env`** 里
  （`.gitignore:59` 已排除，**不入库**）—— 本仓库是公开的，所以这份文档里**不写**主机名与密钥路径。
  （旧端口 22 已不监听；`deploy/agent/install-release.sh` 等脚本里的默认值要按环境覆盖。）
- `scripts/build.env` 已指向该端口与密钥（**该文件不入库**）。构建 wasm：
  `bash scripts/build-wasm.sh release`；原生：`bash scripts/build-wasm.sh native`（产出 `dist/roomd`、`dist/relay-probe`）。
- **本地开发服务**：`python3 scripts/dev-serve.py 8099` —— 必须跑在**常驻会话**里（`nohup &` 会被回收）。
  ⚠️ 它的 accept 队列默认只有 5，页面并行拉 ~25 个模块会溢出被内核 RST
  （表现：页面停在"启动中"、`ERR_CONNECTION_RESET`，而 curl 单个请求永远 200）。已修为 128，别改回去。
- **带 CDP 的 Chrome 必须加** `--no-proxy-server --proxy-bypass-list='*'`，否则本机代理把
  localhost 拦成 RST，所有 CDP 用例一起红。
- **跑大套件前先看内存**：16G 机器很容易耗尽，Chrome 渲染进程会被杀（症状是用例 `BrokenPipe`）。
- roomd 历史**已于 2026-10-10 的 v5 切换中清空**（清前 3570 条）。
  备份：`/opt/iroh/backups/roomd/roomd-20261010T120121287111Z.tar.gz`；
  旧库原样留在 `data/history/cleared-20261010-200154/`（当天可原地回滚）。
- 线上前端当前版本：`1483915c-a1cf-40de-b151-b5810a956e63`（v5）；上一版 `7eb4fa8a-…`（C′）。
- roomd 当前二进制 `7280433a…`（v5）；回滚副本 `/opt/iroh/roomd/roomd.bak-20261010-200154`（= C′ `77280f12…`）。
- 常驻 agent 跑在 `iroh-agent-pi.service`，账号 `iroh-agent`（非 root），房间 `patrick`；
  Rust 二进制 `fd906732…` 与 `agent-pi/src/protocol.gen.ts`（v5）**都已更新**。
  ⚠️ 但那个二进制是**本地构建**（与 roomd 同一次 `build-wasm.sh native`），
  **不在任何 GitHub Release 里** —— 违反第 6 节的硬约束，缺口与补法见
  `docs/release-2026-10-10-protocol-v5.md` 的"未完成 / 偏离"。
- **发布前必读**：本仓库是**公开**的，所以 `docs/*` 里不要写服务器 IP 与私钥路径 ——
  但本文件 §9 第一行与 `release-2026-10-10-roomd-decouple.md` 里**已经写了**，
  真要提交前得先处理掉（见发版记录的同一节）。
- **`deploy-web.sh` 的 DNS 修正代理现在是"按需"的**：它会先探一下
  `api.cloudflare.com` 能不能直连，能直连就不起代理。原因：那个代理会把 OAuth
  续期用的 `sparrow.cloudflare.com` 一起拦掉，令牌一过期就变成
  "auth server could not be reached"，报错指向网络、真凶是自家代理（2026-10-10 卡了一次发版）。

## 10. 进度台账

| 期 | 状态 | 证据 |
|---|---|---|
| 阶段 A（roomd 不再是硬依赖） | ✅ 已上线 | `docs/release-2026-10-10-roomd-decouple.md`；浏览器回归 594 项全绿；线上孤立进房 7/7 |
| 0（agent 三项小修） | ✅ 已上线 | 同一发版记录附录；`scripts/test-agent-adapter.mjs` 7 条；服务器非 root 运行已核对 |
| 阶段 D | ✅ 已完成 | `docs/release-2026-10-10-protocol-single-source.md`；当场抓出 5 处真实漂移；线上 `77f83798-…`；`verify.sh all` 退出码 0（浏览器 594 项）；顺带修掉窄屏抽屉盖住输入框的真 bug |
| 阶段 B′ | ✅ 已完成 | `docs/release-2026-10-10-rendezvous-split.md`；roomd `857dcd4c…`、前端 `77b7da5e-…`；`verify.sh all` 退出码 0；线上"入口拆分"6/6 |
| 阶段 C′ | ✅ 已完成 | `docs/release-2026-10-10-capability-registry.md`；roomd `77280f12…`、前端 `7eb4fa8a-…`；`verify.sh all` 退出码 0（浏览器 618 项）；线上"入口拆分"6/6 |
| v5 切换 | ✅ 已完成 | `docs/release-2026-10-10-protocol-v5.md`；roomd `7280433a…`、前端 `1483915c-…`；Rust 71；浏览器逐套件全绿（2 处负载抖动单独复跑均绿）；线上哈希逐一相等 |
| 阶段 E（多历史提供者） | ⏳ 暂缓 | 需先确认隐私边界 |
