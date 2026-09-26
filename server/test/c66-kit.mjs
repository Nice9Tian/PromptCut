/**
 * 仅供测试，生产代码不得引用。
 *
 * C6.6 契约测试（`c66-*.test.mjs`）的公共件。依据只有 `docs/plan/c66-design.md` 第 2～5 节、第 6 节 T1～T8、
 * 第 8 节，以及 `docs/plan/cloud-task.md` A1 验收；测试方没看实现（`claude/c66-tiers`、`c66-fetch`、`c66-cards`）。
 *
 * 设计稿没写死的模块路径、函数名、参数与回包形状全部集中在本文件，集成时对账只改这里。
 * 每一处假设用「假设 K<n>」标出，报告 `docs/reports/AGENT-c66-tests.md` 按同样的编号列出。
 *
 *   K1  两档生成：新模块 `server/media-tiers.mjs`（设计稿第 2 节没点名文件）导出
 *       - `makeSmallTier({ ffmpeg, input, output })`：把 `input` 转成小版写到 `output`（mp4），resolve 即完成；
 *       - `hasFaststart(file)`：ISO BMFF（mp4 / mov / m4v）按顶层 box 顺序判，`moov` 在首个 `mdat` 前 → true，
 *         否则 false；不是 ISO BMFF（MKV、AVI 等）→ null（「不适用」）。可同步也可异步；
 *       - `ensureFaststart({ ffmpeg, input, workDir })` → `{ path, remuxed }`：需要就 `-c copy -movflags +faststart`
 *         重封装到 `workDir` 下的新文件；不需要或不适用 → `{ path: input, remuxed: false }`；
 *         **重封装失败不抛**，同样回 `{ path: input, remuxed: false }`，源文件不动；
 *       - `prepareTiers({ ffmpeg, input, kind, workDir })` → `{ original: { path, hash }, small?: { path, hash } }`，
 *         `kind` ∈ `'video' | 'audio' | 'image'`；`hash` = 该文件的 sha256（64 位小写 hex）。
 *       函数名允许下面 `pick` 里列的别名。
 *   K2  上传队列：新模块 `server/upload-queue.mjs` 导出 `createUploadQueue({ file, base, fetch, ticket, chunkSize })`：
 *       - `file`：持久化的 `upload-queue.json` 路径（测试给临时目录里的）；
 *       - `base`：素材服务 API 基址（形如 `http://127.0.0.1:<port>/api/asset`），所有请求经注入的 `fetch`；
 *       - `enqueue({ id, tiers: { small?: { hash, path, ext }, original: { hash, path, ext } } })`；
 *       - `drain()`：把队列跑空后 resolve；网络断了可以 reject，也可以一直等（测试用超时兜底）；
 *       - `close()`（或 `stop()`）：停下，已写进 `file` 的待办留着，新实例用同一个 `file` 建出来后 `drain()` 续传。
 *       分片上传沿用素材服务现有协议（`GET <ns>/<hash>/chunks`、`PUT <ns>/<hash>/<n>`、`POST <ns>/<hash>/complete`）。
 *   K3  导出拦截：新模块 `server/export-gate.mjs` 导出 `checkExportOriginals({ project, has })`：
 *       `has(hash) → Promise<boolean>` 是「当前素材服务上这个哈希 complete 没有」；
 *       回 `{ ok: true }` 或 `{ ok: false, code: 'waiting-uploader', message, missing: [{ mediaId, hash, name? }] }`，
 *       `message` 里有「等待上传方」。只看被片段引用的素材的**原片**（`tiers.original`，没有 tiers 就是 `hash`）。
 *   K4  可播性：仍是 `src/render/playability.ts`，导出名不变（`probePlayable(hash, url, ext, kind)`、
 *       `playableOnThisHost`、`rememberPlayable`、`forgetPlayable`）；浏览器主版本取自 `navigator.userAgent`
 *       （`Chrome/<n>`、`Firefox/<n>`、`Version/<n> Safari`），`localStorage` 里存结论的键包含哈希与主版本号；
 *       超时经 `window.__pcRealSetTimeout`（已有口子）计时；「远端」= 绝对 http(s) 地址（本地是 `/@media/...`）。
 *   K5  卡片同步：新模块 `server/card-sync.mjs` 导出 `createCardSync(deps)`，deps：
 *       - `content`：内容库客户端，形状同 `server/render-node/content-client.mjs`（`put(kind, key, body) → { hash, rev }`、
 *         `get(kind, key) → { body, hash, rev } | null`、`list(kind, prefix?) → { items: [{ key, hash, rev }] }`），
 *         另加 `watch(kind, onChanged)`，`onChanged({ kind, key, hash, rev, previousActor })`，回一个取消函数；
 *       - `readLocal(key) → Promise<string | null>`：本机当前这份源码（没有就 null）；
 *       - `install({ key, body, rev }) → Promise`：装卡（代表走 `/api/cards/install`）；
 *       - `backup({ key, body }) → Promise`：备份本机那份；
 *       - `notify({ type: 'card-overwritten', key, rev })`：覆盖提示；
 *       - `scopeOf(key) → 'user' | 'builtin-modified' | 'builtin'`；
 *       - `stateFile`：「上次同步到的 cardRev 与内容哈希」的落盘处。
 *       实例方法：`saved({ key, body })`（保存后）、`open()`（打开共享项目：列、拉、订阅）、`close()`。
 *       卡片源码的 `body` 就是源码字符串；`key` 是仓库相对路径。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const sha256File = (file) => sha256(fs.readFileSync(file));
export const HEX64 = /^[0-9a-f]{64}$/;

export function tempDir(prefix = 'pc-c66-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 从模块里按名字（含别名）取函数；都没有就断言失败并列出实际导出 */
function pick(mod, names, file) {
  for (const n of names) if (typeof mod[n] === 'function') return mod[n];
  assert.fail(`${file} 要导出 ${names.join(' / ')} 之一；实际导出：${Object.keys(mod).join(', ') || '（无）'}`);
}

