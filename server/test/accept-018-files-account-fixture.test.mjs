/**
 * 0.7.18 逐项验收里**需要真实账号组合**的两行,共用一份现成的双账号组合(它占 7 个端口,所以两个场景放在同一个文件里依次跑):
 *
 *   ACC018-REOPEN  2.1-7「正常云端文件重开」:预期原文「连原项目及最新状态,不能用旧文件覆盖」;契约 account-binding-contract.md
 *                  「项目存在且有权限:连接原项目,采用云端当前版本;文件不是覆盖云端的依据」。
 *   ACC018-BACKUP  2.1-14「备份恢复」:预期原文「完整清单、校验结果、实际恢复并打开/读取;数据库快照一致,原备份保留」。
 *
 * 底座:`fixtures/account-dual-user-path.mjs` 的 `startAccountDualUserFixture`(VisuHive 真账号后端 + 文档服务 + 独立素材进程 +
 * 带证书的边缘,全在本机回环)。需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE,没设就整个跳过。
 * 端口:调用方给的 7 个(这里向系统要空闲的)。
 *
 * 关于 ACC018-BACKUP:仓库里**没有**备份/恢复脚本——2026-10-09 在节点上做的那次(docs/archive/three-versions-production-restore-2026-10-09.md)用的是
 * 节点上的一次性脚本。所以这里演练的是**方法**:服务停写 → 数据文件(三个 SQLite、项目日志与状态、素材)逐个列清单 → 备份 → 校验 → 恢复到新目录 →
 * 在恢复副本上打开三个数据库、读项目与素材 → 逐表摘要与停写时一致 → 备份原样还在;再用一份被改坏的备份证明校验会拦、恢复不会落地。
 * 它证明方法在真实的数据布局上成立,不是对节点上那套脚本的回归;「在节点当时的数据上重做」「恢复副本上真的起三个服务」仍要部署后验。
 *
 * 跑(PowerShell 先设两个环境变量,Bash 用 export):npm test -- server/test/accept-018-files-account-fixture.test.mjs
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocketNode from 'ws';
import { startAccountDualUserFixture } from './fixtures/account-dual-user-path.mjs';
import { waitFor } from './fake-ws-kit.mjs';
import { freePorts } from './free-ports.mjs';

const providerRoot = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ?? '';
const orderModule = process.env.PROMPTCUT_PASSWORD_ORDER_MODULE ?? '';
const available = Boolean(providerRoot) && fs.existsSync(path.join(providerRoot, 'account/internal.mjs')) && Boolean(orderModule) && fs.existsSync(orderModule);
const skip = !available && '账号后端源码不可用:设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT(VisuHive 仓库根)与 PROMPTCUT_PASSWORD_ORDER_MODULE(其 account/password-order.mjs)';

const { SyncLink } = await import(srcUrl('editor/sync/link.ts'));
const { accountConnectionProtocols } = await import(srcUrl('account/client.ts'));

const fx = skip ? null : await startAccountDualUserFixture({ ports: await freePorts(7) });
after(async () => {
  if (!fx) return;
  await fx.close();
  const target = path.resolve(fx.fixtureDir);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('pc-dual-account-path-')) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function post(origin, ca, route, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(new URL(route, origin), { method: 'POST', ca, timeout: 8000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(e); } });
    });
    req.once('error', reject); req.once('timeout', () => req.destroy(Error('timeout'))); req.end(data);
  });
}

/** 在共享组合上开「编辑者」:登录、拿会话、连上、能问 project.* */
function editorKit(toClose) {
  const ca = fs.readFileSync(fx.caFile);
  const origin = fx.origin;
  const projectId = fx.projectId;
  const wssBase = `${origin.replace(/^https:/, 'wss:')}/hosted/`;
  class CaSocket extends WebSocketNode { constructor(url, protocols) { super(url, protocols, { ca, origin, handshakeTimeout: 8000 }); } }
  const login = async (account, deviceId) => {
    const r = await post(origin, ca, '/api/account/editor/login', { name: account.name, password: account.password, deviceId, deviceName: deviceId, requestId: `login-${deviceId}` });
    assert.equal(r.status, 200, `editor login ${account.name}: ${r.status}`);
    return r.body.accessToken;
  };
  const sessionOf = (token, deviceId, id = projectId) => post(origin, ca, '/hosted/shared/account/session', { projectId: id, deviceId, requestId: `s-${deviceId}-${Math.random().toString(36).slice(2)}` }, token);
  const connect = async (deviceId) => {
    const token = await login(fx.accounts[0], deviceId);
    const s = await sessionOf(token, deviceId);
    assert.equal(s.status, 200, JSON.stringify(s.body).slice(0, 200));
    const ws = new CaSocket(wssBase, accountConnectionProtocols(s.body)); toClose.push(ws);
    const pending = new Map();
    ws.on('message', bytes => { let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { return; } const w = pending.get(m.reqId); if (w) { pending.delete(m.reqId); w(m); } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let seq = 0;
    const ask = (m) => new Promise((resolve, reject) => {
      const reqId = `q${++seq}`; const timer = setTimeout(() => reject(new Error(`等 ${m.type} 回包超时`)), 8000);
      pending.set(reqId, v => { clearTimeout(timer); resolve(v); }); ws.send(JSON.stringify({ ...m, reqId }));
    });
    return { ws, ask, token, session: s.body };
  };
  return { ca, origin, projectId, wssBase, CaSocket, login, sessionOf, connect };
}

test('ACC018-REOPEN-1/2 项目存在且账号有权:带着旧文件内容重开,连上原项目、页面里是云端最新状态,云端内容和版本没被旧文件改动;未登录、无此项目拿不到会话', { skip, timeout: 120_000 }, async (t) => {
  const toClose = [];
  t.after(() => { for (const c of toClose) { try { c.close(); } catch { /* 已关 */ } } });
  const k = editorKit(toClose);
  const { projectId } = k;
  // 创建者(账号 0)的一台设备:把云端项目改到最新
  const editor = await k.connect('reopen-editor-device');
  const opened = await editor.ask({ type: 'project.open', projectId });
  const baseRev = opened.rev;
  assert.equal(typeof baseRev, 'number');
  // 「旧文件」= 保存时刻(云端版本 baseRev)的内容
  const staleFile = { ...structuredClone(opened.project), name: 'stale-file-name' };
  const r1 = await editor.ask({ type: 'project.op', projectId, opId: 'op-latest-1', ops: [{ op: 'set', path: '/name', value: 'cloud-latest-1' }] });
  assert.equal(r1.type, 'project.op.ok', JSON.stringify(r1));
  const r2 = await editor.ask({ type: 'project.op', projectId, opId: 'op-latest-2', ops: [{ op: 'set', path: '/name', value: 'cloud-latest-2' }] });
  assert.equal(r2.type, 'project.op.ok', JSON.stringify(r2));
  const headRev = r2.rev;
  assert.equal(headRev, baseRev + 2);

  // 重开:页面一侧的 SyncLink(initialize:false,与 enterAccountProject 一致),手里是旧文件内容
  const tokenReopen = await k.login(fx.accounts[0], 'reopen-page-device');
  const sReopen = await k.sessionOf(tokenReopen, 'reopen-page-device');
  assert.equal(sReopen.status, 200);
  const link = new SyncLink({ url: k.wssBase, projectId, session: 'reopen-session', initial: staleFile, initialize: false,
    protocols: () => accountConnectionProtocols(sReopen.body), WebSocketImpl: k.CaSocket, reconnect: { minMs: 50, maxMs: 200 } });
  t.after(() => link.stop());
  link.start();
  await waitFor(() => link.ds.confirmedProject && link.ds.status === 'online', 10_000, '重开的页面拿到云端状态');
  assert.equal(link.ds.project.name, 'cloud-latest-2', '页面里是云端最新状态,不是旧文件内容');
  assert.equal(link.ds.confirmedProject.name, 'cloud-latest-2');
  await link.ds.whenSettled({ timeoutMs: 5000 });
  // 云端没被旧文件改动:内容、版本不变,之后的编辑版本号连续
  const verified = await editor.ask({ type: 'project.open', projectId });
  assert.equal(verified.project.name, 'cloud-latest-2', '云端内容仍是最新');
  assert.equal(verified.rev, headRev, '云端版本号在重开前后一样:旧文件没有被当成根替换提交');
  const after = await editor.ask({ type: 'project.op', projectId, opId: 'op-after-reopen', ops: [{ op: 'set', path: '/name', value: 'cloud-latest-3' }] });
  assert.equal(after.rev, headRev + 1, '版本连续');
  await waitFor(() => link.ds.project.name === 'cloud-latest-3', 5000, '重开的页面收到之后的云端修改');

  // 对照:未登录、项目不存在/无权限都拿不到会话
  const anon = await post(k.origin, k.ca, '/hosted/shared/account/session', { projectId, deviceId: 'nobody', requestId: 'anon-1' }, 'not-a-token');
  assert.equal(anon.status, 401, '未登录拿不到会话');
  const nope = await k.sessionOf(editor.token, 'reopen-editor-device', `sp_${'a'.repeat(26)}`);
  assert.ok([403, 404].includes(nope.status), `不存在/无权限的项目拿不到会话:${nope.status}`);
});

// ------------------------------------------------------------------ 备份恢复演练

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const posix = (p) => p.split(path.sep).join('/');
function listFiles(root, base = root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => {
    const full = path.join(root, e.name);
    return e.isDirectory() ? listFiles(full, base) : [posix(path.relative(base, full))];
  }).sort();
}
/** 清单:相对路径、字节数、SHA-256 */
function buildManifest(root, relPaths) {
  return relPaths.map(rel => ({ path: rel, bytes: fs.statSync(path.join(root, rel)).size, sha256: sha256File(path.join(root, rel)) }));
}
/** 校验:逐项重算,回不一致的清单项;也查多出来的文件 */
function verifyManifest(root, manifest, { allowExtra = false } = {}) {
  const problems = [];
  for (const item of manifest) {
    const file = path.join(root, item.path);
    if (!fs.existsSync(file)) { problems.push({ path: item.path, problem: 'missing' }); continue; }
    if (fs.statSync(file).size !== item.bytes) problems.push({ path: item.path, problem: 'size' });
    else if (sha256File(file) !== item.sha256) problems.push({ path: item.path, problem: 'sha256' });
  }
  if (!allowExtra) { const known = new Set(manifest.map(i => i.path)); for (const rel of listFiles(root)) if (!known.has(rel)) problems.push({ path: rel, problem: 'extra' }); }
  return problems;
}
const hexReplacer = (_k, v) => (v instanceof Uint8Array ? `hex:${Buffer.from(v).toString('hex')}` : typeof v === 'bigint' ? `big:${v}` : v);
/** 一个 SQLite 文件的快照:完整性、user_version、逐表行数与摘要(只读打开) */
function snapshotDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
    const userVersion = Object.values(db.prepare('PRAGMA user_version').get())[0];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const perTable = {};
    for (const name of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      perTable[name] = { rows: rows.length, digest: createHash('sha256').update(JSON.stringify(rows, hexReplacer)).digest('hex') };
    }
    return { integrity, userVersion, perTable };
  } finally { db.close(); }
}
const cpDir = (from, to) => fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });

