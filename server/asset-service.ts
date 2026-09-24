/**
 * 素材服务:第一版的本地素材服务(`docs/semantics/architecture/asset-storage.md`;
 * 任务书 `docs/plan/cloud-task.md` 第 5 步、A1「上传一律走分片」)。
 *
 * 它挂在编辑器进程的媒体插件里(`vite-plugin-media.ts` 的 mediaPlugin)。本模块只管 HTTP,
 * 字节一律经数据层接口 `BlobStore`(`server/asset-store/`,契约 `docs/plan/asset-store-contract.md`)读写;
 * 缺省是 fs 实现,存储就是本地内容库 `out/media`(`mediaDir`),文件名 `<sha256>.<ext>`。
 * **只有数据层和 vite-plugin-media 读写那个目录**;Agent 进程、预渲染进程像外部客户端一样
 * 只经下面的 HTTP API 取字节(地址怎么定见 `asset-client.ts`)。
 * 远程素材服务(局域网 NAS、公网云端)不在本仓库,但必须实现同一份契约,客户端只换基址。
 *
 * # 命名空间(C6.2,`docs/plan/artifact-transfer-contract.md` 第 1 节)
 *
 * 路由是 `/api/asset/<ns>/<hash>…`,`<ns>` ∈ `media` | `snap` | `px`,三个命名空间各一个 `BlobStore`,互不可见:
 * - `media`:素材,就是下面第 5 步写的这一套,行为不变;老路由 `/@media/*` 只对应它。
 * - `snap`:HTML 快照块;`px`:像素产物(本阶段是轨道流的 init `.mp4` 与分段 `.m4s`)。
 *   缺省是 fs 实现,目录 `<root>/out/asset-store/snap`、`<root>/out/asset-store/px`;
 *   不写媒体索引,只按 `<hash>[.<ext>]` 找文件。
 * 子路由、状态码、回包、分片规则、跨源头、写入鉴权三个命名空间相同,下文写 `media/` 的地方换成 `<ns>/` 即可。
 * 两处按命名空间区分:收尾回包的 `url`,`media` 是 `/@media/<hash>`,另两个是 `/api/asset/<ns>/<hash>`;
 * `X-Media-Type` 反查扩展名时,`text/html → html`、`video/iso.segment → m4s` 只对 `snap` / `px` 生效,
 * `media` 的反查表不动。
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
 *   头 `Content-Type, Range, X-Media-Size, X-Media-Ext, X-Media-Type, Authorization`;
 *   请求带 `Access-Control-Request-Private-Network` 时，**只有来源是回环或局域网地址**（`isPrivateOrigin`）
 *   才回 `Access-Control-Allow-Private-Network: true`；公网网页的预检不给这一项，浏览器照样拦下它。
 * - 不带凭据(不用 cookie),所以用 `*`。`/api/**` 的同源守卫只对这一组路径豁免
 *   (`http-guard.mjs` 的 `isAssetServicePath`),其余 `/api/**` 照旧只认同源。
 *
 * ## 写入鉴权(C5,`docs/plan/asset-store-contract.md` 第 4 节)
 *
 * - 只管写:`PUT media/<hash>/<n>`、`POST media/<hash>/complete`。读(`GET` / `HEAD`、`chunks`、`OPTIONS`)不管。
 * - 放行:请求来自本机(`isTrusted`,缺省按对端地址是不是回环);或带 `Authorization: Bearer <集群令牌>`,
 *   与 `PROMPTCUT_CLUSTER_TOKEN` 相符(两边各取 sha256 再定长比较)。
 * - 不放行回 401 `{ ok: false, error: "unauthorized" }`。没配令牌时,非本机的写一律 401。
 * - 令牌原文不进日志、不进回包。
 *
 * # 存储
 *
 * 经 `BlobStore` 读写,本模块不碰文件系统。fs 实现的目录布局(全件、收了一半的分片、每片的「收到」标记)
 * 写在 `server/asset-store/fs-store.mjs` 文件头,与第 5 步逐字节一致。
 */
import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import type { Readable } from "stream";
import crypto from "crypto";
import path from "path";
import { apiPath, isAssetServicePath, clientAddressOf, isLoopbackAddress } from "./http-guard.mjs";
import { createBlobStore } from "./asset-store/index.mjs";
import {
  mediaDir, isMediaHash, extOfName, contentTypeForExt, resolveHashFile, writeMediaIndex, parseRange,
} from "./vite-plugin-media";

