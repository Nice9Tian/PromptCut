/**
 * 仅供测试，生产代码不得引用。
 *
 * C10a 契约测试（`server/test/c10a-*.test.mjs`、`src/**\/c10a-*.test.mjs`、`scripts/probes/c10a-*.mjs`）的公共件。
 * 依据只有 `docs/plan/c10a-contract.md`（第 2、5、8、9、11.1、12 节）与它引的 `docs/plan/auth-contract.md`；
 * 测试方没看实现（`claude/c10a-web`、`claude/c10a-lowmem`）。
 *
 * 契约没写死的模块路径、函数名、参数与回包形状全部集中在本文件，集成时对账只改这里。
 * 每一处假设用「假设 K<n>」标出，报告 `docs/reports/AGENT-c10a-tests.md` 按同样的编号列出。
 *
 * # 实现不在时怎么办
 *
 * 每组用例开头调本文件的 `*Support()` 探测接口在不在：不在就把这组用例标成 `node:test` 的 skip，
 * 原因写「接口缺失：…」。探测只看「实现有没有」，不看「实现对不对」：接口一旦出现，用例就真跑，
 * 名字或形状和假设对不上会直接失败（由集成方改本文件对账），不会被静默跳过。
 * 所以集成前 `npm test` 的跳过数会多出这些；集成后必须回到只跳过需要 5190 的那 1 条。
 *
 *   K1  邀请码（契约第 5 节）：挂在现有的共享项目 HTTP 端点旁边，独立模式 `shared/invite/resolve`、
 *       `shared/invite/redeem`，挂载模式 `<WS 路径>/shared/invite/…`；服务端就是 `auth-kit.mjs` 组装的那一套
 *       （`createSharedDocService`），不另起入口。
 *       - 探测：对随机邀请码 `POST shared/invite/resolve`，回 404 `{ error: 'invite-invalid' }` 算实现在；
 *         现在的实现对不认识的 `shared/…` 路径回 404 `not-found`，据此判为缺失。
 *       - `shared.admin` 的 `invite-create` / `invite-revoke` / `invite-status` 回包字段平铺在
 *         `shared.admin.ok` 上（与 C6.5 的 `list-bans` 回 `bans` 同一做法）；`invite-status` 也接受包在 `status` 里。
 *       - `expiresAt`、`revokedAt` 是毫秒时间戳（同 auth 契约第 8 节票据的 `exp`）。
 *       - 签发、过期按文档服务注入的时钟（`auth-kit.mjs` 的 `testClock`）算。
 *   K2  低内存档判定（契约第 8 节）：`src/online/lowMemory.ts`（契约第 11 节点名的文件）导出一个判定函数，
 *       名字取 `LOW_MEMORY_DECIDERS` 之一。调用约定：`fn(env)`，`env` 见 `lowMemoryEnv()`；同时把同样的桩装到
 *       `globalThis.navigator` / `screen` / `matchMedia` / `localStorage` 上，所以「从参数读」和「从全局读」两种写法都认。
 *       回布尔，或回 `{ lowMemory: boolean }`。设备设置「显示档」存在 localStorage，值 `'auto' | 'low' | 'normal'`，
 *       测试经 `env.override`（`'low' | 'normal' | undefined`）给，不猜 localStorage 的键名。
 *       `src/online/mode.ts` 按契约第 2 节读 `import.meta.env`，node 里没有，测试用 `mock.module` 换成 `{ ONLINE }`。
 *   K3  能力闸（契约第 8 节）：
 *       - `src/render/mediaTier.ts` 的 `chooseTier` / `playbackUrl` 在 `opts.lowMemory === true` 时恒给小尺寸；
 *         没有小尺寸 → `tier: 'none'`（或 url 为空）、`awaiting: true`，不给原尺寸地址。探测：`src/online/lowMemory.ts` 存在。
 *       - `src/editor/stageSwap.ts` 在低内存档不追活渲：它从 `src/online/lowMemory.ts` 取当前档位，
 *         测试把那个模块整个换成桩，导出 `LOW_MEMORY_STUB_EXPORTS` 里的全部别名（都说「是低内存档」）。
 *   K4  预渲染小尺寸（契约第 9 节）：
 *       - 尺寸规则是一个纯函数 `(width, height) → { width, height }`，在 `SMALL_SIZE_FILES` 之一里，名字取
 *         `SMALL_SIZE_NAMES` 之一；探测：找得到这个函数。
 *       - 快照清单（C6.2 的 `SnapshotResult`）另带 `small: [[帧, 哈希, 字节数], …]`，块是 WebP，推到 `px`
 *         （`client.put('px', bytes, { ext: 'webp' })`）；`pushResult` 两档都推成功才返回，任何一块失败就抛。
 *       - 就绪索引（`server/ready-index.mjs`）的小尺寸是单独的 `kind`（`READY_KINDS` 里名字含 `small` 的那个），
 *         与 `html` 层互不覆盖。
 *   K5  MP4 封装器（契约第 11 节〔裁〕）：`src/export/` 下某个 `.ts` 导出类或工厂，名字取 `MUXER_NAMES` 之一；
 *       构造参数 `{ video: { codec: 'avc', width, height, frameRate }, audio?: { codec: 'aac', sampleRate, numberOfChannels }, fastStart? }`；
 *       方法 `addVideoChunk(chunk, meta?)`、`addAudioChunk(chunk, meta?)`、`finalize()`。`chunk` 是 WebCodecs 的
 *       `EncodedVideoChunk` / `EncodedAudioChunk` 形状（`type`、`timestamp`/`duration` 微秒、`byteLength`、`copyTo`），
 *       `meta.decoderConfig.description` 是 avcC / AudioSpecificConfig。产物取 `finalize()` 的返回值
 *       （Uint8Array / ArrayBuffer / Blob），没有就取 `muxer.target.buffer`。
 *   K6  `/api` 守卫（契约第 2 节）：`src/online/` 下某个 `.ts` 导出名字含 `guard`（不分大小写）的函数，调用后
 *       在 `ONLINE` 时让 `fetch('/api/…')` 抛错（同步抛或 reject 都算），别的地址照常转给原来的 `fetch`；
 *       `ONLINE` 为 false 时不拦。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const repoPath = (rel) => path.join(ROOT, ...rel.split('/'));
export const repoUrl = (rel) => pathToFileURL(repoPath(rel)).href;
export const exists = (rel) => fs.existsSync(repoPath(rel));

/** `node:test` 的 skip 选项：接口在就是 false（真跑），不在就是「接口缺失：…」 */
export const skipIf = (missing, what) => (missing ? `接口缺失：${what}（C10a 实现未集成，集成后自动转为真跑）` : false);

