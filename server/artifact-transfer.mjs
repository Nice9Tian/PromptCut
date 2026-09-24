/**
 * 预渲染产物的推送与拉取(C6.2,`docs/plan/artifact-transfer-contract.md` 第 3～6 节、第 11 节)。
 *
 * 队列任务的两类产物 —— HTML 快照(共享档、本地档)和轨道流(init + 分段)—— 按内容哈希推到素材服务
 * (快照进 `snap`、流进 `px`),「这一段由哪些块组成」的任务清单放进 `task.complete` 的 `result`,
 * 随 `task.done` 送到订阅方;订阅方按清单拉块,经现有的写入函数落盘,再发布进就绪索引。
 *
 *   推送端:`collectSnapshotResult` / `collectStreamResult` 从本机帧库读出清单,`pushResult` 把块逐个 `put`;
 *           `createAssetSink` 把这两步包成 `render-queue-contract.md` D.1 的产物库(`sink`)。
 *   拉取端:`applyResult` —— 快照经 `SnapshotStore.commitSnapshots` 落盘再 `pipeline.adoptResult` 发布,
 *           流经 `pipeline.streamProducer().adoptSegments` 落盘并发布。**只有这两个写入函数写文件**,
 *           否则 `index.json` / `stream.json` 会和磁盘对不上(`cloud-task.md` A3b)。
 *
 * 素材服务的客户端(`server/asset-store/client.mjs` 的 `createAssetClient`)由调用方传进来,这里不引它:
 * 只用它的 `put(ns, bytes, { ext })` / `get(ns, hash)` 两个方法(契约第 2 节)。
 *
 * 这个模块引 `snapshot-store.mjs`(带依赖),所以放在 `server/` 下,不放 `server/render-node/`(D1 守门)。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rangeHas } from './snapshot-store.mjs';
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
/** 目录名用得的键(共享档的结果键就是目录名):不许带路径分隔符、不许是 `.` / `..` */
const SAFE_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const safeKey = value => typeof value === 'string' && SAFE_KEY_RE.test(value) && value !== '.' && value !== '..';
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

/** 清单 JSON 的字节数;超上限就抛 `code: 'result-too-large'`(不截断,契约第 11 节第 7 条) */
export function assertResultSize(result) {
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > RESULT_MAX_BYTES) throw fail(`任务清单 ${bytes} 字节,超过上限 ${RESULT_MAX_BYTES}`, { code: 'result-too-large', bytes, retryable: false });
  return bytes;
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
 * 快照任务落在本机帧库的哪里:`{ tier, entryKey, dirKey }`,认不出回 null(不猜,契约第 11 节第 3 条)。
 *
 *   - 共享档:`dirKey = resultKey`;
 *   - 本地档(E.9):`dirKey = resultKeyOf(去掉 "<entryKey>/" 前缀的内容键, 任务的锁指纹)`,
 *     `entryKey = input.entryKey`,内容键是 `input.contentKey`,锁指纹是 `requires.envFingerprint`。
 *     缺任何一项(或内容键不以 `<entryKey>/` 开头)就回 null。
 */
export function snapshotLocation(task) {
  const tier = task?.tier;
  if (tier === 'shared') return safeKey(task.resultKey) ? { tier, entryKey: null, dirKey: task.resultKey } : null;
  if (tier !== 'local') return null;
  const entryKey = task.input?.entryKey;
  const contentKey = task.input?.contentKey;
  const fp = task.requires?.envFingerprint;
  if (!safeKey(entryKey) || typeof contentKey !== 'string' || typeof fp !== 'string' || !fp) return null;
  const prefix = `${entryKey}/`;
  if (!contentKey.startsWith(prefix) || contentKey.length === prefix.length) return null;
  return { tier, entryKey, dirKey: resultKeyOf(contentKey.slice(prefix.length), fp) };
}

/** `canvasHeavy`:依次取 `opts.canvasHeavy`、`task.input.canvasHeavy`(是布尔值时),都没有就是 false(第 11 节第 2 条) */
function canvasHeavyOf(task, opts) {
  if (typeof opts?.canvasHeavy === 'boolean') return opts.canvasHeavy;
  if (typeof task?.input?.canvasHeavy === 'boolean') return task.input.canvasHeavy;
  return false;
}

/* ======================================================================== *
 * 推送端
 * ======================================================================== */

