/**
 * 预渲染产物的推送与拉取(C6.2,`docs/plan/artifact-transfer-contract.md` 第 3～6 节)。
 *
 * 队列任务的两类产物 —— HTML 快照(共享档、本地档)和轨道流(init + 分段)—— 按内容哈希推到素材服务
 * (快照进 `snap`、流进 `px`),「这一段由哪些块组成」的任务清单放进 `task.complete` 的 `result`,
 * 随 `task.done` 送到订阅方;订阅方按清单拉块,经现有的写入函数落盘,再发布进就绪索引。
 *
 *   推送端:`collectSnapshotResult` / `collectStreamResult` 从本机帧库读出清单,`pushResult` 把块逐个 `put`;
 *           `createAssetSink` 把这两步包成 `render-queue-contract.md` D.1 的产物库(`sink`)。
 *   拉取端:`applyResult` —— 快照经 `SnapshotStore.commitSnapshots` 落盘再 `pipeline.adoptResult` 发布,
 *           流经 `pipeline.streams().adoptSegments` 落盘并发布。**只有这两个写入函数写文件**,
 *           否则 `index.json` / `stream.json` 会和磁盘对不上(`cloud-task.md` A3b)。
 *
 * 素材服务的客户端(`server/asset-store/client.mjs` 的 `createAssetClient`)由调用方传进来,这里不引它:
 * 只用它的 `put(ns, bytes, { ext })` / `get(ns, hash)` / `has(ns, hash)` 三个方法(契约第 2 节)。
 *
 * 这个模块引 `snapshot-store.mjs`(带依赖),所以放在 `server/` 下,不放 `server/render-node/`(D1 守门)。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rangeHas, DOM_SNAPSHOT_LIMIT, CANVAS_SNAPSHOT_LIMIT, snapshotTier } from './snapshot-store.mjs';
import { resultKeyOf } from './render-node/fingerprint.mjs';

/** 清单的版本(契约第 3 节的 `v`) */
export const RESULT_VERSION = 1;
/** 清单 JSON 的体积上限:超了报错,不截断(契约第 3 节) */
export const RESULT_MAX_BYTES = 256 * 1024;
/** 素材服务的命名空间(契约第 1 节) */
export const SNAP_NS = 'snap';
export const PX_NS = 'px';
/** 并发推 / 拉的块数 */
const TRANSFER_CONCURRENCY = 4;
/** 拉快照时每攒这么多帧 `commitSnapshots` 一次(每批写一次 index.json) */
const APPLY_BATCH = 8;

const KEY_RE = /^[a-f0-9]{64}$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');

const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

/** 限并发地跑一组异步任务,回 `Promise.allSettled` 的形状(保持顺序) */
async function settleLimited(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = { status: 'fulfilled', value: await work(items[i], i) }; }
      catch (reason) { out[i] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/** 清单 JSON 的字节数;超上限就抛(不截断) */
export function assertResultSize(result) {
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > RESULT_MAX_BYTES) throw fail(`任务清单 ${bytes} 字节,超过上限 ${RESULT_MAX_BYTES}`, { code: 'RESULT_TOO_LARGE', bytes, retryable: false });
  return bytes;
}

/**
 * 把 `readBlob` 挂在清单上,**不可枚举**:`JSON.stringify` 和 `deepStrictEqual` 都看不见它,清单本身仍是
 * 契约第 3 节的纯数据。调用方既可以 `pushResult(client, result)`(缺省就用它),也可以
 * `const { readBlob } = result` / `const { result, readBlob } = await collect…()` 拿出来。
 */
