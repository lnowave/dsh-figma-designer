/**
 * Slash-command tests.
 *
 * The two tier commands exist so the user picks the design budget instead of
 * relying on the model inferring it from wording. They must register on the
 * `commands` service and queue exactly one follow-up turn carrying the tier's
 * budget text and the user's request.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const makeContext = () => {
  const commands = []
  const tools = []
  const disposers = []
  const toolsService = { register: (definition) => { tools.push(definition); return () => {} } }
  const ctx = {
    // lib/tools.js reads ctx.tools directly; the command registry is looked up by name.
    tools: toolsService,
    get: (name) => {
      if (name === 'commands') return { register: (definition) => { commands.push(definition); return () => {} } }
      if (name === 'tools') return toolsService
      return undefined
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return { ctx, commands, tools, disposers }
}

test('tier commands register and queue one follow-up turn each', async () => {
  const home = mkdtempSync(join(tmpdir(), 'figma-designer-commands-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { ctx, commands, disposers } = makeContext()
  try {
    await apply(ctx, { port: 43001 })

    const names = commands.map((command) => command.name)
    assert.deepEqual(names, ['figma-quick-design', 'figma-thinking-design'])
    for (const command of commands) {
      assert.equal(typeof command.description, 'string')
      assert.ok(command.description.length > 0)
      assert.equal(command.input.hint.startsWith('<'), true)
    }

    const sent = []
    const invocation = (rawInput) => ({
      rawInput,
      agent: { followup: (message) => { sent.push(message) } },
      attachments: [],
    })

    const quick = commands.find((command) => command.name === 'figma-quick-design')
    const empty = await quick.handler(invocation('   '))
    assert.equal(empty.kind, 'error')
    assert.match(empty.text, /用法/)

    const ok = await quick.handler(invocation('做一个 pricing 页面'))
    assert.equal(ok.kind, 'success')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].role, 'user')
    const text = sent[0].content.map((block) => block.text).join('\n')
    assert.match(text, /^\[Figma 快速设计\] 做一个 pricing 页面/)
    assert.match(text, /≤6 次/)
    assert.equal(sent[0].source.kind, 'user')
    assert.equal(typeof sent[0].id, 'string')

    const thinking = commands.find((command) => command.name === 'figma-thinking-design')
    const deep = await thinking.handler(invocation('重做结算页'))
    assert.equal(deep.kind, 'success')
    const deepText = sent[1].content.map((block) => block.text).join('\n')
    assert.match(deepText, /^\[Figma 打磨设计\] 重做结算页/)
    assert.match(deepText, /reviews|评审/)
  } finally {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* best effort */
      }
    }
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
