/** Time evaluation is independent of the component framework.
 * direct: evaluate the requested time without replaying earlier frames.
 * stateful: retain Motion/CSS/rAF/simulation history.
 */
export function normalizeFrameMode(mode) {
  // Existing .proc files may embed card source using the old names.
  if (mode === 'direct' || mode === 'react') return 'direct';
  if (mode === 'stateful' || mode === 'non-react') return 'stateful';
  return undefined;
}
export function cardFrameMode(def, params = def?.defaults || {}) {
  const declared = normalizeFrameMode(def?.frameMode);
  if (declared) return declared;
  try {
    const timing = { ...def?.lifecycle, ...def?.timing?.(params) };
    // Compatibility for static cards embedded in existing .proc files,
    // including the paper texture: no need to rewrite their source/file.
    if (timing.after === 'hold' && timing.settleMs === 0) return 'direct';
  } catch { /* Unknown/broken declarations must retain full history. */ }
  return 'stateful';
}
export function clipFrameMode(clip, def) {
  if (clip.parts?.length) return 'stateful';
  return cardFrameMode(def, { ...def?.defaults, ...clip.params });
}
