/**
 * 账号级整理信息(云端分组)的服务端:`server/docservice/modules/account-org.mjs` 与公开路由 `/hosted/shared/account/start-org`。
 * 裁定 V22-05～09(`docs/plan/release-021-rulings.md`),设计见 `docs/reports/AGENT-claude-groups-local-cloud.md`。
 *
 *   ORG-1  get / put 往返:没存过是 version 0、org null;写入后版本 1,读回一致;再写 baseVersion 对得上才加一
 *   ORG-2  版本冲突回 409 并带回云端那一份(含 version),不写;用带回的版本重传就成
 *   ORG-3  超整份大小、超条数(分组 / 项目 / 对话)被拒 413 org-too-large;形状不对 400 bad-org;被拒的不改云端那份
 *   ORG-4  游客令牌被拒 403 guest-org-unavailable,读写都拒,也不会替游客落文件
 *   ORG-5  别的账号读不到你的那份:各读各的,互不覆盖;请求体里写别人的账号编号不算数(400)
 *   ORG-6  存在文档服务数据目录下独立的文件里,重开存储还在;文件被换成别人的内容读出来当没有
 *   ORG-7  没配整理信息存储的部署:503 org-unavailable;没有 Bearer 照旧 401;不认识的 op 400
 *   ORG-8  只存已知字段:多余字段丢掉
 *   ORG-9  put 按账号限流(V22-10):连打超过上限被拒 429 org-rate-limited(带 Retry-After)、被拒的没写、
 *          冷却后又能写、不同账号各算各的、get 不限;缺省的数是 30 次 / 分钟
 *
 * 跑:npm test -- server/test/account-org-route.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountHostedRuntime } from '../docservice/account-hosted.mjs';
import { mountAccountProjects } from '../docservice/modules/account-projects.mjs';
import { createAccountOrgStore, ORG_LIMITS, ORG_WRITE_RATE, checkOrg } from '../docservice/modules/account-org.mjs';
import { createGuestRateLimit } from '../account/guest-rate.mjs';
import { createFileStore } from '../docservice/store/index.mjs';

const A = 'acc_' + 'a'.repeat(24);
const B = 'acc_' + 'b'.repeat(24);
const ROUTE = '/hosted/shared/account/start-org';

const orgOf = (extra = {}) => ({ v: 1, realm: 'cloud', groups: [], projects: [], chats: [], ...extra });

async function fixture(t, { withStore = true, limits, orgWriteLimit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-org-route-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'doc-org-fixture' });
  const people = { 'tok-a': { accountId: A, accountName: 'Alice', loginId: 'login-a' }, 'tok-b': { accountId: B, accountName: 'Bob', loginId: 'login-b' } };
  const accountClient = {
    verify: async (token) => {
      const p = people[token];
      if (!p) throw Object.assign(new Error('login-required'), { status: 401, code: 'login-required' });
      return { ...p, credentialId: `cred-${p.loginId}`, loginGeneration: 1, expiresAt: Date.now() + 3_600_000, accountEventSeq: 0, kind: 'editor' };
    },
    events: async () => ({ events: [], headSeq: 0 }),
  };
  const runtime = createAccountHostedRuntime({ ledger, accountClient, dataDir: null, authorityUrl: 'https://fixture.invalid',
    allowFixtureAssetReady: true, pollMs: 0, guestKey: randomBytes(32) });
  runtime.setAssetReady(true);
  runtime.bindService({ describe: () => ({ conns: [] }), fencePrincipals: async () => ({ actualClosed: true }) }, { registry: { refresh() {}, get: () => null }, urls: {} });
  await runtime.start();
  const dataDir = path.join(dir, 'data');
  const fileStore = createFileStore({ dir: dataDir, log: () => {} });
  const orgStore = createAccountOrgStore({ store: fileStore, ...(limits ? { limits } : {}) });
  t.after(() => { try { runtime.close(); } catch { /* 已关 */ } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const mounted = mountAccountProjects({ authority: runtime.authority, issueSession: (o) => runtime.issueSession(o), ...(withStore ? { orgStore } : {}), ...(orgWriteLimit ? { orgWriteLimit } : {}) });
  const post = async (token, body, { raw = false } = {}) => {
    const req = Readable.from([Buffer.from(raw ? body : JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: ROUTE, socket: { remoteAddress: '203.0.113.1' },
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    let status, value, headers;
    assert.equal(await mounted.handlePublic(req, { writeHead: (s, h) => { status = s; headers = h; }, end: (text) => { value = JSON.parse(text); } }, {}), true);
    return { status, value, headers };
  };
  const guest = async () => {
    const req = Readable.from([Buffer.from('{}')]);
    Object.assign(req, { method: 'POST', url: '/hosted/shared/account/guest', socket: { remoteAddress: '203.0.113.9' }, headers: { 'content-type': 'application/json' } });
    let value;
    await mounted.handlePublic(req, { writeHead() {}, end: (text) => { value = JSON.parse(text); } }, {});
    return value;
  };
  const get = (token) => post(token, { op: 'get' });
  const put = (token, baseVersion, org) => post(token, { op: 'put', baseVersion, org });
  return { post, get, put, guest, dataDir, fileStore, orgStore };
}

test('ORG-1 get / put 往返:没存过是 version 0;写入后版本 1,读回一致;baseVersion 对得上才加一', async (t) => {
  const f = await fixture(t);
  const first = await f.get('tok-a');
  assert.equal(first.status, 200);
  assert.deepEqual([first.value.ok, first.value.version, first.value.org], [true, 0, null]);

  const doc1 = orgOf({ groups: [{ id: 'g1', name: '客户' }], projects: [{ id: 'p1', groupId: 'g1', pinned: true }, { id: 'p2', groupId: null, archived: true }], chats: [{ id: 'c1', projectId: 'p1', pinned: true }] });
  const w1 = await f.put('tok-a', 0, doc1);
  assert.equal(w1.status, 200, JSON.stringify(w1.value));
  assert.equal(w1.value.version, 1);
  assert.deepEqual(w1.value.org, doc1);

  const read = await f.get('tok-a');
  assert.equal(read.value.version, 1);
  assert.deepEqual(read.value.org, doc1);
  assert.ok(read.value.updatedAt > 0);

  const doc2 = orgOf({ groups: [{ id: 'g1', name: '客户改名' }] });
  const w2 = await f.put('tok-a', 1, doc2);
  assert.equal(w2.value.version, 2);
  assert.deepEqual((await f.get('tok-a')).value.org, doc2);
});

test('ORG-2 版本冲突回 409 并带回云端那一份,不写;用带回的版本重传就成', async (t) => {
  const f = await fixture(t);
  const mine = orgOf({ groups: [{ id: 'g-mine', name: '我的' }] });
  const theirs = orgOf({ groups: [{ id: 'g-theirs', name: '另一台设备的' }] });
  assert.equal((await f.put('tok-a', 0, theirs)).value.version, 1); // 另一台设备先写了

  const stale = await f.put('tok-a', 0, mine); // 我还以为是 0
  assert.equal(stale.status, 409);
  assert.equal(stale.value.ok, false);
  assert.equal(stale.value.code, 'org-version-mismatch');
  assert.equal(stale.value.version, 1);
  assert.deepEqual(stale.value.org, theirs, '带回云端当前那一份');
  assert.deepEqual((await f.get('tok-a')).value.org, theirs, '冲突的那次没有写进去');

  const retry = await f.put('tok-a', stale.value.version, mine);
  assert.equal(retry.status, 200);
  assert.equal(retry.value.version, 2);
  // baseVersion 比云端大也算冲突(不是只拒落后的)
  assert.equal((await f.put('tok-a', 9, mine)).status, 409);
});

test('ORG-3 超整份大小、超条数被拒 413;形状不对 400;被拒的不改云端那一份', async (t) => {
  const f = await fixture(t);
  const good = orgOf({ groups: [{ id: 'g', name: '好的' }] });
  assert.equal((await f.put('tok-a', 0, good)).value.version, 1);

  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const tooManyGroups = orgOf({ groups: many(ORG_LIMITS.GROUPS + 1, (i) => ({ id: `g${i}`, name: 'x' })) });
  const tooManyProjects = orgOf({ projects: many(ORG_LIMITS.PROJECTS + 1, (i) => ({ id: `p${i}`, groupId: null })) });
  const tooManyChats = orgOf({ chats: many(ORG_LIMITS.CHATS + 1, (i) => ({ id: `c${i}`, projectId: 'p' })) });
  for (const [label, doc] of [['分组', tooManyGroups], ['项目', tooManyProjects], ['对话', tooManyChats]]) {
    const r = await f.put('tok-a', 1, doc);
    assert.equal(r.status, 413, `${label}超条数`);
    assert.equal(r.value.code, 'org-too-large');
  }
  // 条数没超、字节超:名字都是上限长度,再多塞一点编号长度,凑到超过 256 KB
  const fat = orgOf({ projects: many(1500, (i) => ({ id: `${"p".repeat(190)}${i}`, groupId: `${'g'.repeat(190)}` })) });
  assert.ok(Buffer.byteLength(JSON.stringify(fat)) > ORG_LIMITS.BYTES, '用例自己要先超');
  const big = await f.put('tok-a', 1, fat);
  assert.equal(big.status, 413);
  assert.equal(big.value.code, 'org-too-large');

  const bad = [
    ['不是对象', 'x'], ['缺 v', { realm: 'cloud', groups: [], projects: [], chats: [] }],
    ['realm 是 local', orgOf({ realm: 'local' })], ['groups 不是数组', orgOf({ groups: {} })],
    ['分组没名字', orgOf({ groups: [{ id: 'g', name: '  ' }] })], ['名字太长', orgOf({ groups: [{ id: 'g', name: 'x'.repeat(ORG_LIMITS.NAME + 1) }] })],
    ['项目编号不是字符串', orgOf({ projects: [{ id: 3, groupId: null }] })], ['groupId 是数字', orgOf({ projects: [{ id: 'p', groupId: 5 }] })],
    ['对话缺 projectId', orgOf({ chats: [{ id: 'c' }] })],
  ];
  for (const [label, doc] of bad) {
    const r = await f.put('tok-a', 1, doc);
    assert.equal(r.status, 400, label);
    assert.equal(r.value.code, 'bad-org', label);
  }
  assert.equal((await f.post('tok-a', { op: 'put', baseVersion: 'one', org: good })).status, 400, 'baseVersion 不是整数');
  const after = await f.get('tok-a');
  assert.equal(after.value.version, 1, '所有被拒的都没动云端');
  assert.deepEqual(after.value.org, good);
});

test('ORG-4 游客令牌被拒 403 guest-org-unavailable:读写都拒,也不替游客落文件', async (t) => {
  const f = await fixture(t);
  const g = await f.guest();
  assert.match(g.guestId, /^gst_[0-9a-f]{24}$/);
  const read = await f.get(g.token);
  assert.equal(read.status, 403);
  assert.equal(read.value.code, 'guest-org-unavailable');
  const write = await f.put(g.token, 0, orgOf({ groups: [{ id: 'g', name: '游客的分组' }] }));
  assert.equal(write.status, 403);
  assert.equal(write.value.code, 'guest-org-unavailable');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'accounts')), false, '没有为游客建任何文件');
  // 存储层自己也拒(不只靠路由):游客编号当账号编号用也进不来
  assert.throws(() => f.orgStore.put(g.guestId, 0, orgOf()), (e) => e.code === 'guest-org-unavailable' && e.status === 403);
  assert.throws(() => f.orgStore.get(g.guestId), (e) => e.code === 'guest-org-unavailable');
});

