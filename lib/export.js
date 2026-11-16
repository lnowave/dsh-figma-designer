/**
 * Zero-dependency code generation for a normalized Figma subtree.
 *
 * The companion's `tree` command returns the style-complete node projection;
 * this module turns it into a self-contained HTML page, a React component plus
 * CSS file, or a design JSON snapshot. Auto layouts become flexbox; plain
 * frames keep absolute child positioning so generated code matches Figma.
 *
 * @module dsh-figma-designer/lib/export
 */

const FONT_FALLBACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const UNSUPPORTED_TYPES = new Set([
  'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'SLICE', 'CONNECTOR',
  'STICKY', 'SHAPE_WITH_TEXT', 'WASHI_TAPE', 'HIGHLIGHT', 'MEDIA',
])

const px = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? '0' : `${rounded}px`
}

const hexToRgb = (hex) => {
  const value = String(hex || '').replace('#', '')
  if (value.length !== 6 && value.length !== 8) return null
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  const a = value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) / 255 : 1
  if (![r, g, b, a].every(Number.isFinite)) return null
  return { r, g, b, a }
}

const cssColor = (hex, opacity = 1) => {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const alpha = Math.max(0, Math.min(1, rgb.a * (typeof opacity === 'number' ? opacity : 1)))
  if (alpha >= 0.999) return `#${String(hex).replace('#', '').slice(0, 6)}`
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.round(alpha * 1000) / 1000})`
}

const solidPaint = (paints) => {
  if (!Array.isArray(paints)) return null
  for (const paint of paints) {
    if (!paint || paint.visible === false) continue
    if (paint.type === 'SOLID' && paint.color) {
      return { color: paint.color, opacity: typeof paint.opacity === 'number' ? paint.opacity : 1 }
    }
  }
  return null
}

const fontFamily = (font) => {
  const family = font && typeof font.family === 'string' && font.family.length > 0 ? font.family : 'Inter'
  return `'${family}', ${FONT_FALLBACK}`
}

const fontWeight = (style) => {
  const value = String(style || 'Regular').toLowerCase()
  if (value.includes('thin')) return 100
  if (value.includes('extra light') || value.includes('extra-light') || value.includes('ultra light')) return 200
  if (value.includes('light')) return 300
  if (value.includes('medium')) return 500
  if (value.includes('semi bold') || value.includes('semi-bold') || value.includes('semibold')) return 600
  if (value.includes('extra bold') || value.includes('extra-bold') || value.includes('extrabold')) return 800
  if (value.includes('black') || value.includes('heavy')) return 900
  if (value.includes('bold')) return 700
  return 400
}

const isItalic = (style) => /italic|oblique/i.test(String(style || ''))

const lineHeight = (value) => {
  if (!value || typeof value !== 'object') return null
  if (value.unit === 'AUTO') return null
  if (value.unit === 'PIXELS' && typeof value.value === 'number') return `${Math.round(value.value * 100) / 100}px`
  if (value.unit === 'PERCENT' && typeof value.value === 'number') return `${Math.round(value.value * 10) / 10}%`
  return null
}

const letterSpacing = (value) => {
  if (!value || typeof value !== 'object' || typeof value.value !== 'number') return null
  if (value.unit === 'PERCENT') return `${Math.round(value.value * 10) / 1000}em`
  if (value.unit === 'PIXELS') return `${Math.round(value.value * 100) / 100}px`
  return null
}

const alignFor = (value, map, fallback) => (typeof value === 'string' && map[value] ? map[value] : fallback)

const JUSTIFY = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' }
const ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end' }
const TEXT_ALIGN = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }
const TEXT_CASE = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }
const TEXT_DECORATION = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }

const slug = (value) => {
  const text = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 32)
  return text || 'layer'
}

const escapeHTML = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const dedupe = (values) => {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

const roundRect = (radius) => {
  if (typeof radius === 'number') return px(radius)
  if (Array.isArray(radius) && radius.length === 4 && radius.every((item) => typeof item === 'number')) {
    return radius.map((item) => px(item) || '0').join(' ')
  }
  return null
}

const nodeBounds = (nodes) => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const x = typeof node.x === 'number' ? node.x : 0
    const y = typeof node.y === 'number' ? node.y : 0
    const width = typeof node.width === 'number' ? node.width : 0
    const height = typeof node.height === 'number' ? node.height : 0
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + width)
    maxY = Math.max(maxY, y + height)
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Build the render model shared by the HTML and JSX emitters. */
function buildModel(tree, options = {}) {
  const warnings = Array.isArray(tree.warnings) ? tree.warnings.slice() : []
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : []
  if (nodes.length === 0) throw new Error('没有可导出的节点')
  if (tree.stats && tree.stats.truncated) warnings.push('节点树被截断：部分图层未包含在导出结果中')

  const multiple = nodes.length > 1
  const bounds = multiple ? nodeBounds(nodes) : { x: 0, y: 0, width: 0, height: 0 }
  const rootName = multiple ? (tree.file || 'Figma Export') : (nodes[0].name || 'Figma Export')
  const used = new Set()
  const classes = new Map()

  const className = (node) => {
    if (classes.has(node.id)) return classes.get(node.id)
    const base = slug(node.name)
    const id = String(node.id || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    let value = `${base}-${id || 'node'}`
    let suffix = 2
    while (used.has(value)) value = `${base}-${id || 'node'}-${suffix++}`
    used.add(value)
    classes.set(node.id, value)
    return value
  }

  const buildNode = (node, parentLayout, offsetX, offsetY, isRoot) => {
    const type = String(node.type || '').toUpperCase()
    const name = typeof node.name === 'string' ? node.name : ''
    const cls = className(node)
    const style = {}
    const layout = node.layout && node.layout.mode ? node.layout : null

    if (isRoot) {
      style.position = 'relative'
      if (multiple) {
        style.width = px(bounds.width)
        style.height = px(bounds.height)
      } else {
        style.width = px(node.width)
        style.height = px(node.height)
      }
    } else if (parentLayout) {
      // Flex item owned by the parent's auto layout.
    } else {
      const x = (typeof node.x === 'number' ? node.x : 0) - offsetX
      const y = (typeof node.y === 'number' ? node.y : 0) - offsetY
      style.position = 'absolute'
      style.left = px(x) || '0'
      style.top = px(y) || '0'
    }

    if (!isRoot) {
      if (typeof node.width === 'number') style.width = px(node.width)
      if (typeof node.height === 'number') style.height = px(node.height)
    }
    if (node.visible === false) style.display = 'none'
    if (typeof node.opacity === 'number' && node.opacity < 0.999) style.opacity = String(node.opacity)
    if (typeof node.rotation === 'number' && Math.abs(node.rotation) > 0.001) {
      style.transform = `rotate(${node.rotation}deg)`
      style.transformOrigin = 'center'
    }

    if (type === 'TEXT') {
      const text = node.text || {}
      const paint = solidPaint(node.fills)
      if (paint) {
        const color = cssColor(paint.color, paint.opacity)
        if (color) style.color = color
      }
      style.fontFamily = fontFamily(text.font)
      style.fontSize = px(text.fontSize) || '16px'
      style.fontWeight = String(fontWeight(text.font && text.font.style))
      if (isItalic(text.font && text.font.style)) style.fontStyle = 'italic'
      const lh = lineHeight(text.lineHeight)
      if (lh) style.lineHeight = lh
      const ls = letterSpacing(text.letterSpacing)
      if (ls) style.letterSpacing = ls
      style.textAlign = alignFor(text.align, TEXT_ALIGN, 'left')
      if (text.textCase && TEXT_CASE[text.textCase]) style.textTransform = TEXT_CASE[text.textCase]
      if (text.textDecoration && TEXT_DECORATION[text.textDecoration]) style.textDecoration = TEXT_DECORATION[text.textDecoration]
      // Auto-width Figma text must be allowed to grow: a fixed px width can
      // wrap a word like "PRO" when the browser font is a hair wider.
      if (text.textAutoResize === 'WIDTH_AND_HEIGHT') {
        style.width = 'max-content'
        style.height = 'auto'
        style.flex = 'none'
      }
      style.whiteSpace = 'pre-wrap'
      style.overflowWrap = 'break-word'
      style.margin = '0'
    } else if (type === 'RECTANGLE' || type === 'ELLIPSE' || type === 'LINE') {
      const paint = solidPaint(node.fills)
      if (paint) {
        const color = cssColor(paint.color, paint.opacity)
        if (color) style.background = color
      }
      if (type === 'ELLIPSE') style.borderRadius = '50%'
      else {
        const radius = roundRect(node.cornerRadius)
        if (radius) style.borderRadius = radius
      }
    } else {
      const paint = solidPaint(node.fills)
      if (paint) {
        const color = cssColor(paint.color, paint.opacity)
        if (color) style.background = color
      }
      const radius = roundRect(node.cornerRadius)
      if (radius) style.borderRadius = radius
      if (node.clipsContent === true) style.overflow = 'hidden'
      if (layout) {
        style.display = 'flex'
        style.flexDirection = layout.mode === 'HORIZONTAL' ? 'row' : 'column'
        style.gap = px(layout.itemSpacing) || '0'
        style.justifyContent = alignFor(layout.primaryAxisAlign, JUSTIFY, 'flex-start')
        style.alignItems = alignFor(layout.counterAxisAlign, ALIGN, 'flex-start')
        if (layout.wrap === 'WRAP') style.flexWrap = 'wrap'
        const padding = layout.padding || {}
        const top = typeof padding.top === 'number' ? padding.top : 0
        const right = typeof padding.right === 'number' ? padding.right : 0
        const bottom = typeof padding.bottom === 'number' ? padding.bottom : 0
        const left = typeof padding.left === 'number' ? padding.left : 0
        if (top || right || bottom || left) style.padding = `${px(top) || '0'} ${px(right) || '0'} ${px(bottom) || '0'} ${px(left) || '0'}`
      } else if (Array.isArray(node.children) && node.children.length > 0) {
        // Absolute children need this wrapper as their containing block.
        if (style.position === undefined) style.position = 'relative'
      }
    }

    if (type !== 'TEXT') {
      const stroke = solidPaint(node.strokes)
      if (stroke) {
        const color = cssColor(stroke.color, stroke.opacity)
        const weight = typeof node.strokeWeight === 'number' ? node.strokeWeight : 1
        if (color) style.border = `${Math.max(0.5, Math.round(weight * 100) / 100)}px solid ${color}`
      }
      if (Array.isArray(node.effects)) {
        const shadows = []
        for (const effect of node.effects) {
          if (!effect || effect.type !== 'DROP_SHADOW' && effect.type !== 'INNER_SHADOW') continue
          const color = cssColor(effect.color || '#000000', effect.opacity)
          if (!color) continue
          const offset = effect.offset || { x: 0, y: 0 }
          const radius = typeof effect.radius === 'number' ? effect.radius : 0
          const spread = typeof effect.spread === 'number' ? effect.spread : 0
          shadows.push(`${effect.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(offset.x) || '0'} ${px(offset.y) || '0'} ${px(radius) || '0'} ${px(spread) || '0'} ${color}`)
        }
        if (shadows.length > 0) style.boxShadow = shadows.join(', ')
      }
    }

    if (UNSUPPORTED_TYPES.has(type)) {
      warnings.push(`图层「${name || node.id}」是 ${type}，v0.2 的 HTML/JSX 导出暂不支持，已保留占位盒子`)
    }

    const children = []
    if (Array.isArray(node.children)) {
      // Only a synthetic page root needs to subtract its page origin; normal
      // nodes store child coordinates relative to their own frame.
      const childOffsetX = multiple && isRoot ? offsetX : 0
      const childOffsetY = multiple && isRoot ? offsetY : 0
      for (const child of node.children) {
        children.push(buildNode(child, layout, childOffsetX, childOffsetY, false))
      }
    }
    return { type, name, id: node.id, className: cls, isRoot: isRoot === true, style, text: node.text || null, children }
  }

  const rootNode = multiple
    ? { id: 'page-root', name: rootName, type: 'FRAME', width: bounds.width, height: bounds.height, children: nodes }
    : nodes[0]
  const root = buildNode(rootNode, null, multiple ? bounds.x : 0, multiple ? bounds.y : 0, true)
  if (multiple) root.className = 'figma-page'
  root.rootName = rootName
  return { root, warnings: dedupe(warnings), nodeCount: tree.stats && tree.stats.count ? tree.stats.count : nodes.length }
}

const styleText = (style) => Object.entries(style)
  .filter(([, value]) => value !== null && value !== undefined && value !== '')
  .map(([key, value]) => `${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}: ${value};`)
  .join(' ')

const collectCSS = (node, css) => {
  css.push(`.${node.className} { ${styleText(node.style)} }`)
  for (const child of node.children) collectCSS(child, css)
}

const renderNodeHTML = (node, indent = '') => {
  const classValue = node.isRoot ? `figma-root ${node.className}` : node.className
  const cls = `class="${escapeHTML(classValue)}"`
  if (node.type === 'TEXT') {
    const text = node.text && typeof node.text.characters === 'string' ? node.text.characters : ''
    return `${indent}<div ${cls}>${escapeHTML(text)}</div>`
  }
  if (node.children.length === 0) return `${indent}<div ${cls}></div>`
  const inner = node.children.map((child) => renderNodeHTML(child, `${indent}  `)).join('\n')
  return `${indent}<div ${cls}>\n${inner}\n${indent}</div>`
}

const renderNodeJSX = (node, indent = '  ') => {
  const className = JSON.stringify(node.isRoot ? `figma-root ${node.className}` : node.className)
  if (node.type === 'TEXT') {
    const text = node.text && typeof node.text.characters === 'string' ? node.text.characters : ''
    return `${indent}<div className=${className}>{${JSON.stringify(text)}}</div>`
  }
  if (node.children.length === 0) return `${indent}<div className=${className} />`
  const inner = node.children.map((child) => renderNodeJSX(child, `${indent}  `)).join('\n')
  return `${indent}<div className=${className}>\n${inner}\n${indent}</div>`
}

const htmlShell = (model, css) => {
  const title = escapeHTML(model.root.rootName || 'Figma Export')
  const body = renderNodeHTML(model.root, '    ')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px;
      background: #12141a;
      color: #0b1020;
      font-family: ${FONT_FALLBACK};
    }
    .figma-stage { display: flex; align-items: center; justify-content: center; }
    .figma-root { flex: none; }
${css.map((line) => `    ${line}`).join('\n')}
  </style>
</head>
<body>
  <div class="figma-stage">
${body}
  </div>
</body>
</html>
`
}

