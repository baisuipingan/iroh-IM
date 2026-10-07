# 图片预览比例适配修复（2026-10-04）

## 原因与修复

图片占位容器固定116px高，而预览图片最高220px；Grid的溢出没有参与父容器高度，
竖图越过了进度和完成状态栏。修复前同一浏览器断言在第一张竖图上失败。

有本地预览时启用`has-preview`，容器高度随图片自适应；图片保持原始宽高比，
限制在卡片可用宽度和220px高度以内，不裁切、不拉伸。清除放大按钮默认内边距，
发送和接收使用相同规则。未接收或预览释放时仍使用116px占位框。
仅修改前端CSS和渲染逻辑，没有改变文件协议、后端、常驻身份或历史。

## 验证

- `image-layout.mjs`：本地及线上各94项通过，覆盖Chrome/WebKit、发送/接收、
  横图/竖图/方图/极长图/极宽图、深浅主题、1440px和320px布局；验证比例、
  图片边界、预览区高度、底栏不重叠、占位恢复和放大功能。
- `fix-review.mjs`：本地及线上各52项通过；改用400×600竖图，实际P2P接收后
  分别验证发送端和接收端图片撑开容器，不遮挡底栏。OPFS替代系统保存对话框，
  文件网络传输、写盘及解码使用真实实现。
- 纯布局用例通过本地blob注入卡片，不冒充真实网络接收；WebKit不是Safari真机。
- JS语法、模块引用、自检及`git diff --check`通过。

证据：`output/playwright/image-layout/`、`output/playwright/image-layout-online/`、
`output/playwright/image-ratio-p2p-local/`、`output/playwright/image-ratio-p2p-online/`。

## 发布

- 站点：`https://im.editor.vip`；仅更新Cloudflare前端的两份资源。
- Worker版本：`2f496a3b-6a71-4429-9189-125da8749d72`。
- 全部24份线上静态资源SHA256与`dist/site`一致。
- CSS SHA256：`1c75402c69ff0880264e5f3a336fa2ccda0a4845823672d67d7d6ebed51d8023`。
- Timeline SHA256：`6cdecff5e4cb8bb374fc7e63a9ad94af06c833dcff8f8526c429faa28318861b`。
- 发布前版本：`c6e93985-be9a-4a44-bca4-6be2d1c847a9`，可按部署文档的网络配置
  使用`wrangler rollback`回滚；本轮未重启后端、未修改中继名单。
- 已打开的页面需刷新后加载修复。
