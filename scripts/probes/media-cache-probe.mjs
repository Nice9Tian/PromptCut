/**
 * 舞台素材长期缓存与跨项目路径号隔离的真实无头 Chrome 探针。
 *
 * 用途：
 *   在真实无头 Chrome 中证明：
 *   1. 舞台通过 `/media-s/<sid>/media/<hash>` 读取的素材字节带长期缓存头
 *      `Cache-Control: private, max-age=31536000, immutable` 与 `Vary: Authorization`；
 *   2. 同一浏览器配置目录（userDataDir）重启后的第二次会话中，编辑器页从 `localStorage`
 *      取出同一个 `<sid>`，舞台再次请求 `/media-s/<sid>/media/<hash>` 时直接命中浏览器缓存，
 *      素材服务收到 0 次无 `t` 的 `GET /api/asset/media/<hash>` 请求；
 *   3. 编辑器页通过旧路由 `/media/api/asset/media/<hash>?t=<ticket>` 发起的每次请求均带
 *      `Cache-Control: no-store`，且每次都回源到达素材服务（两次会话共 4 次，每会话精确 +2）；
 *   4. 同一账号下的另一项目 B 拿到不同的 `<sid>`，通过 B 的 `<sid>` 请求项目 A 的素材哈希时
 *      不会命中项目 A 的浏览器缓存，而是回源到素材服务并得到 404。
 *
 * 运行方式：
 *   node scripts/probes/media-cache-probe.mjs [--keep]
 *
 * 端口（仅使用 6420–6429 端口段，仅绑定 127.0.0.1；若端口被占用则打印并退出 1，绝不杀进程）：
 *   - 6420：素材服务（项目授权模式 projectAccess）
 *   - 6421：编辑器页源反代（http://pc.localhost:6421）
 *   - 6422：舞台源反代（http://s1.pc.localhost:6422）
 *
 * 验收判据（每项输出一行 PASS 或 FAIL，全部通过时末行输出 `media-cache-probe: PASS`，任一失败退出码为 1）：
 *   - 会话 1：票据交接 `_grant` 成功；舞台拉取状态码 200、SHA-256 一致、
 *     `Cache-Control` 精确为 `'private, max-age=31536000, immutable'`、`Vary` 为 `'Authorization'`；
 *     素材服务收到至少 1 次不带 `t` 的 `GET /api/asset/media/<hash>`。
 *   - 会话 2：`sid` 与会话 1 的 `sid` 相同（由编辑器页 `localStorage` 持久化）；
 *     舞台拉取状态码 200、SHA-256 一致；会话 2 期间素材服务收到 0 次不带 `t` 的
 *     `GET /api/asset/media/<hash>`；打印 ResourceTiming `transferSize`（若有条目则校验为 0）。
 *   - `?t=` 路由：两轮会话各发起 2 次（共 4 次）带 `?t=` 的同源拉取，每次均到达素材服务
 *     （每轮会话带 `t` 的 `GET` 计数精确增加 2）且响应 `Cache-Control` 为 `'no-store'`。
 *   - 项目 B：项目 B 的 `sid` 与项目 A 不同；舞台经项目 B 的 `sid` 拉取项目 A 的素材哈希返回 404，
 *     且请求到达素材服务（跨项目不命中缓存）。
 */
import '../lib/no-user-dirs.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { compileAssetModules } from '../../server/test/fixtures/asset-project-service.mjs';
import { createProjectAssetStores } from '../../server/asset-store/project-stores.mjs';
import { createProjectAssetAccess } from '../../server/asset-store/project-access.mjs';
import { mediaSRoute } from '../../src/online/stagePolicy.mjs';

setTimeout(() => {
  console.error('SCRIPT_TIMEOUT');
  process.exit(124);
}, 180000).unref();

