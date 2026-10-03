# 项目审查 · 修复后复检 — 2026-10-03 晚

## 范围与方法

同一天上午的审查（[project-review-2026-10-03.md](project-review-2026-10-03.md)）提出 P1×8 + P2×3，
当天下午进行了修复并上线。**本次不是重复那份报告，而是对修复后的当前代码做独立复检**，回答两个问题：

1. 那 11 项修复**是否真的闭合**（还是只改了表面、留了绕过口子）？
2. 修复过程中**有没有引入新问题**？

方法：通读 Rust 核心与前端全量源码；实跑测试与静态校验；对部署产物做逐文件比对。
目录没有 Git 元数据（无 `.git`），因此这是现状审查，不是差异审查。

实际执行的验证（不是"看了一遍"）：

| 验证 | 命令 / 方式 | 结果 |
|---|---|---|
| Rust 单元测试 | `cargo test --no-default-features --features cli` | **37 passed / 0 failed**（含 27 条安全回归 + 1 条 doc-test） |
| 前端语法 | `node --check` 全部 23 个 JS 文件（Node v24.19.0） | 全部通过，无输出 |
| 产物与源码一致性 | `frontend/` ↔ `dist/site/` 逐文件 sha256 | **全部一致**（含 `pkg/iroh_web_bg.wasm`） |
| 站点引用完整性 | 自写脚本解析 `index.html` 的 src/href + 12 个 JS 的 import 图 | 无失效引用、无断链 import |
| 站点模块检查 | `python3 scripts/check-site-modules.py dist/site` | exit 0 |

> 产物与源码逐字节一致这一点值得单独强调：历史上"wasm 停在旧版导致新旧协议混跑"是踩过的坑，
> 当前 `dist/site/pkg/iroh_web_bg.wasm` 与 `frontend/pkg/` 哈希相同，说明这次没有留下半截部署。

---

## 总体结论

**上午那 11 项修复的代码都真实落地了** —— 没有发现任何一项是"改了但没生效"或"只改了注释"。
这一点先用实跑测试和逐文件哈希确认，下面的逐条复核再给出代码级证据。

**但其中 5 项只修了报告点名的那条路径或那类输入**（P1-3/P1-4/P1-5/P1-7/P1-8），
而且本次复检还发现了新的问题，**其中 P1×3 需要优先处理**：

- **F1** 是**修复本身引入的可用性回归**：为 P1-3 加的"发送方必须等于签名者"校验，
  在错误分支上用了 `return` 而不是 `continue`，导致**任何房间里任意一个人发一条畸形邀约，
  就能让该房间所有客户端的 gossip 消费任务永久退出**（聊天、成员、文件全部收不到，且不会自愈）。
  修复量是一个词。
- **F2** 是**信任边界最外圈**的问题：`roomd` 的历史 ALPN 完全没有鉴权，既能读任意房间的完整历史，
  又能让常驻节点无限订阅任意房间（无上限、无回收），是单点故障服务上的无上限资源耗尽。
- **F3** 是运维路径：roomd 的部署"快乐路径"要么直接失败，要么**悄悄上线 5 天前的旧二进制**。

此外还有一组"修复留了开关"的 P2（**F17/F18/F19**）：空 `root_hash` 的邀约能让内容校验
**整体静默跳过并报成功**（等于把上午 P1-5 的洞留了一条后门）、入站数据路径没有任何超时
（且 iroh 强制 keep-alive 使空闲超时兜不住）、重放 `Accept` 可把发送方放大成 N 份并发上传。

安全工程的整体水平明显高于一般项目（签名无歧义编码、id 参与签名、入站流绑定真实发送方、
增量 BLAKE3、按内容哈希命名历史文件 —— 这些都做对了）。剩下的问题集中在三处：
**信任边界最外圈（roomd）**、**异步任务的错误分支与生命周期**、以及**"修复=只修了报告点名的那个调用点"**。

---

## 第一部分：上午 11 项的复核结论

| 编号 | 上午的问题 | 复核结论 | 关键证据 |
|---|---|---|---|
| P1-1 | 签名串 `\|` 拼接有歧义 | ✅ 已闭合 | `sigfmt.rs:50-73` 长度前缀编码；**5 处** `canonical()` 全部改造（不止聊天那条）：`room.rs:133-158`（ChatMessage）、`249-273`（Presence，带 `nfiles` 计数）、`327-330`（Leave）、`375-388`（FileQuery）、`filetransfer.rs:136-217`（FileCtrl）。版本号是每段载荷的**第一个字段**，无法被挤进相邻字段。全仓已无 `format!("…\|…")` 式规范化。 |
| P1-2 | `id` 不在签名里，可改 id 重放 | ✅ 已闭合 | `id` 是签名载荷的第 2 个字段（`room.rs:140`）；`sign()` 重算（`208-215`）；`verify()` **先**核对 `id_matches()` 再验签（`190-206`）；收消息处校验（`1380-1383`）；`HistoryStore::append` 再做一次兜底校验（`735-745`）—— 篡改 id 的消息既进不了内存也进不了磁盘。 |
| P1-3 | 入站文件流只凭公开 file_id 路由 | ✅ 基本闭合（2 处 fail-open 残留） | `Pending` 记 `expect_sender` + 完整 `meta`（`filetransfer.rs:476-491`）；`accept()` 先比 `connection.remote_id()`（`646-654`）再逐项比 header（`656-663`，`header_matches` 含 size/name/chunk_size/mime/root_hash），块序号与块长度都校验（`695-741`）；`Invite` 的 `sender` 进签名且必须等于签名者（`filetransfer.rs:162-164`）。残留：`expect_sender == ""` 时**跳过**身份校验（`:647`）、`root_hash`/`mime` 为空时跳过比对（`:416`、`:421`）—— 见 F17 与 P3-21。 |
| P1-4 | 续传位图不绑定实际文件 | ⚠️ **部分闭合** | 空文件、文件名、大小三条判据都在（`iroh-worker.js:597-630`），报告复现的"空文件当半截文件"已堵死。**但"已收块的内容"仍然没有任何校验** —— 见新发现 F5。 |
| P1-5 | 浏览器接收端不校验内容 | ⚠️ **部分闭合** | `JsChunkSink` 已加块范围校验 + 增量 BLAKE3（`wasm_api.rs:558-682`），整收路径**确实**硬校验哈希（`650-665`）。**但续传路径显式跳过整文件哈希**（`666-670`）—— 见新发现 F5。 |
| P1-6 | 房间名→历史文件名不可逆 | ✅ 已闭合 | 文件名改 `blake3(room)` 前 16 字节（`room.rs:705-707`），写用同一函数（`764`）；`RoomHeader` 存原始房间名并自校验（`663-688`）；加载时**先验文件名哈希 == 头部哈希**（`876-887`）、再验头部自校验（`889-892`）；无头部或对不上的文件**跳过而不是猜**。 |
| P1-7 | 算哈希期间切房间 → 发错房间 | ⚠️ **部分闭合** | `invite_file(meta, expect_room: &str)` 是**必填**参数，且 `send_ctrl_in` 在 `broadcast()` 前最后一刻再核一次（`room.rs:1921-1939, 1960-1971`），证明那一处是对的。**但同类的 `accept_file` / `reject_file` / `query_file` 仍走无房间约束的 `send_ctrl`** —— 见新发现 F7。 |
| P1-8 | 重连与用户切房间竞态 | ⚠️ **部分闭合** | 代次机制（`_joinGen`）、被抢占后的 corrective re-join、事件带不可变 room 快照、`_desiredRoom`、`hasRoomContext()` 都在。**但 `_goOnline` 那一半的补偿分支是不可能执行到的死代码** —— 见新发现 F12。 |
| P2-9 | 切走再切回房间卡片不重建 | ✅ 已闭合 | `rebuildCardsForRoom(room)`（`filetransfer.js:665-682`）与 `restoreInvites()` 分工明确；重建**只画状态不改状态**，且跳过用户已 dismiss 的。 |
| P2-10 | 只用毫秒时间戳翻页会漏消息 | ✅ 已闭合 | 写入侧 `(ts,id)` 排序与游标过滤（`room.rs:834-837`），服务侧同序（`900`），前端游标编解码一致（`wasm_api.rs:326-340`、`util.js:157-160`）。语义是"严格早于游标、取最新 limit 条"，对正常客户端不漏不重。 |
| P2-11 | Cargo.lock 未同步 | ✅ 已闭合 | 本次 `cargo test --no-default-features --features cli` 在锁定依赖下实跑通过。**注意**：真正上线用的 `build-wasm.sh` 既不同步 `Cargo.lock` 也不用 `--locked` —— 见 F9。 |

