/**
 * 在线页面的快照来源(`snapshotSource.ts` 的 `OnlineSnapshotSource`;`docs/plan/c10a-contract.md` 第 8、9 节):
 * 按层表与清单拉预渲染小尺寸,只拉小尺寸、只拉播放头前后 2 秒、内存 LRU 64 MiB。
 * 跑:node --test src/render/onlineSnapshotSource.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OnlineSnapshotSource, ByteLru, parseLayerMap, segmentsInWindow, framesToRanges, smallSnapshotHtml,
  ONLINE_CACHE_MAX_BYTES, PREFETCH_SEC, LAYER_MAP_PREFIX, applyReadyMessage, layerOf,
} from './snapshotSource.ts';
import { pickLayerSnapshot } from './snapshotPick.mjs';

const H = (n) => n.toString(16).padStart(64, '0');

/** 一台假内容库 + 假素材服务 */
function world({ fps = 30 } = {}) {
  const content = new Map();
  const requests = [];
  const fetches = [];
  const bytes = new Map();
  const deps = {
    async request(msg) {
      requests.push(msg);
      if (msg.type !== 'content.get') throw new Error('只认 content.get');
      if (!content.has(msg.key)) return { type: 'content.item', kind: msg.kind, key: msg.key, missing: true };
      return { type: 'content.item', kind: msg.kind, key: msg.key, body: structuredClone(content.get(msg.key)), hash: 'x' };
    },
    assetBase: () => 'https://h.example/media/api/asset/',
    authHeaders: async () => ({ Authorization: 'Bearer RT' }),
    async fetch(url, init) {
      fetches.push({ url, auth: init?.headers?.Authorization });
      const hash = url.split('/').pop();
      if (!bytes.has(hash)) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
      const b = bytes.get(hash);
      return { ok: true, status: 200, headers: { get: () => 'image/webp' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const layerMap = (layers) => content.set(`${LAYER_MAP_PREFIX}p1`, { v: 1, kind: 'layer-map', projectId: 'p1', fps, span: 60, at: 1, layers });
  /** 一段清单:frames 覆盖 [from,to],small 列给出的帧 */
  const manifest = (resultKey, from, to, smallFrames, salt = 0) => {
    const frames = [];
    for (let f = from; f <= to; f++) frames.push([f, H(1000 + f), 10]);
    const small = smallFrames.map((f) => [f, H(5000 + f + salt), 20]);
    for (const [, h] of small) bytes.set(h, new Uint8Array([82, 73, 70, 70, salt & 255, 0, 0, 0]));
    content.set(`${resultKey}:${from}-${to}`, { v: 1, kind: 'snapshot', resultKey, range: { from, to }, frames, small });
  };
  return { deps, content, requests, fetches, layerMap, manifest, bytes };
}

test('OS1 纯函数:层表解析、窗口里的段、帧号并区间、小位图包成铺满平面的 img', () => {
  const map = parseLayerMap({ kind: 'layer-map', projectId: 'p', fps: 30, span: 60, layers: [
    { clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 30, count: 150 },
    { clipId: 'b', kind: 'stream', key: 'S', resultKey: 'R2', firstFrame: 0, count: 10 },
    { clipId: 'c', kind: 'html', key: 'K', resultKey: 'R', firstFrame: -1, count: 5 },
  ] });
  assert.deepEqual(map.layers.map((l) => l.clipId), ['a'], '流与坏项不收');
  assert.equal(parseLayerMap({ kind: 'snapshot' }), null);
  const layer = map.layers[0];
  // 全局帧 60～120 → 本地 30～90 → 段 [0,59] 与 [60,119]
  assert.deepEqual(segmentsInWindow(layer, 60, 60, 120), [[0, 59], [60, 119]]);
  assert.deepEqual(segmentsInWindow(layer, 60, 0, 10), [], '还没到这一层');
  assert.deepEqual(segmentsInWindow(layer, 60, 170, 400), [[120, 149]], '最后一段到 count - 1');
  assert.deepEqual(framesToRanges([5, 1, 2, 3, 9, 9, 10]), [[1, 3], [5, 5], [9, 10]]);
  const html = smallSnapshotHtml('data:image/webp;base64,AAAA');
  assert.match(html, /^<img [^>]*src="data:image\/webp;base64,AAAA"/);
  assert.match(html, /width:100%;height:100%/);
  assert.equal(ONLINE_CACHE_MAX_BYTES, 64 * 1024 * 1024);
  assert.equal(PREFETCH_SEC, 2);
});

test('OS2 就绪:按层表只取播放头前后 2 秒那几段的清单,就绪区间 = 有小位图的帧,照 C3 的全量 layer 发', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 600 }]);
  w.manifest('R', 0, 59, [0, 1, 2, 3, 10]);
  w.manifest('R', 60, 119, [60, 61]);
  w.manifest('R', 300, 359, [300]);
  const src = new OnlineSnapshotSource(w.deps);
  const index = new Map();
  const seen = [];
  src.subscribeReady('s', 0, (m) => { seen.push(m); applyReadyMessage(index, m); });
  src.setProject('p1');
  src.focus(1, 30);
  await src.tickNow();
  const keys = w.requests.filter((r) => r.key !== `${LAYER_MAP_PREFIX}p1`).map((r) => r.key).sort();
  assert.deepEqual(keys, ['R:0-59', 'R:60-119'], '只取窗口里的段(播放头 1 秒 → 全局帧 0～90)');
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K', ranges: [[0, 3], [10, 10], [60, 61]] });
  // 选帧:本地帧 5 回溯到 3(同区间内),和本地模式同一条路
  const pick = pickLayerSnapshot({ layer: layerOf(index, 'a', 'html'), globalFrame: 5, firstFrame: 0, count: 600, anchors: [] });
  assert.equal(pick.localFrame, 3);
  assert.equal(seen[0].type, 'reset');
});

