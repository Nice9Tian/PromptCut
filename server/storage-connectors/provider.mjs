/**
 * StorageProvider 这一层的公共件:错误类型、令牌取法、Range 头的拼与解。
 *
 * 单独一个文件是为了不让 `index.mjs`(工厂)和各家实现互相 import 成环:实现引这里,`index.mjs` 也引这里。
 * 接口本身的说明见 `index.mjs` 的文件头。只用 Node 内置模块。
 */

/**
 * 连接器这一层的错误。`code` 用来让调用方分辨该重试、该换票还是该告诉用户。
 *
 * - `token-expired`:授权过期或被撤销(HTTP 401)。A3 要页面递一张新票,A2 要拉取方自己换;
 * - `forbidden`:有票但没权限(HTTP 403,非配额);
 * - `quota`:网盘限流或下载配额用尽(HTTP 403 `downloadQuotaExceeded`、HTTP 429)。等一阵再来,不算失败;
 * - `not-found`:文件不在了,或这个应用从来没被授权碰过它(HTTP 404);
 * - `range-unsupported`:对方忽略了 Range,整件给的;
 * - `network`:连不上、超时;
 * - `bad-response`:回包不是预期的形状;
 * - `not-implemented`:这家网盘还没做。
 */
export class StorageConnectorError extends Error {
  constructor(message, code = 'bad-response', { status = null, cause = null } = {}) {
    super(message);
    this.name = 'StorageConnectorError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/**
 * 暂时性故障:调用方应当退避重试,不当成失败。
 * 口径和 `../upload-queue.mjs` 一致(语义 `guide_files/suggested_agent_behavior.md`:
 * 「暂时性故障一律重试加退避,不算失败」)。
 */
export const TRANSIENT_CODES = Object.freeze(new Set(['quota', 'network']));

/**
 * 令牌可以是值,也可以是一个取令牌的函数。
 *
 * **为什么允许函数**:A3 的 access token 只活一小时,页面会在过期前递一张新的;A2 由拉取方自己换。
 * 每次请求前重取一次,两种情形都不用重建 provider。
 */
export async function resolveToken(token) {
  const value = typeof token === 'function' ? await token() : token;
  if (typeof value !== 'string' || !value) {
    throw new StorageConnectorError('连接器没拿到访问令牌', 'token-expired');
  }
  return value;
}

/** 闭区间转成 HTTP 的 Range 头;`end` 省略表示到末尾 */
export function rangeHeader(start, end) {
  if (!Number.isInteger(start) || start < 0) throw new TypeError(`bad range start: ${start}`);
  if (end === undefined || end === null) return `bytes=${start}-`;
  if (!Number.isInteger(end) || end < start) throw new TypeError(`bad range end: ${end}`);
  return `bytes=${start}-${end}`;
}

/**
 * 把 HTTP 状态码归成 `StorageConnectorError` 的 `code`。
 *
 * 403 要再看回包:Google 的下载配额用尽也是 403,但那是暂时性的、该退避重试,
 * 和「没权限」不是一回事(任务书第 9 节)。
 */
export function codeForStatus(status, body = '') {
  if (status === 401) return 'token-expired';
  if (status === 429) return 'quota';
  if (status === 403) return /quota|rateLimit|userRateLimit/i.test(body) ? 'quota' : 'forbidden';
  if (status === 404) return 'not-found';
  if (status >= 500) return 'network';
  return 'bad-response';
}