**小结：6 项完全闭合，5 项属于"报告点名的那条路径修对了、同类路径或同类输入漏了"。**
这不是吹毛求疵 —— F5、F7、F12 都是**同一类问题的另一半**，F17 更是把 P1-5 的承诺开了一个后门，
而且都有可达的触发路径。

---

## 第二部分：新发现

> **本部分用 F1、F2… 编号，与第一部分表格里「上午报告的 P1-1…P2-11」是两套编号，不要混读。**
> 括号里的 P1/P2/P3 是本次评定的严重级别。

### F1（P1）· 一条畸形文件邀约即可让整个房间的客户端"永久失聪"

- **位置**：`client-wasm/src/room.rs:1419`（位于 `1356` 起、`1372` 循环体内）
- **根因**：这一行在"`meta.sender` 与签名者不一致"时写的是 **`return`**，而它所在的
  `async move { while let Some(ev) = receiver.next().await { … } }`（`1371-1372`）
  **就是**消费 gossip 事件的整个任务体。`return` 不是"跳过这条消息"，而是**结束这个任务**：
  此后该房间的所有 gossip 事件（聊天、心跳、离开、文件控制、邻居上下线）都不再被消费。
  对比同一个 `match` 里的其它错误分支用的都是 `continue`（`1382`、`1452`）。
- **触发条件极低**：邀约的签名载荷**包含** `sender`（`filetransfer.rs:162-164`），
  所以攻击者可以自己签一条 `sender=""`（或任何人）的邀约 —— 签名完全有效，
  `c.verify()` 在 `1405` 通过，然后在 `1414` 命中不一致分支、`1419` 返回。
  攻击者只需要在房间里（房间名 → topic，无成员名单、无需邀请）。
- **影响**：该房间内**所有**客户端从此收不到任何消息，而 `RoomNode::send()` 仍然正常，
  所以受害者**自己发的消息看起来一切正常**，只是没人回 —— 极难自查。
  任务句柄在 `Joined::_tasks`（`1684`）里是 `AbortOnDropHandle`，
  既不会被观察到结束、也没有任何重启路径，**本次会话内不会自愈**。
- **这是修复引入的回归**：上午报告 P1-3 要求"核对 sender 等于签名者"，校验逻辑本身是对的，
  错在错误分支用了 `return`。
- **修复**：改成 `continue`（或把该分支改为产出 `None` 后 `continue`）。
  补一条回归测试：投喂 `sender != from` 的 `Wire::File`，**然后断言后续 `Wire::Message` 仍能送达**。

### F2（P1）· `roomd` 的历史 ALPN 无任何鉴权：任意房间历史可读 + 常驻节点可被无限订阅

- **位置**：`client-wasm/src/room.rs:932-964`（`HistoryService::accept`）、`951`（`join_tx.try_send`）、
  `client-wasm/src/bin/roomd.rs:284-286`（订阅循环）、`roomd.rs:160-176`（subscribe 实现）、
  `roomd.rs:247`（唯一的移除点）、`room.rs:1140`（`unbounded` 通道）
- **根因**：`HISTORY_ALPN` 的处理器**不校验任何身份**。请求里唯一的"凭据"就是房间名
  （`HistoryRequest { room, limit, before }`，`room.rs:449-461`）。于是一个人只要知道
  常驻节点的 EndpointId（`roomd.rs:136` 会打印出来，前端 `relay-config.json` 里也有）就能：
  1. **读任意房间的完整历史**（`955`，返回最近最多 1000 条）—— 从没进过那个房间也能读；
  2. 让常驻节点**永久订阅任意房间**（`951 → roomd.rs:284-286`）：
     `subscribe()` 只在 `subs` 里 `contains_key` 去重（`161`），随后插入（`175`）并为每个房间
     **常驻两个任务**（消息消费 `184-249`、每 15 秒一次的 presence 广播 `256-270`）。
     `subs` 里唯一的移除在 `247`，只在 gossip 接收流**自己结束时**才跑 ——
     而 sender 被 `subs` 持有，正常永远不会结束。
- **影响**：循环请求随机房间名即可让常驻节点无限增长（topic、任务、内存、磁盘文件、
  每房间 15s 定时广播），直到 OOM。**而常驻节点是所有客户端的 bootstrap 与历史来源 ——
  它是单点**。附带一个隐私问题：房间名是唯一门槛，而房间名是人取的（`lobby` 之类）、
  topic 派生规则（`TOPIC_NS`）也在源码里公开。
- **补充**：`join_tx` 是 `unbounded`（`1140`），且去重检查在 `await` **之前**，
  同一新房间的 N 个并发请求会创建 N 份重复订阅（TOCTOU）。
- **修复**：历史请求要求**绑定房间名的签名凭据**（且只接受真正加入过该房间的 peer）；
  按 remote id 限流；给自动订阅设上限 + 空闲超时回收；
  把"检查 + 预留"放进同一把锁里，消除 TOCTOU。

### F3（P1）· 部署"快乐路径"要么直接失败、要么悄悄上线 5 天前的旧 roomd（运维级 P1）

- **位置**：`deploy/roomd/Dockerfile:8`（`COPY roomd /usr/local/bin/roomd`）、
  `deploy/roomd/README.md:17`（`scp deploy/roomd/{Dockerfile,docker-compose.yml} dist/roomd root@<host>:/opt/iroh/roomd/`）、
  `scripts/build-wasm.sh:57-62`（native 模式）
- **实测证据**：
  - `deploy/roomd/roomd` 是 ELF x86-64 二进制，mtime **2026-09-29 23:24**；
    而 `client-wasm/src/bin/roomd.rs` 是 **2026-10-03 17:35**、`room.rs` 是 **17:36** ——
    **仓库里那份二进制比源码旧 5 天**，而 Dockerfile 是把它 `COPY` 进镜像的。
  - `scripts/build-wasm.sh native` **只**把 `target/release/relay-probe` 拉到 `dist/`
    （`build-wasm.sh:61`），**从不拉 roomd**；`dist/roomd` 目录**根本不存在**。
- **影响**：按 README 的快乐路径走，`scp ... dist/roomd` 立刻报
  "No such file or directory"；若运维改用仓库里那份二进制，
  `docker compose up -d --build` **会成功**、`ROOMD_ENDPOINT_ID` 也照常打印，
  但跑的是 9-29 的旧锚点 —— 上午修的所有 roomd 侧修复（验签、历史文件头、分页游标）
  一个都不在。这正是记忆里记录过的"改了源码、编译成功、功能就是不生效"那一类坑，
  且这次是**默认路径**就会踩。
- **修复**：改成多阶段 Dockerfile 从源码构建（或让 `build-wasm.sh native` 同时拉 roomd），
  删掉仓库里那份二进制，README 引用真实产物名。

### F4（P2）· "关掉一个房间的历史"是可行的：响应上限与服务端读取上限不匹配

- **位置**：`room.rs:955`（`req.limit.min(1000)`）、`57`（`MAX_MESSAGE_SIZE = 512KB`）、
  `959`（整份响应 `serde_json::to_vec`）、`2263`（`read_all` 超过 8MB 直接 `bail`）
- **根因**：服务端按**条数**取上限（最多 1000 条），每条最大 512KB，**最坏 512MB**；
  而收发两端共用的 `read_all` 在 **8MB** 就报错（`"报文过大"`）。
- **影响**：房间里只要累积约 17 条接近上限的大消息，之后**该房间所有客户端的翻页都会失败**
  （任何包含这些消息的页都读不回来）。同时常驻节点在写出去之前会先把整份响应序列化进内存，
  构成一次大额内存峰值。
