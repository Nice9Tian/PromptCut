/**
 * 申请加入、进入方式勾选在页面这一侧(`client.ts`、`joinRequestText.ts`、`useAccountProjects.ts` 的 `autoJoinKey`)。
 * 服务端那一侧见 `server/test/account-join-requests.test.mjs`。
 *
 *   JRC-1 发申请、查状态只走 `/hosted/shared/account/join`,请求体按白名单拼;回包逐项核,形状不对按协议错
 *   JRC-2 桌面外壳的账号桥:用到的路由都在外壳写死的放行清单里(0.2.8 外壳不用换);失败时外壳只带回 status 与 code,页面照样有人话
 *   JRC-3 创建者的 set-entry、通过、拒绝:请求体白名单、本地先核形状、回包逐项核;回包丢了用同一个请求号重发,请求体一字不差
 *   JRC-4 成员投影里的申请列表:只收创建者的;一个账号一条;不能同时是成员或已禁入;多余字段丢掉
 *   JRC-5 每个新 code 都有一句话(不落到「请求失败（code）」那个兜底)
 *   JRC-6 界面上的话:被挡住、已发送、被拒(次数用完带几点以后能再申请)、通过;重开文件那条提示;何时自动再走一次加入
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAccountClient, accountErrorText, AccountFailure } from './client.ts';
import { JOIN_REQUEST_TEXT, autoJoinKey, joinRequestNotice, reopenNotice, retryAtText, requestedAtText } from './joinRequestText.ts';

const account = { id: 'acc_' + 'a'.repeat(24), name: 'Alice' };
const other = 'acc_' + 'b'.repeat(24);
const projectId = 'sp_' + 'a'.repeat(26);
const device = { deviceId: 'device-test', deviceName: 'fixture' };
const jr = 'jr_' + '1'.repeat(24);
const credential = (at = 100_000) => ({ ok: true, account, loginId: 'editor-test', accessToken: 'access-test', accessExpiresAt: at });
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const onlineClient = (handler) => {
  const calls = [];
  const client = createAccountClient({ online: true, origin: 'https://visuhive.com', device, now: () => 1000,
    fetch: async (url, init) => {
      if (url.pathname.endsWith('/me')) return reply({ ok: true, account, csrfToken: 'csrf' });
      if (url.pathname.includes('/editor/')) return reply(credential());
      calls.push({ path: url.pathname, method: init.method, credentials: init.credentials, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return handler(url, JSON.parse(init.body), calls.length);
    } });
  return { client, calls };
};
const status = (fields = {}) => ({ ok: true, projectId, joinRequest: { state: 'none', entry: 'list', canApply: true, ...fields } });

test('JRC-1 发申请、查状态只走 /join,请求体按白名单拼;回包逐项核', async () => {
  const { client, calls } = onlineClient((url, body) => reply(body.joinRequest === 'send'
    ? status({ state: 'pending', canApply: false }) : { ...status(), joinRequest: { ...status().joinRequest, secret: 'never' }, extra: 'x' }));
  await client.restore();
  assert.deepEqual(await client.joinRequestStatus(projectId), { projectId, state: 'none', entry: 'list', canApply: true });
  assert.deepEqual(await client.sendJoinRequest(projectId, 'req-1'), { projectId, state: 'pending', entry: 'list', canApply: false });
  assert.deepEqual(calls.map(c => [c.path, c.method, c.credentials, c.auth]), [
    ['/hosted/shared/account/join', 'POST', 'omit', 'Bearer access-test'], ['/hosted/shared/account/join', 'POST', 'omit', 'Bearer access-test']]);
  assert.deepEqual(calls[0].body, { projectId, joinRequest: 'status' }, '查状态不带请求号、不带设备号');
  assert.deepEqual(calls[1].body, { projectId, requestId: 'req-1', joinRequest: 'send' }, '发申请只带项目号、请求号');
  await assert.rejects(client.sendJoinRequest(projectId, ''), { status: 400, code: 'invalid-join-request' });
  assert.equal(calls.length, 2, '请求号不对的不发出去');
  // 回包形状不对:按协议错,不按「没申请过」糊过去
  for (const broken of [{ ...status(), projectId: 'sp_' + 'b'.repeat(26) }, status({ state: 'approved' }), status({ entry: 'open' }),
    status({ canApply: 'yes' }), status({ retryAt: -1 }), { ok: true, projectId }]) {
    const { client: c } = onlineClient(() => reply(broken));
    await c.restore();
    await assert.rejects(c.joinRequestStatus(projectId), { status: 503, code: 'account-protocol' }, JSON.stringify(broken));
  }
  const { client: withRetry } = onlineClient(() => reply(status({ state: 'rejected', canApply: false, retryAt: 5000 })));
  await withRetry.restore();
  assert.deepEqual(await withRetry.joinRequestStatus(projectId), { projectId, state: 'rejected', entry: 'list', canApply: false, retryAt: 5000 });
});

test('JRC-2 桌面外壳:用到的路由都在外壳的放行清单里;失败时只带回 status 与 code,页面照样有人话', async () => {
  // 外壳(desktop/src-tauri/src/account_vault.rs)里写死的放行清单;0.2.8 外壳(v0.7.18 发版提交)与现在这一份逐字相同
  const vault = fs.readFileSync(new URL('../../desktop/src-tauri/src/account_vault.rs', import.meta.url), 'utf8');
  const allowed = JSON.parse(`[${/\$projectRoute=\$path -cin @\(([^)]*)\)/.exec(vault)[1].replace(/'/g, '"')}]`);
  assert.deepEqual(allowed, ['/hosted/shared/account/create', '/hosted/shared/account/join', '/hosted/shared/account/session', '/hosted/shared/account/admin', '/hosted/shared/account/members']);
  const used = [];
  const shellReplies = { send: { ok: false, status: 429, code: 'join-request-limit' } };
  const client = createAccountClient({ online: false, origin: 'https://visuhive.com', device, now: () => 1000,
    native: async (operation, args) => {
      if (operation === 'recover') return credential();
      assert.equal(operation, 'request');
      used.push(args.path);
      assert.ok(allowed.includes(args.path), `外壳会拒的路由:${args.path}`);
      assert.equal(args.accessToken, 'access-test'); assert.notEqual(args.body, undefined, '外壳要求项目路由都带请求体');
      // 外壳失败时只回这三样(account_vault.rs:`@{ok=$false;status=...;code=...}`)
      if (args.body.joinRequest === 'send') return shellReplies.send;
      if (args.body.joinRequest === 'status') return status({ state: 'rejected' });
      if (args.body.op === 'set-entry') return { ok: false, status: 409, code: 'access-revision-mismatch' };
      return { ok: false, status: 409, code: 'join-request-decided' };
    } });
  await client.restore();
  assert.equal((await client.joinRequestStatus(projectId)).state, 'rejected');
  const limit = await client.sendJoinRequest(projectId, 'req-2').catch(e => e);
  assert.ok(limit instanceof AccountFailure);
  assert.deepEqual([limit.status, limit.code, limit.message], [429, 'join-request-limit', '这个项目你最近申请得太多了，请过一段时间再申请。']);
  const decided = await client.memberAdmin(projectId, { op: 'approve-join', accountId: other, joinRequestId: jr, requestId: 'd-1' }).catch(e => e);
  assert.deepEqual([decided.status, decided.code, decided.message], [409, 'join-request-decided', '这条申请已经处理过了，请刷新。']);
  const entry = await client.memberAdmin(projectId, { op: 'set-entry', allowLinkJoin: false, expectedAccessRevision: 3, requestId: 'e-1' }).catch(e => e);
  assert.equal(entry.code, 'access-revision-mismatch');
  assert.deepEqual([...new Set(used)].sort(), ['/hosted/shared/account/admin', '/hosted/shared/account/join']);
});

test('JRC-3 set-entry、通过、拒绝:请求体白名单、本地先核形状、回包逐项核;回包丢了同一个请求号重发', async () => {
  let lose = true;
  const { client, calls } = onlineClient((url, body) => {
    if (body.op === 'set-entry') return reply({ ok: true, eventId: 'access:doc:5', accessRevision: 5, completed: false, state: 'pending-services' });
    if (body.op === 'approve-join' && lose) { lose = false; throw Error('lost-response'); }
    return reply({ ok: true, accessRevision: 6, joinRequest: { accountId: body.accountId, joinRequestId: body.joinRequestId,
      state: body.op === 'approve-join' ? 'approved' : 'rejected', leaked: 'never' } });
  });
  await client.restore();
  assert.deepEqual(await client.memberAdmin(projectId, { op: 'set-entry', allowLinkJoin: false, expectedAccessRevision: 4, requestId: 'entry-1', extra: 'x' }),
    { eventId: 'access:doc:5', accessRevision: 5, completed: false, state: 'pending-services' });
  assert.deepEqual(calls[0].body, { projectId, op: 'set-entry', allowLinkJoin: false, expectedAccessRevision: 4, requestId: 'entry-1' });
  const approve = { op: 'approve-join', accountId: other, joinRequestId: jr, requestId: 'approve-1' };
  await assert.rejects(client.memberAdmin(projectId, approve), { status: 0, code: 'network' });
  assert.deepEqual(await client.memberAdmin(projectId, approve), { joinRequest: { accountId: other, joinRequestId: jr, state: 'approved' }, accessRevision: 6 });
  assert.deepEqual(calls[1].body, calls[2].body, '重发的请求体一字不差');
  assert.deepEqual(calls[1].body, { projectId, op: 'approve-join', accountId: other, joinRequestId: jr, requestId: 'approve-1' }, '不带访问版本号、不带别的');
  assert.deepEqual((await client.memberAdmin(projectId, { ...approve, op: 'reject-join', requestId: 'reject-1' })).joinRequest.state, 'rejected');
  // 本地先核形状:不发出去
  const before = calls.length;
  await assert.rejects(client.memberAdmin(projectId, { ...approve, joinRequestId: 'jr_bad' }), { status: 400, code: 'invalid-join-request' });
  await assert.rejects(client.memberAdmin(projectId, { ...approve, accountId: 'acc_bad' }), { status: 400, code: 'invalid-join-request' });
  await assert.rejects(client.memberAdmin(projectId, { op: 'set-entry', allowLinkJoin: 'no', expectedAccessRevision: 1, requestId: 'x' }), { status: 400, code: 'invalid-entry' });
  await assert.rejects(client.memberAdmin(projectId, { op: 'set-list', members: [], expectedAccessRevision: 1, requestId: 'x' }), { status: 400, code: 'invalid-member' }, '页面不提供按账号加人');
  assert.equal(calls.length, before);
  // 回包对不上(别的申请、相反的结论):按协议错
  const { client: wrong } = onlineClient((url, body) => reply({ ok: true, accessRevision: 6, joinRequest: { accountId: body.accountId, joinRequestId: body.joinRequestId, state: 'rejected' } }));
  await wrong.restore();
  await assert.rejects(wrong.memberAdmin(projectId, approve), { status: 503, code: 'account-protocol' });
});

const snapshot = (requests, creator = true) => ({ ok: true, v: 2, authorityId: 'doc', projectId, accessRevision: 3,
  self: { accountId: account.id, creator, access: 'rw' }, creatorAccountId: creator ? account.id : other, allowLinkJoin: false,
  members: [{ accountId: account.id, accountName: account.name, access: 'rw', joinedAt: 1 }, ...(creator ? [] : [{ accountId: other, accountName: 'Bob', access: 'rw', joinedAt: 1 }])],
  devices: [], ...(creator ? { bans: [{ accountId: 'acc_' + 'f'.repeat(24), accountName: 'Kim', reason: 'kick' }] } : {}), ...(requests ? { requests } : {}) });
const row = (n, fields = {}) => ({ accountId: `acc_${String(n).repeat(24)}`, joinRequestId: `jr_${String(n).repeat(24)}`, accountName: `申请人${n}`, createdAt: 1000 + n, ...fields });

test('JRC-4 成员投影里的申请列表:只收创建者的;一个账号一条;不能同时是成员或已禁入;多余字段丢掉', async () => {
  const read = async value => {
    const { client } = onlineClient(() => reply(value));
    await client.restore();
    return client.members(projectId);
  };
  const ok = await read(snapshot([row(1, { loginId: 'never', email: 'never@x' }), row(2, { accountName: null })]));
  assert.deepEqual(ok.requests, [{ accountId: row(1).accountId, joinRequestId: row(1).joinRequestId, accountName: '申请人1', createdAt: 1001 },
    { accountId: row(2).accountId, joinRequestId: row(2).joinRequestId, accountName: null, createdAt: 1002 }]);
  assert.equal((await read(snapshot(undefined))).requests, undefined);
  for (const [label, value] of [['普通成员的投影里带申请', snapshot([row(1)], false)], ['同一个账号两条', snapshot([row(1), { ...row(1), joinRequestId: row(2).joinRequestId }])],
    ['申请人已是成员', snapshot([{ ...row(1), accountId: account.id }])], ['申请人已被禁入', snapshot([{ ...row(1), accountId: 'acc_' + 'f'.repeat(24) }])],
    ['申请号形状不对', snapshot([row(1, { joinRequestId: 'jr_x' })])], ['时间不对', snapshot([row(1, { createdAt: -5 })])], ['名字带控制字符', snapshot([row(1, { accountName: 'a\u0007' })])],
    ['不是数组', snapshot({ 0: row(1) })]])
    await assert.rejects(read(value), { status: 503, code: 'account-protocol' }, label);
});

test('JRC-5 每个新 code 都有一句话,不落到「请求失败（code）」兜底', () => {
  for (const code of ['not-listed', 'banned', 'no-project', 'relocating', 'entry-open', 'join-request-limit', 'join-request-full', 'join-request-account-limit',
    'invalid-join-request', 'no-join-request', 'join-request-decided', 'join-request-banned', 'already-member', 'invalid-entry', 'invalid-member',
    'request-mismatch', 'creator-required', 'access-revision-mismatch', 'login-required', 'credential-revoked']) {
    for (const status of [400, 403, 404, 409, 429]) {
      const text = accountErrorText(status, code);
      assert.ok(text && !text.includes('请求失败') && !text.includes(code), `${code} → ${text}`);
    }
  }
  assert.equal(accountErrorText(403, 'not-listed'), JOIN_REQUEST_TEXT.notListed, '被挡住时那一句与开始页同一句');
});

test('JRC-6 界面上的话:被挡住、已发送、被拒、通过;重开文件那条提示;何时自动再走一次加入', () => {
  const s = fields => ({ projectId, state: 'none', entry: 'list', canApply: true, ...fields });
  assert.deepEqual(joinRequestNotice(s()), { text: '你不在这个项目的成员名单中。', canSend: true });
  assert.deepEqual(joinRequestNotice(s({ state: 'pending', canApply: false })), { text: '已发送，等创建者通过', canSend: false });
  assert.deepEqual(joinRequestNotice(s({ state: 'rejected' })), { text: '创建者没有通过你的申请', canSend: true });
  const at = new Date(2026, 9, 23, 9, 5).getTime();
  assert.equal(retryAtText(at), '10月23日 09:05 之后可以再申请。');
  assert.equal(requestedAtText(at), '10月23日 09:05 申请');
  assert.deepEqual(joinRequestNotice(s({ state: 'rejected', canApply: false, retryAt: at })), { text: '创建者没有通过你的申请', canSend: false, hint: '10月23日 09:05 之后可以再申请。' });
  assert.deepEqual(joinRequestNotice(s({ state: 'member', canApply: false })), { text: '创建者已通过你的申请。', canSend: false });
  assert.deepEqual(joinRequestNotice(s({ entry: 'link', canApply: false })), { text: '你不在这个项目的成员名单中。', canSend: false }, '知道链接就能进时不给按钮(页面直接去加入)');
  // 重开文件:语义原文「这个账号不是这个云端项目的成员」,只放名单时另有「发送申请」
  assert.deepEqual(reopenNotice(s()), { text: '这个账号不是这个云端项目的成员', canSend: true });
  assert.deepEqual(reopenNotice(s({ state: 'pending', canApply: false })), { text: '这个账号不是这个云端项目的成员。已发送，等创建者通过', canSend: false });
  assert.deepEqual(reopenNotice(s({ state: 'rejected' })), { text: '这个账号不是这个云端项目的成员。创建者没有通过你的申请', canSend: true });
  assert.deepEqual(reopenNotice(s({ state: 'rejected', canApply: false, retryAt: at })),
    { text: '这个账号不是这个云端项目的成员。创建者没有通过你的申请，10月23日 09:05 之后可以再申请。', canSend: false });
  assert.equal(reopenNotice(s({ entry: 'link', canApply: false })), null, '知道链接就能进的项目:照旧只有那一句,不带按钮');
  assert.equal(reopenNotice(s({ state: 'member', canApply: false })), null);
  // 何时自动再走一次加入:被通过、项目改回知道链接就能进;键随状态变,同一个状态只触发一次
  assert.equal(autoJoinKey(null), null);
  assert.equal(autoJoinKey(s({ state: 'pending', canApply: false })), null);
  assert.equal(autoJoinKey(s({ state: 'rejected' })), null);
  assert.equal(autoJoinKey(s({ state: 'member', canApply: false })), `${projectId}:member:list`);
  assert.equal(autoJoinKey(s({ state: 'pending', entry: 'link', canApply: false })), `${projectId}:pending:link`);
});
