import '../lib/no-user-dirs.mjs';
/**
 * 素材按项目隔离的探针（0.7.18 块六；设计 `docs/plan/three-versions-018-design.md`「素材协议」那张表）。
 *
 * 起的是本机隔离的托管组合，不连节点：真实的账号后端模块（VisuHive 仓库 `account/`）、真实的文档服务托管组合
 * （`server/hosted/combo.mjs`，账号模式）、独立进程的素材服务（暂存目录里起 `server/hosted/asset-main.mjs`），
 * 服务之间走临时证书的双向 TLS。三个账号：甲建项目一，乙建项目二，丙凭链接加入项目一。
 *
 * 验三件事：
 *   1. 同一个内容哈希只在项目一入库时，乙（持项目二的有效票据）在素材服务每个读写入口都读不到、收不了尾；
 *      乙自己再上传同样的字节，各读各的。
 *   2. 项目自己的成员（丙）读写照常。
 *   3. 撤销：丙正在读的流（三命名空间的取回、`/@media/<hash>` 两条路各一条，读到一半停住）在甲踢人后被服务端掐断，
 *      丙的新请求被拒，甲和乙不受影响；乙的登录被退出后同样，重新登录后照常。
 *
 * 不含的入口：`server/frame-stream.mjs` 与渲染工作进程（`server/hosted-render/worker.mjs`），它们在渲染那一带。
 *
 * 用法：
 *   node scripts/probes/asset-account-isolation-probe.mjs [--base-port 28060] [--out <目录>]
 * 环境变量 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`（VisuHive 仓库根）、`PROMPTCUT_PASSWORD_ORDER_MODULE` 必须设好。
 * 占 `base-port` 起的连续 5 个端口（账号内部口、文档服务、文档服务内部口、素材服务、素材服务内部口）。
 * 结果写 `<out>/result.json`，标准输出一行汇总；有一项不过退出码为 1。等待时限只为防卡死。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { stageHostedAssetFiles } from '../../server/hosted/files.mjs';
import { StreamStore } from '../../server/asset-store/stream-store.mjs';
import { projectStorageKey } from '../../server/asset-store/project-stores.mjs';
import { assetWiringPki } from '../../server/test/fixtures/asset-wiring-pki.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const basePort = Number(argOf('--base-port', 28060));
if (!Number.isInteger(basePort) || basePort < 20000 || basePort > 65530) throw new Error('--base-port 要在 20000 以上');
const providerDir = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ?? '';
if (!providerDir || !fs.existsSync(path.join(providerDir, 'account/internal.mjs')) || !process.env.PROMPTCUT_PASSWORD_ORDER_MODULE)
  throw new Error('要先设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT（VisuHive 仓库根）和 PROMPTCUT_PASSWORD_ORDER_MODULE');
const PORT = { account: basePort, doc: basePort + 1, docInternal: basePort + 2, asset: basePort + 3, assetInternal: basePort + 4 };

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-asset-account-probe-'));
const out = path.resolve(argOf('--out', path.join(dir, 'out')));
await fsp.mkdir(out, { recursive: true });

const checks = [];
const check = (name, passed, detail = null) => { checks.push({ name, passed: !!passed, detail }); if (!passed) console.error(`✖ ${name} ${JSON.stringify(detail)}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (probe, label, ms = 30000) => { const end = Date.now() + ms; for (;;) { if (await probe()) return; if (Date.now() > end) throw new Error(`等不到：${label}`); await sleep(25); } };
const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** 一段 0.1 秒 48 kHz 单声道正弦波的 WAV：PCM 那条路要真的能解码 */
const wav = () => { const b = Buffer.alloc(44 + 4800 * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); for (let i = 0; i < 4800; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 16000), 44 + i * 2); return b; };

let accountServer, combo, provider, child, childClosed, childLog = '';
const origin = `http://127.0.0.1:${PORT.doc}`, assetOrigin = `http://127.0.0.1:${PORT.asset}`;
const web = async (method, route, body, token) => { const res = await fetch(origin + route, { method, signal: AbortSignal.timeout(15000),
  headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) }; };

/**
 * 读到第一块就停住不再读的请求：服务端那条流被背压顶住、一直开着。
 * 回 `{ status, got(), ended(), closed, resume() }`；`closed` 在响应真的关掉时兑现成 `{ complete, bytes }`。
 */