export function tempDir(prefix = 'pc-c10a-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ================================================================== K1 邀请码

/** 契约第 5 节：32 字节随机数的 base64url，不带填充，43 个字符 */
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
export const newInviteCode = () => randomBytes(32).toString('base64url');
export const INVITE_DEFAULT_TTL_MS = 604_800 * 1000;

let inviteProbe = null;
/**
 * 探测邀请码端点在不在（K1）。起一台临时的托管端文档服务问一次，回 `{ ok, detail }`。
 * 依赖 `auth-kit.mjs`（它本身要能起服务）；起不来就当缺失并把原因带出来。
 */
export function inviteSupport() {
  inviteProbe ??= (async () => {
    const { startHost } = await import('./auth-kit.mjs');
    let env = null;
    try {
      env = await startHost();
      const r = await env.http('shared/invite/resolve', { method: 'POST', body: { code: newInviteCode() } });
      const ok = r.status === 404 && r.json?.error === 'invite-invalid';
      return { ok, detail: ok ? '' : `POST shared/invite/resolve 回 ${r.status} ${r.text.slice(0, 120)}` };
    } catch (err) {
      return { ok: false, detail: `起托管端失败：${err?.message ?? err}` };
    } finally {
      await env?.close();
    }
  })();
  return inviteProbe;
}

export function resolveInvite(env, code, { remote } = {}) {
  return env.http('shared/invite/resolve', { method: 'POST', body: { code }, remote });
}

export function redeemInvite(env, { code, username, deviceId }, { remote } = {}) {
  return env.http('shared/invite/redeem', { method: 'POST', body: { code, username, deviceId }, remote });
}

/** `invite-status` 的回包：字段平铺，或包在 `status` 里（K1） */
export function inviteStatusOf(reply) {
  assert.equal(reply?.type, 'shared.admin.ok', `invite-status 应 shared.admin.ok：${JSON.stringify(reply)}`);
  return reply.status && typeof reply.status === 'object' ? reply.status : reply;
}

/** 目录下所有文件的全文（二进制按 latin1 读），用来查「原文不落盘」 */
export function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = fs.readFileSync(p);
        if (buf.includes(Buffer.from(needle, 'utf8'))) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

// ================================================================== K2 低内存档判定

export const LOW_MEMORY_FILE = 'src/online/lowMemory.ts';
export const LOW_MEMORY_DECIDERS = [
  'decideLowMemory', 'detectLowMemory', 'computeLowMemory', 'judgeLowMemory', 'lowMemoryFor', 'isLowMemoryDevice', 'resolveLowMemory',
];

/**
 * 判定用的环境桩。
 * @param {object} o
 * @param {number|undefined} o.deviceMemory  `navigator.deviceMemory`（undefined = 没有这个字段，如 iOS）
 * @param {number} o.maxTouchPoints
 * @param {number} o.width   `screen.width`
 * @param {number} o.height  `screen.height`
 * @param {boolean} o.coarse          `(pointer: coarse)` 是否匹配
 * @param {boolean} [o.anyCoarse]     `(any-pointer: coarse)` 是否匹配（缺省同 coarse）
 * @param {'low'|'normal'|undefined} [o.override]  设备设置「显示档」；undefined = 自动
 * @param {string} [o.userAgent]
 */
export function lowMemoryEnv({ deviceMemory, maxTouchPoints = 0, width = 1920, height = 1080, coarse = false, anyCoarse = coarse, override, userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' }) {
  const matchMedia = (q) => {
    const s = String(q).replace(/\s+/g, '');
    const matches = s.includes('(any-pointer:coarse)') ? anyCoarse : s.includes('(pointer:coarse)') ? coarse : false;
    return { matches, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null };
  };
  const navigator = { userAgent, maxTouchPoints, platform: 'x', language: 'zh-CN', hardwareConcurrency: 8 };
  if (deviceMemory !== undefined) navigator.deviceMemory = deviceMemory;
  const screen = { width, height, availWidth: width, availHeight: height };
  return {
    // 平铺的字段（纯函数写法）
    deviceMemory, maxTouchPoints, screenWidth: width, screenHeight: height, coarsePointer: coarse || anyCoarse,
    override: override ?? null, setting: override ?? 'auto', mode: override ?? 'auto',
    // 仿浏览器的对象（从全局或从参数读的写法）
    navigator, screen, matchMedia,
  };
}

const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
};

/** 把桩装到全局（K2 的「从全局读」写法） */
export function installBrowserGlobals(env) {
  const g = globalThis;
  const saved = {};
  for (const k of ['navigator', 'screen', 'matchMedia', 'localStorage', 'window']) saved[k] = Object.getOwnPropertyDescriptor(g, k);
  const def = (k, v) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true, enumerable: true });
  def('navigator', env.navigator);
  def('screen', env.screen);
  def('matchMedia', env.matchMedia);
  if (!saved.localStorage?.value) def('localStorage', memStore());
  if (!saved.window) def('window', g);
  return () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  };
}

