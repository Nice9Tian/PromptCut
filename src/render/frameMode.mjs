/** Time evaluation is independent of the component framework.
 * direct: evaluate the requested time without replaying earlier frames.
 * stateful: retain Motion/CSS/rAF/simulation history.
 */
export function normalizeFrameMode(mode) {
  // Framework labels in embedded .proc source are accepted, but do not
  // establish random-access capability. Replay preserves their old output.
  if (mode === 'direct') return 'direct';
  if (mode === 'stateful' || mode === 'non-react' || mode === 'react') return 'stateful';
  return undefined;
}
export function cardFrameMode(def, params = def?.defaults || {}) {
  if (!def?._derivedPrerendering && def?.need_prerendering === true) return 'stateful';
  const declared = normalizeFrameMode(def?.frameMode);
  // Conflicting declarations retain history rather than silently skipping it.
  if (declared === 'stateful' && def?.frameMode !== 'react') return 'stateful';
  if (!def?._derivedPrerendering && def?.need_prerendering === false) return 'direct';
  if (declared) return declared;
  try {
    const timing = { ...def?.lifecycle, ...def?.timing?.(params) };
    // Compatibility for static cards embedded in existing .proc files,
    // including the paper texture: no need to rewrite their source/file.
    if (timing.after === 'hold' && timing.settleMs === 0) return 'direct';
  } catch { /* Unknown/broken declarations must retain full history. */ }
  return 'stateful';
}

/** Scheduling and compositing are independent capabilities. A stateful glass
 * card needs prerendering in its scene, never an isolated transparent movie.
 * Independence is an explicit, reviewed declaration, not a source-code guess.
 */
export function cardCapabilities(def, params = def?.defaults || {}) {
  const frameMode = cardFrameMode(def, params);
  const compositing = ['independent', 'context'].includes(def?.compositing) ? def.compositing : 'unknown';
  return { frameMode, need_prerendering: frameMode === 'stateful', compositing,
    independentCache: compositing === 'independent' };
}
export function clipFrameMode(clip, def) {
  if (clip.parts?.length) return 'stateful';
  return cardFrameMode(def, { ...def?.defaults, ...clip.params });
}
