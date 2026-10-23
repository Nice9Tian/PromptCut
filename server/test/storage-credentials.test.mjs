// A2「凭据托管」:授权码兑换、加密落盘、按需换票、撤销
// (任务书 `docs/plan/drive-connector-task.md` 第 3 节,D4)。
// 跑:node --test server/test/storage-credentials.test.mjs
//
// 不碰网络:Google 的令牌服务用假 fetch。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';

import { createCredentialStore } from '../storage-connectors/credentials.mjs';
import { exchangeCode, refreshAccessToken, revokeToken } from '../storage-connectors/google-oauth.mjs';
import { connectWithCode, createManagedToken, disconnect } from '../storage-connectors/managed-token.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-storage-cred-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const freshDir = () => path.join(TMP, `d${++seq}`);

const SCOPE = { projectId: 'proj-A', userId: 'user-1', provider: 'google-drive' };
const OTHER_PROJECT = { ...SCOPE, projectId: 'proj-B' };
const OTHER_USER = { ...SCOPE, userId: 'user-2' };

const CLIENT = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost:5321/oauth2callback' };

function jsonFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    calls.push({ url: String(url), body });
    return handler(String(url), body, calls.length - 1);
  };
  impl.calls = calls;
  return impl;
}
const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const err = (error, status = 400) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

// ───────────────────────── 加密落盘 ─────────────────────────

test('存进去再取出来,是同一个 refresh token', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  await store.put(SCOPE, { refreshToken: 'rt-secret', scope: 'https://www.googleapis.com/auth/drive.file' });
  const got = await store.get(SCOPE);
  assert.equal(got.refreshToken, 'rt-secret');
  assert.equal(got.grantedScope, 'https://www.googleapis.com/auth/drive.file');
});

test('落盘的文件里看不到明文', async () => {
  const dir = freshDir();
  const store = createCredentialStore({ dir });
  await store.put(SCOPE, { refreshToken: 'rt-PLAINTEXT-MARKER' });
  const files = fs.readdirSync(path.join(dir, 'connectors'));
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(dir, 'connectors', files[0]), 'utf8');
  assert.ok(!raw.includes('rt-PLAINTEXT-MARKER'), '落盘内容里不该出现明文令牌');
  assert.ok(raw.includes('"iv"') && raw.includes('"tag"'), '应当是 AES-GCM 的形状');
});

test('没存过回 null,不抛', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  assert.equal(await store.get(SCOPE), null);
});

test('一格一份:别的项目、别的成员都读不到', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  await store.put(SCOPE, { refreshToken: 'rt-A' });
  assert.equal(await store.get(OTHER_PROJECT), null);
  assert.equal(await store.get(OTHER_USER), null);
  assert.equal((await store.get(SCOPE)).refreshToken, 'rt-A');
});

test('把文件挪到别的格子里,解不开(AAD 绑死了那一格)', async () => {
  const dir = freshDir();
  const store = createCredentialStore({ dir });
  await store.put(SCOPE, { refreshToken: 'rt-A' });
  await store.put(OTHER_PROJECT, { refreshToken: 'rt-B' });

  const d = path.join(dir, 'connectors');
  const files = fs.readdirSync(d);
  const recs = files.map((f) => ({ f, j: JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) }));
  const a = recs.find((r) => r.j.projectId === 'proj-A');
  const b = recs.find((r) => r.j.projectId === 'proj-B');
  // 把 A 的密文搬进 B 的文件里,元信息照旧
  fs.writeFileSync(path.join(d, b.f), JSON.stringify({ ...b.j, iv: a.j.iv, tag: a.j.tag, data: a.j.data }));

  await assert.rejects(() => store.get(OTHER_PROJECT), (e) => e.code === 'bad-credential');
  // A 自己还好好的
  assert.equal((await store.get(SCOPE)).refreshToken, 'rt-A');
});

test('换了密钥就解不开,而且说得明白', async () => {
  const dir = freshDir();
  await createCredentialStore({ dir }).put(SCOPE, { refreshToken: 'rt-A' });
  fs.writeFileSync(path.join(dir, 'connector-key'), Buffer.alloc(32, 7).toString('base64'));
  await assert.rejects(
    () => createCredentialStore({ dir }).get(SCOPE),
    (e) => e.code === 'bad-credential' && /重新授权/.test(e.message),
  );
});

