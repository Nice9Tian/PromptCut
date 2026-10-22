/**
 * 重开文件时「这个账号不是这个云端项目的成员」那条提示(语义 `workflow/project.md` 第 44 行,2026-10-22 用户定):
 * 项目只放账号名单时,提示里另有「发送申请」按钮(`src/editor/sync/recoveryAssociation.ts` 的 `notMemberToast`)。
 *
 *   RJR-1 只放名单、没申请过:提示带「发送申请」;点了发申请,另起一条「已发送，等创建者通过」;以本地副本打开、保留关联
 *   RJR-2 没收到回包再点:沿用原请求号;明确被拒(如次数用完)后再点:换新请求号;一次只发一个
 *   RJR-3 已经在等、被拒且次数用完:不给按钮,把现状接在后面说
 *   RJR-4 知道链接就能进的项目、被踢(banned)、问不到申请状态、老客户端没有这两个方法:照旧只有那一句,不带按钮
 */
import '../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { handleCloudAssociationReopen, currentCloudAssociation, setCloudAssociation } = await import('../editor/sync/recoveryAssociation.ts');

const projectId = 'sp_' + 'q'.repeat(26);
const assoc = { accountProject: true, projectId, docServiceUrl: 'https://visuhive.com/hosted/', origin: 'https://visuhive.com', savedRev: 3, savedAt: new Date().toISOString() };
const project = { id: 'p-local-copy', name: '本地副本', tracks: [] };
const fail = (status, code) => Object.assign(new Error(code), { status, code, message: code === 'join-request-limit' ? '这个项目你最近申请得太多了，请过一段时间再申请。' : code });

async function reopen({ code = 'not-listed', status = { state: 'none', entry: 'list', canApply: true }, send, client: extra = {} } = {}) {
  const toasts = [], calls = { status: 0, send: [] };
  let opened = null;
  const client = {
    session: async () => { throw fail(403, code); },
    joinRequestStatus: async id => { calls.status++; assert.equal(id, projectId); if (status instanceof Error) throw status; return { projectId, ...status }; },
    sendJoinRequest: async (id, requestId) => { calls.send.push(requestId); assert.equal(id, projectId); return send ? send(calls.send.length) : { projectId, state: 'pending', entry: 'list', canApply: false }; },
    ...extra,
  };
  const result = await handleCloudAssociationReopen(project, assoc, {
    account: { id: 'acc_' + '9'.repeat(24), name: '路人' }, client,
    toast: (text, tone, ms, action) => toasts.push({ text, tone, ms, action }),
    openAsLocal: p => { opened = p; },
  });
  return { result, toasts, calls, opened };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('RJR-1 只放名单、没申请过:提示带「发送申请」;点了发申请,另起一条「已发送，等创建者通过」', async () => {
  setCloudAssociation(null);
  const r = await reopen();
  assert.equal(r.result.status, 'forbidden');
  assert.equal(r.opened, project, '以本地副本打开');
  assert.equal(currentCloudAssociation()?.projectId, projectId, '保留云端关联(通过以后重开能连回去)');
  assert.equal(r.toasts.length, 1);
  const [first] = r.toasts;
  assert.deepEqual([first.text, first.tone, first.ms, first.action?.label, first.action?.pc], ['这个账号不是这个云端项目的成员', 'warn', Infinity, '发送申请', 'reopen-join-request']);
  first.action.run();
  await settle();
  assert.equal(r.calls.send.length, 1);
  assert.deepEqual(r.toasts.slice(1).map(t => [t.text, t.tone]), [['已发送，等创建者通过。通过以后重新打开这个文件，就能连回云端项目。', 'info']]);
});

test('RJR-2 没收到回包再点沿用原请求号;明确被拒后再点换新请求号;一次只发一个', async () => {
  const outcomes = [fail(0, 'network'), fail(429, 'join-request-limit'), null];
  const r = await reopen({ send: n => { const o = outcomes[n - 1]; if (o) throw o; return { projectId, state: 'pending', entry: 'list', canApply: false }; } });
  const { action } = r.toasts[0];
  action.run(); action.run();
  await settle();
  assert.equal(r.calls.send.length, 1, '还没回来时再点不另发');
  action.run(); await settle();
  assert.equal(r.calls.send[1], r.calls.send[0], '没收到回包:同一个请求号重发');
  action.run(); await settle();
  assert.notEqual(r.calls.send[2], r.calls.send[1], '明确被拒之后:新的一次');
  assert.deepEqual(r.toasts.slice(1).map(t => t.text), ['network', '这个项目你最近申请得太多了，请过一段时间再申请。', '已发送，等创建者通过。通过以后重新打开这个文件，就能连回云端项目。']);
});

test('RJR-3 已经在等、被拒且次数用完:不给按钮,把现状接在后面说', async () => {
  const pending = await reopen({ status: { state: 'pending', entry: 'list', canApply: false } });
  assert.deepEqual(pending.toasts.map(t => [t.text, t.action]), [['这个账号不是这个云端项目的成员。已发送，等创建者通过', undefined]]);
  const at = new Date(2026, 9, 23, 18, 30).getTime();
  const spent = await reopen({ status: { state: 'rejected', entry: 'list', canApply: false, retryAt: at } });
  assert.deepEqual(spent.toasts.map(t => [t.text, t.action]), [['这个账号不是这个云端项目的成员。创建者没有通过你的申请，10月23日 18:30 之后可以再申请。', undefined]]);
  const rejected = await reopen({ status: { state: 'rejected', entry: 'list', canApply: true } });
  assert.deepEqual(rejected.toasts.map(t => [t.text, t.action?.label]), [['这个账号不是这个云端项目的成员。创建者没有通过你的申请', '发送申请']]);
});

test('RJR-4 知道链接就能进、被踢、问不到申请状态、老客户端:照旧只有那一句,不带按钮', async () => {
  const plain = [['这个账号不是这个云端项目的成员', 'warn', 10_000, undefined]];
  const shape = r => r.toasts.map(t => [t.text, t.tone, t.ms, t.action]);
  assert.deepEqual(shape(await reopen({ status: { state: 'none', entry: 'link', canApply: false } })), plain);
  const banned = await reopen({ code: 'banned' });
  assert.deepEqual(shape(banned), plain);
  assert.equal(banned.calls.status, 0, '被踢的不去问申请(被踢的不能申请)');
  assert.deepEqual(shape(await reopen({ status: fail(503, 'authority-unavailable') })), plain);
  assert.deepEqual(shape(await reopen({ client: { joinRequestStatus: undefined, sendJoinRequest: undefined } })), plain);
});