/** 按「哈希 → 文件」读块:给 `pushResult` 的 `readBlob` */
const blobReader = files => async hash => {
  const file = files.get(hash);
  if (!file) throw fail(`清单里没有块 ${hash}`);
  return fs.readFile(file);
};

/**
 * 快照任务的清单(契约第 3 节 `SnapshotResult`):读 `index.json` 的 `frames` 与 `oversize`,
 * 再读对应帧文件算哈希。只列这一任务范围里已经落盘的帧(超体积的也在内),按帧升序。
 * 回 `{ result, readBlob }`(第 11 节第 1 条)。
 */
export async function collectSnapshotResult(pipeline, task, opts = {}) {
  if (task?.kind !== undefined && task.kind !== 'snapshot') throw fail(`不是快照任务:${task.kind}`, { retryable: false });
  const loc = snapshotLocation(task);
  if (!loc) throw fail(`认不出快照任务的落盘位置:${task?.resultKey}(本地档要 input.entryKey、input.contentKey、requires.envFingerprint)`, { code: 'unknown-location', retryable: false });
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
    canvasHeavy: canvasHeavyOf(task, opts),
    frames,
  };
  assertResultSize(result);
  return { result, readBlob: blobReader(files) };
}

/** 流库目录的形状同 `frame-stream.mjs` 的 `StreamStore`:`<库根>/streams/<streamKey>/` */
const streamDir = (pipeline, key) => path.join(pipeline.root, 'streams', key);

/** 流库里某条流的清单:直接读盘上的 `stream.json`(生产者每写一个分段存一次) */
async function readStreamManifest(pipeline, key) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(streamDir(pipeline, key), 'stream.json'), 'utf8'));
    return manifest?.streamKey === key ? manifest : null;
  } catch { return null; }
}

/**
 * 轨道流任务的清单(契约第 3 节 `StreamResult`):读 `stream.json`,列这一任务范围里已产出的分段,
 * 以及它们用到的 init;每个块读文件算哈希。分段的 `encoder` 取它所用 init 的 `encoder`(第 11 节第 6 条)。
 * 回 `{ result, readBlob }`。`opts` 目前不用,留着和快照对称。
 */
export async function collectStreamResult(pipeline, task, opts = {}) {
  void opts;
  if (task?.kind !== undefined && task.kind !== 'stream') throw fail(`不是轨道流任务:${task.kind}`, { retryable: false });
  const key = task?.resultKey;
  if (!KEY_RE.test(String(key))) throw fail(`轨道流任务的 resultKey 不对:${key}`, { retryable: false });
  const { from, to } = rangeOf(task);
  const manifest = await readStreamManifest(pipeline, key);
  if (!manifest) throw fail(`本机没有这条流的清单:${key}`, { code: 'no-stream-manifest' });
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
      sig: seg.sig ?? null, encoder: initMeta.encoder ?? null };
  }
  const result = {
    v: RESULT_VERSION, kind: 'stream', resultKey: key, range: { from, to },
    header: { kind: manifest.kind, plane: manifest.plane, clipIds: manifest.clipIds, fps: manifest.fps, bound: manifest.bound,
      offset: manifest.offset ?? null, tight: manifest.tight ?? null },
    inits, segments,
  };
  assertResultSize(result);
  return { result, readBlob: blobReader(files) };
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
 */