/** 从 `lowMemory.ts` 里取判定函数（K2）；取不到就断言失败并列出实际导出 */
export function pickDecider(mod) {
  for (const n of LOW_MEMORY_DECIDERS) if (typeof mod[n] === 'function') return mod[n];
  assert.fail(`${LOW_MEMORY_FILE} 要导出 ${LOW_MEMORY_DECIDERS.join(' / ')} 之一；实际导出：${Object.keys(mod).join(', ') || '（无）'}`);
}

/** 跑一次判定：同时给参数与全局，回布尔 */
export async function decideWith(decider, env) {
  const restore = installBrowserGlobals(env);
  try {
    const r = await decider(env);
    if (typeof r === 'boolean') return r;
    if (r && typeof r === 'object' && typeof r.lowMemory === 'boolean') return r.lowMemory;
    assert.fail(`判定函数应回布尔或 { lowMemory }：${JSON.stringify(r)}`);
  } finally {
    restore();
  }
}

/** K3：`src/online/lowMemory.ts` 换成桩时导出的别名（都说「是低内存档」） */
export function lowMemoryStubExports(low = true) {
  const f = () => low;
  const out = { LOW_MEMORY: low, lowMemoryMode: low };
  for (const n of ['isLowMemory', 'lowMemory', 'getLowMemory', 'lowMemoryActive', 'currentLowMemory', 'inLowMemory', 'useLowMemory', 'lowMemoryNow']) out[n] = f;
  for (const n of LOW_MEMORY_DECIDERS) out[n] = f;
  out.onLowMemoryChange = () => () => {};
  out.subscribeLowMemory = () => () => {};
  out.forceLowMemory = () => {};
  out.demoteToLowMemory = () => {};
  out.setLowMemoryForTest = () => {};
  return out;
}

// ================================================================== K4 预渲染小尺寸