- **修复**：按**累计字节数**截断响应（例如到 1MB 就停止追加），或者改成长度前缀的行式流式返回，
  让读取方永远不需要拿到完整 body。

### F5（P2）· 续传路径不做任何内容校验（P1-4 / P1-5 的另一半）

- **位置**：`client-wasm/src/wasm_api.rs:666-670`（续传时**跳过**整文件哈希）、
  `frontend/js/iroh-worker.js:597-630`（续传判据）、`iroh-worker.js:304-313`（hasher 只用于发送端算哈希）
- **根因**：续传时本次流只补缺失块，Rust 侧拿不到前半段的字节，所以 `finish()` 在
  `resumed > 0` 时**只打一条 warn 就跳过哈希校验**（`666-670`）。
  而 JS 侧的续传判据只有三条：旧位图存在、文件名相同、`文件大小 == 已收块数 × 块大小`。
  这三条证明的是"大小对得上"，**不能证明"已经落盘的那部分内容是对的"**。
- **实测触发**：收一半 → 中断（位图 + 半截文件留在磁盘）→ 用户/同步工具改动了那半截文件，
  或者用户重新选了一个**同名且大小恰好相同**的另一个文件 → 续传 → 发送方只补后半段 →
  整文件哈希被跳过 → **UI 报"已完成"并删掉位图，产出一个前半段内容是错的文件**。
  这正是 P1-4 想堵的那类"静默损坏"，只是从"开头缺失"换成了"开头内容不对"。
- **修复**：续传时把**已落盘的前缀也喂进 BLAKE3**（JS 手上就有文件句柄，
  `handle.getFile().slice(0, expectPartial)` 即可），让 `finish()` 在
  `resumed > 0` 时同样做整文件哈希校验；或者持久化**逐块哈希**，逐块校验。
  另外 IDB 键 `${root_hash}:${size}`（`iroh-worker.js:567`）没带 `chunk_size`，建议一并补上。
- **关联**：同一段 `finish()` 还有一个更直接的开关 —— **空 `root_hash` 会让校验整体静默跳过**，
  见 F17；两者应一起修（把校验判定写成穷尽的）。

### F6（P2）· 所有签名载荷都没有绑定房间，跨房间重放成立

- **位置**：`room.rs:133-158`（ChatMessage）、`249-273`（Presence）、`327-330`（Leave）、
  `375-388`（FileQuery）、`filetransfer.rs:136-217`（FileCtrl）；`room.rs:433-447`（`Wire` 也无房间字段）
- **根因**：上午报告 P1-1 的建议原文是"绑定协议版本**和房间标识**"。
  修复绑定了协议版本（`PROTO_V3` / `p3` / `l2` / `q2` / `f2`），**但没有绑定房间**。
  签名载荷里没有任何房间/topic 信息，`Wire` 也没有。
- **影响**：任何能进目标房间 B 的人（房间名往往可猜、topic 派生规则公开），
  可以把他在房间 A 抓到的**合法签名消息原样转发进 B**，接收方验签通过、id 校验通过，
  于是**原作者在从未进过的房间里"说了话"**。同理：Presence 可被重放成"某人也在 B 房间"
  （并让他声称持有的文件在 B 房间显示为可接收），Leave 可被重放成"某人刚离开 B"。
- **修复**：把房间标识（或 topic id）纳入每个签名载荷，作为协议版本 bump 的一部分
  （v4）；接收方核对"当前房间 == 载荷里的房间"，不匹配直接丢。

### F7（P2）· `accept_file` / `reject_file` / `query_file` 仍在无房间约束地广播（P1-7 的另一半）

- **位置**：`room.rs:2073-2107`（`accept_file` → `send_ctrl`）、`1941-1944`
  （`send_ctrl` 就是 `send_ctrl_in(ctrl, None)`）、`2049-2061`（`query_file` 自己取当前房间广播）、
  `1423-1445`（入站 `Accept/Reject/Done` 转事件时**不带 room**）
- **根因**：只有 `invite_file` 被加了 `expect_room` 必填闸门；兄弟路径没有。
- **影响**：用户收到 A 房间的邀约、切到 B 房间后才点"接收"，
  这条 `Accept`（以及后续 `Reject`/`Done`）会被广播进 **B 房间**，
  让 B 的成员看到与 B 无关的传输控制流。反过来，
  因为 `FileAccepted`/`FileRejected` 事件不带房间，
  **任何与受害者同处一个房间的人**都能凭一个公开广播过的 `file_id` 伪造这些事件，
  触发一次非预期的推送或打断一次正常传输。
- **修复**：把 `expect_room` 按 `invite_file` 的方式贯穿 `accept_file`/`reject_file`/`query_file`；
  给文件类 `RoomEvent` 加 `room` 字段；JS 侧丢弃 room 与传输记录不一致的事件。

### F8（P2）· 常驻节点返回的历史消息**从不验签**（客户端也不验）

- **位置**：`room.rs:895-899`（`load_from_disk` 把每一行可解析的都收进来，**不验签**）、
  `803-844`（`recent` / `recent_before` 原样返回内存内容）、`1836-1855`
  （客户端 `fetch_history` 直接 `serde_json::from_slice` 后返回，**不验签**）
- **根因**：写路径有兜底验签（`735-745`，注释里明确写了"只要有一条路径忘了验，
  被篡改的消息就直接进历史与磁盘"），但**读路径没有同样的兜底**。
- **影响**：任何改动过磁盘 `.jsonl` 的事情（有 shell 权限的人、备份恢复、容器卷、
  早期有 bug 的构建版本）都会在**下次重启后变成"看起来已签名"的聊天记录**，
  而且客户端无法察觉 —— 因为客户端从不重新验签。
  按该项目自己的威胁模型（"转发者无法伪造作者身份"），这是签名机制在读路径上的失效。
- **修复**：`load_from_disk` 里加 `m.verify()`；客户端渲染历史前也重新验签，
  验不过的条目标记为不可信而不是当正常消息显示。
- **说明**：常驻节点是运营者自建、按设计受信，所以这不是"外部攻击者伪造"，
  而是**完整性保证在持久化边界上断了**，与 P1-2 叠加后（无鉴权即可读）更值得修。

### F9（P2）· `build-wasm.sh` 不参与锁定：`Cargo.lock` 根本不在同步范围里，构建也不用 `--locked`

- **位置**：`scripts/build-wasm.sh:35-37`（rsync 只同步 `src/`，`Cargo.toml` 单独 scp）、
  `:51`/`:55`/`:59`（`wasm-pack build` / `cargo build` 均无 `--locked`）
- **实测证据**：`Cargo.lock` **存在且当前是同步的**（本次 `cargo test --no-default-features --features cli`
  在锁定依赖下实跑通过），所以 `--locked` 现在就能加。但脚本从不把 `Cargo.lock` 传到构建机，
  远端那份会漂移，`cargo` 于是自行解析"语义化版本允许范围内的最新依赖"。
- **影响**：**上午刚修好的 P2-11（锁文件同步）在真正的构建路径上被绕过了** ——
  上线的那份 wasm 来自由未审查依赖图构建，而且失败是无声的（构建成功、行为不同）。
  这与"要锁就锁到底"的初衷相矛盾。
- **修复**：把 `client-wasm/Cargo.lock` 纳入同步，三处构建命令加 `--locked`。
  另外建议补 `rust-toolchain.toml` 与 wasm-pack 版本固定（当前均无）。

### F10（P2）· `install-relay.sh` 放行的是**回环地址**的端口，真正的 8443/tcp 从没被放行

- **位置**：`deploy/relay/install-relay.sh:52-57`
- **实测证据**：脚本从 `http_bind_addr` 里取端口 —— 而 `relay-a.toml:2` 是
  `http_bind_addr = "127.0.0.1:3340"`（**只监听回环**）；对外可达的端口在 `[tls]` 段：
  `relay-a.toml:9` `https_bind_addr = "0.0.0.0:8443"`、`:10` `quic_bind_addr = "0.0.0.0:7842"`。
  脚本于是 `ufw allow 3340/tcp`（一个外部根本连不上的回环端口），
  外加一条硬编码的 `ufw allow 7842/udp`，而 `8443/tcp` **从未被放行**；
  收尾校验 `grep -E "3340|3341|7842"` 还会打印成功。
