/**
 * Code-generation tests for the Host export projector.
 *
 * These run against a normalized tree shaped exactly like the companion's
 * `tree` command, so the HTML/JSX/JSON emitters are tested without Figma.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTokenContext, describeModel, toHTML, toJSX, toJSON, toTokens } from '../lib/export.js'

const tree = {
  file: 'Pricing',
  page: { id: '0:1', name: 'Page 1' },
  stats: { count: 5, truncated: false, maxNodes: 800, depth: 20 },
  warnings: [],
  nodes: [
    {
      id: '5:2',
      name: 'Pricing / Desktop',
      type: 'FRAME',
      visible: true,
      opacity: 1,
      rotation: 0,
      x: 500,
      y: 0,
      width: 1200,
      height: 784,
      fills: [{ type: 'SOLID', color: '#0B1020', opacity: 1 }],
      cornerRadius: 28,
      clipsContent: true,
      layout: { mode: 'VERTICAL', itemSpacing: 28, padding: { top: 64, right: 64, bottom: 56, left: 64 }, primaryAxisAlign: 'MIN', counterAxisAlign: 'CENTER' },
      children: [
        {
          id: '5:3',
          name: 'Headline',
          type: 'TEXT',
          visible: true,
          opacity: 1,
          rotation: 0,
          x: 0,
          y: 0,
          width: 1072,
          height: 63,
          fills: [{ type: 'SOLID', color: '#FFFFFF', opacity: 1 }],
          text: { characters: 'Simple "transparent" pricing', font: { family: 'Inter', style: 'Bold' }, fontSize: 52, align: 'CENTER', lineHeight: { unit: 'PIXELS', value: 63 }, letterSpacing: null },
        },
        {
          id: '5:5',
          name: 'Cards',
          type: 'FRAME',
          visible: true,
          opacity: 1,
          rotation: 0,
          x: 596,
          y: 204,
          width: 1008,
          height: 480,
          fills: null,
          layout: { mode: 'HORIZONTAL', itemSpacing: 24, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAxisAlign: 'CENTER', counterAxisAlign: 'MIN' },
          children: [
            { id: '5:6', name: 'Card / Starter', type: 'FRAME', visible: true, opacity: 1, rotation: 0, x: 0, y: 0, width: 320, height: 400, fills: [{ type: 'SOLID', color: '#101728', opacity: 1 }], strokes: [{ type: 'SOLID', color: '#26314D', opacity: 1 }], strokeWeight: 1, cornerRadius: 20, children: [] },
          ],
        },
      ],
    },
  ],
}

test('toHTML emits a self-contained page with flex layout, text color and escaped text', () => {
  const { files, model } = toHTML(tree)
  const html = files['index.html']
  assert.match(html, /<!DOCTYPE html>/)
  assert.match(html, /class="figma-root pricing-desktop-5-2"/)
  assert.match(html, /display: flex;/)
  assert.match(html, /flex-direction: column;/)
  assert.match(html, /gap: 28px;/)
  assert.match(html, /padding: 64px 64px 56px 64px;/)
  assert.match(html, /background: #0B1020;/)
  assert.match(html, /color: #FFFFFF;/)
  assert.match(html, /font-weight: 700;/)
  assert.match(html, /Simple &quot;transparent&quot; pricing/)
  assert.match(html, /class="cards-5-5"/)
  assert.match(html, /border-radius: 20px;/)
  assert.deepEqual(describeModel(model), { frames: 2, texts: 1, leaves: 1 })
})

test('toJSX emits App.jsx plus styles.css with the same class names', () => {
  const { files } = toJSX(tree)
  assert.match(files['App.jsx'], /import '\.\/styles\.css'/)
  assert.match(files['App.jsx'], /export default function App\(\)/)
  assert.match(files['App.jsx'], /className="figma-root pricing-desktop-5-2"/)
  assert.match(files['App.jsx'], /\{"Simple \\"transparent\\" pricing"\}/)
  assert.match(files['styles.css'], /\.pricing-desktop-5-2 \{/)
  assert.match(files['styles.css'], /\.headline-5-3 \{/)
})

test('toJSON preserves the normalized tree and metadata', () => {
  const { files } = toJSON(tree, { file: 'Pricing' })
  const parsed = JSON.parse(files['design.json'])
  assert.equal(parsed.generatedBy, 'dsh-figma-designer')
  assert.equal(parsed.tree.nodes[0].id, '5:2')
  assert.equal(parsed.tree.nodes[0].children[0].text.characters, 'Simple "transparent" pricing')
})

test('multiple roots are wrapped in a page canvas with absolute positions offset to zero', () => {
  const pageTree = {
    ...tree,
    nodes: [
      { id: '1:1', name: 'A', type: 'FRAME', visible: true, x: -100, y: -50, width: 200, height: 100, fills: null, children: [] },
      { id: '1:2', name: 'B', type: 'FRAME', visible: true, x: 100, y: 50, width: 200, height: 100, fills: null, children: [] },
    ],
  }
  const { files } = toHTML(pageTree)
  assert.match(files['index.html'], /class="figma-root figma-page"/)
  assert.match(files['index.html'], /left: 0; top: 0;/)
  assert.match(files['index.html'], /width: 400px;/)
  assert.match(files['index.html'], /height: 200px;/)
})

test('unsupported vector nodes remain as a placed box with a warning', () => {
  const vectorTree = {
    ...tree,
    nodes: [{ id: '9:9', name: 'Icon', type: 'VECTOR', visible: true, x: 0, y: 0, width: 24, height: 24, fills: null, children: [] }],
  }
  const { files, model } = toHTML(vectorTree)
  assert.match(files['index.html'], /class="figma-root icon-9-9"/)
  assert.ok(model.warnings.some((line) => line.includes('VECTOR')))
})

test('token-aware HTML uses paint style, variable colors, spacing vars and text styles', () => {
  const library = {
    variableCollections: [{ id: 'VC:1', name: 'Design Tokens', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Mode 1' }] }],
    variables: [
      { id: 'V:1', name: 'color/primary', resolvedType: 'COLOR', collectionId: 'VC:1', valuesByMode: { m1: '#F97316' }, description: '' },
      { id: 'V:2', name: 'space/16', resolvedType: 'FLOAT', collectionId: 'VC:1', valuesByMode: { m1: 16 }, description: '' },
    ],
    styles: {
      paint: [{ id: 'S:1', name: 'Brand / Primary', type: 'PAINT', paints: [{ type: 'SOLID', color: '#F97316', opacity: 1 }] }],
      text: [{ id: 'S:2', name: 'Heading / XL', type: 'TEXT', font: { family: 'Inter', style: 'Bold' }, fontSize: 48, lineHeight: { unit: 'PIXELS', value: 56 }, letterSpacing: { unit: 'PERCENT', value: 0 } }],
      effect: [],
    },
  }
  const tokenTree = {
    file: 'Token demo',
    page: { id: '0:1', name: 'Page 1' },
    stats: { count: 2, truncated: false },
    nodes: [{
      id: '1:1', name: 'Hero', type: 'FRAME', visible: true, opacity: 1, x: 0, y: 0, width: 400, height: 200,
      fills: [{ type: 'SOLID', color: '#F97316', opacity: 1 }],
      styles: { fill: 'S:1' },
      layout: { mode: 'HORIZONTAL', itemSpacing: 16, padding: { top: 16, right: 16, bottom: 16, left: 16 } },
      children: [{
        id: '1:2', name: 'Headline', type: 'TEXT', visible: true, opacity: 1, x: 0, y: 0, width: 300, height: 56,
        fills: [{ type: 'SOLID', color: '#F97316', opacity: 1 }],
        styles: { text: 'S:2' },
        text: { characters: 'Hello', font: { family: 'Inter', style: 'Bold' }, fontSize: 48, lineHeight: { unit: 'PIXELS', value: 56 }, letterSpacing: null },
      }],
    }],
  }
  const context = buildTokenContext(library)
  const { files } = toHTML(tokenTree, { tokenContext: context })
  const html = files['index.html']
  assert.match(html, /--color-primary: #F97316;/)
  assert.match(html, /--space-16: 16px;/)
  assert.match(html, /background: var\(--paint-brand-primary\);/)
  assert.match(html, /color: var\(--color-primary\);/)
  assert.match(html, /gap: var\(--space-16\);/)
  assert.match(html, /padding: var\(--space-16\) var\(--space-16\) var\(--space-16\) var\(--space-16\);/)
  assert.match(html, /text-heading-xl/)
  assert.match(html, /\.text-heading-xl \{/)
  const jsx = toJSX(tokenTree, { tokenContext: context })
  assert.match(jsx.files['styles.css'], /--color-primary: #F97316;/)
  assert.match(jsx.files['styles.css'], /\.text-heading-xl \{/)
  assert.match(jsx.files['App.jsx'], /text-heading-xl/)
})

test('component-aware JSX extracts repeated component instances and reuses identical ones', () => {
  const instance = (id, label, x) => ({
    id,
    name: `Button instance ${id}`,
    type: 'INSTANCE',
    visible: true,
    opacity: 1,
    x,
    y: 0,
    width: 120,
    height: 44,
    component: { id: 'C:1', name: 'Button' },
    fills: [{ type: 'SOLID', color: '#F97316', opacity: 1 }],
    layout: { mode: 'HORIZONTAL', itemSpacing: 8, padding: { top: 8, right: 12, bottom: 8, left: 12 } },
    children: [{
      id: `${id};label`, name: 'Label', type: 'TEXT', visible: true, opacity: 1, x: 0, y: 0, width: 80, height: 20,
      fills: [{ type: 'SOLID', color: '#0B1020', opacity: 1 }],
      text: { characters: label, font: { family: 'Inter', style: 'Bold' }, fontSize: 16, lineHeight: { unit: 'PIXELS', value: 20 } },
    }],
  })
  const componentTree = {
    file: 'Components', page: { id: '0:1', name: 'Page 1' }, warnings: [], stats: { count: 9, truncated: false },
    nodes: [{
      id: '1:1', name: 'Screen', type: 'FRAME', visible: true, opacity: 1, x: 0, y: 0, width: 400, height: 200,
      fills: [{ type: 'SOLID', color: '#FFFFFF', opacity: 1 }],
      layout: { mode: 'VERTICAL', itemSpacing: 16, padding: { top: 16, right: 16, bottom: 16, left: 16 } },
      children: [instance('I:1', 'Save', 0), instance('I:2', 'Cancel', 0), instance('I:3', 'Save', 0)],
    }],
  }
  const rendered = toJSX(componentTree, { componentAware: true })
  assert.equal(rendered.componentAware, true)
  assert.equal(rendered.componentCount, 2)
  assert.ok(rendered.files['components.jsx'])
  assert.match(rendered.files['App.jsx'], /import \{ Button, Button2 \} from '\.\/components\.jsx'/)
  assert.match(rendered.files['App.jsx'], /<Button \/>/)
  assert.match(rendered.files['App.jsx'], /<Button2 \/>/)
  assert.match(rendered.files['components.jsx'], /export function Button/)
  assert.match(rendered.files['components.jsx'], /export function Button2/)
  const expanded = toJSX(componentTree, { componentAware: false })
  assert.equal(expanded.componentAware, false)
  assert.equal(expanded.files['components.jsx'], undefined)
  assert.doesNotMatch(expanded.files['App.jsx'], /import \{/)
})

test('variant instances of one component set become React props and a wrapper component', () => {
  const variant = (id, props, fill, x) => ({
    id, name: `Button ${props}`, type: 'INSTANCE', visible: true, opacity: 1, x, y: 0, width: 120, height: 44,
    component: { id: `C:${props}`, name: props, componentSetId: 'CS:1', componentSetName: 'Button / Variants' },
    fills: [{ type: 'SOLID', color: fill, opacity: 1 }],
    layout: { mode: 'HORIZONTAL', itemSpacing: 8, padding: { top: 8, right: 12, bottom: 8, left: 12 } },
    children: [{
      id: `${id};label`, name: 'Label', type: 'TEXT', visible: true, opacity: 1, x: 0, y: 0, width: 80, height: 20,
      fills: [{ type: 'SOLID', color: '#0B1020', opacity: 1 }],
      text: { characters: 'Save', font: { family: 'Inter', style: 'Bold' }, fontSize: 16, lineHeight: { unit: 'PIXELS', value: 20 } },
    }],
  })
  const variantTree = {
    file: 'Variants', page: { id: '0:1', name: 'Page 1' }, warnings: [], stats: { count: 9, truncated: false },
    nodes: [{
      id: '1:1', name: 'Screen', type: 'FRAME', visible: true, opacity: 1, x: 0, y: 0, width: 400, height: 200,
      fills: [{ type: 'SOLID', color: '#FFFFFF', opacity: 1 }],
      children: [
        variant('I:1', 'Size=Large, State=Default', '#F97316', 0),
        variant('I:2', 'Size=Small, State=Default', '#EA580C', 0),
      ],
    }],
  }
  const rendered = toJSX(variantTree, { componentAware: true })
  assert.equal(rendered.componentCount, 2)
  assert.match(rendered.files['App.jsx'], /import \{ Button \} from '\.\/components\.jsx'/)
  assert.match(rendered.files['App.jsx'], /<Button size="Large" state="Default" \/>/)
  assert.match(rendered.files['App.jsx'], /<Button size="Small" state="Default" \/>/)
  assert.match(rendered.files['components.jsx'], /export function Button\(\{ size = "Large", state = "Default" \}\)/)
  assert.match(rendered.files['components.jsx'], /export function SizeLargeStateDefault/)
  assert.match(rendered.files['components.jsx'], /export function SizeSmallStateDefault/)
  assert.match(rendered.files['components.jsx'], /if \(size === "Large" && state === "Default"\) return <SizeLargeStateDefault \/>/)
})

test('toTokens emits W3C-ish tokens.json and CSS variables from Variables/styles', () => {
  const library = {
    file: 'Design System',
    variableCollections: [{ id: 'VC:1', name: 'Design Tokens', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Mode 1' }] }],
    variables: [
      { id: 'V:1', name: 'color/primary', resolvedType: 'COLOR', collectionId: 'VC:1', valuesByMode: { m1: '#F97316' }, description: '' },
      { id: 'V:2', name: 'space/16', resolvedType: 'FLOAT', collectionId: 'VC:1', valuesByMode: { m1: 16 }, description: '' },
      { id: 'V:3', name: 'opacity/disabled', resolvedType: 'FLOAT', collectionId: 'VC:1', valuesByMode: { m1: 0.4 }, description: '' },
    ],
    styles: {
      paint: [{ id: 'S:1', name: 'Brand / Primary', type: 'PAINT', paints: [{ type: 'SOLID', color: '#F97316', opacity: 1 }] }],
      text: [{ id: 'S:2', name: 'Heading / XL', type: 'TEXT', font: { family: 'Inter', style: 'Bold' }, fontSize: 48, lineHeight: { unit: 'PIXELS', value: 56 }, letterSpacing: { unit: 'PERCENT', value: 0 } }],
      effect: [],
      grid: [],
    },
  }
  const rendered = toTokens(library, { exportedAt: '2026-11-12T00:00:00.000Z' })
  const tokens = JSON.parse(rendered.files['tokens.json'])
  assert.equal(tokens.color.primary.$type, 'color')
  assert.equal(tokens.color.primary.$value, '#F97316')
  assert.equal(tokens.space['16'].$type, 'dimension')
  assert.equal(tokens.space['16'].$value, '16px')
  assert.equal(tokens.opacity.disabled.$type, 'number')
  assert.equal(tokens.opacity.disabled.$value, 0.4)
  assert.equal(tokens.typography.heading.xl.$value.fontWeight, 700)
  assert.equal(tokens.paint.brand.primary.$value, '#F97316')
  const css = rendered.files['tokens.css']
  assert.match(css, /--color-primary: #F97316;/)
  assert.match(css, /--space-16: 16px;/)
  assert.match(css, /\.text-heading-xl \{/)
  assert.match(rendered.files['tokens.js'], /export const tokens =/)
  assert.equal(rendered.counts.variables, 3)
})
