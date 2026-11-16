# Changelog

## 0.3.2

- 伴生插件窗口改为紧凑模式：300×112，日志可展开到 300×330。
- 移除 UI 内标题/版本号，精简连接状态、文件名/页面名和提示文案。
- 重新连接改为图标按钮；端口和清空日志仅在日志展开后显示。
- 修复样式链接：异步 style setter 前加载所有页面，`figma_style apply` 默认真正链接 style id。
- 新增 `figma_component_set`、变体实例化、`figma_export format:'tokens'`。
- 导出器修复自动宽度文本折行。

## 0.3.1

- 组件集/变体创建、Variant 实例化。
- 样式链接修复。
- token 导出（tokens.json / tokens.css / tokens.js）。

## 0.3.0

- 设计系统：组件、样式、Variables 的读取/创建/绑定。
- `figma_library`、`figma_instantiate`、`figma_style`、`figma_variable`。

## 0.2.0

- HTML / JSX + CSS / SVG / JSON 导出。
- 截图附件修复，避免污染会话历史。

## 0.1.0

- 首次发布：桥、配对伴生插件、六个基础工具、设置卡片。