- **影响**：全新按脚本装的 relay，外部客户端**全部连不上**，而安装日志显示一切正常。
  与 P2-6/P1-3 属于同一类"快乐路径静默产出坏结果"。
- **修复**：从 `https_bind_addr` 取端口；`quic_bind_addr` 仅在
  `enable_quic_addr_discovery = true` 时放行；收尾校验把 8443 算进去。

### F11（P2）· `deploy/relay/relay-docker.toml` 是**纯注释空文件**，却被 compose 当正式配置挂载

- **位置**：`deploy/relay/relay-docker.toml:1-4`（全文件 4 行注释、**0 个配置项**）、
  `deploy/relay/docker-compose.yml:29`（`./relay-docker.toml:/etc/iroh-relay/relay.toml:ro`）、
  `docs/relay-deploy-minimal.md`（§2.3 标题为"配置全文（`relay-docker.toml`）"并给出完整 TOML）
- **影响**：按文档手工部署的人 `scp -r deploy/relay` 过去再 `docker compose up -d`，
  挂进去的是一份没有 `enable_relay` / `[tls]` / `cert_mode` 的空配置 ——
  relay 要么起不来、要么按默认值起来，而文档同时让你 `ufw allow 15443/tcp`，
  于是端口开着、服务是错的。
- **修复**：把 §2.3 的内容真正写进这个文件，并加一条"文件内容与文档一致"的自检。

### F12（P2）· P1-8 的另一半：`_goOnline` 的补偿分支是**不可能执行到的死代码**

- **位置**：`frontend/js/net.js:244-250`、`frontend/main.js:211-217`
- **实测证据**（逐行可验，不需要构造运行时）：
  ```js
  await this.client.call('join', wantRoom, wantNick);
  this._room = wantRoom;                                      // :244  ← 刚赋值
  if (autoGen !== this._joinGen && this._room !== wantRoom) { // :246  ← 恒为 false
    await this.client.call('join', this._room, this._nick)…    //   因此永远跑不到
  }
  bus.emit(EV.REJOINED, wantRoom);                            // :250  已被抢占也照发
  ```
  注释承诺的"那就把最终房间还回去，别把它踢掉"**在代码上不可能发生**。
- **后果**：更糟的是 `:244` 是**无条件覆盖** `_room` —— 而 `joinRoom()` 在 await **之前**
  就写了 `this._room = room`（`net.js:434`），所以一次慢的自动重进会把用户刚选的房间**回滚**掉；
  接着 `REJOINED(wantRoom)` 带着**过期房间**发出，`main.js:212` 又盲信它
  （`joinedRoom = room;`，且 `timeline.note(...)` 会把提示写进**当前房间**的时间线）。
  于是出现"界面显示 C、`joinedRoom` 是 B、底层可能在 B"的错位 ——
  正是 P1-8 声称要消除的那种错位，在 C 房间输入的消息可能被广播到 B。
- **触发路径**：离线时选 B → 网络恢复（`_goOnline` 先发 `NODE_STATE`，`main.js:195-201`
  于是判定"netWillHandle"、清掉 `pendingRoom` 而**不再**自己进房）→ 自动重进 B 的 RPC 在途时
  用户点了 C → 若 `join(B)` 后于 `join(C)` 返回，即命中。
- **修复**：在**覆盖 `_room` 之前**判断是否被抢占；被抢占时直接 `return`，
  既不写 `_room` 也不发 `REJOINED`；`main.js` 的 `REJOINED` 处理要忽略
  "room ≠ 当前显示房间"的事件。更彻底：所有 join 都只走 `joinRoom()` 一个入口。

### F13（P2）· `restoreInvites()` 完全不看房间：跨房间卡片、**删掉别的房间的续传记录**、Accept 发进错房间

- **位置**：`frontend/js/ui/filetransfer.js:685-718`（`restoreInvites`）、
  `:693-695`（用**全局** `knownPeers` 判断"发送方还在不在"）、
  `main.js:110`（每次 `openRoom` 都调它）、`timeline.js:281`（`pushFileCard` 根本不看 `room`）
- **根因**：它遍历**所有**房间的已存邀约，却只拿"当前房间的成员表"判断有效性，
  而卡片层也不校验 room。
- **影响**（三条都能从代码直接推出）：
  1. A 房间的邀约会在 B 房间被渲染成卡片（显示在错误的会话里）；
  2. 载入 B 房间时，因为 A 的发送方不在 B 的成员表里，会执行
     `forgetInvite(meta.file_id)` —— **把 A 房间的续传记录永久删掉**；
  3. 若用户点了那张卡的"继续接收"，`accept_file` 走的是**无房间约束**的
     `send_ctrl`（即 F7），Accept 被广播进 B 房间，发送方在 A 房间永远收不到；
     接收侧于是卡在 `rx.recv()` 上 —— 而 `transfer_orchestrator.rs:348` 的等待
     **没有超时**（见 F16），UI 的 `active` 卡片又**没有任何按钮**，
     结果是**永久"传输中 0%"且无法取消**。
- **修复**：`restoreInvites`/`loadStoredInvites` 按 `item.room === room` 过滤；
  `knownPeers` 改成按房间；Rust 侧给 `accept_file` 补 `expect_room`（F7）；
  接收等待加空闲超时并回调 JS 的 `abort`；`active` 态补取消按钮。

### F14（P2）· 对端可用 `[img]…[/img]` 指定任意 `<img src>`，强制所有客户端发起外部请求

- **位置**：`frontend/js/ui/timeline.js:633-649`（`_fillBubble` 里 `img.src = m[1]`）
- **实测证据**：全仓只有 `timeline.js:633` 的注释提到 `[img]` 格式，
  **composer 已经不再产生这种消息**（图片改走 P2P 文件通道）——
  也就是说任何 `[img]` 消息都是**对端手工构造**的。
- **影响**：`<img>` 不会执行 `javascript:`，所以这不是脚本 XSS；但一个恶意成员发
  `[img]https://attacker/x?…[/img]` 就能让**房间里每个客户端**在气泡进入视口时
  向攻击者服务器发起请求 —— 泄露接收方 IP、在线时间与"此人在这个房间"的事实；
  也可以对 `http://127.0.0.1:<port>/…` 做内网盲探测（`loading="lazy"` 只是延后）。
- **修复**：只允许 `data:image/*` 与 `blob:`，其它替换成"图片已阻止"占位；
  补 `referrerpolicy="no-referrer"`。

### F15（P2）· 重发邀约无法复活已有卡片，而"已失效"的 ✗ 会删掉**活**邀约

- **位置**：`filetransfer.js:619-629`（`_onInvite` 置 `invited` 并发 `EV.FILE_CARD`）、
  `timeline.js:282-283`（`pushFileCard` 命中 `seen` 直接 return）、`timeline.js:73`（`seen` 只在 `open()` 清空）
- **根因**：`_onInvite` 走"新建卡片"事件，而卡片层对同一 `file_id` 是**幂等去重**的 ——
  DOM 卡片既不重建，也没收到 `FILE_CARD_UPDATE`，于是停在旧状态、旧按钮上。
- **影响**：发送方离开 → 卡片变"已失效"、按钮变成"移除这条记录"（`timeline.js:505-512`）→
  发送方回来点 ↻ 重发 → 接收方 `transfers` 里其实已经是活的 `invited`，
  但屏幕上仍是"已失效"，用户点下去**删掉一个有效邀约**。
  能否恢复取决于后续有没有 `EV.PRESENCE` 变化触发 `_refreshArchived`，
  而单纯重发邀约不会让成员/文件表发生变化。
- **修复**：`pushFileCard` 命中 `seen` 时改为委托 `updateFileCard`；
  或在 `_onInvite` 的重发分支直接发 `FILE_CARD_UPDATE`。

### F16（P2）· 接收侧没有超时、`active` 卡片没有取消按钮 → 传输可永久卡死且无法中止

