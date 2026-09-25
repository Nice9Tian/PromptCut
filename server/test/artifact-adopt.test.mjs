/**
 * 换机取用（契约 `docs/plan/manifest-contract.md` 第 5 节，第 6 节用例 A1～A2）。
 * 跑：node --experimental-test-module-mocks --test server/test/artifact-adopt.test.mjs
 *
 * 只照契约写，不看实现。
 *
 * 约定：
 *   - 两个临时帧库 A、B，各一个真的 `FramePipeline`（同一个环境指纹：契约 W3「两台机器指纹相同，所以键完全一致」）；
 *     `bakery/index.mjs` 换成假的，它的函数被调一次就记一笔 —— 「B 没有调任何渲染」就是计数为 0。
 *   - 素材服务（memory，端口 0）、文档服务（内容库，memory，端口 0），同 `artifact-dedup.test.mjs`。
 *   - card plan 按 `card-cache.mjs` 的 control 形状手工造（`clipId`、`snapshotKey`、`contentKey`、`envFingerprint`、`tier`、
 *     `capabilities`、`count`、`sampling`）；A 的「预渲染」直接经 `commitSnapshots` 写帧库。
 *   - A 的「推送完」：按 `split.mjs` 的 `splitPlan` 切出细任务（与队列完全一致的 resultKey 与 range），每个任务
 *     `collect*` → `pushResult` → `content.put(<kind>, '<resultKey>:<from>-<to>', result)`。这样本文件只依赖 C6.2 的推送函数
 *     与内容库客户端，不依赖推送队列。
 *   - B：同一份 card plan（entry 深拷贝）挂进 `B.entries`，一个页面会话订阅这一版；调 `B.adoptFromManifests(entry, content, client)`。
 *   - 流（A1 第二条）：B 是 `interactive: true`，读口接上、编码器名定下（不探测）。A 的流按 `frame-stream.mjs` 的格式手工造，
 *     键用 `planStreams(entry, { envFingerprint, codeVersion: '<STREAM_CODE_VERSION>:' })` 算（管线缺省 `captureCode()` 为空）。
 *
 * 实现还不存在时每条用例各自失败、报原因。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createAssetHarness } from './fake-asset-service.mjs';

const bakeryCalls = [];
const refuse = (name) => (...args) => { bakeryCalls.push(name); void args; throw new Error(`单测不渲染（${name}）`); };
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async (...a) => refuse('openBakery')(...a),
    findFfmpeg: async (...a) => refuse('findFfmpeg')(...a),
    streamPngVideo: refuse('streamPngVideo'),
    bakeFrames: async (...a) => refuse('bakeFrames')(...a),
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { snapshotDir } = await import('../snapshot-store.mjs');
const { planStreams, STREAM_CODE_VERSION } = await import('../frame-stream.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { splitPlan, planTaskOf } = await import('../render-node/split.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const E = await import('./fake-manifest-env.mjs');
const {
  sha256, range, htmlOf, unpack, treeOf, filesOf, makeRoots, startServices, producerOf, watchEntry, staged, writeStreamFixture,
  OWN_ENV, SHARED_CAPS, LOCAL_CAPS,
} = F;
const { countingAsset, countingContent } = E;

let transfer = null, transferError = null;
try { transfer = await import('../artifact-transfer.mjs'); } catch (err) { transferError = err; }
let clientMod = null, clientError = null;
try { clientMod = await import('../asset-store/client.mjs'); } catch (err) { clientError = err; }
function T() {
  if (transferError) throw new Error(`载不进 server/artifact-transfer.mjs：${transferError.message}`);
  return transfer;
}
function newClient(base) {
  if (clientError) throw new Error(`载不进 server/asset-store/client.mjs：${clientError.message}`);
  return clientMod.createAssetClient({ base });
}
function adopt(pipeline, entry, content, client) {
  assert.equal(typeof pipeline.adoptFromManifests, 'function', 'FramePipeline 要有 adoptFromManifests(entry, content, client)');
  return pipeline.adoptFromManifests(entry, content, client);
}

const harness = createAssetHarness();
after(() => harness.cleanup());

const FP = OWN_ENV.fingerprint;
const ENTRY_KEY = sha256('entry-adopt');

async function rig(t) {
  const roots = makeRoots(FramePipeline, 'pc-c64-adopt-');
  t.after(() => roots.cleanup());
  const svc = await startServices(harness, newClient);
  t.after(() => svc.cleanup());
  return { roots, svc };
}

/** card plan：一张共享档（130 帧，3 段）、一张本地档（70 帧，2 段） */
function snapshotPlan() {
  const sharedKey = sha256('card-adopt-shared');
  const localKey = sha256('card-adopt-local');
  return [
    { clipId: 'clip-a', key: 'png-a', snapshotKey: resultKeyOf(sharedKey, FP), contentKey: sharedKey, envFingerprint: FP, tier: 'shared',
      capabilities: SHARED_CAPS, compositing: 'independent', count: 130, sampling: { firstFrame: 0 } },
    { clipId: 'clip-l', key: 'png-l', snapshotKey: resultKeyOf(localKey, FP), contentKey: localKey, envFingerprint: FP, tier: 'local',
      capabilities: LOCAL_CAPS, compositing: 'belowDependent', count: 70, sampling: { firstFrame: 0 } },
  ];
}
const entryOf = (cardPlan, project = { fps: 30, width: 1920, height: 1080, duration: 10, tracks: [] }) => ({ key: ENTRY_KEY, project, cardPlan, status: 'ready' });
const cloneEntry = (entry) => ({ ...entry, project: structuredClone(entry.project), cardPlan: structuredClone(entry.cardPlan) });
const targetOf = (control) => ({ tier: control.tier, entryKey: control.tier === 'local' ? ENTRY_KEY : null, key: control.snapshotKey });

