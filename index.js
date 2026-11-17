/**
 * Host entry of the DSH Figma Designer bundle.
 *
 * Starts the loopback bridge, generates the paired Figma companion, registers
 * the six tools, the settings-card routes, and a compact skill. Everything is
 * released with the plugin fiber (bridge closed, tools and card routes gone).
 *
 * @module dsh-figma-designer
 */

import { randomUUID } from 'node:crypto'
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
const VERSION = '0.9.3'

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

/**
 * Two slash commands that pick the design tier for the user, so the choice does
 * not depend on the model reading intent from wording alone. Each one queues a
 * normal user turn whose first line states the tier and whose body is the
 * budget that tier is allowed to spend.
 */
const COMMANDS = [
  {
    name: 'figma-quick-design',
    title: 'Figma 快速设计',
    description: '快速档：单屏/简单页面，整页一次写入 + 一张截图，最多修一轮（≤6 次工具调用）',
    hint: '<要做的页面或改动>',
    prompt: (request) => [
      `[Figma 快速设计] ${request}`,
      '',
      '按 figma-designer 的快速档执行，不要在流程上停留：',
      '1. figma_designer_status（未连接先 figma_designer_setup）',
      '2. 需要时只读一次：figma_designer_library，或 figma_designer_read（depth:1）',
      '3. 整页用一个 figma_designer_apply 写完（≤80 节点；frame + children 嵌套；真实文案；字号 ≤4 级、颜色 ≤6 个）',
      '4. 一张 figma_designer_screenshot（大画板 scale 0.6），只修看得见的明显问题，最多一轮',
      '5. 交付：方向一句话 + 截图路径',
      '',
      '约束：不写 DESIGN.md、不做灰度稿、不跑 audit、不派独立评审；工具调用总数 ≤6 次。',
    ].join('\n'),
  },
  {
    name: 'figma-thinking-design',
    title: 'Figma 打磨设计',
    description: '打磨档：方向卡 + 灰度 + 视觉 + 审计 + 独立评审，用于核心页面或明确要求做到最好',
    hint: '<要做的页面或改版>',
    prompt: (request) => [
      `[Figma 打磨设计] ${request}`,
      '',
      '按 figma-design 的打磨档执行（本 skill 已加载时直接照做）：',
      '1. 一句话写清约束：用户、核心任务、目标视口、真实内容、现有设计系统',
      '2. 写 DESIGN.md 方向卡：北极星、主角/主动作、调性五刻度、字体色彩间距、页面骨架、记忆点、放弃什么（默认一个方向）',
      '3. 灰度结构 → 一张截图确认层级与主动作',
      '4. 复用 figma_designer_library 的组件/变量/样式；没有就建最小 token 集，再上视觉',
      '5. figma_designer_audit 跑一次，按 nodeId 修 error 和高影响 warn；补一张目标视口截图',
      '6. 派一个无上下文的子 Agent 评审：只给截图、用户原始任务、北极星和 skills/figma-design/references/reviewer.md 路径，不给源码和过程',
      '7. 按 1–10 分清单改一轮，交付：方向、改动、设计系统对象、证据、评分与处理',
      '',
      '证据预算：截图 ≤3 张，audit 只跑一次，评审后只改一轮，不无限循环。',
    ].join('\n'),
  },
]

/**
 * Register the tier commands. `commands` may mount after this bundle applies, so
 * the same wait-for-service pattern as the card routes is used instead of a hard
 * dependency that would keep the tools from loading on a host without it.
 */
function registerCommands(ctx) {
  const install = (service) => {
    if (!service || typeof service.register !== 'function') return
    for (const command of COMMANDS) {
      ctx.effect(() => service.register({
        name: command.name,
        description: command.description,
        input: { hint: command.hint },
        handler: (invocation) => {
          const request = String(invocation && invocation.rawInput !== undefined ? invocation.rawInput : '').trim()
          if (request.length === 0) return { kind: 'error', text: `用法：/${command.name} ${command.hint}` }
          const agent = invocation && invocation.agent
          if (!agent || typeof agent.followup !== 'function') return { kind: 'error', text: '当前会话不能接收命令消息' }
          agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: command.prompt(request) }],
            source: { kind: 'user' },
          })
          return { kind: 'success', text: `${command.title}已启动：${request}` }
        },
      }), `figma-designer: command ${command.name}`)
    }
  }

  const immediate = readService(ctx, 'commands')
  if (immediate) {
    install(immediate)
    return
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (commandCtx) => install(readService(commandCtx, 'commands')))
    } catch (error) {
      try {
        ctx.logger?.warn?.(`figma-designer: commands injection failed: ${error && error.message ? error.message : error}`)
      } catch {
        /* logging is best effort */
      }
    }
  }
}

const SKILLS = [
  { name: 'figma-designer', dir: 'figma-designer', fallback: '用自然语言读取、创建、修改、导出 Figma 设计' },
  { name: 'figma-design', dir: 'figma-design', fallback: '让 Figma 设计达到可交付质量：方向、视觉语言、证据与独立评审' },
]

async function registerSkill(ctx) {
  const skills = readService(ctx, 'skills')
  if (!skills || typeof skills.register !== 'function') return
  for (const skill of SKILLS) {
    const skillDir = join(PACKAGE_DIR, 'skills', skill.dir)
    const skillPath = join(skillDir, 'SKILL.md')
    let raw
    try {
      raw = await readFile(skillPath, 'utf8')
    } catch {
      continue
    }
    const front = /^---\n([\s\S]*?)\n---\n/.exec(raw)
    const description = front ? (/^description: (.+)$/m.exec(front[1])?.[1] ?? '').trim() : ''
    const content = front ? raw.slice(front[0].length).trim() : raw
    try {
      ctx.effect(() => skills.register({
        name: skill.name,
        description: description || skill.fallback,
        content,
        source: 'bundled',
        path: skillPath,
        resourceBase: { kind: 'directory', path: skillDir },
        invocation: { modelInvocable: true, userInvocable: true },
      }), `figma-designer: skill ${skill.name}`)
    } catch (error) {
      try {
        ctx.logger?.warn?.(`figma-designer: skill ${skill.name} registration failed: ${error && error.message ? error.message : error}`)
      } catch {
        /* ignore */
      }
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
  registerCommands(ctx)

  try {
    ctx.logger?.info?.(`figma-designer: bridge on 127.0.0.1:${bridge.port}; companion at ${companion.manifestPath}`)
  } catch {
    /* logging is best effort */
  }
}
