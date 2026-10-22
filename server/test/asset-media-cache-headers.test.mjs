import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountError } from '../account/client.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createProjectAssetAccess, assetAccessError } from '../asset-store/project-access.mjs';
import { createAccountProjectsInternalServer } from '../docservice/modules/account-projects.mjs';
import { startHostedAssetService } from '../hosted/asset-runtime.mjs';
import { startAssetProjectFixture, compileAssetModules } from './fixtures/asset-project-service.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LONG_CACHE = 'private, max-age=31536000, immutable';
const bytes = Buffer.from('project-owned-immutable-media-bytes-for-cache-header-test');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');

function bearer(ticket, extra = {}) {
  return { Authorization: `Bearer ${ticket}`, ...extra };
}

async function upload(base, ticket, ns, content = bytes, key = hash) {
  const url = `${base}/api/asset/${ns}/${key}`;
  const putRes = await fetch(`${url}/0`, {
    method: 'PUT',
    headers: bearer(ticket, { 'X-Media-Size': String(content.length), 'X-Media-Ext': 'mp4' }),
    body: content,
  });
  assert.equal(putRes.status, 200);
  const completeRes = await fetch(`${url}/complete`, {
    method: 'POST',
    headers: bearer(ticket),
  });
  assert.equal(completeRes.status, 200);
}

function assertNoLongCache(res, label = '') {
  const cc = res.headers.get('cache-control');
  assert.equal(cc, 'no-store', `${label} Cache-Control 应为 no-store，实得 ${cc}`);
  assert.ok(!String(cc ?? '').includes('immutable'), `${label} 不应含 immutable`);
  assert.notEqual(cc, LONG_CACHE, `${label} 不应返回长期缓存头`);
}

function assertLongCache(res, label = '') {
  assert.equal(res.headers.get('cache-control'), LONG_CACHE, `${label} Cache-Control 应精确等于长期缓存值`);
  assert.equal(res.headers.get('vary'), 'Authorization', `${label} Vary 应为 Authorization`);
}

async function pickPortInRange(start = 6420, end = 6429) {
  for (let port = start; port <= end; port++) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error(`No free port in ${start}-${end}`);
}

test('项目素材缓存头 (a)：跨项目凭哈希读被拒且回 no-store；本项目的 Bearer GET/Range/HEAD 回长期缓存头与 Vary: Authorization', async (t) => {
  const f = await startAssetProjectFixture();
  t.after(async () => {
    await f.close();
    await fs.rm(f.out, { recursive: true, force: true });
  });

  const { asset } = await compileAssetModules(f.out);
  assert.equal(asset.ASSET_MEDIA_CACHE_CONTROL, LONG_CACHE);

  await upload(f.base, 'B-rw', 'media', bytes, hash);
  const mediaUrl = `${f.base}/api/asset/media/${hash}`;

  // 项目 A 的票据即使知道项目 B 素材的哈希也读不到，且绝不带长期缓存头
  for (const ticket of ['A-r', 'A-rw']) {
    for (const [label, init] of [
      ['GET', { headers: bearer(ticket) }],
      ['HEAD', { method: 'HEAD', headers: bearer(ticket) }],
      ['Range', { headers: bearer(ticket, { Range: 'bytes=0-15' }) }],
    ]) {
      const res = await fetch(mediaUrl, init);
      assert.ok(res.status < 200 || res.status >= 300, `跨项目 ${ticket} ${label} 状态码不能是 2xx: ${res.status}`);
      assert.equal(res.status, 404);
      assertNoLongCache(res, `跨项目 ${ticket} ${label}`);
      await res.arrayBuffer();
    }
  }

  // 所属项目 B 的 Bearer GET -> 200、Range -> 206、HEAD -> 200 均带长期缓存头与 Vary: Authorization
  for (const ticket of ['B-r', 'B-rw']) {
    const getRes = await fetch(mediaUrl, { headers: bearer(ticket) });
    assert.equal(getRes.status, 200);
    assertLongCache(getRes, `${ticket} GET`);
    assert.deepEqual(Buffer.from(await getRes.arrayBuffer()), bytes);

    const rangeRes = await fetch(mediaUrl, { headers: bearer(ticket, { Range: 'bytes=4-19' }) });
    assert.equal(rangeRes.status, 206);
    assertLongCache(rangeRes, `${ticket} Range`);
    assert.deepEqual(Buffer.from(await rangeRes.arrayBuffer()), bytes.subarray(4, 20));

    const headRes = await fetch(mediaUrl, { method: 'HEAD', headers: bearer(ticket) });
    assert.equal(headRes.status, 200);
    assertLongCache(headRes, `${ticket} HEAD`);
    assert.equal(headRes.headers.get('content-length'), String(bytes.length));
    await headRes.arrayBuffer();
  }

  // 越界 Range -> 416 仍为 no-store，绝不带长期缓存头
  const range416 = await fetch(mediaUrl, { headers: bearer('B-r', { Range: 'bytes=99999-100000' }) });
  assert.equal(range416.status, 416);
  assertNoLongCache(range416, '416 Range Not Satisfiable');
  await range416.arrayBuffer();

  // 老路由 /@media/<hash> 保持原样（no-store），不发长期缓存头
  const legacyRes = await fetch(`${f.base}/@media/${hash}`, { headers: bearer('B-r') });
  assert.equal(legacyRes.status, 200);
  assertNoLongCache(legacyRes, '/@media/<hash>');
  await legacyRes.arrayBuffer();
});