test('ACC018-BACKUP-1 备份恢复演练:停写→清单→备份→校验→恢复到新目录→打开读取→逐表摘要与停写时一致→原备份还在;被改坏的备份校验拦住、恢复不落地', { skip, timeout: 120_000 }, async (t) => {
  // 先在运行中的服务上读一次「真相」:项目正文与版本、素材字节
  const toClose = [];
  const k = editorKit(toClose);
  const probe = await k.connect('backup-probe-device');
  const live = await probe.ask({ type: 'project.open', projectId: k.projectId });
  assert.equal(typeof live.rev, 'number'); assert.ok(live.rev >= 1);
  for (const w of toClose) { try { w.close(); } catch { /* 已关 */ } }

  // 停写:关掉三个服务(账号后端、文档服务、素材进程),之后数据目录里不再有写入
  await fx.close();
  const root = fx.fixtureDir;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-accept-018-backup-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  // 数据范围 = 账号库、文档数据目录、素材数据目录(证书/私钥/暂存代码属于「代码与配置」那一包,不在这里)
  // 先把停写后的源整份拷到工作目录当「停写快照」:读数据库(哪怕只读打开)会在目录里生出 -wal/-shm,不在源目录上读,免得改动被备份的东西
  const dataRel = ['accounts.sqlite', 'accounts.sqlite-wal', 'accounts.sqlite-shm', 'doc', 'asset'].filter(rel => fs.existsSync(path.join(root, rel)));
  const dataRoot = path.join(work, 'source-data');
  for (const rel of dataRel) fs.cpSync(path.join(root, rel), path.join(dataRoot, rel), { recursive: true });
  // 备份清单与备份文件取自 root 下的原目录;数据库摘要取自上面的停写快照(两处字节相同,下面会核对)
  const sourceFiles = dataRel.flatMap(rel => (fs.statSync(path.join(root, rel)).isDirectory() ? listFiles(path.join(root, rel), root) : [rel]));

  // 1) 完整清单
  const manifest = buildManifest(root, sourceFiles);
  assert.ok(manifest.length >= 8, `数据文件数:${manifest.length}`);
  assert.ok(manifest.some(i => i.path.endsWith('accounts.sqlite')) && manifest.some(i => i.path.endsWith('account-v2.sqlite')) && manifest.some(i => i.path.endsWith('operation-history-v2.sqlite')), '三个数据库都在清单里');
  assert.ok(manifest.some(i => /\.(png|jpg|mp4|wav)$/.test(i.path)), '素材文件在清单里');
  assert.ok(manifest.some(i => i.path.endsWith('.ndjson')) && manifest.some(i => /\.state-[0-9a-f]+\.json$/.test(i.path)), '项目日志与状态在清单里');
  const dbFiles = manifest.filter(i => i.path.endsWith('.sqlite')).map(i => i.path);
  assert.equal(dbFiles.length, 3);
  assert.deepEqual(verifyManifest(dataRoot, manifest), [], '停写快照与原目录逐文件相同');
  const sourceSnapshots = Object.fromEntries(dbFiles.map(rel => [rel, snapshotDatabase(path.join(dataRoot, rel))]));
  for (const [rel, s] of Object.entries(sourceSnapshots)) assert.deepEqual(s.integrity, ['ok'], `${rel} 完整性`);

  // 2) 备份(目录 + 清单文件)
  const backup = path.join(work, 'backup');
  for (const rel of dataRel) fs.cpSync(path.join(root, rel), path.join(backup, rel), { recursive: true });
  const manifestFile = path.join(work, 'backup-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ v: 1, files: manifest, totals: { files: manifest.length, bytes: manifest.reduce((n, i) => n + i.bytes, 0) } }, null, 2));
  assert.deepEqual(verifyManifest(backup, manifest), [], '3) 校验:备份逐文件与清单一致,没有多出少掉');
  assert.deepEqual(verifyManifest(root, manifest, { allowExtra: true }), [], '备份时的源也与清单一致(备份期间源没变)');

  // 3) 校验能拦坏备份:拷一份,改一个字节,校验要点名那个文件;恢复要拒绝且不落地
  const bad = path.join(work, 'backup-bad');
  cpDir(backup, bad);
  const victim = manifest.find(i => i.path.endsWith('account-v2.sqlite')).path;
  const fd = fs.openSync(path.join(bad, victim), 'r+'); const one = Buffer.alloc(1); fs.readSync(fd, one, 0, 1, 0); one[0] ^= 0xff; fs.writeSync(fd, one, 0, 1, 0); fs.closeSync(fd);
  const badProblems = verifyManifest(bad, manifest);
  assert.deepEqual(badProblems, [{ path: victim, problem: 'sha256' }], '改坏的备份:校验只点名被改的那一个文件');
  const restoreFrom = (from, to) => { const problems = verifyManifest(from, manifest); if (problems.length) throw Object.assign(new Error('backup-verify-failed'), { problems }); if (fs.existsSync(to)) throw new Error('restore-target-exists'); cpDir(from, to); };
  const restoredBad = path.join(work, 'restored-bad');
  assert.throws(() => restoreFrom(bad, restoredBad), /backup-verify-failed/);
  assert.equal(fs.existsSync(restoredBad), false, '校验没过就不落地任何恢复文件');

  // 4) 实际恢复到新目录(目标已存在则拒绝,不覆盖)
  const restored = path.join(work, 'restored');
  restoreFrom(backup, restored);
  assert.throws(() => restoreFrom(backup, restored), /restore-target-exists/, '目标已存在就拒绝,不覆盖');
  assert.deepEqual(verifyManifest(restored, manifest), [], '恢复副本逐文件与清单一致');

  // 5) 在恢复副本上打开、读取:三个数据库能打开、完整性正常、结构版本相同;项目日志和状态能解析;素材字节的哈希与文件名相符
  const restoredSnapshots = Object.fromEntries(dbFiles.map(rel => [rel, snapshotDatabase(path.join(restored, rel))]));
  for (const [rel, s] of Object.entries(restoredSnapshots)) {
    assert.deepEqual(s.integrity, ['ok'], `恢复副本 ${rel} 完整性`);
    assert.equal(s.userVersion, sourceSnapshots[rel].userVersion, `${rel} 结构版本一致`);
  }
  const tenantFiles = manifest.filter(i => i.path.includes('/tenants/'));
  const ndjson = tenantFiles.find(i => i.path.endsWith('.ndjson'));
  const state = tenantFiles.find(i => /\.state-[0-9a-f]+\.json$/.test(i.path));
  const lines = fs.readFileSync(path.join(restored, ndjson.path), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(lines.length >= 1, '项目日志能逐行解析');
  const stateDoc = JSON.parse(fs.readFileSync(path.join(restored, state.path), 'utf8'));
  assert.ok(stateDoc && typeof stateDoc === 'object');
  const mediaItems = manifest.filter(i => /\/out\/media\/[0-9a-f]{64}\.\w+$/.test(i.path));
  assert.ok(mediaItems.length >= 1, '素材文件');
  for (const m of mediaItems) assert.equal(path.basename(m.path).split('.')[0], sha256File(path.join(restored, m.path)), `素材 ${path.basename(m.path).slice(0, 8)} 字节与哈希一致`);
  // 运行中读到的项目(版本、正文)与恢复副本里记的一致:操作历史库里的 projects 表(当前版本号 + 当前正文)
  const historyRel = dbFiles.find(rel => rel.endsWith('operation-history-v2.sqlite'));
  const restoredHistory = new DatabaseSync(path.join(restored, historyRel), { readOnly: true });
  try {
    const row = restoredHistory.prepare('SELECT rev, snapshot FROM projects WHERE id = ?').get(k.projectId);
    assert.ok(row, '恢复副本里读得到这个项目');
    assert.equal(row.rev, live.rev, '恢复副本里的项目版本 = 备份前运行中读到的版本');
    assert.deepEqual(JSON.parse(row.snapshot), live.project, '恢复副本里的项目正文 = 备份前运行中读到的正文');
  } finally { restoredHistory.close(); }

  // 6) 数据库快照一致:逐表行数与摘要,停写时的源 = 恢复副本
  for (const rel of dbFiles) assert.deepEqual(restoredSnapshots[rel].perTable, sourceSnapshots[rel].perTable, `${rel} 逐表行数与摘要与停写时一致`);

  // 7) 原备份保留:恢复之后备份目录逐文件仍与清单一致,清单文件没变
  assert.deepEqual(verifyManifest(backup, manifest), [], '恢复之后原备份还在,字节没变');
  assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).files.length, manifest.length);
  // 恢复没有碰源目录
  assert.deepEqual(verifyManifest(root, manifest, { allowExtra: true }), [], '恢复没动源目录');
});