export const ASSET_CHUNK_SIZE = 8 * 1024 * 1024;
/** 单件上限。防一个跨源页面报个天文数字的 size 把盘占满;真有更大的素材再调 */
export const ASSET_MAX_SIZE = 64 * 1024 * 1024 * 1024;

export const ASSET_ALLOW_METHODS = "GET, HEAD, PUT, POST, OPTIONS";
export const ASSET_ALLOW_HEADERS = "Content-Type, Range, X-Media-Size, X-Media-Ext, X-Media-Type, Authorization";
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

/**
 * 产物命名空间(`snap`、`px`)多认的 MIME。只加给这两个命名空间:`media` 的反查结果一个字节都不许变
 * (比如 `media` 收到 `X-Media-Type: text/html` 仍然是无扩展名)。
 */
const ARTIFACT_MIME_TO_EXT: Record<string, string> = {
  ...MIME_TO_EXT,
  "text/html": "html", "video/iso.segment": "m4s",
};

/** 素材服务的命名空间(契约 `artifact-transfer-contract.md` 第 1 节) */
export const ASSET_NAMESPACES = ["media", "snap", "px"] as const;
export type AssetNamespace = typeof ASSET_NAMESPACES[number];

/** 请求头里的扩展名:X-Media-Ext 优先,其次按 X-Media-Type 反查。取不出给空串 */
function extFromHeaders(req: IncomingMessage, ns: AssetNamespace = "media"): string {
  const raw = String(req.headers["x-media-ext"] || "").trim().toLowerCase().replace(/^\./, "");
  if (/^[a-z0-9]{1,8}$/.test(raw)) return raw;
  const mime = String(req.headers["x-media-type"] || "").split(";")[0].trim().toLowerCase();
  return (ns === "media" ? MIME_TO_EXT : ARTIFACT_MIME_TO_EXT)[mime] || "";
}

/* ------------------------------------------------------------------ *
 * 数据层
 * ------------------------------------------------------------------ */

/** 数据层接口(`server/asset-store/blob-store.mjs` 的 JSDoc),这里只写 HTTP 层用到的部分 */
export interface AssetBlobStore {
  kind: string;
  chunkSize: number;
  stat(hash: string): Promise<{ size: number; ext: string; contentType: string; mtimeMs: number | null } | null>;
  read(hash: string, range?: { start?: number; end?: number }): Promise<Readable | null>;
  chunks(hash: string): Promise<{ size: number | null; chunkSize: number; received: number[]; complete: boolean }>;
  putChunk(hash: string, n: number, info: { size: number; ext?: string }, source: AsyncIterable<Buffer> | Readable): Promise<
    | { status: "ok"; bytes: number }
    | { status: "complete" }
    | { status: "size-mismatch"; size: number }
    | { status: "out-of-range"; count: number }
    | { status: "length"; expected: number; got: number }
    | { status: "discarded" }
  >;
  complete(hash: string): Promise<
    | { status: "ok"; size: number; ext: string }
    | { status: "unknown" }
    | { status: "incomplete"; missing: number[] }
    | { status: "hash-mismatch"; actual: string }
  >;
  remove(hash: string): Promise<boolean>;
  usage(): Promise<{ blobs: number; bytes: number; staging: number }>;
}

/** 缺省的数据层:fs 实现,目录是本地内容库;找文件、写索引、Content-Type 都用 vite-plugin-media 已有的 */
export function defaultAssetStore(root: string): AssetBlobStore {
  return createBlobStore({
    kind: "fs",
    dir: mediaDir(root),
    hooks: {
      resolveFile: (hash: string) => resolveHashFile(root, hash),
      onStored: ({ hash, file, ext, size, contentType }: { hash: string; file: string; ext: string; size: number; contentType: string }) =>
        writeMediaIndex(root, hash, { file, ext, size, contentType }),
      contentTypeForExt,
    },
  }) as AssetBlobStore;
}

/** 产物命名空间的 Content-Type:快照是 HTML,init 是 mp4,分段是 m4s;其余照素材的表 */
function artifactContentType(ext: string): string {
  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  if (e === "html" || e === "htm") return "text/html; charset=utf-8";
  if (e === "m4s") return "video/iso.segment";
  return contentTypeForExt(e);
}

/** 产物命名空间的 fs 目录:`<root>/out/asset-store/<ns>`(契约第 1 节) */
export function artifactStoreDir(root: string, ns: "snap" | "px"): string {
  return path.resolve(root, "out", "asset-store", ns);
}

/**
 * 产物命名空间(`snap` / `px`)缺省的数据层:fs 实现。钩子不写媒体索引 ——
 * 找文件用 fs 实现自带的「`<hash>` 或 `<hash>.<ext>`」,入库后什么都不做。
 */
