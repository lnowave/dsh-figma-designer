/**
 * Host entry of the DSH Figma Designer bundle.
 *
 * Starts the loopback bridge, generates the paired Figma companion, registers
 * the six tools, the settings-card routes, and a compact skill. Everything is
 * released with the plugin fiber (bridge closed, tools and card routes gone).
 *
 * @module dsh-figma-designer
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createBridge, DEFAULT_PORT } from './lib/bridge.js'
import { prepareCompanion } from './lib/setup.js'
import { registerTools } from './lib/tools.js'
import { registerApiRoutes } from './lib/api.js'

export const inject = ['tools']

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const VERSION = '0.3.2'

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

function resolveHomeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

async function registerSkill(ctx) {
  const skills = readService(ctx, 'skills')
  if (!skills || typeof skills.register !== 'function') return
  const skillDir = join(PACKAGE_DIR, 'skills', 'figma-designer')
  const skillPath = join(skillDir, 'SKILL.md')
  let raw
  try {
    raw = await readFile(skillPath, 'utf8')
  } catch {
    return
  }
  const front = /^---\n([\s\S]*?)\n---\n/.exec(raw)
  const description = front ? (/^description: (.+)$/m.exec(front[1])?.[1] ?? '').trim() : ''
  const content = front ? raw.slice(front[0].length).trim() : raw
  try {
    ctx.effect(() => skills.register({
      name: 'figma-designer',
      description: description || '用自然语言读取、创建、修改 Figma 设计',
      content,
      source: 'bundled',
      path: skillPath,
      resourceBase: { kind: 'directory', path: skillDir },
      invocation: { modelInvocable: true, userInvocable: true },
    }), 'figma-designer: skill')
  } catch (error) {
    try {
      ctx.logger?.warn?.(`figma-designer: skill registration failed: ${error && error.message ? error.message : error}`)
    } catch {
      /* ignore */
    }
  }
}

export async function apply(ctx, config = {}) {
  const homeDir = resolveHomeDir()
  const port = Number.isFinite(config.port) ? config.port : DEFAULT_PORT
  const bridge = await createBridge({ homeDir, port })

  let companion = prepareCompanion({
    homeDir,
    packageDir: PACKAGE_DIR,
    token: bridge.token,
    port: bridge.port,
    candidates: bridge.candidates,
    version: VERSION,
  })
  const companionFor = () => companion
  const refreshCompanion = async () => {
    companion = prepareCompanion({
      homeDir,
      packageDir: PACKAGE_DIR,
      token: bridge.token,
      port: bridge.port,
      candidates: bridge.candidates,
      version: VERSION,
    })
    return companion
  }

  ctx.effect(() => () => bridge.close(), 'figma-designer: bridge')
  ctx.effect(() => registerTools(ctx, { bridge, companionFor, refreshCompanion }), 'figma-designer: tools')
  ctx.effect(() => registerApiRoutes(ctx, { bridge, companionFor, refreshCompanion, version: VERSION }), 'figma-designer: api routes')
  await registerSkill(ctx)

  try {
    ctx.logger?.info?.(`figma-designer: bridge on 127.0.0.1:${bridge.port}; companion at ${companion.manifestPath}`)
  } catch {
    /* logging is best effort */
  }
}
