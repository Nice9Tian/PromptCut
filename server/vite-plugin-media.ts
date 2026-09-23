import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "http";
import type { Readable } from "stream";
import path from "path";
import fs from "fs/promises";
import os from "os";
import crypto from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { spawn } from "child_process";
import { Transform } from "stream";
import { pipeline } from "stream/promises";

function sanitizeFilename(name: string) {
  return name.replace(/[/\\]/g, "").replace(/\.\./g, "");
}

function outRoot(root: string): string {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(root, "out");
}

function inside(file: string, dir: string): boolean {
  const target = path.resolve(file);
  const base = path.resolve(dir);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Old .proc files store an absolute path from the desktop media library.  The
 * browser cannot read that path directly, so expose only the two media roots
 * owned by PromptCut (current out/media and the legacy Videos/PromptCut/media
 * folder).  The path is never accepted as an arbitrary file read.
 */
function allowedMediaRoots(root: string): string[] {
  const roots = [mediaDir(root)];
  const legacy = path.join(os.homedir(), "Videos", "PromptCut", "media");
  roots.push(legacy);
  if (process.env.PROMPTCUT_MEDIA_DIR) roots.push(path.resolve(process.env.PROMPTCUT_MEDIA_DIR));
  return roots;
}

async function handleMediaFile(req: Connect.IncomingMessage, res: ServerResponse, root: string) {
  try {
    const query = new URL(req.url || "/", "http://promptcut.local").searchParams;
    const raw = query.get("path");
    if (!raw) { res.statusCode = 400; return res.end("Missing media path"); }
    const file = path.resolve(raw);
    const roots = allowedMediaRoots(root);
    if (!roots.some((dir) => inside(file, dir))) {
      res.statusCode = 403;
      return res.end("Media path is outside PromptCut media folders");
    }
    return serveFile(file, req, res);
  } catch {
    res.statusCode = 400;
    res.end("Invalid media path");
  }
}

/**
 * 素材落盘目录。上传和素材收集(vite-plugin-collect)都往这里写,
 * 所以 /@media/<文件名> 对两边的文件都能取到。
 *
 * A1 之后这里同时是**本地内容库**:导入的素材按 `<sha256>.<原扩展名>` 存,
 * 同一份内容只有一份文件 —— 改了 mtime、换了文件名再导入一次还是同一个键。
 */
export function mediaDir(root: string): string {
  return path.resolve(outRoot(root), "media");
}

/* ------------------------------------------------------------------ *
 * 内容哈希与本地内容库
 * ------------------------------------------------------------------ */

/** 64 位 hex,可带扩展名:/@media/<hash> 和 /@media/<hash>.<ext> 都认 */
const HASH_URL = /^([0-9a-fA-F]{64})(?:\.([A-Za-z0-9]+))?$/;

export function isMediaHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(String(value || "").toLowerCase());
}

/** 文件名里的扩展名(不含点,小写)。没有扩展名给空串 */
export function extOfName(name: string): string {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return "";
  return base.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** 扩展名 → Content-Type。认不出给 application/octet-stream */
export function contentTypeForExt(ext: string): string {
  return CONTENT_TYPES[String(ext || "").toLowerCase().replace(/^\./, "")] || "application/octet-stream";
}

export function contentTypeForFile(filePath: string): string {
  return contentTypeForExt(extOfName(filePath));
}

export interface MediaIndexEntry {
  /** 本地内容库里的文件名(<hash>.<ext>) */
  file: string;
  /** 导入时的原文件名,只用来显示和 .procp 里还原 */
  name?: string;
  ext?: string;
  size?: number;
  contentType?: string;
}

type MediaIndex = Record<string, MediaIndexEntry>;

/** 索引文件:out/media/index.json。丢了也不致命 —— 查不到会退回扫目录 */
function indexPath(root: string): string {
  return path.join(mediaDir(root), "index.json");
}

const indexCache = new Map<string, MediaIndex>();

export async function readMediaIndex(root: string): Promise<MediaIndex> {
  const cached = indexCache.get(root);
  if (cached) return cached;
  let parsed: MediaIndex = {};
  try {
    const text = await fs.readFile(indexPath(root), "utf8");
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && raw.items && typeof raw.items === "object") parsed = raw.items as MediaIndex;
  } catch { /* 没索引就是空索引 */ }
  indexCache.set(root, parsed);
  return parsed;
}

