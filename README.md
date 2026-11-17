# DSH Figma Designer

用自然语言在 **Figma** 里读取、创建、修改设计——作为 DeepSeek Harness 的原生插件运行。

- **类型化操作，不执行脚本**：模型产出 `create/update/move/clone/group/delete/select` 等声明式 ops，Host 先校验再下发。
- **dryRun 预演**：先看"将创建/修改/删除什么"，再决定执行。
- **截图回路**：`figma_designer_screenshot` 把选区渲成 PNG 直接回给模型，改完能自检。
- **前端代码导出（v0.2）**：`figma_designer_export` 把选区/页面导出成自包含 HTML、React（App.jsx + styles.css）、原生 SVG 或节点 JSON，自动处理 Auto Layout → flexbox、文字/颜色/圆角/阴影。
- **设计系统（v0.3）**：`figma_designer_library` 读组件/样式/Variables；`figma_designer_instantiate` 复用组件实例；`figma_designer_style` 应用/创建样式；`figma_designer_variable` 建 token 并绑定填充、间距等。
- **本地免费**：Figma 开发插件 + 本机 loopback 桥，不走官方 MCP、不消耗额度。
- **写入安全**：配对 token、仅本机监听、破坏性写入有 `uncertain-write` 屏障（超时/断线后必须先读再写）。
- **设计质量（v0.4）**：`figma-design` skill 强制先定方向、灰度优先、真实截图验收和 1–10 分独立评审，避免“能画但做得平庸”。
- **方向对比（v0.4.2）**：`figma_designer_compare` 把 2–6 个候选截图并排成自包含 HTML，带概念、色板、特征和“选这个”。
- **component-aware 导出（v0.6）**：`figma_designer_export` 的 JSX 默认把 Figma 组件实例提取为 React 组件（`components.jsx`），相同视觉指纹复用，实例外层保留布局。
- **variant props（v0.6.1）**：同一组件集的多个 variant 收敛成一个 React 组件，`<Button size="Large" state="Default" />`。
- **导出完整性（v0.7）**：组件文字 overrides → props；VECTOR 图标导出为内联 SVG；隐藏节点不导出；同 variant 不同 label 自动合并。
- **token-aware 导出（v0.5）**：`figma_designer_export` 的 HTML/JSX 默认使用 Figma Variables / Paint Styles / Text Styles，输出 `var(--color-primary)`、`.text-heading-xl` 和 `var(--space-16)`。
- **质量审计（v0.4.1）**：`figma_designer_audit` 只读检查对比度、字号/行高、占位文案、点击区、间距网格、颜色数量、token 匹配率、裁剪等，返回 0–100 分和可定位到 nodeId 的问题清单。

> 当前版本 **v0.9.1**：十八个工具 + 配对伴生插件 + 设置卡片 + HTML/JSX/SVG/JSON/tokens 导出 + 组件/样式/Variables 设计系统 + **figma-design 设计质量工作流**（方向卡、灰度、真实截图、独立评审 + `figma_designer_audit` 客观审计 + `figma_designer_compare` 多方向对比）。

## 安装

```bash
cd dsh-figma-designer
node build-client.mjs
```

然后在 DeepSeek Harness 里安装 bundle（绝对路径）：

```
/Users/liweibo/Documents/DSH_plugin/dsh-figma-designer
```

安装后刷新页面 → 设置 → 插件 → **Figma 设计助手** 卡片会显示连接状态与伴生插件 manifest 路径。

## 一次性配置（Figma 桌面版）

1. 点卡片上的 **重新生成配对**（或让 DSH 调用 `figma_designer_setup`），复制 manifest 路径。
2. Figma 桌面版：**Plugins → Development → Import plugin from manifest…**，选择该路径。
3. 打开目标文件，运行 **Plugins → Development → DSH Figma Designer**，保持窗口打开。
4. 回到 DSH 调用 `figma_designer_status`，看到「已连接」即可。

> 升级插件后重新生成配对会原地更新目录，只需关闭并重跑 Figma 插件，**不用重新导入**。