const KEEP = process.argv.includes('--keep');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PORT_ASSET = 6420;
const PORT_EDITOR = 6421;
const PORT_STAGE = 6422;
const EDITOR_ORIGIN = `http://pc.localhost:${PORT_EDITOR}`;
const STAGE_ORIGIN = `http://s1.pc.localhost:${PORT_STAGE}`;
const EXPECTED_LONG_CACHE = 'private, max-age=31536000, immutable';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 检查 127.0.0.1 上指定端口是否空闲（不杀任何进程） */
function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/** 启动绑定在 127.0.0.1 上的 HTTP 服务 */
function listenLocal(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** 关闭 HTTP 服务并断开空闲连接 */
function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** 用 rolldown 将真实的 src/online/stageIsolation.ts 打包为浏览器 IIFE（全局名 PCStageIso） */
async function buildStageIsoBundle(outDir) {
  const file = path.join(outDir, 'stage-iso.js');
  const { build } = await import('rolldown');
  await build({
    cwd: ROOT,
    input: path.join(ROOT, 'src/online/stageIsolation.ts'),
    output: { format: 'iife', name: 'PCStageIso', file },
    write: true,
    logLevel: 'silent',
  });
  return fs.readFileSync(file, 'utf8');
}

const PASSTHROUGH_HEADERS = [
  'cache-control',
  'vary',
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'referrer-policy',
];

function forwardToAsset(req, res, upstreamPath, extraHeaders = null) {
  const headers = { ...req.headers, host: `127.0.0.1:${PORT_ASSET}` };
  delete headers.cookie;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const up = http.request(
    {
      host: '127.0.0.1',
      port: PORT_ASSET,
      method: req.method,
      path: upstreamPath,
      headers,
    },
    (upRes) => {
      const outHeaders = {};
      for (const h of PASSTHROUGH_HEADERS) {
        if (upRes.headers[h] !== undefined) outHeaders[h] = upRes.headers[h];
      }
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad gateway');
    } else {
      res.destroy();
    }
  });
  req.pipe(up);
}

const EDITOR_HTML = `<!doctype html>
<meta charset="utf-8">
<title>editor-probe</title>
<body>
<script src="/stage-iso.js"></script>
<script>
(async () => {
  const q = new URLSearchParams(location.search);
  const accountId = q.get('account') || '';
  const projectId = q.get('project') || '';
  const ticket = q.get('ticket') || '';
  const hash = q.get('hash') || '';
  const doQuery = q.get('doQuery') !== '0';
  const stageOrigin = '${STAGE_ORIGIN}';

  try {
    const store = PCStageIso.createStageSidStore();
    const sid = store.sidFor({ accountId, projectId });
    const grantOk = await PCStageIso.grantMediaCookie(stageOrigin, sid, ticket);

    const stageResult = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stage-timeout')), 30000);
      const iframe = document.createElement('iframe');
      const onMsg = (ev) => {
        if (ev.origin !== stageOrigin) return;
        const data = ev.data || {};
        if (data.kind === 'stage-ready') {
          iframe.contentWindow.postMessage({ kind: 'fetch-media', sid, hash }, stageOrigin);
        } else if (data.kind === 'media-result') {
          window.removeEventListener('message', onMsg);
          clearTimeout(timer);
          resolve(data);
        }
      };
      window.addEventListener('message', onMsg);
      iframe.src = stageOrigin + '/stage';
      document.body.appendChild(iframe);
    });

    const queryFetches = [];
    if (doQuery) {
      for (let i = 0; i < 2; i++) {
        const r = await fetch('/media/api/asset/media/' + hash + '?t=' + encodeURIComponent(ticket));
        const buf = await r.arrayBuffer();
        queryFetches.push({
          status: r.status,
          cacheControl: r.headers.get('cache-control'),
          referrerPolicy: r.headers.get('referrer-policy'),
          byteLength: buf.byteLength,
        });
      }
    }

    window.__probeResult = {
      done: true,
      ok: true,
      accountId,
      projectId,
      sid,
      grantOk,
      stage: stageResult,
      queryFetches,
    };
  } catch (err) {
    window.__probeResult = {
      done: true,
      ok: false,
      error: String((err && err.message) || err),
    };
  }
})();
</script>
</body>
`;

const STAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>stage-probe</title>
<body>
<script>
const EDITOR_ORIGIN = '${EDITOR_ORIGIN}';

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

window.addEventListener('message', async (ev) => {
  if (ev.origin !== EDITOR_ORIGIN) return;
  const msg = ev.data || {};
  if (msg.kind !== 'fetch-media') return;
  const relUrl = '/media-s/' + msg.sid + '/media/' + msg.hash;
  const absUrl = new URL(relUrl, location.origin).href;
  try {
    performance.clearResourceTimings();
    const res = await fetch(relUrl);
    const buf = await res.arrayBuffer();
    const sha256 = res.status === 200 ? await sha256Hex(buf) : null;
    await new Promise((r) => setTimeout(r, 30));
    const entries = performance.getEntriesByName(absUrl);
    const entry = entries[0] || null;
    const transferSize = entry && typeof entry.transferSize === 'number' ? entry.transferSize : null;
    parent.postMessage({
      kind: 'media-result',
      ok: true,
      status: res.status,
      byteLength: buf.byteLength,
      sha256,
      cacheControl: res.headers.get('cache-control'),
      vary: res.headers.get('vary'),
      transferSize,
      hasPerfEntry: !!entry,
    }, EDITOR_ORIGIN);
  } catch (err) {
    parent.postMessage({
      kind: 'media-result',
      ok: false,
      error: String((err && err.message) || err),
    }, EDITOR_ORIGIN);
  }
});

