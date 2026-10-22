/**
 * 改密退出的逐项撤回：算法（纯函数）。语义 `product/document-service.md`「冲突」「保存与延迟退出的修改处理」。
 *
 * LP-01 只撤「改完密码到选退出之间、旧登录做的」：别人的、新登录的、旧登录改密之前的、区间终点之后的一样不碰（安全论证 1）
 * LP-02 逐项判冲突：同一个片段里，别人之后改过的属性保留、没改过的照撤；不是整份回退（安全论证 2）
 * LP-03 增删：旧登录新加的片段整个撤掉；别人往里改过的不撤；旧登录删掉的片段放回原位，连同删之前在区间里改的属性一起退回
 * LP-04 上级被别人删了：下级的修改算冲突、保留（不会把删掉的东西改活）
 * LP-05 同一项「旧登录 → 别人 → 旧登录」：只撤最后一段，退回到别人的值
 * LP-06 Agent 已读消息例外：保留下来的共有已读任务做的修改不撤；私有任务（被中止的）在区间里做的照撤（安全论证 3）
 * LP-07 换了顺序：撤回到原顺序；之后别人又动过这个数组的，顺序保留
 * LP-08 写了同样的值、没有区间里的操作：什么都不做，也不计数
 * LP-09 只认「改密码后选退出」：网站上直接退出、删账号产生的作废不撤（rollbackEventOf）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../docservice/json-ops.mjs';
import { recordChanges, itemKey } from '../docservice/modules/operation-history.mjs';
import { planRollback, candidateOf, rollbackEventOf, retainedRunsOf } from '../account/logout-rollback.mjs';

const OLD = { accountId: 'acc_a', loginId: 'login-old' };
const NEW = { accountId: 'acc_a', loginId: 'login-new' };
const OTHER = { accountId: 'acc_b', loginId: 'login-b' };

/** 照文档服务的操作历史造一串被接受的操作：每步 [写入身份, 顺序号, json-ops, 额外字段] */
function history(initial, steps) {
  let value = structuredClone(initial); const versions = {}; const accepted = [];
  steps.forEach(([actor, orderSeq, ops, extra = {}], i) => {
    const after = applyOps(value, ops).root;
    const changes = recordChanges(value, after, { ops, versions, nextVersion: `${i + 2}:op${i}` });
    for (const c of changes) versions[c.itemKey] = c.afterVersion;
    accepted.push({ opId: `op${i}`, projectId: 'p1', projectRev: i + 2, state: 'materialized', actor, changes,
      witness: { orderSeq, ...(extra.authorization ? { authorization: extra.authorization } : {}) } });
    value = after;
  });
  return { accepted, current: { value, versions } };
}
const project = () => ({ name: '演示', fps: 30,
  tracks: [{ id: 't1', clips: [{ id: 'c1', start: 0, end: 2, opacity: 0.4 }, { id: 'c2', start: 3, end: 5, opacity: 1 }, { id: 'c3', start: 6, end: 8, opacity: 1 }] }] });
const C1 = '/tracks/@t1/clips/@c1', C2 = '/tracks/@t1/clips/@c2', C3 = '/tracks/@t1/clips/@c3';
const window = (extra = {}) => candidateOf({ projectId: 'p1', loginIds: ['login-old'], changeSeq: 10, endSeq: 20, ...extra });
const plan = (h, isCandidate = window()) => {
  const out = planRollback({ accepted: h.accepted, current: h.current, isCandidate });
  return { ...out, result: out.ops.length ? applyOps(h.current.value, out.ops).root : h.current.value };
};
const clip = (value, id) => value.tracks[0].clips.find((c) => c.id === id);

test('LP-01 只撤区间里旧登录的修改:别人的、新登录的、改密之前的、终点之后的都不碰', () => {
  const h = history(project(), [
    [OLD, 5, [{ op: 'set', path: '/name', value: '改密前旧登录改的' }]],
    [OLD, 11, [{ op: 'set', path: `${C1}/opacity`, value: 0.9 }]],
    [OTHER, 12, [{ op: 'set', path: `${C2}/opacity`, value: 0.5 }]],
    [NEW, 13, [{ op: 'set', path: `${C3}/opacity`, value: 0.6 }]],
    [OLD, 14, [{ op: 'set', path: '/fps', value: 25 }]],
    [OLD, 21, [{ op: 'set', path: `${C3}/start`, value: 7 }]],
  ]);
  const { result, reverted, kept } = plan(h);
  assert.equal(result.name, '改密前旧登录改的', '改密之前的不撤');
  assert.equal(clip(result, 'c1').opacity, 0.4, '区间里旧登录改的撤回');
  assert.equal(result.fps, 30, '区间里旧登录改的撤回');
  assert.equal(clip(result, 'c2').opacity, 0.5, '别人的不碰');
  assert.equal(clip(result, 'c3').opacity, 0.6, '同一账号新登录的不碰');
  assert.equal(clip(result, 'c3').start, 7, '区间终点之后的(只会是保留下来的任务)不碰');
  assert.deepEqual(reverted.map((r) => r.path).sort(), [`${C1}/opacity`, '/fps'].sort());
  assert.equal(kept.length, 0);
});

