import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const fingerprints = new Map();
export function invalidateFrameCode(root) { fingerprints.delete(root); }
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
  for (const file of ['scripts/export-frames.mjs', 'scripts/capture-snapshot.mjs', 'scripts/frame-media.mjs', 'server/frame-pipeline.mjs', 'server/frame-identity.mjs']) hash.update(fs.readFileSync(path.join(root, file)));
  const value = hash.digest('hex'); fingerprints.set(root, value); return value;
}
