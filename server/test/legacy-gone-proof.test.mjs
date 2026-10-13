/**
 * 「这个项目已不存在」的证明：文档服务只对留有墓碑的项目签，客户端核对签发方、项目号、签名。
 * 用真的账本（临时目录里的 SQLite）、真的签发方、真的公开入口处理函数；不占端口，请求直接交给处理函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { mountAccountProjects } from '../docservice/modules/account-projects.mjs';
import { queryGone, verifyGoneProof, authorityFor, validAuthority, TRUSTED_GONE_AUTHORITIES, GONE_PATH } from '../recovery/gone-proof.mjs';
import { planLegacyTombstones, applyLegacyTombstones, publicKeyOf, parseIds, verifyLegacyTombstones } from '../hosted/deploy/legacy-tombstones.mjs';

const id = ch => `sp_${ch.repeat(26)}`;
const SERVICE = 'https://old-hosted.example/hosted';
const ORIGIN = 'https://doc.example';

function fixture(t, { signing = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-gone-'));
  const keys = generateKeyPairSync('ed25519');
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'doc-fixture' });
  let accountCalls = 0;
  const accountClient = new Proxy({}, { get: () => () => { accountCalls++; throw Object.assign(new Error('account service must not be asked'), { status: 503, code: 'account-unavailable' }); } });
  const authority = createAccountAuthority({ ledger, accountClient, initializeProject: async () => ({}), authorityUrl: `${ORIGIN}/editor`,
    ...(signing ? { signingKey: keys.privateKey, keyId: 'k1' } : {}), pollMs: 0 });
  const mounted = mountAccountProjects({ authority });
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const seen = [];
  /** 把一次 fetch 交给公开入口的处理函数 */
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input)); seen.push({ url: url.href, init });
    const req = { url: url.pathname + url.search, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, socket: {} };
    let status = 0, headers = {}, body = '';
    const res = { writeHead: (s, h) => { status = s; headers = h; }, end: text => { body = text ?? ''; } };
    assert.equal(await mounted.handlePublic(req, res), true, 'the public route owns this path');
    return { status, ok: status >= 200 && status < 300, headers, json: async () => JSON.parse(body) };
  };
  const trusted = { authorityId: 'doc-fixture', origin: ORIGIN, services: [SERVICE], keys: { k1: publicKeyOf(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })) } };
  return { dir, keys, ledger, authority, fetcher, trusted, seen, accountCalls: () => accountCalls };
}
const file = roomId => ({ version: 1, roomId, service: SERVICE, where: 'hosted' });

test('随软件分发的信任表：没填生产签发方之前谁的证明都不认', () => {
  for (const entry of TRUSTED_GONE_AUTHORITIES) assert.equal(validAuthority(entry), true, '填进来的记录形状必须对');
  assert.equal(authorityFor(file(id('a')), []), null);
  assert.equal(validAuthority({ authorityId: 'x', origin: ORIGIN, services: [SERVICE], keys: {} }), true, '没有钥匙的记录形状合法，只是什么都验不过');
  assert.equal(validAuthority({ authorityId: 'x', origin: `${ORIGIN}/path`, services: [SERVICE], keys: {} }), false);
  assert.equal(validAuthority({ authorityId: 'x', origin: ORIGIN, services: [`${SERVICE}/`], keys: {} }), false, '服务地址必须是归一后的写法');
});

test('登记脚本：空跑不写；真写可重复；撞号或写法不对整份拒绝', t => {
  const f = fixture(t);
  f.ledger.transaction(state => { state.projects[id('p')] = { projectId: id('p'), status: 'active', accessRevision: 1, members: {}, bans: {} }; });
  assert.deepEqual(parseIds(`# 旧项目\n${id('a')}\r\n\n  ${id('b')}  \n`), [id('a'), id('b')]);
  const plan = planLegacyTombstones(f.ledger.read(), [id('a'), id('b'), id('a'), 'sp_bad', id('p')]);
  assert.deepEqual(plan.map(row => row.action), ['new', 'new', 'duplicate-line', 'invalid', 'conflict-account-project']);
  assert.equal(f.ledger.read().legacyTombstones, undefined, '空跑不写账本');
  assert.throws(() => applyLegacyTombstones(f.ledger, [id('a'), id('p')], { source: 'test' }), /一个都没写/);
  assert.throws(() => applyLegacyTombstones(f.ledger, [id('a'), 'sp_bad'], { source: 'test' }), /一个都没写/);
  assert.equal(f.ledger.read().legacyTombstones, undefined, '整份拒绝时一个都不写');
  assert.throws(() => applyLegacyTombstones(f.ledger, [id('a')], {}), /source/);
  const revision = f.ledger.read().revision;
  const written = applyLegacyTombstones(f.ledger, [id('a'), id('b')], { source: '旧托管 2026-10', now: () => 1760000000000 });
  assert.deepEqual(written.map(row => row.action), ['written', 'written']);
  const state = f.ledger.read();
  assert.deepEqual(state.legacyTombstones[id('a')], { revision: revision + 1, deletedAt: 1760000000000, source: '旧托管 2026-10' });
  assert.equal(state.revision, revision + 2);
  const again = applyLegacyTombstones(f.ledger, [id('a'), id('b'), id('c')], { source: '第二次', now: () => 1770000000000 });
  assert.deepEqual(again.map(row => row.action), ['already', 'already', 'written']);
  assert.equal(f.ledger.read().legacyTombstones[id('a')].deletedAt, 1760000000000, '已登记过的原样不动');
});