test('LP-02 逐项判冲突:同一片段里别人后来改过的属性保留,没改过的照撤', () => {
  const h = history(project(), [
    [OLD, 11, [{ op: 'set', path: `${C1}/opacity`, value: 0.9 }, { op: 'set', path: `${C1}/end`, value: 3 }]],
    [OTHER, 12, [{ op: 'set', path: `${C1}/opacity`, value: 0.7 }]],
  ]);
  const { result, reverted, kept } = plan(h);
  assert.equal(clip(result, 'c1').end, 2, '长度没人再改:撤回');
  assert.equal(clip(result, 'c1').opacity, 0.7, '透明度别人又改过:保留现状');
  assert.deepEqual(reverted.map((r) => r.path), [`${C1}/end`]);
  assert.deepEqual(kept.map((k) => [k.path, k.reason]), [[`${C1}/opacity`, 'changed-after']]);
  assert.equal(result.tracks[0].clips.length, 3, '不是整份回退:别的片段原样');
});

test('LP-03 增删:新加的撤掉、别人改过的新片段保留;删掉的放回原位并退回删之前改的属性', () => {
  const added = history(project(), [
    [OLD, 11, [{ op: 'insert', path: '/tracks/@t1/clips', index: 1, value: { id: 'n1', start: 9, end: 10 } },
      { op: 'insert', path: '/tracks/@t1/clips', index: 1, value: { id: 'n2', start: 11, end: 12 } }]],
    [OTHER, 12, [{ op: 'set', path: '/tracks/@t1/clips/@n2/end', value: 13 }]],
  ]);
  const a = plan(added);
  assert.deepEqual(a.result.tracks[0].clips.map((c) => c.id), ['c1', 'n2', 'c2', 'c3'], 'n1 撤掉;n2 别人接着改过,保留');
  assert.deepEqual(a.reverted.map((r) => r.path), ['/tracks/@t1/clips/@n1']);
  assert.deepEqual(a.kept.map((k) => [k.path, k.reason]), [['/tracks/@t1/clips/@n2', 'changed-around']]);

  const removed = history(project(), [
    [OLD, 11, [{ op: 'set', path: `${C2}/opacity`, value: 0.2 }]],
    [OTHER, 12, [{ op: 'insert', path: '/tracks/@t1/clips', index: 0, value: { id: 'x', start: 20, end: 21 } }]],
    [OLD, 13, [{ op: 'remove', path: C2 }]],
  ]);
  const r = plan(removed);
  assert.deepEqual(r.result.tracks[0].clips.map((c) => c.id), ['x', 'c1', 'c2', 'c3'], 'c2 放回 c1 后面;别人加的 x 不动');
  assert.equal(clip(r.result, 'c2').opacity, 1, '删之前在区间里改的透明度一起退回');
  assert.equal(r.kept.length, 0);
});

test('LP-04 上级被别人删了:下级的修改算冲突、保留,不会把删掉的东西改活', () => {
  const h = history(project(), [
    [OLD, 11, [{ op: 'set', path: `${C1}/opacity`, value: 0.9 }]],
    [OTHER, 12, [{ op: 'remove', path: C1 }]],
  ]);
  const { result, reverted, kept, ops } = plan(h);
  assert.equal(ops.length, 0); assert.equal(reverted.length, 0);
  assert.equal(clip(result, 'c1'), undefined, 'c1 仍是别人删掉的样子');
  assert.deepEqual(kept.map((k) => [k.path, k.reason]), [[`${C1}/opacity`, 'changed-around']]);
});