- **位置**：`client-wasm/src/transfer_orchestrator.rs:348-381`（等 `rx.recv()` 无超时）、
  `frontend/js/ui/timeline.js:478-523`（`_fileActions` 对 `active` 不生成任何按钮）、
  `frontend/js/iroh-worker.js:462`（`inTransfers` 只 delete 从不 set，是死状态）、
  `iroh-worker.js:809-812`（`cancel` RPC **没有任何调用点**）
- **影响**：一旦发送方不再拨号（或拨号后被授权校验拒掉），接收侧会一直等在
  `receive_file_data` 里，`accept` 这个 RPC 永不 resolve，`WorkerClient.pending` 条目
  随之泄漏；用户在界面上既不能重试也不能取消，只能刷新页面。
  与 F7/F13 相乘时（Accept 发进错房间）这是**必然**发生而非偶发。
- **修复**：接收等待加空闲超时 → 走 abort 分支保留已收内容并置 `paused`；
  `_fileActions` 给 `active` 补"取消"按钮并接上已有的 `cancel` RPC。

### F17（P2）· 空 `root_hash` 的邀约会让浏览器接收端**静默跳过全部内容校验并报"已完成"**

- **位置**：`client-wasm/src/wasm_api.rs:650-670`（校验分支没有 `else`）、
  `:403-425` 里 `header_matches:421`（空哈希不比对）、`room.rs:1414`（只校验 sender）
- **实测证据**（三段拼起来即可证明，均可逐行核对）：
  1. 校验分支的进入条件是
     `if resumed == 0 && hashed == self.meta.size && !self.meta.root_hash.is_empty()`
     —— `root_hash` 为空时**第一条就为假**；
  2. 唯一的另一个分支是 `else if resumed > 0`（续传时只打 warn）——
     `root_hash` 为空且 `resumed == 0` 时**两个分支都不进**；
  3. 于是直接落到第 ③ 步"让 JS 收尾"（`:672-680`），JS 那边就是
     `writable.close()` + 删位图 + `push('transfer:done')`（`iroh-worker.js:673-679`）。
- **可达性**：签名载荷覆盖 `root_hash`（`filetransfer.rs:160-161`），所以一个恶意成员
  可以**自己签一条 `root_hash = ""` 的正常邀约**（`meta.sender` = 自己，校验通过）；
  接收方的卡片、文件名、大小都正常显示，点"接收"后发送方发任意字节，
  接收方**报成功**。`missing_chunks` 只保证"块都到齐了"，管不了"内容对不对"。
- **性质**：这正是上午 P1-5 要堵的那个洞（"线上从来没执行过内容校验"），
  修复把它堵在了"哈希非空"这一条路径上，但**留了一个可静默关闭校验的开关**。
- **同类**：`chunk_count` 是 `(size + chunk_size - 1) / chunk_size as usize`
  （`filetransfer.rs:338-343`）。在 wasm32 上 `usize` 是 32 位，
  `size = 2^32`、`chunk_size = 1` 时 `as usize` **截断成 0** → `missing_chunks(have, 0)`
  返回空 → "块收齐了"这道闸也一起失效，然后同上落进"无校验成功"。
  （该例在 JS 侧还要先分配 512MB 位图，能否走到取决于内存；但**逻辑洞是确凿的**。）
- **修复**：在邀约处理与 `expect()` 里**拒绝空/非 64 位 hex 的 `root_hash`**，
  校验 `size` / `chunk_size` / 块数在合理范围内，并把校验判定写成**穷尽**的
  （`else { bail!("无法校验内容") }`），不允许"悄悄不校验"。

### F18（P2，接近 P1）· 入站数据路径没有任何超时，且 iroh 强制 keep-alive 使空闲超时兜不住

- **位置**：`client-wasm/src/filetransfer.rs:610-616`（`accept_bi()` 与读 header 均无超时）、
  `:683`/`:808-833`（读块循环无超时）、`:628`（**先读 header 再查 `file_id`**）、`:646`（再校验身份）；
  接收上层 `transfer_orchestrator.rs:348-381`（等 `rx.recv()` 无超时）、
  `filetransfer.rs:764-775`（等上层回执最长 600s）
- **实测证据（依赖库源码已核对）**：`iroh-1.3.0/src/endpoint/quic.rs:157`
  `cfg.keep_alive_interval(Some(HEARTBEAT_INTERVAL));` ——
  **iroh 强制开启 QUIC keep-alive**，所以"对端不发数据"并不会触发空闲超时把连接回收，
  只要对端协议栈继续回 ACK，连接就一直在。
- **影响**：任何能拨通 `FILE_ALPN` 的人（EndpointId + relay 都在 presence / 邀约里公开广播）
  **在身份校验之前**就能钉住一个 Router 派生的任务：连上、开一条双向流、
  发 0~4 字节然后什么都不发即可。而 `FileService.pending` 与并发入站连接都没有上限，
  于是任务/连接/socket 只增不减 —— 对浏览器端就是标签页内存耗尽。
  这与 F1 一样属于"低门槛、高确定性"的可用性问题，只是成本从"一条消息"变成"N 条连接"。
- **修复**：读 header、读每一帧、等待上层回执都要有**deadline**（超时即断连并清理表项）；
  给并发入站连接数与 `pending` 表加上限；把 header 读取放到**上限内的**资源约束之下
  （例如先要求 `file_id` 命中 `pending` 再读大块数据）。

### F19（P2）· 重放 `Accept` 可把发送方放大成 N 份并发上传

- **位置**：`frontend/js/iroh-worker.js:107-115`（每个 `fileAccepted` 事件都直接起 `onAccepted()`）、
  `:350-358`（所谓"去重"只把旧的 UI 记录标失败，不取消在跑的发送）、
  `:414`（每次都会重新 `send_file_to` → 新连接）、
  `transfer_orchestrator.rs:146-333`（发送循环**没有**取消检查）、
  `filetransfer.rs:169-186`（`Accept` 的 `ts` 虽在签名里，但**没有任何新鲜度校验**）
- **影响**：`Accept` 是广播消息，房间成员可以抓下来重放。发送方每收到一次就重发一整个文件，
  且不会取消前一次 —— **一条小消息 = 一次全文件上传**，N 条就是 N 份并发出流量。
  这是拿别人的上行带宽做放大。第二段危害是 `accept_file` 先 `cancel(file_id)`
  （`room.rs:2093`），所以另一个发送方用同一个 `file_id` 的合法邀约能把正在进行的传输替换掉。
- **修复**：按 `(file_id, peer)` 保存可取消的句柄并在取消时真正中止发送循环；
  对 `Accept` 做新鲜度窗口与重复丢弃；给并发出站传输数加上限。

### P3 级（建议修，但不紧急）

1. **`load_from_disk` 不执行 5000 条上限**（`room.rs:754-757` 只在 `append` 时裁剪，`895-899` 加载时不裁）。
   磁盘是**只追加、从不压缩**的（`764-796`），所以磁盘无上限增长；
   重启时又把整个文件读进内存 → 内存上限形同虚设。
   另：`recent_before` 每次请求都 `map.get(room).cloned()` **整份克隆 + 排序**（`832-837`），
   历史越长单次请求越贵。建议加载时也裁剪、加磁盘保留策略、避免全量克隆。
2. **`append` 按 `ts` 单键排序（`753`），而分页契约是 `(ts,id)`（`834`）** ——
   同一毫秒的两条消息在内存里顺序不稳定，可能让页边界重复或漏掉一条。统一成 `(ts,id)`。
3. **`Presence` 的 `epoch` 是墙上时钟**（`987`/`1349` 用 `now_ms()`），
   用 `<` 比较丢弃旧心跳（`1461`）。若某台机器的时钟**向后跳**（NTP 校正、虚拟机恢复），
   它之后的所有心跳都会因 epoch 更小而**被丢弃** → 该成员在别人眼里一直离线、
   文件一直显示过期，直到时钟追平。另：`p.epoch == x.epoch` 是**会通过**的（不是 `<` 就不拦），
   所以"同毫秒两次状态变化被丢"这个说法不成立；真正缺的是 `ts` 的**新鲜度窗口** ——
   没有它，一条抓到的旧心跳可以被无限重放，把已离线的人维持成"在线且文件可用"。
   建议：`epoch = max(now_ms(), last_epoch + 1)`（混合逻辑时钟），并加 `ts` 容差校验。
