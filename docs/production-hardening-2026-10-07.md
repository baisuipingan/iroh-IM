# 生产级打磨与验证记录

## 提交与范围

先修复已知问题并验证，再提交 Conventional Commits 基线，随后打磨高频主流程。
基线已提交：`e366b19 feat(chat): refresh UI and harden migrated deployment`。
包含原有界面重构及相关修复，排除了 `.workbuddy/memory/**`、凭据、构建和测试产物。
后续打磨保留在工作树；没有第二次 commit 或 push。本次工作树内容已通过受控流程发布到生产。
保留用户指定的海底设计、协议 v4 和 WASM BUILD v14，不重写 Rust 传输/历史内核。

## 基线修复与新机运维

- composer 只观察输入框宽度变化，下一帧测高，避免 ResizeObserver 同步写布局循环；Chrome/WebKit 12 项通过。
- relay-enabled 使用独立 context 拦截配置，磁盘原配置不写入；6 项通过。
- 修正隐私说明：常驻节点是房间成员，能读取文本历史；SQLite 存 JSON，没有额外静态加密。
- 新机 identity、.env、中继配置、TLS key 0600，数据/证书目录限制访问；容器运行 UID 为 root。
  仓库及实际证书同步脚本均以 0600 写私钥，实际同步后权限仍正确，健康探测通过。
- SQLite backup API 一致性备份，含身份/配置、私有权限、锁、原子写入、保留 14 份；3 项测试通过。
  新机每日 timer active；首次归档独立恢复 quick_check=ok，2027 条消息，identity 哈希匹配。
- roomd/relay Docker 日志轮转 10 MiB × 3，日常 RUST_LOG=info；保存回滚副本后受控重建，inspect 确认生效。
- 新机补齐 Cargo/Rustup 缓存、wasm-pack、clang 等工具。rustc 1.98.1、wasm-pack 0.13.1；
  native 与 WASM release 锁定构建均通过。WASM 约 3.6 MiB；native 最高 GLIBC 2.34，容器 Debian GLIBC 2.36。
  新候选二进制已在实际 roomd 镜像中运行验证，并作为本次后端发布版本。
- 后续服务器端发版目标为 `<SERVER_IP>:22`，已实测 SSH key 可登录，旧 roomd 保持停止。

## 工程与产品取舍

- `relay-model.js` 统一配置、运行时和 HTTP 探测状态，保留额外运行时节点，禁用节点不冒充主链路。
  校验 URL、唯一标识、启用字段、端口、锚点身份、令牌类型；坏缓存移除，失败有可读原因。
- 顶栏/拓扑通过 main 注入侧栏 host，消除门面之间反向依赖；不增加新框架。
- Worker 致命故障立即终止线程，拒绝并清空 RPC，忽略晚到事件，停止无效重连。
  输入区与文件卡片同步停止；已完成/已拒绝接收者保留结果，未完成者按人标失败。
  刷新后仍用原接收邀约/断点恢复机制，发送方需重新分享。
- 克隆失败只清理本次 RPC；Promise 超时在成功、拒绝、截止后均清理计时器。
- 通知权限在初始化、回前台和发通知前同步，撤权后偏好和开关均关闭；不自动重新申请权限。
- 异步模态失败原地提示、保留输入、恢复确认按钮；图标按钮/设置开关补可访问名称与标签。
- 搜索文案只承诺真实房间搜索。诊断页复用统一探测/存储，传中继令牌、排除禁用节点，
  复制失败有反馈，启动失败关残留节点，错误文本转义后渲染。
- HTTP 探测不再把 429/503 等响应标成可达；测试覆盖预热和采样失败。
- Biome/Playwright 固定为开发依赖，npm ci 可重建；生产不依赖 Node.js。
  开启未声明变量检查，JS/HTML lint 通过，无大规模存量格式改动。
- `verify.sh local|browser|all` 提供统一验证入口；Node 22+、Python/Rust、WebKit/CDP 前置已文档化。
  共享 CDP 脚本串行，默认不重启线上服务。

## 真实失败与复测记录

- 初轮 file-history 15 通过/1 失败：晚加入用户查询文件未及时拿到重发邀约。
  独立串行复测 17/0，随后完整 14 用例 257/0；没有改超时或断言。记录保留，继续观察网络波动。
- 初轮 refresh BrokenPipe 与另一测试误用同 CDP 并关闭标签有关；串行复测 4/0。
  不能把测试互扰当成生产故障证据。
