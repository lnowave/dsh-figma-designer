/**
 * The `figma_*` Host tools.
 *
 * Every tool is a thin projection over `bridge.call(...)`: the agent works with
 * node ids and typed operations, never with Figma scripts. `figma_setup` and
 * `figma_status` work without a connection; the other four return a structured
 * `not-connected` failure with setup guidance instead of throwing.
 *
 * @module dsh-figma-designer/lib/tools
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { auditTree } from './audit.js'
import { buildComparePage, compareSlug } from './compare.js'
import { summarizePlan, validateOps } from './ops.js'
import { buildTokenContext, describeModel, toHTML, toJSX, toJSON, toTokens } from './export.js'

const MAX_IMAGE_BYTES = 12 * 1024 * 1024

const exportSlug = (value) => {
  const text = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  return text || 'figma-export'
}

const exportStamp = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

const currentWorkingDirectory = async (ctx, exec) => {
  const workingDirectory = serviceOf(ctx, 'workingDirectory')
  if (workingDirectory && typeof workingDirectory.ensure === 'function' && exec && exec.agent) {
    try {
      const cwd = await workingDirectory.ensure(exec.agent, exec.signal)
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch {
      /* fall through to the session header */
    }
  }
  const headerCwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  return typeof headerCwd === 'string' && headerCwd.length > 0 ? headerCwd : process.cwd()
}

const EXPORT_FORMATS = ['html', 'jsx', 'svg', 'json', 'tokens']

