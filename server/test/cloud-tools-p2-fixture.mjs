// P2(云端语音转写)测试夹具:真 SQLite 运行授权 + 真 ToolJobs + 真运行资源登记器 + 真项目素材库(接线用受控 wire adapter) + 真工作区。
// 不假装的:没有真 mTLS 的素材 HTTP 通道(wire adapter 直接调真的素材库,同 project-assets-client.test.mjs 的做法);项目是内存里的假文档。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { createToolJobs } from '../agent/service/tool-jobs.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { createProjectAssets } from '../agent/service/project-assets.mjs';
import { createRunAssetClient } from '../agent/service/run-asset-client.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { resourceRevision, assetRefId } from '../account/run-asset-protocol.mjs';
import { accountError } from '../account/client.mjs';
import { createSttTools } from '../agent/service/perception/stt.mjs';

export { projectId, conversationId };
const CHUNK = 1 << 20;
export const FAKE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cloud-tools-p2-fake-stt.mjs');
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function until(check, { ms = 15_000, step = 50, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}
const closedOf = (stream) => (stream.closed ? Promise.resolve() : new Promise((resolve) => stream.once('close', resolve)));

/**
 * @param {object} [options]
 * @param {boolean} [options.realPython] 用真 Python(runtime 里给 pythonPath 等),不用假脚本
 * @param {object} [options.runtime] 传给 createSttTools 的 runtime
 * @param {object} [options.limits]
 */
export async function p2Fixture(t, options = {}) {
  const authority = await runFixture();
  authority.enqueue();
  const grant = await authority.admit();
  await authority.provider.confirmRead(authority.input(grant));
  const flags = { readOnly: false };
  const runClient = {
    registerInstance: async () => authority.agentProcess.registration,
    instanceIdentity: () => authority.agentProcess.registration,
    async checkAccess({ projectId: p, runGrantId, action }) {
      if (flags.readOnly && action === 'write') throw Object.assign(new Error('read-only'), { status: 403, code: 'read-only' });
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return authority.provider.checkAccess({ principal, projectId: p, action });
    },
  };
  const resources = createRunResources({ runClient });
  const context = await resources.contextFor({ projectId, runGrantId: grant.runGrantId });

  // 宿主的取消路径用「控制面事件里的旧栅栏」核对(私有/停止之后当前授权已经读不到了),这里用 cancelWindow 模拟
  const cancel = { window: false, fence: null };
  const authorize = (ctx, action) => resources.authorize(ctx, action);
  const verifyFence = (ctx, revision) => (cancel.window ? revision === cancel.fence : resources.verifyFence(ctx, revision));
  const jobsPath = path.join(authority.dir, 'tool-jobs.db');
  const openJobs = () => createToolJobs({ databasePath: jobsPath, authorize, verifyFence });
  let jobs = openJobs();

  // 素材:每个项目一张表 mediaId -> {hash,size,ext,kind}
  const stores = createProjectAssetStores({ dir: path.join(authority.dir, 'asset'), chunkSize: CHUNK });
  const media = new Map();
  const calls = { openRead: 0, spawns: [], maxConcurrentTranscribe: 0, realChildren: [] };
  async function putMedia(project, mediaId, bytes, { kind = 'audio', ext = 'wav' } = {}) {
    const hash = sha256(bytes);
    const store = stores.store(project, 'media');
    for (let n = 0; n * CHUNK < bytes.length; n += 1) {
      await store.putChunk(hash, n, { size: bytes.length, ext }, Readable.from([bytes.subarray(n * CHUNK, (n + 1) * CHUNK)]));
    }
    await store.complete(hash);
    media.set(`${project}\0${mediaId}`, { hash, size: bytes.length, ext, kind });
    return { hash, size: bytes.length };
  }
  const handles = new Map();
  const transport = {
    async issue({ context: ctx, purpose, selector }) {
      let resource; let extra = {};
      if (purpose === 'openRead') {
        calls.openRead += 1;
        const entry = media.get(`${ctx.projectId}\0${selector.mediaId}`);
        if (!entry) throw accountError(404, 'asset-missing');
        resource = { projectId: ctx.projectId, ns: 'media', hash: entry.hash, size: entry.size, ext: entry.ext, contentType: entry.kind === 'video' ? 'video/mp4' : 'audio/wav' };
        extra = { mediaRev: entry.hash, projectRev: 1, kind: entry.kind };
      } else {
        resource = { projectId: ctx.projectId, ns: 'media', hash: selector.hash, size: selector.size, ext: 'wav', contentType: 'audio/wav' };
      }
      const assetHandleId = `handle-${handles.size}`;
      handles.set(assetHandleId, resource);
      return { assetHandleId, resource, resourceRev: resourceRevision(resource), expiresAt: 1000, fenceRevision: 1, grantState: 'active', ...extra };
    },
    async request({ context: ctx, assetHandleId, method, url }) {
      const ref = handles.get(assetHandleId);
      const store = stores.store(ctx.projectId, 'media');
      let result; let stream; let status = 200;
      if (method === 'GET' && url.endsWith('/chunks')) result = await store.chunks(ref.hash);
      else if (url.endsWith('/verify')) result = { assetRefId: assetRefId(ref), assetRef: ref, resourceRev: resourceRevision(ref) };
      else { stream = await store.read(ref.hash); if (!stream) { status = 404; result = 'asset-missing'; } }
      stream ??= Readable.from([Buffer.from(JSON.stringify(status < 400 ? { ok: true, result } : { ok: false, code: result }))]);
      return { status, headers: {}, stream, closed: closedOf(stream) };
    },
  };
  const workspaces = createWorkspaces({ dataDir: path.join(authority.dir, 'agent') });
  const ws = workspaces.open({ projectId, ownerKey: 'owner123', conversationId });
  const assets = createProjectAssets({
    contextAccess: resources, runAssetClient: createRunAssetClient({ transport, maxResponseBytes: 1 << 20 }), resources,
    workspace: async () => ws, maxImportBytes: 1 << 20, reserveImport: async () => {},
  });

  // 假文档:media 表 + 提交记录
  const doc = { media: new Map(), commits: [], failNextCommit: null, mutateBeforeCommit: null };
  const commitTranscript = async (ctx, input) => {
    await resources.authorize(ctx, 'write');
    if (doc.mutateBeforeCommit) { const fn = doc.mutateBeforeCommit; doc.mutateBeforeCommit = null; fn(); }
    if (doc.failNextCommit) { const error = doc.failNextCommit; doc.failNextCommit = null; throw error; }
    const entry = doc.media.get(input.mediaId);
    if (!entry) throw Object.assign(new Error('media-missing'), { code: 'media-missing' });
    if (entry.hash !== input.assetHash) throw Object.assign(new Error('media-changed'), { code: 'media-changed' });
    entry.transcript = input.transcript;
    doc.commits.push({ ...input, projectId: ctx.projectId });
    return { committed: true };
  };

  // 假 Python:把对 python 的调用换成 node 跑假脚本;模式按子命令分别设
  const modes = { status: 'ready', transcribe: 'ok', install: 'ok' };
  const requirements = path.join(authority.dir, 'locked-requirements.txt');
  fs.writeFileSync(requirements, 'faster_whisper==1.2.1\n');
  let activeTranscribe = 0;
  const fakeSpawn = (command, args, opts) => {
    const marker = args.indexOf('promptcut_stt');
    const sub = args.slice(marker + 1);
    calls.spawns.push({ command, args, cwd: opts.cwd, env: { ...opts.env }, sub });
    const child = spawn(process.execPath, [FAKE_SCRIPT, modes[sub[0]] ?? 'ok', ...sub], opts);
    if (sub[0] === 'transcribe') {
      activeTranscribe += 1;
      calls.maxConcurrentTranscribe = Math.max(calls.maxConcurrentTranscribe, activeTranscribe);
      child.once('close', () => { activeTranscribe -= 1; });
    }
    return child;
  };
  const recordSpawn = (command, args, opts) => { const child = spawn(command, args, opts); calls.realChildren.push(child); return child; };
  const defaultRuntime = options.realPython ? {} : {
    pythonPath: process.execPath, pylibs: path.join(authority.dir, 'pylibs'), modelsDir: path.join(authority.dir, 'models'),
    ffmpegDir: path.join(authority.dir, 'ffmpeg-bin'), requirements: { 'faster-whisper': requirements }, indexUrl: 'https://index.example.test/simple',
  };
  const openTools = (overrides = {}) => createSttTools({
    resources, assets, jobs, workspace: () => ws, commitTranscript,
    runtime: { ...defaultRuntime, ...options.runtime }, limits: { progressMs: 0, closeMs: 8_000, ...options.limits },
    spawnImpl: options.realPython ? recordSpawn : fakeSpawn, ...overrides,
  });
  const opened = [];
  const tools = openTools();
  opened.push(tools);
  t.after(async () => {
    for (const each of opened) await each.close('test-end');
    await jobs.close();
    await assets.close();
    await resources.close();
    authority.close();
    fs.rmSync(authority.dir, { recursive: true, force: true });
  });

  return {
    authority, grant, resources, context, jobs, tools, ws, assets, doc, modes, calls, flags, requirements, putMedia, stores, media,
    jobsPath, cancel, fakeSpawn,
    async reopenJobs() { await jobs.close(); jobs = openJobs(); return jobs; },
    get currentJobs() { return jobs; },
    openTools(overrides) { const each = openTools(overrides); opened.push(each); return each; },
    /** 把素材放进假文档的项目表,并把字节放进项目素材库 */
    async addMedia(mediaId, bytes, meta) {
      const { hash } = await putMedia(projectId, mediaId, bytes, meta);
      doc.media.set(mediaId, { hash, transcript: null });
      return hash;
    },
    /** 取一个作业的当前记录(绕过 ToolJobs 的授权,看它存了什么) */
    async job(jobId) { return jobs.get(context, jobId); },
    /** 读 workspace 里某个文件(工作区相对路径) */
    readWs(rel) { try { return fs.readFileSync(ws.resolve(rel), 'utf8'); } catch { return null; } },
    wsFiles: () => ws.list().filter((f) => !f.path.endsWith('-argv.json') && !f.path.endsWith('.json')),
    pidsFile: () => { try { return JSON.parse(fs.readFileSync(path.join(ws.dir(), 'pids.json'), 'utf8')); } catch { return null; } },
  };
}
