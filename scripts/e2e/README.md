# 浏览器端到端回归

## 测试钩子（`window.__*`）

所有钩子由 `frontend/js/test-hooks.js` 的 `installTestHooks()` 装上，
由 `main.js` 在启动时显式调一次。

| 名字 | 说明 |
|---|---|
| `window.__state()` | **主入口**。返回应用状态 + `ui`（界面文案镜像）+ `layout`（几何自检） |
| `window.__iroh_openRoom(r)` | 进/切房间 |
| `window.__iroh_sendText(t)` | 填输入框并发送（等价用户操作） |
| `window.__iroh_net` | 网络层本体（模拟掉线、强制重连） |
| `window.__iroh_theme(pref)` | **确定性**设置主题（`auto`/`light`/`dark`），不带参数则读 |
| `window.__iroh_view(v)` | 切视图（`chat`/`topology`） |
| 其余 `__iroh_*` | 见 `test-hooks.js` |

⚠️ **`__state` 是唯一没有 `__iroh_` 前缀的** —— 它被 130+ 处引用，改名代价大于收益。
新增钩子请一律用 `__iroh_` 前缀。
⚠️ 改名要同步改本目录下的 `*.py` / `*.mjs` 与 `scripts/transfer-*.{py,mjs}`（按字符串查找）。

## 跑

```bash
npm ci          # 含 wrangler（发布前端用，见 README 的工具链说明）
npx playwright install webkit
# 前置：本地静态服务 + 带 CDP 的 Chrome（见 run.sh 顶部注释）
bash scripts/e2e/run.sh                 # 全部
bash scripts/e2e/run.sh room-isolation  # 单个
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/fix-review.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/image-layout.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/message-ownership.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/roomd-storage.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/history-scroll.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/theme-sync.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/redesign-sync.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/composer-resize.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs python3 scripts/e2e/relay-enabled.py
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs python3 scripts/transfer-bench.py 8099 0.5,2,8 opfs
```

Node.js 22+ 提供冒烟脚本使用的内置 WebSocket。安装开发依赖后，无需设置
`PLAYWRIGHT_MODULE` 即可运行 `.mjs` 用例；该变量仍可覆盖现有安装路径。
`bash scripts/verify.sh all` 串行执行静态/单元/Rust/安全/浏览器验证。
`npm run test:polish` 覆盖 Chrome/WebKit 的通知权限撤回、Worker 致命故障与按人文件状态、
模态异步失败保留输入、草稿宽度自适应、隐私文案及诊断页真实中继鉴权。
故障回归使用隔离上下文注入异常，正常收发和诊断连接仍使用真实中继。

`fix-review.mjs` 启动独立 Chrome/WebKit 进程，覆盖超限报文后的健康通信、同身份连续刷新、
异步草稿/附件保护、按房草稿、房名校验、本地隐藏、取消/拒绝/重邀、图片预览、
窄屏、模态焦点、临时存储模式、列表容量和清理退出。可设置 `E2E_SITE`、
`E2E_ANCHOR`（只覆盖测试上下文的锚点）、`CHROME_PATH` 和 `E2E_OUTPUT`。
系统保存窗口由真实 OPFS 文件句柄替代，文件网络传输与写盘/预览不模拟。
`run.sh` 保留子进程退出码，任何 FAIL、CRASH、缺脚本或未知名称均返回非零。
追加覆盖实时文件证明先于邀约的乱序、历史旁观卡隔离，以及 Worker 下载失败和启动无响应。
Worker超时用例缩短测试计时器，生产启动上限仍为45秒。

`image-layout.mjs` 使用Chrome/WebKit实际渲染横图、竖图、方图及极端比例图片，
覆盖发送/接收、深浅主题和320px/桌面布局，验证比例、容器边界、底栏不重叠、
未接收占位、预览释放及放大查看。图片卡片布局通过本地blob注入，不模拟网络接收；
真实P2P图片接收仍由`fix-review.mjs`覆盖。

`message-ownership.mjs` 在Chrome/WebKit里复现刷新时节点启动未完成就选房，验证身份先于历史加载、
自己的历史和新消息靠右、他人消息靠左，以及文件/图片卡片发送和切房重建后的方向。