## 工具

| 工具 | 作用 |
|---|---|
| `figma_designer_status` | 连接状态、文件列表、绑定目标、是否有未确认写入；未连接时给 setup 指引 |
| `figma_designer_setup` | 生成/刷新伴生插件，返回 manifest 路径与三步说明 |
| `figma_designer_select` | 多文件时选择目标文件（单文件自动绑定） |
| `figma_designer_read` | 读选区/页面/节点树（depth、maxNodes、隐藏节点控制） |
| `figma_designer_screenshot` | 选区/节点导出 PNG 并回图 |
| `figma_designer_apply` | 类型化 ops 批量写入（dryRun / atomic / operationId） |
| `figma_designer_library` | 读组件/组件集、Paint/Text/Effect 样式、Variables |
| `figma_designer_instantiate` | 创建组件 Instance，支持 variant 与文字/填充等 overrides |
| `figma_designer_component_set` | 克隆基础组件创建 Component Set / 变体 |
| `figma_designer_style` | 应用/创建 Paint/Text/Effect 样式 |
| `figma_designer_variable` | list/create/set/bind Variables（设计 token） |
| `figma_designer_export` | 导出 html / jsx / svg / json / tokens；html/jsx 默认 token-aware，jsx 默认 component-aware |
| `figma_designer_compare` | 2–6 个候选截图并排成对比页，带概念/色板/特征 |
| `figma_designer_reference` | 读取本地参考图，返回真实尺寸/预览，可选放 Reference 图片框 |
| `figma_designer_asset` | 把本地 PNG/JPEG/GIF 放进 Figma，或替换节点 image fill |
| `figma_designer_media` | 搜索开放图库、返回许可和联系表，按 ref 下载原图 |
| `figma_designer_image` | 把本地图片放进 Figma（新建图片框或替换 image fill） |
| `figma_designer_audit` | 只读质量审计：对比度/字号/行高/占位文案/点击区/间距/token/裁剪，返回 0–100 分和问题清单 |

## 导出前端代码

```js
// 导出当前选中的节点
figma_designer_export({ format: 'html' })
figma_designer_export({ format: 'jsx' })
figma_designer_export({ format: 'svg' })
figma_designer_export({ format: 'json' })

// 导出整页 / 指定节点 / 指定目录
figma_designer_export({ format: 'html', target: 'page', outDir: 'figma-export/pricing' })
figma_designer_export({ format: 'jsx', target: 'node', nodeIds: ['5:2'] })
figma_designer_export({ format: 'html', tokenAware: false }) // 关闭 token 化
figma_designer_export({ format: 'jsx', componentAware: false }) // 关闭组件提取
```

默认写到 `<工作目录>/figma-export/<节点名>-<时间戳>/`。

| 格式 | 产物 | 说明 |
|---|---|---|
| `html` | `index.html` | 自包含单页，直接双击预览 |
| `jsx` | `App.jsx` + `styles.css` | React 组件，class 与 CSS 对应 |
| `svg` | `<节点名>-<id>.svg` | Figma 原生矢量导出 |
| `json` | `design.json` | 完整节点树（样式/布局/文字），可二次加工 |
| `tokens` | `tokens.json` / `tokens.css` / `tokens.js` | Variables + 样式 → 设计 token / CSS variables / 文本样式 class |

导出会保留 Auto Layout（flex）、绝对定位、填充/描边/圆角/阴影/字体。渐变和图片填充在 v0.2 保留 JSON 描述并给出 warnings；VECTOR 图标建议用 `svg` 格式导出。

## ops 速查

```js
{op:'create', type:'frame'|'component'|'rect'|'ellipse'|'text'|'line'|'polygon'|'star'|'svg',
 parentId?, name?, x?, y?, width?, height?, fill?, stroke?, strokeWidth?, radius?,
 opacity?, visible?, locked?, rotation?, layout?, text?, svg?, effects?, children?:[同结构]}
{op:'update', nodeId, patch:{...}}
{op:'move', nodeId, parentId, index?}
{op:'reorder', nodeId, index}
{op:'clone', nodeId, parentId?, x?, y?, deep?}
{op:'group', nodeIds, name?}
{op:'delete', nodeId}
{op:'select', nodeIds}
```

