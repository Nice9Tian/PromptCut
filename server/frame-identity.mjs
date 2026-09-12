import { createHash } from 'node:crypto';
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stableJson(value)).digest('hex');
/** Audio, UI state and other cuts do not change this cut's pixels. */
export function frameIdentity(project, code = '') {
  const { width, height, fps, duration, themeId, camera3dFov, tracks, media, filters, pixelMaps } = project;
  // v3: direct React subtitles compute their transitions from local time.
  // Old HTML/MOV entries must not retain the previous Motion-based phase.
  return digest({ pipeline: 3, code, width, height, fps, duration, themeId, camera3dFov, tracks, media, filters, pixelMaps });
}
export function trackPrefixes(project, code = '') {
  return [...project.tracks].reverse().filter(t => !t.hidden).map((track, i, bottomUp) => {
    const tracks = bottomUp.slice(0, i + 1).reverse();
    const mediaIds = new Set(tracks.flatMap(t => t.clips.map(c => c.mediaId).filter(Boolean)));
    const subset = { ...project, tracks, media: project.media.filter(m => mediaIds.has(m.id)) };
    return { trackId: track.id, trackIds: tracks.map(t => t.id), key: frameIdentity(subset, code) };
  });
}