test('项目素材缓存头 (b)：未知或过期票据 -> 401、项目被撤销 -> 403，均回 no-store 且绝不带长期缓存头', async (t) => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-cache-exp-'));
  const { asset, media } = await compileAssetModules(out);
  let expired = false;
  const revoked = new Set();
  const subscribers = new Map();
  const principalA = {
    projectId: 'A',
    access: 'rw',
    accountId: 'u-A',
    loginId: 'l-A',
    credentialId: 'c-A',
    authorizationId: 'doc-opaque-A-rw',
  };
  const authority = {
    async checkAccess({ principal, projectId, action }) {
      const allowed =
        principal?.authorizationId === principalA.authorizationId &&
        projectId === 'A' &&
        !revoked.has(projectId) &&
        (action === 'read' || principal.access === 'rw');
      return { allowed, accessRevision: 1, revocationSeq: revoked.size };
    },
    subscribeRevocations(context, callback) {
      const key = Symbol();
      subscribers.set(key, { context, callback });
      return () => subscribers.delete(key);
    },
  };
  const projectAccess = createProjectAssetAccess({
    authority,
    resolvePrincipal: async (req) => {
      const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      if (!token || token !== 'expiring-ticket-A') throw assetAccessError('unauthorized', 401);
      if (expired) throw assetAccessError('ticket-expired', 401);
      return principalA;
    },
  });
  const projectStores = createProjectAssetStores({ dir: path.join(out, 'assets'), contentTypeForExt: media.contentTypeForExt });
  const mw = asset.assetServiceMiddleware(out, { projectStores, projectAccess, pullArtifact: null, pxEvict: null });
  const server = http.createServer((req, res) => {
    void mw(req, res, () => {
      res.statusCode = 404;
      res.end('no route');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(out, { recursive: true, force: true });
  });

  await upload(base, 'expiring-ticket-A', 'media', bytes, hash);
  const url = `${base}/api/asset/media/${hash}`;

  // 票据有效时先确认 200 带长期缓存头
  const okRes = await fetch(url, { headers: bearer('expiring-ticket-A') });
  assert.equal(okRes.status, 200);
  assertLongCache(okRes, '过期前有效票据');
  await okRes.arrayBuffer();

  // 未知票据与无票据 -> 401 + no-store
  for (const [label, headers] of [
    ['无票据', {}],
    ['未知票据', bearer('unknown-ticket')],
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await fetch(url, { method, headers });
      assert.equal(res.status, 401, `${label} ${method}`);
      assertNoLongCache(res, `${label} ${method}`);
      await res.arrayBuffer();
    }
  }

  // 票据过期 -> 401 + no-store
  expired = true;
  for (const [label, init] of [
    ['过期票据 GET', { headers: bearer('expiring-ticket-A') }],
    ['过期票据 HEAD', { method: 'HEAD', headers: bearer('expiring-ticket-A') }],
    ['过期票据 Range', { headers: bearer('expiring-ticket-A', { Range: 'bytes=0-7' }) }],
  ]) {
    const res = await fetch(url, init);
    assert.equal(res.status, 401, label);
    assertNoLongCache(res, label);
    await res.arrayBuffer();
  }

  // 使用 startAssetProjectFixture 验证 fixture.revoke 后 -> 403 + no-store
  const f = await startAssetProjectFixture();
  t.after(async () => {
    await f.close();
    await fs.rm(f.out, { recursive: true, force: true });
  });
  await upload(f.base, 'A-rw', 'media', bytes, hash);
  await f.revoke('A');
  for (const [label, init] of [
    ['撤销后 GET', { headers: bearer('A-r') }],
    ['撤销后 HEAD', { method: 'HEAD', headers: bearer('A-r') }],
    ['撤销后 Range', { headers: bearer('A-r', { Range: 'bytes=0-7' }) }],
  ]) {
    const res = await fetch(`${f.base}/api/asset/media/${hash}`, init);
    assert.equal(res.status, 403, label);
    assertNoLongCache(res, label);
    await res.arrayBuffer();
  }
});

test('项目素材缓存头 (c)：查询串票据 ?t=A-r 回 200 + no-store + no-referrer；Bearer 同时带 ?t=（含空 ?t=）绝不回长期缓存头', async (t) => {
  const f = await startAssetProjectFixture();
  t.after(async () => {
    await f.close();
    await fs.rm(f.out, { recursive: true, force: true });
  });

  await upload(f.base, 'A-rw', 'media', bytes, hash);
  const baseMediaUrl = `${f.base}/api/asset/media/${hash}`;

  // 查询串票据 (?t=A-r)：GET / HEAD / Range 均 200/206 + Cache-Control: no-store + Referrer-Policy: no-referrer
  for (const [label, init, expectedStatus] of [
    ['?t=A-r GET', {}, 200],
    ['?t=A-r HEAD', { method: 'HEAD' }, 200],
    ['?t=A-r Range', { headers: { Range: 'bytes=0-10' } }, 206],
  ]) {
    const res = await fetch(`${baseMediaUrl}?t=A-r`, init);
    assert.equal(res.status, expectedStatus, label);
    assertNoLongCache(res, label);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${label} Referrer-Policy`);
    assert.equal(res.headers.get('vary'), null, `${label} 不应带 Vary: Authorization`);
    await res.arrayBuffer();
  }

  // Bearer 同时携带 ?t=A-r、?t=B-r 或空 ?t=：只要 URLSearchParams.has('t') 为真，一律不给长期缓存头
  for (const query of ['?t=A-r', '?t=B-r', '?t=', '?foo=1&t=']) {
    for (const [label, init] of [
      [`Bearer + ${query} GET`, { headers: bearer('A-r') }],
      [`Bearer + ${query} HEAD`, { method: 'HEAD', headers: bearer('A-r') }],
      [`Bearer + ${query} Range`, { headers: bearer('A-r', { Range: 'bytes=0-5' }) }],
    ]) {
      const res = await fetch(`${baseMediaUrl}${query}`, init);
      assertNoLongCache(res, label);
      assert.equal(res.headers.get('vary'), null, `${label} 不应带 Vary`);
      await res.arrayBuffer();
    }
  }
});

test('项目素材缓存头 (d)：托管素材运行时 startHostedAssetService 拒绝任何带 Cookie 头的请求（含同时带有效 Bearer），回 no-store 且无长期缓存头', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-hosted-cookie-'));
  const assetDir = path.join(dir, 'asset-data');
  await fs.mkdir(assetDir, { recursive: true });
  const pki = assetWiringPki(dir);

  const validTicket = 'valid_asset_ticket_for_project_A_rw_0123456';
  const principal = {
    accountId: 'account-a',
    loginId: 'login-a',
    credentialId: 'credential-a',
    loginGeneration: 1,
    projectId: 'A',
    authorizationId: 'opaque-ref-a',
    authorityId: 'doc-a',
    access: 'rw',
    accessRevision: 1,
    revocationSeq: 0,
  };
  const authority = {
    async checkAccess(body) {
      if (body.principal?.authorizationId !== principal.authorizationId) throw accountError(401, 'authorization-expired');
      if (body.projectId !== 'A') throw accountError(403, 'project-mismatch');
      return { allowed: true, ...principal };
    },
    async synchronize() {},
    eventsSince: () => ({ events: [], headSeq: 0 }),
    ackAccessEvent(_id, _service, receipt) {
      return receipt;
    },
  };
  const docServer = createAccountProjectsInternalServer({
    tls: pki.doc,
    authority,
    services: [{ serviceId: 'asset', fingerprint256: pki.asset.fingerprint256 }],
    resolveAssetTicket: async (ticket) => {
      if (ticket !== validTicket) throw accountError(401, 'ticket-expired');
      return principal;
    },
  });
  await new Promise((resolve, reject) => {
    docServer.once('error', reject);
    docServer.listen(0, '127.0.0.1', resolve);
  });

  const internalPort = await pickPortInRange(6420, 6429);
  let service = null;
  t.after(async () => {
    await service?.close();
    docServer.closeAllConnections?.();
    await new Promise((resolve) => docServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  service = await startHostedAssetService({
    dataDir: assetDir,
    host: '127.0.0.1',
    port: 0,
    internalPort,
    pollMs: 60000,
    doc: {
      origin: `https://127.0.0.1:${docServer.address().port}`,
      authorityId: 'doc-a',
      tls: pki.asset,
      serverFingerprint256: pki.doc.fingerprint256,
    },
    internalTls: pki.asset,
    docFingerprint256: pki.doc.fingerprint256,
  });

  const base = `http://127.0.0.1:${service.port}`;
  await upload(base, validTicket, 'media', bytes, hash);
  const mediaUrl = `${base}/api/asset/media/${hash}`;

  // 对照：不带 Cookie、仅带有效 Bearer 时，真实托管运行时返回 200 与长期缓存头
  const cleanRes = await fetch(mediaUrl, { headers: bearer(validTicket) });
  assert.equal(cleanRes.status, 200);
  assertLongCache(cleanRes, '托管运行时合法 Bearer');
  assert.deepEqual(Buffer.from(await cleanRes.arrayBuffer()), bytes);

  // 携带 Cookie 头（不论是否同时携带有效 Bearer）：一律拒绝，回 no-store 且无长期缓存头
  for (const [label, init] of [
    ['仅 Cookie GET', { headers: { Cookie: `pc_rt=${validTicket}` } }],
    ['有效 Bearer + Cookie GET', { headers: bearer(validTicket, { Cookie: `pc_rt=${validTicket}` }) }],
    ['有效 Bearer + Cookie HEAD', { method: 'HEAD', headers: bearer(validTicket, { Cookie: 'other=1' }) }],
    ['有效 Bearer + Cookie Range', { headers: bearer(validTicket, { Cookie: `pc_rt=${validTicket}`, Range: 'bytes=0-10' }) }],
  ]) {
    const res = await fetch(mediaUrl, init);
    assert.equal(res.status, 400, `${label} 应被拒绝（400）`);
    assertNoLongCache(res, label);
    await res.arrayBuffer();
  }
});