export async function writeMediaIndex(root: string, hash: string, entry: MediaIndexEntry): Promise<void> {
  const index = await readMediaIndex(root);
  index[hash] = entry;
  try {
    await fs.mkdir(mediaDir(root), { recursive: true });
    await fs.writeFile(indexPath(root), JSON.stringify({ version: 1, items: index }, null, 2));
  } catch (err) {
    console.warn("[media] 写索引失败", err);
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; } catch { return false; }
}

/**
 * 哈希 → 本地内容库里的文件。三条路:URL 自带扩展名 → 索引 → 扫目录(索引丢了还能救)。
 * 找不到返回 null(A1 第 5 步会在这里先去素材云端拉,再边落边服务)。
 */
export async function resolveHashFile(root: string, hash: string, ext?: string): Promise<string | null> {
  const key = String(hash || "").toLowerCase();
  if (!isMediaHash(key)) return null;
  const dir = mediaDir(root);
  if (ext) {
    const direct = path.join(dir, `${key}.${ext.toLowerCase()}`);
    if (await exists(direct)) return direct;
  }
  const index = await readMediaIndex(root);
  const entry = index[key];
  if (entry?.file) {
    const file = path.join(dir, sanitizeFilename(entry.file));
    if (await exists(file)) return file;
  }
  try {
    const names = await fs.readdir(dir);
    const hit = names.find((n) => n.toLowerCase() === key || n.toLowerCase().startsWith(key + "."));
    if (hit) {
      // 索引缺了就地补上,下次不用再扫
      indexCache.set(root, { ...index, [key]: { file: hit, ext: extOfName(hit), contentType: contentTypeForFile(hit) } });
      return path.join(dir, hit);
    }
  } catch { /* 目录还不存在 */ }
  return null;
}

/** 这些哈希里哪些已经完整落在本地内容库(A1 第 5 步的预取队列问的也是这条) */
export async function localHashes(root: string, hashes: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of hashes) {
    if (!isMediaHash(h)) continue;
    if (await resolveHashFile(root, h)) out.push(h.toLowerCase());
  }
  return out;
}

/** 已经落盘的文件算一次 sha256(流式,常数内存) */
export async function hashFile(filePath: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  await pipeline(createReadStream(filePath), digest);
  return digest.digest("hex");
}

export interface StoredMedia {
  hash: string;
  ext: string;
  name: string;
  bytes: number;
  /** 本地内容库里的绝对路径 */
  path: string;
  /** 素材地址:身份就是哈希,不带扩展名 */
  url: string;
  contentType: string;
  /** 这次之前库里就有同样内容(mtime / 文件名不同也算同一份) */
  deduped: boolean;
}

/**
 * **边落盘边算哈希**:请求体一路 pipe 到临时文件,每块顺手 update 一次 sha256,
 * 全程常数内存 —— 4 GB 的视频不会有任何一刻整份待在内存里,也没有一个长任务
 * 卡住事件循环(每块几十 KiB 的 hash.update 是几十微秒级),所以主服务在导入
 * 期间照样能在 100 ms 内答别的请求。算完才按 <hash>.<ext> 改名落库:
 * 库里已经有同样内容就直接删掉临时文件(去重),两次导入同一内容拿到同一个键。
 */
export async function storeMediaStream(root: string, name: string, source: Readable): Promise<StoredMedia> {
  const dir = mediaDir(root);
  await fs.mkdir(dir, { recursive: true });
  let decoded = String(name || "");
  try { decoded = decodeURIComponent(decoded); } catch { /* 不是 %xx 就按原样 */ }
  const safeName = sanitizeFilename(decoded);
  const ext = extOfName(safeName);
  const tmp = path.join(dir, `.upload-${crypto.randomBytes(8).toString("hex")}.part`);

  const digest = crypto.createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      digest.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  try {
    await pipeline(source, tap, createWriteStream(tmp));
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }

  const hash = digest.digest("hex");
  const file = ext ? `${hash}.${ext}` : hash;
  const dest = path.join(dir, file);
  const had = await exists(dest);
  if (had) await fs.rm(tmp, { force: true });
  else await fs.rename(tmp, dest);

  const contentType = contentTypeForExt(ext);
  await writeMediaIndex(root, hash, { file, name: safeName, ext, size: bytes, contentType });
  return { hash, ext, name: safeName, bytes, path: dest, url: `/@media/${hash}`, contentType, deduped: had };
}

