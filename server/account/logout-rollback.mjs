/** 改密码或重设密码之后选了「退出」触发的逐项撤回（文档服务这一侧，0.7.20）。
 *
 * 语义：`docs/semantics/product/document-service.md`「冲突」「保存与延迟退出的修改处理」。要撤的只有
 * 「改完密码到选退出之间、旧登录做的修改」；撤回按修改项逐条核对，某一项之后被别人（另一位成员、Agent、同一账号的新登录）
 * 又改过算冲突、不撤、保留现状；不弹任何窗口。共有已读消息触发、退出后保留继续的当前 Agent 任务，它的修改不撤。
 *
 * 做法：
 * - **区间**：账号服务的改密事件带 `changeSeq`（改密那一刻在账号服务的顺序号），旧登录每一次被接受的操作都带账号服务签的
 *   `orderSeq`，两者是同一条序列；0.7.18 在退出确认里记下了「旧登录在各项目里最后一条被接受的操作的顺序号」
 *   （`docLogoutBarriersV1[事件号].proof.projectCursors`），作为区间的终点。区间里的操作 = 旧登录的、
 *   `changeSeq < orderSeq <= 终点`、且不属于保留下来的共有已读任务（`retainedRunsOf`）。
 * - **逐项**：文档服务的操作历史给每次提交记了它改到的每一个修改项（叶子属性，带 id 的数组按元素、外加一条「顺序」项）、
 *   改之前与之后的值（`operation-history.mjs` 的 `recordChanges`）。`planRollback` 逐项看：这一项最后一段连续的改动
 *   都是区间里的旧登录做的，而且之后没有别人改过这一项、它的上级（例如别人删了这个片段）或下级（例如别人改了我新加的片段里的属性），
 *   就撤回到那一段之前的值；否则算冲突，保留。
 * - **落地**：撤回作为一次可审计的补偿操作，经同一条有序提交写进项目（`operation-wiring.mjs` 的 `executeSystem`），
 *   写入身份是 `{ accountId, rollbackEventId }`，账号服务凭文档服务签的撤回证明给它定序（不借任何登录的身份）。
 * - **幂等**：账本 `logoutRollbacksV1[事件号]` 记每个项目做到哪；每个项目的补偿操作号是 `logout-rollback:<事件号>:<第几次>`，
 *   同一个号重来只会认出已经落地的那一次；上一次没定序就被作废的，换下一个号重新算。
 */
import { applyOps, parsePath, isIdArray, idSegment } from '../docservice/json-ops.mjs';
import { canonical, digest, historyError } from '../docservice/modules/operation-history.mjs';
import { accountError } from './client.mjs';

export const ROLLBACK_VERSION = '0.7.20';
/** 账本里每个项目留几条撤回 / 保留的路径（只给排查用；数目另记全数） */
export const ROLLBACK_PATHS_KEPT = 50;
/** 账本里每条路径最多留这么多字符，超了截断并在末尾标「…〔截断〕」（路径里的键来自项目内容，安全专审 SEC-05） */
export const ROLLBACK_PATH_CHARS = 300;
/** 一批补偿操作最多落地几个修改项；一个项目要撤的更多就分几批，批与批之间让出事件循环（安全专审 SEC-03） */
export const ROLLBACK_BATCH_ITEMS = 1000;
/**
 * 一批补偿操作序列化后最多这么多字节，与页面一次提交的上限相同（`modules/project.mjs` 的 `PROJECT_LIMITS.MAX_OPS_BYTES`）：
 * 落地一批的开销（json-ops 在长数组上按 id 找元素是线性的）不超过一笔最大的页面提交。
 */
export const ROLLBACK_BATCH_BYTES = 256 * 1024;
/**
 * 补偿操作号的前缀。页面提交不许用这个前缀（`operation-wiring.mjs` 的 `execute` 拒），否则成员能先用
 * `logout-rollback:<事件号>:<第几次>` 交一笔普通提交占号，撤回永远办不完（安全专审 SEC-01）。
 */
