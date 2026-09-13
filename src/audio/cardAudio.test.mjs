import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

const withAudio = async (fn) => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { await fn(await server.ssrLoadModule("/src/audio/cardAudio.ts")); }
  finally { await server.close(); }
};

test("card audio splits a long local range, asks exact sample blocks, and joins exact frames", async () => withAudio(async ({ CARD_AUDIO_MAX_BLOCK_FRAMES, decodeCardAudioClip }) => {
  const requests = [];
  const fakeBuffer = (channels, length, sampleRate, value) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length).fill(value));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (c) => data[c] };
  };
  const ctx = {
    decodeAudioData: async (bytes) => fakeBuffer(2, new Uint8Array(bytes)[0] === 0 ? CARD_AUDIO_MAX_BLOCK_FRAMES : 13, 48000, new Uint8Array(bytes)[0]),
    createBuffer: (channels, frames, sampleRate) => fakeBuffer(channels, frames, sampleRate, 0),
  };
  const fetchImpl = async (url, init) => {
    if (url === "/api/card-runtime/audio") {
      const body = JSON.parse(init.body); requests.push(body);
      return new Response(JSON.stringify({ url: `/block-${body.start}`, format: "wav", sampleRate: 48000, frames: body.count, channels: 2 }), { status: 200 });
    }
    return new Response(new Uint8Array([url === "/block-0" ? 0 : 1]));
  };
  const output = await decodeCardAudioClip(ctx, { project: {}, nodeId: "generated", frames: CARD_AUDIO_MAX_BLOCK_FRAMES + 13 }, fetchImpl);
  assert.deepEqual(requests.map(({ start, count }) => ({ start, count })), [{ start: 0, count: CARD_AUDIO_MAX_BLOCK_FRAMES }, { start: CARD_AUDIO_MAX_BLOCK_FRAMES, count: 13 }]);
  assert.equal(output.length, CARD_AUDIO_MAX_BLOCK_FRAMES + 13);
  assert.equal(output.getChannelData(0)[0], 0);
  assert.equal(output.getChannelData(1)[CARD_AUDIO_MAX_BLOCK_FRAMES], 1);
}));

test("card audio rejects a short/foreign descriptor and cancellation does not poison a later request", async () => withAudio(async ({ requestCardAudio }) => {
  const project = {};
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 0, count: 10, sampleRate: 48000 }, undefined, async () => new Response(JSON.stringify({ url: "https://example.invalid/x.wav", format: "wav", sampleRate: 48000, frames: 9, channels: 2 }))), /invalid card audio descriptor/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 }, controller.signal, async (_url, init) => { assert.equal(init.signal.aborted, true); throw new DOMException("aborted", "AbortError"); }), /aborted/);
  let calls = 0;
  const good = await requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 }, undefined, async () => { calls++; return new Response(JSON.stringify({ url: "/ok.wav", format: "wav", sampleRate: 48000, frames: 10, channels: 2 })); });
  assert.equal(calls, 1); assert.equal(good.url, "/ok.wav");
}));

test("preview selects generated-only and video-backed audio once and mutes their native video track", async () => withAudio(async ({ generatedCardAudioClipsAt, shouldMuteNativeAudio }) => {
    const project = {
      media: [{ id: "v", kind: "video", url: "/@media/v.mp4" }, { id: "a", kind: "audio", url: "/@media/a.wav" }],
      cardDefinitions: [{ id: "d", language: "python", kind: "audio", source: "x", entry: "A" }],
      cardNodes: [{ id: "video-node", adapter: "python", definitionId: "d" }, { id: "bare-node", adapter: "python", definitionId: "d" }],
      tracks: [{ id: "t", clips: [
        { id: "video-backed", cardId: "", nodeId: "video-node", mediaId: "v", start: 0, end: 4 },
        { id: "generated-only", cardId: "", nodeId: "bare-node", start: 0, end: 4 },
        { id: "ordinary", cardId: "", mediaId: "a", start: 0, end: 4 },
      ] }],
    };
    const generated = generatedCardAudioClipsAt(project, 1);
    assert.deepEqual(generated.map(x => x.clip.id), ["video-backed", "generated-only"]);
    assert.equal(generated.find(x => x.clip.id === "generated-only").media, undefined);
    assert.equal(shouldMuteNativeAudio(project, project.tracks[0].clips[0]), true);
    assert.equal(shouldMuteNativeAudio(project, project.tracks[0].clips[2]), false);
}));
