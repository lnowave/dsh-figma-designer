/**
 * Mock-Figma tests for the DSH Figma Designer companion plugin.
 *
 * The real companion/code.js is evaluated with `new Function('figma','__html__', src)`
 * against an in-memory mock of the Figma plugin API, so these tests exercise the
 * shipped artifact instead of a copy.
 *
 * Run: node --test tests/companion.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CODE_PATH = join(HERE, '..', 'companion', 'code.js')
const CODE_SOURCE = readFileSync(CODE_PATH, 'utf8')

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MOCK_HTML = '<html>mock</html>'

// ---------------------------------------------------------------------------
// Mock Figma API
// ---------------------------------------------------------------------------

function createMock(options = {}) {
  const opts = options || {}
  const AVAILABLE_FONTS = [
    { family: 'Inter', style: 'Regular' },
    { family: 'Inter', style: 'Bold' },
    { family: 'Roboto', style: 'Regular' },
  ]

  const state = {
    seq: 0,
    nextId: 1,
    messages: [],
    showUI: null,
    nodesCreated: 0,
    createdNodes: [],
    removedIds: [],
    exports: [],
    fontCalls: [],
    listFontCalls: 0,
    groupCalls: [],
    svgCalls: [],
  }
  const registry = new Map()

  function tick() {
    state.seq += 1
    return state.seq
  }

  function newId() {
    const id = '10:' + state.nextId
    state.nextId += 1
    return id
  }

  function unregister(node) {
    registry.delete(node.id)
    state.removedIds.push(node.id)
    for (const child of node.children.slice()) unregister(child)
  }

  const nameCounters = {}
  function defaultName(type) {
    const labels = {
      FRAME: 'Frame',
      RECTANGLE: 'Rectangle',
      ELLIPSE: 'Ellipse',
      TEXT: 'Text',
      LINE: 'Line',
      POLYGON: 'Polygon',
      STAR: 'Star',
      GROUP: 'Group',
      PAGE: 'Page',
    }
    const label = labels[type] || type
    nameCounters[type] = (nameCounters[type] || 0) + 1
    return label + ' ' + nameCounters[type]
  }

  const FILL_TYPES = ['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'POLYGON', 'STAR']
  const STROKE_TYPES = ['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'LINE', 'POLYGON', 'STAR']
  const CORNER_TYPES = ['FRAME', 'RECTANGLE']
  const LAYOUT_TYPES = ['FRAME']

  class FakeNode {
    constructor(type, init = {}) {
      this.type = type
      this.id = newId()
      this.name = typeof init.name === 'string' ? init.name : defaultName(type)
      this.parent = null
      this.children = []
      this.removed = false
      this._track = {}
      this._x = typeof init.x === 'number' ? init.x : 0
      this._y = typeof init.y === 'number' ? init.y : 0
      this.width = typeof init.width === 'number' ? init.width : 100
      this.height = typeof init.height === 'number' ? init.height : 100
      this.visible = true
      this.locked = false
      this.opacity = 1
      this.rotation = 0

      if (FILL_TYPES.indexOf(type) >= 0) {
        this.fills = []
        this.strokes = []
        this.strokeWeight = 1
      } else if (STROKE_TYPES.indexOf(type) >= 0) {
        this.strokes = []
        this.strokeWeight = 1
      }

      if (CORNER_TYPES.indexOf(type) >= 0) {
        this.cornerRadius = 0
        this.topLeftRadius = 0
        this.topRightRadius = 0
        this.bottomRightRadius = 0
        this.bottomLeftRadius = 0
      }

      if (LAYOUT_TYPES.indexOf(type) >= 0) {
        this.layoutMode = 'NONE'
        this.itemSpacing = 0
        this.paddingTop = 0
        this.paddingRight = 0
        this.paddingBottom = 0
        this.paddingLeft = 0
        this.primaryAxisAlignItems = 'MIN'
        this.counterAxisAlignItems = 'MIN'
        this.layoutWrap = 'NO_WRAP'
      }

      if (type === 'TEXT') {
        this._characters = ''
        this.fontName = { family: 'Inter', style: 'Regular' }
        this.fontSize = 12
        this.textAlignHorizontal = 'LEFT'
        this.lineHeight = { unit: 'AUTO' }
        this.letterSpacing = { unit: 'PIXELS', value: 0 }
        this.textAutoResize = 'NONE'
      }

      if (type === 'PAGE') this.selection = []
      if (type !== 'PAGE') this.effects = []
    }

    get x() {
      return this._x
    }

    set x(value) {
      this._track.x = tick()
      this._x = value
    }

    get y() {
      return this._y
    }

    set y(value) {
      this._track.y = tick()
      this._y = value
    }

    get characters() {
      return this._characters
    }

    set characters(value) {
      this._track.characters = tick()
      this._characters = value
    }

    appendChild(child) {
      if (!(child instanceof FakeNode)) throw new Error('appendChild expects a node')
      if (child === this) throw new Error('cannot append a node to itself')
      if (child.parent) child.parent._detach(child)
      child.parent = this
      this.children.push(child)
      child._track.appended = tick()
      return child
    }

    insertChild(index, child) {
      if (!(child instanceof FakeNode)) throw new Error('insertChild expects a node')
      if (typeof index !== 'number' || Math.floor(index) !== index || index < 0) throw new Error('invalid index')
      if (child.parent) child.parent._detach(child)
      if (index > this.children.length) throw new Error('index out of range')
      child.parent = this
      this.children.splice(index, 0, child)
      child._track.appended = tick()
      return child
    }

    _detach(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
    }

    resize(width, height) {
      if (!(width >= 1) || !(height >= 1)) throw new Error('resize requires width/height >= 1')
      this.width = width
      this.height = height
      return this
    }

    remove() {
      if (this.removed) return this
      this.removed = true
      if (this.parent) this.parent._detach(this)
      unregister(this)
      return this
    }

    clone() {
      return cloneNode(this)
    }

    async exportAsync(exportOptions) {
      state.exports.push({ nodeId: this.id, options: exportOptions })
      const bytes = new Uint8Array(24)
      for (let index = 0; index < PNG_SIGNATURE.length; index++) bytes[index] = PNG_SIGNATURE[index]
      for (let index = PNG_SIGNATURE.length; index < bytes.length; index++) bytes[index] = 0x40 + (index % 26)
      return bytes
    }
  }

  const CLONE_DATA_KEYS = [
    'width',
    'height',
    'visible',
    'locked',
    'opacity',
    'rotation',
    'fills',
    'strokes',
    'strokeWeight',
    'cornerRadius',
    'topLeftRadius',
    'topRightRadius',
    'bottomRightRadius',
    'bottomLeftRadius',
    'layoutMode',
    'itemSpacing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'primaryAxisAlignItems',
    'counterAxisAlignItems',
    'layoutWrap',
    'effects',
    'fontName',
    'fontSize',
    'textAlignHorizontal',
    'lineHeight',
    'letterSpacing',
    'textAutoResize',
    '_characters',
    'svgSource',
  ]

  function cloneValue(value) {
    if (value === null || typeof value !== 'object') return value
    try {
      return JSON.parse(JSON.stringify(value))
    } catch (_ignored) {
      return value
    }
  }

  function cloneNode(source) {
    const copy = makeNode(source.type, {
      name: source.name,
      x: source.x,
      y: source.y,
      width: source.width,
      height: source.height,
    })
    for (const key of CLONE_DATA_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) copy[key] = cloneValue(source[key])
    }
    if (source.type === 'PAGE') copy.selection = []
    for (const child of source.children) copy.appendChild(cloneNode(child))
    if (source.parent) {
      const index = source.parent.children.indexOf(source)
      source.parent.insertChild(index >= 0 ? index + 1 : source.parent.children.length, copy)
    }
    return copy
  }

  function makeNode(type, init) {
    const node = new FakeNode(type, init || {})
    registry.set(node.id, node)
    state.nodesCreated += 1
    state.createdNodes.push(node)
    return node
  }

  const page = makeNode('PAGE', { name: 'Page 1' })

  function groupNodes(nodes, parent) {
    if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('group requires at least one node')
    if (!parent || typeof parent.appendChild !== 'function') throw new Error('group requires a parent')
    for (const node of nodes) {
      if (node.parent !== parent) throw new Error('all nodes must be children of the same parent')
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of nodes) {
      minX = Math.min(minX, node.x)
      minY = Math.min(minY, node.y)
      maxX = Math.max(maxX, node.x + node.width)
      maxY = Math.max(maxY, node.y + node.height)
    }
    const group = makeNode('GROUP', {
      name: 'Group',
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    })
    const index = parent.children.indexOf(nodes[0])
    parent.insertChild(index < 0 ? parent.children.length : index, group)
    for (const node of nodes) group.appendChild(node)
    state.groupCalls.push({ ids: nodes.map((node) => node.id), parentId: parent.id, groupId: group.id })
    return group
  }

  const api = {
    editorType: opts.editorType || 'figma',
    apiVersion: '1.0.0',
    root: {
      id: '0:0',
      name: opts.fileName || 'Mock File',
      type: 'DOCUMENT',
      children: [page],
    },
    currentPage: page,
    viewport: {
      center: { x: 400, y: 300 },
      scrollAndZoomIntoView() {},
    },
    ui: {
      onmessage: null,
      resize(width, height) {
        state.uiResize = { width, height }
      },
      postMessage(message) {
        state.messages.push(message)
      },
    },
    showUI(html, uiOptions) {
      state.showUI = { html, options: uiOptions }
    },
    async getNodeByIdAsync(id) {
      return registry.get(id) || null
    },
    base64Encode(data) {
      if (typeof data === 'string') return Buffer.from(data, 'utf8').toString('base64')
      if (data instanceof Uint8Array) return Buffer.from(data).toString('base64')
      if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('base64')
      if (Array.isArray(data)) return Buffer.from(Uint8Array.from(data)).toString('base64')
      throw new Error('base64Encode: unsupported data')
    },
    async loadFontAsync(font) {
      if (!font || typeof font !== 'object') throw new Error('loadFontAsync requires a font object')
      state.fontCalls.push({ family: font.family, style: font.style, seq: tick() })
      const exists = AVAILABLE_FONTS.some(
        (candidate) => candidate.family === font.family && candidate.style === font.style,
      )
      if (!exists) throw new Error('Font not found: ' + font.family + ' ' + font.style)
    },
    async listAvailableFontsAsync() {
      state.listFontCalls += 1
      return AVAILABLE_FONTS.map((font) => ({ fontName: { family: font.family, style: font.style } }))
    },
    createFrame() {
      return makeNode('FRAME')
    },
    createRectangle() {
      return makeNode('RECTANGLE')
    },
    createEllipse() {
      return makeNode('ELLIPSE')
    },
    createText() {
      return makeNode('TEXT')
    },
    createLine() {
      return makeNode('LINE')
    },
    createPolygon() {
      return makeNode('POLYGON')
    },
    createStar() {
      return makeNode('STAR')
    },
    createNodeFromSvg(svg) {
      state.svgCalls.push(svg)
      const node = makeNode('FRAME', { name: 'SVG' })
      node.svgSource = svg
      return node
    },
    group(nodes, parent) {
      return groupNodes(nodes, parent)
    },
  }

  return { figma: api, state, page, makeNode, registry }
}

// ---------------------------------------------------------------------------
// Harness: evaluate the real companion/code.js with the mock
// ---------------------------------------------------------------------------

function loadHarness(options = {}) {
  const mock = createMock(options)
  const evaluate = new Function('figma', '__html__', CODE_SOURCE)
  evaluate(mock.figma, MOCK_HTML)

  let commandSeq = 0
  const harness = {
    mock,
    figma: mock.figma,
    state: mock.state,
    page: mock.page,
    async dispatch(message) {
      assert.equal(typeof mock.figma.ui.onmessage, 'function', 'companion must register figma.ui.onmessage')
      const before = mock.state.messages.length
      await mock.figma.ui.onmessage(message)
      const posted = mock.state.messages.slice(before)
      assert.ok(posted.length > 0, 'companion must post a message back')
      return posted[posted.length - 1]
    },
    async command(command, args = {}) {
      commandSeq += 1
      return harness.dispatch({ type: 'command', id: 'cmd-' + commandSeq, command, args })
    },
    async hello() {
      return harness.dispatch({ type: 'hello' })
    },
  }
  return harness
}

function buildFixture() {
  const h = loadHarness()
  const makeNode = h.mock.makeNode
  const page = h.page

  const frame = makeNode('FRAME', { name: 'Frame A', x: 0, y: 0, width: 300, height: 200 })
  page.appendChild(frame)

  const text = makeNode('TEXT', { name: 'Title', x: 10, y: 10, width: 160, height: 24 })
  frame.appendChild(text)
  text.characters = 'Hello'
  text.fontName = { family: 'Inter', style: 'Regular' }
  text.fontSize = 18
  text.textAlignHorizontal = 'CENTER'
  text.lineHeight = { unit: 'PIXELS', value: 24 }
  text.letterSpacing = { unit: 'PIXELS', value: 1 }
  text.textAutoResize = 'NONE'
  text.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }]

  const hiddenChild = makeNode('RECTANGLE', { name: 'Hidden Child', x: 20, y: 20, width: 30, height: 30 })
  frame.appendChild(hiddenChild)
  hiddenChild.visible = false

  const layoutFrame = makeNode('FRAME', { name: 'Layout', x: 400, y: 0, width: 200, height: 100 })
  page.appendChild(layoutFrame)
  layoutFrame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
  layoutFrame.layoutMode = 'HORIZONTAL'
  layoutFrame.itemSpacing = 8
  layoutFrame.paddingTop = 12
  layoutFrame.paddingRight = 12
  layoutFrame.paddingBottom = 12
  layoutFrame.paddingLeft = 12
  layoutFrame.primaryAxisAlignItems = 'CENTER'
  layoutFrame.counterAxisAlignItems = 'MAX'

  const hiddenTop = makeNode('RECTANGLE', { name: 'Hidden Top', x: 700, y: 0, width: 10, height: 10 })
  page.appendChild(hiddenTop)
  hiddenTop.visible = false

  return { h, mock: h.mock, page, frame, text, hiddenChild, layoutFrame, hiddenTop }
}

function decodePng(data) {
  return Array.from(Buffer.from(data, 'base64').subarray(0, PNG_SIGNATURE.length))
}

async function expectInvalidOp(harness, ops, expectedIndex = 0) {
  const res = await harness.command('apply', { ops })
  assert.equal(res.type, 'result')
  assert.equal(res.ok, true, 'op failure should be reported inside value, not as a command error')
  assert.equal(res.value.ok, false)
  assert.equal(res.value.error.code, 'invalid-op')
  assert.equal(res.value.error.opIndex, expectedIndex)
  assert.ok(Array.isArray(res.value.applied))
  return res
}

// ---------------------------------------------------------------------------
// 1. hello / ping
// ---------------------------------------------------------------------------

test('hello 与 ping：返回文件、页面与能力信息', async () => {
  const h = loadHarness()

  assert.ok(h.state.showUI, 'figma.showUI must be called at load time')
  assert.deepEqual(h.state.showUI.options, {
    width: 300,
    height: 112,
    themeColors: true,
    title: 'DSH Figma Designer',
  })
  assert.equal(h.state.showUI.html, MOCK_HTML)

  const ready = await h.hello()
  assert.equal(ready.type, 'ready')
  assert.equal(ready.file, 'Mock File')
  assert.equal(ready.page, 'Page 1')
  assert.equal(ready.editorType, 'figma')
  assert.equal(ready.pluginVersion, '0.9.1')

  const res = await h.command('ping')
  assert.equal(res.type, 'result')
  assert.equal(res.id, 'cmd-1')
  assert.equal(res.ok, true)
  assert.equal(res.value.ok, true)
  assert.equal(res.value.pluginVersion, '0.9.1')
  assert.equal(res.value.file, 'Mock File')
  assert.equal(res.value.page, 'Page 1')
  assert.equal(res.value.editorType, 'figma')
  assert.equal(res.value.apiVersion, '1.0.0')
  assert.deepEqual(res.value.pages, [{ id: h.page.id, name: 'Page 1' }])
  assert.equal(res.value.selectionCount, 0)
  assert.deepEqual(res.value.capabilities, {
    svg: true,
    exportFormats: ['PNG', 'SVG', 'PDF'],
    textEdit: true,
  })

  const unknown = await h.command('no-such-command')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'unsupported')
})

// ---------------------------------------------------------------------------
// 2. read
// ---------------------------------------------------------------------------

test('read：选区摘要、depth 展开、maxNodes 截断、隐藏过滤、文本与布局字段', async () => {
  const { h, page, frame, text, layoutFrame } = buildFixture()

  page.selection = [frame]
  const res = await h.command('read', { target: 'selection', depth: 2 })
  const value = res.value
  assert.equal(value.ok, true)
  assert.deepEqual(value.page, { id: page.id, name: 'Page 1' })
  assert.equal(value.target, 'selection')
  assert.deepEqual(value.selection, [frame.id])
  assert.deepEqual(value.stats, { count: 2, truncated: false, maxNodes: 80, depth: 2 })

  const frameSummary = value.nodes[0]
  assert.equal(frameSummary.id, frame.id)
  assert.equal(frameSummary.name, 'Frame A')
  assert.equal(frameSummary.type, 'FRAME')
  assert.equal(frameSummary.visible, true)
  assert.equal(frameSummary.locked, false)
  assert.equal(frameSummary.opacity, 1)
  assert.equal(frameSummary.rotation, 0)
  assert.deepEqual(frameSummary.bounds, { x: 0, y: 0, width: 300, height: 200 })
  assert.deepEqual(frameSummary.size, { width: 300, height: 200 })
  assert.equal(frameSummary.children, 2, 'children 是原始子节点数量（含隐藏节点）')
  assert.equal(frameSummary.childNodes.length, 1, '隐藏子节点默认被过滤')
  assert.equal(frameSummary.layout, null)

  const textSummary = frameSummary.childNodes[0]
  assert.equal(textSummary.id, text.id)
  assert.equal(textSummary.type, 'TEXT')
  assert.deepEqual(textSummary.text.font, { family: 'Inter', style: 'Regular' })
  assert.equal(textSummary.text.characters, 'Hello')
  assert.equal(textSummary.text.fontSize, 18)
  assert.equal(textSummary.text.align, 'CENTER')
  assert.deepEqual(textSummary.text.lineHeight, { unit: 'PIXELS', value: 24 })
  assert.deepEqual(textSummary.text.letterSpacing, { unit: 'PIXELS', value: 1 })
  assert.equal(textSummary.text.textAutoResize, 'NONE')
  assert.deepEqual(textSummary.fills, [{ type: 'SOLID', color: '#FF0000', opacity: 1 }])
  assert.equal(textSummary.children, 0)

  // no target -> selection (matches the figma_read tool default)
  const defaultRead = await h.command('read', {})
  assert.equal(defaultRead.value.target, 'selection')
  assert.equal(defaultRead.value.nodes.length, 1)

  // depth: 0 -> no childNodes
  const shallow = await h.command('read', { target: 'selection', depth: 0 })
  assert.equal(shallow.value.stats.depth, 0)
  assert.equal(shallow.value.nodes[0].childNodes, undefined)
  assert.equal(shallow.value.nodes[0].children, 2)

  // page target: default hides invisible top-level children
  const pageRead = await h.command('read', { target: 'page', depth: 1 })
  assert.equal(pageRead.value.target, 'page')
  assert.deepEqual(
    pageRead.value.nodes.map((node) => node.name),
    ['Frame A', 'Layout'],
  )
  assert.equal(pageRead.value.stats.count, 3)
  assert.equal(pageRead.value.stats.truncated, false)
  assert.equal(pageRead.value.nodes[0].childNodes.length, 1)

  // includeHidden keeps hidden nodes
  const withHidden = await h.command('read', { target: 'page', depth: 1, includeHidden: true })
  assert.deepEqual(
    withHidden.value.nodes.map((node) => node.name),
    ['Frame A', 'Layout', 'Hidden Top'],
  )
  assert.equal(withHidden.value.nodes[0].childNodes.length, 2)
  assert.equal(withHidden.value.stats.count, 5)

  // maxNodes truncation
  const limited = await h.command('read', { target: 'page', depth: 2, maxNodes: 2 })
  assert.equal(limited.value.stats.count, 2)
  assert.equal(limited.value.stats.truncated, true)
  assert.equal(limited.value.nodes.length, 1, '第二个根节点因 maxNodes 截断未展开')
  assert.equal(limited.value.stats.maxNodes, 2)

  // target: node reads an arbitrary node by id, with layout fields
  const nodeRead = await h.command('read', { target: 'node', nodeIds: [layoutFrame.id], depth: 0 })
  const layoutSummary = nodeRead.value.nodes[0]
  assert.equal(nodeRead.value.nodes.length, 1)
  assert.deepEqual(layoutSummary.layout, {
    mode: 'HORIZONTAL',
    itemSpacing: 8,
    padding: { top: 12, right: 12, bottom: 12, left: 12 },
    primaryAxisAlign: 'CENTER',
    counterAxisAlign: 'MAX',
  })

  // empty selection is not an error
  page.selection = []
  const empty = await h.command('read', { target: 'selection' })
  assert.equal(empty.value.ok, true)
  assert.deepEqual(empty.value.nodes, [])
  assert.equal(empty.value.stats.count, 0)

  // missing node id -> node-not-found (command-level error)
  const missing = await h.command('read', { target: 'node', nodeIds: ['nope'] })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'node-not-found')
})

// ---------------------------------------------------------------------------
// 2b. tree (style-complete export projection)
// ---------------------------------------------------------------------------

test('tree：完整样式树、隐藏节点保留、nodeIds 与 maxNodes 截断', async () => {
  const { h, page, frame, text, layoutFrame } = buildFixture()

  page.selection = [frame]
  const res = await h.command('tree', { target: 'selection' })
  const value = res.value
  assert.equal(value.ok, true)
  assert.equal(value.target, 'selection')
  assert.equal(value.stats.count, 3, 'frame + visible text + hidden child')
  assert.equal(value.stats.truncated, false)
  assert.equal(value.nodes.length, 1)

  const frameTree = value.nodes[0]
  assert.equal(frameTree.id, frame.id)
  assert.equal(frameTree.name, 'Frame A')
  assert.equal(frameTree.type, 'FRAME')
  assert.equal(frameTree.width, 300)
  assert.equal(frameTree.height, 200)
  assert.equal(frameTree.children.length, 2, 'tree keeps hidden nodes for complete geometry')
  assert.equal(frameTree.children[1].visible, false)

  const textTree = frameTree.children[0]
  assert.equal(textTree.type, 'TEXT')
  assert.equal(textTree.text.characters, 'Hello')
  assert.deepEqual(textTree.text.font, { family: 'Inter', style: 'Regular' })
  assert.equal(textTree.text.fontSize, 18)
  assert.equal(textTree.text.align, 'CENTER')
  assert.deepEqual(textTree.fills, [{ type: 'SOLID', color: '#FF0000', opacity: 1 }])

  const nodeTree = await h.command('tree', { target: 'node', nodeIds: [layoutFrame.id] })
  assert.equal(nodeTree.value.nodes.length, 1)
  assert.equal(nodeTree.value.nodes[0].id, layoutFrame.id)
  assert.deepEqual(nodeTree.value.nodes[0].layout, {
    mode: 'HORIZONTAL',
    itemSpacing: 8,
    padding: { top: 12, right: 12, bottom: 12, left: 12 },
    primaryAxisAlign: 'CENTER',
    counterAxisAlign: 'MAX',
    wrap: 'NO_WRAP',
  })

  const limited = await h.command('tree', { target: 'page', maxNodes: 2 })
  assert.equal(limited.value.stats.count, 2)
  assert.equal(limited.value.stats.truncated, true)

  page.selection = []
  const empty = await h.command('tree', { target: 'selection' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'no-node')
})

// ---------------------------------------------------------------------------
// 2c. library (design-system listing)
// ---------------------------------------------------------------------------

test('library：读取组件、样式与 Variables 摘要', async () => {
  const h = loadHarness()
  h.figma.getLocalComponentsAsync = async () => [
    { id: '2:1', name: 'Button / Primary', type: 'COMPONENT', width: 220, height: 48 },
  ]
  h.figma.getLocalPaintStylesAsync = async () => [
    { id: 'S:1', name: 'Brand / Primary', key: 'abc', paints: [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0 } }] },
  ]
  h.figma.getLocalTextStylesAsync = async () => []
  h.figma.getLocalEffectStylesAsync = async () => []
  h.figma.getLocalGridStylesAsync = async () => []
  h.figma.variables = {
    getLocalVariableCollectionsAsync: async () => [
      { id: 'VC:1', name: 'Design Tokens', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Mode 1' }], variableIds: ['V:1'] },
    ],
    getLocalVariablesAsync: async () => [
      { id: 'V:1', name: 'color/primary', key: 'k1', resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m1: { r: 1, g: 0.5, b: 0 } }, description: '' },
    ],
  }

  const res = await h.command('library', {})
  assert.equal(res.ok, true)
  assert.equal(res.value.ok, true)
  assert.equal(res.value.components.length, 1)
  assert.equal(res.value.components[0].name, 'Button / Primary')
  assert.equal(res.value.styles.paint.length, 1)
  assert.equal(res.value.styles.paint[0].name, 'Brand / Primary')
  assert.equal(res.value.styles.paint[0].paints[0].color, '#FF8000')
  assert.equal(res.value.variableCollections.length, 1)
  assert.equal(res.value.variables.length, 1)
  assert.equal(res.value.variables[0].name, 'color/primary')
  assert.equal(res.value.variables[0].valuesByMode.m1, '#FF8000')

  const filtered = await h.command('library', { query: 'missing' })
  assert.equal(filtered.value.components.length, 0)
  assert.equal(filtered.value.variables.length, 0)
})

// ---------------------------------------------------------------------------
// 3. screenshot / export
// ---------------------------------------------------------------------------

test('screenshot：base64 PNG、节点信息、无选区报 no-node；export 支持 PNG/SVG', async () => {
  const { h, page, frame, text } = buildFixture()

  page.selection = [frame]
  const shot = await h.command('screenshot', {})
  assert.equal(shot.ok, true)
  assert.equal(shot.value.ok, true)
  assert.deepEqual(shot.value.node, { id: frame.id, name: 'Frame A', type: 'FRAME' })
  assert.equal(shot.value.scale, 1)
  assert.equal(shot.value.image.mimeType, 'image/png')
  assert.equal(shot.value.image.bytes, 24)
  assert.deepEqual(decodePng(shot.value.image.data), PNG_SIGNATURE)
  assert.equal(shot.value.image.width, 300)
  assert.equal(shot.value.image.height, 200)
  assert.deepEqual(h.state.exports[h.state.exports.length - 1], {
    nodeId: frame.id,
    options: { format: 'PNG', constraint: { type: 'SCALE', value: 1 } },
  })

  // explicit nodeId + scale constraint
  const scaled = await h.command('screenshot', { nodeId: frame.id, scale: 2 })
  assert.equal(scaled.value.scale, 2)
  assert.equal(scaled.value.image.width, 600)
  assert.equal(scaled.value.image.height, 400)
  assert.deepEqual(h.state.exports[h.state.exports.length - 1].options, {
    format: 'PNG',
    constraint: { type: 'SCALE', value: 2 },
  })

  // no selection and no nodeId -> no-node
  page.selection = []
  const noNode = await h.command('screenshot', {})
  assert.equal(noNode.ok, false)
  assert.equal(noNode.error.code, 'no-node')

  // export multiple nodes
  const exported = await h.command('export', { nodeIds: [frame.id, text.id], format: 'PNG', scale: 2 })
  assert.equal(exported.ok, true)
  assert.equal(exported.value.ok, true)
  assert.equal(exported.value.files.length, 2)
  for (const file of exported.value.files) {
    assert.equal(file.format, 'PNG')
    assert.ok(file.bytes > 0)
    assert.deepEqual(decodePng(file.data), PNG_SIGNATURE)
  }
  assert.deepEqual(
    exported.value.files.map((file) => file.nodeId),
    [frame.id, text.id],
  )

  // SVG export must not send a PNG-only constraint
  const svg = await h.command('export', { nodeIds: [frame.id], format: 'SVG' })
  assert.equal(svg.value.files[0].format, 'SVG')
  const svgOptions = h.state.exports[h.state.exports.length - 1].options
  assert.equal(svgOptions.format, 'SVG')
  assert.equal(svgOptions.constraint, undefined)

  // invalid format -> command-level invalid-op
  const badFormat = await h.command('export', { nodeIds: [frame.id], format: 'JPG' })
  assert.equal(badFormat.ok, false)
  assert.equal(badFormat.error.code, 'invalid-op')

  // missing node -> node-not-found
  const missingNode = await h.command('export', { nodeIds: ['nope'], format: 'PNG' })
  assert.equal(missingNode.ok, false)
  assert.equal(missingNode.error.code, 'node-not-found')
})

// ---------------------------------------------------------------------------
// 4. apply: create (nested children, font, color, auto-layout, radius)
// ---------------------------------------------------------------------------

test('apply create：frame + 嵌套文本、appendChild 顺序、字体加载、颜色转换、auto-layout、圆角', async () => {
  const h = loadHarness()
  const hostFrame = h.mock.makeNode('FRAME', { name: 'Host', x: 0, y: 0, width: 400, height: 400 })
  h.page.appendChild(hostFrame)

  const nodesBefore = h.state.nodesCreated
  const svgSource = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'

  const ops = [
    {
      op: 'create',
      type: 'frame',
      name: 'Card',
      x: 100,
      y: 50,
      width: 200,
      height: 120,
      fill: '#FF0000',
      radius: 12,
      layout: {
        mode: 'VERTICAL',
        itemSpacing: 8,
        padding: 16,
        primaryAxisAlign: 'MIN',
        counterAxisAlign: 'CENTER',
      },
      children: [
        {
          op: 'create',
          type: 'text',
          name: 'Heading',
          x: 12,
          y: 16,
          width: 150,
          height: 24,
          fill: '#00FF0080',
          text: {
            characters: '你好 Figma',
            font: { family: 'Inter', style: 'Regular' },
            fontSize: 18,
            align: 'CENTER',
            lineHeight: { unit: 'PIXELS', value: 24 },
            letterSpacing: 1,
            textAutoResize: 'NONE',
          },
        },
      ],
    },
    {
      op: 'create',
      type: 'rect',
      parentId: hostFrame.id,
      name: 'Chip',
      x: 5,
      y: 6,
      width: 10,
      height: 10,
      fill: '#123456',
    },
    {
      op: 'create',
      type: 'svg',
      name: 'Icon',
      svg: svgSource,
    },
  ]

  const res = await h.command('apply', { ops })
  const value = res.value
  assert.equal(res.ok, true)
  assert.equal(value.ok, true)
  assert.equal(value.dryRun, false)
  assert.equal(value.operationId, null)
  assert.equal(value.applied.length, 3)
  assert.equal(value.applied[0].op, 'create')
  assert.equal(value.applied[0].opIndex, 0)
  assert.deepEqual(value.warnings, [])

  // 4 created nodes: frame + nested text + rect + svg
  assert.equal(value.created.length, 4)
  assert.deepEqual(
    value.created.map((entry) => entry.type),
    ['FRAME', 'TEXT', 'RECTANGLE', 'FRAME'],
  )
  assert.equal(value.created[1].opIndex, 0, '嵌套 create 归属于父 op 的 opIndex')
  assert.equal(h.state.nodesCreated, nodesBefore + 4)

  const frameId = value.created[0].nodeId
  const textId = value.created[1].nodeId
  const frameNode = await h.figma.getNodeByIdAsync(frameId)
  const textNode = await h.figma.getNodeByIdAsync(textId)
  assert.ok(frameNode)
  assert.ok(textNode)

  // parent/coordinate semantics: page child gets absolute x/y, frame child gets
  // the raw x/y interpreted relative to its parent (no conversion in v0.1)
  assert.equal(frameNode.parent, h.page)
  assert.equal(frameNode.x, 100)
  assert.equal(frameNode.y, 50)
  assert.equal(frameNode.width, 200)
  assert.equal(frameNode.height, 120)
  assert.equal(textNode.parent, frameNode)
  assert.equal(textNode.x, 12)
  assert.equal(textNode.y, 16)
  assert.equal(textNode.width, 150)
  assert.equal(textNode.height, 24)

  // appendChild must happen before x/y is written (coordinate system)
  assert.ok(textNode._track.appended, 'text node must be appended')
  assert.ok(textNode._track.x, 'text node x must be assigned')
  assert.ok(
    textNode._track.appended < textNode._track.x,
    'text node must be appended to its parent before setting x/y',
  )

  // font: loaded before characters are written
  const fontCall = h.state.fontCalls.find((call) => call.family === 'Inter' && call.style === 'Regular')
  assert.ok(fontCall, 'create TEXT must call figma.loadFontAsync')
  assert.ok(fontCall.seq < textNode._track.characters, 'font must be loaded before setting characters')
  assert.deepEqual(textNode.fontName, { family: 'Inter', style: 'Regular' })
  assert.equal(textNode.characters, '你好 Figma')
  assert.equal(textNode.fontSize, 18)
  assert.equal(textNode.textAlignHorizontal, 'CENTER')
  assert.deepEqual(textNode.lineHeight, { unit: 'PIXELS', value: 24 })
  assert.deepEqual(textNode.letterSpacing, { unit: 'PIXELS', value: 1 })
  assert.equal(textNode.textAutoResize, 'NONE')

  // color conversion: 0..1 floats, #RRGGBBAA alpha -> paint.opacity
  assert.equal(frameNode.fills.length, 1)
  assert.equal(frameNode.fills[0].type, 'SOLID')
  assert.deepEqual(frameNode.fills[0].color, { r: 1, g: 0, b: 0 })
  assert.equal(frameNode.fills[0].opacity, undefined)
  assert.equal(textNode.fills[0].color.r, 0)
  assert.equal(textNode.fills[0].color.g, 1)
  assert.equal(textNode.fills[0].color.b, 0)
  assert.equal(textNode.fills[0].opacity, 0.502)

  // radius + auto layout
  assert.equal(frameNode.cornerRadius, 12)
  assert.equal(frameNode.layoutMode, 'VERTICAL')
  assert.equal(frameNode.itemSpacing, 8)
  assert.equal(frameNode.paddingTop, 16)
  assert.equal(frameNode.paddingRight, 16)
  assert.equal(frameNode.paddingBottom, 16)
  assert.equal(frameNode.paddingLeft, 16)
  assert.equal(frameNode.primaryAxisAlignItems, 'MIN')
  assert.equal(frameNode.counterAxisAlignItems, 'CENTER')

  // rect created under a Frame keeps its local x/y
  const rectNode = await h.figma.getNodeByIdAsync(value.created[2].nodeId)
  assert.equal(rectNode.parent, hostFrame)
  assert.equal(rectNode.x, 5)
  assert.equal(rectNode.y, 6)
  assert.equal(rectNode.fills[0].color.r, 18 / 255)
  assert.equal(rectNode.fills[0].color.g, 52 / 255)
  assert.equal(rectNode.fills[0].color.b, 86 / 255)

  // svg path uses figma.createNodeFromSvg
  assert.deepEqual(h.state.svgCalls, [svgSource])
  const svgNode = await h.figma.getNodeByIdAsync(value.created[3].nodeId)
  assert.equal(svgNode.svgSource, svgSource)
  assert.equal(svgNode.parent, h.page)
})

// ---------------------------------------------------------------------------
// 5. apply: update (old values recorded)
// ---------------------------------------------------------------------------

test('apply update：改 fill/layout/文本并记录旧值', async () => {
  const { h, layoutFrame, text } = buildFixture()

  const ops = [
    {
      op: 'update',
      nodeId: layoutFrame.id,
      patch: {
        name: 'Layout 2',
        fill: '#0000FF',
        opacity: 0.5,
        layout: { mode: 'VERTICAL', itemSpacing: -4, padding: { top: 1, right: 2, bottom: 3, left: 4 } },
      },
    },
    {
      op: 'update',
      nodeId: text.id,
      patch: { text: { characters: 'Updated', fontSize: 20, align: 'RIGHT', letterSpacing: -0.5 } },
    },
  ]

  const res = await h.command('apply', { ops })
  const value = res.value
  assert.equal(value.ok, true)
  assert.equal(value.dryRun, false)
  assert.equal(value.applied.length, 2)
  assert.equal(value.updated.length, 2)
  assert.deepEqual(value.updated[0].changes, ['name', 'fill', 'opacity', 'layout'])
  assert.deepEqual(value.updated[1].changes, ['text.characters', 'text.fontSize', 'text.align', 'text.letterSpacing'])

  const changes = value.applied[0].changes
  assert.deepEqual(changes.name, { from: 'Layout', to: 'Layout 2' })
  assert.deepEqual(changes.fill, { from: '#FFFFFF', to: '#0000FF' })
  assert.deepEqual(changes.opacity, { from: 1, to: 0.5 })
  assert.equal(changes.layout.from.mode, 'HORIZONTAL')
  assert.equal(changes.layout.from.itemSpacing, 8)
  assert.equal(changes.layout.from.padding.top, 12)
  assert.equal(changes.layout.to.mode, 'VERTICAL')
  assert.equal(changes.layout.to.itemSpacing, -4)
  assert.deepEqual(changes.layout.to.padding, { top: 1, right: 2, bottom: 3, left: 4 })

  // mutation actually happened
  assert.equal(layoutFrame.name, 'Layout 2')
  assert.deepEqual(layoutFrame.fills, [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }])
  assert.equal(layoutFrame.opacity, 0.5)
  assert.equal(layoutFrame.layoutMode, 'VERTICAL')
  assert.equal(layoutFrame.itemSpacing, -4)
  assert.deepEqual(
    [layoutFrame.paddingTop, layoutFrame.paddingRight, layoutFrame.paddingBottom, layoutFrame.paddingLeft],
    [1, 2, 3, 4],
  )

  const textChanges = value.applied[1].changes
  assert.deepEqual(textChanges['text.characters'], { from: 'Hello', to: 'Updated' })
  assert.deepEqual(textChanges['text.fontSize'], { from: 18, to: 20 })
  assert.deepEqual(textChanges['text.align'], { from: 'CENTER', to: 'RIGHT' })
  assert.deepEqual(textChanges['text.letterSpacing'], {
    from: { unit: 'PIXELS', value: 1 },
    to: { unit: 'PIXELS', value: -0.5 },
  })
  assert.equal(text.characters, 'Updated')
  assert.equal(text.fontSize, 20)
  assert.equal(text.textAlignHorizontal, 'RIGHT')
  assert.deepEqual(text.letterSpacing, { unit: 'PIXELS', value: -0.5 })
  // updating characters without an explicit font must load the node's font first
  assert.ok(h.state.fontCalls.some((call) => call.family === 'Inter' && call.style === 'Regular'))
})

// ---------------------------------------------------------------------------
// 6. apply: dryRun
// ---------------------------------------------------------------------------

test('apply dryRun：不修改画布且返回 plan 统计', async () => {
  const { h, frame, layoutFrame, hiddenTop } = buildFixture()

  const beforeNodes = h.state.nodesCreated
  const beforeChildren = h.page.children.length
  const beforeExports = h.state.exports.length

  const ops = [
    {
      op: 'create',
      type: 'frame',
      name: 'Dry',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [{ op: 'create', type: 'text', x: 0, y: 0, text: { characters: 'x' } }],
    },
    { op: 'update', nodeId: layoutFrame.id, patch: { name: 'Not applied' } },
    { op: 'delete', nodeId: hiddenTop.id },
    { op: 'group', nodeIds: [frame.id, layoutFrame.id], name: 'Row' },
  ]

  const res = await h.command('apply', { ops, dryRun: true })
  const value = res.value
  assert.equal(res.ok, true)
  assert.equal(value.ok, true)
  assert.equal(value.dryRun, true)
  assert.deepEqual(value.plan.willCreate, 2)
  assert.deepEqual(value.plan.willUpdate, 1)
  assert.deepEqual(value.plan.willDelete, 1)
  assert.deepEqual(value.plan.willGroup, 1)
  assert.equal(value.plan.ops.length, 4)
  assert.equal(value.plan.ops[0].op, 'create')
  assert.equal(value.plan.ops[0].opIndex, 0)
  assert.equal(typeof value.plan.ops[0].description, 'string')
  assert.ok(value.plan.ops[0].description.length > 0)
  assert.deepEqual(value.warnings, [])

  // canvas untouched
  assert.equal(h.state.nodesCreated, beforeNodes)
  assert.equal(h.page.children.length, beforeChildren)
  assert.equal(layoutFrame.name, 'Layout')
  assert.ok(await h.figma.getNodeByIdAsync(hiddenTop.id))
  assert.equal(h.state.exports.length, beforeExports)
})

// ---------------------------------------------------------------------------
// 7. apply: single op failure keeps applied prefix
// ---------------------------------------------------------------------------

test('apply 单条失败：停止后续 ops，返回 applied 前缀与 error.opIndex', async () => {
  const { h } = buildFixture()
  const beforeNodes = h.state.nodesCreated
  const beforeChildren = h.page.children.length

  const ops = [
    { op: 'create', type: 'rect', name: 'First', x: 0, y: 0, width: 10, height: 10 },
    { op: 'update', nodeId: '999:999', patch: { name: 'ghost' } },
    { op: 'create', type: 'rect', name: 'Third', x: 0, y: 0, width: 10, height: 10 },
  ]

  const res = await h.command('apply', { ops })
  const value = res.value
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'node-not-found')
  assert.equal(value.error.opIndex, 1)
  assert.ok(value.error.message.includes('999:999'))
  assert.equal(value.applied.length, 1)
  assert.equal(value.applied[0].op, 'create')
  assert.equal(value.applied[0].opIndex, 0)
  assert.equal(value.applied[0].name, 'First')

  // failed op stopped the pipeline: only the first node was created
  assert.equal(h.state.nodesCreated, beforeNodes + 1)
  assert.equal(h.page.children.length, beforeChildren + 1)
})

// ---------------------------------------------------------------------------
// 8. apply: operationId dedupe (recent 50)
// ---------------------------------------------------------------------------

test('apply operationId：重复提交返回首次结果且不重复执行（保留最近 50 条）', async () => {
  const h = loadHarness()
  const ops = [{ op: 'create', type: 'rect', name: 'Idem', x: 0, y: 0, width: 10, height: 10 }]

  const first = await h.command('apply', { ops, operationId: 'op-1' })
  assert.equal(first.value.ok, true)
  assert.equal(first.value.operationId, 'op-1')
  const firstCreatedId = first.value.created[0].nodeId
  const nodesAfterFirst = h.state.nodesCreated

  const second = await h.command('apply', {
    ops,
    operationId: 'op-1',
    dryRun: true, // must be ignored: the cached first result wins
  })
  assert.deepEqual(second.value, first.value)
  assert.equal(h.state.nodesCreated, nodesAfterFirst)
  assert.equal(h.page.children.length, 1)

  // push 50 more distinct operation ids: op-1 falls out of the recent-50 window
  for (let index = 0; index < 50; index++) {
    const bulk = await h.command('apply', {
      ops: [{ op: 'create', type: 'rect', x: 0, y: 0, width: 1, height: 1 }],
      operationId: 'bulk-' + index,
    })
    assert.equal(bulk.value.ok, true)
  }
  const nodesAfterBulk = h.state.nodesCreated
  const retried = await h.command('apply', { ops, operationId: 'op-1' })
  assert.equal(retried.value.ok, true)
  assert.equal(h.state.nodesCreated, nodesAfterBulk + 1, '被淘汰的 operationId 应重新执行')
  assert.notEqual(retried.value.created[0].nodeId, firstCreatedId)
})

// ---------------------------------------------------------------------------
// 9. apply: delete / group / clone / select
// ---------------------------------------------------------------------------

test('apply delete/group/clone/select 基本行为', async () => {
  const { h, page, frame } = buildFixture()

  const rectA = h.mock.makeNode('RECTANGLE', { name: 'A', x: 10, y: 10, width: 20, height: 20 })
  page.appendChild(rectA)
  const rectB = h.mock.makeNode('RECTANGLE', { name: 'B', x: 40, y: 10, width: 20, height: 20 })
  page.appendChild(rectB)

  // group
  const grouped = await h.command('apply', {
    ops: [{ op: 'group', nodeIds: [rectA.id, rectB.id], name: 'Row' }],
  })
  assert.equal(grouped.value.ok, true)
  const groupEntry = grouped.value.applied[0]
  assert.equal(groupEntry.op, 'group')
  assert.equal(groupEntry.type, 'GROUP')
  assert.equal(grouped.value.created.length, 1)
  const groupNode = await h.figma.getNodeByIdAsync(groupEntry.nodeId)
  assert.ok(groupNode)
  assert.equal(groupNode.type, 'GROUP')
  assert.equal(groupNode.name, 'Row')
  assert.equal(groupNode.parent, page)
  assert.equal(groupNode.children.length, 2)
  assert.deepEqual(
    groupNode.children.map((node) => node.id),
    [rectA.id, rectB.id],
  )
  assert.equal(h.state.groupCalls.length, 1)

  // clone (deep by default)
  const cloned = await h.command('apply', { ops: [{ op: 'clone', nodeId: frame.id, x: 500, y: 600 }] })
  assert.equal(cloned.value.ok, true)
  const cloneEntry = cloned.value.applied[0]
  assert.equal(cloneEntry.op, 'clone')
  assert.notEqual(cloneEntry.nodeId, frame.id)
  assert.equal(cloneEntry.type, 'FRAME')
  const cloneNode = await h.figma.getNodeByIdAsync(cloneEntry.nodeId)
  assert.ok(cloneNode)
  assert.equal(cloneNode.parent, page)
  assert.equal(cloneNode.x, 500)
  assert.equal(cloneNode.y, 600)
  assert.equal(cloneNode.children.length, frame.children.length, 'clone 默认深拷贝')

  // deep:false still deep-clones, with a warning
  const shallow = await h.command('apply', { ops: [{ op: 'clone', nodeId: rectA.id, deep: false }] })
  assert.equal(shallow.value.ok, true)
  assert.equal(typeof shallow.value.applied[0].warning, 'string')
  assert.equal(shallow.value.warnings.length, 1)

  // delete
  const deleted = await h.command('apply', { ops: [{ op: 'delete', nodeId: rectA.id }] })
  assert.equal(deleted.value.ok, true)
  assert.equal(deleted.value.applied[0].op, 'delete')
  assert.deepEqual(deleted.value.deleted, [rectA.id])
  assert.equal(await h.figma.getNodeByIdAsync(rectA.id), null)

  // select op
  const selected = await h.command('apply', {
    ops: [{ op: 'select', nodeIds: [frame.id, cloneEntry.nodeId] }],
  })
  assert.equal(selected.value.ok, true)
  assert.equal(selected.value.applied[0].op, 'select')
  assert.deepEqual(
    page.selection.map((node) => node.id),
    [frame.id, cloneEntry.nodeId],
  )

  // select command
  const selectCommand = await h.command('select', { nodeIds: [cloneEntry.nodeId] })
  assert.equal(selectCommand.ok, true)
  assert.equal(selectCommand.value.ok, true)
  assert.deepEqual(selectCommand.value.selection, [cloneEntry.nodeId])
  assert.deepEqual(
    page.selection.map((node) => node.id),
    [cloneEntry.nodeId],
  )
})

// ---------------------------------------------------------------------------
// 9b. apply: move / reorder / radius array
// ---------------------------------------------------------------------------

test('apply move/reorder：重新挂父级（坐标按新父级解释）与父级内排序', async () => {
  const { h, frame, text, layoutFrame } = buildFixture()

  // first child of frame is the text node
  const moved = await h.command('apply', {
    ops: [{ op: 'move', nodeId: text.id, parentId: layoutFrame.id, index: 0 }],
  })
  const moveValue = moved.value
  assert.equal(moveValue.ok, true)
  assert.equal(moveValue.applied[0].op, 'move')
  assert.deepEqual(moveValue.applied[0].changes.parentId, { from: frame.id, to: layoutFrame.id })
  assert.equal(text.parent, layoutFrame)
  assert.equal(layoutFrame.children[0], text)
  // v0.1 does not convert coordinates when re-parenting
  assert.equal(text.x, 10)
  assert.equal(text.y, 10)

  const sibling = h.mock.makeNode('RECTANGLE', { name: 'Sibling', x: 0, y: 0, width: 10, height: 10 })
  layoutFrame.appendChild(sibling)
  assert.deepEqual(
    layoutFrame.children.map((node) => node.id),
    [text.id, sibling.id],
  )

  const reordered = await h.command('apply', {
    ops: [{ op: 'reorder', nodeId: text.id, index: 1 }],
  })
  const reorderValue = reordered.value
  assert.equal(reorderValue.ok, true)
  assert.equal(reorderValue.applied[0].op, 'reorder')
  assert.deepEqual(reorderValue.applied[0].changes.index, { from: 0, to: 1 })
  assert.deepEqual(
    layoutFrame.children.map((node) => node.id),
    [sibling.id, text.id],
  )
})

test('apply create radius 数组：四角分别写入', async () => {
  const h = loadHarness()
  const res = await h.command('apply', {
    ops: [
      {
        op: 'create',
        type: 'rect',
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        radius: [1, 2, 3, 4],
      },
    ],
  })
  assert.equal(res.value.ok, true)
  const node = await h.figma.getNodeByIdAsync(res.value.created[0].nodeId)
  assert.deepEqual(
    [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius],
    [1, 2, 3, 4],
  )
})

test('补充路径：parent-not-found、effects/可见性/旋转、line/polygon/star、clone parentId、无 index move、radius 数值更新、PDF 导出、默认字体', async () => {
  const h = loadHarness()
  const frame = h.mock.makeNode('FRAME', { name: 'Parent', x: 0, y: 0, width: 100, height: 100 })
  h.page.appendChild(frame)
  const rect = h.mock.makeNode('RECTANGLE', { name: 'Rect', x: 0, y: 0, width: 10, height: 10 })
  h.page.appendChild(rect)

  // parent-not-found
  const badParent = await h.command('apply', {
    ops: [{ op: 'create', type: 'rect', parentId: 'nope', x: 0, y: 0, width: 10, height: 10 }],
  })
  assert.equal(badParent.value.ok, false)
  assert.equal(badParent.value.error.code, 'parent-not-found')

  // other create factories + visual fields + effects
  const created = await h.command('apply', {
    ops: [
      {
        op: 'create',
        type: 'star',
        name: 'Star',
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        opacity: 0.8,
        visible: false,
        locked: true,
        rotation: 45,
        effects: [
          {
            type: 'DROP_SHADOW',
            color: '#00000080',
            offset: { x: 0, y: 2 },
            radius: 4,
            spread: 1,
            visible: true,
          },
        ],
      },
      { op: 'create', type: 'polygon', x: 0, y: 0, width: 10, height: 10 },
      { op: 'create', type: 'line', x: 0, y: 0, width: 10, height: 10, fill: '#FF0000' },
      { op: 'create', type: 'frame', x: 0, y: 0, width: 10, height: 10, fill: null },
    ],
  })
  assert.equal(created.value.ok, true)
  const star = await h.figma.getNodeByIdAsync(created.value.created[0].nodeId)
  assert.equal(star.type, 'STAR')
  assert.equal(star.opacity, 0.8)
  assert.equal(star.visible, false)
  assert.equal(star.locked, true)
  assert.equal(star.rotation, 45)
  assert.equal(star.effects.length, 1)
  assert.equal(star.effects[0].type, 'DROP_SHADOW')
  assert.equal(star.effects[0].color.a, 0.502)
  assert.deepEqual(star.effects[0].offset, { x: 0, y: 2 })
  assert.equal(star.effects[0].radius, 4)
  assert.equal(star.effects[0].spread, 1)
  const polygon = await h.figma.getNodeByIdAsync(created.value.created[1].nodeId)
  assert.equal(polygon.type, 'POLYGON')
  const lineNode = await h.figma.getNodeByIdAsync(created.value.created[2].nodeId)
  assert.equal(lineNode.type, 'LINE')
  assert.ok(created.value.warnings.some((warning) => warning.includes('fill')), 'LINE 不支持 fill 应给出 warning')
  const emptyFill = await h.figma.getNodeByIdAsync(created.value.created[3].nodeId)
  assert.deepEqual(emptyFill.fills, [])

  // default font for text create without a text payload
  const textCreated = await h.command('apply', {
    ops: [{ op: 'create', type: 'text', x: 0, y: 0 }],
  })
  assert.equal(textCreated.value.ok, true)
  const textNode = await h.figma.getNodeByIdAsync(textCreated.value.created[0].nodeId)
  assert.deepEqual(textNode.fontName, { family: 'Inter', style: 'Regular' })
  assert.ok(h.state.fontCalls.some((call) => call.family === 'Inter' && call.style === 'Regular'))

  // clone into an explicit parent
  const cloned = await h.command('apply', {
    ops: [{ op: 'clone', nodeId: rect.id, parentId: frame.id }],
  })
  assert.equal(cloned.value.ok, true)
  const cloneNode = await h.figma.getNodeByIdAsync(cloned.value.applied[0].nodeId)
  assert.equal(cloneNode.parent, frame)

  // move without index appends to the end of the new parent
  const moved = await h.command('apply', { ops: [{ op: 'move', nodeId: rect.id, parentId: frame.id }] })
  assert.equal(moved.value.ok, true)
  assert.equal(frame.children[frame.children.length - 1], rect)

  // radius as a number on update
  const radiusUpdate = await h.command('apply', {
    ops: [{ op: 'update', nodeId: frame.id, patch: { radius: 5 } }],
  })
  assert.equal(radiusUpdate.value.ok, true)
  assert.equal(frame.cornerRadius, 5)
  assert.deepEqual(radiusUpdate.value.applied[0].changes.radius, { from: 0, to: 5 })

  // PDF export uses no PNG constraint
  const pdf = await h.command('export', { nodeIds: [frame.id], format: 'PDF' })
  assert.equal(pdf.value.ok, true)
  assert.equal(pdf.value.files[0].format, 'PDF')
  assert.equal(h.state.exports[h.state.exports.length - 1].options.constraint, undefined)

  // select command with a missing node is a command-level node-not-found
  const badSelect = await h.command('select', { nodeIds: ['nope'] })
  assert.equal(badSelect.ok, false)
  assert.equal(badSelect.error.code, 'node-not-found')
})

// ---------------------------------------------------------------------------
// 10. invalid ops
// ---------------------------------------------------------------------------

test('非法 op：未知类型、缺 nodeId、颜色/尺寸/圆角/布局非法均返回 invalid-op', async () => {
  const { h, frame, layoutFrame } = buildFixture()

  await expectInvalidOp(h, [{ op: 'frobnicate' }])
  await expectInvalidOp(h, [{ op: 'update', patch: { name: 'x' } }])
  await expectInvalidOp(h, [{ op: 'create', type: 'frame' }].map((op) => ({ ...op, type: undefined })))
  await expectInvalidOp(h, [{ op: 'create', type: 'video', width: 10, height: 10 }])
  await expectInvalidOp(h, [{ op: 'create', type: 'rect', fill: '#GGGGGG', width: 10, height: 10 }])
  await expectInvalidOp(h, [{ op: 'create', type: 'rect', width: 0, height: 10 }])
  await expectInvalidOp(h, [{ op: 'create', type: 'rect', width: 10, height: 10, radius: [1, 2, 3] }])
  await expectInvalidOp(h, [
    { op: 'create', type: 'frame', width: 10, height: 10, layout: { mode: 'DIAGONAL' } },
  ])
  await expectInvalidOp(h, [{ op: 'update', nodeId: frame.id, patch: { opacity: 2 } }])
  await expectInvalidOp(h, [{ op: 'update', nodeId: '', patch: { name: 'x' } }])
  await expectInvalidOp(h, [{ op: 'create', type: 'text', text: { characters: 42 } }])
  await expectInvalidOp(h, [{ op: 'create', type: 'text', text: { font: { family: '', style: 'Regular' } } }])
  await expectInvalidOp(h, [{ op: 'update', nodeId: frame.id, patch: { text: { characters: 'x' } } }])
  await expectInvalidOp(h, [{ op: 'reorder', nodeId: frame.id }])
  await expectInvalidOp(h, [{ op: 'create', type: 'frame', children: [{ op: 'update', nodeId: frame.id }] }])

  // group requires a shared parent (runtime validation)
  const foreign = h.mock.makeNode('RECTANGLE', { name: 'Foreign', x: 0, y: 0, width: 10, height: 10 })
  layoutFrame.appendChild(foreign)
  await expectInvalidOp(h, [{ op: 'group', nodeIds: [frame.id, foreign.id] }])

  // apply with a non-array ops payload is a command-level invalid-op
  const badOps = await h.command('apply', { ops: 'nope' })
  assert.equal(badOps.ok, false)
  assert.equal(badOps.error.code, 'invalid-op')

  // structural error in the second op keeps applied prefix (no execution stop bug)
  const prefix = await h.command('apply', {
    ops: [
      { op: 'create', type: 'rect', name: 'Prefix', x: 0, y: 0, width: 10, height: 10 },
      { op: 'frobnicate' },
    ],
  })
  assert.equal(prefix.value.ok, false)
  assert.equal(prefix.value.error.code, 'invalid-op')
  assert.equal(prefix.value.error.opIndex, 1)
  assert.equal(prefix.value.applied.length, 1)
  assert.equal(prefix.value.applied[0].name, 'Prefix')
})

// ---------------------------------------------------------------------------
// 11. atomic rollback
// ---------------------------------------------------------------------------

test('apply atomic：失败时删除已创建节点、恢复被改字段；删除导致的不可恢复标记 uncertain', async () => {
  const { h, frame, hiddenTop } = buildFixture()
  const childrenBefore = h.page.children.length
  const frameNameBefore = frame.name

  const failed = await h.command('apply', {
    ops: [
      { op: 'create', type: 'rect', name: 'Temp', x: 0, y: 0, width: 10, height: 10 },
      { op: 'update', nodeId: frame.id, patch: { name: 'Renamed' } },
      { op: 'update', nodeId: '999:999', patch: { name: 'ghost' } },
    ],
    atomic: true,
  })
  const value = failed.value
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'node-not-found')
  assert.equal(value.error.opIndex, 2)
  assert.equal(value.applied.length, 2, 'applied 仍保留已成功部分')
  assert.equal(value.uncertain, undefined, '可恢复的回滚不应标记 uncertain')

  // created node removed, updated field restored
  assert.equal(h.page.children.length, childrenBefore)
  assert.equal(frame.name, frameNameBefore)

  // deleting a node cannot be undone -> uncertain
  const irreversible = await h.command('apply', {
    ops: [
      { op: 'delete', nodeId: hiddenTop.id },
      { op: 'update', nodeId: '999:999', patch: { name: 'ghost' } },
    ],
    atomic: true,
  })
  assert.equal(irreversible.value.ok, false)
  assert.equal(irreversible.value.uncertain, true)
  assert.equal(await h.figma.getNodeByIdAsync(hiddenTop.id), null)
})

// ---------------------------------------------------------------------------
// 12. font fallback
// ---------------------------------------------------------------------------

test('apply create text：字体不存在时返回 unsupported 并列出 3 个可用候选', async () => {
  const h = loadHarness()
  const before = h.state.nodesCreated

  const res = await h.command('apply', {
    ops: [
      {
        op: 'create',
        type: 'text',
        x: 0,
        y: 0,
        text: { characters: 'x', font: { family: 'Missing Font', style: 'Regular' } },
      },
    ],
  })
  const value = res.value
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'unsupported')
  assert.equal(value.error.opIndex, 0)
  assert.ok(value.error.message.includes('Missing Font'), value.error.message)
  assert.ok(value.error.message.includes('Inter Regular'), value.error.message)
  assert.ok(value.error.message.includes('Roboto Regular'), value.error.message)
  assert.ok(h.state.listFontCalls >= 1, '字体缺失时必须调用 figma.listAvailableFontsAsync')
  assert.equal(h.state.nodesCreated, before, '字体加载失败时不能创建节点')
})


test('UI resize messages are clamped and applied through figma.ui.resize', async () => {
  const h = loadHarness()
  await h.figma.ui.onmessage({ type: 'resize', width: 300, height: 330 })
  assert.deepEqual(h.state.uiResize, { width: 300, height: 330 })
  await h.figma.ui.onmessage({ type: 'resize', width: 10, height: 9999 })
  assert.deepEqual(h.state.uiResize, { width: 220, height: 700 })
  assert.equal(h.state.showUI.options.width, 300)
  assert.equal(h.state.showUI.options.height, 112)
})
