import assert from 'node:assert/strict'
import test from 'node:test'

import { fitSize, inspectImage } from '../lib/image.js'

// 1x1 transparent PNG
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+2k7nWQAAAABJRU5ErkJggg==', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00])

test('inspectImage reads PNG/GIF/JPEG dimensions', () => {
  assert.deepEqual(inspectImage(png), { mimeType: 'image/png', type: 'png', width: 1, height: 1 })
  assert.deepEqual(inspectImage(gif), { mimeType: 'image/gif', type: 'gif', width: 1, height: 1 })
  assert.deepEqual(inspectImage(jpegHeader), { mimeType: 'image/jpeg', type: 'jpeg', width: 48, height: 32 })
})

test('inspectImage rejects unsupported data', () => {
  assert.throws(() => inspectImage(Buffer.from('not an image')), /PNG/)
})

test('fitSize preserves aspect ratio and caps the longest side', () => {
  assert.deepEqual(fitSize(2400, 1200, 1200), { width: 1200, height: 600, scale: 0.5 })
  assert.deepEqual(fitSize(300, 400, 1200), { width: 300, height: 400, scale: 1 })
})
