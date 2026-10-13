// C1(本机采集代下)测试夹具。建在 W2 的夹具上(`cloud-tools-w2-fixture.mjs`,没有改它)。
// 真的:SQLite 账本上的运行授权与对话权限、文档服务的在场表、运行资源登记器、反向通道(带 C1 的扩展工具)与它的请求记录、
//       C1 的委托记录、F0 的「项目素材」(`createProjectAssets` + `createRunAssetClient`)、素材服务的项目分库(磁盘上的物理库,
//       `createProjectAssetStores`)、云端采集(`hosted-collect.mjs`)连同工作区、受限子进程、出网闸与它的代理、
//       页面一侧的执行器(`src/ai/cloud/collectBridge.ts` 原样载入)。
// 不假装的:页面到 Agent 服务是直接调 `attach` / `acceptResult`(没有 HTTP);「项目素材」到素材服务之间是一段受控的转接
//       (与 `project-assets-client.test.mjs` 同一种:核对逻辑照 `server/hosted/asset-run-access.mjs` 的 verifyRef 分支,没有 mTLS);
//       本机采集是内存里的替身(真 Python、真 yt-dlp 在探针里);登记进项目是夹具里一个带版本号的小账本(产品里是宿主经文档服务提交);
//       云端匿名下载用下载器替身(`scripts/probes/fixtures/cloud-collect/fake-collect.mjs`)。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { w2Fixture, projectId, conversationId, sleep, until } from './cloud-tools-w2-fixture.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createProjectAssets } from '../agent/service/project-assets.mjs';
import { createRunAssetClient } from '../agent/service/run-asset-client.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { createEgressGate } from '../agent/service/egress.mjs';
import { createCollect, newCollectState } from '../agent/service/hosted-collect.mjs';
import { createCollectBridge, collectPageTools } from '../agent/service/collect-bridge.mjs';
import { resourceRevision, assetRefId } from '../account/run-asset-protocol.mjs';
import { createCollectBridgePage } from '../../src/ai/cloud/collectBridge.ts';
import { ROOT } from './cloud-agent-kit.mjs';

export { projectId, conversationId, sleep, until };
export const OTHER_PROJECT = 'sp_other';
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FAKE_COLLECTOR = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'cloud-collect', 'fake-collect.mjs');
const OWNER = 'c'.repeat(32);
const CONTENT_TYPES = { mp4: 'video/mp4', m4a: 'audio/mp4', png: 'image/png' };

/**
 * 这些串只存在于「发起人的电脑」上(替身的本机采集里)。云端的日志、请求记录、委托记录、作业表里一处都不许出现。
 * 全是测试用的假值。
 */
export const LOCAL_ONLY = Object.freeze({
  cookie: 'SESSDATA=FAKE-C1-SESSION-0123456789',
  header: 'Cookie: FAKE-C1-HEADER-VALUE',
  cookiesPath: 'C:\\Users\\tester\\AppData\\Roaming\\PromptCut\\cookies\\bilibili.txt',
  profileDir: 'C:\\Users\\tester\\AppData\\Local\\PromptCut\\web-profile',
  filePath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\pc-collect-abc\\clip [login-1080].mp4',
  userId: 'FAKE-C1-USER-424242',
});

export class ToolError extends Error { constructor(message, extra = {}) { super(message); Object.assign(this, extra); } }

/** 「外部站点」替身:同一个端口在一个测试里可能被几份夹具用到,共用一个,最后一份收尾时关 */
const sharedSources = new Map();
async function sharedSource(port, anonymousBytes) {
  let entry = sharedSources.get(port);
  if (!entry) {
    entry = { users: 0, hits: [], bytes: anonymousBytes, server: null };
    entry.server = await listen(port, (req, res) => {
      entry.hits.push({ url: req.url, cookie: req.headers.cookie ?? null });
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(entry.bytes);
    });
    sharedSources.set(port, entry);
  }
  entry.users += 1;
  return { entry, async release() { entry.users -= 1; if (entry.users === 0) { sharedSources.delete(port); await entry.server.close(); } } };
}

