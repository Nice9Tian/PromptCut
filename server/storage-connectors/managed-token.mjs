/**
 * A2 的三件事串起来:接上授权、按需换票、断开
 * (任务书 `docs/plan/drive-connector-task.md` 第 3 节)。
 *
 * ```
 * connectWithCode(...)  页面交来授权码 → 换出 refresh token → 加密存进 credentials.mjs
 * createManagedToken(…) 给 createStorageProvider 当 `token` 用的那个函数:
 *                       手里的 access token 还够用就直接给,不够就自己拿 refresh token 换一张
 * disconnect(...)       向 Google 撤销,并把存着的那份删掉
 * ```
 *
 * # 为什么是一个函数而不是一个值
 *
 * `createStorageProvider({ token })` 收得下函数(见 `provider.mjs` 的 `resolveToken`),每次请求前重取一次。
 * 所以 A2 和 A3 共用同一套 provider 代码:A3 传页面递来的那张票,A2 传这里造出来的函数。
 *
 * # 撤销了就别再试
 *
 * Google 回 `invalid_grant`(用户在账号页撤了、改了密码、令牌过期)时,`code` 是 `token-revoked`。
 * 这时**当场把存着的那份删掉**并把错抛出去 —— 再退避重试一百次也是它,只会白白打扰 Google。
 * 这是任务书里四个撤销口子中的第二个。
 *
 * 只用 Node 内置模块。
 */
import { StorageConnectorError } from './provider.mjs';
import { exchangeCode, refreshAccessToken, revokeToken } from './google-oauth.mjs';

/** 提前这么久就当它过期,免得正用着过期 */
export const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/**
 * 页面走完授权码流程之后调这里:换出 refresh token 存起来。
 *
 * 页面**不自己兑换**授权码 —— 兑换要客户端密钥,那东西只在拉取方这一侧。
 */
export async function connectWithCode({ store, scope, code, codeVerifier, clientId, clientSecret, redirectUri, fetchImpl, now = Date.now }) {
  const got = await exchangeCode({ code, codeVerifier, clientId, clientSecret, redirectUri, fetchImpl, now });
  const meta = await store.put(scope, { refreshToken: got.refreshToken, scope: got.scope });
  // 回包里不带任何令牌,只带「接上了」和授权到的范围
  return { connected: true, grantedScope: got.scope, createdAt: meta.createdAt, updatedAt: meta.updatedAt };
}

/**
 * 造一个取票函数,直接交给 `createStorageProvider({ token })`。
 *
 * 换出来的 access token 只在内存里,不落盘 —— 落盘的只有 refresh token。
 */
export function createManagedToken({ store, scope, clientId, clientSecret, fetchImpl, now = Date.now, marginMs = TOKEN_MARGIN_MS }) {
  let cached = null;   // { accessToken, expiresAt }
  let inflight = null; // 几路同时要票时只换一次

  async function fetchFresh() {
    const cred = await store.get(scope);
    if (!cred) {
      throw new StorageConnectorError('这个项目的这位成员还没接上这个网盘,请先授权', 'no-credential');
    }
    try {
      const got = await refreshAccessToken({ refreshToken: cred.refreshToken, clientId, clientSecret, fetchImpl, now });
      cached = { accessToken: got.accessToken, expiresAt: got.expiresAt };
      return cached.accessToken;
    } catch (e) {
      // 被撤销了:当场清掉,别留一份永远换不出票的记录
      if (e?.code === 'token-revoked') {
        await store.remove(scope).catch(() => {});
        throw new StorageConnectorError('网盘授权已被撤销或失效,存着的那份已清掉,请重新授权', 'token-revoked', { cause: e });
      }
      throw e;
    }
  }

  return async function token() {
    if (cached && cached.expiresAt - marginMs > now()) return cached.accessToken;
    inflight ??= fetchFresh().finally(() => { inflight = null; });
    return inflight;
  };
}

/**
 * 断开:向 Google 撤销,并把存着的那份删掉。
 *
 * **撤销失败也要删本地那份**。用户点了「断开」,本地就不该再留着能用的凭据;Google 那边没撤成,
 * 回包里如实说一句,由调用方提示用户去账号页再撤一次。
 */
export async function disconnect({ store, scope, fetchImpl }) {
  const cred = await store.get(scope).catch(() => null);
  let revoked = false;
  let why = null;
  if (cred?.refreshToken) {
    try {
      const res = await revokeToken({ token: cred.refreshToken, fetchImpl });
      revoked = !!res.ok;
      if (!res.ok) why = `Google 回了 HTTP ${res.status}`;
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
  }
  await store.remove(scope);
  return { removed: true, revoked, ...(why ? { why } : {}) };
}
