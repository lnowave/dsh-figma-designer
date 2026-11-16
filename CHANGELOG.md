# Changelog

## 0.5.0

- `figma_export` 的 HTML/JSX 默认 token-aware：Variables / Paint Styles / Text Styles → CSS 变量和 `.text-*` 类。
- tree 序列化增加 style ids 与 boundVariables，优先精确映射，再做颜色/间距值回退。
- `tokenAware:false` 可关闭；无设计系统时自动回退并返回 warning。
- 新增 `docs/V0.5.0-TOKEN-AWARE.md` 与 token-aware 测试。

## 0.4.2

- 新增 `figma_compare`：2–6 个候选截图并生成自包含对比页（HTML + manifest）。
- 对比页支持概念、色板、特征、“选这个”和“实际尺寸”。
- 新增 `figma-design/references/compare.md` 与 `docs/V0.4.2-COMPARE.md`。

## 0.4.1

- 新增 `figma_audit`：只读质量审计，返回 0–100 分和 nodeId 问题清单。
- 检查文字对比度、字号/行高、占位文案、控件点击区、间距网格、颜色数量、token 匹配率、裁剪、组件使用。
- 新增 `figma-design/references/audit.md`、`docs/V0.4.1-AUDIT.md` 和审计测试。

## 0.4.0

- 新增 `figma-design` skill：方向卡、灰度、视觉语言、真实截图、独立评审 1–10 分。
- 新增 `reviewer.md`、`design-direction.md`、`visual-language.md`、`tokens.md`、`figma-workflow.md` 等参考。

## 0.3.2

- 伴生插件紧凑 UI：300×112，日志可展开。
- 修复样式链接与自动宽度文本导出。

## 0.3.1

- 组件集/变体、样式链接、tokens 导出。

## 0.3.0

- 设计系统：组件、样式、Variables 读取/创建/绑定。

## 0.2.0

- HTML/JSX/SVG/JSON 导出。

## 0.1.0

- 首次发布：桥、伴生插件、基础工具、设置卡片。