test('重新授权覆盖同一格,createdAt 保留、updatedAt 变新', async () => {
  let t = 1000;
  const store = createCredentialStore({ dir: freshDir(), now: () => t });
  const first = await store.put(SCOPE, { refreshToken: 'rt-1' });
  t = 5000;
  const second = await store.put(SCOPE, { refreshToken: 'rt-2' });
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.updatedAt, 5000);
  assert.equal((await store.get(SCOPE)).refreshToken, 'rt-2');
});

test('list 只回元信息,一个令牌都不带', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  await store.put(SCOPE, { refreshToken: 'rt-NEVER-LIST-ME' });
  await store.put(OTHER_USER, { refreshToken: 'rt-ALSO-SECRET' });
  const rows = await store.list();
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes('rt-'), 'list 的结果里不许出现令牌');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['createdAt', 'grantedScope', 'projectId', 'provider', 'updatedAt', 'userId']);
  assert.equal((await store.list({ userId: 'user-2' })).length, 1);
});

test('remove 幂等;removeAll 按项目或成员一把清(踢人、删项目用)', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  await store.put(SCOPE, { refreshToken: 'a' });
  await store.put(OTHER_USER, { refreshToken: 'b' });
  await store.put(OTHER_PROJECT, { refreshToken: 'c' });

  await store.remove(SCOPE);
  await store.remove(SCOPE);                       // 再删一次也不报错
  assert.equal(await store.get(SCOPE), null);

  assert.equal(await store.removeAll({ projectId: 'proj-A' }), 1);  // 只剩 user-2 那一格
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.list())[0].projectId, 'proj-B');
});

test('scope 三段缺一不可', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  for (const bad of [{}, { projectId: 'p' }, { projectId: 'p', userId: 'u' }, { projectId: 'p', userId: 'u', provider: '' }]) {
    await assert.rejects(() => store.get(bad), TypeError);
  }
});

// ───────────────────────── 授权码兑换与换票 ─────────────────────────

test('exchangeCode:换出 refresh token,参数齐全', async () => {
  const fetchImpl = jsonFetch(() => ok({ refresh_token: 'rt', access_token: 'at', expires_in: 3599, scope: 'drive.file' }));
  const got = await exchangeCode({ code: 'c', codeVerifier: 'v', ...CLIENT, fetchImpl, now: () => 1000 });
  assert.equal(got.refreshToken, 'rt');
  assert.equal(got.expiresAt, 1000 + 3599 * 1000);
  const body = fetchImpl.calls[0].body;
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.code_verifier, 'v');
  assert.equal(body.redirect_uri, CLIENT.redirectUri);
});

test('exchangeCode:没给 refresh_token 时说清楚少了什么', async () => {
  const fetchImpl = jsonFetch(() => ok({ access_token: 'at', expires_in: 3599 }));
  await assert.rejects(
    () => exchangeCode({ code: 'c', codeVerifier: 'v', ...CLIENT, fetchImpl }),
    (e) => e.code === 'no-refresh-token' && /access_type=offline/.test(e.message),
  );
});

test('invalid_grant 归成 token-revoked,其余各归各的', async () => {
  const cases = [['invalid_grant', 400, 'token-revoked'], ['invalid_client', 401, 'bad-client'], ['invalid_request', 400, 'bad-request']];
  for (const [error, status, code] of cases) {
    const fetchImpl = jsonFetch(() => err(error, status));
    await assert.rejects(
      () => refreshAccessToken({ refreshToken: 'rt', clientId: 'c', clientSecret: 's', fetchImpl }),
      (e) => e.code === code,
      `${error} 应归成 ${code}`,
    );
  }
});

test('出错信息里不带令牌和密钥', async () => {
  const fetchImpl = jsonFetch(() => err('invalid_grant', 400));
  try {
    await refreshAccessToken({ refreshToken: 'rt-SECRET', clientId: 'cid', clientSecret: 'cs-SECRET', fetchImpl });
    assert.fail('应当抛');
  } catch (e) {
    assert.ok(!e.message.includes('rt-SECRET'));
    assert.ok(!e.message.includes('cs-SECRET'));
  }
});