export function defaultArtifactStore(root: string, ns: "snap" | "px"): AssetBlobStore {
  return createBlobStore({
    kind: "fs",
    dir: artifactStoreDir(root, ns),
    hooks: { onStored: () => {}, contentTypeForExt: artifactContentType },
  }) as AssetBlobStore;
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
  // 声明了长度、且不超过一片的请求体:读完扔掉再回,客户端能干净地收到这个 4xx(不然它还在发、
  // 我们先掐了连接,它看到的只是 ECONNRESET)。长度不明或超过一片的才直接掐。
  const declared = Number(req.headers["content-length"]);
  if (Number.isSafeInteger(declared) && declared >= 0 && declared <= ASSET_CHUNK_SIZE && !req.readableEnded) {
    void drain(req).then(() => sendJson(res, status, body));
    return;
  }
  res.setHeader("Connection", "close");
  sendJson(res, status, body);
  res.once("finish", () => req.destroy());
  setTimeout(() => req.destroy(), 1000).unref?.();
}

/** 请求体读完扔掉 */
function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => { req.on("end", resolve); req.on("error", () => resolve()); req.on("close", () => resolve()); req.resume(); });
}

/** 对账:`GET media/<hash>/chunks` 的回包。`store` 缺省是 `root` 的本地内容库 */
export async function chunkStatus(root: string, hash: string, store: AssetBlobStore = defaultAssetStore(root)) {
  return store.chunks(hash);
}

async function handlePutChunk(req: IncomingMessage, res: ServerResponse, store: AssetBlobStore, hash: string, rawN: string, ns: AssetNamespace = "media") {
  if (!/^(0|[1-9]\d*)$/.test(rawN)) return reject(req, res, 400, { ok: false, error: "bad-chunk-number" });
  const n = Number(rawN);
  const sizeHeader = String(req.headers["x-media-size"] || "").trim();
  if (!/^[1-9]\d*$/.test(sizeHeader)) return reject(req, res, 400, { ok: false, error: "missing-size", detail: "每一片都要带 X-Media-Size(全件字节数)" });
  const size = Number(sizeHeader);
  if (!Number.isSafeInteger(size) || size > ASSET_MAX_SIZE) return reject(req, res, 413, { ok: false, error: "too-large" });
  const count = chunkCount(size, store.chunkSize);
  if (n >= count) return reject(req, res, 416, { ok: false, error: "chunk-out-of-range", count });
  const expected = chunkLength(size, n, store.chunkSize);
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) !== expected) {
    return reject(req, res, 400, { ok: false, error: "chunk-length", expected, got: Number(declared) });
  }

  let out;
  try {
    out = await store.putChunk(hash, n, { size, ext: extFromHeaders(req, ns) }, req);
  } catch (err) {
    // 断线:对面已经不在了,回什么都收不到;这一片的标记没补,对账时报「没收到」
    if (!res.headersSent && !res.destroyed) sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  switch (out.status) {
    case "ok": return sendJson(res, 200, { ok: true, hash, n, bytes: out.bytes });
    // 已入库:数据层已经把请求体读完丢掉了,幂等回 200
    case "complete": return sendJson(res, 200, { ok: true, hash, n, bytes: expected, complete: true });
    case "size-mismatch": return reject(req, res, 409, { ok: false, error: "size-mismatch", size: out.size });
    case "out-of-range": return reject(req, res, 416, { ok: false, error: "chunk-out-of-range", count: out.count });
    case "length": return sendJson(res, 400, { ok: false, error: "chunk-length", expected: out.expected, got: out.got });
    case "discarded": return sendJson(res, 409, { ok: false, error: "staging-discarded" });
  }
}

async function handleComplete(res: ServerResponse, store: AssetBlobStore, hash: string, ns: AssetNamespace = "media") {
  const out = await store.complete(hash);
  switch (out.status) {
    case "ok": return sendJson(res, 200, { ok: true, hash, size: out.size, complete: true, url: ns === "media" ? `/@media/${hash}` : `/api/asset/${ns}/${hash}` });
    case "unknown": return sendJson(res, 404, { ok: false, error: "unknown-hash" });
    case "incomplete": return sendJson(res, 400, { ok: false, error: "incomplete", missing: out.missing });
    case "hash-mismatch": return sendJson(res, 409, { ok: false, error: "hash-mismatch", actual: out.actual });
  }
}

