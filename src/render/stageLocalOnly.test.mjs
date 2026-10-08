/**
 * 舞台(`Stage.tsx`)上这台设备跑不了的卡(C10 契约第 9 节,2026-09-29 用户改语义)。服务端渲染出 HTML 来核,跑:
 *   node --test src/render/stageLocalOnly.test.mjs
 *
 *   SL-01 在线浏览器模式:构建时的用户卡、图卡、同步来的用户卡(没有定义)不挂组件;包裹层照内置重卡的路子挂快照平面、
 *         流平面;占位槽位不再是常驻的(没有 `data-pc-placeholder-fixed`),默认 `hidden`(进显隐调度);父页没确认这一帧没有结果时
 *         是沙漏(`awaiting`),确认了才是「需要本地 PC 渲染辅助」图标;图标与沙漏按预览缩放补偿(`fit`);两边都没有的 id 不画
 *   SL-02 模式关着(桌面、导出、预渲染):用户卡、图卡照常挂组件,同步表不起作用,没有 `unsupported`
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function withStage(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const R = await server.ssrLoadModule("/src/kernel/registry.ts");
    const H = await server.ssrLoadModule("/src/render/placeholderHost.ts");
    const P = await server.ssrLoadModule("/src/kernel/project.ts");
    const S = await server.ssrLoadModule("/src/render/Stage.tsx");
    const marker = (id) => function Marker() { return React.createElement("i", { "data-test-component": id }); };
    R.resetCards();
    R.registerCards([
      { id: "builtin", name: "内置", defaults: {}, controls: [], frameMode: "direct", Component: marker("builtin") },
      { id: "mine", name: "构建时用户卡", defaults: {}, controls: [], frameMode: "direct", Component: marker("mine") },
    ]);
    R.setUserCardSources({ mine: "" }, { mine: "mine" });
    R.setSyncedUserCards([{ id: "synced-card", name: "同步卡" }, { id: "synced-two", name: "同步卡二" }]);
    const clips = [["b", "builtin"], ["u", "mine"], ["s", "synced-card"], ["v", "synced-two"], ["x", "unknown-card"]].map(([id, cardId]) => ({ id, cardId, start: 0, end: 4, params: {} }));
    const project = { version: 1, id: "p", name: "p", width: 640, height: 360, fps: 30, duration: 4, media: [], tracks: clips.map((c, i) => ({ id: `t${i}`, name: "t", clips: [c] })) };
    const timeline = P.flattenOverlay(project);
    const render = (props = {}) => renderToStaticMarkup(React.createElement(S.Stage, { timeline, t: 1, playToken: 1, ...props }));
    await fn({ R, H, render, marker });
  } finally {
    await server.close();
  }
}

/** 某个片段的包裹层(到下一个包裹层为止) */
const wrapOf = (html, id) => html.match(new RegExp(`<div data-pc-clip="${id}"[\\s\\S]*?(?=<div data-pc-clip=|$)`))?.[0] ?? null;

