/**
 * 会话信箱 v2（`scripts/probes/probe-coord-v2.mjs`）：身份、越权、只读、撤销与过期、幂等、重启后的 seq、设备授权、日志脱敏、旧信箱兼容。
 * 全部用临时目录、测试服务自己签发的虚拟令牌和隔离的收件箱；不连生产信箱，不唤起任何真实会话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startV2Server, v2Client, deviceLogin, V2 } from '../../scripts/probes/probe-coord-v2.mjs';
import { startCoordServer, mailClient } from '../../scripts/probes/probe-coord.mjs';

const FAST_SCRYPT = { N: 1024, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pcv2-'));
const sockPath = (dir) => (process.platform === 'win32' ? `\\\\.\\pipe\\pcv2-${crypto.randomBytes(6).toString('hex')}` : path.join(dir, 'admin.sock'));

/** 起一个带两三个主体的测试服务；`clock.t` 可拨 */
async function setup({ storeFile = null, auditFile = null, adminSocket = null, clock = { t: Date.now() } } = {}) {
  const srv = await startV2Server({ port: 0, storeFile, auditFile, adminSocket, now: () => clock.t, scryptParams: FAST_SCRYPT });
  const base = `${srv.url}/v2`;
  const admin = async (cmd, body) => { const [status, j] = await srv.adminHandle(cmd, body); assert.equal(status, 200, `${cmd}: ${JSON.stringify(j)}`); return j; };
  return { srv, base, admin, clock };
}
async function principals(admin) {
  await admin('principal-add', { id: 'doger', kind: 'doger', maxScopes: ['status', 'inbox:read', 'send'], sendTo: ['codex-laptop'] });
  await admin('principal-add', { id: 'codex-laptop', kind: 'codex', maxScopes: ['status', 'inbox:read', 'send'], sendTo: ['doger', 'claude-cloud'] });
  await admin('principal-add', { id: 'claude-cloud', kind: 'claude', maxScopes: ['status', 'inbox:read', 'send'], sendTo: ['codex-laptop'] });
}
const issue = async (admin, principal, scopes, sendTo = [], ttlDays = 7) => (await admin('token-issue', { principal, scopes, sendTo, ttlDays })).token;
const raw = async (base, p, { method = 'GET', token, headers = {}, body } = {}) => {
  const res = await fetch(`${base}${p}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, j: await res.json().catch(() => null) };
};
const send = (base, token, msg, key = crypto.randomUUID()) => raw(base, '/messages', { method: 'POST', token, headers: { 'Idempotency-Key': key }, body: msg });

test('V2-1 健康接口只回 { ok: true }；旧协调口 healthMode minimal 也一样，缺省不变', async () => {
  const { srv, base } = await setup();
  try {
    const h = await raw(base, '/health');
    assert.equal(h.status, 200);
    assert.deepEqual(h.j, { ok: true });
  } finally { await srv.close(); }
  const full = await startCoordServer({ port: 0, mail: { token: 'legacy-token-0123456789' } });
  const min = await startCoordServer({ port: 0, mail: { token: 'legacy-token-0123456789' }, healthMode: 'minimal' });
  try {
    await fetch(`${full.url}/kv/run.secret-name`, { method: 'PUT', headers: { 'X-Mail-Token': 'legacy-token-0123456789' }, body: '{}' });
    const a = await (await fetch(`${full.url}/healthz`)).json();
    assert.ok(Array.isArray(a.keys) && a.mail, '缺省行为不变');
    await fetch(`${min.url}/kv/run.secret-name`, { method: 'PUT', headers: { 'X-Mail-Token': 'legacy-token-0123456789' }, body: '{}' });
    assert.deepEqual(await (await fetch(`${min.url}/healthz`)).json(), { ok: true });
  } finally { await full.close(); await min.close(); }
});

test('V2-2 身份伪造：from 由令牌决定；改秘密、乱格式、旧共享令牌、X-Mail-Token 头一律 401', async () => {
  const { srv, base, admin } = await setup();
  try {
    await principals(admin);
    const dog = await issue(admin, 'doger', ['status', 'inbox:read', 'send'], ['codex-laptop']);
    const codex = await issue(admin, 'codex-laptop', ['status', 'inbox:read']);
    const r = await send(base, dog, { from: 'claude-cloud', to: 'codex-laptop', kind: 'question', body: 'hi' });
    assert.equal(r.status, 201);
    assert.equal(r.j.message.from, 'doger', '客户端自填的 from 被忽略');
    const inbox = await raw(base, '/inbox?after=0', { token: codex });
    assert.equal(inbox.j.messages[0].from, 'doger');
    const forged = `${dog.slice(0, -4)}AAAA`;
    for (const t of [forged, 'pcm2_0000000000000000_' + 'A'.repeat(43), 'not-a-token', 'legacy-token-0123456789']) {
      const x = await raw(base, '/whoami', { token: t });
      assert.equal(x.status, 401, t.slice(0, 8));
      assert.equal(x.j.error, 'invalid_token');
    }
    const legacyHeader = await raw(base, '/whoami', { headers: { 'X-Mail-Token': 'legacy-token-0123456789' } });
    assert.equal(legacyHeader.status, 401);
  } finally { await srv.close(); }
});

test('V2-3 跨会话越权：只读得到自己的收件箱；看、改别人的消息 404；发给授权外的接收方 403', async () => {
  const { srv, base, admin } = await setup();
  try {
    await principals(admin);
    const codex = await issue(admin, 'codex-laptop', ['status', 'inbox:read', 'send'], ['doger', 'claude-cloud']);
    const dog = await issue(admin, 'doger', ['status', 'inbox:read', 'send'], ['codex-laptop']);
    const claude = await issue(admin, 'claude-cloud', ['status', 'inbox:read', 'send'], ['codex-laptop']);
    const toDoger = await send(base, codex, { to: 'doger', kind: 'instruction', body: 'for doger only' });
    assert.equal(toDoger.status, 201);
    const id = toDoger.j.message.id;
    const claudeInbox = await raw(base, '/inbox?after=0', { token: claude });
    assert.deepEqual(claudeInbox.j.messages, [], 'claude 看不到发给 doger 的');
    assert.equal(claudeInbox.j.principal, 'claude-cloud');
    assert.equal((await raw(base, `/messages/${id}`, { token: claude })).status, 404);
    assert.equal((await raw(base, `/messages/${id}/state`, { method: 'POST', token: claude, body: { state: 'processed' } })).status, 404);
    assert.equal((await raw(base, `/messages/${id}`, { token: dog })).status, 200, '接收方能看');
    assert.equal((await raw(base, `/messages/${id}`, { token: codex })).status, 200, '发送方能看');
    const sideways = await send(base, dog, { to: 'claude-cloud', kind: 'instruction', body: 'x' });
    assert.equal(sideways.status, 403);
    assert.equal(sideways.j.error, 'recipient-not-allowed');
    const narrow = await issue(admin, 'codex-laptop', ['status', 'send'], ['claude-cloud']); // 主体能发给 doger，这个令牌只给了 claude-cloud
    const narrowed = await send(base, narrow, { to: 'doger', kind: 'instruction', body: 'x' });
    assert.equal(narrowed.status, 403, '令牌收窄过的接收方以令牌为准，不以主体上限为准');
    assert.equal((await send(base, narrow, { to: 'claude-cloud', kind: 'status', body: 'ok' })).status, 201);
    const ghost = await send(base, dog, { to: 'nobody', kind: 'instruction', body: 'x' });
    assert.equal(ghost.status, 403, '不存在的接收方回同一个 403');
    assert.equal(ghost.j.error, 'recipient-not-allowed');
  } finally { await srv.close(); }
});

test('V2-4 只读身份：缺省令牌没有 send，发消息 403；只有 status 的读不了收件箱；签发不能超过主体上限', async () => {
  const { srv, base, admin } = await setup();
  try {
    await principals(admin);
    await admin('principal-add', { id: 'viewer', kind: 'other', sendTo: [] });
    const ro = (await admin('token-issue', { principal: 'doger', ttlDays: 1 })).token; // 缺省 scope
    const who = await raw(base, '/whoami', { token: ro });
    assert.deepEqual(who.j.scopes, [...V2.DEFAULT_SCOPES]);
    const r = await send(base, ro, { to: 'codex-laptop', kind: 'instruction', body: 'x' });
    assert.equal(r.status, 403);
    assert.equal(r.j.error, 'insufficient_scope');
    const statusOnly = await issue(admin, 'doger', ['status']);
    assert.equal((await raw(base, '/inbox', { token: statusOnly })).status, 403);
    const [st, j] = await srv.adminHandle('token-issue', { principal: 'viewer', scopes: ['send'], ttlDays: 1 });
    assert.equal(st, 400);
    assert.equal(j.error, 'scope-over-limit');
    const [st2, j2] = await srv.adminHandle('token-issue', { principal: 'doger', scopes: ['status', 'send'], sendTo: ['claude-cloud'], ttlDays: 1 });
    assert.equal(st2, 400);
    assert.equal(j2.error, 'send-to-over-limit');
    const [st3, j3] = await srv.adminHandle('token-issue', { principal: 'doger', ttlDays: 365 });
    assert.equal(st3, 400);
    assert.equal(j3.error, 'bad-ttl');
  } finally { await srv.close(); }
});

test('V2-5 撤销、主体停用、令牌过期、消息过期', async () => {
  const clock = { t: Date.parse('2026-10-04T00:00:00Z') };
  const { srv, base, admin } = await setup({ clock });
  try {
    await principals(admin);
    const a = (await admin('token-issue', { principal: 'doger', ttlDays: 1 }));
    const b = await issue(admin, 'doger', ['status'], [], 1);
    const codex = await issue(admin, 'codex-laptop', ['status', 'inbox:read', 'send'], ['doger'], 30);
    assert.equal((await raw(base, '/whoami', { token: a.token })).status, 200);
    await admin('token-revoke', { tokenId: a.record.id });
    assert.equal((await raw(base, '/whoami', { token: a.token })).status, 401, '撤销即失效');
    assert.equal((await raw(base, '/whoami', { token: b })).status, 200, '只撤一个，另一个照常');
    clock.t += 86_400_000 + 1;
    assert.equal((await raw(base, '/whoami', { token: b })).status, 401, '过期即失效');
    const m = await send(base, codex, { to: 'doger', kind: 'status', body: 'short-lived', ttlSeconds: 60 });
    const dog2 = await issue(admin, 'doger', ['status', 'inbox:read'], [], 7);
    assert.equal((await raw(base, '/inbox?after=0', { token: dog2 })).j.messages.length, 1);
    clock.t += 61_000;
    assert.equal((await raw(base, '/inbox?after=0', { token: dog2 })).j.messages.length, 0, '过期消息不再投递');
    assert.equal((await raw(base, `/messages/${m.j.message.id}/state`, { method: 'POST', token: dog2, body: { state: 'processed' } })).status, 410);
    await admin('principal-disable', { id: 'codex-laptop' });
    assert.equal((await raw(base, '/whoami', { token: codex })).status, 401, '主体停用，它的令牌都失效');
  } finally { await srv.close(); }
});

test('V2-6 幂等：同键重发回同一条、收件箱只有一条；同键换内容 409；不带键 400；客户端重试用同一个键', async () => {
  const { srv, base, admin } = await setup();
  try {
    await principals(admin);
    const codex = await issue(admin, 'codex-laptop', ['status', 'inbox:read', 'send'], ['doger']);
    const dog = await issue(admin, 'doger', ['status', 'inbox:read']);
    const key = 'retry-key-0001';
    const one = await send(base, codex, { to: 'doger', kind: 'instruction', body: 'do once' }, key);
    const two = await send(base, codex, { to: 'doger', kind: 'instruction', body: 'do once' }, key);
    assert.equal(one.status, 201);
    assert.equal(two.status, 200);
    assert.equal(two.j.replayed, true);
    assert.equal(two.j.message.id, one.j.message.id);
    assert.equal((await raw(base, '/inbox?after=0', { token: dog })).j.messages.length, 1);
    const conflict = await send(base, codex, { to: 'doger', kind: 'instruction', body: 'something else' }, key);
    assert.equal(conflict.status, 409);
    const noKey = await raw(base, '/messages', { method: 'POST', token: codex, body: { to: 'doger', kind: 'status', body: 'x' } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.j.error, 'bad-idempotency-key');
    const c = v2Client(base, codex);
    const r1 = await c.send({ to: 'doger', kind: 'status', body: 'cli', idempotencyKey: 'client-key-0002' });
    const r2 = await c.send({ to: 'doger', kind: 'status', body: 'cli', idempotencyKey: 'client-key-0002' });
    assert.equal(r1.message.id, r2.message.id);
    assert.equal((await raw(base, '/inbox?after=0', { token: dog })).j.messages.length, 2);
  } finally { await srv.close(); }
});

test('V2-7 收到 / 已处理 / 失败：只有接收方能报；终态不能换；发送方看得到状态；replyTo 只能指向自己收到的', async () => {
  const { srv, base, admin } = await setup();
  try {
    await principals(admin);
    const codex = await issue(admin, 'codex-laptop', ['status', 'inbox:read', 'send'], ['doger']);
    const dog = await issue(admin, 'doger', ['status', 'inbox:read', 'send'], ['codex-laptop']);
    const m = (await send(base, codex, { to: 'doger', kind: 'instruction', body: 'job' })).j.message;
    assert.deepEqual(m.state, { received: null, processed: null, failed: null });
    const st = (s) => raw(base, `/messages/${m.id}/state`, { method: 'POST', token: dog, body: { state: s, detail: 'd' } });
    assert.ok((await st('received')).j.message.state.received);
    assert.equal((await st('processed')).status, 200);
    assert.equal((await st('processed')).status, 200, '同一终态重复报幂等');
    const c = await st('failed');
    assert.equal(c.status, 409);
    assert.equal(c.j.state, 'processed');
    assert.equal((await raw(base, `/messages/${m.id}/state`, { method: 'POST', token: codex, body: { state: 'received' } })).status, 404, '发送方不能替接收方报');
    const seen = await raw(base, `/messages/${m.id}`, { token: codex });
    assert.ok(seen.j.message.state.processed, '发送方能看到已处理');
    const reply = await send(base, dog, { to: 'codex-laptop', kind: 'receipt', body: 'done', replyTo: m.id });
    assert.equal(reply.status, 201);
    assert.equal(reply.j.message.replyTo, m.id);
    const ownSent = (await send(base, codex, { to: 'doger', kind: 'status', body: 'x' })).j.message;
    const bad = await send(base, codex, { to: 'doger', kind: 'receipt', body: 'x', replyTo: ownSent.id });
    assert.equal(bad.status, 400, '不能回复自己发出的消息');
    assert.equal(bad.j.error, 'bad-reply-to');
  } finally { await srv.close(); }
});

test('V2-8 重启后 seq 接着编、游标不失效、令牌与状态都在；存储与审计文件是 0600', async () => {
  const dir = tmpdir();
  const storeFile = path.join(dir, 'store.json');
  const auditFile = path.join(dir, 'audit.jsonl');
  let s1 = await setup({ storeFile, auditFile });
  await principals(s1.admin);
  const codex = await issue(s1.admin, 'codex-laptop', ['status', 'inbox:read', 'send'], ['doger']);
  const dog = await issue(s1.admin, 'doger', ['status', 'inbox:read']);
  const a = (await send(s1.base, codex, { to: 'doger', kind: 'status', body: '1' })).j.message;
  await send(s1.base, codex, { to: 'doger', kind: 'status', body: '2' });
  await raw(s1.base, `/messages/${a.id}/state`, { method: 'POST', token: dog, body: { state: 'processed' } });
  await s1.srv.close();
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(storeFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600);
  }
  const s2 = await setup({ storeFile, auditFile });
  try {
    const c = (await send(s2.base, codex, { to: 'doger', kind: 'status', body: '3' })).j.message;
    assert.equal(c.seq, 3, 'seq 接着编');
    const after2 = await raw(s2.base, '/inbox?after=2', { token: dog });
    assert.deepEqual(after2.j.messages.map((m) => m.body), ['3'], '游标 after=2 只读到新的');
    assert.equal(after2.j.last, 3);
    assert.ok((await raw(s2.base, `/messages/${a.id}`, { token: dog })).j.message.state.processed, '状态在');
    const dup = await send(s2.base, codex, { to: 'doger', kind: 'status', body: '3' }, 'after-restart-key');
    assert.equal(dup.status, 201);
  } finally { await s2.srv.close(); s1 = null; }
});

test('V2-9 长轮询：没有新消息就挂着，新消息一到就醒；别人的消息不叫醒我', async () => {
  const { srv, base, admin } = await setup();
  try {
    await principals(admin);
    const codex = await issue(admin, 'codex-laptop', ['status', 'inbox:read', 'send'], ['doger', 'claude-cloud']);
    const dog = await issue(admin, 'doger', ['status', 'inbox:read']);
    const t0 = Date.now();
    const pending = raw(base, '/inbox?after=0&wait=5', { token: dog });
    await new Promise((r) => setTimeout(r, 150));
    await send(base, codex, { to: 'claude-cloud', kind: 'status', body: 'not yours' });
    await new Promise((r) => setTimeout(r, 150));
    await send(base, codex, { to: 'doger', kind: 'status', body: 'yours' });
    const got = await pending;
    assert.deepEqual(got.j.messages.map((m) => m.body), ['yours']);
    assert.ok(Date.now() - t0 < 4000, '新消息一到就回，不等满');
  } finally { await srv.close(); }
});

test('V2-10 设备授权：待批 → 口令错 → 登录 → 收窄后批准 → 一次性换到令牌；轮询太快 slow_down；码不能重用；拒绝与 CSRF', async () => {
  const { srv, base, admin, clock } = await setup();
  try {
    await principals(admin);
    await admin('passphrase-set', { passphrase: 'correct horse battery staple' });
    const post = async (p, form, cookie) => {
      const res = await fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(form).toString() });
      return { status: res.status, res, text: await res.text() };
    };
    const code = JSON.parse((await post('/device/code', { principal: 'doger', scopes: 'status inbox:read send', send_to: 'codex-laptop claude-cloud', label: 'doger laptop' })).text);
    assert.match(code.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.ok(code.verification_uri.endsWith('/v2/device'));
    assert.equal(code.verification_uri_complete, undefined, '不给带码的地址');
    const poll = (dc = code.device_code) => post('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc });
    assert.equal(JSON.parse((await poll()).text).error, 'authorization_pending');
    assert.equal(JSON.parse((await poll()).text).error, 'slow_down', '间隔内再问 slow_down');
    const bad = await post('/login', { passphrase: 'wrong passphrase!!' });
    assert.equal(bad.status, 401);
    const ok = await post('/login', { passphrase: 'correct horse battery staple' });
    assert.equal(ok.status, 303);
    const setCookie = ok.res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];
    const pageRes = await fetch(`${base}/device?user_code=${encodeURIComponent(code.user_code)}`, { headers: { Cookie: cookie } });
    const html = await pageRes.text();
    assert.match(pageRes.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(html, /doger/);
    assert.match(html, /claude-cloud/, '页面写明了超过上限、不会给的接收方');
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    const noCsrf = await post('/device/approve', { user_code: code.user_code, decision: 'approve', scope: 'status', ttl_days: '7' }, cookie);
    assert.equal(noCsrf.status, 403);
    const approve = await post('/device/approve', new URLSearchParams([['csrf', csrf], ['user_code', code.user_code], ['decision', 'approve'], ['scope', 'status'], ['scope', 'inbox:read'], ['ttl_days', '7']]).toString(), cookie);
    assert.equal(approve.status, 200);
    clock.t += (V2.DEVICE_INTERVAL_S + 5) * 1000 + 1; // slow_down 后间隔加了 5 s（拨服务端的钟，不真等）
    const tok = JSON.parse((await poll()).text);
    assert.equal(tok.token_type, 'Bearer');
    assert.equal(tok.scope, 'status inbox:read', '批准时收窄掉了 send');
    const who = await raw(base, '/whoami', { token: tok.access_token });
    assert.equal(who.j.principal, 'doger');
    assert.deepEqual(who.j.sendTo, []);
    assert.equal(JSON.parse((await poll()).text).error, 'invalid_grant', 'device_code 只能兑换一次');
    const code2 = JSON.parse((await post('/device/code', { principal: 'doger' })).text);
    const page2 = await (await fetch(`${base}/device?user_code=${encodeURIComponent(code2.user_code)}`, { headers: { Cookie: cookie } })).text();
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(page2)[1];
    await post('/device/approve', { csrf: csrf2, user_code: code2.user_code, decision: 'deny' }, cookie);
    assert.equal(JSON.parse((await poll(code2.device_code)).text).error, 'access_denied');
    const anon = await fetch(`${base}/device`);
    assert.match(await anon.text(), /type="password"/, '没登录只给登录表单');
  } finally { await srv.close(); }
});

test('V2-11 deviceLogin 客户端：令牌只写进 0600 文件，提示里只有 user_code 与地址', async () => {
  const dir = tmpdir();
  const { srv, base, admin } = await setup();
  try {
    await principals(admin);
    await admin('passphrase-set', { passphrase: 'correct horse battery staple' });
    const tokenFile = path.join(dir, 'doger.token');
    let prompt = null;
    const approveLater = async () => {
      while (!prompt) await new Promise((r) => setTimeout(r, 20));
      const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'passphrase=correct+horse+battery+staple' });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const html = await (await fetch(`${base}/device?user_code=${encodeURIComponent(prompt.user_code)}`, { headers: { Cookie: cookie } })).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
      await fetch(`${base}/device/approve`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams([['csrf', csrf], ['user_code', prompt.user_code], ['decision', 'approve'], ['scope', 'status'], ['scope', 'inbox:read'], ['scope', 'send'], ['send_to', 'codex-laptop'], ['ttl_days', '3']]).toString() });
    };
    const [r] = await Promise.all([
      deviceLogin(base, { principal: 'doger', scopes: ['status', 'inbox:read', 'send'], sendTo: ['codex-laptop'], tokenFile, onPrompt: (p) => { prompt = p; }, sleep: () => new Promise((res) => setTimeout(res, 50)) }),
      approveLater(),
    ]);
    assert.deepEqual(Object.keys(prompt).sort(), ['expires_in', 'user_code', 'verification_uri']);
    assert.equal(r.scope, 'status inbox:read send');
    if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.equal((await v2Client(base, token).whoami()).principal, 'doger');
  } finally { await srv.close(); }
});

test('V2-12 审计日志脱敏：不含令牌秘密、正文、完整 user_code、口令；只记白名单字段', async () => {
  const dir = tmpdir();
  const auditFile = path.join(dir, 'audit.jsonl');
  const { srv, base, admin } = await setup({ auditFile });
  try {
    await principals(admin);
    await admin('passphrase-set', { passphrase: 'very secret passphrase' });
    const codex = await issue(admin, 'codex-laptop', ['status', 'inbox:read', 'send'], ['doger']);
    await send(base, codex, { to: 'doger', kind: 'instruction', body: 'TOP-SECRET-BODY-TEXT' });
    await raw(base, '/whoami', { token: `${codex.slice(0, -2)}xx` });
    const code = await (await fetch(`${base}/device/code`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'principal=doger' })).json();
    const log = fs.readFileSync(auditFile, 'utf8');
    const secret = codex.split('_')[2];
    assert.ok(!log.includes(secret), '不含令牌秘密');
    assert.ok(!log.includes('TOP-SECRET-BODY-TEXT'), '不含正文');
    assert.ok(!log.includes('very secret passphrase'), '不含口令');
    assert.ok(!log.includes(code.user_code.replace('-', '')) && !log.includes(code.user_code), '不含完整 user_code');
    assert.ok(!log.includes(code.device_code), '不含 device_code');
    const events = log.trim().split('\n').map((l) => JSON.parse(l).event);
    for (const e of ['token.issue', 'message.post', 'auth.fail', 'device.code']) assert.ok(events.includes(e), e);
  } finally { await srv.close(); }
});

test('V2-13 审计日志与过期消息按保留期裁剪', async () => {
  const dir = tmpdir();
  const auditFile = path.join(dir, 'audit.jsonl');
  const storeFile = path.join(dir, 'store.json');
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  const s1 = await setup({ auditFile, storeFile, clock });
  await principals(s1.admin);
  const codex = await issue(s1.admin, 'codex-laptop', ['status', 'inbox:read', 'send'], ['doger']);
  await send(s1.base, codex, { to: 'doger', kind: 'status', body: 'old', ttlSeconds: 60 });
  await s1.srv.close();
  clock.t += (V2.AUDIT_RETENTION_DAYS + 1) * 86_400_000;
  const s2 = await setup({ auditFile, storeFile, clock });
  try {
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.every((l) => Date.parse(l.t) >= clock.t - V2.AUDIT_RETENTION_DAYS * 86_400_000), '旧审计行被裁掉');
    assert.equal(Object.keys(s2.srv.store.data.messages).length, 0, '过期超过保留期的消息被删');
    assert.equal(s2.srv.store.lastSeq('doger'), 1, 'seq 计数不随消息删除回退');
  } finally { await s2.srv.close(); }
});

test('V2-14 管理口只在本机套接字上：0600；HTTP 端口上没有 /admin', async () => {
  const dir = tmpdir();
  const adminSocket = sockPath(dir);
  const { srv, base } = await setup({ adminSocket });
  try {
    if (process.platform !== 'win32') assert.equal(fs.statSync(adminSocket).mode & 0o777, 0o600);
    const http = await import('node:http');
    const call = (cmd, body) => new Promise((resolve, reject) => {
      const req = http.request({ socketPath: adminSocket, path: `/admin/${cmd}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, j: JSON.parse(t) })); });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    assert.equal((await call('principal-add', { id: 'claude-cloud', kind: 'claude' })).status, 200);
    const issued = await call('token-issue', { principal: 'claude-cloud', ttlDays: 1 });
    assert.equal(issued.status, 200);
    assert.ok(!('secretHash' in issued.j.record), '对外的令牌记录不带哈希');
    const listed = await call('token-list', {});
    assert.ok(listed.j.tokens.every((t) => !('secretHash' in t)));
    assert.equal((await raw(base, '/whoami', { token: issued.j.token })).j.principal, 'claude-cloud');
    const viaHttp = await fetch(`${srv.url}/admin/principal-list`, { method: 'POST', body: '{}' });
    assert.equal(viaHttp.status, 404);
  } finally { await srv.close(); }
});

