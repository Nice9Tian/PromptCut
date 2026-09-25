/**
 * 素材服务核对票据用的外观（契约 `docs/plan/auth-contract.md` 第 8 节「素材服务的读写」）。
 *
 * 素材服务与文档服务跑在同一个进程里，直接读凭证存储的内存状态（签名密钥、项目代数、用户代数）：
 * 改项目口令、改名单、踢人之后，已发的票据下一次请求就失效。不同进程之间不支持共用。
 *
 * - `createAssetTicketVerifier({ store, now })`：`store` 是凭证存储或取它的函数；
 * - `assetTicketVerifierFor(authDir)`：按 `auth/` 目录取进程内单例（`store.mjs` 的 `credentialStoreFor`），
 *   第一次核对时才打开；打不开就一律无效（失败即关）。
 */
import { verifyTicket } from './tickets.mjs';
import { credentialStoreFor } from './store.mjs';

/**
 * @param {object} options
 * @param {object | (() => object | null)} options.store
 * @param {() => number} [options.now]
 * @returns {{ verify(ticket: string): { ok: true, access: 'r' | 'rw', projectId: string, userId: string } | { ok: false, reason: string } }}
 */
export function createAssetTicketVerifier({ store, now = Date.now } = {}) {
  const storeOf = typeof store === 'function' ? store : () => store;
  return {
    verify(ticket) {
      let st = null;
      try {
        st = storeOf();
      } catch {
        st = null;
      }
      if (!st) return { ok: false, reason: 'no-store' };
      const v = verifyTicket(ticket, { lookup: (id) => st.peek(id), now: now(), kind: 'asset' });
      if (!v.ok) return { ok: false, reason: v.reason };
      return { ok: true, access: v.payload.r, projectId: v.payload.p, userId: v.payload.u };
    },
  };
}

/** 按 `auth/` 目录取进程内的凭证存储来核对；打不开时每次都再试一次，仍打不开就回无效 */
export function assetTicketVerifierFor(authDir, { now = Date.now } = {}) {
  return createAssetTicketVerifier({ store: () => credentialStoreFor(authDir), now });
}
