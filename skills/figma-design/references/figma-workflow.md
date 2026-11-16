# Figma 设计执行工作流

本文件是 `figma-design` 的操作层衔接。画布命令细节以 `figma-designer` skill 为准。

## 1. 读现状

```text
figma_status({ compact: true })
figma_library({ kind: 'all' })
figma_read({ target: 'selection' })   // 或 target:'page'
figma_screenshot({ nodeId })
```

先看当前文件、已有设计系统、选区真实画面。不要凭文件名或历史记忆判断。

## 2. 写方向与 DESIGN.md

按 `design-doc-template.md` 写任务目录里的 `DESIGN.md`。至少包含北极星、主角/主动作、调性、字体、色彩、间距、骨架、放弃项。后续每次修改先读它，避免 AI 漂移。

## 3. 灰度骨架

用 `figma_apply` 建灰阶 frame；只用黑白灰和结构，不先上品牌色/主视觉。可以：

- 只用 `#FFFFFF/#F5F5F5/#E5E5E5/#9CA3AF/#111827` 这类灰阶；
- 先做代表页，不做全套；
- `figma_screenshot` 后检查层级、主角、主动作和内容密度；
- 结构不行就改骨架，不用颜色/阴影救。

## 4. 设计系统

- 已有组件/变量/样式：`figma_library` 查 id，`figma_instantiate` 用组件，`figma_style` 应用样式，`figma_variable` 绑定 token；
- 没有：按 `tokens.md` 建最小集合；变量命名用领域/角色（`color/primary`、`space/16`），不要 `blue1`、`size2`；
- 组件集用 `figma_component_set`；实例 overrides 只改内容/尺寸/状态，不重画组件。

## 5. 视觉实现

- 先做代表页面/核心流程，再铺其他页面。
- 每次 `figma_apply` 小批次（约 20 节点/4KB 内）；长 JSON 分多次，避免 `MALFORMED_RESPONSE`。
- 改动前 `dryRun:true` 看计划；改完 `figma_screenshot` 看真实画面。
- 不用 `figma_apply` 重画已有组件；先查 `figma_library`。

## 6. 证据

- 目标视口 100% 截图；
- 关键区域 200% 截图（可 `scale:2` + 节点 id）；
- 480px 三秒测试：导出截图后缩放看，或在 Figma 里缩到 480px 宽看；
- 长页面按需看整页/滚动状态；有交互时看操作后状态；
- 只有真实图片才算证据；空图/加载中/透明首屏不算。

## 7. 导出复核

`figma_export` 可以导出 HTML/JSX/SVG/JSON/tokens；HTML/JSX 默认 token-aware（Variables/Paint Styles/Text Styles → CSS 变量与 `.text-*` 类）。导出后：

- HTML 用浏览器/`oil_ui_shoot` 在目标视口截图，和 Figma 截图并排看；
- 不把“导出成功”当成视觉通过；
- 组件实例仍会展开为图层；token-aware 已覆盖颜色/文本样式/间距/圆角。

## 8. 评审

把截图路径、任务、约束和 `reviewer.md` 路径交给独立评审子 Agent。不要给源代码、制作过程或自己的辩护。按结果修改；第一条“重做”就回方向，不修补骨架。

## 9. 交付

- `DESIGN.md`；
- Figma 页面/画板（命名清楚，灰阶稿可隐藏或归档）；
- 证据截图；
- 评审记录与处理结果；
- 未验证项（动效/其他视口/图片素材）明确写出。