4. **历史文件头的 TOCTOU**（`783-795`）：`metadata().len() == 0` 判断与写入之间没有锁，
   两个写入者可能都看到空文件 → 写两行头部 → 加载时第二行被当作坏消息静默跳过。
   建议按文件加锁或首次写用 `create_new`。
5. **前端 `_fileStateText` 里有未转义的 `error` 拼接**（`timeline.js` 中 `失败${error}`），
   而 `pushFileCard` 把它拼进 `innerHTML`（`timeline.js:311`、`323`）。
   **当前不可达**：所有 `EV.FILE_CARD` 发送方都不带 `error`，
   带 `error` 的更新走的是 `FILE_CARD_UPDATE`（用 `textContent`，安全）。
   但这是"等人踩"的隐患 —— 只要将来有人给 `pushFileCard` 传一次 `error`，
   而 `error` 可能来自对端可控的 `Reject/Done.reason`，就会变成 XSS。建议直接 `U.esc(error)`。
6. **站点没有任何安全响应头**：`frontend/index.html` 无 CSP，`dist/site` 无 `_headers`。
   对一个渲染对端内容的聊天应用，建议至少加 CSP（`default-src 'self'`）与 `Referrer-Policy`。
   （好在全部资源同源、无外部引用，风险有限。）
7. **测试脚本默认打生产**：`scripts/real-file-test.py:51` 写死 `https://im.editor.vip` 与固定房名，
   没有"仅本地/dry-run"闸门；误跑一次就会把测试数据写进生产房间历史
   （记忆里已记录过这类污染）。建议默认指向本地，生产必须显式开关。
8. **项目级**：目录**没有 Git 仓库**（无 `.git`、无 CI、根目录无 README/LICENSE/.gitignore）。
   对一个已经开始"修复安全漏洞并上线"的项目，缺版本控制意味着**无法回滚、无法审查差异、
   无法追溯某次修复是否真的进了产物** —— 本次审查也只能做现状审查。
   这是当前投入产出比最高的一项改进。
9. **协议 v3 是破坏性变更，缺少混跑保护**：v2 客户端的消息会被 v3 客户端在
   `room.rs:1380-1383` 静默丢弃（只有 `warn!` 日志，用户侧**零提示**），
   而且它自己的消息在本地看起来发送成功。上线期间若有人没刷新页面，
   表现为"我发的消息别人收不到"且毫无线索。建议握手/心跳里带协议版本，
   发现房间内版本不一致时给出**用户可见**的提示。
10. **`install.sh remove` 必然以非零退出收场**：`deploy/install/install.sh:48` 引用了
   `$TOKEN_FILE`，而它在 `:86` 才定义 —— 却位于 `:34-50` 的 remove 分支里，
   脚本顶部是 `set -euo pipefail`（`:16`）。于是卸载把东西都删完了，
   却在最后一步报 `TOKEN_FILE: unbound variable` 并 exit 1，让人以为卸载失败。
   把定义提到 remove 分支之前即可（顺便同步 `README.md` 里"无残留"的说法 ——
   证书与 token 其实是保留的）。
11. **构建元数据被发布到线上（已实测）**：`https://im.editor.vip/pkg/.gitignore` 与
   `/pkg/package.json` 均返回 **200**（`/probe.html` 正确返回 404，说明排除规则本身生效）。
   `deploy-web.sh:30-35` 只排除了 probe 三个文件和 `.DS_Store`，而 wrangler **不会**因为
   嵌套 `.gitignore` 就跳过文件（它连 `.gitignore` 本身都上传）。
   泄露的是 crate 名/版本与 API 面（`*.d.ts`），危害有限但没必要。
   建议在 rsync 里补 `--exclude '/pkg/*.d.ts' --exclude '/pkg/package.json' --exclude '/pkg/.gitignore'`。
12. **"新鲜度"自检因为缺 `scp -p` 而形同虚设**：`scripts/build-wasm.sh:27` 的
   `SCP=(scp -i … -P … -o BatchMode=yes)` 没有 `-p`，而 `:76-80` 的判断是
   `find src -name '*.rs' -newer frontend/pkg/iroh_web_bg.wasm`。scp 不保时间戳时，
   本地产物的 mtime 是**传输时刻**，永远晚于源码编辑时刻 —— 判断恒为"通过"。
   这正是注释 `:41-45` 想防的那类静默旧产物。加 `-p`，或改比对远端 `sha256sum`。
13. **端口真相分裂**：文档与前端配置用 **15443**（`docs/relay-deploy-minimal.md:32,76`、
    `frontend/relay-config.json:8,16,24`），而随仓库发布的 relay 配置用 **8443**
   （`deploy/relay/relay-a.toml:9`、`deploy/relay/docker-compose.yml:4,14`）。
   测试脚本还把旧端口写死且无环境变量覆盖（`scripts/e2e-relay-test.sh:11-12`、
   同 `verify-docker-noqad.sh:11-12`）—— 于是 e2e"通过"并不代表生产链路可用。
14. **`.gitignore` 缺失 + 无 git**：一旦 `git init && git add -A`，
   `.relay-token`（600）、`dist/relay-probe`（6.4MB）、`dist/roomtest`（6.9MB）、
   `deploy/roomd/roomd`（6.8MB）、`client-wasm/target/`、`scripts/__pycache__/*.pyc`、
   `frontend/pkg/`、`docs/*.png` 会一起进仓。**先写 `.gitignore` 再 init**。
15. **对端可控的 `file_id` 被拼进 CSS 选择器**（`timeline.js:337`、`:528`：`querySelector(\`[data-file-id="${file_id}"]\`)`）。
   `file_id` 是发送方自选的任意字符串，只过签名不看格式；一个 `a"]` 就能让
   所有 `updateFileCard`/`removeFileCard` 抛 `SyntaxError` ——
   而 `bus.emit` 对每个监听器有 `try/catch`（`bus.js:26-32`），所以**异常被吞、进度永久不再更新**。
   建议改 `CSS.escape(file_id)` 或按 `dataset` 过滤查找。
16. **`humanSize()` 会把非数字输入原样回显进 `innerHTML`**（`util.js:98-107`：`Number(bytes) || 0` 之后
   仍 `return \`${bytes} B\``）。当前不可达（Rust 侧是 `u64`，解析失败在 `room.rs:1379` 就丢了整个 `Wire`），
   但这是"只差一个类型检查"的 XSS 隐患。建议 `Number.isFinite` 判断后回退 `'—'`。
17. **IndexedDB 连接每次操作都新开且从不关闭**（`iroh-worker.js:467-477`，消费者 `:479/:492/:506/:813/:824`）。
   大文件每 64 块就 flush 一次位图 → 单次传输会开出很多连接；连接泄漏还会导致
   后续 `onupgradeneeded` 被阻塞。建议每个 worker 缓存一个连接并处理 `onversionchange`。
18. **前端若干"说了但没做"的小问题**：
   - `loadLatest()` 把取回的历史**追加在已经到达的实时消息之后**（`timeline.js:715-733` + `:214` 的 `appendChild`），
     再 `scrollBottom()`，于是顺序错乱且视口停在最老一条（`:726` 只补了空态判断）；
   - `paused`（"已暂停（可续传）"）在 `_fileActions` 里**没有任何按钮**（`timeline.js:439-523`），
     文案承诺可续传但无入口；
   - `transfer:note` / `transfer:send-failed` 两个 worker 事件在主线程**没有处理者**
     （`iroh-worker.js:631`、`:331`），所以"为什么这次从头收"的原因用户永远看不到；
   - `flashTitle` 设置被持久化并渲染成开关，但**没有任何读取方**（`sidebar.js:474-479`），是空开关；
   - `composer.send()` 在 await 之后才读 `this.room`（`composer.js:305` vs `:321`），
     正文与附件的房间可能不一致。
