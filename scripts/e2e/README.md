# 浏览器端到端回归

## 跑

```bash
# 前置：本地静态服务 + 带 CDP 的 Chrome（见 run.sh 顶部注释）
bash scripts/e2e/run.sh                 # 全部
bash scripts/e2e/run.sh room-isolation  # 单个
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/fix-review.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/e2e/image-layout.mjs
```

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
| **relay-enabled** | 本目录 | 配置里的 `enabled: false` **真的排除中继**（状态页标「已禁用」、探测跳过它、全部禁用时启动被拦下） |

> 加粗的三个是后加的（分别验证"历史存储资源上限 + 房间隔离 + F15"、
> "状态页/设置页的布局与控件接线"）。

## 必须知道的坑

`multi-peer` 自己创建并销毁三份独立 BrowserContext，不关闭已有标签页；可用 `E2E_CDP` / `E2E_SITE` 指定 CDP 地址和测试站点。它会模拟首次历史失败和丢失实时广播，验证自动重试及每 10 秒的历史补齐；大于一页的断档会继续分页，文件卡片与文本按 `(ts, id)` 合并。

`file-recipients` 同样使用独立 BrowserContext，可设置 `E2E_CDP` / `E2E_SITE`，以及可选的 `E2E_SCREENSHOT` 保存发送侧截图。发送端卡片表示“已分享”，只统计实际响应的接收者，不把房间人数当作必须接收人数；详情里的进度和成功、拒绝、取消、失败均按身份独立记录。拒绝和取消不是技术错误，重新邀请只重置失败/取消的等待状态，不清掉已接收或拒绝的结果。文件在发送侧页面刷新或被保留预算淘汰前仍可供后来者接收。

若历史补齐先显示文件证明，用例会实际请求可接收的历史卡片以补齐邀约，
再完成逐字节传输检查；不会仅凭 `archived/live` 状态假定已收到文件。

0. ★ **整套连跑之前，先重启 roomd。**
   每轮用例都会新建一批房间，锚点会为每个房间累积历史与 gossip 邻居状态；
   十几轮之后**后半段的传输/进房类用例开始超时**（实测：`file-history` 掉 2 项、
   `file-recipients` 直接 CRASH；单独跑却分别 17/17、26/26）。
   ```bash
   ssh root@<host> 'docker compose -f /opt/iroh/roomd/docker-compose.yml restart roomd'
   ```
   实测：重启后整套 13 个用例 **128 项全绿**；不重启则偶发失败。
   判断依据是"失败的用例单独跑必过、且失败形态是超时而不是结果错误"。
1. **每个用例之前要清浏览器存储**（`clear-storage.py` 已封装）。
   上轮的 IndexedDB 位图与 localStorage 邀约污染下一轮，表现为"进不了房"或 `done=0`。
2. **房名必须每个用例唯一**（用时间戳派生）。
   用写死房名会让**锚点**上累积该房间的历史与 gossip 邻居状态 ——
   后来者进房直接看到「历史卡片(archived)」而不是实时邀约，
   表现为 `peers=1` 之类。**清浏览器存储治不了这个**（污染在服务端）。
   踩过：`refresh` 写死 `rf9` 时 4 项全挂，换新房名立刻 4/4。
3. **本机端口要清代理**（`run.sh` 已处理），否则被沙箱代理拦成 502。
4. **`relay-enabled` 会临时改写 `frontend/relay-config.json`**（dev 服务直接读该目录），
   用 `try/finally` 保证还原。它是唯一会动磁盘文件的用例 —— 跑之前建议先 `git status` 确认干净。
5. **`close_tab` 之后不能再读页面**：关掉标签，CDP 会话随之关闭，
   后续 `P.ev(...)` 会报 `ConnectionError: 连接关闭`（会被误判成"环境不稳"）。
   所有要读的数据都必须在 `close_tab` 之前取完。
6. **别用固定 `sleep` 等异步状态**：能等就等**确定信号**。
   踩过：`sidebar-pages` 的标题断言睡 2s，而标题实际在 `__state` 出现后 1.5~3.0s
   之间才写，正好卡边界 → 偶发失败。改成等"同一函数里更早写入的徽标"即可稳定。
7. **剪贴板在 headless 下默认被拒**：`sidebar-pages` 会用
   `Browser.grantPermissions` 授权 `clipboardReadWrite`，否则「复制」只能验证到
   "有反馈"、验证不了"复制成功"。
