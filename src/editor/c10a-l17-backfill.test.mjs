/**
 * c10a 契约第 17 节「补渲」页面一侧的单测(编号 C10A-L17-B…):低内存档发现判重的层在素材服务里没有产物(按清单判:
 * 不在渲染节点写的层表里)时,向队列发布带片段清单、标 backfill 的计划任务;同一批还在等的不重发;页面只发布,不认领。
 *
 *   B1 任务形状:与队列侧 `backfillPlanTaskOf` 逐字段相同,队列的入站校验收它
 *   B2 缺产物的层:全部可见卡片段减去层表里的;用户卡 / 图卡照样在内(2026-09-29 用户改语义,由桌面版等渲染节点渲);
 *      素材段、隐藏轨道不算
 *   B3 不重发:还在等的片段不再发;新缺的单独成一批;到了的忘掉;过了重发时限或换了版本才再发
 *   B4 只发布不认领:发出去的只有 publisher.hello(一次)与 task.publish;发失败的不算在等,下一轮重发
 *   B5 在线来源的层表:取回来之前判不了(null),内容库里没有层表 = 一层都没有(空集合)
 *
 * 跑:node --experimental-test-module-mocks --test src/editor/c10a-l17-backfill.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { backfillPlanTaskOf, parseInbound } from "../../server/render-queue/messages.mjs";

const B = await import(srcUrl("editor/lowMemoryBackfill.ts"));
const { OnlineSnapshotSource, LAYER_MAP_PREFIX } = await import(srcUrl("render/snapshotSource.ts"));

test("C10A-L17-B1 补渲计划任务的形状与队列侧逐字段相同,队列的入站校验收它", () => {
  for (const clips of [["c1"], ["b", "a", "a"], ["clip-3", "clip-10", "clip-2"]]) {
    const page = B.backfillPlanTask({ projectId: "proj-1", projectRev: 12, clips });
    const server = backfillPlanTaskOf({ projectId: "proj-1", projectRev: 12, clips });
    assert.deepEqual(page, server);
    assert.equal(page.priority, "backfill");
    assert.ok(parseInbound({ type: "task.publish", tasks: [page] }).ok);
  }
});

const project = (tracks) => ({ tracks });
const clip = (id, extra = {}) => ({ id, cardId: `card-${id}`, start: 0, end: 4, params: {}, ...extra });

test("C10A-L17-B2 缺产物的层:所有可见卡片段减去层表里的,用户卡 / 图卡(含同步来的)照样在内;素材段、隐藏轨道不算", () => {
  const p = project([
    { id: "t1", clips: [clip("heavy"), clip("light"), clip("user", { cardId: "my-user-card" }), clip("graph", { cardId: "graph-card" }),
      clip("synced", { cardId: "synced-user-card" })] },
    { id: "t2", clips: [{ id: "video", mediaId: "m1", start: 0, end: 4 }, clip("zero", { end: 0 })] },
    { id: "t3", hidden: true, clips: [clip("hidden")] },
  ]);
  assert.deepEqual(B.missingLayers({ project: p, layerClipIds: new Set(["heavy"]) }), ["graph", "light", "synced", "user"]);
  assert.deepEqual(B.missingLayers({ project: p, layerClipIds: new Set() }), ["graph", "heavy", "light", "synced", "user"]);
  assert.deepEqual(B.missingLayers({ project: p, layerClipIds: new Set(["heavy", "light", "user", "graph"]) }), ["synced"], "同步卡没有层:进补渲清单");
  assert.deepEqual(B.missingLayers({ project: p, layerClipIds: new Set(["heavy", "light", "user", "graph", "synced"]) }), []);
  // 判定的表(界限搜索的结果)里这台设备跑不了的卡一律判重(forcedHeavy):没有产物就进清单
  assert.deepEqual(B.missingLayers({ project: p, layerClipIds: new Set(["heavy"]), heavy: new Set(["heavy", "user", "graph", "synced"]) }), ["graph", "synced", "user"]);
});

/** 假的文档服务连接:记下每条请求,按类型回包 */
function fakeLink({ publishError = null } = {}) {
  const sent = [];
  let fail = publishError;
  return {
    sent,
    setFail(v) { fail = v; },
    request: async (msg) => {
      sent.push(structuredClone(msg));
      if (msg.type === "publisher.hello") return { type: "publisher.welcome", publisherId: msg.publisherId };
      if (msg.type === "task.publish") {
        if (fail === "disconnected") throw new Error("连接断了");
        if (fail) return { type: "task.published", results: msg.tasks.map((t) => ({ id: t.id, error: fail })) };
        return { type: "task.published", results: msg.tasks.map((t) => ({ id: t.id, state: "open", version: 1, created: true })) };
      }
      return { type: "error", reason: "unexpected" };
    },
  };
}

