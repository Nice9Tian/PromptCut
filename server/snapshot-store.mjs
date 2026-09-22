import fs from 'node:fs/promises';
import path from 'node:path';
import { atomic } from './frame-mov.mjs';

/**
 * A3a 的 HTML 快照库。两层档案,目录形状是唯一的对外契约:
 *
 *   共享档(可上云):  <root>/controls-html/<共享键>/<localFrame>.html
 *   本地专用档(不上云):<root>/controls-local/<entry.key>/<共享键>/<localFrame>.html
 *
 * 本地档**两层目录**,不把两个键拼成一个名字 —— 换项目(entry.key 变)时整棵子树
 * 一起丢得掉,而共享键那一层在两种档里是同一个名字,将来要把某一份从本地档提升成
 * 共享档只是挪目录。
 *
 * 文件内容是**原始 UTF-8 HTML**。旧 `html-manifest.json` 的 base64(deflate) 不沿用:
 * 那个编码是为了把几万帧塞进一个 JSON 里,这里一帧一个文件,按需读盘、可 mmap、
 * 可直接被 HTTP 静态服务,再套一层编码只会让每次取快照都多一次解压。
 * 单帧体积上限按 A3c 的 300 KB 算(这里不强制,留给 A3c)。
 *
 * 每个 <共享键>/ 目录一份 index.json = { count, frames: [[from, to], …],
 * oversize?: [[from, to], …] }:`frames` 是已有**且合格**的本地帧闭区间、合并有序;
 * `oversize` 是 A3c 判超限、被丢掉的那些帧(R6-14:不记的话它们永远算「缺」,
 * 每趟后台预渲染都会把同一批帧重渲一遍再丢)。为什么不靠 readdir:一个键几千帧时
 * readdir + parse 比读一个小 JSON 慢得多,而「哪些帧已经有了」是播放调度每次
 * 都要问的问题。`fillCardControls` 每批写完更新一次(不是每帧),批大小 4。
 */

export const SHARED_DIR = 'controls-html';
export const LOCAL_DIR = 'controls-local';

/** 闭区间合并:接受帧号和区间混排,排序、去重、相邻(b + 1 === a)也并掉。 */
export function mergeRanges(ranges) {
  const parts = [];
  for (const value of ranges ?? []) {
    const [from, to] = Array.isArray(value) ? value : [value, value];
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) continue;
    parts.push([from, to]);
  }
  parts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [from, to] of parts) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

export const rangeCount = ranges => ranges.reduce((total, [from, to]) => total + (to - from + 1), 0);
export const rangeHas = (ranges, frame) => ranges.some(([from, to]) => frame >= from && frame <= to);

/**
 * 每个控件走哪一档(A3a)。输入是审阅表给的 capabilities
 * (`src/kernel/frameMode.mjs` 的 `cardCapabilities`,或 `cardGraph` 给合成节点
 * 写的那一份)。
 *
 *   共享档:审阅表 independent / sourceDependent **且** stateful —— canvas 卡同样
 *           按这个判据(它的快照里 [data-pc-gl-plane] 已转成 <img>,M4);
 *   本地档:其余 stateful,含 belowDependent 毛玻璃卡、需要整场景上下文的 context,
 *           **以及 unknown**(计划 3.1(2):真实项目里的定制卡和带部件的组合卡片段
 *           都是 unknown,底稿的「一律判重、没有死素材、只能透明」会让它们在播放和
 *           拖动时整片消失;改成一律按下层依赖卡 belowDependent 处理 —— 照测、照实测
 *           分派,判轻就活渲,判重用本地档快照,不上云、不进流);
 *   不预渲染:非 stateful 的轻卡(渲染 9:在所有位置都判轻的不产快照)。
 */
export function snapshotTier(capabilities) {
  const caps = capabilities ?? {};
  const stateful = caps.frameMode === 'stateful' || caps.need_prerendering === true || caps.needPrerendering === true;
  if (!stateful) return 'none';
  const compositing = caps.compositing || 'unknown';
  if (compositing === 'independent' || compositing === 'sourceDependent') return 'shared';
  return 'local';
}

/**
 * A3c 的单帧快照体积上限。超过它的那一帧**照常落盘**(下一次不用重渲),但
 * 不进就绪索引、不投递 —— 那一层按缺料处理(贴更早的合格快照,没有就透明),
 * 并记一条诊断(卡 id、字节数)。
 *
 * 两档:DOM 卡 300 KB;canvas 卡 1 MB —— 它的字节 84%～95% 是 `toDataURL` 出来的
 * 位图(`docs/snapshot-size-audit.md`),差异样式内联对它无效,按位图的那一档算。
 * 判据是审阅表的 `canvasHeavy`(`src/kernel/frameMode.mjs` 的 `cardCapabilities`)。
 */
export const DOM_SNAPSHOT_LIMIT = 300 * 1024;
export const CANVAS_SNAPSHOT_LIMIT = 1024 * 1024;
export function snapshotLimit(capabilities) {
  return capabilities?.canvasHeavy === true ? CANVAS_SNAPSHOT_LIMIT : DOM_SNAPSHOT_LIMIT;
}
/** 这一帧快照的字节数(UTF-8,和落盘的完全一致)。 */
export const snapshotBytes = html => Buffer.byteLength(String(html ?? ''), 'utf8');
/** 超限就返回 `{ bytes, limit }`,合格返回 null。 */
export function overSnapshotLimit(html, capabilities) {
  const bytes = snapshotBytes(html);
  const limit = snapshotLimit(capabilities);
  return bytes > limit ? { bytes, limit } : null;
}

