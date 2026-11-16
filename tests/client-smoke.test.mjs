/**
 * Client card render smoke test.
 *
 * Loads the generated `client.js`, runs its factory against a minimal React
 * shim, installs the slot registrations against a fake slot service, and
 * renders the Plugins-page card in its loading, connected and uncertain states.
 * Catches render-time crashes before a page refresh.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function createReactShim() {
  let stateSlot = 0
  let overrides = []
  const createElement = (type, props, ...children) => {
    const merged = Object.assign({}, props)
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  }
  const react = {
    createElement,
    useState(initial) {
      const override = overrides[stateSlot]
      stateSlot += 1
      const value = override === undefined ? (typeof initial === 'function' ? initial() : initial) : override
      return [value, () => {}]
    },
    useRef(initial) { return { current: typeof initial === 'function' ? initial() : initial } },
    useCallback(fn) { return fn },
    useMemo(fn) { return typeof fn === 'function' ? fn() : fn },
    useEffect() {},
    useLayoutEffect() {},
    __beginInstance(list) {
      stateSlot = 0
      overrides = Array.isArray(list) ? list : []
    },
  }
  return react
}

function loadPlugin() {
  const react = createReactShim()
  const captured = {}
  const windowStub = { __ModuleLoader__: { load(definition) { captured.definition = definition; captured.factory = definition.factory } }, addEventListener() {}, removeEventListener() {} }
  const documentStub = { visibilityState: 'visible', body: { appendChild() {}, removeChild() {} }, createElement() { return { style: {}, appendChild() {}, remove() {}, click() {}, setAttribute() {} } } }
  const run = new Function('window', 'document', source)
  run(windowStub, documentStub)
  assert.ok(captured.factory, 'client.js must register a module factory')
  const plugin = captured.factory((name) => {
    if (name === 'react') return react
    throw new Error(`client half must not require ${name}`)
  })
  return { plugin, react, definition: captured.definition }
}

function installPlugin() {
  const { plugin, react, definition } = loadPlugin()
  assert.equal(definition.id, 'dsh-figma-designer')
  assert.deepEqual(plugin.inject, ['slots'])
  const registrations = []
  const fakeSlots = {
    inject(_key, callback) { return callback() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  }
  const fakeCtx = {
    get(name) { return name === 'slots' ? fakeSlots : undefined },
    effect(callback) { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {} },
  }
  plugin.apply(fakeCtx)
  return { registrations, react }
}

function renderTree(root, react) {
  const marker = { classes: new Set(), tags: new Set(), texts: [] }
  const walk = (node, level) => {
    if (level > 40) throw new Error('render tree too deep')
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string') { marker.texts.push(node); return }
    if (typeof node === 'number') return
    if (Array.isArray(node)) { for (const child of node) walk(child, level + 1); return }
    if (typeof node !== 'object' || !node.type) return
    const { type, props } = node
    if (typeof type === 'function') {
      react.__beginInstance(type.__stateOverrides)
      let output
      try { output = type(props) } finally { type.__stateOverrides = undefined }
      walk(output, level + 1)
      return
    }
    marker.tags.add(String(type))
    if (props && typeof props.className === 'string') for (const token of props.className.split(/\s+/)) if (token) marker.classes.add(token)
    if (props && props.style && typeof props.style === 'object') {
      for (const [key, value] of Object.entries(props.style)) marker.classes.add(`${key}:${value}`)
    }
    if (props && props.children !== undefined) walk(props.children, level + 1)
  }
  walk(root, 0)
  return marker
}

const connectedStatus = {
  ok: true,
  version: '0.1.0',
  bridge: {
    port: 3977,
    pairFile: '/tmp/pair.json',
    candidates: [3977],
    connections: [{ connectionId: 'c1', name: 'Marketing File', editorType: 'figma', pluginVersion: '0.1.0', uncertain: false }],
    uncertain: false,
  },
  companion: { dir: '/tmp/companion', manifestPath: '/tmp/companion/manifest.json', ports: [3977] },
}

test('client registers the Plugins-page card', () => {
  const { registrations } = installPlugin()
  const card = registrations.find((entry) => entry.options.name === 'plugins.item')
  assert.ok(card, 'plugins.item registration missing')
  assert.equal(card.options.id, 'figma-designer')
  assert.equal(typeof card.options.label, 'function')
  assert.ok(String(card.options.label()).length > 0)
})

test('renders the connected state with manifest path and actions', () => {
  const { registrations, react } = installPlugin()
  const card = registrations.find((entry) => entry.options.name === 'plugins.item')
  card.component.__stateOverrides = [{ loading: false, status: connectedStatus, error: null }]
  const marker = renderTree(react.createElement(card.component, {}), react)
  assert.ok(marker.tags.has('div'))
  assert.ok(marker.texts.some((text) => text.includes('Figma')), 'title missing')
  assert.ok(marker.texts.some((text) => text === '/tmp/companion/manifest.json'), 'manifest path missing')
  assert.ok(marker.texts.some((text) => text.includes('已连接') || text.includes('Connected')), 'connection badge missing')
  assert.ok(marker.texts.some((text) => text.includes('3977')), 'bridge port missing')
})

test('renders the disconnected state without a manifest', () => {
  const { registrations, react } = installPlugin()
  const card = registrations.find((entry) => entry.options.name === 'plugins.item')
  card.component.__stateOverrides = [{ loading: false, status: { ok: true, bridge: { port: 3978, connections: [], uncertain: false }, companion: null }, error: null }]
  const marker = renderTree(react.createElement(card.component, {}), react)
  assert.ok(marker.texts.some((text) => text.includes('未连接') || text.includes('Not connected')))
  assert.ok(marker.texts.some((text) => text.includes('还没生成') || text.includes('not been generated')), 'missing companion hint')
})

test('renders the uncertain badge and never throws', () => {
  const { registrations, react } = installPlugin()
  const card = registrations.find((entry) => entry.options.name === 'plugins.item')
  const uncertainStatus = JSON.parse(JSON.stringify(connectedStatus))
  uncertainStatus.bridge.uncertain = true
  uncertainStatus.bridge.connections[0].uncertain = true
  card.component.__stateOverrides = [{ loading: false, status: uncertainStatus, error: null }]
  const marker = renderTree(react.createElement(card.component, {}), react)
  assert.ok(marker.texts.some((text) => text.includes('未确认') || text.includes('Unconfirmed')))
})

test('renders the initial loading state', () => {
  const { registrations, react } = installPlugin()
  const card = registrations.find((entry) => entry.options.name === 'plugins.item')
  card.component.__stateOverrides = [{ loading: true, status: null, error: null }]
  const marker = renderTree(react.createElement(card.component, {}), react)
  assert.ok(marker.tags.has('div'))
  assert.ok(marker.texts.some((text) => text.includes('Figma')))
})