test('LP-05 同一项「旧登录 → 别人 → 旧登录」:只撤最后一段,退回到别人的值', () => {
  const h = history(project(), [
    [OLD, 11, [{ op: 'set', path: '/name', value: 'A' }]],
    [OTHER, 12, [{ op: 'set', path: '/name', value: 'B' }]],
    [OLD, 13, [{ op: 'set', path: '/name', value: 'C' }]],
  ]);
  const { result, reverted } = plan(h);
  assert.equal(result.name, 'B'); assert.equal(reverted.length, 1);
});

test('LP-06 Agent 已读消息例外:保留下来的共有已读任务的修改不撤,私有任务的照撤', () => {
  const sharedRun = { ...OLD, runGrantId: 'g-shared', runId: 'r-shared', messageId: 'm1', conversationId: 'conv-shared' };
  const privateRun = { ...OLD, runGrantId: 'g-private', runId: 'r-private', messageId: 'm2', conversationId: 'conv-private' };
  const h = history(project(), [
    [sharedRun, 11, [{ op: 'set', path: `${C1}/opacity`, value: 0.9 }]],
    [privateRun, 12, [{ op: 'set', path: `${C2}/opacity`, value: 0.1 }]],
    [{ ...sharedRun }, 15, [{ op: 'set', path: `${C3}/opacity`, value: 0.3 }], { authorization: { kind: 'retained' } }],
  ]);
  const retained = [{ projectId: 'p1', runGrantId: 'g-shared', runId: 'r-shared', messageId: 'm1', conversationId: 'conv-shared', accountId: 'acc_a', loginId: 'login-old' }];
  const { result } = plan(h, window({ retained }));
  assert.equal(clip(result, 'c1').opacity, 0.9, '共有已读、保留继续的当前任务:它的修改不撤');
  assert.equal(clip(result, 'c3').opacity, 0.3, '凭保留证明定序的:不撤');
  assert.equal(clip(result, 'c2').opacity, 1, '私有任务(已中止)在区间里做的:撤回');
  // 关联要精确:同一个授权号但换了消息号的,不算保留的那个任务
  const forged = history(project(), [[{ ...sharedRun, messageId: 'other' }, 11, [{ op: 'set', path: `${C1}/opacity`, value: 0.9 }]]]);
  assert.equal(clip(plan(forged, window({ retained })).result, 'c1').opacity, 0.4);
});

test('LP-07 换顺序:撤回到原顺序;之后别人动过这个数组的,顺序保留', () => {
  const moved = history(project(), [[OLD, 11, [{ op: 'move', path: C3, index: 0 }]]]);
  const m = plan(moved);
  assert.deepEqual(m.result.tracks[0].clips.map((c) => c.id), ['c1', 'c2', 'c3']);
  assert.deepEqual(m.reverted.map((r) => r.kind), ['structure']);
  const later = history(project(), [
    [OLD, 11, [{ op: 'move', path: C3, index: 0 }]],
    [OTHER, 12, [{ op: 'insert', path: '/tracks/@t1/clips', index: 3, value: { id: 'y', start: 30, end: 31 } }]],
  ]);
  const l = plan(later);
  assert.deepEqual(l.result.tracks[0].clips.map((c) => c.id), ['c3', 'c1', 'c2', 'y']);
  assert.deepEqual(l.kept.map((k) => k.reason), ['changed-after']);
});

test('LP-08 写了同样的值、或区间里没有旧登录的操作:不落地、不计数', () => {
  const h = history(project(), [[OLD, 11, [{ op: 'set', path: '/name', value: '演示' }]], [OTHER, 12, [{ op: 'set', path: '/fps', value: 24 }]]]);
  const out = plan(h);
  assert.deepEqual([out.ops.length, out.reverted.length, out.kept.length], [0, 0, 0]);
  assert.equal(itemKey('/name'), itemKey('/name'));
});

