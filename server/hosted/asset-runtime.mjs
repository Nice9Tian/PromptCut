/** 分进程v2素材服务：只持asset私钥，项目权限/凭证引用全由doc mTLS接口核对。 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { certificateFingerprint, accountError } from '../account/client.mjs';
import { registerTsResolve } from './ts-resolve.mjs';
import { createAssetDocClient } from './asset-doc-client.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createProjectAssetAccess } from '../asset-store/project-access.mjs';
import { createAssetRevocationConsumer } from '../asset-store/project-revocations.mjs';
import { createServiceUsage, serviceCapBytes, diskTotalOf } from '../asset-store/service-usage.mjs';
import { StreamStore, handleStreamRequest } from '../asset-store/stream-store.mjs';
import { openAssetLifecycle } from './asset-lifecycle.mjs';

const send = (res, status, value) => { if (res.destroyed || res.headersSent) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
const listen = (server, port, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); }); });
const closeServer = server => new Promise(resolve => { if (!server?.listening) return resolve(); server.close(resolve); server.closeAllConnections?.(); });

export async function startHostedAssetService({ dataDir, host = '127.0.0.1', port = 8788, internalPort, publicUrl,
  doc, internalTls, docFingerprint256, renderCapBytes, pollMs = 100, log = () => {}, wrapStore, recoveryFence, serviceIdentity, allowFixtureRecoveryFence = false }) {
  const docPin = certificateFingerprint(docFingerprint256);
  if (!path.isAbsolute(dataDir ?? '') || !fs.statSync(dataDir).isDirectory() || !internalTls?.key || !internalTls?.cert || !internalTls?.ca ||
      !/^[a-f0-9]{64}$/.test(docPin) || !Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535 ||
      !Number.isInteger(pollMs) || pollMs < 1) throw accountError(503, 'asset-configuration');
  registerTsResolve();
  const [asset, media, shots] = await Promise.all([import('../asset-service.ts'), import('../vite-plugin-media.ts'), import('../asset-store/shots-thumb.mjs')]);
  const root = path.resolve(dataDir), assetsDir = path.join(root, 'assets-v2'); await fsp.mkdir(assetsDir, { recursive: true });
  const docClient = createAssetDocClient(doc), instanceId = randomUUID();
  const lifecycle = await openAssetLifecycle({ root, instanceId, cert: doc.tls.cert, recoveryFence, serviceIdentity, allowFixtureRecoveryFence });
  const consumer = createAssetRevocationConsumer({ authority: docClient, file: path.join(root, 'access-cursor.json') });
  let stopped = false, failure = null, syncing = null, timer, assetServer, internalServer;
  const sync = () => {
    if (stopped) return Promise.reject(accountError(503, 'asset-unavailable'));
    if (!syncing) { syncing = consumer.sync().then(cursor => { failure = null; return cursor; }, error => { failure = error; throw error; }).finally(() => { syncing = null; }); }
    return syncing;
  };
  const ready = () => !stopped && !failure && consumer.ready;
  const resolvePrincipal = async req => {
    if (!ready()) { await sync(); if (!ready()) throw accountError(503, 'asset-not-ready'); }
    if (req.headers.cookie) throw accountError(400, 'asset-ticket-required');
    const url = new URL(req.url, 'http://asset.invalid'), auth = req.headers.authorization;
    const token = auth === undefined ? url.searchParams.get('t') : /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(auth)?.[1];
    if (!token || (auth !== undefined && url.searchParams.has('t') && url.searchParams.get('t') !== token) ||
        (auth === undefined && !['GET', 'HEAD'].includes(req.method))) throw accountError(401, 'asset-ticket-required');
    return docClient.resolveAssetTicket(token, url.searchParams.has('projectId') ? url.searchParams.get('projectId') : undefined);
  };
  const projectAccess = createProjectAssetAccess({ authority: consumer, resolvePrincipal });
  const factory = createProjectAssetStores({ dir: assetsDir, contentTypeForExt: media.contentTypeForExt });
  const projectStores = wrapStore ? { project: id => { const p = factory.project(id); return { ...p, stores: Object.fromEntries(Object.entries(p.stores).map(([ns, store]) => [ns, wrapStore(id, ns, store)])) }; } } : factory;
  const capBytes = Number.isFinite(renderCapBytes) && renderCapBytes >= 0 ? Math.floor(renderCapBytes) : serviceCapBytes({ diskTotal: await diskTotalOf(assetsDir) });
  const serviceUsage = createServiceUsage({ dir: path.join(root, '.service-usage'), projectScoped: true, capBytes });
  const opts = { projectAccess, projectStores, serviceUsage, pxEvict: null, pullArtifact: null };
  const a = asset.assetServiceMiddleware(root, opts), preflight = asset.assetPreflightMiddleware();
  let effectivePublicUrl = publicUrl;
  const m = media.mediaMiddleware(root, { ...opts, verifyRemoteTarget: async (_req, target) => {
    if (target?.base !== effectivePublicUrl) throw accountError(403, 'untrusted-asset-target');
    const principal = await docClient.resolveAssetTicket(target.ticket); return { ...target, projectId: principal.projectId };
  } });
  const thumbnail = shots.shotsThumbMiddleware(root, opts), streamStores = new Map();
  const streamStoreFor = projectId => {
    if (!streamStores.has(projectId)) { const p = factory.project(projectId); streamStores.set(projectId,
      new StreamStore(path.join(root, 'streams'), { ownership: { projectId, assert: async () => p.assertActive() }, projectAccess })); }
    return streamStores.get(projectId);
  };
  async function status() {
    await sync();
    const page = await docClient.eventsSince(consumer.cursor);
    if (page.headSeq !== consumer.cursor) { await sync(); }
    return { ok: true, ready: ready() && consumer.cursor === page.headSeq, authorityId: doc.authorityId, instanceId,
      accessCursor: consumer.cursor, accessHead: page.headSeq };
  }
  assetServer = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://asset.invalid').pathname;
    if (pathname === '/healthz') { if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { ok: false }); return send(res, 200, { ok: true, role: 'asset', layout: 2, accountRequired: true, assetReady: ready() }); }
    if (pathname.startsWith('/internal/') || pathname.startsWith('/admin/')) return send(res, 404, { ok: false, error: 'no-route' });
    preflight(req, res, () => {
      const run = async () => {
        if (!ready()) { await sync(); if (!ready()) throw accountError(503, 'asset-not-ready'); }
        if (pathname.startsWith('/stream/')) { const p = await resolvePrincipal(req); if (!handleStreamRequest(streamStoreFor(p.projectId), req, res, pathname)) send(res, 404, { ok: false, error: 'no-route' }); return; }
        await a(req, res, () => { void m(req, res, () => { void thumbnail(req, res, () => send(res, 404, { ok: false, error: 'no-route' })); }); });
      };
      void run().catch(error => send(res, error.status ?? 503, { ok: false, error: error.code ?? 'asset-unavailable' }));
    });
  });
  internalServer = https.createServer({ ...internalTls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (req.socket.authorized !== true || certificateFingerprint(req.socket.getPeerCertificate()?.fingerprint256) !== docPin) return send(res, 403, { ok: false, error: 'service-forbidden' });
    if (req.method !== 'GET' || req.url !== '/internal/v2/asset/status') return send(res, 404, { ok: false, error: 'no-route' });
    try { send(res, 200, await status()); } catch (error) { send(res, 503, { ok: false, error: 'asset-not-ready' }); }
  });
  try {
    // 起服务时允许权威暂时不可达，但所有数据口和session保持不可用；只重放真实持久head。
    await consumer.start().catch(error => { if (error.status !== 503) throw error; failure = error; log('asset.not-ready', { code: error.code ?? 'authority-unavailable' }); });
    const addr = await listen(assetServer, port, host); await listen(internalServer, internalPort, '127.0.0.1');
    effectivePublicUrl ??= `http://127.0.0.1:${addr.port}/api/asset`;
    timer = setInterval(() => { void sync().catch(error => log('asset.not-ready', { code: error.code ?? 'authority-unavailable' })); }, pollMs); timer.unref();
    return { port: addr.port, internalPort, instanceId, projectStores: factory, projectAccess, serviceUsage, streamStoreFor, status,
      get ready() { return ready(); }, async close() { if (stopped) return; stopped = true; clearInterval(timer); await consumer.close(); docClient.close(); await Promise.all([closeServer(assetServer), closeServer(internalServer)]); await lifecycle.closeClean(); } };
  } catch (error) { stopped = true; clearInterval(timer); await consumer.close().catch(() => {}); docClient.close(); await Promise.all([closeServer(assetServer), closeServer(internalServer)]); throw error; }
}