test('项目素材缓存头 (e)：未收尾的单分片与仅传末片的多分片 GET/HEAD 均 404 + no-store；snap/px 与 chunks 保持 no-store', async (t) => {
  const f = await startAssetProjectFixture();
  t.after(async () => {
    await f.close();
    await fs.rm(f.out, { recursive: true, force: true });
  });

  const { asset } = await compileAssetModules(f.out);
  const chunkSize = asset.ASSET_CHUNK_SIZE;

  // 1. 单分片 PUT 但未调 complete
  const singleBytes = Buffer.from('incomplete-single-chunk-media');
  const singleHash = crypto.createHash('sha256').update(singleBytes).digest('hex');
  const put0 = await fetch(`${f.base}/api/asset/media/${singleHash}/0`, {
    method: 'PUT',
    headers: bearer('A-rw', { 'X-Media-Size': String(singleBytes.length), 'X-Media-Ext': 'mp4' }),
    body: singleBytes,
  });
  assert.equal(put0.status, 200);
  assertNoLongCache(put0, '单分片 PUT');

  for (const method of ['GET', 'HEAD']) {
    const res = await fetch(`${f.base}/api/asset/media/${singleHash}`, { method, headers: bearer('A-r') });
    assert.equal(res.status, 404, `未收尾单分片 ${method}`);
    assertNoLongCache(res, `未收尾单分片 ${method}`);
    await res.arrayBuffer();
  }

  // 2. 两分片对象（size = chunkSize + 1），仅上传最后一片（chunk 1，长度 1 字节），未传 chunk 0 且未 complete
  const twoChunkSize = chunkSize + 1;
  const twoChunkHash = 'b'.repeat(64);
  const put1 = await fetch(`${f.base}/api/asset/media/${twoChunkHash}/1`, {
    method: 'PUT',
    headers: bearer('A-rw', { 'X-Media-Size': String(twoChunkSize), 'X-Media-Ext': 'mp4' }),
    body: Buffer.from([0x7f]),
  });
  assert.equal(put1.status, 200);
  assertNoLongCache(put1, '两分片仅传末片 PUT');

  for (const method of ['GET', 'HEAD']) {
    const res = await fetch(`${f.base}/api/asset/media/${twoChunkHash}`, { method, headers: bearer('A-r') });
    assert.equal(res.status, 404, `仅传末片 ${method}`);
    assertNoLongCache(res, `仅传末片 ${method}`);
    await res.arrayBuffer();
  }

  // 3. snap 与 px 已完整入库时，GET / HEAD / Range 仍为 no-store，绝不带长期缓存头
  for (const ns of ['snap', 'px']) {
    await upload(f.base, 'A-rw', ns, bytes, hash);
    for (const [label, init, expectedStatus] of [
      [`${ns} GET`, { headers: bearer('A-r') }, 200],
      [`${ns} HEAD`, { method: 'HEAD', headers: bearer('A-r') }, 200],
      [`${ns} Range`, { headers: bearer('A-r', { Range: 'bytes=0-7' }) }, 206],
    ]) {
      const res = await fetch(`${f.base}/api/asset/${ns}/${hash}`, init);
      assert.equal(res.status, expectedStatus, label);
      assertNoLongCache(res, label);
      assert.equal(res.headers.get('vary'), null, `${label} 不应带 Vary`);
      await res.arrayBuffer();
    }
  }

  // 4. GET /api/asset/media/<hash>/chunks（含未完成与已完成）保持 no-store
  await upload(f.base, 'A-rw', 'media', bytes, hash);
  for (const targetHash of [singleHash, twoChunkHash, hash]) {
    const chunksRes = await fetch(`${f.base}/api/asset/media/${targetHash}/chunks`, { headers: bearer('A-r') });
    assert.equal(chunksRes.status, 200);
    assertNoLongCache(chunksRes, `chunks (${targetHash.slice(0, 8)})`);
    await chunksRes.arrayBuffer();
  }
});