test('revokeToken:Google 对已失效的令牌回 400,那不算失败', async () => {
  const fetchImpl = jsonFetch(() => err('invalid_token', 400));
  const res = await revokeToken({ token: 'rt', fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

// ───────────────────────── 串起来 ─────────────────────────

test('connectWithCode:存下来,回包里不带任何令牌', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  const fetchImpl = jsonFetch(() => ok({ refresh_token: 'rt-X', access_token: 'at', expires_in: 3599, scope: 'drive.file' }));
  const out = await connectWithCode({ store, scope: SCOPE, code: 'c', codeVerifier: 'v', ...CLIENT, fetchImpl });
  assert.equal(out.connected, true);
  assert.ok(!JSON.stringify(out).includes('rt-X'));
  assert.equal((await store.get(SCOPE)).refreshToken, 'rt-X');
});

test('createManagedToken:第一次换票,之后在有效期内直接复用', async () => {
  let t = 0;
  const store = createCredentialStore({ dir: freshDir() });
  await store.put(SCOPE, { refreshToken: 'rt' });
  let issued = 0;
  const fetchImpl = jsonFetch(() => ok({ access_token: `at-${issued++}`, expires_in: 3600 }));
  const token = createManagedToken({ store, scope: SCOPE, clientId: 'c', clientSecret: 's', fetchImpl, now: () => t });

  assert.equal(await token(), 'at-0');
  assert.equal(await token(), 'at-0');            // 还在有效期内,没再换
  assert.equal(fetchImpl.calls.length, 1);

  t = 3600 * 1000 - 4 * 60 * 1000;                // 还剩 4 分钟,进了 5 分钟的余量
  assert.equal(await token(), 'at-1');
  assert.equal(fetchImpl.calls.length, 2);
});

test('几路同时要票只换一次', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  await store.put(SCOPE, { refreshToken: 'rt' });
  const fetchImpl = jsonFetch(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return ok({ access_token: 'at', expires_in: 3600 });
  });
  const token = createManagedToken({ store, scope: SCOPE, clientId: 'c', clientSecret: 's', fetchImpl });
  const all = await Promise.all([token(), token(), token(), token()]);
  assert.deepEqual(all, ['at', 'at', 'at', 'at']);
  assert.equal(fetchImpl.calls.length, 1);
});

test('没接上过就要票:说清楚要先授权', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  const token = createManagedToken({ store, scope: SCOPE, clientId: 'c', clientSecret: 's', fetchImpl: jsonFetch(() => ok({})) });
  await assert.rejects(() => token(), (e) => e.code === 'no-credential' && /先授权/.test(e.message));
});

test('用户在 Google 账号页撤了:当场清掉存着的那份,不再重试', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  await store.put(SCOPE, { refreshToken: 'rt' });
  const fetchImpl = jsonFetch(() => err('invalid_grant', 400));
  const token = createManagedToken({ store, scope: SCOPE, clientId: 'c', clientSecret: 's', fetchImpl });

  await assert.rejects(() => token(), (e) => e.code === 'token-revoked' && /已清掉/.test(e.message));
  assert.equal(await store.get(SCOPE), null, '撤销后不该再留着那份凭据');
});

test('disconnect:向 Google 撤销并删掉本地那份', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  await store.put(SCOPE, { refreshToken: 'rt' });
  const fetchImpl = jsonFetch(() => new Response('', { status: 200 }));
  const out = await disconnect({ store, scope: SCOPE, fetchImpl });
  assert.deepEqual(out, { removed: true, revoked: true });
  assert.equal(await store.get(SCOPE), null);
  assert.equal(fetchImpl.calls[0].body.token, 'rt');
});

test('disconnect:Google 那边没撤成,本地那份照样删,并说明原因', async () => {
  const store = createCredentialStore({ dir: freshDir() });
  await store.put(SCOPE, { refreshToken: 'rt' });
  const fetchImpl = jsonFetch(() => new Response('', { status: 503 }));
  const out = await disconnect({ store, scope: SCOPE, fetchImpl });
  assert.equal(out.removed, true);
  assert.equal(out.revoked, false);
  assert.match(out.why, /503/);
  assert.equal(await store.get(SCOPE), null, '用户点了断开,本地就不该再留着能用的凭据');
});
