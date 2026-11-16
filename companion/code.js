/**
 * DSH Figma Designer — companion plugin main thread (v0.1).
 *
 * This file runs inside the Figma plugin sandbox. It must therefore be plain
 * JavaScript with no `import` / `export`, no JSX and no Node.js APIs.
 *
 * The plugin UI iframe (companion/ui.html) owns the long-polling connection to
 * the local DSH bridge; it forwards commands to this main thread and posts the
 * results back:
 *
 *   { type: 'hello' }                                   -> { type: 'ready', ... }
 *   { type: 'command', id, command, args }              -> { type: 'result', id, ok, value | error }
 *
 * Commands: ping / read / screenshot / apply / export / select.
 * The ops DSL and result shapes are defined in docs/V0.1-SPEC.md sections 2-3.
 */

const PLUGIN_VERSION = '0.4.1'
const DEFAULT_FONT = { family: 'Inter', style: 'Regular' }
const MAX_OPERATION_CACHE = 50
const EXPORT_FORMATS = ['PNG', 'SVG', 'PDF']

const CREATE_FACTORIES = {
  frame: 'createFrame',
  component: 'createComponent',
  rect: 'createRectangle',
  ellipse: 'createEllipse',
  text: 'createText',
  line: 'createLine',
  polygon: 'createPolygon',
  star: 'createStar',
  svg: 'createNodeFromSvg',
}

const CORNER_KEYS = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius']
const PRIMARY_ALIGNS = ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']
const COUNTER_ALIGNS = ['MIN', 'CENTER', 'MAX']
const WRAP_MODES = ['NO_WRAP', 'WRAP']
const TEXT_ALIGNS = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']
const TEXT_AUTO_RESIZE_MODES = ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT']
const EFFECT_TYPES = ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR']
const LINE_HEIGHT_UNITS = ['PIXELS', 'PERCENT']
const LAYOUT_RAW_KEYS = [
  'layoutMode',
  'itemSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'layoutWrap',
]

/** In-memory operationId dedupe cache (never persisted). */
const operationCache = new Map()
/** Fonts already loaded in this plugin session. */
const loadedFonts = new Set()

// ---------------------------------------------------------------- UI wiring

figma.showUI(__html__, {
  width: 300,
  height: 112,
  themeColors: true,
  title: 'DSH Figma Designer',
})

figma.ui.onmessage = async function (message) {
  try {
    if (!message || typeof message !== 'object') return

    if (message.type === 'resize') {
      const width = Math.max(220, Math.min(480, Math.round(Number(message.width) || 300)))
      const height = Math.max(80, Math.min(700, Math.round(Number(message.height) || 112)))
      if (figma.ui && typeof figma.ui.resize === 'function') figma.ui.resize(width, height)
      return
    }

    if (message.type === 'hello') {
      postToUI({
        type: 'ready',
        file: fileDisplayName(),
        page: pageDisplayName(),
        editorType: typeof figma.editorType === 'string' ? figma.editorType : 'figma',
        pluginVersion: PLUGIN_VERSION,
      })
      return
    }

    if (message.type !== 'command') return

    const id = message.id
    const command = typeof message.command === 'string' ? message.command : ''
    const args = message.args && typeof message.args === 'object' && !Array.isArray(message.args) ? message.args : {}

    try {
      const value = await handleCommand(command, args)
      postToUI({ type: 'result', id: id, ok: true, value: value })
    } catch (error) {
      postToUI({ type: 'result', id: id, ok: false, error: errorPayload(error) })
    }
  } catch (fatal) {
    // Never let an exception escape the plugin message handler (Figma would
    // close the plugin). Last resort: report it to the UI.
    try {
      postToUI({
        type: 'result',
        id: message && message.id,
        ok: false,
        error: { code: 'figma-error', message: errorMessage(fatal) },
      })
    } catch (_ignored) {
      // UI is gone; nothing else we can do.
    }
  }
}

async function handleCommand(command, args) {
  switch (command) {
    case 'ping':
      return pingCommand()
    case 'read':
      return readCommand(args)
    case 'screenshot':
      return screenshotCommand(args)
    case 'apply':
      return applyCommand(args)
    case 'export':
      return exportCommand(args)
    case 'tree':
      return treeCommand(args)
    case 'library':
      return libraryCommand(args)
    case 'instantiate':
      return instantiateCommand(args)
    case 'styles':
      return stylesCommand(args)
    case 'variables':
      return variablesCommand(args)
    case 'variants':
      return variantsCommand(args)
    case 'select':
      return selectCommand(args)
    default:
      throw pluginError('unsupported', '未知命令：' + (command || '(empty)'))
  }
}

// ------------------------------------------------------------- tiny helpers

function postToUI(message) {
  try {
    if (figma.ui && typeof figma.ui.postMessage === 'function') {
      figma.ui.postMessage(message)
    }
  } catch (_ignored) {
    // The plugin UI may have been closed; the bridge will surface the timeout.
  }
}

function fileDisplayName() {
  return figma.root && typeof figma.root.name === 'string' ? figma.root.name : ''
}

function pageDisplayName() {
  return figma.currentPage && typeof figma.currentPage.name === 'string' ? figma.currentPage.name : ''
}

function currentSelection() {
  if (figma.currentPage && Array.isArray(figma.currentPage.selection)) return figma.currentPage.selection
  return []
}

function hasField(object, key) {
  return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key)
}

function hasProperty(target, key) {
  return target !== null && target !== undefined && key in target
}

function errorMessage(error) {
  if (error && typeof error.message === 'string') return error.message
  return String(error)
}

function pluginError(code, message, opIndex) {
  const error = new Error(message)
  error.code = code
  if (typeof opIndex === 'number') error.opIndex = opIndex
  return error
}

function invalidOp(message, opIndex) {
  return pluginError('invalid-op', message, opIndex)
}

function errorPayload(error, fallbackIndex) {
  const payload = {
    code: error && typeof error.code === 'string' ? error.code : 'figma-error',
    message: errorMessage(error),
  }
  let index = null
  if (error && typeof error.opIndex === 'number') index = error.opIndex
  else if (typeof fallbackIndex === 'number') index = fallbackIndex
  if (index !== null) payload.opIndex = index
  return payload
}

function cloneData(value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (_ignored) {
    return value
  }
}

function clonePlain(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'object') return cloneData(value)
  return value
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !isFinite(value)) return fallback
  if (value < min) return min
  if (value > max) return max
  return value
}

function clampInteger(value, min, max, fallback) {
  if (typeof value !== 'number' || !isFinite(value)) return fallback
  return clampNumber(Math.round(value), min, max, fallback)
}

function shallowCopy(object) {
  const out = {}
  for (const key in object) {
    if (hasField(object, key)) out[key] = object[key]
  }
  return out
}

function bytesLength(bytes) {
  if (!bytes) return 0
  if (typeof bytes.byteLength === 'number') return bytes.byteLength
  if (typeof bytes.length === 'number') return bytes.length
  return 0
}

// --------------------------------------------------------------- ping / read

function pingCommand() {
  const root = figma.root || {}
  const page = figma.currentPage || null
  const pages = []
  if (Array.isArray(root.children)) {
    for (const child of root.children) {
      if (child && typeof child.id === 'string') {
        pages.push({ id: child.id, name: typeof child.name === 'string' ? child.name : '' })
      }
    }
  }
  return {
    ok: true,
    pluginVersion: PLUGIN_VERSION,
    file: typeof root.name === 'string' ? root.name : '',
    page: page && typeof page.name === 'string' ? page.name : '',
    editorType: typeof figma.editorType === 'string' ? figma.editorType : 'figma',
    apiVersion: typeof figma.apiVersion === 'string' ? figma.apiVersion : '',
    pages: pages,
    selectionCount: currentSelection().length,
    capabilities: { svg: true, exportFormats: ['PNG', 'SVG', 'PDF'], textEdit: true },
  }
}

async function readCommand(args) {
  const target = args.target === undefined || args.target === null ? 'selection' : args.target
  if (target !== 'selection' && target !== 'page' && target !== 'node') {
    throw invalidOp('target 必须是 selection / page / node')
  }
  const depth = clampInteger(args.depth, 0, 6, 2)
  const maxNodes = clampInteger(args.maxNodes, 1, 300, 80)
  const includeHidden = args.includeHidden === true
  const page = figma.currentPage
  if (!page) throw pluginError('figma-error', '当前没有活动页面')

  const selection = currentSelection()
  const selectionIds = selection.map(function (node) {
    return node.id
  })

  let roots = []
  if (target === 'selection') {
    roots = selection.slice()
  } else if (target === 'page') {
    const children = Array.isArray(page.children) ? page.children : []
    roots = includeHidden
      ? children.slice()
      : children.filter(function (child) {
          return child.visible !== false
        })
  } else {
    const ids = Array.isArray(args.nodeIds) ? args.nodeIds : []
    if (ids.length === 0) throw invalidOp('target:node 需要 nodeIds 数组')
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0) throw invalidOp('nodeIds 必须是非空字符串数组')
      let node = null
      try {
        node = await figma.getNodeByIdAsync(id)
      } catch (error) {
        throw pluginError('figma-error', '读取节点失败：' + errorMessage(error))
      }
      if (!node) throw pluginError('node-not-found', '找不到节点 ' + id)
      roots.push(node)
    }
  }

  const state = { count: 0, truncated: false, maxNodes: maxNodes }
  const nodes = []
  for (const root of roots) {
    if (state.count >= maxNodes) {
      state.truncated = true
      break
    }
    nodes.push(summarizeNode(root, state, depth, includeHidden))
  }

  return {
    ok: true,
    page: { id: page.id, name: page.name },
    target: target,
    nodes: nodes,
    stats: { count: state.count, truncated: state.truncated, maxNodes: maxNodes, depth: depth },
    selection: selectionIds,
  }
}

function summarizeNode(node, state, depthLeft, includeHidden) {
  state.count += 1
  const summary = {
    id: node.id,
    name: typeof node.name === 'string' ? node.name : '',
    type: node.type,
    visible: node.visible !== false,
    locked: node.locked === true,
    opacity: typeof node.opacity === 'number' ? node.opacity : 1,
    rotation: typeof node.rotation === 'number' ? node.rotation : 0,
    bounds: boundsOf(node),
  }

  if (typeof node.width === 'number' && typeof node.height === 'number') {
    summary.size = { width: node.width, height: node.height }
  }
  if (Array.isArray(node.children)) summary.children = node.children.length

  if (hasProperty(node, 'fills')) summary.fills = summarizePaints(node.fills)
  if (hasProperty(node, 'strokes')) summary.strokes = summarizePaints(node.strokes)
  if (typeof node.strokeWeight === 'number') summary.strokeWeight = node.strokeWeight

  const radius = readRadius(node)
  if (radius !== null) summary.cornerRadius = radius

  if (hasProperty(node, 'layoutMode')) summary.layout = layoutSummary(node)

  if (node.type === 'TEXT' && typeof node.characters === 'string') summary.text = summarizeText(node)

  if (node.type === 'INSTANCE') {
    let component = null
    try {
      const mainComponent = node.mainComponent
      if (mainComponent && typeof mainComponent.id === 'string') {
        component = { id: mainComponent.id, name: mainComponent.name }
      }
    } catch (_ignored) {
      component = null
    }
    summary.component = component
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    const rawChildren = node.children
    const visibleChildren = includeHidden
      ? rawChildren.slice()
      : rawChildren.filter(function (child) {
          return child.visible !== false
        })
    if (depthLeft > 0) {
      if (state.count >= state.maxNodes) {
        state.truncated = true
      } else if (visibleChildren.length > 0) {
        const childSummaries = []
        for (const child of visibleChildren) {
          if (state.count >= state.maxNodes) {
            state.truncated = true
            break
          }
          childSummaries.push(summarizeNode(child, state, depthLeft - 1, includeHidden))
        }
        summary.childNodes = childSummaries
      }
    }
  }

  return summary
}

function boundsOf(node) {
  const box = node && node.absoluteBoundingBox
  if (box && typeof box.x === 'number' && typeof box.y === 'number') {
    return {
      x: roundTo(box.x, 100),
      y: roundTo(box.y, 100),
      width: roundTo(box.width, 100),
      height: roundTo(box.height, 100),
    }
  }
  return {
    x: typeof node.x === 'number' ? roundTo(node.x, 100) : null,
    y: typeof node.y === 'number' ? roundTo(node.y, 100) : null,
    width: typeof node.width === 'number' ? roundTo(node.width, 100) : null,
    height: typeof node.height === 'number' ? roundTo(node.height, 100) : null,
  }
}

function roundTo(value, multiplier) {
  if (typeof value !== 'number' || !isFinite(value)) return null
  const scale = multiplier || 1
  return Math.round(value * scale) / scale
}

function summarizePaints(paints) {
  if (!Array.isArray(paints) || paints.length === 0) return null
  const out = []
  for (const paint of paints) {
    if (out.length >= 4) break
    if (!paint || typeof paint !== 'object') continue
    if (paint.type === 'SOLID') {
      out.push({
        type: 'SOLID',
        color: paintToHex(paint),
        opacity: typeof paint.opacity === 'number' ? paint.opacity : 1,
      })
    } else if (typeof paint.type === 'string') {
      out.push({ type: paint.type })
    }
  }
  return out.length > 0 ? out : null
}

function paintToHex(paint) {
  const color = (paint && paint.color) || {}
  const channel = function (value) {
    const number = typeof value === 'number' && isFinite(value) ? value : 0
    return Math.max(0, Math.min(255, Math.round(number * 255)))
      .toString(16)
      .padStart(2, '0')
  }
  return ('#' + channel(color.r) + channel(color.g) + channel(color.b)).toUpperCase()
}

function summarizeText(node) {
  return {
    characters: node.characters,
    font: readFont(node),
    fontSize: typeof node.fontSize === 'number' ? node.fontSize : null,
    align: typeof node.textAlignHorizontal === 'string' ? node.textAlignHorizontal : null,
    lineHeight: clonePlain(node.lineHeight),
    letterSpacing: clonePlain(node.letterSpacing),
    textAutoResize: typeof node.textAutoResize === 'string' ? node.textAutoResize : null,
  }
}