function withReader(result, readBlob) {
  Object.defineProperty(result, 'readBlob', { value: readBlob, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(result, 'result', { value: result, enumerable: false, configurable: true, writable: true });
  return result;
}

const rangeOf = task => {
  const from = task?.range?.from, to = task?.range?.to;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw fail(`任务的 range 不对:${JSON.stringify(task?.range ?? null)}`, { retryable: false });
  return { from, to };
};

/* ======================================================================== *
 * 快照:任务 → 落盘位置(E.9)
 * ======================================================================== */

/**
 * 快照任务落在本机帧库的哪里:`{ tier, entryKey, dirKey }`,认不出回 null。
 *
 *   - 共享档:`dirKey = resultKey`;
 *   - 本地档(E.9):`dirKey = resultKeyOf(去掉 "<entryKey>/" 前缀的内容键, 任务的锁指纹)`,
 *     内容键是 `input.contentKey`,锁指纹是 `requires.envFingerprint`;还要满足
 *     `resultKey = resultKeyOf(input.contentKey, 锁指纹)`,对不上就当认不出。
 *   - 本地档而任务里没有 `input`(D.1 的 `sink.has` / `put` 只给 `{ resultKey, kind, tier, range }`):
 *     在本机的 entry 里按 card plan 反查 —— 某个本地档 control 按上式算出的结果键等于 `resultKey`。
 */
export function snapshotLocation(pipeline, task) {
  const tier = task?.tier;
  const resultKey = task?.resultKey;
  if (!KEY_RE.test(String(resultKey))) return null;
  if (tier === 'shared') return { tier, entryKey: null, dirKey: resultKey };
  if (tier !== 'local') return null;
  const entryKey = task.input?.entryKey;
  const contentKey = task.input?.contentKey;
  const fp = task.requires?.envFingerprint;
  if (typeof entryKey === 'string' && entryKey && typeof contentKey === 'string' && typeof fp === 'string' && fp) {
    const prefix = `${entryKey}/`;
    if (!contentKey.startsWith(prefix) || resultKeyOf(contentKey, fp) !== resultKey) return null;
    return { tier, entryKey, dirKey: resultKeyOf(contentKey.slice(prefix.length), fp) };
  }
  for (const entry of pipeline?.entries?.values?.() ?? []) {
    for (const control of entry?.cardPlan ?? []) {
      if ((control?.tier || snapshotTier(control?.capabilities)) !== 'local') continue;
      const own = control.contentKey ?? control.snapshotKey;
      const envFp = control.envFingerprint ?? pipeline.envFingerprint;
      if (!own || !envFp) continue;
      if (resultKeyOf(`${entry.key}/${own}`, envFp) === resultKey) return { tier, entryKey: entry.key, dirKey: resultKeyOf(own, envFp) };
    }
  }
  return null;
}

/** 这张卡的 `canvasHeavy`(本机 card plan 里找得到这张卡时用它) */
function controlCanvasHeavy(pipeline, task, loc) {
  for (const entry of pipeline?.entries?.values?.() ?? []) {
    if (loc.tier === 'local' && entry?.key !== loc.entryKey) continue;
    for (const control of entry?.cardPlan ?? []) {
      if (task?.input?.clipId && control?.clipId !== task.input.clipId) continue;
      if (control?.snapshotKey !== loc.dirKey) continue;
      return control?.capabilities?.canvasHeavy === true;
    }
  }
  return null;
}

/**
 * 拉取方 `commitSnapshots` 按 `canvasHeavy` 重新判超限。为了让它对这一批帧的判决和本机一模一样,先按本机
 * `index.json` 反推:合格帧里有超过 DOM 上限的 → 本机用的是 canvas 那一档;超限帧里有不到 canvas 上限的
 * → 本机用的是 DOM 那一档。两样都推不出来时(这一批帧在两档下判决相同)才取 card plan 里的值。
 */
function inferCanvasHeavy(frames, index, fallback) {
  for (const [f, , bytes] of frames) if (rangeHas(index.frames, f) && bytes > DOM_SNAPSHOT_LIMIT) return true;
  for (const [f, , bytes] of frames) if (rangeHas(index.oversize, f) && bytes <= CANVAS_SNAPSHOT_LIMIT) return false;
  return fallback === true;
}

/* ======================================================================== *
 * 推送端
 * ======================================================================== */

/**
 * 快照任务的清单(契约第 3 节 `SnapshotResult`):读 `index.json` 的 `frames` 与 `oversize`,
 * 再读对应帧文件算哈希。只列这一任务范围里已经落盘的帧(超体积的也在内),按帧升序。
 * 清单上挂着不可枚举的 `readBlob(hash) → Promise<Buffer>`(见 `withReader`)。
 */
export async function collectSnapshotResult(pipeline, task) {
  if (task?.kind !== undefined && task.kind !== 'snapshot') throw fail(`不是快照任务:${task.kind}`, { retryable: false });
  const loc = snapshotLocation(pipeline, task);
  if (!loc) throw fail(`认不出快照任务的落盘位置:${task?.resultKey}`, { retryable: false });
  const { from, to } = rangeOf(task);
  const store = pipeline.snapshots();
  const target = { tier: loc.tier, entryKey: loc.entryKey, key: loc.dirKey };
  const index = await store.snapshotIndex(target);
  const dir = store.dir(target);
  const files = new Map();
  const frames = [];
  for (let f = from; f <= to; f++) {
    if (!rangeHas(index.frames, f) && !rangeHas(index.oversize, f)) continue;
    const file = path.join(dir, `${f}.html`);
    let buf;
    try { buf = await fs.readFile(file); } catch { continue; }
    const hash = sha256(buf);
    frames.push([f, hash, buf.length]);
    files.set(hash, file);
  }
  const result = {
    v: RESULT_VERSION, kind: 'snapshot', tier: loc.tier,
    resultKey: task.resultKey, dirKey: loc.dirKey, entryKey: loc.tier === 'local' ? loc.entryKey : null,
    range: { from, to },
    canvasHeavy: inferCanvasHeavy(frames, index, controlCanvasHeavy(pipeline, task, loc)),
    frames,
  };
  assertResultSize(result);
  return withReader(result, async hash => {
    const file = files.get(hash);
    if (!file) throw fail(`清单里没有块 ${hash}`);
    return fs.readFile(file);
  });
}

/** 流库里某条流的清单:直接读盘上的 `stream.json`(生产者每写一个分段存一次) */
async function readStreamManifest(pipeline, key) {
  const dir = streamDir(pipeline, key);
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'stream.json'), 'utf8'));
    return manifest?.streamKey === key ? manifest : null;
  } catch { return null; }
}
/** 流库目录的形状同 `frame-stream.mjs` 的 `StreamStore`:`<库根>/streams/<streamKey>/` */
const streamDir = (pipeline, key) => path.join(pipeline.root, 'streams', key);

