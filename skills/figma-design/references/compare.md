# 方向对比（figma_compare）

把 2–6 个候选 Figma 节点截图并生成自包含对比页 `compare.html` + `manifest.json`。只读，不修改 Figma。

## 什么时候用

- 用户明确要求比较 2–3 个方向/版式；
- 你自己做了多个候选，需要让用户并排看实际画面再选；
- 需要把“方向名 / 概念 / 色板 / 特征”和截图放在一起，而不是只发几张散图。

不要用它替代独立评审：对比页负责让用户选方向，评审负责判断质量。

## 怎么用

```text
figma_compare({
  title: '登录页 — 三个方向',
  candidates: [
    { nodeId: '11:606', name: 'Acme workspace', concept: '安静、编辑式、左对齐', palette: ['#0B1020', '#F97316'], traits: ['单列', '编辑式'] },
    { nodeId: '12:100', name: 'Editorial', concept: '大字标题，强品牌', palette: ['#F8FAFC', '#F97316'], traits: ['对比强', '大标题'] }
  ]
})
```

- `nodeId` 必填；`name` 缺省用 Figma 图层名。
- `palette` 只接受 hex；`traits` 是短标签。
- `title`、`scale`、`outDir` 可选；默认输出到 `<工作目录>/figma-export/compare-<时间戳>/`。
- 返回 `htmlPath`、`manifestPath` 和每个候选的截图文件。

## 候选怎么选

- 每个方向只放**首屏/代表页**，不要提前铺完整多页；
- 候选必须共用同一产品事实和示例数据，只变构图、组织、字体、色彩、主视觉；
- 至少一个候选有产品自己的记忆点；不要把同一模板换色当成三个方向；
- 用户选定后按 `manifest.json` 记录选择，回到 `figma-design` 主流程只深化一个。

## 打开与复核

- 用浏览器打开 `htmlPath`；每张卡片有“实际尺寸”和“选这个”。
- 对比页本身不带风格倾向；不要把它当设计稿。
- 需要 PNG 总览时，可用 `oil_ui_shoot` 对 `compare.html` 截图（若宿主已安装 oil-ui），但这不是插件运行必需。
