# 历史归档（2026-10-02 ~ 10-06）

这里放的是**一次性的过程产物**：日期化的审查报告、修复记录、交接文档。
它们的结论都已经汇总进上一层的当前状态文档，**平时不需要翻**。

只有两种情况值得来看：

1. 你想知道"当时为什么这么改" —— 每份审查报告都写清了发现的问题与处理
2. 你要追溯某个测试/某次改动的由来

## 清单

| 文档 | 当时发生了什么 |
|---|---|
| `frontend-review-2026-10-02.md` | 第一轮前端 review（改造前） |
| `project-review-2026-10-03.md` | 项目审查（SQLite 改造前后） |
| `project-review-2026-10-03-postfix.md` | 上面那份的修复后复检 |
| `browser-functional-review-2026-10-04.md` | 浏览器全功能实测与交互评估 |
| `review-fixes-2026-10-04.md` | 上一份的修复记录 |
| `image-preview-layout-fix-2026-10-04.md` | 图片预览比例适配修复 |
| `roomd-storage-fixes-2026-10-05.md` | roomd SQLite 修复与上线验证 |
| `project-review-2026-10-06.md` | 界面改造与服务器迁移的独立 review（其中的问题已在 10-07 处理完） |
| `handoff-2026-10-05.md` | 传输吞吐卡死时的交接说明（**已过时**，问题已解决） |
| `handoff-independent-review-2026-10-05.md` | 上面那份的独立复核 |
| `brief-for-original-dev.md` | 给原开发者的改动说明（**已过时**） |
| `prompt-transfer-throughput.md` | 吞吐排查用的可复制提示词（**已过时**，问题已解决） |

标「已过时」的三份对应的问题（批量传输吞吐被 TCP CUBIC 卡住）已在
[`../relay-tcp-bbr.md`](../relay-tcp-bbr.md) 里解决并记录。