/** 目录形状的唯一一处实现。`entryKey` 只有本地档要。 */
export function snapshotDir(root, { tier, entryKey, key }) {
  if (!key) throw new Error('Snapshot key is required');
  if (tier === 'shared') return path.join(root, SHARED_DIR, key);
  if (tier === 'local') {
    if (!entryKey) throw new Error('Local snapshots need an entry key');
    return path.join(root, LOCAL_DIR, entryKey, key);
  }
  throw new Error(`Unknown snapshot tier ${tier}`);
}

const frameFile = (dir, localFrame) => {
  if (!Number.isInteger(localFrame) || localFrame < 0) throw new Error(`Invalid local frame ${localFrame}`);
  return path.join(dir, `${localFrame}.html`);
};

const EMPTY = { count: 0, frames: [], oversize: [] };

/** 诊断环形缓冲的容量:超限帧是少数,留最近这么多条够看清是哪张卡 */
const OVERSIZE_LOG = 64;

export class SnapshotStore {
  constructor(root) {
    this.root = root;
    // 同一个键目录上的 index.json 串行读改写:一个键的多批次可能并发落盘,
    // 读-改-写之间插进另一批就会丢掉一段区间。
    this.chains = new Map();
    /** A3c 超限帧的诊断(最近 OVERSIZE_LOG 条):{ clipId, key, localFrame, bytes, limit } */
    this.oversize = [];
  }
  dir(target) { return snapshotDir(this.root, target); }

  /**
   * A3c 的通用兜底。返回 true = 这一帧合格、可以进就绪索引;false = 超限,
   * 已落盘但不进索引、不投递,并记一条诊断。
   */
  noteSnapshotSize({ clipId, key, localFrame, html, capabilities }) {
    const over = overSnapshotLimit(html, capabilities);
    if (!over) return true;
    const record = { clipId: clipId ?? null, key: key ?? null, localFrame, ...over, at: Date.now() };
    this.oversize.push(record);
    while (this.oversize.length > OVERSIZE_LOG) this.oversize.shift();
    console.warn(`[snapshot] 快照超限,不进就绪索引:卡 ${record.clipId ?? key} 本地帧 ${localFrame} ${record.bytes} 字节 > ${record.limit}`);
    return false;
  }

  /** 只写帧文件,不碰 index —— index 由 `updateIndex` 每批更新一次。 */
  async writeSnapshot({ tier, entryKey, key, localFrame, html }) {
    const dir = this.dir({ tier, entryKey, key });
    const file = frameFile(dir, localFrame);
    await fs.mkdir(dir, { recursive: true });
    await atomic(file, Buffer.from(String(html ?? ''), 'utf8'));
    return file;
  }

  /** 缺帧返回 null(不是抛):缺料那一层透明、播放头不停(渲染 7)。 */
  async readSnapshot({ tier, entryKey, key, localFrame }) {
    const file = frameFile(this.dir({ tier, entryKey, key }), localFrame);
    try { return await fs.readFile(file, 'utf8'); } catch { return null; }
  }

  async snapshotIndex({ tier, entryKey, key }) {
    const file = path.join(this.dir({ tier, entryKey, key }), 'index.json');
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      const frames = mergeRanges(value?.frames ?? []);
      const oversize = mergeRanges(value?.oversize ?? []);
      return { count: rangeCount(frames), frames, oversize };
    } catch { return { count: 0, frames: [], oversize: [] }; }
  }

  /**
   * 把这一批新帧并进 index.json。返回合并后的 index。
   *
   * `oversize` 是 A3c 里**超限被丢掉**的那些本地帧(R6-14)。它们不进 `frames`
   * (不就绪、不投递),但记在这里:缺帧是按 `frames` 算的,不记的话它们永远算「缺」,
   * 每一趟后台预渲染都会把同一批帧重渲一遍、再判超限、再丢掉。
   * 记下来之后下一趟直接跳过 —— 两张大 lottie 卡不用每趟整段重渲。
   * 帧文件照常在盘上(`writeSnapshot` 先写、判超限在后),所以这只是「别再白渲一次」。
   */
  async updateIndex({ tier, entryKey, key, frames, oversize }) {
    const dir = this.dir({ tier, entryKey, key });
    const chain = (this.chains.get(dir) || Promise.resolve()).catch(() => {}).then(async () => {
      const current = await this.snapshotIndex({ tier, entryKey, key });
      const merged = mergeRanges([...current.frames, ...(frames ?? [])]);
      const over = mergeRanges([...current.oversize, ...(oversize ?? [])]);
      const index = { count: rangeCount(merged), frames: merged, ...(over.length ? { oversize: over } : {}) };
      await fs.mkdir(dir, { recursive: true });
      await atomic(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(index), 'utf8'));
      return { ...index, oversize: over };
    });
    this.chains.set(dir, chain);
    return chain;
  }

  /** 按盘上实际的 <localFrame>.html 重建 index —— 修复用,不在热路径上。 */
  async rebuildIndex({ tier, entryKey, key }) {
    const dir = this.dir({ tier, entryKey, key });
    let names = [];
    try { names = await fs.readdir(dir); } catch { return { ...EMPTY }; }
    const frames = names.map(name => /^(\d+)\.html$/.exec(name)).filter(Boolean).map(match => Number(match[1]));
    const merged = mergeRanges(frames);
    // 超限名单从旧 index 里留着:盘上有帧文件不代表它合格(A3c 先写文件再判超限),
    // 丢了这份名单下一趟就会把那些帧再渲一遍、再判超限、再丢掉(R6-14)。
    const { oversize } = await this.snapshotIndex({ tier, entryKey, key });
    const index = { count: rangeCount(merged), frames: merged, ...(oversize.length ? { oversize } : {}) };
    await atomic(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(index), 'utf8'));
    return { ...index, oversize };
  }
}