test('ORG-5 别的账号读不到你的那份;各读各的;请求体里写别人的账号编号不算数', async (t) => {
  const f = await fixture(t);
  const a = orgOf({ groups: [{ id: 'ga', name: 'A 的分组' }], projects: [{ id: 'pa', groupId: 'ga' }] });
  const b = orgOf({ groups: [{ id: 'gb', name: 'B 的分组' }] });
  await f.put('tok-a', 0, a);
  const bFirst = await f.get('tok-b');
  assert.deepEqual([bFirst.value.version, bFirst.value.org], [0, null], 'B 看不到 A 的');
  assert.equal((await f.put('tok-b', 0, b)).value.version, 1, 'B 自己的版本从 0 起,和 A 的无关');
  assert.deepEqual((await f.get('tok-a')).value.org, a, 'B 写了之后 A 的没被盖');
  assert.deepEqual((await f.get('tok-b')).value.org, b);
  // 想借请求体读 / 写 A 的:编号字段一律不收
  const claim = await f.post('tok-b', { op: 'get', accountId: A });
  assert.equal(claim.status, 400);
  assert.equal(claim.value.code, 'invalid-authority-claim');
  const claimPut = await f.post('tok-b', { op: 'put', baseVersion: 1, org: orgOf(), accountId: A });
  assert.equal(claimPut.status, 400);
  assert.deepEqual((await f.get('tok-a')).value.org, a);
  // 令牌不对
  assert.equal((await f.get('tok-nobody')).status, 401);
});

