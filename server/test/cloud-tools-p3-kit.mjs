/**
 * 仅供测试与探针(P3 包:运动追踪与片段运动),生产代码不得引用。不是测试文件(名字不以 .test.mjs 结尾)。
 *
 * 搭一整套「真东西」:
 *   - 真 ffmpeg 现造几秒的视频(有纹理的背景 + 一块有纹理的目标按已知路径走),路径就是真值;
 *   - 真项目素材库(`createProjectAssetStores`)+ F0 的 `ProjectAssets`(真流、真哈希、真 close);
 *   - F0 的 `ToolJobs`(真 SQLite)、`run-resources`(真登记/真 abort);
 *   - 真工作区(`createWorkspaces`,子进程环境变量白名单、不弹窗口);
 *   - 真 Python(`python -m promptcut_track`,模板匹配兜底)。
 *
 * 假的只有两处,都在文档里标明:素材服务的网络传输(进程内直连项目素材库,没有 mTLS)和授权来源(受控的 `access` 桩,
 * 或另一份测试里接真 run-authority)。所以这里证明的是「工具提供者的行为」,不是 mTLS 或 doc 授权本身。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createProjectAssets } from '../agent/service/project-assets.mjs';
import { createRunAssetClient } from '../agent/service/run-asset-client.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { createToolJobs } from '../agent/service/tool-jobs.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { createTrackResultStore, createTrackTools } from '../agent/service/perception/track.mjs';
import { resourceRevision, assetRefId } from '../account/run-asset-protocol.mjs';
import { accountError } from '../account/client.mjs';
import { digestOf } from '../account/ledger.mjs';

export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const PYTHON_PACKAGE_ROOT = path.join(REPO_ROOT, 'python');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 40, what = '条件' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > until) throw new Error(`等${what}超时(${timeoutMs} ms)`);
    await sleep(intervalMs);
  }
}

/* ---------------------------------------------------------------- 环境探测 */

/** 找一个能 import numpy 的 Python 和 ffmpeg。都有才返回;没有就是 null(测试据此 skip,而不是假绿) */
export function findTestRuntime() {
  const candidates = [process.env.PROMPTCUT_PYTHON, process.env.PROMPTCUT_TEST_PYTHON, 'python'].filter(Boolean);
  let python = null;
  for (const cand of candidates) {
    const r = spawnSync(cand, ['-c', 'import numpy,sys;sys.stdout.write(sys.executable)'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) { python = r.stdout.trim(); break; }
  }
  const ffmpegCands = [process.env.PROMPTCUT_FFMPEG, 'ffmpeg'].filter(Boolean);
  let ffmpeg = null;
  for (const cand of ffmpegCands) {
    const r = spawnSync(cand, ['-version'], { timeout: 10_000, windowsHide: true });
    if (r.status === 0 && !r.error) { ffmpeg = cand; break; }
  }
  return python && ffmpeg ? { python, ffmpeg } : null;
}

/* ---------------------------------------------------------------- 真视频 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
  };
}

/**
 * 用 ffmpeg 现造一段视频:4×4 块噪声的背景 + 一块 25×25 的噪声目标,目标中心按 (x0+vx·t, y0+vy·t) 走(整数)。
 * 回 `{ file, width, height, frames, fps, truth: [[cx, cy], ...], half }`;`truth[t]` 是第 t 帧目标中心的真值(原始像素)。
 */
export async function writeTrackVideo(file, {
  ffmpeg, width = 320, height = 200, frames = 60, fps = 30, x0 = 60, y0 = 70, vx = 2, vy = 1, seed = 7, crf = 12,
} = {}) {
  const rand = mulberry32(seed);
  const cell = 4;
  const bg = Buffer.alloc(width * height);
  for (let by = 0; by < Math.ceil(height / cell); by += 1) {
    for (let bx = 0; bx < Math.ceil(width / cell); bx += 1) {
      const v = 40 + Math.floor(rand() * 170);
      for (let y = by * cell; y < Math.min(height, (by + 1) * cell); y += 1) bg.fill(v, y * width + bx * cell, y * width + Math.min(width, (bx + 1) * cell));
    }
  }
  const size = 25;
  const half = (size - 1) / 2;
  const patch = Buffer.alloc(size * size);
  for (let i = 0; i < patch.length; i += 1) patch[i] = Math.floor(rand() * 256);
  const truth = [];
  const child = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf), '-pix_fmt', 'yuv420p', file,
  ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  child.stdin.on('error', () => {});
  for (let t = 0; t < frames; t += 1) {
    const cx = Math.round(x0 + vx * t);
    const cy = Math.round(y0 + vy * t);
    truth.push([cx, cy]);
    const frame = Buffer.from(bg);
    for (let py = 0; py < size; py += 1) patch.copy(frame, (cy - half + py) * width + (cx - half), py * size, (py + 1) * size);
    if (!child.stdin.write(frame)) await new Promise((resolve) => child.stdin.once('drain', resolve));
  }
  child.stdin.end();
  const code = await closed;
  if (code !== 0) throw new Error(`ffmpeg 造视频失败(${code}):${stderr.slice(-300)}`);
  return { file, width, height, frames, fps, truth, half, patch };
}