19. **重复块在哈希之后覆盖落盘内容**：`wasm_api.rs` 的顺序是"块校验（`:561-583`）→ **JS 写盘**（`:585-595`）→
   置位图（`:597-600`）→ 顺序检查（`:601-616`）"，而其中 `seq < next_seq` 是**被容忍**的（`:609-610`）。
   于是已鉴权的发送方重发同一块的不同字节时，落盘内容会变成"没有被哈希过的那份"，
   而 `finish()` 比的仍是先前那份哈希 → **校验通过但盘上文件不是被校验的那个**。
   修复：把顺序检查挪到 JS 写盘**之前**，重复块直接判失败（或逐字节比对）。
20. **`Pending` 在多数退出路径不清理**：只有正常完成时删（`filetransfer.rs:780`）；
   `deny`、取消、越界块、长度错、读失败（`:653`、`:662`、`:681`、`:710`、`:740`、`:755`）
   都直接 `return`，表项与两个通道端留在 map 里。后果：发送方重试同一 `file_id` 会命中
   "上层接收端已消失"的陈旧条目 → `tx.send` 失败 → 进而在等回执处阻塞最长 600s。
21. **`expect_sender == ""` 是失败开放**：`filetransfer.rs:647` 对空期望值**跳过**身份校验；
   `expect()`（`:516-535`）也不校验 `file_id` 非空，于是两个不同发送方可以登记同一个 `file_id`
   （签名只绑 sender 不绑 id）→ 结合 `accept_file` 先 `cancel(file_id)`（`room.rs:2093`）
   可相互顶掉传输。建议拒绝空值、失败关闭，表项按 `(sender, file_id)` 索引。
22. **断点位图被塞进 gossip 控制消息**：`Accept` 携带整个位图（`filetransfer.rs:99-103`、`room.rs:2099`），
   而 gossip 单条上限 512KB（`room.rs:51-57`）。超限时 iroh-gossip 是在**连接发送层**才报错
   （`iroh-gossip-0.101.0/src/net/util.rs:84-94` 的 `write_frame`），此时 `broadcast()` 早已返回 `Ok`
   —— 消息被丢，且该 gossip 连接报错（聊天一起受影响）。约 3.1M 块（16KB 块 ≈ 51GB）即触达。
   建议把位图移出控制面，或设硬上限并把超限当本地错误。
23. **`receiver_relay` 未校验就拨号**：`room.rs:2169`、`:2172-2175` 解析并拨号由 `Accept` 签名者提供的
   relay URL，还把它登记进内存地址表（`transfer_orchestrator.rs:169-173`）。
   任何房间成员都能让发送方去拨任意 relay（可做内网探测/地址簿污染）。建议限定在配置的 relay 集合内。
24. **原生 `BytesSink` 校验不严谨（生产不走，仅 `bin/filetest.rs:215`）**：
   `transfer_orchestrator.rs:125` 只按 `min()` 长度比前缀（`starts_with`）→ 空 `root_hash` 恒过；
   `&want[..n]` 在非字符边界会 panic。建议长度检查 + 完整字节比较。

---

## 第三部分：验证证据与局限

**已实测**：Rust 37 个单测（含安全回归）全绿；23 个前端 JS 语法全过；
`frontend/` 与 `dist/site/` 逐文件 sha256 全等（含 wasm）；站点引用与 import 图无断链；
线上 `https://im.editor.vip/pkg/.gitignore`、`/pkg/package.json` 返回 200、
`/probe.html` 返回 404（用于确认构建元数据泄露与排除规则生效）。

**F1（`return` 死循环体）与 F12（`_room !== wantRoom` 恒假）是可静态证明的**：
不需要运行时就能确认这两处分支不可能按注释的意图工作，这是本次结论里最硬的两条。
**F17（空 `root_hash` 跳过校验后直达成功）也是静态可证的** —— 三个判断条件与"没有 `else`"
拼起来就构成一条无校验的成功路径。**F18** 依赖的库行为也已在本机 vendored 源码里核对：
`iroh-1.3.0/src/endpoint/quic.rs:157` 确实强制 `keep_alive_interval`。

**本次审查的局限（不能由本次结论保证的部分）**：

- 未做真实浏览器双端端到端（保存位置交互、续传交互、大文件吞吐）。
  因此 **F5（续传不校验内容）**、**F13/F16（跨房间邀约 → 永久卡死）**、
  **F17 的"报成功"结局**、**F19 的放大效果** 都是静态分析 + 代码路径推导的结论，
  没有跑出"坏文件 / 卡死 / 被放大"的实物。
- 未对线上中继或线上 `roomd` 做任何攻击探测或压力验证；
  **F2** 的放大效应（无限订阅）与 **F18** 的连接耗尽都是按代码路径推导的。
- **F1** 的触发条件（一条畸形邀约）已按代码路径确认可达；
  但"任务永久退出、不自愈"是阅读 `AbortOnDropHandle` 生命周期得出的，
  没有在真实双端环境里观测到"此后彻底静默"的现象。
- 未重新构建 wasm（只验证了现有产物与源码一致）。
- 部署类结论里，凡涉及远端主机行为的部分（`build-wasm.sh` 的 `scp -p`、
  Docker 构建、防火墙实际生效）是**按脚本与文档静态推导**的，没有在目标主机上复现。

---

## 建议修复顺序

1. **`room.rs:1419` 的 `return` → `continue`**（一个词，P1，影响所有用户；
   并补"坏邀约之后消息仍能送达"的回归测试）。**性价比最高的一项。**
2. **给 `HISTORY_ALPN` 加鉴权 + 给自动订阅加上限与回收**（P1，单点服务的可用性与隐私）。
3. **把内容校验的判定写成穷尽的**（F17：拒绝空/非法 `root_hash`，加 `else { bail }`，
   并校验 `size`/`chunk_size` 上界）+ **续传也校验整文件哈希**（F5）。
   这两条合起来才真正兑现"浏览器端会校验内容"这个承诺。
4. **给入站文件路径加超时与并发上限**（F18：读 header/读帧/等回执都要 deadline，
   并发连接与 `pending` 表要有上限）。
5. **`net.js:244-250` 的抢占判断提前、被抢占时不写 `_room` 不发 `REJOINED`**（P2，改动小、
   消除"消息进错房间"）。顺手让 `main.js` 忽略 room 不匹配的 `REJOINED`。
6. **`accept_file`/`reject_file`/`query_file` 补 `expect_room`，文件事件带 room，
   并给接收等待加超时 + 取消入口**（F7+F13+F16 是一组，必须一起修才算闭环）。
7. **`Accept` 加新鲜度校验与可取消的发送句柄**（F19，阻止重放放大与重复上传）。
8. **签名载荷绑定房间（v4）**（F6，跨房间重放/冒充）。
9. **修部署快乐路径**：roomd 改为从源码多阶段构建（F3）、
   `install-relay.sh` 放行 `https_bind_addr`（F10）、`relay-docker.toml` 填上真实配置（F11）、
   `build-wasm.sh` 同步 `Cargo.lock` 并加 `--locked`（F9）。
10. **先补 `.gitignore`，再 `git init`**，把地址/版本/测试一起纳入（工程基座，越早越好）。
11. 历史读路径补验签 + 按字节数截断响应（F4/F8）。
12. 其余 P3 按需处理；其中"`[img]` 白名单"（F14）、"测试脚本默认打生产"、
    "`Pending` 退出路径清理"（P3-20）改动都很小，建议顺手做掉。

---

## 第四部分：修复记录（2026-10-03 晚，本报告之后）

修复过程本身又发现了一个**报告里没有的严重回归**，见下文 ⚠️ 项。

