import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

const withSources = async (fn) => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { await fn(await server.ssrLoadModule("/src/render/cards/audioSources.ts")); }
  finally { await server.close(); }
};

const HASH = "a".repeat(64);
const SR = 48000;

/** /@media/<hash>/pcm 的假服务端:记下每次的查询串,回 count × 2 × 4 字节 */
function stubFetch(log) {
  globalThis.fetch = async (url) => {
    const query = new URL(url, "http://local").searchParams;
    log.push({ url: String(url), start: Number(query.get("start")), count: Number(query.get("count")), sampleRate: Number(query.get("sampleRate")), ch: Number(query.get("ch")) });
    const count = Number(query.get("count"));
    const samples = new Float32Array(count * 2).fill(Number(query.get("start")));
    return new Response(samples.buffer, { status: 200 });
  };
}

/** 一段裁过的素材(mediaOffset = 2 秒)+ 一张接它的音频图卡 */
const project = {
  media: [{ id: "m", kind: "video", name: "clip.mp4", url: `/@media/${HASH}`, hash: HASH }],
  tracks: [{ id: "t", clips: [
    { id: "src", cardId: "", mediaId: "m", mediaOffset: 2, start: 0, end: 4 },
    { id: "gain", cardId: "", nodeId: "n1", start: 0, end: 4, params: { gain: 3 } },
  ] }],
};
const nodes = [
  { id: "n1", adapter: "card", cardId: "gain", kind: "audio", params: { gain: 1 }, inputs: { source: { nodeId: "@clip/src/source", offset: 0.5, rate: 1 } } },
  { id: "n2", adapter: "card", cardId: "mix", kind: "audio", params: {}, inputs: { source: { nodeId: "n1" } } },
];

test("媒体输入:clip.mediaOffset + 边.offset 只在页面折算一次,折进 start", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => undefined, sampleRate: SR };
  const out = await blockOf(ctx, { clipId: "src", offset: 0.5, rate: 1 }, 100, 480);
  assert.equal(out.length, 960, "交错立体声:count × 2");
  assert.equal(log.length, 1);
  // 100 + 0.5×48000 + 2×48000 = 100 + 24000 + 96000
  assert.equal(log[0].start, 120100);
  assert.equal(log[0].count, 480);
  assert.equal(log[0].sampleRate, SR);
  assert.equal(log[0].ch, 2);
  assert.equal(log[0].url.startsWith(`/@media/${HASH}/pcm?`), true, "路由带哈希,没有 offset 参数");
}));

test("媒体输入:负的 start 原样传给服务端(前面补静音由服务端做)", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project: { ...project, tracks: [{ id: "t", clips: [{ id: "src", mediaId: "m", mediaOffset: 0, start: 0, end: 4 }] }] }, getCard: () => undefined, sampleRate: SR };
  await blockOf(ctx, { clipId: "src" }, -240, 480);
  assert.equal(log[0].start, -240);
}));

test("块缓存按 (hash, position, count) 命中,上限 32 块", async () => withSources(async ({ blockOf, clearAudioBlockCache, AUDIO_BLOCK_CACHE_LIMIT }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => undefined, sampleRate: SR };
  await blockOf(ctx, { clipId: "src" }, 0, 480);
  await blockOf(ctx, { clipId: "src" }, 0, 480);
  assert.equal(log.length, 1, "同一个 (hash, position, count) 只取一次");
  await blockOf(ctx, { clipId: "src" }, 480, 480);
  assert.equal(log.length, 2, "换了位置就是另一块");

  assert.equal(AUDIO_BLOCK_CACHE_LIMIT, 32);
  // 再灌 32 块把最早那两块挤出去
  for (let i = 1; i <= AUDIO_BLOCK_CACHE_LIMIT; i++) await blockOf(ctx, { clipId: "src" }, i * 10000, 480);
  const before = log.length;
  await blockOf(ctx, { clipId: "src" }, 0, 480);
  assert.equal(log.length, before + 1, "超过上限的旧块被淘汰,要重新取");
}));

test("边上的播放速率 ≠ 1 第一版报错", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => undefined, sampleRate: SR };
  await assert.rejects(() => blockOf(ctx, { clipId: "src", rate: 2 }, 0, 480), /第一版不支持/);
  await assert.rejects(() => blockOf(ctx, { nodeId: "n1", rate: 0.5 }, 0, 480), /第一版不支持/);
  assert.equal(log.length, 0);
}));

test("图卡输入递归调它的 audio(),实例参数按 H2 的口径(clip.params 覆盖 clip.nodeId 指向的那个节点)", async () => withSources(async ({ blockOf, evaluateCardAudio, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const seen = [];
  const cards = {
    gain: { id: "gain", defaults: { gain: 1 }, audio: async (sources, range, params) => {
      seen.push({ card: "gain", params: { ...params }, start: range.start });
      const input = await sources.source.block(range.start, range.count);
      return input.map((v) => v * Number(params.gain));
    } },
    mix: { id: "mix", defaults: {}, audio: async (sources, range, params) => {
      seen.push({ card: "mix", params: { ...params }, start: range.start });
      return sources.source.block(range.start, range.count);
    } },
  };
  const ctx = { graph: nodes, project, getCard: (id) => cards[id], sampleRate: SR };
  const out = await evaluateCardAudio(ctx, "n2", { start: 0, count: 4, sampleRate: SR });
  assert.equal(out.length, 8);
  assert.deepEqual(seen.map((s) => s.card), ["mix", "gain"], "n2 → n1 → 素材");
  // n1 被片段 "gain" 指着(clip.nodeId === 'n1'),参数以 clip.params 为准:3,不是节点上的 1
  assert.equal(seen.find((s) => s.card === "gain").params.gain, 3);
  // 素材那一跳:0 + 0.5×48000 + 2×48000
  assert.equal(log[0].start, 120000);
  assert.equal(out[0], 120000 * 3);

  // 直接从 n1 起跳也一样(blockOf 对图卡节点就是递归求值)
  const direct = await blockOf(ctx, { nodeId: "n1" }, 4, 4);
  assert.equal(direct.length, 8);
}));

test("图卡 audio() 回的采样数不是 count 的整数倍就报错", async () => withSources(async ({ evaluateCardAudio, clearAudioBlockCache }) => {
  stubFetch([]); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => ({ id: "gain", defaults: {}, audio: (_s, range) => new Float32Array(range.count * 2 - 1) }), sampleRate: SR };
  await assert.rejects(() => evaluateCardAudio(ctx, "n1", { start: 0, count: 4, sampleRate: SR }), /not a whole number of channels/);
}));

test("没有内容哈希的老素材给一句能照做的报错", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  stubFetch([]); clearAudioBlockCache();
  const legacy = { media: [{ id: "m", kind: "video", name: "old.mp4", url: "/@media/old.mp4" }], tracks: project.tracks };
  const ctx = { graph: nodes, project: legacy, getCard: () => undefined, sampleRate: SR };
  await assert.rejects(() => blockOf(ctx, { clipId: "src" }, 0, 480), /重新导入/);
}));
