/**
 * 素材服务:第一版的本地素材服务(`docs/semantics/architecture/asset-storage.md`;
 * 任务书 `docs/plan/cloud-task.md` 第 5 步、A1「上传一律走分片」)。
 *
 * 它挂在编辑器进程的媒体插件里(`vite-plugin-media.ts` 的 mediaPlugin),存储就是本地内容库
 * `out/media`(`mediaDir`),文件名 `<sha256>.<ext>`。**只有这个模块和 vite-plugin-media 读写那个目录**;
 * Agent 进程、预渲染进程像外部客户端一样只经下面的 HTTP API 取字节(地址怎么定见 `asset-client.ts`)。
 * 远程素材服务(局域网 NAS、公网云端)不在本仓库,但必须实现同一份契约,客户端只换基址。
 *
 * # API 契约(第 5 步)
 *
 * 基址 `<origin>/api/asset`;下面的路径都相对基址。本地素材服务的老读路由 `/@media/<hash>`
 * 与 `GET media/<hash>` 等价,同样允许跨源。
 *
 * ## 按哈希寻址
 *
 * - `<hash>` 是**全件内容的 sha256**,64 位 hex,**由上传方在自己那边算好**;大小写不敏感,服务端一律按小写存。
 * - 写入后不可变,天然去重:同一个哈希只存一份。
 *
 * ## 分片上传 `PUT media/<hash>/<n>`
 *
 * - 分片固定 `chunkSize = 8 MiB`(8388608 字节);分片数 `count = max(1, ceil(size / chunkSize))`,
 *   小于 8 MiB 的素材就是 1 片。没有整件 `PUT media/<hash>` 这条路。
 * - `<n>` 是十进制分片号,`0 ≤ n < count`,不带前导零。格式不对回 400,越界回 416。
 * - 请求头(**每一片都要带**,服务端不靠「第一片」记状态,乱序、并发、断点重传都一样):
 *   - `X-Media-Size: <全件字节数>` —— 必填,正整数,上限 64 GiB。缺了或不是整数回 400;
 *     与这个哈希已登记的 size 不一致回 409(`error: "size-mismatch"`)。
 *   - `X-Media-Ext: <扩展名>` 与 / 或 `X-Media-Type: <MIME>` —— 选填,决定取回时的 Content-Type。
 *     扩展名优先;只给 MIME 时按表反查扩展名;都没给就是无扩展名、`application/octet-stream`。
 *     **哪一片先带上就以哪一片为准**,之后的不再改它。
 *   - 请求体的 `Content-Type` 不看(一般是 `application/octet-stream`)。
 * - 长度:除最后一片外每片必须恰好 `chunkSize` 字节,最后一片是 `size - chunkSize × (count - 1)`。
 *   `Content-Length` 对不上直接回 400;实收字节多了或少了也回 400,这一片不算收到。
 * - **幂等**:同一片重传,按新到的字节原位重写,结果一样;这一哈希已经 `complete` 时,任何分片都回 200 不落盘。
 * - 成功回 200 `{ ok: true, hash, n, bytes }`。
 *
 * ## 对账 `GET media/<hash>/chunks`
 *
 * - 回 200 `{ size, chunkSize, received: number[], complete }`。`received` 升序。
 * - 从没见过的哈希:`{ size: null, chunkSize, received: [], complete: false }`。
 * - 已入库(包括走老的整件导入进来的):`{ size, chunkSize, received: [0..count-1], complete: true }`。
 * - 这是「这一档到齐没有」的**唯一事实来源**;断点续传只补 `received` 里缺的片。
 *
 * ## 收尾 `POST media/<hash>/complete`
 *
 * - 分片没到齐回 400 `{ error: "incomplete", missing: number[] }`,已收的分片不动。
 * - 到齐了按顺序对全件算 sha256:和 `<hash>` 不符回 **409** `{ error: "hash-mismatch", actual }`,
 *   并**丢弃这一哈希已收的全部分片**(分不清是哪一片坏了),之后 `chunks` 报 `received: []`,上传方从头传。
 * - 校验通过才入库,回 200 `{ ok: true, hash, size, complete: true, url: "/@media/<hash>" }`;
 *   从这以后 `chunks` 报 `complete: true`。已经入库的哈希再 `complete` 一次也回 200。
 * - 从没见过的哈希回 404。
 *
 * ## 取回 `GET media/<hash>`(`HEAD` 同)
 *
 * - 只取已入库的全件,Content-Type 按扩展名;支持单段 Range(`bytes=a-b`、`bytes=a-`、`bytes=-n`),
 *   回 206 + `Content-Range`;落在文件外回 416。还没 `complete` 的哈希回 404(分片不对外)。
 *
 * ## 跨源
 *
 * - 本模块管的路由(`/api/asset/media/...` 和 `/@media/*`)一律回 `Access-Control-Allow-Origin: *`,
 *   `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, Content-Type`。
 * - 预检 `OPTIONS` 回 204:方法 `GET, HEAD, PUT, POST, OPTIONS`,
 *   头 `Content-Type, Range, X-Media-Size, X-Media-Ext, X-Media-Type`;
 *   请求带 `Access-Control-Request-Private-Network` 时回 `Access-Control-Allow-Private-Network: true`。
 * - 不带凭据(不用 cookie),所以用 `*`。`/api/**` 的同源守卫只对这一组路径豁免
 *   (`http-guard.mjs` 的 `isAssetServicePath`),其余 `/api/**` 照旧只认同源。
 *
 * # 存储
 *
 * 收了一半的分片放在 `out/media/.chunks/<hash>/`:`meta.json`(size、ext)、`data`(按偏移原位写的
 * 全件,收尾时只读一遍算哈希再改名入库,不再拷一遍)、`<n>.ok`(这一片完整落盘的标记)。
 * 写一片之前先删它的标记,写完、长度对了才补上 —— 断电、断线、写到一半失败都只会让这一片算「没收到」。
 */
