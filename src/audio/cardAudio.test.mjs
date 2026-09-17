import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

const withAudio = async (fn) => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { await fn(await server.ssrLoadModule("/src/audio/cardAudio.ts")); }
  finally { await server.close(); }
};

/** 一份最小的音频图卡项目:一个 adapter:'card' / kind:'audio' 的节点,没有输入 */
const audioProject = (nodeId = "generated") => ({
  media: [], tracks: [],
  cardNodes: [{ id: nodeId, adapter: "card", cardId: "beep", kind: "audio", inputs: {}, params: {} }],
});

const fakeBuffer = (channels, length, sampleRate, value) => {
  const data = Array.from({ length: channels }, () => new Float32Array(length).fill(value));
  return { numberOfChannels: channels, length, sampleRate, getChannelData: (c) => data[c] };
};
const fakeCtx = () => ({ createBuffer: (channels, frames, sampleRate) => fakeBuffer(channels, frames, sampleRate, 0) });

test("card audio splits a long local range, asks exact sample blocks in page, and joins exact frames", async () => withAudio(async ({ CARD_AUDIO_MAX_BLOCK_FRAMES, configureCardAudio, decodeCardAudioClip }) => {
  const requests = [];
  configureCardAudio({
    sourceVersionOf: () => "v1",
    // 定义直接 mock 掉:块不再走 HTTP,`audio()` 就是求值本身
    getCard: (id) => id !== "beep" ? undefined : {
      id, defaults: {},
      audio: (_sources, range) => {
        requests.push({ start: range.start, count: range.count, sampleRate: range.sampleRate });
        return new Float32Array(range.count * 2).fill(range.start === 0 ? 0 : 1);
      },
    },
  });
  const project = audioProject();
  const output = await decodeCardAudioClip(fakeCtx(), { project, nodeId: "generated", frames: CARD_AUDIO_MAX_BLOCK_FRAMES + 13 });
  assert.deepEqual(requests.map(({ start, count }) => ({ start, count })), [{ start: 0, count: CARD_AUDIO_MAX_BLOCK_FRAMES }, { start: CARD_AUDIO_MAX_BLOCK_FRAMES, count: 13 }]);
  assert.equal(requests.every((r) => r.sampleRate === 48000), true);
  assert.equal(output.length, CARD_AUDIO_MAX_BLOCK_FRAMES + 13);
  assert.equal(output.getChannelData(0)[0], 0);
  assert.equal(output.getChannelData(1)[CARD_AUDIO_MAX_BLOCK_FRAMES], 1);

  // 拼完的块整条删掉(一块立体声 8 MB,不删就在 project 存活期内常驻):再要一次得重新求值
  await decodeCardAudioClip(fakeCtx(), { project, nodeId: "generated", frames: 13 });
  assert.equal(requests.length, 3, "blocks are dropped after concatenation, so the next clip re-evaluates");
}));

test("card audio rejects a block that is not a whole number of channels and a throwing audio() does not poison the cache", async () => withAudio(async ({ configureCardAudio, requestCardAudio }) => {
  const project = audioProject("n");
  let mode = "short", calls = 0;
  configureCardAudio({
    sourceVersionOf: () => "v1",
    getCard: (id) => id !== "beep" ? undefined : {
      id, defaults: {},
      audio: (_sources, range) => {
        calls++;
        // 回包没有 url,只校验 samples.length % count === 0
        if (mode === "short") return new Float32Array(range.count * 2 - 1);
        if (mode === "throw") throw new Error("card blew up");
        return new Float32Array(range.count * 2).fill(0.5);
      },
    },
  });
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 0, count: 10, sampleRate: 48000 }), /not a whole number of channels|invalid card audio descriptor/);

  // 取消:求值前就抛 AbortError,`audio()` 一次都不该跑
  const controller = new AbortController(); controller.abort();
  const before = calls;
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 }, controller.signal), /aborted/);
  assert.equal(calls, before, "an already-aborted request never evaluates the card");

  // audio() 抛错 → pending.catch 把键删掉,下一次照样能算出来(缓存没被毒化)
  mode = "throw";
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 }), /card blew up/);
  mode = "ok";
  const good = await requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 });
  assert.equal(good.frames, 10);
  assert.equal(good.channels, 2);
  assert.equal(good.samples.length, 20);
  assert.equal(good.samples[0], 0.5);
  assert.equal(good.url, undefined, "块留在内存里,只有预览的租约才编一份 blob: WAV");

  // 同一个键第二次直接命中缓存,不再求值
  const after = calls;
  await requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 });
  assert.equal(calls, after);
}));