test('静态回归守卫：nginx 舞台站点 /media-s/<sid>/media/<hash> 与 stage-headers 片段不覆盖或剥离上游 Cache-Control 与 Vary', async () => {
  const siteConf = await fs.readFile(path.join(ROOT, 'server/hosted/deploy/nginx-site-promptcut-stages.conf'), 'utf8');
  const snippetConf = await fs.readFile(path.join(ROOT, 'server/hosted/deploy/nginx-snippet-promptcut-stage-headers.conf'), 'utf8');

  const locMatch = /location\s+~\s+"(?:\^\/media-s\/[^"]*media\/\[0-9a-f\]\{64\}[^"]*)"\s*\{([\s\S]*?)\n\s*\}/.exec(siteConf);
  assert.ok(locMatch, '应找到 /media-s/<sid>/media/<hash> 的 location 块');
  const locBody = locMatch[1];

  assert.doesNotMatch(locBody, /\badd_header\s+Cache-Control\b/i, 'location 块内不得有 add_header Cache-Control');
  assert.doesNotMatch(locBody, /\badd_header\s+Vary\b/i, 'location 块内不得有 add_header Vary');
  assert.doesNotMatch(locBody, /\bproxy_hide_header\b/i, 'location 块内不得有 proxy_hide_header');
  assert.doesNotMatch(locBody, /\bproxy_ignore_headers\b/i, 'location 块内不得有 proxy_ignore_headers');

  const activeSnippetLines = snippetConf
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  for (const line of activeSnippetLines) {
    assert.doesNotMatch(line, /\bCache-Control\b/i, `stage-headers 片段不得设置 Cache-Control: ${line}`);
    assert.doesNotMatch(line, /\bVary\b/i, `stage-headers 片段不得设置 Vary: ${line}`);
  }
});

