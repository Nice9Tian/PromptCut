/**
 * 通用 JSON 路径操作引擎（C6.5 设计稿 `docs/plan/c65-design.md` 第 2 节；精确语义见 `docs/plan/c65-ops-spec.md`）。
 *
 * 文档服务是通用的 JSON 分发中心，不认识任何业务结构：本文件只认 JSON 的对象、数组、标量，
 * 以及「数组里带 `id` 的对象按 `@<id>` 寻址」这一条通用约定。只用语言内置能力，不引用任何其它文件。
 *
 * - 路径：JSON 指针（RFC 6901，`~0` = `~`、`~1` = `/`），空串是根。数组里的元素只能按 `@<id>` 寻址，不认下标。
 * - 四种操作：`set`、`remove`、`insert`、`move`（见 `applyOps`）。
 * - 一批操作原子生效：`applyOps` 按写时复制做，旧的根一个字节都不改；任何一条失败就整批作废、抛错。
 * - 实体：`entityOf` 把路径归到「最多 `depth` 层 `@id`」的前缀上，没有 `@id` 的归到 `metaEntity`；
 *   `entitiesOf` 按 `applyOps` 给的效果算出一批操作写到的实体（`set` 按新旧值的实际差别算）。
 */

export const OP_NAMES = Object.freeze(['set', 'remove', 'insert', 'move']);

/** 实体的缺省口径：最多两层 `@id`，没有 `@id` 的顶层字段归到 `/meta` */
export const ENTITY_DEFAULTS = Object.freeze({ depth: 2, metaEntity: '/meta' });

/**
 * 引擎的错误：
 * - `bad-op`：操作本身的格式不对（操作名、路径语法、缺 `value`、`index` 不是非负整数……），与文档内容无关；
 * - `bad-path`：格式对，但对着当前文档走不通（父级不存在、下标寻址、`insert` 的 `id` 已存在……）。
 * `index` 是出错的那条操作在批里的下标。
 */
