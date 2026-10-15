# 2026-10-15 气泡 Markdown 渲染 + 「原文」开关

## 一句话

像 Markdown 的消息（agent 输出为主）按排版渲染——标题 / 列表 / 围栏代码块 /
行内代码 / 粗斜体 / 引用 / 分隔线 / 链接；气泡**右上角**多一个「原文」小药丸，
一点就切回**逐字原文**（方便原样复制），再点回排版。普通聊天不受影响。

```
## 环境信息                       ┌──────┐
- 工作目录：/Users/…          hover→│ 原文 │   ← 气泡右上角（meta 行右端）
- 平台：macOS (darwin)             └──────┘
```

## 设计决策（都写进了代码注释）

| 点 | 选择 | 为什么 |
|---|---|---|
| 渲染器 | **自己写极简版**（`js/ui/markdown.js`，零依赖、全 DOM 构建） | 消息是**他人可控的签名内容**：引解析库就要重新审供应链与 XSS；聊天只需一个小子集 |
| 何时渲染 | `looksLikeMarkdown()` **命中才渲染** | 普通聊天（"2*3=6"、句子里的 "- "）保持原样；只有像 Markdown 的才换排版 |
| 与 @ 混排 | 带 `@<id8>` 的消息仍走 chip 路径 | 两者在 agent 输出里基本不同时出现；避免把 chip 逻辑搅进解析器（留待以后要做再加） |
| 开关位置 | 挂在 `.msg__meta` **右端**（视觉上=气泡右上角），**不放进气泡内部** | ① 不遮正文/时间；② 不污染 `.bubble` 的 `textContent`（`__state().messages` 等 e2e 直接读它做断言） |
| 开关状态 | 按消息 id 记在会话内 `Set`（`timeline._rawMd`） | 时间线重渲染 / 翻历史回来仍是原文视图 |
| 链接安全 | 只放行 `http(s)://`；裸链自动成链并去尾部标点；`target=_blank rel=noopener noreferrer nofollow` | `javascript:`、`<img onerror>`、原始 HTML 一律只能成为**文本** |
| 深/浅两主题 | 代码块等用 token 变量；金色气泡（自己发的）单独调成半透明白底 | 两套主题对比度不被吃掉 |

「原文」原文态 = 老的纯文本渲染（`pre-wrap`），所以**逐字一致**（e2e 用 `textContent === 原串` 钉死）。

## 验证

| 项 | 结果 |
|---|---|
| 新 e2e `markdown`（已注册进 run.sh） | **17/17**：结构（标题/两个 li/围栏码含语言标记/链接与裸链）；「原文」开关切回后与原文逐字一致、再点回排版；`<img onerror>` 不产生元素且 `onerror` 未执行、`javascript:` 不产生 `<a>`；普通消息不渲染、无开关；带 @ 的消息 chip 正常且不渲染 |
| 回归面 | `multi-peer` 19/19、`redesign` 128/128（气泡/视觉断言未回归） |
| `verify.sh all` | **退出码 0**；30 处套件/子套件全 `FAIL=0`（含新 markdown 17/17） |

## 发版

- 前端：CF 已发（Version `9d33ef40-b8ca-4556-8e4b-1c14437fa2b6`）——
  `js/ui/markdown.js` / `js/ui/timeline.js` / `css/components.css` 线上哈希与本地逐一相等；
  无协议/后端改动。
- 回滚：`git revert` + 重发（纯前端）。

## 附：效果截图

`output/md-preview-toggle.png`（本地调试截图，随 output/ 忽略，不入库）。
