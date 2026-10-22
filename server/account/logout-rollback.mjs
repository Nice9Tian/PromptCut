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
import { canonical } from '../docservice/modules/operation-history.mjs';
import { accountError } from './client.mjs';

export const ROLLBACK_VERSION = '0.7.20';
/** 账本里每个项目留几条撤回 / 保留的路径（只给排查用；数目另记全数） */
export const ROLLBACK_PATHS_KEPT = 50;

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

function walk(root, segs) {
  let node = root;
  for (const seg of segs) {
    if (Array.isArray(node)) {
      if (seg.id === null) return { present: false };
      const found = node.find((el) => el && typeof el === 'object' && !Array.isArray(el) && el.id === seg.id);
      if (!found) return { present: false };
      node = found;
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
  const at = beforeIds.indexOf(id);
  for (let k = at - 1; k >= 0; k--) {
    const index = current.findIndex((el) => el?.id === beforeIds[k]);
    if (index >= 0) return index + 1;
  }
  return 0;
}

/** 两个 id 序列里共同的那些 id，相对顺序是不是变了（只增删不算换顺序） */
function reordered(before, after) {
  const common = new Set(after.filter((id) => before.includes(id)));
  const a = before.filter((id) => common.has(id)), b = after.filter((id) => common.has(id));
  return canonical(a) !== canonical(b);
}

/**
 * 算一个项目的撤回：给出要落地的补偿操作（json-ops）、撤回了哪些修改项、保留了哪些。纯函数。
 *
 * @param {object} input
 * @param {object[]} input.accepted 这个项目全部被接受的操作，按项目历史序号排（`history.accepted(projectId)`）
 * @param {{ value: unknown }} input.current 项目现在的内容（`history.snapshot(projectId)`）
 * @param {(op: object) => boolean} input.isCandidate 哪些操作是这次要撤的（`candidateOf`）
 * @returns {{ ops: object[], reverted: {path:string,kind:string}[], kept: {path:string,kind:string,reason:string}[] }}
 */
export function planRollback({ accepted, current, isCandidate }) {
  const entries = [];
  accepted.forEach((op, i) => {
    const cand = Boolean(isCandidate(op));
    for (const c of op.changes ?? []) entries.push({ i, op, c, cand });
  });
  const chains = new Map();
  for (const e of entries) {
    if (!chains.has(e.c.itemKey)) chains.set(e.c.itemKey, []);
    chains.get(e.c.itemKey).push(e);
  }
  const reverts = [], kept = [];
  for (const [key, chain] of chains) {
    const mine = chain.filter((e) => e.cand);
    if (!mine.length) continue;
    const head = mine[0].c;
    if (head.kind === 'structure' && isIdList(head)) {
      // 带 id 的数组的「顺序」项：增删由元素那一项管，这里只管换了顺序的。
      if (!mine.some((e) => reordered(e.c.before.value ?? [], e.c.after.value ?? []))) continue;
    } else if (mine.every((e) => same(e.c.before, e.c.after))) continue; // 写了同样的值，没有可撤的
    let k = chain.length;
    while (k > 0 && chain[k - 1].cand) k--;
    const run = chain.slice(k);
    if (!run.length || same(run[0].c.before, run.at(-1).c.after)) {
      kept.push({ path: head.path, kind: head.kind, reason: 'changed-after' });
      continue;
    }
    const first = run[0];
    if (first.c.kind !== 'structure' || !isIdList(first.c)) {
      // 之后别人改过它的上级或下级：上级的「顺序」项不算（别人往同一个数组里加了别的元素不碍事，元素自己那一项会记增删）
      const clash = entries.some((e) => !e.cand && e.i > first.i && e.c.itemKey !== key && related(first.c.path, e.c.path) &&
        !(e.c.kind === 'structure' && isIdList(e.c) && under(e.c.path, first.c.path)));
      if (clash) { kept.push({ path: first.c.path, kind: first.c.kind, reason: 'changed-around' }); continue; }
    }
    reverts.push({ key, path: first.c.path, kind: first.c.kind, target: first.c.before, op: first.op, structure: first.c.kind === 'structure' && isIdList(first.c) });
  }
  // 先上级后下级（先把删掉的片段放回去，再退它里面的属性），顺序项最后
  reverts.sort((a, b) => Number(a.structure) - Number(b.structure) || depthOf(a.path) - depthOf(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let work = current.value;
  const ops = [], reverted = [], removed = [];
  for (const item of reverts) {
    if (removed.some((path) => under(path, item.path))) continue; // 整个上级已经撤掉了，下级跟着没了，不另算
    let built;
    try { built = item.structure ? reorderOps(work, item) : valueOps(work, item); } catch { built = null; }
    if (built === null) { kept.push({ path: item.path, kind: item.kind, reason: 'cannot-apply' }); continue; }
    if (!built.length) continue;
    try { work = applyOps(work, built).root; }
    catch { kept.push({ path: item.path, kind: item.kind, reason: 'cannot-apply' }); continue; }
    ops.push(...built);
    reverted.push({ path: item.path, kind: item.kind });
    if (!item.structure && item.target.present === false) removed.push(item.path);
  }
  return { ops, reverted, kept };
}

function isIdList(change) {
  const list = change.before?.present ? change.before.value : change.after?.value;
  return Array.isArray(list) && list.every((id) => typeof id === 'string');
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
  // 上级不在了：对象的上级 set 会自己补；落在数组元素上的走不通（上面的冲突判断本该已经挡住）
  return [{ op: 'set', path: item.path, value: target.value }];
}

function reorderOps(work, item) {
  const now = walk(work, parsePath(item.path));
  if (!now.present || !isIdArray(now.value)) return null;
  const ids = now.value.map((el) => el.id);
  const wanted = (item.target.value ?? []).filter((id) => ids.includes(id));
  const order = [...wanted, ...ids.filter((id) => !wanted.includes(id))];
  if (canonical(order) === canonical(ids)) return [];
  return order.map((id, index) => ({ op: 'move', path: `${item.path}/${idSegment(id)}`, index }));
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
export function createLogoutRollback({ ledger, operations, report = null, now = Date.now, onDiagnostic = () => {} } = {}) {
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
    if (row.reported || !(row.totals.reverted + row.totals.kept > 0)) return true;
    if (typeof report !== 'function') return true;
    try {
      await report(row.eventId, { reportId: `logout-rollback:${row.eventId}`, version: ROLLBACK_VERSION,
        reverted: row.totals.reverted, kept: row.totals.kept, projects: row.totals.projects });
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
      const prior = row.projects[cursor.projectId];
      if (prior?.state === 'done') continue;
      const attempt = prior?.attempt ?? 1;
      let outcome;
      try {
        outcome = await coordinator.rollbackProject({ projectId: cursor.projectId, eventId: row.eventId, accountId: row.accountId, attempt,
          name: nameOf(ledger.read(), cursor.projectId, row.accountId),
          candidate: { projectId: cursor.projectId, loginIds: row.loginIds, changeSeq: row.changeSeq, endSeq: cursor.endSeq, retained } });
      } catch (error) {
        if (['operation-fenced', 'project-not-found', 'projection-unavailable-deleted'].includes(error.code) || error.status === 404) {
          // 项目已经删了：没有东西可撤，也没人收得到气泡
          outcome = { state: 'done', reverted: [], kept: [], opId: null, gone: true };
        } else { note(row.eventId, `logout-rollback-${error.code ?? 'failed'}`, { projectId: cursor.projectId }); pending = true; continue; }
      }
      row = save(row.eventId, (rows) => {
        const target = rows[row.eventId];
        if (outcome.state === 'cancelled') target.projects[cursor.projectId] = { state: 'retry', attempt: attempt + 1 };
        else target.projects[cursor.projectId] = { state: 'done', attempt, opId: outcome.opId ?? null,
          reverted: outcome.reverted.length, kept: outcome.kept.length, gone: Boolean(outcome.gone),
          notified: outcome.notified === true ? true : outcome.reverted.length ? 'lost' : false,
          revertedPaths: outcome.reverted.slice(0, ROLLBACK_PATHS_KEPT).map((item) => item.path),
          keptPaths: outcome.kept.slice(0, ROLLBACK_PATHS_KEPT).map((item) => `${item.reason}:${item.path}`), at: now() };
      });
      if (outcome.state === 'cancelled') pending = true;
    }
    if (pending || cursors(row).some((cursor) => row.projects[cursor.projectId]?.state !== 'done')) return { done: false, row };
    row = save(row.eventId, (rows) => {
      const target = rows[row.eventId];
      const done = Object.values(target.projects);
      target.totals = { reverted: done.reduce((n, p) => n + p.reverted, 0), kept: done.reduce((n, p) => n + p.kept, 0),
        projects: done.filter((p) => p.reverted > 0).length };
      target.state = 'done'; target.doneAt = now();
    });
    onDiagnostic({ code: 'logout-rollback-done', eventId: row.eventId, reverted: row.totals.reverted, kept: row.totals.kept });
    return { done: await settle(row), row };
  }
  const cursors = (row) => row.cursors ?? [];
  return { run, status: (eventId) => structuredClone(ledger.read().logoutRollbacksV1?.[eventId] ?? null) };
}