test('ORG-6 存在数据目录下独立的文件里:重开存储还在;文件被换成别人的内容当没有', async (t) => {
  const f = await fixture(t);
  const a = orgOf({ groups: [{ id: 'ga', name: '持久' }] });
  await f.put('tok-a', 0, a);
  await f.put('tok-b', 0, orgOf({ groups: [{ id: 'gb', name: 'B' }] }));
  const dir = path.join(f.dataDir, 'accounts');
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, [`${A}.json`, `${B}.json`], '一个账号一个文件,在 accounts/ 下;不在授权账本里');
  // 重开一份存储(模拟进程重启):读回来一样
  const reopened = createAccountOrgStore({ store: createFileStore({ dir: f.dataDir, log: () => {} }) });
  const got = reopened.get(A);
  assert.equal(got.version, 1);
  assert.deepEqual(got.org, a);
  // 把 B 的文件拷到 A 的名下:内容里的账号编号对不上,读出来当没有,不把 B 的整理信息给 A
  fs.copyFileSync(path.join(dir, `${B}.json`), path.join(dir, `${A}.json`));
  const swapped = createAccountOrgStore({ store: createFileStore({ dir: f.dataDir, log: () => {} }) }).get(A);
  assert.deepEqual([swapped.version, swapped.org], [0, null]);
  // 文件坏了也不抛
  fs.writeFileSync(path.join(dir, `${A}.json`), '{not json');
  assert.deepEqual(createAccountOrgStore({ store: createFileStore({ dir: f.dataDir, log: () => {} }) }).get(A).org, null);
});