export const ROLLBACK_OP_PREFIX = 'logout-rollback:';
export const rollbackOpId = (eventId, attempt) => `${ROLLBACK_OP_PREFIX}${eventId}:${attempt}`;
export const isReservedOpId = (opId) => typeof opId === 'string' && opId.startsWith(ROLLBACK_OP_PREFIX);
const clipPath = (path) => (path.length > ROLLBACK_PATH_CHARS ? `${path.slice(0, ROLLBACK_PATH_CHARS)}…〔截断〕` : path);
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

const same = (a, b) => canonical(a ?? { present: false }) === canonical(b ?? { present: false });
const under = (ancestor, path) => ancestor === '' ? path !== '' : path.startsWith(`${ancestor}/`);
const related = (a, b) => a === b || under(a, b) || under(b, a);
const depthOf = (path) => (path === '' ? 0 : path.split('/').length - 1);

/** 这次退出是不是「改密码或重设密码之后选了退出」：账本里同一个事件号先有 `password-changed`、后有 `credentials-revoked`，
 * 而且这些旧登录都已经在作废名单里。网站上直接点「退出登录」、删账号产生的作废不算（它们没有「改完密码到选退出之间」）。 */
export function rollbackEventOf(state, eventId) {
  const rows = Object.values(state?.accountEvents ?? {}).map((row) => row?.event).filter((event) => event?.eventId === eventId);
  const changed = rows.find((event) => event.type === 'password-changed');
  const revoked = rows.find((event) => event.type === 'credentials-revoked');
  const barrier = state?.barriers?.[`event:${eventId}`];
  if (!changed || !revoked || !barrier || changed.accountId !== revoked.accountId || changed.changeSeq !== revoked.changeSeq) return null;
  if (!Number.isSafeInteger(revoked.changeSeq) || revoked.changeSeq < 0 || !Array.isArray(barrier.loginIds) || !barrier.loginIds.length) return null;
  if (!barrier.loginIds.every((loginId) => state.revokedLogins?.[`login:${loginId}`]?.eventId === eventId)) return null;
  return { eventId, accountId: revoked.accountId, changeSeq: revoked.changeSeq, loginIds: [...barrier.loginIds], accessEventId: barrier.accessEventId };
}

const RUN_FIELDS = ['runGrantId', 'runId', 'messageId', 'conversationId', 'accountId', 'loginId'];
/** 这次退出时保留下来继续跑的共有已读任务（Agent 已读消息例外）：账本里这次作废的任务控制记录里 `retained` 的那些授权。 */
export function retainedRunsOf(state, accessEventId) {
  const out = [];
  for (const control of Object.values(state?.runControlsV2 ?? {})) {
    if (control?.requestId !== `access:${accessEventId}`) continue;
    for (const id of control.retained ?? []) {
      const grant = state.runGrantsV2?.[id];
      if (grant) out.push({ projectId: grant.projectId, ...Object.fromEntries(RUN_FIELDS.map((key) => [key, grant[key]])) });
    }
  }
  return out;
}

/** 某次被接受的操作是不是这次要撤的：旧登录的、在区间里、不是保留下来的共有已读任务做的。 */
export function candidateOf({ projectId, loginIds, changeSeq, endSeq, retained = [] }) {
  const logins = new Set(loginIds);
  return (op) => {
    const actor = op?.actor ?? {}, seq = op?.witness?.orderSeq;
    if (!logins.has(actor.loginId) || !Number.isSafeInteger(seq) || seq <= changeSeq) return false;
    if (Number.isSafeInteger(endSeq) && seq > endSeq) return false;
    if (!['accepted', 'materialized'].includes(op.state)) return false;
    // 凭「共有已读、当前任务」的保留证明定序的，一律不撤（`password-order.mjs` 的 `retainedOperationProof`）
    if (op.witness?.authorization?.kind === 'retained') return false;
    if (actor.runGrantId && retained.some((grant) => grant.projectId === projectId && grant.runGrantId === actor.runGrantId &&
        RUN_FIELDS.every((key) => grant[key] === undefined || grant[key] === actor[key]))) return false;
    return true;
  };
}

