import fs from 'node:fs/promises';
import path from 'node:path';
import { cardNodeIdentities, cardSampling, cardCacheIdentity } from './card-identity.mjs';
import { MovFrameStore } from './frame-mov.mjs';
import { findFfmpeg } from '../scripts/export-frames.mjs';

const exists = file => fs.access(file).then(() => true, () => false);

/**
 * Durable cache for cards which have explicitly declared independent
 * compositing.  Each value is a full-stage transparent PNG; placement belongs
 * to the browser compositor, so a cached image is never transformed again.
 *
 * The public shape deliberately contains URLs only.  The browser receives it
 * through project._cardRender and is the sole component allowed to composite
 * it with the live scene.
 */
export class CardFrameCache {
  constructor({ root, project }) {
    this.root = root; this.project = project; this.fps = Number(project.fps) || 30;
    this.stores = new Map(); this.meta = new Map();
  }
  async store(key) {
    if (!this.stores.has(key)) {
      const store = new MovFrameStore({ dir: path.join(this.root, 'controls', key), fps: this.fps });
      this.stores.set(key, store); await store.ready;
    }
    return this.stores.get(key);
  }
  /** Accept both the compact browser plan and graph.outputs.  Unknown and
   * context cards are intentionally excluded: they must be rendered in their
   * complete Chrome context. */
  plan(value) {
    const graph = value?.graph || value;
    if (!graph?.nodes || !graph?.outputs) return [];
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const definitions = new Map((graph.definitions || []).map(definition => [definition.id, definition]));
    const identities = cardNodeIdentities(graph, { style: this.project.style || {}, environment: value?.environment || {}, sourceVersions: value?.sourceVersions || {} });
    const controls = [];
    for (const output of graph.outputs) {
      const node = nodes.get(output.nodeId);
      const definition = definitions.get(node?.definitionId);
      const caps = output.capabilities || node?.capabilities || node?.definition?.capabilities || definition || {};
      const compositing = caps.compositing || node?.compositing || 'unknown';
      // A Chrome implementation has to opt in.  We retain non-independent
      // records too, because required context/unknown cards need explicit
      // foreground missing state and a full-scene required producer.
      const cacheable = compositing === 'independent';
      const start = Number(output.start ?? node?.start ?? 0), end = Number(output.end ?? node?.end ?? start);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const sampling = cardSampling(start, this.fps);
      const phase = Number(sampling.phase.numerator) / Number(sampling.phase.denominator);
      // Samples are t = first/fps + local/fps, strictly before clip.end.
      // `phase` is seconds, hence it must be subtracted before multiplying by
      // fps (the old expression mixed seconds and frames).
      const count = Math.max(1, Math.ceil((end - start - phase) * this.fps - 1e-9));
      const nodeKey = identities.get(output.nodeId);
      if (!nodeKey) continue;
      // Output appearance belongs in the key: clipping frame, opacity/fades
      // and motion change pixels even if the underlying node stays identical.
      const appearance = { frame: output.frame, opacity: output.opacity, fadeIn: output.fadeIn, fadeOut: output.fadeOut, motion: output.motion,
        width: this.project.width, height: this.project.height };
      const key = cardCacheIdentity(nodeKey, sampling, end - start, JSON.stringify(appearance));
      controls.push({ key, clipId: output.clipId || node?.clipId, nodeId: output.nodeId, start, end, count, sampling, compositing, cacheable,
        needPrerendering: caps.need_prerendering === true || caps.needPrerendering === true || node?.need_prerendering === true || node?.needPrerendering === true, appearance });
    }
    return controls;
  }
  async renderState(plan, frames, { urlFor = (key, n) => `/api/frames/control/${encodeURIComponent(key)}/${n}` } = {}) {
    const values = {}, missing = {};
    for (const control of plan) {
      if (!control.cacheable) {
        if (control.needPrerendering) for (const globalFrame of frames) {
          if (globalFrame >= control.sampling.firstFrame && globalFrame / this.fps < control.end - 1e-9) (missing[globalFrame] ||= []).push(control.clipId);
        }
        continue;
      }
      const store = await this.store(control.key);
      for (const globalFrame of frames) {
        const local = globalFrame - control.sampling.firstFrame;
        if (local < 0 || local >= control.count || globalFrame / this.fps >= control.end - 1e-9) continue;
        if (await store.get(local)) {
          (values[control.clipId] ||= {})[globalFrame] = urlFor(control.key, local);
        } else if (control.needPrerendering) (missing[globalFrame] ||= []).push(control.clipId);
      }
    }
    return { mode: 'interactive', frames: values, missing };
  }
  async put(key, localFrame, png, guard = () => true) {
    if (!guard()) return false;
    const store = await this.store(key);
    if (!guard()) return false;
    await store.put(localFrame, png);
    return true;
  }
  async hasComplete(control) {
    const store = await this.store(control.key);
    for (let n = 0; n < control.count; n++) if (!store.has(n)) return false;
    return true;
  }
  async finish(control) {
    if (!await this.hasComplete(control)) return false;
    const store = await this.store(control.key);
    // streamPngVideo (used by MovFrameStore) is ProRes 4444 with alpha.  Start
    // only after every local sample exists so a sparse interactive request can
    // never publish a truncated control movie.
    await store.start(await findFfmpeg());
    await store.finish();
    return true;
  }
  async close() { await Promise.all([...this.stores.values()].map(store => store.close())); }
}

export const cardControlPngPath = (root, key, frame) => path.join(root, 'controls', key, 'mov', 'frames', String(frame).padStart(6, '0') + '.png');