/**
 * 给一个**已经在素材目录里**的文件补算内容键(素材收集下载好的那种)。
 *
 * 那条路不经过上传,文件本来就在服务端,再从浏览器 POST 一遍几百 MB 纯属浪费;
 * 但没有键它就进不了 .procp、也享受不到跨机器去重。所以在服务端就地流式算一遍
 * sha256(hashFile,常数内存、不卡事件循环),然后把它挂进内容库:
 * 先试硬链接(同一卷上不占第二份字节),不行才拷。原文件留在原处不动 ——
 * 素材收集那一侧可能还按原名在引用它。
 */
export async function adoptMediaFile(root: string, filePath: string): Promise<StoredMedia> {
  const dir = mediaDir(root);
  await fs.mkdir(dir, { recursive: true });
  const src = path.resolve(filePath);
  const stat = await fs.stat(src);
  const name = path.basename(src);
  const ext = extOfName(name);
  const hash = await hashFile(src);
  const file = ext ? `${hash}.${ext}` : hash;
  const dest = path.join(dir, file);

  const had = await exists(dest);
  if (!had && path.resolve(dest) !== src) {
    try { await fs.link(src, dest); }
    catch { await fs.copyFile(src, dest); }
  }
  const contentType = contentTypeForExt(ext);
  await writeMediaIndex(root, hash, { file, name, ext, size: stat.size, contentType });
  return { hash, ext, name, bytes: stat.size, path: dest, url: `/@media/${hash}`, contentType, deduped: had };
}

async function handleMediaUpload(req: Connect.IncomingMessage, res: ServerResponse, root: string) {
  const rawName = req.url?.split("?")[0].split("/").pop();
  if (!rawName) {
    res.statusCode = 400;
    res.end("Missing filename");
    return;
  }
  try {
    const stored = await storeMediaStream(root, rawName, req as unknown as Readable);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      hash: stored.hash,
      ext: stored.ext,
      name: stored.name,
      path: stored.path,
      url: stored.url,
      bytes: stored.bytes,
      deduped: stored.deduped,
    }));
  } catch (err: unknown) {
    res.statusCode = 500;
    res.end(err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------------------------------------------ *
 * GET /@media/<hash>/pcm —— 音频图卡的素材输入
 * ------------------------------------------------------------------ */

/** 路由里的哈希。必须排在 /@media/<文件名> 之前,不然 `.pop()` 取出来的是 "pcm" */
const PCM_URL = /^\/@media\/([^/?]+)\/pcm$/;
const PCM_MAX_FRAMES = 1048576;
const PCM_CHANNELS = 2;
const PCM_MAX_BYTES = 256 * 1024 * 1024;

/**
 * ffmpeg 在哪。**惰性**取:vite 配置加载时不该把整个 server/bakery 拖进来,
 * 而且 server/test 里把这个插件转译到临时目录再 import 的那几个测试也不能因此解析失败。
 */
async function ffmpegCommand(): Promise<string> {
  const { findFfmpeg } = await import("./bakery/index.mjs");
  return findFfmpeg();
}

/** card-service.mjs:47 的 commandBuffer。子进程的标准输出收成一个 Buffer,超预算就杀掉 */
function commandBuffer(executable: string, args: string[], max = PCM_MAX_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const parts: Buffer[] = [];
    let size = 0, diagnostic = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) { child.kill(); reject(new Error("Source buffer exceeds budget")); }
      else parts.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk).slice(-4096); });
    child.on("error", reject);
    child.on("close", (code) => { if (code !== 0) reject(new Error(`Source decoder failed: ${diagnostic}`)); else resolve(Buffer.concat(parts)); });
  });
}

