/**
 * 按分段把一份网盘文件拉到本机的一个临时文件,支持断点续传。只认 `StorageProvider` 接口,不认具体是哪家网盘。
 *
 * # 为什么是分段
 *
 * 2026-10-23 的 D1 探针实测 Google Drive 支持 Range(任务书第 6.1 节):头 1024 字节和中段 1024 字节
 * 都回 206、都恰好 1024 字节,且内容不同。所以断了只补缺的那几段,不用整件重来 —— 和素材服务自己的分片上传
 * 是同一个思路(`../asset-store/blob-store.mjs`,8 MiB 一片)。
 *
 * # 续传靠的是临时文件自己的长度
 *
 * 不另记进度文件:临时文件现在多长,就从哪里接着拉。这和素材服务「同步状态只问素材服务」是同一种做法 ——
 * 事实只有一处,不会对不上(语义 `docs/semantics/mechanism/asset-service.md`)。
 *
 * **`dest` 必须对每个(网盘 × 文件)唯一**,否则会把两份文件的字节接到一起。`import.mjs` 按
 * `<kind>-<fileId>.part` 构造,调用方自己传 `dest` 时也要照办。
 *
 * # 本层不重试
 *
 * 拉失败就抛,由调用方决定退避多久再来 —— 反正是断点续传,再调一次就接着拉。退避的口径见
 * `../upload-queue.mjs`(5 s、30 s、120 s,之后每 10 min)。哪些错该重试看 `provider.mjs` 的 `TRANSIENT_CODES`。
 *
 * 只用 Node 内置模块。
 */
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageConnectorError } from './provider.mjs';

/** 一段多大。和素材服务的分片一样是 8 MiB,两边的「片」对得上,日志好读 */
export const PULL_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * 把 `fileId` 拉到 `dest`。`dest` 已经存在就从它当前的长度接着拉。
 *
 * @param {object} p
 * @param {{ stat: Function, openRange: Function, kind?: string }} p.provider
 * @param {string} p.fileId
 * @param {string} p.dest 临时文件的绝对路径,对每个(网盘 × 文件)唯一
 * @param {number} [p.size] 已知总长就传进来,省一次 `stat`
 * @param {number} [p.chunkSize]
 * @param {(progress: { bytes: number, total: number }) => void} [p.onProgress] 每拉完一段叫一次
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{ bytes: number, total: number, resumedFrom: number, segments: number }>}
 */
export async function pullToFile({ provider, fileId, dest, size = null, chunkSize = PULL_CHUNK_SIZE, onProgress = null, signal = null }) {
  if (!provider?.openRange) throw new TypeError('provider required');
  if (typeof dest !== 'string' || !dest) throw new TypeError('dest required');
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new TypeError(`bad chunkSize: ${chunkSize}`);

  const total = Number.isInteger(size) && size >= 0 ? size : (await provider.stat(fileId, { signal })).size;

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  let written = await currentLength(dest);
  const resumedFrom = written;

  // 临时文件比源文件还长:多半是 dest 被另一份文件用过。不猜,丢掉重来
  if (written > total) {
    await fsp.rm(dest, { force: true });
    written = 0;
  }

  // 空文件:建出来就完事,不发请求
  if (total === 0) {
    await fsp.writeFile(dest, '');
    return { bytes: 0, total: 0, resumedFrom, segments: 0 };
  }

  let segments = 0;
  while (written < total) {
    signal?.throwIfAborted();
    const start = written;
    const end = Math.min(start + chunkSize, total) - 1;
    const want = end - start + 1;

    const res = await provider.openRange(fileId, { start, end, signal });

    // 对方忽略了 Range、从头给的整件:这一段白拉,只能从头写
    if (res.status === 200 && start > 0) {
      res.stream.destroy?.();
      throw new StorageConnectorError(
        `${provider.kind || '网盘'}忽略了 Range(回了 200 不是 206),断点续传没法用`,
        'range-unsupported',
        { status: 200 },
      );
    }

    const got = await appendStream(dest, res.stream, start);
    segments += 1;

    if (got === 0) {
      throw new StorageConnectorError(`拉到第 ${start} 字节处对方不给了,这一段是空的`, 'bad-response');
    }
    // 给多了:后面的字节会和下一段重叠,不敢要
    if (got > want) {
      await truncate(dest, start);
      throw new StorageConnectorError(`要 ${want} 字节,对方给了 ${got} 字节`, 'bad-response');
    }

    written = start + got;
    onProgress?.({ bytes: written, total });
  }

  const finalLength = await currentLength(dest);
  if (finalLength !== total) {
    throw new StorageConnectorError(`拉完之后长度对不上:应为 ${total},实为 ${finalLength}`, 'bad-response');
  }
  return { bytes: total, total, resumedFrom, segments };
}

/** 文件现在多长;不存在算 0 */
async function currentLength(file) {
  try {
    const st = await fsp.stat(file);
    return st.isFile() ? st.size : 0;
  } catch (e) {
    if (e?.code === 'ENOENT') return 0;
    throw e;
  }
}

/**
 * 从 `start` 处往 `dest` 写,返回实际写进去多少字节。
 *
 * 两处讲究:
 *
 * - **定位写,不用追加**。`a` 在某些平台上会忽略定位,前一次写到一半留下的多余字节会被留在文件里;
 *   `r+` 加 `start` 保证「从 start 开始覆盖」,重拉同一段是幂等的。`start` 为 0 时用 `w`,顺手把旧内容截掉。
 * - **用 `fs.createWriteStream`,不用 `FileHandle.createWriteStream`**。后者配 `autoClose: false` 时不发
 *   `close` 事件,而 `stream/promises` 的 `pipeline` 要等到 `close` 才算完 —— 会一直挂着。
 *   (2026-10-23 写这一层时踩到:五个会落盘的用例全部 15 秒超时。)
 *
 * 实际写进去多少不靠在源流上挂 `data` 监听来数(那会把流切成流动模式,`pipeline` 接手前的字节有丢失风险),
 * 而是写完之后看文件长了多少。
 */
async function appendStream(dest, stream, start) {
  const out = createWriteStream(dest, start === 0 ? { flags: 'w' } : { flags: 'r+', start });
  try {
    await pipeline(stream, out);
  } catch (e) {
    // start > 0 却打不开说明临时文件在两次调用之间被人删了。不补一个空壳(会写出空洞),直接报出去重来
    if (e?.code === 'ENOENT' && start > 0) {
      throw new StorageConnectorError(`临时文件在拉取途中不见了:${dest}`, 'bad-response', { cause: e });
    }
    throw e;
  }
  return Math.max(0, (await currentLength(dest)) - start);
}

async function truncate(file, length) {
  const handle = await fsp.open(file, 'r+');
  try { await handle.truncate(length); } finally { await handle.close().catch(() => {}); }
}

/** 给 `import.mjs` 和测试用:临时文件名。同一份文件重来时落在同一个路径上,才接得上 */
export function partPath(dir, kind, fileId) {
  const safe = String(fileId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return path.join(dir, `${kind}-${safe}.part`);
}
