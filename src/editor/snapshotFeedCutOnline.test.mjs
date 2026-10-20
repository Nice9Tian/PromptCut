/**
 * 在线页面贴剪辑段的流(`docs/reports/AGENT-cutseg-layer-sig.md`):真的在线来源(`render/snapshotSource.ts` 的 `OnlineSnapshotSource`,
 * 读层表里 `streamKind: 'cut'` 的那一行,行由服务端真的 `layerStreamsOf` 写)接上真的父页判重(`snapshotFeed.ts` 的 `cutStreamHeavy`)。
 * 跑:npm test -- src/editor/snapshotFeedCutOnline.test.mjs
 *
 * 钉死:
 *   - CO-1 层表那一行带 `streamKind: 'cut'` 与签名 → 就绪消息、就绪索引都带这两项(与桌面预渲染进程发的层同形);签名对得上、
 *          流铺满 → 按重卡办(抑制、发流平面);
 *   - CO-2 被引用剪辑(两层深)改了:父页拿 store 里的新项目当场不贴旧流(在线来源还没收到新项目,也不贴),照旧活渲(不抑制、
 *          不发流平面);在线来源收到新项目后撤掉那一层;渲染节点换键重写层表以后贴新流;
 *   - CO-3 旧节点写的行(没有 `streamKind`、没有签名):照旧贴(向后兼容,行为与改动前相同)。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

globalThis.window = globalThis;
let plan = null;
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { planFeed, cutStreamHeavy, suppressedAt, snapshotFeedDebug, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed } = feed;
const { OnlineSnapshotSource, LAYER_MAP_PREFIX, LAYER_MAP_POLL_MS } = await import(srcUrl("render/snapshotSource.ts"));
const { SEGMENT_FRAMES } = await import(srcUrl("render/streamPlayer.ts"));
const { streamInputSig } = await import(srcUrl("render/streamInputSig.mjs"));
const { layerStreamsOf } = await import("../../server/artifact-transfer.mjs");

let now = 1000;
performance.now = () => now;

const FPS = 30;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const bytesOf = (text) => new TextEncoder().encode(text);
const track = (id, clips, extra = {}) => ({ id, name: id, clips, ...extra });
const card = (id, cardId, start, end, extra = {}) => ({ id, cardId, start, end, params: {}, ...extra });
const seg = (id, cutId, start, end, extra = {}) => ({ id, cardId: "", cutId, start, end, params: {}, ...extra });

/**
 * 激活剪辑上一个剪辑段 S(第 1～3 秒,即第 30～89 帧,这条流的分段 0～3)引用 B,B 里又有一个剪辑段引用 C(两层嵌套)。
 * 段只有 2 秒:在线来源只取播放头附近的分段(往回一段、往前 2 秒),播放头在段头时整段都在窗口里。
 */
function project({ inner = "x" } = {}) {
  return {
    id: "p1", version: 1, name: "p", width: 1280, height: 720, fps: FPS, duration: 10, media: [],
    tracks: [track("ta", [seg("S", "B", 1, 3, { cutOffset: 1, frame: { x: 160, y: 90, w: 960, h: 540 } })]), track("tk", [card("k", "c", 0, 10)])],
    cuts: [
      { id: "A", name: "剪辑A" },
      { id: "B", name: "剪辑B", duration: 6, transitions: [], tracks: [track("tb", [card("b1", "r6", 0, 6)]), track("tb2", [seg("bs", "C", 0, 6)])] },
      { id: "C", name: "剪辑C", duration: 6, transitions: [], tracks: [track("tc", [card("c1", "slow", 0, 6, { params: { label: inner } })])] },
    ],
    activeCutId: "A",
  };
}
const clipS = (p) => p.tracks[0].clips[0];
const heavy = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const T = 1 + 1e-4;   // 播放头在段头
const ORIGIN = 30, LAST_SEG = 3;

/**
 * 渲染节点按这一版项目写的那一行(服务端真的 `layerStreamsOf`;spec 的形状同 `planStreams` 给剪辑段出的那条)。
 * 流的结果键 = 内容键 × 指纹,由 `layerStreamsOf` 算;回 `{ row, rk }`。
 */
