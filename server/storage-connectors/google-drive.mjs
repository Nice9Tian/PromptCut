/**
 * Google Drive 的 StorageProvider 实现(接口说明见 `index.mjs` 的文件头)。
 *
 * # 只用 `drive.file` 这个窄范围
 *
 * 用户在 Google Picker 里选中的文件,这个应用才读得到 —— 搜不了他整个网盘。这是刻意的:
 * `drive.file` 是**非敏感**范围,不触发 Google 每年一次的第三方安全评估;`drive.readonly` 是受限范围,要评估。
 * 2026-10-23 的 D1 探针实测过「选中即授权」成立(任务书第 6.1 节)。
 *
 * # 两个接口
 *
 * - 元信息:`GET /drive/v3/files/<id>?fields=…`;
 * - 字节:`GET /drive/v3/files/<id>?alt=media`,带 `Range` 头。D1 实测支持分段取(206、按偏移给字节),
 *   所以断点续传能落到片级,不用整件重来。
 *
 * # 两处坑(都是 D1 实测到的,任务书第 6.1 节)
 *
 * - **`Content-Range` 在浏览器里读不到**:Google 没把它放进 `Access-Control-Expose-Headers`。本文件跑在服务端,
 *   没有跨源这回事,读得到;但 `pull.mjs` 仍然自己记偏移,不拿这个头当准。
 * - **Google 会自动多给几个范围**:只申请 `drive.file`,回来的还有 `openid` / `email` / `profile`。
 *   都是非敏感的 OpenID Connect 基本范围,不用登记,也不影响判定。
 *
 * # 下载不了的那一类
 *
 * Google 文档、表格、幻灯片(`application/vnd.google-apps.*`)没有原始字节,`alt=media` 取不到,
 * 要走 `files.export`。素材库用不上这些,这里直接回一句说得明白的错,不去 export。
 */
import { Readable } from 'node:stream';
import { StorageConnectorError, resolveToken, rangeHeader, codeForStatus } from './provider.mjs';

const API = 'https://www.googleapis.com/drive/v3/files';
/** 元信息要哪几个字段。只要这几个,别把整份元数据拖回来 */
const FIELDS = 'id,name,size,mimeType';
/** Google 自家格式的前缀,这一类没有原始字节 */
const NATIVE_PREFIX = 'application/vnd.google-apps.';
/** 单次请求的时限。取元信息很快;取字节是流式的,这个时限只管到响应头到达为止 */
const DEFAULT_TIMEOUT_MS = 60_000;

const FILE_ID = /^[A-Za-z0-9_-]{5,256}$/;

/**
 * @param {object} options
 * @param {string | (() => string | Promise<string>)} options.token
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs] 到响应头为止的时限
 */
export function createGoogleDriveProvider({ token, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl required');

  /** 发一个请求,把网络层的失败也归成 StorageConnectorError */
  async function call(url, { headers = {}, signal } = {}) {
    const bearer = await resolveToken(token);
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { ...headers, Authorization: `Bearer ${bearer}` },
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `${Math.round(timeoutMs / 1000)} 秒没有回应`
        : String(e?.cause?.code || e?.message || e);
      throw new StorageConnectorError(`连不上 Google Drive:${why}`, 'network', { cause: e });
    }
    return res;
  }

  /** 非 2xx 的回包:读一点正文帮着归类与报错,但不把整份正文塞进错误信息 */
  async function fail(res, what) {
    const body = await res.text().catch(() => '');
    const code = codeForStatus(res.status, body);
    const hint = code === 'quota'
      ? '。Google 的下载配额是暂时性的,等一阵再试'
      : code === 'token-expired'
        ? '。授权过期或已被撤销,要重新授权'
        : code === 'not-found'
          ? '。文件不在了,或者这个应用没有被授权碰它(drive.file 只能读用户当场选中的文件)'
          : '';
    throw new StorageConnectorError(
      `Google Drive 拒绝了${what}(HTTP ${res.status})${hint}${body ? `:${body.slice(0, 200)}` : ''}`,
      code,
      { status: res.status },
    );
  }

  function checkId(fileId) {
    if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) {
      throw new TypeError(`bad Google Drive file id: ${String(fileId).slice(0, 64)}`);
    }
  }

  return {
    kind: 'google-drive',

    async stat(fileId, { signal } = {}) {
      checkId(fileId);
      const url = `${API}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`;
      const res = await call(url, { signal });
      if (!res.ok) await fail(res, '读文件信息');
      let data;
      try { data = await res.json(); } catch (e) {
        throw new StorageConnectorError('Google Drive 的文件信息不是 JSON', 'bad-response', { cause: e });
      }
      const mimeType = String(data?.mimeType || '');
      if (mimeType.startsWith(NATIVE_PREFIX)) {
        throw new StorageConnectorError(
          `这是 Google 自家格式的文件(${mimeType}),没有原始字节,导不进素材库`,
          'not-downloadable',
        );
      }
      // Drive v3 的 size 是字符串,而且只有二进制文件才有
      const size = Number(data?.size);
      if (!Number.isInteger(size) || size < 0) {
        throw new StorageConnectorError(`Google Drive 没给出文件大小(${mimeType || '未知类型'})`, 'bad-response');
      }
      return { id: String(data.id || fileId), name: String(data.name || fileId), size, mimeType };
    },

    async openRange(fileId, { start = 0, end = null, signal } = {}) {
      checkId(fileId);
      const url = `${API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
      const res = await call(url, { headers: { Range: rangeHeader(start, end) }, signal });
      // 416 只在起点越过文件末尾时出现,当成「这一段没有」交给调用方判断
      if (res.status === 416) {
        throw new StorageConnectorError(`要的区间越过了文件末尾(${start}-${end ?? ''})`, 'range-out-of-bounds', { status: 416 });
      }
      if (!res.ok) await fail(res, '取文件字节');
      if (!res.body) throw new StorageConnectorError('Google Drive 回了空响应体', 'bad-response');
      return {
        status: res.status,
        // 服务端没有跨源限制,读得到;`pull.mjs` 只拿它做核对,不拿它当偏移的准
        contentRange: res.headers.get('content-range'),
        stream: Readable.fromWeb(res.body),
      };
    },
  };
}
