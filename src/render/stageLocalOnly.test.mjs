/**
 * 舞台(`Stage.tsx`)上这台设备跑不了的卡(C10 契约第 9 节,2026-09-29 用户改语义)。服务端渲染出 HTML 来核,跑:
 *   node --test src/render/stageLocalOnly.test.mjs
 *
 *   SL-01 在线浏览器模式:构建时的用户卡、图卡、同步来的用户卡(没有定义)不挂组件;包裹层照内置重卡的路子挂快照平面、
 *         流平面;占位槽位不再是常驻的(没有 `data-pc-placeholder-fixed`),默认 `hidden`,原因是 `unsupported`(进显隐调度);
 *         两边都没有的 id 不画(与桌面一致)
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
    R.setSyncedUserCards([{ id: "synced-card", name: "同步卡" }]);
    const clips = [["b", "builtin"], ["u", "mine"], ["s", "synced-card"], ["x", "unknown-card"]].map(([id, cardId]) => ({ id, cardId, start: 0, end: 4, params: {} }));
    const project = { version: 1, id: "p", name: "p", width: 640, height: 360, fps: 30, duration: 4, media: [], tracks: clips.map((c, i) => ({ id: `t${i}`, name: "t", clips: [c] })) };
    const timeline = P.flattenOverlay(project);
    const render = (props = {}) => renderToStaticMarkup(React.createElement(S.Stage, { timeline, t: 1, playToken: 1, ...props }));
    await fn({ R, H, render });
  } finally {
    await server.close();
  }
}

/** 某个片段的包裹层(到下一个包裹层为止) */
const wrapOf = (html, id) => html.match(new RegExp(`<div data-pc-clip="${id}"[\\s\\S]*?(?=<div data-pc-clip=|$)`))?.[0] ?? null;

test("SL-01 在线:本机跑不了的卡不挂组件,照挂快照 / 流平面,占位槽位进显隐调度;未知 id 不画", () => withStage(async ({ H, render }) => {
  H.setOnlineBrowserMode(true);
  H.setPlaceholdersEnabled(true);
  try {
    const html = render({ snapshots: new Map([["s", "<p>snap-s</p>"]]), suppressed: new Set(["u", "s"]), streamPlanes: [{ clipIds: ["u"] }], awaiting: new Set(), settling: new Map() });
    const b = wrapOf(html, "b"), u = wrapOf(html, "u"), s = wrapOf(html, "s");
    assert.match(b, /data-test-component="builtin"/, "内置卡照常挂组件");
    assert.doesNotMatch(u, /data-test-component/, "构建时的用户卡不挂组件");
    assert.match(u, /data-pc-stream-plane=""/, "用户卡照挂流平面");
    assert.match(s, /data-pc-snapshot-plane=""[^>]*><p>snap-s<\/p>/, "同步卡(没有定义)照挂快照平面");
    for (const w of [u, s]) {
      assert.match(w, /data-pc-placeholder-slot="" hidden=""/, "槽位默认藏着,由显隐调度切");
      assert.doesNotMatch(w, /data-pc-placeholder-fixed/, "不再是常驻槽位");
      assert.match(w, /data-pc-placeholder-reason="unsupported"/);
      assert.match(w, /需要本地 PC 渲染辅助/);
    }
    assert.doesNotMatch(b, /data-pc-placeholder-reason="unsupported"/, "内置卡的占位照旧是沙漏");
    assert.equal(wrapOf(html, "x"), null, "两边都没有的 id 不画");
    // 后台舞台(占位关着):照样不挂组件,也没有槽位
    H.setPlaceholdersEnabled(false);
    const back = render({ snapshots: new Map(), suppressed: new Set() });
    assert.doesNotMatch(wrapOf(back, "u"), /data-test-component|data-pc-placeholder-slot/);
  } finally {
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
  H.setPlaceholdersEnabled(false);
}));