import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import path from "path";
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import crypto from "crypto";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { apiPath, isAssetServicePath } from "./http-guard.mjs";
import {
  mediaDir, isMediaHash, extOfName, contentTypeForExt, resolveHashFile, writeMediaIndex, serveFile,
} from "./vite-plugin-media";

export const ASSET_CHUNK_SIZE = 8 * 1024 * 1024;
/** 单件上限。防一个跨源页面报个天文数字的 size 把盘占满;真有更大的素材再调 */
export const ASSET_MAX_SIZE = 64 * 1024 * 1024 * 1024;

export const ASSET_ALLOW_METHODS = "GET, HEAD, PUT, POST, OPTIONS";
export const ASSET_ALLOW_HEADERS = "Content-Type, Range, X-Media-Size, X-Media-Ext, X-Media-Type";
export const ASSET_EXPOSE_HEADERS = "Content-Range, Accept-Ranges, Content-Length, Content-Type";

/** 分片数:小于一片的素材也算 1 片 */
export function chunkCount(size: number, chunkSize = ASSET_CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** 第 n 片应有的字节数 */
export function chunkLength(size: number, n: number, chunkSize = ASSET_CHUNK_SIZE): number {
  const count = chunkCount(size, chunkSize);
  return n < count - 1 ? chunkSize : size - chunkSize * (count - 1);
}

const MIME_TO_EXT: Record<string, string> = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/** 请求头里的扩展名:X-Media-Ext 优先,其次按 X-Media-Type 反查。取不出给空串 */
function extFromHeaders(req: IncomingMessage): string {
  const raw = String(req.headers["x-media-ext"] || "").trim().toLowerCase().replace(/^\./, "");
  if (/^[a-z0-9]{1,8}$/.test(raw)) return raw;
  const mime = String(req.headers["x-media-type"] || "").split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[mime] || "";
}

/* ------------------------------------------------------------------ *
 * 暂存区
 * ------------------------------------------------------------------ */

interface ChunkMeta { size: number; ext: string }

function stagingDir(root: string, hash: string): string {
  return path.join(mediaDir(root), ".chunks", hash);
}

async function readMeta(root: string, hash: string): Promise<ChunkMeta | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(stagingDir(root, hash), "meta.json"), "utf8"));
    if (Number.isSafeInteger(raw?.size) && raw.size > 0) return { size: raw.size, ext: String(raw.ext || "") };
  } catch { /* 没有暂存 */ }
  return null;
}

