# iroh 聊天室

一个跑在浏览器里的端到端加密聊天室。基于 [iroh](https://iroh.computer/)（QUIC + 自建中继），
**无需注册账号** —— 房间名就是组播的标识，同名即同房间。中继只转发加密流量，
但常驻节点会保存可读取的文本历史；知道房名的人可以访问，没有成员审批，请勿用于敏感信息。

当前仅订阅正在打开的房间：切换房间后不接收其他房间的新消息，回房时从常驻节点补历史。
文件是在线分享而非永久云盘附件，发送者刷新或停止分享后无法继续获取。

## 三块东西

| 组件 | 是什么 | 在哪 |
|---|---|---|
| **前端** | 纯静态站点 + Rust→WASM 客户端（浏览器里跑一个 iroh endpoint） | Cloudflare Worker → `https://im.pinkstar.cc` |
| **中继（relay）** | 转发加密流量。看不到内容，也做不到历史 | 自建，`15443/tcp` + `7842/udp` |
| **常驻节点（roomd）** | 房间锚点：提供**历史消息**和在线状态，让新进房的人有东西可看 | 服务器 Docker，`/opt/iroh/roomd` |

浏览器版是 **relay-only**（不能打洞），所以中继是必需品；
roomd 让"人不在也能看到历史"成立 —— 中继无状态，一转手就忘。

## 快速开始（本地）

```bash
python3 scripts/dev-serve.py 8099        # 服务 frontend/，强制不缓存
# 浏览器打开 http://127.0.0.1:8099/?autostart=1&room=test
```

本地前端默认连**线上**中继与常驻节点，所以一个人也能进房、看到历史。

## 部署与变更

**看 [`docs/deploy.md`](docs/deploy.md)** —— 唯一权威的上线流程，包含：

- 两条部署线的顺序（**先升 roomd、再上前端**，反了不生效）
- 「改了什么 → 要重建什么」对照表
- **「改了但没生效」四条排查**（Docker 镜像是 `COPY` 进去的、构建脚本可能静默失败…）
- 协议版本变更（破坏性）与历史清理
- 上线后的验证方式（含"本机 curl 会被代理中间人，要改从构建机验"）
- 回滚

## 开发

```bash
cd client-wasm && export PATH="$HOME/.cargo/bin:$PATH"
cargo test  --offline --locked --no-default-features --features cli   # 单元测试
cargo check --offline --locked --no-default-features --features cli   # 验证 Cargo.lock 同步

bash scripts/security/run.sh    # 安全攻击回归（用原始攻击脚本验证修复被挡住）

node scripts/smoke.mjs          # 前端冒烟（~6 秒）—— 改过前端**先跑这个**
bash scripts/e2e/run.sh         # 浏览器端到端回归（前置见 scripts/e2e/README.md）
```

⚠️ **`smoke.mjs` 必须在 `e2e/run.sh` 之前**。一个未定义的引用就能让整个
`main.js` 挂掉，表现为**每个用例都 `TimeoutError`** —— 崩溃日志完全指不到真正的错。
（实测：`test-hooks.js` 里一个悬空变量，26 个用例全 CRASH，跑了 21 分钟才查到。）
冒烟脚本会直接把页面异常和缺失的钩子打出来，6 秒定位。

前端零构建：改 `frontend/**.js|css|html` 直接刷新即可（`dev-serve.py` 强制不缓存）。

### 代码风格（lint / format）

本项目**零 npm 依赖**，所以工具也不进 `package.json` —— 用biome 的独立二进制：

```bash
npm i -g @biomejs/biome     # 或 npx @biomejs/biome
cd frontend && biome check ../frontend/js main.js ../frontend/css
biome check --write .       # 自动修
```

- **`biome.json`** —— lint + format 配置。当前状态：**0 error / 0 warning**。
- **`.editorconfig`** —— 编辑器通用约定。Python 侧（`scripts/` 下 30+ 脚本）
  没有任何工具管，这份文件是那边唯一的约束。
- ⚠️ **`biome format` 不要跑在存量代码上**：项目里行尾注释是**刻意用空格对齐成列**的
  （`EV` 事件表、配置项列表都是），biome 会把这些对齐全部拆掉，产生 21 个文件的无意义 diff。
  formatter 只用于**新写的文件**。

**biome.json 里每条被关掉的规则都写了注释说明原因**，别随手打开 ——
比如 `noControlCharactersInRegex` 关掉是因为 `util.js` 的房间名校验
**本来就要**匹配控制字符。

### 前端代码结构

```
frontend/js/
frontend/main.js          组装层：初始化 + 事件接线 + 进房流程
  bus.js  store.js  util.js    内核：无 DOM 副作用
  net.js                 网络层（唯一碰 wasm 的地方，走 postMessage RPC）
  iroh-worker.js         Worker：wasm + blake3 + IndexedDB 断点
  probe.js               中继探测
  test-hooks.js          自动化钩子（window.__state / __iroh_*），main.js 显式装一次
  ui/
    primitives.js        跨视图共享原语（avatar / ico / regionLabel / WALLPAPERS）
    sidebar.js           侧栏门面：只管状态、事件接线、渲染调度
    sidebar/chats.js       会话列表页
    sidebar/status.js      连接状态页
    sidebar/settings.js    设置页 + 设置项动作
    timeline.js  composer.js  filetransfer.js
    motion.js  topology.js  theme.js  notify.js  dialog.js
```

**依赖方向单向向下**：`main → ui/* → 内核 → net → Worker`。
⚠️ **不要在 ui/ 之间横向 import**（`timeline.js` 去 import `sidebar.js` 这类）。
共享的东西放`primitives.js`，确实需要读另一个视图的状态就用参数把 `host` 传进去。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/deploy.md`](docs/deploy.md) | **部署与变更**（先看这个） |
| [`deploy/roomd/README.md`](deploy/roomd/README.md) | 常驻节点：部署细节、环境变量、容量上限、历史访问边界 |
| [`deploy/relay/README.md`](deploy/relay/README.md) · [`docs/relay-deploy-minimal.md`](docs/relay-deploy-minimal.md) | 中继部署 |
| [`deploy/install/README.md`](deploy/install/README.md) | 中继一键安装脚本 |
| [`scripts/e2e/README.md`](scripts/e2e/README.md) | 浏览器回归：用例清单 + 前置 + 已知坑 |
| [`scripts/security/README.md`](scripts/security/README.md) | 安全回归的用法与覆盖范围 |
| [`docs/iroh-chatroom-feasibility.md`](docs/iroh-chatroom-feasibility.md) | 最初的可行性分析 |
| [`docs/project-review-2026-10-03.md`](docs/project-review-2026-10-03.md) · [`-postfix`](docs/project-review-2026-10-03-postfix.md) | 两轮安全审查与修复记录（设计约束的来由多半在这里） |

## 设计要点（看一眼能省很多事）

- **软状态是唯一事实来源**：成员靠心跳（10s）与超时（35s）派生，事件只加速、不决定事实
- **每条消息都用作者私钥签名**，`id` 由载荷派生并参与签名；签名载荷里带房间标识（v4）
- **历史落盘文件名是 `blake3(房间名)`**，原始房间名存在文件头并自校验 —— 绝不从文件名反推
- **文件传输走 P2P（QUIC）**，内容走增量 BLAKE3 校验；`file_id` 是公开广播的，**不是授权凭据**
- 常驻节点的历史 ALPN **没有应用层鉴权**（房间名就是全部凭据），不要托管私密历史