parent.postMessage({ kind: 'stage-ready' }, EDITOR_ORIGIN);
</script>
</body>
`;

async function launchProbeBrowser(userDataDir) {
  return puppeteer.launch({
    headless: true,
    userDataDir,
    protocolTimeout: 120000,
    args: [
      ...PROBE_CHROME_ARGS,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--host-resolver-rules=MAP *.localhost 127.0.0.1',
      `--unsafely-treat-insecure-origin-as-secure=${EDITOR_ORIGIN},${STAGE_ORIGIN}`,
    ],
  });
}

async function runEditorFlow(browser, { accountId, projectId, ticket, hash, doQuery }) {
  const page = await browser.newPage();
  try {
    const u = new URL('/editor', EDITOR_ORIGIN);
    u.searchParams.set('account', accountId);
    u.searchParams.set('project', projectId);
    u.searchParams.set('ticket', ticket);
    u.searchParams.set('hash', hash);
    u.searchParams.set('doQuery', doQuery ? '1' : '0');
    await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__probeResult && window.__probeResult.done === true, { timeout: 60000 });
    return await page.evaluate(() => window.__probeResult);
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  for (const port of [PORT_ASSET, PORT_EDITOR, PORT_STAGE]) {
    const free = await checkPortFree(port);
    if (!free) {
      console.error(`PORT_BUSY: 127.0.0.1:${port} 已被占用`);
      process.exit(1);
    }
  }

  let dataDir = null;
  let profileDir = null;
  let assetServer = null;
  let editorServer = null;
  let stageServer = null;
  let browser = null;

  let failed = 0;
  const check = (name, cond, detail = '') => {
    const tag = cond ? 'PASS' : 'FAIL';
    console.log(`${tag} ${name}${detail ? ` (${detail})` : ''}`);
    if (!cond) failed++;
    return !!cond;
  };

  try {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-media-cache-probe-data-'));
    profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-media-cache-probe-profile-'));

    // 1. 启动项目授权模式的素材服务（端口 6420）
    const { asset, media } = await compileAssetModules(dataDir);
    const ticketA = crypto.randomBytes(32).toString('base64url');
    const ticketB = crypto.randomBytes(32).toString('base64url');
    const principals = new Map([
      [ticketA, { projectId: 'proj-A', access: 'rw', accountId: 'acct-1', loginId: 'l-A', credentialId: 'c-A', authorizationId: 'auth-A' }],
      [ticketB, { projectId: 'proj-B', access: 'rw', accountId: 'acct-1', loginId: 'l-B', credentialId: 'c-B', authorizationId: 'auth-B' }],
    ]);
    const authority = {
      async checkAccess({ principal, projectId, action }) {
        const ok = !!principal && principal.projectId === projectId && (action === 'read' || principal.access === 'rw');
        return { allowed: ok, accessRevision: 1, revocationSeq: 0 };
      },
      subscribeRevocations() {
        return () => {};
      },
    };
    const projectAccess = createProjectAssetAccess({
      authority,
      resolvePrincipal: async (req) => {
        const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
        const query = new URL(req.url, 'http://127.0.0.1').searchParams.get('t');
        return principals.get(bearer ?? query) ?? null;
      },
    });
    const projectStores = createProjectAssetStores({
      dir: path.join(dataDir, 'assets'),
      contentTypeForExt: media.contentTypeForExt,
    });
    const assetMiddleware = asset.assetServiceMiddleware(dataDir, {
      projectStores,
      projectAccess,
      pullArtifact: null,
      pxEvict: null,
    });

    // 统计到达素材服务的请求（按 method + pathname + 是否带 t 查询参数计数，绝不打印票据）
    const assetCounts = new Map();
    const countKey = (method, pathname, hasT) => `${String(method || 'GET').toUpperCase()} ${pathname} ${hasT ? 't=1' : 't=0'}`;
    const getCount = (method, pathname, hasT) => assetCounts.get(countKey(method, pathname, hasT)) ?? 0;

    assetServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const k = countKey(req.method, u.pathname, u.searchParams.has('t'));
      assetCounts.set(k, (assetCounts.get(k) ?? 0) + 1);
      void assetMiddleware(req, res, () => {
        res.statusCode = 404;
        res.end('no route');
      });
    });
    await listenLocal(assetServer, PORT_ASSET);

    // 上传一份 256 KiB 随机字节的媒体素材到项目 A（ext: bin）
    const mediaBytes = crypto.randomBytes(256 * 1024);
    const mediaHash = crypto.createHash('sha256').update(mediaBytes).digest('hex');
    const mediaApiPath = `/api/asset/media/${mediaHash}`;
    const assetBase = `http://127.0.0.1:${PORT_ASSET}`;

    const putRes = await fetch(`${assetBase}${mediaApiPath}/0`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ticketA}`,
        'X-Media-Size': String(mediaBytes.length),
        'X-Media-Ext': 'bin',
      },
      body: mediaBytes,
    });
    const completeRes = await fetch(`${assetBase}${mediaApiPath}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ticketA}` },
    });
    if (putRes.status !== 200 || completeRes.status !== 200) {
      throw new Error(`上传测试素材失败: put=${putRes.status}, complete=${completeRes.status}`);
    }

    // 2. 打包真实的 src/online/stageIsolation.ts 并启动本地反代（6421 编辑器源、6422 舞台源）
    const stageIsoBundle = await buildStageIsoBundle(dataDir);

    editorServer = http.createServer((req, res) => {
      const u = new URL(req.url, EDITOR_ORIGIN);
      if (u.pathname === '/stage-iso.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(stageIsoBundle);
        return;
      }
      if (u.pathname === '/editor') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(EDITOR_HTML);
        return;
      }
      if (u.pathname === '/media' || u.pathname.startsWith('/media/')) {
        const upstreamPath = (u.pathname.slice('/media'.length) || '/') + u.search;
        forwardToAsset(req, res, upstreamPath);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    await listenLocal(editorServer, PORT_EDITOR);

    stageServer = http.createServer((req, res) => {
      const u = new URL(req.url, STAGE_ORIGIN);
      if (u.pathname === '/stage') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(STAGE_HTML);
        return;
      }
      if (u.pathname.startsWith('/media-s/')) {
        const route = mediaSRoute(
          {
            method: req.method,
            pathname: u.pathname,
            origin: req.headers.origin ?? null,
            authorization: req.headers.authorization ?? null,
            cookie: req.headers.cookie ?? null,
          },
          { editorOrigin: EDITOR_ORIGIN, secure: false },
        );
        if (route.kind === 'preflight' || route.kind === 'grant') {
          res.writeHead(204, route.headers);
          res.end();
          return;
        }
        if (route.kind === 'reject') {
          res.writeHead(route.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('rejected');
          return;
        }
        if (route.kind === 'proxy') {
          forwardToAsset(req, res, route.path, { authorization: route.authorization });
          return;
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    await listenLocal(stageServer, PORT_STAGE);

    // 3. 会话 1：启动无头 Chrome，打开账号 acct-1 / 项目 A 的编辑器页
    const s1BeforeNoT = getCount('GET', mediaApiPath, false);
    const s1BeforeWithT = getCount('GET', mediaApiPath, true);

    browser = await launchProbeBrowser(profileDir);
    const s1 = await runEditorFlow(browser, {
      accountId: 'acct-1',
      projectId: 'proj-A',
      ticket: ticketA,
      hash: mediaHash,
      doQuery: true,
    });
    await sleep(1500);
    await browser.close();
    browser = null;

    const s1AfterNoT = getCount('GET', mediaApiPath, false);
    const s1AfterWithT = getCount('GET', mediaApiPath, true);
    const s1NoTDelta = s1AfterNoT - s1BeforeNoT;
    const s1WithTDelta = s1AfterWithT - s1BeforeWithT;

    check('session1: grantMediaCookie succeeded', s1?.grantOk === true, `sid=${s1?.sid}`);
    check(
      'session1: stage fetch status 200 and SHA-256 matches',
      s1?.stage?.status === 200 && s1?.stage?.sha256 === mediaHash,
      `status=${s1?.stage?.status}, bytes=${s1?.stage?.byteLength}`,
    );
    check(
      'session1: stage response Cache-Control is long-cache immutable',
      s1?.stage?.cacheControl === EXPECTED_LONG_CACHE,
      `cache-control=${JSON.stringify(s1?.stage?.cacheControl)}`,
    );
    check(
      'session1: stage response Vary is Authorization',
      s1?.stage?.vary === 'Authorization',
      `vary=${JSON.stringify(s1?.stage?.vary)}`,
    );
    check(
      'session1: asset service saw >= 1 GET without t',
      s1NoTDelta >= 1,
      `delta=${s1NoTDelta}`,
    );

    // 4. 会话 2：使用同一个 userDataDir 再次启动 Chrome，先跑项目 A，再跑项目 B
    const s2BeforeNoT = getCount('GET', mediaApiPath, false);
    const s2BeforeWithT = getCount('GET', mediaApiPath, true);

    browser = await launchProbeBrowser(profileDir);
    const s2A = await runEditorFlow(browser, {
      accountId: 'acct-1',
      projectId: 'proj-A',
      ticket: ticketA,
      hash: mediaHash,
      doQuery: true,
    });

    const s2AfterANoT = getCount('GET', mediaApiPath, false);
    const s2AfterAWithT = getCount('GET', mediaApiPath, true);
    const s2ANoTDelta = s2AfterANoT - s2BeforeNoT;
    const s2WithTDelta = s2AfterAWithT - s2BeforeWithT;

    check(
      'session2: sid equals session 1 sid (persisted in editor localStorage)',
      typeof s1?.sid === 'string' && s2A?.sid === s1?.sid,
      `s1=${s1?.sid}, s2=${s2A?.sid}`,
    );
    check(
      'session2: stage fetch status 200 and SHA-256 matches',
      s2A?.stage?.status === 200 && s2A?.stage?.sha256 === mediaHash,
      `status=${s2A?.stage?.status}, bytes=${s2A?.stage?.byteLength}`,
    );
    check(
      'session2: asset service saw 0 GET requests without t (served from browser cache)',
      s2ANoTDelta === 0,
      `before=${s2BeforeNoT}, after=${s2AfterANoT}, delta=${s2ANoTDelta}`,
    );
    console.log(`INFO session2 stage transferSize=${s2A?.stage?.transferSize} (hasPerfEntry=${s2A?.stage?.hasPerfEntry})`);
    if (s2A?.stage?.hasPerfEntry && typeof s2A?.stage?.transferSize === 'number') {
      check(
        'session2: ResourceTiming transferSize is 0',
        s2A.stage.transferSize === 0,
        `transferSize=${s2A.stage.transferSize}`,
      );
    }

    // 5. 核查 ?t= 路由：每轮会话 2 次（共 4 次）均到达素材服务且返回 Cache-Control: no-store
    const allQueryFetches = [...(s1?.queryFetches ?? []), ...(s2A?.queryFetches ?? [])];
    const queryNoStoreOk =
      allQueryFetches.length === 4 &&
      allQueryFetches.every((f) => f.status === 200 && f.cacheControl === 'no-store' && f.byteLength === mediaBytes.length);
    check(
      'query-ticket route: GET with t count increased by exactly 2 in session 1 and 2 in session 2',
      s1WithTDelta === 2 && s2WithTDelta === 2,
      `s1Delta=${s1WithTDelta}, s2Delta=${s2WithTDelta}`,
    );
    check(
      'query-ticket route: all 4 fetches returned status 200 and Cache-Control: no-store',
      queryNoStoreOk,
      `fetches=${JSON.stringify(allQueryFetches.map((f) => ({ status: f.status, cc: f.cacheControl })))}`,
    );

    // 6. 会话 2 内打开同账号下的项目 B：sid 不同，且经 B 的 sid 拉取 A 的素材哈希回源返回 404
    const bBeforeNoT = getCount('GET', mediaApiPath, false);
    const s2B = await runEditorFlow(browser, {
      accountId: 'acct-1',
      projectId: 'proj-B',
      ticket: ticketB,
      hash: mediaHash,
      doQuery: false,
    });
    const bAfterNoT = getCount('GET', mediaApiPath, false);
    const bNoTDelta = bAfterNoT - bBeforeNoT;

    check(
      'project B: sid differs from project A sid',
      typeof s2B?.sid === 'string' && s2B.sid.length === 32 && s2B.sid !== s1?.sid,
      `sidA=${s1?.sid}, sidB=${s2B?.sid}`,
    );
    check(
      'project B: stage fetch of project A hash through B sid returns 404 and reached asset service',
      s2B?.grantOk === true && s2B?.stage?.status === 404 && bNoTDelta >= 1,
      `grantOk=${s2B?.grantOk}, status=${s2B?.stage?.status}, assetDelta=${bNoTDelta}`,
    );
  } catch (err) {
    console.error('FAIL unexpected error:', err?.stack || err);
    failed++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await Promise.all([closeServer(stageServer), closeServer(editorServer), closeServer(assetServer)]);
    if (!KEEP) {
      if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`INFO kept temp dirs: profileDir=${profileDir}, dataDir=${dataDir}`);
    }
  }

  if (failed > 0) {
    console.error(`media-cache-probe: FAIL (${failed} failed)`);
    process.exitCode = 1;
  } else {
    console.log('media-cache-probe: PASS');
  }
}

await main();