async function writeMeta(root: string, hash: string, meta: ChunkMeta): Promise<void> {
  const dir = stagingDir(root, hash);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `meta.${crypto.randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(meta));
  await fs.rename(tmp, path.join(dir, "meta.json"));
}

async function receivedChunks(root: string, hash: string, meta: ChunkMeta): Promise<number[]> {
  const count = chunkCount(meta.size);
  let names: string[] = [];
  try { names = await fs.readdir(stagingDir(root, hash)); } catch { return []; }
  const out: number[] = [];
  for (const name of names) {
    const m = /^(\d+)\.ok$/.exec(name);
    if (m) { const n = Number(m[1]); if (n < count) out.push(n); }
  }
  return out.sort((a, b) => a - b);
}

/** 同一哈希的登记、收尾串行执行;分片字节本身的写入不排队 */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(hash: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(hash) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(hash, tail);
  void tail.then(() => { if (locks.get(hash) === tail) locks.delete(hash); });
  return run;
}

/* ------------------------------------------------------------------ *
 * 各条路由
 * ------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** 回完错误再掐断:请求体还在路上,别让它继续往服务端灌(和 http-guard.mjs 的 overLimit 同一个理由) */
function reject(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  res.setHeader("Connection", "close");
  sendJson(res, status, body);
  res.once("finish", () => req.destroy());
  setTimeout(() => req.destroy(), 1000).unref?.();
}

/** 请求体读完扔掉(已入库时的幂等重传) */
function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => { req.on("end", resolve); req.on("error", () => resolve()); req.on("close", () => resolve()); req.resume(); });
}

export async function chunkStatus(root: string, hash: string) {
  const done = await resolveHashFile(root, hash);
  if (done) {
    const size = (await fs.stat(done)).size;
    const count = chunkCount(size);
    return { size, chunkSize: ASSET_CHUNK_SIZE, received: Array.from({ length: count }, (_, i) => i), complete: true };
  }
  const meta = await readMeta(root, hash);
  if (!meta) return { size: null, chunkSize: ASSET_CHUNK_SIZE, received: [] as number[], complete: false };
  return { size: meta.size, chunkSize: ASSET_CHUNK_SIZE, received: await receivedChunks(root, hash, meta), complete: false };
}

async function handlePutChunk(req: IncomingMessage, res: ServerResponse, root: string, hash: string, rawN: string) {
  if (!/^(0|[1-9]\d*)$/.test(rawN)) return reject(req, res, 400, { ok: false, error: "bad-chunk-number" });
  const n = Number(rawN);
  const sizeHeader = String(req.headers["x-media-size"] || "").trim();
  if (!/^[1-9]\d*$/.test(sizeHeader)) return reject(req, res, 400, { ok: false, error: "missing-size", detail: "每一片都要带 X-Media-Size(全件字节数)" });
  const size = Number(sizeHeader);
  if (!Number.isSafeInteger(size) || size > ASSET_MAX_SIZE) return reject(req, res, 413, { ok: false, error: "too-large" });
  const count = chunkCount(size);
  if (n >= count) return reject(req, res, 416, { ok: false, error: "chunk-out-of-range", count });
  const expected = chunkLength(size, n);
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) !== expected) {
    return reject(req, res, 400, { ok: false, error: "chunk-length", expected, got: Number(declared) });
  }

  // 登记(串行):已入库就幂等放过;size 对不上拒掉;先删这一片的标记,写完再补
  const ext = extFromHeaders(req);
  const pre = await withLock(hash, async () => {
    if (await resolveHashFile(root, hash)) return "complete" as const;
    const meta = await readMeta(root, hash);
    if (meta && meta.size !== size) return { conflict: meta.size };
    if (!meta || (!meta.ext && ext)) await writeMeta(root, hash, { size, ext: meta?.ext || ext });
    const dir = stagingDir(root, hash);
    await fs.rm(path.join(dir, `${n}.ok`), { force: true });
    // data 不存在就建一个空的;已经存在的不截断(别的片可能已经写进去了)
    await (await fs.open(path.join(dir, "data"), "a")).close();
    return "ok" as const;
  });
  if (pre === "complete") { await drain(req); return sendJson(res, 200, { ok: true, hash, n, bytes: expected, complete: true }); }
  if (typeof pre === "object") return reject(req, res, 409, { ok: false, error: "size-mismatch", size: pre.conflict });

  const dir = stagingDir(root, hash);
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      // 超长的部分不写(免得写进下一片的位置),读完再按长度回 400。
      // 不在这里报错:pipeline 出错会连 req 带 socket 一起毁掉,客户端只看到连接被重置
      const room = expected - bytes;
      bytes += chunk.length;
      if (room <= 0) return cb();
      cb(null, chunk.length > room ? chunk.subarray(0, room) : chunk);
    },
  });
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(path.join(dir, "data"), "r+");
    await pipeline(req, counter, handle.createWriteStream({ start: n * ASSET_CHUNK_SIZE, autoClose: false }));
  } catch (err) {
    await handle?.close().catch(() => {});
    handle = null;
    // 断线:对面已经不在了,回什么都收不到;这一片的标记没补,对账时报「没收到」
    if (!res.headersSent && !res.destroyed) sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  } finally {
    await handle?.close().catch(() => {});
  }
  if (bytes !== expected) return sendJson(res, 400, { ok: false, error: "chunk-length", expected, got: bytes });
  // 标记落在暂存目录里;这期间要是被收尾丢弃了(409),目录不在,标记也就不写
  try { await fs.writeFile(path.join(dir, `${n}.ok`), ""); }
  catch { return sendJson(res, 409, { ok: false, error: "staging-discarded" }); }
  sendJson(res, 200, { ok: true, hash, n, bytes });
}

async function handleComplete(res: ServerResponse, root: string, hash: string) {
  const out = await withLock(hash, async () => {
    const done = await resolveHashFile(root, hash);
    if (done) return { status: 200, body: { ok: true, hash, size: (await fs.stat(done)).size, complete: true, url: `/@media/${hash}` } };
    const meta = await readMeta(root, hash);
    if (!meta) return { status: 404, body: { ok: false, error: "unknown-hash" } };
    const received = new Set(await receivedChunks(root, hash, meta));
    const missing: number[] = [];
    for (let i = 0; i < chunkCount(meta.size); i++) if (!received.has(i)) missing.push(i);
    if (missing.length) return { status: 400, body: { ok: false, error: "incomplete", missing } };

    const dir = stagingDir(root, hash);
    const data = path.join(dir, "data");
    const digest = crypto.createHash("sha256");
    const handle = await fs.open(data, "r");
    try {
      await pipeline(handle.createReadStream({ start: 0, end: meta.size - 1, autoClose: false }), digest);
    } finally {
      await handle.close();
    }
    const actual = digest.digest("hex");
    if (actual !== hash) {
      await fs.rm(dir, { recursive: true, force: true });
      return { status: 409, body: { ok: false, error: "hash-mismatch", actual } };
    }
    // 原位写的 data 不会比 size 长(每片长度都校验过),保险起见还是截一下
    await fs.truncate(data, meta.size);
    const file = meta.ext ? `${hash}.${meta.ext}` : hash;
    const dest = path.join(mediaDir(root), file);
    await fs.rename(data, dest);
    await fs.rm(dir, { recursive: true, force: true });
    await writeMediaIndex(root, hash, { file, ext: meta.ext, size: meta.size, contentType: contentTypeForExt(meta.ext) });
    return { status: 200, body: { ok: true, hash, size: meta.size, complete: true, url: `/@media/${hash}` } };
  });
  sendJson(res, out.status, out.body);
}

/* ------------------------------------------------------------------ *
 * 中间件
 * ------------------------------------------------------------------ */

/** 这条请求归不归素材服务的跨源规则管:`/api/asset/media/...`(严格匹配)和 `/@media/*` */
export function isAssetCorsPath(url: string | undefined): boolean {
  return isAssetServicePath(url) || String(url || "").startsWith("/@media/");
}

function applyCors(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", ASSET_EXPOSE_HEADERS);
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", ASSET_ALLOW_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ASSET_ALLOW_HEADERS);
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.headers["access-control-request-private-network"]) res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

/**
 * 素材服务的中间件。`/api/asset/media/...` 全部在这里答完;`/@media/*` 只补 CORS 头、答预检,
 * 取字节仍交给 `vite-plugin-media.ts` 的 mediaMiddleware(next)。别的请求原样 next。
 */
export function assetServiceMiddleware(root: string) {
  return async function assetService(req: Connect.IncomingMessage, res: ServerResponse, next: () => void) {
    if (!isAssetCorsPath(req.url)) return next();
    applyCors(req, res);
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (!isAssetServicePath(req.url)) return next(); // /@media/* 的 GET / HEAD

    // 判据和同源守卫的豁免是同一条正则,守卫放过来的请求从这里起一定有回应,不会 next 给别的 /api 处理函数
    const parts = apiPath(req.url).split("/"); // ["", "api", "asset", "media", <hash>, <tail>?]
    const hash = parts[4];
    const tail = parts[5];
    const method = String(req.method || "GET").toUpperCase();
    try {
      if (!isMediaHash(hash)) return sendJson(res, 400, { ok: false, error: "bad-hash" });
      if (tail === undefined) {
        if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { ok: false, error: "method" });
        const file = await resolveHashFile(root, hash);
        if (!file) return sendJson(res, 404, { ok: false, error: "not-found" });
        return serveFile(file, req, res);
      }
      if (tail === "chunks") {
        if (method !== "GET") return sendJson(res, 405, { ok: false, error: "method" });
        return sendJson(res, 200, await chunkStatus(root, hash));
      }
      if (tail === "complete") {
        if (method !== "POST") return sendJson(res, 405, { ok: false, error: "method" });
        return await handleComplete(res, root, hash);
      }
      if (method !== "PUT") return reject(req, res, 405, { ok: false, error: "method" });
      return await handlePutChunk(req, res, root, hash, tail);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/** 上传方每一片要带的请求头(测试和将来第 6 步的上传队列用) */
export function chunkHeaders(size: number, name?: string): Record<string, string> {
  const h: Record<string, string> = { "X-Media-Size": String(size) };
  const ext = extOfName(name || "");
  if (ext) h["X-Media-Ext"] = ext;
  return h;
}
