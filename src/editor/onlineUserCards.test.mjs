/**
 * 在线浏览器模式下这台设备跑不了的卡(用户卡、图卡、内容库同步来的用户卡)在父页一侧的判定(C10 契约第 9 节,2026-09-29 用户改语义)。
 * 跑:node --experimental-test-module-mocks --test src/editor/onlineUserCards.test.mjs
 *
 *   OU-01 `clipIdentityOf`:在线时不给它们身份(不测、查不到旧成本记录、查不到声明的帧模式);桌面照旧;同步表变了跟着变
 *   OU-02 `planDispatch`:它们一律判重、进预渲染集合(页面发布的清单计划据此含它们),哪怕 L2 里留着判轻的旧记录;
 *         同步表后到也重算;没有定义的同步卡不让算表崩
 *   OU-03 时间轴:标签依次取构建时名字 → 同步名字 →「未知卡片」;徽标只在「在线、本机跑不了、没覆盖整段」三者同时成立时出
 *   OU-04 卡片源码同步(`sync/onlineCardSources.ts`):列、取、解析进注册表;哈希没变不再取正文;连接换了清表;取不到时表不动
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;

mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });
mock.module(srcUrl("render/cardSourceFiles.mjs"), { exports: { builtinCardSourceFiles: {}, cardSourceFilesVersion: () => 0 } });
mock.module(srcUrl("render/cardSourceVersion.mjs"), { exports: { cardSourceVersion: (card) => `v-${card.id}` } });

const R = await import(srcUrl("kernel/registry.ts"));
const H = await import(srcUrl("render/placeholderHost.ts"));
const CI = await import(srcUrl("editor/costIdentity.ts"));
const D = await import(srcUrl("editor/planDispatch.ts"));
const B = await import(srcUrl("editor/timeline/localPcBadge.ts"));
const S = await import(srcUrl("editor/sync/onlineCardSources.ts"));

const FPS = 30;
const dom = (id, extra = {}) => ({ id, name: `名-${id}`, defaults: {}, controls: [], frameMode: "direct", Component: () => null, ...extra });
function setup() {
  R.resetCards();
  R.registerCards([dom("builtin"), dom("mine", { name: "构建时用户卡" }), dom("graphish", { Component: undefined, card: () => ({}) })]);
  R.setUserCardSources({ mine: "" }, { mine: "mine" });
  R.setSyncedUserCards([]);
  CI.resetClipIdentityCache();
}
const clip = (id, cardId, start = 0, end = 2) => ({ id, cardId, start, end, params: {} });
const project = () => ({ version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: FPS, duration: 10, media: [],
  tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin"), clip("u", "mine", 2, 4), clip("g", "graphish", 4, 6), clip("s", "synced-card", 6, 8), clip("x", "nobody", 8, 10)] }] });
const settle = () => new Promise((r) => setTimeout(r, 0));

test("OU-01 clipIdentityOf:在线时这台设备跑不了的卡没有身份;桌面照旧;同步表变了跟着变", () => {
  setup();
  const p = project();
  try {
    const desk = CI.clipIdentityOf(p);
    for (const id of ["b", "u", "s", "x"]) assert.ok(desk.identityKeys[id], `桌面:${id} 有身份`);
    assert.ok(desk.frameModes.b && desk.frameModes.u);
    H.setOnlineBrowserMode(true);
    const on1 = CI.clipIdentityOf(p);
    assert.notEqual(on1, desk, "模式变了不用旧的记忆");
    assert.ok(on1.identityKeys.b && on1.identityKeys.s && on1.identityKeys.x, "同步表还没到:s 还是未知卡片,照旧有身份");
    assert.equal(on1.identityKeys.u, undefined, "构建时的用户卡:没有身份");
    assert.equal(on1.identityKeys.g, undefined, "图卡:没有身份");
    assert.equal(on1.frameModes.u, undefined, "也没有声明的帧模式(否则 direct 会判轻)");
    assert.equal(on1.capabilities.has("u"), false);
    R.setSyncedUserCards([{ id: "synced-card", name: "同步卡" }]);
    const on2 = CI.clipIdentityOf(p);
    assert.equal(on2.identityKeys.s, undefined, "同步表到了:同步卡也没有身份");
    assert.ok(on2.identityKeys.x, "两边都没有的 id 不受影响");
    assert.equal(CI.clipIdentityOf(p), on2, "没变就用记忆");
  } finally {
    H.setOnlineBrowserMode(false);
    R.setSyncedUserCards([]);
  }
});

test("OU-02 planDispatch:在线时本机跑不了的卡一律判重、进预渲染集合,旧的判轻记录不认;同步表后到也重算", async () => {
  setup();
  const p = project();
  // 桌面口径的身份键 → 每张都有一条很轻的成本记录(模拟 L2 里以前在后台舞台上测过的旧记录)
  const keys = CI.clipIdentityOf(p).identityKeys;
  const lightRec = (key) => ({ identityKey: key, fps: FPS, device: "d", measuredAt: 1, stepMs: 0.2, kind: "random", vtOk: true, seekOk: true, seekMs: 0.2, catchUpMs: 0.2 });
  D.resetPlanDispatch();
  D.setPlanCosts(Object.values(keys).map(lightRec), null);
  D.setPlanProject(p);
  await settle();
  const desk = D.currentPlan().prerenderSet;
  for (const id of ["b", "u", "s", "x"]) assert.equal(desk.has(id), false, `桌面:${id} 按旧记录判轻`);
  try {
    H.setOnlineBrowserMode(true);
    CI.resetClipIdentityCache();
    D.setPlanCosts(Object.values(keys).map(lightRec), null);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "u"], "在线:用户卡、图卡判重;同步表还没到");
    R.setSyncedUserCards([{ id: "synced-card", name: "同步卡" }]);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s", "u"], "同步表到了:没有定义的同步卡也判重,算表不崩");
    // 页面发布的清单计划按 prerenderSet 取卡片段(Preview 的 clips()):含用户卡与同步卡
    const byId = new Map(p.tracks[0].clips.map((c) => [c.id, c]));
    assert.deepEqual([...D.currentPlan().prerenderSet].filter((id) => !!byId.get(id)?.cardId), ["g", "s", "u"]);
  } finally {
    H.setOnlineBrowserMode(false);
    R.setSyncedUserCards([]);
    D.resetPlanDispatch();
  }
});

test("OU-03 时间轴:标签与「需要本地 PC 渲染辅助」徽标的判定", () => {
  setup();
  R.setSyncedUserCards([{ id: "synced-card", name: "探针同步卡" }, { id: "builtin", name: "撞内置" }]);
  try {
    assert.equal(B.clipCardLabel(R.knownCardName("mine")), "构建时用户卡");
    assert.equal(B.clipCardLabel(R.knownCardName("synced-card")), "探针同步卡");
    assert.equal(B.clipCardLabel(R.knownCardName("builtin")), "名-builtin", "撞车的同步条目忽略");
    assert.equal(B.clipCardLabel(R.knownCardName("nobody")), "未知卡片");
    const badge = (online, cardId, coverage) => B.showLocalPcBadge({ online, localOnly: online && H.needsLocalPc(cardId, R.getCard(cardId)), coverage });
    assert.equal(badge(true, "synced-card", "none"), true, "同步卡没有层:出");
    assert.equal(badge(true, "synced-card", "partial"), true, "没覆盖整段:出");
    assert.equal(badge(true, "synced-card", "full"), false, "覆盖齐了:撤");
    assert.equal(badge(true, "mine", null), true, "没有在线来源(判不了覆盖):按没有结果");
    assert.equal(badge(true, "graphish", "partial"), true, "图卡");
    assert.equal(badge(true, "builtin", "none"), false, "内置卡从不出");
    assert.equal(badge(true, "nobody", "none"), false, "两边都没有的 id:只标未知卡片,不挂徽标");
    assert.equal(badge(false, "mine", "none"), false, "桌面从不出");
  } finally {
    R.setSyncedUserCards([]);
  }
});

/** 假的内容库:card-source 一类的 list / get */
function fakeContent(items) {
  const store = new Map(Object.entries(items));
  const sent = [];
  let fail = false;
  return {
    sent, store,
    setFail(v) { fail = v; },
    request: async (msg) => {
      sent.push(msg);
      if (fail) throw new Error("没连上文档服务");
      if (msg.type === "content.list") {
        const keys = [...store.keys()].filter((k) => k.startsWith(msg.prefix)).sort();
        return { type: "content.listing", kind: msg.kind, items: keys.map((key) => ({ key, hash: `h:${store.get(key).length}:${store.get(key).slice(-12)}`, rev: 1 })), truncated: false };
      }
      if (msg.type === "content.get") {
        if (!store.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
        const body = store.get(msg.key);
        return { type: "content.item", kind: msg.kind, key: msg.key, body, hash: `h:${body.length}:${body.slice(-12)}`, rev: 1 };
      }
      return { type: "error" };
    },
  };
}
const cardSrc = (id, name) => `import type { CardDef } from "../../kernel/types";\nexport const c: CardDef = { id: "${id}", name: "${name}", defaults: {}, controls: [], Component: () => null };\n`;

test("OU-04 卡片源码同步:列、取、解析进注册表;哈希没变不取正文;只认 src/cards/user/ 下一层的 .tsx;连接换了清表;取不到时表不动", async () => {
  setup();
  const content = fakeContent({
    "src/cards/user/a.tsx": cardSrc("synced-a", "同步甲"),
    "src/cards/user/b.tsx": cardSrc("synced-b", "同步乙") + cardSrc("synced-b2", "同步乙二").replace("export const c", "export const c2"),
    "src/cards/user/lib/helper.tsx": cardSrc("not-entry", "不是入口"),
    "src/cards/user/_scopes.json": "{}",
  });
  let link = { id: 1 };
  let changes = 0;
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link, onChange: () => changes++ });
  try {
    await sources.sync();
    assert.deepEqual([...R.syncedUserCards().keys()].sort(), ["synced-a", "synced-b", "synced-b2"]);
    assert.equal(R.knownCardName("synced-b2"), "同步乙二");
    assert.equal(R.syncedUserCards().get("synced-a").source, "src/cards/user/a.tsx");
    assert.equal(R.isUserCardId("not-entry"), false, "子目录里的不是入口文件");
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 2);
    assert.deepEqual(content.sent[0], { type: "content.list", kind: "card-source", prefix: "src/cards/user/" });
    assert.equal(changes, 1);
    // 再来一轮:哈希没变,不再取正文,不通知
    await sources.sync();
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 2);
    assert.equal(changes, 1);
    // 改名:只取那一条
    content.store.set("src/cards/user/a.tsx", cardSrc("synced-a", "同步甲改名"));
    await sources.sync();
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 3);
    assert.equal(R.knownCardName("synced-a"), "同步甲改名");
    // 取不到:表不动
    content.setFail(true);
    await sources.sync();
    assert.equal(R.syncedUserCards().size, 3);
    assert.ok(sources.debug().errors > 0);
    content.setFail(false);
    // 连接换了(换项目):先清表,再按新连接重取
    content.store.delete("src/cards/user/b.tsx");
    link = { id: 2 };
    await sources.sync();
    assert.deepEqual([...R.syncedUserCards().keys()], ["synced-a"]);
    // 离开共享项目:清空
    link = null;
    await sources.sync();
    assert.equal(R.syncedUserCards().size, 0);
  } finally {
    sources.stop();
    R.setSyncedUserCards([]);
  }
});

test("OU-04b entriesOf:按键排序,同一 id 取第一条", () => {
  const parsed = new Map([["src/cards/user/b.tsx", [{ id: "x", name: "乙里的 x" }]], ["src/cards/user/a.tsx", [{ id: "x", name: "甲里的 x" }, { id: "y", name: "y" }]]]);
  assert.deepEqual(S.entriesOf(["src/cards/user/b.tsx", "src/cards/user/a.tsx"], parsed), [
    { id: "x", name: "甲里的 x", source: "src/cards/user/a.tsx" },
    { id: "y", name: "y", source: "src/cards/user/a.tsx" },
  ]);
});