test('V2-15 旧客户端兼容：旧信箱照旧收发；v2 令牌进不了旧信箱，旧令牌进不了 v2；两边各编各的号', async () => {
  const legacyToken = 'legacy-shared-token-0123';
  const legacy = await startCoordServer({ port: 0, mail: { token: legacyToken } });
  const { srv, base, admin } = await setup();
  try {
    await principals(admin);
    const codex = await issue(admin, 'codex-laptop', ['status', 'inbox:read', 'send'], ['doger']);
    const mc = mailClient(legacy.url, legacyToken);
    const r = await mc.send('to-cloud', { from: 'local', kind: 'instruction', body: 'legacy works' });
    assert.equal(r.seq, 1);
    const got = await mc.read('to-cloud', 0, 0);
    assert.equal(got.messages[0].body, 'legacy works');
    const v2OnLegacy = await fetch(`${legacy.url}/mail/to-cloud`, { headers: { 'X-Mail-Token': codex } });
    assert.equal(v2OnLegacy.status, 401);
    const v2Bearer = await fetch(`${legacy.url}/mail/to-cloud`, { headers: { Authorization: `Bearer ${codex}` } });
    assert.equal(v2Bearer.status, 401);
    assert.equal((await raw(base, '/whoami', { token: legacyToken })).status, 401);
    const m = await send(base, codex, { to: 'doger', kind: 'status', body: 'v2' });
    assert.equal(m.j.message.seq, 1);
    assert.equal((await mc.read('to-cloud', 0, 0)).last, 1, 'v2 的消息不进旧队列');
  } finally { await srv.close(); await legacy.close(); }
});