function layoutSummary(node) {
  if (!hasProperty(node, 'layoutMode')) return null
  if (!node.layoutMode || node.layoutMode === 'NONE') return null
  return {
    mode: node.layoutMode,
    itemSpacing: typeof node.itemSpacing === 'number' ? node.itemSpacing : 0,
    padding: {
      top: typeof node.paddingTop === 'number' ? node.paddingTop : 0,
      right: typeof node.paddingRight === 'number' ? node.paddingRight : 0,
      bottom: typeof node.paddingBottom === 'number' ? node.paddingBottom : 0,
      left: typeof node.paddingLeft === 'number' ? node.paddingLeft : 0,
    },
    primaryAxisAlign: typeof node.primaryAxisAlignItems === 'string' ? node.primaryAxisAlignItems : 'MIN',
    counterAxisAlign: typeof node.counterAxisAlignItems === 'string' ? node.counterAxisAlignItems : 'MIN',
  }
}

// ---------------------------------------------------- screenshot / export / select

async function screenshotCommand(args) {
  const scale = clampNumber(args.scale, 0.1, 4, 1)
  let node = null
  if (args.nodeId !== undefined && args.nodeId !== null) {
    if (typeof args.nodeId !== 'string' || args.nodeId.length === 0) {
      throw invalidOp('nodeId 必须是非空字符串')
    }
    try {
      node = await figma.getNodeByIdAsync(args.nodeId)
    } catch (error) {
      throw pluginError('figma-error', '读取节点失败：' + errorMessage(error))
    }
    if (!node) throw pluginError('node-not-found', '找不到节点 ' + args.nodeId)
  } else {
    const selection = currentSelection()
    node = selection.length > 0 ? selection[0] : null
  }
  if (!node) throw pluginError('no-node', '没有可截图的节点：请先在 Figma 中选中一个图层，或传 nodeId')
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw pluginError('unsupported', '页面/文档节点不能截图')
  if (typeof node.exportAsync !== 'function') throw pluginError('unsupported', '节点 ' + node.id + ' (' + node.type + ') 不支持截图')

  const bytes = await exportNodeBytes(node, 'PNG', scale)
  const data = encodeBase64(bytes)
  const width = Math.max(1, Math.round((typeof node.width === 'number' ? node.width : 0) * scale))
  const height = Math.max(1, Math.round((typeof node.height === 'number' ? node.height : 0) * scale))

  return {
    ok: true,
    node: { id: node.id, name: node.name, type: node.type },
    scale: scale,
    image: {
      mimeType: 'image/png',
      bytes: bytesLength(bytes),
      data: data,
      width: width,
      height: height,
    },
  }
}

async function exportCommand(args) {
  const format = args.format === undefined || args.format === null ? 'PNG' : args.format
  if (EXPORT_FORMATS.indexOf(format) < 0) {
    throw invalidOp('不支持的导出格式：' + String(format) + '（可选 PNG / SVG / PDF）')
  }
  const scale = clampNumber(args.scale, 0.1, 4, 1)
  if (!Array.isArray(args.nodeIds) || args.nodeIds.length === 0) {
    throw invalidOp('nodeIds 必须是非空字符串数组')
  }

  const files = []
  for (const id of args.nodeIds) {
    if (typeof id !== 'string' || id.length === 0) throw invalidOp('nodeIds 必须是非空字符串数组')
    let node = null
    try {
      node = await figma.getNodeByIdAsync(id)
    } catch (error) {
      throw pluginError('figma-error', '读取节点失败：' + errorMessage(error))
    }
    if (!node) throw pluginError('node-not-found', '找不到节点 ' + id)
    if (typeof node.exportAsync !== 'function') {
      throw pluginError('unsupported', '节点 ' + id + ' (' + node.type + ') 不支持导出')
    }
    const bytes = await exportNodeBytes(node, format, scale)
    files.push({
      nodeId: node.id,
      name: node.name,
      format: format,
      bytes: bytesLength(bytes),
      data: encodeBase64(bytes),
    })
  }
  return { ok: true, files: files }
}


/**
 * Return a style-complete subtree for code generation. `read` is deliberately
 * compact for agent context; `tree` is the lossless export projection used by
 * the Host's HTML/JSX/SVG exporters.
 */
async function treeCommand(args) {
  const page = figma.currentPage
  const target = args.target === 'page' || args.target === 'node' ? args.target : 'selection'
  const depth = clampInteger(args.depth, 0, 20, 12)
  const maxNodes = clampInteger(args.maxNodes, 1, 2000, 800)
  const selection = currentSelection()
  const selectionIds = selection.map(function (node) {
    return node.id
  })
  const warnings = []
  let roots = []

  if (Array.isArray(args.nodeIds) && args.nodeIds.length > 0) {
    const seen = {}
    for (const id of args.nodeIds) {
      if (typeof id !== 'string' || id.length === 0) throw invalidOp('nodeIds 必须是非空字符串数组')
      if (seen[id]) continue
      seen[id] = true
      let node = null
      try {
        node = await figma.getNodeByIdAsync(id)
      } catch (error) {
        throw pluginError('figma-error', '读取节点失败：' + errorMessage(error))
      }
      if (!node) throw pluginError('node-not-found', '找不到节点 ' + id)
      roots.push(node)
    }
  } else if (target === 'page') {
    roots = page.children.slice()
  } else {
    if (selection.length === 0) throw pluginError('no-node', '没有选中的节点：请先在 Figma 中选中要导出的图层')
    roots = selection
  }

  const state = { count: 0, truncated: false, maxNodes: maxNodes }
  const nodes = []
  for (const root of roots) {
    if (state.count >= maxNodes) {
      state.truncated = true
      break
    }
    nodes.push(serializeExportNode(root, state, depth, warnings))
  }

  return {
    ok: true,
    page: { id: page.id, name: page.name },
    file: fileDisplayName(),
    target: target,
    nodes: nodes,
    stats: { count: state.count, truncated: state.truncated, maxNodes: maxNodes, depth: depth },
    selection: selectionIds,
    warnings: uniqueStrings(warnings).slice(0, 20),
  }
}

function serializeExportNode(node, state, depthLeft, warnings) {
  state.count += 1
  const out = {
    id: node.id,
    name: typeof node.name === 'string' ? node.name : '',
    type: node.type,
    visible: node.visible !== false,
    opacity: typeof node.opacity === 'number' ? node.opacity : 1,
    rotation: typeof node.rotation === 'number' ? node.rotation : 0,
  }
  if (typeof node.x === 'number') out.x = roundTo(node.x, 100)
  if (typeof node.y === 'number') out.y = roundTo(node.y, 100)
  if (typeof node.width === 'number') out.width = roundTo(node.width, 100)
  if (typeof node.height === 'number') out.height = roundTo(node.height, 100)

  if (hasProperty(node, 'clipsContent')) out.clipsContent = node.clipsContent === true
  if (hasProperty(node, 'fills')) out.fills = serializeExportPaints(node.fills, warnings, node.name, '填充')
  if (hasProperty(node, 'strokes')) out.strokes = serializeExportPaints(node.strokes, warnings, node.name, '描边')
  if (typeof node.strokeWeight === 'number') out.strokeWeight = roundTo(node.strokeWeight, 100)
  if (typeof node.strokeAlign === 'string') out.strokeAlign = node.strokeAlign

  const radius = readRadius(node)
  if (radius !== null) out.cornerRadius = radius

  if (hasProperty(node, 'effects')) {
    const effects = serializeExportEffects(node.effects, warnings, node.name)
    if (effects !== null) out.effects = effects
  }
  if (hasProperty(node, 'layoutMode')) {
    const layout = layoutSummary(node)
    if (layout !== null) {
      if (typeof node.layoutWrap === 'string') layout.wrap = node.layoutWrap
      out.layout = layout
    }
  }

  if (node.type === 'TEXT') {
    out.text = serializeExportText(node, warnings)
  }
  if (node.type === 'INSTANCE') {
    try {
      const main = node.mainComponent
      if (main && typeof main.id === 'string') out.component = { id: main.id, name: main.name }
    } catch (_ignored) {
      /* detached or unavailable main component */
    }
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    if (depthLeft <= 0) {
      state.truncated = true
    } else {
      const children = []
      for (const child of node.children) {
        if (state.count >= state.maxNodes) {
          state.truncated = true
          break
        }
        children.push(serializeExportNode(child, state, depthLeft - 1, warnings))
      }
      if (children.length > 0) out.children = children
    }
  }
  return out
}

function serializeExportPaints(paints, warnings, nodeName, label) {
  if (!Array.isArray(paints) || paints.length === 0) return null
  const out = []
  for (const paint of paints) {
    if (!paint || typeof paint !== 'object') continue
    if (paint.visible === false) continue
    if (paint.type === 'SOLID') {
      out.push({
        type: 'SOLID',
        color: paintToHex(paint),
        opacity: typeof paint.opacity === 'number' ? paint.opacity : 1,
      })
    } else if (typeof paint.type === 'string' && paint.type.indexOf('GRADIENT') === 0) {
      out.push({ type: 'GRADIENT', gradientType: paint.type, opacity: typeof paint.opacity === 'number' ? paint.opacity : 1 })
      warnings.push('节点「' + (nodeName || '?') + '」的' + label + '使用了渐变，HTML/JSX 导出暂不支持，已保留 JSON 描述')
    } else if (paint.type === 'IMAGE') {
      out.push({ type: 'IMAGE', opacity: typeof paint.opacity === 'number' ? paint.opacity : 1 })
      warnings.push('节点「' + (nodeName || '?') + '」的' + label + '使用了图片填充，v0.2 暂不内嵌图片')
    } else {
      out.push({ type: paint.type })
      warnings.push('节点「' + (nodeName || '?') + '」的' + label + '类型 ' + paint.type + ' 暂不支持')
    }
  }
  return out.length > 0 ? out : null
}

function serializeExportEffects(effects, warnings, nodeName) {
  if (!Array.isArray(effects) || effects.length === 0) return null
  const out = []
  for (const effect of effects) {
    if (!effect || typeof effect !== 'object' || effect.visible === false) continue
    if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
      out.push({
        type: effect.type,
        color: paintToHex({ color: effect.color }),
        opacity: typeof effect.color === 'object' && typeof effect.color.a === 'number' ? effect.color.a : 1,
        offset: {
          x: typeof effect.offset === 'object' && typeof effect.offset.x === 'number' ? roundTo(effect.offset.x, 100) : 0,
          y: typeof effect.offset === 'object' && typeof effect.offset.y === 'number' ? roundTo(effect.offset.y, 100) : 0,
        },
        radius: typeof effect.radius === 'number' ? roundTo(effect.radius, 100) : 0,
        spread: typeof effect.spread === 'number' ? roundTo(effect.spread, 100) : 0,
      })
    } else if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
      out.push({ type: effect.type, radius: typeof effect.radius === 'number' ? roundTo(effect.radius, 100) : 0 })
    } else {
      warnings.push('节点「' + (nodeName || '?') + '」的 effect ' + effect.type + ' 暂不支持')
    }
  }
  return out.length > 0 ? out : null
}

function serializeExportText(node, warnings) {
  const font = readFont(node)
  if (!font) warnings.push('节点「' + (node.name || '?') + '」使用了混合字体，按 Inter Regular 导出')
  return {
    characters: typeof node.characters === 'string' ? node.characters : '',
    font: font || { family: 'Inter', style: 'Regular' },
    fontSize: typeof node.fontSize === 'number' ? node.fontSize : 16,
    align: typeof node.textAlignHorizontal === 'string' ? node.textAlignHorizontal : 'LEFT',
    lineHeight: clonePlain(node.lineHeight),
    letterSpacing: clonePlain(node.letterSpacing),
    textAutoResize: typeof node.textAutoResize === 'string' ? node.textAutoResize : null,
    textCase: typeof node.textCase === 'string' ? node.textCase : null,
    textDecoration: typeof node.textDecoration === 'string' ? node.textDecoration : null,
  }
}

function uniqueStrings(values) {
  const seen = {}
  const out = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen[value]) continue
    seen[value] = true
    out.push(value)
  }
  return out
}

// --------------------------------------------------------- design system

async function libraryCommand(args) {
  const warnings = []
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
  const limit = clampInteger(args.limit, 1, 500, 100)
  await loadAllPagesOnce()
  const componentNodes = await localComponentNodes(warnings)
  const componentSets = []
  const components = []
  for (const node of componentNodes) {
    if (node.type === 'COMPONENT_SET') {
      if (query.length > 0 && node.name.toLowerCase().indexOf(query) < 0) continue
      componentSets.push(summarizeComponentSet(node))
    } else if (node.type === 'COMPONENT') {
      const parentSet = node.parent && node.parent.type === 'COMPONENT_SET' ? node.parent : null
      const name = parentSet ? parentSet.name : node.name
      if (query.length > 0 && name.toLowerCase().indexOf(query) < 0) continue
      components.push(summarizeComponent(node, parentSet))
    }
  }
  const styles = await localStyleSummary(query, warnings)
  const variableData = await localVariableSummary(query, warnings)
  return {
    ok: true,
    file: fileDisplayName(),
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    components: components.slice(0, limit),
    componentSets: componentSets.slice(0, limit),
    styles: styles,
    variableCollections: variableData.collections.slice(0, limit),
    variables: variableData.variables.slice(0, limit),
    stats: {
      components: components.length,
      componentSets: componentSets.length,
      paintStyles: styles.paint.length,
      textStyles: styles.text.length,
      effectStyles: styles.effect.length,
      collections: variableData.collections.length,
      variables: variableData.variables.length,
      limit: limit,
      truncated: components.length > limit || componentSets.length > limit || variableData.variables.length > limit,
    },
    warnings: uniqueStrings(warnings).slice(0, 20),
  }
}

async function loadAllPagesOnce() {
  try {
    if (typeof figma.loadAllPagesAsync === 'function') await figma.loadAllPagesAsync()
  } catch (_ignored) {
    /* The dynamic-page API may reject; local async getters still work. */
  }
}

async function localComponentNodes(warnings) {
  let nodes = []
  try {
    if (typeof figma.getLocalComponentsAsync === 'function') nodes = await figma.getLocalComponentsAsync()
    else if (typeof figma.getLocalComponents === 'function') nodes = figma.getLocalComponents()
    else if (typeof figma.root.findAllWithCriteria === 'function') {
      nodes = figma.root.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })
    }
  } catch (error) {
    warnings.push('读取本地组件失败：' + errorMessage(error))
    return []
  }
  const out = []
  const seen = {}
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || seen[node.id] || (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET')) continue
    seen[node.id] = true
    out.push(node)
  }
  return out
}

function summarizeComponent(node, parentSet) {
  const summary = {
    id: node.id,
    name: node.name,
    type: 'COMPONENT',
    width: typeof node.width === 'number' ? roundTo(node.width, 100) : null,
    height: typeof node.height === 'number' ? roundTo(node.height, 100) : null,
    componentSetId: parentSet ? parentSet.id : null,
    componentSetName: parentSet ? parentSet.name : null,
  }
  if (node.variantProperties && typeof node.variantProperties === 'object') summary.variantProperties = cloneData(node.variantProperties)
  if (typeof node.description === 'string' && node.description.length > 0) summary.description = node.description
  return summary
}

