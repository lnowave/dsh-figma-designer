# 参考图与素材

## 参考图

用户给截图/参考时，先用 `figma_designer_reference({ path })`：

- 工具返回真实像素尺寸、格式和图片附件；
- 先看原图，不靠记忆；缩略图只看构图，不判断字号；
- 拆产品参考和交互参考：
  - 产品参考：首屏骨架、内容组织、字体、颜色、图像用法；
  - 交互参考：触发 → 对象变化 → 反馈 → 下一状态。
- 拆成 6–10 条“是什么样、为什么这样做”，不要只说“干净/高级”。

要保留参考图在工作现场时，传 `place:true`、`x/y`，工具会创建 `Reference / <name>` 图片框。参考框不是设计稿，选完方向后可隐藏。

## 素材

### 开放图库

需要真实摄影/插画/馆藏素材时，先用 `figma_designer_media` 搜索开放图库：

```js
figma_designer_media({ action: 'search', query: 'minimal workspace desk', source: 'all' })
figma_designer_media({ action: 'fetch', refs: ['C2', 'O1'], dir: 'assets/media' })
```

只把 `usable:"page"` 的候选默认放进商用页面；`reference` 只能做参考，`check` 需要人工确认。下载后把 `SOURCES.md` 一起交付。

真实图片通常承担产品证据、对象识别或情绪，不要用通用渐变/几何图形替代必要图片。

工作流：

1. 先定每张图的任务：展示对象、解释关系、建立品牌，还是纯装饰；
2. 有合适本地素材就用 `figma_designer_asset` 放进来；
3. 没有合适素材时，先用占位色块，不要假装是最终图；
4. 图片进入 Figma 后 `figma_designer_screenshot` 看真实效果，再调裁切、比例和留白；
5. 记录素材来源/授权，不把生成图冒充真实产品截图。

## 工具

```js
figma_designer_reference({ path: 'references/pricing.png' })
figma_designer_reference({ path: 'references/pricing.png', place: true, x: 1600, y: 0 })

figma_designer_image({ path: 'assets/hero.jpg', name: 'Hero image', x: 0, y: 0 })
figma_designer_image({ path: 'assets/avatar.png', nodeId: '11:42' }) // 替换已有 image fill
```

支持 PNG/JPEG/GIF；`figma_designer_image` 默认 FIT，可传 `FILL`。工具不联网、不生成图片、不管理授权，素材由用户/设计师提供。
