/**
 * 网盘连接器的 HTTP 层:给页面用的两个口,接在编辑器进程的素材路由上
 * (`../vite-plugin-media.ts`,任务书 `docs/plan/drive-connector-task.md` 第 5 节)。
 *
 * - `GET  /api/media/storage/config` —— 页面要的公开参数(客户端 ID、API 密钥、项目编号)。
 *   这三样本来就出现在页面里,不是秘密;**客户端密钥不在其中**,它只有 A2 那条路用得上,而且进部署配置不进代码库。
 * - `POST /api/media/storage/import { kind, token, fileId, name? }` —— 拉一份文件进素材库,
 *   回包形状和 `POST /api/media/upload/<名>` 一样,页面照 `applyUploadedMedia` 那条路登记。
 *
 * # 令牌只过手,不落盘
 *
 * 页面交来的 access token 只在这一次请求里用,用完就扔:不写文件、不进日志、不进回包。这是 A3 那条路
 * (任务书第 3 节)。A2 的长期凭据保管是另一件事,本文件不碰。
 *
 * # 临时文件放在固定目录
 *
 * 断点续传要认得上次拉到哪,所以临时目录是固定的一个(不像素材收集那样每次 `mkdtemp` 一个新的)。
 * 放在系统临时目录下,不放进素材库 —— 免得拉到一半的半成品被当成一份素材。
 *
 * 只用 Node 内置模块。
 */
import os from 'node:os';
import path from 'node:path';
import { createStorageProvider, SUPPORTED_KINDS, StorageConnectorError } from './index.mjs';
import { importFromStorage } from './import.mjs';

/** 断点续传要的固定临时目录 */
export function pullTmpDir(env = process.env) {
  return env.PROMPTCUT_STORAGE_PULL_DIR || path.join(os.tmpdir(), 'promptcut-storage-pull');
}

/** 每家网盘在界面上怎么显示。Dropbox 本轮只占位,见任务书第 2 节 */
const CATALOG = [
  { kind: 'google-drive', label: 'Google Drive', scope: 'https://www.googleapis.com/auth/drive.file' },
  { kind: 'dropbox', label: 'Dropbox', scope: null },
];

/**
 * 页面要的配置。没配环境变量就 `configured: false`,界面把按钮置灰并说明原因,不报错。
 *
 * 三样都不是秘密(会出现在页面源码里),靠的是 Google 控制台那一侧的来源限制:
 * API 密钥限了 API 与来源网址,OAuth 客户端限了 JavaScript 来源。
 */
export function storageConfig(env = process.env) {
  const clientId = String(env.PROMPTCUT_GOOGLE_CLIENT_ID || '');
  const apiKey = String(env.PROMPTCUT_GOOGLE_API_KEY || '');
  const appId = String(env.PROMPTCUT_GOOGLE_PROJECT_NUMBER || '');
  return {
    ok: true,
    providers: CATALOG.map((p) => {
      if (p.kind !== 'google-drive') {
        return { ...p, configured: false, reason: '还没做,见任务书第 2 节' };
      }
      const configured = !!(clientId && apiKey && appId);
      return {
        ...p,
        configured,
        ...(configured
          ? { clientId, apiKey, appId }
          : { reason: '没配 PROMPTCUT_GOOGLE_CLIENT_ID / PROMPTCUT_GOOGLE_API_KEY / PROMPTCUT_GOOGLE_PROJECT_NUMBER' }),
      };
    }),
  };
}

/**
 * 校验页面交来的请求体。令牌只看形状,不看内容 —— 对不对由 Google 说了算。
 * @returns {{ kind: string, token: string, fileId: string, name: string | null }}
 */
export function parseImportBody(body) {
  const kind = String(body?.kind || '');
  if (!SUPPORTED_KINDS.includes(kind)) {
    throw new StorageConnectorError(`不认识的网盘:${kind || '(没给)'}`, 'bad-request');
  }
  const token = body?.token;
  if (typeof token !== 'string' || !token || token.length > 4096) {
    throw new StorageConnectorError('请求里没有可用的访问令牌', 'bad-request');
  }
  const fileId = body?.fileId;
  if (typeof fileId !== 'string' || !fileId) {
    throw new StorageConnectorError('请求里没有文件 id', 'bad-request');
  }
  const name = typeof body?.name === 'string' && body.name ? body.name : null;
  return { kind, token, fileId, name };
}

/** `code` 到 HTTP 状态码。页面据此决定是提示重试、重新授权,还是认错收场 */
export function statusForCode(code) {
  switch (code) {
    case 'bad-request': return 400;
    case 'token-expired': return 401;
    case 'forbidden': return 403;
    case 'not-found': return 404;
    case 'not-downloadable': return 415;
    case 'quota': return 429;
    case 'not-implemented': return 501;
    case 'network': return 502;
    default: return 500;
  }
}

/**
 * 拉一份文件进素材库。
 *
 * @param {object} body 页面交来的请求体
 * @param {object} ctx
 * @param {() => (string | null)} ctx.origin 素材服务的源
 * @param {string | (() => Promise<string|null>) | null} [ctx.ticket]
 * @param {object | null} [ctx.ownership]
 * @param {string} [ctx.tmpDir]
 * @param {typeof fetch} [ctx.fetchImpl] 取网盘字节用;云端那一侧要传出网闸包出来的那个
 * @param {(p: { bytes: number, total: number }) => void} [ctx.onProgress]
 */
export async function handleStorageImport(body, ctx) {
  const { kind, token, fileId, name } = parseImportBody(body);
  const provider = createStorageProvider({ kind, token, ...(ctx?.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) });
  return importFromStorage({
    provider,
    fileId,
    name,
    tmpDir: ctx?.tmpDir || pullTmpDir(),
    origin: ctx.origin,
    ticket: ctx?.ticket ?? null,
    ownership: ctx?.ownership ?? null,
    onProgress: ctx?.onProgress ?? null,
  });
}
