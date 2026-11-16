/**
 * DSH-Figma-Designer · Ops DSL v1（Host 侧校验器）
 *
 * 契约：`docs/V0.1-SPEC.md` 第 2 节（Ops DSL）与第 5 节（Host 侧 ops 校验）。
 *
 * 约束：
 *   - 纯 ESM、零 import、不使用任何 Node / DOM API，Node 与浏览器均可直接 import；
 *   - 只做「校验 + 白名单规范化」，不解析节点引用、不产生节点、不转 Figma 对象；
 *   - 不修改入参（可对入参 Object.freeze）；
 *   - 颜色保留原始十六进制字符串（SPEC 2.1：Host 只做校验，插件侧再转 Figma 颜色对象）；
 *   - 未知字段静默丢弃（不报错）；op 上的 `label` 允许但不下发；
 *   - 错误码只用 `invalid-op` / `unsupported`（当前实现只会产生 `invalid-op`）。
 *
 * 主要导出：
 *   - OP_TYPES                     合法的 op 名称
 *   - validateOps(ops)             -> { ok, errors, ops(normalizedOps) }
 *   - summarizePlan(ops)           -> dryRun 计划统计
 *   - normalizeColor(value)        -> { r, g, b, a } | null（非法 -> undefined）
 *   - normalizePadding(value)      -> { top, right, bottom, left } | null（非法 -> null）
 *   - clonePatch(patch)            -> 深拷贝并剔除 undefined
 */

/** 合法的 op 名称（SPEC 2.2）。 */
export const OP_TYPES = ['create', 'update', 'move', 'reorder', 'clone', 'group', 'delete', 'select'];

/** create 支持的节点类型（SPEC 2.2）。 */
const CREATE_TYPES = ['frame', 'component', 'rect', 'ellipse', 'text', 'line', 'polygon', 'star', 'svg'];

/** SPEC 2.1 公共节点字段；create 直接使用，update.patch 共用同一白名单。 */
const COMMON_FIELDS = [
  'name',
  'x',
  'y',
  'width',
  'height',
  'fill',
  'stroke',
  'strokeWidth',
  'radius',
  'opacity',
  'visible',
  'locked',
  'rotation',
  'layout',
  'text',
  'svg',
  'effects',
];

const LAYOUT_MODES = ['HORIZONTAL', 'VERTICAL'];
const PRIMARY_AXIS_ALIGNS = ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'];
const COUNTER_AXIS_ALIGNS = ['MIN', 'CENTER', 'MAX'];
const WRAPS = ['NO_WRAP', 'WRAP'];
const TEXT_ALIGNS = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'];
const TEXT_AUTO_RESIZES = ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT'];
const METRIC_UNITS = ['PIXELS', 'PERCENT'];
const EFFECT_TYPES = ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'];

/** 嵌套 create 的最大层数（防御循环引用 / 过深输入）。 */
const MAX_NESTING_DEPTH = 32;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 是否为普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 是否为有限数字（排除 NaN / Infinity / 字符串数字）。 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * 记录一条校验错误。
 * 错误码统一为 invalid-op；SPEC 只允许 invalid-op / unsupported。
 */
function addError(errors, opIndex, path, message) {
  errors.push({
    opIndex,
    code: 'invalid-op',
    message: path ? `${path}: ${message}` : message,
  });
}

/** 字段校验失败：记录错误并返回统一结果。 */
function fieldError(errors, opIndex, path, message) {
  addError(errors, opIndex, path, message);
  return { ok: false, value: undefined };
}

/** 字段校验成功。 */
function fieldOk(value) {
  return { ok: true, value };
}

function describeOpKind(kind) {
  return typeof kind === 'string' ? kind : String(kind);
}

// ---------------------------------------------------------------------------
// 导出：颜色 / padding / patch 深拷贝
// ---------------------------------------------------------------------------

/**
 * 十六进制颜色 → Figma 颜色对象（通道 0..1 浮点，Figma Plugin API 约定）。
 *
 * 支持 "#RGB" / "#RRGGBB" / "#RRGGBBAA"（大小写不敏感）。
 *   - null  -> null（表示无填充，透传）
 *   - 其它非法输入（undefined、非字符串、错误长度、非 hex 字符等）-> undefined
 */
