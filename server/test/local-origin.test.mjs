/**
 * 「本机」按真正的发起方判断（语义 `docs/semantics/product/document-service.md`「本机按真正的发起方判断」；契约
 * `docs/plan/http-transport-contract.md` 第 10 节〔裁：2026-09-27 主会话，HT-a〕）：套接字对端是回环，且转发头
 * （`Forwarded` 的 `for=`、`X-Forwarded-For` 的每一跳、`X-Real-IP`）里每一跳都是回环，才算本机；本机信任开关为 0 时一律不算。
 * 跑：node --test server/test/local-origin.test.mjs
 *
 *   - 纯函数：`forwardedHops`、`isLocalOrigin`、`remoteTagOf`（`server/auth/origin.mjs`）与 `http-guard.mjs` 的
 *     `fromLocalClient`、素材服务的 `isLoopbackRequest`；
 *   - 托管组合（进程内，端口 0、只绑回环）：文档服务握手（回环不带凭证）、素材读（不带票据）、管理接口（不带令牌）
 *     三处，在直连、带外网转发头、带全回环转发头、`Forwarded` 头、信任开关为 0 几种情况下的结果。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { forwardedHops, isLocalOrigin, remoteTagOf, isLoopbackAddress } from '../auth/origin.mjs';
import { fromLocalClient, STAGE_CLIENT_HEADER } from '../http-guard.mjs';
import { registerTsResolve } from '../hosted/ts-resolve.mjs';
import { startHostedCombo } from '../hosted/combo.mjs';

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('LO-hops 转发头逐跳解析：X-Forwarded-For 每一跳、Forwarded 的 for=（引号、方括号、端口）、X-Real-IP', () => {
  assert.deepEqual(forwardedHops(req('127.0.0.1')), []);
  assert.deepEqual(forwardedHops(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5, 127.0.0.1' })), ['203.0.113.5', '127.0.0.1']);
  assert.deepEqual(forwardedHops(req('127.0.0.1', { forwarded: 'for=192.0.2.60;proto=http;by=203.0.113.43, for="[2001:db8:cafe::17]:4711"' })), ['192.0.2.60', '2001:db8:cafe::17']);
  assert.deepEqual(forwardedHops(req('127.0.0.1', { forwarded: 'For="[::1]:5555"', 'x-real-ip': '127.0.0.1' })), ['::1', '127.0.0.1']);
  assert.deepEqual(forwardedHops(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1:5555' })), ['127.0.0.1']);
  assert.deepEqual(forwardedHops(req('127.0.0.1', { 'x-forwarded-for': ['127.0.0.1', '10.0.0.2'] })), ['127.0.0.1', '10.0.0.2']);
  assert.deepEqual(forwardedHops(req('127.0.0.1', { 'x-forwarded-for': ' , ' })), [], '空的跳不算');
});

test('LO-local 判本机：直连回环算；回环 + 外网转发头不算；全回环链算；Forwarded 同理；对端不是回环的一律不算', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.5.6.7']) assert.equal(isLocalOrigin(req(a)), true, `直连 ${a}`);
  assert.equal(isLocalOrigin(req('192.168.1.9')), false);
  assert.equal(isLocalOrigin(req(undefined)), false, '没有对端地址');
  // X-Forwarded-For
  assert.equal(isLocalOrigin(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })), false, '回环 + 外网 XFF');
  assert.equal(isLocalOrigin(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, ::1' })), true, '全回环 XFF');
  assert.equal(isLocalOrigin(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 198.51.100.2, 127.0.0.1' })), false, '中间一跳不是回环');
  assert.equal(isLocalOrigin(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.20' })), false, '局域网地址也不是本机');
  // Forwarded
  assert.equal(isLocalOrigin(req('127.0.0.1', { forwarded: 'for=203.0.113.5;proto=https' })), false, '回环 + 外网 Forwarded');
  assert.equal(isLocalOrigin(req('127.0.0.1', { forwarded: 'for=127.0.0.1, for="[::1]:8080"' })), true, '全回环 Forwarded');
  assert.equal(isLocalOrigin(req('127.0.0.1', { forwarded: 'for=unknown' })), false, 'for=unknown 不算回环');
  assert.equal(isLocalOrigin(req('127.0.0.1', { forwarded: 'for=_hidden' })), false, '混淆名不算回环');
  // X-Real-IP
  assert.equal(isLocalOrigin(req('127.0.0.1', { 'x-real-ip': '203.0.113.5' })), false);
  assert.equal(isLocalOrigin(req('127.0.0.1', { 'x-real-ip': '127.0.0.1' })), true);
  // 只收紧不放宽：对端不是回环，转发头写回环也不算
  assert.equal(isLocalOrigin(req('203.0.113.5', { 'x-forwarded-for': '127.0.0.1' })), false);
  assert.equal(isLocalOrigin(req('203.0.113.5', { forwarded: 'for=127.0.0.1', 'x-real-ip': '127.0.0.1' })), false);
  // 调用方换成已认过的真实对端（舞台端口代理）
  assert.equal(isLocalOrigin(req('127.0.0.1'), '192.168.1.9'), false);
});

test('LO-remote-tag 日志与限速用的来源：经代理转来的回环记成 proxied:<对端>，不再像回环', () => {
  assert.equal(remoteTagOf(req('127.0.0.1')), '127.0.0.1');
  assert.equal(remoteTagOf(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })), '127.0.0.1');
  assert.equal(remoteTagOf(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })), 'proxied:127.0.0.1');
  assert.equal(remoteTagOf(req('::1', { forwarded: 'for=203.0.113.5' })), 'proxied:::1');
  assert.equal(remoteTagOf(req('203.0.113.5', { 'x-forwarded-for': '1.2.3.4' })), '203.0.113.5');
  assert.equal(remoteTagOf(req(undefined)), null);
  assert.equal(isLoopbackAddress('proxied:127.0.0.1'), false);
  assert.equal(isLocalOrigin(req('proxied:127.0.0.1')), false, '只凭来源地址判本机的地方（创建者操作的限速豁免）不当本机');
});

test('LO-guards 编辑器的 /api 守卫与素材服务的缺省判据同样看转发头（舞台端口代理写进的真实对端照旧）', async () => {
  // 素材服务是 .ts，里面有不带扩展名的相对引用：同托管组合一样先装解析钩子（`hosted/ts-resolve.mjs`）
  registerTsResolve();
  const { isLoopbackRequest } = await import('../asset-service.ts');
  assert.equal(fromLocalClient(req('127.0.0.1')), true);
  assert.equal(fromLocalClient({ headers: {} }), true, '没有 socket 的进程内请求算本机');
  assert.equal(fromLocalClient(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })), false);
  assert.equal(fromLocalClient(req('127.0.0.1', { [STAGE_CLIENT_HEADER]: '127.0.0.1' })), true, '舞台端口代理转来的本机');
  assert.equal(fromLocalClient(req('127.0.0.1', { [STAGE_CLIENT_HEADER]: '192.168.1.9' })), false, '舞台端口代理转来的局域网设备');
  assert.equal(isLoopbackRequest(req('127.0.0.1')), true);
  assert.equal(isLoopbackRequest(req('127.0.0.1', { forwarded: 'for=203.0.113.5' })), false);
  assert.equal(isLoopbackRequest(req('127.0.0.1', { forwarded: 'for=127.0.0.1' })), true);
});

// ------------------------------------------------------------------ 托管组合：三处都照这条判

/** 原始 WebSocket 握手，可带任意请求头；回状态码 */
function handshake(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', reject);
    let buf = '';
    sock.on('connect', () => {
      const lines = ['GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Protocol: promptcut.v1'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) { sock.destroy(); resolve(Number(m[1])); }
    });
    setTimeout(() => { sock.destroy(); reject(new Error('握手超时')); }, 3000).unref();
  });
}

