import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMediaContactPage, downloadMediaImage, rightsUse, searchMedia } from '../lib/media.js'

const response = (json) => ({ ok: true, status: 200, json: async () => json, headers: { get: () => 'application/json' } })
const binary = (bytes, mimeType = 'image/png') => ({ ok: true, status: 200, arrayBuffer: async () => bytes, headers: { get: () => mimeType } })

test('rightsUse separates commercial, reference and check licenses', () => {
  assert.equal(rightsUse('CC0'), 'page')
  assert.equal(rightsUse('CC BY-SA 4.0'), 'page')
  assert.equal(rightsUse('CC BY-NC 4.0'), 'reference')
  assert.equal(rightsUse('Rights not specified'), 'check')
})

test('Openverse search normalizes license and candidate metadata', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /api\.openverse\.org/)
    return response({ results: [{
      id: 'o1', title: 'Desk', creator: 'Ada', source: 'flickr', license: 'by', license_version: '4.0',
      license_url: 'https://creativecommons.org/licenses/by/4.0/', foreign_landing_url: 'https://example.com/o1',
      url: 'https://example.com/o1.jpg', thumbnail: 'https://example.com/o1-thumb.jpg', width: 1200, height: 800,
    }] })
  }
  const { candidates } = await searchMedia({ query: 'desk', source: 'openverse', limit: 2, fetchImpl })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].provider, 'openverse')
  assert.equal(candidates[0].usable, 'page')
  assert.equal(candidates[0].imageUrl, 'https://example.com/o1.jpg')
})

test('Wikimedia Commons search reads extmetadata and thumbnail', async () => {
  const fetchImpl = async () => response({ query: { pages: [{
    pageid: 1, title: 'File:Desk.jpg',
    imageinfo: [{
      url: 'https://upload.wikimedia.org/desk.jpg', thumburl: 'https://upload.wikimedia.org/thumb/desk.jpg',
      width: 1600, height: 1000, mime: 'image/jpeg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Desk.jpg',
      extmetadata: {
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
        Artist: { value: '<a>Ada</a>' },
        ObjectName: { value: 'Desk' },
      },
    }],
  }] } })
  const { candidates } = await searchMedia({ query: 'desk', source: 'commons', limit: 1, fetchImpl })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].license, 'CC BY-SA 4.0')
  assert.equal(candidates[0].attribution.includes('Ada'), true)
  assert.equal(candidates[0].usable, 'page')
})

test('downloadMediaImage enforces HTTP status and size metadata', async () => {
  const image = await downloadMediaImage('https://example.com/a.png', { fetchImpl: async () => binary(new Uint8Array([1, 2, 3])) })
  assert.equal(image.mimeType, 'image/png')
  assert.deepEqual([...image.buffer], [1, 2, 3])
})

test('contact page includes refs, license state, thumbnails and choose action', () => {
  const html = buildMediaContactPage({
    query: 'desk', source: 'all', candidates: [{
      ref: 'C1', title: 'Desk', detail: 'Photo', license: 'CC0', usable: 'page', attribution: 'Commons',
      pageUrl: 'https://example.com', thumbDataUri: 'data:image/png;base64,AA==',
    }],
  })
  assert.match(html, /C1/)
  assert.match(html, /可商用/)
  assert.match(html, /data:image\/png;base64,AA==/)
  assert.match(html, /选这个/)
})
