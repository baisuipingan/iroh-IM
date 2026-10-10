# 2026-10-10 协议 v5：统一版本串 + 版本握手 + 清历史

> 这是方案里的**第 4 步、唯一一次破坏性发布**（决策 ④）。前三期（D / B′ / C′）
> 都是增量的；这一步之后，改造只剩阶段 E（多历史提供者，暂缓）。

## 一句话

协议版本串从"每个消息族一个标签"（`p4`/`l3`/`q3`/`f3`）**统一成一个 `v5`**，
并给三个服务端能力（history / rendezvous / announce）加上**版本握手** ——
于是"版本不一致"从"消息静默验签失败"变成一条能看见的提示。

## 改了什么

### 1. 版本串统一（`sigfmt.rs`）
- `PROTO_V4` → **`PROTO_V5 = "v5"`**；`room.rs` 4 处（ChatMessage / Presence /
  LeaveMsg / FileQuery）+ `filetransfer.rs` 4 处（FileCtrl 家族）全部改用这一个常量。
- **为什么这是破坏性的**：签名载荷里的标签变了 ⇒ 旧代码验不过新消息，
  新代码也验不过旧消息。混跑时表现为**消息被丢弃**（双方都是）。

### 2. 版本握手（这是 v5 真正的价值）
- `HistoryRequest/Response`、`RendezvousRequest/Response`、`AnnounceRequest/Response`
  各加一个 `#[serde(default)] pub protocol: String`：
  - 服务端填自己的版本；
  - **`#[serde(default)]` 是关键**：旧服务端根本没有这个字段 ⇒ 客户端读到空串 =
    "对端是旧版"。这正是我们要能识别的情形。
- **客户端**（`RoomNode::note_peer_protocol`）：三个入口（拉历史 / 问入口 / 发加入声明）
  拿到响应就比对，不一致 ⇒ `warn!` + 新事件 `RoomEvent::ProtocolMismatch{room,ours,theirs}`。
  同一个版本只报一次（拉历史是高频动作，重复提示会变成噪音）。
- **服务端**（`note_client_protocol`）：请求里报的版本不一致就 `warn!`
  （每个「能力 × 版本」只报一次）。**只记日志、不拒绝** —— 拒掉旧客户端对谁都没好处，
  反而会把"还有旧版在跑"这条线索一起吞掉。
- **UI 三端都接**：web `main.js` 底部 sticky 提示（页面级、不按房间过滤）；
  移动端 `useRoom.protocolMismatch` + `ChatScreen` 红色横幅。

### 3. 清历史（决策 ④ 的另一半）
- 清之前**先做一致性备份**（SQLite + 身份打包，`roomd-backup.service`）：
  `/opt/iroh/backups/roomd/roomd-20261010T120121287111Z.tar.gz`（541 KB，含 `history.db` + `identity.key`）。
- 清掉时先停容器，`history.db` / `-wal` / `-shm` 三个文件**整体移到**
  `data/history/cleared-20261010-200154/`（当天可原地回滚），再启动。
- 旧库 **3570 条**（`111` 225、`长历史3186` 90、`长历史3231` 90、`贴底测试房` 72…）。
  不清的话这些旧签名的行会在新客户端加载时被**逐条丢弃**（每次拉历史都白验一遍）。

## ⚠️ 切换窗口：这一步的代价是**真实存在**的，不是纸面风险

必须记住的事实（这次实测确认，不是推测）：

| 组合 | 结果 |
|---|---|
| 新 roomd × **旧**客户端 | 旧客户端发的消息被 roomd **拒绝写入历史**（`拒绝写入历史：验签失败`），房间里的人互相看不到 |
| **旧** roomd × 新客户端 | 同上，只是方向反过来 |

所以顺序是 **roomd → 前端 → agent，同一窗口内完成**，不能各放各的。
本次实测到这件事本身就是一个证据：我在本地（新 wasm）跑浏览器回归、而线上 roomd 还是旧二进制时，
`file-history` / `multi-peer` / `room-isolation` 立刻大面积变红，roomd 日志里刷的是
`拒绝写入历史：验签失败 room=…`。**部署完 roomd 后同一批用例立刻全绿。**