`roomd-storage.mjs` 使用三个独立 Chrome 存储和一个 WebKit 用户，覆盖多人互发、晚加入历史、
64 条消息的跨页读取、排序与归属、刷新恢复。可设置 `E2E_SITE`、`PLAYWRIGHT_MODULE`、`E2E_OUTPUT`。
设置 `E2E_RESTART=1` 时，脚本在生成 `restart-ready.json` 后等待操作员重启 roomd，
在同一输出目录写入 `restart-complete.json`（内容为 `{"ok":true}`）继续验证新浏览器能读回全部历史、
重启后新消息仍能持久化。输出目录应为本次运行的独立目录，避免使用上一轮的重启确认文件。

## Agent / 适配器回归（非浏览器）

这些脚本不走 CDP、不需要浏览器，直接用**真实中继**验证 `iroh-agent serve`（行协议）
与 `agent-pi` 适配器。前置：

```bash
cd client-wasm && cargo build --no-default-features --features cli --bin agent
cd ../agent-pi && npm ci      # 只有 pi-* 脚本需要（pi SDK）
```

中继与令牌自动读 `frontend/relay-config.json`（公开信息，随页面下发）；
身份目录不给参数就自动建临时目录。**每个进程必须独立 `IROH_AGENT_HOME`**
（同一身份两个端点同时在线会打架，见 `docs/agent-daemon-protocol.md` §1）。

```bash
python3 scripts/e2e/agent-serve-smoke.py     # 单进程协议往返（~1 分钟）
python3 scripts/e2e/agent-serve-two-peer.py  # 双进程真实收发 + presence（~2 分钟）
python3 scripts/e2e/agent-file-receive.py    # agent 收文件：3MB 真实传输 + sha256 校验（~1 分钟）
python3 scripts/e2e/agent-pi-e2e.py          # 适配器：触发/冷却/@提及/杀进程自愈/SIGTERM（~4 分钟）
python3 scripts/e2e/agent-pi-files.py        # 适配器文件策略：自动收小文件/按上限拒大文件（~1 分钟）
python3 scripts/e2e/agent-pi-llm-down.py     # LLM 不可用时：只影响单条消息、进程存活（~2 分钟，需 agent-pi npm ci）
node scripts/e2e/agent-pi-faux.ts            # pi-sdk brain 离线冒烟（faux provider，秒级）
E2E_PI_MODEL=hahacode/gpt-6.1-sol \
  python3 scripts/e2e/agent-pi-live.py       # 真实 LLM 房间级问答（opt-in，~2 分钟起）
```

`agent-pi-live.py` 需要 `~/.pi/agent/models.json` 里有可用 provider，并用
`E2E_PI_MODEL=provider/modelId` 指定模型（不设会直接退出并提示）。

`serve` 的**黄金转录**不在这里 —— 它是离线的 Rust 测试，已进标准套件：

```bash
cd client-wasm
cargo test --offline --locked --no-default-features --features cli --test daemon-protocol
# 有意改协议后重新生成（review diff 再提交）：
UPDATE_GOLDEN=1 cargo test --offline --locked --no-default-features --features cli --test daemon-protocol
```

| 脚本 | 覆盖 |
|---|---|
| `agent-serve-smoke.py` | hello/reply 往返、错误码（badRequest/unsupportedCmd/tooLarge）、事件流、退出码 0 |
| `agent-serve-two-peer.py` | A 以 B 为 bootstrap 入房；消息互收（mine/from 正确）、presence 互见、优雅退出 |
| `agent-file-receive.py` | B 发 3MB → A `accept_file` 落盘；sha256 逐字节一致、`fileRecv*` 事件齐全、双方优雅退出 |
| `agent-pi-e2e.py` | `!ping`→pong、无关文本不触发、@提及 + `{bot}` 模板、杀 serve 子进程后自动重启并重新进房、SIGTERM 退出码 0 |
| `agent-pi-files.py` | `--files accept`：小文件自动接收（sha256 一致）、超上限文件自动拒绝（理由含大小）、大文件不落盘 |
| `agent-pi-llm-down.py` | LLM 失败只影响单条消息（无回复、有日志）、双进程存活、SIGTERM 仍优雅退出 |
| `agent-pi-faux.ts` | pi-sdk 真会话（faux 模型）：两轮回复、队列耗尽错误路径、会话有记忆、dispose 干净 |
| `agent-pi-live.py` | **真实 LLM 房间级**：@触发 → 房间内真实回答 → 优雅退出（opt-in，`E2E_PI_MODEL` 指定模型） |
| `daemon-protocol.rs`（Rust） | serve 协议黄金转录（归一化 + 排序对比；seq 严格递增单独断言） |