test('只有登记过墓碑的旧项目号拿得到证明；核对过签发方、项目号、签名才认', async t => {
  const f = fixture(t);
  applyLegacyTombstones(f.ledger, [id('a')], { source: 'test', now: () => 1760000000000 });
  const gone = await queryGone(file(id('a')), { authorities: [f.trusted], fetch: f.fetcher });
  assert.equal(gone.state, 'gone');
  assert.deepEqual(Object.keys(gone.proof).sort(), ['authorityId', 'issuedAt', 'kid', 'projectId', 'signature', 'state', 'tombstoneRevision', 'v']);
  assert.deepEqual({ ...gone.proof, signature: '' }, { v: 1, authorityId: 'doc-fixture', projectId: id('a'), state: 'gone', tombstoneRevision: f.ledger.read().legacyTombstones[id('a')].revision, issuedAt: 1760000000000, kid: 'k1', signature: '' });
  const asked = new URL(f.seen[0].url);
  assert.equal(asked.origin + asked.pathname, ORIGIN + GONE_PATH);
  assert.equal(f.seen[0].init.credentials, 'omit'); assert.equal(f.seen[0].init.headers, undefined, '不带登录、不带任何凭证');
  assert.equal(f.accountCalls(), 0, '匿名查询不去问账号服务');

  // 服务说得清「没有墓碑」：没登记过的号、账号项目（在、删了都一样）、两边都有的号
  f.ledger.transaction(state => {
    state.projects[id('p')] = { projectId: id('p'), status: 'active', accessRevision: 1, members: {}, bans: {} };
    state.projects[id('d')] = { projectId: id('d'), status: 'deleted', accessRevision: 2, members: {}, bans: {}, tombstone: { revision: 2, deletedAt: 5 } };
    state.projects[id('x')] = { projectId: id('x'), status: 'active', accessRevision: 3, members: {}, bans: {} };
    state.legacyTombstones[id('x')] = { revision: 9, deletedAt: 9, source: 'forced' };
  });
  for (const ch of ['b', 'p', 'd', 'x']) assert.deepEqual(await queryGone(file(id(ch)), { authorities: [f.trusted], fetch: f.fetcher }), { state: 'no-tombstone' }, ch);

  // 文件里记的服务不在信任表里：没处可问，一次请求都不发
  const before = f.seen.length;
  assert.deepEqual(await queryGone({ ...file(id('a')), service: 'https://someone-else.example/hosted' }, { authorities: [f.trusted], fetch: f.fetcher }), { state: 'untrusted-service' });
  assert.deepEqual(await queryGone(file(id('a')), { authorities: [], fetch: f.fetcher }), { state: 'untrusted-service' });
  assert.equal(f.seen.length, before);

  // 证明对不上：签发方标识不同、钥匙不同、没有这把钥匙、项目号被换、字段被改
  assert.deepEqual(await queryGone(file(id('a')), { authorities: [{ ...f.trusted, authorityId: 'other-doc' }], fetch: f.fetcher }), { state: 'proof-rejected', reason: 'authority' });
  const stranger = publicKeyOf(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.deepEqual(await queryGone(file(id('a')), { authorities: [{ ...f.trusted, keys: { k1: stranger } }], fetch: f.fetcher }), { state: 'proof-rejected', reason: 'signature' });
  assert.deepEqual(await queryGone(file(id('a')), { authorities: [{ ...f.trusted, keys: { k2: f.trusted.keys.k1 } }], fetch: f.fetcher }), { state: 'proof-rejected', reason: 'key' });
  assert.deepEqual(await queryGone(file(id('a')), { authorities: [{ ...f.trusted, keys: {} }], fetch: f.fetcher }), { state: 'proof-rejected', reason: 'key' });
  applyLegacyTombstones(f.ledger, [id('c')], { source: 'test' });
  const swap = async (input, init) => f.fetcher(String(input).replace(id('b'), id('c')), init);
  assert.deepEqual(await queryGone(file(id('b')), { authorities: [f.trusted], fetch: swap }), { state: 'proof-rejected', reason: 'project' }, '别的项目的真证明不能拿来顶');
  for (const [field, value, reason] of [['tombstoneRevision', 999, 'signature'], ['issuedAt', 1, 'signature'], ['state', 'exists', 'shape'], ['v', 2, 'shape'], ['signature', 'AAAA', 'shape']]) {
    const tamper = async (input, init) => { const r = await f.fetcher(input, init); return { ...r, json: async () => ({ ...await r.json(), [field]: value }) }; };
    assert.deepEqual(await queryGone(file(id('a')), { authorities: [f.trusted], fetch: tamper }), { state: 'proof-rejected', reason }, field);
  }
  assert.deepEqual(await verifyGoneProof(gone.proof, { descriptor: file(id('c')), authority: f.trusted }), { ok: false, reason: 'project' });
  assert.equal((await verifyGoneProof({ ...gone.proof, extra: 'ignored' }, { descriptor: file(id('a')), authority: f.trusted })).ok, true, '签名只盖证明自己的字段');

  // 说不清的一律抛「暂时无法确认」：断网、超时、限速、5xx、认证失败、没有权限、回的不是约定的内容
  const unavailable = async (fetcher, detail) => assert.rejects(() => queryGone(file(id('a')), { authorities: [f.trusted], fetch: fetcher, timeoutMs: 30 }),
    error => error.reason === 'gone-check-unavailable' && (detail === undefined || error.detail === detail), String(detail));
  await unavailable(async () => { throw new TypeError('fetch failed'); }, 'TypeError');
  await unavailable((_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), 'TimeoutError');
  for (const [status, code] of [[500, 'authority-unavailable'], [503, 'gone-proof-unavailable'], [429, 'rate-limited'], [401, 'login-required'], [403, 'banned'], [404, 'no-project'], [404, 'no-route'], [410, 'deleted']])
    await unavailable(async () => ({ status, ok: false, json: async () => ({ ok: false, code, error: code }) }), `http-${status}`);
  await unavailable(async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('html'); } }), 'SyntaxError');
  await unavailable(async () => ({ status: 200, ok: true, json: async () => null }), 'protocol');
  await unavailable(async () => ({ status: 200, ok: true, json: async () => ({ state: 'gone' }) }), 'http-200');

  // 从公网核对用的那一步（部署后主会话跑）
  const checked = await verifyLegacyTombstones({ authority: f.trusted, service: SERVICE, ids: [id('a'), id('c')], absent: [id('b'), id('p')], fetch: f.fetcher });
  assert.equal(checked.ok, true, JSON.stringify(checked.rows));
  assert.equal((await verifyLegacyTombstones({ authority: f.trusted, service: SERVICE, ids: [id('b')], fetch: f.fetcher })).ok, false);
});

