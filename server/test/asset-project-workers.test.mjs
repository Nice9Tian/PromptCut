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
import { StreamStore, StreamProducer, handleStreamRequest } from '../frame-stream.mjs';
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
  const dir = await tmp(t), fixture = await startAssetProjectFixture({ port: 5782 }); t.after(() => fixture.close());
  const aOwner = owner(), bOwner = owner('B'), a = new StreamStore(dir, { ownership: aOwner, projectAccess: fixture.projectAccess }), b = new StreamStore(dir, { ownership: bOwner, projectAccess: fixture.projectAccess });
  assert.notEqual(a.root, b.root); const initId = 'b'.repeat(16), file = `0-${'c'.repeat(16)}.m4s`;
  await a.save({ streamKey: hash, projectId: 'A', inits: {}, segments: {}, length: 15 }); await fs.writeFile(a.initFile(hash, initId), bytes); await fs.writeFile(a.segFile(hash, file), bytes);
  const server = http.createServer((req, res) => { const selected = req.headers.authorization === 'Bearer B-rw' ? b : a; if (!handleStreamRequest(selected, req, res, req.url)) { res.statusCode = 404; res.end(); } });
  await new Promise(r => server.listen(5781, '127.0.0.1', r)); t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  for (const part of ['manifest', `init/${initId}`, `seg/${file}`]) for (const project of ['A', 'B']) { const r = await fetch(`http://127.0.0.1:5781/stream/${hash}/${part}`, { headers: { authorization: `Bearer ${project}-rw` } }); assert.equal(r.status, project === 'A' ? 200 : 404); await r.arrayBuffer(); }
  const producer = new StreamProducer({ root: dir }, { ownership: aOwner, env: {} }); await assert.rejects(producer.adoptionNeeds({ projectId: 'B' }), /project-mismatch/); await assert.rejects(producer.adoptSegmentsNow({ projectId: 'B' }, {}), /project-mismatch/);
  aOwner.deny(); await assert.rejects(a.save({ streamKey: hash }), /access-revoked/); await assert.rejects(producer.adoptionNeeds({ projectId: 'A' }), /access-revoked/);
  await fixture.revoke('A'); const denied = await fetch(`http://127.0.0.1:5781/stream/${hash}/manifest`, { headers: { authorization: 'Bearer A-rw' } }); assert.equal(denied.status, 403); await denied.arrayBuffer();
});