function summarizeComponentSet(node) {
  const variants = []
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (!child || child.type !== 'COMPONENT') continue
      const entry = { id: child.id, name: child.name }
      if (child.variantProperties && typeof child.variantProperties === 'object') entry.variantProperties = cloneData(child.variantProperties)
      variants.push(entry)
    }
  }
  return {
    id: node.id,
    name: node.name,
    type: 'COMPONENT_SET',
    variants: variants,
    variantCount: variants.length,
    properties: node.componentPropertyDefinitions && typeof node.componentPropertyDefinitions === 'object'
      ? Object.keys(node.componentPropertyDefinitions).map(function (key) {
          const def = node.componentPropertyDefinitions[key] || {}
          return { name: key, type: def.type || null, defaultValue: def.defaultValue === undefined ? null : def.defaultValue }
        })
      : [],
  }
}

async function localStyleNodes() {
  const paint = []
  const text = []
  const effect = []
  const grid = []
  try {
    if (typeof figma.getLocalPaintStylesAsync === 'function') paint.push.apply(paint, await figma.getLocalPaintStylesAsync())
    else if (typeof figma.getLocalPaintStyles === 'function') paint.push.apply(paint, figma.getLocalPaintStyles())
  } catch (_ignored) {}
  try {
    if (typeof figma.getLocalTextStylesAsync === 'function') text.push.apply(text, await figma.getLocalTextStylesAsync())
    else if (typeof figma.getLocalTextStyles === 'function') text.push.apply(text, figma.getLocalTextStyles())
  } catch (_ignored) {}
  try {
    if (typeof figma.getLocalEffectStylesAsync === 'function') effect.push.apply(effect, await figma.getLocalEffectStylesAsync())
    else if (typeof figma.getLocalEffectStyles === 'function') effect.push.apply(effect, figma.getLocalEffectStyles())
  } catch (_ignored) {}
  try {
    if (typeof figma.getLocalGridStylesAsync === 'function') grid.push.apply(grid, await figma.getLocalGridStylesAsync())
    else if (typeof figma.getLocalGridStyles === 'function') grid.push.apply(grid, figma.getLocalGridStyles())
  } catch (_ignored) {}
  return { paint: paint, text: text, effect: effect, grid: grid }
}

async function localStyleSummary(query, warnings) {
  const nodes = await localStyleNodes()
  const match = function (name) {
    return query.length === 0 || String(name || '').toLowerCase().indexOf(query) >= 0
  }
  return {
    paint: nodes.paint.filter(function (style) { return match(style.name) }).map(function (style) {
      return {
        id: style.id,
        name: style.name,
        key: typeof style.key === 'string' ? style.key : null,
        type: 'PAINT',
        paints: serializeExportPaints(style.paints, warnings, style.name, '样式'),
      }
    }),
    text: nodes.text.filter(function (style) { return match(style.name) }).map(function (style) {
      return {
        id: style.id,
        name: style.name,
        key: typeof style.key === 'string' ? style.key : null,
        type: 'TEXT',
        font: readFont({ fontName: style.fontName }) || (style.fontName ? { family: style.fontName.family, style: style.fontName.style } : null),
        fontSize: typeof style.fontSize === 'number' ? style.fontSize : null,
        lineHeight: clonePlain(style.lineHeight),
        letterSpacing: clonePlain(style.letterSpacing),
      }
    }),
    effect: nodes.effect.filter(function (style) { return match(style.name) }).map(function (style) {
      return {
        id: style.id,
        name: style.name,
        key: typeof style.key === 'string' ? style.key : null,
        type: 'EFFECT',
        effects: serializeExportEffects(style.effects, warnings, style.name),
      }
    }),
    grid: nodes.grid.filter(function (style) { return match(style.name) }).map(function (style) {
      return { id: style.id, name: style.name, key: typeof style.key === 'string' ? style.key : null, type: 'GRID' }
    }),
  }
}

async function localVariableSummary(query, warnings) {
  if (!figma.variables || typeof figma.variables.getLocalVariablesAsync !== 'function') {
    warnings.push('当前 Figma 版本/文件不允许读取 Variables（需要 Figma Variables 支持）')
    return { collections: [], variables: [] }
  }
  let collections = []
  let variables = []
  try {
    collections = await figma.variables.getLocalVariableCollectionsAsync()
    variables = await figma.variables.getLocalVariablesAsync()
  } catch (error) {
    warnings.push('读取变量失败：' + errorMessage(error))
    return { collections: [], variables: [] }
  }
  const collectionById = {}
  for (const collection of collections) collectionById[collection.id] = collection
  const match = function (name) {
    return query.length === 0 || String(name || '').toLowerCase().indexOf(query) >= 0
  }
  return {
    collections: collections.filter(function (collection) { return match(collection.name) }).map(function (collection) {
      return {
        id: collection.id,
        name: collection.name,
        defaultModeId: collection.defaultModeId,
        modes: Array.isArray(collection.modes) ? collection.modes.map(function (mode) { return { modeId: mode.modeId, name: mode.name } }) : [],
        variableCount: Array.isArray(collection.variableIds) ? collection.variableIds.length : 0,
      }
    }),
    variables: variables.filter(function (variable) { return match(variable.name) }).map(function (variable) {
      const collection = collectionById[variable.variableCollectionId]
      const values = {}
      if (variable.valuesByMode && typeof variable.valuesByMode === 'object') {
        for (const modeId in variable.valuesByMode) {
          if (hasField(variable.valuesByMode, modeId)) values[modeId] = formatVariableValue(variable.resolvedType, variable.valuesByMode[modeId])
        }
      }
      return {
        id: variable.id,
        name: variable.name,
        key: typeof variable.key === 'string' ? variable.key : null,
        resolvedType: variable.resolvedType,
        collectionId: variable.variableCollectionId,
        collectionName: collection ? collection.name : null,
        valuesByMode: values,
        description: typeof variable.description === 'string' ? variable.description : null,
      }
    }),
  }
}

function formatVariableValue(resolvedType, value) {
  if (value === null || value === undefined) return null
  if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') return { alias: value.id }
  if (resolvedType === 'COLOR' && value && typeof value === 'object') {
    const hex = paintToHex({ color: value })
    const alpha = typeof value.a === 'number' ? Math.round(value.a * 1000) / 1000 : 1
    return alpha < 1 ? hex + Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase() : hex
  }
  if (typeof value === 'object') return cloneData(value)
  return value
}

function parseVariableValue(resolvedType, value) {
  if (resolvedType === 'COLOR') {
    if (value && typeof value === 'object' && typeof value.r === 'number') return { r: value.r, g: value.g, b: value.b, a: typeof value.a === 'number' ? value.a : 1 }
    if (typeof value === 'string') {
      const color = parseHexColor(value)
      if (!color) throw invalidOp('COLOR 变量值必须是 #RRGGBB / #RRGGBBAA')
      return { r: color.r, g: color.g, b: color.b, a: color.hasAlpha ? color.a : 1 }
    }
    throw invalidOp('COLOR 变量值必须是 #RRGGBB / #RRGGBBAA')
  }
  if (resolvedType === 'FLOAT') {
    if (typeof value !== 'number' || !isFinite(value)) throw invalidOp('FLOAT 变量值必须是数字')
    return value
  }
  if (resolvedType === 'BOOLEAN') {
    if (typeof value !== 'boolean') throw invalidOp('BOOLEAN 变量值必须是 true/false')
    return value
  }
  if (resolvedType === 'STRING') {
    if (typeof value !== 'string') throw invalidOp('STRING 变量值必须是字符串')
    return value
  }
  throw invalidOp('不支持的变量类型：' + String(resolvedType))
}

async function resolveVariableOrThrow(args) {
  if (!figma.variables) throw pluginError('unsupported', '当前 Figma 版本/文件不支持 Variables')
  if (typeof args.variableId === 'string' && args.variableId.length > 0) {
    if (typeof figma.variables.getVariableByIdAsync === 'function') {
      const variable = await figma.variables.getVariableByIdAsync(args.variableId)
      if (variable) return variable
    }
    const all = await figma.variables.getLocalVariablesAsync()
    const found = all.find(function (item) { return item.id === args.variableId })
    if (found) return found
    throw pluginError('node-not-found', '找不到变量 ' + args.variableId)
  }
  if (typeof args.name === 'string' && args.name.length > 0) {
    const all = await figma.variables.getLocalVariablesAsync()
    const exact = all.find(function (item) { return item.name === args.name })
    if (exact) return exact
    const partial = all.find(function (item) { return item.name.toLowerCase().indexOf(args.name.toLowerCase()) >= 0 })
    if (partial) return partial
  }
  throw invalidOp('必须提供 variableId 或 name')
}

async function findOrCreateCollection(args) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  const wantedId = typeof args.collectionId === 'string' ? args.collectionId : ''
  const wantedName = typeof args.collectionName === 'string' && args.collectionName.length > 0 ? args.collectionName : 'Design Tokens'
  let collection = wantedId ? collections.find(function (item) { return item.id === wantedId }) : null
  if (!collection) collection = collections.find(function (item) { return item.name === wantedName })
  if (!collection) {
    collection = figma.variables.createVariableCollection(wantedName)
  }
  return collection
}

async function instantiateCommand(args) {
  const warnings = []
  const resolved = await resolveComponentForInstance(args, warnings)
  const component = resolved.component
  let instance = null
  try {
    instance = component.createInstance()
  } catch (error) {
    throw pluginError('figma-error', '创建组件实例失败：' + errorMessage(error))
  }
  const parent = args.parentId ? await resolveParent(args.parentId, 0) : figma.currentPage
  try {
    parent.appendChild(instance)
  } catch (error) {
    throw pluginError('figma-error', '挂载组件实例失败：' + errorMessage(error))
  }
  if (typeof args.name === 'string' && args.name.length > 0) instance.name = args.name
  if (typeof args.x === 'number' || typeof args.y === 'number') {
    if (typeof instance.x === 'number') instance.x = typeof args.x === 'number' ? args.x : instance.x
    if (typeof instance.y === 'number') instance.y = typeof args.y === 'number' ? args.y : instance.y
  }
  if (typeof args.width === 'number' && typeof instance.resize === 'function') {
    instance.resize(args.width, typeof args.height === 'number' ? args.height : (typeof instance.height === 'number' ? instance.height : args.width))
  } else if (typeof args.height === 'number' && typeof instance.resize === 'function') {
    instance.resize(typeof instance.width === 'number' ? instance.width : args.height, args.height)
  }

  const applied = []
  const overrides = Array.isArray(args.overrides) ? args.overrides : []
  for (let index = 0; index < overrides.length; index++) {
    const override = overrides[index]
    if (!override || typeof override !== 'object') {
      warnings.push('overrides[' + index + '] 不是对象，已忽略')
      continue
    }
    const target = findInstanceNode(instance, override)
    if (!target) {
      warnings.push('实例中找不到图层 ' + (override.nodeName || override.nodeId || '(未命名)'))
      continue
    }
    const changed = []
    if (hasField(override, 'text') && target.type === 'TEXT') {
      try {
        const font = readFont(target) || { family: 'Inter', style: 'Regular' }
        await figma.loadFontAsync(font)
        target.characters = String(override.text)
        changed.push('text')
      } catch (error) {
        warnings.push('改文字失败 ' + target.name + '：' + errorMessage(error))
      }
    }
    if (hasField(override, 'fill') && hasProperty(target, 'fills')) {
      target.fills = colorValueToPaints(override.fill, 0)
      changed.push('fill')
    }
    if (hasField(override, 'visible')) {
      target.visible = override.visible !== false
      changed.push('visible')
    }
    if (hasField(override, 'opacity') && typeof override.opacity === 'number') {
      target.opacity = Math.max(0, Math.min(1, override.opacity))
      changed.push('opacity')
    }
    if (hasField(override, 'radius')) {
      if (writeRadius(target, override.radius)) changed.push('radius')
    }
    if ((hasField(override, 'width') || hasField(override, 'height')) && typeof target.resize === 'function') {
      try {
        const width = typeof override.width === 'number' ? override.width : target.width
        const height = typeof override.height === 'number' ? override.height : target.height
        target.resize(width, height)
        changed.push('size')
      } catch (error) {
        warnings.push('调整尺寸失败 ' + target.name + '：' + errorMessage(error))
      }
    }
    applied.push({ nodeId: target.id, name: target.name, changes: changed })
  }

  return {
    ok: true,
    node: { id: instance.id, name: instance.name, type: instance.type },
    component: { id: component.id, name: component.name, type: component.type, componentSetId: resolved.componentSet ? resolved.componentSet.id : null },
    overrides: applied,
    warnings: uniqueStrings(warnings).slice(0, 20),
  }
}

