import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeFrames, openBakery, resolveWorkers } from './export-frames.mjs';

/** Safe cuts only at card boundaries; Motion/WAAPI cards are never cut mid-life. */
export function safeShardRanges(project, startFrame, endFrame, workers) {
  const fps = project.fps || 30;
  const cuts = new Set([startFrame, endFrame + 1]);
  for (const track of project.tracks || []) for (const clip of track.clips || []) for (const t of [clip.start, clip.end]) {
    const f = Math.round(Number(t) * fps);
    if (Number.isFinite(f) && f > startFrame && f <= endFrame) cuts.add(f);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i + 1 < points.length; i++) segments.push([points[i], points[i + 1] - 1]);
  if (segments.length <= workers) return segments;
  const out = [];
  let at = 0;
  for (let shard = 0; shard < workers; shard++) {
    const slots = workers - shard;
    const remaining = segments.slice(at).reduce((n, r) => n + r[1] - r[0] + 1, 0);
    const target = Math.ceil(remaining / slots);
    let count = 0;
    let next = at;
    while (next < segments.length && (count === 0 || count + segments[next][1] - segments[next][0] + 1 <= target || slots === 1)) {
      count += segments[next][1] - segments[next][0] + 1;
      next++;
      if (slots > 1 && count >= target) break;
    }
    out.push([segments[at][0], segments[next - 1][1]]);
    at = next;
  }
  return out;
}

/** Stream each shard through Chrome/bakeFrames without retaining the HTML archive. */
export async function exportUnified(project, opts) {
  const fps = opts.fps || project.fps || 30;
  project = { ...project, fps };
  let startFrame = 0;
  let endFrame = Math.max(0, Math.floor(project.duration * fps) - 1);
  if (opts.frames) [startFrame, endFrame] = opts.frames.split('-').map(Number);
  const targetFrames = opts.targetFrames?.length ? [...new Set(opts.targetFrames)].sort((a, b) => a - b) : null;
  const allFrames = targetFrames || Array.from({ length: endFrame - startFrame + 1 }, (_, i) => i + startFrame);
  const out = opts.out || 'out';
  const requestedWorkers = targetFrames ? 1 : await resolveWorkers(opts.workers);
  const ranges = targetFrames ? [[startFrame, endFrame]] : safeShardRanges(project, startFrame, endFrame, requestedWorkers);
  const started = Date.now();
  let completed = 0;
  let first = null;
  const shardProgress = new Map();
  const render = async ([a, b]) => {
    const bakery = await openBakery({ ...opts, url: opts.url });
    try {
      const result = await bakeFrames(bakery, {
        ...opts, out, url: opts.url, frames: `${a}-${b}`, workers: 1, onProgressLog: false,
        quiet: true,
        onProgress: (frame) => {
          const local = Math.max(0, Math.min(b, frame) - a + 1);
          const previous = shardProgress.get(a) || 0;
          if (local <= previous) return;
          shardProgress.set(a, local);
          completed += local - previous;
          console.log(`Exported frame ${frame} (${completed}/${allFrames.length})`);
        },
      });
      first ||= result;
      return result;
    } finally { await bakery.close().catch(() => {}); }
  };
  const results = await Promise.all(ranges.map(render));
  return {
    ...(first || { framesDir: path.join(out, 'frames'), ext: 'png', width: project.width, height: project.height }),
    fps, startFrame: allFrames[0], endFrame: allFrames.at(-1), totalFrames: allFrames.length,
    durationSec: (allFrames.length / fps).toFixed(3), reused: results.reduce((n, r) => n + (r.reused || 0), 0),
    elapsed: ((Date.now() - started) / 1000).toFixed(1),
    glass: { dir: first?.glass?.dir ?? null, list: results.flatMap(r => r.glass?.list || []), blurs: [...new Set(results.flatMap(r => r.glass?.blurs || []))] },
  };
}
