/**
 * Tools integration tests (v0.1).
 *
 * Runs the real tool definitions against the real bridge with a fake plugin
 * client, so validation, dispatch, sesssion binding, screenshots and the
 * uncertain-write barrier are exercised end to end without Figma.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBridge } from '../lib/bridge.js'
import { registerTools } from '../lib/tools.js'

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64')

const post = async (base, path, body, token) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  })
  return { status: response.status, data: await response.json() }
}

/** Attach a fake Figma plugin that answers commands with `handler`. */
async function attachPlugin(bridge, handler) {
  const base = `http://127.0.0.1:${bridge.port}`
  const connected = await post(base, '/bridge/connect', { clientId: 'fake', name: 'Fake File', editorType: 'figma', version: '0.1.0' }, bridge.token)
  const connectionId = connected.data.connectionId
  const commands = []
  let running = true
  const loop = (async () => {
    while (running) {
      let poll
      try {
        poll = await post(base, '/bridge/poll', { connectionId }, bridge.token)
      } catch {
        return
      }
      if (!poll.data || poll.data.idle) continue
      commands.push(poll.data.command)
      const reply = await handler(poll.data.command, poll.data.args)
      await post(base, '/bridge/result', { connectionId, id: poll.data.id, ok: reply.ok !== false, value: reply.value ?? reply, error: reply.error }, bridge.token)
    }
  })()
  return {
    connectionId,
    commands,
    async stop() {
      running = false
      try {
        await post(base, '/bridge/disconnect', { connectionId }, bridge.token)
      } catch {
        /* ignore */
      }
      await loop.catch(() => {})
    },
  }
}

function makeTools(bridge, options = {}) {
  const registry = new Map()
  const attachments = options.attachments === undefined
    ? {
        async saveImage(input) {
          return {
            attachmentId: `sha256:${'a'.repeat(64)}`,
            mediaType: input.mediaType,
            bytes: input.data.byteLength,
            width: 640,
            height: 400,
            name: input.name,
          }
        },
      }
    : options.attachments
  const ctx = {
    tools: { register(definition) { registry.set(definition.name, definition); return () => registry.delete(definition.name) } },
    get(name) { return name === 'attachments' ? attachments : undefined },
  }
  registerTools(ctx, {
    bridge,
    companionFor: () => ({ dir: '/tmp/companion', manifestPath: '/tmp/companion/manifest.json', ports: [bridge.port] }),
    refreshCompanion: async () => ({ dir: '/tmp/companion', manifestPath: '/tmp/companion/manifest.json', ports: [bridge.port] }),
  })
  const call = (name, args, exec = { agent: { id: 'session-tools' } }) => registry.get(name).execute(args ?? {}, exec)
  return { registry, call, attachments }
}

async function start() {
  const homeDir = mkdtempSync(join(tmpdir(), 'figma-designer-tools-'))
  const bridge = await createBridge({ homeDir, candidates: [0], pollTimeoutMs: 300, commandTimeoutMs: 5000, logger: silentLogger })
  return { bridge, homeDir }
}

const fakeReadValue = {
  ok: true,
  page: { id: '0:1', name: 'Page 1' },
  target: 'selection',
  nodes: [{ id: '1:2', name: 'Frame 1', type: 'FRAME', visible: true, bounds: { x: 0, y: 0, width: 320, height: 200 } }],
  stats: { count: 1, truncated: false, maxNodes: 80, depth: 2 },
  selection: ['1:2'],
}