export class OpError extends Error {
  constructor(code, index, detail) {
    super(detail);
    this.code = code;
    this.index = index;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isContainer = (v) => v !== null && typeof v === 'object';
const isIdValue = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const isIndex = (v) => Number.isSafeInteger(v) && v >= 0;

// ---------------------------------------------------------------- 路径

function unescapeToken(raw) {
  if (!raw.includes('~')) return raw;
  if (/~[^01]|~$/.test(raw)) return null;
  return raw.replace(/~1/g, '/').replace(/~0/g, '~');
}

const escapeToken = (text) => text.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * 拆路径：空串 → []；否则必须以 `/` 开头。每段 `{ text, id }`：`text` 是反转义后的键；
 * 以 `@` 开头的段 `id` 是去掉 `@` 的部分（在数组里按它找元素），否则 `id` 为 null。
 * 在对象里，`@` 开头的段仍按字面键处理。语法不对回 null。
 */
export function parsePath(path) {
  if (typeof path !== 'string') return null;
  if (path === '') return [];
  if (path[0] !== '/') return null;
  const out = [];
  for (const raw of path.slice(1).split('/')) {
    const text = unescapeToken(raw);
    if (text === null) return null;
    const id = text.startsWith('@') ? text.slice(1) : null;
    if (id === '') return null;
    out.push({ text, id });
  }
  return out;
}

/** 段列表 → 路径（规范写法） */
export function formatPath(segs) {
  return segs.map((s) => `/${escapeToken(s.text)}`).join('');
}

/** 一个 `id` 在路径里的段：`@<id>`（转义后） */
export const idSegment = (id) => `@${escapeToken(String(id))}`;

/** 数组元素是否就是 `@<id>` 指的那个 */
function matchesId(el, id) {
  if (!isObj(el)) return false;
  return el.id === id || (typeof el.id === 'number' && String(el.id) === id);
}

function findById(arr, id) {
  for (let i = 0; i < arr.length; i += 1) if (matchesId(arr[i], id)) return i;
  return -1;
}

// ---------------------------------------------------------------- 校验（与文档无关）

/**
 * 只看操作本身的格式，不看文档。不对就抛 `OpError('bad-op')`。返回每条的已解析路径。
 * @param {unknown} ops
 */
export function checkOps(ops) {
  if (!Array.isArray(ops)) throw new OpError('bad-op', -1, 'ops 必须是数组');
  const parsed = [];
  ops.forEach((op, i) => {
    if (!isObj(op)) throw new OpError('bad-op', i, '每条操作必须是对象');
    if (!OP_NAMES.includes(op.op)) throw new OpError('bad-op', i, `op 只能是 ${OP_NAMES.join(' / ')}`);
    const segs = parsePath(op.path);
    if (segs === null) throw new OpError('bad-op', i, 'path 必须是空串或以 / 开头的 JSON 指针');
    switch (op.op) {
      case 'set':
        if (!Object.hasOwn(op, 'value') || op.value === undefined) throw new OpError('bad-op', i, 'set 缺少 value');
        break;
      case 'remove':
        if (segs.length === 0) throw new OpError('bad-op', i, '不能 remove 根');
        break;
      case 'insert':
        if (!isObj(op.value) || !isIdValue(op.value.id)) throw new OpError('bad-op', i, 'insert 的 value 必须是带 id（字符串或数字）的对象');
        if (!isIndex(op.index)) throw new OpError('bad-op', i, 'insert 的 index 必须是非负整数');
        break;
      case 'move':
        if (segs.length === 0 || segs[segs.length - 1].id === null) throw new OpError('bad-op', i, 'move 的 path 必须以 @<id> 结尾');
        if (!isIndex(op.index)) throw new OpError('bad-op', i, 'move 的 index 必须是非负整数');
        break;
      default:
        break;
    }
    parsed.push(segs);
  });
  return parsed;
}

// ---------------------------------------------------------------- 应用

/** 给对象设一个键：`__proto__` 走 defineProperty，免得改到原型 */
function putKey(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  else obj[key] = value;
}

/**
 * 按顺序应用一批操作，返回新的根和每条的效果；**不改动传入的根**（写时复制：只复制路径上经过的容器，
 * 同一批里已经复制过的不再复制）。任何一条失败抛 `OpError`，调用方丢掉整批即可。
 *
 * 语义（与 `docs/plan/c65-ops-spec.md` 一致）：
 * - `set`：路径为空串时替换整个根。否则逐级走下去：对象里缺的键（以及根本身缺失）连同缺的父级对象一起建成 `{}`；
 *   数组里找不到 `@id`、中途碰到标量或 null、在数组上用非 `@id` 段，都是 `bad-path`。
 *   末段在数组里时替换那个元素，新值必须是 `id` 相同的对象，否则 `bad-path`。
 * - `remove`：父级必须存在（否则 `bad-path`）；目标不存在时什么都不做（记为 noop）。数组上末段必须是 `@id`。
 * - `insert`：`path` 指向数组本身，数组必须存在（否则 `bad-path`）；`value.id` 已在数组里是 `bad-path`；
 *   `index` 大于长度时按长度算（插到末尾）。
 * - `move`：`path` 指向数组里的元素，数组必须存在（否则 `bad-path`）；元素不存在时什么都不做（noop）。
 *   `index` 是挪完之后它在数组里的下标，大于最后一个下标时按最后一个算。
 *
 * @param {unknown} root 当前的根（undefined / null 表示还没有内容）
 * @param {Array<object>} ops
 * @returns {{ root: unknown, effects: Array<{ op: string, path: string, target: string, noop: boolean, before?: unknown, after?: unknown }> }}
 *   `target` 是这条操作写到的位置（`insert` 是新元素的路径）；`set` 另带写之前与之后的值
 */
export function applyOps(root, ops) {
  const parsed = checkOps(ops);
  const owned = new WeakSet();
  const state = { root };

  const own = (node) => {
    if (owned.has(node)) return node;
    const copy = Array.isArray(node) ? node.slice() : { ...node };
    owned.add(copy);
    return copy;
  };

  /** 根变成自己的可写副本；`create` 为真时根缺失（undefined / null）就建成 `{}` */
  function ownRoot(i, create) {
    if (!isContainer(state.root)) {
      if (!create || (state.root !== undefined && state.root !== null)) {
        throw new OpError('bad-path', i, state.root === undefined || state.root === null ? '文档还没有内容' : '根不是对象或数组');
      }
      state.root = {};
      owned.add(state.root);
      return state.root;
    }
    state.root = own(state.root);
    return state.root;
  }

  /**
   * 从根走到 `segs` 指的容器，沿途复制成可写的，返回它。
   * `create`：对象里缺的键建成 `{}`（只有 set 用）。走不通抛 `bad-path`。
   */
  function descend(i, segs, create) {
    let node = ownRoot(i, create);
    for (let k = 0; k < segs.length; k += 1) {
      const seg = segs[k];
      const where = formatPath(segs.slice(0, k + 1));
      if (Array.isArray(node)) {
        if (seg.id === null) throw new OpError('bad-path', i, `数组只能按 @<id> 寻址：${where}`);
        const at = findById(node, seg.id);
        if (at < 0) throw new OpError('bad-path', i, `找不到 ${where}`);
        const child = node[at];
        const copy = own(child);
        node[at] = copy;
        node = copy;
        continue;
      }
      const has = Object.hasOwn(node, seg.text);
      const child = has ? node[seg.text] : undefined;
      if (!has || child === undefined) {
        if (!create) throw new OpError('bad-path', i, `找不到 ${where}`);
        const fresh = {};
        owned.add(fresh);
        putKey(node, seg.text, fresh);
        node = fresh;
        continue;
      }
      if (!isContainer(child)) throw new OpError('bad-path', i, `${where} 不是对象或数组`);
      const copy = own(child);
      putKey(node, seg.text, copy);
      node = copy;
    }
    return node;
  }

  const effects = [];
  ops.forEach((op, i) => {
    const segs = parsed[i];
    const path = formatPath(segs);
    switch (op.op) {
      case 'set': {
        if (segs.length === 0) {
          effects.push({ op: 'set', path, target: path, noop: false, before: state.root, after: op.value });
          state.root = op.value;
          return;
        }
        const parent = descend(i, segs.slice(0, -1), true);
        const last = segs[segs.length - 1];
        if (Array.isArray(parent)) {
          if (last.id === null) throw new OpError('bad-path', i, `数组只能按 @<id> 寻址：${path}`);
          const at = findById(parent, last.id);
          if (at < 0) throw new OpError('bad-path', i, `找不到 ${path}（set 不在数组里建元素，用 insert）`);
          if (!matchesId(op.value, last.id)) throw new OpError('bad-path', i, `${path} 的新值必须是 id 相同的对象`);
          effects.push({ op: 'set', path, target: path, noop: false, before: parent[at], after: op.value });
          parent[at] = op.value;
          return;
        }
        const before = Object.hasOwn(parent, last.text) ? parent[last.text] : undefined;
        effects.push({ op: 'set', path, target: path, noop: false, before, after: op.value });
        putKey(parent, last.text, op.value);
        return;
      }
      case 'remove': {
        const parent = descend(i, segs.slice(0, -1), false);
        const last = segs[segs.length - 1];
        if (Array.isArray(parent)) {
          if (last.id === null) throw new OpError('bad-path', i, `数组只能按 @<id> 寻址：${path}`);
          const at = findById(parent, last.id);
          if (at >= 0) parent.splice(at, 1);
          effects.push({ op: 'remove', path, target: path, noop: at < 0 });
          return;
        }
        const has = Object.hasOwn(parent, last.text);
        if (has) delete parent[last.text];
        effects.push({ op: 'remove', path, target: path, noop: !has });
        return;
      }
      case 'insert': {
        const arr = descend(i, segs, false);
        if (!Array.isArray(arr)) throw new OpError('bad-path', i, `${path} 不是数组`);
        const id = String(op.value.id);
        if (findById(arr, id) >= 0) throw new OpError('bad-path', i, `${path} 里已经有 id ${id}`);
        arr.splice(Math.min(op.index, arr.length), 0, op.value);
        effects.push({ op: 'insert', path, target: `${path}/${idSegment(op.value.id)}`, noop: false });
        return;
      }
      case 'move': {
        const arr = descend(i, segs.slice(0, -1), false);
        if (!Array.isArray(arr)) throw new OpError('bad-path', i, `${formatPath(segs.slice(0, -1))} 不是数组`);
        const at = findById(arr, segs[segs.length - 1].id);
        if (at < 0) {
          effects.push({ op: 'move', path, target: path, noop: true });
          return;
        }
        const [el] = arr.splice(at, 1);
        arr.splice(Math.min(op.index, arr.length), 0, el);
        effects.push({ op: 'move', path, target: path, noop: false });
        return;
      }
      default:
        throw new OpError('bad-op', i, '未知操作');
    }
  });
  return { root: state.root, effects };
}

// ---------------------------------------------------------------- 比较与实体

/** 两个 JSON 值是否相同（对象不看键序，数组看顺序） */
export function jsonEqual(a, b) {
  if (a === b) return true;
  if (!isContainer(a) || !isContainer(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
  }
  return true;
}

/** 段列表 → 它所属的实体：截到第 `depth` 个 `@id` 段为止；一个 `@id` 都没有时是 `metaEntity` */
function entityOfSegs(segs, depth, metaEntity) {
  let seen = 0;
  let cut = -1;
  for (let k = 0; k < segs.length; k += 1) {
    if (segs[k].id === null) continue;
    seen += 1;
    cut = k;
    if (seen >= depth) break;
  }
  return cut < 0 ? metaEntity : formatPath(segs.slice(0, cut + 1));
}

/**
 * 路径所属的实体。路径里以 `@` 开头的段一律当 `@id` 看（本函数不看文档，对象里以 `@` 开头的字面键也算）。
 * 路径语法不对回 null。
 */
export function entityOf(path, { depth = ENTITY_DEFAULTS.depth, metaEntity = ENTITY_DEFAULTS.metaEntity } = {}) {
  const segs = parsePath(path);
  if (segs === null) return null;
  return entityOfSegs(segs, depth, metaEntity);
}

/**
 * 新旧两个值之间有差别的实体，加进 `out`。`segs` 是这两个值所在的路径。
 * - 对象逐键比；只在一边有的键，按「那个键的路径」记；
 * - 数组里带 id 的元素按 id 配对：只在一边有的元素按它自己的路径记，两边都有的往下比；
 *   共同元素的相对顺序变了，或不带 id 的元素有差别，按数组本身的路径记；
 * - 已经到了 `depth` 层 `@id`，或类型不同、标量不同，整个按当前路径记。
 */
function diffEntities(a, b, segs, idCount, opts, out) {
  if (a === b) return;
  const mark = (s) => out.add(entityOfSegs(s, opts.depth, opts.metaEntity));
  if (idCount >= opts.depth) {
    if (!jsonEqual(a, b)) mark(segs);
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const child = [...segs, { text: k, id: null }];
      const ha = Object.hasOwn(a, k);
      const hb = Object.hasOwn(b, k);
      if (ha && hb) diffEntities(a[k], b[k], child, idCount, opts, out);
      else if (!jsonEqual(ha ? a[k] : undefined, hb ? b[k] : undefined)) mark(child);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const ida = new Map();
    const idb = new Map();
    const plainA = [];
    const plainB = [];
    for (const el of a) if (isObj(el) && isIdValue(el.id) && !ida.has(String(el.id))) ida.set(String(el.id), el); else plainA.push(el);
    for (const el of b) if (isObj(el) && isIdValue(el.id) && !idb.has(String(el.id))) idb.set(String(el.id), el); else plainB.push(el);
    let containerChanged = !jsonEqual(plainA, plainB);
    const commonA = [...ida.keys()].filter((id) => idb.has(id));
    const commonB = [...idb.keys()].filter((id) => ida.has(id));
    if (commonA.some((id, i) => commonB[i] !== id)) containerChanged = true;
    for (const [id, el] of ida) {
      const child = [...segs, { text: `@${id}`, id }];
      if (idb.has(id)) diffEntities(el, idb.get(id), child, idCount + 1, opts, out);
      else mark(child);
    }
    for (const id of idb.keys()) if (!ida.has(id)) mark([...segs, { text: `@${id}`, id }]);
    if (containerChanged) mark(segs);
    return;
  }
  if (!jsonEqual(a, b)) mark(segs);
}

/**
 * 一批操作写到的实体（按首次出现的顺序去重）。`effects` 是 `applyOps` 的返回值里的那个。
 * - `set`：按新旧值的实际差别算（值没变就不算写到）；整个根替换也照此算；
 * - `remove`、`move`：真的删了、挪了才算，算到目标路径所属的实体；
 * - `insert`：算到新元素所属的实体。
 */
export function entitiesOf(effects, { depth = ENTITY_DEFAULTS.depth, metaEntity = ENTITY_DEFAULTS.metaEntity } = {}) {
  const out = new Set();
  const opts = { depth, metaEntity };
  for (const e of effects) {
    if (e.noop) continue;
    const segs = parsePath(e.target);
    if (e.op === 'set') {
      const idCount = segs.filter((s) => s.id !== null).length;
      diffEntities(e.before, e.after, segs, idCount, opts, out);
    } else {
      out.add(entityOfSegs(segs, depth, metaEntity));
    }
  }
  return [...out];
}
