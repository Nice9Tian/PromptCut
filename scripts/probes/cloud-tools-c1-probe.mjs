/**
 * C1(本机采集代下)的真东西探针:真 Python、真 yt-dlp、真的本机采集接口、真的上传队列、素材服务的真项目分库。
 *
 *   node scripts/probes/cloud-tools-c1-probe.mjs --setup   # 只准备依赖:把主工作区已装好的 yt_dlp 复制进 out/c1-collect/pylibs(只读来源,不联网、不 pip)
 *   node scripts/probes/cloud-tools-c1-probe.mjs           # 跑(缺依赖时说缺什么并退出码 1,不跳过)
 *
 * 跑之前设好 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE(运行授权夹具要用)。端口只用 28812～28822:
 * 假站 28812、素材服务 28813、桌面一侧的编辑器 28820(连同 28821、28822)。
 *
 * 验收(每条打一行 JSON `{ check, ok, detail }`,有一条不过退出码 1):
 *   R1  桌面一侧:真的编辑器进程(本 worktree 的 dev server)上,采集就绪(真 Python、真 yt-dlp)、本机有测试用的假登录态;
 *   R2  对照——云端匿名:不给委托口子,云端(真 Python、真 yt-dlp,隔离模式,经出网闸的代理)下到的是假站的**低画质**那一份
 *       (哈希与假站那一份逐字节相同),假站看到的请求不带任何 cookie;
 *   R3  委托:同一条链接,发起页是桌面版 → 由桌面一侧真的本机采集带着假登录态下载(假站看到带登录 cookie 的请求,给出**高画质**那一份),
 *       经真的上传队列传进素材服务里本项目的分库;云端向素材服务核实(哈希、大小对得上)后登记;登记的那一份的哈希就是高画质那一份;
 *       别的项目的票据在素材服务上取不到这份字节;
 *   R4  发起页是浏览器页面(没有本机采集):如实匿名,拿到的是低画质那一份,说明里写了原因;
 *   R5  `collect_login` / `collect_login_check` 走到桌面一侧真的接口(已登录,所以不弹任何窗口),云端只拿回「已登录」;
 *   R6  云端的日志、反向通道的请求记录、委托记录、作业表里查不到:假登录 cookie 的值、cookies 文件的路径、桌面一侧的数据目录与临时目录;
 *   R7  收尾:探针起的编辑器进程树按进程号结束,端口放回。
 *
 * 哪些是真的:
 *   - 假站是本机回环上的 HTTP 服务,带不带登录 cookie 给不同的真视频文件(`cloud-tools-c1-site.mjs`);
 *   - 桌面一侧是本 worktree 的 dev server:`/api/collect/*`(`server/vite-plugin-collect.ts`)起真的 `python -m promptcut_collect`(yt-dlp 的通用提取器),
 *     登录态是它数据目录里的 cookies 文件(`server/collect-cookies.mjs` 判定「已登录」),下载物经真的入库接口进本机内容库,
 *     再经真的上传队列(`/api/media/upload-queue/*`)用项目的写票据传到素材服务;
 *   - 素材服务是真的素材模块加真的项目分库(`createProjectAssetStores`,磁盘上的物理库),按项目的票据分权限;
 *   - 页面一侧执行请求的是 `src/ai/cloud/collectBridge.ts` 原样;云端是 `page-bridge.mjs`(带 C1 的扩展工具)、`collect-bridge.mjs`、
 *     `hosted-collect.mjs`(真的工作区、受限子进程、出网闸)、F0 的「项目素材」`verifyRef`,运行授权是真的 SQLite 账本。
 * 哪些不是产品接线(中央文件归最后的接线包,本包不许改,所以探针自己搭,不冒充):
 *   - 页面一侧的执行器跑在探针进程里(不是浏览器里的编辑器页面),它的「本机采集」「上传」两组接口是对上面那台真编辑器进程发真的 HTTP 请求,
 *     发的就是 `src/ai/collect.ts` 用的那几个接口;页面到 Agent 服务的事件流与交回是进程内直接调 `attach` / `acceptResult`(真 HTTP 在 W2 的探针里验过);
 *   - 「项目素材」到素材服务之间是一段受控的转接(核对逻辑照 `server/hosted/asset-run-access.mjs` 的 verifyRef 分支,读的是同一个物理库),没有 mTLS;
 *   - 登记进项目是探针里一个带版本号的小账本(产品里是宿主经文档服务带期望版本提交);
 *   - 假站不在 `server/collect-cookies.mjs` 的站点表里,所以探针把「这条链接属于哪个有登录支持的站点」换成「假站算 bilibili」(`loginSiteOf`,
 *     `collect-bridge.mjs` 留的口子);桌面一侧因此用的是 bilibili 那一格的登录态文件,里面另有一行假站认的 cookie;
 *   - 账号登录、委托票据、真模型不在本探针的范围里。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, startDesktop, killDesktop, portFree, createUi, sleep } from './cloud-agent-ui-lib.mjs';
import { startLoginSite, fakeLoginCookies, sha256 } from './cloud-tools-c1-site.mjs';
import { w2Fixture, projectId, conversationId } from '../../server/test/cloud-tools-w2-fixture.mjs';
import { compileAssetModules } from '../../server/test/fixtures/asset-project-service.mjs';
import { createProjectAssetStores } from '../../server/asset-store/project-stores.mjs';
import { createProjectAssetAccess } from '../../server/asset-store/project-access.mjs';
import { createProjectAssets } from '../../server/agent/service/project-assets.mjs';
import { createRunAssetClient } from '../../server/agent/service/run-asset-client.mjs';
import { createWorkspaces } from '../../server/agent/service/workspace.mjs';
import { createEgressGate } from '../../server/agent/service/egress.mjs';
import { createCollect, newCollectState } from '../../server/agent/service/hosted-collect.mjs';
import { createCollectBridge, collectPageTools, COLLECT_BRIDGE_TEXT } from '../../server/agent/service/collect-bridge.mjs';
import { resourceRevision, assetRefId } from '../../server/account/run-asset-protocol.mjs';
import { createCollectBridgePage } from '../../src/ai/cloud/collectBridge.ts';

const PORTS = { site: 28812, asset: 28813, editor: 28820 };
const MAIN = path.resolve(ROOT, '..', '..');
const DEPS = path.join(ROOT, 'out', 'c1-collect');
const PYLIBS = path.join(DEPS, 'pylibs');
const OUT = path.join(ROOT, 'out', 'c1-probe', `run-${Date.now()}`);
const OTHER = 'sp_other';
const { check, say, results } = createUi({ maxLine: 2400 });

const findPython = () => [process.env.PROMPTCUT_PYTHON, path.join(ROOT, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'), path.join(MAIN, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe')]
  .filter(Boolean).find((p) => fs.existsSync(p)) ?? null;
const findFfmpeg = () => {
  const out = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffmpeg'], { windowsHide: true, encoding: 'utf8' });
  return out.status === 0 ? out.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null : null;
};

function setup() {
  if (fs.existsSync(path.join(PYLIBS, 'yt_dlp'))) return true;
  const source = [path.join(ROOT, 'out', 'pylibs'), path.join(MAIN, 'out', 'pylibs')].find((d) => fs.existsSync(path.join(d, 'yt_dlp')));
  if (!source) return false;
  fs.mkdirSync(PYLIBS, { recursive: true });
  for (const name of fs.readdirSync(source).filter((n) => n === 'yt_dlp' || /^yt_dlp-.*\.dist-info$/.test(n))) fs.cpSync(path.join(source, name), path.join(PYLIBS, name), { recursive: true });
  return true;
}

let site; let assetServer; let desktop; let fixture; let collectBridge; let assets; const cleanups = [];

async function main() {
  const python = findPython();
  const ffmpeg = findFfmpeg();
  const missing = [!python && '内置 Python(PROMPTCUT_PYTHON 或主工作区 desktop/src-tauri/runtime/python)', !setup() && 'yt_dlp(主工作区 out/pylibs 里也没有)', !ffmpeg && 'PATH 上的 ffmpeg'].filter(Boolean);
  if (missing.length) { console.log(`FAIL  缺依赖:${missing.join(';')}`); process.exit(1); }
  if (process.argv.includes('--setup')) { console.log(`依赖齐了:python=${python} pylibs=${PYLIBS} ffmpeg=${ffmpeg}`); return; }
  for (const p of [PORTS.site, PORTS.asset, PORTS.editor, PORTS.editor + 1, PORTS.editor + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  fs.mkdirSync(OUT, { recursive: true });

  /* ---- 假站 */
  site = await startLoginSite({ port: PORTS.site, dir: path.join(OUT, 'site') });
  say('site', { url: site.url, sd: [site.sd.size, '320x180'], hd: [site.hd.size, '1280x720'] });

  /* ---- 素材服务:真的素材模块 + 真的项目分库;票据按项目分 */
  const assetOut = path.join(OUT, 'asset-service');
  fs.mkdirSync(assetOut, { recursive: true });
  const { asset, media } = await compileAssetModules(assetOut);
  const principals = new Map();
  for (const id of [projectId, OTHER]) for (const access of ['r', 'rw']) principals.set(`${id}-${access}`, { projectId: id, access, accountId: `u-${id}`, loginId: `l-${id}`, credentialId: `c-${id}`, authorizationId: `doc-opaque-${id}-${access}` });
  const projectAccess = createProjectAssetAccess({
    authority: {
      async checkAccess({ principal, projectId: target, action }) {
        const known = [...principals.values()].find((p) => p.authorizationId === principal?.authorizationId);
        return { allowed: !!known && known.projectId === target && principal.projectId === target && (action === 'read' || principal.access === 'rw'), accessRevision: 1, revocationSeq: 0 };
      },
      subscribeRevocations() { return () => {}; },
    },
    resolvePrincipal: async (req) => principals.get(/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]) ?? null,
  });
  const stores = createProjectAssetStores({ dir: path.join(assetOut, 'assets'), contentTypeForExt: media.contentTypeForExt });
  const opts = { projectStores: stores, projectAccess, pullArtifact: null, pxEvict: null };
  const assetMw = asset.assetServiceMiddleware(assetOut, opts);
  const uploads = [];
  assetServer = http.createServer((req, res) => {
    if (req.method === 'PUT' || req.method === 'POST') uploads.push({ method: req.method, url: req.url.split('?')[0], from: req.headers['user-agent'] ?? null });
    void assetMw(req, res, () => { res.statusCode = 404; res.end('no route'); });
  });
  await new Promise((resolve, reject) => { assetServer.once('error', reject); assetServer.listen(PORTS.asset, '127.0.0.1', resolve); });
  const assetBase = `http://127.0.0.1:${PORTS.asset}/api/asset`;
  const assetHead = (ticket, hash) => fetch(`${assetBase}/media/${hash}`, { method: 'HEAD', headers: { Authorization: `Bearer ${ticket}` } }).then((r) => r.status, () => 0);
  const assetGet = async (ticket, hash) => { const r = await fetch(`${assetBase}/media/${hash}`, { headers: { Authorization: `Bearer ${ticket}` } }); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; };

  /* ---- 桌面一侧:真的编辑器进程;数据目录里放测试用的假登录态 */
  const deskDir = path.join(OUT, 'desktop');
  fs.mkdirSync(path.join(deskDir, 'cookies'), { recursive: true });
  const cookiesFile = path.join(deskDir, 'cookies', 'bilibili.txt');
  fs.writeFileSync(cookiesFile, fakeLoginCookies(site.loginValue));
  desktop = await startDesktop({ port: PORTS.editor, dir: deskDir, env: { PROMPTCUT_PYTHON: python, PROMPTCUT_PYLIBS: PYLIBS, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  say('desktop', { origin: desktop.origin, pid: desktop.pid });
  const api = async (url, init = {}) => {
    const r = await fetch(`${desktop.origin}${url}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(60_000) });
    return r.json().catch(() => ({}));
  };
  const localCalls = [];
  /** 页面一侧的两组接口:对真编辑器进程发真的请求(与 `src/ai/collect.ts` 用的是同一组接口) */
  const local = {
    status: async () => { const s = await api('/api/collect/status'); localCalls.push('status'); return { ready: s.ready === true, raw: s }; },
    cookies: async () => { localCalls.push('cookies'); return (await api('/api/collect/cookies')).cookies ?? {}; },
    download: async (url, o) => { localCalls.push(['download', { ...o, cookies: o.cookies ? '(本机路径)' : undefined }]); const r = await api('/api/collect/download', { method: 'POST', body: JSON.stringify({ url, ...o }) }); if (!r.ok) throw new Error('download refused'); return { jobId: r.jobId }; },
    job: async (id) => { const r = await api(`/api/collect/job/${id}`); return r.ok ? r.job : null; },
    cancel: async (id) => { await api(`/api/collect/job/${id}`, { method: 'DELETE' }); },
    login: async (args) => { localCalls.push(['login', args]); return api('/api/collect/login', { method: 'POST', body: JSON.stringify({ site: args.site, force: args.force === true }) }); },
    loginCheck: async (args) => { localCalls.push(['loginCheck', args]); return api('/api/collect/login/check', { method: 'POST', body: JSON.stringify({ site: args.site, hide: args.hide !== false }) }); },
  };
  const upload = {
    projectId: () => projectId,
    push: async (items) => { const r = await api('/api/media/upload-queue/enqueue', { method: 'POST', body: JSON.stringify({ items: items.map((it) => ({ name: it.name, original: it.hash })) }) }); localCalls.push(['enqueue', { queued: (r.queued ?? []).length, deferred: (r.deferred ?? []).length, missing: (r.missing ?? []).length, bad: r.bad, local: r.local }]);
      // 视频入库时编辑器进程自己已经把它排进上传队列(先小尺寸后原尺寸),这里再交一次是幂等的:只要本机内容库里有、上传目标不是本机就算交了;传没传完看 stored()
      return r.ok === true && r.local !== true && !items.some((it) => (r.missing ?? []).includes(it.hash)); },
    stored: async (hash) => (await assetHead(`${projectId}-rw`, hash)) === 200,
  };
  // 上传目标:素材服务的地址与这个项目的写票据(产品里由账号会话签发、`assetTiers.ts` 的 startUploadTarget 推给编辑器进程)
  await api('/api/media/upload-queue/target', { method: 'POST', body: JSON.stringify({ base: assetBase, ticket: `${projectId}-rw` }) });

  const status = await local.status();
  const cookieView = await local.cookies();
  check('R1 桌面一侧的真编辑器进程:采集就绪(真 Python、真 yt-dlp),本机有测试用的假登录态', status.ready === true && status.raw.ytdlp?.installed === true && cookieView.bilibili?.loggedIn === true,
    { ready: status.ready, ytdlp: status.raw.ytdlp, ffmpeg: !!status.raw.ffmpeg, bilibili: { loggedIn: cookieView.bilibili?.loggedIn, expired: cookieView.bilibili?.expired } });

  /* ---- 云端:运行授权(真账本)、反向通道 + C1 的扩展工具、项目素材、委托、云端采集 */
  fixture = await w2Fixture({ after: (fn) => cleanups.push(fn) }, { limits: { pageMs: 15_000, attachMs: 3_000 } });
  const f = fixture;
  const logs = f.logs;
  const log = (event, fields) => logs.push({ event, ...fields });
  const bridge = f.openBridge({ extraTools: collectPageTools() });
  const handles = new Map(); const verifyCalls = [];
  const closedOf = (stream) => (stream.closed ? Promise.resolve() : new Promise((r) => stream.once('close', r)));
  const transport = {
    async issue({ context: ctx, selector }) {
      const stat = await stores.store(ctx.projectId, 'media').stat(selector.hash);
      const resource = { projectId: ctx.projectId, ns: 'media', hash: selector.hash, size: selector.size, ...(stat?.ext ? { ext: stat.ext } : {}), contentType: stat?.contentType ?? 'application/octet-stream' };
      const assetHandleId = `handle-${handles.size}`; handles.set(assetHandleId, resource);
      return { assetHandleId, resource, resourceRev: resourceRevision(resource), expiresAt: 1000, fenceRevision: 1, grantState: 'active' };
    },
    async request({ context: ctx, assetHandleId, url, body }) {
      const ref = handles.get(assetHandleId); let status = 200; let result;
      const parsed = JSON.parse(Buffer.from(body).toString('utf8'));
      const stat = await stores.store(ctx.projectId, 'media').stat(ref.hash);
      verifyCalls.push({ projectId: ctx.projectId, hash: ref.hash, size: ref.size, found: !!stat });
      if (!url.endsWith('/verify') || parsed.projectId !== ctx.projectId || parsed.hash !== ref.hash || parsed.size !== ref.size) { status = 403; result = 'asset-run-resource-mismatch'; }
      else if (!stat) { status = 404; result = 'asset-missing'; }
      else if (stat.size !== ref.size) { status = 409; result = 'asset-size-mismatch'; }
      else result = { assetRefId: assetRefId(ref), assetRef: ref, resourceRev: resourceRevision(ref) };
      const stream = Readable.from([Buffer.from(JSON.stringify(status < 400 ? { ok: true, result } : { ok: false, code: result }))]);
      return { status, headers: {}, stream, closed: closedOf(stream) };
    },
  };
  const workspaces = createWorkspaces({ dataDir: path.join(OUT, 'agent') });
  const workspace = workspaces.open({ projectId, ownerKey: 'c'.repeat(32), conversationId });
  assets = createProjectAssets({ contextAccess: f.resources.contextAccess, runAssetClient: createRunAssetClient({ transport, maxResponseBytes: 8192 }),
    resources: f.resources, workspace: async () => workspace, maxImportBytes: 64 * 1024 * 1024, reserveImport: async () => {} });
  const doc = { rev: 1, media: [], commits: [], byRequest: new Map() };
  const register = async (context, entry) => {
    const seen = doc.byRequest.get(entry.requestId); if (seen) return seen;
    await f.resources.authorize(context, 'write');
    const expectedRev = doc.rev; doc.rev += 1;
    const out = { mediaId: `m-${doc.media.length + 1}`, kind: entry.kind };
    doc.media.push({ ...out, hash: entry.assetRef.hash, size: entry.assetRef.size, name: entry.name, width: entry.width, height: entry.height, via: 'delegated' });
    doc.commits.push({ requestId: entry.requestId, expectedRev, rev: doc.rev });
    doc.byRequest.set(entry.requestId, out);
    return out;
  };
  collectBridge = createCollectBridge({ bridge, databasePath: path.join(OUT, 'collect-delegations.sqlite'), assets, authorize: (ctx, action) => f.resources.authorize(ctx, action), register, log,
    // 探针专用:假站不在站点表里,这里把它算作 bilibili 那一格(产品里缺省是 `collect-cookies.mjs` 的 `siteOfUrl`)
    loginSiteOf: (url) => (String(url).startsWith(site.origin) ? 'bilibili' : null) });
  const egress = createEgressGate({ testAllow: [`127.0.0.1:${PORTS.site}`] });
  const collector = createCollect({ config: { python, pythonPath: [path.join(ROOT, 'python'), PYLIBS].join(path.delimiter), ffmpegDir: path.dirname(ffmpeg) }, egress, limits: { watchMs: 200 }, log });
  const cloud = { delegate: null, imported: [], usage: [] };
  const tools = collector.forConversation({
    state: newCollectState(), workspace: () => workspace, conversationId, record: (row) => cloud.usage.push(row),
    ensureCanWrite: async () => { await f.resources.authorize(f.context, 'write'); },
    // 云端匿名下载的入库:字节进本项目的物理库,再登记(产品里是 import_media 的那条路)
    importFile: async (rel, name) => {
      const bytes = workspace.read(rel, { maxBytes: 64 * 1024 * 1024 }); const hash = sha256(bytes);
      const store = stores.store(projectId, 'media');
      if (!(await store.stat(hash))) { await store.putChunk(hash, 0, { size: bytes.length, ext: 'mp4' }, Readable.from([bytes])); await store.complete(hash); }
      doc.rev += 1; doc.media.push({ mediaId: `m-${doc.media.length + 1}`, kind: 'video', hash, size: bytes.length, name, via: 'anonymous' });
      cloud.imported.push({ hash, size: bytes.length });
      return { mediaId: doc.media.at(-1).mediaId, kind: 'video', bytes: bytes.length };
    },
    delegate: () => cloud.delegate,
  });
  const waitJob = async (jobId, ms = 180_000) => { const t0 = Date.now(); for (;;) { const job = await tools.collect_job({ jobId }); if (job.status !== 'running') return job; if (Date.now() - t0 > ms) throw new Error(`作业 ${jobId} 没有在时限内结束`); await sleep(300); } };
  const whichClip = (hash) => (hash === site.hd.hash ? '高画质(1280x720)' : hash === site.sd.hash ? '低画质(320x180)' : '别的');

  /* ---- R2 对照:云端匿名 */
  let mark = site.hits.length;
  const anon = await waitJob((await tools.collect_download({ url: site.url, quality: 1080 })).jobId);
  const anonHits = site.hits.slice(mark);
  check('R2 对照:云端匿名(真 Python、真 yt-dlp,经出网闸的代理)拿到的是低画质那一份,请求不带 cookie',
    anon.status === 'done' && anon.route === 'anonymous' && cloud.imported.at(-1)?.hash === site.sd.hash && anonHits.length > 0 && anonHits.every((h) => !h.hasCookie && h.served === 'sd'),
    { status: anon.status, route: anon.route, message: anon.message, got: whichClip(cloud.imported.at(-1)?.hash), bytes: cloud.imported.at(-1)?.size, siteSaw: anonHits.map((h) => `${h.method} cookie:${h.hasCookie} → ${h.served}`), usage: cloud.usage.map((u) => `${u.model}:${u.units}`) });

  /* ---- R3 委托:发起页是桌面版 */
  const answers = [];
  const attachPage = (executor) => bridge.attach({ identity: f.initiatorPage.identity, conversationId, pageId: f.initiatorPage.pageId, aclRevision: f.aclOf(conversationId),
    send: (event) => { void (async () => { const answer = await executor.run(event); if (!answer) return; answers.push({ tool: event.tool, answer }); await bridge.acceptResult({ identity: f.initiatorPage.identity, conversationId, body: answer }).catch((e) => answers.push({ tool: event.tool, refused: e?.code })); })(); } });
  const deskExecutor = createCollectBridgePage({ pageId: () => f.initiatorPage.pageId, local, upload, pollMs: 300 });
  let stream = attachPage(deskExecutor);
  cloud.delegate = collectBridge.forRun(f.context);
  mark = site.hits.length; const uploadsBefore = uploads.length; const verifyBefore = verifyCalls.length;
  const t0 = Date.now();
  const del = await waitJob((await tools.collect_download({ url: site.url, quality: 1080 })).jobId);
  const delHits = site.hits.slice(mark);
  const registered = doc.media.find((m) => m.via === 'delegated');
  const stored = registered ? await assetGet(`${projectId}-rw`, registered.hash) : null;
  const receipt = answers.find((a) => a.answer?.result?.state === 'done')?.answer.result.receipt ?? null;
  check('R3a 委托:桌面一侧真的本机采集带着假登录态下载,假站给的是高画质那一份',
    del.status === 'done' && del.route === 'delegated' && delHits.length > 0 && delHits.every((h) => h.loggedIn && h.served === 'hd'),
    { status: del.status, route: del.route, message: del.message, notes: del.notes, ms: Date.now() - t0, siteSaw: delHits.map((h) => `${h.method} 登录:${h.loggedIn} → ${h.served}`), localCalls: localCalls.filter((c) => Array.isArray(c)) });
  check('R3b 文件由桌面一侧的上传队列直接传进素材服务里本项目的分库:取回来的字节就是高画质那一份;别的项目的票据取不到',
    !!stored && sha256(stored) === site.hd.hash && stored.length === site.hd.size && (await assetHead(`${OTHER}-rw`, site.hd.hash)) === 404 && uploads.length > uploadsBefore,
    { storedBytes: stored?.length, storedIs: stored ? whichClip(sha256(stored)) : null, otherProjectStatus: await assetHead(`${OTHER}-rw`, site.hd.hash), uploadRequests: uploads.slice(uploadsBefore).map((u) => `${u.method} ${u.url.replace(/[0-9a-f]{64}/, '<hash>')}`) });
  check('R3c 云端只收到回执 { requestId, jobId, assetRef: { projectId, hash, size }, result },向素材服务核实后带期望版本登记;登记的就是高画质那一份',
    !!receipt && JSON.stringify(Object.keys(receipt)) === '["requestId","jobId","assetRef","result"]' && JSON.stringify(Object.keys(receipt.assetRef)) === '["projectId","hash","size"]' &&
    receipt.assetRef.projectId === projectId && receipt.assetRef.hash === site.hd.hash && receipt.assetRef.size === site.hd.size &&
    verifyCalls.slice(verifyBefore).some((v) => v.projectId === projectId && v.hash === site.hd.hash && v.size === site.hd.size && v.found) &&
    registered?.hash === site.hd.hash && registered.width === 1280 && registered.height === 720 && doc.commits.length === 1 && del.mediaIds?.[0] === registered.mediaId,
    { receipt, verify: verifyCalls.slice(verifyBefore), registered, commit: doc.commits[0], jobItems: del.items });

  /* ---- R4 发起页是浏览器页面(没有本机采集) */
  stream.detach();
  const webExecutor = createCollectBridgePage({ pageId: () => f.initiatorPage.pageId });
  stream = attachPage(webExecutor);
  mark = site.hits.length; const importedBefore = cloud.imported.length; const delegatedBefore = doc.media.filter((m) => m.via === 'delegated').length;
  const web = await waitJob((await tools.collect_download({ url: `${site.url}?web` })).jobId);
  const webHits = site.hits.slice(mark);
  check('R4 发起页是浏览器页面:如实匿名(低画质那一份),说明里写了原因,没有假装委托',
    web.status === 'done' && web.route === 'anonymous' && cloud.imported.length === importedBefore + 1 && cloud.imported.at(-1).hash === site.sd.hash &&
    webHits.every((h) => !h.hasCookie) && doc.media.filter((m) => m.via === 'delegated').length === delegatedBefore &&
    web.notes?.[0] === `${COLLECT_BRIDGE_TEXT.fallback['page-without-local-collect']}${COLLECT_BRIDGE_TEXT.fallbackTail}`,
    { status: web.status, route: web.route, got: whichClip(cloud.imported.at(-1)?.hash), notes: web.notes, siteSaw: webHits.map((h) => `cookie:${h.hasCookie} → ${h.served}`) });

  /* ---- R5 登录两件:走到桌面一侧真的接口(已登录,不弹窗) */
  stream.detach();
  stream = attachPage(deskExecutor);
  const loginOut = await tools.collect_login({});
  const checkOut = await tools.collect_login_check({});
  check('R5 collect_login / collect_login_check 在本人电脑上执行,云端只拿回「已登录」',
    loginOut.ok === true && loginOut.alreadyLoggedIn === true && checkOut.ok === true && checkOut.loggedIn === true &&
    JSON.stringify(Object.keys(checkOut).sort()) === '["hint","loggedIn","ok","onInitiatorComputer","site"]' && localCalls.some((c) => c[0] === 'login') && localCalls.some((c) => c[0] === 'loginCheck'),
    { loginOut, checkOut });

  /* ---- R6 云端查不到本机的东西 */
  const texts = [JSON.stringify(logs), JSON.stringify(cloud.usage), JSON.stringify(answers)];
  for (const [file, table] of [[f.dbPath, 'page_requests'], [path.join(OUT, 'collect-delegations.sqlite'), 'collect_delegations']]) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { texts.push(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())); } finally { db.close(); }
  }
  texts.push(workspace.read('collect/jobs.json').toString('utf8'));
  const cloudText = texts.join('\n');
  const esc = (s) => JSON.stringify(s).slice(1, -1);
  const forbidden = { 假登录cookie的值: site.loginValue, 假SESSDATA: 'FAKE-C1-SESSDATA', 假用户标识: 'FAKE-C1-USER', cookies文件路径: cookiesFile, 桌面数据目录: deskDir, cookie字样: 'cookie:' , Cookie头: 'Cookie' };
  const found = Object.entries(forbidden).filter(([, v]) => cloudText.includes(v) || cloudText.includes(esc(v)) || cloudText.includes(esc(esc(v)))).map(([k]) => k);
  const delegationRows = (() => { const db = new DatabaseSync(path.join(OUT, 'collect-delegations.sqlite'), { readOnly: true }); try { return db.prepare('SELECT job_id, site, state, reason, refs, media FROM collect_delegations ORDER BY created_at').all().map((r) => ({ ...r })); } finally { db.close(); } })();
  check('R6 云端的日志、请求记录、委托记录、作业表、页面交回的每一份答案里都查不到 cookie、cookies 文件路径、桌面的数据目录', found.length === 0,
    { found, scannedBytes: cloudText.length, delegations: delegationRows.map((r) => `${r.state}${r.reason ? `(${r.reason})` : ''} refs=${r.refs.replace(/[0-9a-f]{56}"/g, '…"')}`), delegateLogs: logs.filter((l) => l.event === 'agent.collect.delegate').map((l) => `${l.state}${l.why ? `:${l.why}` : ''}`) });
  stream.detach();
}

async function cleanup() {
  let killed = null;
  try { await collectBridge?.close('probe-end'); } catch { /* 收尾 */ }
  try { await assets?.close(); } catch { /* 收尾 */ }
  for (const fn of cleanups) { try { await fn(); } catch { /* 收尾 */ } }
  try { killed = await killDesktop(desktop); } catch (error) { killed = { error: String(error?.message ?? error) }; }
  try { await new Promise((resolve) => { assetServer?.closeAllConnections?.(); assetServer ? assetServer.close(() => resolve()) : resolve(); }); } catch { /* 收尾 */ }
  try { await site?.close(); } catch { /* 收尾 */ }
  await sleep(300);
  const free = await Promise.all([PORTS.site, PORTS.asset, PORTS.editor, PORTS.editor + 1, PORTS.editor + 2].map(portFree));
  if (desktop) check('R7 收尾:探针起的编辑器进程树按进程号结束,端口放回', killed?.gone !== false && free.every(Boolean), { pids: killed?.pids, gone: killed?.gone, portsFree: free });
}

let failed = false;
try { await main(); } catch (error) { failed = true; console.log(JSON.stringify({ check: '探针中途出错', ok: false, detail: String(error?.stack ?? error).slice(0, 1500), desktopLog: desktop?.log?.slice(-8) })); }
await cleanup();
const bad = results.filter((r) => !r.ok).map((r) => r.check);
console.log(JSON.stringify({ summary: true, total: results.length, passed: results.length - bad.length, failed: failed ? ['探针中途出错', ...bad] : bad }));
process.exit(failed || bad.length ? 1 : 0);