test('项目素材缓存头 (f)：局域网、本机项目用的旧模式（没有 projectAccess，凭 Bearer 票据或回环）读 media 不回长期缓存头、不带 Vary: Authorization', async (t) => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-cache-legacy-'));
  const { asset } = await compileAssetModules(out);
  const tickets = {
    verify(ticket) {
      if (ticket === 'L-rw') return { ok: true, access: 'rw', projectId: 'L', userId: 'u' };
      if (ticket === 'L-r') return { ok: true, access: 'r', projectId: 'L', userId: 'u' };
      return { ok: false, reason: 'unknown' };
    },
  };
  let trusted = false;
  const mw = asset.assetServiceMiddleware(out, { tickets, isTrusted: () => trusted, pullArtifact: null, pxEvict: null });
  const server = http.createServer((req, res) => { void mw(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(out, { recursive: true, force: true });
  });

  await upload(base, 'L-rw', 'media', bytes, hash);
  const url = `${base}/api/asset/media/${hash}`;
  const notLong = (res, label) => {
    assert.notEqual(res.headers.get('cache-control'), LONG_CACHE, label);
    assert.ok(!String(res.headers.get('cache-control') ?? '').includes('immutable'), label);
    assert.notEqual(res.headers.get('vary'), 'Authorization', label);
  };
  for (const isTrusted of [false, true]) {
    trusted = isTrusted;
    for (const [label, init, status] of [
      ['GET', { headers: bearer('L-r') }, 200],
      ['Range', { headers: bearer('L-r', { Range: 'bytes=2-9' }) }, 206],
      ['HEAD', { method: 'HEAD', headers: bearer('L-r') }, 200],
    ]) {
      const res = await fetch(url, init);
      assert.equal(res.status, status, `旧模式 ${isTrusted ? '回环' : 'Bearer'} ${label}`);
      notLong(res, `旧模式 ${isTrusted ? '回环' : 'Bearer'} ${label}`);
      await res.arrayBuffer();
    }
  }
});