test("card audio cache key follows the card source version", async () => withAudio(async ({ configureCardAudio, requestCardAudio }) => {
  let version = "v1", calls = 0;
  configureCardAudio({
    sourceVersionOf: () => version,
    getCard: (id) => ({ id, defaults: {}, audio: (_s, range) => { calls++; return new Float32Array(range.count * 2); } }),
  });
  const project = audioProject("n");
  await requestCardAudio({ project, nodeId: "n", start: 0, count: 4, sampleRate: 48000 });
  await requestCardAudio({ project, nodeId: "n", start: 0, count: 4, sampleRate: 48000 });
  assert.equal(calls, 1);
  version = "v2";
  await requestCardAudio({ project, nodeId: "n", start: 0, count: 4, sampleRate: 48000 });
  assert.equal(calls, 2, "改了图卡源码之后 project 对象不变,旧采样块不能一直用");
}));

test("card audio refuses to evaluate before the registry injects its hooks", async () => withAudio(async ({ requestCardAudio, getCardAudioEpoch, configureCardAudio, subscribeCardAudioEpoch }) => {
  await assert.rejects(() => requestCardAudio({ project: audioProject("n"), nodeId: "n", start: 0, count: 4, sampleRate: 48000 }), /card audio hooks not configured/);
  const seen = [];
  const stop = subscribeCardAudioEpoch(() => seen.push(getCardAudioEpoch()));
  const before = getCardAudioEpoch();
  configureCardAudio({ getCard: () => undefined, sourceVersionOf: () => "v" });
  assert.equal(getCardAudioEpoch(), before + 1, "每调一次 configureCardAudio 版本号 +1");
  assert.deepEqual(seen, [before + 1]);
  stop();
  configureCardAudio({ getCard: () => undefined, sourceVersionOf: () => "v" });
  assert.equal(seen.length, 1, "退订之后不再收到通知");
}));

test("preview selects generated-only and video-backed audio once and mutes their native video track", async () => withAudio(async ({ generatedCardAudioClipsAt, shouldMuteNativeAudio, isCardAudioNode }) => {
    const project = {
      media: [{ id: "v", kind: "video", url: "/@media/v.mp4" }, { id: "a", kind: "audio", url: "/@media/a.wav" }],
      cardNodes: [
        { id: "video-node", adapter: "card", cardId: "beep", kind: "audio" },
        { id: "bare-node", adapter: "card", cardId: "beep", kind: "audio" },
        { id: "visual-node", adapter: "card", cardId: "blur", kind: "filter" },
      ],
      tracks: [{ id: "t", clips: [
        { id: "video-backed", cardId: "", nodeId: "video-node", mediaId: "v", start: 0, end: 4 },
        { id: "generated-only", cardId: "", nodeId: "bare-node", start: 0, end: 4 },
        { id: "ordinary", cardId: "", mediaId: "a", start: 0, end: 4 },
        { id: "visual", cardId: "blur", nodeId: "visual-node", mediaId: "v", start: 0, end: 4 },
      ] }],
    };
    const generated = generatedCardAudioClipsAt(project, 1);
    assert.deepEqual(generated.map(x => x.clip.id), ["video-backed", "generated-only"]);
    assert.equal(generated.find(x => x.clip.id === "generated-only").media, undefined);
    assert.equal(shouldMuteNativeAudio(project, project.tracks[0].clips[0]), true);
    assert.equal(shouldMuteNativeAudio(project, project.tracks[0].clips[2]), false);
    // 只看节点:kind 不是 audio 的图卡节点不算音频卡(Node 侧的 mux-audio.mjs 用同一条判据)
    assert.equal(isCardAudioNode(project, "visual-node"), false);
    assert.equal(isCardAudioNode(project, "bare-node"), true);
}));
