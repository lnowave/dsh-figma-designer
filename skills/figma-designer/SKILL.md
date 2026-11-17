---
description: 用自然语言读取、创建、修改、导出 Figma 设计（选区优先）：figma_designer_status 查连接，figma_designer_read 读结构，figma_designer_apply 用类型化 ops 批量写入，figma_designer_screenshot 自检，figma_designer_export 导出 HTML/JSX/SVG/JSON/tokens。
---

# Figma 设计助手（figma-designer）

用户想**看/改 Figma 里的设计**时使用：读取选区或页面结构、按描述新建界面、改颜色/文字/布局/尺寸、批量调整、导出代码。

不是“按明确指令改图层”，而是新建设计、整体改版、要做得好/好看、探索方向时，改用 `figma-design` skill。

## 固定回路（尽量少的往返）

1. **查连接**：`figma_designer_status`（默认就是紧凑版）。
   - 未连接 → `figma_designer_setup` 拿 manifest 路径，让用户在 Figma 桌面版 `Plugins → Development → Import plugin from manifest…` 导入并运行，保持窗口打开。
   - 多个文件 → `figma_designer_select`。
2. **读**：`figma_designer_read`（默认读选区；整页设计用 `target:'page'`）。
   - 已知要放在哪个 frame 里、只是新建内容，可以跳过读；只在需要改已有节点、或必须知道父级尺寸时读。
   - 骨架用 `depth:1`，细节用 `nodeIds` 局部读。改完只读受影响的节点，不要重复读整页。
3. **写**：`figma_designer_apply` 一次提交一个完整区块或整页。
   - 新建整页：**一个** `frame` op + 嵌套 `children` 一次成型，不要拆成「骨架→卡片→收尾」多次 apply。
   - 预算：单次 ≤80 个节点 / ≤20KB JSON。超过再按区块拆成 2 次。
   - `dryRun` 只在批量删除/移动/重构前用；普通新建和修改直接执行。
   - 需要幂等或大改动时带 `operationId`；破坏性批量可加 `atomic:true`。
4. **自检**：`figma_designer_screenshot` 截改动后的节点。
   - 大画板用 `scale:0.5–0.75` 就够看布局；只有怀疑字体、对齐、裁切时才用 1–2 或局部节点。
   - 看得出的问题直接改；一次修完再截一次，不要每改一个属性截一张。
5. **设计系统**：复用文件里的组件/样式/变量时先 `figma_designer_library` 查 id，用 `figma_designer_instantiate` 放实例（不要重画），`figma_designer_style` 应用样式，`figma_designer_variable` 建 token / 绑定填充与间距。
6. **组件集**：需要变体时用 `figma_designer_component_set`，之后用 `variant:{Size:'Large'}` 实例化。
7. **导出**：`figma_designer_export {format:'html'|'jsx'|'svg'|'json'|'tokens'}`；返回绝对路径，直接告诉用户。HTML/JSX 默认 token-aware，JSX 默认 component-aware；VECTOR 图标用 `svg` 格式。

## 坐标与层级

- `create` 的 `parentId` 为空 → 挂到当前页面，`x/y` 是页面绝对坐标。
- `parentId` 是 Frame 时，子节点 `x/y` 相对该 Frame。
- 图层顺序 = `children` 追加顺序（后加的在上面），用 `reorder` 调整。
- `group` 要求节点同父级。

## 常用 ops

```js
// 新建整页：一个 frame + 内部子层，一次 apply 完成
{op:'create', type:'frame', name:'Pricing', x:0, y:0, width:1200, height:800, fill:'#0B1220',
 layout:{mode:'VERTICAL', itemSpacing:32, padding:{top:64,right:64,bottom:64,left:64}},
 children:[
   {type:'text', name:'Title', width:1072, height:60, fill:'#F8FAFC', text:{characters:'Simple pricing', fontSize:48, font:{family:'Inter',style:'Bold'}}},
   {type:'rect', name:'Card', width:320, height:420, fill:'#111827', radius:16, stroke:'#1F2937', strokeWidth:1}
 ]}
// 改节点 / 改文字 / 批量改属性
{op:'update', nodeId:'1:2', patch:{fill:'#111827', radius:16, layout:{mode:'VERTICAL', itemSpacing:16, padding:24}}}
{op:'update', nodeId:'1:3', patch:{text:{characters:'Start free', fontSize:20, font:{family:'Inter',style:'Semi Bold'}}}}
```

- 颜色 `#RRGGBB` / `#RRGGBBAA`，`fill:null` 清空；圆角是数字或 `[左上,右上,右下,左下]`。
- 文本必须给 `text.characters`；默认 `Inter / Regular`，缺字体时 Figma 会返回候选，换一个可用的。
- Auto Layout：`layout:{mode:'HORIZONTAL'|'VERTICAL', itemSpacing, padding, primaryAxisAlign, counterAxisAlign}`；`layout:null` 取消。

## 错误处理

| 返回 | 处理 |
|---|---|
| `not-connected` | `figma_designer_setup` 拿 manifest，让用户导入并运行伴生插件 |
| `invalid-op`（含 `errors`） | 按 `opIndex` 改那一条再提交，不要原样重试 |
| `uncertain-write` | 上次写入超时：先 `figma_designer_read` 核查受影响节点 |
| `unsupported` | 换参数或换字体 |
| `too-large`（截图） | 降低 `scale` 或选更小节点 |
| `invalid-format` / `invalid-target` | 按枚举修正；`target:'node'` 必须带 `nodeIds` |

## 质量底线

- 真实文案与合理层级，不要 lorem ipsum；整页用一个带 Auto Layout 的 frame 组织，而不是几十个散层。
- 只做用户要求的改动，不为“重排”删用户已有图层。
- 与参考差距大时，先修尺寸/间距/颜色，再谈细节。