export async function pushResult(client, result, readBlob) {
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

/** 本机帧库是否覆盖了这一段(快照:`frames ∪ oversize` 盖住每一帧;流:每个分段和它的 init 都在清单里) */
async function coversRange(pipeline, ref) {
  const { from, to } = rangeOf(ref);
  if (ref.kind === 'snapshot') {
    const loc = snapshotLocation(ref);
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
 * D.1 的产物库(`sink`),素材服务实现(契约第 4 节、第 11 节第 3、7 条)。
 *
 *   - `has(ref)`:本机帧库覆盖了整个 `range` 就回 true。只看本机,不查素材服务(跨节点去重在 C6.4)。
 *   - `put({ ...ref, artifacts, meta })`:`artifacts` 本阶段忽略,字节以本机帧库为准。`collect*` 再
 *     `pushResult`,全部推完回 `{ complete: true, result }`;清单缺帧、有块推失败、清单超过 256 KiB,
 *     都回 `{ complete: false }`。`result` 是对 D.1 的扩展,什么时候放进 `session.complete` 由 M5b 定。
 *
 * `ref` 带着任务的 `input` 与 `requires`(M5b 的 local-node 原样传入)。本地档靠它们按 E.9 算落盘键;
 * 缺了就 `has` 回 false、`put` 回 `{ complete: false }`,不猜。`canvasHeavy` 取 `ref.input.canvasHeavy`。
 */
export function createAssetSink({ pipeline, client }) {
  if (!pipeline) throw new Error('createAssetSink needs a pipeline');
  if (!client) throw new Error('createAssetSink needs an asset client');
  return {
    async has(ref) {
      try { return await coversRange(pipeline, ref); } catch { return false; }
    },
    async put(ref) {
      try {
        let collected;
        if (ref?.kind === 'snapshot') collected = await collectSnapshotResult(pipeline, ref);
        else if (ref?.kind === 'stream') collected = await collectStreamResult(pipeline, ref);
        else return { complete: false };
        if (!resultComplete(collected.result)) return { complete: false };
        await pushResult(client, collected.result, collected.readBlob);
        return { complete: true, result: collected.result };
      } catch {
        return { complete: false };
      }
    },
  };
}

/* ======================================================================== *
 * 拉取端
 * ======================================================================== */

function checkSnapshotResult(result) {
  const bad = why => { throw fail(`快照清单不对:${why}`, { retryable: false }); };
  if (result.tier !== 'shared' && result.tier !== 'local') bad(`tier = ${result.tier}`);
  if (!safeKey(result.dirKey)) bad('dirKey');
  if (result.tier === 'local' && !safeKey(result.entryKey)) bad('本地档缺 entryKey');
  const { from, to } = result.range ?? {};
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) bad('range');
  if (!Array.isArray(result.frames)) bad('frames');
  for (const item of result.frames) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || item[0] < from || item[0] > to || !KEY_RE.test(String(item[1]))) bad(`帧 ${JSON.stringify(item)}`);
  }
}

/**
 * 按任务清单把一段产物拉进本机帧库并发布(契约第 5 节)。回 `{ written, skipped, fetched }`(第 11 节第 8 条):
 * 实际落盘的帧数 / 分段数、本机已有而跳过的、从素材服务下载的块数(init 也算)。
 *
 *   快照:本机 `index.json` 里已有的帧(`frames` 或 `oversize`)不下载;其余按哈希从 `snap` 拉,
 *         经 `commitSnapshots` 分批落盘(超体积由它自己判),最后 `pipeline.adoptResult` 发布。
 *         某块拉不到(404)或拉坏了:已经拉到的照常落盘、发布,然后整体抛错(不留半截文件)。
 *   流:   先问生产者缺哪些(`adoptionNeeds`),只从 `px` 拉这些块,交给 `adoptSegments` 落盘并发布;
 *         拉不到的块对应的分段不收,其余照收,然后整体抛错。管线上没有生产者(`streamProducer()` 回 null,
 *         即 `interactive: false` 或已关闭)就抛 `code: 'no-stream-producer'`。
 */
export async function applyResult(pipeline, client, result) {
  if (!result || typeof result !== 'object' || result.v !== RESULT_VERSION) throw fail('不认识的任务清单', { retryable: false });
  if (result.kind === 'snapshot') return applySnapshotResult(pipeline, client, result);
  if (result.kind === 'stream') return applyStreamResult(pipeline, client, result);
  throw fail(`不认识的清单 kind:${result.kind}`, { retryable: false });
}

async function fetchBlock(client, ns, hash) {
  const buf = await client.get(ns, hash);
  if (buf === null || buf === undefined) throw fail(`块 ${ns}/${hash} 不在素材服务上`, { code: 'blob-missing', status: 404 });
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (sha256(bytes) !== hash) throw fail(`块 ${ns}/${hash} 的内容和哈希对不上`, { code: 'blob-corrupt' });
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
      if (!Buffer.from(html, 'utf8').equals(item.value)) { failure ||= fail(`快照块 ${batch[k][1]} 不是合法的 UTF-8`, { code: 'blob-corrupt' }); return; }
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
  const producer = typeof pipeline?.streamProducer === 'function' ? pipeline.streamProducer() : null;
  if (!producer) throw fail('这个预渲染实例没有轨道流生产者(interactive: false 或已关闭),收不了流清单', { code: 'no-stream-producer', retryable: false });
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