test('LP-09 只认「改密码后选了退出」;网站上直接退出登录、删账号不撤', () => {
  const base = { accountEvents: {}, barriers: {}, revokedLogins: {}, runControlsV2: {}, runGrantsV2: {} };
  const changed = { type: 'password-changed', eventId: 'pw_1', accountId: 'acc_a', changeSeq: 10, oldLoginIds: ['login-old'] };
  const revoked = { ...changed, type: 'credentials-revoked', revokedLoginIds: ['login-old'] };
  const state = { ...base, accountEvents: { 1: { event: changed }, 2: { event: revoked } },
    barriers: { 'event:pw_1': { eventId: 'pw_1', loginIds: ['login-old'], accessEventId: 'ae1' } },
    revokedLogins: { 'login:login-old': { eventId: 'pw_1' } },
    runControlsV2: { k: { requestId: 'access:ae1', retained: ['g'] } },
    runGrantsV2: { g: { projectId: 'p1', runGrantId: 'g', runId: 'r', messageId: 'm', conversationId: 'c', accountId: 'acc_a', loginId: 'login-old' } } };
  assert.deepEqual(rollbackEventOf(state, 'pw_1'), { eventId: 'pw_1', accountId: 'acc_a', changeSeq: 10, loginIds: ['login-old'], accessEventId: 'ae1' });
  assert.equal(retainedRunsOf(state, 'ae1').length, 1);
  const logout = { ...base, accountEvents: { 1: { event: { ...revoked, eventId: 'logout_1' } } },
    barriers: { 'event:logout_1': { eventId: 'logout_1', loginIds: ['login-old'], accessEventId: 'ae2' } },
    revokedLogins: { 'login:login-old': { eventId: 'logout_1' } } };
  assert.equal(rollbackEventOf(logout, 'logout_1'), null, '直接退出登录:没有改密事件');
  assert.equal(rollbackEventOf({ ...state, revokedLogins: {} }, 'pw_1'), null, '登录还没作废:不撤');
});

test('LP-10 普通数组(词表、原本为空的数组)按整个数组撤;别人之后改过的进保留,不悄悄漏掉(安全专审 SEC-02)', () => {
  const W = '/tracks/@t1/clips/@c1/words', L = '/tracks/@t1/clips/@c1/lines';
  const base = () => ({ tracks: [{ id: 't1', clips: [{ id: 'c1', words: ['开场', '欢迎'], lines: [] }] }] });
  const h = history(base(), [
    [OLD, 11, [{ op: 'set', path: W, value: ['开场', '改了'] }]],
    [OLD, 12, [{ op: 'set', path: L, value: [{ start: 0, end: 1, text: '加了' }] }]],
  ]);
  const { result, reverted } = plan(h);
  assert.deepEqual(clip(result, 'c1').words, ['开场', '欢迎'], '词表整个退回');
  assert.deepEqual(clip(result, 'c1').lines, [], '原本为空的数组退回为空');
  assert.deepEqual(reverted.map((r) => r.path).sort(), [L, W].sort());
  const later = history(base(), [
    [OLD, 11, [{ op: 'set', path: W, value: ['开场', '改了'] }]],
    [OTHER, 12, [{ op: 'set', path: W, value: ['别人', '又改'] }]],
  ]);
  const k = plan(later);
  assert.deepEqual(clip(k.result, 'c1').words, ['别人', '又改']);
  assert.deepEqual(k.kept.map((x) => [x.path, x.reason]), [[W, 'changed-after']], '冲突的记进保留');
});

test('LP-11 上限与分批(安全专审 SEC-03):超过上限的逐条记进保留(over-limit);一批只落一部分,剩下的数目回在 remaining,前几批落过的不再算', () => {
  const ops = Array.from({ length: 30 }, (_, i) => ({ op: 'set', path: `/name${i}`, value: i }));
  const h = history(project(), [[OLD, 11, ops]]);
  const capped = planRollback({ accepted: h.accepted, current: h.current, isCandidate: window(), limit: 20 });
  assert.equal(capped.reverted.length, 20); assert.equal(capped.overLimit, 10);
  assert.equal(capped.kept.filter((k) => k.reason === 'over-limit').length, 10, '超出的不悄悄丢');
  const first = planRollback({ accepted: h.accepted, current: h.current, isCandidate: window(), maxItems: 12 });
  assert.equal(first.reverted.length, 12); assert.equal(first.remaining, 18);
  // 第一批作为这次撤回自己的补偿操作落地以后再算:落过的算已撤,只剩 18 项
  const after = applyOps(h.current.value, first.ops).root;
  const self = { accountId: 'acc_a', rollbackEventId: 'pw_1' };
  const h2 = history(project(), [[OLD, 11, ops], [self, 12, first.ops]]);
  assert.deepEqual(h2.current.value, after);
  const second = planRollback({ accepted: h2.accepted, current: h2.current, isCandidate: window(), maxItems: 12,
    isSelf: (op) => op.actor.rollbackEventId === 'pw_1' });
  assert.deepEqual([second.reverted.length, second.remaining, second.kept.length], [12, 6, 0], '前一批落过的不算冲突,也不重算');
});