function cutRow(p, tag) {
  const rows = layerStreamsOf({ project: p }, { streams: [{ topClipId: "S", clipIds: ["S"], kind: "card", plane: "local", solo: "cut",
    contentKey: `ck-${tag}`, originFrame: ORIGIN, firstSegment: 0, lastSegment: LAST_SEG, envFingerprint: "fp-host" }] });
  assert.equal(rows.length, 1);
  return { row: rows[0], rk: rows[0].candidates[0].resultKey };
}

/** 假内容库 + 假素材服务 */
function world() {
  const w = { content: new Map(), bytes: new Map(), clock: 1_000_000 };
  w.deps = {
    async request(msg) {
      if (!w.content.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
      return { type: "content.item", kind: msg.kind, key: msg.key, body: structuredClone(w.content.get(msg.key)), hash: "x" };
    },
    assetBase: () => "https://h.example/media/api/asset/",
    authHeaders: async () => ({ Authorization: "Bearer T" }),
    async fetch(url) {
      const b = w.bytes.get(url.split("/").pop());
      if (!b) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, headers: { get: () => "video/mp4" }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    now: () => w.clock, setTimer: () => 0, clearTimer: () => {},
  };
  /** 一条剪辑段流的清单(分段 0～3,一份)和它的字节 */
  w.putStream = (rk) => {
    const initBytes = bytesOf(`init ${rk}`), initHash = sha(initBytes), id = initHash.slice(0, 16);
    w.bytes.set(initHash, initBytes);
    const segments = {};
    for (let n = 0; n <= LAST_SEG; n++) {
      const body = bytesOf(`seg ${rk} ${n}`), hash = sha(body);
      w.bytes.set(hash, body);
      segments[n] = { hash, bytes: body.length, init: id, stride: 1, samples: SEGMENT_FRAMES, sig: null, encoder: "libx264" };
    }
    w.content.set(`${rk}:0-${LAST_SEG}`, { v: 1, kind: "stream", resultKey: rk, range: { from: 0, to: LAST_SEG },
      header: { kind: "card", plane: "local", clipIds: ["S"], fps: FPS, bound: { x: -32, y: -32, w: 1024, h: 604 }, offset: { x: 480, y: 270 }, tight: null },
      inits: { [id]: { hash: initHash, bytes: initBytes.length, codec: "avc1.640028", width: 1024, height: 1208, timescale: 15360, rect: { x: -32, y: -32, w: 1024, h: 604 }, encoder: "libx264" } },
      segments });
  };
  w.putMap = (streams) => w.content.set(`${LAYER_MAP_PREFIX}p1`, { v: 3, kind: "layer-map", projectId: "p1", entryKey: "e", fps: FPS, span: 60, at: 1, layers: [], streams });
  w.settle = async (src) => { await src.tickNow(); await src.idle(); await src.tickNow(); await src.idle(); };
  return w;
}

let w, src, messages;
beforeEach(() => {
  resetSnapshotFeed();
  w = world();
  src = new OnlineSnapshotSource(w.deps, { tier: "original" });
  messages = [];
  src.subscribeReady("probe", 0, (m) => messages.push(m));
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  plan = heavy("S");
  now += 10_000;
});
const streamLayerOf = (p) => snapshotFeedDebug({ project: p, t: T, playing: false }).ready.find((r) => r.clipId === "S")?.kinds.find((k) => k.kind === "stream");

test("CO-1 层表那一行带 streamKind: cut 与签名:就绪消息照桌面的形状带上;签名对得上、流铺满 → 按重卡办", async () => {
  const p = project();
  const { row, rk } = cutRow(p, "c1");
  assert.equal(row.streamKind, "cut", "服务端写的行带 streamKind: cut");
  assert.equal(row.inputSig, streamInputSig(p, { clipIds: ["S"] }));
  w.putStream(rk);
  w.putMap([row]);
  src.setProject("p1");
  src.setInputs(p);
  src.focus(T, FPS);
  await w.settle(src);
  const last = messages.filter((m) => m.type === "layer" && m.kind === "stream").at(-1);
  assert.deepEqual(last, { type: "layer", clipId: "S", kind: "stream", key: rk, ranges: [[0, LAST_SEG]], originFrame: ORIGIN, streamKind: "cut", inputSig: row.inputSig },
    "与桌面预渲染进程发的层同形(`belowLayerMark`)");
  assert.equal(cutStreamHeavy(p, clipS(p), T), true);
  assert.equal(streamLayerOf(p)?.streamKind, "cut", "诊断里就绪的层带 streamKind");
  assert.deepEqual(snapshotFeedDebug({ project: p, t: T, playing: false }).staleCut, []);
  for (const playing of [true, false]) {
    const f = planFeed({ project: p, t: T, playing });
    assert.deepEqual(f.heavy, ["S"], `playing=${playing}`);
    assert.deepEqual(f.streamPlanes, [{ clipIds: ["S"], key: rk, ranges: [[0, LAST_SEG]], originFrame: ORIGIN }]);
  }
  assert.deepEqual(suppressedAt({ project: p, t: T, playing: true }), ["S"]);
  src.stop();
});

test("CO-2 被引用剪辑改了:父页当场不贴旧流、照旧活渲;在线来源收到新项目撤层;层表换成新行以后贴新流", async () => {
  const p0 = project(), p1 = project({ inner: "y" });
  const { row: row0, rk: rk0 } = cutRow(p0, "c1"), { row: row1, rk: rk1 } = cutRow(p1, "c2");
  assert.notEqual(streamInputSig(p0, { clipIds: ["S"] }), streamInputSig(p1, { clipIds: ["S"] }), "两层深的改动进了签名");
  w.putStream(rk0);
  w.putMap([row0]);
  src.setProject("p1");
  src.setInputs(p0);
  src.focus(T, FPS);
  await w.settle(src);
  assert.equal(cutStreamHeavy(p0, clipS(p0), T), true);
  // store 里已经是新项目,在线来源还没收到(`setInputs` 没调):就绪索引里还是旧流,父页比签名,当场不贴
  assert.ok(rk0.startsWith(streamLayerOf(p1)?.key), "就绪索引里还是旧流那一层(调试视图的键截短)");
  assert.equal(cutStreamHeavy(p1, clipS(p1), T), false, "旧流签名对不上:不贴");
  assert.deepEqual(snapshotFeedDebug({ project: p1, t: T, playing: false }).staleCut, ["S"], "诊断里认出过期的剪辑段流");
  for (const playing of [true, false]) {
    const head = { project: p1, t: T, playing };
    const f = planFeed(head);
    assert.deepEqual(f.heavy, [], `playing=${playing}:照旧活渲`);
    assert.deepEqual(f.streamPlanes, []);
    assert.deepEqual(suppressedAt(head), [], "不抑制(活渲,不显示占位符)");
  }
  // 在线来源收到新项目:那一层撤掉(就绪区间发空)
  src.setInputs(p1);
  assert.equal(src.streamPlane(rk0), null);
  assert.deepEqual(src.debug().staleStreams, ["S"]);
  assert.equal(cutStreamHeavy(p1, clipS(p1), T), false);
  // 渲染节点按新项目换键重写层表
  w.putStream(rk1);
  w.putMap([row1]);
  w.clock += LAYER_MAP_POLL_MS;
  await w.settle(src);
  assert.ok(rk1.startsWith(streamLayerOf(p1)?.key));
  assert.equal(cutStreamHeavy(p1, clipS(p1), T), true, "新流签名对得上:贴");
  assert.deepEqual(planFeed({ project: p1, t: T, playing: true }).streamPlanes, [{ clipIds: ["S"], key: rk1, ranges: [[0, LAST_SEG]], originFrame: ORIGIN }]);
  src.stop();
});

test("CO-3 旧节点写的行(没有 streamKind、没有签名):照旧贴,与改动前相同", async () => {
  const p = project();
  const { row, rk } = cutRow(p, "c3");
  const { streamKind: _k, inputSig: _s, ...old } = row;
  w.putStream(rk);
  w.putMap([old]);
  src.setProject("p1");
  src.setInputs(p);
  src.focus(T, FPS);
  await w.settle(src);
  const last = messages.filter((m) => m.type === "layer" && m.kind === "stream").at(-1);
  assert.equal("streamKind" in last, false);
  assert.equal("inputSig" in last, false);
  assert.equal(cutStreamHeavy(p, clipS(p), T), true);
  // 改了也照贴(没签名可比;靠渲染节点换键重写层表 —— 这就是本次要补的口子)
  const p1 = project({ inner: "y" });
  assert.equal(cutStreamHeavy(p1, clipS(p1), T), true);
  src.stop();
});