/** 用 ffmpeg 把视频第 index 帧解成灰度字节(真画面,用来复核轨迹) */
export function decodeGrayFrame(ffmpeg, file, index, width, height) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${index})`, '-vframes', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { maxBuffer: width * height * 2, windowsHide: true });
  if (r.status !== 0 || r.stdout.length < width * height) throw new Error(`解不出第 ${index} 帧`);
  return r.stdout.subarray(0, width * height);
}

/** 两块 size×size 灰度的零均值归一化互相关 */
export function nccAt(frame, width, cx, cy, template, size) {
  const half = (size - 1) / 2;
  const a = [];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) a.push(frame[(Math.round(cy) - half + y) * width + (Math.round(cx) - half + x)]);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a);
  const mt = mean([...template]);
  let num = 0; let da = 0; let dt = 0;
  for (let i = 0; i < a.length; i += 1) { num += (a[i] - ma) * (template[i] - mt); da += (a[i] - ma) ** 2; dt += (template[i] - mt) ** 2; }
  return num / Math.sqrt(da * dt);
}

/* ---------------------------------------------------------------- 授权桩 */

export function contextOf(overrides = {}) {
  return {
    projectId: 'proj_a', conversationId: 'conv_a', runId: 'run_1', runGrantId: 'grant_1', instanceId: 'inst_1',
    instanceGeneration: 1, senderAccountId: 'acct_1', messageId: 'msg_1', ...overrides,
  };
}

/**
 * 受控的授权桩(形状同 F0 的 `contextAccess` + `verifyFence`)。只认 `trust()` 过的完整八字段上下文;
 * 可以改 `state` 来模拟:只读成员(`writeAllowed=false`)、撤权(`readAllowed=false`)、fence 变化(`fence`)。
 */
export function makeAccess() {
  const trusted = new Map();
  const state = { readAllowed: true, writeAllowed: true, fence: 1, grantState: 'active', calls: 0 };
  const keyOf = (ctx) => JSON.stringify(ctx);
  const deny = (code) => { throw Object.assign(new Error(code), { name: 'ToolContextError', code }); };
  const access = {
    state,
    trust(ctx) { trusted.set(keyOf(ctx), true); return ctx; },
    async authorize(ctx, action) {
      state.calls += 1;
      if (!trusted.has(keyOf(ctx))) deny('tool-context-untrusted');
      if (action !== 'read' && action !== 'write') deny('tool-action-invalid');
      if (!state.readAllowed) deny('run-access-denied');
      if (action === 'write' && !state.writeAllowed) deny('run-access-denied');
      return { allowed: true, fenceRevision: state.fence, grantState: state.grantState };
    },
    async fromGrant() { deny('tool-grant-locator-invalid'); },
    async verifyFence(ctx, revision) { return trusted.has(keyOf(ctx)) && revision === state.fence; },
  };
  return access;
}

/* ---------------------------------------------------------------- 整套环境 */

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [o]
 * @param {ReturnType<typeof makeAccess>} [o.access]
 * @param {object} [o.runtime] `findTestRuntime()` 的结果
 * @param {object} [o.python] 覆盖给 `createTrackTools` 的 `python`(null = 没配)
 * @param {object} [o.limits]
 * @param {object} [o.install]
 * @param {(ctx: object) => Promise<object|null>} [o.readProject]
 * @param {object} [o.resources] 现成的 run-resources(接真 run-authority 时用)
 * @param {{ authorize: Function, verifyFence: Function }} [o.gate] 配 `resources` 时必须一起给
 */
export async function buildTrackEnv(t, { access = makeAccess(), runtime = findTestRuntime(), python: pythonOverride, limits = {}, install = {}, readProject = null, resources: resourcesIn = null, gate = null, dir = null, keep = false } = {}) {
  const root = dir ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-p3-'));
  const chunkSize = 256 * 1024;
  const stores = createProjectAssetStores({ dir: path.join(root, 'asset'), chunkSize });
  const mediaTable = new Map();
  const handles = new Map();
  const spawns = [];
  const closedPending = (stream) => (stream.closed ? Promise.resolve() : new Promise((resolve) => stream.once('close', resolve)));

  const transport = {
    async issue({ context, purpose, selector }) {
      let resource;
      let extra = {};
      if (purpose === 'openRead') {
        const entry = mediaTable.get(`${context.projectId}:${selector.mediaId}`);
        if (!entry) throw accountError(404, 'media-not-found');
        resource = { projectId: context.projectId, ns: 'media', hash: entry.hash, size: entry.size, ext: entry.ext, contentType: entry.contentType };
        extra = { mediaRev: digestOf({ v: 1, projectId: context.projectId, mediaId: selector.mediaId, hash: entry.hash, kind: entry.kind }), projectRev: 1, kind: entry.kind };
      } else {
        resource = { projectId: context.projectId, ns: 'media', hash: selector.hash, size: selector.size, ext: selector.ext ?? 'bin', contentType: 'application/octet-stream' };
      }
      const assetHandleId = `handle-${handles.size}`;
      handles.set(assetHandleId, resource);
      return { assetHandleId, resource, resourceRev: resourceRevision(resource), expiresAt: Date.now() + 60_000, fenceRevision: 1, grantState: 'active', ...extra };
    },
    async request({ context, assetHandleId, method, url }) {
      const ref = handles.get(assetHandleId);
      const store = stores.store(context.projectId, 'media');
      let stream; let status = 200; let body;
      if (url.endsWith('/verify')) {
        const stat = await store.stat(ref.hash);
        body = stat ? { ok: true, result: { assetRefId: assetRefId(ref), assetRef: ref, resourceRev: resourceRevision(ref) } } : { ok: false, code: 'asset-missing' };
        status = stat ? 200 : 404;
      } else if (method === 'GET' && !url.endsWith('/chunks')) {
        stream = await store.read(ref.hash);
        if (!stream) { status = 404; body = { ok: false, code: 'asset-missing' }; }
      } else {
        status = 501; body = { ok: false, code: 'not-supported-in-kit' };
      }
      stream ??= Readable.from([Buffer.from(JSON.stringify(body))]);
      return { status, headers: {}, stream, closed: closedPending(stream) };
    },
  };
  const client = createRunAssetClient({ transport, maxResponseBytes: 8192 });

  const gateAuthorize = gate?.authorize ?? access.authorize;
  const gateVerify = gate?.verifyFence ?? access.verifyFence;
  const resources = resourcesIn ?? createRunResources({ contextAccess: { fromGrant: access.fromGrant, authorize: access.authorize } });
  const jobsPath = path.join(root, 'state', 'tool-jobs.db');
  const resultsPath = path.join(root, 'state', 'track-results.db');
  const jobs = createToolJobs({ databasePath: jobsPath, authorize: gateAuthorize, verifyFence: gateVerify });

  const workspaces = createWorkspaces({ dataDir: path.join(root, 'agent') });
  const workspace = async (ctx) => {
    const ws = workspaces.open({ projectId: ctx.projectId, ownerKey: 'owner123', conversationId: ctx.conversationId });
    const original = ws.spawn;
    ws.spawn = (command, args, options) => {
      const child = original(command, args, options);
      spawns.push({ command, args: [...args], pid: child.pid, child });
      return child;
    };
    return ws;
  };
  const assets = createProjectAssets({
    contextAccess: { fromGrant: access.fromGrant, authorize: gateAuthorize }, runAssetClient: client, resources, workspace,
    maxImportBytes: 64 * 1024 * 1024, reserveImport: async () => {},
  });

  const pythonConfig = pythonOverride === undefined
    ? (runtime ? { executable: runtime.python, packageRoot: PYTHON_PACKAGE_ROOT, ffmpeg: runtime.ffmpeg, models: path.join(root, 'models'), pylibs: path.join(root, 'pylibs') } : null)
    : pythonOverride;

  const opened = [];
  function openTracks(extra = {}) {
    const provider = createTrackTools({
      contextAccess: { authorize: gateAuthorize }, resources, jobs, assets, workspace, databasePath: resultsPath,
      python: pythonConfig, readProject, install, limits, ...extra,
    });
    opened.push(provider);
    return provider;
  }
  const tracks = openTracks();

  /** 把一份字节作为这个项目的一个素材放进真项目素材库 */
  async function addMedia(projectId, mediaId, bytes, { kind = 'video', ext = 'mp4' } = {}) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : fs.readFileSync(bytes);
    const hash = createHash('sha256').update(buffer).digest('hex');
    const store = stores.store(projectId, 'media');
    for (let n = 0; n * chunkSize < buffer.length; n += 1) {
      await store.putChunk(hash, n, { size: buffer.length, ext }, Readable.from([buffer.subarray(n * chunkSize, (n + 1) * chunkSize)]));
    }
    await store.complete(hash);
    mediaTable.set(`${projectId}:${mediaId}`, { hash, size: buffer.length, ext, kind, contentType: kind === 'video' ? 'video/mp4' : 'application/octet-stream' });
    return { hash, size: buffer.length };
  }

  let closedAll = null;
  const env = {
    root, stores, assets, resources, jobs, access, tracks, workspaces, workspace, spawns, addMedia, mediaTable, openTracks,
    jobsPath, resultsPath, pythonConfig, runtime,
    /** 幂等:提供者、素材、资源表、作业库依次关 */
    close() {
      closedAll ??= (async () => { for (const provider of opened) await provider.close('test-close'); await assets.close(); await resources.close(); await jobs.close(); })();
      return closedAll;
    },
  };
  t.after(async () => {
    await env.close().catch((e) => { });
    if (!keep) await fsp.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  });
  return env;
}

/** 进程还活着吗(给子进程 pid 做「真的退出了」的核对) */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** 轮询 get_track 直到不再 running;回最后一次的返回值(失败会抛) */
export async function untilTracked(tracks, context, mediaId, { timeoutMs = 60_000 } = {}) {
  const progress = [];
  const result = await waitFor(async () => {
    const out = await tracks.call('get_track', { mediaId }, context);
    if (out.running) { progress.push(out.percent); return false; }
    return out;
  }, { timeoutMs, what: `${mediaId} 的追踪跑完` });
  return { result, progress };
}

export { createTrackResultStore };