async function importRepo(rel) {
  try {
    return await import(pathToFileURL(path.join(ROOT, rel)).href);
  } catch (err) {
    assert.fail(`载不进 ${rel}：${err?.message ?? err}`);
  }
}

// ================================================================== ffmpeg 与样本

let ffmpegCmd = null;
/** 用仓库现有的 `findFfmpeg`（设计稿第 2 节：「用 findFfmpeg」） */
export async function ffmpeg() {
  if (ffmpegCmd) return ffmpegCmd;
  const { findFfmpeg } = await import(pathToFileURL(path.join(ROOT, 'server', 'bakery', 'ffmpeg.mjs')).href);
  ffmpegCmd = await findFfmpeg();
  return ffmpegCmd;
}
export async function ffprobe() {
  const f = await ffmpeg();
  return f.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
}

export function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(cmd)} ${args.join(' ')} 退出码 ${code}：${err.slice(-800)}`));
    });
  });
}

/** ffprobe 的 streams + format */
export async function probe(file) {
  const { out } = await run(await ffprobe(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const j = JSON.parse(out);
  const video = j.streams.find((s) => s.codec_type === 'video');
  const audio = j.streams.find((s) => s.codec_type === 'audio');
  return { video, audio, format: j.format, streams: j.streams };
}

/** 按流算包数据的 md5：编码不变 ⇔ 每条流的包数据一致（重封装只挪 box，不动包） */
export async function streamHashes(file) {
  const { out } = await run(await ffmpeg(), ['-v', 'error', '-i', file, '-map', '0', '-c', 'copy', '-f', 'streamhash', '-hash', 'md5', '-']);
  return out.trim().split(/\r?\n/).filter(Boolean);
}

/** 视频流解出来的帧数（按包数，`-count_packets`） */
export async function videoPackets(file) {
  const { out } = await run(await ffprobe(), ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return Number(out.trim());
}

/**
 * ISO BMFF 顶层 box 的类型序列（测试自己的解析，不用被测模块的）。
 * size == 1 → 64 位 largesize；size == 0 → 到文件尾。解析不下去就停。
 */
export function topLevelBoxes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const types = [];
    let off = 0;
    const head = Buffer.alloc(16);
    while (off + 8 <= total) {
      fs.readSync(fd, head, 0, 16, off);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(type)) break;
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      else if (size === 0) size = total - off;
      if (size < 8) break;
      types.push(type);
      off += size;
    }
    return types;
  } finally {
    fs.closeSync(fd);
  }
}
export function boxFaststart(file) {
  const t = topLevelBoxes(file);
  const moov = t.indexOf('moov');
  const mdat = t.indexOf('mdat');
  if (moov < 0 || mdat < 0) return null;
  return moov < mdat;
}

/**
 * 现场生成的小样本（设计稿第 8 节「测试素材：现场生成」）。一个测试文件内只生成一次。
 *   hd        1920×1080、30 fps、2 s、H.264 yuv420p + AAC，faststart
 *   lateMoov  同上，moov 在 mdat 之后
 *   prores    1280×720 ProRes MOV + PCM（ffmpeg 的 mov 缺省就是晚置 moov）
 *   mkv       640×360 H.264 MKV
 *   fps120    640×360、120 fps、1 s，无音轨
 *   odd       1001×777、yuv444p（小版要换成 yuv420p、偶数尺寸）
 *   portrait  1920×1080 画面 + 显示旋转 90°（-autorotate 后小版是竖的）
 *   noAudio   640×360、无音轨（不放大）
 *   png       320×240 一帧图片
 *   m4a       2 s 正弦 AAC
 */
export async function makeSamples(dir) {
  const f = await ffmpeg();
  const lav = (spec) => ['-f', 'lavfi', '-i', spec];
  const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast'];
  const out = (name) => path.join(dir, name);
  const s = {
    hd: out('hd.mp4'), lateMoov: out('late.mp4'), prores: out('prores.mov'), mkv: out('clip.mkv'),
    fps120: out('fps120.mp4'), odd: out('odd.mp4'), portrait: out('portrait.mp4'), noAudio: out('noaudio.mp4'),
    png: out('still.png'), m4a: out('tone.m4a'),
  };
  const jobs = [
    [...lav('testsrc2=size=1920x1080:rate=30:duration=2'), ...lav('sine=frequency=440:duration=2'), ...x264, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', s.hd],
    [...lav('testsrc2=size=1920x1080:rate=30:duration=2'), ...lav('sine=frequency=440:duration=2'), ...x264, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', s.lateMoov],
    [...lav('testsrc2=size=1280x720:rate=25:duration=1'), ...lav('sine=frequency=330:duration=1'), '-c:v', 'prores_ks', '-profile:v', '0', '-c:a', 'pcm_s16le', '-shortest', s.prores],
    [...lav('testsrc2=size=640x360:rate=30:duration=1'), ...x264, '-pix_fmt', 'yuv420p', s.mkv],
    [...lav('testsrc2=size=640x360:rate=120:duration=1'), ...x264, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', s.fps120],
    [...lav('testsrc2=size=1001x777:rate=30:duration=1'), ...x264, '-pix_fmt', 'yuv444p', '-movflags', '+faststart', s.odd],
    [...lav('testsrc2=size=640x360:rate=30:duration=1'), ...x264, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', s.noAudio],
    [...lav('testsrc2=size=320x240:rate=1'), '-frames:v', '1', s.png],
    [...lav('sine=frequency=440:duration=2'), '-c:a', 'aac', '-b:a', '96k', s.m4a],
  ];
  await Promise.all(jobs.map((args) => run(f, ['-y', '-hide_banner', '-loglevel', 'error', ...args])));
  // 显示旋转 90°：拿 hd 直接复制，只加显示矩阵
  await run(f, ['-y', '-hide_banner', '-loglevel', 'error', '-display_rotation', '90', '-i', s.hd, '-c', 'copy', '-movflags', '+faststart', s.portrait]);
  return s;
}

// ================================================================== K1 两档生成

export async function loadTiers() {
  const file = 'server/media-tiers.mjs';
  const mod = await importRepo(file);
  const makeSmall = pick(mod, ['makeSmallTier', 'generateSmallTier', 'transcodeSmall', 'makeSmall'], file);
  const hasFaststartFn = pick(mod, ['hasFaststart', 'isFaststart', 'detectFaststart'], file);
  const ensureFaststartFn = pick(mod, ['ensureFaststart', 'remuxFaststart', 'faststartOriginal'], file);
  const prepareFn = pick(mod, ['prepareTiers', 'prepareMediaTiers', 'makeTiers'], file);
  return {
    mod,
    makeSmall: (opts) => makeSmall(opts),
    hasFaststart: async (f) => hasFaststartFn(f),
    ensureFaststart: async (opts) => {
      const r = await ensureFaststartFn(opts);
      assert.ok(r && typeof r.path === 'string', `ensureFaststart 要回 { path, remuxed }：${JSON.stringify(r)}`);
      return { path: r.path, remuxed: !!r.remuxed };
    },
    prepare: async (opts) => {
      const r = await prepareFn(opts);
      assert.ok(r && r.original && typeof r.original.path === 'string', `prepareTiers 要回 { original: { path, hash }, small? }：${JSON.stringify(r)}`);
      return r;
    },
  };
}

// ================================================================== K2 上传队列

export async function loadUploadQueue() {
  const file = 'server/upload-queue.mjs';
  const mod = await importRepo(file);
  const create = pick(mod, ['createUploadQueue', 'uploadQueue'], file);
  return (opts) => {
    const q = create(opts);
    assert.equal(typeof q?.enqueue, 'function', 'createUploadQueue 的实例要有 enqueue');
    assert.equal(typeof q?.drain, 'function', 'createUploadQueue 的实例要有 drain');
    return {
      raw: q,
      enqueue: (item) => q.enqueue(item),
      drain: () => q.drain(),
      close: async () => { await (q.close ?? q.stop)?.call(q); },
    };
  };
}

/**
 * 记录每个请求的 fetch（同 `asset-client.test.mjs` 的写法）。`state.offline` 为真时一律抛网络错；
 * `hook(info, log)` 返回 Response 或抛错可代替真请求。`log` 每项 `{ method, url, path, ns, hash, action, n }`，
 * `action` ∈ `chunks` | `put` | `complete` | `other`。
 */
export function recordingFetch(hook = () => undefined) {
  const log = [];
  const state = { offline: false };
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const p = new URL(url).pathname;
    const m = /\/(media|snap|px)\/([0-9a-f]{64})(?:\/(chunks|complete|\d+))?$/i.exec(p);
    const info = { method, url, path: p, ns: m?.[1] ?? null, hash: m?.[2]?.toLowerCase() ?? null, action: 'other', n: null, ok: null };
    if (m?.[3] === 'chunks') info.action = 'chunks';
    else if (m?.[3] === 'complete') info.action = 'complete';
    else if (m?.[3] && method === 'PUT') { info.action = 'put'; info.n = Number(m[3]); }
    log.push(info);
    if (state.offline) { info.ok = false; throw new TypeError('fetch failed (测试断网)'); }
    const replaced = await hook(info, log, state);
    if (replaced !== undefined) return replaced;
    const res = await globalThis.fetch(input, init);
    info.ok = res.ok;
    return res;
  };
  return { fetch: fn, log, state };
}

/** 直接问素材服务 `GET media/<hash>/chunks` */
export async function chunksOf(base, hash, ns = 'media') {
  const res = await fetch(`${base}/${ns}/${hash}/chunks`);
  assert.equal(res.status, 200, `GET ${ns}/${hash}/chunks 应回 200`);
  return res.json();
}

/** 可复现的伪随机字节 */
export function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}

// ================================================================== K3 导出拦截

export async function loadExportGate() {
  const file = 'server/export-gate.mjs';
  const mod = await importRepo(file);
  const check = pick(mod, ['checkExportOriginals', 'checkOriginals', 'exportGate'], file);
  return async ({ project, has }) => {
    const r = await check({ project, has });
    assert.ok(r && typeof r.ok === 'boolean', `checkExportOriginals 要回 { ok, ... }：${JSON.stringify(r)}`);
    const missing = (r.missing ?? []).map((m) => (typeof m === 'string' ? { hash: m } : m));
    return { ...r, missing, missingHashes: missing.map((m) => String(m.hash).toLowerCase()).sort() };
  };
}

// ================================================================== K4 可播性（假 DOM）

/**
 * 在 globalThis 上装一个最小的假 DOM（`document.createElement('video')`、`navigator.userAgent`、`localStorage`、
 * `window.__pcRealSetTimeout`），供 `playability.ts` 在 Node 里跑。
 *   behavior(el) 决定这支假 video 怎么回应：'playable' | 'error' | 'hang'；canPlay 决定 canPlayType 回什么。
 * 回 `{ storage, created, timers, setUA, restore }`：`created` 是每次 createElement 的记录，`timers` 是超时的毫秒数。
 */
export function installFakeDom({ ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' } = {}) {
  const saved = {};
  for (const k of ['document', 'navigator', 'localStorage', 'window']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    _map: map,
  };
  const ctl = { canPlay: 'maybe', behavior: 'playable', created: [], timers: [], fireTimers: true };
  const nav = { userAgent: ua };
  class FakeVideo extends EventTarget {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this._src = ''; this.muted = false; this.preload = ''; this.readyState = 0; ctl.created.push(this); }
    canPlayType(mime) { this.askedMime = mime; return ctl.canPlay; }
    set src(v) {
      this._src = v;
      if (!v) return;
      const b = ctl.behavior;
      setTimeout(() => {
        if (b === 'playable') {
          this.readyState = 2;
          this.dispatchEvent(new Event('loadedmetadata'));
          this.dispatchEvent(new Event('loadeddata'));
          this.dispatchEvent(new Event('canplay'));
        } else if (b === 'error') {
          this.dispatchEvent(new Event('error'));
        }
      }, 5);
    }
    get src() { return this._src; }
    setAttribute(k, v) { if (k === 'src') this.src = v; }
    removeAttribute(k) { if (k === 'src') this._src = ''; }
    load() {}
    play() { return Promise.resolve(); }
    pause() {}
    requestVideoFrameCallback(cb) {
      if (ctl.behavior === 'playable') setTimeout(() => cb(performance.now(), { mediaTime: 0, presentedFrames: 1 }), 5);
      return 1;
    }
    cancelVideoFrameCallback() {}
  }
  const doc = { createElement: (tag) => new FakeVideo(tag), body: { appendChild() {}, removeChild() {} } };
  const win = {
    __pcRealSetTimeout: (fn, ms) => { ctl.timers.push(ms); return setTimeout(fn, ctl.fireTimers ? 20 : 2 ** 31 - 1); },
    location: { origin: 'http://127.0.0.1:5199', href: 'http://127.0.0.1:5199/' },
    navigator: nav,
    localStorage: storage,
    document: doc,
  };
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('document', doc);
  def('navigator', nav);
  def('localStorage', storage);
  def('window', win);
  return {
    storage, ctl,
    setUA: (next) => { nav.userAgent = next; },
    restore: () => {
      for (const [k, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(globalThis, k, d);
        else delete globalThis[k];
      }
    },
  };
}

export async function loadPlayability() {
  await import(pathToFileURL(path.join(ROOT, 'src', 'testing', 'registerTs.mjs')).href);
  const file = 'src/render/playability.ts';
  const mod = await importRepo(file);
  for (const n of ['probePlayable', 'playableOnThisHost', 'rememberPlayable', 'forgetPlayable']) pick(mod, [n], file);
  return mod;
}

export async function loadMediaTier() {
  await import(pathToFileURL(path.join(ROOT, 'src', 'testing', 'registerTs.mjs')).href);
  return importRepo('src/render/mediaTier.ts');
}

// ================================================================== K5 卡片同步

/**
 * 假内容库客户端：行为照 `server/docservice/modules/content.mjs`（`card-source` 按键发 rev，每次 put 加一，
 * 后写的赢；`hash = sha256(JSON.stringify(body))`），外加 `watch`。`as(actor)` 取一个以该身份写的视图，
 * 两个视图共享同一份存储，用来模拟 A、B 两端。
 */
export function fakeContentService() {
  const items = new Map();
  const watchers = new Set();
  const puts = [];
  const hashOf = (body) => sha256(JSON.stringify(body));
  function as(actor) {
    return {
      actor,
      async put(kind, key, body) {
        const prev = items.get(`${kind}\n${key}`);
        const rev = (prev?.rev ?? 0) + 1;
        const hash = hashOf(body);
        items.set(`${kind}\n${key}`, { kind, key, body: structuredClone(body), hash, rev, actor });
        puts.push({ actor, kind, key, body, rev });
        const evt = { kind, key, hash, rev, previousActor: prev?.actor ?? null };
        for (const w of [...watchers]) if (w.kind === kind && w.actor !== actor) queueMicrotask(() => w.cb(structuredClone(evt)));
        return { hash, rev };
      },
      async get(kind, key) {
        const it = items.get(`${kind}\n${key}`);
        return it ? { body: structuredClone(it.body), hash: it.hash, rev: it.rev } : null;
      },
      async list(kind, prefix = '') {
        const out = [...items.values()].filter((it) => it.kind === kind && it.key.startsWith(prefix))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .map(({ key, hash, rev }) => ({ key, hash, rev }));
        return { items: out, truncated: false };
      },
      watch(kind, cb) {
        const w = { kind, cb, actor };
        watchers.add(w);
        return () => watchers.delete(w);
      },
    };
  }
  return { as, items, puts };
}

/** 一端的本机环境：文件、装卡、备份、提示都记下来 */
export function fakeCardHost({ files = {}, scopes = {}, stateFile } = {}) {
  const local = new Map(Object.entries(files));
  const events = [];
  return {
    local, events, stateFile,
    readLocal: async (key) => (local.has(key) ? local.get(key) : null),
    install: async ({ key, body, rev }) => { events.push({ type: 'install', key, body, rev }); local.set(key, body); },
    backup: async ({ key, body }) => { events.push({ type: 'backup', key, body }); },
    notify: (msg) => { events.push({ type: 'notify', ...msg }); },
    scopeOf: (key) => scopes[key] ?? 'user',
  };
}

export async function loadCardSync() {
  const file = 'server/card-sync.mjs';
  const mod = await importRepo(file);
  const create = pick(mod, ['createCardSync', 'cardSync'], file);
  return ({ content, host }) => {
    const s = create({
      content, readLocal: host.readLocal, install: host.install, backup: host.backup, notify: host.notify,
      scopeOf: host.scopeOf, stateFile: host.stateFile,
    });
    for (const n of ['saved', 'open']) assert.equal(typeof s?.[n], 'function', `createCardSync 的实例要有 ${n}`);
    return {
      raw: s,
      /** 本机保存：先改本机文件，再告诉同步 */
      save: async (key, body) => { host.local.set(key, body); await s.saved({ key, body }); },
      open: () => s.open(),
      close: async () => { await s.close?.(); },
    };
  };
}

/** 等到 pred() 为真；超时断言失败 */
export async function waitFor(pred, { timeoutMs = 3000, stepMs = 10, what = '条件' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) assert.fail(`等 ${what} 超时（${timeoutMs} ms）`);
    await sleep(stepMs);
  }
}