/** A 的「预渲染」：每张卡把 frames 这些帧写进帧库 */
async function prerender(A, cardPlan, framesOf = (c) => range(0, c.count - 1)) {
  for (const c of cardPlan) {
    const frames = framesOf(c);
    if (!frames.length) continue;
    await A.snapshots().commitSnapshots({ ...targetOf(c), clipId: c.clipId, capabilities: c.capabilities,
      items: frames.map((n) => ({ localFrame: n, html: htmlOf(n, `${c.clipId}`) })) });
  }
}

/** 按 split.mjs 切出这一版的细任务（与队列完全一致） */
function tasksOf(entry, streams = []) {
  return splitPlan({ planTask: planTaskOf({ projectId: 'p-adopt', projectRev: 1 }), entryKey: entry.key, cardPlan: entry.cardPlan, streams,
    envFingerprint: FP, codeVersion: 'c' });
}

/** A 推送一个细任务并写清单；回清单 */
async function pushTask(A, svc, task) {
  const out = unpack(task.kind === 'stream' ? await T().collectStreamResult(A, task) : await T().collectSnapshotResult(A, task));
  await T().pushResult(svc.client, out.raw, out.readBlob);
  const kind = task.kind === 'stream' ? 'render-manifest' : 'snapshot-manifest';
  await svc.content.put(kind, `${task.resultKey}:${task.range.from}-${task.range.to}`, out.result);
  return out.result;
}

/* ------------------------------------------------------------------ A1 */

