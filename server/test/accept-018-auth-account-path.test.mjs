/**
 * 0.7.18 验收补证据（组名 auth）：账号任务书「逐项验收」两行的服务端公网路径证据。
 *   2.1-2  项目权限与两张列表：权限只记在云端文档服务；被踢全设备拒绝；列表准确、不越账号。
 *   2.1-21 在线浏览器任务书第一步（浏览器新建项目）里服务端能验的那几条：新建前要先登录；创建者跟着账号走；
 *          另一账号凭链接加入后两边列表对得上。界面本身（开始页的按钮）要真浏览器，见分段文件说明。
 *
 * 搭法：account-dual-user-path 那套真实组合（账号后端源码、文档服务、独立素材进程、公网入口），不改它。
 * 跑法：npm test -- server/test/accept-018-auth-account-path.test.mjs（先设好两个环境变量，值见 docs/local.md）。
 * 手动跑可设 ACCEPT018_AUTH_PORT_BASE=28570。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acceptPorts, httpsJson, SKIP_WITHOUT_PROVIDER } from './fixtures/accept-018-auth-kit.mjs';

test('公网路径：新建前必须登录且归登录的账号；两张列表按账号分、不越账号；被踢的账号全部设备被拒；权限不在账号库里',
  { skip: SKIP_WITHOUT_PROVIDER, timeout: 120_000 }, async t => {
  const { startAccountDualUserFixture } = await import('./fixtures/account-dual-user-path.mjs');
  const fx = await startAccountDualUserFixture({ ports: await acceptPorts(7) });
  try {
    const ca = fs.readFileSync(fx.caFile);
    const edge = (route, opts) => httpsJson(fx.origin, ca, route, opts);
    const doc = (route, body, token) => edge('/hosted/shared/account/' + route, { method: 'POST', body, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const editorLogin = async (account, deviceId) => {
      const answer = await edge('/api/account/editor/login', { method: 'POST', body: { name: account.name, password: account.password, deviceId, deviceName: deviceId, requestId: `login-${deviceId}` } });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body;
    };
    const website = async (account, { register = false } = {}) => {
      let cookie = '', csrf = '';
      const call = async (route, body) => {
        const result = await edge('/api/account' + route, { method: body ? 'POST' : 'GET', body, headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin: fx.origin, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf } : {}) } });
        if (result.cookie) cookie = result.cookie; if (result.body?.csrfToken) csrf = result.body.csrfToken; return result;
      };
      await call('/me');
      const entered = await call(register ? '/register' : '/login', { name: account.name, password: account.password });
      assert.equal(entered.status, 200, JSON.stringify(entered.body));
      return { call, accountId: entered.body.account.id };
    };
    const [ownerAccount, memberAccount] = fx.accounts;
    const outsiderAccount = { name: 'accOutsiderTwo', password: 'accept-outsider-two-password' };
    const owner = await website(ownerAccount), member = await website(memberAccount), outsider = await website(outsiderAccount, { register: true });
    const ids = list => list.map(item => item.projectId);

    await t.test('2.1-21 新建前要先登录：没有凭证、乱写的凭证、只带网站 cookie 都建不成，也不留下半成品', async () => {
      const body = { name: 'Accept Anonymous Project', requestId: 'accept-anon-create', allowLinkJoin: true, initialProject: { name: 'x', tracks: [] } };
      const before = (await owner.call('/projects')).body;
      const none = await doc('create', body);
      const garbage = await doc('create', body, 'garbage-token');
      const cookieOnly = await edge('/hosted/shared/account/create', { method: 'POST', body, headers: { cookie: 'vh_session=not-a-real-session' } });
      for (const [label, answer] of [['没有凭证', none], ['乱写的凭证', garbage], ['只带 cookie', cookieOnly]]) {
        assert.ok([400, 401, 403].includes(answer.status), `${label}: ${answer.status}`);
        assert.ok(!answer.body?.projectId, `${label}: 不返回项目号`);
      }
      t.diagnostic(`anonymous create answers: none=${none.status}/${none.body?.code} garbage=${garbage.status}/${garbage.body?.code} cookieOnly=${cookieOnly.status}/${cookieOnly.body?.code}`);
      const after = (await owner.call('/projects')).body;
      assert.deepEqual(ids(after.owned), ids(before.owned), '没有多出项目');
      // 退出登录之后手里的令牌也建不成
      const spare = await editorLogin(ownerAccount, 'accept-spare');
      assert.equal((await edge('/api/account/editor/logout', { method: 'POST', body: {}, headers: { authorization: `Bearer ${spare.accessToken}` } })).status, 200);
      const afterLogout = await doc('create', { ...body, requestId: 'accept-anon-create-2' }, spare.accessToken);
      assert.ok([401, 403].includes(afterLogout.status), `退出之后：${afterLogout.status}`);
    });

    await t.test('2.1-21 创建者跟着账号走：登录的人新建，项目归这个账号；换一台设备重新登录还是创建者；别的账号凭链接加入后两边列表对得上', async () => {
      const first = await editorLogin(ownerAccount, 'accept-browser-1');
      const created = await doc('create', { name: 'Accept Created Project', requestId: 'accept-create-1', allowLinkJoin: true, initialProject: { name: 'Accept Created Project', tracks: [] } }, first.accessToken);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const projectId = created.body.projectId;
      assert.ok(ids((await owner.call('/projects')).body.owned).includes(projectId), '新项目在创建者的「我创建的」里');
      assert.ok(!ids((await outsider.call('/projects')).body.owned).includes(projectId));
      // 清掉浏览器数据 / 换设备：同一个账号在另一台设备重新登录
      const second = await editorLogin(ownerAccount, 'accept-browser-2');
      const session = await doc('session', { projectId, deviceId: 'accept-browser-2', requestId: 'accept-session-2' }, second.accessToken);
      assert.equal(session.status, 200, JSON.stringify(session.body));
      assert.equal(session.body.creator, true, '换设备后仍是创建者');
      // 另一个账号：未加入时进不去，凭项目号加入后两边都看得见
      const memberDevice = await editorLogin(memberAccount, 'accept-member-1');
      const early = await doc('session', { projectId, deviceId: 'accept-member-1', requestId: 'accept-member-early' }, memberDevice.accessToken);
      assert.equal(early.status, 403, '没加入之前进不去');
      const joined = await doc('join', { projectId, deviceId: 'accept-member-1', requestId: 'accept-member-join' }, memberDevice.accessToken);
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      const memberSession = await doc('session', { projectId, deviceId: 'accept-member-1', requestId: 'accept-member-session' }, memberDevice.accessToken);
      assert.equal(memberSession.status, 200); assert.equal(memberSession.body.creator, false);
      assert.ok(ids((await member.call('/projects')).body.joined).includes(projectId), '成员的「我加入的」里有');
      assert.ok(!ids((await member.call('/projects')).body.owned).includes(projectId));
      assert.equal((await member.call('/projects')).body.joined.find(item => item.projectId === projectId).creatorAccountId, owner.accountId);
    });

    await t.test('2.1-2 两张列表按账号分：每个账号只看到自己创建的和自己加入的，不越账号；列表里的地址就是进编辑器的地址', async () => {
      const lists = { owner: (await owner.call('/projects')).body, member: (await member.call('/projects')).body, outsider: (await outsider.call('/projects')).body };
      assert.ok(lists.owner.owned.length >= 2 && lists.owner.joined.length === 0);
      assert.ok(lists.member.joined.length >= 2 && lists.member.owned.length === 0);
      assert.deepEqual(lists.outsider.owned.concat(lists.outsider.joined), [], '没有任何项目的账号看到空列表（不是别人的）');
      for (const item of lists.owner.owned) assert.match(item.url, /\/editor\/?\?project=sp_[a-z2-7]{26}$/);
      for (const key of ['owner', 'member']) for (const item of lists[key].owned.concat(lists[key].joined)) assert.ok(!/token|ticket|password/i.test(JSON.stringify(item)), '列表项里没有凭证');
    });

    await t.test('2.1-2 被踢的账号在全部设备上被拒，也加不回来，列表里没有了', async () => {
      const projectId = (await owner.call('/projects')).body.owned.find(item => item.name === 'Accept Created Project').projectId;
      const devices = [await editorLogin(memberAccount, 'accept-kick-1'), await editorLogin(memberAccount, 'accept-kick-2')];
      for (const [index, device] of devices.entries())
        assert.equal((await doc('session', { projectId, deviceId: `accept-kick-${index + 1}`, requestId: `accept-kick-before-${index}` }, device.accessToken)).status, 200, `踢之前设备 ${index + 1} 是通的`);
      const ownerDevice = await editorLogin(ownerAccount, 'accept-kick-owner');
      const revision = (await doc('session', { projectId, deviceId: 'accept-kick-owner', requestId: 'accept-kick-owner-session' }, ownerDevice.accessToken)).body.accessRevision;
      const kicked = await doc('admin', { projectId, op: 'kick', accountId: member.accountId, expectedAccessRevision: revision, requestId: 'accept-kick-1' }, ownerDevice.accessToken);
      assert.equal(kicked.status, 200, JSON.stringify(kicked.body));
      for (const [index, device] of devices.entries()) {
        const answer = await doc('session', { projectId, deviceId: `accept-kick-${index + 1}`, requestId: `accept-kick-after-${index}` }, device.accessToken);
        assert.equal(answer.status, 403, `踢之后设备 ${index + 1}：${JSON.stringify(answer.body)}`);
        assert.ok(!answer.body?.connectionTicket && !answer.body?.assetTicket);
      }
      const rejoin = await doc('join', { projectId, deviceId: 'accept-kick-3', requestId: 'accept-kick-rejoin' }, (await editorLogin(memberAccount, 'accept-kick-3')).accessToken);
      assert.ok([403, 409].includes(rejoin.status), `想再加入：${rejoin.status} ${JSON.stringify(rejoin.body)}`);
      assert.ok(!ids((await member.call('/projects')).body.joined).includes(projectId), '列表里没有了');
      assert.ok(ids((await owner.call('/projects')).body.owned).includes(projectId), '创建者的列表不受影响');
    });

    await t.test('2.1-2 权限只由云端文档服务记录：账号库里没有项目、成员、禁入这类表', async () => {
      const db = new DatabaseSync(path.join(fx.fixtureDir, 'accounts.sqlite'), { readOnly: true });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
        t.diagnostic('account database tables: ' + tables.join(','));
        assert.ok(tables.length > 3);
        assert.deepEqual(tables.filter(name => /project|member|ban|acl|invite/i.test(name)), [], '账号库只有账号、登录、事件这类表');
      } finally { db.close(); }
    });
  } finally { await fx.close(); }
});