test('公开入口：成功和失败都放开只读跨源；别的方法、别的入口不受影响；没配签名钥匙就签不出来', async t => {
  const f = fixture(t);
  applyLegacyTombstones(f.ledger, [id('a')], { source: 'test' });
  const ok = await f.fetcher(`${ORIGIN}${GONE_PATH}?authorityId=doc-fixture&projectId=${id('a')}`);
  assert.equal(ok.status, 200); assert.equal(ok.headers['access-control-allow-origin'], '*'); assert.equal(ok.headers['cache-control'], 'no-store');
  const none = await f.fetcher(`${ORIGIN}${GONE_PATH}?authorityId=doc-fixture&projectId=${id('b')}`);
  assert.equal(none.status, 404); assert.equal(none.headers['access-control-allow-origin'], '*'); assert.equal((await none.json()).code, 'no-tombstone');
  assert.equal((await f.fetcher(`${ORIGIN}${GONE_PATH}?authorityId=doc-fixture&projectId=nope`)).status, 400);
  assert.equal((await f.fetcher(`${ORIGIN}${GONE_PATH}?authorityId=wrong&projectId=${id('a')}`)).status, 409);
  const post = await f.fetcher(`${ORIGIN}${GONE_PATH}?authorityId=doc-fixture&projectId=${id('a')}`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(post.status, 401, '只有 GET 是公开的'); assert.equal(post.headers['access-control-allow-origin'], undefined);
  const status = await f.fetcher(`${ORIGIN}/hosted/shared/account/status?authorityId=doc-fixture&projectId=${id('a')}`);
  assert.equal(status.status, 401, '带登录的状态接口照旧要登录'); assert.equal(status.headers['access-control-allow-origin'], undefined);

  const bare = fixture(t, { signing: false });
  applyLegacyTombstones(bare.ledger, [id('a')], { source: 'test' });
  const unsigned = await bare.fetcher(`${ORIGIN}${GONE_PATH}?authorityId=doc-fixture&projectId=${id('a')}`);
  assert.equal(unsigned.status, 503); assert.equal((await unsigned.json()).code, 'gone-proof-unavailable');
});
