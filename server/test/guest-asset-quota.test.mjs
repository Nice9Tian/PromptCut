/**
 * 游客素材限额接到素材服务上（`server/asset-store/guest-quota.mjs`，数在 `server/account/guest.mjs` 的 `GUEST_LIMITS`）。
 *
 * 口径（2026-10-23 用户定）：「每一条源文件不能大于100M。总视频素材不能大于三条。」
 * - 每个传上来的文件都查 100 MB；
 * - 只数视频的原尺寸档（`X-Media-Tier` 缺失、拼错一律当原尺寸），小档、图片、音频不计数。
 *
 * 起真的素材服务中间件（`asset-service.ts` + 媒体中间件，按 `fixtures/asset-project-service.mjs` 的办法转译），
 * 托管那条路用真的项目数据层（fs，临时目录）和合成的文档服务权威；票据那条路用 memory 数据层和合成的票据核对。
 * 端口一律 0（系统随便给），不占固定端口。
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
/** 一个文件：`ext` 是 `X-Media-Ext`，`tier` 是 `X-Media-Tier`（`null` 表示不带这个头） */
const file = (label, { ext = 'mp4', tier = 'original' } = {}) => {
  const bytes = Buffer.from(`guest asset ${label} ${crypto.randomUUID()}`);
  return { bytes, hash: sha(bytes), ext, tier };
};
/** 一个视频：在线编辑器传两个文件，小档和原尺寸，哈希不同 */
const video = label => ({ small: file(`${label}-small`, { tier: 'small' }), original: file(`${label}-original`) });

const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-guest-asset-quota-'));
after(() => fsp.rm(out, { recursive: true, force: true }));
const { asset, media } = await compileAssetModules(out);

/** 数据层里算数的条数：视频扩展名、且不是小档。和 guest-quota 同一个判断，用来核对它真的照这个口径收 */
const isVideoExt = ext => media.contentTypeForExt(ext).startsWith('video/');
async function countedVideos(store) {
  const inv = await store.inventory();
  return inv.stored.filter(e => isVideoExt(e.ext) && e.tier !== 'small').length;
}

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
const mediaOf = projectId => hosted.factory.project(projectId).stores.media;

