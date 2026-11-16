/**
 * Pure audit-engine tests.
 *
 * The audit consumes the same normalized `tree` payload as the exporter, so
 * synthetic trees keep it testable without Figma or a running bridge.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { auditTree } from '../lib/audit.js'

const text = (id, characters, options = {}) => ({
  id,
  name: options.name || id,
  type: 'TEXT',
  visible: true,
  opacity: 1,
  x: options.x ?? 0,
  y: options.y ?? 0,
  width: options.width ?? 300,
  height: options.height ?? 24,
  fills: options.fill === null ? null : [{ type: 'SOLID', color: options.fill || '#FFFFFF', opacity: 1 }],
  text: {
    characters,
    font: { family: options.family || 'Inter', style: options.style || 'Regular' },
    fontSize: options.fontSize ?? 16,
    align: 'LEFT',
    lineHeight: options.lineHeight ?? { unit: 'PIXELS', value: (options.fontSize ?? 16) * 1.6 },
    letterSpacing: { unit: 'PERCENT', value: 0 },
    textAutoResize: 'NONE',
  },
})

const frame = (id, children = [], options = {}) => ({
  id,
  name: options.name || id,
  type: 'FRAME',
  visible: true,
  opacity: 1,
  x: options.x ?? 0,
  y: options.y ?? 0,
  width: options.width ?? 390,
  height: options.height ?? 844,
  fills: options.fill === null ? null : [{ type: 'SOLID', color: options.fill || '#0B1020', opacity: 1 }],
  clipsContent: options.clipsContent === true,
  layout: options.layout,
  children,
})

const tree = (nodes) => ({ ok: true, file: 'Audit', page: { id: '0:1', name: 'Page 1' }, target: 'selection', nodes, stats: { truncated: false } })

test('good page passes contrast, type, spacing, palette and tap-target checks', () => {
  const audit = auditTree(tree([
    frame('1:1', [
      text('1:2', 'Workspace login', { fontSize: 32, fill: '#F8FAFC' }),
      text('1:3', 'Use your work account to continue.', { fontSize: 15, fill: '#E2E8F0' }),
      frame('1:4', [
        text('1:5', 'Sign in', { fontSize: 16, fill: '#0B1020', width: 60 }),
      ], { name: 'Sign in button', width: 334, height: 56, fill: '#F97316' }),
    ], { layout: { mode: 'VERTICAL', itemSpacing: 16, padding: { top: 32, right: 28, bottom: 32, left: 28 } } }),
  ]), null)
  assert.equal(audit.ok, true)
  assert.equal(audit.counts.errors, 0)
  assert.equal(audit.counts.warnings, 0, JSON.stringify(audit.issues))
  assert.equal(audit.metrics.contrast.checked, 3)
  assert.equal(audit.metrics.contrast.failed, 0)
  assert.equal(audit.score, 100)
})

test('low contrast, tiny text and placeholder copy are errors with node ids', () => {
  const audit = auditTree(tree([
    frame('2:1', [
      text('2:2', 'Lorem ipsum dolor sit amet', { fontSize: 9, fill: '#777777' }),
    ], { fill: '#FFFFFF' }),
  ]), null)
  const codes = audit.issues.map((item) => item.code)
  assert.ok(codes.includes('copy/placeholder'))
  assert.ok(codes.includes('type/too-small'))
  assert.ok(codes.includes('contrast/text'))
  assert.ok(audit.issues.some((item) => item.nodeId === '2:2'))
  assert.ok(audit.score < 70)
})

test('text contrast is computed against inherited ancestor backgrounds', () => {
  const audit = auditTree(tree([
    frame('3:1', [
      frame('3:2', [
        text('3:3', 'Low contrast on dark', { fontSize: 15, fill: '#333333' }),
        text('3:4', 'High contrast on dark', { fontSize: 15, fill: '#FFFFFF' }),
      ], { fill: null }),
    ], { fill: '#0B1020' }),
  ]), null)
  const failed = audit.issues.filter((item) => item.code === 'contrast/text')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].nodeId, '3:3')
})

test('spacing outliers, many sizes and oversized palettes are reported as warnings', () => {
  const children = [
    text('4:2', 'One', { fontSize: 12, fill: '#FFFFFF' }),
    text('4:3', 'Two', { fontSize: 13, fill: '#EEEEEE' }),
    text('4:4', 'Three', { fontSize: 14, fill: '#DDDDDD' }),
    text('4:5', 'Four', { fontSize: 15, fill: '#CCCCCC' }),
    text('4:6', 'Five', { fontSize: 16, fill: '#BBBBBB' }),
    text('4:7', 'Six', { fontSize: 17, fill: '#AAAAAA' }),
    text('4:8', 'Seven', { fontSize: 18, fill: '#999999' }),
    text('4:9', 'Eight', { fontSize: 18, fill: '#888888' }),
    text('4:10', 'Nine', { fontSize: 18, fill: '#777777' }),
    text('4:11', 'Ten', { fontSize: 18, fill: '#666666' }),
    text('4:12', 'Eleven', { fontSize: 18, fill: '#555555' }),
    text('4:13', 'Twelve', { fontSize: 18, fill: '#444444' }),
  ]
  const audit = auditTree(tree([
    frame('4:1', children, {
      fill: '#111111',
      layout: { mode: 'VERTICAL', itemSpacing: 10, padding: { top: 18, right: 16, bottom: 16, left: 16 } },
    }),
  ]), null)
  const codes = audit.issues.map((item) => item.code)
  assert.ok(codes.includes('spacing/off-grid'))
  assert.ok(codes.includes('type/too-many-sizes'))
  assert.ok(codes.includes('palette/too-many'))
})

test('small interactive controls and clipped children are flagged', () => {
  const audit = auditTree(tree([
    frame('5:1', [
      frame('5:2', [{ id: '5:3', name: 'icon', type: 'RECT', width: 12, height: 12, x: 380, y: 0, visible: true }], {
        name: 'Icon button', width: 30, height: 30, clipsContent: true, fill: '#111111',
      }),
    ], { fill: '#0B1020' }),
  ]), null)
  const codes = audit.issues.map((item) => item.code)
  assert.ok(codes.includes('a11y/tap-target'))
  assert.ok(codes.includes('layout/clipped'))
})

test('hidden nodes are skipped by default and token coverage uses library colors', () => {
  const hidden = text('6:2', 'Hidden text', { fontSize: 8, fill: '#111111' })
  hidden.visible = false
  const audit = auditTree(tree([
    frame('6:1', [
      hidden,
      text('6:3', 'Visible', { fontSize: 15, fill: '#F97316' }),
    ], { fill: '#0B1020' }),
  ]), {
    styles: { paint: [{ name: 'Brand / Primary', paints: [{ type: 'SOLID', color: '#F97316' }] }] },
    variables: [],
  })
  assert.equal(audit.metrics.nodes, 2)
  assert.equal(audit.metrics.textNodes, 1)
  assert.equal(audit.metrics.palette.tokensAvailable, 1)
  assert.ok(audit.metrics.palette.tokenCoverage > 0)
})
