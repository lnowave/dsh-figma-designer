/**
 * Companion generation tests.
 *
 * These encode the two Phase 0 findings that must not regress: the manifest may
 * only use `http://localhost:<port>` entries, and the pairing token must exist
 * solely in ui.html (never in code.js, manifest.json, or the README).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { prepareCompanion } from '../lib/setup.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'a'.repeat(48)

const makeHome = () => mkdtempSync(join(tmpdir(), 'figma-designer-setup-'))

test('manifest is Figma-valid: localhost-only dev domains, no paths, no IPs', () => {
  const homeDir = makeHome()
  try {
    const result = prepareCompanion({
      homeDir,
      packageDir: ROOT,
      token: TOKEN,
      port: 3977,
      candidates: [3977, 3978, 3979],
      version: '0.1.0',
    })
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    assert.equal(manifest.name, 'DSH Figma Designer')
    assert.equal(manifest.main, 'code.js')
    assert.equal(manifest.ui, 'ui.html')
    assert.equal(manifest.documentAccess, 'dynamic-page')
    assert.deepEqual(manifest.editorType, ['figma', 'figjam'])
    assert.deepEqual(manifest.networkAccess.allowedDomains, ['none'])
    assert.deepEqual(manifest.networkAccess.devAllowedDomains, [
      'http://localhost:3977',
      'http://localhost:3978',
      'http://localhost:3979',
    ])
    for (const domain of manifest.networkAccess.devAllowedDomains) {
      assert.ok(!domain.includes('/bridge'), 'devAllowedDomains must not contain a path')
      assert.ok(!/127\.0\.0\.1|\[::1\]/.test(domain), 'devAllowedDomains must not contain an IP literal')
      assert.match(domain, /^http:\/\/localhost:\d+$/)
    }
    assert.deepEqual(result.ports, [3977, 3978, 3979])
    assert.equal(JSON.stringify(manifest).includes(TOKEN), false, 'manifest must not contain the token')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('pairing token only lives in ui.html; code.js is copied verbatim', () => {
  const homeDir = makeHome()
  try {
    const result = prepareCompanion({
      homeDir,
      packageDir: ROOT,
      token: TOKEN,
      port: 3977,
      candidates: [3977],
      version: '0.1.0',
    })
    const files = ['manifest.json', 'code.js', 'ui.html', 'README.md']
    for (const name of files) assert.ok(existsSync(join(result.dir, name)), `missing ${name}`)

    const ui = readFileSync(join(result.dir, 'ui.html'), 'utf8')
    assert.ok(ui.includes(TOKEN), 'ui.html must embed the pairing token')
    assert.ok(ui.includes('http://localhost:'), 'ui.html must call localhost')
    assert.ok(!ui.includes('__CONFIG__'), 'placeholder must be replaced')

    const code = readFileSync(join(result.dir, 'code.js'), 'utf8')
    assert.equal(code.includes(TOKEN), false, 'code.js must not contain the token')
    assert.equal(code, readFileSync(join(ROOT, 'companion', 'code.js'), 'utf8'), 'code.js must be copied verbatim')

    const readme = readFileSync(join(result.dir, 'README.md'), 'utf8')
    assert.equal(readme.includes(TOKEN), false, 'README must not contain the token')
    assert.ok(readme.includes(result.manifestPath), 'README should point at the manifest path')

    const manifest = readFileSync(join(result.dir, 'manifest.json'), 'utf8')
    assert.equal(manifest.includes(TOKEN), false, 'manifest must not contain the token')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('regeneration is stable and leaves no temporary files', () => {
  const homeDir = makeHome()
  try {
    const first = prepareCompanion({ homeDir, packageDir: ROOT, token: TOKEN, port: 3977, candidates: [3977], version: '0.1.0' })
    const firstManifest = readFileSync(first.manifestPath, 'utf8')
    const second = prepareCompanion({ homeDir, packageDir: ROOT, token: TOKEN, port: 3978, candidates: [3978], version: '0.1.0' })
    const secondManifest = readFileSync(second.manifestPath, 'utf8')
    assert.notEqual(firstManifest, secondManifest, 'a new port must be reflected in the manifest')
    const leftovers = readdirSync(second.dir).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('candidate ports are de-duplicated and keep the active port first', () => {
  const homeDir = makeHome()
  try {
    const result = prepareCompanion({
      homeDir,
      packageDir: ROOT,
      token: TOKEN,
      port: 3978,
      candidates: [3977, 3978, 3978, 3979],
      version: '0.1.0',
    })
    assert.deepEqual(result.ports, [3978, 3977, 3979])
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})
