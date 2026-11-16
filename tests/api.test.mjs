/**
 * Settings-card API route registration tests.
 *
 * The card is served from the same Web origin as `/figma-designer/api/*`. The
 * Host bundle can be applied before `webServer`'s fiber is active, so the
 * routes must register through `ctx.inject`, not a one-shot `ctx.get`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { registerApiRoutes } from '../lib/api.js'

const makeContext = (immediateWebServer) => {
  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    get(name) { return name === 'webServer' ? immediateWebServer : undefined },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      callback({ webServer })
      return () => {}
    },
  }
  return { ctx, routes }
}

const bridge = {
  status: () => ({
    port: 3977,
    pairFile: '/tmp/pair.json',
    candidates: [3977],
    connections: [{ connectionId: 'c1', name: 'Figma', editorType: 'figma', pluginVersion: '0.1.1', uncertain: false }],
    uncertain: false,
  }),
}

const invoke = async (handler) => {
  let status = 0
  let body = ''
  const req = {
    method: 'POST',
    headers: {},
    on(event, callback) { if (event === 'end') callback() },
  }
  const res = {
    writableEnded: false,
    writeHead(next) { status = next },
    end(chunk) { body = chunk },
  }
  await handler(req, res)
  return { status, data: JSON.parse(body) }
}

test('registers the card routes through ctx.inject when webServer is not active yet', async () => {
  const { ctx, routes } = makeContext(undefined)
  const dispose = registerApiRoutes(ctx, {
    bridge,
    companionFor: () => ({ dir: '/tmp/companion', manifestPath: '/tmp/companion/manifest.json', ports: [3977] }),
    refreshCompanion: async () => ({ dir: '/tmp/companion', manifestPath: '/tmp/companion/manifest.json', ports: [3977] }),
    version: '0.1.2',
  })
  assert.deepEqual([...routes.keys()].sort(), ['/figma-designer/api/setup', '/figma-designer/api/status'])
  const result = await invoke(routes.get('/figma-designer/api/status'))
  assert.equal(result.status, 200)
  assert.equal(result.data.ok, true)
  assert.equal(result.data.version, '0.1.2')
  assert.equal(result.data.bridge.connections[0].name, 'Figma')
  dispose()
  assert.equal(routes.size, 0)
})

test('registers immediately when webServer is already available and rejects non-POST', async () => {
  const { ctx, routes } = makeContext({ register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
  // Replace the immediate server with the shared recorder.
  ctx.get = (name) => (name === 'webServer' ? { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } } : undefined)
  registerApiRoutes(ctx, {
    bridge,
    companionFor: () => null,
    refreshCompanion: async () => ({ dir: '', manifestPath: '', ports: [] }),
    version: '0.1.2',
  })
  const handler = routes.get('/figma-designer/api/status')
  assert.ok(handler)
  let status = 0
  await handler({ method: 'GET', headers: {}, on() {} }, { writableEnded: false, writeHead(next) { status = next }, end() {} })
  assert.equal(status, 405)
})