> 这些脚本互相独立、可并发跑（房名都有随机后缀），但都会连线上中继、占用带宽；
> 与浏览器套件同时跑时注意吞吐类用例别受干扰。

## 用例

全部用例都在本目录（原来散在 `/tmp`，重启即丢；已搬进版本控制）。

| 名称 | 覆盖 |
|---|---|
| file-history | 文件历史卡片、能力清单、离开即过期、可逆恢复、刷新失效（主测试） |
| multi-peer | 三份独立浏览器存储、三人互发、晚加入历史重试、丢失广播补齐、历史/实时排序、跨页断档、切房代次隔离 |
| file-recipients | 独立三端的成功/拒绝混合结果、全拒绝、按人进度、失败与取消、续传重试、图片/文件详情和切房重建 |
| review-frontend | 输入框/附件/空态等交互与 console 无错 |
| dm-removed | 私聊移除后不残留 |
| stale | 陈旧邀约不诈尸 |
| offline-room | 断线时切房间 → 恢复后进**用户想去的**那间 |
| refresh | 多接收方 + 一方刷新，另一端不受牵连 |
| leave-cancel | 刷新方主动取消，发送端立即感知 |
| **room-isolation** | 本目录 | **文件清单按房间隔离**（切房后不再声明旧房间的 file_id） |
| **card-revive** | 本目录 | **重发邀约让"已失效"卡片复活**（DOM 按钮回到 ✓/✗） |
| **sidebar-pages** | 本目录 | **状态页/设置页**：中继行不叠字、不横向溢出、身份分组显示、中继计数自洽、资料卡「复制」按钮真绑定、标题未读数开关真生效 |
| **multi-user-online** | 本目录 | **线上多用户模拟**（真站点 + 真中继 + 真 roomd）：4 个固定身份互相可见、消息归属（自己靠右/他人靠左）、全局时间序、后进房者能看历史、刷新后历史完整且归属正确 |
| **relay-enabled** | 本目录 | 配置里的 `enabled: false` **真的排除中继**（状态页标「已禁用」、探测跳过它、全部禁用时启动被拦下） |
| **rendezvous-split** | 本目录 | **阶段 B′**：入口（rendezvous）与历史（history）是两个独立能力 —— 去掉兼容字段 `anchor`、把 `history` 指向一个合法但不存在的节点，**仍然进得了房**（证明发现走的是入口）且实时消息照常（证明历史挂掉不影响房间）|
| **isolated-room** | 本目录 | 常驻节点**联系不上时仍能进房**（降级为"孤立"，不报"进房间失败"）：拦截 `relay-config.json` 把 anchor 换成一个合法但没人应答的 ed25519 公钥，断言进房成功、输入可用、如实提示孤立、消息仍发得出去；对照组（真 anchor）不出现孤立提示 |
| **redesign** | 本目录 | **比奇堡视觉改造**：三栏骨架尺寸、环境气泡、筛选 chips、顶栏徽标/副行、连接状态页与设置页的卡片结构、**两套主题逐对量 WCAG 对比度**、**状态页不许出现设计稿编造的量**（`3000m`/`MHz`/`丢失率`）、壁纸即改即存、设置页搜索真的筛、以及 `image-layout.mjs` 那两条图片硬约束的 CDP 复刻（116px / ≤220px） |

> 加粗的几个是后加的（分别验证"历史存储资源上限 + 房间隔离 + F15"、
> "状态页/设置页的布局与控件接线"、"中继 enabled 开关"，以及比奇堡改造后的视觉与对比度）。

## 必须知道的坑

`multi-peer` 自己创建并销毁三份独立 BrowserContext，不关闭已有标签页；可用 `E2E_CDP` / `E2E_SITE` 指定 CDP 地址和测试站点。它会模拟首次历史失败和丢失实时广播，验证自动重试及每 10 秒的历史补齐；大于一页的断档会继续分页，文件卡片与文本按 `(ts, id)` 合并。