/**
 * 素材的一段 PCM(交错 f32le,恒 2 通道)。`card-service.mjs:308-313` 那段搬过来的:
 * 参数校验一起搬,只是不再写 `.bin` 回描述符,直接回字节。
 *
 * **没有 `offset` 参数**:`clip.mediaOffset + 边.offset` 由页面折算一次,折进 `start`。
 * 所以服务端的 `position = start`,可以为负(前面补静音),素材短于请求时尾部补零。
 */
async function handleMediaPcm(req: Connect.IncomingMessage, res: ServerResponse, root: string, hash: string) {
  try {
    const query = new URL(req.url || "/", "http://promptcut.local").searchParams;
    // 缺参数不能当 0:Number(null) 是 0,漏了 start 会静默从头裁
    const num = (name: string) => { const raw = query.get(name); return raw === null || raw.trim() === "" ? NaN : Number(raw); };
    const start = num("start"), count = num("count"), sampleRate = num("sampleRate");
    const channels = query.has("ch") ? num("ch") : PCM_CHANNELS;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1 || count > PCM_MAX_FRAMES
      || !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || channels !== PCM_CHANNELS) {
      res.statusCode = 400;
      return res.end("Invalid source audio range");
    }
    const file = await resolveHashFile(root, sanitizeFilename(hash).toLowerCase());
    if (!file) { res.statusCode = 404; return res.end("Not found"); }

    const position = start;
    const leading = Math.min(count, Math.max(0, -position));
    const pcm = leading === count ? Buffer.alloc(0) : await commandBuffer(await ffmpegCommand(), [
      "-v", "error", "-ss", String(Math.max(0, position) / sampleRate), "-i", file,
      "-t", String((count - leading) / sampleRate), "-vn",
      "-ar", String(sampleRate), "-ac", String(PCM_CHANNELS), "-f", "f32le", "pipe:1",
    ]);
    // 素材短于请求时尾部补零;position 为负时前 leading 帧是静音
    const bytes = Buffer.alloc(count * PCM_CHANNELS * 4);
    pcm.copy(bytes, leading * PCM_CHANNELS * 4, 0, Math.min(pcm.length, (count - leading) * PCM_CHANNELS * 4));
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store" });
    return res.end(bytes);
  } catch (err) {
    res.statusCode = 500;
    res.end(err instanceof Error ? err.message : String(err));
  }
}

/**
 * 解析 Range 头。只认单段 `bytes=a-b` / `bytes=a-` / `bytes=-n`(后缀);
 * 认不出的返回 null(当没带 Range,回整件 200),落在文件外的返回 "unsatisfiable"(回 416)。
 * 结尾超出文件的按 RFC 9110 截到最后一个字节。合法的 `bytes=a-b` 和原来的行为一字不差。
 */
export function parseRange(header: string, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number, end: number;
  if (m[1] === "") {
    const n = parseInt(m[2], 10);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

async function serveFile(filePath: string, req: Connect.IncomingMessage, res: ServerResponse) {
  try {
    const stat = await fs.stat(filePath);
    const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
    const contentType = contentTypeForFile(filePath);
    const head = req.method === "HEAD";

    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
      return res.end();
    }
    if (range) {
      const { start, end } = range;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": (end - start) + 1,
        "Content-Type": contentType,
      });
      if (head) return res.end();
      const stream = createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      if (head) return res.end();
      const stream = createReadStream(filePath);
      stream.pipe(res);
    }
  } catch (err) {
    res.statusCode = 404;
    res.end("Not found");
  }
}

export { serveFile };

/**
 * 媒体路由。和插件本身分开导出,单测可以直接把它架在一个裸 http server 上跑
 * (Range/206、哈希 URL 的 contentType、文件名回退都在这一层)。
 */
