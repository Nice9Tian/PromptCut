import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const fingerprints = new Map();
const captures = new Map();
const freezes = new Map();
/** server/ 的上一级 —— 仓库根,也是打包后的 runtime/app 根。freezeCode 只读源码,
 * 调用方(card-cache)手里只有缓存目录、拿不到仓库根时用它。 */
const APP_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
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
export function invalidateFrameCode(root) { fingerprints.delete(root); captures.delete(root); freezes.delete(root); }
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

/**
 * 冻结代码指纹 —— 共享快照键(A3a)里唯一一项「渲染器版本」。
 *
 * 只哈希 CAPTURE_FILES 里**和冻结有关**的两个:`export-frames.mjs`(`__bfFreeze`
 * 本体:内联计算样式、id 改名、canvas 转 img、按 data-pc-clip 切 control 子树)和
 * `capture-snapshot.mjs`(把冻好的 HTML 塞回文档栅格化);再加页面侧的
 * `src/render/snapshotFreeze.ts` / `src/render/snapshotRename.ts`。
 * 其余 CAPTURE_FILES(capture-frame / frame-media / frame-ready / png-integrity)
 * 决定的是**截图**,不决定快照 HTML 的内容,不进这个指纹。
 *
 * J1 联动(必须一起读):J1 把冻结逻辑从 export-frames.mjs 搬进 src/ 的那两个模块
 * 之后,**这里不再加文件** —— 集合已经把要搬进去的两个文件写死在里面了。于是:
 *   - 改冻结代码 ⇒ 指纹变 ⇒ 共享键变 ⇒ 旧快照自然失效,不会被错误复用;
 *   - 不改冻结代码 ⇒ 指纹不变 ⇒ 旧快照跨机器照常复用,搬家本身不作废任何快照。
 * 反例:直接用 `frameCode`(它哈希整个 src/ 加 frame-pipeline.mjs)的话,任何一次
 * 无关的卡片改动都会把全世界的共享快照冲掉,共享档就没有意义了。
 *
 * 缺文件按 `hashFiles` 的老规矩记 `'missing'`:snapshotFreeze / snapshotRename 还
 * 没落地时指纹是确定的,J1 落地那一刻变一次(本来就该变)。
 */
const FREEZE_FILES = ['scripts/export-frames.mjs', 'scripts/capture-snapshot.mjs',
  'src/render/snapshotFreeze.ts', 'src/render/snapshotRename.ts'];
export function freezeCode(root = APP_ROOT) {
  if (freezes.has(root)) return freezes.get(root);
  const hash = createHash('sha256');
  hashFiles(hash, root, FREEZE_FILES);
  const value = hash.digest('hex').slice(0, 32); freezes.set(root, value); return value;
}
