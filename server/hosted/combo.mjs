/**
 * 托管组合（SP，契约 `docs/plan/shared-project-contract.md` 第 1 节）：一个 Node 进程里的文档服务与素材服务。
 * 入口 `main.mjs` 读环境变量后调这里；测试也直接调这里（同一进程里起、关）。
 *
 * - **文档服务**：`createSharedDocService({ mode: 'hosted' })`，数据在 `<dataDir>/docservice/`
 *   （`local` 空间的日志、`tenants/<projectId>/`、凭证存储 `auth/`）。
 * - **素材服务**：独立的 http 服务器，挂 `server/asset-service.ts` 的中间件；三个命名空间各一个 `fs-store`，
 *   分目录布局（`shard: true`），目录 `<dataDir>/assets/<ns>/`，布局标记 `<dataDir>/assets/.layout`。
 *   票据核对与文档服务共用同一份凭证存储（进程内单例 `credentialStoreFor`，auth-contract 第 8 节「同进程共用」）。
 * - 素材服务起来后，经回环地址向本进程的文档服务登记公网地址（`service.announce { kind: 'asset' }`），
 *   有集群令牌就带令牌（管理身份），没有就以回环的本机身份登记（本机身份同样允许登记，auth-contract 第 10 节）。
 * - 素材服务端口上另有两条管理接口（「迁移导出」，auth-contract 第 1 节的管理接口；只认集群令牌或本机回环）：
 *   - `GET /admin/inventory`：盘点——共享项目、各空间里每个项目的 `projectRev`、内容库条目数、项目快照数、
 *     三个命名空间的哈希清单与字节数。迁移前后各取一份对比（`shared-project-probe.mjs --role migrate-check`）；
 *   - `GET /admin/blob/<ns>/<hash>`：按哈希取回字节（迁移后抽查重算 sha256）。
 * - `GET /healthz`（素材服务端口）：`{ ok, role: 'asset', layout }`。文档服务端口的 `/healthz` 照旧。
 *
 * 失败即关（启动时抛 `HostedConfigError`，`main.mjs` 打 `config.error { reason }` 退出码 1）：
 * - `data-dir`：数据目录不存在、不是目录或不可写；
 * - `layout`：`assets/.layout` 与分目录布局对不上，或者 `assets/` 里已有来历不明的东西而没有标记；
 * - `auth-store`：绑非回环地址而凭证存储打不开（沿用 auth-contract 第 10 节）。
 *
 * 磁盘满：`ENOSPC` / `EDQUOT` 由素材服务中间件回 507 `insufficient-storage`（见 `asset-service.ts` 文件头）。
 * 不挂预渲染进程，不起渲染节点。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { registerTsResolve } from './ts-resolve.mjs';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { credentialStoreFor } from '../auth/store.mjs';
import { createAssetTicketVerifier } from '../auth/asset-tickets.mjs';
import { isLoopbackAddress } from '../auth/handshake.mjs';
import { createFsStore, ensureLayoutSync, LAYOUTS } from '../asset-store/fs-store.mjs';
import { normalizeHash } from '../asset-store/blob-store.mjs';
import { startAssetAnnounce } from '../asset-announce.mjs';

export const HOSTED_NAMESPACES = Object.freeze(['media', 'snap', 'px']);
/** 登记素材服务地址用的登记者身份 */
export const HOSTED_ANNOUNCER_ID = 'asset:hosted';

/** 启动时的配置错误：`reason` 是 `config.error` 的原因词 */
export class HostedConfigError extends Error {
  constructor(reason, extra = {}) {
    super(reason);
    this.reason = reason;
    this.extra = extra;
  }
}

/** 数据目录下的布局（契约第 1 节） */
export function hostedPaths(dataDir) {
  const root = path.resolve(dataDir);
  return {
    root,
    docservice: path.join(root, 'docservice'),
    auth: path.join(root, 'docservice', 'auth'),
    tenants: path.join(root, 'docservice', 'tenants'),
    assets: path.join(root, 'assets'),
    secrets: path.join(root, 'secrets'),
    clusterTokenFile: path.join(root, 'secrets', 'cluster-token'),
  };
}

