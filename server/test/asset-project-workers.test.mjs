import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createServiceUsage } from '../asset-store/service-usage.mjs';
import { createPxEvictor } from '../asset-store/px-evict.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { authorizedAssetStore, openProjectStream } from '../asset-store/project-access.mjs';
import { createUploadQueue } from '../upload-queue.mjs';
import { projectMediaPull } from '../media-pull.mjs';
import { createMediaStamper } from '../media-stamp.mjs';
import { createTierManager } from '../media-tiers.mjs';
import { StreamStore, StreamProducer, handleStreamRequest, planStreams, queueStreamOf, segmentSignature } from '../frame-stream.mjs';
import { createWorker, createWorkerProjectScope, WORKER_PROJECT_ENV } from '../hosted-render/worker.mjs';
import { startAssetProjectFixture } from './fixtures/asset-project-service.mjs';

const hash = 'a'.repeat(64), bytes = Buffer.from('owned-payload');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await sleep(10); } throw new Error('test condition timeout'); }
async function tmp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-workers-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function owner(projectId = 'A') { let allowed = true; return { projectId, assert: async () => { if (!allowed) throw new Error('access-revoked'); }, deny: () => { allowed = false; } }; }

test('v2 service usage同hash分别计量；disown/dropA及重启不动B，旧v1账本不误回放', async t => {
  const dir = await tmp(t); await fs.writeFile(path.join(dir, 'render.ndjson'), JSON.stringify({ op: 'add', ns: 'px', hash, size: 99, projectId: 'legacy' }));
  let u = createServiceUsage({ dir, capBytes: 1000, projectScoped: true }); assert.equal(u.usedBytes(), 0);
  for (const projectId of ['A', 'B']) { assert.equal(u.reserve('px', hash, 10, projectId), true); u.record({ ns: 'px', hash, size: 10, projectId }); }
  assert.equal(u.usedBytes(), 20); assert.equal(u.blockCount(), 2); assert.throws(() => u.has('px', hash), /projectId required/);
  u.disown('px', hash, 'A'); u = createServiceUsage({ dir, capBytes: 1000, projectScoped: true }); assert.equal(u.has('px', hash, 'A'), false); assert.equal(u.has('px', hash, 'B'), true);
  u.record({ ns: 'px', hash, size: 10, projectId: 'A' }); assert.deepEqual(u.dropProject('A').map(b => b.projectId), ['A']); assert.equal(u.usedBytes(), 10);
});

test('px维护不能配其它project/namespace目录；退休store迟到发布拒', async t => {
  const dir = await tmp(t), f = createProjectAssetStores({ dir }), a = f.project('A'), b = f.project('B');
  assert.throws(() => createPxEvictor({ dir: b.dirs.px, store: a.stores.px }), /mismatch/);
  assert.throws(() => createPxEvictor({ dir: a.dirs.media, store: a.stores.media }), /mismatch/);
  const stream = new Readable({ read() {} }), h = sha(bytes);
  const pending = a.stores.media.putChunk(h, 0, { size: bytes.length, ext: 'wav' }, stream);
  await sleep(30); await f.removeProject('A'); stream.push(bytes); stream.push(null);
  await assert.rejects(pending, /project-gone|ENOENT/); assert.throws(() => a.stores.media.stat(h), /project-gone/); assert.equal(await b.stores.media.stat(h), null);
});

test('旧凭证撤销夹在完整块发布前：complete拒且不落完整hash', async t => {
  const dir = await tmp(t), f = createProjectAssetStores({ dir }), raw = f.store('A', 'media'), h = sha(bytes);
  await raw.putChunk(h, 0, { size: bytes.length, ext: 'wav' }, Readable.from([bytes]));
  let callback, allowed = true, checks = 0;
  const authority = { subscribeRevocations: (_c, cb) => { callback = cb; return () => {}; }, checkAccess: async () => { checks++; if (checks === 4) { allowed = false; callback({ reason: 'kicked' }); } return { allowed }; } };
  const lease = await openProjectStream({ authority, principal: { projectId: 'A' }, projectId: 'A' });
  await assert.rejects(authorizedAssetStore(raw, lease).complete(h), /forbidden|access-revoked/); assert.equal(await raw.stat(h), null); lease.release();
});