/**
 * 轨道流任务的清单(契约第 3 节 `StreamResult`):读 `stream.json`,列这一任务范围里已产出的分段,
 * 以及它们用到的 init;每个块读文件算哈希。清单上挂着不可枚举的 `readBlob`。
 */
export async function collectStreamResult(pipeline, task) {
  if (task?.kind !== undefined && task.kind !== 'stream') throw fail(`不是轨道流任务:${task.kind}`, { retryable: false });
  const key = task?.resultKey;
  if (!KEY_RE.test(String(key))) throw fail(`轨道流任务的 resultKey 不对:${key}`, { retryable: false });
  const { from, to } = rangeOf(task);
  const manifest = await readStreamManifest(pipeline, key);
  if (!manifest) throw fail(`本机没有这条流的清单:${key}`);
  const dir = streamDir(pipeline, key);
  const files = new Map();
  const inits = {};
  const segments = {};
  const readHashed = async file => {
    const buf = await fs.readFile(file);
    const hash = sha256(buf);
    files.set(hash, file);
    return { hash, bytes: buf.length };
  };
  for (let n = from; n <= to; n++) {
    const seg = manifest.segments?.[n];
    if (!seg?.file || !seg.init) continue;
    const initMeta = manifest.inits?.[seg.init];
    if (!initMeta) continue;
    let segBlob;
    try { segBlob = await readHashed(path.join(dir, seg.file)); } catch { continue; }
    if (!inits[seg.init]) {
      let initBlob;
      try { initBlob = await readHashed(path.join(dir, `init-${seg.init}.mp4`)); } catch { continue; }
      inits[seg.init] = { hash: initBlob.hash, bytes: initBlob.bytes, codec: initMeta.codec ?? null, width: initMeta.width ?? null, height: initMeta.height ?? null,
        timescale: initMeta.timescale ?? null, rect: initMeta.rect ?? null, encoder: initMeta.encoder ?? null };
    }
    segments[n] = { hash: segBlob.hash, bytes: segBlob.bytes, init: seg.init, stride: seg.stride, samples: seg.samples,
      sig: seg.sig ?? null, encoder: seg.encoder ?? initMeta.encoder ?? null };
  }
  const result = {
    v: RESULT_VERSION, kind: 'stream', resultKey: key, range: { from, to },
    header: { kind: manifest.kind, plane: manifest.plane, clipIds: manifest.clipIds, fps: manifest.fps, bound: manifest.bound,
      offset: manifest.offset ?? null, tight: manifest.tight ?? null },
    inits, segments,
  };
  assertResultSize(result);
  return withReader(result, async hash => {
    const file = files.get(hash);
    if (!file) throw fail(`清单里没有块 ${hash}`);
    return fs.readFile(file);
  });
}