- 坐标：`parentId` 是 Frame → 相对父级；是页面 → 绝对坐标。
- 颜色：`#RRGGBB` / `#RRGGBBAA`；`fill:null` 清空。
- `layout`：`{mode:'HORIZONTAL'|'VERTICAL', itemSpacing, padding, primaryAxisAlign, counterAxisAlign}`。
- `text`：`{characters, font:{family,style}, fontSize, align, lineHeight, letterSpacing, textAutoResize}`。
- 一次 `apply` 只做用户要求的改动；改完 `figma_designer_screenshot` 自检。

## 架构

```
DSH Host（本插件）
  lib/bridge.js   127.0.0.1:3977 长轮询桥（token / Host / Origin / JSON content-type）
  lib/tools.js    18 个工具：status/setup/select/read/screenshot/apply/audit/compare/reference/asset/media/image/library/instantiate/component_set/style/variable/export
  lib/export.js   HTML / JSX + CSS / JSON 代码生成器
  lib/ops.js      ops 校验器（Host 先校验，再下发）
  lib/setup.js    生成 <DSH_HOME>/figma-designer/companion/（配对插件）
  lib/api.js      设置卡片的同源接口
  skills/         模型按需加载的 Figma 工作流技能
  client-src/     Plugins 页卡片
Figma Desktop
  companion/code.js  命令实现（read/tree/apply/screenshot/export/select，纯 Plugin API）
  companion/ui.html  长轮询客户端 + 状态面板
```

## 安全与边界

- 桥只监听 `127.0.0.1`，校验 Host/Host 头、Origin（Figma 插件 iframe 为 `null`）、`application/json`（强制 CORS 预检）和配对 token；token 只写在伴生插件 `ui.html` 与 `~/.dsh/figma-designer/pair.json`（0600）。
- 不执行任意脚本；所有写入走 ops 校验。
- 写入无事务：`atomic:true` 是尽力回滚；超时/断线后返回 `uncertain-write`，必须先 `figma_designer_read` 核查。
- 只支持 **Figma 桌面版**（开发插件需要桌面版导入）。

## 已知限制（v0.3）

- 跨页、复杂组件属性/text/instance-swap、变量别名与多 mode 的高级操作仍有限。
- HTML/JSX 导出暂不支持渐变、图片填充和 VECTOR 图标（VECTOR 用 SVG 格式导出）；动效未实现。
- 导出的 HTML/JSX 是静态还原，尚未把组件/token 抽象保留到代码（后续版本）。
- 异步样式链接需要先加载所有页面（已在 companion 内处理）；`link:false` 可只按值写入。应用前先 `figma_designer_read` 确认。
- 不接官方 Figma MCP（保留为 v0.4 可选只读后端）。
- 伴生插件需手动导入一次；窗口关闭即断线。

## 开发

```bash
node --check index.js lib/*.js companion/*.js
node build-client.mjs
node --test tests/*.test.mjs
node --test spike/phase0/test/    # Phase 0 的协议与 mock 测试（历史参考）
```

目录：`docs/V0.1-SPEC.md`（ops/协议契约）、`docs/V0.2-EXPORT.md`、`docs/V0.3-DESIGN-SYSTEM.md`、`docs/V0.3.2-COMPANION-UI.md`、`docs/V0.4.0-DESIGN-QUALITY.md`、`docs/V0.4.1-AUDIT.md`、`docs/V0.4.2-COMPARE.md`、`docs/V0.5.0-TOKEN-AWARE.md`、`docs/V0.6.0-COMPONENTS.md`、`docs/V0.6.1-VARIANT-PROPS.md`、`docs/V0.7.0-EXPORT-COMPLETE.md`、`docs/V0.8.0-REFERENCE-ASSETS.md`、`docs/V0.9.0-MEDIA.md`。
