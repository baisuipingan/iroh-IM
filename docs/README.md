# 文档索引

> 想知道"该看哪份"从这里开始。**日期化的审查与修复记录已归档到 [`history/`](history/)** ——
> 那些是一次性的过程产物，结论基本都汇总进了下面的"当前状态"类文档。

## 当前状态（这几份是权威的）

| 文档 | 什么时候看它 |
|---|---|
| [`stability-review-2026-10-19.md`](stability-review-2026-10-19.md) | **跨公网闪断复盘**：线上 7 天 21,945 次中继队列满丢包的证据、2 MB 初始窗口 vs 512 包队列的根因、P0/P1/P2 分阶段方案与验收标准 |
| [`production-hardening-2026-10-07.md`](production-hardening-2026-10-07.md) | **最近一轮加固与发布的权威记录**：修了什么、取舍、逐文件自查、全部验证数字、发布版本与回滚路径、未完成的后续建议 |
| [`deploy.md`](deploy.md) | 日常部署与运维：roomd / 中继 / 前端发布、构建机、备份、1Panel 与防火墙、回滚 |
| [`server-migration-2026-10-06.md`](server-migration-2026-10-06.md) | 香港服务器迁移的清点与结果（已迁到新机，老机到期作废） |

## 架构与设计

| 文档 | 内容 |
|---|---|
| [`file-transfer-architecture-review-2026-10-19.md`](file-transfer-architecture-review-2026-10-19.md) | **文件传输选型复核**：iroh 官方对浏览器 relay-only / iroh-blobs 的边界、WebRTC 实测成功率、Matrix/XMPP/tus/S3 的成熟做法，以及"保留聊天层、换文件面"的方案对比 |
| [`file-plane-implementation-2026-10-19.md`](file-plane-implementation-2026-10-19.md) | **文件面落地笔记**：Matrix 的 content repository 细节、tusd 的能力/钩子/部署坑、RustFS vs MinIO vs R2 的取舍、以及"3 台 relay 够不够"的部署形态 |
| [`simplest-stable-plan-2026-10-19.md`](simplest-stable-plan-2026-10-19.md) | **最简稳定方案（推荐）**：不用 iroh，单机 VPS + WebSocket 聊天 + HTTP/tus 文件 + SQLite/R2；含技术选型、MVP 范围、迁移步骤与取舍 |
| [`agent-chat-simplest-plan-2026-10-19.md`](agent-chat-simplest-plan-2026-10-19.md) | **Agent 聊天室最简方案（BYOA 专用）**：本地 agent 出站 WebSocket 接入 Hub；保留 `agent-pi` 的 ACP/权限/触发逻辑，只换 transport；含协议、身份、路由、文件、迁移 |
| [`iroh-chatroom-feasibility.md`](iroh-chatroom-feasibility.md) | 为什么选 iroh、浏览器端永久 relay-only 的含义、多中继动态切换、可行性边界 |
| [`roomd-architecture-and-storage.md`](roomd-architecture-and-storage.md) | 常驻节点（房间锚点）的职责、协议、历史存储改造决策 |
| [`message-storage-design.md`](message-storage-design.md) | 消息存储方案调研与设计（端侧权威为什么不照搬微信） |
| [`storage-migration-plan.md`](storage-migration-plan.md) | 历史存储从手写 jsonl 换成 SQLite 的改造方案 |

## 中继

| 文档 | 内容 |
|---|---|
| [`relay-deploy-minimal.md`](relay-deploy-minimal.md) | 精简部署方案（Docker 版）、一键安装脚本、证书与续期链 |
| [`relay-tcp-bbr.md`](relay-tcp-bbr.md) | TCP 吞吐修复：为什么浏览器走 WSS/TCP、端口级 BBR 怎么装、基准数据 |

## 界面

| 文档 | 内容 |
|---|---|
| [`frontend-redesign-bikini-bottom-2026-10-05.md`](frontend-redesign-bikini-bottom-2026-10-05.md) | 比奇堡海底通讯改造全过程：设计令牌、三栏骨架、会话列表/输入区/时间线/状态页/设置页的落地、四个阶段的问题与修法、2026-10-05 上线记录 |
| [`design-brief-filetransfer.md`](design-brief-filetransfer.md) | 给设计团队的 Brief（可直接复制的提示词 + 完整状态表），文件传输卡片体系还没实现，这份是输入 |

## 历史归档

[`history/`](history/) 里有 12 份日期化的审查与修复报告（2026-10-02 ~ 10-06），
包括前端 review、项目审查、浏览器实测、交接文档等。
它们的结论已汇总进上面的当前状态文档，**只在你想追溯"当时为什么这么改"时才需要翻**。