`file-recipients` 同样使用独立 BrowserContext，可设置 `E2E_CDP` / `E2E_SITE`，以及可选的 `E2E_SCREENSHOT` 保存发送侧截图。发送端卡片表示“已分享”，只统计实际响应的接收者，不把房间人数当作必须接收人数；详情里的进度和成功、拒绝、取消、失败均按身份独立记录。拒绝和取消不是技术错误，重新邀请只重置失败/取消的等待状态，不清掉已接收或拒绝的结果。文件在发送侧页面刷新或被保留预算淘汰前仍可供后来者接收。

若历史补齐先显示文件证明，用例会实际请求可接收的历史卡片以补齐邀约，
再完成逐字节传输检查；不会仅凭 `archived/live` 状态假定已收到文件。

0. **不要把重启 roomd 当作回归前置或根据超时直接归因。** 本轮修复后未重启 roomd，整套功能回归通过。
   先检查日志、连接、实际接收进度、测试隔离与历史结果，再决定是否需要重启。
   共享 CDP 中会关闭标签页或清存储的脚本必须串行运行；吞吐基准也应在无其他文件传输时测量。

0b. **`file-recipients` 大文件超时时，要区分发送排队进度与接收交付。**
   典型签名（失败瞬间的快照）：
   ```
   发送方视图：recipient state=sending, done=128/128, bytes=2097152   ← 已写入发送队列，尚未确认交付
   接收方页面：state=active, done=104/128                             ← 只收到 104
   ```
   每次卡在不同块数本身不能排除状态机或资源问题。本轮通过独立浏览器、真实 OPFS、无写盘对照、
   Worker计时和服务端TCP重传指标定位外层链路；端口级 BBR 修复及回滚对照见 `docs/relay-tcp-bbr.md`。
   **HTTP 探测快 ≠ 数据面快**：浏览器数据走 `15443/tcp` 的 WSS 隧道，内部承载 QUIC；
   `7842/udp` 的 QAD 探测不代表浏览器文件数据路径。

   ⚠️ **不要用"把 45s 超时调大"来解决。** 那只会把"吞吐劣化"这个真实信号盖掉，
   而吞吐劣化会直接影响真实用户传大文件。先用 `scripts/transfer-bench.py` 量出真实吞吐。

1. **每个用例之前要清浏览器存储**（`clear-storage.py` 已封装）。
   上轮的 IndexedDB 位图与 localStorage 邀约污染下一轮，表现为"进不了房"或 `done=0`。
2. **房名必须每个用例唯一**（用时间戳派生）。
   用写死房名会让**锚点**上累积该房间的历史与 gossip 邻居状态 ——
   后来者进房直接看到「历史卡片(archived)」而不是实时邀约，
   表现为 `peers=1` 之类。**清浏览器存储治不了这个**（污染在服务端）。
   踩过：`refresh` 写死 `rf9` 时 4 项全挂，换新房名立刻 4/4。
3. **本机端口要清代理**（`run.sh` 已处理），否则被沙箱代理拦成 502。
4. **`relay-enabled` 使用独立 Playwright context 拦截配置请求**，不写入磁盘配置。
   需要安装 Playwright，或通过 `PLAYWRIGHT_MODULE` 指定现有模块路径；运行完整套件时也要导出该变量。
   禁用中继的测试配置仅对测试浏览器生效，即使进程被杀也不会污染下次发布。
   跑完回归仍应检查 `git status`，避免其他用例产生意外修改。
5. **`close_tab` 之后不能再读页面**：关掉标签，CDP 会话随之关闭，
   后续 `P.ev(...)` 会报 `ConnectionError: 连接关闭`（会被误判成"环境不稳"）。
   所有要读的数据都必须在 `close_tab` 之前取完。
6. **别用固定 `sleep` 等异步状态**：能等就等**确定信号**。
   踩过：`sidebar-pages` 的标题断言睡 2s，而标题实际在 `__state` 出现后 1.5~3.0s
   之间才写，正好卡边界 → 偶发失败。改成等"同一函数里更早写入的徽标"即可稳定。
7. **剪贴板在 headless 下默认被拒**：`sidebar-pages` 会用
   `Browser.grantPermissions` 授权 `clipboardReadWrite`，否则「复制」只能验证到
   "有反馈"、验证不了"复制成功"。