test('队列持久记录只含项目归属，错项目restoration/target/input与迟到完成不能算成功', async t => {
  const dir = await tmp(t), file = path.join(dir, 'queue.json'), ownership = owner(); let release, uploads = 0;
  const blocked = new Promise(r => { release = r; }); const target = { projectId: 'A', client: { async putFile(_ns, _file, options) { uploads++; await options.beforeChunk(); await blocked; return { uploaded: true }; }, chunks: async () => ({ complete: true }) } };
  const q = createUploadQueue({ file, ownership, target: () => target, resolveFile: async () => 'owned.tmp', backoff: [60000] });
  assert.deepEqual(await q.enqueue({ projectId: 'B', tiers: [{ tier: 'original', hash }] }), { queued: false, reason: 'project-mismatch' });
  await q.enqueue({ tiers: [{ tier: 'original', hash }] }); const disk = await fs.readFile(file, 'utf8'); assert.equal(/authorizationId|credentialId|token/.test(disk), false);
  const foreignFile = path.join(dir, 'foreign.json'); await fs.copyFile(file, foreignFile);
  const foreign = createUploadQueue({ file: foreignFile, ownership: owner('B'), target: () => target, resolveFile: async () => 'unused' }); assert.equal(foreign.stats().restored, 0); await foreign.stop();
  q.start(); await until(() => uploads === 1); ownership.deny(); release(); await until(() => !q.stats().working);
  assert.equal(q.stats().done, 0); assert.equal(q.stats().items.length, 1); assert.equal(q.stats().failures, 1); await q.stop();
  const wrong = createUploadQueue({ file: path.join(dir, 'wrong.json'), ownership: owner(), target: () => ({ ...target, projectId: 'B' }), resolveFile: async () => 'unused', backoff: [60000] });
  await wrong.enqueue({ tiers: [{ tier: 'original', hash }] }); wrong.start(); await until(() => wrong.stats().failures === 1); assert.equal(uploads, 1); await wrong.stop();
});

test('项目pull独立remote/cache状态，不能以A票据设置B；stamp缓存命中仍重核', async () => {
  const a = projectMediaPull({ projectId: 'A', root: path.join(os.tmpdir(), 'pull-a') }), b = projectMediaPull({ projectId: 'B', root: path.join(os.tmpdir(), 'pull-b') });
  a.resetPullStateForTest(); b.resetPullStateForTest(); a.setRemoteAssetService({ projectId: 'A', base: 'http://127.0.0.1:5788/api/asset', ticket: 'fixture' });
  assert.equal(b.remoteAssetBase(), null); assert.throws(() => b.setRemoteAssetService({ projectId: 'A', base: 'http://127.0.0.1:5788/api/asset' }), /project-mismatch/);
  const ownership = owner(); let calls = 0; const stamper = createMediaStamper({ ownership, mediaUrl: () => 'http://fixture', fetch: async () => { calls++; return new Response('', { headers: { 'content-length': '4' } }); } });
  await stamper.stamp({ path: 'owned', projectId: 'A' }); await stamper.stamp({ path: 'owned', projectId: 'A' }); assert.equal(calls, 1); ownership.deny(); await assert.rejects(stamper.stamp({ path: 'owned' }), /access-revoked/);
  a.resetPullStateForTest(); b.resetPullStateForTest();
});

test('tier manager拒错项目输入/持久缓存；worker失权不认领也不排上传', async t => {
  const dir = await tmp(t), ownership = owner(); let uploads = 0;
  await fs.writeFile(path.join(dir, 'tiers.json'), JSON.stringify({ v: 1, projectId: 'B', items: { [hash]: { state: 'ready', small: hash } } }));
  const manager = createTierManager({ dir, ownership, ffmpeg: async () => { throw new Error('must not execute'); }, lib: {}, queue: { enqueue: async () => { uploads++; } } });
  assert.equal(manager.status([hash])[hash].state, 'unknown');
  await assert.rejects(manager.prepareImport({ projectId: 'B', path: path.join(dir, 'x.mp4'), ext: 'mp4', hash }), /project-mismatch/);
  const image = { projectId: 'A', path: path.join(dir, 'x.png'), ext: 'png', hash }; await manager.prepareImport(image); assert.equal(uploads, 1);
  ownership.deny(); await assert.rejects(manager.backfill({ hash, ext: 'mp4' }), /access-revoked/); assert.equal(uploads, 1); await manager.idle();
});