/** Render a self-contained HTML page. */
export function toHTML(tree) {
  const model = buildModel(tree)
  const css = []
  collectCSS(model.root, css)
  return { files: { 'index.html': htmlShell(model, css) }, model }
}

/** Render App.jsx + styles.css. */
export function toJSX(tree) {
  const model = buildModel(tree)
  const css = []
  collectCSS(model.root, css)
  const component = `import './styles.css'

export default function App() {
  return (
${renderNodeJSX(model.root, '    ')}
  )
}
`
  const styles = `/* Generated by DSH Figma Designer. */
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: #12141a;
  font-family: ${FONT_FALLBACK};
}
.figma-stage { display: flex; align-items: center; justify-content: center; }
.figma-root { flex: none; }
${css.join('\n')}
`
  return { files: { 'App.jsx': component, 'styles.css': styles }, model }
}

/** Render the normalized design snapshot used by all other formats. */
export function toJSON(tree, meta = {}) {
  const model = buildModel(tree)
  return {
    files: {
      'design.json': `${JSON.stringify({ generatedBy: 'dsh-figma-designer', ...meta, tree }, null, 2)}\n`,
    },
    model,
  }
}

export function describeModel(model) {
  let frames = 0
  let texts = 0
  let leaves = 0
  const visit = (node) => {
    if (node.type === 'TEXT') texts += 1
    else if (node.children.length > 0) frames += 1
    else leaves += 1
    for (const child of node.children) visit(child)
  }
  visit(model.root)
  return { frames, texts, leaves }
}