/** 清单里要推的块:`[{ ns, hash, ext }]`,去重 */
function resultBlocks(result) {
  const out = new Map();
  if (result?.kind === 'snapshot') {
    for (const [, hash] of result.frames ?? []) out.set(hash, { ns: SNAP_NS, hash, ext: 'html' });
  } else if (result?.kind === 'stream') {
    for (const meta of Object.values(result.inits ?? {})) out.set(meta.hash, { ns: PX_NS, hash: meta.hash, ext: 'mp4' });
    for (const seg of Object.values(result.segments ?? {})) out.set(seg.hash, { ns: PX_NS, hash: seg.hash, ext: 'm4s' });
  } else throw fail(`不认识的清单 kind:${result?.kind}`, { retryable: false });
  for (const { hash } of out.values()) if (!KEY_RE.test(String(hash))) throw fail(`清单里的哈希不对:${hash}`, { retryable: false });
  return [...out.values()];
}

/**
 * 把清单里的每个块 `client.put` 一次(快照进 `snap`、流进 `px`;`put` 自己会跳过素材服务上已有的块)。
 * 全部成功才返回 `{ result, uploaded, skipped }`;任何一块失败就抛(第一处错误)。
 * `readBlob` 缺省用 `collect*` 挂在清单上的那个。
 */
export async function pushResult(client, result, readBlob = result?.readBlob) {
  if (!result || result.v !== RESULT_VERSION) throw fail('不认识的任务清单', { retryable: false });
  if (typeof readBlob !== 'function') throw fail('pushResult 需要 readBlob', { retryable: false });
  assertResultSize(result);
  const blocks = resultBlocks(result);
  let uploaded = 0, skipped = 0;
  const settled = await settleLimited(blocks, TRANSFER_CONCURRENCY, async ({ ns, hash, ext }) => {
    const bytes = await readBlob(hash);
    if (!bytes || sha256(bytes) !== hash) throw fail(`块 ${hash} 的内容和清单对不上(本机文件在清单之后被改过)`);
    const put = await client.put(ns, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), { ext });
    if (put?.hash && put.hash !== hash) throw fail(`素材服务回的哈希 ${put.hash} 和清单里的 ${hash} 不同`);
    if (put?.uploaded) uploaded++; else skipped++;
  });
  const failed = settled.find(item => item.status === 'rejected');
  if (failed) throw failed.reason;
  return { result, uploaded, skipped };
}

/** 本机帧库是否覆盖了这一段(快照:`frames ∪ oversize` 盖住每一帧;流:每个分段都在清单里) */
async function coversRange(pipeline, ref) {
  const { from, to } = rangeOf(ref);
  if (ref.kind === 'snapshot') {
    const loc = snapshotLocation(pipeline, ref);
    if (!loc) return false;
    const index = await pipeline.snapshots().snapshotIndex({ tier: loc.tier, entryKey: loc.entryKey, key: loc.dirKey });
    for (let f = from; f <= to; f++) if (!rangeHas(index.frames, f) && !rangeHas(index.oversize, f)) return false;
    return true;
  }
  if (ref.kind === 'stream') {
    if (!KEY_RE.test(String(ref.resultKey))) return false;
    const manifest = await readStreamManifest(pipeline, ref.resultKey);
    if (!manifest) return false;
    for (let n = from; n <= to; n++) {
      const seg = manifest.segments?.[n];
      if (!seg?.file || !manifest.inits?.[seg.init]) return false;
    }
    return true;
  }
  return false;
}