test('OS3 取字节:只拉 px/<hash>(小尺寸),带只读票据;缓存命中不再请求;没有这一帧的小尺寸就抛', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 60 }]);
  w.manifest('R', 0, 59, [0, 1]);
  const src = new OnlineSnapshotSource(w.deps);
  src.subscribeReady('s', 0, () => {});
  src.setProject('p1');
  src.focus(0, 30);
  await src.tickNow();
  // 预取已经把窗口里的两张取了
  await new Promise((r) => setTimeout(r, 5));
  const n = w.fetches.length;
  assert.equal(n, 2);
  assert.ok(w.fetches.every((f) => /^https:\/\/h\.example\/media\/api\/asset\/px\/[0-9a-f]{64}$/.test(f.url)), '只拉 px 下的小位图');
  assert.ok(w.fetches.every((f) => f.auth === 'Bearer RT'));
  const html = await src.fetchSnapshot('html', 'K', 1);
  assert.match(html, /data:image\/webp;base64,/);
  assert.equal(w.fetches.length, n, '缓存命中');
  await assert.rejects(src.fetchSnapshot('html', 'K', 5), /没有这一帧的预渲染小尺寸/);
  assert.ok(src.cacheBytes > 0);
  src.clearCache();
  assert.equal(src.cacheBytes, 0, '导出前释放小尺寸缓存');
});

test('OS4 换键(渲染节点重渲之后):层表换了,旧键的帧不再算就绪;卡不在层表里了就发空层撤掉', async () => {
  const w = world();
  w.layerMap([
    { clipId: 'a', kind: 'html', key: 'K1', resultKey: 'R1', firstFrame: 0, count: 60 },
    { clipId: 'b', kind: 'html', key: 'KB', resultKey: 'RB', firstFrame: 0, count: 60 },
  ]);
  w.manifest('R1', 0, 59, [0, 1, 2]);
  w.manifest('RB', 0, 59, [0]);
  let now = 0;
  const src = new OnlineSnapshotSource({ ...w.deps, now: () => now });
  const index = new Map();
  src.subscribeReady('s', 0, (m) => applyReadyMessage(index, m));
  src.setProject('p1');
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html').ranges, [[0, 2]]);
  // 改了卡 a:渲染节点换了键,新键的清单还没有
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K2', resultKey: 'R2', firstFrame: 0, count: 60 }]);
  now += 10_000;
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K2', ranges: [] }, '新键还没料:区间空(页面显示占位)');
  assert.deepEqual(layerOf(index, 'b', 'html').ranges, [], 'b 不在层表里了:空层撤掉');
  // 新的小尺寸回来了
  w.manifest('R2', 0, 59, [0, 1]);
  now += 10_000;
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K2', ranges: [[0, 1]] });
});

test('OS5 清单还没满的段过一会儿再取;满了就不再取', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 4 }]);
  w.manifest('R', 0, 3, [0]);
  let now = 0;
  const src = new OnlineSnapshotSource({ ...w.deps, now: () => now });
  const index = new Map();
  src.subscribeReady('s', 0, (m) => applyReadyMessage(index, m));
  src.setProject('p1');
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html').ranges, [[0, 0]]);
  w.manifest('R', 0, 3, [0, 1, 2, 3]);
  now += 500;
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html').ranges, [[0, 0]], '不到 2 秒不重取');
  now += 2500;
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html').ranges, [[0, 3]]);
  const count = w.requests.filter((r) => r.key === 'R:0-3').length;
  now += 5000;
  await src.tickNow();
  assert.equal(w.requests.filter((r) => r.key === 'R:0-3').length, count, '满了不再取');
});

