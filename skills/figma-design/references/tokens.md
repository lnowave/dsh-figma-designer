# 设计 token 配方

先用 `figma_library` 看已有变量/样式；已有就沿用，不另造一套。没有时才建最小集合。

## 字号梯度

按内容角色，而不是按需要多少种字号：

| 角色 | 建议起点 |
|---|---|
| 展示标题 | 40 / 48 / 56 / 64 |
| 页面标题 | 28 / 32 / 36 |
| 区块标题 | 20 / 24 |
| 正文 | 14 / 16 / 18 |
| 辅助信息 | 12 / 13 |
| 标签 / 数据 | 11 / 12 / 13（仅在确实需要时） |

一个页面通常只需要 4–6 个字号。先定角色，再选数值；不要每个区块随手换字号。

## 间距

4 或 8 的倍数为主：

`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96`

- 组内 4–12；组间 24–48；区块间 48–96；页面边距 24–64（按视口）。
- 同一段距离只由一个层级负责。
- 密集工具可以用 4/8，品牌页面可以用更大的 32/48/64，但同一页保持一套。

## 圆角

`4 / 8 / 12 / 16 / 24 / 999`

- 同一产品通常 2–3 档：控件、卡片、容器。
- 胶囊只用于标签/按钮等短元素，不要所有容器都 999。
- 圆角要和产品调性一致：精致/工具偏小，消费/友好偏大。

## 描边与阴影

- 描边：1px 为主，层级越高越细；不要每层都画框，也不要同一处分隔叠双线。
- 阴影：2–3 档足够；优先低透明度、大模糊、短偏移。不要给每张普通卡片加重阴影。
- 阴影/描边/底色三者只选需要的组合，避免同时用三种方式表达同一层级。

## 颜色角色

至少定义：

- `bg` 页面底
- `surface` 卡片/面板
- `surface-2` 次级表面
- `text` 主文字
- `text-muted` 辅助文字
- `border` 描边
- `primary` 主操作
- `primary-hover` 主操作悬停/按下
- `success` / `warning` / `danger`
- `focus` 焦点

要求：

- 正文对比度目标 4.5:1；大字/次要信息不低于 3:1。
- 主色面积克制；重要状态不只靠颜色。
- 深色模式不是把浅色反相；表面层级和文字对比要重新检查。

## 在 Figma 里落地

```text
figma_library({ kind: 'variables' })
figma_variable({ action: 'create', name: 'color/primary', resolvedType: 'COLOR', value: '#F97316' })
figma_variable({ action: 'create', name: 'space/16', resolvedType: 'FLOAT', value: 16 })
figma_variable({ action: 'bind', name: 'color/primary', nodeId: '...', field: 'fill' })
figma_variable({ action: 'bind', name: 'space/16', nodeId: '...', field: 'itemSpacing' })

figma_style({ action: 'create', kind: 'text', name: 'Heading/XL', font: { family: 'Inter', style: 'Bold' }, fontSize: 48 })
figma_style({ action: 'apply', nodeId: '...', styleName: 'Heading/XL', target: 'text' })
```

导出 tokens：

```text
figma_export({ format: 'tokens' })
```

产物是 `tokens.json` / `tokens.css` / `tokens.js`；HTML/JSX 导出目前仍展开图层，token-aware 导出在后续版本。
