/**
 * Same-origin JSON routes for the plugin's settings card.
 *
 * The Client half cannot call Host services directly, so the card reads setup
 * and connection state over these routes on the Harness web origin. They are
 * deliberately not CORS-enabled: only the page itself may call them, and they
 * never expose the pairing token.
 *
 * @module dsh-figma-designer/lib/api
 */

const readService = (ctx, name) => {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined) return viaGet
  } catch {
    /* fall through */
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

const sendJson = (res, status, value) => {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

const readBody = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (raw.length === 0) {
      resolve({})
      return
    }
    try {
      resolve(JSON.parse(raw))
    } catch {
      resolve({})
    }
  })
  req.on('error', () => resolve({}))
})

const isLoopbackOrigin = (origin) => {
  if (typeof origin !== 'string') return true
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * @param {object} ctx
 * @param {{ bridge: object, companionFor: () => object, refreshCompanion: () => Promise<object>, version: string }} deps
 */
export function registerApiRoutes(ctx, deps) {
  const { bridge, companionFor, refreshCompanion, version } = deps
  const disposers = []
  let registered = false
  let disposed = false

  const registerOn = (webServer) => {
    if (disposed || registered) return
    if (!webServer || typeof webServer.register !== 'function') return
    registered = true

    const route = (path, handler) => {
      const wrapped = async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'post-required' })
            return
          }
          if (!isLoopbackOrigin(req.headers.origin)) {
            sendJson(res, 403, { ok: false, error: 'loopback-only' })
            return
          }
          await handler(req, res)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
        }
      }
      disposers.push(webServer.register({ kind: 'exact', path, handler: wrapped }))
    }

    route('/figma-designer/api/status', async (req, res) => {
      await readBody(req)
      const companion = companionFor()
      const status = bridge.status()
      sendJson(res, 200, {
        ok: true,
        version,
        bridge: {
          port: status.port,
          pairFile: status.pairFile,
          candidates: status.candidates,
          connections: status.connections.map((item) => ({
            connectionId: item.connectionId,
            name: item.name,
            editorType: item.editorType,
            pluginVersion: item.pluginVersion,
            uncertain: item.uncertain,
          })),
          uncertain: status.uncertain,
        },
        companion: companion
          ? { dir: companion.dir, manifestPath: companion.manifestPath, ports: companion.ports }
          : null,
      })
    })

    route('/figma-designer/api/setup', async (req, res) => {
      await readBody(req)
      const companion = await refreshCompanion()
      sendJson(res, 200, {
        ok: true,
        companion: { dir: companion.dir, manifestPath: companion.manifestPath, ports: companion.ports },
        steps: [
          '打开 Figma 桌面版',
          'Plugins → Development → Import plugin from manifest…',
          `选择 ${companion.manifestPath}`,
          '在目标文件运行 DSH Figma Designer 并保持窗口打开',
        ],
      })
    })
  }

  // `ctx.get('webServer')` is strict about the providing fiber being active.
  // A bundle can be applied before the web server fiber reaches that state, so
  // an immediate lookup silently misses the service. `ctx.inject` waits for
  // the dependency and registers the card API once it is available.
  const immediate = readService(ctx, 'webServer')
  if (immediate) {
    registerOn(immediate)
  } else if (ctx && typeof ctx.inject === 'function') {
    try {
      const disposeInject = ctx.inject(['webServer'], (webCtx) => {
        registerOn(readService(webCtx, 'webServer'))
      })
      if (typeof disposeInject === 'function') disposers.push(disposeInject)
    } catch (error) {
      try {
        ctx.logger?.warn?.(`figma-designer: webServer injection failed: ${error && error.message ? error.message : error}`)
      } catch {
        /* logging is best effort */
      }
    }
  }

  return () => {
    disposed = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* best effort */
      }
    }
    disposers.length = 0
  }
}
