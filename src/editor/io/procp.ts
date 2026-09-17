import type { Project } from "../../kernel/project";

/**
 * `.procp` —— 「编排 + 素材」的打包件。
 *
 * 结构:一个 zip,**第一个条目一定是 `project.proc`**(不解压也能 head 出编排),
 * 其余是 `media/<hash>.<原扩展名>` —— 名字就是内容哈希,所以同一份内容在包里只有一份,
 * 装包和拆包都天然去重。
 *
 * 为什么自己写 zip:项目里没有 zip 依赖(package.json 里一个都没有),而这里要的东西
 * 很小 —— 素材(mp4 / jpg / mp3)本来就是压过的,再 deflate 一遍只费 CPU 不省字节,
 * 所以写的时候一律 store(method 0),只有编排那一条文本也 store(几十 KB)。
 * 读的时候连别人用普通 zip 工具压出来的 deflate 条目一起认(DecompressionStream)。
 *
 * 全程走 Blob 不走 ArrayBuffer:几 GB 的素材由浏览器托管(可以落在磁盘上),
 * 页面只按块流过去算 CRC / 传给服务端,主线程不持有整份字节。
 *
 * **这个文件顶上只有类型 import**:zip 读写和装拆包都只用 Blob / fetch / DecompressionStream,
 * 编辑器那一侧(store、proc.ts 里的 React 依赖)只在最外面那两个薄包装里动态 import。
 * 于是 `node --test` 能直接加载它,zip 的字节格式有单测兜着(见 procp.test.mjs)。
 */

export const PROCP_EXT = ".procp";
const PROC_ENTRY = "project.proc";
const MEDIA_PREFIX = "media/";

/**
 * 这个文件是不是 .procp 包。
 *
 * 名字对不上也再看一眼头四个字节(`PK\x03\x04`)—— 用户可能把包改了名,
 * 而拿 `.text()` 去读一个几 GB 的 zip 只会把页面读死,所以必须在 read 之前就分流。
 */