/** 带 id 的数组按 id 找元素与位置：同一个数组对象只建一次索引（数组不原地改，换了内容就是另一个对象）。 */
const idIndexes = new WeakMap();
function idIndex(arr) {
  let index = idIndexes.get(arr);
  if (!index) {
    index = new Map();
    arr.forEach((el, i) => { if (el && typeof el === 'object' && !Array.isArray(el) && typeof el.id === 'string' && !index.has(el.id)) index.set(el.id, i); });
    idIndexes.set(arr, index);
  }
  return index;
}
function walk(root, segs) {
  let node = root;
  for (const seg of segs) {
    if (Array.isArray(node)) {
      if (seg.id === null) return { present: false };
      const at = idIndex(node).get(seg.id);
      if (at === undefined) return { present: false };
      node = node[at];
    } else if (node && typeof node === 'object') {
      if (!Object.hasOwn(node, seg.text)) return { present: false };
      node = node[seg.text];
    } else return { present: false };
  }
  return { present: true, value: node };
}
const parentOf = (path) => path.slice(0, path.lastIndexOf('/'));

/** 一个带 id 的数组里，按那次删除之前的顺序，把 id 插回去该在的位置：前面最近一个现在还在的兄弟之后，没有就放最前。 */
function insertIndex(current, beforeIds, id) {
  const at = beforeIds.indexOf(id), index = idIndex(current);
  for (let k = at - 1; k >= 0; k--) {
    const i = index.get(beforeIds[k]);
    if (i !== undefined) return i + 1;
  }
  return 0;
}

/** 两个 id 序列里共同的那些 id，相对顺序是不是变了（只增删不算换顺序） */
function reordered(before, after) {
  const inBefore = new Set(before), inAfter = new Set(after);
  const a = before.filter((id) => inAfter.has(id)), b = after.filter((id) => inBefore.has(id));
  return a.some((id, i) => id !== b[i]);
}

/**
 * 这一条「structure」记录是不是带 id 的数组的「顺序」项（`recordChanges` 对带 id 的数组只记 id 序列；普通数组记整个数组，
 * 种类也叫 structure）。不靠值的形状猜（`string[]` 的词表、原本为空的数组都会被猜错，安全专审 SEC-02）：
 * 看那次操作前后真实的数组是不是带 id 的数组；操作里没带前后快照时看项目现在的值；都是空数组时看同一次操作有没有记它的元素项。
 */
function isIdStructure(entry, current) {
  const c = entry.c;
  if (c.kind !== 'structure') return false;
  const segs = parsePath(c.path);
  if (!segs) return false;
  const roots = [entry.op.before, entry.op.after].filter((root) => root !== undefined);
  if (!roots.length) roots.push(current.value);
  for (const root of roots) {
    const found = walk(root, segs);
    if (!found.present || !Array.isArray(found.value)) continue;
    if (found.value.length) return isIdArray(found.value);
  }
  const lists = [c.before, c.after].filter((v) => v?.present).map((v) => v.value);
  if (!lists.every((list) => Array.isArray(list) && list.every((id) => typeof id === 'string'))) return false;
  const prefix = `${c.path}/@`;
  return (entry.op.changes ?? []).some((other) => other !== c && other.path.startsWith(prefix));
}

/** 撤回的硬上限：一个项目一次最多处理这么多个修改项；超出的不撤，`planRollback` 的 kept 里逐条标原因 `over-limit`，
 * 账本与上报里单独记 `overLimit`（不并进「被别人接着改过而保留」：它们没人改过），网页上另一句话说明。 */
export const ROLLBACK_ITEM_LIMIT = 50_000;

/**
 * 算一个项目的撤回：给出要落地的补偿操作（json-ops）、撤回了哪些修改项、保留了哪些。纯函数。
 * 耗时约 O(n log n)（n 是这个项目历史里的修改记录数）：判「之后有没有别人改过它的上级或下级」用按路径排好序的索引查区间最大值，
 * 不两两比（安全专审 SEC-03：原来两两比，16000 项要 28 秒，整个文档服务的事件循环被占住）。
 *
 * @param {object} input
 * @param {object[]} input.accepted 这个项目全部被接受的操作，按项目历史序号排（`history.accepted(projectId)`）
 * @param {{ value: unknown }} input.current 项目现在的内容（`history.snapshot(projectId)`）
 * @param {(op: object) => boolean} input.isCandidate 哪些操作是这次要撤的（`candidateOf`）
 * @param {number} [input.limit] 修改项上限，缺省 `ROLLBACK_ITEM_LIMIT`
 * @param {(op: object) => boolean} [input.isSelf] 这次撤回自己前几批已经落地的补偿操作（分批撤时用）：它们改过的项算已撤，
 *   它们删掉的东西底下的项跟着没了；它们不算「别人后来改过」
 * @param {number} [input.maxItems] 这一批最多落地几个修改项；剩下的数目回在 `remaining`，下一批再算
 * @returns {{ ops: object[], reverted: {path:string,kind:string}[], kept: {path:string,kind:string,reason:string}[], overLimit: number, remaining: number }}
 */
