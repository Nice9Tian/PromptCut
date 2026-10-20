/**
 * 剪辑段参与测量与预渲染(`mechanism/rendering.md`「剪辑段」)的单测。跑:npm test -- src/kernel/cutSegmentPrerender.test.mjs
 *
 * 钉死:
 *   - `withCutSegmentOutputs`:没有剪辑段时原样返回同一个图;有剪辑段时末尾补节点与输出(能力表、预卷、内容身份、里面各卡的源码版本);
 *     隐藏序列、悬空引用不补;
 *   - 内容身份(`cutSegmentContent`)与成本键:改两层深的被引用剪辑、改里面那张卡的源码版本,键都变;激活剪辑里别的改动不变;
 *   - 流的划分:剪辑段是 `solo: 'cut'` 的单卡流,挂载帧含预卷、要回放;
 *   - 输入签名:剪辑段的片段签名随被引用剪辑变;不是剪辑段的片段签名不变;
 *   - 卡片计划(服务端 `CardFrameCache.plan`)里剪辑段的控件不走整帧 PNG 那一支。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyProject } from "./project.ts";
import { projectCardGraph } from "./cardGraph.mjs";
import { withCutSegmentOutputs, setCutClipFrameMode, isCutSegmentNode, CUT_SEGMENT_CARD } from "./cutSegments.ts";
import { cutSegmentContent, cutSegmentHasVisualMedia } from "./cutIdentity.mjs";
import { clipCostIndex } from "../render/pipelinePlan.mjs";
import { clipInputSig } from "../render/layerInputSig.mjs";
import { soloStreamKind } from "../render/streamPlanRules.mjs";
import { CardFrameCache } from "../../server/card-cache.mjs";
import { planStreams } from "../../server/frame-stream.mjs";

const track = (id, clips, extra = {}) => ({ id, name: id, clips, ...extra });
const card = (id, cardId, start, end, extra = {}) => ({ id, cardId, start, end, params: {}, ...extra });
const seg = (id, cutId, start, end, extra = {}) => ({ id, cardId: "", cutId, start, end, params: {}, ...extra });

function proj({ a, inner = { label: "x" }, media = [] } = {}) {
  const p = createEmptyProject("t");
  return {
    ...p,
    media,
    width: 1280, height: 720, fps: 30, duration: 10,
    tracks: a ?? [track("ta", [seg("S", "B", 1, 5, { cutOffset: 1, frame: { x: 160, y: 90, w: 960, h: 540 } })])],
    cuts: [
      { id: "A", name: "剪辑A" },
      { id: "B", name: "剪辑B", duration: 6, transitions: [], tracks: [track("tb", [card("b1", "r6", 0, 6)]), track("tb2", [seg("bs", "C", 0, 6)])] },
      { id: "C", name: "剪辑C", duration: 6, transitions: [], tracks: [track("tc", [card("c1", "slow", 0, 6, { params: inner })])] },
    ],
    activeCutId: "A",
  };
}
const modes = (clip) => (clip.cardId === "slow" ? "direct" : "stateful");
const versions = { r6: "builtin:r6v1", slow: "builtin:slowv1" };
function planGraph(p, versionOf = (id) => versions[id]) {
  setCutClipFrameMode(modes);
  try {
    return withCutSegmentOutputs(p, projectCardGraph(p, () => undefined), versionOf);
  } finally {
    setCutClipFrameMode(null);
  }
}

test("没有剪辑段:图原样返回同一个对象", () => {
  const p = { ...proj(), tracks: [track("ta", [card("k", "r6", 0, 2)])] };
  const g = projectCardGraph(p, () => undefined);
  assert.equal(withCutSegmentOutputs(p, g), g);
});

test("有剪辑段:末尾补一个节点和一个输出,能力表带推帧口径与预卷", () => {
  const p = proj();
  const base = projectCardGraph(p, () => undefined);
  const g = planGraph(p);
  assert.equal(g.nodes.length, base.nodes.length + 1);
  assert.equal(g.outputs.length, base.outputs.length + 1);
  const node = g.nodes.at(-1), out = g.outputs.at(-1);
  assert.equal(node.id, "@clip/S/cut");
  assert.equal(node.cardId, CUT_SEGMENT_CARD);
  assert.equal(node.clipId, "S");
  assert.ok(isCutSegmentNode(node));
  assert.deepEqual(node.capabilities, { frameMode: "stateful", compositing: "independent", need_prerendering: false, cutSegment: true, cutPreroll: 1 });
  assert.deepEqual(node.cut.cardIds, ["r6", "slow"]);
  assert.deepEqual(node.cut.versions, { r6: "builtin:r6v1", slow: "builtin:slowv1" });
  assert.deepEqual(node.cut.contents.map((c) => c.id), ["B", "C"], "两层嵌套都在");
  assert.equal(out.nodeId, node.id);
  assert.equal(out.start, 1);
  assert.equal(out.end, 5);
  assert.deepEqual(out.frame, { x: 160, y: 90, w: 960, h: 540 });
});

test("隐藏序列、悬空引用的剪辑段不补", () => {
  const hidden = proj({ a: [track("ta", [seg("S", "B", 1, 5)], { hidden: true })] });
  assert.equal(planGraph(hidden).nodes.some((n) => n.id === "@clip/S/cut"), false);
  const dangling = proj({ a: [track("ta", [seg("S", "Z", 1, 5)])] });
  assert.equal(planGraph(dangling).nodes.some((n) => n.id === "@clip/S/cut"), false);
});

test("成本键:改两层深的被引用剪辑、改里面那张卡的源码,键都变;激活剪辑里别的改动不变", () => {
  const keyOf = (p, versionOf) => {
    const g = planGraph(p, versionOf);
    return clipCostIndex(p, g, () => null).identityKeys.S;
  };
  const base = keyOf(proj());
  assert.equal(typeof base, "string");
  assert.notEqual(keyOf(proj({ inner: { label: "y" } })), base, "里面那张卡的参数");
  assert.notEqual(keyOf(proj(), (id) => (id === "slow" ? "builtin:slowv2" : versions[id])), base, "里面那张卡的源码版本");
  const other = proj();
  other.tracks = [...other.tracks, track("tz", [card("z", "r6", 7, 9)])];
  assert.equal(keyOf(other), base, "激活剪辑里加别的片段");
  setCutClipFrameMode(modes);
  try {
    assert.equal(clipCostIndex(proj(), planGraph(proj()), () => null).frameModes.S, "stateful");
  } finally {
    setCutClipFrameMode(null);
  }
});

test("内容身份:素材只取 id、种类、哈希;有画面素材时 hasVisualMedia", () => {
  const media = [{ id: "v", kind: "video", name: "v", url: "/v.mp4", hash: "h1", duration: 5 }, { id: "a", kind: "audio", name: "a", url: "/a.wav", duration: 5 }];
  const p = proj({ media });
  p.cuts[2].tracks = [...p.cuts[2].tracks, track("tv", [{ id: "mv", cardId: "", mediaId: "v", start: 0, end: 2, params: {} }])];
  const clip = p.tracks[0].clips[0];
  const content = cutSegmentContent(p, clip);
  assert.deepEqual(content.media, [{ id: "v", kind: "video", hash: "h1" }]);
  assert.equal(cutSegmentHasVisualMedia(p, clip), true);
  assert.equal(cutSegmentHasVisualMedia(proj({ media }), proj({ media }).tracks[0].clips[0]), false);
});

test("输入签名:剪辑段的签名随被引用剪辑变;不是剪辑段的片段不受影响", () => {
  const a = proj(), b = proj({ inner: { label: "y" } });
  assert.notEqual(clipInputSig(a, "S"), clipInputSig(b, "S"));
  const withCard = (p) => ({ ...p, tracks: [...p.tracks, track("tk", [card("k", "r6", 0, 1)])] });
  assert.equal(clipInputSig(withCard(a), "k"), clipInputSig(withCard(b), "k"));
});

test("流的划分:剪辑段是 solo cut 的单卡流,挂载帧含预卷、要回放;服务端控件不走整帧 PNG", () => {
  const p = proj();
  const g = planGraph(p);
  const cache = new CardFrameCache({ root: ".", project: p, envFingerprint: "fp" });
  const plan = cache.plan({ graph: g, sourceVersions: versions, environment: {} });
  const control = plan.find((c) => c.clipId === "S");
  assert.ok(control);
  assert.equal(control.cacheable, false);
  assert.equal(control.frameMode, "stateful");
  assert.equal(typeof control.costKey, "string");
  assert.equal(soloStreamKind(control, p.tracks[0].clips[0], p.tracks[0], p), "cut");
  const specs = planStreams({ project: p, cardPlan: plan }, { envFingerprint: "fp", below: false });
  const spec = specs.find((s) => s.topClipId === "S");
  assert.ok(spec);
  assert.equal(spec.solo, "cut");
  assert.equal(spec.kind, "card");
  assert.equal(spec.plane, "local");
  assert.equal(spec.originFrame, 30);
  assert.equal(spec.lastFrame, 149);
  assert.equal(spec.mountFrame, 0, "预卷 1 秒:从第 0 帧起推");
  assert.equal(spec.replay, true);
  assert.equal(spec.hasMedia, false);
});
