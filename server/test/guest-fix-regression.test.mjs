/**
 * 游客限额的回归（claude/guest-fix，审查 REVIEW-guest-identity 实测出来的绕过）：
 * - A1：把视频原件的每一片都标成 `X-Media-Tier: small` 就不计数（实测 5 条 mp4 全收）；
 * - A2：把视频的扩展名报成 `jpg` 就不计数（实测 5 条全收）；整件上传把文件名起成 `.jpg` 同理；
 * - S2：整件上传第一次核权出暂时性错误时直接放行到媒体中间件（失败放开），绕过限额；
 * - S3：`POST /api/media/adopt` 能把媒体目录里的文件（包括还没收尾的分片暂存）挂进库，绕过收尾时的计数。
 * 改法见 `server/asset-store/guest-quota.mjs`、`server/asset-store/media-sniff.mjs` 的文件头。
 *
 * 夹具里的「视频」是带真 `ftyp` 盒子开头的字节（文件头认得出是 mp4），图片是带真 PNG 签名的字节。
 * 端口一律 0（系统给），不占固定端口。
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
import { sniffMediaKind, countsAsVideoFile } from '../asset-store/media-sniff.mjs';
import { videoSourcesOf } from '../asset-store/guest-quota.mjs';
import { GUEST_LIMITS } from '../account/guest.mjs';

const GUEST = 'gst_' + '0123456789abcdef01234567';
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const tail = () => Buffer.from(` ${crypto.randomUUID()} `.repeat(4));
/** 一段以 mp4 的 `ftyp isom` 盒子开头的字节 */
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom\0\0\x02\0isomiso2avc1mp41', 'latin1'), tail()]);
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]), tail()]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.from('IHDR', 'latin1'), tail()]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF\0', 'latin1'), tail()]);
const wav = () => Buffer.concat([Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1'), tail()]);
const binaryJunk = () => Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]), crypto.randomBytes(48)]);

test('文件头认类型：视频、图片、音频、文本、认不出', () => {
  assert.equal(sniffMediaKind(mp4()), 'video');
  assert.equal(sniffMediaKind(webm()), 'video');
  assert.equal(sniffMediaKind(Buffer.from('\0\0\0\x14moovxxxxxxxxxxxxxxxx', 'latin1')), 'video', '没有 ftyp 的老式 mov');
  assert.equal(sniffMediaKind(Buffer.from('RIFF\0\0\0\0AVI LIST', 'latin1')), 'video');
  assert.equal(sniffMediaKind(Buffer.from('\0\0\0\x1cftypavif\0\0\0\0avifmif1', 'latin1')), 'image', 'AVIF 是图片');
  assert.equal(sniffMediaKind(Buffer.from('\0\0\0\x1cftypM4A \0\0\0\0M4A isom', 'latin1')), 'audio', 'M4A 是音频');
  assert.equal(sniffMediaKind(png()), 'image');
  assert.equal(sniffMediaKind(jpeg()), 'image');
  assert.equal(sniffMediaKind(Buffer.from('GIF89a\x01\0\x01\0', 'latin1')), 'image');
  assert.equal(sniffMediaKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image');
  assert.equal(sniffMediaKind(wav()), 'audio');
  assert.equal(sniffMediaKind(Buffer.from('ID3\x04\0\0\0\0\0\0', 'latin1')), 'audio');
  assert.equal(sniffMediaKind(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0])), 'audio', 'MP3 帧同步');
  assert.equal(sniffMediaKind(Buffer.from('OggS\0\x02\0\0\0\0\0\0\0\0\x01vorbis', 'latin1')), 'audio');
  assert.equal(sniffMediaKind(Buffer.from('OggS\0\x02\0\0\0\0\0\0\0\0\x80theora', 'latin1')), 'video', 'Ogg 里装 Theora 是视频');
  assert.equal(sniffMediaKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'text');
  assert.equal(sniffMediaKind(binaryJunk()), 'unknown');
  // 算不算一条视频：报的扩展名是视频的一律算；否则文件头是视频或认不出（又不是文本）的算
  assert.equal(countsAsVideoFile(png(), true), true);
  assert.equal(countsAsVideoFile(mp4(), false), true);
  assert.equal(countsAsVideoFile(binaryJunk(), false), true, '认不出的按视频算（失败闭合）');
  for (const head of [png(), jpeg(), wav(), Buffer.from('<svg/>')]) assert.equal(countsAsVideoFile(head, false), false);
});

test('视频源怎么数：原件几个、小档几个，取多的那个', () => {
  const v = (tier, video = true) => ({ video, tier });
  assert.equal(videoSourcesOf([v('original'), v('small'), v('original'), v('small')]), 2, '两个视频各两档');
  assert.equal(videoSourcesOf([v('small'), v('small'), v('small'), v('small'), v('small')]), 5, '全报小档：照样数到');
  assert.equal(videoSourcesOf([v('original'), v('original'), v('original', false), v('small', false)]), 2, '不是视频的不数');
});