/** 数据目录必须已经存在、是目录、可写（试写一个文件再删掉）；否则 `data-dir` */
export function checkDataDir(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new HostedConfigError('data-dir', { detail: 'unset' });
  const root = path.resolve(dataDir);
  let st;
  try {
    st = fs.statSync(root);
  } catch (err) {
    throw new HostedConfigError('data-dir', { detail: String(err?.code ?? 'stat') });
  }
  if (!st.isDirectory()) throw new HostedConfigError('data-dir', { detail: 'not-a-directory' });
  const probe = path.join(root, `.write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    try { fs.unlinkSync(probe); } catch { /* 没写成 */ }
    throw new HostedConfigError('data-dir', { detail: String(err?.code ?? 'write') });
  }
  return root;
}

/**
 * 集群令牌：先读 `<dataDir>/secrets/cluster-token`（去掉首尾空白），没有这个文件再回落 `env.PROMPTCUT_CLUSTER_TOKEN`。
 * 回 `{ token, source: 'file' | 'env' | 'none', loose }`，`loose` 为真表示文件权限比 0600 宽（只在 POSIX 上判，只记日志）。
 * 文件存在但读不了照原样抛错。
 */
export function readClusterToken(dataDir, env = process.env) {
  const file = hostedPaths(dataDir).clusterTokenFile;
  let text = null;
  let loose = false;
  try {
    text = fs.readFileSync(file, 'utf8');
    if (process.platform !== 'win32') loose = (fs.statSync(file).mode & 0o077) !== 0;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (text !== null) return { token: text.trim(), source: 'file', loose };
  const fromEnv = env.PROMPTCUT_CLUSTER_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv !== '') return { token: fromEnv, source: 'env', loose: false };
  return { token: undefined, source: 'none', loose: false };
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest();

/** 读一个 ndjson 文件的全部记录；读不了回 []，解析不了的行跳过 */
function readRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) out.push(rec);
    } catch { /* 崩溃留下的半行 */ }
  }
  return out;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 盘点一个空间的存储目录（`docservice-contract` 第 3 节的文件布局）：
 * - `projects/*.ndjson`：项目版本日志，按记录自己的 `projectId` 取最大的 `rev`；
 * - `projects/*@<rev>.json`：项目快照（不可变文件）；
 * - `content/<kind>.ndjson`：内容库，按记录自己的 `kind` + `key` 数不同的键。
 */
function scanSpace(dir) {
  const projects = {};
  let snapshots = 0;
  for (const ent of listDir(path.join(dir, 'projects'))) {
    if (!ent.isFile()) continue;
    if (ent.name.endsWith('.ndjson')) {
      for (const rec of readRecords(path.join(dir, 'projects', ent.name))) {
        if (typeof rec.projectId !== 'string' || !Number.isSafeInteger(rec.rev)) continue;
        projects[rec.projectId] = Math.max(projects[rec.projectId] ?? 0, rec.rev);
      }
    } else if (/@\d+\.json$/.test(ent.name)) {
      snapshots += 1;
    }
  }
  const content = {};
  for (const ent of listDir(path.join(dir, 'content'))) {
    if (!ent.isFile() || !ent.name.endsWith('.ndjson')) continue;
    for (const rec of readRecords(path.join(dir, 'content', ent.name))) {
      if (typeof rec.kind !== 'string' || typeof rec.key !== 'string') continue;
      (content[rec.kind] ??= new Set()).add(rec.key);
    }
  }
  const sorted = Object.fromEntries(Object.keys(projects).sort().map((k) => [k, projects[k]]));
  const counts = Object.fromEntries(Object.keys(content).sort().map((k) => [k, content[k].size]));
  return { projects: sorted, snapshots, content: counts };
}

/**
 * @param {object} options
 * @param {string} options.dataDir  `PROMPTCUT_DATA_DIR`：必须已存在、可写
 * @param {number} [options.docPort]  缺省 8787；0 表示随便给一个（测试用）
 * @param {number} [options.assetPort]  缺省 8788
 * @param {string} [options.host]  两个端口都绑它，缺省 `0.0.0.0`
 * @param {string} [options.clusterToken]  已校验过格式的集群令牌；不给则管理接口只认本机回环
 * @param {string} [options.assetPublicUrl]  登记给成员的素材服务地址；不给就按实际端口拼 `http://127.0.0.1:<port>/api/asset`
 * @param {string} [options.docPublicUrl]  只作记录与诊断
 * @param {boolean} [options.trustLoopback]  素材服务与管理接口是否把本机回环当自己人（缺省 true）；
 *   false 时回环来的请求也要票据 / 令牌（测试开关：本机也能验票据读写）
 * @param {{ deviceId: string, deviceName: string }} [options.localDevice]
 * @param {(ns: string, store: object) => object} [options.wrapStore]  测试用：包一层数据层（注入磁盘满等）
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {object} [options.limits]  透传 `createSharedDocService`
 * @param {object} [options.service]  透传 `createSharedDocService`
 */
export async function startHostedCombo({
  dataDir,
  docPort = 8787,
  assetPort = 8788,
  host = '0.0.0.0',
  clusterToken,
  assetPublicUrl,
  docPublicUrl,
  trustLoopback = true,
  localDevice,
  wrapStore,
  log = () => {},
  now = Date.now,
  limits,
  service: serviceOptions,
} = /** @type {any} */ ({})) {
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志出错不影响服务 */ } };
  const root = checkDataDir(dataDir);
  const paths = hostedPaths(root);
  const loopbackBind = host === '127.0.0.1' || host === '::1' || host === 'localhost';

  // 目录：docservice/、assets/、secrets/（0700）
  try {
    fs.mkdirSync(paths.docservice, { recursive: true });
    fs.mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(paths.secrets, 0o700);
  } catch (err) {
    throw new HostedConfigError('data-dir', { detail: String(err?.code ?? 'mkdir') });
  }

  // 素材布局：标记对不上就拒绝启动（两种布局读取互不兼容）
  let layout;
  try {
    layout = ensureLayoutSync(paths.assets, LAYOUTS.shard);
  } catch (err) {
    throw new HostedConfigError('data-dir', { detail: String(err?.code ?? 'layout-write') });
  }
  if (!layout.ok) throw new HostedConfigError('layout', { expected: LAYOUTS.shard, found: layout.found });
  if (layout.created) say('assets.layout.created', { layout: LAYOUTS.shard });

  // 凭证存储：进程内单例，文档服务与素材服务共用
  let store = null;
  try {
    store = credentialStoreFor(paths.auth, { log: say, now });
  } catch (err) {
    if (!loopbackBind) throw new HostedConfigError('auth-store', { message: String(err?.code ?? err?.message ?? err) });
    say('auth.store.unavailable', { message: String(err?.code ?? err?.message ?? err) });
  }

  // 素材服务的中间件是 .ts（vite 写法）：先装解析钩子再载入
  registerTsResolve();
  const [assetService, media] = await Promise.all([
    import('../asset-service.ts'),
    import('../vite-plugin-media.ts'),
  ]);

  const stores = {};
  for (const ns of HOSTED_NAMESPACES) {
    const contentTypeForExt = ns === 'media' ? media.contentTypeForExt : artifactContentType(media.contentTypeForExt);
    const st = createFsStore({ dir: path.join(paths.assets, ns), shard: true, hooks: { contentTypeForExt } });
    stores[ns] = typeof wrapStore === 'function' ? wrapStore(ns, st) : st;
  }

  const isLoopbackReq = (req) => trustLoopback && isLoopbackAddress(req?.socket?.remoteAddress);
  const tickets = createAssetTicketVerifier({ store: () => store, now });
  const assetMiddleware = assetService.assetServiceMiddleware(root, { stores, tickets, isTrusted: isLoopbackReq });
  const preflight = assetService.assetPreflightMiddleware();

  const tokenDigest = typeof clusterToken === 'string' && clusterToken !== '' ? sha256(clusterToken) : null;
  /** 管理接口：本机回环（trustLoopback 时），或 `Authorization: Bearer <集群令牌>` */
  function adminAllowed(req) {
    if (isLoopbackReq(req)) return true;
    if (!tokenDigest) return false;
    const m = /^Bearer[ \t]+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim());
    return !!m && timingSafeEqual(sha256(m[1]), tokenDigest);
  }

  const { service } = createSharedDocService({
    mode: 'hosted',
    dataDir: paths.docservice,
    store,
    clusterToken,
    localDevice,
    now,
    log: say,
    ...(limits ? { limits } : {}),
    ...(serviceOptions ? { service: serviceOptions } : {}),
  });

  async function inventory() {
    const spaces = { local: scanSpace(paths.docservice) };
    for (const ent of listDir(paths.tenants)) {
      if (ent.isDirectory()) spaces[ent.name] = scanSpace(path.join(paths.tenants, ent.name));
    }
    const shared = store ? store.list().sort((a, b) => (a.projectId < b.projectId ? -1 : 1)) : null;
    const assets = {};
    for (const ns of HOSTED_NAMESPACES) {
      const list = await stores[ns].list();
      assets[ns] = { count: list.length, bytes: list.reduce((n, e) => n + e.size, 0), hashes: list.map((e) => e.hash) };
    }
    return { ok: true, layout: LAYOUTS.shard, docPublicUrl: docPublicUrl ?? null, assetPublicUrl: publicUrl, sharedProjects: shared, spaces, assets };
  }

  async function adminBlob(req, res, ns, rawHash) {
    let hash;
    try {
      hash = normalizeHash(rawHash);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad-hash' });
    }
    const st = await stores[ns].stat(hash);
    if (!st) return sendJson(res, 404, { ok: false, error: 'not-found' });
    const stream = await stores[ns].read(hash);
    if (!stream) return sendJson(res, 404, { ok: false, error: 'not-found' });
    res.writeHead(200, { 'Content-Type': st.contentType, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async function handleAsset(req, res) {
    const url = new URL(req.url ?? '/', 'http://hosted.local');
    if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(res, 200, { ok: true, role: 'asset', layout: LAYOUTS.shard });
    }
    if (url.pathname.startsWith('/admin/')) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method' });
      if (!adminAllowed(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      if (url.pathname === '/admin/inventory') return sendJson(res, 200, await inventory());
      const m = /^\/admin\/blob\/(media|snap|px)\/([^/]+)$/.exec(url.pathname);
      if (m) return adminBlob(req, res, m[1], m[2]);
      return sendJson(res, 404, { ok: false, error: 'not-found' });
    }
    preflight(req, res, () => {
      assetMiddleware(req, res, () => sendJson(res, 404, { ok: false, error: 'not-found' }));
    });
  }

  const assetServer = http.createServer((req, res) => {
    handleAsset(req, res).catch((err) => {
      say('asset.error', { message: String(err?.message ?? err) });
      sendJson(res, 500, { ok: false, error: 'internal' });
    });
  });

  // 先起文档服务，再起素材服务；任何一个起不来，把已经起来的关掉再抛
  let docAddr;
  try {
    docAddr = await service.listen(docPort, host);
  } catch (err) {
    await service.close().catch(() => {});
    throw err;
  }
  let assetAddr;
  try {
    assetAddr = await new Promise((resolve, reject) => {
      assetServer.once('error', reject);
      assetServer.listen(assetPort, host, () => {
        assetServer.off('error', reject);
        resolve(assetServer.address());
      });
    });
  } catch (err) {
    await service.close().catch(() => {});
    throw err;
  }

  const publicUrl = assetPublicUrl || `http://127.0.0.1:${assetAddr.port}/api/asset`;
  const loopHost = host === '0.0.0.0' || host === '::' || loopbackBind ? (host === '::1' ? '[::1]' : '127.0.0.1') : host;
  let announceDone = () => {};
  const announced = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    timer.unref?.();
    announceDone = (ok) => { clearTimeout(timer); resolve(ok); };
  });
  const announcer = startAssetAnnounce({
    url: `ws://${loopHost}:${docAddr.port}`,
    token: tokenDigest ? clusterToken : undefined,
    announcerId: HOSTED_ANNOUNCER_ID,
    urls: [publicUrl],
    log(event, fields) {
      say(event, fields);
      if (event === 'asset-announce.announced') announceDone(true);
      if (event === 'asset-announce.error' && fields?.stage === 'reply') announceDone(false);
    },
  });
  const announceOk = await announced;
  say('asset.announce', { ok: announceOk, url: publicUrl, via: tokenDigest ? 'cluster-token' : 'loopback-local' });

  let closed = false;
  return {
    paths,
    docPort: docAddr.port,
    assetPort: assetAddr.port,
    assetPublicUrl: publicUrl,
    announced: announceOk,
    service,
    stores,
    get credentialStore() { return store; },
    inventory,
    async close() {
      if (closed) return;
      closed = true;
      try { announcer.stop(); } catch { /* 已停 */ }
      await new Promise((resolve) => {
        assetServer.close(() => resolve());
        assetServer.closeAllConnections?.();
      });
      await service.close();
    },
  };
}

/**
 * 产物命名空间（`snap` / `px`）的 Content-Type：快照是 HTML，init 是 mp4，分段是 m4s，其余照素材的表。
 * 与 `asset-service.ts` 里没导出的 `artifactContentType` 同一张表。
 */
function artifactContentType(base) {
  return (ext) => {
    const e = String(ext || '').toLowerCase().replace(/^\./, '');
    if (e === 'html' || e === 'htm') return 'text/html; charset=utf-8';
    if (e === 'm4s') return 'video/iso.segment';
    return base(e);
  };
}
