/**
 * 游客素材限额接到素材服务上（`server/asset-store/guest-quota.mjs`，数在 `server/account/guest.mjs` 的 `GUEST_LIMITS`）。
 *
 * 起真的素材服务中间件（`asset-service.ts` + 媒体中间件，按 `fixtures/asset-project-service.mjs` 的办法转译），
 * 托管那条路用真的项目数据层（fs，临时目录）和合成的文档服务权威；票据那条路用 memory 数据层和合成的票据核对。
 * 端口一律 0（系统随便给），不占固定端口。
 *
 * 覆盖：游客第 4 条被拒（分片时、收尾时）、101 MB 被拒、正好 3 条 / 正好 100 MB 收下、已有的同一条再传照收、
 * 并发开新暂存只放进一条、删掉一条之后又能收尾、`snap` / `px` 不受限、账号 10 条 200 MB 照常、
 * 整件上传（`/api/media/upload`）同样拦、票据路径同样拦、本机回环不受限。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { compileAssetModules } from './fixtures/asset-project-service.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createProjectAssetAccess } from '../asset-store/project-access.mjs';
import { createMemoryStore } from '../asset-store/memory-store.mjs';
import { GUEST_LIMITS } from '../account/guest.mjs';

const MiB = 1024 * 1024;
const CHUNK = 8 * MiB;
const GUEST = 'gst_' + '0123456789abcdef01234567';
const GUEST2 = 'gst_' + 'fedcba9876543210fedcba98';
const ACCOUNT = 'acc_' + '00112233445566778899aabb';
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const item = label => { const bytes = Buffer.from(`guest asset ${label} ${crypto.randomUUID()}`); return { bytes, hash: sha(bytes) }; };

const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-guest-asset-quota-'));
after(() => fsp.rm(out, { recursive: true, force: true }));
const { asset, media } = await compileAssetModules(out);

/* ------------------------------------------------------------------ *
 * 托管（项目数据层 + 文档服务权威）
 * ------------------------------------------------------------------ */

/** 票据就是 `<项目>:<主体>`；主体 `guest` / `guest2` / `account`。权威只认登记过的主体、项目对得上、写要 rw */
function principalOf(token) {
  const m = /^([A-Za-z0-9-]+):(guest|guest2|account)$/.exec(String(token ?? ''));
  if (!m) return null;
  const accountId = { guest: GUEST, guest2: GUEST2, account: ACCOUNT }[m[2]];
  return { projectId: m[1], access: 'rw', accountId, loginId: `l-${accountId}`, credentialId: `c-${accountId}`, authorizationId: `auth-${m[1]}-${m[2]}` };
}

/** 收什么都扔掉、只记一笔的数据层：账号传 10 条 200 MB 那项用，验的是限额这一层放不放行，不验落盘 */
function sinkStore(projectId) {
  const seen = new Map(), done = new Map();
  return {
    kind: 'sink', chunkSize: CHUNK, projectId, namespace: 'media',
    async stat(hash) { return done.has(hash) ? { size: done.get(hash), ext: '', contentType: 'application/octet-stream', mtimeMs: 0 } : null; },
    async read() { return null; },
    async chunks(hash) {
      if (done.has(hash)) return { size: done.get(hash), chunkSize: CHUNK, received: [0], complete: true };
      return seen.has(hash) ? { size: seen.get(hash), chunkSize: CHUNK, received: [0], complete: false } : { size: null, chunkSize: CHUNK, received: [], complete: false };
    },
    async putChunk(hash, _n, { size }, source) { let bytes = 0; for await (const c of source) bytes += c.length; seen.set(hash, size); return { status: 'ok', bytes }; },
    async complete(hash) { if (!seen.has(hash)) return { status: 'unknown' }; done.set(hash, seen.get(hash)); seen.delete(hash); return { status: 'ok', size: done.get(hash), ext: '' }; },
    async remove(hash) { return done.delete(hash) || seen.delete(hash); },
    async usage() { let bytes = 0; for (const v of done.values()) bytes += v; return { blobs: done.size, bytes, staging: seen.size }; },
    get count() { return done.size; },
  };
}

