/**
 * 在线页面层表里剪辑段流的输入签名(`docs/reports/AGENT-cutseg-layer-sig.md`)。跑:npm test -- server/test/cutseg-layer-sig.test.mjs
 *
 * 钉死(服务端写层表那一半;页面那一半在 `src/editor/snapshotFeedCutOnline.test.mjs`):
 *   - LS-1 剪辑段级的流(`planStreams` 的 `solo: 'cut'`)在层表 `streams` 表里那一行带 `streamKind: 'cut'` 和输入签名,
 *          签名与桌面预渲染进程发层时带的(`belowLayerMark`)相同;
 *   - LS-2 被引用剪辑(两层深)改了:页面按新项目算的签名与旧行对不上;渲染节点按新项目重写层表,新行的签名对得上;
 *   - LS-3 没有剪辑段的项目:层表一个字节不变(与改动前 main `3267ce84` 的 `layerMapOf` 输出的 SHA-256 相同,见 `GOLDEN`);
 *          别的单独成流的卡(`solo: 'source' | 'spatial'`)、组流、依赖下层的流都不带 `streamKind`;
 *   - LS-4 形状不对的(多成员、舞台坐标)即使标了 `solo: 'cut'` 也不带 `streamKind`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createEmptyProject } from "../../src/kernel/project.ts";
import { projectCardGraph } from "../../src/kernel/cardGraph.mjs";
import { withCutSegmentOutputs, setCutClipFrameMode } from "../../src/kernel/cutSegments.ts";
import { streamInputSig, streamSigStale } from "../../src/render/streamInputSig.mjs";
import { CardFrameCache } from "../card-cache.mjs";
import { planStreams, belowLayerMark } from "../frame-stream.mjs";
import { layerMapOf, layerStreamsOf } from "../artifact-transfer.mjs";
import { plainLayerMapInput } from "./cutseg-layer-sig-fixture.mjs";

/**
 * 没有剪辑段的项目的层表(`cutseg-layer-sig-fixture.mjs` 的输入,`JSON.stringify` 后)的 SHA-256。
 * 这个值是在主工作区(main `3267ce84`,改动之前的 `server/artifact-transfer.mjs`)上用同一份输入算出来的:
 *   import 主工作区的 `server/artifact-transfer.mjs`,对 `plainLayerMapInput()` 调 `layerMapOf`,取 `JSON.stringify` 结果的 SHA-256(3733 字节)。
 * 本改动之后同一份输入算出的值必须还是它。
 */
const GOLDEN = "5840986d807a20df3ee0d77c5e9e2bb1615ecd2965f66861a2ac8fa478a9c21c";

const track = (id, clips, extra = {}) => ({ id, name: id, clips, ...extra });
const card = (id, cardId, start, end, extra = {}) => ({ id, cardId, start, end, params: {}, ...extra });
const seg = (id, cutId, start, end, extra = {}) => ({ id, cardId: "", cutId, start, end, params: {}, ...extra });

/** 同 `cut-segment-prerender.test.mjs`:激活剪辑上一个剪辑段 S(第 1～5 秒)引用 B,B 里又有一个剪辑段引用 C(两层嵌套) */
function proj({ inner = { label: "x" } } = {}) {
  const p = createEmptyProject("t");
  return {
    ...p, id: "p1", media: [], width: 1280, height: 720, fps: 30, duration: 10,
    tracks: [track("ta", [seg("S", "B", 1, 5, { cutOffset: 1, frame: { x: 160, y: 90, w: 960, h: 540 } })])],
    cuts: [
      { id: "A", name: "剪辑A" },
      { id: "B", name: "剪辑B", duration: 6, transitions: [], tracks: [track("tb", [card("b1", "r6", 0, 6)]), track("tb2", [seg("bs", "C", 0, 6)])] },
      { id: "C", name: "剪辑C", duration: 6, transitions: [], tracks: [track("tc", [card("c1", "slow", 0, 6, { params: inner })])] },
    ],
    activeCutId: "A",
  };
}
const versions = { r6: "builtin:r6v1", slow: "builtin:slowv1" };
/** 一版项目 → 渲染节点认下的这一版(卡片计划 + 流的计划),同预渲染进程、托管渲染服务 */
function entryOf(p) {
  setCutClipFrameMode((clip) => (clip.cardId === "slow" ? "direct" : "stateful"));
  let graph;
  try { graph = withCutSegmentOutputs(p, projectCardGraph(p, () => undefined), (id) => versions[id]); } finally { setCutClipFrameMode(null); }
  const cardPlan = new CardFrameCache({ root: ".", project: p, envFingerprint: "fp" }).plan({ graph, sourceVersions: versions, environment: {} });
  const entry = { key: `entry-${p.cuts[2].tracks[0].clips[0].params.label}`, project: p, cardPlan };
  const streams = planStreams(entry, { envFingerprint: "fp", below: false });
  return { entry, streams };
}