export function planRollback({ accepted, current, isCandidate, limit = ROLLBACK_ITEM_LIMIT, isSelf = () => false, maxItems = Infinity, maxBytes = Infinity }) {
  const entries = [], selfDone = new Set(), selfRemoved = new Set();
  accepted.forEach((op, i) => {
    const self = Boolean(isSelf(op));
    const cand = !self && Boolean(isCandidate(op));
    for (const c of op.changes ?? []) {
      if (self) { selfDone.add(c.itemKey); if (c.after?.present === false) selfRemoved.add(c.path); continue; }
      entries.push({ i, op, c, cand });
    }
  });
  for (const e of entries) e.ids = isIdStructure(e, current);
  const chains = new Map();
  for (const e of entries) {
    if (!chains.has(e.c.itemKey)) chains.set(e.c.itemKey, []);
    chains.get(e.c.itemKey).push(e);
  }
  const underSelfRemoved = (path) => { if (!selfRemoved.size) return false; for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) if (selfRemoved.has(path.slice(0, cut))) return true; return false; };
  // 别人（非候选）的修改记录的索引：同一路径各种类的最晚一次；按路径排序的数组 + 区间最大值（查下级）
  const latestAt = new Map(); // path → Map(itemKey → { i, ids })
  const others = [];
  for (const e of entries) {
    if (e.cand) continue;
    others.push(e);
    let byKey = latestAt.get(e.c.path);
    if (!byKey) latestAt.set(e.c.path, (byKey = new Map()));
    const prior = byKey.get(e.c.itemKey);
    if (!prior || prior.i < e.i) byKey.set(e.c.itemKey, { i: e.i, ids: e.ids });
  }
  others.sort((a, b) => (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : 0));
  const paths = others.map((e) => e.c.path);
  const maxTable = sparseMax(others.map((e) => e.i));
  const lowerBound = (key) => { let lo = 0, hi = paths.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (paths[mid] < key) lo = mid + 1; else hi = mid; } return lo; };
  /** 别人在第 after 次操作之后，改没改过 path 本身（别的种类）、它的上级（带 id 数组的顺序项除外）、它的下级 */
  function changedAround(path, key, after) {
    for (const [otherKey, row] of latestAt.get(path) ?? []) if (otherKey !== key && row.i > after) return true;
    for (let cut = path.lastIndexOf('/'); cut >= 0; cut = path.lastIndexOf('/', cut - 1)) {
      for (const row of (latestAt.get(path.slice(0, cut)) ?? new Map()).values()) if (row.i > after && !row.ids) return true;
      if (cut === 0) break;
    }
    // 下级：路径以「path/」开头的，在排好序的数组里是连续的一段（'/' 后面紧跟的字符是 '0'）
    const from = lowerBound(path === '' ? '/' : `${path}/`), to = lowerBound(path === '' ? '0' : `${path}0`);
    return from < to && maxTable(from, to - 1) > after;
  }
  const reverts = [], kept = [];
  let overLimit = 0, counted = 0;
  for (const [key, chain] of chains) {
    const mine = chain.filter((e) => e.cand);
    if (!mine.length) continue;
    const head = mine[0];
    // 前几批已经撤过的、或者它的上级已经被前几批撤掉的：不再算（带 id 数组的顺序项除外，增删不等于撤了顺序）
    if ((!head.ids && selfDone.has(key)) || underSelfRemoved(head.c.path)) continue;
    if (head.ids) {
      // 带 id 的数组的「顺序」项：增删由元素那一项管，这里只管换了顺序的。
      if (!mine.some((e) => reordered(e.c.before.value ?? [], e.c.after.value ?? []))) continue;
    } else if (mine.every((e) => same(e.c.before, e.c.after))) continue; // 写了同样的值，没有可撤的
    if (++counted > limit) { overLimit++; kept.push({ path: head.c.path, kind: head.c.kind, reason: 'over-limit' }); continue; }
    let k = chain.length;
    while (k > 0 && chain[k - 1].cand) k--;
    const run = chain.slice(k);
    if (!run.length || same(run[0].c.before, run.at(-1).c.after)) {
      kept.push({ path: head.c.path, kind: head.c.kind, reason: 'changed-after' });
      continue;
    }
    const first = run[0];
    if (!first.ids && changedAround(first.c.path, key, first.i)) {
      kept.push({ path: first.c.path, kind: first.c.kind, reason: 'changed-around' });
      continue;
    }
    reverts.push({ key, path: first.c.path, kind: first.c.kind, target: first.c.before, op: first.op, structure: first.ids, depth: depthOf(first.c.path) });
  }
  // 先上级后下级（先把删掉的片段放回去，再退它里面的属性），顺序项最后。同一层的一起落地（一次 applyOps 只复制一遍经过的容器）。
  reverts.sort((a, b) => Number(a.structure) - Number(b.structure) || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let work = current.value, produced = 0, bytes = 0, stopAt = reverts.length;
  const ops = [], reverted = [], removed = new Set();
  const underRemoved = (path) => { for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) if (removed.has(path.slice(0, cut))) return true; return false; };
  const landed = ({ item, built }) => { ops.push(...built); reverted.push({ path: item.path, kind: item.kind }); if (!item.structure && item.target.present === false) removed.add(item.path); };
  for (let at = 0; at < stopAt;) {
    let end = at;
    while (end < reverts.length && reverts[end].structure === reverts[at].structure && reverts[end].depth === reverts[at].depth) end++;
    const level = [];
    let k = at;
    for (; k < end && produced < maxItems; k++) {
      const item = reverts[k];
      if (underRemoved(item.path)) continue; // 整个上级已经撤掉了，下级跟着没了，不另算
      let built;
      try { built = item.structure ? reorderOps(work, item) : valueOps(work, item); } catch { built = null; }
      if (built === null) { kept.push({ path: item.path, kind: item.kind, reason: 'cannot-apply' }); continue; }
      if (built.length) {
        const size = Buffer.byteLength(JSON.stringify(built));
        if (produced > 0 && bytes + size > maxBytes) break; // 这一批的字节够了：这一项留给下一批
        level.push({ item, built }); produced++; bytes += size;
      }
    }
    let next = null;
    try { next = applyOps(work, level.flatMap((x) => x.built)).root; } catch { next = null; }
    if (next !== null) { work = next; level.forEach(landed); }
    else {
      // 整层落不下（同一层里互相碍着）：逐项试，落不下的记保留
      for (const x of level) {
        try { work = applyOps(work, x.built).root; }
        catch { kept.push({ path: x.item.path, kind: x.item.kind, reason: 'cannot-apply' }); continue; }
        landed(x);
      }
    }
    if (k < end) { stopAt = k; break; } // 这一批够数了：剩下的下一批再算
    at = end;
  }
  const remaining = reverts.length - stopAt;
  return { ops, reverted, kept, overLimit, remaining };
}