export const SMALL_SIZE_FILES = [
  'server/artifact-transfer.mjs', 'server/frame-pipeline.mjs', 'server/artifact-push.mjs', 'server/prerender-small.mjs',
  'server/bakery/small.mjs', 'server/bakery/smallSize.mjs', 'server/bakery/prerender-small.mjs', 'server/bakery/rasterize-small.mjs',
];
export const SMALL_SIZE_NAMES = ['smallPrerenderSize', 'prerenderSmallSize', 'smallSize', 'smallSizeOf', 'fitSmall', 'smallDims', 'smallTierSize', 'smallBox'];

/** 找尺寸规则函数（K4）；回 `{ fn, file, name }` 或 null。`server/bakery/` 下的 .mjs 也逐个看 */
export async function findSmallSize() {
  const files = [...SMALL_SIZE_FILES];
  try {
    for (const f of fs.readdirSync(repoPath('server/bakery'))) if (f.endsWith('.mjs') && !files.includes(`server/bakery/${f}`)) files.push(`server/bakery/${f}`);
  } catch { /* 没有目录 */ }
  for (const rel of files) {
    if (!exists(rel)) continue;
    const src = fs.readFileSync(repoPath(rel), 'utf8');
    if (!SMALL_SIZE_NAMES.some((n) => src.includes(n))) continue; // 不 import 无关的重模块
    let mod;
    try { mod = await import(repoUrl(rel)); } catch { continue; }
    for (const n of SMALL_SIZE_NAMES) if (typeof mod[n] === 'function') return { fn: mod[n], file: rel, name: n };
  }
  return null;
}

/** 尺寸函数可能回 `{ width, height }` 或 `[w, h]` */
export function sizeOf(r) {
  if (Array.isArray(r)) return { width: r[0], height: r[1] };
  return { width: r?.width ?? r?.w, height: r?.height ?? r?.h };
}

// ================================================================== K5 MP4 封装器

export const MUXER_NAMES = ['Mp4Muxer', 'MP4Muxer', 'Muxer', 'createMp4Muxer', 'createMuxer', 'mp4Muxer'];

/** 在 `src/export/*.ts` 里找封装器（K5）；回 `{ make, file, name }` 或 null */
export async function findMuxer() {
  const dir = repoPath('src/export');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /\.(m?ts|mjs)$/.test(f) && !f.endsWith('.d.ts') && !f.includes('.test.'));
  // 名字里带 mux / mp4 的先看
  files.sort((a, b) => Number(!/mux|mp4/i.test(a)) - Number(!/mux|mp4/i.test(b)));
  for (const f of files) {
    const rel = `src/export/${f}`;
    const src = fs.readFileSync(repoPath(rel), 'utf8');
    if (!MUXER_NAMES.some((n) => src.includes(n))) continue;
    let mod;
    try { mod = await import(repoUrl(rel)); } catch { continue; }
    for (const n of MUXER_NAMES) {
      const v = mod[n];
      if (typeof v !== 'function') continue;
      const isClass = /^class\b/.test(Function.prototype.toString.call(v));
      return { file: rel, name: n, make: (opts) => (isClass ? new v(opts) : v(opts)) };
    }
  }
  return null;
}

/** 封装器的产物字节（K5） */
export async function muxerBytes(muxer, finalized) {
  let out = await finalized;
  if (out === undefined || out === null) out = muxer?.target?.buffer ?? muxer?.buffer ?? muxer?.bytes;
  if (out && typeof out.arrayBuffer === 'function') out = await out.arrayBuffer();
  if (out instanceof ArrayBuffer) return Buffer.from(out);
  if (ArrayBuffer.isView(out)) return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  assert.fail(`封装器 finalize() 没交出字节：${Object.prototype.toString.call(out)}`);
}

/** WebCodecs 的 EncodedVideoChunk / EncodedAudioChunk 形状 */
export function fakeChunk({ type, timestamp, duration, data }) {
  const bytes = new Uint8Array(data);
  return {
    type, timestamp, duration, byteLength: bytes.byteLength,
    copyTo(dest) {
      const view = dest instanceof ArrayBuffer ? new Uint8Array(dest) : new Uint8Array(dest.buffer, dest.byteOffset, dest.byteLength);
      view.set(bytes);
    },
  };
}

// ---- 样本：ffmpeg 现场出 H.264 Annex B / AAC ADTS，测试自己拆成 WebCodecs 的块

export function findFfmpegSync() {
  for (const cmd of ['ffmpeg']) {
    const r = spawnSync(cmd, ['-version'], { windowsHide: true });
    if (r.status === 0) return cmd;
  }
  return null;
}
export const ffprobeOf = (ffmpeg) => ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));