（这也解释了为什么这条发布必须在"项目还没正式上线"的窗口里做。）

## 验证

| 项 | 结果 |
|---|---|
| **`bash scripts/verify.sh all`** | **退出码 0**（整轮一次过，无 CRASH、无 ❌） |
| Rust 单元/集成 | **71 通过 / 0 失败**（含新增的 `stale_history_provider_is_reported_as_protocol_mismatch_exactly_once`），另有集成/示例 4+1+1+1+8+1 全绿 |
| 安全攻击回归 | 17 + 1 通过 |
| 浏览器回归 | 23 组套件逐项绿：file-history 17、multi-peer 19、file-recipients 34、review-frontend 19、dm-removed 15、stale 4、offline-room 4、refresh 4、leave-cancel 1、room-isolation 4、card-revive 4、sidebar-pages 7、redesign 127、relay-enabled 6、polish 22、isolated-room 7、rendezvous-split 6、history-scroll 20、theme-sync 16、image-layout 94、fix-review 52、message-ownership 38、roomd-storage 12（**全部 0 失败**） |
| 线上 `im.pinkstar.cc` | 四个关键产物哈希与本地逐一相等（**见下面的"怎么验的"**） |
| roomd | `running` / `healthy` / `restarts=0`；启动日志 `房间能力：["history","rendezvous","announce"]`；**EndpointId 未变** |
| 常驻 agent | `iroh-agent-pi.service` active；日志 `hello：… chatProtocol=v5`、`已进入房间 patrick`；roomd 侧 `[patrick] 服务器助手 在线`，且**不再出现** `拒绝写入历史` |

### 线上哈希"怎么验的"（这一步踩了坑，别用本机直连）

本机（这次的开发机）出网**严重降级**：拉 `pkg/iroh_web_bg.wasm` 会被**静默截断**
（拿到 2,035,328 / 168,106 字节的不完整副本，`curl` 还报 200），
`page.goto https://im.pinkstar.cc/...` 会超时、`js/test-hooks.js` 直接被
`ERR_CONNECTION_RESET`。所以：

- **改从服务器验**：把本地 `dist/site` 里那四个文件 scp 到服务器，
  在服务器上 `curl` 线上的同一路径再比 sha256 —— 四条全等（结果见上）。
- 另外直接拉线上 `js/net.js` 确认 `const BUILD = 'v15'`，防止"页面缓存了旧 wasm"
  这类只在真实浏览器里才暴露的问题。
- ⚠️ 因此**这一轮没能做"线上页面的浏览器端到端探测"**（本机到 `im.pinkstar.cc`
  的连接会被重置）。等价的证明链是：线上 wasm 的**字节**= 本地字节（哈希相等）→
  这些字节在 `verify.sh all` 的浏览器回归里**对着生产 roomd / 生产中继**跑过 →
  切换后 roomd 库里多出的 **335 行**（`storage-*` / `fix-review-*` / `贴底测试房`）
  正是那些用例用 v5 签名写进去的。等出网恢复后补一次线上浏览器探测更稳妥。

新增的那条测试证明的是**行为**，不是常量：它拿一个**假的历史提供者**
（注册在 `HISTORY_ALPN` 上、响应里故意不带 `protocol` 字段）当对端，验证
①客户端收到 `ProtocolMismatch`（`theirs == ""`，不凭空造版本）、
②同一版本**只报一次**。把三处调用点注释掉后该测试**确实变红**（已验证）。

浏览器回归逐项（本轮全部复跑过）：

| 套件 | 结果 | 套件 | 结果 |
|---|---|---|---|
| file-history | 17/0 | room-isolation | 4/0 |
| multi-peer | 19/0 | card-revive | 4/0 |
| file-recipients | 34/0 | sidebar-pages | 7/0 |
| review-frontend | 19/0 | redesign | 127/0 |
| dm-removed | 15/0 | relay-enabled | 6/0 |
| stale | 4/0 | polish | 22/0 |
| offline-room | 4/0 | isolated-room | 7/0 |
| refresh | 4/0 | rendezvous-split | 6/0 |
| leave-cancel | 1/0 | history-scroll | 20/0 |
| theme-sync | 16/0 | image-layout | 94/0 |
| fix-review | 52/0 | message-ownership | 38/0 |
| roomd-storage | 12/0 | | |