async function startCombo(t, { trustLoopback }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-lo-'));
  const clusterToken = crypto.randomBytes(32).toString('base64url');
  const combo = await startHostedCombo({ dataDir, docPort: 0, assetPort: 0, host: '127.0.0.1', clusterToken, trustLoopback, log: () => {} });
  t.after(async () => {
    await combo.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return combo;
}

const HASH = 'cd'.repeat(32);
async function probe(combo, headers) {
  const hs = await handshake(combo.docPort, headers);
  const media = (await fetch(`http://127.0.0.1:${combo.assetPort}/api/asset/media/${HASH}`, { headers })).status;
  const admin = (await fetch(`http://127.0.0.1:${combo.assetPort}/admin/inventory`, { headers })).status;
  return { handshake: hs, media, admin };
}

const LOCAL = { handshake: 101, media: 404, admin: 200 };
const REMOTE = { handshake: 401, media: 401, admin: 401 };
const CASES = [
  ['直连回环', {}, LOCAL],
  ['X-Forwarded-For 外网地址', { 'X-Forwarded-For': '203.0.113.5' }, REMOTE],
  ['X-Forwarded-For 全回环链', { 'X-Forwarded-For': '127.0.0.1, ::1' }, LOCAL],
  ['X-Forwarded-For 链上一跳外网', { 'X-Forwarded-For': '127.0.0.1, 203.0.113.5' }, REMOTE],
  ['Forwarded 外网地址', { Forwarded: 'for=203.0.113.5;proto=https' }, REMOTE],
  ['Forwarded 全回环', { Forwarded: 'for=127.0.0.1, for="[::1]:4711"' }, LOCAL],
  ['X-Real-IP 外网地址', { 'X-Real-IP': '198.51.100.7' }, REMOTE],
];

test('LO-combo 信任开关为 1：文档服务握手、素材读、管理接口三处都按真正的发起方判本机', { timeout: 60_000 }, async (t) => {
  const combo = await startCombo(t, { trustLoopback: true });
  for (const [label, headers, want] of CASES) assert.deepEqual(await probe(combo, headers), want, label);
});

test('LO-combo-off 信任开关为 0：不论有没有转发头都不算本机', { timeout: 60_000 }, async (t) => {
  const combo = await startCombo(t, { trustLoopback: false });
  for (const [label, headers] of CASES) assert.deepEqual(await probe(combo, headers), REMOTE, label);
});