export function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0) resolve({ out: buf.toString('utf8'), buf, err });
      else reject(new Error(`${path.basename(cmd)} ${args.join(' ')} 退出码 ${code}：${err.slice(-800)}`));
    });
  });
}

/** Annex B 拆 NAL（去掉起始码） */
export function splitAnnexB(buf) {
  const nals = [];
  let i = 0;
  let start = -1;
  while (i + 3 <= buf.length) {
    const sc3 = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1;
    const sc4 = i + 4 <= buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1;
    if (sc3 || sc4) {
      if (start >= 0) nals.push(buf.subarray(start, i));
      i += sc4 ? 4 : 3;
      start = i;
    } else i++;
  }
  if (start >= 0) nals.push(buf.subarray(start));
  // 去掉 NAL 末尾的 0（下一个起始码的前导 0）
  return nals.map((n) => { let e = n.length; while (e > 0 && n[e - 1] === 0) e--; return n.subarray(0, e); }).filter((n) => n.length);
}

/**
 * H.264 Annex B → `{ avcC, samples: [{ key, data(AVCC 长度前缀) }] }`。
 * 要求一帧一个 slice、没有 B 帧（ffmpeg 出样本时保证）；SPS/PPS 只进 avcC，不进样本（WebCodecs `avc` 格式）。
 */
export function annexBToAvcc(buf) {
  const nals = splitAnnexB(buf);
  let sps = null, pps = null;
  const samples = [];
  let cur = [];
  let key = false;
  for (const nal of nals) {
    const t = nal[0] & 0x1f;
    if (t === 7) { sps ??= nal; continue; }
    if (t === 8) { pps ??= nal; continue; }
    if (t === 9) continue; // AUD
    cur.push(nal);
    if (t === 5) key = true;
    if (t === 1 || t === 5) {
      const len = cur.reduce((s, n) => s + 4 + n.length, 0);
      const data = Buffer.alloc(len);
      let o = 0;
      for (const n of cur) { data.writeUInt32BE(n.length, o); n.copy(data, o + 4); o += 4 + n.length; }
      samples.push({ key, data });
      cur = [];
      key = false;
    }
  }
  assert.ok(sps && pps, 'H.264 样本里没有 SPS / PPS');
  const avcC = Buffer.concat([
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([sps.length >> 8, sps.length & 0xff]), sps,
    Buffer.from([1, pps.length >> 8, pps.length & 0xff]), pps,
  ]);
  const codec = `avc1.${[sps[1], sps[2], sps[3]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return { avcC, codec, samples };
}

/** AAC ADTS → `{ asc, sampleRate, channels, frames: [Buffer] }`（去掉 ADTS 头） */
export function adtsToRaw(buf) {
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const frames = [];
  let i = 0;
  let profile = 1, srIdx = 4, ch = 2;
  while (i + 7 <= buf.length) {
    assert.ok(buf[i] === 0xff && (buf[i + 1] & 0xf6) === 0xf0, `ADTS 同步字不对（偏移 ${i}）`);
    const protectionAbsent = buf[i + 1] & 1;
    profile = (buf[i + 2] >> 6) + 1;
    srIdx = (buf[i + 2] >> 2) & 0xf;
    ch = ((buf[i + 2] & 1) << 2) | (buf[i + 3] >> 6);
    const len = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    const head = protectionAbsent ? 7 : 9;
    frames.push(buf.subarray(i + head, i + len));
    i += len;
  }
  const asc = Buffer.from([(profile << 3) | (srIdx >> 1), ((srIdx & 1) << 7) | (ch << 3)]);
  return { asc, sampleRate: RATES[srIdx], channels: ch, frames };
}

// ================================================================== K6 `/api` 守卫

/** `src/online/` 下导出名含 guard 的函数（K6）；回 `{ fn, file, name }` 或 null。按文本先筛，再 import */
export async function findApiGuard(importer) {
  const dir = repoPath('src/online');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts') && f !== 'mode.ts');
  files.sort((a, b) => Number(!/guard|api/i.test(a)) - Number(!/guard|api/i.test(b)));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /export\s+(?:async\s+)?function\s+(\w*[Gg]uard\w*)|export\s+const\s+(\w*[Gg]uard\w*)\s*=/.exec(src);
    if (!m) continue;
    const name = m[1] ?? m[2];
    const mod = await importer(`src/online/${f}`);
    if (typeof mod[name] === 'function') return { fn: mod[name], file: `src/online/${f}`, name };
  }
  return null;
}
