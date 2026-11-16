/**
 * Compare-page generator tests (pure, no browser).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildComparePage, compareSlug } from '../lib/compare.js'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64')

test('compare page embeds images, metadata, palette and neutral shell', () => {
  const { html, manifest } = buildComparePage({
    title: 'Pricing <directions>',
    file: 'Acme',
    page: 'Page 1',
    generatedAt: '2026-11-16T00:00:00.000Z',
    candidates: [
      {
        nodeId: '1:2',
        name: 'A "bold"',
        concept: 'Editorial pricing',
        palette: ['#0B1020', '#F97316'],
        traits: ['editorial', 'dense'],
        image: { mimeType: 'image/png', data: png, width: 320, height: 640 },
        imageFile: '01-a.png',
      },
      {
        nodeId: '1:3',
        name: 'B',
        concept: 'Calm workspace',
        image: { mimeType: 'image/png', data: png, width: 320, height: 640 },
        imageFile: '02-b.png',
      },
    ],
  })
  assert.match(html, /Pricing &lt;directions&gt;/)
  assert.match(html, /A &quot;bold&quot;/)
  assert.match(html, /Editorial pricing/)
  assert.match(html, /data:image\/png;base64/)
  assert.match(html, /class="swatch"/)
  assert.match(html, /editorial/)
  assert.match(html, /选这个/)
  assert.match(html, /实际尺寸/)
  assert.equal(manifest.candidates.length, 2)
  assert.equal(manifest.candidates[0].image, '01-a.png')
  assert.equal(manifest.candidates[0].nodeId, '1:2')
  assert.ok(!JSON.stringify(manifest).includes(png), 'manifest must not duplicate base64 image data')
})

test('compare slug is filename-safe', () => {
  assert.equal(compareSlug('A bold direction'), 'a-bold-direction')
  assert.equal(compareSlug('方向'), 'candidate')
  assert.equal(compareSlug('方向 A'), 'a')
  assert.match(compareSlug('a'.repeat(80)), /^a{1,32}$/)
})