test("SL-01 在线:本页运行不了的卡不挂组件,照挂快照 / 流平面,占位槽位进显隐调度;能运行的用户卡照常挂;未知 id 不画", () => withStage(async ({ R, H, render, marker }) => {
  H.setOnlineBrowserMode(true);
  H.setPlaceholdersEnabled(true);
  try {
    const html = render({ snapshots: new Map([["s", "<p>snap-s</p>"]]), suppressed: new Set(["u", "s"]), streamPlanes: [{ clipIds: ["u"] }], awaiting: new Set(), settling: new Map() });
    const b = wrapOf(html, "b"), s = wrapOf(html, "s");
    assert.match(b, /data-test-component="builtin"/, "内置卡照常挂组件");
    // 2026-10-06(online-card-exec-contract.md 第 6 节):构建时就在包里的用户卡是页面自己的代码,照内置卡挂组件
    assert.match(wrapOf(html, "u"), /data-test-component="mine"/, "构建时的用户卡照常挂组件");
    assert.doesNotMatch(wrapOf(html, "u"), /unsupported|需要本地 PC 渲染辅助/);
    // 低内存档不执行用户卡的代码:构建时的用户卡在低内存档照旧不挂组件(下面用它核「运行不了的卡」的那一套)
    H.setLocalOnlyLowMemory(true);
    const lowHtml = render({ snapshots: new Map([["s", "<p>snap-s</p>"]]), suppressed: new Set(["u", "s"]), streamPlanes: [{ clipIds: ["u"] }], awaiting: new Set(), settling: new Map() });
    const u = wrapOf(lowHtml, "u");
    assert.doesNotMatch(u, /data-test-component/, "低内存档:构建时的用户卡不挂组件");
    assert.match(u, /data-pc-stream-plane=""/, "用户卡照挂流平面");
    // 同步来的卡在舞台里载入成功(运行时注册表里有定义):照常挂组件;没载入的(v)照旧不挂
    H.setLocalOnlyLowMemory(false);
    R.setRuntimeCards([{ id: "synced-card", name: "同步卡", defaults: {}, controls: [], frameMode: "direct", Component: marker("synced") }]);
    const live = render({ snapshots: new Map(), suppressed: new Set(), awaiting: new Set(), settling: new Map() });
    assert.match(wrapOf(live, "s"), /data-test-component="synced"/, "载入成功的同步卡挂组件");
    assert.doesNotMatch(wrapOf(live, "v"), /data-test-component/, "没载入的同步卡不挂组件");
    R.setRuntimeCards([]);
    H.setLocalOnlyLowMemory(true);
    assert.match(s, /data-pc-snapshot-plane=""[^>]*><p>snap-s<\/p>/, "同步卡(没有定义)照挂快照平面");
    for (const w of [u, s]) {
      assert.match(w, /data-pc-placeholder-slot="" hidden=""/, "槽位默认藏着,由显隐调度切");
      assert.doesNotMatch(w, /data-pc-placeholder-fixed/, "不再是常驻槽位");
      // 父页还没确认这一帧没有结果:普通加载占位(沙漏),不是图标(刚打开页面不闪图标)
      assert.match(w, /data-pc-placeholder-reason="awaiting"/);
      assert.doesNotMatch(w, /需要本地 PC 渲染辅助/);
    }
    // 父页确认 u、s 这一帧没有可贴的结果:换成「需要本地 PC 渲染辅助」图标
    H.setLocalOnlyConfirmed(["u", "s"]);
    // 预览缩放 25%:片段框 640×360、不缩放 → 目标倍数 4,横排 792 放不进 → 竖排 640 也放不进(留边距)→ 只留图标
    H.setPlaceholderViewScale(0.25);
    const html2 = render({ snapshots: new Map([["s", "<p>snap-s</p>"]]), suppressed: new Set(["u", "s"]), streamPlanes: [{ clipIds: ["u"] }], awaiting: new Set(), settling: new Map() });
    for (const id of ["u", "s"]) {
      const w = wrapOf(html2, id);
      assert.match(w, /data-pc-placeholder-reason="unsupported"/);
      assert.match(w, /需要本地 PC 渲染辅助/);
      // 量不到实体框:小徽标,中心在位置框中心,按 fit 放大
      assert.match(w, /data-pc-placeholder-kind="unsupported-badge"[^>]*data-pc-placeholder-layout="icon"[^>]*style="position:absolute;left:320px;top:180px;transform:translate\(-50%, -50%\) scale\(4\)"/);
      assert.match(w, /aria-label="需要本地 PC 渲染辅助"/, "只留图标时 aria-label 照旧是全文");
    }
    // 内置卡的沙漏:屏幕上保持原大小,只抵消预览缩放(28 × 4 舞台像素)
    const b2 = wrapOf(html2, "b");
    assert.match(b2, /data-pc-placeholder-kind="badge"[^>]*style="position:absolute;left:306px;top:166px;width:28px;height:28px;transform:scale\(4\)"/);
    H.setLocalOnlyConfirmed([]);
    H.setPlaceholderViewScale(1);
    assert.doesNotMatch(b, /data-pc-placeholder-reason="unsupported"/, "内置卡的占位照旧是沙漏");
    assert.equal(wrapOf(html, "x"), null, "两边都没有的 id 不画");
    // 后台舞台(占位关着):照样不挂组件,也没有槽位
    H.setPlaceholdersEnabled(false);
    const back = render({ snapshots: new Map(), suppressed: new Set() });
    assert.doesNotMatch(wrapOf(back, "u"), /data-test-component|data-pc-placeholder-slot/);
  } finally {
    H.setLocalOnlyLowMemory(false);
    R.setRuntimeCards([]);
    H.setOnlineBrowserMode(false);
    H.setPlaceholdersEnabled(false);
  }
}));

test("SL-02 模式关着:用户卡照常挂组件,同步表不起作用,没有 unsupported", () => withStage(async ({ H, render }) => {
  H.setOnlineBrowserMode(false);
  for (const placeholders of [false, true]) {
    H.setPlaceholdersEnabled(placeholders);
    const html = render(placeholders ? { snapshots: new Map(), suppressed: new Set(["u"]) } : {});
    assert.match(wrapOf(html, "u"), /data-test-component="mine"/);
    assert.equal(wrapOf(html, "s"), null, "同步卡本机没有定义:桌面不画");
    assert.doesNotMatch(html, /unsupported/);
  }
  // 桌面预览也按预览缩放补偿沙漏(屏幕上约 28 像素),不补偿这一层自己的缩放
  H.setPlaceholdersEnabled(true);
  H.setPlaceholderViewScale(0.5);
  try {
    const html = render({ snapshots: new Map(), suppressed: new Set(["u"]) });
    assert.match(wrapOf(html, "u"), /data-pc-placeholder-kind="badge"[^>]*width:28px;height:28px;transform:scale\(2\)/);
  } finally {
    H.setPlaceholderViewScale(1);
    H.setPlaceholdersEnabled(false);
  }
}));
