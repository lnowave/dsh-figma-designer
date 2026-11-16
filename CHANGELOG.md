# Changelog

## 0.8.0

- 新增 `figma_reference`：读取本地参考图，返回尺寸/预览，可选在 Figma 创建 Reference 图片框。
- 新增 `figma_asset`：把本地 PNG/JPEG/GIF 放进 Figma，或替换已有节点 image fill。
- 新增本地图片尺寸嗅探（PNG/JPEG/GIF）与对应测试。
- 文档：`docs/V0.8.0-REFERENCE-ASSETS.md`。

## 0.7.0

- 组件内部文字 overrides 提升为 React props（如 `label`）。
- 同一 variant 的不同 label 合并为一个组件，不再拆快照。
- VECTOR 节点异步导出 SVG，HTML/JSX 渲染为内联 SVG 图片。
- 隐藏子节点不再进入导出结果。
- 新增 `docs/V0.7.0-EXPORT-COMPLETE.md` 与测试。

## 0.6.1

- 同一组件集的 variant 映射为 React props，生成 `<Button size="Large" state="Default" />`。
- 每个 variant 仍保留快照函数，包装组件按 props 选择。
- 同一 variant 多个不同内容快照时自动回退，避免错配。
- 新增 `docs/V0.6.1-VARIANT-PROPS.md` 与测试。

## 0.6.0

- `figma_export` JSX 默认 component-aware：组件实例提取为 React 组件，生成 `components.jsx`。
- 相同组件视觉指纹复用；不同 override 拆成独立组件快照（尚未提升为 props）。
- 组件外层 `component-slot` 保留父级定位/尺寸。
- 新增 `docs/V0.6.0-COMPONENTS.md` 和 component-aware 测试。

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
