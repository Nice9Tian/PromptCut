import path from 'node:path';

/** Resolve only the durable local forms used by the frame/card pipeline.
 * `cacheRoot` is normally <out>/frame-library, so its parent is the export
 * root containing media/ and export-<id>/media/. Non-local URLs return null. */
export function cardMediaPath(media, cacheRoot) {
  if (!media) return null;
  if (media.path) return String(media.path);
  const url = String(media.url || '');
  if (url.startsWith('/api/media/file?')) {
    try { return new URL(url, 'http://localhost').searchParams.get('path'); } catch { return null; }
  }
  const out = process.env.PROMPTCUT_EXPORT_DIR || path.dirname(cacheRoot);
  if (url.startsWith('/@media/')) return path.join(process.env.PROMPTCUT_MEDIA_DIR || path.join(out, 'media'), decodeURIComponent(url.slice('/@media/'.length).split('?')[0]));
  if (url.startsWith('/@export/')) {
    const relative = decodeURIComponent(url.slice('/@export/'.length).split('?')[0]);
    const match = /^([^/]+)\/media\/(.+)$/.exec(relative);
    if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..')) return null;
    const file = path.resolve(out, `export-${match[1]}/media/${match[2]}`);
    const base = path.resolve(out, `export-${match[1]}/media`);
    return file.startsWith(base + path.sep) || file === base ? file : null;
  }
  return null;
}