async function startHosted() {
  const authority = {
    async checkAccess({ principal, projectId, action }) {
      const known = principalOf(`${principal?.projectId}:${{ [GUEST]: 'guest', [GUEST2]: 'guest2', [ACCOUNT]: 'account' }[principal?.accountId]}`);
      return { allowed: !!known && known.authorizationId === principal.authorizationId && known.projectId === projectId && (action === 'read' || known.access === 'rw'), accessRevision: 1, revocationSeq: 0 };
    },
    subscribeRevocations() { return () => {}; },
  };
  const projectAccess = createProjectAssetAccess({ authority, resolvePrincipal: async req => principalOf(/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]) });
  const factory = createProjectAssetStores({ dir: path.join(out, `assets-${crypto.randomUUID()}`), contentTypeForExt: media.contentTypeForExt });
  const sinks = new Map();
  const projectStores = { project: id => {
    const p = factory.project(id);
    if (!id.startsWith('sink')) return p;
    if (!sinks.has(id)) sinks.set(id, sinkStore(id));
    return { ...p, stores: { ...p.stores, media: sinks.get(id) } };
  } };
  const opts = { projectStores, projectAccess, pullArtifact: null, pxEvict: null };
  const a = asset.assetServiceMiddleware(out, opts);
  const m = media.mediaMiddleware(out, { ...opts, verifyRemoteTarget: async () => { throw Object.assign(new Error('no'), { status: 403 }); } });
  const server = http.createServer((req, res) => { void a(req, res, () => { void m(req, res, () => { res.statusCode = 404; res.end('no route'); }); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  after(() => { server.closeAllConnections?.(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, factory, sinks };
}

const hosted = await startHosted();

/** 一片：`PUT <ns>/<hash>/<n>`，size 是全件大小，body 是这一片 */
function put(base, token, ns, hash, n, size, body) {
  return fetch(`${base}/api/asset/${ns}/${hash}/${n}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'X-Media-Size': String(size), 'X-Media-Ext': 'bin' }, body });
}
const complete = (base, token, ns, hash) => fetch(`${base}/api/asset/${ns}/${hash}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
async function errorOf(res) { const body = await res.json(); return { status: res.status, error: body.error }; }

/** 整件按 8 MiB 一片传完再收尾，回收尾的响应 */
async function upload(base, token, ns, { bytes, hash }) {
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK));
  for (let n = 0; n < count; n++) {
    const res = await put(base, token, ns, hash, n, bytes.length, bytes.subarray(n * CHUNK, Math.min(bytes.length, (n + 1) * CHUNK)));
    if (res.status !== 200) return res;
    await res.arrayBuffer();
  }
  return complete(base, token, ns, hash);
}

test('游客：正好 3 条收下，第 4 条在分片时就回 403 guest-asset-limit；已有的同一条再传照收', async () => {
  const tok = 'p-limit:guest';
  const items = [item(1), item(2), item(3)];
  for (const it of items) assert.equal((await upload(hosted.base, tok, 'media', it)).status, 200);
  const fourth = item(4);
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', fourth.hash, 0, fourth.bytes.length, fourth.bytes)), { status: 403, error: 'guest-asset-limit' });
  // 第 4 条连暂存都没开：对账报没见过
  assert.equal((await (await fetch(`${hosted.base}/api/asset/media/${fourth.hash}/chunks`, { headers: { Authorization: `Bearer ${tok}` } })).json()).size, null);
  // 已入库的那条重传：不是新的一条，照旧 200
  const again = await upload(hosted.base, tok, 'media', items[0]);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).complete, true);
  assert.equal((await hosted.factory.project('p-limit').stores.media.usage()).blobs, 3);
});

test('游客：101 MB 在第一片就回 403 guest-asset-too-large，正好 100 MB 收下', async () => {
  const tok = 'p-size:guest';
  const over = GUEST_LIMITS.assetBytes + 1 * MiB;
  const fake = crypto.randomBytes(32).toString('hex');
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', fake, 0, over, Buffer.alloc(CHUNK))), { status: 403, error: 'guest-asset-too-large' });
  // 只差一个字节也拦
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', fake, 0, GUEST_LIMITS.assetBytes + 1, Buffer.alloc(CHUNK))), { status: 403, error: 'guest-asset-too-large' });
  const bytes = Buffer.alloc(GUEST_LIMITS.assetBytes, 7);
  bytes.write(crypto.randomUUID());
  const res = await upload(hosted.base, tok, 'media', { bytes, hash: sha(bytes) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).size, GUEST_LIMITS.assetBytes);
});

test('游客：收尾时再数一次，满了回 403、暂存留着；删掉一条之后同一条能收尾，也能再传新的', async () => {
  const tok = 'p-complete:guest';
  const store = hosted.factory.project('p-complete').stores.media;
  const [a, b] = [item('a'), item('b')];
  for (const it of [a, b]) assert.equal((await upload(hosted.base, tok, 'media', it)).status, 200);
  // 第 3 条只传分片、不收尾（2 条入库 + 1 条在收 = 3，开得出来）
  const x = item('x');
  assert.equal((await put(hosted.base, tok, 'media', x.hash, 0, x.bytes.length, x.bytes)).status, 200);
  // 这时再开一个新暂存：入库 2 + 在收 1 已经到 3，拦
  const y = item('y');
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', y.hash, 0, y.bytes.length, y.bytes)), { status: 403, error: 'guest-asset-limit' });
  // 同一项目里别的写入（例如创建者以外的成员）先占满了第 3 条：直接经数据层写一条
  const z = item('z');
  assert.equal((await store.putChunk(z.hash, 0, { size: z.bytes.length }, [z.bytes])).status, 'ok');
  assert.equal((await store.complete(z.hash)).status, 'ok');
  assert.deepEqual(await errorOf(await complete(hosted.base, tok, 'media', x.hash)), { status: 403, error: 'guest-asset-limit' });
  assert.deepEqual((await (await fetch(`${hosted.base}/api/asset/media/${x.hash}/chunks`, { headers: { Authorization: `Bearer ${tok}` } })).json()).received, [0], '暂存留着');
  // 删掉一条（三天清理、或将来的删素材）：同一条能收尾了
  assert.equal(await store.remove(a.hash), true);
  assert.equal((await complete(hosted.base, tok, 'media', x.hash)).status, 200);
  // 又满了；再删一条，能传新的
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', y.hash, 0, y.bytes.length, y.bytes)), { status: 403, error: 'guest-asset-limit' });
  assert.equal(await store.remove(b.hash), true);
  assert.equal((await upload(hosted.base, tok, 'media', y)).status, 200);
  assert.equal((await store.usage()).blobs, 3);
});

test('游客：并发开两个新暂存，只放进一个', async () => {
  const tok = 'p-race:guest';
  for (const it of [item('r1'), item('r2')]) assert.equal((await upload(hosted.base, tok, 'media', it)).status, 200);
  const [p, q] = [item('p'), item('q')];
  const results = await Promise.all([p, q].map(it => put(hosted.base, tok, 'media', it.hash, 0, it.bytes.length, it.bytes).then(r => r.status)));
  assert.deepEqual(results.sort(), [200, 403]);
});

test('游客：snap / px 不受限（条数、尺寸都不管）', async () => {
  const tok = 'p-artifacts:guest';
  for (const ns of ['snap', 'px']) {
    for (let i = 0; i < GUEST_LIMITS.assets + 2; i++) assert.equal((await upload(hosted.base, tok, ns, item(`${ns}-${i}`))).status, 200, `${ns} 第 ${i + 1} 条`);
    const big = crypto.randomBytes(32).toString('hex');
    assert.equal((await put(hosted.base, tok, ns, big, 0, GUEST_LIMITS.assetBytes * 2, Buffer.alloc(CHUNK))).status, 200, `${ns} 200 MB 的第一片`);
  }
});

test('账号：10 条照收（真的数据层），10 条 200 MB 照收（只记不落盘的数据层）', async () => {
  const tok = 'p-account:account';
  for (let i = 0; i < 10; i++) assert.equal((await upload(hosted.base, tok, 'media', item(`acc-${i}`))).status, 200, `第 ${i + 1} 条`);
  assert.equal((await hosted.factory.project('p-account').stores.media.usage()).blobs, 10);
  const sinkTok = 'sink-account:account';
  for (let i = 0; i < 10; i++) {
    const hash = crypto.randomBytes(32).toString('hex');
    const res = await put(hosted.base, sinkTok, 'media', hash, 0, 200 * MiB, Buffer.alloc(CHUNK));
    assert.equal(res.status, 200, `第 ${i + 1} 条 200 MB 的分片`);
    await res.arrayBuffer();
    assert.equal((await complete(hosted.base, sinkTok, 'media', hash)).status, 200, `第 ${i + 1} 条 200 MB 收尾`);
  }
  assert.equal(hosted.sinks.get('sink-account').count, 10);
});

test('游客的限额按各自项目数：另一个游客的项目不受这一个影响', async () => {
  for (const it of [item('g1'), item('g2'), item('g3')]) assert.equal((await upload(hosted.base, 'p-own1:guest', 'media', it)).status, 200);
  assert.equal((await upload(hosted.base, 'p-own2:guest2', 'media', item('other'))).status, 200);
});

/** 不经 fetch 发整件上传：可以只报 Content-Length 不发正文，或者不带 Content-Length（分块编码） */
function rawUpload(base, token, { name = 'clip.mp4', body = null, length = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}/api/media/upload/${name}`);
    const headers = { Authorization: `Bearer ${token}` };
    if (length !== undefined) headers['Content-Length'] = String(length);
    const req = http.request(url, { method: 'POST', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', err => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? undefined : reject(err)));
    if (body) req.write(body);
    if (length === undefined || body) req.end();
    else req.flushHeaders(); // 只报长度不发正文：头要先送出去，不然 Node 等第一次 write 才发
  });
}

test('整件上传 /api/media/upload：游客同样按 3 条、100 MB 拦，没带 Content-Length 回 411；账号不受影响', async () => {
  const tok = 'p-whole:guest';
  for (let i = 0; i < GUEST_LIMITS.assets; i++) {
    const bytes = item(`w${i}`).bytes;
    const res = await rawUpload(hosted.base, tok, { body: bytes, length: bytes.length });
    assert.equal(res.status, 200, `第 ${i + 1} 条`);
    assert.equal(res.json.ok, true);
  }
  assert.equal((await hosted.factory.project('p-whole').stores.media.usage()).blobs, 3);
  const extra = item('w-extra').bytes;
  assert.deepEqual(await rawUpload(hosted.base, tok, { body: extra, length: extra.length }).then(r => ({ status: r.status, error: r.json?.error })), { status: 403, error: 'guest-asset-limit' });
  // 另一个空项目里：报 101 MB 的长度，正文一个字节都不发，当场回 403
  const tok2 = 'p-whole2:guest';
  assert.deepEqual(await rawUpload(hosted.base, tok2, { length: GUEST_LIMITS.assetBytes + 1 }).then(r => ({ status: r.status, error: r.json?.error })), { status: 403, error: 'guest-asset-too-large' });
  // 分块编码（没有 Content-Length）：量不出多大，游客的拒
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(new URL(`${hosted.base}/api/media/upload/a.bin`), { method: 'POST', headers: { Authorization: `Bearer ${tok2}`, 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', err => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? undefined : reject(err)));
    req.end(Buffer.from('abc'));
  });
  assert.equal(chunked, 411);
  // 账号：照常收
  for (let i = 0; i < GUEST_LIMITS.assets + 2; i++) {
    const bytes = item(`wa${i}`).bytes;
    assert.equal((await rawUpload(hosted.base, 'p-whole-acc:account', { body: bytes, length: bytes.length })).status, 200);
  }
});

/* ------------------------------------------------------------------ *
 * 票据那条路（本机 / 局域网素材服务，单一 media 数据层）
 * ------------------------------------------------------------------ */

test('票据路径：票据的 userId 是游客就按游客限额拦；账号票据、本机回环不受限', async () => {
  const mediaStore = createMemoryStore();
  // 真实票据里的 userId 写成 `account:<编号>@<设备>`（`server/docservice/account-hosted.mjs`），
  // 不是裸编号 —— 夹具用裸编号的话，这条测试看着过了，线上那条路其实一次都不会命中
  const users = { 'g-rw': `account:${GUEST}@device-1`, 'a-rw': `account:${ACCOUNT}@device-1`, 'g-bare': GUEST };
  const tickets = { verify: t => users[t] ? { ok: true, access: 'rw', projectId: 'p1', userId: users[t] } : { ok: false, reason: 'unknown' } };
  let trusted = false;
  const a = asset.assetServiceMiddleware(path.join(out, 'ticket-root'), { stores: { media: mediaStore }, tickets, isTrusted: () => trusted, pullArtifact: null, pxEvict: null });
  const server = http.createServer((req, res) => { void a(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  after(() => { server.closeAllConnections?.(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  for (let i = 0; i < GUEST_LIMITS.assets; i++) assert.equal((await upload(base, 'g-rw', 'media', item(`t${i}`))).status, 200);
  const fourth = item('t-4');
  assert.deepEqual(await errorOf(await put(base, 'g-rw', 'media', fourth.hash, 0, fourth.bytes.length, fourth.bytes)), { status: 403, error: 'guest-asset-limit' });
  assert.deepEqual(await errorOf(await put(base, 'g-rw', 'media', crypto.randomBytes(32).toString('hex'), 0, GUEST_LIMITS.assetBytes + 1, Buffer.alloc(CHUNK))), { status: 403, error: 'guest-asset-too-large' });
  // 账号票据：照收
  assert.equal((await upload(base, 'a-rw', 'media', fourth)).status, 200);
  // 本机回环（不看票据，也就不知道是谁）：照收
  trusted = true;
  for (let i = 0; i < 3; i++) assert.equal((await upload(base, 'whatever', 'media', item(`local${i}`))).status, 200);
  assert.equal((await mediaStore.usage()).blobs, 7);
});