export function normalizeColor(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;

  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
  if (!match) return undefined;

  let hex = match[1];
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  const byteAt = (offset) => parseInt(hex.slice(offset, offset + 2), 16);
  return {
    r: byteAt(0) / 255,
    g: byteAt(2) / 255,
    b: byteAt(4) / 255,
    a: hex.length === 8 ? byteAt(6) / 255 : 1,
  };
}

/**
 * padding → { top, right, bottom, left }。
 *
 * 支持：
 *   - 非负有限数字（四边相同）
 *   - { top, right, bottom, left }（四边均须为非负有限数字，未知键丢弃）
 * null / undefined / 非法输入（含数组、缺边、负数）→ null。
 */
export function normalizePadding(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!isFiniteNumber(value) || value < 0) return null;
    return { top: value, right: value, bottom: value, left: value };
  }

  if (isPlainObject(value)) {
    if (!isFiniteNumber(value.top) || value.top < 0) return null;
    if (!isFiniteNumber(value.right) || value.right < 0) return null;
    if (!isFiniteNumber(value.bottom) || value.bottom < 0) return null;
    if (!isFiniteNumber(value.left) || value.left < 0) return null;
    return {
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      left: value.left,
    };
  }

  return null;
}

/**
 * 深拷贝 patch 并剔除 undefined。
 *
 *   - 对象：删除值为 undefined 的键
 *   - 数组：删除 undefined 元素
 *   - 其它值（含 null / 字符串 / 数字 / 布尔）原样返回
 *
 * 非普通对象（Date 等）按引用返回，避免破坏其语义。
 */
export function clonePatch(patch) {
  return cloneValue(patch);
}