/** 一片：`PUT <ns>/<hash>/<n>`，size 是全件大小，body 是这一片；`tier: null` 不带档位头 */
function put(base, token, ns, hash, n, size, body, { ext = 'mp4', tier = 'original' } = {}) {
  const headers = { Authorization: `Bearer ${token}`, 'X-Media-Size': String(size), 'X-Media-Ext': ext };
  if (tier !== null) headers['X-Media-Tier'] = tier;
  return fetch(`${base}/api/asset/${ns}/${hash}/${n}`, { method: 'PUT', headers, body });
}
const complete = (base, token, ns, hash) => fetch(`${base}/api/asset/${ns}/${hash}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
const chunksOf = (base, token, ns, hash) => fetch(`${base}/api/asset/${ns}/${hash}/chunks`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
async function errorOf(res) { const body = await res.json(); return { status: res.status, error: body.error }; }

/** 整件按 8 MiB 一片传完再收尾，回收尾的响应（某一片没过就回那一片的响应） */
async function upload(base, token, ns, { bytes, hash, ext = 'mp4', tier = 'original' }) {
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK));
  for (let n = 0; n < count; n++) {
    const res = await put(base, token, ns, hash, n, bytes.length, bytes.subarray(n * CHUNK, Math.min(bytes.length, (n + 1) * CHUNK)), { ext, tier });
    if (res.status !== 200) return res;
    await res.arrayBuffer();
  }
  return complete(base, token, ns, hash);
}
/** 一个视频照在线编辑器的顺序传：先小档再原尺寸。回两档收尾的状态码 */
async function uploadVideo(base, token, v) {
  const small = await upload(base, token, 'media', v.small);
  const original = await upload(base, token, 'media', v.original);
  return { small: small.status, original: original.status };
}

test('游客：3 个视频（每个两档共 6 个文件）全部收下；第 4 个的原件在分片时就回 403 guest-video-limit，小档照收', async () => {
  const tok = 'p-videos:guest';
  const videos = [video(1), video(2), video(3)];
  for (const [i, v] of videos.entries()) assert.deepEqual(await uploadVideo(hosted.base, tok, v), { small: 200, original: 200 }, `第 ${i + 1} 个视频`);
  assert.equal((await mediaOf('p-videos').usage()).blobs, 6, '6 个文件都入库了');
  assert.equal(await countedVideos(mediaOf('p-videos')), GUEST_LIMITS.videos, '算数的只有 3 条原尺寸');
  const fourth = video(4);
  // 小档不占额：照收
  assert.equal((await upload(hosted.base, tok, 'media', fourth.small)).status, 200, '第 4 个视频的小档照收');
  // 原尺寸：第一片就拦，连暂存都没开
  const o = fourth.original;
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', o.hash, 0, o.bytes.length, o.bytes)), { status: 403, error: 'guest-video-limit' });
  assert.equal((await chunksOf(hosted.base, tok, 'media', o.hash)).size, null, '第 4 条原尺寸没开暂存');
  // 已入库的那条原尺寸重传：不是新的一条，照旧 200
  const again = await upload(hosted.base, tok, 'media', videos[0].original);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).complete, true);
  assert.equal((await mediaOf('p-videos').usage()).blobs, 7);
  assert.equal(await countedVideos(mediaOf('p-videos')), 3);
});

test('游客：图片、音频不计数 —— 3 个视频传满之后再传 10 张图、3 段音频照收，之后视频原件照样拦', async () => {
  const tok = 'p-stills:guest';
  for (const i of [1, 2, 3]) assert.deepEqual(await uploadVideo(hosted.base, tok, video(`s${i}`)), { small: 200, original: 200 });
  for (let i = 0; i < 10; i++) {
    const ext = ['png', 'jpg', 'webp', 'gif', 'jpeg'][i % 5];
    assert.equal((await upload(hosted.base, tok, 'media', file(`img-${i}`, { ext }))).status, 200, `第 ${i + 1} 张图（${ext}）`);
  }
  for (const ext of ['mp3', 'wav', 'm4a']) assert.equal((await upload(hosted.base, tok, 'media', file(`aud-${ext}`, { ext }))).status, 200, `音频 ${ext}`);
  // 图片不带档位头、或者报成 original，也不算数（只数视频）
  assert.equal((await upload(hosted.base, tok, 'media', file('img-notier', { ext: 'png', tier: null }))).status, 200);
  const store = mediaOf('p-stills');
  assert.equal((await store.usage()).blobs, 6 + 10 + 3 + 1);
  assert.equal(await countedVideos(store), 3);
  const v = file('s4-original');
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', v.hash, 0, v.bytes.length, v.bytes)), { status: 403, error: 'guest-video-limit' });
  // 另一个空项目里先传 10 张图：一条视频都还没算，3 个视频照收
  const tok2 = 'p-stills-first:guest';
  for (let i = 0; i < 10; i++) assert.equal((await upload(hosted.base, tok2, 'media', file(`first-img-${i}`, { ext: 'png' }))).status, 200);
  for (const i of [1, 2, 3]) assert.deepEqual(await uploadVideo(hosted.base, tok2, video(`f${i}`)), { small: 200, original: 200 });
});

test('游客：每一个文件 101 MB 在第一片就回 403 guest-file-too-large（原件、小档、图片、音频都查），正好 100 MB 收下', async () => {
  const tok = 'p-size:guest';
  const fake = () => crypto.randomBytes(32).toString('hex');
  const over = GUEST_LIMITS.assetBytes + 1 * MiB;
  for (const headers of [{ ext: 'mp4', tier: 'original' }, { ext: 'mp4', tier: 'small' }, { ext: 'png', tier: null }, { ext: 'wav', tier: null }, { ext: 'mp4', tier: null }]) {
    const label = `${headers.ext}/${headers.tier}`;
    assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', fake(), 0, over, Buffer.alloc(CHUNK), headers)), { status: 403, error: 'guest-file-too-large' }, `101 MB ${label}`);
    // 只差一个字节也拦
    assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', fake(), 0, GUEST_LIMITS.assetBytes + 1, Buffer.alloc(CHUNK), headers)), { status: 403, error: 'guest-file-too-large' }, `100 MB + 1 字节 ${label}`);
  }
  // 正好 100 MB：视频原件和图片各一条，都收下
  for (const ext of ['mp4', 'png']) {
    const bytes = Buffer.alloc(GUEST_LIMITS.assetBytes, 7);
    bytes.write(crypto.randomUUID());
    const res = await upload(hosted.base, tok, 'media', { bytes, hash: sha(bytes), ext });
    assert.equal(res.status, 200, `100 MB ${ext}`);
    assert.equal((await res.json()).size, GUEST_LIMITS.assetBytes);
  }
  assert.equal(await countedVideos(mediaOf('p-size')), 1);
});

test('游客：档位头缺失、拼错、不认识的值一律当原件计数；只有 small 不计数', async () => {
  const tok = 'p-tier:guest';
  // 三条「原件」：一条明说 original，一条不带头，一条拼错成 smal
  assert.equal((await upload(hosted.base, tok, 'media', file('t-orig', { tier: 'original' }))).status, 200);
  assert.equal((await upload(hosted.base, tok, 'media', file('t-missing', { tier: null }))).status, 200);
  assert.equal((await upload(hosted.base, tok, 'media', file('t-typo', { tier: 'smal' }))).status, 200);
  assert.equal(await countedVideos(mediaOf('p-tier')), 3, '缺头、拼错的都按原件记进数据层');
  // 满了：再来不带头的、乱写的、空串，都按原件拦
  for (const tier of [null, 'thumbnail', '', 'small,original']) {
    const f = file(`t-more-${tier}`);
    assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', f.hash, 0, f.bytes.length, f.bytes, { tier })), { status: 403, error: 'guest-video-limit' }, `X-Media-Tier=${JSON.stringify(tier)}`);
  }
  // 只有 small（不分大小写、两头空白）不计数
  for (const tier of ['small', 'SMALL', ' Small ']) assert.equal((await upload(hosted.base, tok, 'media', file(`t-small-${tier}`, { tier }))).status, 200, `X-Media-Tier=${JSON.stringify(tier)}`);
  assert.equal(await countedVideos(mediaOf('p-tier')), 3);
});

test('游客：先报小档开暂存、后面的片改报原件（或不带头），数据层改记原件，收尾时照原件数', async () => {
  const tok = 'p-downgrade:guest';
  for (const i of [1, 2, 3]) assert.equal((await upload(hosted.base, tok, 'media', file(`d${i}`))).status, 200);
  for (const second of ['original', null]) {
    // 9 MiB：两片
    const bytes = crypto.randomBytes(CHUNK + MiB);
    const hash = sha(bytes);
    assert.equal((await put(hosted.base, tok, 'media', hash, 0, bytes.length, bytes.subarray(0, CHUNK), { tier: 'small' })).status, 200, '报小档：第一片放进去');
    assert.equal((await put(hosted.base, tok, 'media', hash, 1, bytes.length, bytes.subarray(CHUNK), { tier: second })).status, 200, '已在收的不算新的一条');
    const staged = (await mediaOf('p-downgrade').inventory()).staging.find(e => e.hash === hash);
    assert.equal(staged?.tier, 'original', `第二片 X-Media-Tier=${JSON.stringify(second)} 之后改记原件`);
    assert.deepEqual(await errorOf(await complete(hosted.base, tok, 'media', hash)), { status: 403, error: 'guest-video-limit' });
  }
  // 反过来：先报原件、后面的片改报小档，不会退回小档（只往计数那边退）。先把上面两条被拒的暂存和一条已入库的删掉腾出名额
  const store = mediaOf('p-downgrade');
  for (const e of (await store.inventory()).staging) assert.equal(await store.remove(e.hash), true);
  assert.equal(await store.remove((await store.inventory()).stored[0].hash), true);
  const bytes = crypto.randomBytes(CHUNK + MiB);
  const hash = sha(bytes);
  assert.equal((await put(hosted.base, tok, 'media', hash, 0, bytes.length, bytes.subarray(0, CHUNK), { tier: 'original' })).status, 200);
  assert.equal((await put(hosted.base, tok, 'media', hash, 1, bytes.length, bytes.subarray(CHUNK), { tier: 'small' })).status, 200);
  assert.equal((await complete(hosted.base, tok, 'media', hash)).status, 200);
  assert.equal((await store.inventory()).stored.find(e => e.hash === hash)?.tier, 'original');
  assert.equal(await countedVideos(store), 3);
});

test('游客：收尾时再数一次，满了回 403、暂存留着；删掉一个视频原件之后能收尾、能再传，删小档不腾名额', async () => {
  const tok = 'p-complete:guest';
  const store = mediaOf('p-complete');
  const [a, b] = [video('a'), video('b')];
  for (const v of [a, b]) assert.deepEqual(await uploadVideo(hosted.base, tok, v), { small: 200, original: 200 });
  // 第 3 条原件只传分片、不收尾（2 条入库 + 1 条在收 = 3，开得出来）
  const x = file('x');
  assert.equal((await put(hosted.base, tok, 'media', x.hash, 0, x.bytes.length, x.bytes)).status, 200);
  // 这时再开一个新的原件暂存：入库 2 + 在收 1 已经到 3，拦；小档不拦
  const y = file('y');
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', y.hash, 0, y.bytes.length, y.bytes)), { status: 403, error: 'guest-video-limit' });
  assert.equal((await upload(hosted.base, tok, 'media', file('y-small', { tier: 'small' }))).status, 200);
  // 同一项目里别的写入先占满了第 3 条：直接经数据层写一条视频原件
  const z = file('z');
  assert.equal((await store.putChunk(z.hash, 0, { size: z.bytes.length, ext: 'mov' }, [z.bytes])).status, 'ok');
  assert.equal((await store.complete(z.hash)).status, 'ok');
  assert.deepEqual(await errorOf(await complete(hosted.base, tok, 'media', x.hash)), { status: 403, error: 'guest-video-limit' });
  assert.deepEqual((await chunksOf(hosted.base, tok, 'media', x.hash)).received, [0], '暂存留着');
  // 删掉一个小档：名额不变，还是收不了尾
  assert.equal(await store.remove(a.small.hash), true);
  assert.deepEqual(await errorOf(await complete(hosted.base, tok, 'media', x.hash)), { status: 403, error: 'guest-video-limit' }, '删小档不腾名额');
  // 删掉一个视频原件：同一条能收尾了
  assert.equal(await store.remove(a.original.hash), true);
  assert.equal((await complete(hosted.base, tok, 'media', x.hash)).status, 200);
  // 又满了；再删一条，能传新的
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', y.hash, 0, y.bytes.length, y.bytes)), { status: 403, error: 'guest-video-limit' });
  assert.equal(await store.remove(b.original.hash), true);
  assert.equal((await upload(hosted.base, tok, 'media', y)).status, 200);
  assert.equal(await countedVideos(store), 3);
});

test('游客：整个项目目录被清掉（三天清理删的就是整个项目目录）之后，数当场归零', async () => {
  const tok = 'p-sweep:guest';
  for (const i of [1, 2, 3]) assert.deepEqual(await uploadVideo(hosted.base, tok, video(`sw${i}`)), { small: 200, original: 200 });
  const v = file('sw4');
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', v.hash, 0, v.bytes.length, v.bytes)), { status: 403, error: 'guest-video-limit' });
  // `removeProject` 删的是 `project(id).dir` 整个目录；这里只删目录、不撤注册，好在同一个项目里接着传
  await fsp.rm(hosted.factory.project('p-sweep').dir, { recursive: true, force: true });
  assert.equal(await countedVideos(mediaOf('p-sweep')), 0);
  for (const i of [5, 6, 7]) assert.deepEqual(await uploadVideo(hosted.base, tok, video(`sw${i}`)), { small: 200, original: 200 });
});

test('游客：并发开两个新的原件暂存，只放进一个；并发的小档都放', async () => {
  const tok = 'p-race:guest';
  for (const it of [file('r1'), file('r2')]) assert.equal((await upload(hosted.base, tok, 'media', it)).status, 200);
  const [p, q] = [file('p'), file('q')];
  const results = await Promise.all([p, q].map(it => put(hosted.base, tok, 'media', it.hash, 0, it.bytes.length, it.bytes).then(r => r.status)));
  assert.deepEqual(results.sort(), [200, 403]);
  const smalls = [1, 2, 3, 4].map(i => file(`ps${i}`, { tier: 'small' }));
  assert.deepEqual(await Promise.all(smalls.map(it => put(hosted.base, tok, 'media', it.hash, 0, it.bytes.length, it.bytes, { tier: 'small' }).then(r => r.status))), [200, 200, 200, 200]);
});

test('游客：snap / px 不受限（条数、尺寸都不管）', async () => {
  const tok = 'p-artifacts:guest';
  for (const ns of ['snap', 'px']) {
    for (let i = 0; i < GUEST_LIMITS.videos + 2; i++) assert.equal((await upload(hosted.base, tok, ns, file(`${ns}-${i}`))).status, 200, `${ns} 第 ${i + 1} 条`);
    const big = crypto.randomBytes(32).toString('hex');
    assert.equal((await put(hosted.base, tok, ns, big, 0, GUEST_LIMITS.assetBytes * 2, Buffer.alloc(CHUNK))).status, 200, `${ns} 200 MB 的第一片`);
  }
});

test('账号：10 个视频原件照收（真的数据层），10 条 200 MB 照收（只记不落盘的数据层）', async () => {
  const tok = 'p-account:account';
  for (let i = 0; i < 10; i++) assert.equal((await upload(hosted.base, tok, 'media', file(`acc-${i}`))).status, 200, `第 ${i + 1} 条`);
  assert.equal(await countedVideos(mediaOf('p-account')), 10);
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
  for (const i of [1, 2, 3]) assert.equal((await upload(hosted.base, 'p-own1:guest', 'media', file(`g${i}`))).status, 200);
  assert.equal((await upload(hosted.base, 'p-own2:guest2', 'media', file('other'))).status, 200);
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

test('整件上传 /api/media/upload：视频按 3 条拦、图片不计数、每个文件 100 MB，没带 Content-Length 回 411；账号不受影响', async () => {
  const tok = 'p-whole:guest';
  for (let i = 0; i < GUEST_LIMITS.videos; i++) {
    const bytes = file(`w${i}`).bytes;
    const res = await rawUpload(hosted.base, tok, { name: `clip${i}.mp4`, body: bytes, length: bytes.length });
    assert.equal(res.status, 200, `第 ${i + 1} 条`);
    assert.equal(res.json.ok, true);
  }
  assert.equal(await countedVideos(mediaOf('p-whole')), 3);
  const extra = file('w-extra').bytes;
  for (const name of ['more.mp4', 'more.MOV', 'more.webm', 'more.mkv'])
    assert.deepEqual(await rawUpload(hosted.base, tok, { name, body: extra, length: extra.length }).then(r => ({ status: r.status, error: r.json?.error })), { status: 403, error: 'guest-video-limit' }, name);
  // 图片、音频：满了照收
  for (const name of ['still.png', 'photo.jpg', 'voice.wav']) {
    const bytes = file(name).bytes;
    assert.equal((await rawUpload(hosted.base, tok, { name, body: bytes, length: bytes.length })).status, 200, name);
  }
  // 分片传的视频原件和整件传的算在同一个数里
  const chunked = file('w-chunked');
  assert.deepEqual(await errorOf(await put(hosted.base, tok, 'media', chunked.hash, 0, chunked.bytes.length, chunked.bytes)), { status: 403, error: 'guest-video-limit' });
  // 另一个空项目里：报 101 MB 的长度，正文一个字节都不发，当场回 403；图片也一样
  const tok2 = 'p-whole2:guest';
  for (const name of ['big.mp4', 'big.png'])
    assert.deepEqual(await rawUpload(hosted.base, tok2, { name, length: GUEST_LIMITS.assetBytes + 1 }).then(r => ({ status: r.status, error: r.json?.error })), { status: 403, error: 'guest-file-too-large' }, name);
  // 分块编码（没有 Content-Length）：量不出多大，游客的拒
  const te = await new Promise((resolve, reject) => {
    const req = http.request(new URL(`${hosted.base}/api/media/upload/a.png`), { method: 'POST', headers: { Authorization: `Bearer ${tok2}`, 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', err => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? undefined : reject(err)));
    req.end(Buffer.from('abc'));
  });
  assert.equal(te, 411);
  // 账号：照常收
  for (let i = 0; i < GUEST_LIMITS.videos + 2; i++) {
    const bytes = file(`wa${i}`).bytes;
    assert.equal((await rawUpload(hosted.base, 'p-whole-acc:account', { name: `a${i}.mp4`, body: bytes, length: bytes.length })).status, 200);
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

  for (let i = 0; i < GUEST_LIMITS.videos; i++) assert.deepEqual(await uploadVideo(base, 'g-rw', video(`t${i}`)), { small: 200, original: 200 });
  const fourth = video('t-4');
  assert.equal((await upload(base, 'g-rw', 'media', fourth.small)).status, 200, '小档照收');
  assert.equal((await upload(base, 'g-rw', 'media', file('t-img', { ext: 'png' }))).status, 200, '图片照收');
  assert.deepEqual(await errorOf(await put(base, 'g-rw', 'media', fourth.original.hash, 0, fourth.original.bytes.length, fourth.original.bytes)), { status: 403, error: 'guest-video-limit' });
  assert.deepEqual(await errorOf(await put(base, 'g-bare', 'media', fourth.original.hash, 0, fourth.original.bytes.length, fourth.original.bytes)), { status: 403, error: 'guest-video-limit' }, '裸编号的票据也认');
  assert.deepEqual(await errorOf(await put(base, 'g-rw', 'media', crypto.randomBytes(32).toString('hex'), 0, GUEST_LIMITS.assetBytes + 1, Buffer.alloc(CHUNK), { ext: 'png', tier: null })), { status: 403, error: 'guest-file-too-large' });
  // 账号票据：照收
  assert.equal((await upload(base, 'a-rw', 'media', fourth.original)).status, 200);
  // 本机回环（不看票据，也就不知道是谁）：照收
  trusted = true;
  for (let i = 0; i < 3; i++) assert.equal((await upload(base, 'whatever', 'media', file(`local${i}`))).status, 200);
  assert.equal((await mediaStore.usage()).blobs, 6 + 2 + 1 + 3);
});