async function resolveComponentForInstance(args, warnings) {
  await loadAllPagesOnce()
  const nodes = await localComponentNodes(warnings)
  let component = null
  if (typeof args.componentId === 'string' && args.componentId.length > 0) {
    try {
      component = await figma.getNodeByIdAsync(args.componentId)
    } catch (error) {
      throw pluginError('figma-error', '读取组件失败：' + errorMessage(error))
    }
    if (!component) throw pluginError('node-not-found', '找不到组件 ' + args.componentId)
  } else if (typeof args.componentName === 'string' && args.componentName.length > 0) {
    const wanted = args.componentName.toLowerCase()
    const exact = nodes.find(function (node) { return (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.name === args.componentName })
    const partial = nodes.find(function (node) { return (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.name.toLowerCase().indexOf(wanted) >= 0 })
    component = exact || partial || null
    if (!component) throw pluginError('node-not-found', '找不到组件/组件集 ' + args.componentName)
  } else {
    throw invalidOp('必须提供 componentId 或 componentName')
  }

  let componentSet = null
  if (component.type === 'COMPONENT_SET') {
    componentSet = component
    component = chooseVariant(component, args.variant)
    if (!component) throw pluginError('node-not-found', '组件集 ' + componentSet.name + ' 没有匹配的 variant')
  } else if (component.parent && component.parent.type === 'COMPONENT_SET') {
    componentSet = component.parent
  }
  return { component: component, componentSet: componentSet }
}

function chooseVariant(componentSet, variant) {
  const children = Array.isArray(componentSet.children) ? componentSet.children.filter(function (child) { return child && child.type === 'COMPONENT' }) : []
  if (children.length === 0) return null
  if (!variant || typeof variant !== 'object') return componentSet.defaultVariant || children[0]
  const matches = children.filter(function (child) {
    const props = child.variantProperties || {}
    for (const key in variant) {
      if (!hasField(variant, key)) continue
      if (String(props[key]) !== String(variant[key])) return false
    }
    return true
  })
  return matches[0] || null
}

function findInstanceNode(instance, override) {
  if (typeof override.nodeId === 'string' && override.nodeId.length > 0) {
    const byId = findDescendant(instance, function (node) { return node.id === override.nodeId })
    if (byId) return byId
  }
  if (typeof override.nodeName === 'string' && override.nodeName.length > 0) {
    return findDescendant(instance, function (node) { return node.name === override.nodeName })
  }
  return null
}

function findDescendant(root, predicate) {
  if (!root) return null
  if (predicate(root)) return root
  const children = Array.isArray(root.children) ? root.children : []
  for (const child of children) {
    const found = findDescendant(child, predicate)
    if (found) return found
  }
  return null
}

async function variantsCommand(args) {
  const specs = Array.isArray(args.variants) ? args.variants : []
  if (specs.length === 0) throw invalidOp('variants 必须是非空数组')
  if (!args.baseComponentId && !args.baseComponentName) throw invalidOp('必须提供 baseComponentId 或 baseComponentName')
  const warnings = []
  const baseResult = await resolveComponentForInstance({ componentId: args.baseComponentId, componentName: args.baseComponentName }, warnings)
  const base = baseResult.component
  let parent = figma.currentPage
  if (typeof args.parentId === 'string' && args.parentId.length > 0) {
    parent = await resolveParent(args.parentId, 0)
  } else if (base.parent && (base.parent.type === 'PAGE' || base.parent.type === 'FRAME')) {
    parent = base.parent
  }

  const created = []
  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index] && typeof specs[index] === 'object' ? specs[index] : {}
    let clone = null
    try {
      clone = base.clone()
      parent.appendChild(clone)
    } catch (error) {
      throw pluginError('figma-error', '复制基础组件失败：' + errorMessage(error))
    }
    const properties = spec.properties && typeof spec.properties === 'object' ? spec.properties : { Variant: String(index + 1) }
    clone.name = variantPropertyName(properties)
    if (typeof spec.width === 'number' || typeof spec.height === 'number') {
      try {
        clone.resize(typeof spec.width === 'number' ? spec.width : clone.width, typeof spec.height === 'number' ? spec.height : clone.height)
      } catch (error) {
        warnings.push('variant ' + clone.name + ' 调整尺寸失败：' + errorMessage(error))
      }
    }
    if (spec.fill !== undefined && hasProperty(clone, 'fills')) clone.fills = colorValueToPaints(spec.fill, 0)
    if (typeof spec.text === 'string') {
      const textNode = findDescendant(clone, function (node) { return node.type === 'TEXT' })
      if (textNode) {
        try {
          const font = readFont(textNode) || { family: 'Inter', style: 'Regular' }
          await figma.loadFontAsync(font)
          textNode.characters = spec.text
        } catch (error) {
          warnings.push('variant ' + clone.name + ' 改文字失败：' + errorMessage(error))
        }
      } else {
        warnings.push('variant ' + clone.name + ' 没有可覆盖的 TEXT 图层')
      }
    }
    if (Array.isArray(spec.overrides)) {
      const applied = await applyNodeOverrides(clone, spec.overrides, warnings)
      if (applied.length > 0) warnings.push('variant ' + clone.name + ' 应用了 ' + applied.length + ' 个 override')
    }
    created.push(clone)
  }

  let componentSet = null
  try {
    componentSet = figma.combineAsVariants(created, parent)
  } catch (error) {
    throw pluginError('figma-error', '合并变体失败：' + errorMessage(error))
  }
  componentSet.name = typeof args.name === 'string' && args.name.length > 0 ? args.name : base.name + ' Variants'
  return {
    ok: true,
    componentSet: {
      id: componentSet.id,
      name: componentSet.name,
      type: 'COMPONENT_SET',
      variants: created.map(function (variant) {
        return { id: variant.id, name: variant.name, variantProperties: clonePlain(variant.variantProperties) }
      }),
    },
    warnings: uniqueStrings(warnings).slice(0, 20),
  }
}

function variantPropertyName(properties) {
  const parts = []
  for (const key in properties) {
    if (!hasField(properties, key)) continue
    parts.push(String(key) + '=' + String(properties[key]))
  }
  return parts.length > 0 ? parts.join(', ') : 'Variant=Default'
}

async function applyNodeOverrides(root, overrides, warnings) {
  const applied = []
  for (let index = 0; index < overrides.length; index++) {
    const override = overrides[index]
    if (!override || typeof override !== 'object') continue
    const target = findInstanceNode(root, override)
    if (!target) {
      warnings.push('变体中找不到图层 ' + (override.nodeName || override.nodeId || '(未命名)'))
      continue
    }
    const changed = []
    if (typeof override.text === 'string' && target.type === 'TEXT') {
      try {
        const font = readFont(target) || { family: 'Inter', style: 'Regular' }
        await figma.loadFontAsync(font)
        target.characters = override.text
        changed.push('text')
      } catch (error) {
        warnings.push('改文字失败 ' + target.name + '：' + errorMessage(error))
      }
    }
    if (override.fill !== undefined && hasProperty(target, 'fills')) {
      target.fills = colorValueToPaints(override.fill, 0)
      changed.push('fill')
    }
    if (override.visible !== undefined) {
      target.visible = override.visible !== false
      changed.push('visible')
    }
    if (typeof override.width === 'number' || typeof override.height === 'number') {
      try {
        target.resize(typeof override.width === 'number' ? override.width : target.width, typeof override.height === 'number' ? override.height : target.height)
        changed.push('size')
      } catch (error) {
        warnings.push('调整尺寸失败 ' + target.name + '：' + errorMessage(error))
      }
    }
    applied.push({ nodeId: target.id, name: target.name, changes: changed })
  }
  return applied
}

async function stylesCommand(args) {
  const action = args.action === 'create' || args.action === 'apply' ? args.action : 'apply'
  if (action === 'create') return createStyleCommand(args)
  return applyStyleCommand(args)
}

async function createStyleCommand(args) {
  const kind = typeof args.kind === 'string' ? args.kind.toLowerCase() : ''
  const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : ''
  if (!name) throw invalidOp('create style 必须提供 name')
  if (kind === 'paint' || kind === 'fill' || kind === 'color') {
    if (typeof figma.createPaintStyle !== 'function') throw pluginError('unsupported', '当前 Figma 不支持创建 Paint Style')
    const style = figma.createPaintStyle()
    style.name = name
    style.paints = colorValueToPaints(typeof args.color === 'string' ? args.color : '#F97316', 0)
    if (typeof args.description === 'string') style.description = args.description
    return { ok: true, style: { id: style.id, name: style.name, type: 'PAINT' } }
  }
  if (kind === 'text') {
    if (typeof figma.createTextStyle !== 'function') throw pluginError('unsupported', '当前 Figma 不支持创建 Text Style')
    const style = figma.createTextStyle()
    style.name = name
    const font = args.font && typeof args.font === 'object' ? args.font : { family: 'Inter', style: 'Regular' }
    await figma.loadFontAsync(font)
    style.fontName = font
    if (typeof args.fontSize === 'number') style.fontSize = args.fontSize
    if (args.lineHeight !== undefined) style.lineHeight = cloneData(args.lineHeight)
    if (args.letterSpacing !== undefined) style.letterSpacing = cloneData(args.letterSpacing)
    return { ok: true, style: { id: style.id, name: style.name, type: 'TEXT' } }
  }
  if (kind === 'effect') {
    if (typeof figma.createEffectStyle !== 'function') throw pluginError('unsupported', '当前 Figma 不支持创建 Effect Style')
    const style = figma.createEffectStyle()
    style.name = name
    style.effects = Array.isArray(args.effects) ? cloneData(args.effects) : []
    return { ok: true, style: { id: style.id, name: style.name, type: 'EFFECT' } }
  }
  throw invalidOp('create style 的 kind 必须是 paint / text / effect')
}

async function applyStyleByValue(node, style, target) {
  if (style.type === 'PAINT') {
    const paints = Array.isArray(style.paints) ? cloneData(style.paints) : null
    if (!paints || paints.length === 0) throw pluginError('unsupported', 'Paint Style 没有可应用的 paints')
    if (target === 'stroke' || (target === 'auto' && hasProperty(node, 'strokeStyleId') && !hasProperty(node, 'fillStyleId'))) {
      if (!hasProperty(node, 'strokes')) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持描边')
      node.strokes = paints
      return { ok: true, node: { id: node.id, name: node.name }, style: { id: style.id, name: style.name, type: style.type }, field: 'stroke', linked: false, mode: 'value' }
    }
    if (!hasProperty(node, 'fills')) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持填充')
    node.fills = paints
    return { ok: true, node: { id: node.id, name: node.name }, style: { id: style.id, name: style.name, type: style.type }, field: 'fill', linked: false, mode: 'value' }
  }
  if (style.type === 'TEXT') {
    if (node.type !== 'TEXT') throw pluginError('unsupported', '文本样式只能应用到 TEXT 节点')
    const font = style.fontName ? { family: style.fontName.family, style: style.fontName.style } : null
    if (font) {
      await figma.loadFontAsync(font)
      node.fontName = font
    }
    if (typeof style.fontSize === 'number') node.fontSize = style.fontSize
    if (style.lineHeight !== undefined && style.lineHeight !== null) node.lineHeight = cloneData(style.lineHeight)
    if (style.letterSpacing !== undefined && style.letterSpacing !== null) node.letterSpacing = cloneData(style.letterSpacing)
    if (typeof style.textCase === 'string') node.textCase = style.textCase
    if (typeof style.textDecoration === 'string') node.textDecoration = style.textDecoration
    return { ok: true, node: { id: node.id, name: node.name }, style: { id: style.id, name: style.name, type: style.type }, field: 'text', linked: false, mode: 'value' }
  }
  if (style.type === 'EFFECT') {
    if (!hasProperty(node, 'effects')) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持 effects')
    node.effects = Array.isArray(style.effects) ? cloneData(style.effects) : []
    return { ok: true, node: { id: node.id, name: node.name }, style: { id: style.id, name: style.name, type: style.type }, field: 'effect', linked: false, mode: 'value' }
  }
  throw pluginError('unsupported', '样式类型 ' + style.type + ' 暂不支持应用')
}

async function assignNodeStyle(node, field, styleId) {
  // Some Figma API surfaces return style ids with a trailing comma. The
  // setter expects the canonical id; strip only the separator.
  const targetId = typeof styleId === 'string' ? styleId.replace(/,$/, '') : styleId
  const asyncName = field === 'fill'
    ? 'setFillStyleIdAsync'
    : field === 'stroke'
      ? 'setStrokeStyleIdAsync'
      : field === 'text'
        ? 'setTextStyleIdAsync'
        : field === 'effect'
          ? 'setEffectStyleIdAsync'
          : null
  if (asyncName && typeof node[asyncName] === 'function') {
    await node[asyncName](targetId)
    return
  }
  const syncField = field === 'fill'
    ? 'fillStyleId'
    : field === 'stroke'
      ? 'strokeStyleId'
      : field === 'text'
        ? 'textStyleId'
        : 'effectStyleId'
  node[syncField] = targetId
}

async function applyStyleCommand(args) {
  const node = await resolveNodeOrThrow(args.nodeId, 0)
  let style = null
  if (typeof args.styleId === 'string' && args.styleId.length > 0) {
    if (typeof figma.getStyleByIdAsync === 'function') {
      try { style = await figma.getStyleByIdAsync(args.styleId) } catch (_ignored) { style = null }
    }
    if (!style) {
      const all = await localStyleNodes()
      style = all.paint.concat(all.text, all.effect, all.grid).find(function (item) { return item.id === args.styleId }) || null
    }
    if (!style) throw pluginError('node-not-found', '找不到样式 ' + args.styleId)
  } else if (typeof args.styleName === 'string' && args.styleName.length > 0) {
    const all = await localStyleNodes()
    const wanted = args.styleName.toLowerCase()
    const candidates = all.paint.concat(all.text, all.effect, all.grid)
    style = candidates.find(function (item) { return item.name === args.styleName }) || candidates.find(function (item) { return item.name.toLowerCase().indexOf(wanted) >= 0 }) || null
    if (!style) throw pluginError('node-not-found', '找不到样式 ' + args.styleName)
  } else {
    throw invalidOp('必须提供 styleId 或 styleName')
  }

  const target = typeof args.target === 'string' ? args.target.toLowerCase() : 'auto'
  // Linking styles through the async style-id setters is not reliable in every
  // Figma build (some routes stall for 10s on a backend lookup). Value mode is
  // the default; callers can opt into linking with link:true.
  if (args.link === false) {
    return await applyStyleByValue(node, style, target)
  }

  await loadAllPagesOnce()

  if (args.clear === true) {
    if (style.type === 'PAINT') {
      if (hasProperty(node, 'fillStyleId') && (target === 'auto' || target === 'fill')) await assignNodeStyle(node, 'fill', '')
      else if (hasProperty(node, 'strokeStyleId') && (target === 'auto' || target === 'stroke')) await assignNodeStyle(node, 'stroke', '')
    } else if (style.type === 'TEXT') await assignNodeStyle(node, 'text', '')
    else if (style.type === 'EFFECT') await assignNodeStyle(node, 'effect', '')
    return { ok: true, node: { id: node.id, name: node.name }, style: { id: style.id, name: style.name, type: style.type }, cleared: true }
  }

  // Dynamic-page style setters can need the style (and, for text, its font)
  // loaded before the async assignment. Without this Figma may spend 10s
  // trying to reach its backend and then report a connection error.
  try {
    if (style.type === 'TEXT' && style.fontName) await figma.loadFontAsync(style.fontName)
  } catch (_ignored) {
    /* proceed and let the setter report a precise failure */
  }

  if (style.type === 'PAINT') {
    if (target === 'stroke' || (target === 'auto' && hasProperty(node, 'strokeStyleId') && !hasProperty(node, 'fillStyleId'))) {
      if (!hasProperty(node, 'strokeStyleId')) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持描边样式')
      await assignNodeStyle(node, 'stroke', style.id)
    } else {
      if (!hasProperty(node, 'fillStyleId')) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持填充样式')
      await assignNodeStyle(node, 'fill', style.id)
    }
  } else if (style.type === 'TEXT') {
    if (!hasProperty(node, 'textStyleId')) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持文本样式')
    await assignNodeStyle(node, 'text', style.id)
  } else if (style.type === 'EFFECT') {
    if (!hasProperty(node, 'effectStyleId')) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持效果样式')
    await assignNodeStyle(node, 'effect', style.id)
  } else {
    throw pluginError('unsupported', '样式类型 ' + style.type + ' 暂不支持应用')
  }
  return { ok: true, node: { id: node.id, name: node.name }, style: { id: style.id, name: style.name, type: style.type }, target: target }
}