> ⚠️ 关于"整轮跑"的**已知环境抖动**（不是本轮改动）：这台 16G 机器在连续开十几个
> 标签页的套件里偶发两处时序抖动 —— ① `file-recipients` 的"详情显示接收者昵称"
> 慢一拍（presence 还没到）、② `leave-cancel` 的取消快路径超过 8 秒阈值。
> 本轮**第一次** `verify.sh all` 就各撞上一次（其余全绿），单独复跑分别 34/0、1/0；
> 上面表里那次**整轮复跑是干净的退出码 0**。C′ 那轮记录的是同一类现象
> （内存压力下 CDP 直接断开）。

## 发布与回滚

- 顺序：**先 roomd、再前端、再 agent**（同一窗口）。
- 后端 roomd：`7280433a1baacab94882849c206b20da70400fa70e03dd85e7f83733284691f0`
  （`docker exec roomd sha256sum /usr/local/bin/roomd` 实测相等）。
- 前端：Cloudflare Worker `iroh-chatroom`，最终版本 **`e152e816-4b39-4361-898b-ddd3d3af3ba4`**
  （中间那次 `1483915c-…` 漏了下面这件事，紧接着补发了一次）。
  ⚠️ **重新编 wasm 必须 bump `net.js` 的 `BUILD`**（这次 v14→**v15**）：wasm 是按
  `pkg/iroh_web_bg.wasm?b=<BUILD>` 缓存的，不 bump 的话**已经来过页面的人会继续用旧 wasm**，
  而旧 wasm 正是 v4 签名 —— 对着新 roomd 就是全线丢消息。第一次发版漏了，补上了。
  线上产物哈希（与本地 `dist/site` 逐一相等）：
  `main.js` `c3c6ea9200568748`、`js/net.js` `7d8870b37d1908a3`、
  `js/iroh-worker.js` `474a90b97a288b24`、`pkg/iroh_web_bg.wasm` `265b33b5ebf17166`（3,835,336 B）。
  ⚠️ 校验方式：**把这几个文件 scp 到服务器再 curl 比对**。本机直连下 3.8 MB 的 wasm
  会**被截断**（实测拿到 2,035,328 / 168,106 字节的不完整副本，且 curl 不报错）——
  本机比出来的哈希不可信。
- agent：先用工作区源码本地构建的那份（`fd90673229b29a58…`）把窗口合上，
  **随后换成 Release `agent-v1.2.0` 的产物**（`c18a09277c025a0a…`，见"补齐 Release"一节），
  同时把 `agent-pi/src/protocol.gen.ts` 更新到 v5（`1190b257…`）。
  适配器自带的那道闸门当场拦住了错误组合：
  `启动失败：protocolMismatch: agent 报告 chatProtocol=v5，适配器只支持 v4；请同步升级` ——
  先升二进制不升适配器**不会**静默跑起来，这正是想要的行为。
- 回滚点：
  - 数据：`/opt/iroh/backups/roomd/roomd-20261010T120121287111Z.tar.gz`；
    被清掉的那份旧库原样留在 `data/history/cleared-20261010-200154/`。
  - roomd 二进制：`/opt/iroh/roomd/roomd.bak-20261010-200154`（= C′ 的 `77280f12…`）。
  - 前端：上一个 CF 版本 `1483915c-a1cf-40de-b151-b5810a956e63`（v15 之前那次）；
    再往前是 C′ 的 `7eb4fa8a-f7f5-4a58-8b5a-10f9126c6051`。
  - agent：`/opt/iroh-agent/bin/agent.bak-20261010-121937`（= Release `agent-v1.1.0`）；
    `agent-pi/src/protocol.gen.ts.bak-v4-20261010-201955`。
  - **回滚要三件一起回**：任何一侧单独回退都会回到"新×旧"的组合 ⇒ 全线丢消息。

## 补齐 Release（同一个窗口里做完）

`agent-v1.2.0` **已经出出来了**，服务器上跑的 agent 现在就是**这个 Release 的产物**
（硬约束"服务器上跑的二进制必须属于某个 Release"这一条到此才真正满足）。
过程与一个意外发现：