- 第一轮 verify all 的 Rust、安全和 14 浏览器用例通过，新增 polish 用例停在窄屏遮罩拦截。
  脚本改为实际点击遮罩关闭抽屉再继续，不 force 点击穿透。
- DataCloneError 用 pending 总数断言会撞到正常轮询；改为检查故障请求 id 未泄漏。
  致命 Worker 故障后仍严格检查所有 pending 清空。
- 旧配置超时测试用空 relays 缓存，现改为有效配置；仍验证超时缓存回退与无缓存失败，截止时间不变。
- 上述修正后 test:polish 独立双内核复测：异常状态 50、草稿 12、隐私/同步 6、诊断页 22，通过。

## 逐文件自查

以下为基线提交后的逐文件自查重点。用户 memory 文件未改动、不提交。

| 文件 | 重点 |
|---|---|
| `.gitignore` | 仅新增 node_modules，密钥/产物继续排除 |
| `package.json` | 固定开发工具、Node 前置和命令一致 |
| `package-lock.json` | npm ci 可重建，无生产 npm 依赖 |
| `biome.json` | 仅格式与未声明变量检查，已有规则例外语义不变 |
| `frontend/js/relay-model.js` | 配置校验、URL 归一、禁用/无计时状态 |
| `frontend/js/probe.js` | 网络/缓存验证、15s 截止、HTTP 失败判断 |
| `frontend/js/net.js` | RPC 清理、启动失败、晚到事件、重连竞态 |
| `frontend/js/util.js` | 所有 Promise 结局清理计时器、保留原异常 |
| `frontend/js/ui/filetransfer.js` | 发送/接收故障分开、不改完成结果、不删断点 |
| `frontend/js/ui/dialog.js` | 异步失败留输入、旧异常不写新对话框 |
| `frontend/js/ui/notify.js` | 撤权同步，历史/自己消息仍不通知 |
| `frontend/js/ui/motion.js` | host 注入与主中继语义，快捷操作不变 |
| `frontend/js/ui/topology.js` | 统一模型，无主链路不冒用首台配置 |
| `frontend/js/ui/sidebar/status.js` | 禁用/冷备/异常区分，HTTP 非数据吞吐 |
| `frontend/js/ui/sidebar/settings.js` | switch 名称转义、原动作保留 |
| `frontend/main.js` | host 接线，网络与文件初始化顺序不变 |
| `frontend/index.html` | 名称/按钮类型、首帧主题、真实搜索语义 |
| `frontend/css/components.css` | 仅错误提示，长文可换行 |
| `frontend/probe.js` | 旧路径转发统一实现 |
| `frontend/probe-main.js` | 鉴权/禁用、复制失败、HTML 转义、节点清理 |
| `frontend/probe.html` | 按钮类型与输入标签，不删控件 |
| `scripts/test-frontend.mjs` | 8 项聚焦测试，mock 全局恢复，无公网依赖 |
| `scripts/e2e/production-polish.mjs` | 独立双内核、故障注入、DOM 和移动布局 |
| `scripts/e2e/diagnostic-probe.mjs` | 真实鉴权连接、隔离错误配置、不改磁盘 |
| `scripts/e2e/fix-review.mjs` | 有效缓存覆盖超时，原目的和截止不变 |
| `scripts/verify.sh` | 失败退出码、共享 CDP 串行、不隐式重启 |
| `scripts/e2e/README.md` | 工具安装、真实网络/模拟故障边界 |
| `README.md` | 开发/架构一致，移除旧 JSONL 描述 |
| `docs/production-hardening-2026-10-07.md` | 提交、复测、发布状态与残余风险 |

## 最终验证

最终串行命令已完成，退出码 0：

```bash
E2E_LOG_DIR=output/playwright/hardening-20261007/verified-suite \
E2E_OUTPUT=output/playwright/hardening-20261007/verified-browser \
bash scripts/verify.sh all
```

| 验证 | 结果 |
|---|---|
| Rust offline/locked 单元、集成、文档测试 | 78 通过 |
| 安全攻击回归（验签/真实 QUIC 流） | 18 通过 |
| 14 个浏览器主套件用例 | 257 通过 |
| Chrome/WebKit 异常态产品回归 | 50 通过 |
| 草稿缩窄/放宽 | 12 通过 |
| 提示音/拓扑/隐私同步 | 6 通过 |
| 诊断页真实鉴权与异常配置 | 22 通过 |
| 历史滚动 | 20 通过 |
| 主题跨标签同步 | 16 通过 |
| 图片布局 | 94 通过 |
| 交互/异常恢复综合回归 | 52 通过 |
| 刷新/切房消息与文件归属 | 38 通过 |
| 三 Chrome 存储与第四 WebKit 用户的历史存储 | 12 通过 |