async function variablesCommand(args) {
  if (!figma.variables) throw pluginError('unsupported', '当前 Figma 版本/文件不支持 Variables')
  const action = typeof args.action === 'string' ? args.action : 'list'
  if (action === 'list') {
    const data = await localVariableSummary(typeof args.query === 'string' ? args.query.toLowerCase() : '', [])
    return { ok: true, collections: data.collections, variables: data.variables }
  }
  if (action === 'create') {
    const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : ''
    if (!name) throw invalidOp('create 变量必须提供 name')
    const resolvedType = normalizeResolvedType(args.resolvedType)
    const collection = await findOrCreateCollection(args)
    let variable = null
    try {
      variable = figma.variables.createVariable(name, collection, resolvedType)
    } catch (error) {
      throw pluginError('figma-error', '创建变量失败：' + errorMessage(error))
    }
    const modeId = typeof args.modeId === 'string' && args.modeId.length > 0 ? args.modeId : collection.defaultModeId
    variable.setValueForMode(modeId, parseVariableValue(resolvedType, args.value))
    if (typeof args.description === 'string') variable.description = args.description
    return {
      ok: true,
      variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType, collectionId: collection.id, collectionName: collection.name, modeId: modeId, value: formatVariableValue(resolvedType, args.value) },
      collection: { id: collection.id, name: collection.name, defaultModeId: collection.defaultModeId },
    }
  }
  if (action === 'set') {
    const variable = await resolveVariableOrThrow(args)
    const collections = await figma.variables.getLocalVariableCollectionsAsync()
    const collection = collections.find(function (item) { return item.id === variable.variableCollectionId })
    const modeId = typeof args.modeId === 'string' && args.modeId.length > 0 ? args.modeId : (collection ? collection.defaultModeId : null)
    if (!modeId) throw invalidOp('找不到变量的 modeId')
    variable.setValueForMode(modeId, parseVariableValue(variable.resolvedType, args.value))
    return { ok: true, variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType }, modeId: modeId, value: formatVariableValue(variable.resolvedType, args.value) }
  }
  if (action === 'bind') {
    const variable = await resolveVariableOrThrow(args)
    const node = await resolveNodeOrThrow(args.nodeId, 0)
    const field = typeof args.field === 'string' && args.field.length > 0 ? args.field : 'fill'
    if (field === 'fill' || field === 'stroke') {
      const key = field === 'fill' ? 'fills' : 'strokes'
      if (!hasProperty(node, key)) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持 ' + field)
      const paints = Array.isArray(node[key]) ? node[key].slice() : []
      const base = paints[0] && paints[0].type === 'SOLID' ? paints[0] : { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }
      paints[0] = figma.variables.setBoundVariableForPaint(base, 'color', variable)
      node[key] = paints
    } else {
      if (typeof node.setBoundVariable !== 'function') throw pluginError('unsupported', '节点 ' + node.type + ' 不支持变量绑定')
      try {
        node.setBoundVariable(field, variable)
      } catch (error) {
        throw pluginError('unsupported', '字段 ' + field + ' 不支持绑定变量：' + errorMessage(error))
      }
    }
    return { ok: true, node: { id: node.id, name: node.name, type: node.type }, variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType }, field: field }
  }
  throw invalidOp('action 必须是 list / create / set / bind')
}

function normalizeResolvedType(value) {
  const type = typeof value === 'string' ? value.toUpperCase() : 'COLOR'
  if (['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'].indexOf(type) < 0) throw invalidOp('resolvedType 必须是 COLOR / FLOAT / STRING / BOOLEAN')
  return type
}

async function selectCommand(args) {
  if (!Array.isArray(args.nodeIds)) throw invalidOp('nodeIds 必须是字符串数组')
  const nodes = []
  for (const id of args.nodeIds) {
    if (typeof id !== 'string' || id.length === 0) throw invalidOp('nodeIds 必须是非空字符串数组')
    let node = null
    try {
      node = await figma.getNodeByIdAsync(id)
    } catch (error) {
      throw pluginError('figma-error', '读取节点失败：' + errorMessage(error))
    }
    if (!node) throw pluginError('node-not-found', '找不到节点 ' + id)
    nodes.push(node)
  }
  try {
    figma.currentPage.selection = nodes
  } catch (error) {
    throw pluginError('figma-error', '设置选区失败：' + errorMessage(error))
  }
  return {
    ok: true,
    selection: nodes.map(function (node) {
      return node.id
    }),
  }
}

async function exportNodeBytes(node, format, scale) {
  const options = { format: format }
  if (format === 'PNG') options.constraint = { type: 'SCALE', value: scale }
  try {
    return await node.exportAsync(options)
  } catch (error) {
    throw pluginError('figma-error', '导出节点 ' + node.id + ' 失败：' + errorMessage(error))
  }
}

function encodeBase64(bytes) {
  try {
    return figma.base64Encode(bytes)
  } catch (error) {
    throw pluginError('figma-error', 'base64 编码失败：' + errorMessage(error))
  }
}

// --------------------------------------------------------------- ops: apply

async function applyCommand(args) {
  if (!Array.isArray(args.ops) || args.ops.length === 0) throw invalidOp('ops 必须是非空数组')

  let operationId = null
  if (args.operationId !== undefined && args.operationId !== null) {
    if (typeof args.operationId !== 'string' || args.operationId.length === 0) {
      throw invalidOp('operationId 必须是非空字符串')
    }
    operationId = args.operationId
  }

  if (operationId !== null && operationCache.has(operationId)) {
    // Same operation id submitted again: return the first result, do not re-run.
    return operationCache.get(operationId)
  }

  const dryRun = args.dryRun === true
  const result = dryRun ? buildPlan(args.ops) : await executeOps(args.ops, args.atomic === true)

  if (!dryRun && result && result.ok === true) result.operationId = operationId

  if (operationId !== null) {
    operationCache.set(operationId, result)
    while (operationCache.size > MAX_OPERATION_CACHE) {
      const oldestKey = operationCache.keys().next().value
      operationCache.delete(oldestKey)
    }
  }
  return result
}

function buildPlan(ops) {
  const plan = { willCreate: 0, willUpdate: 0, willDelete: 0, willGroup: 0, ops: [] }
  for (let index = 0; index < ops.length; index++) {
    let op = null
    try {
      op = normalizeOp(ops[index], index)
    } catch (error) {
      return { ok: false, error: errorPayload(error, index), applied: [] }
    }
    plan.ops.push({ opIndex: index, op: op.op, description: describeOp(op) })
    countPlanOp(op, plan)
  }
  return { ok: true, dryRun: true, plan: plan, warnings: [] }
}

function countPlanOp(op, plan) {
  if (op.op === 'create') {
    plan.willCreate += 1
    const children = op.children || []
    for (const child of children) countPlanOp(child, plan)
  } else if (op.op === 'update') {
    plan.willUpdate += 1
  } else if (op.op === 'delete') {
    plan.willDelete += 1
  } else if (op.op === 'group') {
    plan.willGroup += 1
  }
}

function describeOp(op) {
  switch (op.op) {
    case 'create': {
      let suffix = ''
      const total = countCreateTree(op)
      if (total > 1) suffix = '，含 ' + (total - 1) + ' 个嵌套节点'
      return 'create ' + op.type + (op.name ? ' "' + op.name + '"' : '') + suffix
    }
    case 'update':
      return 'update ' + op.nodeId + '（' + Object.keys(op.patch).join(', ') + '）'
    case 'move':
      return 'move ' + op.nodeId + ' → ' + op.parentId + (op.index !== undefined ? ' @' + op.index : '')
    case 'reorder':
      return 'reorder ' + op.nodeId + ' @' + op.index
    case 'clone':
      return 'clone ' + op.nodeId
    case 'group':
      return 'group ' + op.nodeIds.join(', ')
    case 'delete':
      return 'delete ' + op.nodeId
    case 'select':
      return 'select ' + op.nodeIds.join(', ')
    default:
      return String(op.op)
  }
}

function countCreateTree(op) {
  let total = 1
  const children = op.children || []
  for (const child of children) total += countCreateTree(child)
  return total
}

async function executeOps(ops, atomic) {
  const ctx = {
    atomic: atomic === true,
    applied: [],
    created: [],
    updated: [],
    deleted: [],
    warnings: [],
    undo: [],
    initialSelection: null,
  }
  if (ctx.atomic) {
    try {
      ctx.initialSelection = currentSelection().slice()
    } catch (_ignored) {
      ctx.initialSelection = []
    }
  }

  for (let index = 0; index < ops.length; index++) {
    try {
      const op = normalizeOp(ops[index], index)
      const entry = await executeSingle(op, index, ctx)
      if (entry) ctx.applied.push(entry)
    } catch (error) {
      let uncertain = false
      if (ctx.atomic) uncertain = await rollback(ctx)
      const failure = {
        ok: false,
        error: errorPayload(error, index),
        applied: ctx.applied.slice(),
      }
      if (uncertain) failure.uncertain = true
      return failure
    }
  }

  return {
    ok: true,
    dryRun: false,
    applied: ctx.applied,
    created: ctx.created,
    updated: ctx.updated,
    deleted: ctx.deleted,
    warnings: ctx.warnings,
  }
}

async function executeSingle(op, opIndex, ctx) {
  switch (op.op) {
    case 'create': {
      const node = await createNodeRecursive(op, opIndex, ctx)
      return {
        opIndex: opIndex,
        op: 'create',
        nodeId: node.id,
        name: node.name,
        type: node.type,
      }
    }
    case 'update':
      return applyUpdate(op, opIndex, ctx)
    case 'move':
      return applyMove(op, opIndex, ctx)
    case 'reorder':
      return applyReorder(op, opIndex, ctx)
    case 'clone':
      return applyClone(op, opIndex, ctx)
    case 'group':
      return applyGroup(op, opIndex, ctx)
    case 'delete':
      return applyDelete(op, opIndex, ctx)
    case 'select':
      return applySelect(op, opIndex, ctx)
    default:
      throw invalidOp('未知 op：' + String(op.op), opIndex)
  }
}

// ------------------------------------------------------- ops: normalization

function normalizeOp(rawOp, opIndex) {
  if (!rawOp || typeof rawOp !== 'object' || Array.isArray(rawOp)) {
    throw invalidOp('op 必须是对象', opIndex)
  }
  switch (rawOp.op) {
    case 'create':
      return normalizeCreate(rawOp, opIndex)
    case 'update': {
      const nodeId = requireNodeId(rawOp.nodeId, opIndex, 'nodeId')
      if (!rawOp.patch || typeof rawOp.patch !== 'object' || Array.isArray(rawOp.patch)) {
        throw invalidOp('update 缺少 patch 对象', opIndex)
      }
      return { op: 'update', nodeId: nodeId, patch: normalizeNodeFields(rawOp.patch, opIndex) }
    }
    case 'move': {
      const nodeId = requireNodeId(rawOp.nodeId, opIndex, 'nodeId')
      const parentId = requireNodeId(rawOp.parentId, opIndex, 'parentId')
      const op = { op: 'move', nodeId: nodeId, parentId: parentId }
      if (rawOp.index !== undefined && rawOp.index !== null) op.index = requireIndex(rawOp.index, opIndex, 'index')
      return op
    }
    case 'reorder': {
      const nodeId = requireNodeId(rawOp.nodeId, opIndex, 'nodeId')
      return { op: 'reorder', nodeId: nodeId, index: requireIndex(rawOp.index, opIndex, 'index') }
    }
    case 'clone': {
      const nodeId = requireNodeId(rawOp.nodeId, opIndex, 'nodeId')
      const op = { op: 'clone', nodeId: nodeId, deep: rawOp.deep !== false }
      if (rawOp.parentId !== undefined && rawOp.parentId !== null) {
        op.parentId = requireNodeId(rawOp.parentId, opIndex, 'parentId')
      }
      if (rawOp.x !== undefined) op.x = requireNumber(rawOp.x, 'x', opIndex)
      if (rawOp.y !== undefined) op.y = requireNumber(rawOp.y, 'y', opIndex)
      return op
    }
    case 'group': {
      if (!Array.isArray(rawOp.nodeIds) || rawOp.nodeIds.length === 0) {
        throw invalidOp('group 需要非空 nodeIds 数组', opIndex)
      }
      const nodeIds = []
      for (const id of rawOp.nodeIds) nodeIds.push(requireNodeId(id, opIndex, 'nodeIds'))
      const op = { op: 'group', nodeIds: nodeIds }
      if (rawOp.name !== undefined) {
        if (typeof rawOp.name !== 'string') throw invalidOp('group.name 必须是字符串', opIndex)
        op.name = rawOp.name
      }
      return op
    }
    case 'delete':
      return { op: 'delete', nodeId: requireNodeId(rawOp.nodeId, opIndex, 'nodeId') }
    case 'select': {
      if (!Array.isArray(rawOp.nodeIds)) throw invalidOp('select 需要 nodeIds 数组', opIndex)
      const nodeIds = []
      for (const id of rawOp.nodeIds) nodeIds.push(requireNodeId(id, opIndex, 'nodeIds'))
      return { op: 'select', nodeIds: nodeIds }
    }
    default:
      throw invalidOp('未知 op：' + String(rawOp.op), opIndex)
  }
}