const cssVarName = (name) => String(name || '')
  .replace(/\//g, '-')
  .replace(/[^a-zA-Z0-9_-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase() || 'token'

const tokenPath = (name) => String(name || '').split('/').map((part) => slug(part)).filter(Boolean)

const tokenTypeForFloat = (name) => /opacity|alpha|ratio|weight/i.test(name) ? 'number' : 'dimension'

const tokenValueForFloat = (name, value) => {
  if (typeof value !== 'number') return value
  return tokenTypeForFloat(name) === 'dimension' ? `${value}px` : value
}

const setNestedToken = (root, parts, token) => {
  let cursor = root
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {}
    cursor = cursor[key]
  }
  const last = parts[parts.length - 1]
  if (cursor[last] && typeof cursor[last] === 'object' && !cursor[last].$type) {
    cursor[last] = { ...cursor[last], ...token }
  } else {
    cursor[last] = token
  }
}

const fontStyleForCSS = (style) => {
  const weight = fontWeight(style)
  const parts = [String(weight)]
  if (isItalic(style)) parts.push('italic')
  return parts.join(' ')
}

/** Generate design-token files from a `figma_library` response. */
export function toTokens(library, meta = {}) {
  const variables = Array.isArray(library.variables) ? library.variables : []
  const collections = Array.isArray(library.variableCollections) ? library.variableCollections : []
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]))
  const tokens = {}
  const cssLines = []
  const warnings = []
  let count = 0

  for (const variable of variables) {
    const collection = variable.collectionId ? collectionById.get(variable.collectionId) : null
    const modeId = collection && collection.defaultModeId ? collection.defaultModeId : Object.keys(variable.valuesByMode || {})[0]
    const raw = variable.valuesByMode && modeId !== undefined ? variable.valuesByMode[modeId] : undefined
    if (raw === undefined) {
      warnings.push(`变量「${variable.name}」没有默认 mode 值，已跳过`)
      continue
    }
    const parts = tokenPath(variable.name)
    if (parts.length === 0) continue
    let token
    if (variable.resolvedType === 'COLOR') {
      token = { $type: 'color', $value: raw }
    } else if (variable.resolvedType === 'FLOAT') {
      token = { $type: tokenTypeForFloat(variable.name), $value: tokenValueForFloat(variable.name, raw) }
    } else if (variable.resolvedType === 'BOOLEAN') {
      token = { $type: 'boolean', $value: Boolean(raw) }
    } else {
      token = { $type: 'string', $value: raw }
    }
    if (typeof variable.description === 'string' && variable.description.length > 0) token.$description = variable.description
    setNestedToken(tokens, parts, token)
    cssLines.push(`  --${cssVarName(variable.name)}: ${token.$value};`)
    count += 1
  }

  const styles = library.styles || {}
  const textStyles = Array.isArray(styles.text) ? styles.text : []
  const typography = {}
  for (const style of textStyles) {
    const key = style.name || 'text'
    const font = style.font || {}
    const value = {
      fontFamily: font.family || 'Inter',
      fontWeight: fontWeight(font.style),
      fontSize: typeof style.fontSize === 'number' ? `${style.fontSize}px` : '16px',
    }
    const lh = lineHeight(style.lineHeight)
    if (lh) value.lineHeight = lh
    const ls = letterSpacing(style.letterSpacing)
    if (ls) value.letterSpacing = ls
    setNestedToken(typography, tokenPath(key), { $type: 'typography', $value: value })
    cssLines.push(`  --font-${cssVarName(key)}: ${fontStyleForCSS(font.style)} ${value.fontSize} ${fontFamily(font)};`)
  }
  if (Object.keys(typography).length > 0) tokens.typography = typography

  const paintStyles = Array.isArray(styles.paint) ? styles.paint : []
  const paintTokens = {}
  for (const style of paintStyles) {
    const color = solidPaint(style.paints)
    if (!color) continue
    const hex = cssColor(color.color, color.opacity)
    if (!hex) continue
    setNestedToken(paintTokens, tokenPath(style.name || 'paint'), { $type: 'color', $value: hex })
    cssLines.push(`  --${cssVarName('paint/' + (style.name || 'paint'))}: ${hex};`)
  }
  if (Object.keys(paintTokens).length > 0) tokens.paint = paintTokens

  const textClasses = textStyles.map((style) => {
    const font = style.font || {}
    const lh = lineHeight(style.lineHeight)
    const ls = letterSpacing(style.letterSpacing)
    return `.text-${cssVarName(style.name)} {\n  font-family: ${fontFamily(font)};\n  font-size: ${typeof style.fontSize === 'number' ? `${style.fontSize}px` : '16px'};\n  font-weight: ${fontWeight(font.style)};\n${isItalic(font.style) ? '  font-style: italic;\n' : ''}${lh ? `  line-height: ${lh};\n` : ''}${ls ? `  letter-spacing: ${ls};\n` : ''}}`
  }).join('\n\n')

  const payload = {
    $description: 'Design tokens exported by DSH Figma Designer',
    generatedAt: meta.exportedAt || new Date().toISOString(),
    ...tokens,
  }
  const css = `/* Design tokens exported by DSH Figma Designer. */
:root {
${cssLines.join('\n')}
}
${textClasses ? `\n/* Text styles */\n${textClasses}\n` : ''}`
  const js = `// Design tokens exported by DSH Figma Designer.
export const tokens = ${JSON.stringify(tokens, null, 2)}
`
  return {
    files: {
      'tokens.json': `${JSON.stringify(payload, null, 2)}\n`,
      'tokens.css': css,
      'tokens.js': js,
    },
    counts: { variables: count, textStyles: textStyles.length, paintStyles: paintStyles.length },
    warnings,
  }
}
