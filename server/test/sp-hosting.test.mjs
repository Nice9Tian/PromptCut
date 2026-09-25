/**
 * SP 托管组合的实现方自测（契约 `docs/plan/shared-project-contract.md` 第 1、2 节、第 6 节 migrate-check、第 7 节 SP1 / SP3 / SP7）。
 * 用例名前缀 SPH。跑：node --test server/test/sp-hosting.test.mjs
 *
 * - 组合在本进程里起（`server/hosted/combo.mjs`，端口 0，只绑回环）；失败即关的几条起 `server/hosted/main.mjs` 子进程，
 *   按退出码与 `config.error` 判；
 * - 「非回环来源」用 `trustLoopback: false` 模拟：素材服务与管理接口不再把本机回环当自己人（文档服务的握手本来就按证明判）；
 * - migrate-check 起 `scripts/probes/shared-project-probe.mjs` 子进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startHostedCombo, readClusterToken, hostedPaths, HOSTED_ANNOUNCER_ID } from '../hosted/combo.mjs';
import { stageHostedFiles, HOSTED_DEPLOY_DIRS, HOSTED_DEPLOY_FILES } from '../hosted/files.mjs';
import { createFsStore, ensureLayoutSync, readLayoutSync, LAYOUTS, LAYOUT_FILE } from '../asset-store/fs-store.mjs';
import { createAssetClient } from '../asset-store/client.mjs';
import { createSharedProject, buildAuthProtocols } from '../auth/client.mjs';
import { forgetCredentialStore } from '../auth/store.mjs';
import { createWsEndpoint } from '../render-node/ws-transport.mjs';
import { createTicketSource } from '../auth/ticket-source.mjs';
import { hostedInstance, hostedPm2Config, hostedDeployScript } from '../hosted/deploy.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MAIN = path.join(ROOT, 'server', 'hosted', 'main.mjs');
const PROBE = path.join(ROOT, 'scripts', 'probes', 'shared-project-probe.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sp-hosting-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

let seq = 0;
const newDir = (label) => {
  const d = path.join(TMP, `${label}-${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => crypto.randomBytes(32).toString('base64url');

/** 同一套组合参数：端口 0、只绑回环、日志收进数组 */
async function combo(dataDir, extra = {}) {
  const logs = [];
  const c = await startHostedCombo({
    dataDir, docPort: 0, assetPort: 0, host: '127.0.0.1', log: (event, fields) => logs.push({ event, ...fields }), ...extra,
  });
  c.logs = logs;
  return c;
}
async function closeCombo(c) {
  await c.close();
  forgetCredentialStore(c.paths.auth);
}

/** 一条凭证连接 + 按 reqId 配对的请求 */
async function connect(c, { projectId, username, password, as = 'member', role = 'page' }) {
  const base = `http://127.0.0.1:${c.docPort}`;
  const deviceId = `test-device-${crypto.randomBytes(6).toString('hex')}`;
  const ep = createWsEndpoint({
    url: `ws://127.0.0.1:${c.docPort}`,
    protocols: () => buildAuthProtocols({ base, projectId, username, deviceId, deviceName: 'sph', as, password, role }),
    backoff: { baseMs: 50, maxMs: 200 },
  });
  const waiting = new Map();
  let n = 0;
  ep.onMessage((m) => {
    const w = m?.reqId !== undefined ? waiting.get(m.reqId) : undefined;
    if (!w) return;
    w.got.push(m);
    if (m.type === 'error' || !w.until || w.until(m)) { waiting.delete(m.reqId); w.resolve(w.until ? w.got : m); }
  });
  const rpc = (msg, until) => new Promise((resolve, reject) => {
    const reqId = `t${++n}`;
    const timer = setTimeout(() => reject(new Error(`等 ${msg.type} 超时`)), 10_000);
    waiting.set(reqId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, until, got: [] });
    ep.send({ ...msg, reqId });
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连不上')), 10_000);
    ep.onOpen(() => { clearTimeout(t); resolve(); });
  });
  const endpoints = await new Promise((resolve) => {
    ep.onMessage((m) => { if (m?.type === 'service.endpoints') resolve(m.endpoints); });
    ep.send({ type: 'service.watch', kinds: ['asset'] });
  });
  return { ep, rpc, endpoints, close: () => new Promise((resolve) => { ep.onClose(resolve); ep.close(); setTimeout(resolve, 2000); }) };
}