| 编号 | 状态 | 说明 |
|---|---|---|
| F1  | ✅ 已修 | `ctrl_event` 抽成纯函数（结构上不可能再 `return`），补回归测试「非法邀约只丢弃不终止循环」 |
| F2  | ✅ 已修 | roomd：容量上限 + LRU 淘汰（`ROOMD_ROOMS` pinned 保护）+ 新房间令牌桶（20 突发/5 每秒）+ 空闲回收（默认 30 分钟）+ 占位消除 TOCTOU + 有界通道；新增 4 条测试 |
| F3  | ✅ 已修 | `build-wasm.sh native` 同时产出 `dist/roomd`；删除仓库里那份 9-29 旧二进制；README/Dockerfile 写明"必须验证容器里的二进制" |
| F4  | ✅ 已修 | 历史响应按 1MB 预算裁剪（纯函数 `cap_history_by_bytes` + 测试，保证至少留一条） |
| F5  | ✅ 已修 | 续传时 JS 回读整份文件算 BLAKE3；校验失败则**丢弃断点**并以 `transfer:error` 明确报失败 |
| F6  | ✅ 已修 | 协议升到 **v4**：房间标识进全部签名载荷（ChatMessage/Presence/Leave/FileQuery/FileCtrl），`compute_id` 一并含 room；补 3 条「跨房间重放必须验签失败」测试。⚠️ **破坏性变更**：roomd + 前端必须同时升级并清旧历史。 |
| F7  | ✅ 已修 | `send_ctrl_in` 的房间参数改为**必填**（删掉"不限定房间"的入口）；`query_file`/`accept_file`/`reject_file` 全部带房间 |
| F8  | ✅ 已修 | 落盘加载与客户端渲染前都验签（各配日志计数） |
| F9  | ✅ 已修 | 同步 `Cargo.lock` + 三处构建加 `--locked` |
| F10 | ✅ 已修 | 改读 `https_bind_addr`；QUIC 端口只在开了 QAD 时放行；顺带把端口解析换成可移植的 `sed -E`（原来的 BRE `\+` 只在 GNU sed 上有效） |
| F11 | ✅ 已修 | `relay-docker.toml` 补上完整可用配置；端口口径统一为 **15443**（与前端/install.sh/文档一致） |
| F12 | ✅ 已修 | 抢占判断提到覆盖 `_room` 之前；被抢占时不写 `_room`、不发 `REJOINED`；`main.js` 忽略房间不匹配的 `REJOINED`；重进失败改为 `_scheduleRetry()` |
| F13 | ✅ 已修 | `restoreInvites(room)` 按房间过滤，且**不再删别的房间的记录** |
| F14 | ✅ 已修 | `[img]` 白名单（只放 `data:image/*` 与 `blob:`）+ `referrerpolicy=no-referrer` |
| F15 | ⏸ 未修 | 重发邀约复活已有卡片（`seen` 去重）—— 需要改 `pushFileCard` 的去重语义，风险高于收益，留待后续 |
| F16 | ✅ 已修 | 接收侧空闲超时（Rust 120s）+ 传输中停顿超时（60s）+ 「停止」按钮 + `paused` 补「继续接收」 |
| F17 | ✅ 已修 | 校验判定穷尽化（缺哈希/字节数不符一律判失败）+ `validate_meta`（64 位 hex、块大小、块数、id 字符集、文件名）+ 两处失败关闭 |
| F18 | ✅ 已修 | 读 header/开流超时 30s、帧间空闲 60s、在途并发闸门 64、待接收表上限 32 |
| F19 | ✅ 已修 | 控制消息新鲜度窗口（15 分钟，含"为什么这么宽"的说明）+ 同 `(file_id, peer)` 重复 Accept 去重 |
| P3-1 | ✅ 已修 | 加载时同样执行 `MAX_MEM_HISTORY` 上限 |
| P3-2 | ✅ 已修 | `humanSize` 非数字回退 `—` |
| P3-3 | ✅ 已修 | `append` 排序统一为 `(ts,id)` |
| P3-5 | ✅ 已修 | 文件卡片状态文案在拼进 `innerHTML` 前转义 |
| P3-6 | ✅ 已修 | `rebuildCardsForRoom` 带上进度与失败原因；`pushFileCard` 不再把初始宽度写死 0% |
| P3-8 | ✅ 已修 | 滚回底部时摘掉"以下为新消息"分隔线 |
| P3-9 | ✅ 已修 | `loadOlder` 按"游标是否前进"判定到底 |
| P3-10| ✅ 已修 | Worker 事件流循环加错误处理 → `node:degraded` → 提示并自动重连 |
| P3-13| ✅ 已修 | 补上 `transfer:note` / `transfer:send-failed` 的处理者 |
| P3-14| ✅ 已修 | `composer.send` 在第一个 await 前定下房间 |
| P3-15| ✅ 已修 | 卡片选择器对 `file_id` 用 `CSS.escape` |
| P3-16| ✅ 已修 | `bus.emit` 透传全部参数（`EV.TIP` 的 opts 不再是死的） |
| P3-19| ✅ 已修 | 重复块在**写盘之前**拒绝（不再"哈希通过但盘上内容被覆盖"） |
| P3-20| ✅ 已修 | `Pending` 表项清理守卫（按代次比对，不会误删用户续传新建的那条） |
| P3-21| ✅ 已修 | `expect_sender` 为空时失败关闭 |
| P3-4 | ⏸ 未修 | 历史文件头 TOCTOU（需要按文件加锁；当前单进程写入，实际触发概率低） |
| P3-7 | ⏸ 未修 | 前端 `transfers` / `outFiles` 无上限（长会话地图增长）—— 建议后续加 LRU |
| P3-11| ⏸ 未修 | `setNickname` 失败被吞、`flashTitle` 是空开关（纯体验问题） |
| P3-12| ✅ 已修 | `scp` 加 `-p`，让"产物比源码新"的自检真正生效 |
| 部署 P2-3 | ✅ 已处理 | 新增 `.gitignore`（密钥、构建产物、22MB 二进制）并 `git init` + 4 个提交 |

### ⚠️ 修复过程中发现的新回归（报告里没有，已修）

**浏览器端断点续传此前必然失败。** `JsChunkSink::write_chunk` 把"增量哈希必须按序"
与"块序号必须连续"混成了一件事，而续传本轮只补缺失块
（`need = missing_chunks(have, n)`，第一个到达的块序号就是第一个缺失块，例如 32），
`next_seq` 却从 0 起 —— 于是**第一块**就报
「块乱序：期望 seq=0，收到 32」，续传直接失败。
原生 `BytesSink` 只按 `seq * chunk_size` 写、没有顺序要求，所以这个缺陷
**只在浏览器路径上**，而 37 个单测走的全是原生路径 —— 测试全绿也发现不了。
已抽出纯函数 `check_chunk_admission` 并补 4 条测试把它钉住。

### 验证结果（修复后）

```
cargo test --no-default-features --features cli   53(lib) + 4(roomd) + 1(doc) 全绿
cargo check --locked --no-default-features --features cli   通过
node --check  23 个前端 JS                          全部通过
python3 scripts/check-site-modules.py dist/site     exit 0
事件总线一致性（EV.* 全部有定义）                     通过
全部 shell 脚本 bash -n                              通过
```

⚠️ **本次没有重新构建 wasm**（本机缺 wasm32 target，且 rustup 镜像 403）。
前端 JS 现在会给 `accept_and_receive` / `reject_file` / `query_file` 多传一个
`room` 参数，**只有新 wasm 才有这个签名** —— 所以部署必须按顺序：

1. `bash scripts/build-wasm.sh release`（重建 wasm，**必须先做**）
2. `bash scripts/build-wasm.sh native`（拿到新的 `dist/roomd`）
3. roomd：按 `deploy/roomd/README.md` 上传并 `docker compose up -d --build`，
   再用 `docker cp` + `strings` 验证容器里确实是新二进制
4. `bash scripts/deploy-web.sh`（发布站点）

⚠️ **F6 之后协议已是 v4，这一条不再成立**：签名载荷格式变了，
**roomd 与前端必须同时升级**，并且**清掉旧历史**（旧 `.jsonl` 里的消息在新代码下验不过，
会在加载时被当作"验签失败"丢弃并打 warn）。升级顺序：

1. 先 `bash scripts/build-wasm.sh release`（新 wasm）与 `native`（新 roomd）
2. 部署新 roomd（`deploy/roomd/README.md`），确认容器里是新二进制
3. 再 `bash scripts/deploy-web.sh` 发布新前端
4. 清历史：删掉 `ROOMD_DATA_DIR/history/*.jsonl`（**保留 `identity.key`**，否则 EndpointId 会变）

第 2、3 步之间存在一个混跑窗口：先升级的那一侧发出的消息会被另一侧静默丢弃。
自建小规模场景通常可接受；要完全避免就挑没人使用时做。
