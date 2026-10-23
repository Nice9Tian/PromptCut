/**
 * 第三方存储连接器(任务书 `docs/plan/drive-connector-task.md` 第 4 节)。
 *
 * 用户授权后,从他自己的网盘里把素材直接取进项目,不必先下载到本机再上传。本目录只管**取字节**:
 * 取到的字节照常经素材服务入库(`../media-ingest.mjs`),不另开通道 —— 语义
 * `docs/semantics/product/asset-service.md`「职责」的「入库这一步不能省,任何一方不得绕过它直接读写字节」。
 *
 * # 分层
 *
 * | 文件 | 管什么 |
 * |---|---|
 * | `index.mjs`(本文件) | 工厂。调用方只认这一层,不认具体是哪家网盘 |
 * | `provider.mjs` | 公共件:错误类型、令牌取法、Range 头 |
 * | `google-drive.mjs` | 第一个实现。以后加 Dropbox 就再加一个,上层不改 |
 * | `pull.mjs` | 按分段把一份文件拉到本机临时文件,支持断点续传 |
 * | `import.mjs` | 把临时文件交给素材服务入库,入库后删掉 |
 *
 * # StorageProvider 接口
 *
 * ```
 * StorageProvider = {
 *   kind: 'google-drive',
 *   stat(fileId, { signal? }) → Promise<{ id, name, size, mimeType }>
 *   openRange(fileId, { start, end, signal? }) → Promise<{ status: 206 | 200, stream: Readable }>
 * }
 * ```
 *
 * - `openRange` 的区间是**闭区间**,和 HTTP 的 Range 一致,也和 `../asset-store/blob-store.mjs` 的 `read` 一致;
 * - 回 `status: 200` 表示对方忽略了 Range、从头给的整件。`pull.mjs` 据此从头重来;
 * - 取不到的一律抛 `StorageConnectorError`,靠 `code` 分辨该重试、该换票还是该告诉用户。
 *
 * # 只用 Node 内置模块
 *
 * 和 `../asset-store/` 一样,本目录不引 `.ts`、不引第三方包。`fetch` 由调用方注入:云端那一侧要把
 * 出网闸(`../agent/service/egress.mjs`)包出来的那个传进来,本机这一侧用全局 `fetch` 就行。
 */
import { createGoogleDriveProvider } from './google-drive.mjs';
import { StorageConnectorError } from './provider.mjs';

export { StorageConnectorError, TRANSIENT_CODES, resolveToken, rangeHeader, codeForStatus } from './provider.mjs';
export { pullToFile, PULL_CHUNK_SIZE } from './pull.mjs';
export { importFromStorage } from './import.mjs';
export { createGoogleDriveProvider } from './google-drive.mjs';

/** 本轮做通的网盘。Dropbox 记在任务书第 9 节的待办里,接口已经按可换后端设计 */
export const SUPPORTED_KINDS = Object.freeze(['google-drive']);

/**
 * 按 `kind` 造一个 StorageProvider。
 *
 * @param {object} options
 * @param {'google-drive'|'dropbox'} options.kind
 * @param {string | (() => string | Promise<string>)} options.token 访问令牌,或取令牌的函数(见 `provider.mjs` 的 `resolveToken`)
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {{ kind: string, stat: Function, openRange: Function }}
 */
export function createStorageProvider(options) {
  const kind = options?.kind;
  if (kind === 'google-drive') return createGoogleDriveProvider(options);
  if (kind === 'dropbox') throw new StorageConnectorError('Dropbox 连接器还没做', 'not-implemented');
  throw new TypeError(`unknown storage provider kind: ${String(kind)}`);
}
