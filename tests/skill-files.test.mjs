/**
 * Bundled skill packaging tests.
 *
 * The Host registers both `figma-designer` (operations) and `figma-design`
 * (quality workflow). Missing SKILL.md/reference files silently degrade the
 * agent's workflow, so keep this guard cheap and explicit.
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

test('both bundled skills have frontmatter and required references', () => {
  for (const name of ['figma-designer', 'figma-design']) {
    const skillPath = join(ROOT, name, 'SKILL.md')
    assert.ok(existsSync(skillPath), `${name}/SKILL.md missing`)
    const raw = readFileSync(skillPath, 'utf8')
    assert.match(raw, /^---\n/, `${name} must start with frontmatter`)
    assert.match(raw, /^description:\s+\S/m, `${name} needs a description`)
  }
  const designDir = join(ROOT, 'figma-design', 'references')
  for (const file of ['design-direction.md', 'visual-language.md', 'tokens.md', 'figma-workflow.md', 'reviewer.md', 'audit.md', 'compare.md', 'design-doc-template.md']) {
    assert.ok(existsSync(join(designDir, file)), `figma-design/references/${file} missing`)
  }
})

test('reviewer manual keeps the independent scoring and rejection gates', () => {
  const manual = readFileSync(join(ROOT, 'figma-design', 'references', 'reviewer.md'), 'utf8')
  assert.match(manual, /验收否决/)
  assert.match(manual, /三秒测试/)
  assert.match(manual, /1–10/)
  assert.match(manual, /不可发布|重做/)
  assert.match(manual, /保留/)
})