/**
 * 按哈希取回。响应头与 vite-plugin-media 的 serveFile 一样:200 / 206 / 416,
 * Content-Type、Content-Length、Accept-Ranges、Last-Modified(数据层给不出修改时间就不发)、Content-Range。
 */
async function serveBlob(req: IncomingMessage, res: ServerResponse, store: AssetBlobStore, hash: string) {
  const stat = await store.stat(hash);
  if (!stat) return sendJson(res, 404, { ok: false, error: "not-found" });
  const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
  const head = req.method === "HEAD";
  // Last-Modified:没有内容哈希的迁移期素材,帧管线按 `HEAD` 的 Content-Length + Last-Modified 打戳
  const lastModified = stat.mtimeMs === null || stat.mtimeMs === undefined ? null : new Date(stat.mtimeMs).toUTCString();

  if (range === "unsatisfiable") {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
    return res.end();
  }
  const headers: Record<string, string | number> = range
    ? {
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": (range.end - range.start) + 1,
      "Content-Type": stat.contentType,
    }
    : {
      "Content-Length": stat.size,
      "Content-Type": stat.contentType,
      "Accept-Ranges": "bytes",
    };
  if (lastModified !== null) headers["Last-Modified"] = lastModified;
  // 流先打开再发头:入库的东西万一刚被删,还能干净地回 404
  const stream = head ? null : await store.read(hash, range ? { start: range.start, end: range.end } : {});
  if (!head && !stream) return sendJson(res, 404, { ok: false, error: "not-found" });
  res.writeHead(range ? 206 : 200, headers);
  if (!stream) return res.end();
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/* ------------------------------------------------------------------ *
 * 写入鉴权
 * ------------------------------------------------------------------ */

/** 缺省的「本机」判据:对端是回环地址。舞台端口的反向代理转来的请求按它写进的真实对端判(`clientAddressOf`) */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = clientAddressOf(req);
  return address !== null && isLoopbackAddress(address);
}

/** `Authorization: Bearer <令牌>` 里的令牌;没带或格式不对给 null */
function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

const sha256Of = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest();

/** 两边各取 sha256 再定长比较,不因长度或前缀不同而提前返回 */
function tokenMatches(given: string, token: string): boolean {
  return crypto.timingSafeEqual(sha256Of(given), sha256Of(token));
}

function writeAllowed(req: IncomingMessage, token: string | null, isTrusted: (req: IncomingMessage) => boolean): boolean {
  let trusted = false;
  try { trusted = !!isTrusted(req); } catch { trusted = false; }
  if (trusted) return true;
  if (!token) return false; // 没配令牌:非本机的写一律拒,失败即关
  const given = bearerOf(req);
  return given !== null && tokenMatches(given, token);
}

/* ------------------------------------------------------------------ *
 * 中间件
 * ------------------------------------------------------------------ */

/** 这条请求归不归素材服务的跨源规则管:`/api/asset/<ns>/...`(三个命名空间,严格匹配)和 `/@media/*` */
export function isAssetCorsPath(url: string | undefined): boolean {
  return isAssetServicePath(url) || String(url || "").startsWith("/@media/");
}

/**
 * 来源是不是回环或局域网地址:localhost / *.localhost / *.local、127.0.0.0/8、10/8、172.16/12、192.168/16、
 * 169.254/16、IPv6 的 ::1、fc00::/7、fe80::/10。素材服务要让局域网里的设备直接访问
 * (`docs/semantics/architecture/asset-storage.md`「职责」),没说要让公网网页访问本机 ——
 * 私有网络访问只放给这些来源,取最保守的一边。认不出的来源一律当公网。
 */
