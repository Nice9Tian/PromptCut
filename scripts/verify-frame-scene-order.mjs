/**
 * Browser integration acceptance for mixed same-track FrameScene layers.
 * It deliberately uses the real prerender Vite server, Python card endpoint and
 * beginFrame capture rather than a DOM/unit-test stand-in. Evidence lives under
 * work/frame-scene-order and is safe to keep between runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { createServer } from "vite";
import { openBakery, bakeFrames } from "./export-frames.mjs";
import { saveCardDefinition, applyCardDefinition } from "../src/kernel/cardAuthoring.mjs";

process.env.PROMPTCUT_ROLE = "prerender";
const root = process.cwd(), port = 5203, origin = `http://127.0.0.1:${port}`;
const output = path.join(root, "work", "frame-scene-order");
await fs.mkdir(output, { recursive: true });
const base = { id: "frame-scene-order", name: "frame scene order", width: 640, height: 360, fps: 10, duration: 2,
  themeId: "default", media: [], style: {}, tracks: [{ id: "main", name: "main", clips: [] }] };
const timelineUrl = (project) => `${origin}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify(project))}`)}`;
const card = { id: "opaque-python", language: "python", entry: "Card", kind: "animation", compositing: "independent", need_prerendering: false,
  source: `from PIL import Image\nclass Card:\n    need_prerendering = False\n    def __init__(self, style=None): pass\n    def card(self, source, time): return Image.new('RGBA',(640,360),(225,20,30,255))` };
const makePython = (id, frame = undefined) => {
  const saved = saveCardDefinition(base, card);
  return applyCardDefinition(saved, { cardId: card.id, trackId: "main", start: 0, end: 2, newClipId: id, nodeId: `${id}-node`, ...(frame ? { frame } : {}) }).project;
};
const native = { id: "native", cardId: "punch-pill", start: 0, end: 2, params: { text: "NATIVE", position: "center" } };
const center = (bytes) => { const p = PNG.sync.read(bytes), n = (Math.floor(p.height / 2) * p.width + Math.floor(p.width / 2)) * 4; return [...p.data.subarray(n, n + 4)]; };
const same = (rgba, expected) => rgba.every((value, index) => Math.abs(value - expected[index]) <= 2);
const solidPng = (color) => {
  const png = new PNG({ width: 640, height: 360 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set(color, i);
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
};
const red = [225, 20, 30, 255], blue = [15, 70, 235, 255];
const server = await createServer({ configFile: path.join(root, "vite.prerender.config.ts"), server: { host: "127.0.0.1", port, strictPort: true } });
let bakery;
try {
  await server.listen();
  bakery = await openBakery({ url: timelineUrl(base) });
  const capture = async (name, project) => {
    await bakery.reset(project, timelineUrl(project), { deferCards: true });
    let bytes;
    await bakeFrames(bakery, { out: output, targetFrames: [10], fullFrame: true, writeFrames: false, onFrame: (_frame, png) => { bytes = png; } });
    assert.ok(bytes, `${name}: capture returned no PNG`);
    await fs.writeFile(path.join(output, `${name}.png`), bytes);
    return bytes;
  };

  // A Python clip before a legacy card must stay below that card. The reverse
  // order must be opaque red, proving order comes from tr.clips rather than a
  // fixed Python-before-Stage bucket.
  const pyFirst = makePython("python-first");
  pyFirst.tracks[0].clips.push(native);
  const first = center(await capture("python-before-native", pyFirst));
  assert.ok(!same(first, red), `native card was not above prior Python clip: ${first}`);
  const pyLast = makePython("python-last");
  pyLast.tracks[0].clips.unshift(native);
  const last = center(await capture("native-before-python", pyLast));
  assert.ok(same(last, red), `Python clip was not above prior native card: ${last}`);

  // Cached controls are a full-stage image. Verify both ordering directions;
  // an opaque cache after native must cover it, while one before native must not.
  const cachedLast = { ...base, _cardRender: { frames: { cache: { 10: solidPng(blue) } } }, tracks: [{ ...base.tracks[0], clips: [native, { id: "cache", cardId: "caption-track", start: 0, end: 2, params: {} }] }] };
  const cacheOnTop = center(await capture("native-before-cache", cachedLast));
  assert.ok(same(cacheOnTop, blue), `cached full-stage PNG was not above native: ${cacheOnTop}`);
  const cachedFirst = { ...cachedLast, tracks: [{ ...base.tracks[0], clips: [{ id: "cache", cardId: "caption-track", start: 0, end: 2, params: {} }, native] }] };
  const cacheBelow = center(await capture("cache-before-native", cachedFirst));
  assert.ok(!same(cacheBelow, blue), `native card was not above earlier cache: ${cacheBelow}`);

  // A 3-D Python frame must have perspective on its parent, just like a Stage
  // child. Inspect the real page after a capture and preserve that concrete DOM
  // fact in evidence alongside the pixels.
  const threeD = makePython("python-3d", { x: 320, y: 180, w: 260, h: 160, anchor: [0.5, 0.5], rotateY: 35 });
  threeD.camera3dFov = 40;
  await capture("python-3d", threeD);
  const perspective = await bakery.page.evaluate(() => getComputedStyle(document.querySelector("[data-pc-python-layer='python-3d']")).perspective);
  assert.notEqual(perspective, "none", "Python 3-D parent did not receive CSS perspective");
  const evidence = { frame: 10, pythonBeforeNative: first, nativeBeforePython: last, nativeBeforeCache: cacheOnTop, cacheBeforeNative: cacheBelow, python3dPerspective: perspective };
  await fs.writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("PASS FrameScene mixed ordering", JSON.stringify(evidence));
} finally { await bakery?.close(); await server.close(); }
