/**
 * Local bridge between the DSH Host and the Figma companion plugin.
 *
 * Design: the bridge owns one loopback HTTP server (default port 3977) and one
 * long-poll connection per open Figma file. The companion plugin's UI polls for
 * commands and posts results back; this module exposes `call(...)` so tools can
 * issue commands synchronously and get results or structured failures.
 *
 * Security (learned from Phase 0 and from figwright's threat model):
 * - listen on 127.0.0.1 only;
 * - require a pairing token (constant-time compare) written to a 0600 file;
 * - reject requests whose Host header is not loopback:port (DNS rebinding);
 * - require `content-type: application/json` (browsers must preflight, so a
 *   random page cannot fire a simple request at the bridge);
 * - accept the companion iframe's opaque `Origin: null`.
 *
 * @module dsh-figma-designer/lib/bridge
 */

import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const BRIDGE_VERSION = '0.1.0'
export const DEFAULT_PORT = 3977
export const CANDIDATE_PORTS = [3977, 3978, 3979, 3980, 3981, 3982, 3983, 3984, 3985, 3986]
const MAX_BODY = 32 * 1024 * 1024
const STALE_MS = 45000

const safeEqual = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) {
      reject(new Error('body-too-large'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (raw.length === 0) {
      resolve({})
      return
    }
    try {
      resolve(JSON.parse(raw))
    } catch {
      reject(new Error('invalid-json'))
    }
  })
  req.on('error', reject)
})

const isLoopbackHost = (header, port) => {
  const value = String(header ?? '').toLowerCase()
  return value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`
}

const contentTypeOk = (req) => /^application\/json/i.test(String(req.headers['content-type'] ?? ''))

function setCors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
  res.setHeader('access-control-max-age', '600')
  res.setHeader('cache-control', 'no-store')
}

function sendJson(res, status, value) {
  if (res.writableEnded) return
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  }
  res.end(JSON.stringify(value))
}

const readPairToken = (pairFile) => {
  try {
    const parsed = JSON.parse(readFileSync(pairFile, 'utf8'))
    return typeof parsed.token === 'string' && parsed.token.length >= 16 ? parsed.token : null
  } catch {
    return null
  }
}

const writePairFile = (pairFile, payload) => {
  mkdirSync(dirname(pairFile), { recursive: true, mode: 0o700 })
  const tmp = `${pairFile}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, pairFile)
}

/**
 * @param {{ homeDir: string, port?: number, candidates?: number[], pollTimeoutMs?: number, commandTimeoutMs?: number, logger?: Console }} options
 */
