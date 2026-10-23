/**
 * Google 的授权码兑换与换票(A2「凭据托管」那条路,任务书 `docs/plan/drive-connector-task.md` 第 3 节)。
 *
 * # 和 A3 的分工
 *
 * A3 只拿一张一小时的 access token,页面自己管,本文件用不上。A2 要的是**长期授权**:
 * 页面走授权码流程拿到一个**授权码**,不自己兑换,把码和 PKCE 的 verifier 交给拉取方;
 * 拉取方在这里用码加客户端密钥换出 refresh token,加密存起来(`credentials.mjs`),
 * 之后用户不在也能自己换 access token 接着拉。
 *
 * # 客户端密钥从哪来
 *
 * 调用方传进来,本文件不去读环境变量也不读文件 —— 密钥的位置归部署配置管,不进代码库
 * (本机那一份的位置记在 `docs/local.md`,该文件不入库)。
 *
 * # 三个口
 *
 * | 函数 | 打哪 |
 * |---|---|
 * | `exchangeCode` | `POST https://oauth2.googleapis.com/token`,`grant_type=authorization_code` |
 * | `refreshAccessToken` | 同一个地址,`grant_type=refresh_token` |
 * | `revokeToken` | `POST https://oauth2.googleapis.com/revoke` |
 *
 * **令牌与密钥一律不进日志、不进错误信息。** 出错只带 Google 回的 `error` 字段和状态码。
 *
 * 只用 Node 内置模块。
 */
import { StorageConnectorError } from './provider.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Google 的 `error` 字段归成我们的 `code`。
 *
 * `invalid_grant` 是最要紧的一个:refresh token 被撤销、过期、或者用户改了密码都会回它。
 * 拿到它就该把存着的那份凭据清掉并告诉用户重新授权,不要退避重试 —— 再试一百次也是它。
 */
function codeForOAuthError(error, status) {
  if (error === 'invalid_grant') return 'token-revoked';
  if (error === 'invalid_client') return 'bad-client';
  if (error === 'invalid_request' || error === 'unsupported_grant_type') return 'bad-request';
  if (status === 429) return 'quota';
  if (status >= 500) return 'network';
  return 'bad-response';
}

async function postForm(url, params, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const body = new URLSearchParams(params).toString();
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `${Math.round(timeoutMs / 1000)} 秒没有回应`
      : String(e?.cause?.code || e?.message || e);
    throw new StorageConnectorError(`连不上 Google 的令牌服务:${why}`, 'network', { cause: e });
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* 下面按 null 处理 */ }
  if (!res.ok || !data) {
    const error = String(data?.error || '');
    // 只带 error 字段,不带正文 —— 正文里可能回显请求参数
    throw new StorageConnectorError(
      `Google 的令牌服务回了 HTTP ${res.status}${error ? `(${error})` : ''}`,
      codeForOAuthError(error, res.status),
      { status: res.status },
    );
  }
  return data;
}

/**
 * 用授权码换 refresh token。
 *
 * @param {object} p
 * @param {string} p.code 页面交来的授权码
 * @param {string} p.codeVerifier PKCE 的 verifier,和页面发起授权时用的那个对应
 * @param {string} p.clientId
 * @param {string} p.clientSecret 部署配置里的,不进代码库
 * @param {string} p.redirectUri 必须和页面发起时用的那个逐字一致
 * @returns {Promise<{ refreshToken: string, accessToken: string, expiresAt: number, scope: string }>}
 */
export async function exchangeCode({ code, codeVerifier, clientId, clientSecret, redirectUri, fetchImpl, timeoutMs, signal, now = Date.now }) {
  for (const [k, v] of Object.entries({ code, codeVerifier, clientId, clientSecret, redirectUri })) {
    if (typeof v !== 'string' || !v) throw new TypeError(`${k} required`);
  }
  const data = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  }, { fetchImpl, timeoutMs, signal });

  // 没有 refresh_token 多半是没带 access_type=offline、或者用户之前已经授权过而没带 prompt=consent
  if (typeof data.refresh_token !== 'string' || !data.refresh_token) {
    throw new StorageConnectorError(
      'Google 没给 refresh token:发起授权时要带 access_type=offline 与 prompt=consent',
      'no-refresh-token',
    );
  }
  return {
    refreshToken: String(data.refresh_token),
    accessToken: String(data.access_token || ''),
    expiresAt: now() + (Number(data.expires_in) || 3600) * 1000,
    scope: String(data.scope || ''),
  };
}

/** 用 refresh token 换一张新的 access token。拿到 `token-revoked` 就该清掉存着的凭据 */
export async function refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl, timeoutMs, signal, now = Date.now }) {
  for (const [k, v] of Object.entries({ refreshToken, clientId, clientSecret })) {
    if (typeof v !== 'string' || !v) throw new TypeError(`${k} required`);
  }
  const data = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }, { fetchImpl, timeoutMs, signal });

  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new StorageConnectorError('Google 的换票回包里没有 access token', 'bad-response');
  }
  return {
    accessToken: String(data.access_token),
    expiresAt: now() + (Number(data.expires_in) || 3600) * 1000,
    scope: String(data.scope || ''),
  };
}

/**
 * 主动撤销(用户在软件里点「断开这个网盘」时走这里)。
 *
 * Google 对已经失效的令牌也回 400,那对我们不算失败 —— 目的就是让它失效。所以只有网络层的失败才抛。
 */
export async function revokeToken({ token, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (typeof token !== 'string' || !token) throw new TypeError('token required');
  try {
    const res = await fetchImpl(`${REVOKE_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    throw new StorageConnectorError(`连不上 Google 的撤销接口:${String(e?.message || e)}`, 'network', { cause: e });
  }
}
