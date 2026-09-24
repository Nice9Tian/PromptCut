/**
 * 素材服务的数据层出口（契约 `docs/plan/asset-store-contract.md` 第 2 节）。
 *
 * - `kind: 'fs'`     → 本地内容库（`fs-store.mjs`）
 * - `kind: 'memory'` → 内存（`memory-store.mjs`，测试用）
 * - `kind: 'oss'`    → 插槽：抛 Error，`code === 'not-implemented'`，不装任何 SDK
 * - 其它             → TypeError
 *
 * 接口写在 `blob-store.mjs` 的 JSDoc 里。本目录只引 Node 内置模块。
 */
import { createFsStore } from './fs-store.mjs';
import { createMemoryStore } from './memory-store.mjs';
import { BLOB_CHUNK_SIZE } from './blob-store.mjs';

export { BLOB_CHUNK_SIZE, createFsStore, createMemoryStore };

/**
 * @param {{ kind: 'fs' | 'memory' | 'oss' } & Record<string, any>} options
 * @returns {import('./blob-store.mjs').BlobStore}
 */
export function createBlobStore(options) {
  const kind = options?.kind;
  if (kind === 'fs') return createFsStore(options);
  if (kind === 'memory') return createMemoryStore(options);
  if (kind === 'oss') {
    const err = new Error('createBlobStore：oss 实现还没有（只留插槽）');
    /** @type {any} */ (err).code = 'not-implemented';
    throw err;
  }
  throw new TypeError(`createBlobStore：不认识的 kind ${JSON.stringify(kind)}`);
}