function normalizeCreate(raw, opIndex) {
  const type = raw.type
  if (typeof type !== 'string' || type.length === 0) throw invalidOp('create 缺少 type', opIndex)
  if (!hasField(CREATE_FACTORIES, type)) throw invalidOp('不支持的节点类型：' + type, opIndex)

  const fields = normalizeNodeFields(raw, opIndex)
  const op = { op: 'create', type: type }
  if (raw.parentId !== undefined && raw.parentId !== null) {
    op.parentId = requireNodeId(raw.parentId, opIndex, 'parentId')
  }
  for (const key in fields) {
    if (hasField(fields, key)) op[key] = fields[key]
  }

  if (type === 'text') {
    if (op.text === undefined) op.text = {}
  } else if (op.text !== undefined) {
    throw invalidOp('text 字段仅适用于 text 节点', opIndex)
  }

  if (type === 'svg') {
    if (typeof raw.svg !== 'string' || raw.svg.trim().length === 0) {
      throw invalidOp('svg 类型必须提供非空 svg 源码', opIndex)
    }
    op.svg = raw.svg
  }

  op.children = []
  if (raw.children !== undefined && raw.children !== null) {
    if (!Array.isArray(raw.children)) throw invalidOp('children 必须是数组', opIndex)
    for (let childIndex = 0; childIndex < raw.children.length; childIndex++) {
      const rawChild = raw.children[childIndex]
      if (!rawChild || typeof rawChild !== 'object' || Array.isArray(rawChild)) {
        throw invalidOp('children[' + childIndex + '] 必须是 create op 对象', opIndex)
      }
      if (rawChild.op !== 'create') {
        throw invalidOp('children[' + childIndex + '] 必须是 create op', opIndex)
      }
      op.children.push(normalizeCreate(rawChild, opIndex))
    }
  }
  return op
}

function normalizeNodeFields(source, opIndex) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw invalidOp('节点字段必须是对象', opIndex)
  }
  const out = {}

  if (hasField(source, 'name')) {
    if (typeof source.name !== 'string') throw invalidOp('name 必须是字符串', opIndex)
    out.name = source.name
  }
  if (hasField(source, 'x')) out.x = requireNumber(source.x, 'x', opIndex)
  if (hasField(source, 'y')) out.y = requireNumber(source.y, 'y', opIndex)
  if (hasField(source, 'width')) out.width = requireNumber(source.width, 'width', opIndex, 1)
  if (hasField(source, 'height')) out.height = requireNumber(source.height, 'height', opIndex, 1)
  if (hasField(source, 'fill')) out.fill = normalizeColorField(source.fill, 'fill', opIndex)
  if (hasField(source, 'stroke')) out.stroke = normalizeColorField(source.stroke, 'stroke', opIndex)
  if (hasField(source, 'strokeWidth')) {
    out.strokeWidth = requireNumber(source.strokeWidth, 'strokeWidth', opIndex, 0)
  }
  if (hasField(source, 'radius')) out.radius = normalizeRadius(source.radius, opIndex)
  if (hasField(source, 'opacity')) {
    const value = requireNumber(source.opacity, 'opacity', opIndex, 0)
    if (value > 1) throw invalidOp('opacity 必须在 0–1 之间', opIndex)
    out.opacity = value
  }
  if (hasField(source, 'visible')) {
    if (typeof source.visible !== 'boolean') throw invalidOp('visible 必须是布尔值', opIndex)
    out.visible = source.visible
  }
  if (hasField(source, 'locked')) {
    if (typeof source.locked !== 'boolean') throw invalidOp('locked 必须是布尔值', opIndex)
    out.locked = source.locked
  }
  if (hasField(source, 'rotation')) out.rotation = requireNumber(source.rotation, 'rotation', opIndex)
  if (hasField(source, 'layout')) {
    out.layout = source.layout === null ? null : normalizeLayout(source.layout, opIndex)
  }
  if (hasField(source, 'effects')) out.effects = normalizeEffects(source.effects, opIndex)
  if (hasField(source, 'text')) out.text = normalizeText(source.text, opIndex)

  return out
}

function requireNumber(value, label, opIndex, min) {
  if (typeof value !== 'number' || !isFinite(value)) {
    throw invalidOp(label + ' 必须是有限数字', opIndex)
  }
  if (min !== undefined && value < min) {
    throw invalidOp(label + ' 必须 >= ' + min, opIndex)
  }
  return value
}

function requireNodeId(value, opIndex, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidOp((label || 'nodeId') + ' 必须是非空字符串', opIndex)
  }
  return value
}

function requireIndex(value, opIndex, label) {
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value < 0) {
    throw invalidOp((label || 'index') + ' 必须是非负整数', opIndex)
  }
  return value
}

function normalizeColorField(value, label, opIndex) {
  if (value === null) return null
  if (typeof value !== 'string') throw invalidOp(label + ' 必须是十六进制颜色字符串或 null', opIndex)
  const parsed = parseHexColor(value)
  if (!parsed) throw invalidOp(label + ' 不是合法的十六进制颜色：' + value, opIndex)
  return value
}

function normalizeRadius(value, opIndex) {
  if (typeof value === 'number') return requireNumber(value, 'radius', opIndex, 0)
  if (Array.isArray(value)) {
    if (value.length !== 4) throw invalidOp('radius 数组长度必须是 4（左上/右上/右下/左下）', opIndex)
    const out = []
    for (const item of value) out.push(requireNumber(item, 'radius[i]', opIndex, 0))
    return out
  }
  throw invalidOp('radius 必须是数字或长度为 4 的数字数组', opIndex)
}

function normalizeLayout(layout, opIndex) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    throw invalidOp('layout 必须是对象或 null', opIndex)
  }
  if (layout.mode !== 'HORIZONTAL' && layout.mode !== 'VERTICAL') {
    throw invalidOp('layout.mode 必须是 HORIZONTAL 或 VERTICAL', opIndex)
  }
  const out = { mode: layout.mode }
  if (hasField(layout, 'itemSpacing') && layout.itemSpacing !== null && layout.itemSpacing !== undefined) {
    // Figma allows negative itemSpacing (overlap); only require a finite number.
    out.itemSpacing = requireNumber(layout.itemSpacing, 'layout.itemSpacing', opIndex)
  }
  if (hasField(layout, 'padding') && layout.padding !== null && layout.padding !== undefined) {
    out.padding = normalizePadding(layout.padding, opIndex)
  }
  if (hasField(layout, 'primaryAxisAlign') && layout.primaryAxisAlign !== null && layout.primaryAxisAlign !== undefined) {
    if (PRIMARY_ALIGNS.indexOf(layout.primaryAxisAlign) < 0) {
      throw invalidOp('layout.primaryAxisAlign 必须是 ' + PRIMARY_ALIGNS.join('/'), opIndex)
    }
    out.primaryAxisAlign = layout.primaryAxisAlign
  }
  if (hasField(layout, 'counterAxisAlign') && layout.counterAxisAlign !== null && layout.counterAxisAlign !== undefined) {
    if (COUNTER_ALIGNS.indexOf(layout.counterAxisAlign) < 0) {
      throw invalidOp('layout.counterAxisAlign 必须是 ' + COUNTER_ALIGNS.join('/'), opIndex)
    }
    out.counterAxisAlign = layout.counterAxisAlign
  }
  if (hasField(layout, 'wrap') && layout.wrap !== null && layout.wrap !== undefined) {
    if (WRAP_MODES.indexOf(layout.wrap) < 0) {
      throw invalidOp('layout.wrap 必须是 ' + WRAP_MODES.join('/'), opIndex)
    }
    out.wrap = layout.wrap
  }
  return out
}

function normalizePadding(value, opIndex) {
  if (typeof value === 'number') {
    const sides = requireNumber(value, 'layout.padding', opIndex, 0)
    return { top: sides, right: sides, bottom: sides, left: sides }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidOp('layout.padding 必须是数字或 {top,right,bottom,left} 对象', opIndex)
  }
  const out = { top: 0, right: 0, bottom: 0, left: 0 }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    if (hasField(value, side) && value[side] !== undefined && value[side] !== null) {
      out[side] = requireNumber(value[side], 'layout.padding.' + side, opIndex, 0)
    }
  }
  return out
}

function normalizeText(text, opIndex) {
  if (!text || typeof text !== 'object' || Array.isArray(text)) {
    throw invalidOp('text 必须是对象', opIndex)
  }
  const out = {}
  if (hasField(text, 'characters')) {
    if (typeof text.characters !== 'string') throw invalidOp('text.characters 必须是字符串', opIndex)
    out.characters = text.characters
  }
  if (hasField(text, 'font') && text.font !== null && text.font !== undefined) {
    if (!text.font || typeof text.font !== 'object' || Array.isArray(text.font)) {
      throw invalidOp('text.font 必须是 {family,style} 对象', opIndex)
    }
    if (typeof text.font.family !== 'string' || text.font.family.length === 0) {
      throw invalidOp('text.font.family 必须是非空字符串', opIndex)
    }
    if (typeof text.font.style !== 'string' || text.font.style.length === 0) {
      throw invalidOp('text.font.style 必须是非空字符串', opIndex)
    }
    out.font = { family: text.font.family, style: text.font.style }
  }
  if (hasField(text, 'fontSize') && text.fontSize !== undefined && text.fontSize !== null) {
    const value = requireNumber(text.fontSize, 'text.fontSize', opIndex, 0)
    if (value <= 0) throw invalidOp('text.fontSize 必须 > 0', opIndex)
    out.fontSize = value
  }
  if (hasField(text, 'align') && text.align !== undefined && text.align !== null) {
    if (TEXT_ALIGNS.indexOf(text.align) < 0) throw invalidOp('text.align 必须是 ' + TEXT_ALIGNS.join('/'), opIndex)
    out.align = text.align
  }
  if (hasField(text, 'lineHeight') && text.lineHeight !== undefined && text.lineHeight !== null) {
    out.lineHeight = normalizeMetric(text.lineHeight, 'text.lineHeight', opIndex, 0)
  }
  if (hasField(text, 'letterSpacing') && text.letterSpacing !== undefined && text.letterSpacing !== null) {
    // Figma allows negative letterSpacing (tighter tracking).
    out.letterSpacing = normalizeMetric(text.letterSpacing, 'text.letterSpacing', opIndex)
  }
  if (hasField(text, 'textAutoResize') && text.textAutoResize !== undefined && text.textAutoResize !== null) {
    if (TEXT_AUTO_RESIZE_MODES.indexOf(text.textAutoResize) < 0) {
      throw invalidOp('text.textAutoResize 必须是 ' + TEXT_AUTO_RESIZE_MODES.join('/'), opIndex)
    }
    out.textAutoResize = text.textAutoResize
  }
  return out
}

function normalizeMetric(value, label, opIndex, min) {
  if (typeof value === 'number') {
    const number = requireNumber(value, label, opIndex, min)
    return { unit: 'PIXELS', value: number }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidOp(label + ' 必须是数字或 {unit,value} 对象', opIndex)
  }
  if (LINE_HEIGHT_UNITS.indexOf(value.unit) < 0) {
    throw invalidOp(label + '.unit 必须是 ' + LINE_HEIGHT_UNITS.join('/'), opIndex)
  }
  return { unit: value.unit, value: requireNumber(value.value, label + '.value', opIndex, min) }
}

function normalizeEffects(effects, opIndex) {
  if (!Array.isArray(effects)) throw invalidOp('effects 必须是数组', opIndex)
  const out = []
  for (let index = 0; index < effects.length; index++) {
    const effect = effects[index]
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
      throw invalidOp('effects[' + index + '] 必须是对象', opIndex)
    }
    if (EFFECT_TYPES.indexOf(effect.type) < 0) {
      throw invalidOp('effects[' + index + '].type 必须是 ' + EFFECT_TYPES.join('/'), opIndex)
    }
    const normalized = { type: effect.type }
    if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
      if (hasField(effect, 'color') && effect.color !== null && effect.color !== undefined) {
        if (typeof effect.color !== 'string') {
          throw invalidOp('effects[' + index + '].color 必须是十六进制颜色字符串', opIndex)
        }
        const parsed = parseHexColor(effect.color)
        if (!parsed) throw invalidOp('effects[' + index + '].color 不是合法颜色：' + effect.color, opIndex)
        normalized.color = { r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a }
      }
      if (hasField(effect, 'offset') && effect.offset !== null && effect.offset !== undefined) {
        if (typeof effect.offset !== 'object' || Array.isArray(effect.offset)) {
          throw invalidOp('effects[' + index + '].offset 必须是 {x,y}', opIndex)
        }
        normalized.offset = {
          x: requireNumber(effect.offset.x, 'effects.offset.x', opIndex),
          y: requireNumber(effect.offset.y, 'effects.offset.y', opIndex),
        }
      }
      if (hasField(effect, 'radius') && effect.radius !== undefined && effect.radius !== null) {
        normalized.radius = requireNumber(effect.radius, 'effects.radius', opIndex, 0)
      }
      if (hasField(effect, 'spread') && effect.spread !== undefined && effect.spread !== null) {
        normalized.spread = requireNumber(effect.spread, 'effects.spread', opIndex)
      }
      if (hasField(effect, 'visible') && effect.visible !== undefined) {
        if (typeof effect.visible !== 'boolean') throw invalidOp('effects[' + index + '].visible 必须是布尔值', opIndex)
        normalized.visible = effect.visible
      }
    } else {
      if (hasField(effect, 'radius') && effect.radius !== undefined && effect.radius !== null) {
        normalized.radius = requireNumber(effect.radius, 'effects.radius', opIndex, 0)
      }
      if (hasField(effect, 'visible') && effect.visible !== undefined) {
        if (typeof effect.visible !== 'boolean') throw invalidOp('effects[' + index + '].visible 必须是布尔值', opIndex)
        normalized.visible = effect.visible
      }
    }
    out.push(normalized)
  }
  return out
}

// ------------------------------------------------------- ops: node creation

async function createNodeRecursive(op, opIndex, ctx) {
  const type = op.type
  const factory = CREATE_FACTORIES[type]
  if (!factory) throw invalidOp('不支持的节点类型：' + String(type), opIndex)

  const parent = await resolveParent(op.parentId, opIndex)

  let font = null
  if (type === 'text') {
    const text = op.text && typeof op.text === 'object' ? op.text : {}
    font = await loadFont(text.font || DEFAULT_FONT)
  }

  let node = null
  try {
    if (type === 'svg') node = figma.createNodeFromSvg(op.svg)
    else node = figma[factory]()
  } catch (error) {
    throw pluginError('figma-error', '创建 ' + type + ' 节点失败：' + errorMessage(error), opIndex)
  }
  if (!node || typeof node !== 'object') {
    throw pluginError('figma-error', '创建 ' + type + ' 节点失败：Figma 未返回节点', opIndex)
  }

  // Requirement: append first, then set x/y so the coordinate system is the
  // parent's (relative for frames, absolute for pages). Text characters also
  // require the node to exist and the font to be loaded.
  try {
    parent.appendChild(node)
  } catch (error) {
    throw pluginError('figma-error', '挂载 ' + type + ' 节点失败：' + errorMessage(error), opIndex)
  }

  const createdEntry = { opIndex: opIndex, nodeId: node.id, name: node.name, type: node.type }
  ctx.created.push(createdEntry)

  applyCreateFields(node, op, font, ctx, opIndex)

  createdEntry.name = node.name
  createdEntry.type = node.type

  if (op.children && op.children.length > 0) {
    for (let childIndex = 0; childIndex < op.children.length; childIndex++) {
      const childOp = shallowCopy(op.children[childIndex])
      if (childOp.parentId !== undefined) {
        ctx.warnings.push('create.children[' + childIndex + '] 的 parentId 已忽略：子节点始终挂到新创建的父节点下')
      }
      childOp.parentId = node.id
      await createNodeRecursive(childOp, opIndex, ctx)
    }
  }

  return node
}

