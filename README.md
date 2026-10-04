# iroh 聊天室

一个跑在浏览器里的端到端加密聊天室。基于 [iroh](https://iroh.computer/)（QUIC + 自建中继），
**无需注册账号** —— 房间名就是组播的标识，同名即同房间。中继只转发加密流量，
但常驻节点会保存可读取的文本历史；知道房名的人可以访问，没有成员审批，请勿用于敏感信息。

当前仅订阅正在打开的房间：切换房间后不接收其他房间的新消息，回房时从常驻节点补历史。
文件是在线分享而非永久云盘附件，发送者刷新或停止分享后无法继续获取。

## 三块东西

| 组件 | 是什么 | 在哪 |
|---|---|---|
| **前端** | 纯静态站点 + Rust→WASM 客户端（浏览器里跑一个 iroh endpoint） | Cloudflare Worker → `https://im.editor.vip` |
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
bash scripts/e2e/run.sh         # 浏览器端到端回归（前置见 scripts/e2e/README.md）
```

前端零构建：改 `frontend/**.js|css|html` 直接刷新即可（`dev-serve.py` 强制不缓存）。

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