export function isPrivateOrigin(origin: string | string[] | undefined): boolean {
  let host: string;
  try { host = new URL(String(origin || "")).hostname.toLowerCase(); } catch { return false; }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return v6 === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function applyCors(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", ASSET_EXPOSE_HEADERS);
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", ASSET_ALLOW_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ASSET_ALLOW_HEADERS);
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.headers["access-control-request-private-network"] && isPrivateOrigin(req.headers.origin)) res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

/**
 * 素材服务路由的预检,**必须排在 vite 自带的 cors 中间件前面**。
 *
 * vite 的 `server.cors` 默认只放行 localhost / 127.0.0.1 / [::1] 的源,而且它排在所有插件中间件之前:
 * 局域网设备(比如 `http://192.168.1.50:8080`)的预检被它当场答成 204、却不带
 * `Access-Control-Allow-Origin`,浏览器判预检失败,请求根本到不了 assetServiceMiddleware(实测过)。
 * 所以媒体插件把这一个中间件插到 connect 栈的最前面(`middlewares.stack.unshift`),只答素材服务路由的 OPTIONS,
 * 别的请求原样放过。vite.config.ts 的 `server.cors` 不动,其余路由的跨源行为一点不变。
 */
export function assetPreflightMiddleware() {
  return function assetPreflight(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (req.method !== "OPTIONS" || !isAssetCorsPath(req.url)) return next();
    applyCors(req, res);
    res.statusCode = 204;
    res.end();
  };
}

/**
 * 素材服务的中间件。`/api/asset/<ns>/...`(`media`、`snap`、`px`)全部在这里答完;`/@media/*` 只补 CORS 头、答预检,
 * 取字节仍交给 `vite-plugin-media.ts` 的 mediaMiddleware(next)。别的请求原样 next。
 *
 * 选项(契约 `docs/plan/asset-store-contract.md` 第 3、4 节;`artifact-transfer-contract.md` 第 1 节):
 * - `stores`:三个命名空间各自的数据层 `{ media?, snap?, px? }`。缺的用缺省:`media` 是 `root` 的本地内容库
 *   (`defaultAssetStore`),`snap` / `px` 是 `<root>/out/asset-store/<ns>` 的 fs 实现(`defaultArtifactStore`,用到时才建);
 * - `store`:旧名,仍然认,当作 `stores.media`(两个都给时 `stores.media` 优先);
 * - `token`:集群令牌,缺省在这里读一次 `PROMPTCUT_CLUSTER_TOKEN`,没设是 null;空串也当没设;
 * - `isTrusted`:哪些请求算本机,缺省 `isLoopbackRequest`。
 */
export interface AssetServiceOptions {
  stores?: { media?: AssetBlobStore; snap?: AssetBlobStore; px?: AssetBlobStore };
  store?: AssetBlobStore;
  token?: string | null;
  isTrusted?: (req: IncomingMessage) => boolean;
}

export function assetServiceMiddleware(root: string, opts: AssetServiceOptions = {}) {
  const media = opts.stores?.media ?? opts.store ?? defaultAssetStore(root);
  const artifactStores: Partial<Record<"snap" | "px", AssetBlobStore>> = { snap: opts.stores?.snap, px: opts.stores?.px };
  const storeOf = (ns: AssetNamespace): AssetBlobStore => {
    if (ns === "media") return media;
    return (artifactStores[ns] ??= defaultArtifactStore(root, ns));
  };
  const rawToken = opts.token !== undefined ? opts.token : (process.env.PROMPTCUT_CLUSTER_TOKEN ?? null);
  const token = typeof rawToken === "string" && rawToken !== "" ? rawToken : null;
  const isTrusted = typeof opts.isTrusted === "function" ? opts.isTrusted : isLoopbackRequest;
  return async function assetService(req: Connect.IncomingMessage, res: ServerResponse, next: () => void) {
    if (!isAssetCorsPath(req.url)) return next();
    applyCors(req, res);
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (!isAssetServicePath(req.url)) return next(); // /@media/* 的 GET / HEAD

    // 判据和同源守卫的豁免是同一条正则,守卫放过来的请求从这里起一定有回应,不会 next 给别的 /api 处理函数
    const parts = apiPath(req.url).split("/"); // ["", "api", "asset", <ns>, <hash>, <tail>?]
    const ns = parts[3] as AssetNamespace; // 正则只放过 media / snap / px
    const hash = parts[4];
    const tail = parts[5];
    const method = String(req.method || "GET").toUpperCase();
    try {
      const store = storeOf(ns);
      if (!isMediaHash(hash)) return sendJson(res, 400, { ok: false, error: "bad-hash" });
      if (tail === undefined) {
        if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { ok: false, error: "method" });
        return await serveBlob(req, res, store, hash);
      }
      if (tail === "chunks") {
        if (method !== "GET") return sendJson(res, 405, { ok: false, error: "method" });
        return sendJson(res, 200, await store.chunks(hash));
      }
      if (tail === "complete") {
        if (method !== "POST") return sendJson(res, 405, { ok: false, error: "method" });
        if (!writeAllowed(req, token, isTrusted)) return reject(req, res, 401, { ok: false, error: "unauthorized" });
        return await handleComplete(res, store, hash, ns);
      }
      if (method !== "PUT") return reject(req, res, 405, { ok: false, error: "method" });
      if (!writeAllowed(req, token, isTrusted)) return reject(req, res, 401, { ok: false, error: "unauthorized" });
      return await handlePutChunk(req, res, store, hash, tail, ns);
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