浏览器合计 579 项通过、0 失败。真实多人收发、64 条消息的 50 条跨页读取、
无重漏排序、刷新归属及晚加入历史均验证；本轮未启用人工重启 roomd 的可选步骤。
完整日志：`output/playwright/hardening-20261007/verification-final.log`；
主套件逐用例日志：`verified-suite/`；双内核截图/结果：`verified-browser/`（同一输出根目录）。

- npm test：前端 8、SQLite 备份 3 项通过；lint 27 文件、模块引用和 whitespace 检查通过。
- npm audit（registry.npmjs.org）：当前 npm 固定开发依赖 0 已知漏洞。
  npmmirror audit 返回 404，未算通过；不据此宣称 Rust/整个系统无漏洞。
- 发布目录 dry-run 4.2 MiB、自检通过；随后已调用 Cloudflare 发布并完成线上资源哈希核对。
- Chrome/WebKit 桌面与 390px 移动截图人工检查，无横向溢出或乱叠；设置为滚动抽屉。
  Chrome 一次截图残影在等待稳定布局后未复现。
- 新机复查 roomd/relay 运行、HTTP 200、日志轮转生效、备份/BBR active/enabled，私钥/凭据 0600。
- 候选 native 在当前 roomd 镜像内以只读、无网络临时容器运行 ldd，所需动态库全部存在；
  这验证装载依赖兼容，随后已完成带现有身份和数据的服务端实际运行验收。

## 发布与回滚记录

> 原先单独一份 `release-2026-10-07-hardening`（已合并删除） 与本节的版本/回滚信息约九成重复，
> 2026-10-07 已合并到这里，原文件删除。**本文件是这一轮加固与发布的权威记录。**

### 版本

- 前端：Cloudflare Worker `iroh-chatroom`，版本 `bfef888a-79ab-4bbe-826a-12bd0b7a8089`，
  域名 `https://im.pinkstar.cc`。
- 后端：服务器 `<SERVER_IP>` 上的 `roomd` 容器，
  候选 SHA-256 `126d874cfe848deca0c964c4ecdda2b5bf812e40c32c7a0dc24160001f5a855f`。
- 保留协议 v4、WASM BUILD v14；未清理历史或身份数据。

### 回滚

- SQLite / identity / 配置备份：`/opt/iroh/backups/roomd/roomd-20261007T023016077212Z.tar.gz`
- 上一个后端二进制：`/opt/iroh/roomd/roomd.bak-20261007-023042`

### 线上验收

- 生产界面与异常状态（Chrome/WebKit）：50/50
- 三份独立存储、多人同步、晚加入历史、64 条消息分页与刷新归属：12/12
- Chrome/WebKit 文本、文件、图片的刷新/切房归属：38/38
- 三端文件分享、拒绝、续传、取消与混合结果：26/26
- 生产静态资源 SHA-256 与发布源一致；HTTPS、relay `/ping`、roomd/relay 容器状态通过，
  两者均 `restarts=0`
- 发布后 SQLite `quick_check=ok`，roomd 发布以来无 ERROR / panic / fatal

### 提交状态

基线 `e366b19` 已提交；随后一轮打磨以 `fc24920` 提交并推送。

## 后续建议（未完成）

1. 轮换聊天中提供过的 root 密码；确认可用密钥和救援通道后禁用密码 SSH，未擅改 sshd。
2. 增加异机加密备份、恢复演练和失败告警；本机备份不能抵御整机丢失。
3. 将 15443/TCP 规则统一到 1Panel 管理，避免批量操作覆盖当前 UFW 规则。
4. ~~发布前固定 Wrangler~~ —— **2026-10-07 已完成**：`wrangler@4.147.0` 已精确锁定进 `devDependencies`，`npm ci` 后 `deploy-web.sh` 的第一优先路径直接命中，不再依赖会被清理的 npx 缓存。（验证实际镜像运行、线上产物哈希这两条仍需每次发布时做。）
5. 回归不等于 SLA、跨地域吞吐保证或容量压测；继续观察 file-history 偶发失败。
6. 保留产品约束：只订阅打开的房间；房名即访问凭据；常驻节点可读历史；
   在线文件不是永久云盘，Safari/Firefox 文件系统限制仍明确提示。