function listen(port, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.initiator] 发消息的账号(缺省 sender;owner 是对话的主人)
 * @param {object} [options.limits] 反向通道的时限
 * @param {object} [options.collectLimits] 委托的时限(`collect-bridge.mjs`)
 * @param {boolean} [options.cloudCollector] 云端节点装没装采集工具(缺省装了:下载器替身)
 * @param {number} [options.sourcePort] 云端匿名下载的「外部站点」替身的端口(分给本包的端口段里)
 */
export async function c1Fixture(t, options = {}) {
  // W2 夹具的收尾(关库、删目录)要排在本夹具的收尾之后:先收它的钩子,最后一起按顺序跑
  const baseCleanups = [];
  const f = await w2Fixture({ after: (fn) => baseCleanups.push(fn) }, { ...options, limits: { pageMs: 2_000, attachMs: 150, ...options.limits } });
  const dir = f.authority.dir;
  const logs = f.logs;
  const log = (event, fields) => logs.push({ event, ...fields });

  // ---- 反向通道:同一个库上另开一份,带 C1 的五种请求
  const bridge = f.openBridge({ extraTools: collectPageTools(options.collectLimits) });

  // ---- 素材服务的项目分库(物理库)与「项目素材」
  const stores = createProjectAssetStores({ dir: path.join(dir, 'asset'), contentTypeForExt: (ext) => CONTENT_TYPES[ext] });
  const handles = new Map();
  const assetCalls = [];
  const closedOf = (stream) => (stream.closed ? Promise.resolve() : new Promise((r) => stream.once('close', r)));
  const transport = {
    async issue({ context: ctx, purpose, selector }) {
      if (purpose !== 'verifyRef') throw Object.assign(new Error('only verifyRef is wired in this fixture'), { status: 503 });
      const stat = await stores.store(ctx.projectId, 'media').stat(selector.hash);
      const resource = { projectId: ctx.projectId, ns: 'media', hash: selector.hash, size: selector.size,
        ...(stat?.ext ? { ext: stat.ext } : {}), contentType: stat?.contentType ?? 'application/octet-stream' };
      const assetHandleId = `handle-${handles.size}`;
      handles.set(assetHandleId, resource);
      return { assetHandleId, resource, resourceRev: resourceRevision(resource), expiresAt: 1000, fenceRevision: 1, grantState: 'active' };
    },
    async request({ context: ctx, assetHandleId, url, body }) {
      const ref = handles.get(assetHandleId);
      assetCalls.push({ projectId: ctx.projectId, hash: ref.hash, size: ref.size });
      let status = 200; let result;
      // 与 `server/hosted/asset-run-access.mjs` 的 verifyRef 分支同一组判断:只看这个项目自己的库
      const parsed = JSON.parse(Buffer.from(body).toString('utf8'));
      const stat = await stores.store(ctx.projectId, 'media').stat(ref.hash);
      if (!url.endsWith('/verify') || parsed.projectId !== ctx.projectId || parsed.hash !== ref.hash || parsed.size !== ref.size) { status = 403; result = 'asset-run-resource-mismatch'; }
      else if (!stat) { status = 404; result = 'asset-missing'; }
      else if (stat.size !== ref.size) { status = 409; result = 'asset-size-mismatch'; }
      else result = { assetRefId: assetRefId(ref), assetRef: ref, resourceRev: resourceRevision(ref) };
      const stream = Readable.from([Buffer.from(JSON.stringify(status < 400 ? { ok: true, result } : { ok: false, code: result }))]);
      return { status, headers: {}, stream, closed: closedOf(stream) };
    },
  };
  const workspaces = createWorkspaces({ dataDir: path.join(dir, 'agent') });
  const workspace = workspaces.open({ projectId, ownerKey: OWNER, conversationId });
  const assets = createProjectAssets({ contextAccess: f.resources.contextAccess, runAssetClient: createRunAssetClient({ transport, maxResponseBytes: 8192 }),
    resources: f.resources, workspace: async () => workspace, maxImportBytes: 64 * 1024 * 1024, reserveImport: async () => {} });

  /** 直接往一个项目的物理库里放一份字节(发起人的电脑上传、或测试里伪造「别的项目里有」) */
  async function putBytes(project, bytes, ext = 'mp4') {
    const hash = sha(bytes);
    const store = stores.store(project, 'media');
    await store.putChunk(hash, 0, { size: bytes.length, ext }, Readable.from([bytes]));
    await store.complete(hash);
    return { projectId: project, hash, size: bytes.length };
  }
  const has = async (project, hash) => !!(await stores.store(project, 'media').stat(hash));

  // ---- 登记进项目:一个带版本号的小账本(产品里是宿主经文档服务带期望版本提交)
  const doc = { rev: 7, media: [], commits: [], byRequest: new Map(), fail: null };
  const register = async (context, entry) => {
    const seen = doc.byRequest.get(entry.requestId);
    if (seen) return seen;
    if (doc.fail) { const error = doc.fail; doc.fail = null; throw error; }
    // 宿主自己也按当前这一轮核写权限(真的账本)
    await f.resources.authorize(context, 'write');
    const expectedRev = doc.rev;
    if (expectedRev !== doc.rev) throw Object.assign(new Error('stale'), { code: 'conflict' });
    doc.rev += 1;
    const out = { mediaId: `m-${doc.media.length + 1}`, kind: entry.kind, ...(entry.kind === 'video' ? { clipId: `c-${doc.media.length + 1}` } : {}) };
    doc.media.push({ ...out, hash: entry.assetRef.hash, size: entry.assetRef.size, name: entry.name, ext: entry.ext, sourceJobId: entry.sourceJobId });
    doc.commits.push({ requestId: entry.requestId, expectedRev, rev: doc.rev, by: context.runId });
    doc.byRequest.set(entry.requestId, out);
    return out;
  };

  // ---- 委托记录与委托逻辑
  const delegationsPath = path.join(dir, 'collect-delegations.sqlite');
  const openedCollect = [];
  const openCollectBridge = (overrides = {}) => {
    const cb = createCollectBridge({ bridge, databasePath: delegationsPath, assets, authorize: (ctx, action) => f.resources.authorize(ctx, action), register,
      loginSiteOf: (url) => (String(url).includes('/login-site/') || /^BV/.test(String(url)) ? 'bilibili' : null),
      limits: { pollMs: 25, offlineGraceMs: 400, ...options.collectLimits }, log, ...overrides });
    openedCollect.push(cb);
    return cb;
  };
  const collectBridge = openCollectBridge();

  // ---- 云端匿名下载:真的工作区、受限子进程、出网闸;下载器是替身;「外部站点」是本机回环上的替身
  const sourceServer = options.sourcePort ? await sharedSource(options.sourcePort, randomBytes(2048)) : null;
  const anonymousBytes = sourceServer?.entry.bytes ?? Buffer.alloc(0);
  const source = sourceServer?.entry ?? { hits: [] };
  const egress = createEgressGate({ testAllow: options.sourcePort ? [`127.0.0.1:${options.sourcePort}`] : [] });
  const collector = createCollect({
    config: options.cloudCollector === false ? null : { python: process.execPath, args: [FAKE_COLLECTOR], testRunner: true, pythonPath: path.join(ROOT, 'python') },
    egress, limits: { watchMs: 100 }, log,
  });
  const cloud = { state: newCollectState(), imported: [], usage: [], readOnly: false, delegate: () => collectBridge.forRun(f.context) };
  const openTools = (state = cloud.state) => collector.forConversation({
    state, workspace: () => workspace, ToolError, conversationId,
    ensureCanWrite: async () => { if (cloud.readOnly) throw new ToolError('你在这个项目里只有只读权限,云端 Agent 不能替你把素材写进项目。', { code: 'forbidden' }); },
    // 云端匿名下载的入库(产品里是 `import_media` 的那条路)
    importFile: async (rel, name) => { const bytes = workspace.read(rel); cloud.imported.push({ name, hash: sha(bytes), bytes: bytes.length }); return { mediaId: `anon-${cloud.imported.length}`, kind: 'video', bytes: bytes.length }; },
    record: (row) => cloud.usage.push(row),
    delegate: () => cloud.delegate?.() ?? null,
  });
  cloud.tools = openTools();
  cloud.reopen = () => { cloud.state = newCollectState(); cloud.tools = openTools(cloud.state); return cloud.tools; };

  /**
   * 「发起人的电脑」:本机采集的替身 + 上传进素材服务的项目分库 + 页面一侧真的执行器。
   * `desk.hold` 设成一个工具名时,那种请求的答案先扣着(`desk.held`),测试自己决定什么时候交回、交回什么。
   */
  function desktop(page, { web = false, project = projectId, bytes = randomBytes(4096) } = {}) {
    const desk = {
      page, bytes, hash: sha(bytes), ready: true, loggedIn: true, expired: false,
      downloadGate: Promise.resolve(), downloadFails: false, uploadFails: false, uploadGate: Promise.resolve(), uploadTo: project,
      jobs: new Map(), downloads: [], cancelled: [], loginCalls: [], checkCalls: [], posted: [], held: [], hold: null, received: [],
    };
    const local = {
      status: async () => ({ ready: desk.ready, python: true, ffmpeg: 'C:\\tools\\ffmpeg.exe' }),
      cookies: async () => ({ bilibili: { name: '哔哩哔哩', loggedIn: desk.loggedIn, expired: desk.expired, userId: LOCAL_ONLY.userId, path: LOCAL_ONLY.cookiesPath } }),
      download: async (url, opts) => {
        const jobId = `local-${desk.downloads.length + 1}`;
        desk.downloads.push({ url, opts });
        const job = { id: jobId, status: 'running', stage: 'video', percent: 10, cookiesUsed: true, items: [], stderrTail: [LOCAL_ONLY.header, LOCAL_ONLY.filePath] };
        desk.jobs.set(jobId, job);
        void (async () => {
          await desk.downloadGate;
          if (job.status !== 'running') return;
          if (desk.downloadFails) { job.status = 'error'; job.message = `下载失败 ${LOCAL_ONLY.filePath} ${LOCAL_ONLY.cookie}`; return; }
          // 本机入库回来的那一条里有本机路径,页面不许往云端带
          job.items = [{ filename: LOCAL_ONLY.filePath, path: LOCAL_ONLY.filePath, url: `/@media/${desk.hash}`, hash: desk.hash, bytes: bytes.length,
            title: '登录后才有的 1080p', duration: 12.5, width: 1920, height: 1080, vcodec: 'h264', media: { path: LOCAL_ONLY.filePath } }];
          job.status = 'done'; job.stage = 'done'; job.percent = 100;
        })();
        return { jobId };
      },
      job: async (jobId) => desk.jobs.get(jobId) ?? null,
      cancel: async (jobId) => { desk.cancelled.push(jobId); const job = desk.jobs.get(jobId); if (job?.status === 'running') { job.status = 'error'; job.message = '已取消'; } },
      login: async (args) => { desk.loginCalls.push(args); return desk.loggedIn && !args.force ? { ok: true, alreadyLoggedIn: true, userId: LOCAL_ONLY.userId, expiresAt: '2027-01-01T00:00:00.000Z' } : { ok: true, visible: true, shell: true, loginUrl: 'https://passport.bilibili.com/login' }; },
      loginCheck: async (args) => { desk.checkCalls.push(args); return desk.loggedIn ? { ok: true, loggedIn: true, userId: LOCAL_ONLY.userId, path: LOCAL_ONLY.cookiesPath, count: 9 } : { ok: true, loggedIn: false, expired: desk.expired, missing: ['SESSDATA'], hint: '还没有登录态' }; },
    };
    const upload = {
      projectId: () => project,
      push: async () => {
        if (desk.uploadFails) return false;
        void (async () => { await desk.uploadGate; await putBytes(desk.uploadTo, bytes); })();
        return true;
      },
      stored: (hash) => has(desk.uploadTo, hash),
    };
    desk.executor = createCollectBridgePage({ pageId: () => page.pageId, ...(web ? {} : { local, upload }), pollMs: 10, uploadMs: options.uploadMs ?? 5_000, downloadMs: options.localDownloadMs ?? 5_000 });
    desk.post = async (answer, { as = page.identity, conversation = conversationId } = {}) => {
      try { const out = await bridge.acceptResult({ identity: as, conversationId: conversation, body: answer }); desk.posted.push({ tool: answer.tool, id: answer.id, ok: true, out }); return out; }
      catch (error) { desk.posted.push({ id: answer.id, ok: false, code: error?.code, status: error?.status }); throw error; }
    };
    desk.attach = (overrides = {}) => {
      page.stream = bridge.attach({ identity: page.identity, conversationId, pageId: page.pageId, aclRevision: f.aclOf(conversationId), ...overrides,
        send: (event) => {
          page.events.push(event);
          desk.received.push(event.tool);
          void (async () => {
            const answer = await desk.executor.run(event);
            if (!answer) return;
            const isDone = answer.result?.state === 'done';
            if (desk.hold && (desk.hold === event.tool || (desk.hold === 'receipt' && isDone))) { desk.held.push({ event, answer }); return; }
            await desk.post(answer).catch(() => {});
          })();
        } });
      return page.stream;
    };
    return desk;
  }

  t.after(async () => {
    cloud.tools.stopAll();
    for (const each of openedCollect) await each.close('test-end').catch(() => {});
    await assets.close().catch(() => {});
    await sourceServer?.release();
    await sleep(50);
    for (const cleanup of baseCleanups) await cleanup();
  });

  const waitJob = async (jobId, ms = 20_000, tools = cloud.tools) => {
    const t0 = Date.now();
    for (;;) {
      const job = await tools.collect_job({ jobId });
      if (job.status !== 'running') return job;
      if (Date.now() - t0 > ms) throw new Error(`job ${jobId} did not finish in time`);
      await sleep(20);
    }
  };
  const delegationRows = () => {
    const db = new DatabaseSync(delegationsPath, { readOnly: true });
    try { return db.prepare('SELECT * FROM collect_delegations ORDER BY created_at, delegation_id').all().map((r) => ({ ...r })); } finally { db.close(); }
  };
  /** 云端落盘与日志里的全部文字:两个 SQLite 库的每一行、作业表文件、日志 */
  const cloudText = () => {
    const parts = [JSON.stringify(logs), JSON.stringify(delegationRows()), JSON.stringify(cloud.usage)];
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try { parts.push(JSON.stringify(db.prepare('SELECT * FROM page_requests').all())); } finally { db.close(); }
    try { parts.push(workspace.read('collect/jobs.json').toString('utf8')); } catch { /* 还没有作业 */ }
    return parts.join('\n');
  };

  return Object.assign(f, {
    bridge, collectBridge, openCollectBridge, stores, assets, assetCalls, putBytes, has, doc, cloud, desktop, waitJob, delegationRows, cloudText,
    workspace, source, anonymousBytes, delegationsPath,
    loginUrl: 'https://example.com/login-site/watch?v=1',
    anonymousUrl: options.sourcePort ? `http://127.0.0.1:${options.sourcePort}/clip.mp4` : null,
    loginSiteUrl: options.sourcePort ? `http://127.0.0.1:${options.sourcePort}/login-site/clip.mp4` : null,
  });
}