test("C10A-L17-B3 同一批还在等的不重发;新缺的单独成一批;到了的忘掉;过了重发时限或换了版本才再发", async () => {
  let now = 1_000;
  const link = fakeLink();
  const pub = new B.BackfillPublisher({ request: link.request, publisherId: "lowmem-x", now: () => now });
  const publishes = () => link.sent.filter((m) => m.type === "task.publish").map((m) => m.tasks[0]);

  let r = await pub.sync({ projectId: "p", projectRev: 5, missing: ["c2", "c1"] });
  assert.deepEqual(r.published.clips, ["c1", "c2"]);
  assert.equal(publishes().length, 1);
  assert.equal(publishes()[0].priority, "backfill");
  assert.equal(publishes()[0].source.projectRev, 5);

  now += 3_000;
  r = await pub.sync({ projectId: "p", projectRev: 5, missing: ["c1", "c2"] });
  assert.equal(r.published, null, "同一批还在等:不重发");
  assert.deepEqual(r.waiting, ["c1", "c2"]);
  assert.equal(publishes().length, 1);

  now += 3_000;
  r = await pub.sync({ projectId: "p", projectRev: 5, missing: ["c1", "c2", "c3"] });
  assert.deepEqual(r.published.clips, ["c3"], "新缺的单独成一批,在等的不带");
  assert.deepEqual(r.waiting, ["c1", "c2"]);

  now += 3_000;
  r = await pub.sync({ projectId: "p", projectRev: 5, missing: ["c3"] });
  assert.equal(r.published, null, "c1、c2 的产物到了(进了层表):忘掉;c3 还在等");
  assert.deepEqual(pub.debug().waiting.map((w) => w.clip), ["c3"]);

  // 过了重发时限还缺:按同一份清单再发一次(队列里还在就只合并)
  now += B.BACKFILL_RESEND_MS;
  r = await pub.sync({ projectId: "p", projectRev: 5, missing: ["c3"] });
  assert.deepEqual(r.published.clips, ["c3"]);
  assert.equal(publishes().at(-1).id, publishes()[1].id, "同一份清单同一个键");

  // 换了版本:刚换不到宽限期还算在等,过了宽限期按新版本另发
  now += 1_000;
  r = await pub.sync({ projectId: "p", projectRev: 6, missing: ["c3"] });
  assert.equal(r.published, null);
  now += B.BACKFILL_REV_GRACE_MS;
  r = await pub.sync({ projectId: "p", projectRev: 6, missing: ["c3"] });
  assert.equal(r.published.projectRev, 6);
  assert.notEqual(publishes().at(-1).id, publishes()[1].id);

  // 没有项目号 / 版本号:不发
  assert.equal((await pub.sync({ projectId: null, projectRev: 6, missing: ["c9"] })).published, null);
  assert.equal((await pub.sync({ projectId: "p", projectRev: null, missing: ["c9"] })).published, null);
});

test("C10A-L17-B4 页面只发布不认领:只发 publisher.hello(一次)与 task.publish;发失败的不算在等,下一轮重发", async () => {
  let now = 0;
  const link = fakeLink({ publishError: "limit" });
  const pub = new B.BackfillPublisher({ request: link.request, publisherId: "lowmem-y", now: () => now });
  let r = await pub.sync({ projectId: "p", projectRev: 1, missing: ["a"] });
  assert.equal(r.published, null);
  assert.match(r.error, /limit/);
  now += 3_000;
  link.setFail("disconnected");
  r = await pub.sync({ projectId: "p", projectRev: 1, missing: ["a"] });
  assert.equal(r.published, null, "连接断了:不算发出");
  now += 3_000;
  link.setFail(null);
  r = await pub.sync({ projectId: "p", projectRev: 1, missing: ["a"] });
  assert.deepEqual(r.published.clips, ["a"], "恢复后重发");
  const types = new Set(link.sent.map((m) => m.type));
  assert.deepEqual([...types].sort(), ["publisher.hello", "task.publish"], "从不发 node.hello / queue.watch / task.claim");
  // 断线之后重新报到过一次(连接断了会作废报到)
  assert.equal(link.sent.filter((m) => m.type === "publisher.hello").length, 2);
  // reset(换连接):重新报到,在等的清掉
  pub.reset();
  r = await pub.sync({ projectId: "p", projectRev: 1, missing: ["a"] });
  assert.deepEqual(r.published.clips, ["a"]);
  assert.equal(link.sent.filter((m) => m.type === "publisher.hello").length, 3);
});

test("C10A-L17-B5 在线来源的层表:取回来之前判不了(null),内容库里没有层表 = 一层都没有", async () => {
  const content = new Map();
  const deps = {
    async request(msg) {
      if (!content.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
      return { type: "content.item", kind: msg.kind, key: msg.key, body: structuredClone(content.get(msg.key)) };
    },
    assetBase: () => null, authHeaders: async () => ({}), setTimer: () => 0, clearTimer: () => {},
  };
  const src = new OnlineSnapshotSource(deps);
  src.setProject("p1");
  assert.equal(src.layerClipIds(), null, "还没取过层表:判不了");
  await src.tickNow();
  assert.deepEqual([...src.layerClipIds()], [], "内容库回「没有」:一层都没有");
  content.set(`${LAYER_MAP_PREFIX}p1`, { v: 1, kind: "layer-map", projectId: "p1", fps: 30, span: 60, at: 1,
    layers: [{ clipId: "heavy", kind: "html", key: "K", resultKey: "R", firstFrame: 0, count: 90 }] });
  src.setProject(null);
  src.setProject("p1");
  await src.tickNow();
  assert.deepEqual([...src.layerClipIds()], ["heavy"]);
  src.stop();
});
