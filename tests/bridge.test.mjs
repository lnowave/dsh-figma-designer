/**
 * Bridge protocol tests (v0.1).
 *
 * A fake plugin client speaks the same HTTP protocol as the Figma companion UI,
 * so connect/poll/result, long-poll timeouts, session binding, the uncertain
 * write barrier, auth/Host/content-type gating and reconnect semantics are all
 * proven without Figma.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBridge } from '../lib/bridge.js'

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }

async function startBridge(overrides = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), 'figma-designer-'))
  const bridge = await createBridge({
    homeDir,
    candidates: [0],
    pollTimeoutMs: 400,
    commandTimeoutMs: 400,
    logger: silentLogger,
    ...overrides,
  })
  return { bridge, homeDir, base: `http://127.0.0.1:${bridge.port}` }
}

const post = async (base, path, body, headers = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: response.status, data }
}

const asPlugin = (bridge) => {
  const base = `http://127.0.0.1:${bridge.port}`
  const auth = { authorization: `Bearer ${bridge.token}` }
  return {
    connect: (overrides = {}) => post(base, '/bridge/connect', {
      clientId: 'fake-client',
      name: 'Fake File',
      editorType: 'figma',
      version: '0.1.0',
      ...overrides,
    }, auth),
    poll: (connectionId) => post(base, '/bridge/poll', { connectionId }, auth),
    result: (connectionId, id, value) => post(base, '/bridge/result', { connectionId, id, ok: true, value }, auth),
    fail: (connectionId, id, error) => post(base, '/bridge/result', { connectionId, id, ok: false, error }, auth),
    heartbeat: (connectionId) => post(base, '/bridge/heartbeat', { connectionId }, auth),
    disconnect: (connectionId) => post(base, '/bridge/disconnect', { connectionId }, auth),
  }
}

test('connect → long-poll → result resolves a call and auto-binds a single file', async () => {
  const { bridge, homeDir } = await startBridge()
  try {
    const plugin = asPlugin(bridge)
    const connected = await plugin.connect()
    assert.equal(connected.status, 200)
    const connectionId = connected.data.connectionId
    assert.ok(connectionId)

    const pollPromise = plugin.poll(connectionId)
    const callPromise = bridge.call({ command: 'ping', sessionId: 'session-1' })
    const polled = await pollPromise
    assert.equal(polled.data.command, 'ping')
    await plugin.result(connectionId, polled.data.id, { ok: true, file: 'Fake File' })
    const result = await callPromise
    assert.equal(result.ok, true)
    assert.equal(result.value.file, 'Fake File')
    assert.ok(result.ms >= 0)

    const status = bridge.status('session-1')
    assert.equal(status.connections.length, 1)
    assert.equal(status.bound.connectionId, connectionId)
    assert.equal(status.needsSelection, false)
    assert.ok(status.port > 0)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('no connection yields actionable guidance, and multiple files require a selection', async () => {
  const { bridge, homeDir } = await startBridge()
  try {
    const none = await bridge.call({ command: 'read', sessionId: 's' })
    assert.equal(none.ok, false)
    assert.equal(none.error.code, 'not-connected')
    assert.match(none.error.message, /figma_setup|伴生插件/)

    const plugin = asPlugin(bridge)
    const first = await plugin.connect({ clientId: 'c1', name: 'File A' })
    const second = await plugin.connect({ clientId: 'c2', name: 'File B' })
    const ambiguous = await bridge.call({ command: 'read', sessionId: 's' })
    assert.equal(ambiguous.ok, false)
    assert.match(ambiguous.error.message, /figma_select/)

    const bound = bridge.bind('s', second.data.connectionId)
    assert.equal(bound.ok, true)
    const status = bridge.status('s')
    assert.equal(status.bound.connectionId, second.data.connectionId)
    assert.equal(status.needsSelection, false)
    assert.notEqual(first.data.connectionId, second.data.connectionId)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('long-poll returns idle when nothing is queued', async () => {
  const { bridge, homeDir } = await startBridge({ pollTimeoutMs: 120 })
  try {
    const plugin = asPlugin(bridge)
    const connected = await plugin.connect()
    const started = Date.now()
    const polled = await plugin.poll(connected.data.connectionId)
    assert.equal(polled.data.idle, true)
    assert.ok(Date.now() - started >= 80)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a timed-out write sets the uncertain barrier; a read clears it', async () => {
  const { bridge, homeDir } = await startBridge({ commandTimeoutMs: 150 })
  try {
    const plugin = asPlugin(bridge)
    const connected = await plugin.connect()
    const connectionId = connected.data.connectionId

    const pollPromise = plugin.poll(connectionId)
    const writePromise = bridge.call({ command: 'apply', sessionId: 's', write: true, timeoutMs: 150, args: { ops: [] } })
    const polled = await pollPromise
    assert.equal(polled.data.command, 'apply')
    const result = await writePromise
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'timeout')

    const status = bridge.status('s')
    assert.equal(status.uncertain, true)
    assert.equal(status.bound.uncertain, true)

    const refused = await bridge.call({ command: 'apply', sessionId: 's', write: true, args: { ops: [] } })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'uncertain-write')

    // A read is the reconcile gesture.
    const readPoll = plugin.poll(connectionId)
    const readCall = bridge.call({ command: 'read', sessionId: 's' })
    const readPolled = await readPoll
    await plugin.result(connectionId, readPolled.data.id, { ok: true, nodes: [] })
    const read = await readCall
    assert.equal(read.ok, true)
    bridge.clearUncertain(read.connectionId)
    assert.equal(bridge.status('s').uncertain, false)

    const writePoll = plugin.poll(connectionId)
    const writeAgain = bridge.call({ command: 'apply', sessionId: 's', write: true, args: { ops: [] } })
    const writePolled = await writePoll
    await plugin.result(connectionId, writePolled.data.id, { ok: true, applied: [] })
    assert.equal((await writeAgain).ok, true)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a plain read timeout does not create the write barrier', async () => {
  const { bridge, homeDir } = await startBridge({ commandTimeoutMs: 120 })
  try {
    const plugin = asPlugin(bridge)
    const connected = await plugin.connect()
    const pollPromise = plugin.poll(connected.data.connectionId)
    const readPromise = bridge.call({ command: 'read', sessionId: 's', timeoutMs: 120 })
    await pollPromise
    const result = await readPromise
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'timeout')
    assert.equal(bridge.status('s').uncertain, false)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a failed write marks the connection uncertain', async () => {
  const { bridge, homeDir } = await startBridge()
  try {
    const plugin = asPlugin(bridge)
    const connected = await plugin.connect()
    const connectionId = connected.data.connectionId
    const pollPromise = plugin.poll(connectionId)
    const callPromise = bridge.call({ command: 'apply', sessionId: 's', write: true, args: { ops: [] } })
    const polled = await pollPromise
    await plugin.fail(connectionId, polled.data.id, { code: 'figma-error', message: 'boom' })
    const result = await callPromise
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'figma-error')
    assert.equal(bridge.status('s').uncertain, true)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('auth, content type, host and preflight gating', async () => {
  const { bridge, homeDir, base } = await startBridge()
  try {
    const noToken = await post(base, '/bridge/connect', { clientId: 'x', name: 'x' })
    assert.equal(noToken.status, 401)

    const wrongToken = await post(base, '/bridge/connect', { clientId: 'x', name: 'x' }, { authorization: 'Bearer nope' })
    assert.equal(wrongToken.status, 401)

    const wrongType = await fetch(`${base}/bridge/connect`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${bridge.token}` },
      body: '{}',
    })
    assert.equal(wrongType.status, 415)

    const badHost = await new Promise((resolve) => {
      const req = httpRequest(`${base}/bridge/connect`, {
        method: 'POST',
        headers: { host: 'evil.example.com', 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
      }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', () => resolve(-1))
      req.end('{}')
    })
    assert.equal(badHost, 403)

    const preflight = await fetch(`${base}/bridge/poll`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('disconnect fails pending work and drops the binding', async () => {
  const { bridge, homeDir } = await startBridge()
  try {
    const plugin = asPlugin(bridge)
    const connected = await plugin.connect()
    const connectionId = connected.data.connectionId
    const pollPromise = plugin.poll(connectionId)
    const callPromise = bridge.call({ command: 'read', sessionId: 's' })
    await pollPromise
    await plugin.disconnect(connectionId)
    const result = await callPromise
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'plugin-disconnected')
    assert.equal(bridge.status('s').bound, null)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('reconnect with the same clientId reuses the connection; pairing token persists', async () => {
  const { bridge, homeDir } = await startBridge()
  try {
    const plugin = asPlugin(bridge)
    const first = await plugin.connect({ clientId: 'stable' })
    const second = await plugin.connect({ clientId: 'stable' })
    assert.equal(first.data.connectionId, second.data.connectionId)
  } finally {
    await bridge.close()
    // The token file survives for the next Host start.
    const next = await createBridge({ homeDir, candidates: [0], logger: silentLogger })
    assert.equal(next.token, bridge.token)
    await next.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a write lost to a disconnect stays uncertain after the companion reconnects', async () => {
  const { bridge, homeDir } = await startBridge()
  try {
    const plugin = asPlugin(bridge)
    const first = await plugin.connect({ clientId: 'c1', name: 'File A' })
    const firstId = first.data.connectionId

    const pollPromise = plugin.poll(firstId)
    const writePromise = bridge.call({ command: 'apply', sessionId: 's', write: true, args: { ops: [] } })
    const polled = await pollPromise
    assert.equal(polled.data.command, 'apply')

    // The companion drops while the write is in flight.
    await plugin.disconnect(firstId)
    const lost = await writePromise
    assert.equal(lost.ok, false)
    assert.equal(lost.error.code, 'plugin-disconnected')
    assert.equal(bridge.status('s').uncertain, true)

    // Reconnect returns a new connection id; the barrier must not disappear.
    const second = await plugin.connect({ clientId: 'c2', name: 'File A' })
    const secondId = second.data.connectionId
    assert.notEqual(secondId, firstId)
    assert.equal(bridge.status('s').uncertain, true)
    bridge.bind('s', secondId)

    const refused = await bridge.call({ command: 'apply', sessionId: 's', write: true, args: { ops: [] } })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'uncertain-write')

    // A successful read is the reconciliation gesture and clears the barrier.
    const readPoll = plugin.poll(secondId)
    const readCall = bridge.call({ command: 'read', sessionId: 's' })
    const readPolled = await readPoll
    await plugin.result(secondId, readPolled.data.id, { ok: true, nodes: [] })
    const read = await readCall
    assert.equal(read.ok, true)
    bridge.clearUncertain(read.connectionId)
    assert.equal(bridge.status('s').uncertain, false)

    const writePoll = plugin.poll(secondId)
    const writeAgain = bridge.call({ command: 'apply', sessionId: 's', write: true, args: { ops: [] } })
    const writePolled = await writePoll
    await plugin.result(secondId, writePolled.data.id, { ok: true, applied: [] })
    assert.equal((await writeAgain).ok, true)
  } finally {
    await bridge.close()
    rmSync(homeDir, { recursive: true, force: true })
  }
})