function stalledRead(route, ticket) {
  return new Promise((resolve, reject) => {
    const req = http.get(assetOrigin + route, { headers: { authorization: `Bearer ${ticket}` }, agent: false }, res => {
      let bytes = 0, ended = false, isClosed = false, stalled = true, settle;
      const closed = new Promise(done => { settle = done; });
      res.on('data', chunk => { bytes += chunk.length; if (stalled) res.pause(); });
      res.on('end', () => { ended = true; });
      res.on('error', () => {});
      res.on('close', () => { isClosed = true; settle({ complete: ended && res.complete, bytes }); });
      res.once('data', () => resolve({ status: res.statusCode, got: () => bytes, ended: () => ended, isClosed: () => isClosed, closed, resume: () => { stalled = false; res.resume(); } }));
      if (res.statusCode !== 200) { res.resume(); resolve({ status: res.statusCode, got: () => bytes, ended: () => ended, isClosed: () => isClosed, closed, resume: () => {} }); }
    });
    req.on('error', reject);
    req.setTimeout(600000, () => req.destroy(new Error('stalled read timeout'))); // 只为防卡死
  });
}

try {
  /* ---------------- 起服务 ---------------- */
  const pki = assetWiringPki(dir);
  const [storeMod, credentialsMod, internalMod] = await Promise.all(['store', 'credentials', 'internal'].map(n => import(pathToFileURL(path.join(providerDir, `account/${n}.mjs`)).href)));
  provider = storeMod.openStore(path.join(dir, 'provider.sqlite'));
  const credentials = credentialsMod.createCredentials({ store: provider, key: randomBytes(32) });
  const orderModule = await import(pathToFileURL(process.env.PROMPTCUT_PASSWORD_ORDER_MODULE).href);
  const orderKeys = { account: generateKeyPairSync('ed25519'), doc: generateKeyPairSync('ed25519') };
  const order = orderModule.createPasswordOrder({ store: provider, credentials, accountOrderSigningKey: orderKeys.account.privateKey,
    accountOrderKeyId: 'asset-probe-order', docAttestationPublicKey: orderKeys.doc.publicKey });
  const ids = ['acc_0123456789abcdef01234567', 'acc_abcdef0123456789abcdef01', 'acc_00112233445566778899aabb'];
  const names = ['甲', '乙', '丙'];
  const login = (i, device) => credentials.createEditor({ account: provider.accountById(ids[i]), deviceId: device, requestId: `login-${i}-${device}` });
  const editors = ids.map((id, i) => { provider.createAccount({ id, name: `Asset Probe ${i}`, nameKey: `asset-probe-${i}`, pw: 'probe-only', now: Date.now() }); return login(i, `probe-device-${i}`); });
  accountServer = internalMod.createInternalServer({ tls: pki.account, store: provider, credentials, order, services: [{ serviceId: 'doc', fingerprint256: pki.doc.fingerprint256 }] });
  await new Promise(resolve => accountServer.listen(PORT.account, '127.0.0.1', resolve));
  const docDir = path.join(dir, 'doc'), assetDir = path.join(dir, 'asset'), app = path.join(dir, 'app');
  await fsp.mkdir(docDir); await fsp.mkdir(assetDir); stageHostedAssetFiles(repoRoot, app);
  const authorityId = 'asset-probe-doc';
  combo = await startHostedCombo({ dataDir: docDir, docPort: PORT.doc, assetPort: basePort + 9, host: '127.0.0.1', trustLoopback: false, clusterToken: 'probe-cluster-token-32-characters0',
    accountRequired: true, assetPublicUrl: `${assetOrigin}/api/asset`,
    assetStatus: { origin: `https://127.0.0.1:${PORT.assetInternal}`, tls: pki.doc, serverFingerprint256: pki.asset.fingerprint256 },
    account: { origin: `https://127.0.0.1:${PORT.account}`, clientTls: pki.doc, serverFingerprint256: pki.account.fingerprint256, authorityId,
      authorityUrl: 'https://probe.invalid/editor', signingKey: generateKeyPairSync('ed25519').privateKey, keyId: 'probe', internalTls: pki.doc, internalPort: PORT.docInternal,
      services: [{ serviceId: 'asset', fingerprint256: pki.asset.fingerprint256 }],
      order: { witnessKeys: { 'asset-probe-order': orderKeys.account.publicKey }, docAttestationPrivateKey: orderKeys.doc.privateKey } } });
  check('账号模式下组合不另挂旧的公开素材口', combo.assetPort === null, combo.assetPort);
  const env = { ...process.env, PROMPTCUT_ASSET_DATA_DIR: assetDir, PROMPTCUT_ASSET_HOST: '127.0.0.1', PROMPTCUT_ASSET_PORT: String(PORT.asset), PROMPTCUT_ASSET_INTERNAL_PORT: String(PORT.assetInternal),
    PROMPTCUT_ASSET_PUBLIC_URL: `${assetOrigin}/api/asset`, PROMPTCUT_ASSET_DOC_AUTHORITY_ID: authorityId, PROMPTCUT_ASSET_DOC_ORIGIN: `https://127.0.0.1:${PORT.docInternal}`,
    PROMPTCUT_ASSET_DOC_FINGERPRINT256: pki.doc.fingerprint256, PROMPTCUT_ASSET_DOC_CLIENT_FINGERPRINT256: pki.doc.fingerprint256,
    PROMPTCUT_ASSET_DOC_CA_FILE: path.join(dir, 'ca.crt'), PROMPTCUT_ASSET_CLIENT_KEY_FILE: path.join(dir, 'asset.key'), PROMPTCUT_ASSET_CLIENT_CERT_FILE: path.join(dir, 'asset.crt'),
    PROMPTCUT_ASSET_INTERNAL_KEY_FILE: path.join(dir, 'asset.key'), PROMPTCUT_ASSET_INTERNAL_CERT_FILE: path.join(dir, 'asset.crt') };
  child = spawn(process.execPath, ['server/hosted/asset-main.mjs'], { cwd: app, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  childClosed = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', b => { childLog += b; }); child.stderr.on('data', b => { childLog += b; });
  await waitFor(async () => { if (child.exitCode !== null) throw new Error('素材服务进程退出了：' + childLog); try { return (await fetch(assetOrigin + '/healthz')).ok; } catch { return false; } }, '素材服务监听');

  /* ---------------- 两个项目、三个账号 ---------------- */
  const projects = [];
  for (const i of [0, 1]) { const created = await web('POST', '/hosted/shared/account/create', { name: `Probe ${i}`, requestId: `create-${i}`, allowLinkJoin: true, initialProject: { tracks: [] } }, editors[i].accessToken);
    if (created.status !== 201) throw new Error('建项目失败 ' + JSON.stringify(created)); projects.push(created.body.projectId); }
  const joined = await web('POST', '/hosted/shared/account/join', { projectId: projects[0], requestId: 'join-c', deviceId: 'probe-device-2' }, editors[2].accessToken);
  check('丙凭链接加入项目一', joined.status === 200, joined.status);
  const session = async (i, project, requestId, token = editors[i].accessToken, device = `probe-device-${i}`) => web('POST', '/hosted/shared/account/session', { projectId: projects[project], deviceId: device, requestId }, token);
  const ticket = {};
  for (const [who, i, project] of [['A', 0, 0], ['B', 1, 1], ['C', 2, 0]]) { const got = await session(i, project, `session-${who}`); if (got.status !== 200) throw new Error(`${who} 开会话失败 ${JSON.stringify(got)}`); ticket[who] = got.body.assetTicket; }
  const crossSession = await session(1, 0, 'cross-session');
  check('乙拿不到项目一的会话与票据', crossSession.status !== 200 && !crossSession.body.assetTicket, crossSession.status);
  const req = (who, route, options = {}) => fetch(assetOrigin + route, { ...options, signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${ticket[who]}`, ...options.headers } });
  const status = async (who, route, options) => { const r = await req(who, route, options); await r.arrayBuffer().catch(() => {}); return r.status; };
  const json = async (who, route, options) => { const r = await req(who, route, options); return { status: r.status, body: await r.json().catch(() => null) }; };
  const upload = async (who, ns, bytes, ext = 'wav') => { const hash = sha(bytes), size = bytes.length, chunk = 8 * 1024 * 1024, count = Math.max(1, Math.ceil(size / chunk)), codes = [];
    for (let n = 0; n < count; n++) codes.push(await status(who, `/api/asset/${ns}/${hash}/${n}`, { method: 'PUT', headers: { 'x-media-size': String(size), 'x-media-ext': ext }, body: bytes.subarray(n * chunk, Math.min(size, (n + 1) * chunk)) }));
    codes.push(await status(who, `/api/asset/${ns}/${hash}/complete`, { method: 'POST' })); return codes.every(code => code === 200) ? 200 : codes; };

  const bytes = wav(), hash = sha(bytes);
  const projectRoot = i => path.join(assetDir, 'assets-v2', 'projects', projectStorageKey(projects[i]));

  /* ---------------- 没有票据、自报身份、换项目 ---------------- */
  check('甲把素材传进项目一（media）', await upload('A', 'media', bytes) === 200);
  const bare = route => fetch(assetOrigin + route, { signal: AbortSignal.timeout(10000) }).then(async r => { await r.arrayBuffer().catch(() => {}); return r.status; });
  check('没有票据读 /api/asset 被拒', await bare(`/api/asset/media/${hash}`) === 401);
  check('没有票据读 /@media 被拒', await bare(`/@media/${hash}`) === 401);
  check('自报账号与项目的请求头不算数', (await fetch(`${assetOrigin}/api/asset/media/${hash}`, { headers: { 'x-account-id': ids[0], 'x-project-id': projects[0] } })).status === 401);
  check('带 cookie 的请求不放行', (await fetch(`${assetOrigin}/api/asset/media/${hash}`, { headers: { cookie: 'session=anything', authorization: `Bearer ${ticket.A}` } })).status === 400);
  check('乙的票据在查询串里点名项目一被拒', await status('B', `/api/asset/media/${hash}?projectId=${encodeURIComponent(projects[0])}`) === 403);
  check('甲的票据在查询串里点名项目二被拒', await status('A', `/api/asset/media/${hash}?projectId=${encodeURIComponent(projects[1])}`) === 403);
  check('素材服务的内部口不在公开端口上', await status('A', '/internal/v2/asset/status') === 404);

  /* ---------------- 入口一：/api/asset 三个命名空间 ---------------- */
  for (const ns of ['media', 'snap', 'px']) {
    if (ns !== 'media') check(`${ns}：甲上传`, await upload('A', ns, bytes) === 200);
    const route = `/api/asset/${ns}/${hash}`;
    for (const [label, options, ok] of [['GET', {}, 200], ['HEAD', { method: 'HEAD' }, 200], ['Range', { headers: { range: 'bytes=2-6' } }, 206]]) {
      check(`${ns}：乙凭哈希 ${label} 读不到项目一的`, await status('B', route, options) === 404);
      check(`${ns}：甲 ${label} 照常`, await status('A', route, options) === ok);
      check(`${ns}：丙（项目一成员）${label} 照常`, await status('C', route, options) === ok);
    }
    const chunks = await json('B', `${route}/chunks`);
    check(`${ns}：乙对账看不到项目一的分片`, chunks.status === 200 && chunks.body?.size === null && chunks.body?.received?.length === 0 && chunks.body?.complete === false, chunks.body);
    check(`${ns}：乙替项目一的哈希收尾被拒`, await status('B', `${route}/complete`, { method: 'POST' }) === 404);
    check(`${ns}：乙用查询串票据读不到`, await bare(`${route}?t=${ticket.B}`) === 404);
    check(`${ns}：甲用查询串票据照常`, await bare(`${route}?t=${ticket.A}`) === 200);
    // 甲只传了一片、还没收尾的另一份：乙不能替它收尾，也看不到它的分片
    const half = Buffer.concat([bytes, Buffer.from(`half-${ns}`)]), halfHash = sha(half);
    check(`${ns}：甲传一片不收尾`, await status('A', `/api/asset/${ns}/${halfHash}/0`, { method: 'PUT', headers: { 'x-media-size': String(half.length), 'x-media-ext': 'wav' }, body: half }) === 200);
    const halfChunks = await json('B', `/api/asset/${ns}/${halfHash}/chunks`);
    check(`${ns}：乙看不到甲收了一半的分片`, halfChunks.body?.size === null && halfChunks.body?.received?.length === 0, halfChunks.body);
    check(`${ns}：甲传的分片乙收不了尾`, await status('B', `/api/asset/${ns}/${halfHash}/complete`, { method: 'POST' }) === 404);
    check(`${ns}：甲自己收尾照常`, await status('A', `/api/asset/${ns}/${halfHash}/complete`, { method: 'POST' }) === 200);
  }
  check('只读查询串票据不能写', (await fetch(`${assetOrigin}/api/asset/media/${hash}/complete?t=${ticket.A}`, { method: 'POST' })).status === 401);

  /* ---------------- 入口二：/@media、PCM、/api/media/* ---------------- */
  for (const [label, route] of [['/@media/<hash>', `/@media/${hash}`], ['/@media/<hash>.<ext>', `/@media/${hash}.wav`]]) {
    check(`${label}：乙读不到`, await status('B', route) === 404);
    check(`${label}：甲照常`, await status('A', route) === 200);
    check(`${label}：丙照常`, await status('C', route) === 200);
  }
  const pcmRoute = `/@media/${hash}/pcm?start=0&count=480&sampleRate=48000`;
  check('PCM：乙读不到', await status('B', pcmRoute) === 404);
  const pcm = await req('A', pcmRoute), pcmBytes = Buffer.from(await pcm.arrayBuffer());
  check('PCM：甲解得出样本', pcm.status === 200 && pcmBytes.length === 480 * 2 * 4 && pcmBytes.some(b => b !== 0), { status: pcm.status, bytes: pcmBytes.length });
  const localB = await json('B', `/api/media/local?hashes=${hash}`), localA = await json('A', `/api/media/local?hashes=${hash}`);
  check('local：乙问不出项目一有这个哈希', localB.status === 200 && Array.isArray(localB.body?.hashes) && localB.body.hashes.length === 0, localB.body);
  check('local：甲问得到', localA.body?.hashes?.includes(hash), localA.body);
  const tiersB = await json('B', `/api/media/tiers?hashes=${hash}`);
  check('tiers：乙只得到「没登记过」', tiersB.status === 200 && tiersB.body?.items?.[hash]?.state === 'unknown', tiersB.body);
  const backfillB = await json('B', '/api/media/tiers/backfill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ hash, name: 'x.wav' }] }) });
  check('tiers/backfill：乙得到「本地没有」', backfillB.status === 200 && backfillB.body?.items?.[hash]?.state === 'absent', backfillB.body);
  const backfillA = await json('A', '/api/media/tiers/backfill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ hash, name: 'x.wav' }] }) });
  check('tiers/backfill：甲的那份查得到（不是「本地没有」）', backfillA.status === 200 && backfillA.body?.items?.[hash]?.state !== 'absent', backfillA.body);
  const enqueueB = await json('B', '/api/media/upload-queue/enqueue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes: [hash] }) });
  check('upload-queue/enqueue：乙排不进项目一的哈希', enqueueB.status === 200 && !(enqueueB.body?.queued ?? []).includes(hash) && (enqueueB.body?.ok === false || (enqueueB.body?.missing ?? []).includes(hash)), enqueueB.body);
  const queueB = await json('B', '/api/media/upload-queue');
  check('upload-queue：乙的队列状态里没有项目一的哈希', queueB.status === 200 && !JSON.stringify(queueB.body).includes(hash), queueB.body);
  const targetB = await json('B', '/api/media/upload-queue/target', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ base: `${assetOrigin}/api/asset`, ticket: ticket.A }) });
  check('upload-queue/target：乙不能把上传目标设成甲的票据', targetB.status === 403, targetB);
  const remoteB = await json('B', '/api/media/remote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ base: `${assetOrigin}/api/asset`, ticket: ticket.A }) });
  check('remote：乙不能把拉取来源设成甲的票据', remoteB.status === 403, remoteB);
  const remoteStatusB = await json('B', '/api/media/remote');
  check('remote：乙的拉取来源仍是空的', remoteStatusB.status === 200 && (remoteStatusB.body?.base ?? null) === null, remoteStatusB.body);
  const prefetchB = await json('B', '/api/media/prefetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ hash, name: 'x.wav' }] }) });
  check('prefetch：乙预取项目一的哈希后仍读不到', prefetchB.status === 200 && await status('B', `/@media/${hash}`) === 404, prefetchB);
  const originalsB = await json('B', '/api/media/originals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes: [hash] }) });
  check('originals：乙问不出项目一这份素材原尺寸在不在', originalsB.status === 200 && (originalsB.body?.remote ?? null) === null && !JSON.stringify(originalsB.body?.present ?? '').includes(hash), originalsB.body);
  const physical = path.join(projectRoot(0), 'out', 'media', `${hash}.wav`);
  check('项目一的文件确实落在项目一自己的目录里', fs.existsSync(physical));
  check('file?path=：乙点名项目一的磁盘路径被拒', await status('B', `/api/media/file?path=${encodeURIComponent(physical)}`) === 403);
  check('adopt?path=：乙收编项目一的磁盘路径被拒', await status('B', `/api/media/adopt?path=${encodeURIComponent(physical)}`, { method: 'POST' }) === 403);
  check('file?path=：点名项目目录以外的路径被拒', await status('A', `/api/media/file?path=${encodeURIComponent(path.join(dir, 'ca.key'))}`) === 403);
  // 成员写：丙经整件上传口传一份新的进项目一
  const fresh = Buffer.concat([bytes, Buffer.from('member-upload')]), freshHash = sha(fresh);
  const uploaded = await json('C', '/api/media/upload/member.wav', { method: 'POST', body: fresh });
  check('upload：丙（成员）整件上传进项目一', uploaded.status === 200 && uploaded.body?.hash === freshHash && uploaded.body?.projectId === projects[0], uploaded.body);
  check('upload：甲读得到丙传的', await status('A', `/@media/${freshHash}`) === 200);
  check('upload：乙读不到丙传的', await status('B', `/@media/${freshHash}`) === 404 && await status('B', `/api/asset/media/${freshHash}`) === 404);
  check('丙（成员）分片上传进项目一的 media', await upload('C', 'media', Buffer.concat([bytes, Buffer.from('member-chunks')])) === 200);

  /* ---------------- 入口三：镜头缩略图、素材服务上的流读口 ---------------- */
  const thumbDir = path.join(projectRoot(0), 'out', 'shots'); await fsp.mkdir(thumbDir, { recursive: true }); await fsp.writeFile(path.join(thumbDir, 'same.jpg'), bytes);
  for (const method of ['GET', 'HEAD']) {
    check(`缩略图 ${method}：甲照常`, await status('A', '/api/shots/thumb/same.jpg', { method }) === 200);
    check(`缩略图 ${method}：丙照常`, await status('C', '/api/shots/thumb/same.jpg', { method }) === 200);
    check(`缩略图 ${method}：乙凭文件名读不到`, await status('B', '/api/shots/thumb/same.jpg', { method }) === 404);
  }
  const streams = new StreamStore(path.join(assetDir, 'streams'), { ownership: { projectId: projects[0], assert: async () => {} } });
  const streamKey = 'a'.repeat(64), initId = 'b'.repeat(16), segment = `0-${'c'.repeat(16)}.m4s`;
  await streams.writeFile(streams.initFile(streamKey, initId), bytes); await streams.writeFile(streams.segFile(streamKey, segment), bytes);
  await streams.save({ streamKey, kind: 'card', fps: 30, inits: { [initId]: { codec: 'fixture' } }, segments: { 0: { init: initId, file: segment, stride: 1, samples: 15 } } });
  for (const tail of ['manifest', `init/${initId}`, `seg/${segment}`]) {
    check(`素材服务的流读口 ${tail.split('/')[0]}：甲照常`, await status('A', `/stream/${streamKey}/${tail}`) === 200);
    check(`素材服务的流读口 ${tail.split('/')[0]}：丙照常`, await status('C', `/stream/${streamKey}/${tail}`) === 200);
    check(`素材服务的流读口 ${tail.split('/')[0]}：乙凭流键读不到`, await status('B', `/stream/${streamKey}/${tail}`) === 404);
  }
  check('素材服务的流读口：没有票据被拒', await bare(`/stream/${streamKey}/manifest`) === 401);

  /* ---------------- 同一个哈希，乙自己也传一份 ---------------- */
  for (const ns of ['media', 'snap', 'px']) {
    check(`${ns}：乙自己上传同样的字节`, await upload('B', ns, bytes) === 200);
    const own = await req('B', `/api/asset/${ns}/${hash}`);
    check(`${ns}：乙读到的是自己项目里的那份`, own.status === 200 && Buffer.from(await own.arrayBuffer()).equals(bytes));
  }
  check('两个项目各有一份物理文件', fs.existsSync(physical) && fs.existsSync(path.join(projectRoot(1), 'out', 'media', `${hash}.wav`)) && projectRoot(0) !== projectRoot(1));

  /* ---------------- 撤销一：甲踢掉丙，丙正在读的流被关 ---------------- */
  const big = Buffer.alloc(40 * 1024 * 1024); for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE((i * 2654435761) >>> 0, i);
  const bigHash = sha(big);
  for (const ns of ['media', 'snap', 'px']) check(`大件传进项目一（${ns}）`, await upload('A', ns, big, 'bin') === 200);
  check('大件传进项目二（media）', await upload('B', 'media', big, 'bin') === 200);
  const openStalled = async who => { const reads = {};
    for (const ns of ['media', 'snap', 'px']) reads[`/api/asset/${ns}`] = await stalledRead(`/api/asset/${ns}/${bigHash}`, ticket[who]);
    reads['/@media'] = await stalledRead(`/@media/${bigHash}`, ticket[who]);
    return reads; };
  const readsC = await openStalled('C'), readA = await stalledRead(`/api/asset/media/${bigHash}`, ticket.A);
  const readB = await stalledRead(`/api/asset/media/${bigHash}`, ticket.B), readB2 = await stalledRead(`/@media/${bigHash}`, ticket.B);
  for (const [label, read] of Object.entries(readsC)) check(`丙开始读 ${label}（读到一半停住）`, read.status === 200 && read.got() > 0 && read.got() < big.length && !read.ended(), { status: read.status, got: read.got() });
  // 素材服务处理撤销事件的进度：每处理完一条（正在读的流真的关掉之后才算），把序号持久记进这个文件并回执给文档服务
  const cursorOf = async () => { try { const saved = JSON.parse(await fsp.readFile(path.join(assetDir, 'access-cursor.json'), 'utf8')); return saved.pending ? saved.cursor : saved.cursor; } catch { return -1; } };
  const statusA = await web('GET', `/hosted/shared/account/status?authorityId=${authorityId}&projectId=${encodeURIComponent(projects[0])}`, null, editors[0].accessToken);
  const kickedAt = Date.now();
  const kicked = await web('POST', '/hosted/shared/account/admin', { projectId: projects[0], op: 'kick', accountId: ids[2], expectedAccessRevision: statusA.body.accessRevision, requestId: 'kick-c' }, editors[0].accessToken);
  check('甲踢掉丙', kicked.status === 200, kicked);
  const kickSeq = Number(String(kicked.body?.eventId ?? '').split(':').pop());
  // 客户端这时仍停着不读：服务端要自己把流关掉、回执才发得出去，不靠客户端继续读来触发
  const acked = Number.isInteger(kickSeq) && await waitFor(async () => await cursorOf() >= kickSeq, '素材服务处理完踢人事件').then(() => true, () => false);
  const closeMs = Date.now() - kickedAt;
  check('踢人事件：素材服务在客户端仍停着时就关完流并回执', acked, { kickSeq, cursor: await cursorOf() });
  const endsC = await Promise.all(Object.values(readsC).map(read => { read.resume(); return Promise.race([read.closed, sleep(30000).then(() => null)]); }));
  for (const [n, label] of Object.keys(readsC).entries()) {
    const end = endsC[n];
    check(`踢人后丙正在读的 ${label} 已被服务端掐断（接着读也读不完）`, end !== null && end.complete === false && end.bytes < big.length, end ?? '30 秒内没有结束');
  }
  for (const [label, route, options] of [['GET', `/api/asset/media/${hash}`], ['HEAD', `/api/asset/media/${hash}`, { method: 'HEAD' }], ['Range', `/api/asset/media/${hash}`, { headers: { range: 'bytes=0-1' } }],
    ['chunks', `/api/asset/media/${hash}/chunks`], ['snap', `/api/asset/snap/${hash}`], ['px', `/api/asset/px/${hash}`], ['/@media', `/@media/${hash}`], ['PCM', pcmRoute],
    ['local', `/api/media/local?hashes=${hash}`], ['缩略图', '/api/shots/thumb/same.jpg'], ['流读口', `/stream/${streamKey}/manifest`],
    ['分片写', `/api/asset/media/${'d'.repeat(64)}/0`, { method: 'PUT', headers: { 'x-media-size': '4' }, body: Buffer.from('nope') }], ['整件上传', '/api/media/upload/again.wav', { method: 'POST', body: bytes }]]) {
    const code = await status('C', route, options);
    check(`踢人后丙的新请求被拒：${label}`, code === 401 || code === 403, code);
  }
  const sessionC = await session(2, 0, 'session-C-after-kick');
  check('踢人后丙开不出新会话', sessionC.status !== 200 && !sessionC.body.assetTicket, sessionC.status);
  readA.resume(); const doneA = await Promise.race([readA.closed, sleep(60000).then(() => null)]);
  check('踢人不影响甲正在读的流：接着读完整件', doneA?.complete === true && doneA.bytes === big.length, doneA);
  readB2.resume(); const doneB2 = await Promise.race([readB2.closed, sleep(60000).then(() => null)]);
  check('踢人不影响乙正在读的流：接着读完整件', doneB2?.complete === true && doneB2.bytes === big.length, doneB2);
  check('踢人后甲的新请求照常', await status('A', `/api/asset/media/${hash}`) === 200 && await status('A', `/@media/${hash}`) === 200);

  /* ---------------- 撤销二：乙的登录被退出 ---------------- */
  const logout = provider.logoutLogin(editors[1].loginId, Date.now());
  await combo.accountRuntime.authority.synchronize();
  const logoutAcked = await waitFor(() => combo.accountRuntime.authority.revocationStatus(logout.eventId)?.serviceAcks?.asset?.complete === true, '素材服务确认退出登录已处理完').then(() => true, () => false);
  const logoutAck = combo.accountRuntime.authority.revocationStatus(logout.eventId)?.serviceAcks?.asset;
  check('退出登录：素材服务在客户端仍停着时就关掉流并向文档服务回执', logoutAcked && logoutAck?.complete === true && logoutAck.closedStreams?.length >= 1, logoutAck ? { complete: logoutAck.complete, closedStreams: logoutAck.closedStreams?.length } : null);
  readB.resume(); const endB = await Promise.race([readB.closed, sleep(30000).then(() => null)]);
  check('退出登录后乙正在读的流已被服务端掐断（接着读也读不完）', endB !== null && endB.complete === false && endB.bytes < big.length, endB ?? '30 秒内没有结束');
  for (const [label, route, options] of [['GET', `/api/asset/media/${hash}`], ['Range', `/api/asset/media/${hash}`, { headers: { range: 'bytes=0-1' } }], ['/@media', `/@media/${hash}`], ['chunks', `/api/asset/px/${hash}/chunks`]]) {
    const code = await status('B', route, options);
    check(`退出登录后乙旧票据的新请求被拒：${label}`, code === 401 || code === 403, code);
  }
  const relogin = login(1, 'probe-device-1b');
  const sessionB2 = await session(1, 1, 'session-B-relogin', relogin.accessToken, 'probe-device-1b');
  check('乙重新登录后开得出会话', sessionB2.status === 200 && !!sessionB2.body.assetTicket, sessionB2.status);
  ticket.B = sessionB2.body.assetTicket;
  const again = await req('B', `/api/asset/media/${hash}`);
  check('乙重新登录后读自己项目的照常', again.status === 200 && Buffer.from(await again.arrayBuffer()).equals(bytes));
  check('乙重新登录后仍读不到项目一独有的', await status('B', `/@media/${freshHash}`) === 404);
  check('全程甲读自己项目的照常', await status('A', `/api/asset/snap/${hash}`) === 200 && await status('A', `/api/asset/px/${hash}`) === 200);
  checks.push({ name: '（记录）踢人到素材服务关完流并回执的耗时毫秒数，只记录不当通过条件', passed: true, detail: closeMs });
} catch (error) {
  check('探针异常', false, { message: error.message, stack: error.stack });
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await childClosed; }
  await combo?.close().catch(() => {});
  if (accountServer?.listening) await closeServer(accountServer);
  try { provider?.close(); } catch { /* 已关 */ }
  await fsp.writeFile(path.join(out, 'asset-child.log'), childLog);
}
const result = { v: 1, scope: 'local-isolated-hosted-combo', ports: PORT, passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, checks };
await fsp.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
if (!args.includes('--keep')) { for (const name of ['doc', 'asset', 'app']) await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {}); for (const name of await fsp.readdir(dir)) if (/\.(key|crt|csr|srl|txt|sqlite.*)$/.test(name)) await fsp.rm(path.join(dir, name), { force: true }).catch(() => {}); }
console.log(JSON.stringify({ out, passed: result.passed, failed: result.failed, failedNames: checks.filter(c => !c.passed).map(c => c.name) }));
process.exit(result.failed ? 1 : 0);
