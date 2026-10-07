# 2026-10-07 生产发版记录

## 版本

- 前端：Cloudflare Worker `iroh-chatroom`，版本 `bfef888a-79ab-4bbe-826a-12bd0b7a8089`。
- 域名：`https://im.pinkstar.cc`。
- 后端：服务器 `189.24.70.253:22` 的 `roomd` 容器。
- 后端 SHA-256：`126d874cfe848deca0c964c4ecdda2b5bf812e40c32c7a0dc24160001f5a855f`。

## 回滚

- SQLite、identity、配置备份：`/opt/iroh/backups/roomd/roomd-20261007T023016077212Z.tar.gz`。
- 旧后端二进制：`/opt/iroh/roomd/roomd.bak-20261007-023042`。
- 发布时保留协议 v4、WASM BUILD v14，未清理历史或身份数据。

## 线上验收

- 生产界面和异常状态：Chrome/WebKit `50/50`。
- 三份独立存储、多人同步、晚加入历史、64 条消息分页和刷新归属：`12/12`。
- Chrome/WebKit 文本、文件和图片刷新/切房归属：`38/38`。
- 三端文件分享、拒绝、续传、取消和混合结果：`26/26`。
- 生产静态资源 SHA-256 与发布源一致，HTTPS、relay `/ping`、roomd/relay 容器状态检查通过；roomd 和 relay 均 `restarts=0`。
- 发布后 SQLite `quick_check=ok`，roomd 发布以来未出现 ERROR、panic 或 fatal 日志。

详细验证输出位于 `output/playwright/release-20261007/`，该目录为本地测试产物，不参与发布。