/* ------------------------------------------------------------------ *
 * 托管的素材服务（真的项目数据层 + 合成的文档服务权威）
 * ------------------------------------------------------------------ */

const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-guest-fix-'));
after(() => fsp.rm(out, { recursive: true, force: true }));
const { asset, media } = await compileAssetModules(out);

/** 票据就是项目号；`flaky-` 开头的项目，核权按 `failures` 里登记的次数先回 503 */
const failures = new Map();
const principalOf = token => (/^[A-Za-z0-9-]+$/.test(String(token ?? ''))
  ? { projectId: token, access: 'rw', accountId: GUEST, loginId: `l-${GUEST}`, credentialId: `c-${GUEST}`, authorizationId: `auth-${token}` } : null);
const authority = {
  async checkAccess({ principal, projectId }) { return { allowed: principal?.projectId === projectId, accessRevision: 1, revocationSeq: 0 }; },
  subscribeRevocations() { return () => {}; },
};
const projectAccess = createProjectAssetAccess({ authority, resolvePrincipal: async req => {
  const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
  const left = failures.get(token) ?? 0;
  if (left > 0) { failures.set(token, left - 1); throw Object.assign(new Error('flaky'), { status: 503, code: 'authority-unavailable' }); }
  return principalOf(token);
} });
const factory = createProjectAssetStores({ dir: path.join(out, 'assets'), contentTypeForExt: media.contentTypeForExt });
const opts = { projectStores: factory, projectAccess, pullArtifact: null, pxEvict: null };
const a = asset.assetServiceMiddleware(out, opts);
const m = media.mediaMiddleware(out, { ...opts, verifyRemoteTarget: async () => { throw Object.assign(new Error('no'), { status: 403 }); } });
const server = http.createServer((req, res) => { void a(req, res, () => { void m(req, res, () => { res.statusCode = 404; res.end('no route'); }); }); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => { server.closeAllConnections?.(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const storeOf = pid => factory.project(pid).stores.media;

/** 分片上传一个文件（一片）再收尾：回 `[PUT 的状态, 收尾的状态, 收尾的 error]` */
async function chunked(pid, bytes, { ext, tier }) {
  const hash = sha(bytes);
  const headers = { Authorization: `Bearer ${pid}`, 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), 'X-Media-Ext': ext };
  if (tier !== undefined) headers['X-Media-Tier'] = tier;
  const put = await fetch(`${base}/api/asset/media/${hash}/0`, { method: 'PUT', headers, body: bytes });
  await put.arrayBuffer();
  if (put.status !== 200) return { hash, put: put.status, complete: null, error: null };
  const c = await fetch(`${base}/api/asset/media/${hash}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${pid}` } });
  const body = await c.json().catch(() => ({}));
  return { hash, put: put.status, complete: c.status, error: body.error ?? null };
}
/** 整件上传 */
async function whole(pid, name, bytes) {
  const res = await fetch(`${base}/api/media/upload/${encodeURIComponent(name)}`, { method: 'POST', headers: { Authorization: `Bearer ${pid}` }, body: bytes });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, error: body.error ?? null, hash: body.hash ?? null };
}
const stored = async pid => (await storeOf(pid).inventory()).stored.length;

test('A1：视频原件的每一片都标成 small，第 4 条起拦下（改前 5 条全收）', async () => {
  const pid = 'a1-tier-spoof';
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await chunked(pid, mp4(), { ext: 'mp4', tier: 'small' }));
  console.log('A1', JSON.stringify(res.map(r => [r.put, r.complete])));
  assert.deepEqual(res.map(r => r.put), [200, 200, 200, 403, 403]);
  assert.equal(await stored(pid), GUEST_LIMITS.videos);
  // 3 个报原件、3 个报小档：最多放进 6 个文件（每条视频源一原件一小档），第 7 个拦
  const pid2 = 'a1-mixed';
  const mixed = [];
  for (const tier of ['original', 'original', 'original', 'small', 'small', 'small', 'small', 'original']) mixed.push((await chunked(pid2, mp4(), { ext: 'mp4', tier })).put);
  console.log('A1 mixed', JSON.stringify(mixed));
  assert.deepEqual(mixed, [200, 200, 200, 200, 200, 200, 403, 403]);
});