test('真实owned child撤销等待close而非只见exit', async () => {
  let callback; const authority = { checkAccess: async () => ({ allowed: true }), subscribeRevocations: (_c, cb) => { callback = cb; return () => {}; } };
  const lease = await openProjectStream({ authority, principal: { projectId: 'A' }, projectId: 'A' });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' }); let closed = false; child.once('close', () => { closed = true; }); lease.trackProcess(child);
  await callback({ reason: 'delete' }); assert.equal(closed, true); lease.release();
});

test('真实ffmpeg项目worker独立转码/登记；编码后失权的迟到产物清理不发布', { timeout: 20000 }, async t => {
  const dir = await tmp(t);
  const exec = (command, args) => new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', b => { stderr += b; }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr))); });
  const source = path.join(dir, 'source.mp4'); await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32:r=10', '-t', '0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', source]);
  const content = await fs.readFile(source), h = sha(content);
  for (const late of [false, true]) {
    const ownedDir = path.join(dir, late ? 'late' : 'accepted'); await fs.mkdir(ownedDir); await fs.writeFile(path.join(ownedDir, `${h}.mp4`), content);
    const ownership = owner(); let indexed = 0, enqueued = 0;
    const manager = createTierManager({ dir: ownedDir, ownership, ffmpeg: async () => 'ffmpeg', queue: { enqueue: async item => { assert.equal(item.projectId, 'A'); enqueued++; } }, lib: {
      hashFile: async file => { const result = sha(await fs.readFile(file)); if (late) ownership.deny(); return result; }, contentTypeForExt: () => 'video/mp4', writeIndex: async () => { indexed++; },
    } });
    await manager.prepareImport({ projectId: 'A', path: path.join(ownedDir, `${h}.mp4`), ext: 'mp4', name: 'public-fixture.mp4', hash: h }, { remux: false }); await manager.idle();
    const files = await fs.readdir(ownedDir); assert.equal(files.some(n => n.startsWith('.small-')), false);
    if (late) { assert.equal(indexed, 0); assert.equal(enqueued, 0); assert.equal(files.filter(n => n.endsWith('.mp4')).length, 1); }
    else { assert.equal(indexed, 1); assert.equal(enqueued, 1); assert.equal(manager.status([h])[h].state, 'ready'); const disk = JSON.parse(await fs.readFile(manager.file, 'utf8')); assert.equal(disk.projectId, 'A'); }
  }
});