async function newProject(c, name = `sph-${crypto.randomBytes(3).toString('hex')}`) {
  const creator = { username: 'creator', password: 'creator-pw-1' };
  const password = 'project-pw-1';
  const created = await createSharedProject({ base: `http://127.0.0.1:${c.docPort}`, name, mode: 'free', creator, password });
  return { ...created, creator, password };
}

/** 一轮：快照、内容库条目、一个素材、一个产物 */
async function oneRound(c, p) {
  const conn = await connect(c, { projectId: p.projectId, username: 'alice', password: p.password, role: 'render' });
  const text = JSON.stringify({ id: 'proj-1', note: 'sph' });
  const digest = sha256(text);
  const ann = await conn.rpc({ type: 'project.announce', projectId: 'proj-1', digest });
  assert.equal(ann.type, 'project.announced');
  const put = await conn.rpc({ type: 'project.snapshot.put', projectId: 'proj-1', projectRev: ann.projectRev, digest, index: 0, count: 1, data: text });
  assert.equal(put.complete, true, JSON.stringify(put));
  const st = await conn.rpc({ type: 'content.put', kind: 'render-manifest', key: 'k1', body: { a: 1 } });
  assert.equal(st.type, 'content.stored');
  const assetUrl = conn.endpoints.find((e) => e.kind === 'asset').urls[0];
  const client = createAssetClient({ base: assetUrl, ticket: createTicketSource(conn.ep, { access: 'rw' }) });
  const media = crypto.randomBytes(40_000);
  const px = Buffer.from(`artifact-${crypto.randomBytes(4).toString('hex')}`);
  await client.put('media', media, { ext: 'png' });
  await client.put('px', px, { ext: 'm4s' });
  await conn.close();
  return { text, digest, projectRev: ann.projectRev, media, px, assetUrl };
}

/** 起 main.mjs 子进程，等它退出或打出 listen 行 */
function runMain(env, { waitListen = false, ms = 20_000 } = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('PROMPTCUT_')) delete base[k];
  const child = spawn(process.execPath, [MAIN], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => {
    const done = (code) => resolve({ code, out, child });
    const t = setTimeout(() => { child.kill(); done('timeout'); }, ms);
    child.once('exit', (code) => { clearTimeout(t); done(code); });
    if (waitListen) {
      const iv = setInterval(() => {
        if (/"event":"listen"/.test(out)) { clearInterval(iv); clearTimeout(t); done('listening'); }
      }, 50);
      child.once('exit', () => clearInterval(iv));
    }
  });
}
const configErrorOf = (out) => {
  const line = out.split('\n').find((l) => l.includes('"config.error"'));
  return line ? JSON.parse(line) : null;
};

/* ================================================================== shard 布局 */

test('SPH-shard-1 分目录布局：全件在 <dir>/<hh>/<hash>.<ext>，暂存在 .chunks/<hash>/，入库后暂存删掉；list / usage 只数分目录里的全件', async () => {
  const dir = newDir('shard');
  const store = createFsStore({ dir, shard: true });
  assert.equal(store.layout, LAYOUTS.shard);
  const buf = crypto.randomBytes(3000);
  const h = sha256(buf);
  assert.equal((await store.putChunk(h, 0, { size: buf.length, ext: 'mp4' }, Readable.from([buf]))).status, 'ok');
  assert.ok(fs.existsSync(path.join(dir, '.chunks', h, 'data')), '暂存在 .chunks/<hash>/');
  assert.ok(fs.existsSync(path.join(dir, '.chunks', h, '0.ok')));
  assert.deepEqual(await store.complete(h), { status: 'ok', size: buf.length, ext: 'mp4' });
  const file = path.join(dir, h.slice(0, 2), `${h}.mp4`);
  assert.ok(fs.existsSync(file), '全件在前两位的子目录里');
  assert.ok(!fs.existsSync(path.join(dir, `${h}.mp4`)), '不在根上');
  assert.ok(!fs.existsSync(path.join(dir, '.chunks', h)), '暂存删掉了');
  assert.deepEqual(fs.readFileSync(file), buf);
  // 根上放一个同名的「原布局」文件：分目录布局不认它
  const other = crypto.randomBytes(10);
  fs.writeFileSync(path.join(dir, `${sha256(other)}.bin`), other);
  assert.equal(await store.stat(sha256(other)), null, '分目录布局不读根上的文件');
  // 不是哈希形状的文件、放错子目录（前两位对不上）的哈希文件都不算
  fs.writeFileSync(path.join(dir, h.slice(0, 2), 'readme.txt'), 'x');
  const stray = h.startsWith('00') ? `ff${h.slice(2)}` : `00${h.slice(2)}`;
  fs.writeFileSync(path.join(dir, h.slice(0, 2), `${stray}.bin`), 'y');
  assert.deepEqual(await store.list(), [{ hash: h, size: buf.length }]);
  assert.deepEqual(await store.usage(), { blobs: 1, bytes: buf.length, staging: 0 });
  assert.equal(await store.remove(h), true);
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(await store.list(), []);
});

