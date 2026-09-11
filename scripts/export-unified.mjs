import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FramePipeline } from '../server/frame-pipeline.mjs';
import { frameCode } from '../server/frame-code.mjs';

/** Export is a consumer of see_frames, using the same persistent library as preview/Agent. */
export async function exportUnified(project, opts) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const service = new FramePipeline({ root: path.join(process.env.PROMPTCUT_EXPORT_DIR || path.join(root, 'out'), 'frame-library'),
    origin: () => new URL(opts.url).origin, code: () => frameCode(root) });
  const fps = opts.fps || project.fps || 30;
  project = { ...project, fps };
  let startFrame = 0, endFrame = Math.max(0, Math.floor(project.duration * fps) - 1);
  if (opts.frames) [startFrame, endFrame] = opts.frames.split('-').map(Number);
  const frames = opts.targetFrames?.length ? [...new Set(opts.targetFrames)].sort((a, b) => a - b) :
    Array.from({ length: endFrame - startFrame + 1 }, (_, i) => i + startFrame);
  const framesDir = path.join(opts.out || 'out', 'frames');
  await fs.mkdir(framesDir, { recursive: true });
  const start = Date.now();
  try {
    const entry = await service.entry(project);
    // B samples once up to the furthest requested frame, without screenshots or video loads.
    if (frames.some(n => !entry.html.has(n))) {
      const { bakeFrames } = await import('./export-frames.mjs');
      const bakery = await service.bakery(project);
      try {
        await bakeFrames(bakery, { out: entry.dir, targetFrames: frames, snapshotOnly: true, signal: opts.signal,
          onProgressLog: true,
          onSnapshot: (n, html, controls) => service.record(entry, n, html, controls) });
        await service.save(entry);
      } finally { await bakery.close(); }
    }
    // Bound the live PNG set; a long export never retains the entire video in memory.
    for (let offset = 0; offset < frames.length; offset += 24) {
      if (opts.signal?.aborted) throw new Error('Export cancelled');
      const batch = frames.slice(offset, offset + 24);
      const result = await service.see_frames(project, batch.map(n => n / fps), { signal: opts.signal });
      for (const [frame, value] of result) await fs.writeFile(path.join(framesDir, String(frame).padStart(6, '0') + '.png'), value.buf);
      console.log(`Exported frame ${batch.at(-1)} (${Math.min(offset + 24, frames.length)}/${frames.length})`);
    }
    return { framesDir, ext: 'png', fps, width: project.width, height: project.height, startFrame: frames[0], endFrame: frames.at(-1),
      totalFrames: frames.length, durationSec: (frames.length / fps).toFixed(3), reused: 0, elapsed: ((Date.now() - start) / 1000).toFixed(1), glass: { dir: null, list: [], blurs: [] } };
  } finally { await service.close(); }
}
