import test from "node:test";
import assert from "node:assert/strict";
import { buildAudioPlan, buildFfmpegArgs } from "./mux-audio.mjs";

test("generated-only and video-backed Python audio replace source entries without timing quantization", () => {
  const project = {
    media: [{ id: "audio", kind: "audio", url: "/@media/a.wav" }, { id: "video", kind: "video", url: "/@media/v.mp4" }],
    cardDefinitions: [{ id: "d", language: "python", kind: "audio" }], cardNodes: [{ id: "n1", adapter: "python", definitionId: "d" }, { id: "n2", adapter: "python", definitionId: "d" }],
    tracks: [{ id: "t", clips: [
      { id: "generated-only", cardId: "", nodeId: "n1", start: 0.0001234, end: 1.2345678 },
      { id: "video-backed", cardId: "", nodeId: "n2", mediaId: "video", start: 2.0001234, end: 3.2345678 },
      { id: "ordinary", cardId: "", mediaId: "audio", start: 4, end: 5 },
    ] }],
  };
  const plan = buildAudioPlan(project, ".", () => true, (media) => media && `/disk/${media.id}`);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.filter(x => x.cardAudio).map(x => x.clipId), ["generated-only", "video-backed"]);
  assert.equal(plan.find(x => x.clipId === "generated-only").start, 0.0001234);
  assert.ok(Math.abs(plan.find(x => x.clipId === "generated-only").dur - 1.2344444) < 1e-12);
  assert.equal(plan.find(x => x.clipId === "video-backed").file, undefined, "video source must not double-play beside its generated node");
  assert.equal(plan.find(x => x.clipId === "ordinary").file, "/disk/audio");
  assert.throws(() => buildFfmpegArgs("video.mp4", plan, "out.mp4", 5), /cannot render Python card audio/);
});
