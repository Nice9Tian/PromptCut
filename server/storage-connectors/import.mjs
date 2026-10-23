/**
 * 把一份网盘文件导进素材库:拉到本机临时文件 → 经素材服务入库 → 删掉临时文件。
 *
 * 这条路和素材收集(`../agent/service/hosted-collect.mjs` 的 yt-dlp 下载)、配音(TTS)走的是同一条:
 * 都先落在自己的临时目录,完成后由 `../media-ingest.mjs` 流式送进素材服务,拿回内容哈希。
 * 语义 `docs/semantics/product/asset-service.md`「职责」:入库这一步不能省,任何一方不得绕过它直接读写字节。
 *
 * # 失败了临时文件留着
 *
 * 拉到一半断了、或者入库被拒,**都不删临时文件** —— 下次再调同一个 `fileId` 就从断点接着拉,
 * 不用把已经拉下来的字节再拉一遍。只有入库成功才删。要主动清掉就调 `discardPartial`。
 *
 * # 两档素材
 *
 * 入库时带 `tiers=1`,和用户自己导入素材完全一样:素材服务那一侧做 faststart 判定、排素材小尺寸的转码。
 * 转码由**拉取方**做(语义「素材小尺寸由上传方在自己的机器上转码,素材服务不转码」);本机拉取时拉取方
 * 就是编辑器进程,它本来就有 ffmpeg。
 */
import fsp from 'node:fs/promises';
import { pullToFile, partPath } from './pull.mjs';
import { ingestFile } from '../media-ingest.mjs';

/** 网盘上的文件名未必能直接当本机文件名用:去掉路径分隔符和控制字符,留住扩展名 */
export function safeName(raw, fallback = 'media') {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned.length > 180 ? cleaned.slice(-180) : cleaned;
}

/**
 * @param {object} p
 * @param {{ kind: string, stat: Function, openRange: Function }} p.provider
 * @param {string} p.fileId
 * @param {string} p.tmpDir 临时文件放哪
 * @param {() => (string | null)} p.origin 素材服务的源(同 `../media-ingest.mjs`)
 * @param {string | (() => Promise<string|null>) | null} [p.ticket] 素材票据
 * @param {object|null} [p.ownership] 项目归属(同 `../media-ingest.mjs`)
 * @param {string|null} [p.name] 不给就用网盘上的文件名
 * @param {(progress: { bytes: number, total: number }) => void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 * @param {typeof fetch} [p.fetchImpl] 给 `ingestFile` 用
 * @returns {Promise<object>} `ingestFile` 的结果,另加 `source`、`pulled`
 */
export async function importFromStorage({
  provider, fileId, tmpDir, origin, ticket = null, ownership = null,
  name = null, onProgress = null, signal = null, fetchImpl = undefined,
}) {
  if (!provider?.kind) throw new TypeError('provider required');
  if (typeof tmpDir !== 'string' || !tmpDir) throw new TypeError('tmpDir required');

  const info = await provider.stat(fileId, { signal });
  const fileName = safeName(name ?? info.name, `${provider.kind}-${fileId}`);
  const dest = partPath(tmpDir, provider.kind, fileId);

  const pulled = await pullToFile({ provider, fileId, dest, size: info.size, onProgress, signal });

  // 入库成功才删临时文件:中途失败留着,下次接着拉
  const stored = await ingestFile({
    file: dest,
    name: fileName,
    origin,
    tiers: true,
    ownership,
    ticket,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await fsp.rm(dest, { force: true });

  return {
    ...stored,
    source: { kind: provider.kind, fileId: info.id, name: info.name, mimeType: info.mimeType, size: info.size },
    pulled,
  };
}

/** 主动丢掉某份文件拉到一半的临时文件(用户取消导入、或者换了授权账号) */
export async function discardPartial({ kind, fileId, tmpDir }) {
  await fsp.rm(partPath(tmpDir, kind, fileId), { force: true });
}