const dedupeWarnings = (values) => {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Resolve a Host service without assuming Cordis injection order. Tools run
 * after the composition is mounted, so the lookup happens per call rather than
 * at registration time.
 */
const serviceOf = (ctx, name) => {
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

const lossless = (value) => {
  if (value === undefined) return null
  const text = JSON.stringify(value)
  return text === undefined ? null : JSON.parse(text)
}

const jsonText = (value) => [{ type: 'text', text: JSON.stringify(lossless(value), null, 2) }]

const toolOutput = (render) => ({
  schema: {},
  render: render ?? ((_args, value) => jsonText(value)),
})

const sessionOf = (exec) => {
  const agent = exec && exec.agent
  if (agent && typeof agent.id === 'string') return agent.id
  return undefined
}

/**
 * `apply` reports transport success plus a business outcome: the companion
 * returns `{ok:true,value:{ok:false,error,applied}}` when an op failed. Fold
 * that into a top-level failure so the model cannot mistake a partial write for
 * a success.
 */
const applyOutcome = (result) => {
  if (!result.ok) return brief(result)
  const value = result.value
  if (value && typeof value === 'object' && value.ok === false) {
    return {
      ok: false,
      error: value.error ?? { code: 'figma-error', message: 'Figma 拒绝执行该批操作' },
      applied: Array.isArray(value.applied) ? value.applied.slice(0, 20) : [],
      ms: result.ms,
      connectionId: result.connectionId,
    }
  }
  return result
}

const brief = (result) => {
  if (result.ok) return result
  return {
    ok: false,
    error: result.error ?? { code: 'figma-error', message: 'Figma 命令失败' },
    ms: result.ms,
    connectionId: result.connectionId,
  }
}

const OPS_DESCRIPTION = `ops 数组，按顺序执行。类型：
{op:'create', parentId?, type:'frame'|'component'|'rect'|'ellipse'|'text'|'line'|'polygon'|'star'|'svg', name?, x?, y?, width?, height?, fill?, stroke?, strokeWidth?, radius?, opacity?, visible?, locked?, rotation?, layout?, text?, svg?, effects?, children?:[同结构]}
{op:'update', nodeId, patch:{name?,x?,y?,width?,height?,fill?,stroke?,strokeWidth?,radius?,opacity?,visible?,locked?,rotation?,layout?,text?,effects?}}
{op:'move', nodeId, parentId, index?}
{op:'reorder', nodeId, index}
{op:'clone', nodeId, parentId?, x?, y?, deep?}
{op:'group', nodeIds:[...], name?}
{op:'delete', nodeId}
{op:'select', nodeIds:[...]}
颜色 #RRGGBB / #RRGGBBAA；layout:{mode:'HORIZONTAL'|'VERTICAL', itemSpacing?, padding?, primaryAxisAlign?, counterAxisAlign?}；text:{characters, font?:{family,style}, fontSize?, align?, lineHeight?, letterSpacing?, textAutoResize?}；radius 可用 [左上,右上,右下,左下]。`

/**
 * Register all tools. Returns one disposer.
 * @param {object} ctx
 * @param {object} deps
 */
export function registerTools(ctx, deps) {
  const { bridge, companionFor, refreshCompanion } = deps
  const disposers = []

  const register = (definition) => {
    const dispose = ctx.tools.register(definition)
    disposers.push(dispose)
  }

  register({
    name: 'figma_status',
    description: '检查 Figma 连接：本地桥端口、已连接的 Figma 文件、当前会话绑定的目标文件、是否有未确认写入，以及伴生插件的 manifest 路径。任何 Figma 操作前先调用它；未连接时按返回的 setup 指引操作。',
    parameters: {
      type: 'object',
      properties: {
        compact: { type: 'boolean', description: '只返回关键状态（默认 false）' },
      },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const status = bridge.status(sessionOf(exec))
      const companion = companionFor()
      if (args && args.compact) {
        return lossless({
          ok: true,
          connected: status.connections.length > 0,
          files: status.connections.map((item) => ({ connectionId: item.connectionId, name: item.name, editorType: item.editorType })),
          bound: status.bound,
          needsSelection: status.needsSelection,
          uncertain: status.uncertain,
        })
      }
      return lossless({
        ok: true,
        backend: 'local',
        bridge: { port: status.port, pairFile: status.pairFile },
        files: status.connections,
        bound: status.bound,
        needsSelection: status.needsSelection,
        uncertain: status.uncertain,
        setup: {
          manifestPath: companion ? companion.manifestPath : null,
          companionDir: companion ? companion.dir : null,
          ports: status.candidates,
        },
        instructions: status.connections.length === 0
          ? [
            '在 Figma 桌面版导入伴生插件：Plugins → Development → Import plugin from manifest…，选择 setup.manifestPath。',
            '在目标 Figma 文件运行 Plugins → Development → DSH Figma Designer，保持窗口打开。',
            '然后重新调用 figma_status 确认已连接。',
          ]
          : status.needsSelection
            ? ['已连接多个 Figma 文件：调用 figma_select 选择要操作的文件。']
            : ['已连接，可以开始 figma_read / figma_apply。'],
      })
    },
  })

  register({
    name: 'figma_setup',
    description: '生成或刷新本机配对的 Figma 伴生插件，返回要在 Figma 里导入的 manifest 绝对路径与三步安装说明。第一次使用、升级插件后、或 figma_status 提示未连接时调用。不会返回配对密钥。',
    parameters: { type: 'object', properties: { regenerate: { type: 'boolean', description: '强制重新生成（默认 true）' } } },
    output: toolOutput(),
    async execute() {
      const companion = await refreshCompanion()
      return lossless({
        ok: true,
        companionDir: companion.dir,
        manifestPath: companion.manifestPath,
        ports: companion.ports,
        steps: [
          '打开 Figma 桌面版。',
          '菜单 Plugins → Development → Import plugin from manifest…，选择 manifestPath。',
          '在目标文件运行 Plugins → Development → DSH Figma Designer，保持窗口打开。',
          '回到 DSH 调用 figma_status 确认连接。',
        ],
        note: '目录位置固定；升级后重新生成会原地更新，只需关闭并重跑 Figma 插件，无需重新导入。',
      })
    },
  })

  register({
    name: 'figma_select',
    description: '选择当前会话要操作的 Figma 文件。不带参数时列出已连接文件；带 connectionId 或 fileName 时绑定（多个文件同时打开时必须显式选择）。单个文件会自动绑定。',
    parameters: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'figma_status 返回的 connectionId' },
        fileName: { type: 'string', description: '按文件名选择（唯一匹配时）' },
      },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const status = bridge.status(sessionId)
      if (!args || (!args.connectionId && !args.fileName)) {
        return lossless({ ok: true, files: status.connections, bound: status.bound, needsSelection: status.needsSelection })
      }
      let connectionId = args.connectionId
      if (!connectionId && args.fileName) {
        const matches = status.connections.filter((item) => item.name === args.fileName)
        if (matches.length === 0) return lossless({ ok: false, error: { code: 'not-connected', message: `没有名为「${args.fileName}」的已连接文件` }, files: status.connections })
        if (matches.length > 1) return lossless({ ok: false, error: { code: 'ambiguous', message: '同名文件有多个，请改用 connectionId' }, files: matches })
        connectionId = matches[0].connectionId
      }
      const bound = bridge.bind(sessionId, connectionId)
      return lossless(bound.ok ? { ok: true, bound: bound.connection } : bound)
    },
  })

  register({
    name: 'figma_read',
    description: '读取 Figma 结构：默认读当前选区，也可读当前页面或指定节点。返回紧凑节点树（id/名称/类型/位置尺寸/填充/auto-layout/文本/组件），默认 depth=2、maxNodes=80，超出会截断。修改前先读拿 nodeId；读取成功也会清除“写入结果不确定”的屏障。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['selection', 'page', 'node'], description: '默认 selection' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'target=node 时必填' },
        depth: { type: 'integer', minimum: 0, maximum: 6, description: '展开深度，默认 2' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 300, description: '节点上限，默认 80' },
        includeHidden: { type: 'boolean', description: '包含 visible=false 的节点（默认 false）' },
      },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const target = args && typeof args.target === 'string' ? args.target : 'selection'
      const result = await bridge.call({
        command: 'read',
        sessionId: sessionOf(exec),
        args: {
          target,
          nodeIds: Array.isArray(args?.nodeIds) ? args.nodeIds : undefined,
          depth: Number.isFinite(args?.depth) ? args.depth : 2,
          maxNodes: Number.isFinite(args?.maxNodes) ? args.maxNodes : 80,
          includeHidden: args?.includeHidden === true,
        },
        timeoutMs: 60000,
      })
      if (result.ok) bridge.clearUncertain(result.connectionId)
      return lossless(brief(result))
    },
  })

  register({
    name: 'figma_audit',
    description: '只读设计质量审计：读取选区/页面/节点的完整样式树和设计系统，检查文字对比度、字号/行高、占位文案、控件点击区、间距网格、颜色数量、token 匹配率、裁剪、组件使用等，返回 0–100 分、问题清单（含 nodeId/修复建议）。不修改画布；评审后先用 figma_read 定位，再按问题修复。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['selection', 'page', 'node'], description: '默认 selection' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'target=node 时必填' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 2000, description: '最多审计节点数，默认 800' },
        includeHidden: { type: 'boolean', description: '包含 visible=false 的节点（默认 false）' },
      },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const target = args && typeof args.target === 'string' ? args.target : 'selection'
      const treeResult = await bridge.call({
        command: 'tree',
        sessionId: sessionOf(exec),
        args: {
          target,
          nodeIds: Array.isArray(args?.nodeIds) ? args.nodeIds : undefined,
          depth: 20,
          maxNodes: Number.isFinite(args?.maxNodes) ? Math.max(1, Math.min(2000, args.maxNodes)) : 800,
          includeHidden: args?.includeHidden === true,
        },
        timeoutMs: 120000,
      })
      if (!treeResult.ok) return lossless(brief(treeResult))
      bridge.clearUncertain(treeResult.connectionId)
      const tree = treeResult.value && typeof treeResult.value === 'object' ? treeResult.value : {}
      let library = null
      let libraryError = null
      try {
        const libraryResult = await bridge.call({
          command: 'library',
          sessionId: sessionOf(exec),
          args: { limit: 500 },
          timeoutMs: 120000,
        })
        if (libraryResult.ok && libraryResult.value && typeof libraryResult.value === 'object') library = libraryResult.value
        else libraryError = (libraryResult.error && libraryResult.error.message) || '设计系统读取失败'
      } catch (error) {
        libraryError = error && error.message ? error.message : String(error)
      }
      const audit = auditTree(tree, library, { includeHidden: args?.includeHidden === true })
      if (libraryError) audit.warnings = [...(audit.warnings || []), `设计系统读取失败：${libraryError}`]
      return lossless({
        ...audit,
        connectionId: treeResult.connectionId,
        ms: treeResult.ms,
      })
    },
  })

  register({
    name: 'figma_compare',
    description: '把 2–6 个候选 Figma 节点截图并生成自包含的方向对比页（HTML + manifest.json），带候选名、概念、色板、特征和“选这个”复制选择。只读；不修改 Figma。适合多方向探索后让用户并排挑选，再回到对话确认。',
    parameters: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          minItems: 2,
          maxItems: 6,
          description: '[{nodeId, name?, concept?, palette?:string[], traits?:string[]}]，至少 2 个',
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string' },
              name: { type: 'string' },
              concept: { type: 'string' },
              palette: { type: 'array', items: { type: 'string' } },
              traits: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        title: { type: 'string', description: '对比页标题，默认「设计方向对比」' },
        scale: { type: 'number', minimum: 0.25, maximum: 2, description: '截图倍率，默认 1' },
        outDir: { type: 'string', description: '输出目录；默认 <工作目录>/figma-export/compare-<时间戳>/' },
      },
      required: ['candidates'],
    },
    output: toolOutput(),
    async execute(args, exec) {
      const candidates = args && Array.isArray(args.candidates) ? args.candidates : null
      if (!candidates || candidates.length < 2 || candidates.length > 6) {
        return lossless({ ok: false, error: { code: 'invalid-argument', message: 'candidates 必须是 2–6 个候选' } })
      }
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]
        if (!candidate || typeof candidate.nodeId !== 'string' || candidate.nodeId.length === 0) {
          return lossless({ ok: false, error: { code: 'invalid-argument', message: `candidates[${index}].nodeId 必须是非空字符串` } })
        }
      }
      const scale = Number.isFinite(args.scale) ? Math.max(0.25, Math.min(2, args.scale)) : 1
      const base = await currentWorkingDirectory(ctx, exec)
      const stamp = exportStamp()
      const dir = args.outDir ? resolve(base, args.outDir) : join(base, 'figma-export', `compare-${stamp}`)
      const shots = []
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]
        const result = await bridge.call({
          command: 'screenshot',
          sessionId: sessionOf(exec),
          args: { nodeId: candidate.nodeId, scale },
          timeoutMs: 120000,
        })
        if (!result.ok) {
          return lossless({
            ...brief(result),
            candidateIndex: index + 1,
            nodeId: candidate.nodeId,
          })
        }
        const value = result.value || {}
        const image = value.image
        if (!image || typeof image.data !== 'string' || image.data.length === 0) {
          return lossless({ ok: false, error: { code: 'unsupported', message: `候选 ${index + 1} 没有返回截图数据` }, nodeId: candidate.nodeId })
        }
        shots.push({ candidate, image, node: value.node || {} })
      }

      await mkdir(dir, { recursive: true })
      const builtCandidates = []
      for (let index = 0; index < shots.length; index += 1) {
        const shot = shots[index]
        const name = typeof shot.candidate.name === 'string' && shot.candidate.name.trim()
          ? shot.candidate.name.trim()
          : (shot.node && shot.node.name) || `Candidate ${index + 1}`
        const imageFile = `${String(index + 1).padStart(2, '0')}-${compareSlug(name)}.png`
        await writeFile(join(dir, imageFile), Buffer.from(shot.image.data, 'base64'))
        builtCandidates.push({
          nodeId: shot.candidate.nodeId,
          name,
          concept: typeof shot.candidate.concept === 'string' ? shot.candidate.concept : undefined,
          palette: Array.isArray(shot.candidate.palette) ? shot.candidate.palette : undefined,
          traits: Array.isArray(shot.candidate.traits) ? shot.candidate.traits : undefined,
          image: shot.image,
          imageFile,
          width: shot.image.width,
          height: shot.image.height,
        })
      }

      const status = bridge.status(sessionOf(exec))
      const file = (status.bound && status.bound.name) || (status.connections[0] && status.connections[0].name) || null
      const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '设计方向对比'
      const built = buildComparePage({
        title,
        file,
        page: null,
        generatedAt: new Date().toISOString(),
        candidates: builtCandidates,
      })
      const htmlPath = join(dir, 'compare.html')
      const manifestPath = join(dir, 'manifest.json')
      await writeFile(htmlPath, built.html, 'utf8')
      await writeFile(manifestPath, JSON.stringify(built.manifest, null, 2) + '\n', 'utf8')

      return lossless({
        ok: true,
        dir,
        htmlPath,
        manifestPath,
        title,
        file,
        scale,
        candidates: builtCandidates.map((candidate) => ({
          nodeId: candidate.nodeId,
          name: candidate.name,
          imageFile: candidate.imageFile,
          width: candidate.width,
          height: candidate.height,
        })),
        instructions: [
          '打开 htmlPath 查看并排对比；每张卡片有“实际尺寸”和“选这个”。',
          '用户选定后回到对话里确认，再继续深化选中的方向。',
        ],
      })
    },
  })

  register({
    name: 'figma_screenshot',
    description: '把 Figma 选区或指定节点导出为 PNG 并直接显示给你（视觉自检）。修改后用相同 nodeId 截图确认；无选区时传 nodeId。scale 0.1–4，默认 1。',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '目标节点 id；缺省用当前选区第一个节点' },
        scale: { type: 'number', minimum: 0.1, maximum: 4, description: '导出倍率，默认 1' },
      },
    },
    output: toolOutput((_args, value) => {
      if (!value || value.ok !== true || !value.image || !value.image.attachment) return jsonText(value)
      const summary = {
        ok: true,
        node: value.node,
        scale: value.scale,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        mediaType: value.image.mediaType,
      }
      return [
        { type: 'text', text: JSON.stringify(summary, null, 2) },
        // `attachment` is the only image representation the Host session and
        // model transports understand. A raw {mimeType,data} block is not a
        // valid durable content block: it poisons the session history and
        // every later request fails while reading `block.attachment`.
        { type: 'image', attachment: value.image.attachment },
      ]
    }),
    async execute(args, exec) {
      const scale = Number.isFinite(args?.scale) ? Math.max(0.1, Math.min(4, args.scale)) : 1
      const result = await bridge.call({
        command: 'screenshot',
        sessionId: sessionOf(exec),
        args: { nodeId: typeof args?.nodeId === 'string' ? args.nodeId : undefined, scale },
        timeoutMs: 120000,
      })
      if (!result.ok) return lossless(brief(result))
      const value = result.value || {}
      if (!value.image || typeof value.image.data !== 'string') return lossless({ ok: false, error: { code: 'unsupported', message: 'Figma 没有返回截图数据' } })
      if (Buffer.byteLength(value.image.data, 'base64') > MAX_IMAGE_BYTES) {
        return lossless({ ok: false, error: { code: 'too-large', message: '截图超过 12MB，请降低 scale 或选更小的节点' } })
      }

      // Persist the PNG through the Host attachment store and return its
      // durable reference. Never put raw base64 into tool content: the model
      // request layer expects `{type:'image', attachment}` and will crash on
      // any other shape.
      const attachments = serviceOf(ctx, 'attachments')
      if (!attachments || typeof attachments.saveImage !== 'function') {
        return lossless({
          ok: false,
          error: {
            code: 'image-unsupported',
            message: '当前 DSH 没有挂载 attachments 服务，截图无法作为图片返回；请改用 figma_read 或导出文件。',
          },
          node: value.node,
          scale: value.scale,
        })
      }
      try {
        const attachment = await attachments.saveImage({
          data: Buffer.from(value.image.data, 'base64'),
          mediaType: value.image.mimeType || 'image/png',
          name: 'figma-screenshot.png',
        })
        return lossless({
          ok: true,
          node: value.node,
          scale: value.scale,
          image: {
            mediaType: attachment.mediaType,
            bytes: attachment.bytes,
            width: attachment.width,
            height: attachment.height,
            attachment,
          },
        })
      } catch (error) {
        return lossless({
          ok: false,
          error: {
            code: 'image-storage-failed',
            message: `截图已生成，但无法写入 DSH 附件库：${error && error.message ? error.message : String(error)}`,
          },
          node: value.node,
          scale: value.scale,
        })
      }
    },
  })

  register({
    name: 'figma_apply',
    description: `对 Figma 画布执行一批类型化操作（不执行任意脚本）。先 figma_read 拿 nodeId，建议先 dryRun:true 预览再正式执行，成功后用 figma_screenshot 自检。
坐标：parentId 是 Frame 时 x/y 相对父级，是页面时绝对坐标；colors 用 #RRGGBB/#RRGGBBAA；text 需提供 characters 与字体（默认 Inter Regular）。
若上一次写入超时/断线，会返回 uncertain-write：必须先 figma_read 核查再继续。
${OPS_DESCRIPTION}`,
    parameters: {
      type: 'object',
      properties: {
        ops: { type: 'array', description: OPS_DESCRIPTION, items: { type: 'object' } },
        dryRun: { type: 'boolean', description: '只校验并返回计划，不修改画布（推荐先 true）' },
        atomic: { type: 'boolean', description: '尽力回滚：失败时删除已创建节点、恢复被改字段' },
        operationId: { type: 'string', description: '幂等 id；重复提交同一 id 不会重复执行' },
      },
      required: ['ops'],
    },
    output: toolOutput(),
    async execute(args, exec) {
      const validated = validateOps(args && args.ops)
      if (!validated.ok) {
        return lossless({
          ok: false,
          error: { code: 'invalid-op', message: 'ops 校验失败', errors: validated.errors.slice(0, 20) },
        })
      }
      const plan = summarizePlan(validated.ops)
      if (args.dryRun === true) {
        const result = await bridge.call({
          command: 'apply',
          sessionId: sessionOf(exec),
          args: { ops: validated.ops, dryRun: true, operationId: args.operationId },
          timeoutMs: 90000,
        })
        const outcome = applyOutcome(result)
        return lossless({ ...outcome, hostPlan: plan })
      }
      const timeoutMs = Math.min(300000, 60000 + validated.ops.length * 3000)
      const result = await bridge.call({
        command: 'apply',
        sessionId: sessionOf(exec),
        write: true,
        args: {
          ops: validated.ops,
          dryRun: false,
          atomic: args.atomic === true,
          operationId: typeof args.operationId === 'string' ? args.operationId : undefined,
        },
        timeoutMs,
      })
      const outcome = applyOutcome(result)
      return lossless({ ...outcome, hostPlan: plan })
    },
  })

  register({
    name: 'figma_library',
    description: '读取当前 Figma 文件的设计系统：组件与组件集、Paint/Text/Effect 样式、Variables 集合与变量。先用它拿 id，再用 figma_instantiate / figma_style / figma_variable 复用或修改。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['all', 'components', 'styles', 'variables'], description: '只返回某一类（默认 all）' },
        query: { type: 'string', description: '按名称过滤' },
        limit: { type: 'number', minimum: 1, maximum: 500, description: '每类最多返回数量，默认 100' },
      },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const result = await bridge.call({
        command: 'library',
        sessionId: sessionOf(exec),
        args: {
          query: typeof args.query === 'string' ? args.query : undefined,
          limit: Number.isFinite(args.limit) ? args.limit : undefined,
        },
        timeoutMs: 120000,
      })
      if (!result.ok) return lossless(brief(result))
      const value = result.value || {}
      const kind = typeof args.kind === 'string' ? args.kind : 'all'
      if (kind === 'components') {
        return lossless({ ok: true, file: value.file, page: value.page, components: value.components, componentSets: value.componentSets, stats: value.stats, warnings: value.warnings })
      }
      if (kind === 'styles') {
        return lossless({ ok: true, file: value.file, page: value.page, styles: value.styles, stats: value.stats, warnings: value.warnings })
      }
      if (kind === 'variables') {
        return lossless({ ok: true, file: value.file, page: value.page, variableCollections: value.variableCollections, variables: value.variables, stats: value.stats, warnings: value.warnings })
      }
      return lossless(value)
    },
  })

  register({
    name: 'figma_instantiate',
    description: '把已有组件放进画布：按 componentId 或 componentName（含组件集 variant 选择）创建 Instance，可指定父节点/坐标/尺寸，并用 overrides 覆盖实例内的文字、填充、可见性、圆角、尺寸。不要用 create 重画已有组件。',
    parameters: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: '组件 id（figma_library 返回）' },
        componentName: { type: 'string', description: '组件名；找不到 id 时用名称精确/模糊匹配' },
        variant: { type: 'object', description: '组件集变体属性，例如 {Size:"Large", State:"Default"}' },
        parentId: { type: 'string', description: '父节点 id；缺省挂到当前页' },
        x: { type: 'number', description: '相对父级的 x' },
        y: { type: 'number', description: '相对父级的 y' },
        width: { type: 'number', description: '实例宽度（可选）' },
        height: { type: 'number', description: '实例高度（可选）' },
        name: { type: 'string', description: '实例图层名（可选）' },
        overrides: {
          type: 'array',
          description: '实例内覆盖：[{nodeName?,nodeId?,text?,fill?,visible?,opacity?,radius?,width?,height?}]',
          items: { type: 'object' },
        },
      },
    },
    output: toolOutput(),
    async execute(args, exec) {
      if (typeof args.componentId !== 'string' && typeof args.componentName !== 'string') {
        return lossless({ ok: false, error: { code: 'invalid-args', message: '必须提供 componentId 或 componentName' } })
      }
      const result = await bridge.call({
        command: 'instantiate',
        sessionId: sessionOf(exec),
        args: {
          componentId: typeof args.componentId === 'string' ? args.componentId : undefined,
          componentName: typeof args.componentName === 'string' ? args.componentName : undefined,
          variant: args.variant && typeof args.variant === 'object' ? args.variant : undefined,
          parentId: typeof args.parentId === 'string' ? args.parentId : undefined,
          x: Number.isFinite(args.x) ? args.x : undefined,
          y: Number.isFinite(args.y) ? args.y : undefined,
          width: Number.isFinite(args.width) ? args.width : undefined,
          height: Number.isFinite(args.height) ? args.height : undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
          overrides: Array.isArray(args.overrides) ? args.overrides : undefined,
        },
        timeoutMs: 90000,
      })
      return lossless(result.ok ? result : brief(result))
    },
  })

  register({
    name: 'figma_component_set',
    description: '基于一个基础组件创建组件集/变体：克隆基础组件 N 次，按 properties（如 {Size:"Small",State:"Default"}）命名并合并为 Component Set；每个变体可覆盖尺寸、填充、文字和内部图层。之后用 figma_instantiate 的 variant 参数选择变体。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '组件集名称' },
        baseComponentId: { type: 'string', description: '基础组件 id' },
        baseComponentName: { type: 'string', description: '基础组件名（id 缺失时用）' },
        parentId: { type: 'string', description: '组件集挂载的父级；默认跟随基础组件所在父级' },
        variants: {
          type: 'array',
          description: '[{properties:{Size:"Small"},width?,height?,fill?,text?,overrides?:[...]}]',
          items: { type: 'object' },
        },
      },
      required: ['variants'],
    },
    output: toolOutput(),
    async execute(args, exec) {
      if (!Array.isArray(args.variants) || args.variants.length === 0) {
        return lossless({ ok: false, error: { code: 'invalid-args', message: 'variants 必须是非空数组' } })
      }
      if (typeof args.baseComponentId !== 'string' && typeof args.baseComponentName !== 'string') {
        return lossless({ ok: false, error: { code: 'invalid-args', message: '必须提供 baseComponentId 或 baseComponentName' } })
      }
      const result = await bridge.call({
        command: 'variants',
        sessionId: sessionOf(exec),
        args: {
          name: typeof args.name === 'string' ? args.name : undefined,
          baseComponentId: typeof args.baseComponentId === 'string' ? args.baseComponentId : undefined,
          baseComponentName: typeof args.baseComponentName === 'string' ? args.baseComponentName : undefined,
          parentId: typeof args.parentId === 'string' ? args.parentId : undefined,
          variants: args.variants,
        },
        timeoutMs: 120000,
      })
      return lossless(result.ok ? result : brief(result))
    },
  })

  register({
    name: 'figma_style',
    description: '应用或创建 Figma 样式：把 Paint/Text/Effect 样式应用到节点（默认真正链接 style id；link:false 时仅按样式值写入），或创建新的本地样式。先用 figma_library kind:"styles" 查样式 id/name。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['apply', 'create'], description: '默认 apply' },
        kind: { type: 'string', enum: ['paint', 'text', 'effect'], description: 'create 时必填；apply 时可省略（按 style 类型推断）' },
        name: { type: 'string', description: 'create 的样式名' },
        styleId: { type: 'string', description: 'apply 的样式 id' },
        styleName: { type: 'string', description: 'apply 的样式名（id 缺失时用）' },
        nodeId: { type: 'string', description: 'apply 的目标节点 id' },
        target: { type: 'string', enum: ['auto', 'fill', 'stroke', 'text', 'effect'], description: 'apply 的目标字段，默认 auto' },
        clear: { type: 'boolean', description: 'apply 时清除已绑定样式（仅 link:true 模式）' },
        link: { type: 'boolean', description: 'apply 时是否链接 style id（默认 true；传 false 只写入样式值，不建立链接）' },
        color: { type: 'string', description: 'create paint 样式的颜色' },
        font: { type: 'object', description: 'create text 样式的字体 {family,style}' },
        fontSize: { type: 'number', description: 'create text 样式的字号' },
        effects: { type: 'array', description: 'create effect 样式的 effects 数组', items: { type: 'object' } },
      },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const action = args.action === 'create' ? 'create' : 'apply'
      if (action === 'create' && (typeof args.kind !== 'string' || typeof args.name !== 'string')) {
        return lossless({ ok: false, error: { code: 'invalid-args', message: 'create 样式必须提供 kind 和 name' } })
      }
      if (action === 'apply' && (typeof args.nodeId !== 'string' || (typeof args.styleId !== 'string' && typeof args.styleName !== 'string'))) {
        return lossless({ ok: false, error: { code: 'invalid-args', message: 'apply 样式必须提供 nodeId 和 styleId/styleName' } })
      }
      const result = await bridge.call({
        command: 'styles',
        sessionId: sessionOf(exec),
        args: {
          action: action,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
          styleId: typeof args.styleId === 'string' ? args.styleId : undefined,
          styleName: typeof args.styleName === 'string' ? args.styleName : undefined,
          nodeId: typeof args.nodeId === 'string' ? args.nodeId : undefined,
          target: typeof args.target === 'string' ? args.target : undefined,
          clear: args.clear === true,
          link: args.link !== false,
          color: typeof args.color === 'string' ? args.color : undefined,
          font: args.font && typeof args.font === 'object' ? args.font : undefined,
          fontSize: Number.isFinite(args.fontSize) ? args.fontSize : undefined,
          effects: Array.isArray(args.effects) ? args.effects : undefined,
        },
        timeoutMs: 60000,
      })
      return lossless(result.ok ? result : brief(result))
    },
  })

  register({
    name: 'figma_variable',
    description: '读取/创建/修改/绑定 Figma Variables（设计 token）：list 集合与变量；create 颜色/数字/字符串/布尔变量；set 改变量值；bind 把变量绑定到节点的填充、描边、间距、圆角、宽高、透明度等字段。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'set', 'bind'], description: '默认 list' },
        query: { type: 'string', description: 'list 时按名称过滤' },
        name: { type: 'string', description: '变量名（create 必填；set/bind 可替代 variableId）' },
        variableId: { type: 'string', description: '变量 id' },
        collectionName: { type: 'string', description: 'create 的集合名，默认 Design Tokens' },
        collectionId: { type: 'string', description: 'create 的集合 id' },
        resolvedType: { type: 'string', enum: ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'], description: 'create 的变量类型，默认 COLOR' },
        value: { description: 'create/set 的值：颜色 #RRGGBB、数字、字符串或布尔值' },
        modeId: { type: 'string', description: 'create/set 的 mode id，默认集合默认 mode' },
        nodeId: { type: 'string', description: 'bind 的目标节点 id' },
        field: { type: 'string', description: 'bind 字段：fill/stroke/paddingTop/itemSpacing/cornerRadius/width/height/opacity 等，默认 fill' },
      },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const action = ['list', 'create', 'set', 'bind'].includes(args.action) ? args.action : 'list'
      if (action === 'create' && typeof args.name !== 'string') {
        return lossless({ ok: false, error: { code: 'invalid-args', message: 'create 变量必须提供 name' } })
      }
      if ((action === 'set' || action === 'bind') && typeof args.variableId !== 'string' && typeof args.name !== 'string') {
        return lossless({ ok: false, error: { code: 'invalid-args', message: 'set/bind 必须提供 variableId 或 name' } })
      }
      if (action === 'bind' && typeof args.nodeId !== 'string') {
        return lossless({ ok: false, error: { code: 'invalid-args', message: 'bind 必须提供 nodeId' } })
      }
      const result = await bridge.call({
        command: 'variables',
        sessionId: sessionOf(exec),
        args: {
          action: action,
          query: typeof args.query === 'string' ? args.query : undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
          variableId: typeof args.variableId === 'string' ? args.variableId : undefined,
          collectionName: typeof args.collectionName === 'string' ? args.collectionName : undefined,
          collectionId: typeof args.collectionId === 'string' ? args.collectionId : undefined,
          resolvedType: typeof args.resolvedType === 'string' ? args.resolvedType : undefined,
          value: args.value,
          modeId: typeof args.modeId === 'string' ? args.modeId : undefined,
          nodeId: typeof args.nodeId === 'string' ? args.nodeId : undefined,
          field: typeof args.field === 'string' ? args.field : undefined,
        },
        timeoutMs: 60000,
      })
      return lossless(result.ok ? result : brief(result))
    },
  })

  register({
    name: 'figma_export',
    description: '把 Figma 设计导出到工作目录并返回绝对路径。format：html（自包含单页）、jsx（App.jsx + styles.css）、svg（Figma 原生矢量）、json（完整节点树快照）、tokens（Variables + 样式 → tokens.json/tokens.css/tokens.js）。html/jsx 默认 token-aware：Variables/Paint Styles/Text Styles → CSS 变量与 .text-* 类；tokenAware:false 关闭。jsx 默认 component-aware：组件实例提取为 React 组件（components.jsx）；componentAware:false 关闭。先 figma_select 选目标文件；前四种默认导出当前选区。',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: EXPORT_FORMATS, description: '导出格式：html / jsx / svg / json / tokens' },
        target: { type: 'string', enum: ['selection', 'page', 'node'], description: '导出目标：当前选区（默认）/ 当前页 / nodeIds 指定节点' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'target 为 node 时必填；其他 target 也可用它覆盖选区' },
        outDir: { type: 'string', description: '输出目录；默认 <工作目录>/figma-export/<文件名>-<时间戳>/。相对路径按工作目录解析' },
        tokenAware: { type: 'boolean', description: 'html/jsx 是否使用设计系统变量/文本样式（默认 true；无 token 时自动回退原始值）' },
        componentAware: { type: 'boolean', description: 'jsx 是否把组件实例提取为 React 组件（默认 true）' },
      },
      required: ['format'],
    },
    output: toolOutput(),
    async execute(args, exec) {
      const format = typeof args.format === 'string' ? args.format.toLowerCase() : ''
      if (EXPORT_FORMATS.indexOf(format) < 0) {
        return lossless({ ok: false, error: { code: 'invalid-format', message: `format 必须是 ${EXPORT_FORMATS.join(' / ')}` } })
      }
      const target = args.target === 'page' || args.target === 'node' ? args.target : 'selection'
      const nodeIds = Array.isArray(args.nodeIds)
        ? args.nodeIds.filter((id) => typeof id === 'string' && id.length > 0)
        : []
      if (target === 'node' && nodeIds.length === 0) {
        return lossless({ ok: false, error: { code: 'invalid-target', message: 'target:"node" 时必须提供 nodeIds' } })
      }

      if (format === 'tokens') {
        const libResult = await bridge.call({
          command: 'library',
          sessionId: sessionOf(exec),
          args: { limit: 500 },
          timeoutMs: 120000,
        })
        if (!libResult.ok) return lossless(brief(libResult))
        const library = libResult.value
        if (!library || library.ok !== true) {
          return lossless({ ok: false, error: { code: 'nothing-to-export', message: 'Figma 没有返回设计系统数据' } })
        }
        const cwdForTokens = await currentWorkingDirectory(ctx, exec)
        const tokenDirArg = typeof args.outDir === 'string' && args.outDir.trim().length > 0 ? args.outDir.trim() : ''
        const tokenOutDir = tokenDirArg
          ? (isAbsolute(tokenDirArg) ? tokenDirArg : resolve(cwdForTokens, tokenDirArg))
          : resolve(cwdForTokens, 'figma-export', `tokens-${exportStamp()}`)
        try {
          await mkdir(tokenOutDir, { recursive: true })
        } catch (error) {
          return lossless({ ok: false, error: { code: 'write-failed', message: `无法创建输出目录：${error && error.message ? error.message : error}` } })
        }
        let renderedTokens
        try {
          renderedTokens = toTokens(library, { exportedAt: new Date().toISOString() })
        } catch (error) {
          return lossless({ ok: false, error: { code: 'export-failed', message: error && error.message ? error.message : String(error) } })
        }
        const tokenFiles = []
        for (const [name, content] of Object.entries(renderedTokens.files)) {
          const filePath = join(tokenOutDir, name)
          try {
            await writeFile(filePath, content, 'utf8')
          } catch (error) {
            return lossless({ ok: false, error: { code: 'write-failed', message: `写入 ${name} 失败：${error && error.message ? error.message : error}` } })
          }
          tokenFiles.push({ name, path: filePath, bytes: Buffer.byteLength(content, 'utf8') })
        }
        return lossless({
          ok: true,
          format: 'tokens',
          target: 'library',
          outDir: tokenOutDir,
          rootName: library.file || library.page?.name || 'design-tokens',
          nodeCount: 0,
          files: tokenFiles,
          counts: renderedTokens.counts,
          warnings: dedupeWarnings([...(library.warnings || []), ...renderedTokens.warnings]).slice(0, 20),
        })
      }

      const treeResult = await bridge.call({
        command: 'tree',
        sessionId: sessionOf(exec),
        args: { target, nodeIds: nodeIds.length > 0 ? nodeIds : undefined, depth: format === 'svg' ? 0 : 20, maxNodes: 1200 },
        timeoutMs: 120000,
      })
      if (!treeResult.ok) return lossless(brief(treeResult))
      const tree = treeResult.value
      if (!tree || tree.ok !== true || !Array.isArray(tree.nodes) || tree.nodes.length === 0) {
        return lossless({ ok: false, error: { code: 'nothing-to-export', message: 'Figma 没有返回可导出的节点' } })
      }

      const rootName = target === 'page' || tree.nodes.length > 1
        ? (tree.file || tree.page?.name || 'Figma Export')
        : (tree.nodes[0].name || tree.file || tree.page?.name || 'Figma Export')
      const cwd = await currentWorkingDirectory(ctx, exec)
      const dirArg = typeof args.outDir === 'string' && args.outDir.trim().length > 0 ? args.outDir.trim() : ''
      const outDir = dirArg
        ? (isAbsolute(dirArg) ? dirArg : resolve(cwd, dirArg))
        : resolve(cwd, 'figma-export', `${exportSlug(rootName)}-${exportStamp()}`)

      try {
        await mkdir(outDir, { recursive: true })
      } catch (error) {
        return lossless({ ok: false, error: { code: 'write-failed', message: `无法创建输出目录：${error && error.message ? error.message : error}` } })
      }

      const warnings = Array.isArray(tree.warnings) ? tree.warnings.slice() : []
      const written = []
      if (format === 'svg') {
        const rootIds = tree.nodes.map((node) => node.id).filter((id) => typeof id === 'string')
        const result = await bridge.call({
          command: 'export',
          sessionId: sessionOf(exec),
          args: { format: 'SVG', nodeIds: rootIds, scale: 1 },
          timeoutMs: 120000,
        })
        if (!result.ok) return lossless(brief(result))
        const files = result.value && Array.isArray(result.value.files) ? result.value.files : []
        if (files.length === 0) return lossless({ ok: false, error: { code: 'nothing-to-export', message: 'Figma 没有返回 SVG 数据' } })
        for (const file of files) {
          if (!file || typeof file.data !== 'string') continue
          const safe = `${exportSlug(file.name || 'export')}-${String(file.nodeId || 'node').replace(/[^a-zA-Z0-9]+/g, '-')}.svg`
          const filePath = join(outDir, safe)
          try {
            await writeFile(filePath, Buffer.from(file.data, 'base64'))
          } catch (error) {
            return lossless({ ok: false, error: { code: 'write-failed', message: `写入 ${safe} 失败：${error && error.message ? error.message : error}` } })
          }
          written.push({ name: safe, path: filePath, bytes: Buffer.byteLength(file.data, 'base64') })
        }
        return lossless({
          ok: true,
          format: 'svg',
          target,
          outDir,
          rootName,
          nodeCount: tree.stats && typeof tree.stats.count === 'number' ? tree.stats.count : rootIds.length,
          files: written,
          warnings: warnings.slice(0, 20),
          treeStats: tree.stats,
        })
      }

      let tokenContext = null
      if ((format === 'html' || format === 'jsx') && args.tokenAware !== false) {
        try {
          const libResult = await bridge.call({
            command: 'library',
            sessionId: sessionOf(exec),
            args: { limit: 500 },
            timeoutMs: 120000,
          })
          if (libResult.ok && libResult.value && libResult.value.ok === true) {
            tokenContext = buildTokenContext(libResult.value)
          } else {
            warnings.push('设计系统读取失败，已回退为原始颜色/字号/间距')
          }
        } catch (error) {
          warnings.push(`设计系统读取失败，已回退为原始值：${error && error.message ? error.message : String(error)}`)
        }
      }

      let rendered
      try {
        if (format === 'html') rendered = toHTML(tree, { tokenContext })
        else if (format === 'jsx') rendered = toJSX(tree, { tokenContext, componentAware: args.componentAware !== false })
        else rendered = toJSON(tree, { file: tree.file, page: tree.page, exportedAt: new Date().toISOString() })
      } catch (error) {
        return lossless({ ok: false, error: { code: 'export-failed', message: error && error.message ? error.message : String(error) } })
      }
      for (const [name, content] of Object.entries(rendered.files)) {
        const filePath = join(outDir, name)
        try {
          await writeFile(filePath, content, 'utf8')
        } catch (error) {
          return lossless({ ok: false, error: { code: 'write-failed', message: `写入 ${name} 失败：${error && error.message ? error.message : error}` } })
        }
        written.push({ name, path: filePath, bytes: Buffer.byteLength(content, 'utf8') })
      }
      const counts = describeModel(rendered.model)
      return lossless({
        ok: true,
        format,
        target,
        outDir,
        rootName,
        nodeCount: tree.stats && typeof tree.stats.count === 'number' ? tree.stats.count : tree.nodes.length,
        files: written,
        counts,
        warnings: dedupeWarnings([...warnings, ...rendered.model.warnings]).slice(0, 20),
        tokenAware: rendered.tokenAware === true,
        tokenCounts: tokenContext ? tokenContext.counts : null,
        componentAware: rendered.componentAware === true,
        componentCount: rendered.componentCount || 0,
        treeStats: tree.stats,
      })
    },
  })

  return () => {
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
