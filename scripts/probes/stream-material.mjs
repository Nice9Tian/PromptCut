// G0-b 的素材源：把真实卡片渲成**带透明背景**的逐帧 PNG，供 (5)(8)(10) 用。
// 走的是仓库现成的预渲染引擎 server/bakery/（openBakery + bakeFrames，fullFrame + png），
// 项目是「一条轨道一个 clip」的隔离工程（形状同 scripts/probe-card-costs.mjs 的 __mkProject）。
//
// 先在本 worktree 根起 dev server：npx vite --port 5201 --strictPort --host 127.0.0.1
//
//   node scripts/probes/stream-material.mjs --cards particles-snow,growth-curve,scene-3d
//   node scripts/probes/stream-material.mjs --cards odometer --frames 45 --origin http://127.0.0.1:5201
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { arg, writeJson } from './stream-common.mjs';

const ORIGIN = String(arg('origin', 'http://127.0.0.1:5201')).replace(/\/+$/, '');
const CARDS = String(arg('cards', 'particles-snow,growth-curve,scene-3d')).split(',').map((s) => s.trim()).filter(Boolean);
const FRAMES = Number(arg('frames', '45'));
const FPS = Number(arg('fps', '30'));
const W = Number(arg('w', '1920'));
const H = Number(arg('h', '1080'));
const outRoot = String(arg('out', path.join(os.tmpdir(), 'pc-stream-material')));
const jsonOut = arg('json');

const mkProject = (cardId, lenSec) => ({
  version: 1, id: 'g0b', name: 'g0b', width: W, height: H, fps: FPS, duration: lenSec,
  themeId: 'midnight', media: [],
  tracks: [{ id: 'g0b-track', clips: [{ id: 'c0', cardId, start: 0, end: lenSec, params: {} }] }],
});

const report = { probe: 'stream-material', when: new Date().toISOString(), origin: ORIGIN, fps: FPS, w: W, h: H, frames: FRAMES, cards: [] };

console.log(`起预渲染间（${ORIGIN}/?export=1）…`);
const bakery = await openBakery({ url: `${ORIGIN}/?export=1` });

try {
  for (const cardId of CARDS) {
    const outDir = path.join(outRoot, cardId);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const lenSec = +((FRAMES + 2) / FPS).toFixed(6);
    console.log(`\n=== ${cardId} ===  ${FRAMES} 帧 @ ${FPS} fps，${W}x${H}`);
    const t0 = performance.now();
    try {
      await bakery.reset(mkProject(cardId, lenSec), `${ORIGIN}/?export=1`);
      const resetMs = performance.now() - t0;
      const t1 = performance.now();
      const res = await bakeFrames(bakery, {
        out: outDir, fps: FPS, frames: `0-${FRAMES - 1}`,
        fullFrame: true, format: 'png', warm: 3, staticSkip: false,
      });
      const bakeMs = performance.now() - t1;
      const files = fs.readdirSync(path.join(outDir, 'frames')).filter((f) => f.endsWith('.png')).sort();
      const bytes = files.reduce((s, f) => s + fs.statSync(path.join(outDir, 'frames', f)).size, 0);
      console.log(`  换页 ${resetMs.toFixed(0)} ms，出 ${files.length} 帧用 ${bakeMs.toFixed(0)} ms（${(bakeMs / Math.max(1, files.length)).toFixed(1)} ms/帧），PNG 共 ${(bytes / 1e6).toFixed(1)} MB`);
      report.cards.push({
        cardId, dir: path.join(outDir, 'frames'), frameCount: files.length,
        resetMs: +resetMs.toFixed(1), bakeMs: +bakeMs.toFixed(1), msPerFrame: +(bakeMs / Math.max(1, files.length)).toFixed(2),
        pngBytes: bytes, pngBytesPerFrame: Math.round(bytes / Math.max(1, files.length)),
        width: res?.width ?? W, height: res?.height ?? H,
      });
    } catch (e) {
      console.log(`  失败：${String(e.message).slice(0, 300)}`);
      report.cards.push({ cardId, error: String(e.message).slice(0, 600) });
    }
  }
} finally {
  await bakery.close().catch(() => {});
}

console.log(`\n素材 -> ${outRoot}`);
if (jsonOut) console.log(`JSON -> ${writeJson(String(jsonOut), report)}`);