/** 清单是不是把 `range` 里每一帧 / 每个分段都列上了 */
function resultComplete(result) {
  const { from, to } = result.range;
  if (result.kind === 'snapshot') {
    const have = new Set(result.frames.map(([f]) => f));
    for (let f = from; f <= to; f++) if (!have.has(f)) return false;
    return true;
  }
  for (let n = from; n <= to; n++) {
    const seg = result.segments?.[n];
    if (!seg || !result.inits?.[seg.init]) return false;
  }
  return true;
}

/**
 * D.1 的产物库(`sink`),素材服务实现(契约第 4 节)。
 *
 *   - `has(ref)`:本机帧库覆盖了整个 `range` 就回 true。只看本机,不查素材服务(跨节点去重在 C6.4)。
 *   - `put({ ...ref, artifacts, meta })`:`artifacts` 本阶段忽略,字节以本机帧库为准。`collect*` 再
 *     `pushResult`,全部推完回 `{ complete: true, result }`;清单缺帧、有块推失败回 `{ complete: false }`。
 *     清单超过 256 KiB 照样抛(不截断,`retryable: false`)。`result` 是对 D.1 的扩展,什么时候放进
 *     `session.complete` 由 M5b 定。
 *
 * `ref` 里带着任务的 `input` / `requires`(调用方把整个 TaskView 展开进来)时按它们定本地档的位置;
 * 只有 D.1 的四个字段时,本地档在本机 card plan 里反查(`snapshotLocation`)。
 */
export function createAssetSink({ pipeline, client }) {
  if (!pipeline) throw new Error('createAssetSink needs a pipeline');
  if (!client) throw new Error('createAssetSink needs an asset client');
  return {
    async has(ref) {
      try { return await coversRange(pipeline, ref); } catch { return false; }
    },
    async put(ref) {
      let result;
      try {
        if (ref?.kind === 'snapshot') result = await collectSnapshotResult(pipeline, ref);
        else if (ref?.kind === 'stream') result = await collectStreamResult(pipeline, ref);
        else return { complete: false };
      } catch (error) {
        if (error?.code === 'RESULT_TOO_LARGE') throw error;
        return { complete: false };
      }
      if (!resultComplete(result)) return { complete: false };
      try { await pushResult(client, result); } catch (error) {
        if (error?.code === 'RESULT_TOO_LARGE') throw error;
        return { complete: false };
      }
      return { complete: true, result };
    },
  };
}

/* ======================================================================== *
 * 拉取端
 * ======================================================================== */

function checkSnapshotResult(result) {
  const bad = why => { throw fail(`快照清单不对:${why}`, { retryable: false }); };
  if (result.tier !== 'shared' && result.tier !== 'local') bad(`tier = ${result.tier}`);
  if (!KEY_RE.test(String(result.dirKey))) bad('dirKey');
  if (result.tier === 'local' && !(typeof result.entryKey === 'string' && result.entryKey)) bad('本地档缺 entryKey');
  const { from, to } = result.range ?? {};
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) bad('range');
  if (!Array.isArray(result.frames)) bad('frames');
  for (const item of result.frames) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || item[0] < from || item[0] > to || !KEY_RE.test(String(item[1]))) bad(`帧 ${JSON.stringify(item)}`);
  }
}

/**
 * 按任务清单把一段产物拉进本机帧库并发布(契约第 5 节)。回 `{ written, skipped, fetched }`:
 * 落盘了几帧 / 几个分段、跳过几个(本机已有)、从素材服务下载了几个块。
 *
 *   快照:本机 `index.json` 里已有的帧(`frames` 或 `oversize`)不下载;其余按哈希从 `snap` 拉,
 *         经 `commitSnapshots` 分批落盘(超体积由它自己判),最后 `pipeline.adoptResult` 发布。
 *         某块拉不到(404)或拉坏了:已经拉到的照常落盘、发布,然后整体抛错(不留半截文件)。
 *   流:   先问生产者缺哪些(`adoptionNeeds`),只从 `px` 拉这些块,交给 `adoptSegments` 落盘并发布;
 *         拉不到的块对应的分段不收,其余照收,然后整体抛错。
 */
