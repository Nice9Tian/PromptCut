/**
 * 本机暂存(浏览器本地缓存):断网期间的离线修改与待合并表的本机副本。
 *
 * 语义 `docs/semantics/workflow/project.md`「暂时离线项目与保存」、`mechanism/document-service.md`「保存基准与修改状态检查」:
 * 在线浏览器断网期间的改动落盘到浏览器本地缓存(`IndexedDB`,取不到时退到 `localStorage`);连上文档服务、
 * 存进该用户的待合并表之后,清掉对应的本机暂存。
 *
 * 键按「项目 × 用户」:`<类别>|<项目号>|<用户>`,类别 `journal`(DocSync 的离线批次)、`merge`(待合并表的本机副本与待发队列)。
 * 纯接口,存储由调用方注入(单测用 `src/testing/fakeIndexedDB.mjs` 或内存版)。
 */

export interface KvStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export type CacheKind = "journal" | "merge";

export const cacheKey = (kind: CacheKind, projectId: string, user: string): string => `${kind}|${projectId}|${user}`;

/** 三级数字:库名、表名 */
export const OFFLINE_DB = { name: "pc-offline", version: 1, store: "kv" } as const;

type IdbFactory = { open(name: string, version?: number): IDBOpenDBRequest };

/** IndexedDB 版:一个库一张表,`key` 是主键 */
export function idbStore(factory: IdbFactory): KvStore {
  let opening: Promise<IDBDatabase> | null = null;
  const db = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(OFFLINE_DB.name, OFFLINE_DB.version);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames?.contains?.(OFFLINE_DB.store)) d.createObjectStore(OFFLINE_DB.store, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error ?? new Error("IndexedDB 打不开")); };
  });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction([OFFLINE_DB.store], mode);
      const req = fn(tx.objectStore(OFFLINE_DB.store));
      let result: T;
      if (req) req.onsuccess = () => { result = req.result as T; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 写入失败"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 写入被中止"));
    });
  };
  return {
    async get(key) {
      const row = await run<{ key: string; value: unknown } | undefined>("readonly", (s) => s.get(key));
      return row?.value;
    },
    async put(key, value) { await run("readwrite", (s) => s.put({ key, value })); },
    async delete(key) { await run("readwrite", (s) => s.delete(key)); },
  };
}

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** localStorage 版(取不到 IndexedDB 时) */
export function storageStore(storage: StorageLike, prefix = "pc.offline."): KvStore {
  return {
    async get(key) {
      const raw = storage.getItem(prefix + key);
      return raw == null ? undefined : JSON.parse(raw);
    },
    async put(key, value) { storage.setItem(prefix + key, JSON.stringify(value)); },
    async delete(key) { storage.removeItem(prefix + key); },
  };
}

/** 内存版(没有任何浏览器存储时;关页面就没) */
export function memoryStore(): KvStore & { readonly size: number } {
  const m = new Map<string, string>();
  return {
    async get(key) { const raw = m.get(key); return raw === undefined ? undefined : JSON.parse(raw); },
    async put(key, value) { m.set(key, JSON.stringify(value)); },
    async delete(key) { m.delete(key); },
    get size() { return m.size; },
  };
}

/** 页面缺省用的那一份:IndexedDB → localStorage → 内存 */
let shared: KvStore | null = null;
export function defaultStore(): KvStore {
  if (shared) return shared;
  const g = globalThis as { indexedDB?: IdbFactory; localStorage?: StorageLike };
  try { if (g.indexedDB) return (shared = idbStore(g.indexedDB)); } catch { /* 下一种 */ }
  try { if (g.localStorage) return (shared = storageStore(g.localStorage)); } catch { /* 下一种 */ }
  return (shared = memoryStore());
}

/** 单测换存储 */
export function setDefaultStore(s: KvStore | null): void {
  shared = s;
}
