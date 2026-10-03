# 浏览器端到端回归

## 跑

```bash
# 前置：本地静态服务 + 带 CDP 的 Chrome（见 run.sh 顶部注释）
bash scripts/e2e/run.sh                 # 全部
bash scripts/e2e/run.sh room-isolation  # 单个
```

## 用例

| 名称 | 位置 | 覆盖 |
|---|---|---|
| file-history | `/tmp/file-history-test.py` | 文件历史卡片、能力清单、离开即过期、可逆恢复、刷新失效（主测试） |
| review-frontend | `/tmp` | 输入框/附件/空态等交互与 console 无错 |
| dm-removed | `/tmp` | 私聊移除后不残留 |
| stale | `/tmp` | 陈旧邀约不诈尸 |
| offline-room | `/tmp` | 断线时切房间 → 恢复后进**用户想去的**那间 |
| refresh | `/tmp` | 多接收方 + 一方刷新，另一端不受牵连 |
| leave-cancel | `/tmp` | 刷新方主动取消，发送端立即感知 |
| **room-isolation** | 本目录 | **文件清单按房间隔离**（切房后不再声明旧房间的 file_id） |
| **card-revive** | 本目录 | **重发邀约让"已失效"卡片复活**（DOM 按钮回到 ✓/✗） |

> 加粗的两个是本目录新增的（验证"历史存储资源上限 + 房间隔离 + F15"那一轮）。
> 其余历史上放在 `/tmp`，未纳入版本控制 —— 建议后续一起搬进本目录。

## 两个必须知道的坑

1. **每个用例之前要清浏览器存储**（`clear-storage.py` 已封装）。
   用例用固定房名 + 固定身份 key，上轮的 IndexedDB 位图与 localStorage 邀约
   会污染下一轮，表现为"进不了房"或 `done=0`。单独跑就过、连跑就挂。
2. **本机端口要清代理**（`run.sh` 已处理），否则被沙箱代理拦成 502。