export async function isProcpFile(file: Blob & { name?: string }): Promise<boolean> {
  if (typeof file?.name === "string" && file.name.toLowerCase().endsWith(PROCP_EXT)) return true;
  if (!file || file.size < 4) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/* ------------------------------ zip 基本件 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

/** 流着算 CRC32:整份字节不进 JS 堆 */
async function crc32OfBlob(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    crc = crc32Update(crc, value as Uint8Array);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

function bytes(len: number) {
  const buf = new Uint8Array(new ArrayBuffer(len));
  const view = new DataView(buf.buffer);
  return { buf, view };
}

interface PackEntry { name: string; blob: Blob }

/** store-only zip。条目顺序就是写进去的顺序 —— project.proc 排第一。单测直接用它验字节格式 */
export async function writeZip(entries: PackEntry[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const { time, date } = dosTime(new Date());
  let offset = 0;

  for (const entry of entries) {
    // 拷一份到自己的 ArrayBuffer:TextEncoder 给的视图类型上不保证不是 SharedArrayBuffer,Blob 不收
    const encoded = new TextEncoder().encode(entry.name);
    const name = new Uint8Array(encoded.length);
    name.set(encoded);
    const size = entry.blob.size;
    const crc = await crc32OfBlob(entry.blob);

    const local = bytes(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);   // version needed
    local.view.setUint16(6, 0x0800, true); // UTF-8 名字
    local.view.setUint16(8, 0, true);    // method: store
    local.view.setUint16(10, time, true);
    local.view.setUint16(12, date, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, size, true);
    local.view.setUint32(22, size, true);
    local.view.setUint16(26, name.length, true);
    local.view.setUint16(28, 0, true);
    parts.push(local.buf, name, entry.blob);

    const dir = bytes(46);
    dir.view.setUint32(0, 0x02014b50, true);
    dir.view.setUint16(4, 20, true);
    dir.view.setUint16(6, 20, true);
    dir.view.setUint16(8, 0x0800, true);
    dir.view.setUint16(10, 0, true);
    dir.view.setUint16(12, time, true);
    dir.view.setUint16(14, date, true);
    dir.view.setUint32(16, crc, true);
    dir.view.setUint32(20, size, true);
    dir.view.setUint32(24, size, true);
    dir.view.setUint16(28, name.length, true);
    dir.view.setUint32(42, offset, true);
    const dirEntry = new Uint8Array(46 + name.length);
    dirEntry.set(dir.buf, 0);
    dirEntry.set(name, 46);
    central.push(dirEntry);

    offset += 30 + name.length + size;
  }

  const centralSize = central.reduce((n, e) => n + e.length, 0);
  const end = bytes(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buf], { type: "application/zip" });
}

interface ReadEntry { name: string; method: number; size: number; blob: Blob }

async function sliceView(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/** 读中央目录。条目数据按 Blob 切出来,不整份读进内存。单测直接用它验字节格式 */
export async function readZip(file: Blob): Promise<ReadEntry[]> {
  const tailLen = Math.min(file.size, 66560); // 64 KiB + EOCD:够覆盖带注释的包
  const tail = new Uint8Array(await file.slice(file.size - tailLen, file.size).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("这不是一个 .procp 包(没找到 zip 目录)");
  const end = new DataView(tail.buffer, tail.byteOffset + eocd, 22);
  const count = end.getUint16(10, true);
  const cdOffset = end.getUint32(16, true);
  const cdSize = end.getUint32(12, true);

  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const out: ReadEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const size = cd.getUint32(p + 24, true);
    const csize = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    const head = await sliceView(file, local, local + 30);
    const dataStart = local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    out.push({ name, method, size, blob: file.slice(dataStart, dataStart + csize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 条目的原始字节。store 直接给,deflate 走浏览器自带的解压流(别人用普通 zip 工具压的包也认) */
export function inflate(entry: ReadEntry): Blob | Promise<Blob> {
  if (entry.method === 0) return entry.blob;
  if (entry.method !== 8) throw new Error(`.procp 里有不认识的压缩方式(${entry.method}):${entry.name}`);
  const ds = new DecompressionStream("deflate-raw");
  return new Response(entry.blob.stream().pipeThrough(ds)).blob();
}

/* ------------------------------ 装包 / 拆包 ------------------------------ */

/** 项目里每条素材的 <hash>.<ext>(按哈希去重) */
function mediaEntries(project: Project): { hash: string; file: string }[] {
  const seen = new Map<string, string>();
  for (const m of project.media || []) {
    if (!m.hash || seen.has(m.hash)) continue;
    const ext = (m.ext || (m.name || "").split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    seen.set(m.hash, ext ? `${m.hash}.${ext}` : m.hash);
  }
  return [...seen].map(([hash, file]) => ({ hash, file }));
}

/**
 * 当前项目 → .procp 包。素材从本地内容库按 /@media/<hash> 取回来装进去;
 * 取不到的那条跳过(包里缺它,拆包方会当成缺失素材),不让一条坏素材毁掉整次导出。
 */
export async function packProcp(): Promise<Blob> {
  const { serializeProc } = await import("./proc.ts");
  const { getState } = await import("../../store/project.ts");
  return packProcpFrom(serializeProc(), getState().project);
}

/**
 * 装包本体。和 store 分开是为了能单测(见 procp.test.mjs)—— 它只认一份编排文本
 * 和一份 Project,素材从 /@media/<hash> 取。
 */
export async function packProcpFrom(procText: string, project: Project): Promise<Blob> {
  const entries: PackEntry[] = [{ name: PROC_ENTRY, blob: new Blob([procText], { type: "application/json" }) }];
  for (const { hash, file } of mediaEntries(project)) {
    try {
      const res = await fetch(`/@media/${hash}`);
      if (!res.ok) { console.warn(`[procp] 本地内容库里没有 ${hash},跳过`); continue; }
      entries.push({ name: MEDIA_PREFIX + file, blob: await res.blob() });
    } catch (err) {
      console.warn(`[procp] 取素材失败 ${hash}`, err);
    }
  }
  return writeZip(entries);
}

/** 这些哈希里哪些已经在本地内容库(拆包时用来跳过已有素材) */
async function alreadyLocal(hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  try {
    const res = await fetch(`/api/media/local?hashes=${hashes.join(",")}`);
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set<string>(Array.isArray(data?.hashes) ? data.hashes : []);
  } catch {
    return new Set();
  }
}

export interface UnpackResult {
  procText: string;
  /** 这次真正写进内容库的素材数 */
  stored: number;
  /** 库里已经有、跳过的素材数 */
  deduped: number;
}

/**
 * 拆包:素材落进本地内容库(按哈希去重,库里已有的一份字节都不传),编排原样返回。
 *
 * 落库走的还是 `/api/media/upload/<名字>` —— 服务端照样边落盘边算哈希,所以包里
 * 条目名写错了也污染不了内容库(它会落在自己**真正**的哈希下)。
 */
export async function unpackProcp(file: Blob): Promise<UnpackResult> {
  const entries = await readZip(file);
  const proc = entries.find((e) => e.name === PROC_ENTRY) || entries[0];
  if (!proc) throw new Error("这不是一个 .procp 包(里面是空的)");
  const procText = await (await inflate(proc)).text();

  const media = entries.filter((e) => e.name.startsWith(MEDIA_PREFIX) && e !== proc);
  const hashOf = (name: string) => name.slice(MEDIA_PREFIX.length).split(".")[0].toLowerCase();
  const have = await alreadyLocal(media.map((e) => hashOf(e.name)).filter((h) => /^[0-9a-f]{64}$/.test(h)));

  let stored = 0;
  let deduped = 0;
  for (const entry of media) {
    const hash = hashOf(entry.name);
    if (have.has(hash)) { deduped += 1; continue; }
    const name = entry.name.slice(MEDIA_PREFIX.length);
    try {
      const body = await inflate(entry);
      const res = await fetch(`/api/media/upload/${encodeURIComponent(name)}`, { method: "POST", body });
      if (!res.ok) { console.warn(`[procp] 素材落库失败: ${name}`); continue; }
      const data = await res.json();
      if (data?.deduped) deduped += 1; else stored += 1;
    } catch (err) {
      console.warn(`[procp] 素材落库异常: ${name}`, err);
    }
  }
  return { procText, stored, deduped };
}

/** 拆包并载入(和打开 .proc 走同一条路,素材地址由 restoreMediaUrls 按 hash 还原) */
export async function loadProcpFile(file: Blob): Promise<Project> {
  const { procText } = await unpackProcp(file);
  const { loadProc } = await import("./proc.ts");
  return loadProc(procText);
}