test("LS-1 剪辑段级的流在层表里那一行带 streamKind: cut 和输入签名,与桌面发的层同一个签名", () => {
  const p = proj();
  const { entry, streams } = entryOf(p);
  const spec = streams.find((s) => s.topClipId === "S");
  assert.equal(spec?.solo, "cut");
  const map = layerMapOf(entry, { fingerprint: "fp", now: 1, streams });
  const row = map.streams.find((r) => r.topClipId === "S");
  assert.ok(row, "层表里有 S 这一行");
  assert.equal(row.streamKind, "cut");
  assert.equal(row.kind, "card");
  assert.equal(row.plane, "local");
  assert.deepEqual(row.clipIds, ["S"]);
  assert.equal(row.inputSig, streamInputSig(p, { clipIds: ["S"] }));
  assert.equal(row.inputSig, belowLayerMark(spec, "S").inputSig, "与桌面预渲染进程发层时带的签名相同");
  // 别的行不带
  for (const r of map.streams.filter((x) => x.topClipId !== "S")) assert.equal("streamKind" in r, false, r.topClipId);
});

test("LS-2 被引用剪辑改了:旧行签名对不上新项目;渲染节点换键重写层表,新行对得上", () => {
  const p0 = proj(), p1 = proj({ inner: { label: "y" } });
  const row0 = layerMapOf(entryOf(p0).entry, { fingerprint: "fp", now: 1, streams: entryOf(p0).streams }).streams.find((r) => r.topClipId === "S");
  const page1 = streamInputSig(p1, { clipIds: ["S"] });
  assert.equal(streamSigStale(row0.inputSig, page1), true, "旧流:签名对不上");
  const { entry, streams } = entryOf(p1);
  const row1 = layerMapOf(entry, { fingerprint: "fp", now: 2, streams }).streams.find((r) => r.topClipId === "S");
  assert.notEqual(row1.contentKey, row0.contentKey, "渲染节点换了键");
  assert.equal(row1.streamKind, "cut");
  assert.equal(streamSigStale(row1.inputSig, page1), false, "新流:签名对得上");
});

test("LS-3 没有剪辑段的项目:层表一个字节不变;别的流不带 streamKind", () => {
  const { entry, options } = plainLayerMapInput();
  const body = layerMapOf(entry, options);
  const text = JSON.stringify(body);
  assert.equal(createHash("sha256").update(text).digest("hex"), GOLDEN, "与改动前 main 的输出逐字节相同");
  assert.ok(body.streams.length >= 4, "card、group、below、solo source 都在");
  for (const r of body.streams) assert.equal("streamKind" in r, false, `${r.kind} ${r.topClipId}`);
});

test("LS-4 形状不对的(多成员、舞台坐标)标了 solo: cut 也不带 streamKind", () => {
  const p = proj();
  const base = { contentKey: "ck", originFrame: 30, firstSegment: 0, lastSegment: 7, envFingerprint: "fp", solo: "cut" };
  const rows = layerStreamsOf({ project: p }, { streams: [
    { ...base, topClipId: "S", clipIds: ["S"], kind: "card", plane: "local" },
    { ...base, topClipId: "S", clipIds: ["S"], kind: "card", plane: "stage" },
    { ...base, topClipId: "S", clipIds: ["b", "S"], kind: "group", plane: "stage" },
  ] });
  assert.deepEqual(rows.map((r) => r.streamKind ?? null), ["cut", null, null]);
});