test('SPH-shard-2 本机编辑器的原布局不变：不传 shard 时全件仍在 <dir>/<hash>.<ext>，layout 报 flat；两种布局互相读不到对方', async () => {
  const dir = newDir('flat');
  const flat = createFsStore({ dir });
  assert.equal(flat.layout, LAYOUTS.flat);
  const buf = crypto.randomBytes(500);
  const h = sha256(buf);
  await flat.putChunk(h, 0, { size: buf.length, ext: 'png' }, Readable.from([buf]));
  await flat.complete(h);
  assert.ok(fs.existsSync(path.join(dir, `${h}.png`)));
  assert.ok(!fs.existsSync(path.join(dir, h.slice(0, 2))), '原布局不建子目录');
  const sharded = createFsStore({ dir, shard: true });
  assert.equal(await sharded.stat(h), null, '分目录布局读不到原布局的文件——所以要 .layout 标记');
  const buf2 = crypto.randomBytes(501);
  const h2 = sha256(buf2);
  await sharded.putChunk(h2, 0, { size: buf2.length }, Readable.from([buf2]));
  await sharded.complete(h2);
  assert.equal(await flat.stat(h2), null, '原布局读不到分目录布局的文件');
});

test('SPH-layout-1 ensureLayoutSync：空目录写标记；同布局通过；不同布局、来历不明的内容、坏标记都拒绝', () => {
  const dir = path.join(newDir('layout'), 'assets');
  assert.equal(readLayoutSync(dir), null);
  assert.deepEqual(ensureLayoutSync(dir, LAYOUTS.shard), { ok: true, created: true });
  assert.deepEqual(readLayoutSync(dir), { v: 1, layout: 'shard2' });
  assert.deepEqual(ensureLayoutSync(dir, LAYOUTS.shard), { ok: true, created: false });
  assert.deepEqual(ensureLayoutSync(dir, LAYOUTS.flat), { ok: false, found: 'shard2' });

  const dir2 = newDir('layout-unmarked');
  fs.mkdirSync(path.join(dir2, 'media'));
  assert.deepEqual(ensureLayoutSync(dir2, LAYOUTS.shard), { ok: false, found: 'unmarked' });
  assert.equal(fs.existsSync(path.join(dir2, LAYOUT_FILE)), false, '拒绝时不写标记');

  const dir3 = newDir('layout-bad');
  fs.writeFileSync(path.join(dir3, LAYOUT_FILE), 'not json');
  assert.deepEqual(ensureLayoutSync(dir3, LAYOUTS.shard), { ok: false, found: 'unreadable' });
});

/* ================================================================== 失败即关（main.mjs 子进程） */

