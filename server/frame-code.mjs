import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const fingerprints = new Map();
const captures = new Map();
/** Code that decides which pixels a screenshot contains. A fix here (e.g. a
 * readiness wait or a stale-screenshot guard) must retire frames captured by
 * the old code, including card caches whose keys do not contain frameCode. */
const CAPTURE_FILES = ['scripts/export-frames.mjs', 'scripts/capture-frame.mjs', 'scripts/capture-snapshot.mjs', 'scripts/frame-media.mjs',
  'scripts/frame-ready.mjs', 'scripts/png-integrity.mjs'];
const hashFiles = (hash, root, files) => {
  for (const file of files) {
    hash.update(file);
    try { hash.update(fs.readFileSync(path.join(root, file))); } catch { hash.update('missing'); }
  }
};
export function invalidateFrameCode(root) { fingerprints.delete(root); captures.delete(root); }
export function frameCode(root) {
  if (fingerprints.has(root)) return fingerprints.get(root);
  const hash = createHash('sha256');
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (/\.(tsx?|mjs|css|json)$/.test(item.name)) { hash.update(path.relative(root, file).replaceAll('\\', '/')); hash.update(fs.readFileSync(file)); }
    }
  }
  walk(path.join(root, 'src'));
  hashFiles(hash, root, [...CAPTURE_FILES, 'server/frame-pipeline.mjs', 'server/frame-identity.mjs']);
  const value = hash.digest('hex'); fingerprints.set(root, value); return value;
}
export function captureCode(root) {
  if (captures.has(root)) return captures.get(root);
  const hash = createHash('sha256');
  hashFiles(hash, root, CAPTURE_FILES);
  const value = hash.digest('hex').slice(0, 32); captures.set(root, value); return value;
}
