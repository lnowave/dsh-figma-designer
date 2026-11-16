# 质量审计（figma_audit）

客观检查层。它不能替代独立视觉评审，但能在评审前清掉大部分“肉眼能测出来”的问题。

## 什么时候用

- 新建/改版完成代表页面后，送独立评审前；
- 修改共享样式、颜色、字号、间距后，检查是否引入回归；
- 用户要求“检查这个页面有什么问题”但不想要主观评分时；
- 现有项目盘点基线。

## 怎么用

```text
figma_audit({ target: 'selection' })
figma_audit({ target: 'page', maxNodes: 800 })
figma_audit({ target: 'node', nodeIds: ['11:606'] })
```

默认读当前选区；只读，不改画布。输出 `score`、`issues`（含 `nodeId`/`severity`/`suggestion`）和 `metrics`。

## 处理顺序

1. 先修 `severity:"error"`：低对比、字号过小、占位文案、严重点击区；
2. 再修高影响 `warn`：行高、间距离群、颜色过多、token 匹配率低、裁剪；
3. `info` 是提示，不强制；
4. 每轮修改后重跑一次，确认问题数量下降；
5. 审计通过后再派独立评审，评审负责方向/品味/动效，审计负责可测量项。

## 边界

- 对比度只对纯色背景计算；渐变/图片背景会跳过（计入 `contrastSkipped`）。
- 不检查 hover/focus/error/loading/动效等运行时状态。
- token 覆盖按颜色值匹配，不等于已绑定变量。
- 分数是问题加权，不是审美分；最终仍以独立评审和用户判断为准。
