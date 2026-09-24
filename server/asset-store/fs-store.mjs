/**
 * `BlobStore` 的 fs 实现：本地内容库（契约 `docs/plan/asset-store-contract.md` 第 2 节）。
 *
 * 目录布局与第 5 步（原来写在 `server/asset-service.ts` 里的那一版）逐字节一致：
 * - 全件：`<dir>/<hash>.<ext>`，没有扩展名就是 `<dir>/<hash>`；
 * - 暂存：`<dir>/.chunks/<hash>/`，里面是 `meta.json`（size、ext）、`data`（按偏移原位写的全件）、
 *   `<n>.ok`（这一片完整落盘的标记）。
 * 写一片之前先删它的标记，写完、长度对了才补上 —— 断电、断线、写到一半失败都只会让这一片算「没收到」。
 * 收尾时只读一遍 `data` 算哈希，再直接改名成全件，不再拷一遍。
 *
 * 本模块不引 `vite-plugin-media.ts`：找已入库文件（兼容老的整件导入）、入库后写媒体索引、
 * 扩展名到 Content-Type 都经调用方注入的 `hooks`。只引 Node 内置模块。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BLOB_CHUNK_SIZE, normalizeHash, normalizeExt, checkChunkArgs, chunkCountOf, chunkLengthOf,
  extOfName, createKeyedLock, drainSource, toBuffer, minimalContentType,
} from './blob-store.mjs';

/**
 * 同一个目录可能被多个 store 实例同时管（比如中间件建了两次），锁按「目录 + 哈希」放在模块级，
 * 保证同一哈希的登记与收尾在整个进程里串行。
 */
const withLock = createKeyedLock();

const HASH_FILE = /^([0-9a-f]{64})(?:\.[a-z0-9]+)?$/i;

async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

/**
 * @param {object} options
 * @param {string} options.dir  本地内容库目录（`mediaDir(root)`）
 * @param {object} [options.hooks]
 * @param {(hash: string) => Promise<string | null>} [options.hooks.resolveFile]  找已入库的文件；缺省在 `dir` 里按文件名找
 * @param {(entry: { hash: string, file: string, ext: string, size: number, contentType: string }) => (void | Promise<void>)} [options.hooks.onStored]  入库后写媒体索引
 * @param {(ext: string) => string} [options.hooks.contentTypeForExt]
 * @param {number} [options.chunkSize]  缺省 8 MiB
 * @returns {import('./blob-store.mjs').BlobStore}
 */
