/**
 * lib/ops.js 单测（node:test + node:assert/strict）
 *
 * 覆盖 docs/V0.1-SPEC.md 第 5 节每条规则 + 复杂嵌套 create + dryRun 计划统计 +
 * 合法 ops 规范化透传（只保留 SPEC 2.1 / 2.2 允许的字段）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OP_TYPES,
  validateOps,
  summarizePlan,
  normalizeColor,
  normalizePadding,
  clonePatch,
} from '../lib/ops.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 断言校验通过，并返回规范化后的 ops。 */
function assertOk(ops) {
  const result = validateOps(ops);
  assert.equal(
    result.ok,
    true,
    `期望校验通过，实际错误：${JSON.stringify(result.errors)}`,
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.ops.length, ops.length);
  return result.ops;
}

/** 断言校验失败：错误结构合法、错误码在白名单内、message 命中所有正则。 */
function assertInvalid(ops, patterns = []) {
  const result = validateOps(ops);
  assert.equal(result.ok, false, '期望校验失败，实际通过');
  assert.ok(result.errors.length >= 1, '期望至少一条错误');
  for (const error of result.errors) {
    assert.equal(typeof error.opIndex, 'number');
    assert.ok(['invalid-op', 'unsupported'].includes(error.code), `非法错误码：${error.code}`);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
  }
  const text = result.errors.map((error) => error.message).join('\n');
  for (const pattern of patterns) assert.match(text, pattern);
  return result;
}

function closeTo(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    message ?? `期望 ${expected}，实际 ${actual}`,
  );
}