/** 区间最大值（稀疏表）：建表 O(n log n)，每次查 O(1)。 */
function sparseMax(values) {
  const table = [values];
  for (let span = 1; span * 2 <= values.length; span *= 2) {
    const prev = table.at(-1), row = new Array(values.length - span * 2 + 1);
    for (let i = 0; i < row.length; i++) row[i] = Math.max(prev[i], prev[i + span]);
    table.push(row);
  }
  return (lo, hi) => { const level = Math.floor(Math.log2(hi - lo + 1)), span = 1 << level; return Math.max(table[level][lo], table[level][hi - span + 1]); };
}

function valueOps(work, item) {
  const segs = parsePath(item.path);
  if (!segs || !segs.length) return null; // 根本身不按项撤
  const now = walk(work, segs), parent = walk(work, segs.slice(0, -1)), last = segs.at(-1);
  const target = item.target;
  if (parent.present && Array.isArray(parent.value)) {
    if (last.id === null || !isIdArray(parent.value)) return null;
    if (!target.present) return now.present ? [{ op: 'remove', path: item.path }] : [];
    if (now.present) return same(now, target) ? [] : [{ op: 'set', path: item.path, value: target.value }];
    const structure = (item.op.changes ?? []).find((c) => c.path === parentOf(item.path) && c.kind === 'structure');
    const beforeIds = structure?.before?.present && Array.isArray(structure.before.value) ? structure.before.value : [last.id];
    return [{ op: 'insert', path: parentOf(item.path), index: insertIndex(parent.value, beforeIds, last.id), value: target.value }];
  }
  if (!target.present) return now.present ? [{ op: 'remove', path: item.path }] : [];
  if (now.present && same(now, target)) return [];
  // 上级不在了：对象的上级 set 会自己补；落在数组元素上的走不通（上面的冲突判断本该已经挡住）。普通数组整个 set 回去。
  return [{ op: 'set', path: item.path, value: target.value }];
}