test('frame stream真实HTTP清单/初始化/分段按项目、错项目worker归属与迟到save拒', async t => {
  const dir = await tmp(t), fixture = await startAssetProjectFixture(); t.after(() => fixture.close());
  const aOwner = owner(), bOwner = owner('B'), a = new StreamStore(dir, { ownership: aOwner, projectAccess: fixture.projectAccess }), b = new StreamStore(dir, { ownership: bOwner, projectAccess: fixture.projectAccess });
  assert.notEqual(a.root, b.root); const initId = 'b'.repeat(16), file = `0-${'c'.repeat(16)}.m4s`;
  await a.save({ streamKey: hash, projectId: 'A', inits: {}, segments: {}, length: 15 }); await fs.writeFile(a.initFile(hash, initId), bytes); await fs.writeFile(a.segFile(hash, file), bytes);
  const server = http.createServer((req, res) => { const selected = req.headers.authorization === 'Bearer B-rw' ? b : a; if (!handleStreamRequest(selected, req, res, req.url)) { res.statusCode = 404; res.end(); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  for (const part of ['manifest', `init/${initId}`, `seg/${file}`]) for (const project of ['A', 'B']) { const r = await fetch(`http://127.0.0.1:${server.address().port}/stream/${hash}/${part}`, { headers: { authorization: `Bearer ${project}-rw` } }); assert.equal(r.status, project === 'A' ? 200 : 404); await r.arrayBuffer(); }
  const producer = new StreamProducer({ root: dir }, { ownership: aOwner, env: {} }); await assert.rejects(producer.adoptionNeeds({ projectId: 'B' }), /project-mismatch/); await assert.rejects(producer.adoptSegmentsNow({ projectId: 'B' }, {}), /project-mismatch/);
  aOwner.deny(); await assert.rejects(a.save({ streamKey: hash }), /access-revoked/); await assert.rejects(producer.adoptionNeeds({ projectId: 'A' }), /access-revoked/);
  await fixture.revoke('A'); const denied = await fetch(`http://127.0.0.1:${server.address().port}/stream/${hash}/manifest`, { headers: { authorization: 'Bearer A-rw' } }); assert.equal(denied.status, 403); await denied.arrayBuffer();
});

test('frame-stream 跨项目同卡片参数衍生流键隔离，且项目 B 绝不能凭相同参数或流键读到项目 A 轨道流或跳过授权', async t => {
  const dir = await tmp(t), fixture = await startAssetProjectFixture(); t.after(() => fixture.close());
  const cardEntry = {
    key: 'entry-same',
    project: {
      fps: 30,
      width: 1920,
      height: 1080,
      duration: 2,
      tracks: [{ id: 't1', clips: [{ id: 'c1', cardId: 'heavy-card', start: 0, end: 2 }] }],
    },
    cardPlan: [{
      clipId: 'c1',
      key: 'card-key-same',
      streamMemberKey: 'member-key-same',
      count: 60,
      sampling: { firstFrame: 0, fps: { numerator: '30', denominator: '1' }, phase: { numerator: '0', denominator: '1' } },
      capabilities: { heavy: true },
    }],
  };

  // 1) 相同卡片参数 + 相同 envFingerprint 在项目 A 与项目 B 下衍生出不同的 contentKey、streamKey 与分段签名
  const specsA = planStreams(cardEntry, { envFingerprint: 'env-1', projectId: 'A' });
  const specsB = planStreams(cardEntry, { envFingerprint: 'env-1', projectId: 'B' });
  assert.equal(specsA.length, 1);
  assert.equal(specsB.length, 1);
  assert.equal(specsA[0].projectId, 'A');
  assert.equal(specsB[0].projectId, 'B');
  assert.notEqual(specsA[0].contentKey, specsB[0].contentKey, '不同项目的同参数卡片衍生 contentKey 必须隔离');
  assert.notEqual(specsA[0].streamKey, specsB[0].streamKey, '不同项目的同参数卡片衍生 streamKey 必须隔离');
  assert.equal(queueStreamOf(specsA[0]).projectId, 'A');
  assert.notEqual(
    segmentSignature({ streamKey: specsA[0].streamKey, segment: 0, stride: 1, encoder: 'libx264', rect: specsA[0].bound, projectId: 'A' }),
    segmentSignature({ streamKey: specsA[0].streamKey, segment: 0, stride: 1, encoder: 'libx264', rect: specsA[0].bound, projectId: 'B' }),
  );

  // 2) StreamProducer 严格绑定所属项目，拒绝跨项目 entry / spec 的 update、queueState、produceRange、produceExportRange
  const aOwner = owner('A'), bOwner = owner('B');
  const makePipeline = () => ({
    root: dir,
    envFingerprint: 'env-1',
    prerenderPicked: () => true,
    ready: { stageByKey() {}, publish() {} },
  });
  const prodA = new StreamProducer(makePipeline(), { ownership: aOwner, projectAccess: fixture.projectAccess, env: {} });
  const prodB = new StreamProducer(makePipeline(), { ownership: bOwner, projectAccess: fixture.projectAccess, env: {} });
  prodA.attachRoute();
  prodB.attachRoute();
  t.after(async () => { await prodA.close(); await prodB.close(); });

  const initId = 'd'.repeat(16), segFile = `0-${'e'.repeat(16)}.m4s`;
  const keyA = specsA[0].streamKey;
  await prodA.store.save({
    version: 4,
    streamKey: keyA,
    projectId: 'A',
    kind: 'card',
    plane: 'local',
    clipIds: ['c1'],
    fps: 30,
    originFrame: 0,
    bound: specsA[0].bound,
    inits: { [initId]: { codec: 'avc1.64001f', width: 640, height: 360, rect: specsA[0].bound } },
    segments: { 0: { init: initId, file: segFile, stride: 1, samples: 15 } },
  });
  await fs.writeFile(prodA.store.initFile(keyA, initId), bytes);
  await fs.writeFile(prodA.store.segFile(keyA, segFile), bytes);

  // 项目 B 尝试用项目 A 的 entry 或 spec 调用生产者各入口一律抛 project-mismatch
  await assert.rejects(prodB.update({ ...cardEntry, projectId: 'A' }), /project-mismatch/);
  await assert.rejects(prodB.queueState(cardEntry, specsA[0]), /project-mismatch/);
  await assert.rejects(prodB.produceRange(cardEntry, specsA[0], { from: 0, to: 0 }), /project-mismatch/);
  await assert.rejects(prodB.produceExportRange(cardEntry, { ...specsA[0], exportResultKey: keyA }, { from: 0, to: 0 }, { onFrame: () => {} }), /project-mismatch/);

  // 即使项目 B 直接向自己的流库或 HTTP 路由请求项目 A 的 streamKey，也拿不到任何清单或分段
  assert.equal(await prodB.store.load(keyA), null);
  const server = http.createServer((req, res) => {
    const target = req.headers['x-target-store'] === 'A' ? prodA : prodB;
    if (!target.handle(req, res, req.url)) { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // 项目 B 票据打项目 B 的 store（404）与打项目 A 的 store（403 project-mismatch）均被拒
  const bOnB = await fetch(`${base}/stream/${keyA}/manifest`, { headers: { authorization: 'Bearer B-rw', 'x-target-store': 'B' } });
  assert.equal(bOnB.status, 404);
  await bOnB.arrayBuffer();

  const bOnA = await fetch(`${base}/stream/${keyA}/manifest`, { headers: { authorization: 'Bearer B-rw', 'x-target-store': 'A' } });
  assert.equal(bOnA.status, 403, '项目 B 票据访问项目 A 流读口必须被 403 拒绝');
  await bOnA.arrayBuffer();

  const aOnA = await fetch(`${base}/stream/${keyA}/seg/${segFile}`, { headers: { authorization: 'Bearer A-rw', 'x-target-store': 'A' } });
  assert.equal(aOnA.status, 200);
  assert.deepEqual(Buffer.from(await aOnA.arrayBuffer()), bytes);
});

test('hosted-render/worker 跨项目同哈希素材缓存、代理口令与环境变量隔离，切换项目绝不串用', async t => {
  const dir = await tmp(t);
  const sameBytes = Buffer.from('identical-media-bytes-across-projects-A-and-B');
  const sameHash = sha(sameBytes);

  const scopeA = createWorkerProjectScope({
    dataDir: dir,
    projectId: 'proj_A',
    brokerUrl: 'http://127.0.0.1:5399',
    brokerKey: 'broker-key-proj-A',
    ticket: 'asset-ticket-proj-A',
    remoteAssetBase: 'http://127.0.0.1:5788/api/asset',
  });
  const scopeB = createWorkerProjectScope({
    dataDir: dir,
    projectId: 'proj_B',
    brokerUrl: 'http://127.0.0.1:5399',
    brokerKey: 'broker-key-proj-B',
    ticket: 'asset-ticket-proj-B',
    remoteAssetBase: 'http://127.0.0.1:5788/api/asset',
  });

  // 1) 物理目录完全隔离，且项目 A 写入的同哈希素材缓存绝不在项目 B 命中
  assert.notEqual(scopeA.dirs.assets, scopeB.dirs.assets);
  scopeA.putAsset(sameHash, sameBytes, { projectId: 'proj_A', ticket: 'asset-ticket-proj-A' });
  assert.equal(scopeA.hasAsset(sameHash), true);
  assert.deepEqual(scopeA.getAsset(sameHash), sameBytes);
  assert.equal(scopeB.hasAsset(sameHash), false, '项目 B 绝不能命中项目 A 的同哈希素材缓存');
  assert.equal(scopeB.getAsset(sameHash), null);

  // 2) 跨项目使用票据、代理口令或伪造磁盘缓存元数据一律被拒
  assert.throws(() => scopeB.getAsset(sameHash, { projectId: 'proj_A' }), /project-mismatch/);
  assert.throws(() => scopeB.getAsset(sameHash, { ticket: 'asset-ticket-proj-A' }), /project-mismatch/);
  assert.throws(() => scopeB.putAsset(sameHash, sameBytes, { ticket: 'asset-ticket-proj-A' }), /project-mismatch/);
  assert.throws(() => scopeB.setCredentials({ brokerKey: 'broker-key-proj-A' }), /project-mismatch/);
  assert.throws(() => scopeB.setCredentials({ ticket: 'asset-ticket-proj-A' }), /project-mismatch/);

  // 即使把项目 A 的缓存文件与元数据硬拷进项目 B 的目录，因元数据 projectId 为 proj_A 也被拒绝读取
  await fs.copyFile(path.join(scopeA.dirs.assets, sameHash), path.join(scopeB.dirs.assets, sameHash));
  await fs.copyFile(path.join(scopeA.dirs.assets, `${sameHash}.meta.json`), path.join(scopeB.dirs.assets, `${sameHash}.meta.json`));
  assert.equal(scopeB.getAsset(sameHash), null, '带项目 A 归属标记的缓存文件在项目 B 下被拒读');

  // 项目 B 用自己的票据独立入库相同字节后，项目 B 正常可读
  scopeB.putAsset(sameHash, sameBytes, { projectId: 'proj_B', ticket: 'asset-ticket-proj-B' });
  assert.deepEqual(scopeB.getAsset(sameHash), sameBytes);

  // 3) createWorker 环境变量绑定与 switchProject 跨项目切换隔离
  const spawnedEnvs = [];
  let currentCmdProject = 'proj_A';
  let currentCmdBrokerKey = 'broker-key-worker-A';
  const fakeSpawn = (_cmd, _args, opts) => {
    spawnedEnvs.push(opts.env);
    const fakeChild = Object.assign(new Readable({ read() {} }), {
      pid: 42000 + spawnedEnvs.length,
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      connected: true,
      send() { setImmediate(() => fakeChild.emit('exit', 0, null)); },
    });
    return fakeChild;
  };

  const worker = createWorker({
    projectId: 'proj_A',
    dataDir: dir,
    brokerUrl: 'http://127.0.0.1:5399',
    brokerKey: currentCmdBrokerKey,
    spawn: fakeSpawn,
    command: () => ({
      cmd: process.execPath,
      args: ['render-host.mjs'],
      projectId: currentCmdProject,
      brokerKey: currentCmdBrokerKey,
      env: { PROMPTCUT_CLUSTER_TOKEN: 'secret-cluster', PROMPTCUT_ASSET_TICKET: 'stale-ticket' },
    }),
  });

  worker.start();
  assert.equal(spawnedEnvs.length, 1);
  assert.equal(spawnedEnvs[0][WORKER_PROJECT_ENV], 'proj_A');
  assert.equal(spawnedEnvs[0].PROMPTCUT_RENDER_BROKER_KEY, 'broker-key-worker-A');
  assert.equal(spawnedEnvs[0].PROMPTCUT_CLUSTER_TOKEN, undefined, '集群令牌被剥离');
  assert.equal(spawnedEnvs[0].PROMPTCUT_ASSET_TICKET, undefined, '遗留票据被剥离');
  const prevScopeA = worker.assetScope;
  prevScopeA.putAsset(sameHash, sameBytes);
  assert.equal(prevScopeA.hasAsset(sameHash), true);

  // 切换到项目 B 时若试图沿用项目 A 的 brokerKey 立即报错拒绝
  await assert.rejects(
    worker.switchProject('proj_B', { brokerKey: 'broker-key-worker-A' }),
    /project-mismatch/,
  );

  // 用项目 B 专属的新 brokerKey 切换后，旧作用域退役、新作用域缓存为空且目录/环境变量严格指向 proj_B
  currentCmdProject = 'proj_B';
  currentCmdBrokerKey = 'broker-key-worker-B';
  const nextScopeB = await worker.switchProject('proj_B', {
    brokerKey: currentCmdBrokerKey,
    ticket: 'ticket-worker-B',
    wipePreviousDisk: true,
  });
  assert.equal(prevScopeA.active, false, '切换项目后旧项目的素材缓存作用域已退役');
  assert.throws(() => prevScopeA.getAsset(sameHash), /worker-scope-retired|project-retired/);
  assert.equal(worker.projectId, 'proj_B');
  assert.equal(nextScopeB.projectId, 'proj_B');

  worker.start();
  assert.equal(spawnedEnvs.length, 2);
  assert.equal(spawnedEnvs[1][WORKER_PROJECT_ENV], 'proj_B');
  assert.equal(spawnedEnvs[1].PROMPTCUT_RENDER_BROKER_KEY, 'broker-key-worker-B');
  assert.notEqual(spawnedEnvs[1].PROMPTCUT_DATA_DIR, spawnedEnvs[0].PROMPTCUT_DATA_DIR);
  await worker.stop();
});
