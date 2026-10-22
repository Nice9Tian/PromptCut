/**
 * 游客素材限额在素材服务上的接线（2026-10-23 用户定；数和判断函数在 `server/account/guest.mjs`）。
 *
 * 用户的口径：「每一条源文件不能大于100M。总视频素材不能大于三条。」所以分两条管游客往 `media` 写的东西：
 * - **尺寸**：传上来的每一个文件（视频、图片、音频、小档）都不超过 `GUEST_LIMITS.assetBytes`；
 * - **条数**：只数**视频的原尺寸档**，最多 `GUEST_LIMITS.videos` 条。在线编辑器传一个视频会传两个文件
 *   （小档预览和原尺寸，`src/online/mediaUploadQueue.ts`），小档是系统生成的代理，不占额；图片、音频不计数。
 * 账号、本机回环来源、托管方服务一律不经这里。`snap`、`px` 是预渲染产物，不是用户传的素材，也不经这里。
 *
 * **怎么认出是视频**：看扩展名，经调用方注入的 `isVideoExt`（`asset-service.ts` 用 `vite-plugin-media.ts`
 * 的 `contentTypeForExt`，`video/*` 就是视频），这里不另写一张表。分片上传每一片带 `X-Media-Ext`，
 * 数据层以最先登记的非空值为准、入库后写在文件名上；整件上传从文件名拿。
 *
 * **怎么认出是哪一档**：页面在每一片上带 `X-Media-Tier: small | original`。**失败闭合**：头缺失、拼错、
 * 不认识的值一律当 `original`，也就是计数（`blob-store.mjs` 的 `normalizeTier`）；同一个哈希只要有一片没说
 * `small`，这一条就记成 `original`，不会反过来。
 *
 * **这两样都是页面说的**：游客可以把原件标成 `small`、把视频的扩展名报成 `jpg` 来绕过条数。可以接受，因为
 * 按用户的口径图片、音频本来就不计数，绕过去得到的也只是「多传几个不超过 100 MB 的文件」；真正的兜底是
 * 领令牌的 IP 限流、一个游客只能建一个项目、三天清理。尺寸那一条不靠页面说：分片时看 `X-Media-Size`，
 * 数据层按它校验每一片的长度、收尾时核哈希，报小了收不齐。
 *
 * **「已经存了几条视频原件」怎么数**：问数据层的 `inventory()`（`BlobStore` 接口，fs、memory 两种实现都有），
 * 当场数，不另记账。档位由数据层跟着哈希一起存（暂存里记在登记信息上，入库后记在全件旁边，删的时候一起删，
 * 见 `blob-store.mjs`「档位」），所以删掉一条、三天清理删掉整个项目，下一次数自然跟着变，不会对不上：
 * - 开一个**新的**暂存（这个哈希既没入库、也没在收）且它算数时，数「已入库的 + 正在收的」算数条数：
 *   不然游客可以同时开任意多个视频原件的暂存、一个都不收尾；
 * - 收尾时只数已入库的（这一条自己还在暂存里，不算），这一条算不算按数据层登记的扩展名和档位判
 *   （不按收尾请求说的，收尾请求不带这两样）。收尾是真正的闸门：先报 `small` 开了暂存、后面的片改报
 *   `original`，数据层会改记成原尺寸，到这里照样数进去；
 * - 不算数的（图片、音频、小档）只查尺寸。它们不限条数，所以也不限同时开几个暂存。
 * 不用 `service-usage.mjs` 那本账：它只记托管方渲染服务的产物，而且是另一份要和数据层对齐的状态。
 *
 * 云端托管下每个项目一个独立的数据层（`project-stores.mjs`），游客自己只能建一个项目、进别人的项目只读、
 * 写不进去，所以「这个项目的 `media` 有几条视频原件」就是「这个游客传了几条」。
 *
 * **并发**：数和写之间有空档，两路同时开新暂存、或者同时收尾，都可能各自看到「还差一条」而一起放进去。
 * 所以游客的「数 + 开新暂存的第一片」「数 + 收尾」「数 + 整件上传」在同一个项目里排队做（`serialize`），
 * 账号的写入不排这个队。
 *
 * 只引 Node 内置模块与 `../account/guest.mjs`（它只引 `node:crypto` 和同目录的 `client.mjs`）。
 */
import { checkGuestAsset, guestIdOfUserId, isGuestId, GUEST_LIMITS } from '../account/guest.mjs';
import { normalizeTier } from './blob-store.mjs';

export { GUEST_LIMITS, guestIdOfUserId };

/** 这次写入要不要按游客限额管：只管游客往 `media` 写 */
export const guestQuotaApplies = (accountId, ns) => ns === 'media' && isGuestId(accountId);

const DENY = code => ({ ok: false, status: 403, error: code });

/**
 * 一个素材服务中间件一份：里面只有按项目排队用的锁。
 * `key` 是「同一个数据层」的标识：托管下是项目编号，本机是那个数据层对象本身。
 *
 * @param {{ isVideoExt: (ext: string) => boolean }} options
 *   `isVideoExt`：这个扩展名（不含点、小写）是不是视频。必须给：缺了就等于「没有一样算视频」，条数限额整个落空
 */
