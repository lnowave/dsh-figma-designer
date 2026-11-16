# DSH Figma Designer

用自然语言在 **Figma** 里读取、创建、修改设计，并导出前端代码。作为 [DeepSeek Harness](https://github.com/deepseek-ai) 的原生插件运行。

> 当前版本 **v0.6.0**，测试环境：DSH `0.2.2-rc.1` + Figma Desktop。

## 功能

- **类型化操作**：模型产出 `create/update/move/clone/group/delete/select` 等声明式 ops，Host 先校验再下发，不执行任意脚本。
- **dryRun 预演**：先看将创建/修改/删除什么，再执行。
- **截图回路**：`figma_screenshot` 把选区渲成 PNG 回给模型，改完自检。
- **设计系统**：读取组件/组件集、Paint/Text/Effect 样式、Variables；实例化组件、应用样式、创建/绑定 token。
- **前端代码导出**：HTML、React JSX + CSS、原生 SVG、节点 JSON、设计 tokens，自动处理 Auto Layout → flexbox。
- **本地免费**：Figma 开发插件 + 本机 loopback 桥，不走官方 MCP、不消耗额度。
- **写入安全**：配对 token、仅本机监听、`uncertain-write` 屏障。
- **设计质量（v0.4）**：新增 `figma-design` skill，强制方向卡 → 灰度 → 视觉 → 真实截图 → 独立评审（1–10 分），避免“能画但做得平庸”。
- **component-aware 导出（v0.6）**：`figma_export` 的 JSX 默认把 Figma 组件实例提取为 React 组件（`components.jsx`），相同视觉指纹复用，外层 `component-slot` 保留定位。
- **token-aware 导出（v0.5）**：`figma_export` 的 HTML/JSX 默认使用 Figma Variables / Paint Styles / Text Styles，输出 `var(--color-primary)`、`var(--space-16)` 和 `.text-*` 类。
- **方向对比（v0.4.2）**：`figma_compare` 把 2–6 个候选截图并排成自包含 HTML，带概念、色板、特征和“选这个”。
- **质量审计（v0.4.1）**：`figma_audit` 只读检查对比度、字号/行高、占位文案、点击区、间距网格、颜色数量、token 匹配率、裁剪等，返回 0–100 分和 nodeId 问题清单。

## 环境要求

- DeepSeek Harness 桌面版（本版本在 `0.2.2-rc.1` 验证；其他版本可能需调整）
- Figma **桌面版**（开发插件只能在桌面版导入）
- macOS 已验证；Windows 尚未完整验证（尤其 `localhost` / IPv6 和端口占用）
- Node.js 仅开发/构建需要，普通使用由 DSH 自带运行时提供

## 安装（从 GitHub）

1. 在 DSH 打开 **设置 → 插件 → 添加插件**。
2. 填入 Git 地址，例如：

   ```text
   github:lnowave/dsh-figma-designer
   ```

   或固定版本：

   ```text
   github:lnowave/dsh-figma-designer#v0.6.0
   ```

   私有仓库需要那台电脑的 Git 凭据。
3. 安装完成后点 **启用**，刷新 DSH 页面。
4. 打开 **设置 → 插件**，应看到「Figma 设计助手」卡片。

> Git 安装的 bundle 不会自动更新；升级时先在插件管理器卸载，再安装新版本。

## 一次性配置 Figma 伴生插件

**每台电脑只需导入一次**，因为配对 token 是本机生成的，不能从其他电脑复制。

1. 在 DSH 的「Figma 设计助手」卡片点 **重新生成配对**（或让 Agent 调用 `figma_setup`）。
2. 复制卡片显示的 manifest 路径：

   ```text
   ~/.dsh/figma-designer/companion/manifest.json
   ```

3. 打开 Figma 桌面版 → **Plugins → Development → Import plugin from manifest…**，选择该文件。
4. 在目标 Figma 文件运行 **Plugins → Development → DSH Figma Designer**，保持窗口打开。
5. 回到 DSH 调用 `figma_status`，看到「已连接」即可。

升级 DSH 插件后重新生成配对会原地更新伴生插件目录，只需关闭并重跑 Figma 插件，**不用重新导入**。

## 设计质量（v0.4）

插件现在包含两个 skill：

- `figma-designer`：操作层，读取/创建/修改/导出 Figma；
- `figma-design`：判断层，负责设计方向、视觉语言、设计系统、真实截图验收和独立评审。

新建页面、整体改版、探索方向或评审视觉质量时，Agent 会按 `figma-design` 的流程：

1. 写产品事实与方向卡（`DESIGN.md`）：北极星、主角/主动作、调性、字体、色彩、间距、记忆点；
2. 先做灰度结构，再做视觉；
3. 复用现有组件/变量/样式，不在每个节点硬编码；
4. 用 `figma_screenshot` 在目标视口、480px 缩略图和 200% 局部检查；
5. 派独立子 Agent 按评审手册打 1–10 分，按问题清单修正。

参考：`skills/figma-design/references/`（方向、视觉语言、tokens、Figma 工作流、评审手册）。

## 质量审计（v0.4.1）

```text
figma_audit({ target: 'selection' })
figma_audit({ target: 'page', maxNodes: 800 })
figma_audit({ target: 'node', nodeIds: ['11:606'] })
```

只读检查：文字对比度、字号/行高、占位文案、控件点击区、间距网格、颜色数量、token 匹配率、裁剪、组件使用。返回 `score`（0–100）、`grade` 和带 `nodeId`/修复建议的 `issues`；不修改画布。审计是独立评审前的客观检查，不替代 1–10 分视觉评审。

## 工具

| 工具 | 作用 |
|---|---|
| `figma_status` | 连接状态、文件列表、绑定目标、未确认写入 |
| `figma_setup` | 生成/刷新伴生插件，返回 manifest 路径 |
| `figma_select` | 多文件时选择目标文件（单文件自动绑定） |
| `figma_read` | 读选区/页面/节点树（depth、maxNodes、隐藏节点） |
| `figma_screenshot` | 选区/节点导出 PNG 并回图 |
| `figma_apply` | 类型化 ops 批量写入（dryRun / atomic / operationId） |
| `figma_library` | 读组件/组件集、Paint/Text/Effect 样式、Variables |
| `figma_instantiate` | 创建组件 Instance，支持 variant 与 overrides |
| `figma_component_set` | 克隆基础组件创建 Component Set / 变体 |
| `figma_style` | 应用/创建 Paint/Text/Effect 样式 |
| `figma_variable` | list/create/set/bind Variables |
| `figma_export` | 导出 html / jsx / svg / json / tokens；html/jsx 默认 token-aware，jsx 默认 component-aware |
| `figma_compare` | 2–6 个候选截图并排成对比页，带概念/色板/特征 |
| `figma_audit` | 只读质量审计：对比度/字号/行高/占位/点击区/间距/token/裁剪，返回分数和 nodeId 问题清单 |

## 导出

```js
figma_export({ format: 'html' })
figma_export({ format: 'jsx' })
figma_export({ format: 'svg' })
figma_export({ format: 'json' })
figma_export({ format: 'tokens' })

figma_export({ format: 'html', target: 'page', outDir: 'figma-export/pricing' })
figma_export({ format: 'jsx', target: 'node', nodeIds: ['5:2'] })
figma_export({ format: 'html', tokenAware: false }) // 关闭 token 化
figma_export({ format: 'jsx', componentAware: false }) // 关闭组件提取
```

默认写到 `<工作目录>/figma-export/<节点名>-<时间戳>/`。

| 格式 | 产物 |
|---|---|
| `html` | 自包含 `index.html` |
| `jsx` | `App.jsx` + `styles.css` |
| `svg` | Figma 原生矢量 `.svg` |
| `json` | 完整节点树 `design.json` |
| `tokens` | `tokens.json` + `tokens.css` + `tokens.js` |

## 架构

```
DSH Host（本插件）
  lib/bridge.js   127.0.0.1:3977 长轮询桥（token / Host / Origin / JSON content-type）
  lib/tools.js    12 个工具
  lib/export.js   HTML / JSX + CSS / JSON / tokens 生成器
  lib/ops.js      ops 校验器
  lib/setup.js    生成 <DSH_HOME>/figma-designer/companion/
  lib/api.js      设置卡片同源接口
  skills/         模型按需加载的 Figma 工作流技能
  client-src/     Plugins 页卡片
Figma Desktop
  companion/code.js  命令实现（read/tree/apply/screenshot/export/...，纯 Plugin API）
  companion/ui.html  长轮询客户端 + 紧凑状态窗口
```

## 安全与边界

- 桥只监听 `127.0.0.1`，校验 Host/Origin/`application/json` 和配对 token；token 只写在伴生插件 `ui.html` 与 `~/.dsh/figma-designer/pair.json`（0600）。
- 不执行任意脚本；所有写入走 ops 校验。
- 写入无事务：`atomic:true` 是尽力回滚；超时/断线后返回 `uncertain-write`，必须先 `figma_read` 核查。
- 只支持 **Figma 桌面版**。
- 仓库源码不包含配对 token；生成的 `~/.dsh/figma-designer/` 不要提交或分享。

## 已知限制

- 跨页、复杂组件属性/text/instance-swap、变量别名与多 mode 的高级操作仍有限。
- HTML/JSX 导出暂不支持渐变、图片填充和 VECTOR 图标（VECTOR 用 `svg` 格式）。
- 导出的 HTML/JSX 是静态还原，尚未把组件/token 抽象保留到代码。
- Windows 尚未完整验证。

## 开发

```bash
node --check index.js lib/*.js companion/*.js
node build-client.mjs
node --test tests/*.test.mjs
```

目录：`docs/V0.1-SPEC.md`（ops/协议契约）、`docs/V0.2-EXPORT.md`、`docs/V0.3-DESIGN-SYSTEM.md`、`docs/V0.3.2-COMPANION-UI.md`、`docs/V0.4.0-DESIGN-QUALITY.md`、`docs/V0.4.1-AUDIT.md`、`docs/V0.4.2-COMPARE.md`、`docs/V0.5.0-TOKEN-AWARE.md`、`docs/V0.6.0-COMPONENTS.md`。

发布/升级时在 GitHub 打 tag（如 `v0.6.0`），安装时可用 `github:lnowave/dsh-figma-designer#v0.6.0`。

## License

MIT