export function mediaMiddleware(root: string) {
  return async function media(req: Connect.IncomingMessage, res: ServerResponse, next: () => void) {
    if (!req.url) return next();

    // POST /api/media/upload/<文件名> —— 流式落盘 + 内容哈希
    if (req.method === "POST" && req.url.startsWith("/api/media/upload/")) {
      return handleMediaUpload(req, res, root);
    }

    // POST /api/media/adopt —— 给素材目录里已有的文件补算内容键(素材收集下载的那种)
    if (req.method === "POST" && req.url.startsWith("/api/media/adopt")) {
      try {
        const query = new URL(req.url, "http://promptcut.local").searchParams;
        const raw = query.get("path");
        if (!raw) { res.statusCode = 400; return res.end("Missing media path"); }
        const file = path.resolve(raw);
        if (!allowedMediaRoots(root).some((dir) => inside(file, dir))) {
          res.statusCode = 403;
          return res.end("Media path is outside PromptCut media folders");
        }
        const stored = await adoptMediaFile(root, file);
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({
          ok: true,
          hash: stored.hash,
          ext: stored.ext,
          name: stored.name,
          path: stored.path,
          url: stored.url,
          bytes: stored.bytes,
          deduped: stored.deduped,
        }));
      } catch (err: unknown) {
        res.statusCode = 500;
        return res.end(err instanceof Error ? err.message : String(err));
      }
    }

    // GET /api/media/local?hashes=a,b —— 这些哈希里哪些已经在本地内容库
    if (req.method === "GET" && req.url.startsWith("/api/media/local")) {
      const query = new URL(req.url, "http://promptcut.local").searchParams;
      const asked = (query.get("hashes") || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      const have = await localHashes(root, asked);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: true, hashes: have }));
    }

    // GET /api/media/file?path=<legacy absolute path>
    if (req.method === "GET" && req.url.startsWith("/api/media/file")) {
      return handleMediaFile(req, res, root);
    }

    // GET /@media/<hash>/pcm?start=&count=&sampleRate=&ch=2 —— 音频图卡的素材输入。
    // 一定要排在下面 /@media/<文件名> 那支之前:那支用 .split("/").pop() 取名,
    // 取到的会是 "pcm",取到了就直接 serveFile,这条路由永远轮不上。
    if (req.method === "GET") {
      const pcm = PCM_URL.exec(req.url.split("?")[0]);
      if (pcm) return handleMediaPcm(req, res, root, pcm[1]);
    }

    // GET /@media/<hash> | /@media/<hash>.<ext> | /@media/<文件名>(迁移期)
    if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/@media/")) {
      const rawName = req.url.split("?")[0].split("/").pop();
      if (rawName) {
        let decoded = rawName;
        try { decoded = decodeURIComponent(rawName); } catch { /* 原样 */ }
        const name = sanitizeFilename(decoded);
        const hashed = HASH_URL.exec(name);
        if (hashed) {
          const file = await resolveHashFile(root, hashed[1].toLowerCase(), hashed[2]);
          if (file) return serveFile(file, req, res);
          res.statusCode = 404;
          return res.end("Not found");
        }
        return serveFile(path.resolve(mediaDir(root), name), req, res);
      }
    }

    next();
  };
}

export function mediaPlugin(): Plugin {
  return {
    name: "vite-plugin-media",
    async configureServer(server) {
      const root = server.config.root;
      // 素材服务(第 5 步:分片上传、对账、按哈希取回、跨源)排在老路由前面:它先给 /@media/*
      // 补上 CORS 头、答预检,不归它管的请求再交给下面的 mediaMiddleware。
      // **惰性 import**:好几个单测把本文件单独转译到临时目录再 import,静态 import 兄弟模块会解析失败。
      const { assetServiceMiddleware, assetPreflightMiddleware } = await import("./asset-service");
      // 预检要抢在 vite 自带的 cors 中间件前面答(它不认局域网的源),理由见 assetPreflightMiddleware
      server.middlewares.stack.unshift({ route: "", handle: assetPreflightMiddleware() as Connect.NextHandleFunction });
      const { rememberLocalAssetOrigin } = await import("./asset-client");
      rememberLocalAssetOrigin(server.httpServer);
      const asset = assetServiceMiddleware(root);
      const handler = mediaMiddleware(root);
      server.middlewares.use((req, res, next) => { void asset(req, res, () => { void handler(req, res, next); }); });
    }
  };
}
