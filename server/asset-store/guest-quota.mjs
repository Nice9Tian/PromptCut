/**
 * 游客素材限额在素材服务上的接线（2026-10-23 用户定；数和判断函数在 `server/account/guest.mjs`）。
 *
 * 游客（编号 `gst_` 开头）往 `media` 命名空间传素材：最多 `GUEST_LIMITS.assets` 条，每条不超过 `assetBytes`。
 * 账号、本机回环来源、托管方服务一律不经这里。`snap`、`px` 是预渲染产物，不是用户传的素材，也不经这里。
 *
 * **「已经存了几条」怎么数**：问数据层的 `usage()`（`BlobStore` 接口里本来就有，fs、memory 两种实现都有），
 * 当场数，不另记账：
 * - `blobs` 是已入库的全件数（按哈希去重），`staging` 是收了一半的哈希数；
 * - 开一个**新的**暂存（这个哈希既没入库、也没在收）时数 `blobs + staging`：不然游客可以同时开任意多个
 *   100 MB 的暂存、一个都不收尾，把盘占满；
 * - 收尾时只数 `blobs`（这一条自己还在暂存里，不算）。
 * 不用 `service-usage.mjs` 那本账：它只记托管方渲染服务的产物，而且是另一份要和数据层对齐的状态；
 * 删掉一条、三天清理删掉整个项目，数据层当场就少了，这里下一次数自然跟着变，不会对不上。
 *
 * 云端托管下每个项目一个独立的数据层（`project-stores.mjs`），游客自己只能建一个项目、进别人的项目只读、
 * 写不进去，所以「这个项目的 `media` 有几条」就是「这个游客传了几条」。
 *
 * **并发**：数和写之间有空档，两路同时开新暂存、或者同时收尾，都可能各自看到「还差一条」而一起放进去。
 * 所以游客的「数 + 开新暂存的第一片」「数 + 收尾」「数 + 整件上传」在同一个项目里排队做（`serialize`），
 * 账号的写入不排这个队。
 *
 * 只引 Node 内置模块与 `../account/guest.mjs`（它只引 `node:crypto` 和同目录的 `client.mjs`）。
 */
import { checkGuestAsset, guestIdOfUserId, isGuestId, GUEST_LIMITS } from '../account/guest.mjs';

export { GUEST_LIMITS, guestIdOfUserId };

/** 这次写入要不要按游客限额管：只管游客往 `media` 写 */
export const guestQuotaApplies = (accountId, ns) => ns === 'media' && isGuestId(accountId);

const DENY = code => ({ ok: false, status: 403, error: code });

/**
 * 一个素材服务中间件一份：里面只有按项目排队用的锁。
 * `key` 是「同一个数据层」的标识：托管下是项目编号，本机是那个数据层对象本身。
 */
export function createGuestAssetQuota() {
  /** @type {Map<unknown, Promise<unknown>>} */
  const tails = new Map();
  function serialize(key, task) {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(() => {}, () => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  }
  /** 占住这个数据层的游客队，回放锁函数。占到的时候，之前排队的都做完了 */
  function acquire(key) {
    return new Promise(resolveAcquired => {
      void serialize(key, () => new Promise(release => resolveAcquired(release)));
    });
  }

  const countOf = async (store, { withStaging }) => {
    const u = await store.usage();
    return (u?.blobs ?? 0) + (withStaging ? (u?.staging ?? 0) : 0);
  };

  return {
    acquire,

    /**
     * `PUT media/<hash>/<n>`：先看尺寸（`X-Media-Size`，每一片都带），再看是不是要开一个新的暂存。
     * 已入库（去重，数据层回 complete）或这个哈希已经在收（续传、乱序的后几片）都不算新的一条。
     * 要开新暂存时在队里数完再写这一片，写完才放队。
     *
     * @param {{ accountId?: string, ns: string, size: number, hash: string, store: any, key: unknown }} who
     * @param {() => Promise<void>} put 真正写这一片（回包也在里面）
     * @param {(denied: { status: number, error: string }) => void} deny
     */
    async putChunk({ accountId, ns, size, hash, store, key }, put, deny) {
      if (!guestQuotaApplies(accountId, ns)) return put();
      const sized = checkGuestAsset({ accountId, bytes: size, storedCount: 0 });
      if (!sized.ok) return deny(DENY(sized.code));
      const known = await store.chunks(hash);
      if (known.complete || known.size !== null) return put();
      const release = await acquire(key);
      try {
        const again = await store.chunks(hash);
        if (!again.complete && again.size === null) {
          const verdict = checkGuestAsset({ accountId, bytes: size, storedCount: await countOf(store, { withStaging: true }) });
          if (!verdict.ok) return deny(DENY(verdict.code));
        }
        return await put();
      } finally { release(); }
    },

    /**
     * `POST media/<hash>/complete`：在队里数已入库的条数（这一条还在暂存，不算），够了就不收尾，暂存留着
     * （删掉一条之后再收尾就能进去）。已入库的再收尾一次照旧放行。
     *
     * @param {{ accountId?: string, ns: string, hash: string, store: any, key: unknown }} who
     * @param {() => Promise<void>} complete
     * @param {(denied: { status: number, error: string }) => void} deny
     */
    async complete({ accountId, ns, hash, store, key }, complete, deny) {
      if (!guestQuotaApplies(accountId, ns)) return complete();
      const release = await acquire(key);
      try {
        const known = await store.chunks(hash);
        if (!known.complete && known.size !== null) {
          const verdict = checkGuestAsset({ accountId, bytes: known.size, storedCount: await countOf(store, { withStaging: false }) });
          if (!verdict.ok) return deny(DENY(verdict.code));
        }
        return await complete();
      } finally { release(); }
    },

    /**
     * 整件上传（`POST /api/media/upload/<名>`、`POST /api/media/adopt`，托管下也挂着）：
     * 内容哈希要读完才知道，所以只能按「再多一条」算，已存满就拒（哪怕传的是一份已有的）。
     * 尺寸看 `Content-Length`（Node 不会多收），整件上传没带它的游客请求回 411。
     * 放行时回放锁函数，调用方占到回完包再放；拒了回 `{ status, error }`。
     *
     * @param {{ accountId?: string, bytes: number | null, store: any, key: unknown, needsLength: boolean }} who
     * @returns {Promise<{ ok: true, release: () => void } | { ok: false, status: number, error: string }>}
     */
    async whole({ accountId, bytes, store, key, needsLength }) {
      if (!guestQuotaApplies(accountId, 'media')) return { ok: true, release: () => {} };
      if (needsLength && bytes === null) return { ok: false, status: 411, error: 'length-required' };
      if (bytes !== null) {
        const sized = checkGuestAsset({ accountId, bytes, storedCount: 0 });
        if (!sized.ok) return DENY(sized.code);
      }
      const release = await acquire(key);
      try {
        const verdict = checkGuestAsset({ accountId, bytes: bytes ?? 0, storedCount: await countOf(store, { withStaging: true }) });
        if (!verdict.ok) { release(); return DENY(verdict.code); }
        return { ok: true, release };
      } catch (error) { release(); throw error; }
    },
  };
}