export async function applyResult(pipeline, client, result) {
  if (!result || typeof result !== 'object' || result.v !== RESULT_VERSION) throw fail('不认识的任务清单', { retryable: false });
  if (result.kind === 'snapshot') return applySnapshotResult(pipeline, client, result);
  if (result.kind === 'stream') return applyStreamResult(pipeline, client, result);
  throw fail(`不认识的清单 kind:${result.kind}`, { retryable: false });
}

async function fetchBlock(client, ns, hash) {
  const buf = await client.get(ns, hash);
  if (buf === null || buf === undefined) throw fail(`块 ${ns}/${hash} 不在素材服务上`, { code: 'BLOB_MISSING', status: 404 });
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (sha256(bytes) !== hash) throw fail(`块 ${ns}/${hash} 的内容和哈希对不上`, { code: 'BLOB_CORRUPT' });
  return bytes;
}

async function applySnapshotResult(pipeline, client, result) {
  checkSnapshotResult(result);
  const store = pipeline.snapshots();
  const entryKey = result.tier === 'local' ? result.entryKey : null;
  const target = { tier: result.tier, entryKey, key: result.dirKey };
  const index = await store.snapshotIndex(target);
  const seen = new Set();
  const want = [];
  for (const item of result.frames) {
    if (seen.has(item[0])) continue;
    seen.add(item[0]);
    if (rangeHas(index.frames, item[0]) || rangeHas(index.oversize, item[0])) continue;
    want.push(item);
  }
  const skipped = seen.size - want.length;
  const capabilities = { canvasHeavy: result.canvasHeavy === true };
  let written = 0, fetched = 0, failure = null;
  for (let i = 0; i < want.length && !failure; i += APPLY_BATCH) {
    const batch = want.slice(i, i + APPLY_BATCH);
    const settled = await settleLimited(batch, TRANSFER_CONCURRENCY, ([, hash]) => fetchBlock(client, SNAP_NS, hash));
    const items = [];
    settled.forEach((item, k) => {
      if (item.status === 'rejected') { failure ||= item.reason; return; }
      fetched++;
      const html = item.value.toString('utf8');
      // 快照按 UTF-8 文本落盘(`commitSnapshots` 的口径):解码再编码回不到原字节的块不收
      if (!Buffer.from(html, 'utf8').equals(item.value)) { failure ||= fail(`快照块 ${batch[k][1]} 不是合法的 UTF-8`, { code: 'BLOB_CORRUPT' }); return; }
      items.push({ localFrame: batch[k][0], html });
    });
    if (items.length) {
      await store.commitSnapshots({ ...target, clipId: null, capabilities, items });
      written += items.length;
    }
  }
  await pipeline.adoptResult(result);
  if (failure) throw failure;
  return { written, skipped, fetched };
}

async function applyStreamResult(pipeline, client, result) {
  const producer = pipeline.streams?.();
  if (!producer) throw fail('这个预渲染实例没有轨道流生产者(已关闭)');
  const needs = await producer.adoptionNeeds(result);
  const wanted = new Set(needs.segments);
  const settled = await settleLimited(needs.hashes, TRANSFER_CONCURRENCY, hash => fetchBlock(client, PX_NS, hash));
  const blobs = new Map();
  let fetched = 0, failure = null;
  settled.forEach((item, i) => {
    if (item.status === 'rejected') { failure ||= item.reason; return; }
    fetched++;
    blobs.set(needs.hashes[i], item.value);
  });
  // 只把本机缺、而且字节齐了的分段交给 adoptSegments(它见到缺块会整个不写)
  const segments = {};
  let total = 0;
  for (const [n, seg] of Object.entries(result.segments ?? {})) {
    total++;
    if (!wanted.has(Number(n)) || !blobs.has(seg.hash)) continue;
    const initHash = result.inits?.[seg.init]?.hash;
    if (initHash && needs.hashes.includes(initHash) && !blobs.has(initHash)) continue;
    segments[n] = seg;
  }
  const adopted = Object.keys(segments).length
    ? await producer.adoptSegments({ ...result, segments }, blobs)
    : { written: 0, skipped: 0 };
  if (failure) throw failure;
  return { written: adopted.written, skipped: adopted.skipped + (total - wanted.size), fetched };
}