test('A2：视频报成 jpg（分片上传），第 4 条在收尾时被拒、刚入库的那条删掉（改前 5 条全收）', async () => {
  const pid = 'a2-ext-spoof';
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await chunked(pid, mp4(), { ext: 'jpg', tier: 'original' }));
  console.log('A2', JSON.stringify(res.map(r => [r.put, r.complete, r.error])));
  assert.deepEqual(res.map(r => [r.put, r.complete]), [[200, 200], [200, 200], [200, 200], [200, 403], [200, 403]]);
  assert.deepEqual(res.slice(3).map(r => r.error), ['guest-video-limit', 'guest-video-limit']);
  assert.equal(await stored(pid), GUEST_LIMITS.videos);
  for (const r of res.slice(3)) assert.equal(await storeOf(pid).stat(r.hash), null, '被拒的那条没留在库里');
  // WebM 报成 png、认不出的二进制报成 jpg：一样算视频，满了照拦
  assert.equal((await chunked(pid, webm(), { ext: 'png', tier: 'original' })).complete, 403);
  assert.equal((await chunked(pid, binaryJunk(), { ext: 'jpg', tier: 'original' })).complete, 403);
  // 真的图片、音频不计数：满了照收
  for (const [bytes, ext] of [[png(), 'png'], [jpeg(), 'jpg'], [wav(), 'wav'], [png(), 'jpg'], [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg']]) {
    const r = await chunked(pid, bytes, { ext, tier: 'original' });
    assert.deepEqual([r.put, r.complete], [200, 200], `真的 ${ext}`);
  }
  // 删掉一条报成 jpg 的视频，就能再传一条视频
  const first = res[0].hash;
  assert.equal(await storeOf(pid).remove(first), true);
  assert.equal((await chunked(pid, mp4(), { ext: 'mp4', tier: 'original' })).complete, 200);
});

test('A2：整件上传把视频的文件名起成 .jpg，按文件头算视频；真的图片照收', async () => {
  const pid = 'a2-whole';
  const res = [];
  for (let i = 0; i < 4; i++) res.push(await whole(pid, `clip${i}.jpg`, mp4()));
  console.log('A2 whole', JSON.stringify(res.map(r => [r.status, r.error])));
  assert.deepEqual(res.map(r => r.status), [200, 200, 200, 403]);
  assert.equal(res[3].error, 'guest-video-limit');
  for (const [name, bytes] of [['a.png', png()], ['b.jpg', jpeg()], ['c.wav', wav()]]) assert.equal((await whole(pid, name, bytes)).status, 200, name);
  // 分片和整件算在同一个数里
  assert.equal((await chunked(pid, mp4(), { ext: 'mp4', tier: 'original' })).put, 403);
  // 读过开头再塞回去，整件的字节没少：取回来和原来一样
  const pic = png();
  const up = await whole(pid, 'same.png', pic);
  assert.equal(up.hash, sha(pic));
});

test('S2：整件上传第一次核权回 503 时照错误回，不再放到媒体中间件去（改前放过去、绕过限额）', async () => {
  const pid = 'flaky-s2';
  for (let i = 0; i < 3; i++) assert.equal((await whole(pid, `v${i}.mp4`, mp4())).status, 200);
  failures.set(pid, 1);
  const r = await whole(pid, 'v3.mp4', mp4());
  console.log('S2', JSON.stringify(r));
  assert.deepEqual([r.status, r.error], [503, 'authority-unavailable']);
  assert.equal(await stored(pid), 3);
  // 核权恢复之后照常按限额拦
  assert.equal((await whole(pid, 'v4.mp4', mp4())).status, 403);
});

test('S3：游客不能补算内容键（adopt），哪怕指向还没收尾的分片暂存', async () => {
  const pid = 's3-adopt';
  for (let i = 0; i < 3; i++) assert.equal((await chunked(pid, mp4(), { ext: 'mp4', tier: 'original' })).complete, 200);
  // 第 4 条只传分片不收尾（报成 jpg 开得出暂存），再拿它的暂存文件去 adopt
  const bytes = mp4();
  const hash = sha(bytes);
  const put = await fetch(`${base}/api/asset/media/${hash}/0`, { method: 'PUT', headers: { Authorization: `Bearer ${pid}`, 'X-Media-Size': String(bytes.length), 'X-Media-Ext': 'jpg' }, body: bytes });
  assert.equal(put.status, 200);
  const staged = path.join(factory.project(pid).dirs.media, '.chunks', hash, 'data');
  await fsp.stat(staged);
  const res = await fetch(`${base}/api/media/adopt?path=${encodeURIComponent(staged)}`, { method: 'POST', headers: { Authorization: `Bearer ${pid}` } });
  const body = await res.json().catch(() => ({}));
  console.log('S3', res.status, body.error);
  assert.deepEqual([res.status, body.error], [403, 'guest-adopt-forbidden']);
  assert.equal(await stored(pid), 3);
});
