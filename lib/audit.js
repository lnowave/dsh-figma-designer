/**
 * Read-only design audit for a normalized Figma `tree` payload.
 *
 * The audit is intentionally deterministic and dependency-free: it works on
 * the same JSON the companion's `tree` command returns, so it can be tested
 * without Figma and gives the model node ids to fix. It is a supplement to,
 * not a replacement for, an independent visual review.
 *
 * @module dsh-figma-designer/lib/audit
 */

const PLACEHOLDER_RE = /(lorem ipsum|dolor sit amet|\bplaceholder\b|\btodo\b|待补充|待定|示例数据|示例文本|示例标题|示例描述|标题文本|描述文本)/i
const INTERACTIVE_RE = /(button|btn|cta|tab|toggle|switch|checkbox|radio|menu|close)/i
const MAX_ISSUES = 60
const GRID = 4

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const round = (value, digits = 2) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function parseColor(input) {
  if (typeof input !== 'string') return null
  let text = input.trim().replace(/^#/, '')
  if (text.length === 3) text = text.split('').map((ch) => ch + ch).join('')
  if (text.length === 6) text += 'FF'
  if (text.length !== 8 || !/^[0-9a-f]+$/i.test(text)) return null
  return {
    r: parseInt(text.slice(0, 2), 16),
    g: parseInt(text.slice(2, 4), 16),
    b: parseInt(text.slice(4, 6), 16),
    a: parseInt(text.slice(6, 8), 16) / 255,
  }
}

function toHex(color) {
  if (!color) return null
  const part = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`.toUpperCase()
}

function blend(child, parent) {
  if (!child) return parent
  if (!parent) return child
  const alpha = clamp(child.a * (parent.a === undefined ? 1 : parent.a), 0, 1)
  return {
    r: Math.round(child.r * alpha + parent.r * (1 - alpha)),
    g: Math.round(child.g * alpha + parent.g * (1 - alpha)),
    b: Math.round(child.b * alpha + parent.b * (1 - alpha)),
    a: clamp(alpha + parent.a * (1 - alpha), 0, 1),
  }
}

function luminance(color) {
  const channel = (value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrastRatio(a, b) {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function solidPaint(paints) {
  if (!Array.isArray(paints)) return null
  let hasUnsupported = false
  let solid = null
  for (const paint of paints) {
    if (!paint || paint.visible === false || paint.opacity === 0) continue
    if (paint.type !== 'SOLID') {
      hasUnsupported = true
      continue
    }
    const color = parseColor(paint.color)
    if (color) {
      const paintOpacity = typeof paint.opacity === 'number' ? clamp(paint.opacity, 0, 1) : 1
      solid = { ...color, a: color.a * paintOpacity }
    }
  }
  if (!solid) return hasUnsupported ? { unsupported: true } : null
  return { color: solid, unsupported: hasUnsupported }
}

function nodeOpacity(node) {
  return typeof node.opacity === 'number' && Number.isFinite(node.opacity) ? clamp(node.opacity, 0, 1) : 1
}

function textFillColor(node) {
  const fill = solidPaint(node.fills)
  if (!fill || fill.unsupported || !fill.color) return null
  return fill.color
}

function backgroundFor(entry) {
  let background = { r: 255, g: 255, b: 255, a: 1 }
  for (const ancestor of entry.ancestors) {
    if (ancestor.node.type === 'TEXT') continue
    const fill = solidPaint(ancestor.node.fills)
    if (!fill) continue
    if (fill.unsupported) return null
    const color = { ...fill.color, a: fill.color.a * nodeOpacity(ancestor.node) }
    background = blend(color, background)
  }
  return background
}

function issue(severity, code, message, node, extra = {}) {
  return {
    severity,
    code,
    message,
    nodeId: node && node.id ? node.id : null,
    nodeName: node && node.name ? node.name : null,
    nodeType: node && node.type ? node.type : null,
    ...extra,
  }
}

function walk(nodes, ancestors, absX, absY, out, options) {
  if (!Array.isArray(nodes)) return
  for (const node of nodes) {
    if (!isObject(node)) continue
    if (options.includeHidden !== true && node.visible === false) continue
    const x = absX + (Number.isFinite(node.x) ? node.x : 0)
    const y = absY + (Number.isFinite(node.y) ? node.y : 0)
    const entry = { node, ancestors, absX: x, absY: y }
    out.push(entry)
    if (Array.isArray(node.children) && node.children.length > 0) {
      walk(node.children, [...ancestors, entry], x, y, out, options)
    }
  }
}

function collectText(entries, issues, metrics) {
  for (const entry of entries) {
    const node = entry.node
    if (node.type !== 'TEXT' || !node.text || typeof node.text.characters !== 'string') continue
    const chars = node.text.characters.trim()
    if (chars.length === 0) continue
    const fontSize = Number.isFinite(node.text.fontSize) ? node.text.fontSize : 16
    const fontStyle = node.text.font && typeof node.text.font.style === 'string' ? node.text.font.style : ''
    const family = node.text.font && typeof node.text.font.family === 'string' ? node.text.font.family : ''
    metrics.textNodes += 1
    metrics.fontSizes.add(fontSize)
    if (family) metrics.fontFamilies.add(family)

    if (PLACEHOLDER_RE.test(chars)) {
      issues.push(issue('error', 'copy/placeholder', `文本仍是占位/示例内容：「${chars.slice(0, 40)}」`, node, {
        suggestion: '替换为真实产品文案或真实示例数据。',
      }))
    }

    const letterSpacing = node.text.letterSpacing
    const isEyebrow = chars === chars.toUpperCase() && chars.length <= 24 && letterSpacing && typeof letterSpacing === 'object' && Number.isFinite(letterSpacing.value) && letterSpacing.value > 0
    if (fontSize < 10 && !isEyebrow) {
      issues.push(issue('error', 'type/too-small', `字号 ${round(fontSize)}px 过小，阅读困难`, node, {
        current: fontSize,
        expected: '>= 12px（正文建议 14–16px）',
        suggestion: '先删冗余信息或调整层级；不要用极小字号制造“精致”。',
      }))
    } else if (fontSize < 12 && !isEyebrow) {
      issues.push(issue('warn', 'type/small', `字号 ${round(fontSize)}px 偏小`, node, {
        current: fontSize,
        expected: '>= 12px',
        suggestion: '检查是否可作为标签/脚注；正文不要低于 12px。',
      }))
    }

    const lineHeight = node.text.lineHeight
    let lineHeightPx = null
    if (lineHeight && typeof lineHeight === 'object') {
      if (lineHeight.unit === 'PIXELS' && Number.isFinite(lineHeight.value)) lineHeightPx = lineHeight.value
      else if (lineHeight.unit === 'PERCENT' && Number.isFinite(lineHeight.value)) lineHeightPx = fontSize * lineHeight.value / 100
    } else if (Number.isFinite(lineHeight)) {
      lineHeightPx = lineHeight
    }
    if (lineHeightPx && fontSize < 24 && (chars.length >= 40 || chars.includes('\n'))) {
      const ratio = lineHeightPx / fontSize
      if (ratio < 1.4) {
        issues.push(issue('warn', 'type/tight-leading', `多行文本行高偏紧（${round(ratio)}× 字号）`, node, {
          current: round(ratio),
          expected: '>= 1.4（中文正文建议 1.6–1.75）',
          suggestion: '提高 lineHeight，或减少每行字数。',
        }))
      }
    }

    const fill = textFillColor(node)
    const background = backgroundFor(entry)
    if (!fill) {
      metrics.contrastSkipped += 1
    } else if (!background) {
      metrics.contrastSkipped += 1
    } else {
      metrics.contrastChecked += 1
      const ancestorOpacity = entry.ancestors.reduce((value, ancestor) => value * nodeOpacity(ancestor.node), 1)
      const opacity = nodeOpacity(node) * ancestorOpacity * (fill.a === undefined ? 1 : fill.a)
      const foreground = blend({ ...fill, a: opacity }, background)
      const ratio = contrastRatio(foreground, background)
      const large = fontSize >= 24 || (fontSize >= 18.66 && /bold|semibold|black|heavy/i.test(fontStyle))
      const minimum = large ? 3 : 4.5
      if (ratio + 0.001 < minimum) {
        issues.push(issue(ratio + 0.5 < minimum ? 'error' : 'warn', 'contrast/text', `文字对比度 ${round(ratio, 2)}:1，低于 ${minimum}:1`, node, {
          current: round(ratio, 2),
          expected: minimum,
          foreground: toHex(foreground),
          background: toHex(background),
          suggestion: '提高前景亮度或更换底色；不要只靠字号/字重弥补低对比。',
        }))
        metrics.contrastFailed += 1
      }
    }
  }
}

function collectFrames(entries, issues, metrics) {
  const spacing = new Map()
  let spacingChecks = 0
  for (const entry of entries) {
    const node = entry.node
    if (node.layout && typeof node.layout === 'object') {
      const values = []
      if (Number.isFinite(node.layout.itemSpacing) && node.layout.itemSpacing > 0) values.push({ field: 'itemSpacing', value: node.layout.itemSpacing })
      const padding = node.layout.padding
      if (padding && typeof padding === 'object') {
        for (const field of ['top', 'right', 'bottom', 'left']) {
          if (Number.isFinite(padding[field]) && padding[field] > 0) values.push({ field: `padding.${field}`, value: padding[field] })
        }
      } else if (Number.isFinite(padding) && padding > 0) {
        values.push({ field: 'padding', value: padding })
      }
      for (const item of values) {
        spacingChecks += 1
        const key = String(round(item.value, 1))
        if (!spacing.has(key)) spacing.set(key, { value: item.value, nodes: [] })
        spacing.get(key).nodes.push({ node, field: item.field })
      }
    }

    if (node.clipsContent === true && Array.isArray(node.children)) {
      for (const child of entry.node.children || []) {
        if (!isObject(child) || child.visible === false) continue
        const childX = entry.absX + (Number.isFinite(child.x) ? child.x : 0)
        const childY = entry.absY + (Number.isFinite(child.y) ? child.y : 0)
        const childW = Number.isFinite(child.width) ? child.width : 0
        const childH = Number.isFinite(child.height) ? child.height : 0
        const parentW = Number.isFinite(node.width) ? node.width : 0
        const parentH = Number.isFinite(node.height) ? node.height : 0
        if (childX + childW > entry.absX + parentW + 1 || childY + childH > entry.absY + parentH + 1) {
          issues.push(issue('warn', 'layout/clipped', `子节点可能被父级裁剪：「${child.name || child.id}」`, child, {
            suggestion: '调整子节点尺寸/位置，或关闭父级 clipsContent。',
          }))
        }
      }
    }
  }
  metrics.spacingChecks = spacingChecks
  metrics.spacingValues = [...spacing.values()].map((item) => item.value).sort((a, b) => a - b)
  const offGrid = [...spacing.entries()].filter(([, item]) => Math.abs(item.value - Math.round(item.value / GRID) * GRID) > 0.01)
  if (spacing.size > 8) {
    issues.push(issue('warn', 'spacing/fragmented', `间距值用了 ${spacing.size} 种，节奏可能过碎`, null, {
      values: metrics.spacingValues,
      suggestion: '收敛到 4/8/12/16/24/32/48 等一套尺度。',
    }))
  }
  for (const [, item] of offGrid.slice(0, 6)) {
    const first = item.nodes[0]
    issues.push(issue('warn', 'spacing/off-grid', `间距 ${round(item.value)}px 不在 4px 网格上`, first.node, {
      current: item.value,
      field: first.field,
      suggestion: '如果并非有意，调到 4 的倍数；同一关系保持一致。',
    }))
  }
  if (offGrid.length > 6) {
    issues.push(issue('info', 'spacing/off-grid-count', `共有 ${offGrid.length} 种非 4px 网格间距`, null, {
      count: offGrid.length,
    }))
  }
}

function collectPalette(entries, library, issues, metrics) {
  const colors = new Map()
  for (const entry of entries) {
    const node = entry.node
    const iconContext = [entry, ...entry.ancestors].some((item) => /icon|logo/i.test(String(item.node && item.node.name)));
    if (iconContext) continue
    for (const key of ['fills', 'strokes']) {
      if (!Array.isArray(node[key])) continue
      for (const paint of node[key]) {
        if (!paint || paint.type !== 'SOLID' || paint.visible === false) continue
        const color = parseColor(paint.color)
        if (!color || color.a <= 0) continue
        const hex = toHex(color)
        if (!colors.has(hex)) colors.set(hex, [])
        colors.get(hex).push(node)
      }
    }
  }
  metrics.colors = [...colors.keys()].sort()
  metrics.colorCount = colors.size
  if (colors.size > 20) {
    issues.push(issue('error', 'palette/too-many', `使用了 ${colors.size} 种颜色，超出可维护范围`, null, {
      count: colors.size,
      suggestion: '把颜色收敛到背景/表面/文字/辅助/描边/主色/状态几类 token。',
    }))
  } else if (colors.size > 12) {
    issues.push(issue('warn', 'palette/too-many', `使用了 ${colors.size} 种颜色，建议收敛`, null, {
      count: colors.size,
      suggestion: '检查是否有无理由的近似色；同一种用途用一个 token。',
    }))
  }

  const tokenColors = new Set()
  if (isObject(library)) {
    const paintStyles = library.styles && Array.isArray(library.styles.paint) ? library.styles.paint : []
    for (const style of paintStyles) {
      for (const paint of Array.isArray(style.paints) ? style.paints : []) {
        if (paint && paint.type === 'SOLID') {
          const color = parseColor(paint.color)
          if (color) tokenColors.add(toHex(color))
        }
      }
    }
    for (const variable of Array.isArray(library.variables) ? library.variables : []) {
      if (variable && variable.resolvedType === 'COLOR' && variable.valuesByMode && typeof variable.valuesByMode === 'object') {
        for (const value of Object.values(variable.valuesByMode)) {
          const color = parseColor(value)
          if (color) tokenColors.add(toHex(color))
        }
      }
    }
  }
  metrics.tokenColors = [...tokenColors].sort()
  metrics.tokensAvailable = tokenColors.size
  if (tokenColors.size > 0 && colors.size > 0) {
    let matched = 0
    for (const hex of colors.keys()) if (tokenColors.has(hex)) matched += 1
    metrics.tokenCoverage = round(matched / colors.size, 3)
    if (metrics.tokenCoverage < 0.5) {
      issues.push(issue('warn', 'palette/token-coverage', `只有 ${Math.round(metrics.tokenCoverage * 100)}% 的颜色能匹配设计系统 token`, null, {
        coverage: metrics.tokenCoverage,
        suggestion: '优先使用已有 Paint Style / Variable；没有的再补 token，避免散落近似色。',
      }))
    }
  }
}

function collectTypography(entries, issues, metrics) {
  const sizes = [...metrics.fontSizes].sort((a, b) => a - b)
  if (sizes.length > 6) {
    issues.push(issue('warn', 'type/too-many-sizes', `使用了 ${sizes.length} 档字号，角色可能不够收敛`, null, {
      values: sizes,
      suggestion: '把字号收敛到 4–6 个角色（标题/正文/辅助/数据等）。',
    }))
  }
  if (metrics.fontFamilies.size > 2) {
    issues.push(issue('warn', 'type/too-many-families', `使用了 ${metrics.fontFamilies.size} 个字体家族`, null, {
      values: [...metrics.fontFamilies],
      suggestion: '通常 1–2 个字体家族足够；中文回退字体单独配置即可。',
    }))
  }
}

function collectComponents(entries, issues, metrics) {
  let instances = 0
  let components = 0
  let frames = 0
  for (const entry of entries) {
    const node = entry.node
    if (node.type === 'INSTANCE') instances += 1
    else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') components += 1
    else if (node.type === 'FRAME') frames += 1
  }
  metrics.instances = instances
  metrics.components = components
  metrics.frames = frames
  if (instances === 0 && frames >= 8) {
    issues.push(issue('info', 'system/no-instances', '页面没有任何组件实例，可能全部是手绘图层', null, {
      suggestion: '检查是否有可复用的 Button/Card/Input 组件；静态稿不强制。',
    }))
  }
}

function collectTapTargets(entries, issues, metrics) {
  let checked = 0
  for (const entry of entries) {
    const node = entry.node
    if (!['FRAME', 'INSTANCE', 'COMPONENT'].includes(node.type)) continue
    if (typeof node.name !== 'string' || !INTERACTIVE_RE.test(node.name)) continue
    const width = Number.isFinite(node.width) ? node.width : 0
    const height = Number.isFinite(node.height) ? node.height : 0
    if (width <= 0 || height <= 0) continue
    checked += 1
    if (height < 44 || width < 44) {
      issues.push(issue(height < 32 || width < 32 ? 'error' : 'warn', 'a11y/tap-target', `可点击控件 ${round(width)}×${round(height)} 小于 44×44`, node, {
        current: { width, height },
        expected: '>= 44×44',
        suggestion: '扩大点击区域；视觉尺寸可以不变，用透明热区补足。',
      }))
    }
  }
  metrics.tapTargetsChecked = checked
}

/**
 * Audit a `tree` payload. Pure: no I/O, no Figma, no mutation.
 * @param {{nodes?:Array}} tree
 * @param {object|null} library
 * @param {{includeHidden?:boolean, maxIssues?:number}} [options]
 */
export function auditTree(tree, library = null, options = {}) {
  const nodes = tree && Array.isArray(tree.nodes) ? tree.nodes : []
  const entries = []
  walk(nodes, [], 0, 0, entries, { includeHidden: options.includeHidden === true })
  const issues = []
  const metrics = {
    nodes: entries.length,
    textNodes: 0,
    contrastChecked: 0,
    contrastSkipped: 0,
    contrastFailed: 0,
    fontSizes: new Set(),
    fontFamilies: new Set(),
    spacingChecks: 0,
    spacingValues: [],
    colorCount: 0,
    colors: [],
    tokensAvailable: 0,
    tokenColors: [],
    instances: 0,
    components: 0,
    frames: 0,
    tapTargetsChecked: 0,
    warnings: Array.isArray(tree && tree.warnings) ? tree.warnings.slice(0, 20) : [],
  }

  collectText(entries, issues, metrics)
  collectFrames(entries, issues, metrics)
  collectPalette(entries, library, issues, metrics)
  collectTypography(entries, issues, metrics)
  collectComponents(entries, issues, metrics)
  collectTapTargets(entries, issues, metrics)

  const errors = issues.filter((item) => item.severity === 'error').length
  const warns = issues.filter((item) => item.severity === 'warn').length
  const infos = issues.filter((item) => item.severity === 'info').length
  const score = clamp(100 - errors * 15 - warns * 4 - infos, 0, 100)
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'
  const sorted = issues.slice().sort((a, b) => {
    const rank = { error: 0, warn: 1, info: 2 }
    return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || String(a.code).localeCompare(String(b.code))
  }).slice(0, Number.isFinite(options.maxIssues) ? options.maxIssues : MAX_ISSUES)

  return {
    ok: true,
    score,
    grade,
    summary: `发现 ${issues.length} 个问题（错误 ${errors} / 警告 ${warns} / 提示 ${infos}），质量分 ${score}/100。`,
    counts: { errors, warnings: warns, info: infos, total: issues.length },
    issues: sorted,
    metrics: {
      nodes: metrics.nodes,
      textNodes: metrics.textNodes,
      contrast: { checked: metrics.contrastChecked, failed: metrics.contrastFailed, skipped: metrics.contrastSkipped },
      typography: {
        fontSizes: [...metrics.fontSizes].sort((a, b) => a - b),
        families: [...metrics.fontFamilies].sort(),
      },
      spacing: {
        values: metrics.spacingValues,
        count: metrics.spacingValues.length,
        checks: metrics.spacingChecks,
      },
      palette: {
        count: metrics.colorCount,
        colors: metrics.colors,
        tokensAvailable: metrics.tokensAvailable,
        tokenColors: metrics.tokenColors,
        tokenCoverage: metrics.tokenCoverage === undefined ? null : metrics.tokenCoverage,
      },
      components: { instances: metrics.instances, components: metrics.components, frames: metrics.frames },
      tapTargets: { checked: metrics.tapTargetsChecked },
      warnings: metrics.warnings,
    },
    file: tree && tree.file ? tree.file : null,
    page: tree && tree.page ? tree.page : null,
    target: tree && tree.target ? tree.target : null,
    truncated: Boolean(tree && tree.stats && tree.stats.truncated),
    warnings: metrics.warnings,
  }
}