export function createFsStore({ dir, hooks = {}, chunkSize = BLOB_CHUNK_SIZE } = /** @type {any} */ ({})) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createFsStore：dir 必须是非空字符串');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('createFsStore：chunkSize 必须是正整数');
  const base = path.resolve(dir);
  const contentTypeForExt = typeof hooks.contentTypeForExt === 'function' ? hooks.contentTypeForExt : minimalContentType;
  const onStored = typeof hooks.onStored === 'function' ? hooks.onStored : () => {};
  const resolveFile = typeof hooks.resolveFile === 'function' ? hooks.resolveFile : scanFile;

  /** 缺省的 resolveFile：`<hash>` 或 `<hash>.<ext>` */
  async function scanFile(hash) {
    let names = [];
    try { names = await fs.readdir(base); } catch { return null; }
    const hit = names.find((n) => n.toLowerCase() === hash || n.toLowerCase().startsWith(hash + '.'));
    return hit ? path.join(base, hit) : null;
  }

  const lockKey = (hash) => `${base}\0${hash}`;
  const stagingDir = (hash) => path.join(base, '.chunks', hash);

  async function readMeta(hash) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(stagingDir(hash), 'meta.json'), 'utf8'));
      if (Number.isSafeInteger(raw?.size) && raw.size > 0) return { size: raw.size, ext: String(raw.ext || '') };
    } catch { /* 没有暂存 */ }
    return null;
  }

  async function writeMeta(hash, meta) {
    const d = stagingDir(hash);
    await fs.mkdir(d, { recursive: true });
    const tmp = path.join(d, `meta.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(meta));
    await fs.rename(tmp, path.join(d, 'meta.json'));
  }

  async function receivedChunks(hash, meta) {
    const count = chunkCountOf(meta.size, chunkSize);
    let names = [];
    try { names = await fs.readdir(stagingDir(hash)); } catch { return []; }
    const out = [];
    for (const name of names) {
      const m = /^(\d+)\.ok$/.exec(name);
      if (m) { const n = Number(m[1]); if (n < count) out.push(n); }
    }
    return out.sort((a, b) => a - b);
  }

  /** 已入库的全件：{ file, size } 或 null */
  async function stored(hash) {
    const file = await resolveFile(hash);
    if (!file) return null;
    try {
      const st = await fs.stat(file);
      return { file, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  return {
    kind: 'fs',
    chunkSize,

    async stat(hash) {
      const key = normalizeHash(hash);
      const done = await stored(key);
      if (!done) return null;
      const ext = extOfName(done.file);
      return { size: done.size, ext, contentType: contentTypeForExt(ext), mtimeMs: done.mtimeMs };
    },

    async read(hash, { start, end } = {}) {
      const key = normalizeHash(hash);
      const done = await stored(key);
      if (!done) return null;
      if (start === undefined && end === undefined) return createReadStream(done.file);
      return createReadStream(done.file, { start: start ?? 0, end: end ?? Math.max(0, done.size - 1) });
    },

    async chunks(hash) {
      const key = normalizeHash(hash);
      const done = await stored(key);
      if (done) {
        const count = chunkCountOf(done.size, chunkSize);
        return { size: done.size, chunkSize, received: Array.from({ length: count }, (_, i) => i), complete: true };
      }
      const meta = await readMeta(key);
      if (!meta) return { size: null, chunkSize, received: [], complete: false };
      return { size: meta.size, chunkSize, received: await receivedChunks(key, meta), complete: false };
    },

    async putChunk(hash, n, { size, ext } = /** @type {any} */ ({}), source) {
      const key = normalizeHash(hash);
      checkChunkArgs(n, size);
      const wantExt = normalizeExt(ext);
      const count = chunkCountOf(size, chunkSize);
      if (n >= count) return { status: 'out-of-range', count };
      const expected = chunkLengthOf(size, n, chunkSize);

      // 登记（串行）：已入库就幂等放过；size 对不上拒掉；先删这一片的标记，写完再补
      const pre = await withLock(lockKey(key), async () => {
        if (await resolveFile(key)) return 'complete';
        const meta = await readMeta(key);
        if (meta && meta.size !== size) return { conflict: meta.size };
        if (!meta || (!meta.ext && wantExt)) await writeMeta(key, { size, ext: meta?.ext || wantExt });
        const d = stagingDir(key);
        await fs.rm(path.join(d, `${n}.ok`), { force: true });
        // data 不存在就建一个空的；已经存在的不截断（别的片可能已经写进去了）
        await (await fs.open(path.join(d, 'data'), 'a')).close();
        return 'ok';
      });
      if (pre === 'complete') { await drainSource(source); return { status: 'complete' }; }
      if (typeof pre === 'object') return { status: 'size-mismatch', size: pre.conflict };

      const d = stagingDir(key);
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          // 超长的部分不写（免得写进下一片的位置），读完再按长度判
          const buf = toBuffer(chunk);
          const room = expected - bytes;
          bytes += buf.length;
          if (room <= 0) return cb();
          cb(null, buf.length > room ? buf.subarray(0, room) : buf);
        },
      });
      // r+：原位写，不截断别的片已经写进去的字节。pipeline 等到文件句柄关掉才返回；
      // 出错（断线等）原样抛给调用方，这一片的标记没补，对账时报「没收到」
      await pipeline(source, counter, createWriteStream(path.join(d, 'data'), { flags: 'r+', start: n * chunkSize }));
      if (bytes !== expected) return { status: 'length', expected, got: bytes };
      // 标记落在暂存目录里；这期间要是被收尾丢弃了，目录不在，标记也就不写
      try { await fs.writeFile(path.join(d, `${n}.ok`), ''); }
      catch { return { status: 'discarded' }; }
      return { status: 'ok', bytes };
    },

    async complete(hash) {
      const key = normalizeHash(hash);
      return withLock(lockKey(key), async () => {
        const done = await stored(key);
        if (done) return { status: 'ok', size: done.size, ext: extOfName(done.file) };
        const meta = await readMeta(key);
        if (!meta) return { status: 'unknown' };
        const received = new Set(await receivedChunks(key, meta));
        const missing = [];
        for (let i = 0; i < chunkCountOf(meta.size, chunkSize); i++) if (!received.has(i)) missing.push(i);
        if (missing.length) return { status: 'incomplete', missing };

        const d = stagingDir(key);
        const data = path.join(d, 'data');
        const digest = crypto.createHash('sha256');
        // 句柄在 pipeline 返回前就关了，下面才能改名（Windows 上开着的文件改不了名）
        await pipeline(createReadStream(data, { start: 0, end: meta.size - 1 }), digest);
        const actual = digest.digest('hex');
        if (actual !== key) {
          await fs.rm(d, { recursive: true, force: true });
          return { status: 'hash-mismatch', actual };
        }
        // 原位写的 data 不会比 size 长（每片长度都校验过），保险起见还是截一下
        await fs.truncate(data, meta.size);
        const file = meta.ext ? `${key}.${meta.ext}` : key;
        await fs.rename(data, path.join(base, file));
        await fs.rm(d, { recursive: true, force: true });
        await onStored({ hash: key, file, ext: meta.ext, size: meta.size, contentType: contentTypeForExt(meta.ext) });
        return { status: 'ok', size: meta.size, ext: meta.ext };
      });
    },

    async remove(hash) {
      const key = normalizeHash(hash);
      return withLock(lockKey(key), async () => {
        let removed = false;
        const file = await resolveFile(key);
        if (file) {
          try { await fs.rm(file); removed = true; } catch { /* 已经不在 */ }
        }
        const d = stagingDir(key);
        if (await exists(d)) {
          await fs.rm(d, { recursive: true, force: true });
          removed = true;
        }
        return removed;
      });
    },

    async usage() {
      const sizes = new Map();
      let entries = [];
      try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { /* 目录还不存在 */ }
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const m = HASH_FILE.exec(ent.name);
        if (!m) continue;
        const key = m[1].toLowerCase();
        if (sizes.has(key)) continue;
        try { sizes.set(key, (await fs.stat(path.join(base, ent.name))).size); } catch { /* 刚被删 */ }
      }
      let staging = 0;
      let dirs = [];
      try { dirs = await fs.readdir(path.join(base, '.chunks'), { withFileTypes: true }); } catch { /* 没有暂存 */ }
      for (const ent of dirs) if (ent.isDirectory() && /^[0-9a-f]{64}$/.test(ent.name)) staging++;
      let bytes = 0;
      for (const v of sizes.values()) bytes += v;
      return { blobs: sizes.size, bytes, staging };
    },
  };
}