export function createGuestAssetQuota({ isVideoExt } = /** @type {any} */ ({})) {
  if (typeof isVideoExt !== 'function') throw new TypeError('createGuestAssetQuota：要传 isVideoExt');
  /** 这一条算不算一条视频：视频扩展名、且不是小档 */
  const counts = ({ ext, tier }) => !!isVideoExt(String(ext || '').toLowerCase().replace(/^\./, '')) && normalizeTier(tier) !== 'small';

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

  /** 已入库（`withStaging` 时连正在收的）算数的视频有几条 */
  const videosOf = async (store, { withStaging }) => {
    const inv = await store.inventory();
    let n = 0;
    for (const e of inv?.stored ?? []) if (counts(e)) n++;
    if (withStaging) for (const e of inv?.staging ?? []) if (counts(e)) n++;
    return n;
  };

  return {
    acquire,

    /**
     * `PUT media/<hash>/<n>`：先看尺寸（`X-Media-Size`，每一片都带，不管什么类型），再看是不是要开一个
     * 新的、算数的暂存。已入库（去重，数据层回 complete）或这个哈希已经在收（续传、乱序的后几片）都不算
     * 新的一条；不算数的（图片、音频、小档）不数。要数时在队里数完再写这一片，写完才放队。
     *
     * @param {{ accountId?: string, ns: string, size: number, hash: string, ext?: string, tier?: string, store: any, key: unknown }} who
     *   `ext`、`tier` 是这一片的 `X-Media-Ext`、`X-Media-Tier`
     * @param {() => Promise<void>} put 真正写这一片（回包也在里面）
     * @param {(denied: { status: number, error: string }) => void} deny
     */
    async putChunk({ accountId, ns, size, hash, ext, tier, store, key }, put, deny) {
      if (!guestQuotaApplies(accountId, ns)) return put();
      const sized = checkGuestAsset({ accountId, bytes: size });
      if (!sized.ok) return deny(DENY(sized.code));
      if (!counts({ ext, tier })) return put();
      const known = await store.chunks(hash);
      if (known.complete || known.size !== null) return put();
      const release = await acquire(key);
      try {
        const again = await store.chunks(hash);
        if (!again.complete && again.size === null) {
          const verdict = checkGuestAsset({ accountId, bytes: size, countsAsVideo: true, storedVideos: await videosOf(store, { withStaging: true }) });
          if (!verdict.ok) return deny(DENY(verdict.code));
        }
        return await put();
      } finally { release(); }
    },

    /**
     * `POST media/<hash>/complete`：这一条算不算数按数据层登记的扩展名和档位判；算数的在队里数已入库的
     * 条数（这一条还在暂存，不算），够了就不收尾，暂存留着（删掉一条之后再收尾就能进去）。
     * 暂存里找不到这一条的登记（刚好被别处删了之类）按算数办。已入库的再收尾一次照旧放行。
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
          const inv = await store.inventory();
          const mine = (inv?.staging ?? []).find(e => e.hash === String(hash).toLowerCase());
          const countsAsVideo = mine ? counts(mine) : true;
          const storedVideos = countsAsVideo ? (inv?.stored ?? []).filter(counts).length : 0;
          const verdict = checkGuestAsset({ accountId, bytes: known.size, countsAsVideo, storedVideos });
          if (!verdict.ok) return deny(DENY(verdict.code));
        }
        return await complete();
      } finally { release(); }
    },

    /**
     * 整件上传（`POST /api/media/upload/<名>`、`POST /api/media/adopt`，托管下也挂着）：
     * 扩展名从文件名拿，档位没有（整件上传只有原件），所以视频一律算数。内容哈希要读完才知道，
     * 算数的只能按「再多一条」算，已存满就拒（哪怕传的是一份已有的）；不算数的只查尺寸。
     * 尺寸看 `Content-Length`（Node 不会多收），整件上传没带它的游客请求回 411。
     * 放行时回放锁函数，调用方占到回完包再放；拒了回 `{ status, error }`。
     *
     * @param {{ accountId?: string, bytes: number | null, ext?: string, store: any, key: unknown, needsLength: boolean }} who
     * @returns {Promise<{ ok: true, release: () => void } | { ok: false, status: number, error: string }>}
     */
    async whole({ accountId, bytes, ext, store, key, needsLength }) {
      if (!guestQuotaApplies(accountId, 'media')) return { ok: true, release: () => {} };
      if (needsLength && bytes === null) return { ok: false, status: 411, error: 'length-required' };
      if (bytes !== null) {
        const sized = checkGuestAsset({ accountId, bytes });
        if (!sized.ok) return DENY(sized.code);
      }
      if (!counts({ ext, tier: 'original' })) return { ok: true, release: () => {} };
      const release = await acquire(key);
      try {
        const verdict = checkGuestAsset({ accountId, bytes: bytes ?? 0, countsAsVideo: true, storedVideos: await videosOf(store, { withStaging: true }) });
        if (!verdict.ok) { release(); return DENY(verdict.code); }
        return { ok: true, release };
      } catch (error) { release(); throw error; }
    },
  };
}
