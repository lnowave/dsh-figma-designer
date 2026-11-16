---
description: 用自然语言读取、创建、修改、导出 Figma 设计（选区优先）：figma_status 查连接，figma_read 读结构，figma_apply 用类型化 ops 批量写入，figma_screenshot 自检，figma_export 导出 HTML/JSX/SVG/JSON/tokens。
---

# Figma 设计助手（figma-designer）

当用户想**看/改 Figma 里的设计**时使用本技能：读取选区或页面结构、按描述新建界面、改颜色/文字/布局/尺寸、批量调整、导出截图确认。

## 固定回路

1. **查连接**：`figma_status`（`compact:true` 更省 token）。
   - 未连接 → `figma_setup` 拿 manifest 路径，让用户在 Figma 桌面版 `Plugins → Development → Import plugin from manifest…` 导入并运行 **DSH Figma Designer**，保持窗口打开。
   - 多个文件 → `figma_select` 选目标文件。
2. **读**：`figma_read`（默认读当前选区；`target:'page'` 读当前页）。
   - 先用默认 `depth:2`、`maxNodes:80`；需要细节时用 `nodeIds` 局部读，别一次拉整棵树。
   - 节点 id 形如 `1:2`，后续 update/delete 都用它。
3. **计划**：`figma_apply {dryRun:true}` 先看 `plan`（将创建/修改/删除多少），有 `warnings` 先处理。
4. **执行**：`figma_apply`（建议带 `operationId`；大改动可 `atomic:true`）。
   - **单次 ops 控制在约 20 个节点 / 4KB 以内**。整页生成拆成 2–4 次：页面骨架 → 卡片/区块 → 收尾。一次塞 30+ 节点、8KB JSON 时，模型容易把括号/`operationId` 写错，触发 `MALFORMED_RESPONSE: tool input is invalid JSON`。
5. **自检**：`figma_screenshot`（改完用同一 nodeId），看结果是否与用户要求一致；不一致继续 `figma_read` + `update`，不要重画整页。
6. **设计系统**：要复用项目里的组件/样式/变量时，先 `figma_library` 查 id；用 `figma_instantiate` 放组件实例（不要重画），`figma_style` 应用样式，`figma_variable` 建 token / 绑定填充、间距等。
   - `figma_style apply` 默认链接 style id（内部先 loadAllPagesAsync）；传 `link:false` 可只按值写入。
   - 样式应用前先 `figma_read` 确认目标节点，避免覆盖用户手动改过的 fill。
7. **组件集**：需要变体时用 `figma_component_set`（基于基础组件克隆 + combineAsVariants）；之后 `figma_instantiate` 用 `variant:{Size:'Large'}` 选变体。
8. **导出**：用户要前端代码时用 `figma_export {format:'html'|'jsx'|'svg'|'json', target?, nodeIds?, outDir?}`；返回文件绝对路径，直接告诉用户路径。HTML/JSX 处理 Auto Layout→flex；VECTOR 图标用 `svg` 格式；渐变/图片填充会进 warnings。

## 坐标与层级

- `create` 的 `parentId` 为空 → 挂到当前页面，`x/y` 是**页面绝对坐标**。
- `parentId` 是 Frame 时，子节点 `x/y` **相对该 Frame**。
- 图层顺序 = `children` 追加顺序（后加的在上面）；用 `reorder` 调整。
- `group` 要求这些节点有同一个父级。

## 常用 ops

```js
// 新建整页：一个 frame + 内部子层（一次 apply 完成）
{op:'create', type:'frame', name:'Pricing', x:0, y:0, width:1200, height:800, fill:'#0B1220',
 layout:{mode:'VERTICAL', itemSpacing:32, padding:{top:64,right:64,bottom:64,left:64}},
 children:[
   {type:'text', name:'Title', width:1072, height:60, fill:'#F8FAFC', text:{characters:'Simple pricing', fontSize:48, font:{family:'Inter',style:'Bold'}}},
   {type:'rect', name:'Card', width:320, height:420, fill:'#111827', radius:16, stroke:'#1F2937', strokeWidth:1}
 ]}
// 改选中节点
{op:'update', nodeId:'1:2', patch:{fill:'#111827', radius:16, layout:{mode:'VERTICAL', itemSpacing:16, padding:24}}}
// 改文字
{op:'update', nodeId:'1:3', patch:{text:{characters:'Start free', fontSize:20, font:{family:'Inter',style:'Semi Bold'}}}}
// 批量改颜色/尺寸
{op:'update', nodeId:'1:4', patch:{fill:'#2563EB'}}
```

- 颜色：`#RRGGBB` / `#RRGGBBAA`；`fill:null` 清空。
- 圆角：数字或 `[左上,右上,右下,左下]`。
- 文本必须给 `text.characters`；字体默认 `Inter / Regular`，缺字体时 Figma 会返回候选，换一个可用的。
- Auto Layout：`layout:{mode:'HORIZONTAL'|'VERTICAL', itemSpacing, padding, primaryAxisAlign, counterAxisAlign}`；`layout:null` 取消。

## 错误处理

| 返回 | 处理 |
|---|---|
| `not-connected` | 跑 `figma_setup`，按步骤让用户导入并运行伴生插件 |
| `invalid-op`（含 `errors`） | 按 `opIndex` 修对应 op 再提交，不要原样重试 |
| `uncertain-write` | 上次写入超时/断线：先 `figma_read` 核查受影响节点，确认后再继续 |
| `unsupported` | 功能/字体不支持，按提示换参数或换字体 |
| `too-large`（截图） | 降低 `scale` 或选更小节点 |
| `invalid-format` / `invalid-target`（导出） | 按 `format` / `target` 的枚举修正；`target:'node'` 必须带 `nodeIds` |
| `export-failed` / `write-failed` | 按错误信息修参数或换 `outDir`，不要原样重试 |

## 设计质量要求

- 用真实文案与合理层级，不要 lorem ipsum；标题/正文/按钮使用同一套字号梯度。
- 整页生成优先用**一个带 Auto Layout 的 frame + 嵌套子层**，而不是几十个散落图层。
- 每次只做用户要求的改动；不要为了"重排"删除用户已有图层。
- 改完必须截图确认；与参考差距大时先修尺寸/间距/颜色，再继续。