function reorderOps(work, item) {
  const now = walk(work, parsePath(item.path));
  if (!now.present || !isIdArray(now.value)) return null;
  const ids = now.value.map((el) => el.id), present = new Set(ids);
  const wanted = (item.target.value ?? []).filter((id) => present.has(id)), inWanted = new Set(wanted);
  const order = [...wanted, ...ids.filter((id) => !inWanted.has(id))];
  if (order.every((id, i) => id === ids[i])) return [];
  return order.map((id, index) => ({ op: 'move', path: `${item.path}/${idSegment(id)}`, index }));
}

/** 在一个项目上办撤回：交给这个项目的有序提交（`operation-wiring.mjs` 的 `rollback`，再到项目模块），
 * 它在项目锁里回调 `plan(当前内容)`，这里按同一份操作历史逐项算。内容和操作历史对不上就不撤（等对账）。 */
export function rollbackThrough({ history, coordinator }, { projectId, eventId, accountId, attempt, name, candidate, notify = true,
  limit = ROLLBACK_ITEM_LIMIT, batch = ROLLBACK_BATCH_ITEMS } = {}) {
  if (!candidate || candidate.projectId !== projectId || typeof coordinator?.rollback !== 'function') throw historyError('bad-rollback', 400);
  const isCandidate = candidateOf(candidate);
  // 前几批这次撤回自己落地的补偿操作:算已撤
  const isSelf = (op) => op?.actor?.rollbackEventId === eventId && op.actor.loginId === undefined;
  return coordinator.rollback({ projectId, eventId, accountId, attempt, name, notify, plan: (body) => {
    const current = history.snapshot(projectId);
    if (digest(current.value) !== digest(body)) throw historyError('needs-reconciliation');
    return planRollback({ accepted: history.accepted(projectId), current, isCandidate, isSelf, limit, maxItems: batch, maxBytes: ROLLBACK_BATCH_BYTES });
  } });
}

/**
 * 续办器用的撤回执行器。每次 `run(barrier, proof)` 把这次退出要撤的各项目往下办，全部办完（并把结果报给账号服务）才回 `done: true`；
 * 续办器在那之前不去登记结束见证，所以网页上「设备已退出」出现的时候，那一行撤回结果已经在账号服务那边了。
 *
 * @param {object} options
 * @param {{ read(): object, transaction(fn: (state: object) => any): any }} options.ledger 文档服务账本
 * @param {() => ({ rollbackProject(input: object): Promise<object> } | null)} options.operations 文档服务的有序提交（`doc-assembly.mjs`）
 * @param {(eventId: string, body: object) => Promise<unknown>} [options.report] 把「撤了几处、保留几处」报给账号服务
 */
