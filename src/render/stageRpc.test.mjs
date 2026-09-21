/**
 * E1 协议面的单测。跑:node --test src/render/stageRpc.test.mjs
 *
 * 这里只钉**不依赖浏览器**的那几条:七种事件各归哪个角色(父页按 event.source 过滤的判据)、
 * 事件白名单本身、以及舞台 id 与角色脱钩(`detectHostCapabilities` 读的是实例名,不是角色)。
 * RPC 往返、角色闸门、跨源那几条由 scripts/probes/stage-rpc-probe.mjs 在真浏览器里验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { stageEventRole, STAGE_EVENT_TYPES, isStageEvent, isRpcRequest, isRpcReply } = await import("./stageRpc.ts");

test("七种事件各只认一个角色发来的(E0:不过滤就会在互换那一拍重复 tick)", () => {
  // 播放器舞台的事
  assert.equal(stageEventRole("frame"), "front");
  assert.equal(stageEventRole("ended"), "front");
  assert.equal(stageEventRole("settled"), "front");
  assert.equal(stageEventRole("demote"), "front");
  // 后台舞台的事
  assert.equal(stageEventRole("mediaReady"), "back");
  assert.equal(stageEventRole("probe"), "back");
  assert.equal(stageEventRole("probe-frame"), "back");
});

test("事件白名单就是这七种,一个不多一个不少", () => {
  assert.deepEqual(
    [...STAGE_EVENT_TYPES].sort(),
    ["demote", "ended", "frame", "mediaReady", "probe", "probe-frame", "settled"],
  );
  // 每一种都能分到一个角色:漏一种,那种事件就会被两个舞台都当成自己的
  for (const type of STAGE_EVENT_TYPES) assert.ok(stageEventRole(type) === "front" || stageEventRole(type) === "back");
});

test("isStageEvent 只认白名单里的 type,RPC 的两种消息不混进事件流", () => {
  assert.equal(isStageEvent({ type: "frame", sec: 1 }), true);
  assert.equal(isStageEvent({ type: "pc-stage-ready" }), false);
  assert.equal(isStageEvent({ type: "pc-rpc-reply", id: 1, ok: true }), false);
  assert.equal(isStageEvent(null), false);
  assert.equal(isStageEvent("frame"), false);
  assert.equal(isRpcRequest({ type: "pc-rpc", id: 3, method: "setTime", args: [1] }), true);
  assert.equal(isRpcRequest({ type: "pc-rpc", method: "setTime" }), false);
  assert.equal(isRpcReply({ type: "pc-rpc-reply", id: 3, ok: false }), true);
  assert.equal(isRpcReply({ type: "pc-rpc", id: 3 }), false);
});

test("stageId 是实例名不是角色:缺省给 A,不给 front", async () => {
  const { detectHostCapabilities } = await import("./stageRpc.ts");
  const g = globalThis;
  const saved = { location: g.location, navigator: g.navigator, OffscreenCanvas: g.OffscreenCanvas, Worker: g.Worker };
  try {
    Object.defineProperty(g, "location", { value: { search: "?stage=1&id=B&prerender=1" }, configurable: true, writable: true });
    Object.defineProperty(g, "navigator", { value: { userAgent: "Chrome/152", deviceMemory: 32 }, configurable: true, writable: true });
    g.OffscreenCanvas = undefined;
    g.Worker = undefined;
    assert.equal(detectHostCapabilities().stageId, "B");
    assert.equal(detectHostCapabilities().prerender, true);

    Object.defineProperty(g, "location", { value: { search: "?stage=1" }, configurable: true, writable: true });
    assert.equal(detectHostCapabilities().stageId, "A");
    assert.equal(detectHostCapabilities().prerender, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
    }
  }
});
