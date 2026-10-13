// P4 主体识别的测试底座:真的 doc 一侧运行权限(SQLite)、真的 run-resources、真的 tool-jobs(SQLite)、
// 真的项目素材物理库与 project-assets、真的工作区,项目一侧用一个内存里的替身(G 包才接真的 doc)。
// 不含 TLS 线路(那一段由 F0 的 mTLS 测试负责)——素材传输走受控线路适配器,但字节、哈希、fd 都是真的。
// 单测与探针(scripts/probes/cloud-tools-p4-subject-probe.mjs)共用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { createToolJobs } from '../agent/service/tool-jobs.mjs';
import { createProjectAssets } from '../agent/service/project-assets.mjs';
import { createRunAssetClient } from '../agent/service/run-asset-client.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { resourceRevision, assetRefId } from '../account/run-asset-protocol.mjs';
import { createSubjectTools } from '../agent/service/perception/subject.mjs';

export { projectId, conversationId };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const closedOf = (stream) => (stream.closed ? Promise.resolve() : new Promise((r) => stream.once('close', r)));

/** 素材记录的版本号(替身用;真实的由 doc 在 openRead 的票据里给) */
export const mediaRevOf = (m) => sha(`${m.kind}|${m.hash}|${m.size}|${m.ext}`);

export async function makeP4Fixture(t, { config = null, limits = {}, readOnly = false, kernel = null, extraProjects = [] } = {}) {
  const authority = await runFixture();
  authority.enqueue();
  const grant = await authority.admit();
  await authority.provider.confirmRead(authority.input(grant));
  const dir = authority.dir;

  let denyWrite = readOnly;
  const runClient = {
    registerInstance: async () => authority.agentProcess.registration,
    instanceIdentity: () => authority.agentProcess.registration,
    async checkAccess({ projectId: p, runGrantId, action }) {
      if (denyWrite && action === 'write') throw Object.assign(new Error('controlled read-only context'), { status: 403, code: 'read-only' });
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return authority.provider.checkAccess({ principal, projectId: p, action });
    },
  };
  const resources = createRunResources({ runClient });
  const context = await resources.contextFor({ projectId, runGrantId: grant.runGrantId });
  const dbPath = path.join(dir, 'tool-jobs.db');
  const openJobs = () => createToolJobs({ databasePath: dbPath, authorize: (c, a) => resources.authorize(c, a), verifyFence: (c, r) => resources.verifyFence(c, r) });
  let jobs = openJobs();

  const workspaces = createWorkspaces({ dataDir: path.join(dir, 'agent') });
  const ws = workspaces.open({ projectId, ownerKey: 'owner1234', conversationId });

  // 项目一侧的替身:projectId -> mediaId -> 素材记录
  const projects = new Map([[projectId, new Map()], ...extraProjects.map((p) => [p, new Map()])]);
  const commits = [];
  const project = {
    async getMedia(ctx, mediaId) {
      const m = projects.get(ctx.projectId)?.get(mediaId);
      return m ? structuredClone({ ...m, mediaRev: mediaRevOf(m) }) : null;
    },
    async setMediaSubjects(ctx, { mediaId, expectedMediaRev, subjects, jobId }) {
      const map = projects.get(ctx.projectId);
      const m = map?.get(mediaId);
      if (!m) throw Object.assign(new Error('media-missing'), { code: 'media-missing' });
      if (mediaRevOf(m) !== expectedMediaRev) throw Object.assign(new Error('media-changed'), { code: 'media-changed' });
      map.set(mediaId, { ...m, subjects }); // 换新对象,不原地改
      commits.push({ projectId: ctx.projectId, mediaId, jobId, engine: subjects.engine });
      return { projectRev: commits.length };
    },
  };

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

  const build = () => createSubjectTools({ config, resources, assets, jobs, workspace: async () => ws, project, kernel, limits });
  let tools = build();

  let counter = 0;
  /** 把一份字节放进项目 `forProject` 的素材库并登记成素材 */
  async function addMedia({ id, name = 'clip.mp4', kind = 'video', bytes, forProject = projectId, extra = {} }) {
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
    projects.get(forProject).set(id, { id, name, kind, hash, size: buf.length, ext, ...extra });
    return { id, hash, size: buf.length };
  }

  const readConfigCalls = () => {
    const file = path.join(ws.dir(), 'stub-calls.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  async function dispose() {
    await tools.close('test-end').catch(() => {});
    await assets.close().catch(() => {});
    await jobs.close().catch(() => {});
    await resources.close().catch(() => {});
    authority.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (t) t.after(dispose);

  return {
    authority, resources, assets, ws, project, projects, commits, stores, context, grant, dir, dbPath, readConfigCalls, addMedia,
    get tools() { return tools; },
    get jobs() { return jobs; },
    setReadOnly(v) { denyWrite = v; },
    /** 模拟 Agent 服务重启:关掉工具与账本,在同一份 SQLite 与工作区上重开 */
    async restart() {
      await tools.close('restart');
      await jobs.close();
      jobs = openJobs();
      tools = build();
      return tools;
    },
    dispose,
  };
}

export const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