export function createLogoutRollback({ ledger, operations, report = null, now = Date.now, onDiagnostic = () => {},
  itemLimit = ROLLBACK_ITEM_LIMIT, batchItems = ROLLBACK_BATCH_ITEMS } = {}) {
  if (typeof ledger?.read !== 'function' || typeof ledger?.transaction !== 'function' || typeof operations !== 'function')
    throw accountError(503, 'logout-rollback-configuration');
  const note = (eventId, code, extra = {}) => onDiagnostic({ code, eventId, ...extra });
  const save = (eventId, fn) => ledger.transaction((state) => {
    const rows = state.logoutRollbacksV1 ??= {};
    const out = fn(rows, state);
    return out === undefined ? structuredClone(rows[eventId] ?? null) : out;
  });
  const nameOf = (state, projectId, accountId) => {
    const project = state.projects?.[projectId];
    const name = project?.members?.[accountId]?.accountNameAtJoin ?? project?.bans?.[accountId]?.accountNameAtJoin;
    return typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\u0000-\u001f]/.test(name) ? name : null;
  };

  async function settle(row) {
    if (row.reported || !(row.totals.reverted + row.totals.kept + (row.totals.overLimit ?? 0) > 0)) return true;
    if (typeof report !== 'function') return true;
    try {
      await report(row.eventId, { reportId: `logout-rollback:${row.eventId}`, version: ROLLBACK_VERSION,
        // 三个数分开：kept 只算「真的被别人接着改过所以保留」，超过上限没撤的单独是 overLimit（网页上另一句话）
        reverted: row.totals.reverted, kept: row.totals.kept, overLimit: row.totals.overLimit ?? 0, projects: row.totals.projects });
      save(row.eventId, (rows) => { rows[row.eventId].reported = true; rows[row.eventId].reportedAt = now(); });
      return true;
    } catch (error) {
      note(row.eventId, `logout-rollback-report-${error.code ?? 'failed'}`);
      return false;
    }
  }

  /** 把一次退出的撤回往下办一步。回 `{ done }`；没办完的下一轮再来，不放弃也不跳过。 */
  async function run(barrier, proof) {
    let row = ledger.read().logoutRollbacksV1?.[barrier.eventId];
    if (row?.state === 'done' || row?.state === 'not-applicable') return { done: await settle(row), row: structuredClone(row) };
    const state = ledger.read();
    if (!row) {
      const event = rollbackEventOf(state, barrier.eventId);
      if (!event) {
        // 网站上直接退出登录、删账号：没有「改完密码到选退出之间」，不撤。
        row = save(barrier.eventId, (rows) => { rows[barrier.eventId] ??= { eventId: barrier.eventId, state: 'not-applicable', version: ROLLBACK_VERSION,
          totals: { reverted: 0, kept: 0, projects: 0 }, at: now() }; });
        return { done: true, row };
      }
      const list = (proof?.projectCursors ?? []).map((cursor) => ({ projectId: cursor.projectId, endSeq: cursor.lastAcceptedOrderSeq }))
        .filter((cursor) => Number.isSafeInteger(cursor.endSeq) && cursor.endSeq > event.changeSeq);
      row = save(barrier.eventId, (rows) => { rows[barrier.eventId] ??= { eventId: barrier.eventId, state: 'running', version: ROLLBACK_VERSION,
        accountId: event.accountId, changeSeq: event.changeSeq, loginIds: event.loginIds, accessEventId: event.accessEventId,
        cursors: list, projects: {}, startedAt: now() }; });
    }
    const coordinator = operations();
    if (cursors(row).length && typeof coordinator?.rollbackProject !== 'function') { note(row.eventId, 'logout-rollback-order-unavailable'); return { done: false, row }; }
    const retained = retainedRunsOf(ledger.read(), row.accessEventId);
    let pending = false;
    for (const cursor of cursors(row)) {
      // 一个项目分几批撤（每批一次补偿操作、一个号）；批与批之间让出事件循环，别的项目、别的连接不被冻住
      for (let parts = 0; row.projects[cursor.projectId]?.state !== 'done'; parts++) {
        if (parts) await yieldLoop();
        const prior = row.projects[cursor.projectId] ?? {};
        const attempt = prior.attempt ?? 1, doneSoFar = prior.reverted ?? 0;
        let outcome;
        try {
          outcome = await coordinator.rollbackProject({ projectId: cursor.projectId, eventId: row.eventId, accountId: row.accountId, attempt,
            name: nameOf(ledger.read(), cursor.projectId, row.accountId), notify: !prior.notice || prior.notice === 'none',
            limit: Math.max(0, itemLimit - doneSoFar), batch: batchItems,
            candidate: { projectId: cursor.projectId, loginIds: row.loginIds, changeSeq: row.changeSeq, endSeq: cursor.endSeq, retained } });
        } catch (error) {
          if (['operation-fenced', 'project-not-found', 'projection-unavailable-deleted'].includes(error.code) || error.status === 404) {
            // 项目已经删了：没有东西可撤，也没人收得到气泡
            outcome = { state: 'done', reverted: [], kept: [], opId: null, remaining: 0, gone: true };
          } else if (error.code === 'operation-id-mismatch') {
            // 这个号已经被别的提交用过（前缀保留之前留下的老数据）：换下一个号，不卡在这里
            outcome = { state: 'cancelled' };
            note(row.eventId, 'logout-rollback-op-id-taken', { projectId: cursor.projectId });
          } else { note(row.eventId, `logout-rollback-${error.code ?? 'failed'}`, { projectId: cursor.projectId }); pending = true; break; }
        }
        row = save(row.eventId, (rows) => {
          const target = rows[row.eventId], was = target.projects[cursor.projectId] ?? {};
          if (outcome.state === 'cancelled') { target.projects[cursor.projectId] = { ...was, state: 'running', attempt: attempt + 1 }; return; }
          const reverted = (was.reverted ?? 0) + outcome.reverted.length;
          // 有剩下的却一笔都没落地（这一批全落不下）：不再空转，剩下的数目记成保留（over-limit），不悄悄丢
          const finished = !(outcome.remaining > 0) || !outcome.opId;
          const stranded = finished && outcome.remaining > 0 ? outcome.remaining : 0;
          const notice = was.notice && was.notice !== 'none' ? was.notice
            // 气泡：发给了此刻在线的成员 / 没人在线 / 重启后认出已落地的同一次（不补发，语义「不在线的不补弹」）
            : !outcome.reverted.length ? 'none' : outcome.duplicate ? 'not-resent' : outcome.notified ? 'sent' : 'nobody-online';
          target.projects[cursor.projectId] = { ...was, state: finished ? 'done' : 'running', attempt: outcome.opId ? attempt + 1 : attempt,
            lastOpId: outcome.opId ?? was.lastOpId ?? null, parts: (was.parts ?? 0) + (outcome.opId ? 1 : 0), reverted, notice, gone: Boolean(outcome.gone),
            revertedPaths: [...(was.revertedPaths ?? []), ...outcome.reverted.map((item) => clipPath(item.path))].slice(0, ROLLBACK_PATHS_KEPT),
            // kept 不含超过上限没撤的（它们没人改过）；那些单独记 overLimit
            ...(finished ? { kept: outcome.kept.filter((item) => item.reason !== 'over-limit').length, overLimit: (outcome.overLimit ?? 0) + stranded,
              keptPaths: outcome.kept.slice(0, ROLLBACK_PATHS_KEPT).map((item) => `${item.reason}:${clipPath(item.path)}`) } : {}),
            at: now() };
        });
        if (outcome.state === 'cancelled') { pending = true; break; }
        if (outcome.overLimit) note(row.eventId, 'logout-rollback-over-limit', { projectId: cursor.projectId, overLimit: outcome.overLimit });
      }
    }
    if (pending || cursors(row).some((cursor) => row.projects[cursor.projectId]?.state !== 'done')) return { done: false, row };
    row = save(row.eventId, (rows) => {
      const target = rows[row.eventId];
      const done = Object.values(target.projects);
      target.totals = { reverted: done.reduce((n, p) => n + p.reverted, 0), kept: done.reduce((n, p) => n + p.kept, 0),
        projects: done.filter((p) => p.reverted > 0).length, overLimit: done.reduce((n, p) => n + (p.overLimit ?? 0), 0) };
      target.state = 'done'; target.doneAt = now();
    });
    onDiagnostic({ code: 'logout-rollback-done', eventId: row.eventId, reverted: row.totals.reverted, kept: row.totals.kept });
    return { done: await settle(row), row };
  }
  const cursors = (row) => row.cursors ?? [];
  return { run, status: (eventId) => structuredClone(ledger.read().logoutRollbacksV1?.[eventId] ?? null) };
}
