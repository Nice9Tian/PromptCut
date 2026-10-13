// P5(后台作业状态与一键流程)的测试底座:真的 doc 一侧运行权限(SQLite)、真的 run-resources、真的 tool-jobs(SQLite)、
// 真的项目素材物理库与 project-assets、真的工作区;项目一侧是一个内存里的替身(G 包才接真的 doc),
// 三个感知包的提供方有两种:「假」(按真提供方的回执形状和账本约定写的,可由测试控制何时完成、失败、卡住)和「真」(真的 stt / shots / subject)。
// 不含 TLS 线路(那一段由 F0 的 mTLS 测试负责);素材传输走受控线路适配器,但字节、哈希、fd 都是真的。
// 单测与探针(scripts/probes/cloud-tools-p5-workflow-probe.mjs)共用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { createToolJobs } from '../agent/service/tool-jobs.mjs';
import { createProjectAssets } from '../agent/service/project-assets.mjs';
import { createRunAssetClient } from '../agent/service/run-asset-client.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { resourceRevision, assetRefId } from '../account/run-asset-protocol.mjs';
import { createWorkflowTools } from '../agent/service/hosted-workflow.mjs';

export { projectId, conversationId };

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const closedOf = (stream) => (stream.closed ? Promise.resolve() : new Promise((r) => stream.once('close', r)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(check, { ms = 15_000, step = 25, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

/** 素材记录的版本号(替身用;真实的由 doc 在 openRead 的票据里给) */
export const mediaRevOf = (m) => sha(`${m.kind}|${m.hash}|${m.size}|${m.ext}`);

/** 一键流程配卡用到的九张卡加字幕卡的参数表(取自 src/cards/native/*.tsx 里每张卡的 controls;宿主在生产里经 ssr-host 取真的 getCard) */
export const CARD_CONTROLS = Object.freeze({
  odometer: ['value', 'unit', 'label', 'kicker'],
  'stat-proof': ['kicker', 'kickerZh', 'value', 'prefix', 'suffix', 'footEn', 'footZh', 'countMs'],
  'versus-card': ['aKicker', 'aTitle', 'aSub', 'aAccent', 'bKicker', 'bTitle', 'bSub', 'winner'],
  'step-timeline': ['steps', 'stepMs'],
  checklist: ['items', 'stepMs'],
  'quote-lockup': ['quote', 'author', 'side'],
  'blur-text': ['text', 'staggerMs'],
  'punch-pill': ['text'],
  'term-card': ['en', 'term', 'def'],
  'caption-track': ['position', 'lines', 'showEn', 'strokeOn', 'strokeW', 'strokeColor'],
});
export const testKernel = Object.freeze({
  getCard: (id) => (CARD_CONTROLS[id] ? { id, controls: CARD_CONTROLS[id].map((key) => ({ key })) } : undefined),
});

/** 一份中文文字稿:每一段落进下面注释里的那种卡 */
export const SCRIPT_SEGMENTS = Object.freeze([
  { start: 0.0, end: 3.0, text: '去年我们的用户增长了300%,' },        // 组 1:≥5 秒且句末标点 → odometer(增长 + 数字%)
  { start: 3.0, end: 6.2, text: '这是一个翻倍的结果。' },
  { start: 8.0, end: 10.5, text: '所谓留存率,指的是' },               // 组 2:停顿 1.8 秒后的新组;≥5 秒后遇句号断 → term-card
  { start: 10.5, end: 13.5, text: '用户回来的比例。' },
  { start: 15.0, end: 17.0, text: '第一步,打开软件,' },                // 组 3:step-timeline
  { start: 17.0, end: 20.5, text: '第二步,导入素材。' },
]);

export const SCRIPT = { engine: 'faster-whisper', model: 'small', language: 'zh', createdAt: '2026-10-13T00:00:00.000Z', segments: SCRIPT_SEGMENTS.map((s) => ({ ...s })) };

/** 项目一侧的替身:素材表、时间轴、版本号、提交记录。接缝同各感知包(getMedia / setMediaShots / setMediaSubjects / commitTranscript)再加本包的 getTimeline / applyEdits */
function makeProjectDouble({ resources, extraProjects = [] }) {
  const projects = new Map([[projectId, new Map()], ...extraProjects.map((p) => [p, new Map()])]);
  const state = {
    rev: 1, duration: 30,
    tracks: [{ id: 'v1', clips: [] }],
    cards: [],              // 放进项目的卡片与字幕片段
    commits: [],            // 每一次提交(转写、镜头、主体、配卡)的记录
    editAttempts: 0,        // applyEdits 被调用的次数(含被拒的)
    published: [],          // prerender 接缝收到的
  };
  const hooks = { beforeApply: null, failApply: null, applyDelayMs: 0 };
  let clipCounter = 0;
  const ensureProject = (ctx) => {
    const map = projects.get(ctx.projectId);
    if (!map) throw Object.assign(new Error('media-missing'), { code: 'media-missing' });
    return map;
  };
  const bump = (what, extra = {}) => { state.rev += 1; state.commits.push({ what, rev: state.rev, ...extra }); return state.rev; };
  const project = {
    async getMedia(ctx, mediaId) {
      const m = projects.get(ctx.projectId)?.get(mediaId);
      return m ? structuredClone({ ...m, mediaRev: mediaRevOf(m) }) : null;
    },
    async getStage() { return { width: 1920, height: 1080 }; },
    async commitTranscript(ctx, { mediaId, assetHash, transcript, jobId }) {
      await resources.authorize(ctx, 'write');
      const map = ensureProject(ctx);
      const m = map.get(mediaId);
      if (!m) throw Object.assign(new Error('media-missing'), { code: 'media-missing' });
      if (m.hash !== assetHash) throw Object.assign(new Error('media-changed'), { code: 'media-changed' });
      map.set(mediaId, { ...m, transcript });
      bump('transcript', { mediaId, jobId });
      return { committed: true };
    },
    async setMediaShots(ctx, { mediaId, expectedMediaRev, shots, jobId }) {
      const map = ensureProject(ctx);
      const m = map.get(mediaId);
      if (!m) throw Object.assign(new Error('media-missing'), { code: 'media-missing' });
      if (mediaRevOf(m) !== expectedMediaRev) throw Object.assign(new Error('media-changed'), { code: 'media-changed' });
      map.set(mediaId, { ...m, shots });
      return { projectRev: bump('shots', { mediaId, jobId }) };
    },
    async setMediaSubjects(ctx, { mediaId, expectedMediaRev, subjects, jobId }) {
      const map = ensureProject(ctx);
      const m = map.get(mediaId);
      if (!m) throw Object.assign(new Error('media-missing'), { code: 'media-missing' });
      if (mediaRevOf(m) !== expectedMediaRev) throw Object.assign(new Error('media-changed'), { code: 'media-changed' });
      map.set(mediaId, { ...m, subjects });
      return { projectRev: bump('subjects', { mediaId, jobId }) };
    },
    async getTimeline(ctx) {
      ensureProject(ctx);
      return structuredClone({ projectRev: state.rev, tracks: state.tracks });
    },
    async applyEdits(ctx, input) {
      state.editAttempts += 1;
      await resources.authorize(ctx, 'write');
      if (hooks.applyDelayMs) await sleep(hooks.applyDelayMs);
      if (hooks.beforeApply) { const fn = hooks.beforeApply; hooks.beforeApply = null; await fn(); }
      if (hooks.failApply) { const error = hooks.failApply; hooks.failApply = null; throw error; }
      // 整份要么全进要么全不进:先全部校验,再一次落下
      if (input.expectedProjectRev !== state.rev) throw Object.assign(new Error('project-changed'), { code: 'project-changed' });
      const existing = state.cards.filter((c) => c.commitKey === input.commitKey);
      if (existing.length) {
        return { alreadyApplied: true, projectRev: state.rev,
          clips: existing.filter((c) => c.cardId !== 'caption-track').map((c) => ({ clipId: c.clipId, start: c.start, end: c.end })),
          captionClipId: existing.find((c) => c.cardId === 'caption-track')?.clipId ?? null };
      }
      const placed = input.cards.map((card, i) => {
        if (i >= 6 && hooks.dropAfter6) return null;       // 模拟放不下的片段
        const clipId = `clip_${++clipCounter}`;
        return { clipId, cardId: card.cardId, start: card.start, end: card.start + card.duration, params: card.params, commitKey: input.commitKey, jobId: input.jobId };
      });
      let caption = null;
      if (input.caption) {
        caption = { clipId: `clip_${++clipCounter}`, cardId: 'caption-track', start: input.caption.start, end: input.caption.start + input.caption.duration,
          params: input.caption.params, trackId: 'captions', commitKey: input.commitKey, jobId: input.jobId };
      }
      const added = [...placed.filter(Boolean), ...(caption ? [caption] : [])];
      state.cards.push(...added);
      const maxEnd = Math.max(0, ...state.tracks.flatMap((t) => t.clips.map((c) => c.end)), ...state.cards.map((c) => c.end));
      if (maxEnd > state.duration) state.duration = maxEnd;
      bump('edits', { jobId: input.jobId, count: added.length });
      return {
        projectRev: state.rev,
        clips: placed.map((c) => (c ? { clipId: c.clipId, start: c.start, end: c.end } : null)),
        captionClipId: caption?.clipId ?? null,
      };
    },
  };
  const prerender = {
    mode: 'ok',              // ok | not-published | throw
    async publish(ctx, input) {
      await resources.authorize(ctx, 'write');
      state.published.push({ ...input });
      if (prerender.mode === 'throw') throw new Error('渲染队列连不上');
      if (prerender.mode === 'not-published') return { published: false, reason: '这个项目现在没有可用的渲染节点。' };
      return { published: true, planned: input.clipIds.length };
    },
  };
  return { project, projects, state, hooks, prerender };
}

/**
 * 假的感知提供方:回执形状、账本约定、工作区索引都照真提供方(stt.mjs / shots.mjs / subject.mjs)写,
 * 但「什么时候做完、做不做得成」由测试控制。
 */
function makeFakeProvider({ name, kind, tool, resources, jobs, wsOf, project, finish, indexFile = null }) {
  const live = new Map();
  const ctl = {
    unavailable: null,        // 字符串:回 cloudUnavailable
    hold: false,              // true:卡住,直到 release()
    delayMs: 20,
    failCode: null,           // 做到最后失败,写这个码
    failMessage: null,        // 写进工作区索引的人话(镜头、主体)
    throwOnCall: null,        // 调用时直接抛(例如参数错)
    calls: [],
    commits: 0,
  };
  const gates = new Set();
  const api = {
    ctl,
    release() { ctl.hold = false; },
    async call(toolName, args, context, options = {}) {
      ctl.calls.push({ toolName, args, requestId: options.requestId });
      if (toolName !== tool) throw new Error(`fake ${name} 不处理 ${toolName}`);
      await resources.authorize(context, 'write');
      if (ctl.throwOnCall) throw ctl.throwOnCall;
      if (ctl.unavailable) return { ok: false, cloudUnavailable: true, error: ctl.unavailable };
      const mediaId = args.mediaId;
      const digest = sha(JSON.stringify({ name, mediaId }));
      const requestId = options.requestId ?? `fake-${crypto.randomUUID()}`;
      const started = await jobs.start(context, kind, digest, requestId);
      if (started.state !== 'queued' || live.has(started.jobId)) return { jobId: started.jobId, started: false, state: started.state, mediaId };
      const job = { jobId: started.jobId, context, mediaId, controller: new AbortController(), revision: 0, done: null };
      live.set(started.jobId, job);
      job.done = run(job).finally(() => live.delete(started.jobId));
      return { jobId: started.jobId, started: true, mediaId };
    },
    async cancel(context, jobId) { const job = live.get(jobId); if (job) job.controller.abort(); return { cancelled: !!job }; },
    async close() { for (const job of live.values()) job.controller.abort(); await Promise.allSettled([...live.values()].map((j) => j.done)); return { childrenClosed: true, streamsClosed: true, workPending: 0 }; },
    get active() { return live.size; },
  };
  async function patch(job, p) {
    await jobs.update(job.context, job.jobId, job.revision, p);
    job.revision += 1;
  }
  async function writeIndex(job, row) {
    if (!indexFile) return;
    const ws = await wsOf(job.context);
    let rows = [];
    try { if (ws.exists(indexFile)) rows = JSON.parse(ws.read(indexFile).toString('utf8')); } catch { rows = []; }
    const at = rows.findIndex((r) => r.jobId === job.jobId);
    const merged = { ...(at >= 0 ? rows[at] : { jobId: job.jobId, mediaId: job.mediaId }), ...row };
    if (at >= 0) rows[at] = merged; else rows.push(merged);
    ws.write(indexFile, JSON.stringify(rows));
  }
  async function run(job) {
    const handle = Object.assign(new EventEmitter(), { destroy() { job.controller.abort(); this.emit('close'); } });
    let registration;
    try { registration = await resources.register(job.context, { kind: 'stream', resource: handle }); } catch { return; }
    const signal = AbortSignal.any([registration.signal, job.controller.signal]);
    try {
      job.revision = (await jobs.get(job.context, job.jobId)).revision;
      await patch(job, { state: 'running', stage: 'work', progress: 0.1 });
      for (let waited = 0; ctl.hold || waited < ctl.delayMs; waited += 5) {
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        await sleep(5);
      }
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      await patch(job, { progress: 0.6 });
      if (ctl.failCode) {
        await writeIndex(job, { status: 'error', errorCode: ctl.failCode, message: ctl.failMessage ?? undefined });
        await patch(job, { state: 'error', errorCode: ctl.failCode });
        return;
      }
      await resources.authorize(job.context, 'write');
      await finish(job, project, ctl);
      ctl.commits += 1;
      await writeIndex(job, { status: 'done' });
      await patch(job, { state: 'done', progress: 1, outputRefs: [{ kind: kind.split('.')[0], id: job.mediaId.replace(/[^A-Za-z0-9_-]/g, '_') }] });
    } catch (error) {
      if (error?.name === 'AbortError' || signal.aborted) {
        // 被停:能写就写 cancelled,写不了(授权已收回)就留给宿主的 cancelForFence
        try { await patch(job, { state: 'cancelled', errorCode: 'FENCE_CANCELLED' }); } catch { /* 交给宿主 */ }
      } else {
        try { await patch(job, { state: 'error', errorCode: 'FAKE_CRASH' }); } catch { /* 同上 */ }
      }
    } finally {
      handle.destroy();
    }
  }
  return api;
}

export async function makeP5Fixture(t, {
  workflowLimits = {}, readOnly = false, extraProjects = [], errorTexts = {}, optionalStages, withPrerender = true,
  providers: providerMode = 'fake', realProviders = null, now = Date.now,
} = {}) {
  const authority = await runFixture();
  authority.enqueue();
  const grant = await authority.admit();
  await authority.provider.confirmRead(authority.input(grant));
  const dir = authority.dir;

  let denyWrite = readOnly;
  let unavailable = false;
  const runClient = {
    registerInstance: async () => authority.agentProcess.registration,
    instanceIdentity: () => authority.agentProcess.registration,
    async checkAccess({ projectId: p, runGrantId, action }) {
      if (unavailable) throw new Error('controlled transport unavailable');
      if (denyWrite && action === 'write') throw Object.assign(new Error('controlled read-only context'), { status: 403, code: 'read-only' });
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return authority.provider.checkAccess({ principal, projectId: p, action });
    },
  };
  const resources = createRunResources({ runClient });
  const context = await resources.contextFor({ projectId, runGrantId: grant.runGrantId });
  const dbPath = path.join(dir, 'tool-jobs.db');
  // 宿主的取消路径用「控制面事件里的旧栅栏」核对(私有/停止之后当前授权已经读不到了),这里用 cancelWindow 模拟
  const cancel = { window: false, fence: null };
  const openJobs = () => createToolJobs({
    databasePath: dbPath, now,
    authorize: (c, a) => resources.authorize(c, a),
    verifyFence: (c, r) => (cancel.window ? r === cancel.fence : resources.verifyFence(c, r)),
  });
  let jobs = openJobs();

  const workspaces = createWorkspaces({ dataDir: path.join(dir, 'agent') });
  const ws = workspaces.open({ projectId, ownerKey: 'owner1234', conversationId });
  const wsOf = async () => ws;

  const double = makeProjectDouble({ resources, extraProjects });
  const { project, projects, state, hooks, prerender } = double;

  // 素材服务:真的物理库 + 受控线路适配器(只有真的感知提供方才会读到字节)
  const stores = createProjectAssetStores({ dir: path.join(dir, 'asset'), chunkSize: 64 * 1024 });
  const handles = new Map();
  const transport = {
    async issue({ context: ctx, purpose, selector }) {
      let resource;
      let extra = {};
      if (purpose === 'openRead') {
        const m = projects.get(ctx.projectId)?.get(selector.mediaId);
        if (!m) throw Object.assign(new Error('asset-missing'), { status: 404, code: 'asset-missing' });
        resource = { projectId: ctx.projectId, ns: 'media', hash: m.hash, size: m.size, ext: m.ext, contentType: m.kind === 'video' ? 'video/mp4' : 'application/octet-stream' };
        extra = { mediaRev: mediaRevOf(m), projectRev: 1, kind: m.kind };
      } else resource = { projectId: ctx.projectId, ns: 'media', hash: selector.hash, size: selector.size, ext: selector.ext ?? 'bin', contentType: 'application/octet-stream' };
      const assetHandleId = `handle-${handles.size}`;
      handles.set(assetHandleId, resource);
      return { assetHandleId, resource, resourceRev: resourceRevision(resource), expiresAt: 1000, fenceRevision: 1, grantState: 'active', ...extra };
    },
    async request({ context: ctx, assetHandleId, method, url, body }) {
      const ref = handles.get(assetHandleId);
      const store = stores.store(ctx.projectId, 'media');
      let result;
      let stream;
      let status = 200;
      if (method === 'PUT') result = await store.putChunk(ref.hash, Number(url.split('/').at(-1)), { size: ref.size, ext: ref.ext }, Readable.from([body]));
      else if (url.endsWith('/complete')) result = await store.complete(ref.hash);
      else if (url.endsWith('/chunks')) result = await store.chunks(ref.hash);
      else if (url.endsWith('/verify')) {
        const stat = await store.stat(ref.hash);
        if (!stat) { status = 404; result = 'asset-missing'; } else result = { assetRefId: assetRefId(ref), assetRef: ref, resourceRev: resourceRevision(ref) };
      } else { stream = await store.read(ref.hash); if (!stream) { status = 404; result = 'asset-missing'; } }
      stream ??= Readable.from([Buffer.from(JSON.stringify(status < 400 ? { ok: true, result } : { ok: false, code: result }))]);
      return { status, headers: {}, stream, closed: closedOf(stream) };
    },
  };
  const client = createRunAssetClient({ transport, maxResponseBytes: 64 * 1024 });
  const assets = createProjectAssets({
    contextAccess: resources.contextAccess, runAssetClient: client, resources, workspace: async () => ws,
    maxImportBytes: 512 * 1024 * 1024, reserveImport: async () => {}, verifySourceJob: async () => true,
  });

  // 三个感知提供方
  const fakeOf = () => ({
    stt: makeFakeProvider({ name: 'stt', kind: 'stt.transcribe', tool: 'transcribe_media', resources, jobs, wsOf, project,
      finish: async (job, p) => p.commitTranscript(job.context, { mediaId: job.mediaId, assetHash: (await p.getMedia(job.context, job.mediaId)).hash, transcript: structuredClone(SCRIPT), jobId: job.jobId }) }),
    shots: makeFakeProvider({ name: 'shots', kind: 'shots.detect', tool: 'detect_shots', resources, jobs, wsOf, project, indexFile: 'shots/jobs.json',
      finish: async (job, p) => { const m = await p.getMedia(job.context, job.mediaId); return p.setMediaShots(job.context, { mediaId: job.mediaId, expectedMediaRev: m.mediaRev, jobId: job.jobId,
        shots: { engine: 'scdet', shots: [{ start: 0, end: 10 }, { start: 10, end: 20.5 }], transitions: [] } }); } }),
    subject: makeFakeProvider({ name: 'subject', kind: 'subject.detect', tool: 'detect_subjects', resources, jobs, wsOf, project, indexFile: 'subject/jobs.json',
      finish: async (job, p) => { const m = await p.getMedia(job.context, job.mediaId); return p.setMediaSubjects(job.context, { mediaId: job.mediaId, expectedMediaRev: m.mediaRev, jobId: job.jobId,
        subjects: { engine: 'light', samples: [{ t: 1, boxes: [] }], failedCount: 0 } }); } }),
  });
  let perception = providerMode === 'real' ? realProviders({ resources, assets, jobs, ws, project, wsOf }) : fakeOf();

  const buildWorkflow = (overrides = {}) => createWorkflowTools({
    resources, jobs, workspace: wsOf,
    providers: { stt: perception.stt, shots: perception.shots, subject: perception.subject },
    project, prerender: withPrerender ? prerender : null, kernel: testKernel, errorTexts, now,
    limits: { pollMs: 15, progressMs: 0, closeMs: 8_000, fastWaitMs: 15_000, ...(optionalStages ? { optionalStages } : {}), ...workflowLimits },
    ...overrides,
  });
  let workflow = buildWorkflow();

  let counter = 0;
  /** 把一份字节放进项目的素材库并登记成素材(假提供方用不到字节,真的会读) */
  async function addMedia({ id, name = 'clip.mp4', kind = 'video', bytes = Buffer.from(`media-${id}`), forProject = projectId, extra = {}, onTimeline = true } = {}) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const ext = path.extname(name).slice(1).toLowerCase() || 'bin';
    const hash = sha(buf);
    if (forProject === projectId) {
      await assets.import(context, buf, { name, kind, requestId: `import-${id}-${counter++}-xxxxxx` });
    } else {
      const store = stores.store(forProject, 'media');
      await store.putChunk(hash, 0, { size: buf.length, ext }, Readable.from([buf]));
      await store.complete(hash);
    }
    projects.get(forProject).set(id, { id, name, kind, hash, size: buf.length, ext, duration: 20.5, ...extra });
    if (onTimeline && forProject === projectId && kind !== 'image') state.tracks[0].clips.push({ id: `tl_${id}`, mediaId: id, start: 0, end: 20.5, mediaOffset: 0 });
    return { id, hash, size: buf.length };
  }

  const call = (name, args, ctx = context, options = {}) => workflow.call(name, args, ctx, options);
  /** 等一键流程走完(终态),回 auto_workflow_status */
  async function settle(jobId, ms = 30_000) {
    return until(async () => { const s = await call('auto_workflow_status', { jobId }); return s.done ? s : null; }, { ms, what: `workflow ${jobId} to finish` });
  }

  async function dispose() {
    await workflow.close('test-end').catch(() => {});
    for (const p of Object.values(perception)) await p?.close?.('test-end').catch?.(() => {});
    await assets.close().catch(() => {});
    await jobs.close().catch(() => {});
    await resources.close().catch(() => {});
    authority.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (t) t.after(dispose);

  return {
    authority, resources, assets, ws, wsOf, project, projects, state, hooks, prerender, stores, context, grant, dir, dbPath, cancel,
    addMedia, call, settle,
    get workflow() { return workflow; },
    get jobs() { return jobs; },
    get perception() { return perception; },
    setReadOnly(v) { denyWrite = v; },
    setUnavailable(v) { unavailable = v; },
    /** 开第二个账本连接(同一份 SQLite),用任意授权往里塞别的项目/别的对话的作业,测「看不到」 */
    foreignJobs() {
      return createToolJobs({ databasePath: dbPath, now, authorize: async () => ({ allowed: true, fenceRevision: 1, grantState: 'active' }), verifyFence: async () => true });
    },
    /** 模拟 Agent 服务重启:关掉流程与感知提供方,在同一份 SQLite 与工作区上重开账本与提供方(项目替身留着) */
    async restart({ keepProviders = false, workflowOverrides = {} } = {}) {
      await workflow.close('restart');
      if (!keepProviders) for (const p of Object.values(perception)) await p?.close?.('restart');
      await jobs.close();
      jobs = openJobs();
      if (!keepProviders) perception = providerMode === 'real' ? realProviders({ resources, assets, jobs, ws, project, wsOf }) : fakeOf();
      workflow = buildWorkflow(workflowOverrides);
      return workflow;
    },
    dispose,
  };
}

export const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