/** 深冻结，用于验证 validateOps 不修改入参。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

// ---------------------------------------------------------------------------
// OP_TYPES
// ---------------------------------------------------------------------------

test('OP_TYPES 与 SPEC 2.2 一致', () => {
  assert.deepEqual(OP_TYPES, [
    'create',
    'update',
    'move',
    'reorder',
    'clone',
    'group',
    'delete',
    'select',
  ]);
});

// ---------------------------------------------------------------------------
// normalizeColor
// ---------------------------------------------------------------------------

test('normalizeColor 支持 #RGB / #RRGGBB / #RRGGBBAA', () => {
  assert.deepEqual(normalizeColor('#FFF'), { r: 1, g: 1, b: 1, a: 1 });
  assert.deepEqual(normalizeColor('#fff'), { r: 1, g: 1, b: 1, a: 1 });

  const black = normalizeColor('#000000');
  assert.equal(black.r, 0);
  assert.equal(black.g, 0);
  assert.equal(black.b, 0);
  assert.equal(black.a, 1);

  const short = normalizeColor('#123');
  closeTo(short.r, 0x11 / 255);
  closeTo(short.g, 0x22 / 255);
  closeTo(short.b, 0x33 / 255);
  assert.equal(short.a, 1);

  const withAlpha = normalizeColor('#FF8800CC');
  assert.equal(withAlpha.r, 1);
  closeTo(withAlpha.g, 0x88 / 255);
  closeTo(withAlpha.b, 0x00 / 255);
  closeTo(withAlpha.a, 0xcc / 255);
});

test('normalizeColor：null 透传 null，非法返回 undefined', () => {
  assert.equal(normalizeColor(null), null);
  assert.equal(normalizeColor(undefined), undefined);
  assert.equal(normalizeColor(''), undefined);
  assert.equal(normalizeColor('red'), undefined);
  assert.equal(normalizeColor('ff8800'), undefined);
  assert.equal(normalizeColor('#ff'), undefined);
  assert.equal(normalizeColor('#ffff'), undefined);
  assert.equal(normalizeColor('#fffff'), undefined);
  assert.equal(normalizeColor('#GGGGGG'), undefined);
  assert.equal(normalizeColor('#fff '), undefined);
  assert.equal(normalizeColor(0xff8800), undefined);
  assert.equal(normalizeColor({ r: 1, g: 0, b: 0 }), undefined);
});

// ---------------------------------------------------------------------------
// normalizePadding
// ---------------------------------------------------------------------------

test('normalizePadding 支持数字与四边对象', () => {
  assert.deepEqual(normalizePadding(8), { top: 8, right: 8, bottom: 8, left: 8 });
  assert.deepEqual(normalizePadding(0), { top: 0, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(normalizePadding({ top: 1, right: 2, bottom: 3, left: 4 }), {
    top: 1,
    right: 2,
    bottom: 3,
    left: 4,
  });
  // 未知键丢弃
  assert.deepEqual(normalizePadding({ top: 1, right: 2, bottom: 3, left: 4, extra: 9 }), {
    top: 1,
    right: 2,
    bottom: 3,
    left: 4,
  });
});

test('normalizePadding：null/undefined/非法输入返回 null', () => {
  assert.equal(normalizePadding(null), null);
  assert.equal(normalizePadding(undefined), null);
  assert.equal(normalizePadding(-1), null);
  assert.equal(normalizePadding(NaN), null);
  assert.equal(normalizePadding('8'), null);
  assert.equal(normalizePadding([1, 2, 3, 4]), null);
  assert.equal(normalizePadding({ top: 1, right: 2, bottom: 3 }), null);
  assert.equal(normalizePadding({ top: 1, right: 2, bottom: 3, left: NaN }), null);
  assert.equal(normalizePadding({ top: 1, right: 2, bottom: 3, left: -4 }), null);
});

// ---------------------------------------------------------------------------
// clonePatch
// ---------------------------------------------------------------------------

test('clonePatch 深拷贝并剔除 undefined（对象与数组）', () => {
  const patch = {
    name: 'Card',
    fill: null,
    visible: false,
    nested: { a: 1, drop: undefined, deep: { b: 2, drop: undefined } },
    list: [1, undefined, { c: 3, drop: undefined }, undefined],
    drop: undefined,
  };

  const cloned = clonePatch(patch);

  assert.deepEqual(cloned, {
    name: 'Card',
    fill: null,
    visible: false,
    nested: { a: 1, deep: { b: 2 } },
    list: [1, { c: 3 }],
  });

  // 深拷贝：不与原对象共享引用
  assert.notEqual(cloned, patch);
  assert.notEqual(cloned.nested, patch.nested);
  assert.notEqual(cloned.list, patch.list);
  assert.notEqual(cloned.list[1], patch.list[2]);
});

test('clonePatch 对原始值原样返回', () => {
  assert.equal(clonePatch(undefined), undefined);
  assert.equal(clonePatch(null), null);
  assert.equal(clonePatch(0), 0);
  assert.equal(clonePatch('x'), 'x');
  assert.equal(clonePatch(false), false);
});

// ---------------------------------------------------------------------------
// validateOps：整体形状
// ---------------------------------------------------------------------------

test('validateOps([]) 合法且返回空数组', () => {
  const result = validateOps([]);
  assert.deepEqual(result, { ok: true, errors: [], ops: [] });
});

test('validateOps：ops 不是数组时报错（opIndex -1）', () => {
  for (const bad of [null, undefined, {}, 'ops', 42]) {
    const result = validateOps(bad);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].opIndex, -1);
    assert.equal(result.errors[0].code, 'invalid-op');
    assert.match(result.errors[0].message, /数组/);
    assert.deepEqual(result.ops, []);
  }
});

test('validateOps：op 不是对象时报错', () => {
  for (const bad of [null, 42, 'create', [], true]) {
    const result = assertInvalid([bad]);
    assert.equal(result.errors[0].opIndex, 0);
    assert.match(result.errors[0].message, /必须是对象/);
  }
});

test('未知 op 报 invalid-op', () => {
  assertInvalid([{ op: 'explode', nodeId: '1:2' }], [/未知 op/]);
  assertInvalid([{ op: 'Create', type: 'frame' }], [/未知 op/]);
  assertInvalid([{}], [/未知 op/]);
});

// ---------------------------------------------------------------------------
// validateOps：复杂嵌套 create + 合法 ops 规范化透传
// ---------------------------------------------------------------------------

test('复杂嵌套 create + 各类 op：合法时规范化透传（只保留允许字段）', () => {
  const input = [
    {
      op: 'create',
      type: 'frame',
      parentId: '0:1',
      name: 'Card',
      x: 10,
      y: 20,
      width: 320,
      height: 200,
      fill: '#FF8800',
      stroke: '#FFF',
      strokeWidth: 1,
      radius: [8, 8, 8, 8],
      opacity: 0.9,
      visible: true,
      locked: false,
      rotation: 0,
      layout: {
        mode: 'VERTICAL',
        itemSpacing: 12,
        padding: { top: 16, right: 16, bottom: 16, left: 16 },
        primaryAxisAlign: 'MIN',
        counterAxisAlign: 'CENTER',
        wrap: 'NO_WRAP',
        sizing: 'FILL', // SPEC 2.1 未列出 -> 丢弃
      },
      effects: [
        {
          type: 'DROP_SHADOW',
          color: '#00000033',
          offset: { x: 0, y: 4 },
          radius: 12,
          spread: 0,
          visible: true,
          blendMode: 'NORMAL', // 未列出 -> 丢弃
        },
      ],
      label: 'card', // op 级 label 允许但不下发
      unknownField: 'drop me', // 未知字段 -> 丢弃
      children: [
        {
          op: 'create',
          type: 'text',
          name: 'Title',
          width: 100,
          height: 24,
          text: {
            characters: 'Hello',
            font: { family: 'Inter', style: 'Regular', weight: 400 },
            fontSize: 16,
            align: 'LEFT',
            lineHeight: { unit: 'PIXELS', value: 20 },
            letterSpacing: 0,
            textAutoResize: 'WIDTH_AND_HEIGHT',
            fontWeight: 600, // 未列出 -> 丢弃
          },
          bogus: 1,
        },
      ],
    },
    {
      op: 'update',
      nodeId: '1:2',
      patch: { name: 'New', fill: '#000000', opacity: 1, layout: null, unknownPatch: true },
      label: 'update card',
    },
    { op: 'move', nodeId: '1:2', parentId: '0:1', index: 2, junk: 1 },
    { op: 'reorder', nodeId: '1:2', index: 0 },
    { op: 'clone', nodeId: '1:2', parentId: '0:1', x: 400, y: 0, deep: false },
    { op: 'group', nodeIds: ['1:2', '1:3'], name: 'Group', extra: 1 },
    { op: 'delete', nodeId: '1:4' },
    { op: 'select', nodeIds: ['1:2'] },
  ];

  const normalized = assertOk(input);

  assert.deepEqual(normalized, [
    {
      op: 'create',
      type: 'frame',
      parentId: '0:1',
      name: 'Card',
      x: 10,
      y: 20,
      width: 320,
      height: 200,
      fill: '#FF8800',
      stroke: '#FFF',
      strokeWidth: 1,
      radius: [8, 8, 8, 8],
      opacity: 0.9,
      visible: true,
      locked: false,
      rotation: 0,
      layout: {
        mode: 'VERTICAL',
        itemSpacing: 12,
        padding: { top: 16, right: 16, bottom: 16, left: 16 },
        primaryAxisAlign: 'MIN',
        counterAxisAlign: 'CENTER',
        wrap: 'NO_WRAP',
      },
      effects: [
        {
          type: 'DROP_SHADOW',
          color: '#00000033',
          offset: { x: 0, y: 4 },
          radius: 12,
          spread: 0,
          visible: true,
        },
      ],
      children: [
        {
          op: 'create',
          type: 'text',
          name: 'Title',
          width: 100,
          height: 24,
          text: {
            characters: 'Hello',
            font: { family: 'Inter', style: 'Regular' },
            fontSize: 16,
            align: 'LEFT',
            lineHeight: { unit: 'PIXELS', value: 20 },
            letterSpacing: 0,
            textAutoResize: 'WIDTH_AND_HEIGHT',
          },
        },
      ],
    },
    {
      op: 'update',
      nodeId: '1:2',
      patch: { name: 'New', fill: '#000000', opacity: 1, layout: null },
    },
    { op: 'move', nodeId: '1:2', parentId: '0:1', index: 2 },
    { op: 'reorder', nodeId: '1:2', index: 0 },
    { op: 'clone', nodeId: '1:2', parentId: '0:1', x: 400, y: 0, deep: false },
    { op: 'group', nodeIds: ['1:2', '1:3'], name: 'Group' },
    { op: 'delete', nodeId: '1:4' },
    { op: 'select', nodeIds: ['1:2'] },
  ]);

  // label 不下发；规范化结果是新对象（不共享引用）
  assert.equal('label' in normalized[0], false);
  assert.notEqual(normalized[0], input[0]);
  assert.notEqual(normalized[0].radius, input[0].radius);
  assert.notEqual(normalized[1].patch, input[1].patch);
});

test('validateOps 不修改入参（入参可被深冻结）', () => {
  const input = deepFreeze([
    {
      op: 'create',
      type: 'frame',
      width: 100,
      height: 100,
      radius: [1, 2, 3, 4],
      children: [{ op: 'create', type: 'rect', width: 10, height: 10 }],
      label: 'frozen',
    },
    { op: 'select', nodeIds: ['1:2'] },
  ]);

  assert.doesNotThrow(() => validateOps(input));
  const normalized = assertOk(input);
  // 同一输入重复校验结果稳定
  assert.deepEqual(validateOps(input).ops, normalized);
});

test('create 可以没有 children 字段', () => {
  const [op] = assertOk([{ op: 'create', type: 'rect' }]);
  assert.deepEqual(op, { op: 'create', type: 'rect' });
  assert.equal('children' in op, false);
});

test('create children: [] 保留为空数组', () => {
  const [op] = assertOk([{ op: 'create', type: 'frame', children: [] }]);
  assert.deepEqual(op.children, []);
});

// ---------------------------------------------------------------------------
// validateOps：create 规则
// ---------------------------------------------------------------------------

test('create 必须提供合法 type（SPEC 5）', () => {
  assertInvalid([{ op: 'create' }], [/ops\[0\]\.type/, /type/]);
  assertInvalid([{ op: 'create', type: 'image' }], [/ops\[0\]\.type/]);
  assertInvalid([{ op: 'create', type: 123 }], [/ops\[0\]\.type/]);
  assertInvalid([{ op: 'create', type: 'FRAME' }], [/ops\[0\]\.type/]);
});

test('create 的 parentId / children 结构校验', () => {
  assertInvalid([{ op: 'create', type: 'frame', parentId: 123 }], [
    /ops\[0\]\.parentId/,
  ]);
  assertInvalid([{ op: 'create', type: 'frame', children: 'nope' }], [
    /ops\[0\]\.children/,
  ]);
  assertInvalid([{ op: 'create', type: 'frame', children: [null] }], [
    /ops\[0\]\.children\[0\]/,
  ]);
  // children 只允许 create op
  assertInvalid(
    [
      {
        op: 'create',
        type: 'frame',
        children: [{ op: 'update', nodeId: '1:2', patch: {} }],
      },
    ],
    [/ops\[0\]\.children\[0\]\.op/, /children 只允许 create op/],
  );
});

test('嵌套 children 递归校验：错误 opIndex 用顶层索引，message 带子路径', () => {
  const result = assertInvalid(
    [
      {
        op: 'create',
        type: 'frame',
        children: [
          { op: 'create', type: 'text' },
          { op: 'create', type: 'rect', width: -1 },
        ],
      },
    ],
    [/ops\[0\]\.children\[1\]\.width/],
  );

  // 错误 opIndex 是顶层 op 的索引
  assert.ok(result.errors.every((error) => error.opIndex === 0));
  // 整棵 create 子树因错误被丢弃
  assert.deepEqual(result.ops, []);
});

test('嵌套三层 create 合法且逐层保留', () => {
  const [root] = assertOk([
    {
      op: 'create',
      type: 'frame',
      name: 'Page',
      children: [
        {
          op: 'create',
          type: 'frame',
          name: 'Section',
          children: [{ op: 'create', type: 'text', text: { characters: 'Hi' } }],
        },
      ],
    },
  ]);

  assert.equal(root.children[0].name, 'Section');
  assert.equal(root.children[0].children[0].text.characters, 'Hi');
});

// ---------------------------------------------------------------------------
// validateOps：update / move / reorder / clone / group / delete / select
// ---------------------------------------------------------------------------

test('update 必须提供 nodeId 与 patch 对象（SPEC 5）', () => {
  assertInvalid([{ op: 'update', patch: {} }], [/ops\[0\]\.nodeId/, /nodeId/]);
  assertInvalid([{ op: 'update', nodeId: '', patch: {} }], [/ops\[0\]\.nodeId/]);
  assertInvalid([{ op: 'update', nodeId: 123, patch: {} }], [/ops\[0\]\.nodeId/]);
  assertInvalid([{ op: 'update', nodeId: '1:2' }], [/ops\[0\]\.patch/]);
  assertInvalid([{ op: 'update', nodeId: '1:2', patch: null }], [/ops\[0\]\.patch/]);
  assertInvalid([{ op: 'update', nodeId: '1:2', patch: [] }], [/ops\[0\]\.patch/]);
});

test('update 的 patch 走 SPEC 2.1 白名单，未知字段丢弃', () => {
  const [op] = assertOk([
    {
      op: 'update',
      nodeId: '1:2',
      patch: { name: 'x', fill: null, children: [], parentId: '0:1', label: 'nope' },
    },
  ]);
  assert.deepEqual(op, { op: 'update', nodeId: '1:2', patch: { name: 'x', fill: null } });
});

test('move 需要 nodeId + parentId，index 可选非负整数', () => {
  assertInvalid([{ op: 'move', parentId: '0:1' }], [/ops\[0\]\.nodeId/]);
  assertInvalid([{ op: 'move', nodeId: '1:2' }], [/ops\[0\]\.parentId/]);
  assertInvalid([{ op: 'move', nodeId: '1:2', parentId: '0:1', index: -1 }], [
    /ops\[0\]\.index/,
  ]);
  assertInvalid([{ op: 'move', nodeId: '1:2', parentId: '0:1', index: 1.5 }], [
    /ops\[0\]\.index/,
  ]);
  assertInvalid([{ op: 'move', nodeId: '1:2', parentId: '0:1', index: '0' }], [
    /ops\[0\]\.index/,
  ]);
  assert.deepEqual(assertOk([{ op: 'move', nodeId: '1:2', parentId: '0:1', index: 0 }]), [
    { op: 'move', nodeId: '1:2', parentId: '0:1', index: 0 },
  ]);
});

test('reorder 需要 nodeId + 非负整数 index', () => {
  assertInvalid([{ op: 'reorder', index: 0 }], [/ops\[0\]\.nodeId/]);
  assertInvalid([{ op: 'reorder', nodeId: '1:2' }], [/ops\[0\]\.index/]);
  assertInvalid([{ op: 'reorder', nodeId: '1:2', index: -1 }], [/ops\[0\]\.index/]);
  assertInvalid([{ op: 'reorder', nodeId: '1:2', index: 2.5 }], [/ops\[0\]\.index/]);
  assert.deepEqual(assertOk([{ op: 'reorder', nodeId: '1:2', index: 0 }]), [
    { op: 'reorder', nodeId: '1:2', index: 0 },
  ]);
});

test('clone 需要 nodeId，可选 parentId/x/y/deep', () => {
  assertInvalid([{ op: 'clone' }], [/ops\[0\]\.nodeId/]);
  assertInvalid([{ op: 'clone', nodeId: '1:2', deep: 'yes' }], [/ops\[0\]\.deep/]);
  assertInvalid([{ op: 'clone', nodeId: '1:2', x: '10' }], [/ops\[0\]\.x/]);
  assertInvalid([{ op: 'clone', nodeId: '1:2', y: null }], [/ops\[0\]\.y/]);
  assert.deepEqual(assertOk([{ op: 'clone', nodeId: '1:2' }]), [
    { op: 'clone', nodeId: '1:2' },
  ]);
  assert.deepEqual(
    assertOk([{ op: 'clone', nodeId: '1:2', x: 0, y: 10, deep: true, junk: 1 }]),
    [{ op: 'clone', nodeId: '1:2', x: 0, y: 10, deep: true }],
  );
});

test('group 需要至少 1 个 nodeId 的字符串数组', () => {
  assertInvalid([{ op: 'group' }], [/ops\[0\]\.nodeIds/]);
  assertInvalid([{ op: 'group', nodeIds: '1:2' }], [/ops\[0\]\.nodeIds/]);
  assertInvalid([{ op: 'group', nodeIds: [] }], [/至少需要 1 个节点/]);
  assertInvalid([{ op: 'group', nodeIds: ['1:2', 3] }], [/nodeIds/]);
  assertInvalid([{ op: 'group', nodeIds: ['1:2'], name: 9 }], [/ops\[0\]\.name/]);
  assert.deepEqual(assertOk([{ op: 'group', nodeIds: ['1:2', '1:3'], name: 'G' }]), [
    { op: 'group', nodeIds: ['1:2', '1:3'], name: 'G' },
  ]);
});

test('delete 需要 nodeId', () => {
  assertInvalid([{ op: 'delete' }], [/ops\[0\]\.nodeId/]);
  assertInvalid([{ op: 'delete', nodeId: '' }], [/ops\[0\]\.nodeId/]);
  assertInvalid([{ op: 'delete', nodeId: 42 }], [/ops\[0\]\.nodeId/]);
  assert.deepEqual(assertOk([{ op: 'delete', nodeId: '1:2' }]), [
    { op: 'delete', nodeId: '1:2' },
  ]);
});

test('select 需要 nodeIds 字符串数组（空数组合法 = 清空选区）', () => {
  assertInvalid([{ op: 'select' }], [/ops\[0\]\.nodeIds/]);
  assertInvalid([{ op: 'select', nodeIds: '1:2' }], [/ops\[0\]\.nodeIds/]);
  assertInvalid([{ op: 'select', nodeIds: ['1:2', null] }], [/nodeIds/]);
  assert.deepEqual(assertOk([{ op: 'select', nodeIds: [] }]), [
    { op: 'select', nodeIds: [] },
  ]);
  assert.deepEqual(assertOk([{ op: 'select', nodeIds: ['1:2'] }]), [
    { op: 'select', nodeIds: ['1:2'] },
  ]);
});

// ---------------------------------------------------------------------------
// validateOps：数值 / 颜色 / 圆角规则（SPEC 5）
// ---------------------------------------------------------------------------

test('width/height 必须 >= 1', () => {
  assertInvalid([{ op: 'create', type: 'rect', width: 0 }], [/ops\[0\]\.width/]);
  assertInvalid([{ op: 'create', type: 'rect', width: -10 }], [/ops\[0\]\.width/]);
  assertInvalid([{ op: 'create', type: 'rect', width: '100' }], [/ops\[0\]\.width/]);
  assertInvalid([{ op: 'create', type: 'rect', height: 0 }], [/ops\[0\]\.height/]);
  assertInvalid([{ op: 'create', type: 'rect', height: NaN }], [/ops\[0\]\.height/]);
  assertInvalid([{ op: 'create', type: 'rect', width: 0.5, height: 1 }], [/ops\[0\]\.width/]);
  // 1 合法
  assert.deepEqual(assertOk([{ op: 'create', type: 'rect', width: 1, height: 1 }])[0], {
    op: 'create',
    type: 'rect',
    width: 1,
    height: 1,
  });
});

test('opacity 限定 0..1；strokeWidth >= 0；rotation 为数字', () => {
  assertInvalid([{ op: 'create', type: 'rect', opacity: 1.1 }], [/ops\[0\]\.opacity/]);
  assertInvalid([{ op: 'create', type: 'rect', opacity: -0.1 }], [/ops\[0\]\.opacity/]);
  assertInvalid([{ op: 'create', type: 'rect', opacity: '0.5' }], [/ops\[0\]\.opacity/]);
  assert.deepEqual(assertOk([{ op: 'create', type: 'rect', opacity: 0 }])[0].opacity, 0);
  assert.deepEqual(assertOk([{ op: 'create', type: 'rect', opacity: 1 }])[0].opacity, 1);

  assertInvalid([{ op: 'create', type: 'rect', strokeWidth: -1 }], [/ops\[0\]\.strokeWidth/]);
  assert.deepEqual(assertOk([{ op: 'create', type: 'rect', strokeWidth: 0 }])[0].strokeWidth, 0);

  assertInvalid([{ op: 'create', type: 'rect', rotation: '45' }], [/ops\[0\]\.rotation/]);
  assert.deepEqual(assertOk([{ op: 'create', type: 'rect', rotation: -45 }])[0].rotation, -45);
});

test('radius 只接受非负数字或长度 4 的数组（SPEC 5）', () => {
  assertInvalid([{ op: 'create', type: 'rect', radius: [8, 8, 8] }], [
    /ops\[0\]\.radius/,
    /长度 4/,
  ]);
  assertInvalid([{ op: 'create', type: 'rect', radius: [1, 2, 3, 4, 5] }], [
    /ops\[0\]\.radius/,
  ]);
  assertInvalid([{ op: 'create', type: 'rect', radius: [-1, 2, 3, 4] }], [
    /ops\[0\]\.radius/,
  ]);
  assertInvalid([{ op: 'create', type: 'rect', radius: '8' }], [/ops\[0\]\.radius/]);
  assert.deepEqual(assertOk([{ op: 'create', type: 'rect', radius: 0 }])[0].radius, 0);
  assert.deepEqual(assertOk([{ op: 'create', type: 'rect', radius: [1, 2, 3, 4] }])[0].radius, [
    1, 2, 3, 4,
  ]);
});

test('颜色非法报 invalid-op；null 合法（SPEC 5）', () => {
  assertInvalid([{ op: 'create', type: 'rect', fill: 'red' }], [
    /ops\[0\]\.fill/,
    /#RGB/,
  ]);
  assertInvalid([{ op: 'create', type: 'rect', fill: '#12345' }], [/ops\[0\]\.fill/]);
  assertInvalid([{ op: 'create', type: 'rect', stroke: 123 }], [/ops\[0\]\.stroke/]);
  assertInvalid([{ op: 'update', nodeId: '1:2', patch: { fill: 'blue' } }], [
    /ops\[0\]\.patch\.fill/,
  ]);

  const [op] = assertOk([
    { op: 'create', type: 'rect', fill: null, stroke: '#FFF', strokeWidth: 1 },
  ]);
  assert.equal(op.fill, null);
  assert.equal(op.stroke, '#FFF');
});

// ---------------------------------------------------------------------------
// validateOps：layout
// ---------------------------------------------------------------------------

test('layout：null 合法；对象必须是 HORIZONTAL/VERTICAL（SPEC 5）', () => {
  assert.deepEqual(assertOk([{ op: 'create', type: 'frame', layout: null }])[0].layout, null);

  assertInvalid([{ op: 'create', type: 'frame', layout: { mode: 'NONE' } }], [
    /ops\[0\]\.layout\.mode/,
  ]);
  assertInvalid([{ op: 'create', type: 'frame', layout: {} }], [
    /ops\[0\]\.layout\.mode/,
  ]);
  assertInvalid([{ op: 'create', type: 'frame', layout: 'VERTICAL' }], [
    /ops\[0\]\.layout/,
  ]);
});

test('layout 子字段校验', () => {
  assertInvalid([{ op: 'create', type: 'frame', layout: { mode: 'VERTICAL', itemSpacing: '8' } }], [
    /ops\[0\]\.layout\.itemSpacing/,
  ]);
  assertInvalid([{ op: 'create', type: 'frame', layout: { mode: 'VERTICAL', padding: -1 } }], [
    /ops\[0\]\.layout\.padding/,
  ]);
  assertInvalid(
    [{ op: 'create', type: 'frame', layout: { mode: 'VERTICAL', padding: { top: 1 } } }],
    [/ops\[0\]\.layout\.padding/],
  );
  assertInvalid(
    [
      {
        op: 'create',
        type: 'frame',
        layout: { mode: 'VERTICAL', primaryAxisAlign: 'TOP' },
      },
    ],
    [/ops\[0\]\.layout\.primaryAxisAlign/],
  );
  assertInvalid(
    [
      {
        op: 'create',
        type: 'frame',
        layout: { mode: 'VERTICAL', counterAxisAlign: 'SPACE_BETWEEN' },
      },
    ],
    [/ops\[0\]\.layout\.counterAxisAlign/],
  );
  assertInvalid(
    [{ op: 'create', type: 'frame', layout: { mode: 'HORIZONTAL', wrap: 'NOWRAP' } }],
    [/ops\[0\]\.layout\.wrap/],
  );
});

test('layout 合法值规范化（padding 数字保留、对象转四边、未知字段丢弃）', () => {
  const [withNumber] = assertOk([
    {
      op: 'create',
      type: 'frame',
      layout: { mode: 'HORIZONTAL', padding: 8, sizing: 'FILL' },
    },
  ]);
  assert.deepEqual(withNumber.layout, { mode: 'HORIZONTAL', padding: 8 });

  const [full] = assertOk([
    {
      op: 'create',
      type: 'frame',
      layout: {
        mode: 'VERTICAL',
        itemSpacing: 12,
        padding: { top: 1, right: 2, bottom: 3, left: 4, extra: 9 },
        primaryAxisAlign: 'SPACE_BETWEEN',
        counterAxisAlign: 'MAX',
        wrap: 'WRAP',
      },
    },
  ]);
  assert.deepEqual(full.layout, {
    mode: 'VERTICAL',
    itemSpacing: 12,
    padding: { top: 1, right: 2, bottom: 3, left: 4 },
    primaryAxisAlign: 'SPACE_BETWEEN',
    counterAxisAlign: 'MAX',
    wrap: 'WRAP',
  });
});

// ---------------------------------------------------------------------------
// validateOps：text
// ---------------------------------------------------------------------------

test('text：characters 必须是字符串；font 需 family/style 字符串', () => {
  assertInvalid([{ op: 'create', type: 'text', text: { characters: 123 } }], [
    /ops\[0\]\.text\.characters/,
  ]);
  assertInvalid([{ op: 'create', type: 'text', text: 'hello' }], [/ops\[0\]\.text/]);
  assertInvalid([{ op: 'create', type: 'text', text: { font: { family: 'Inter' } } }], [
    /ops\[0\]\.text\.font/,
  ]);
  assertInvalid([{ op: 'create', type: 'text', text: { font: { family: '', style: 'Regular' } } }], [
    /ops\[0\]\.text\.font/,
  ]);
  assertInvalid([{ op: 'create', type: 'text', text: { font: 'Inter' } }], [
    /ops\[0\]\.text\.font/,
  ]);
});

test('text：fontSize / align / lineHeight / letterSpacing / textAutoResize', () => {
  assertInvalid([{ op: 'create', type: 'text', text: { fontSize: 0 } }], [
    /ops\[0\]\.text\.fontSize/,
  ]);
  assertInvalid([{ op: 'create', type: 'text', text: { fontSize: -2 } }], [
    /ops\[0\]\.text\.fontSize/,
  ]);
  assertInvalid([{ op: 'create', type: 'text', text: { align: 'BOTTOM' } }], [
    /ops\[0\]\.text\.align/,
  ]);
  assertInvalid([{ op: 'create', type: 'text', text: { lineHeight: '20px' } }], [
    /ops\[0\]\.text\.lineHeight/,
  ]);
  assertInvalid(
    [{ op: 'create', type: 'text', text: { lineHeight: { unit: 'PX', value: 20 } } }],
    [/ops\[0\]\.text\.lineHeight/],
  );
  assertInvalid(
    [{ op: 'create', type: 'text', text: { letterSpacing: { unit: 'PIXELS' } } }],
    [/ops\[0\]\.text\.letterSpacing/],
  );
  assertInvalid([{ op: 'create', type: 'text', text: { textAutoResize: 'FIT' } }], [
    /ops\[0\]\.text\.textAutoResize/,
  ]);
});

test('text 合法值规范化：font/未知字段处理，字体度量支持 number 与 {unit,value}', () => {
  const [op] = assertOk([
    {
      op: 'create',
      type: 'text',
      text: {
        characters: 'Hi',
        font: { family: 'Inter', style: 'Bold', weight: 700 },
        fontSize: 18,
        align: 'CENTER',
        lineHeight: 24,
        letterSpacing: { unit: 'PERCENT', value: 2 },
        textAutoResize: 'HEIGHT',
        fontWeight: 700,
      },
    },
  ]);

  assert.deepEqual(op.text, {
    characters: 'Hi',
    font: { family: 'Inter', style: 'Bold' },
    fontSize: 18,
    align: 'CENTER',
    lineHeight: 24,
    letterSpacing: { unit: 'PERCENT', value: 2 },
    textAutoResize: 'HEIGHT',
  });
});

test('update.patch 的 text 可只含 fontSize（characters 可选）', () => {
  const [op] = assertOk([
    { op: 'update', nodeId: '1:2', patch: { text: { fontSize: 20, align: 'LEFT' } } },
  ]);
  assert.deepEqual(op.patch, { text: { fontSize: 20, align: 'LEFT' } });
});

// ---------------------------------------------------------------------------
// validateOps：effects
// ---------------------------------------------------------------------------

test('effects：必须是数组，每项 type 枚举 + 可选字段校验', () => {
  assertInvalid([{ op: 'create', type: 'rect', effects: {} }], [/ops\[0\]\.effects/]);
  assertInvalid([{ op: 'create', type: 'rect', effects: [null] }], [
    /ops\[0\]\.effects\[0\]/,
  ]);
  assertInvalid([{ op: 'create', type: 'rect', effects: [{ type: 'GLOW' }] }], [
    /ops\[0\]\.effects\[0\]\.type/,
  ]);
  assertInvalid(
    [{ op: 'create', type: 'rect', effects: [{ type: 'DROP_SHADOW', color: 'black' }] }],
    [/ops\[0\]\.effects\[0\]\.color/],
  );
  assertInvalid(
    [
      {
        op: 'create',
        type: 'rect',
        effects: [{ type: 'DROP_SHADOW', offset: { x: 0 } }],
      },
    ],
    [/ops\[0\]\.effects\[0\]\.offset/],
  );
  assertInvalid(
    [{ op: 'create', type: 'rect', effects: [{ type: 'LAYER_BLUR', radius: '12' }] }],
    [/ops\[0\]\.effects\[0\]\.radius/],
  );
  assertInvalid(
    [{ op: 'create', type: 'rect', effects: [{ type: 'LAYER_BLUR', visible: 1 }] }],
    [/ops\[0\]\.effects\[0\]\.visible/],
  );
});

test('effects 合法值规范化（未知字段丢弃）', () => {
  const [op] = assertOk([
    {
      op: 'create',
      type: 'rect',
      effects: [
        {
          type: 'DROP_SHADOW',
          color: '#00000080',
          offset: { x: 0, y: 2, z: 9 },
          radius: 8,
          spread: 1,
          visible: true,
          blendMode: 'NORMAL',
        },
        { type: 'INNER_SHADOW' },
      ],
    },
  ]);
  assert.deepEqual(op.effects, [
    {
      type: 'DROP_SHADOW',
      color: '#00000080',
      offset: { x: 0, y: 2 },
      radius: 8,
      spread: 1,
      visible: true,
    },
    { type: 'INNER_SHADOW' },
  ]);
});

// ---------------------------------------------------------------------------
// validateOps：错误码与部分失败
// ---------------------------------------------------------------------------

test('所有错误码只使用 invalid-op / unsupported', () => {
  const invalidCases = [
    [{ op: 'nope' }],
    [{ op: 'create' }],
    [{ op: 'create', type: 'rect', width: -1, fill: 'bad' }],
    [{ op: 'update', nodeId: '1:2', patch: { radius: [1, 2, 3] } }],
    [{ op: 'group', nodeIds: [] }],
    [{ op: 'reorder', nodeId: '1:2', index: -1 }],
  ];
  for (const ops of invalidCases) {
    const result = validateOps(ops);
    assert.equal(result.ok, false);
    for (const error of result.errors) {
      assert.ok(['invalid-op', 'unsupported'].includes(error.code));
    }
  }
});

test('部分失败：errors 带对应 opIndex，规范化 ops 只含通过校验的 op', () => {
  const result = validateOps([
    { op: 'create', type: 'rect', width: 10, height: 10 },
    { op: 'update', nodeId: '1:2', patch: { fill: 'bad-color' } },
    { op: 'delete', nodeId: '1:3' },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].opIndex, 1);
  assert.match(result.errors[0].message, /ops\[1\]\.patch\.fill/);

  // 只保留校验通过的第 0、2 条
  assert.deepEqual(result.ops, [
    { op: 'create', type: 'rect', width: 10, height: 10 },
    { op: 'delete', nodeId: '1:3' },
  ]);
});

test('一条 op 内可同时报告多个字段错误', () => {
  const result = assertInvalid(
    [{ op: 'create', type: 'rect', width: 0, height: -1, fill: 'red' }],
    [/ops\[0\]\.width/, /ops\[0\]\.height/, /ops\[0\]\.fill/],
  );
  assert.ok(result.errors.length >= 3);
});

// ---------------------------------------------------------------------------
// summarizePlan（dryRun 计划统计）
// ---------------------------------------------------------------------------

test('summarizePlan：dryRun 计划统计（create 嵌套子节点计入 description）', () => {
  const ops = [
    {
      op: 'create',
      type: 'frame',
      name: 'Page',
      children: [
        { op: 'create', type: 'text', name: 'Title' },
        { op: 'create', type: 'rect', children: [{ op: 'create', type: 'ellipse' }] },
      ],
    },
    { op: 'create', type: 'rect', name: 'Card' },
    { op: 'update', nodeId: '1:2', patch: { fill: '#FFFFFF', name: 'New' } },
    { op: 'move', nodeId: '1:2', parentId: '0:1', index: 2 },
    { op: 'reorder', nodeId: '1:2', index: 0 },
    { op: 'clone', nodeId: '1:2' },
    { op: 'group', nodeIds: ['1:2', '1:3'], name: 'G' },
    { op: 'delete', nodeId: '1:4' },
    { op: 'select', nodeIds: ['1:2', '1:3'] },
  ];

  const plan = summarizePlan(ops);

  assert.equal(plan.willCreate, 2);
  assert.equal(plan.willUpdate, 1);
  assert.equal(plan.willDelete, 1);
  assert.equal(plan.willGroup, 1);
  assert.equal(plan.ops.length, ops.length);
  assert.deepEqual(
    plan.ops.map((entry) => entry.op),
    ['create', 'create', 'update', 'move', 'reorder', 'clone', 'group', 'delete', 'select'],
  );
  assert.deepEqual(
    plan.ops.map((entry) => entry.opIndex),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );

  // create：名字 + 子孙节点数（text 1 + rect 1 + ellipse 1 = 3）
  assert.match(plan.ops[0].description, /创建 frame「Page」/);
  assert.match(plan.ops[0].description, /含 3 个子节点/);
  assert.match(plan.ops[1].description, /创建 rect「Card」/);

  assert.match(plan.ops[2].description, /更新节点 1:2/);
  assert.match(plan.ops[2].description, /fill/);
  assert.match(plan.ops[2].description, /name/);

  assert.match(plan.ops[3].description, /移动节点 1:2/);
  assert.match(plan.ops[3].description, /索引 2/);
  assert.match(plan.ops[4].description, /排序/);
  assert.match(plan.ops[5].description, /深拷贝/);
  assert.match(plan.ops[6].description, /编组 2 个节点/);
  assert.match(plan.ops[6].description, /「G」/);
  assert.match(plan.ops[7].description, /删除节点 1:4/);
  assert.match(plan.ops[8].description, /选中 2 个节点/);
});

test('summarizePlan：克隆浅拷贝 / 清空选区 / 未知 op / 非数组', () => {
  const plan = summarizePlan([
    { op: 'clone', nodeId: '1:2', deep: false },
    { op: 'select', nodeIds: [] },
    { op: 'nope' },
  ]);
  assert.equal(plan.willCreate, 0);
  assert.equal(plan.willUpdate, 0);
  assert.equal(plan.willDelete, 0);
  assert.equal(plan.willGroup, 0);
  assert.match(plan.ops[0].description, /浅拷贝/);
  assert.match(plan.ops[1].description, /清空选区/);
  assert.equal(plan.ops[2].op, 'unknown');
  assert.match(plan.ops[2].description, /未知 op/);

  assert.deepEqual(summarizePlan(null), {
    willCreate: 0,
    willUpdate: 0,
    willDelete: 0,
    willGroup: 0,
    ops: [],
  });
  assert.deepEqual(summarizePlan(undefined), {
    willCreate: 0,
    willUpdate: 0,
    willDelete: 0,
    willGroup: 0,
    ops: [],
  });
});

test('summarizePlan 可直接消费 validateOps 的规范化结果', () => {
  const normalized = assertOk([
    { op: 'create', type: 'frame', children: [{ op: 'create', type: 'text' }] },
    { op: 'delete', nodeId: '1:9' },
  ]);
  const plan = summarizePlan(normalized);
  assert.equal(plan.willCreate, 1);
  assert.equal(plan.willDelete, 1);
  assert.equal(plan.ops.length, 2);
});