test('SPH-failclosed-1 数据目录没设、不存在、是个文件 → 退出码 1、config.error data-dir', { timeout: 60_000 }, async () => {
  const unset = await runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0' });
  assert.equal(unset.code, 1, unset.out);
  assert.equal(configErrorOf(unset.out)?.reason, 'data-dir');

  const missing = await runMain({ PROMPTCUT_DATA_DIR: path.join(TMP, 'no-such-dir'), PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0' });
  assert.equal(missing.code, 1, missing.out);
  assert.equal(configErrorOf(missing.out)?.reason, 'data-dir');
  assert.equal(fs.existsSync(path.join(TMP, 'no-such-dir')), false, '不替人建数据目录本身');

  const file = path.join(newDir('file'), 'data');
  fs.writeFileSync(file, 'x');
  const notDir = await runMain({ PROMPTCUT_DATA_DIR: file, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0' });
  assert.equal(notDir.code, 1, notDir.out);
  assert.equal(configErrorOf(notDir.out)?.reason, 'data-dir');
});

test('SPH-failclosed-2 assets/.layout 对不上、assets/ 有东西却没标记 → 退出码 1、config.error layout', { timeout: 60_000 }, async () => {
  const d1 = newDir('lay1');
  fs.mkdirSync(path.join(d1, 'assets'));
  fs.writeFileSync(path.join(d1, 'assets', LAYOUT_FILE), JSON.stringify({ v: 1, layout: 'flat' }));
  const r1 = await runMain({ PROMPTCUT_DATA_DIR: d1, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0' });
  assert.equal(r1.code, 1, r1.out);
  assert.deepEqual({ reason: configErrorOf(r1.out)?.reason, found: configErrorOf(r1.out)?.found }, { reason: 'layout', found: 'flat' });

  const d2 = newDir('lay2');
  fs.mkdirSync(path.join(d2, 'assets', 'media'), { recursive: true });
  fs.writeFileSync(path.join(d2, 'assets', 'media', `${'a'.repeat(64)}.png`), 'x');
  const r2 = await runMain({ PROMPTCUT_DATA_DIR: d2, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0' });
  assert.equal(r2.code, 1, r2.out);
  assert.equal(configErrorOf(r2.out)?.found, 'unmarked');
});

test('SPH-failclosed-3 令牌：secrets/cluster-token 优先于环境变量；格式不对 → bad-token-format，输出里没有令牌原文', { timeout: 60_000 }, async () => {
  const d = newDir('tok');
  const good = token();
  // readClusterToken 的优先级
  assert.deepEqual(readClusterToken(d, {}), { token: undefined, source: 'none', loose: false });
  assert.equal(readClusterToken(d, { PROMPTCUT_CLUSTER_TOKEN: good }).source, 'env');
  fs.mkdirSync(path.join(d, 'secrets'));
  fs.writeFileSync(path.join(d, 'secrets', 'cluster-token'), `${good}\n`, { mode: 0o600 });
  const fromFile = readClusterToken(d, { PROMPTCUT_CLUSTER_TOKEN: 'ignored' });
  assert.equal(fromFile.token, good);
  assert.equal(fromFile.source, 'file');

  const bad = 'short!token';
  fs.writeFileSync(path.join(d, 'secrets', 'cluster-token'), bad);
  const r = await runMain({ PROMPTCUT_DATA_DIR: d, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0' });
  assert.equal(r.code, 1, r.out);
  assert.equal(configErrorOf(r.out)?.reason, 'bad-token-format');
  assert.equal(configErrorOf(r.out)?.source, 'file');
  assert.ok(!r.out.includes(bad), '输出里没有令牌原文');
});

test('SPH-failclosed-4 绑非回环：没设 PROMPTCUT_ASSET_PUBLIC_URL → asset-public-url；凭证存储打不开 → auth-store；都退出码 1', { timeout: 60_000 }, async () => {
  // 「非回环」用 127.0.0.2（同 docservice-auth A6：main 按字面判回环，127.0.0.2 仍在回环网卡上，不弹防火墙）
  const d = newDir('nonloop');
  const r1 = await runMain({ PROMPTCUT_DATA_DIR: d, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.2', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0' });
  assert.equal(r1.code, 1, r1.out);
  assert.equal(configErrorOf(r1.out)?.reason, 'asset-public-url');

  const d2 = newDir('authstore');
  fs.mkdirSync(path.join(d2, 'docservice'));
  fs.writeFileSync(path.join(d2, 'docservice', 'auth'), 'not a directory');
  const r2 = await runMain({
    PROMPTCUT_DATA_DIR: d2, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.2', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0',
    PROMPTCUT_ASSET_PUBLIC_URL: 'http://127.0.0.2:1/api/asset',
  });
  assert.equal(r2.code, 1, r2.out);
  assert.equal(configErrorOf(r2.out)?.reason, 'auth-store');
});

test('SPH-failclosed-5 端口被占 → 退出码 1、config.error listen；正常时 listen 行带两个端口与布局', { timeout: 60_000 }, async (t) => {
  const d = newDir('listen');
  const ok = await runMain({ PROMPTCUT_DATA_DIR: d, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0' }, { waitListen: true });
  t.after(() => ok.child.kill());
  assert.equal(ok.code, 'listening', ok.out);
  const listen = JSON.parse(ok.out.split('\n').find((l) => l.includes('"event":"listen"')));
  assert.ok(listen.docservice.port > 0 && listen.asset.port > 0);
  assert.equal(listen.asset.announced, true, '素材服务向本进程的文档服务登记成功');
  assert.equal(readLayoutSync(path.join(d, 'assets')).layout, 'shard2');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(d, 'secrets')).mode & 0o777, 0o700);

  const d2 = newDir('listen2');
  const clash = await runMain({ PROMPTCUT_DATA_DIR: d2, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: String(listen.docservice.port), PROMPTCUT_ASSET_PORT: '0' });
  assert.equal(clash.code, 1, clash.out);
  assert.equal(configErrorOf(clash.out)?.reason, 'listen');
});

/* ================================================================== 507 */

test('SPH-507 数据层报 ENOSPC / EDQUOT：分片与收尾回 507 insufficient-storage，不算收到、不入库，已收的分片保留，腾出空间后续传成功', async (t) => {
  const d = newDir('full');
  const full = { put: null, complete: false };
  const c = await combo(d, {
    wrapStore: (ns, st) => ({
      ...st,
      async putChunk(hash, n, info, source) {
        if (full.put !== null && n === full.put) {
          for await (const _ of source) { /* 读完请求体 */ }
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        return st.putChunk(hash, n, info, source);
      },
      async complete(hash) {
        if (full.complete) throw Object.assign(new Error('quota'), { code: 'EDQUOT' });
        return st.complete(hash);
      },
    }),
  });
  t.after(() => closeCombo(c));
  const base = `http://127.0.0.1:${c.assetPort}/api/asset`;
  const CS = 8 * 1024 * 1024;
  const buf = crypto.randomBytes(CS + 100);
  const h = sha256(buf);
  const put = (n, body) => fetch(`${base}/media/${h}/${n}`, { method: 'PUT', headers: { 'X-Media-Size': String(buf.length), 'X-Media-Ext': 'mp4' }, body });

  full.put = 1;
  assert.equal((await put(0, buf.subarray(0, CS))).status, 200);
  const r1 = await put(1, buf.subarray(CS));
  assert.equal(r1.status, 507);
  assert.deepEqual(await r1.json(), { ok: false, error: 'insufficient-storage' });
  let chunks = await (await fetch(`${base}/media/${h}/chunks`)).json();
  assert.deepEqual(chunks.received, [0], '满盘那一片不算收到，已收的第 0 片保留');

  full.put = null;
  assert.equal((await put(1, buf.subarray(CS))).status, 200);
  full.complete = true;
  const r2 = await fetch(`${base}/media/${h}/complete`, { method: 'POST' });
  assert.equal(r2.status, 507);
  assert.deepEqual(await r2.json(), { ok: false, error: 'insufficient-storage' });
  chunks = await (await fetch(`${base}/media/${h}/chunks`)).json();
  assert.deepEqual({ received: chunks.received, complete: chunks.complete }, { received: [0, 1], complete: false }, '收尾失败不标记完成，分片都还在');
  assert.equal((await fetch(`${base}/media/${h}`, { method: 'HEAD' })).status, 404);

  full.complete = false;
  assert.equal((await fetch(`${base}/media/${h}/complete`, { method: 'POST' })).status, 200);
  const got = Buffer.from(await (await fetch(`${base}/media/${h}`)).arrayBuffer());
  assert.equal(sha256(got), h);
  assert.ok(fs.existsSync(path.join(d, 'assets', 'media', h.slice(0, 2), `${h}.mp4`)), '落在分目录布局里');
});

/* ================================================================== SP1 */

test('SPH-SP1 托管组合：成员不设令牌凭项目凭证进入；从 service.endpoints 拿到素材服务公网地址；快照读取、票据读写成功；管理接口要令牌', async (t) => {
  const d = newDir('sp1');
  const tok = token();
  const c = await combo(d, { clusterToken: tok, trustLoopback: false, assetPublicUrl: undefined });
  t.after(() => closeCombo(c));
  assert.equal(c.announced, true, '素材服务带集群令牌向本进程文档服务登记成功');
  assert.ok(c.logs.some((l) => l.event === 'asset.announce' && l.via === 'cluster-token'));
  const p = await newProject(c);

  // 不带任何凭证的非回环握手在别的用例（AU 系列）里测；这里只确认成员凭证能进、拿得到地址
  const conn = await connect(c, { projectId: p.projectId, username: 'bob', password: p.password, role: 'render' });
  t.after(() => conn.close());
  const asset = conn.endpoints.find((e) => e.kind === 'asset' && e.announcerId === HOSTED_ANNOUNCER_ID);
  assert.deepEqual(asset?.urls, [c.assetPublicUrl]);

  // 快照
  const text = JSON.stringify({ sp1: true });
  const digest = sha256(text);
  const ann = await conn.rpc({ type: 'project.announce', projectId: 'p1', digest });
  await conn.rpc({ type: 'project.snapshot.put', projectId: 'p1', projectRev: ann.projectRev, digest, index: 0, count: 1, data: text });
  const parts = await conn.rpc({ type: 'project.snapshot.get', projectId: 'p1', projectRev: ann.projectRev }, (m) => m.type === 'project.snapshot.end');
  assert.equal(parts.filter((m) => m.type === 'project.snapshot.part').map((m) => m.data).join(''), text);

  // 票据读写
  const rw = createTicketSource(conn.ep, { access: 'rw' });
  const r = createTicketSource(conn.ep, { access: 'r' });
  const base = c.assetPublicUrl;
  const client = createAssetClient({ base, ticket: rw });
  const media = crypto.randomBytes(10_000);
  const h = sha256(media);
  const noTicket = createAssetClient({ base });
  await assert.rejects(noTicket.put('media', media), (err) => err.status === 401, '不带票据写 401');
  assert.equal((await client.put('media', media, { ext: 'png' })).uploaded, true, 'rw 票据写成功');
  assert.deepEqual(await client.get('media', h), media, 'Bearer 读成功');
  assert.equal((await fetch(`${base}/media/${h}`)).status, 401, '不带票据读 401');
  const rq = await fetch(`${base}/media/${h}?t=${encodeURIComponent(await r())}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(rq.status, 206, '查询串只读票据 Range 读');
  assert.equal(rq.headers.get('cache-control'), 'no-store');
  const ro = createAssetClient({ base, ticket: r });
  await assert.rejects(ro.put('px', Buffer.from('x')), (err) => err.status === 403, '只读票据写 403');

  // 管理接口：不带令牌 401，带令牌 200
  const origin = new URL(base).origin;
  assert.equal((await fetch(`${origin}/admin/inventory`)).status, 401);
  assert.equal((await fetch(`${origin}/admin/inventory`, { headers: { Authorization: `Bearer ${token()}` } })).status, 401);
  const inv = await (await fetch(`${origin}/admin/inventory`, { headers: { Authorization: `Bearer ${tok}` } })).json();
  assert.equal(inv.ok, true);
  assert.deepEqual(inv.assets.media.hashes, [h]);
  assert.equal(inv.spaces[p.projectId].projects.p1, ann.projectRev);
  const blob = await fetch(`${origin}/admin/blob/media/${h}`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(sha256(Buffer.from(await blob.arrayBuffer())), h);
  // 集群令牌不给素材服务数据面任何权限
  assert.equal((await fetch(`${base}/media/${h}`, { headers: { Authorization: `Bearer ${tok}` } })).status, 401);
});

/* ================================================================== SP3 */

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(path.join(e.parentPath ?? e.path, e.name));
  }
  return out;
}

test('SPH-SP3 一轮之后全部成员断开：新成员（重启前、重启后）取回的快照、内容库条目、素材、产物逐项一致，文件都在数据目录之下', async (t) => {
  const d = newDir('sp3');
  let c = await combo(d, { trustLoopback: false });
  const p = await newProject(c);
  const round = await oneRound(c, p);
  const invBefore = await c.inventory();

  async function newMemberCheck(cc) {
    const conn = await connect(cc, { projectId: p.projectId, username: 'carol', password: p.password });
    try {
      const parts = await conn.rpc({ type: 'project.snapshot.get', projectId: 'proj-1', projectRev: round.projectRev }, (m) => m.type === 'project.snapshot.end' || m.missing);
      assert.equal(parts.filter((m) => m.type === 'project.snapshot.part').map((m) => m.data).join(''), round.text, '快照');
      const listing = await conn.rpc({ type: 'content.list', kind: 'render-manifest' });
      assert.deepEqual(listing.items.map((i) => i.key), ['k1'], '内容库条目');
      const client = createAssetClient({ base: conn.endpoints.find((e) => e.kind === 'asset').urls[0], ticket: createTicketSource(conn.ep, { access: 'r' }) });
      assert.deepEqual(await client.get('media', sha256(round.media)), round.media, '素材');
      assert.deepEqual(await client.get('px', sha256(round.px)), round.px, '产物');
    } finally {
      await conn.close();
    }
  }
  await newMemberCheck(c);
  await closeCombo(c);
  c = await combo(d, { trustLoopback: false });
  t.after(() => closeCombo(c));
  await newMemberCheck(c);
  const invAfter = await c.inventory();
  assert.deepEqual(invAfter.spaces, invBefore.spaces, '重启后空间盘点一致');
  assert.deepEqual(invAfter.assets, invBefore.assets, '重启后素材盘点一致');
  assert.equal(invAfter.assets.media.count, 1);
  assert.equal(invAfter.assets.px.count, 1);

  // 文件都在数据目录之下，而且在契约第 1 节的布局里
  const P = hostedPaths(d);
  const files = walk(d).map((f) => path.relative(P.root, f).split(path.sep).join('/'));
  assert.ok(files.every((f) => !f.startsWith('..')));
  const inTenant = (f) => f.startsWith(`docservice/tenants/${p.projectId}/`);
  assert.ok(files.some((f) => inTenant(f) && /^.*projects\/.*\.ndjson$/.test(f)), '项目版本日志在 tenants/<projectId>/');
  assert.ok(files.some((f) => inTenant(f) && /projects\/.*@\d+\.json$/.test(f)), '项目快照在 tenants/<projectId>/');
  assert.ok(files.some((f) => inTenant(f) && /content\/render-manifest\.ndjson$/.test(f)), '内容库在 tenants/<projectId>/');
  assert.ok(files.includes(`docservice/auth/projects/${p.projectId}.json`), '凭证存储在 docservice/auth/');
  const mh = sha256(round.media);
  const ph = sha256(round.px);
  assert.ok(files.includes(`assets/media/${mh.slice(0, 2)}/${mh}.png`));
  assert.ok(files.includes(`assets/px/${ph.slice(0, 2)}/${ph}.m4s`));
  assert.ok(files.includes('assets/.layout'));
});

/* ================================================================== SP7 */

function runProbe(args, env = {}) {
  const base = { ...process.env };
  delete base.PROMPTCUT_CLUSTER_TOKEN;
  const child = spawn(process.execPath, [PROBE, ...args], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => child.once('exit', (code) => {
    const last = out.trim().split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"fails"'));
    resolve({ code, out, result: last ? JSON.parse(last) : null });
  }));
}

test('SPH-SP7 两份托管组合：停写、拷数据目录、两边都起来后 migrate-check 通过；新实例上少一个产物时不通过', { timeout: 120_000 }, async (t) => {
  const dA = newDir('sp7-a');
  const tok = token();
  fs.mkdirSync(path.join(dA, 'secrets'));
  fs.writeFileSync(path.join(dA, 'secrets', 'cluster-token'), `${tok}\n`, { mode: 0o600 });
  let a = await combo(dA, { clusterToken: readClusterToken(dA).token, trustLoopback: false });
  const p = await newProject(a);
  const round = await oneRound(a, p);
  await closeCombo(a); // 停写

  const dB = path.join(TMP, `sp7-b-${++seq}`);
  fs.cpSync(dA, dB, { recursive: true });
  a = await combo(dA, { clusterToken: tok, trustLoopback: false });
  t.after(() => closeCombo(a));
  const b = await combo(dB, { clusterToken: readClusterToken(dB).token, trustLoopback: false });
  t.after(() => closeCombo(b));
  assert.equal(readClusterToken(dB).source, 'file', '令牌随数据目录一起迁移');

  const ok = await runProbe(['--role', 'migrate-check', '--from', `http://127.0.0.1:${a.docPort}`, '--to', `ws://127.0.0.1:${b.docPort}`], { PROMPTCUT_CLUSTER_TOKEN: tok });
  assert.equal(ok.code, 0, ok.out.slice(-2000));
  assert.equal(ok.result.ok, true);
  assert.deepEqual(ok.result.sharedProjects, { from: 1, to: 1, equal: true });
  assert.equal(ok.result.sample.ok, 2, '素材 1 个 + 产物 1 个，全部重算 sha256 相符');
  assert.equal(ok.result.sample.ratio, 1);
  assert.deepEqual(ok.result.assetUrls, { from: a.assetPublicUrl, to: b.assetPublicUrl });

  // 没有令牌：管理接口不认（trustLoopback: false 等同于别的机器）→ 退出码 1
  const noTok = await runProbe(['--role', 'migrate-check', '--from', `http://127.0.0.1:${a.docPort}`, '--to', `http://127.0.0.1:${b.docPort}`]);
  assert.equal(noTok.code, 1);

  // 新实例少了一个产物
  const ph = sha256(round.px);
  fs.rmSync(path.join(dB, 'assets', 'px', ph.slice(0, 2), `${ph}.m4s`));
  const bad = await runProbe(['--role', 'migrate-check', '--from', `http://127.0.0.1:${a.docPort}`, '--to', `http://127.0.0.1:${b.docPort}`], { PROMPTCUT_CLUSTER_TOKEN: tok });
  assert.equal(bad.code, 1, bad.out.slice(-2000));
  assert.equal(bad.result.assets.px.equal, false);
});

/* ================================================================== 部署 */

test('SPH-deploy-1 部署清单是闭合的：按 files.mjs 拼出的暂存目录（没有仓库的其它文件）里 main.mjs 起得来、两个端口都通', { timeout: 60_000 }, async (t) => {
  const stage = path.join(newDir('stage'), 'app');
  const copied = stageHostedFiles(ROOT, stage);
  assert.ok(copied.some((f) => f.endsWith(path.join('server', 'hosted', 'main.mjs'))));
  assert.ok(!copied.some((f) => /[\\/]test[\\/]|\.test\./.test(f)), '不拷测试');
  for (const rel of [...HOSTED_DEPLOY_DIRS, ...HOSTED_DEPLOY_FILES]) assert.ok(fs.existsSync(path.join(stage, rel)), rel);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).type, 'module');
  const data = newDir('stage-data');
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('PROMPTCUT_')) delete base[k];
  const child = spawn(process.execPath, [path.join(stage, 'server', 'hosted', 'main.mjs')], {
    cwd: stage, env: { ...base, PROMPTCUT_DATA_DIR: data, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const until = Date.now() + 20_000;
  while (!/"event":"listen"/.test(out) && child.exitCode === null && Date.now() < until) await sleep(50);
  assert.match(out, /"event":"listen"/, out);
  const listen = JSON.parse(out.split('\n').find((l) => l.includes('"event":"listen"')));
  assert.equal((await fetch(`http://127.0.0.1:${listen.docservice.port}/healthz`)).status, 200);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${listen.asset.port}/healthz`)).json(), { ok: true, role: 'asset', layout: 'shard2' });
});

test('SPH-deploy-2 PM2 配置与远端脚本：两个实例的 app 名、端口、内存上限；fork、1 个实例、kill_timeout 5000；配置里没有令牌；脚本不碰 UFW', () => {
  const main = hostedInstance('main', {});
  const drill = hostedInstance('drill', {});
  assert.deepEqual([main.app, main.docPort, main.assetPort, main.maxMemory], ['promptcut-hosted', 8787, 8788, '700M']);
  assert.deepEqual([drill.app, drill.docPort, drill.assetPort, drill.maxMemory], ['promptcut-drill', 8777, 8778, '400M']);
  assert.notEqual(main.data, drill.data, '演练实例的数据目录另给');
  assert.throws(() => hostedInstance('prod', {}));

  const cfgText = hostedPm2Config(drill, '203.0.113.5');
  const mod = { exports: {} };
  new Function('module', cfgText)(mod);
  const [app] = mod.exports.apps;
  assert.equal(app.name, 'promptcut-drill');
  assert.equal(app.exec_mode, 'fork');
  assert.equal(app.instances, 1);
  assert.equal(app.kill_timeout, 5000);
  assert.equal(app.max_memory_restart, '400M');
  assert.equal(app.env.PROMPTCUT_ASSET_PUBLIC_URL, 'http://203.0.113.5:8778/api/asset');
  assert.equal(app.env.PROMPTCUT_DOCSERVICE_PUBLIC_URL, 'ws://203.0.113.5:8777');
  assert.equal(app.env.PROMPTCUT_DATA_DIR, drill.data);
  assert.ok(!('PROMPTCUT_CLUSTER_TOKEN' in app.env), 'PM2 配置里没有令牌');

  const tok = token();
  const withSave = hostedDeployScript(main, { pm2Config: hostedPm2Config(main, 'h'), save: true, replaceDocservice: false, token: null });
  assert.match(withSave, /pm2 startOrReload "\$DIR\/pm2\.config\.cjs" --update-env/);
  assert.match(withSave, /^pm2 save$/m);
  assert.doesNotMatch(withSave, /ufw/i, '部署脚本不改防火墙');
  assert.match(withSave, /exit 3/, '旧的 promptcut-docservice 还在时停手');
  const noSave = hostedDeployScript(drill, { pm2Config: hostedPm2Config(drill, 'h'), save: false, replaceDocservice: false, token: tok });
  assert.doesNotMatch(noSave, /^pm2 save$/m);
  assert.ok(noSave.includes(tok), '--write-token 时令牌只在经标准输入交给远端的脚本里');
  const bash = spawnSync('bash', ['-n'], { input: withSave, encoding: 'utf8' });
  if (bash.status !== null && !bash.error) assert.equal(bash.status, 0, bash.stderr);
});
