import fs from 'node:fs/promises';
import path from 'node:path';
import { cardNodeIdentities, cardSampling, cardCacheIdentity, cardSnapshotIdentity } from './card-identity.mjs';
import { freezeCode } from './frame-code.mjs';
import { snapshotTier } from './snapshot-store.mjs';
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
  /** `capture`/`scale` describe the renderer that writes samples. A sample is
   * served only when it was captured by the current capture code for this
   * card key, and an empty sample only after a second render confirmed it. */
  constructor({ root, project, capture = () => undefined, scale = () => 1 }) {
    this.root = root; this.project = project; this.fps = Number(project.fps) || 30;
    this.capture = capture; this.scale = scale;
    this.stores = new Map(); this.meta = new Map();
  }
  expected(key) { return { capture: this.capture() || undefined, cards: key }; }
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
      // A3a / C2 备注(第 4 步再放行):转场卡(`sourceDependent`)的快照也是内容寻址
      // 的、也该进共享档,但**这里**不能提前放行。`cacheable` 不只是「能不能存」,
      // 它同时决定两件今天就生效的事:(1) `fillCardControls` 会把这张卡丢进
      // `isolatedCardProject` 单独渲染;(2) `renderState` 会把渲出来的东西当成正确
      // 结果发给前台。而隔离工程今天只平移目标片段、不带依赖链上的源片段(A3a 说
      // 的 `graph` 参数和 `−phase − target.start` 位移量是第 4 步),转场卡在里面
      // 会拿到空输入 —— 现在放行等于把空画面当成死素材存下来并发出去。
      // 所以档位判定(`snapshotTier`)认 `sourceDependent`,`cacheable` 不认;
      // 第 4 步接上隔离工程的依赖链之后,把这里改成
      // `compositing === 'independent' || compositing === 'sourceDependent'`。
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
      // A3a 的共享快照键:和 `key`(CardFrameCache 的 PNG 键,带位置画幅和 clipId)
      // 是两回事 —— 这个剥掉片段身份、不含外观,同一张卡两个片段共用一份快照。
      // 普通卡没有上游,`inputKeys` 是 {};sourceDependent 的链路拼接在第 4 步接上。
      const snapshotKey = cardSnapshotIdentity(node ?? {}, {
        definition, style: this.project.style || {}, environment: value?.environment || {},
        sourceVersions: value?.sourceVersions || {}, inputKeys: {},
        fps: this.fps, sampling, duration: end - start,
        stage: { width: this.project.width, height: this.project.height, camera3dFov: this.project.camera3dFov },
        frame: output.frame, themeId: this.project.themeId,
        fontFingerprint: value?.environment?.fontFingerprint || '', freezeCode: freezeCode(),
      });
      controls.push({ key, snapshotKey, tier: snapshotTier(caps), capabilities: caps,
        clipId: output.clipId || node?.clipId, nodeId: output.nodeId, start, end, count, sampling, compositing, cacheable,
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
        if (await store.lookup(local, this.expected(control.key))) {
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
    await store.put(localFrame, png, { capture: this.capture() || undefined, scale: this.scale(), cards: key });
    return true;
  }
  async hasComplete(control) {
    const store = await this.store(control.key);
    const expected = this.expected(control.key);
    await store.hydrate(Array.from({ length: control.count }, (_, n) => n));
    for (let n = 0; n < control.count; n++) if (!store.valid(n, expected)) return false;
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