test('A1 A 预渲染并推送完；B 用同一份 card plan 调 adoptFromManifests：帧库与 A 逐字节相同，就绪索引发布了对应的层，B 没有调任何渲染', async (t) => {
  const { roots, svc } = await rig(t);
  const rootA = await roots.root(), rootB = await roots.root();
  const A = roots.make(rootA), B = roots.make(rootB);
  const plan = snapshotPlan();
  const entryA = entryOf(plan);
  await prerender(A, plan);
  const tasks = tasksOf(entryA);
  assert.deepEqual(tasks.map((x) => `${x.tier}:${x.range.from}-${x.range.to}`), ['shared:0-59', 'shared:60-119', 'shared:120-129', 'local:0-59', 'local:60-69'], '夹具：5 段');
  assert.equal(tasks[0].resultKey, plan[0].snapshotKey, '共享档 resultKey = snapshotKey');
  assert.equal(tasks[3].resultKey, resultKeyOf(`${ENTRY_KEY}/${plan[1].contentKey}`, FP), '本地档 resultKey 按 E.9');
  let blocks = 0;
  for (const task of tasks) blocks += (await pushTask(A, svc, task)).frames.length;
  assert.equal(blocks, 200);

  const entryB = cloneEntry(entryA);
  const watch = watchEntry(B, entryB);
  const before = bakeryCalls.length;
  const asset = countingAsset(svc.client);
  const contentB = countingContent(await svc.another('node-b'));
  const out = await adopt(B, entryB, contentB, asset);
  assert.deepEqual({ manifests: out?.manifests, fetched: out?.fetched, written: out?.written }, { manifests: 5, fetched: 200, written: 200 },
    `返回 { manifests, fetched, written }：${JSON.stringify(out)}`);
  const keysAsked = contentB.gets().map((g) => `${g.kind}|${g.key}`).sort();
  const want = tasks.map((x) => `snapshot-manifest|${x.resultKey}:${x.range.from}-${x.range.to}`).sort();
  for (const k of want) assert.ok(keysAsked.includes(k), `按本机算出的键查了清单：${k}`);
  assert.equal(asset.puts.length, 0, '取用不上传');

  for (const c of plan) {
    const dirA = snapshotDir(rootA, targetOf(c)), dirB = snapshotDir(rootB, targetOf(c));
    const fa = await filesOf(dirA), fb = await filesOf(dirB);
    assert.deepEqual(Object.keys(fb).sort(), Object.keys(fa).sort(), `${c.clipId}：同一批文件`);
    for (const name of Object.keys(fa)) {
      if (name === 'index.json') assert.deepEqual(JSON.parse(fb[name]), JSON.parse(fa[name]), `${c.clipId} index.json 一致`);
      else assert.ok(fb[name].equals(fa[name]), `${c.clipId} ${name} 逐字节相同`);
    }
  }
  // 整棵帧库只多了这两个快照目录（没有别的产物、没有半截文件）
  const treeB = Object.keys(await treeOf(rootB)).filter((p) => !p.startsWith('controls-lock/'));
  assert.ok(treeB.every((p) => p.startsWith('controls-html/') || p.startsWith('controls-local/')), `B 只写了快照库：${treeB.filter((p) => !p.startsWith('controls-')).join(', ')}`);

  const sharedHit = staged(B, 'html', plan[0].snapshotKey);
  assert.deepEqual(sharedHit?.ranges, [[0, 129]], `共享档的键挂进了就绪索引：${JSON.stringify(B.ready.stagedKeys())}`);
  const localHit = staged(B, 'local', `${ENTRY_KEY}/${plan[1].snapshotKey}`);
  assert.deepEqual(localHit?.ranges, [[0, 69]], '本地档的键（<entryKey>/<dirKey>）挂进了就绪索引');
  const layerOf = (clipId) => watch.layers().filter((m) => m.clipId === clipId).at(-1);
  assert.deepEqual(layerOf('clip-a') && { kind: layerOf('clip-a').kind, key: layerOf('clip-a').key, ranges: layerOf('clip-a').ranges },
    { kind: 'html', key: plan[0].snapshotKey, ranges: [[0, 129]] }, '会话收到共享档的 layer');
  assert.deepEqual(layerOf('clip-l') && { kind: layerOf('clip-l').kind, key: layerOf('clip-l').key, ranges: layerOf('clip-l').ranges },
    { kind: 'local', key: `${ENTRY_KEY}/${plan[1].snapshotKey}`, ranges: [[0, 69]] }, '会话收到本地档的 layer');
  assert.equal(bakeryCalls.length, before, 'B 没有调任何渲染');

  // 再调一次：本机都有了，全部跳过
  const again = await adopt(B, entryB, await svc.another('node-b2'), countingAsset(svc.client));
  assert.equal(again.fetched, 0, '本机已有的段不再拉');
  assert.equal(again.written, 0);
});

test('A1 流：A 推送完一条轨道流；B 调 adoptFromManifests 拉全它的分段、发布 stream 范围，不渲染', async (t) => {
  const { roots, svc } = await rig(t);
  const rootA = await roots.root(), rootB = await roots.root();
  const A = roots.make(rootA, { interactive: true });
  const B = roots.make(rootB, { interactive: true });
  // 一张能进流的卡：independent、在一条可见序列上、有 cardId；45 帧 → 分段 0..2
  const contentKey = sha256('card-adopt-stream');
  const control = { clipId: 'clip-s', key: 'png-s', snapshotKey: resultKeyOf(contentKey, FP), contentKey, envFingerprint: FP, tier: 'shared',
    capabilities: SHARED_CAPS, compositing: 'independent', count: 45, sampling: { firstFrame: 0 } };
  const project = { fps: 30, width: 1920, height: 1080, duration: 2, media: [],
    tracks: [{ id: 't1', clips: [{ id: 'clip-s', cardId: 'demo-card', start: 0, end: 1.5 }] }] };
  const entryA = entryOf([control], project);
  const specs = planStreams(entryA, { envFingerprint: FP, codeVersion: `${STREAM_CODE_VERSION}:` });
  assert.equal(specs.length, 1, `夹具：一条流 ${JSON.stringify(specs.map((s) => [s.streamKey?.slice(0, 8), s.firstSegment, s.lastSegment]))}`);
  const spec = specs[0];
  const streamTasks = tasksOf(entryA, specs).filter((x) => x.kind === 'stream');
  assert.equal(streamTasks.length, 1);
  assert.equal(streamTasks[0].resultKey, spec.streamKey, '流任务的 resultKey = streamKey');
  const segs = range(spec.firstSegment, spec.lastSegment);
  const fx = await writeStreamFixture(rootA, { streamKey: spec.streamKey, segments: segs });
  producerOf(A);
  const result = await pushTask(A, svc, streamTasks[0]);
  assert.deepEqual(Object.keys(result.segments).map(Number).sort((a, b) => a - b), segs);

  const entryB = cloneEntry(entryA);
  const prodB = producerOf(B);
  watchEntry(B, entryB);
  const before = bakeryCalls.length;
  const out = await adopt(B, entryB, await svc.another('node-b'), svc.client);
  assert.ok(out.manifests >= 1, `查到了流的清单：${JSON.stringify(out)}`);
  const dirB = path.join(rootB, 'streams', spec.streamKey);
  const fb = await filesOf(dirB);
  for (const [name, buf] of Object.entries(fx.files)) assert.ok(fb[name]?.equals(buf), `B 有 ${name}，与 A 相同`);
  const state = prodB.streams.get(spec.streamKey);
  assert.ok(state?.manifest, '清单合进了 B 的生产者状态');
  for (const n of segs) {
    assert.equal(state.manifest.segments[n]?.adopted, true, `第 ${n} 段记 adopted`);
    assert.notEqual(prodB.segmentState(state, n), 'stale', `第 ${n} 段在 B 上不判 stale`);
  }
  assert.deepEqual(staged(B, 'stream', spec.streamKey)?.ranges, [[spec.firstSegment, spec.lastSegment]], `就绪索引挂上了 stream：${JSON.stringify(B.ready.stagedKeys())}`);
  assert.equal(bakeryCalls.length, before, 'B 没有调任何渲染');
});