test('OS6 LRU 按字节,上限之内;最久没用的先走', () => {
  const lru = new ByteLru(10);
  lru.set('a', '1234');
  lru.set('b', '1234');
  lru.get('a');
  lru.set('c', '1234');
  assert.equal(lru.has('b'), false, 'b 最久没用');
  assert.equal(lru.has('a'), true);
  assert.ok(lru.total <= 10);
  lru.set('huge', 'x'.repeat(50));
  assert.equal(lru.size, 1, '单张超上限也留着最新那一张');
});

test('OS7 没连上文档服务 / 没有素材服务:不抛,只记错,下一轮再来', async () => {
  const w = world();
  const src = new OnlineSnapshotSource({ ...w.deps, request: async () => { throw new Error('没连上文档服务'); }, assetBase: () => null });
  src.subscribeReady('s', 0, () => {});
  src.setProject('p1');
  await src.tickNow();
  assert.ok(src.stats.errors >= 1);
  assert.equal(w.fetches.length, 0);
});

test('OS8 一次层表请求永久悬挂后仍能拉到新键', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K2', resultKey: 'R2', firstFrame: 0, count: 2 }]);
  w.manifest('R2', 0, 1, [0, 1]);
  let calls = 0;
  const src = new OnlineSnapshotSource({ ...w.deps, request: (msg) => {
    if (msg.key === 'layers:p1' && ++calls === 1) return new Promise(() => {});
    return w.deps.request(msg);
  }, requestTimeoutMs: 20 });
  const index = new Map();
  src.subscribeReady('s', 0, (m) => applyReadyMessage(index, m));
  src.setProject('p1');
  await Promise.race([src.tickNow(), new Promise((_, reject) => setTimeout(() => reject(new Error('轮询被悬挂请求卡住')), 100))]);
  assert.equal(calls, 1);
  await src.tickNow();
  assert.equal(layerOf(index, 'a', 'html')?.key, 'K2');
  src.stop();
});

test('OS9 一张小位图请求永久悬挂后释放队列并重取', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 1 }]);
  w.manifest('R', 0, 0, [0]);
  let calls = 0;
  const src = new OnlineSnapshotSource({ ...w.deps, assetTimeoutMs: 20, fetch: (...args) => {
    if (++calls === 1) return new Promise(() => {});
    return w.deps.fetch(...args);
  } });
  src.setProject('p1');
  await src.tickNow();
  await new Promise((r) => setTimeout(r, 30));
  assert.match(await src.fetchSnapshot('html', 'K', 0), /data:image\/webp;base64,/);
  assert.equal(calls, 2);
  src.stop();
});

test('OS10 清单缺几帧小尺寸(阿里云 2026-09-27:295/300,缺第 0 帧与 28～31):有的帧照常就绪、照常取;缺的那一帧同区间回溯,段首缺才占位', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 300 }]);
  const all = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  w.manifest('R', 0, 59, all(0, 59).filter((f) => f !== 0 && (f < 28 || f > 31)));
  w.manifest('R', 60, 119, all(60, 119));
  const src = new OnlineSnapshotSource(w.deps);
  const index = new Map();
  src.subscribeReady('s', 0, (m) => applyReadyMessage(index, m));
  src.setProject('p1');
  src.focus(0, 30);
  await src.tickNow();
  const layer = layerOf(index, 'a', 'html');
  assert.deepEqual(layer.ranges, [[1, 27], [32, 119]], '不满的那一段不整段丢:有小尺寸的帧都算就绪');
  assert.equal(src.debug().layers[0].ready, 115, '同阿里云手机上的 ready 115');
  const pick = (g) => pickLayerSnapshot({ layer, globalFrame: g, firstFrame: 0, count: 300, anchors: [0, 300] })?.localFrame ?? null;
  assert.equal(pick(0), null, '段首那一帧缺:没有更早的可回溯,这一层按兜底顺序显示占位');
  assert.equal(pick(5), 5, '有的帧照常贴');
  assert.equal(pick(30), 27, '缺的那一帧回溯到同区间里最近的一帧');
  assert.equal(pick(90), 90);
  assert.match(await src.fetchSnapshot('html', 'K', 5), /data:image\/webp;base64,/);
  await assert.rejects(src.fetchSnapshot('html', 'K', 0), /没有这一帧的预渲染小尺寸/);
  // 渲染节点补上那几张之后(清单换成满的),下一轮就绪区间补齐,段首也贴得上
  w.manifest('R', 0, 59, all(0, 59));
  src.stop();
  const later = new OnlineSnapshotSource({ ...w.deps });
  const index2 = new Map();
  later.subscribeReady('s', 0, (m) => applyReadyMessage(index2, m));
  later.setProject('p1');
  later.focus(0, 30);
  await later.tickNow();
  assert.deepEqual(layerOf(index2, 'a', 'html').ranges, [[0, 119]]);
});