function applyCreateFields(node, op, font, ctx, opIndex) {
  const warnings = ctx.warnings

  if (op.name !== undefined) node.name = op.name

  if (op.type === 'text') applyTextCreate(node, op.text || {}, font)

  if (op.width !== undefined || op.height !== undefined) {
    if (typeof node.resize === 'function') {
      const width = op.width !== undefined ? op.width : typeof node.width === 'number' ? node.width : 100
      const height = op.height !== undefined ? op.height : typeof node.height === 'number' ? node.height : 100
      try {
        node.resize(width, height)
      } catch (error) {
        throw pluginError('figma-error', '调整节点尺寸失败：' + errorMessage(error), opIndex)
      }
    } else {
      warnings.push('节点 ' + node.type + ' 不支持 resize，已忽略 width/height')
    }
  }

  if (op.x !== undefined) assignCreateField(node, 'x', op.x, 'x', warnings)
  if (op.y !== undefined) assignCreateField(node, 'y', op.y, 'y', warnings)

  if (op.fill !== undefined) {
    if (hasProperty(node, 'fills')) node.fills = colorValueToPaints(op.fill, opIndex, 'fill')
    else warnings.push('节点 ' + node.type + ' 不支持 fill，已忽略')
  }
  if (op.stroke !== undefined) {
    if (hasProperty(node, 'strokes')) node.strokes = colorValueToPaints(op.stroke, opIndex, 'stroke')
    else warnings.push('节点 ' + node.type + ' 不支持 stroke，已忽略')
  }
  if (op.strokeWidth !== undefined) {
    if (op.strokeWidth === 0) {
      if (hasProperty(node, 'strokes')) node.strokes = []
      else warnings.push('节点 ' + node.type + ' 不支持 stroke，已忽略')
    } else if (hasProperty(node, 'strokeWeight')) {
      node.strokeWeight = op.strokeWidth
    } else {
      warnings.push('节点 ' + node.type + ' 不支持 strokeWidth，已忽略')
    }
  }

  if (op.radius !== undefined) {
    if (!writeRadius(node, op.radius)) warnings.push('节点 ' + node.type + ' 不支持 radius，已忽略')
  }

  if (op.opacity !== undefined) assignCreateField(node, 'opacity', op.opacity, 'opacity', warnings)
  if (op.visible !== undefined) assignCreateField(node, 'visible', op.visible, 'visible', warnings)
  if (op.locked !== undefined) assignCreateField(node, 'locked', op.locked, 'locked', warnings)
  if (op.rotation !== undefined) assignCreateField(node, 'rotation', op.rotation, 'rotation', warnings)

  if (op.effects !== undefined) {
    if (hasProperty(node, 'effects')) node.effects = cloneData(op.effects)
    else warnings.push('节点 ' + node.type + ' 不支持 effects，已忽略')
  }

  if (op.layout !== undefined) {
    if (hasProperty(node, 'layoutMode')) applyLayout(node, op.layout)
    else warnings.push('节点 ' + node.type + ' 不支持 auto layout，已忽略 layout')
  }
}

function assignCreateField(node, key, value, label, warnings) {
  if (!hasProperty(node, key)) {
    warnings.push('节点 ' + node.type + ' 不支持 ' + label + '，已忽略')
    return
  }
  node[key] = value
}

function applyTextCreate(node, text, font) {
  if (font) node.fontName = { family: font.family, style: font.style }
  if (text.characters !== undefined) node.characters = text.characters
  if (text.fontSize !== undefined) node.fontSize = text.fontSize
  if (text.align !== undefined) node.textAlignHorizontal = text.align
  if (text.lineHeight !== undefined) node.lineHeight = cloneData(text.lineHeight)
  if (text.letterSpacing !== undefined) node.letterSpacing = cloneData(text.letterSpacing)
  if (text.textAutoResize !== undefined) node.textAutoResize = text.textAutoResize
}

// -------------------------------------------------------- ops: update/move...

async function applyUpdate(op, opIndex, ctx) {
  const node = await resolveNodeOrThrow(op.nodeId, opIndex)
  if (op.patch.text !== undefined && node.type !== 'TEXT') {
    throw invalidOp('text 字段仅适用于 TEXT 节点', opIndex)
  }
  let font = null
  if (op.patch.text) {
    if (op.patch.text.font) {
      font = await loadFont(op.patch.text.font)
    } else {
      const currentFont = readFont(node)
      if (currentFont) font = await loadFont(currentFont)
    }
  }
  const outcome = applyPatchToNode(node, op.patch, ctx, font, opIndex)
  ctx.updated.push({
    opIndex: opIndex,
    nodeId: node.id,
    name: node.name,
    changes: outcome.changedFields,
  })
  return {
    opIndex: opIndex,
    op: 'update',
    nodeId: node.id,
    name: node.name,
    type: node.type,
    changes: outcome.changes,
  }
}

function applyPatchToNode(node, patch, ctx, font, opIndex) {
  const changes = {}
  const changedFields = []

  function note(field, fromValue, toValue) {
    changes[field] = { from: fromValue, to: toValue }
  }

  function assertProperty(key, label) {
    if (!hasProperty(node, key)) {
      throw pluginError('unsupported', '节点 ' + node.type + ' 不支持 ' + label, opIndex)
    }
  }

  if (hasField(patch, 'name')) {
    const oldValue = node.name
    pushRestore(ctx, function () {
      node.name = oldValue
    })
    node.name = patch.name
    note('name', oldValue, patch.name)
    changedFields.push('name')
  }

  if (patch.text) applyTextPatch(node, patch.text, ctx, note, changedFields)

  if (hasField(patch, 'x')) {
    assertProperty('x', 'x')
    const oldValue = node.x
    pushRestore(ctx, function () {
      node.x = oldValue
    })
    node.x = patch.x
    note('x', oldValue, patch.x)
    changedFields.push('x')
  }
  if (hasField(patch, 'y')) {
    assertProperty('y', 'y')
    const oldValue = node.y
    pushRestore(ctx, function () {
      node.y = oldValue
    })
    node.y = patch.y
    note('y', oldValue, patch.y)
    changedFields.push('y')
  }

  if (hasField(patch, 'width') || hasField(patch, 'height')) {
    if (typeof node.resize !== 'function') throw pluginError('unsupported', '节点 ' + node.type + ' 不支持 resize', opIndex)
    const oldWidth = node.width
    const oldHeight = node.height
    const width = hasField(patch, 'width') ? patch.width : oldWidth
    const height = hasField(patch, 'height') ? patch.height : oldHeight
    pushRestore(ctx, function () {
      node.resize(oldWidth, oldHeight)
    })
    try {
      node.resize(width, height)
    } catch (error) {
      throw pluginError('figma-error', '调整节点尺寸失败：' + errorMessage(error), opIndex)
    }
    if (hasField(patch, 'width')) {
      note('width', oldWidth, width)
      changedFields.push('width')
    }
    if (hasField(patch, 'height')) {
      note('height', oldHeight, height)
      changedFields.push('height')
    }
  }

  if (hasField(patch, 'fill')) {
    assertProperty('fills', 'fill')
    const oldRaw = cloneData(node.fills)
    const oldValue = summarizeFillValue(node.fills)
    pushRestore(ctx, function () {
      node.fills = cloneData(oldRaw)
    })
    node.fills = colorValueToPaints(patch.fill, opIndex, 'fill')
    note('fill', oldValue, patch.fill)
    changedFields.push('fill')
  }

  if (hasField(patch, 'stroke')) {
    assertProperty('strokes', 'stroke')
    const oldRaw = cloneData(node.strokes)
    const oldValue = summarizeFillValue(node.strokes)
    pushRestore(ctx, function () {
      node.strokes = cloneData(oldRaw)
    })
    node.strokes = colorValueToPaints(patch.stroke, opIndex, 'stroke')
    note('stroke', oldValue, patch.stroke)
    changedFields.push('stroke')
  }

  if (hasField(patch, 'strokeWidth')) {
    const oldEffective = Array.isArray(node.strokes) && node.strokes.length > 0 ? node.strokeWeight : 0
    if (patch.strokeWidth === 0) {
      assertProperty('strokes', 'strokeWidth')
      const oldStrokes = cloneData(node.strokes)
      pushRestore(ctx, function () {
        node.strokes = cloneData(oldStrokes)
      })
      node.strokes = []
    } else {
      assertProperty('strokeWeight', 'strokeWidth')
      const oldWeight = node.strokeWeight
      pushRestore(ctx, function () {
        node.strokeWeight = oldWeight
      })
      node.strokeWeight = patch.strokeWidth
    }
    note('strokeWidth', oldEffective, patch.strokeWidth)
    changedFields.push('strokeWidth')
  }

  if (hasField(patch, 'radius')) {
    if (!supportsRadius(node)) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持 radius', opIndex)
    const oldValue = readRadius(node)
    pushRestore(ctx, function () {
      restoreRadius(node, oldValue)
    })
    writeRadius(node, patch.radius)
    note('radius', oldValue, patch.radius)
    changedFields.push('radius')
  }

  if (hasField(patch, 'opacity')) {
    assertProperty('opacity', 'opacity')
    const oldValue = node.opacity
    pushRestore(ctx, function () {
      node.opacity = oldValue
    })
    node.opacity = patch.opacity
    note('opacity', oldValue, patch.opacity)
    changedFields.push('opacity')
  }
  if (hasField(patch, 'visible')) {
    assertProperty('visible', 'visible')
    const oldValue = node.visible
    pushRestore(ctx, function () {
      node.visible = oldValue
    })
    node.visible = patch.visible
    note('visible', oldValue, patch.visible)
    changedFields.push('visible')
  }
  if (hasField(patch, 'locked')) {
    assertProperty('locked', 'locked')
    const oldValue = node.locked
    pushRestore(ctx, function () {
      node.locked = oldValue
    })
    node.locked = patch.locked
    note('locked', oldValue, patch.locked)
    changedFields.push('locked')
  }
  if (hasField(patch, 'rotation')) {
    assertProperty('rotation', 'rotation')
    const oldValue = node.rotation
    pushRestore(ctx, function () {
      node.rotation = oldValue
    })
    node.rotation = patch.rotation
    note('rotation', oldValue, patch.rotation)
    changedFields.push('rotation')
  }

  if (hasField(patch, 'layout')) {
    if (!hasProperty(node, 'layoutMode')) throw pluginError('unsupported', '节点 ' + node.type + ' 不支持 auto layout', opIndex)
    const oldValue = layoutSummary(node)
    const oldRaw = captureLayout(node)
    pushRestore(ctx, function () {
      restoreLayout(node, oldRaw)
    })
    applyLayout(node, patch.layout)
    note('layout', oldValue, patch.layout === null ? null : cloneData(patch.layout))
    changedFields.push('layout')
  }

  if (hasField(patch, 'effects')) {
    assertProperty('effects', 'effects')
    const oldValue = cloneData(node.effects)
    pushRestore(ctx, function () {
      node.effects = cloneData(oldValue)
    })
    node.effects = cloneData(patch.effects)
    note('effects', oldValue, cloneData(patch.effects))
    changedFields.push('effects')
  }

  return { changes: changes, changedFields: changedFields }
}

function applyTextPatch(node, text, ctx, note, changedFields) {
  if (text.font !== undefined) {
    const oldValue = readFont(node)
    pushRestore(ctx, function () {
      if (oldValue) node.fontName = { family: oldValue.family, style: oldValue.style }
    })
    node.fontName = { family: text.font.family, style: text.font.style }
    note('text.font', oldValue, { family: text.font.family, style: text.font.style })
    changedFields.push('text.font')
  }
  if (hasField(text, 'characters')) {
    const oldValue = node.characters
    pushRestore(ctx, function () {
      node.characters = oldValue
    })
    node.characters = text.characters
    note('text.characters', oldValue, text.characters)
    changedFields.push('text.characters')
  }
  if (hasField(text, 'fontSize')) {
    const oldValue = node.fontSize
    pushRestore(ctx, function () {
      node.fontSize = oldValue
    })
    node.fontSize = text.fontSize
    note('text.fontSize', oldValue, text.fontSize)
    changedFields.push('text.fontSize')
  }
  if (hasField(text, 'align')) {
    const oldValue = node.textAlignHorizontal
    pushRestore(ctx, function () {
      node.textAlignHorizontal = oldValue
    })
    node.textAlignHorizontal = text.align
    note('text.align', oldValue, text.align)
    changedFields.push('text.align')
  }
  if (hasField(text, 'lineHeight')) {
    const oldValue = clonePlain(node.lineHeight)
    pushRestore(ctx, function () {
      node.lineHeight = clonePlain(oldValue)
    })
    node.lineHeight = cloneData(text.lineHeight)
    note('text.lineHeight', oldValue, cloneData(text.lineHeight))
    changedFields.push('text.lineHeight')
  }
  if (hasField(text, 'letterSpacing')) {
    const oldValue = clonePlain(node.letterSpacing)
    pushRestore(ctx, function () {
      node.letterSpacing = clonePlain(oldValue)
    })
    node.letterSpacing = cloneData(text.letterSpacing)
    note('text.letterSpacing', oldValue, cloneData(text.letterSpacing))
    changedFields.push('text.letterSpacing')
  }
  if (hasField(text, 'textAutoResize')) {
    const oldValue = node.textAutoResize
    pushRestore(ctx, function () {
      node.textAutoResize = oldValue
    })
    node.textAutoResize = text.textAutoResize
    note('text.textAutoResize', oldValue, text.textAutoResize)
    changedFields.push('text.textAutoResize')
  }
}

function pushRestore(ctx, restore) {
  if (ctx.atomic) ctx.undo.push(restore)
}

function captureLayout(node) {
  const snapshot = {}
  for (const key of LAYOUT_RAW_KEYS) {
    if (hasProperty(node, key)) snapshot[key] = node[key]
  }
  return snapshot
}

function restoreLayout(node, snapshot) {
  for (const key in snapshot) {
    if (hasField(snapshot, key) && hasProperty(node, key)) node[key] = snapshot[key]
  }
}