/* ------------------------------------------------------------------ A2 */

test('A2 部分段在内容库里没有、部分段本机已有：只拉内容库里有且本机缺的，返回的计数正确', async (t) => {
  const { roots, svc } = await rig(t);
  const rootA = await roots.root(), rootB = await roots.root();
  const A = roots.make(rootA), B = roots.make(rootB);
  const plan = snapshotPlan();
  const entryA = entryOf(plan);
  await prerender(A, plan);
  const tasks = tasksOf(entryA);
  const byName = Object.fromEntries(tasks.map((x) => [`${x.tier}:${x.range.from}-${x.range.to}`, x]));
  // 内容库里有：共享档 0-59、120-129，本地档 60-69；没有：共享档 60-119、本地档 0-59
  const pushed = {};
  for (const name of ['shared:0-59', 'shared:120-129', 'local:60-69']) pushed[name] = await pushTask(A, svc, byName[name]);
  // B 本机已经有共享档 0-59（与 A 相同的内容）
  await B.snapshots().commitSnapshots({ ...targetOf(plan[0]), clipId: 'clip-a', capabilities: SHARED_CAPS,
    items: range(0, 59).map((n) => ({ localFrame: n, html: htmlOf(n, 'clip-a') })) });

  const entryB = cloneEntry(entryA);
  watchEntry(B, entryB);
  const asset = countingAsset(svc.client);
  const before = bakeryCalls.length;
  const out = await adopt(B, entryB, await svc.another('node-b'), asset);
  assert.equal(out.fetched, 20, `只下载共享档 120-129 与本地档 60-69 的 20 个块：${JSON.stringify(out)}`);
  assert.equal(out.written, 20, `落盘 20 帧：${JSON.stringify(out)}`);
  // manifests：用上的清单数。本机已有的共享档 0-59 要么根本不查、要么查到但什么都不拉 —— 契约没说它算不算，两种都认
  assert.ok(out.manifests === 2 || out.manifests === 3, `manifests 是用上的清单数（2；把本机已有、查到而没拉的也算上是 3）：${out.manifests}`);
  const wantHashes = new Set([...pushed['shared:120-129'].frames, ...pushed['local:60-69'].frames].map(([, h]) => h));
  assert.equal(asset.gets.length, 20, `get 了 20 次：${asset.gets.length}`);
  assert.ok(asset.gets.every((g) => wantHashes.has(g.hash)), '下载的都是缺的那两段的块');

  const idxShared = await B.snapshots().snapshotIndex(targetOf(plan[0]));
  assert.deepEqual(idxShared.frames, [[0, 59], [120, 129]], '共享档：本机的 0-59 加上拉来的 120-129；60-119 留给本机预渲染');
  const idxLocal = await B.snapshots().snapshotIndex(targetOf(plan[1]));
  assert.deepEqual(idxLocal.frames, [[60, 69]], '本地档：只有拉来的 60-69');
  const fa = await filesOf(snapshotDir(rootA, targetOf(plan[0]))), fb = await filesOf(snapshotDir(rootB, targetOf(plan[0])));
  for (const n of range(120, 129)) assert.ok(fb[`${n}.html`]?.equals(fa[`${n}.html`]), `第 ${n} 帧与 A 相同`);
  assert.equal(fb['60.html'], undefined, '内容库里没有的段不拉');
  assert.equal(bakeryCalls.length, before, 'adoptFromManifests 本身不渲染');
});