test('ORG-7 没配存储的部署 503 org-unavailable;没有 Bearer 401;不认识的 op 400', async (t) => {
  const none = await fixture(t, { withStore: false });
  const r = await none.get('tok-a');
  assert.equal(r.status, 503);
  assert.equal(r.value.code, 'org-unavailable');

  const f = await fixture(t);
  const noAuth = await f.post(null, { op: 'get' });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.value.code, 'login-required');
  const weird = await f.post('tok-a', { op: 'delete' });
  assert.equal(weird.status, 400);
  assert.equal(weird.value.code, 'bad-org');
});

test('ORG-8 只存已知字段:多余字段丢掉;标记只认 true', async (t) => {
  const f = await fixture(t);
  const w = await f.put('tok-a', 0, {
    v: 1, realm: 'cloud', evil: 'x',
    groups: [{ id: 'g', name: 'n', pinned: 'yes', archived: true, extra: 1 }],
    projects: [{ id: 'p', groupId: 'g', pinned: true, secret: 'z' }],
    chats: [{ id: 'c', projectId: 'p', foo: 1 }],
  });
  assert.equal(w.status, 200);
  assert.deepEqual(w.value.org, orgOf({ groups: [{ id: 'g', name: 'n', archived: true }], projects: [{ id: 'p', groupId: 'g', pinned: true }], chats: [{ id: 'c', projectId: 'p' }] }));
  // 纯函数同样
  assert.deepEqual(Object.keys(checkOrg(orgOf({ x: 1 }))).sort(), ['chats', 'groups', 'projects', 'realm', 'v']);
});

test('ORG-9 put 按账号限流:连打超过上限被拒 429 org-rate-limited、被拒的没写;冷却后又能写;不同账号各算各的;get 不限', async (t) => {
  const clock = { t: 1_000_000 };
  const orgWriteLimit = createGuestRateLimit({ max: 3, windowMs: 60_000, now: () => clock.t });
  const f = await fixture(t, { orgWriteLimit });
  const doc = (n) => orgOf({ groups: [{ id: 'g', name: `第${n}次` }] });
  let version = 0;
  for (let i = 1; i <= 3; i++) {
    const w = await f.put('tok-a', version, doc(i));
    assert.equal(w.status, 200, `第 ${i} 次该收`);
    version = w.value.version;
  }
  const refused = await f.put('tok-a', version, doc(4));
  assert.equal(refused.status, 429);
  assert.equal(refused.value.code, 'org-rate-limited');
  assert.ok(Number(refused.headers['retry-after']) >= 1, '带 Retry-After');
  assert.equal((await f.get('tok-a')).value.version, 3, '被拒的那次没写');
  assert.equal((await f.get('tok-a')).value.org.groups[0].name, '第3次');
  // get 不限:被限流时照读
  for (let i = 0; i < 10; i++) assert.equal((await f.get('tok-a')).status, 200);
  // 被拒的这一次不算数:冷却一过就又能写
  clock.t += 61_000;
  const again = await f.put('tok-a', version, doc(4));
  assert.equal(again.status, 200);
  assert.equal(again.value.version, 4);
  // 不同账号各算各的:A 被限时,B 照写(A 的次数没有算到 B 头上)
  for (let i = 0; i < 2; i++) await f.put('tok-a', 4 + i, doc(5 + i));
  assert.equal((await f.put('tok-a', 6, doc(7))).status, 429, 'A 又满了');
  const b = await f.put('tok-b', 0, orgOf({ groups: [{ id: 'gb', name: 'B 的' }] }));
  assert.equal(b.status, 200, 'B 不受 A 的限流影响');
  // 缺省的数:30 次 / 分钟(三级,理由在 ORG_WRITE_RATE 的注释里)
  assert.deepEqual({ ...ORG_WRITE_RATE }, { max: 30, windowMs: 60_000 });
});