export async function createBridge(options = {}) {
  const homeDir = options.homeDir
  if (typeof homeDir !== 'string' || homeDir.length === 0) throw new Error('createBridge requires homeDir')
  const pairFile = join(homeDir, 'figma-designer', 'pair.json')
  const requestedPort = Number.isFinite(options.port) ? Number(options.port) : DEFAULT_PORT
  const candidates = Array.isArray(options.candidates) && options.candidates.length > 0
    ? options.candidates.map(Number).filter(Number.isFinite)
    : [requestedPort, ...CANDIDATE_PORTS.filter((port) => port !== requestedPort)]
  const token = readPairToken(pairFile) ?? randomBytes(24).toString('hex')
  const pollTimeoutMs = options.pollTimeoutMs ?? 20000
  const commandTimeoutMs = options.commandTimeoutMs ?? 120000
  const log = (event, detail) => {
    try {
      const logger = options.logger ?? console
      logger.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }))
    } catch {
      /* logging never breaks the bridge */
    }
  }

  const connections = new Map()
  /** sessionId -> connectionId */
  const bindings = new Map()
  /**
   * Whether some dispatched write may have reached Figma without a confirmed
   * result. Tracked globally (not per connection id) because a companion that
   * disconnects and reconnects gets a new id; a per-id set would silently drop
   * the barrier exactly when it matters.
   */
  let uncertain = false
  const recent = []
  let server = null
  let port = null
  let sweeper = null
  let closed = false

  const pushRecent = (entry) => {
    recent.unshift(entry)
    if (recent.length > 40) recent.length = 40
  }

  const rejectQueue = (conn, code, message, markUncertain) => {
    if (markUncertain && (conn.active?.write || conn.queue.some((job) => job.write))) uncertain = true
    if (conn.active) {
      const job = conn.active
      conn.active = null
      job.finish({ ok: false, error: { code, message } })
    }
    while (conn.queue.length > 0) {
      const job = conn.queue.shift()
      job.finish({ ok: false, error: { code, message } })
    }
  }

  const dispatch = (conn) => {
    if (conn.active || !conn.poll) return
    const job = conn.queue.shift()
    if (!job) return
    conn.active = job
    job.timer = setTimeout(() => {
      if (conn.active !== job) return
      conn.active = null
      if (job.write) uncertain = true
      log('command-timeout', { command: job.command, id: job.id, write: job.write })
      job.finish({
        ok: false,
        error: {
          code: 'timeout',
          message: `Figma 在 ${job.timeoutMs}ms 内没有返回结果。${job.write ? '写入结果未知，请先 figma_read 核查受影响节点再继续。' : '请确认 Figma 插件仍在运行。'}`,
        },
      })
      dispatch(conn)
    }, job.timeoutMs)
    const poll = conn.poll
    conn.poll = null
    clearTimeout(poll.timer)
    log('dispatch', { command: job.command, id: job.id, connectionId: conn.id, write: job.write })
    sendJson(poll.res, 200, { id: job.id, command: job.command, args: job.args })
  }

  const connectionList = () => [...connections.values()].map((conn) => ({
    connectionId: conn.id,
    name: conn.name,
    fileKey: conn.fileKey,
    editorType: conn.editorType,
    pluginVersion: conn.version,
    connectedAt: conn.createdAt,
    lastSeen: conn.lastSeen,
    pending: conn.queue.length + (conn.active ? 1 : 0),
    uncertain,
  }))

  /** Resolve (and lazily bind) the connection for one DSH session. */
  const resolveConnection = (sessionId) => {
    if (typeof sessionId === 'string') {
      const boundId = bindings.get(sessionId)
      const bound = boundId ? connections.get(boundId) : null
      if (bound) return bound
      if (boundId) bindings.delete(sessionId)
    }
    const list = [...connections.values()]
    if (list.length === 1) {
      const only = list[0]
      if (typeof sessionId === 'string') bindings.set(sessionId, only.id)
      return only
    }
    return null
  }

  /**
   * Issue one command. Never rejects; returns `{ ok, value, error, ms }`.
   * @param {{ command: string, args?: object, sessionId?: string, write?: boolean, timeoutMs?: number, connectionId?: string }} input
   */
  const call = (input) => {
    const started = Date.now()
    const command = typeof input.command === 'string' ? input.command : ''
    if (command.length === 0) {
      return Promise.resolve({ ok: false, error: { code: 'invalid-command', message: '缺少 command' }, ms: 0 })
    }
    const explicit = input.connectionId ? connections.get(input.connectionId) : null
    const conn = explicit ?? resolveConnection(input.sessionId)
    if (!conn) {
      const count = connections.size
      return Promise.resolve({
        ok: false,
        error: {
          code: 'not-connected',
          message: count === 0
            ? 'Figma 未连接：请在 Figma 桌面版运行 DSH Figma Designer 伴生插件（先调用 figma_setup 获取导入路径），并在目标文件里保持插件窗口打开。'
            : '当前有多个 Figma 文件连接，请先调用 figma_select 选择目标文件。',
        },
        ms: 0,
      })
    }
    if (input.write && uncertain) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'uncertain-write',
          message: '上一次写入结果不确定（超时或断线）。请先调用 figma_read 核查受影响节点，确认后再继续写入。',
        },
        ms: 0,
        connectionId: conn.id,
      })
    }
    const job = {
      id: randomUUID(),
      command,
      args: input.args && typeof input.args === 'object' ? input.args : {},
      write: input.write === true,
      timeoutMs: Number.isFinite(input.timeoutMs) ? input.timeoutMs : commandTimeoutMs,
      timer: null,
      finish: null,
    }
    return new Promise((resolve) => {
      job.finish = (payload) => {
        if (job.timer) clearTimeout(job.timer)
        const result = { ...payload, ms: Date.now() - started, command, connectionId: conn.id }
        pushRecent({
          at: new Date().toISOString(),
          command,
          ok: result.ok === true,
          ms: result.ms,
          write: job.write,
          error: result.ok === true ? null : result.error?.code ?? 'error',
        })
        resolve(result)
      }
      conn.queue.push(job)
      dispatch(conn)
    })
  }

  const bind = (sessionId, connectionId) => {
    const conn = connections.get(connectionId)
    if (!conn) return { ok: false, error: { code: 'not-connected', message: '目标 Figma 文件未连接' } }
    if (typeof sessionId === 'string') bindings.set(sessionId, conn.id)
    return { ok: true, connection: connectionList().find((item) => item.connectionId === conn.id) }
  }

  const unbind = (sessionId) => {
    if (typeof sessionId === 'string') bindings.delete(sessionId)
  }

  const status = (sessionId) => {
    const boundId = typeof sessionId === 'string' ? bindings.get(sessionId) : undefined
    const bound = boundId ? connections.get(boundId) : null
    return {
      ok: true,
      bridgeVersion: BRIDGE_VERSION,
      port,
      candidates,
      pairFile,
      connections: connectionList(),
      bound: bound ? {
        connectionId: bound.id,
        name: bound.name,
        editorType: bound.editorType,
        uncertain,
      } : null,
      needsSelection: !bound && connections.size > 1,
      uncertain,
      recent,
    }
  }

  /** A read is the reconciliation gesture: clear the uncertain barrier on success. */
  const clearUncertain = (connectionId) => {
    // Any successful read reconciles model-visible state; clear the global
    // barrier so a reconnect cannot leave a permanent stale warning.
    uncertain = false
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port ?? 0}`)
      const path = url.pathname
      if (req.method === 'OPTIONS') {
        setCors(res)
        res.writeHead(204)
        res.end()
        return
      }
      if (!path.startsWith('/bridge/')) {
        sendJson(res, 404, { error: 'not-found' })
        return
      }
      setCors(res)
      if (!isLoopbackHost(req.headers.host, port)) {
        sendJson(res, 403, { error: 'host-rejected' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'post-required' })
        return
      }
      if (!contentTypeOk(req)) {
        sendJson(res, 415, { error: 'json-content-type-required' })
        return
      }
      if (!safeEqual(req.headers.authorization, `Bearer ${token}`)) {
        sendJson(res, 401, { error: 'pairing-token-required' })
        return
      }
      const body = await readBody(req)

      if (path === '/bridge/connect') {
        const clientId = typeof body.clientId === 'string' && body.clientId.length > 0 ? body.clientId : null
        let conn = clientId ? [...connections.values()].find((item) => item.clientId === clientId) : null
        if (!conn) {
          conn = {
            id: randomUUID(),
            clientId,
            name: typeof body.name === 'string' ? body.name.slice(0, 200) : 'Figma',
            fileKey: typeof body.fileKey === 'string' ? body.fileKey.slice(0, 200) : null,
            editorType: typeof body.editorType === 'string' ? body.editorType.slice(0, 40) : 'figma',
            version: typeof body.version === 'string' ? body.version.slice(0, 64) : null,
            createdAt: Date.now(),
            lastSeen: Date.now(),
            poll: null,
            active: null,
            queue: [],
          }
          connections.set(conn.id, conn)
          log('plugin-connected', { connectionId: conn.id, name: conn.name, editorType: conn.editorType })
        } else {
          conn.lastSeen = Date.now()
        }
        // Keep the token stable across restarts: the companion already has it.
        writePairFile(pairFile, { token, port, candidates, createdAt: new Date().toISOString(), bridgeVersion: BRIDGE_VERSION })
        return sendJson(res, 200, { connectionId: conn.id, bridgeVersion: BRIDGE_VERSION })
      }

      const conn = connections.get(body.connectionId)
      if (!conn) return sendJson(res, 404, { error: 'unknown-connection' })
      conn.lastSeen = Date.now()

      if (path === '/bridge/heartbeat') {
        return sendJson(res, 200, { connected: true, pending: conn.queue.length + (conn.active ? 1 : 0) })
      }
      if (path === '/bridge/poll') {
        if (conn.poll) return sendJson(res, 409, { error: 'poll-already-pending' })
        conn.poll = {
          res,
          timer: setTimeout(() => {
            if (conn.poll && conn.poll.res === res) {
              conn.poll = null
              sendJson(res, 200, { idle: true })
            }
          }, pollTimeoutMs),
        }
        res.once('close', () => {
          if (conn.poll && conn.poll.res === res) {
            clearTimeout(conn.poll.timer)
            conn.poll = null
          }
        })
        dispatch(conn)
        return
      }
      if (path === '/bridge/result') {
        const job = conn.active
        if (!job || job.id !== body.id) return sendJson(res, 409, { error: 'unknown-or-consumed-operation' })
        conn.active = null
        const ok = body.ok === true
        const error = ok ? null : (body.error ?? { code: 'figma-error', message: 'Figma 命令失败' })
        if (!ok && job.write) uncertain = true
        job.finish({ ok, value: ok ? body.value ?? null : null, error })
        sendJson(res, 200, { accepted: true })
        dispatch(conn)
        return
      }
      if (path === '/bridge/disconnect') {
        log('plugin-disconnected', { connectionId: conn.id })
        connections.delete(conn.id)
        for (const [sessionId, connectionId] of bindings) if (connectionId === conn.id) bindings.delete(sessionId)
        rejectQueue(conn, 'plugin-disconnected', 'Figma 插件已断开', true)
        if (conn.poll) {
          clearTimeout(conn.poll.timer)
          sendJson(conn.poll.res, 200, { idle: true })
          conn.poll = null
        }
        return sendJson(res, 200, { disconnected: true })
      }
      return sendJson(res, 404, { error: 'unknown-bridge-route' })
    } catch (error) {
      sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
    }
  }

  for (const candidate of candidates) {
    const attempt = createServer((req, res) => {
      handler(req, res).catch((error) => sendJson(res, 500, { error: error && error.message ? error.message : String(error) }))
    })
    try {
      await new Promise((resolve, reject) => {
        attempt.once('error', reject)
        attempt.listen(candidate, '127.0.0.1', resolve)
      })
      server = attempt
      port = attempt.address().port
      break
    } catch (error) {
      attempt.close()
      if (error && error.code !== 'EADDRINUSE') throw error
      log('port-busy', { port: candidate })
    }
  }
  if (!server || port === null) throw new Error('没有可用端口（3977–3986 都被占用）')

  writePairFile(pairFile, {
    token,
    port,
    candidates: [port, ...candidates.filter((value) => value !== port)],
    createdAt: new Date().toISOString(),
    bridgeVersion: BRIDGE_VERSION,
  })

  sweeper = setInterval(() => {
    const now = Date.now()
    for (const conn of [...connections.values()]) {
      if (now - conn.lastSeen <= STALE_MS) continue
      log('plugin-stale', { connectionId: conn.id })
      connections.delete(conn.id)
      for (const [sessionId, connectionId] of bindings) if (connectionId === conn.id) bindings.delete(sessionId)
      rejectQueue(conn, 'plugin-stale', 'Figma 插件心跳超时（45s），已视为断开', true)
      if (conn.poll) {
        clearTimeout(conn.poll.timer)
        sendJson(conn.poll.res, 200, { idle: true })
        conn.poll = null
      }
    }
  }, 5000)
  sweeper.unref?.()

  log('bridge-listening', { port, pairFile })

  return {
    port,
    token,
    pairFile,
    candidates: [port, ...candidates.filter((value) => value !== port)],
    call,
    bind,
    unbind,
    status,
    clearUncertain,
    connectionList,
    async close() {
      if (closed) return
      closed = true
      if (sweeper) clearInterval(sweeper)
      for (const conn of connections.values()) {
        rejectQueue(conn, 'bridge-closed', 'Bridge 已关闭', false)
        if (conn.poll) {
          clearTimeout(conn.poll.timer)
          try {
            sendJson(conn.poll.res, 200, { idle: true })
          } catch {
            /* ignore */
          }
          conn.poll = null
        }
      }
      connections.clear()
      bindings.clear()
      if (!server) return
      await new Promise((resolve) => server.close(resolve))
      server = null
    },
  }
}