async function applyMove(op, opIndex, ctx) {
  const node = await resolveNodeOrThrow(op.nodeId, opIndex)
  const oldParent = node.parent || null
  const oldIndex = oldParent && Array.isArray(oldParent.children) ? oldParent.children.indexOf(node) : -1
  const parent = await resolveParent(op.parentId, opIndex)
  if (parent === node) throw invalidOp('不能把节点移动到它自己下面', opIndex)

  try {
    if (op.index !== undefined && typeof parent.insertChild === 'function') {
      parent.insertChild(op.index, node)
    } else {
      parent.appendChild(node)
    }
  } catch (error) {
    throw pluginError('figma-error', '移动节点失败：' + errorMessage(error), opIndex)
  }

  if (ctx.atomic) {
    ctx.undo.push(function () {
      if (!oldParent) return
      if (oldIndex >= 0 && typeof oldParent.insertChild === 'function') oldParent.insertChild(oldIndex, node)
      else if (typeof oldParent.appendChild === 'function') oldParent.appendChild(node)
    })
  }

  const newIndex = Array.isArray(parent.children) ? parent.children.indexOf(node) : -1
  return {
    opIndex: opIndex,
    op: 'move',
    nodeId: node.id,
    name: node.name,
    type: node.type,
    changes: {
      parentId: { from: oldParent ? oldParent.id : null, to: parent.id },
      index: { from: oldIndex, to: newIndex },
    },
  }
}

async function applyReorder(op, opIndex, ctx) {
  const node = await resolveNodeOrThrow(op.nodeId, opIndex)
  const parent = node.parent
  if (!parent || !Array.isArray(parent.children)) {
    throw pluginError('unsupported', '节点没有父级，无法 reorder', opIndex)
  }
  const children = parent.children
  const oldIndex = children.indexOf(node)
  if (oldIndex < 0) throw pluginError('node-not-found', '节点不在父级 children 中：' + node.id, opIndex)
  if (op.index > children.length - 1) {
    throw invalidOp('index ' + op.index + ' 超出父级子节点范围（0–' + (children.length - 1) + '）', opIndex)
  }
  if (oldIndex !== op.index) {
    if (typeof parent.insertChild !== 'function') {
      throw pluginError('unsupported', '父级不支持 insertChild，无法 reorder', opIndex)
    }
    try {
      parent.insertChild(op.index, node)
    } catch (error) {
      throw pluginError('figma-error', '重新排序失败：' + errorMessage(error), opIndex)
    }
    if (ctx.atomic) {
      ctx.undo.push(function () {
        parent.insertChild(oldIndex, node)
      })
    }
  }
  return {
    opIndex: opIndex,
    op: 'reorder',
    nodeId: node.id,
    name: node.name,
    type: node.type,
    changes: { index: { from: oldIndex, to: op.index } },
  }
}

async function applyClone(op, opIndex, ctx) {
  const source = await resolveNodeOrThrow(op.nodeId, opIndex)
  if (typeof source.clone !== 'function') {
    throw pluginError('unsupported', '节点 ' + source.type + ' 不支持 clone', opIndex)
  }
  let clone = null
  try {
    clone = source.clone()
  } catch (error) {
    throw pluginError('figma-error', '克隆节点失败：' + errorMessage(error), opIndex)
  }
  if (op.parentId !== undefined) {
    const parent = await resolveParent(op.parentId, opIndex)
    try {
      parent.appendChild(clone)
    } catch (error) {
      throw pluginError('figma-error', '挂载克隆节点失败：' + errorMessage(error), opIndex)
    }
  }
  if (op.x !== undefined) clone.x = op.x
  if (op.y !== undefined) clone.y = op.y

  const entry = {
    opIndex: opIndex,
    op: 'clone',
    nodeId: clone.id,
    name: clone.name,
    type: clone.type,
    changes: { sourceNodeId: source.id },
  }
  if (op.deep === false) {
    entry.warning = 'Figma clone() 仅支持深拷贝，deep:false 已按深拷贝执行'
    ctx.warnings.push(entry.warning)
  }
  ctx.created.push({ opIndex: opIndex, nodeId: clone.id, name: clone.name, type: clone.type })
  return entry
}

async function applyGroup(op, opIndex, ctx) {
  const nodes = []
  for (const id of op.nodeIds) nodes.push(await resolveNodeOrThrow(id, opIndex))
  const parent = nodes[0].parent
  if (!parent) throw pluginError('invalid-op', '节点没有父级，无法 group', opIndex)
  for (const node of nodes) {
    if (node.parent !== parent) throw invalidOp('group 要求所有节点在同一父级', opIndex)
  }
  if (typeof figma.group !== 'function') throw pluginError('unsupported', '当前 Figma 环境不支持 group()', opIndex)

  const insertIndex = Array.isArray(parent.children) ? parent.children.indexOf(nodes[0]) : -1

  let group = null
  try {
    group = figma.group(nodes, parent)
  } catch (error) {
    throw pluginError('figma-error', '创建分组失败：' + errorMessage(error), opIndex)
  }
  if (op.name !== undefined) group.name = op.name

  ctx.created.push({ opIndex: opIndex, nodeId: group.id, name: group.name, type: group.type })

  if (ctx.atomic) {
    ctx.undo.push(async function () {
      const children = Array.isArray(group.children) ? group.children.slice() : []
      for (const child of children) {
        if (insertIndex >= 0 && insertIndex <= parent.children.length) parent.insertChild(insertIndex, child)
        else parent.appendChild(child)
      }
      if (typeof group.remove === 'function') group.remove()
    })
  }

  return {
    opIndex: opIndex,
    op: 'group',
    nodeId: group.id,
    name: group.name,
    type: group.type,
    changes: { nodeIds: op.nodeIds.slice() },
  }
}

async function applyDelete(op, opIndex, ctx) {
  const node = await resolveNodeOrThrow(op.nodeId, opIndex)
  const entry = {
    opIndex: opIndex,
    op: 'delete',
    nodeId: node.id,
    name: node.name,
    type: node.type,
  }
  try {
    node.remove()
  } catch (error) {
    throw pluginError('figma-error', '删除节点失败：' + errorMessage(error), opIndex)
  }
  ctx.deleted.push(node.id)
  return entry
}

async function applySelect(op, opIndex, ctx) {
  const nodes = []
  for (const id of op.nodeIds) nodes.push(await resolveNodeOrThrow(id, opIndex))
  try {
    figma.currentPage.selection = nodes
  } catch (error) {
    throw pluginError('figma-error', '设置选区失败：' + errorMessage(error), opIndex)
  }
  return {
    opIndex: opIndex,
    op: 'select',
    changes: { nodeIds: op.nodeIds.slice() },
  }
}

// --------------------------------------------------------- ops: atomic undo

async function rollback(ctx) {
  let uncertain = false

  if (Array.isArray(ctx.initialSelection)) {
    try {
      figma.currentPage.selection = ctx.initialSelection
    } catch (_ignored) {
      uncertain = true
    }
  }

  for (let index = ctx.undo.length - 1; index >= 0; index--) {
    try {
      await ctx.undo[index]()
    } catch (_ignored) {
      uncertain = true
    }
  }

  for (let index = ctx.created.length - 1; index >= 0; index--) {
    const item = ctx.created[index]
    try {
      const node = await figma.getNodeByIdAsync(item.nodeId)
      if (node && typeof node.remove === 'function') node.remove()
    } catch (_ignored) {
      uncertain = true
    }
  }

  // Deleted nodes cannot be resurrected with the plugin API.
  if (ctx.deleted.length > 0) uncertain = true

  return uncertain
}

// ------------------------------------------------------- nodes/colors/fonts

async function resolveNodeOrThrow(nodeId, opIndex) {
  if (typeof nodeId !== 'string' || nodeId.length === 0) throw invalidOp('nodeId 必须是非空字符串', opIndex)
  let node = null
  try {
    node = await figma.getNodeByIdAsync(nodeId)
  } catch (error) {
    throw pluginError('figma-error', '读取节点失败：' + errorMessage(error), opIndex)
  }
  if (!node) throw pluginError('node-not-found', '找不到节点 ' + nodeId, opIndex)
  return node
}

async function resolveParent(parentId, opIndex) {
  if (parentId === undefined || parentId === null) return figma.currentPage
  if (typeof parentId !== 'string' || parentId.length === 0) {
    throw invalidOp('parentId 必须是非空字符串', opIndex)
  }
  let parent = null
  try {
    parent = await figma.getNodeByIdAsync(parentId)
  } catch (error) {
    throw pluginError('figma-error', '读取父节点失败：' + errorMessage(error), opIndex)
  }
  if (!parent) throw pluginError('parent-not-found', '找不到父节点 ' + parentId, opIndex)
  if (typeof parent.appendChild !== 'function') {
    throw pluginError('unsupported', '节点 ' + parentId + ' (' + parent.type + ') 不能作为父级', opIndex)
  }
  return parent
}

/** Parse #RGB / #RRGGBB / #RRGGBBAA into 0..1 floats. Returns null when invalid. */
function parseHexColor(value) {
  if (typeof value !== 'string') return null
  let hex = value.trim()
  if (hex.charAt(0) === '#') hex = hex.slice(1)
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) return null
  if (hex.length === 3) {
    hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2)
  }
  const hasAlpha = hex.length === 8
  const channel = function (slice) {
    return parseInt(hex.slice(slice, slice + 2), 16) / 255
  }
  const alpha = hasAlpha ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: Math.round(alpha * 1000) / 1000,
    hasAlpha: hasAlpha,
  }
}

/** Convert a normalized hex color (or null) to Figma SOLID paints. */
function colorValueToPaints(value, opIndex, label) {
  if (value === null) return []
  const color = parseHexColor(value)
  if (!color) throw invalidOp((label || '颜色') + ' 不是合法的十六进制颜色：' + String(value), opIndex)
  const paint = {
    type: 'SOLID',
    color: { r: color.r, g: color.g, b: color.b },
  }
  // #RRGGBBAA: alpha is expressed through paint.opacity.
  if (color.hasAlpha) paint.opacity = color.a
  return [paint]
}

function summarizeFillValue(paints) {
  if (!Array.isArray(paints) || paints.length === 0) return null
  const paint = paints[0]
  if (!paint || typeof paint !== 'object') return null
  if (paint.type === 'SOLID') return paintToHex(paint)
  return typeof paint.type === 'string' ? paint.type : null
}

function readRadius(node) {
  if (typeof node.cornerRadius === 'number') return node.cornerRadius
  let hasAll = true
  for (const key of CORNER_KEYS) {
    if (typeof node[key] !== 'number') {
      hasAll = false
      break
    }
  }
  if (hasAll) return CORNER_KEYS.map(function (key) { return node[key] })
  return null
}

function supportsRadius(node) {
  if (hasProperty(node, 'cornerRadius')) return true
  for (const key of CORNER_KEYS) {
    if (!hasProperty(node, key)) return false
  }
  return true
}

function writeRadius(node, radius) {
  const perCorner = supportsPerCorner(node)
  if (typeof radius === 'number') {
    if (hasProperty(node, 'cornerRadius')) {
      node.cornerRadius = radius
      return true
    }
    if (perCorner) {
      for (const key of CORNER_KEYS) node[key] = radius
      return true
    }
    return false
  }
  if (!Array.isArray(radius)) return false
  if (perCorner) {
    for (let index = 0; index < CORNER_KEYS.length; index++) node[CORNER_KEYS[index]] = radius[index]
    return true
  }
  if (hasProperty(node, 'cornerRadius')) {
    node.cornerRadius = radius[0]
    return true
  }
  return false
}

function supportsPerCorner(node) {
  for (const key of CORNER_KEYS) {
    if (!hasProperty(node, key)) return false
  }
  return true
}

function restoreRadius(node, value) {
  if (value === null || value === undefined) return
  writeRadius(node, value)
}

function applyLayout(node, layout) {
  if (layout === null) {
    node.layoutMode = 'NONE'
    return
  }
  node.layoutMode = layout.mode
  if (layout.itemSpacing !== undefined && hasProperty(node, 'itemSpacing')) node.itemSpacing = layout.itemSpacing
  if (layout.padding !== undefined) {
    if (hasProperty(node, 'paddingTop')) node.paddingTop = layout.padding.top
    if (hasProperty(node, 'paddingRight')) node.paddingRight = layout.padding.right
    if (hasProperty(node, 'paddingBottom')) node.paddingBottom = layout.padding.bottom
    if (hasProperty(node, 'paddingLeft')) node.paddingLeft = layout.padding.left
  }
  if (layout.primaryAxisAlign !== undefined && hasProperty(node, 'primaryAxisAlignItems')) {
    node.primaryAxisAlignItems = layout.primaryAxisAlign
  }
  if (layout.counterAxisAlign !== undefined && hasProperty(node, 'counterAxisAlignItems')) {
    node.counterAxisAlignItems = layout.counterAxisAlign
  }
  if (layout.wrap !== undefined && hasProperty(node, 'layoutWrap')) node.layoutWrap = layout.wrap}

function readFont(node) {
  const font = node && node.fontName
  if (font && typeof font === 'object' && typeof font.family === 'string' && typeof font.style === 'string') {
    return { family: font.family, style: font.style }
  }
  return null
}

async function loadFont(font) {
  if (!font || typeof font !== 'object') throw invalidOp('字体必须是 {family,style} 对象')
  const family = typeof font.family === 'string' ? font.family : ''
  const style = typeof font.style === 'string' ? font.style : ''
  if (family.length === 0 || style.length === 0) throw invalidOp('字体必须是 {family,style} 对象')

  const key = family + '\u0000' + style
  if (loadedFonts.has(key)) return { family: family, style: style }

  try {
    await figma.loadFontAsync({ family: family, style: style })
  } catch (error) {
    const candidates = await listFontCandidates()
    const hint = candidates.length > 0 ? '；可用字体候选：' + candidates.join('、') : ''
    throw pluginError('unsupported', '字体不可用：' + family + ' ' + style + '（' + errorMessage(error) + '）' + hint)
  }
  loadedFonts.add(key)
  return { family: family, style: style }
}

async function listFontCandidates() {
  try {
    if (typeof figma.listAvailableFontsAsync !== 'function') return []
    const fonts = await figma.listAvailableFontsAsync()
    if (!Array.isArray(fonts)) return []
    const candidates = []
    for (const item of fonts) {
      if (candidates.length >= 3) break
      const fontName = item && item.fontName
      if (fontName && typeof fontName.family === 'string') {
        candidates.push(fontName.family + ' ' + (typeof fontName.style === 'string' ? fontName.style : 'Regular'))
      }
    }
    return candidates
  } catch (_ignored) {
    return []
  }
}