function cloneValue(value) {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item === undefined) continue;
      out.push(cloneValue(item));
    }
    return out;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined) continue;
    // 用 defineProperty 而非赋值，避免 JSON 里的 "__proto__" 键污染原型。
    Object.defineProperty(out, key, {
      value: cloneValue(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 导出：校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化一组 ops。
 *
 * @param {unknown} ops 原始 ops 数组（通常来自工具入参，JSON 反序列化后的普通对象）
 * @returns {{ ok: boolean, errors: Array<{opIndex:number, code:string, message:string}>, ops: Array<object> }}
 *
 * 约定：
 *   - `ok === true` 时 `ops` 与入参一一对应（只保留 SPEC 2.1 / 2.2 允许的字段）；
 *   - `ok === false` 时 `ops` 只包含"自身校验通过"的顶层 op（顺序不变、长度可能小于入参），
 *     调用方应在 ok=false 时忽略 `ops`，改用 `errors` 报错；
 *   - 嵌套 children 的错误，opIndex 使用顶层 op 的索引，message 带
 *     `ops[0].children[1]...` 形式的子路径。
 */
export function validateOps(ops) {
  const errors = [];

  if (!Array.isArray(ops)) {
    addError(errors, -1, 'ops', '必须是 ops 数组');
    return { ok: false, errors, ops: [] };
  }

  const normalized = [];
  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const normalizedOp = normalizeOp(ops[opIndex], opIndex, `ops[${opIndex}]`, errors);
    if (normalizedOp) normalized.push(normalizedOp);
  }

  return { ok: errors.length === 0, errors, ops: normalized };
}

/**
 * 计算 dryRun 计划统计（不修改画布、不做引用解析）。
 *
 * @param {unknown} ops ops 数组（建议传 validateOps 的规范化结果）
 * @returns {{ willCreate:number, willUpdate:number, willDelete:number, willGroup:number,
 *             ops:Array<{opIndex:number, op:string, description:string}> }}
 *
 * 计数口径：willCreate / willUpdate / willDelete / willGroup 均统计**顶层 op 条数**；
 * create 的嵌套子节点数量在对应 description 中给出（(`，含 N 个子节点`）。
 */
export function summarizePlan(ops) {
  const plan = { willCreate: 0, willUpdate: 0, willDelete: 0, willGroup: 0, ops: [] };

  if (!Array.isArray(ops)) return plan;

  ops.forEach((op, opIndex) => {
    const kind = isPlainObject(op) ? op.op : undefined;
    // 已识别的 op 用原名，缺失/未知统一记为 'unknown'。
    const normalizedKind = typeof kind === 'string' && OP_TYPES.includes(kind) ? kind : 'unknown';
    let description = '';

    switch (normalizedKind) {
      case 'create': {
        plan.willCreate += 1;
        const type = typeof op.type === 'string' && op.type ? op.type : '节点';
        const name = typeof op.name === 'string' && op.name ? `「${op.name}」` : '';
        const descendants = countDescendants(op);
        description =
          `创建 ${type}${name}` + (descendants > 0 ? `，含 ${descendants} 个子节点` : '');
        break;
      }
      case 'update': {
        plan.willUpdate += 1;
        const fields = isPlainObject(op.patch) ? Object.keys(op.patch) : [];
        const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '?';
        description = `更新节点 ${nodeId}` + (fields.length > 0 ? `（${fields.join(', ')}）` : '');
        break;
      }
      case 'move': {
        const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '?';
        const parentId = typeof op.parentId === 'string' ? op.parentId : '?';
        description =
          `移动节点 ${nodeId} 到父级 ${parentId}` +
          (op.index !== undefined ? `（索引 ${op.index}）` : '');
        break;
      }
      case 'reorder': {
        const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '?';
        description = `调整节点 ${nodeId} 的排序到索引 ${op.index}`;
        break;
      }
      case 'clone': {
        const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '?';
        description = `克隆节点 ${nodeId}` + (op.deep === false ? '（浅拷贝）' : '（深拷贝）');
        break;
      }
      case 'group': {
        plan.willGroup += 1;
        const nodeIds = Array.isArray(op.nodeIds) ? op.nodeIds : [];
        const name = typeof op.name === 'string' && op.name ? `「${op.name}」` : '';
        description = `编组 ${nodeIds.length} 个节点${name}`;
        break;
      }
      case 'delete': {
        plan.willDelete += 1;
        const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '?';
        description = `删除节点 ${nodeId}`;
        break;
      }
      case 'select': {
        const nodeIds = Array.isArray(op.nodeIds) ? op.nodeIds : [];
        description = nodeIds.length === 0 ? '清空选区' : `选中 ${nodeIds.length} 个节点`;
        break;
      }
      default:
        description = `未知 op（${describeOpKind(kind)}）`;
    }

    plan.ops.push({ opIndex, op: normalizedKind, description });
  });

  return plan;
}

// ---------------------------------------------------------------------------
// 单条 op 的分发
// ---------------------------------------------------------------------------

function normalizeOp(raw, opIndex, path, errors) {
  if (!isPlainObject(raw)) {
    addError(errors, opIndex, path, '必须是对象');
    return null;
  }

  const kind = raw.op;
  if (typeof kind !== 'string' || !OP_TYPES.includes(kind)) {
    addError(
      errors,
      opIndex,
      `${path}.op`,
      `未知 op（${describeOpKind(kind)}），仅支持 ${OP_TYPES.join(' / ')}`,
    );
    return null;
  }

  switch (kind) {
    case 'create':
      return normalizeCreate(raw, opIndex, path, errors, 0);
    case 'update':
      return normalizeUpdate(raw, opIndex, path, errors);
    case 'move':
      return normalizeMove(raw, opIndex, path, errors);
    case 'reorder':
      return normalizeReorder(raw, opIndex, path, errors);
    case 'clone':
      return normalizeClone(raw, opIndex, path, errors);
    case 'group':
      return normalizeGroup(raw, opIndex, path, errors);
    case 'delete':
      return normalizeDelete(raw, opIndex, path, errors);
    case 'select':
      return normalizeSelect(raw, opIndex, path, errors);
    default:
      // 理论上不可达（OP_TYPES 已拦截）。
      addError(errors, opIndex, `${path}.op`, '不支持的 op');
      return null;
  }
}

/** 读取必填的非空字符串 nodeId / parentId。 */
function requireNodeId(value, path, errors, opIndex, message) {
  if (isNonEmptyString(value)) return value;
  addError(errors, opIndex, path, message);
  return undefined;
}

/** 可选的非负整数索引。 */
function readOptionalIndex(raw, path, errors, opIndex) {
  if (raw.index === undefined) return { ok: true, value: undefined };
  if (isNonNegativeInteger(raw.index)) return { ok: true, value: raw.index };
  addError(errors, opIndex, `${path}.index`, '必须是非负整数');
  return { ok: false, value: undefined };
}

// ---------------------------------------------------------------------------
// create（含嵌套 children 递归）
// ---------------------------------------------------------------------------

function normalizeCreate(raw, opIndex, path, errors, depth) {
  const start = errors.length;

  if (depth > MAX_NESTING_DEPTH) {
    addError(errors, opIndex, path, `嵌套层级超过上限（${MAX_NESTING_DEPTH} 层）`);
    return null;
  }

  const out = { op: 'create' };

  if (typeof raw.type === 'string' && CREATE_TYPES.includes(raw.type)) {
    out.type = raw.type;
  } else {
    addError(
      errors,
      opIndex,
      `${path}.type`,
      `create 必须提供合法 type（${CREATE_TYPES.join(' / ')}）`,
    );
  }

  if (hasOwn(raw, 'parentId') && raw.parentId !== undefined) {
    if (isNonEmptyString(raw.parentId)) out.parentId = raw.parentId;
    else addError(errors, opIndex, `${path}.parentId`, '必须是非空字符串');
  }

  Object.assign(out, normalizeCommonFields(raw, path, errors, opIndex));

  if (hasOwn(raw, 'children') && raw.children !== undefined) {
    if (!Array.isArray(raw.children)) {
      addError(errors, opIndex, `${path}.children`, '必须是 create op 数组');
    } else {
      const children = [];
      raw.children.forEach((child, childIndex) => {
        const childPath = `${path}.children[${childIndex}]`;
        if (!isPlainObject(child)) {
          addError(errors, opIndex, childPath, '子节点必须是 create op 对象');
          return;
        }
        if (child.op !== 'create') {
          addError(errors, opIndex, `${childPath}.op`, 'children 只允许 create op');
          return;
        }
        const normalizedChild = normalizeCreate(child, opIndex, childPath, errors, depth + 1);
        if (normalizedChild) children.push(normalizedChild);
      });
      out.children = children;
    }
  }

  return errors.length === start ? out : null;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

function normalizeUpdate(raw, opIndex, path, errors) {
  const start = errors.length;

  const nodeId = requireNodeId(
    raw.nodeId,
    `${path}.nodeId`,
    errors,
    opIndex,
    'update 必须提供非空字符串 nodeId',
  );

  let patch;
  if (!isPlainObject(raw.patch)) {
    addError(errors, opIndex, `${path}.patch`, 'update 必须提供 patch 对象');
  } else {
    patch = normalizeCommonFields(raw.patch, `${path}.patch`, errors, opIndex);
  }

  if (errors.length !== start) return null;
  return { op: 'update', nodeId, patch };
}

// ---------------------------------------------------------------------------
// move / reorder / clone
// ---------------------------------------------------------------------------

function normalizeMove(raw, opIndex, path, errors) {
  const start = errors.length;

  const nodeId = requireNodeId(
    raw.nodeId,
    `${path}.nodeId`,
    errors,
    opIndex,
    'move 必须提供非空字符串 nodeId',
  );
  const parentId = requireNodeId(
    raw.parentId,
    `${path}.parentId`,
    errors,
    opIndex,
    'move 必须提供非空字符串 parentId',
  );
  const index = readOptionalIndex(raw, path, errors, opIndex);

  if (errors.length !== start) return null;
  const out = { op: 'move', nodeId, parentId };
  if (index.value !== undefined) out.index = index.value;
  return out;
}

function normalizeReorder(raw, opIndex, path, errors) {
  const start = errors.length;

  const nodeId = requireNodeId(
    raw.nodeId,
    `${path}.nodeId`,
    errors,
    opIndex,
    'reorder 必须提供非空字符串 nodeId',
  );

  if (!isNonNegativeInteger(raw.index)) {
    addError(errors, opIndex, `${path}.index`, 'reorder 必须提供非负整数 index');
  }

  if (errors.length !== start) return null;
  return { op: 'reorder', nodeId, index: raw.index };
}

function normalizeClone(raw, opIndex, path, errors) {
  const start = errors.length;

  const nodeId = requireNodeId(
    raw.nodeId,
    `${path}.nodeId`,
    errors,
    opIndex,
    'clone 必须提供非空字符串 nodeId',
  );

  let parentId;
  if (hasOwn(raw, 'parentId') && raw.parentId !== undefined) {
    if (isNonEmptyString(raw.parentId)) parentId = raw.parentId;
    else addError(errors, opIndex, `${path}.parentId`, '必须是非空字符串');
  }

  let x;
  if (hasOwn(raw, 'x') && raw.x !== undefined) {
    if (isFiniteNumber(raw.x)) x = raw.x;
    else addError(errors, opIndex, `${path}.x`, '必须是有限数字');
  }

  let y;
  if (hasOwn(raw, 'y') && raw.y !== undefined) {
    if (isFiniteNumber(raw.y)) y = raw.y;
    else addError(errors, opIndex, `${path}.y`, '必须是有限数字');
  }

  let deep;
  if (hasOwn(raw, 'deep') && raw.deep !== undefined) {
    if (typeof raw.deep === 'boolean') deep = raw.deep;
    else addError(errors, opIndex, `${path}.deep`, '必须是布尔值');
  }

  if (errors.length !== start) return null;
  const out = { op: 'clone', nodeId };
  if (parentId !== undefined) out.parentId = parentId;
  if (x !== undefined) out.x = x;
  if (y !== undefined) out.y = y;
  if (deep !== undefined) out.deep = deep;
  return out;
}

// ---------------------------------------------------------------------------
// group / delete / select
// ---------------------------------------------------------------------------

function normalizeGroup(raw, opIndex, path, errors) {
  const start = errors.length;

  let nodeIds;
  if (!Array.isArray(raw.nodeIds)) {
    addError(errors, opIndex, `${path}.nodeIds`, 'group 必须提供 nodeIds 字符串数组');
  } else if (raw.nodeIds.length === 0) {
    addError(errors, opIndex, `${path}.nodeIds`, 'group 的 nodeIds 至少需要 1 个节点');
  } else if (!raw.nodeIds.every((id) => isNonEmptyString(id))) {
    addError(errors, opIndex, `${path}.nodeIds`, 'nodeIds 必须全部是非空字符串');
  } else {
    nodeIds = [...raw.nodeIds];
  }

  let name;
  if (hasOwn(raw, 'name') && raw.name !== undefined) {
    if (typeof raw.name === 'string') name = raw.name;
    else addError(errors, opIndex, `${path}.name`, '必须是字符串');
  }

  if (errors.length !== start) return null;
  const out = { op: 'group', nodeIds };
  if (name !== undefined) out.name = name;
  return out;
}

function normalizeDelete(raw, opIndex, path, errors) {
  const start = errors.length;

  const nodeId = requireNodeId(
    raw.nodeId,
    `${path}.nodeId`,
    errors,
    opIndex,
    'delete 必须提供非空字符串 nodeId',
  );

  if (errors.length !== start) return null;
  return { op: 'delete', nodeId };
}

function normalizeSelect(raw, opIndex, path, errors) {
  const start = errors.length;

  let nodeIds;
  if (!Array.isArray(raw.nodeIds)) {
    addError(errors, opIndex, `${path}.nodeIds`, 'select 必须提供 nodeIds 字符串数组');
  } else if (!raw.nodeIds.every((id) => isNonEmptyString(id))) {
    addError(errors, opIndex, `${path}.nodeIds`, 'nodeIds 必须全部是非空字符串');
  } else {
    // 空数组表示清空选区，合法。
    nodeIds = [...raw.nodeIds];
  }

  if (errors.length !== start) return null;
  return { op: 'select', nodeIds };
}

// ---------------------------------------------------------------------------
// SPEC 2.1 公共字段白名单校验
// ---------------------------------------------------------------------------

/**
 * 按 SPEC 2.1 白名单提取并校验字段；未知字段丢弃。
 * @returns {object} 只含合法字段的规范化对象
 */
function normalizeCommonFields(source, path, errors, opIndex) {
  const out = {};
  for (const key of COMMON_FIELDS) {
    if (!hasOwn(source, key) || source[key] === undefined) continue;
    const result = normalizeCommonField(key, source[key], `${path}.${key}`, errors, opIndex);
    if (result.ok) out[key] = result.value;
  }
  return out;
}

function normalizeCommonField(key, value, path, errors, opIndex) {
  switch (key) {
    case 'name':
      return typeof value === 'string'
        ? fieldOk(value)
        : fieldError(errors, opIndex, path, '必须是字符串');

    case 'x':
    case 'y':
    case 'rotation':
      return isFiniteNumber(value)
        ? fieldOk(value)
        : fieldError(errors, opIndex, path, '必须是有限数字');

    case 'width':
    case 'height':
      return isFiniteNumber(value) && value >= 1
        ? fieldOk(value)
        : fieldError(errors, opIndex, path, '必须是不小于 1 的数字');

    case 'strokeWidth':
      return isFiniteNumber(value) && value >= 0
        ? fieldOk(value)
        : fieldError(errors, opIndex, path, '必须是非负数字');

    case 'opacity':
      return isFiniteNumber(value) && value >= 0 && value <= 1
        ? fieldOk(value)
        : fieldError(errors, opIndex, path, '必须是 0 到 1 之间的数字');

    case 'visible':
    case 'locked':
      return typeof value === 'boolean'
        ? fieldOk(value)
        : fieldError(errors, opIndex, path, '必须是布尔值');

    case 'fill':
    case 'stroke': {
      // null 表示无填充/无描边，合法。
      if (value === null) return fieldOk(null);
      if (typeof value === 'string' && normalizeColor(value) !== undefined) {
        // 保留原始字符串，Host 不转 Figma 颜色对象。
        return fieldOk(value);
      }
      return fieldError(
        errors,
        opIndex,
        path,
        '必须是 #RGB / #RRGGBB / #RRGGBBAA 十六进制颜色或 null',
      );
    }

    case 'radius': {
      if (isFiniteNumber(value) && value >= 0) return fieldOk(value);
      if (Array.isArray(value)) {
        if (value.length !== 4) {
          return fieldError(
            errors,
            opIndex,
            path,
            'radius 数组必须是 [topLeft, topRight, bottomRight, bottomLeft] 长度 4',
          );
        }
        if (!value.every((corner) => isFiniteNumber(corner) && corner >= 0)) {
          return fieldError(errors, opIndex, path, 'radius 数组的每一项必须是非负数字');
        }
        return fieldOk([...value]);
      }
      return fieldError(errors, opIndex, path, '必须是非负数字或长度 4 的数组');
    }

    case 'layout':
      return normalizeLayoutField(value, path, errors, opIndex);

    case 'text':
      return normalizeTextField(value, path, errors, opIndex);

    case 'svg':
      return typeof value === 'string'
        ? fieldOk(value)
        : fieldError(errors, opIndex, path, '必须是字符串');

    case 'effects':
      return normalizeEffectsField(value, path, errors, opIndex);

    default:
      // COMMON_FIELDS 之外不可达。
      return { ok: false, value: undefined };
  }
}

// ---------------------------------------------------------------------------
// layout / text / effects 子结构
// ---------------------------------------------------------------------------

function normalizeLayoutField(value, path, errors, opIndex) {
  if (value === null) return fieldOk(null);
  if (!isPlainObject(value)) {
    return fieldError(errors, opIndex, path, '必须是对象或 null（null 表示关闭 Auto Layout）');
  }

  const start = errors.length;
  const out = {};

  if (typeof value.mode === 'string' && LAYOUT_MODES.includes(value.mode)) {
    out.mode = value.mode;
  } else {
    addError(
      errors,
      opIndex,
      `${path}.mode`,
      `必须是 ${LAYOUT_MODES.join(' / ')} 之一（关闭 Auto Layout 请传 layout:null）`,
    );
  }

  if (hasOwn(value, 'itemSpacing') && value.itemSpacing !== undefined) {
    if (isFiniteNumber(value.itemSpacing)) out.itemSpacing = value.itemSpacing;
    else addError(errors, opIndex, `${path}.itemSpacing`, '必须是有限数字');
  }

  if (hasOwn(value, 'padding') && value.padding !== undefined) {
    const padding = normalizePadding(value.padding);
    if (padding === null) {
      addError(
        errors,
        opIndex,
        `${path}.padding`,
        '必须是非负数字或 {top,right,bottom,left}（四边均须为非负有限数字）',
      );
    } else {
      // 数字输入保留数字（插件侧接受 number | object），对象输入规范化为四边对象。
      out.padding = typeof value.padding === 'number' ? value.padding : padding;
    }
  }

  if (hasOwn(value, 'primaryAxisAlign') && value.primaryAxisAlign !== undefined) {
    if (
      typeof value.primaryAxisAlign === 'string' &&
      PRIMARY_AXIS_ALIGNS.includes(value.primaryAxisAlign)
    ) {
      out.primaryAxisAlign = value.primaryAxisAlign;
    } else {
      addError(
        errors,
        opIndex,
        `${path}.primaryAxisAlign`,
        `必须是 ${PRIMARY_AXIS_ALIGNS.join(' / ')} 之一`,
      );
    }
  }

  if (hasOwn(value, 'counterAxisAlign') && value.counterAxisAlign !== undefined) {
    if (
      typeof value.counterAxisAlign === 'string' &&
      COUNTER_AXIS_ALIGNS.includes(value.counterAxisAlign)
    ) {
      out.counterAxisAlign = value.counterAxisAlign;
    } else {
      addError(
        errors,
        opIndex,
        `${path}.counterAxisAlign`,
        `必须是 ${COUNTER_AXIS_ALIGNS.join(' / ')} 之一`,
      );
    }
  }

  if (hasOwn(value, 'wrap') && value.wrap !== undefined) {
    if (typeof value.wrap === 'string' && WRAPS.includes(value.wrap)) {
      out.wrap = value.wrap;
    } else {
      addError(errors, opIndex, `${path}.wrap`, `必须是 ${WRAPS.join(' / ')} 之一`);
    }
  }

  if (errors.length !== start) return { ok: false, value: undefined };
  return fieldOk(out);
}

function normalizeTextField(value, path, errors, opIndex) {
  if (!isPlainObject(value)) {
    return fieldError(errors, opIndex, path, '必须是对象');
  }

  const start = errors.length;
  const out = {};

  if (hasOwn(value, 'characters') && value.characters !== undefined) {
    if (typeof value.characters === 'string') out.characters = value.characters;
    else addError(errors, opIndex, `${path}.characters`, '必须是字符串');
  }

  if (hasOwn(value, 'font') && value.font !== undefined) {
    const font = value.font;
    if (isPlainObject(font) && isNonEmptyString(font.family) && isNonEmptyString(font.style)) {
      out.font = { family: font.family, style: font.style };
    } else {
      addError(
        errors,
        opIndex,
        `${path}.font`,
        '必须是 {family, style} 且两者均为非空字符串',
      );
    }
  }

  if (hasOwn(value, 'fontSize') && value.fontSize !== undefined) {
    if (isFiniteNumber(value.fontSize) && value.fontSize > 0) out.fontSize = value.fontSize;
    else addError(errors, opIndex, `${path}.fontSize`, '必须是大于 0 的数字');
  }

  if (hasOwn(value, 'align') && value.align !== undefined) {
    if (typeof value.align === 'string' && TEXT_ALIGNS.includes(value.align)) {
      out.align = value.align;
    } else {
      addError(errors, opIndex, `${path}.align`, `必须是 ${TEXT_ALIGNS.join(' / ')} 之一`);
    }
  }

  for (const metricKey of ['lineHeight', 'letterSpacing']) {
    if (!hasOwn(value, metricKey) || value[metricKey] === undefined) continue;
    const metric = normalizeTextMetricField(value[metricKey], `${path}.${metricKey}`, errors, opIndex);
    if (metric.ok) out[metricKey] = metric.value;
  }

  if (hasOwn(value, 'textAutoResize') && value.textAutoResize !== undefined) {
    if (
      typeof value.textAutoResize === 'string' &&
      TEXT_AUTO_RESIZES.includes(value.textAutoResize)
    ) {
      out.textAutoResize = value.textAutoResize;
    } else {
      addError(
        errors,
        opIndex,
        `${path}.textAutoResize`,
        `必须是 ${TEXT_AUTO_RESIZES.join(' / ')} 之一`,
      );
    }
  }

  if (errors.length !== start) return { ok: false, value: undefined };
  return fieldOk(out);
}

/** lineHeight / letterSpacing：number 或 {unit:'PIXELS'|'PERCENT', value:number}。 */
function normalizeTextMetricField(value, path, errors, opIndex) {
  if (isFiniteNumber(value)) return fieldOk(value);
  if (
    isPlainObject(value) &&
    typeof value.unit === 'string' &&
    METRIC_UNITS.includes(value.unit) &&
    isFiniteNumber(value.value)
  ) {
    return fieldOk({ unit: value.unit, value: value.value });
  }
  return fieldError(
    errors,
    opIndex,
    path,
    '必须是数字或 {unit:"PIXELS"|"PERCENT", value:number}',
  );
}

function normalizeEffectsField(value, path, errors, opIndex) {
  if (!Array.isArray(value)) return fieldError(errors, opIndex, path, '必须是数组');

  const start = errors.length;
  const out = [];

  value.forEach((effect, effectIndex) => {
    const effectPath = `${path}[${effectIndex}]`;
    if (!isPlainObject(effect)) {
      addError(errors, opIndex, effectPath, '必须是对象');
      return;
    }

    const normalized = {};

    if (typeof effect.type === 'string' && EFFECT_TYPES.includes(effect.type)) {
      normalized.type = effect.type;
    } else {
      addError(
        errors,
        opIndex,
        `${effectPath}.type`,
        `必须是 ${EFFECT_TYPES.join(' / ')} 之一`,
      );
    }

    if (hasOwn(effect, 'color') && effect.color !== undefined) {
      if (
        effect.color === null ||
        (typeof effect.color === 'string' && normalizeColor(effect.color) !== undefined)
      ) {
        normalized.color = effect.color;
      } else {
        addError(
          errors,
          opIndex,
          `${effectPath}.color`,
          '必须是 #RGB / #RRGGBB / #RRGGBBAA 十六进制颜色或 null',
        );
      }
    }

    if (hasOwn(effect, 'offset') && effect.offset !== undefined) {
      const offset = effect.offset;
      if (isPlainObject(offset) && isFiniteNumber(offset.x) && isFiniteNumber(offset.y)) {
        normalized.offset = { x: offset.x, y: offset.y };
      } else {
        addError(errors, opIndex, `${effectPath}.offset`, '必须是 {x, y} 且 x/y 均为有限数字');
      }
    }

    for (const numericKey of ['radius', 'spread']) {
      if (!hasOwn(effect, numericKey) || effect[numericKey] === undefined) continue;
      if (isFiniteNumber(effect[numericKey])) normalized[numericKey] = effect[numericKey];
      else addError(errors, opIndex, `${effectPath}.${numericKey}`, '必须是有限数字');
    }

    if (hasOwn(effect, 'visible') && effect.visible !== undefined) {
      if (typeof effect.visible === 'boolean') normalized.visible = effect.visible;
      else addError(errors, opIndex, `${effectPath}.visible`, '必须是布尔值');
    }

    out.push(normalized);
  });

  if (errors.length !== start) return { ok: false, value: undefined };
  return fieldOk(out);
}

// ---------------------------------------------------------------------------
// dryRun 辅助：统计 create 子树（含子孙）节点数
// ---------------------------------------------------------------------------

function countDescendants(node, depth = 0) {
  if (!isPlainObject(node) || !Array.isArray(node.children)) return 0;
  if (depth >= MAX_NESTING_DEPTH) return 0;

  let count = 0;
  for (const child of node.children) {
    count += 1;
    count += countDescendants(child, depth + 1);
  }
  return count;
}