test('status works without a connection and guides setup', async () => {
  const { bridge, homeDir } = await start()
  try {
    const { call } = makeTools(bridge)
    const status = await call('figma_status')
    assert.equal(status.ok, true)
    assert.equal(status.backend, 'local')
    assert.equal(status.files.length, 0)
    assert.equal(status.setup.manifestPath, '/tmp/companion/manifest.json')
    assert.ok(status.instructions.some((line) => line.includes('Import plugin from manifest')))
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('setup returns the manifest path and steps', async () => {
  const { bridge, homeDir } = await start()
  try {
    const { call } = makeTools(bridge)
    const result = await call('figma_setup')
    assert.equal(result.ok, true)
    assert.equal(result.manifestPath, '/tmp/companion/manifest.json')
    assert.ok(Array.isArray(result.steps) && result.steps.length >= 3)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('read dispatches to the plugin and returns its tree', async () => {
  const { bridge, homeDir } = await start()
  try {
    const plugin = await attachPlugin(bridge, () => fakeReadValue)
    const { call } = makeTools(bridge)
    const result = await call('figma_read', { depth: 2 })
    assert.equal(result.ok, true)
    assert.equal(result.value.nodes[0].id, '1:2')
    assert.deepEqual(plugin.commands, ['read'])
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('audit reads the tree and library, then returns a score without writing', async () => {
  const { bridge, homeDir } = await start()
  try {
    const auditTreePayload = {
      ok: true,
      file: 'Fake File',
      page: { id: '0:1', name: 'Page 1' },
      target: 'selection',
      nodes: [
        {
          id: '1:2', name: 'Frame', type: 'FRAME', visible: true, opacity: 1, x: 0, y: 0, width: 390, height: 844,
          fills: [{ type: 'SOLID', color: '#0B1020', opacity: 1 }],
          children: [
            { id: '1:3', name: 'Heading', type: 'TEXT', visible: true, opacity: 1, x: 0, y: 0, width: 300, height: 40, fills: [{ type: 'SOLID', color: '#F8FAFC', opacity: 1 }], text: { characters: 'Hello', font: { family: 'Inter', style: 'Bold' }, fontSize: 32, lineHeight: { unit: 'PIXELS', value: 38 }, textAutoResize: 'NONE' } },
          ],
        },
      ],
      stats: { truncated: false },
      warnings: [],
    }
    const plugin = await attachPlugin(bridge, (command) => {
      if (command === 'tree') return auditTreePayload
      if (command === 'library') return { ok: true, file: 'Fake File', page: { id: '0:1', name: 'Page 1' }, components: [], componentSets: [], styles: { paint: [], text: [], effect: [], grid: [] }, variables: [], variableCollections: [], stats: {} }
      return { ok: false, error: { code: 'unsupported', message: `unexpected ${command}` } }
    })
    const { call } = makeTools(bridge)
    const result = await call('figma_audit', { target: 'selection' })
    assert.equal(result.ok, true)
    assert.equal(typeof result.score, 'number')
    assert.ok(Array.isArray(result.issues))
    assert.ok(plugin.commands.includes('tree'))
    assert.ok(plugin.commands.includes('library'))
    assert.ok(!plugin.commands.includes('apply'))
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('compare screenshots candidates and writes a self-contained HTML page', async () => {
  const { bridge, homeDir } = await start()
  const outDir = mkdtempSync(join(tmpdir(), 'figma-compare-'))
  try {
    const plugin = await attachPlugin(bridge, (command) => {
      if (command === 'screenshot') {
        return {
          ok: true,
          value: {
            ok: true,
            node: { id: '1:2', name: 'Candidate', type: 'FRAME' },
            scale: 1,
            image: { mimeType: 'image/png', bytes: 12, data: PNG_BASE64, width: 320, height: 640 },
          },
        }
      }
      return { ok: false, error: { code: 'unsupported', message: `unexpected ${command}` } }
    })
    const { call } = makeTools(bridge)
    const result = await call('figma_compare', {
      outDir,
      title: 'Pricing directions',
      candidates: [
        { nodeId: '1:2', name: 'Bold', concept: 'Editorial' },
        { nodeId: '1:3', name: 'Calm', concept: 'Quiet workspace' },
      ],
    })
    assert.equal(result.ok, true)
    assert.ok(result.htmlPath.endsWith('compare.html'))
    assert.ok(result.manifestPath.endsWith('manifest.json'))
    const html = readFileSync(result.htmlPath, 'utf8')
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    assert.match(html, /Pricing directions/)
    assert.match(html, /Bold/)
    assert.match(html, /data:image\/png;base64/)
    assert.equal(manifest.candidates.length, 2)
    assert.equal(manifest.candidates[1].name, 'Calm')
    assert.deepEqual(plugin.commands, ['screenshot', 'screenshot'])
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('invalid ops are rejected locally without touching Figma', async () => {
  const { bridge, homeDir } = await start()
  try {
    const plugin = await attachPlugin(bridge, () => ({ ok: true, value: {} }))
    const { call } = makeTools(bridge)
    const result = await call('figma_apply', { ops: [{ op: 'explode' }] })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'invalid-op')
    assert.ok(result.error.errors.length >= 1)
    assert.deepEqual(plugin.commands, [], 'invalid ops must not reach Figma')
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('dry-run sends no write and reports a plan', async () => {
  const { bridge, homeDir } = await start()
  try {
    const plugin = await attachPlugin(bridge, (command) => ({ ok: true, value: { ok: true, dryRun: true, plan: { willCreate: 2 }, applied: [] } }))
    const { call } = makeTools(bridge)
    const result = await call('figma_apply', {
      dryRun: true,
      ops: [
        { op: 'create', type: 'frame', width: 320, height: 200, children: [{ op: 'create', type: 'text', text: { characters: 'hi' } }] },
      ],
    })
    assert.equal(result.ok, true)
    // Host plan counts top-level ops; the plugin's dry-run plan (result.value.plan)
    // counts actual nodes. Keep both, with distinct names.
    assert.equal(result.hostPlan.willCreate, 1)
    assert.match(result.hostPlan.ops[0].description, /子节点/)
    assert.deepEqual(plugin.commands, ['apply'])
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a write applies, and a failed write sets the uncertain barrier refused by the next apply', async () => {
  const { bridge, homeDir } = await start()
  try {
    let failWrites = false
    const plugin = await attachPlugin(bridge, (command, args) => {
      if (command === 'apply' && args && args.dryRun === false && failWrites) {
        return { ok: false, error: { code: 'figma-error', message: 'boom' } }
      }
      return { ok: true, value: { ok: true, dryRun: false, applied: [{ opIndex: 0, op: 'create', nodeId: '1:3' }] } }
    })
    const { call } = makeTools(bridge)
    const ops = [{ op: 'create', type: 'rect', width: 100, height: 100 }]

    const ok = await call('figma_apply', { ops })
    assert.equal(ok.ok, true)
    assert.equal(ok.value.applied[0].nodeId, '1:3')

    failWrites = true
    const failed = await call('figma_apply', { ops })
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'figma-error')

    const status = await call('figma_status', { compact: true })
    assert.equal(status.uncertain, true)
    assert.equal(status.bound.uncertain, true)

    const refused = await call('figma_apply', { ops })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'uncertain-write')
    assert.deepEqual(plugin.commands, ['apply', 'apply'])
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('an op-level failure inside a successful envelope surfaces as a tool failure', async () => {
  const { bridge, homeDir } = await start()
  try {
    await attachPlugin(bridge, () => ({
      ok: true,
      value: {
        ok: false,
        error: { code: 'node-not-found', message: '找不到节点 9:9', opIndex: 1 },
        applied: [{ opIndex: 0, op: 'create', nodeId: '1:3' }],
      },
    }))
    const { call } = makeTools(bridge)
    const result = await call('figma_apply', {
      ops: [
        { op: 'create', type: 'rect', width: 100, height: 100 },
        { op: 'update', nodeId: '9:9', patch: { fill: '#000000' } },
      ],
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'node-not-found')
    assert.equal(result.applied.length, 1)
    assert.equal(result.hostPlan.ops.length, 2)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('screenshot persists the PNG and returns a durable image attachment', async () => {
  const { bridge, homeDir } = await start()
  try {
    await attachPlugin(bridge, () => ({
      ok: true,
      value: {
        ok: true,
        node: { id: '1:2', name: 'Frame 1', type: 'FRAME' },
        scale: 2,
        image: { mimeType: 'image/png', bytes: 12, width: 640, height: 400, data: PNG_BASE64 },
      },
    }))
    const { registry, call } = makeTools(bridge)
    const value = await call('figma_screenshot', { nodeId: '1:2', scale: 2 })
    assert.equal(value.ok, true)
    const content = registry.get('figma_screenshot').output.render({}, value)
    assert.equal(content[0].type, 'text')
    const summary = JSON.parse(content[0].text)
    assert.equal(summary.width, 640)
    assert.equal(summary.mediaType, 'image/png')
    assert.equal(content[1].type, 'image')
    assert.equal(content[1].attachment.attachmentId, `sha256:${'a'.repeat(64)}`)
    // The canonical block carries a durable reference only; raw base64 in a
    // tool result is what used to poison the session.
    assert.equal(content[1].data, undefined)
    assert.equal(content[1].mimeType, undefined)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('screenshot without an attachment store fails safely instead of emitting raw base64', async () => {
  const { bridge, homeDir } = await start()
  try {
    await attachPlugin(bridge, () => ({
      ok: true,
      value: {
        ok: true,
        node: { id: '1:2', name: 'Frame 1', type: 'FRAME' },
        scale: 1,
        image: { mimeType: 'image/png', bytes: 12, width: 640, height: 400, data: PNG_BASE64 },
      },
    }))
    const { registry, call } = makeTools(bridge, { attachments: null })
    const value = await call('figma_screenshot', { nodeId: '1:2' })
    assert.equal(value.ok, false)
    assert.equal(value.error.code, 'image-unsupported')
    const content = registry.get('figma_screenshot').output.render({}, value)
    assert.equal(content.length, 1)
    assert.equal(content[0].type, 'text')
    assert.equal(content.some((block) => block.type === 'image'), false)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('apply without a connection reports not-connected and the setup hint', async () => {
  const { bridge, homeDir } = await start()
  try {
    const { call } = makeTools(bridge)
    const result = await call('figma_apply', { ops: [{ op: 'create', type: 'rect', width: 10, height: 10 }] })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'not-connected')
    assert.match(result.error.message, /figma_setup/)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('select binds an explicit file when several are connected', async () => {
  const { bridge, homeDir } = await start()
  try {
    const first = await attachPlugin(bridge, () => fakeReadValue)
    const base = `http://127.0.0.1:${bridge.port}`
    const secondConnect = await post(base, '/bridge/connect', { clientId: 'second', name: 'Second File', editorType: 'figma', version: '0.1.0' }, bridge.token)
    const { call } = makeTools(bridge)

    const list = await call('figma_select', {})
    assert.equal(list.ok, true)
    assert.equal(list.files.length, 2)
    assert.equal(list.needsSelection, true)

    const selected = await call('figma_select', { fileName: 'Second File' })
    assert.equal(selected.ok, true)
    assert.equal(selected.bound.connectionId, secondConnect.data.connectionId)

    const status = await call('figma_status', { compact: true })
    assert.equal(status.bound.connectionId, secondConnect.data.connectionId)

    await first.stop()
    await post(base, '/bridge/disconnect', { connectionId: secondConnect.data.connectionId }, bridge.token)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('figma_export writes html, jsx, json and native svg files', async () => {
  const { bridge, homeDir } = await start()
  const outRoot = mkdtempSync(join(tmpdir(), 'figma-export-tools-'))
  try {
    await attachPlugin(bridge, (command) => {
      if (command === 'tree') {
        return {
          ok: true,
          value: {
            ok: true,
            file: 'Pricing',
            page: { id: '0:1', name: 'Page 1' },
            nodes: [{
              id: '1:2',
              name: 'Pricing / Desktop',
              type: 'FRAME',
              visible: true,
              opacity: 1,
              rotation: 0,
              x: 0,
              y: 0,
              width: 400,
              height: 200,
              fills: [{ type: 'SOLID', color: '#0B1020', opacity: 1 }],
              layout: { mode: 'VERTICAL', itemSpacing: 16, padding: { top: 20, right: 20, bottom: 20, left: 20 }, primaryAxisAlign: 'MIN', counterAxisAlign: 'MIN' },
              children: [{
                id: '1:3', name: 'Headline', type: 'TEXT', visible: true, opacity: 1, rotation: 0, x: 0, y: 0, width: 360, height: 40,
                fills: [{ type: 'SOLID', color: '#FFFFFF', opacity: 1 }],
                text: { characters: 'Exported', font: { family: 'Inter', style: 'Bold' }, fontSize: 32, align: 'LEFT' },
              }],
            }],
            stats: { count: 2, truncated: false, maxNodes: 1200, depth: 20 },
            warnings: [],
          },
        }
      }
      if (command === 'export') {
        return {
          ok: true,
          value: {
            ok: true,
            files: [{ nodeId: '1:2', name: 'Pricing / Desktop', format: 'SVG', bytes: 12, data: Buffer.from('<svg></svg>').toString('base64') }],
          },
        }
      }
      return { ok: true, value: { ok: true } }
    })
    const { call } = makeTools(bridge)

    const htmlDir = join(outRoot, 'html')
    const html = await call('figma_export', { format: 'html', outDir: htmlDir })
    assert.equal(html.ok, true)
    assert.equal(html.format, 'html')
    assert.equal(html.files[0].name, 'index.html')
    assert.match(readFileSync(join(htmlDir, 'index.html'), 'utf8'), /class="figma-root pricing-desktop-1-2"/)

    const jsxDir = join(outRoot, 'jsx')
    const jsx = await call('figma_export', { format: 'jsx', outDir: jsxDir })
    assert.equal(jsx.ok, true)
    assert.deepEqual(jsx.files.map((file) => file.name).sort(), ['App.jsx', 'styles.css'])
    assert.match(readFileSync(join(jsxDir, 'App.jsx'), 'utf8'), /export default function App/)

    const jsonDir = join(outRoot, 'json')
    const json = await call('figma_export', { format: 'json', outDir: jsonDir })
    assert.equal(json.ok, true)
    assert.equal(JSON.parse(readFileSync(join(jsonDir, 'design.json'), 'utf8')).generatedBy, 'dsh-figma-designer')

    const svgDir = join(outRoot, 'svg')
    const svg = await call('figma_export', { format: 'svg', outDir: svgDir })
    assert.equal(svg.ok, true)
    assert.equal(svg.files.length, 1)
    assert.equal(readFileSync(svg.files[0].path, 'utf8'), '<svg></svg>')
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(outRoot, { recursive: true, force: true })
  }
})

test('figma_export validates format and node target without calling Figma', async () => {
  const { bridge, homeDir } = await start()
  try {
    const { call } = makeTools(bridge)
    const badFormat = await call('figma_export', { format: 'pdf' })
    assert.equal(badFormat.ok, false)
    assert.equal(badFormat.error.code, 'invalid-format')
    const noNode = await call('figma_export', { format: 'html', target: 'node' })
    assert.equal(noNode.ok, false)
    assert.equal(noNode.error.code, 'invalid-target')
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('design-system tools dispatch library / instantiate / style / variable commands', async () => {
  const { bridge, homeDir } = await start()
  try {
    const seen = []
    await attachPlugin(bridge, (command, args) => {
      seen.push({ command, args })
      if (command === 'library') {
        return {
          ok: true,
          value: {
            ok: true,
            file: 'Test file',
            page: { id: '0:1', name: 'Page 1' },
            components: [{ id: '2:1', name: 'Button / Primary', type: 'COMPONENT', width: 220, height: 48 }],
            componentSets: [],
            styles: { paint: [{ id: 'S:1', name: 'Brand/Primary', type: 'PAINT' }], text: [], effect: [], grid: [] },
            variableCollections: [{ id: 'VC:1', name: 'Design Tokens', defaultModeId: 'm1' }],
            variables: [{ id: 'V:1', name: 'color/primary', resolvedType: 'COLOR' }],
            stats: { components: 1, componentSets: 0, variables: 1 },
            warnings: [],
          },
        }
      }
      if (command === 'instantiate') {
        return { ok: true, value: { ok: true, node: { id: '3:1', name: 'Button', type: 'INSTANCE' }, component: { id: '2:1', name: 'Button / Primary' }, overrides: [{ nodeId: '3:2', name: 'Label', changes: ['text'] }], warnings: [] } }
      }
      if (command === 'styles') {
        return { ok: true, value: { ok: true, style: { id: 'S:1', name: 'Brand/Primary', type: 'PAINT' }, node: { id: '3:1', name: 'Button' } } }
      }
      if (command === 'variables') {
        return { ok: true, value: { ok: true, collections: [{ id: 'VC:1', name: 'Design Tokens' }], variables: [{ id: 'V:1', name: 'color/primary' }] } }
      }
      return { ok: true, value: { ok: true } }
    })
    const { call } = makeTools(bridge)

    const library = await call('figma_library', { kind: 'components' })
    assert.equal(library.ok, true)
    assert.equal(library.components[0].name, 'Button / Primary')
    assert.equal(library.componentSets.length, 0)

    const instance = await call('figma_instantiate', { componentName: 'Button', parentId: '5:2', x: 10, y: 20, overrides: [{ nodeName: 'Label', text: 'Go' }] })
    assert.equal(instance.ok, true)
    assert.equal(instance.value.node.id, '3:1')

    const style = await call('figma_style', { action: 'apply', nodeId: '3:1', styleName: 'Brand/Primary', target: 'fill' })
    assert.equal(style.ok, true)
    assert.equal(style.value.style.id, 'S:1')

    const variable = await call('figma_variable', { action: 'bind', variableId: 'V:1', nodeId: '3:1', field: 'fill' })
    assert.equal(variable.ok, true)

    assert.deepEqual(seen.map((item) => item.command), ['library', 'instantiate', 'styles', 'variables'])
    assert.deepEqual(seen[1].args.overrides, [{ nodeName: 'Label', text: 'Go' }])
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('design-system tools reject missing required arguments before dispatch', async () => {
  const { bridge, homeDir } = await start()
  try {
    const { call } = makeTools(bridge)
    const instance = await call('figma_instantiate', {})
    assert.equal(instance.ok, false)
    assert.equal(instance.error.code, 'invalid-args')
    const style = await call('figma_style', { action: 'create', kind: 'paint' })
    assert.equal(style.ok, false)
    assert.equal(style.error.code, 'invalid-args')
    const variable = await call('figma_variable', { action: 'bind', variableId: 'V:1' })
    assert.equal(variable.ok, false)
    assert.equal(variable.error.code, 'invalid-args')
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('figma_export tokens writes tokens.json/css/js from the library', async () => {
  const { bridge, homeDir } = await start()
  const outDir = mkdtempSync(join(tmpdir(), 'figma-tokens-'))
  try {
    await attachPlugin(bridge, (command) => {
      if (command === 'library') {
        return {
          ok: true,
          value: {
            ok: true,
            file: 'Design System',
            page: { id: '0:1', name: 'Page 1' },
            variableCollections: [{ id: 'VC:1', name: 'Design Tokens', defaultModeId: 'm1' }],
            variables: [
              { id: 'V:1', name: 'color/primary', resolvedType: 'COLOR', collectionId: 'VC:1', valuesByMode: { m1: '#F97316' } },
              { id: 'V:2', name: 'space/16', resolvedType: 'FLOAT', collectionId: 'VC:1', valuesByMode: { m1: 16 } },
            ],
            styles: { paint: [], text: [{ id: 'S:1', name: 'Heading / XL', type: 'TEXT', font: { family: 'Inter', style: 'Bold' }, fontSize: 48 }], effect: [], grid: [] },
            warnings: [],
          },
        }
      }
      return { ok: true, value: { ok: true } }
    })
    const { call } = makeTools(bridge)
    const result = await call('figma_export', { format: 'tokens', outDir })
    assert.equal(result.ok, true)
    assert.equal(result.format, 'tokens')
    assert.deepEqual(result.files.map((file) => file.name).sort(), ['tokens.css', 'tokens.js', 'tokens.json'])
    const tokens = JSON.parse(readFileSync(join(outDir, 'tokens.json'), 'utf8'))
    assert.equal(tokens.color.primary.$value, '#F97316')
    assert.match(readFileSync(join(outDir, 'tokens.css'), 'utf8'), /--space-16: 16px;/)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('figma_component_set creates variants through the companion', async () => {
  const { bridge, homeDir } = await start()
  try {
    let received = null
    await attachPlugin(bridge, (command, args) => {
      if (command === 'variants') {
        received = args
        return { ok: true, value: { ok: true, componentSet: { id: '2:9', name: 'Button Variants', type: 'COMPONENT_SET', variants: [{ id: '2:10', name: 'Size=Small' }] }, warnings: [] } }
      }
      return { ok: true, value: { ok: true } }
    })
    const { call } = makeTools(bridge)
    const result = await call('figma_component_set', {
      name: 'Button Variants',
      baseComponentName: 'Button / Primary',
      variants: [{ properties: { Size: 'Small' }, width: 160 }, { properties: { Size: 'Large' }, width: 280 }],
    })
    assert.equal(result.ok, true)
    assert.equal(result.value.componentSet.id, '2:9')
    assert.equal(received.variants.length, 2)
    const missing = await call('figma_component_set', { variants: [] })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'invalid-args')
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})