1. 六期改动（A / 0 / D / B′ / C′ / v5）此前**全都还没提交**。本次把它们提交到分支
   **`codex/protocol-v5`**（commit `6f44026`）并开了 PR
   [**#1**](https://github.com/baisuipingan/iroh-IM/pull/1)。走分支而不是直接推 `main`，
   是为了留一个可评审的落点（`main` 原本停在 `c65ef56`，即 v4 时代）。
   ⚠️ **提交前先脱敏**：`docs/architecture-refactor-plan.md` §9 与
   `docs/release-2026-10-10-roomd-decouple.md` 里原本写着**服务器地址与私钥路径**，
   而本仓库是公开的（`build-wasm.sh` 头部就写着"不写主机名与密钥路径"）。
   已改成指向 `scripts/build.env`（`.gitignore:59` 已排除，不入库）。
2. 先 `gh workflow run release-agent.yml --ref codex/protocol-v5` 跑了一次**只构建不发布**
   的矩阵（6 个平台全绿，`8m17s`）—— 确认没问题再打 tag，免得 tag 打出去、
   CI 挂在 `windows-11-arm` 这类 runner 上，Release 半死不活。
3. 打 tag `agent-v1.2.0`（指向 `6f44026`）→ CI 编 6 平台 → 14 个资产
   （每个产物旁边都有 `.sha256`，另有 `SHA256SUMS.txt`）就位，
   Release 现在是 **Latest**（`2026-10-10T13:46Z`）。
4. 用**文档里同一条路**装上去：`VERSION=agent-v1.2.0 bash deploy/agent/install-release.sh`
   → `sha256sum -c` 通过 → `/opt/iroh-agent/bin/agent` = `c18a09277c025a0a…`
   → 重启服务 → `hello：… chatProtocol=v5`、`已进入房间 patrick`、roomd 侧 `服务器助手 在线`。

### ★ 顺手挖出来的一个真 bug：agent 的安装链路本来就是坏的

`skills/iroh-agent/scripts/install.sh` 与 `deploy/install/agent-install.sh` 在不指定版本时
都走 `https://github.com/<repo>/releases/latest/download`。而 GitHub 的 **"Latest" 当时是
`android-v0.1.0`**（它只有一个 `libiroh_web-arm64-v8a.so`）—— 也就是说
**任何人照着文档装 agent 都会 404**；就算他手动锁到 `agent-v1.1.0`，装到的也是
**v4 客户端，对着已经切到 v5 的 roomd 一个字都发不出去**。
把 `agent-v1.2.0` 推成 Latest 顺带把这条链路修好了。
后来发现"推成 Latest"本身就是**错的解法** —— 见下面第二个 bug。
`deploy/agent/install-release.sh` 的默认 `VERSION` 也从 `agent-v1.1.0` 改成了
`agent-v1.2.0`（默认值必须跟着协议走，注释里写了原因）。

### ★★ 第二个真 bug：`releases/latest` 是**全局**的，而这个仓库有两条产物线

发完 `agent-v1.2.0` 我立刻发现：`scripts/fetch-android-so.sh`（默认取 `latest`）
**开始 404** —— 因为 GitHub 的 `releases/latest` 是**整个仓库**的 Latest，
而它已经被 agent 那次发布顶掉了；`libiroh_web-arm64-v8a.so` 当然不在 agent 的 Release 里。
反过来说，等我把 `android-v0.2.0` 发出去，Latest 又变回 android，
**agent 的安装脚本会立刻坏掉**。所以"靠 Latest"这条路本身就是错的：

> 两条产物线 + 一个全局 Latest = 谁最后发布谁就砸掉对方的安装路径。

改法（`bc9dfcf`）：`latest` 一律**按本产物族的 tag 前缀**去 releases 列表里取最新那个。
`scripts/fetch-android-so.sh` → 最新 `android-*`；
`deploy/install/agent-install.{sh,ps1}` 与 `skills/iroh-agent/scripts/install.{sh,ps1}`
→ 最新 `agent-v*`（`AGENT_RELEASE_BASE` / `$BaseUrl` 镜像地址仍优先）。
实测解析结果：`agent-v → agent-v1.2.0`、`android- → android-v0.2.0`，
**与 Latest 现在指向谁无关**。

### 第三个 Release：`android-v0.2.0`（v5 的 `.so`）

`android-v0.1.0` 里那份 `.so` 是 **v4 签名**，装到手机上表现为
"能进房、但消息一条看不到"（静默丢消息）—— 正是 v5 要消灭的那类故障。
所以打 tag `android-v0.2.0`（指向 `bc9dfcf`）重编：

| 项 | 值 |
|---|---|
| 资产 | `libiroh_web-arm64-v8a.so` 8,773,328 B + `.sha256` |
| 完整性 | 从服务器下载后 `sha256sum` = `dbbe0b7546b3ec8f…` **与 Release 里的 `.sha256` 逐字节相符** |
| 源码一致性 | `git show "android-v0.2.0:client-wasm/src/sigfmt.rs"` = `pub const PROTO_V5: &str = "v5";` |
| 取法 | `bash scripts/fetch-android-so.sh`（不带参数 = 最新 `android-*`） |

## 仍未做

1. 阶段 E（多历史提供者）仍暂缓 —— 需要先确认隐私边界。
2. 顺带观察到一条**非本轮引入**的噪音：roomd 在客户端"连上就断"时会打
   `router.accept{… alpn="editor.vip/iroh-announce/1"}: … timed out`（WARN）。
   agent 重启那一下能看到一条。语义无害（对端自己走了），但噪音级别可以再压。
3. **PR #1 还没合**。合之前 `main` 仍是 v4 时代的代码；tag `agent-v1.2.0` → `6f44026`、
   `android-v0.2.0` → `bc9dfcf`，都在这个分支上，与线上跑/发布的源码一致。
4. **手机上装着的那个 App 还是 v4**：`.so` 已经出了 v5 的（`android-v0.2.0`），
   但要**重新构建并安装** App 才会真正生效（`scripts/fetch-android-so.sh` 换 .so →
   Expo/原生构建 → 装到手机）。在那之前它会表现为"能进房、消息看不到"。

## 反漂移自检（方案 §8 逐条）

1. **有没有让"任何 peer 掉线不影响别人"变差？** 没有。v5 只动了版本串与握手字段；
   进房降级（阶段 A）、入口/历史双能力（B′）的语义一行没改，`isolated-room` 7/7、
   `rendezvous-split` 6/6 复跑仍绿。
2. **核心的能力分发表是变小了还是又多了一个 if？** 没变。v5 都在能力**内部**：
   版本比对写在各自的 accept/调用点，`CapabilityRegistry` 与 dispatch 一行未动
   （新增的只是一条事件变体，UI 消费）。
3. **协议类型仍然只有一份来源？** 是。`protocol.gen.ts` 由 Rust 生成，
   `check-protocol-types.sh` 进 `verify.sh`；这次 `CHAT_PROTOCOL` 从 v4→v5 是**只改 Rust
   再重跑生成脚本**得到的，三端（web/mobile/agent-pi）没有一处手抄。
   `daemon-protocol` 的黄金转录也改成引用 `iroh_web::sigfmt::PROTO_V5` 而不是字面量。
4. **能不能单独回滚？回滚步骤写了吗？** 能，写在上面（但要三件一起回）。
5. **有没有哪条已拍板决策与现实冲突？** 出现过**一条与实现无关但挡住交付**的：
   决策 ⑤与第 6 节要求"服务器上的二进制都属于某个 Release"，而六期改动
   当时**全都还没提交**（`git status` 里 76 个文件未跟踪/未提交），
   要做 Release 就必须先提交+推送，而提交会把服务器地址带进公开仓库。
   **处理方式**：先脱敏（把地址/私钥路径换成指向 `scripts/build.env`）→
   提交到**分支** `codex/protocol-v5` + 开 PR #1（不动 `main`）→ 先跑一次只构建的
   矩阵验证 → 打 tag `agent-v1.2.0` → 用 Release 产物覆盖安装。
   到此第 6 节那条硬约束满足，方向没有被静默改掉。
