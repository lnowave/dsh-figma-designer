/**
 * Paired Figma companion generation.
 *
 * Writes `<DSH_HOME>/figma-designer/companion/` with the current bridge port and
 * pairing token embedded in `ui.html`, so the user imports that folder once in
 * Figma Desktop and reruns the plugin after each upgrade. The directory path is
 * stable, which is what lets a regeneration avoid a re-import.
 *
 * Constraints learned in Phase 0 (do not "fix" them):
 * - `devAllowedDomains` accepts only `http://localhost:<port>`: no paths, no IP
 *   literals, or Figma rejects the manifest with "must be a valid URL".
 * - the pairing token belongs in `ui.html` only; `code.js` and README must never
 *   contain it.
 *
 * @module dsh-figma-designer/lib/setup
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const COMPANION_VERSION = '0.3.2'

const atomicWrite = (dir, name, content) => {
  const target = join(dir, name)
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, content, { mode: 0o644 })
  renameSync(tmp, target)
}

const manifestFor = (ports) => ({
  name: 'DSH Figma Designer',
  id: 'dsh-figma-designer-local',
  api: '1.0.0',
  main: 'code.js',
  ui: 'ui.html',
  editorType: ['figma', 'figjam'],
  documentAccess: 'dynamic-page',
  networkAccess: {
    allowedDomains: ['none'],
    devAllowedDomains: ports.map((port) => `http://localhost:${port}`),
    reasoning: 'Connect only to the local DSH Figma Designer bridge on loopback.',
  },
})

const README = (manifestPath) => `# DSH Figma Designer — 本机配对伴生插件

这个目录由 DSH-Figma-Designer 生成，**内含本机配对密钥**（只写在 ui.html），请勿分享或上传。

## 导入（只需一次）

1. 打开 Figma **桌面版**。
2. 菜单 **Plugins → Development → Import plugin from manifest…**
3. 选择：\`${manifestPath}\`
4. 在目标文件运行 **Plugins → Development → DSH Figma Designer**，保持窗口打开。

## 升级后

DSH 侧插件更新后，重新生成会原地更新这个目录；关闭并重新运行 Figma 插件即可，不需要重新导入。
`

/**
 * @param {{ homeDir: string, packageDir: string, token: string, port: number, candidates?: number[], version?: string }} input
 */
export function prepareCompanion(input) {
  const { homeDir, packageDir, token, port } = input
  if (typeof token !== 'string' || token.length < 16) throw new Error('prepareCompanion requires a pairing token')
  if (!Number.isFinite(port)) throw new Error('prepareCompanion requires a port')
  const version = typeof input.version === 'string' ? input.version : COMPANION_VERSION
  const ports = [port, ...(Array.isArray(input.candidates) ? input.candidates : []).filter((value) => Number.isFinite(value) && value !== port)]
  const dir = join(homeDir, 'figma-designer', 'companion')
  const manifestPath = join(dir, 'manifest.json')

  const uiTemplate = readFileSync(join(packageDir, 'companion', 'ui.html'), 'utf8')
  if (!uiTemplate.includes('__CONFIG__')) throw new Error('companion/ui.html 缺少 __CONFIG__ 占位符')
  const code = readFileSync(join(packageDir, 'companion', 'code.js'), 'utf8')
  const ui = uiTemplate.replace('__CONFIG__', JSON.stringify({ token, ports, port, version }))

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  atomicWrite(dir, 'manifest.json', `${JSON.stringify(manifestFor(ports), null, 2)}\n`)
  atomicWrite(dir, 'code.js', code)
  atomicWrite(dir, 'ui.html', ui)
  atomicWrite(dir, 'README.md', README(manifestPath))

  return { dir, manifestPath, ports, version, token }
}
