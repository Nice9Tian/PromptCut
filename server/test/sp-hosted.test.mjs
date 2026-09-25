/**
 * SP 托管组合（契约 `docs/plan/shared-project-contract.md` 第 1 节；验收第 7 节 SP1、SP2 托管端部分、SP3、SP7）。
 * 跑：node --test server/test/sp-hosted.test.mjs
 *
 * 起 `server/hosted/main.mjs` 子进程，用本分支端口段 5490～5499 的固定端口（见 `sp-kit.mjs` 的 PORTS），用例串行。
 * 要「非回环来源」时连本机的局域网 IPv4（托管组合绑 0.0.0.0，对端地址就不是回环）；本机没有这种网卡时相关断言跳过。
 * 只照契约写，不看实现；契约没写死的地方见 `sp-kit.mjs` 文件头的假设。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  PORTS, tmpDir, runHosted, hostedFor, exitWithin, docEnv, assetReq, uploadWhole, endpointsOf, assetUrls,
  putSnapshot, getSnapshot, runProbe, lanIPv4, sha256hex, PROTOCOL,
} from './sp-kit.mjs';
import { createProject, join, joinStatus, proofFor, ask, ticketOf, members, bearer, flipSignature, adminOp, credential } from './auth-kit.mjs';
import { randomToken, snapshotTaskInput } from './fake-ws-kit.mjs';

const LAN = lanIPv4();
const T = { timeout: 90_000 };
const SNAP_PROJECT = 'sp-project-main';

const A = (t, extra = {}) => ({ docPort: PORTS.A_DOC, assetPort: PORTS.A_ASSET, dataDir: path.join(tmpDir(t, 'pc-sp-a-'), 'data'), ...extra });
const mkdirData = (o) => { fs.mkdirSync(o.dataDir, { recursive: true }); return o; };

/** 在一份托管组合里造一整套内容：项目快照、内容库、素材、预渲染产物，跑一轮发布、认领、完成 */
async function populate(run, { password = `pw-${randomBytes(4).toString('hex')}` } = {}) {
  const env = docEnv(run.docPort);
  const proj = await createProject(env, { mode: 'free', password, creator: { username: 'alice', password: `c-${password}` } });
  const page = await join(env, proj, { username: 'alice', role: 'page' });
  const publisher = await join(env, proj, { username: 'alice', role: 'page' });
  const node = await join(env, proj, { username: 'rig', role: 'render' });

  const snapText = JSON.stringify({ name: proj.name, cards: [1, 2, 3], nonce: randomBytes(8).toString('hex') });
  const { projectRev } = await putSnapshot(page, SNAP_PROJECT, snapText);

  const contentKeys = ['k-a', 'k-b', 'k-c'];
  for (const key of contentKeys) {
    const s = await ask(page, { type: 'content.put', kind: 'card-source', key, body: { key } }, 'content.stored');
    assert.equal(s.type, 'content.stored', JSON.stringify(s));
  }

  const rw = await ticketOf(page, { kind: 'asset', access: 'rw' });
  const media = [];
  for (let i = 0; i < 3; i++) {
    const u = await uploadWhole(run.assetBase, { ns: 'media', ext: 'bin', headers: bearer(rw.ticket) });
    assert.equal(u.put.status, 200, u.put.buf.toString());
    assert.equal(u.done.status, 200, u.done.buf.toString());
    media.push(u.hash);
  }
  const snap = [];
  for (let i = 0; i < 2; i++) {
    const u = await uploadWhole(run.assetBase, { ns: 'snap', ext: 'html', bytes: Buffer.from(`<p>${randomBytes(12).toString('hex')}</p>`), headers: bearer(rw.ticket) });
    assert.equal(u.put.status, 200, u.put.buf.toString());
    assert.equal(u.done.status, 200, u.done.buf.toString());
    snap.push(u.hash);
  }

  // 一轮发布、认领、完成
  await ask(publisher, { type: 'publisher.hello', publisherId: `pub-${proj.projectId}` }, 'publisher.welcome');
  const task = snapshotTaskInput({ resultKey: `rk-${randomBytes(4).toString('hex')}`, projectId: SNAP_PROJECT, projectRev });
  const pub = await ask(publisher, { type: 'task.publish', tasks: [task] }, 'task.published');
  assert.equal(pub.type, 'task.published', JSON.stringify(pub));
  const hello = await ask(node, { type: 'node.hello', nodeId: `n-${proj.projectId}`, profile: 'host' }, 'node.welcome');
  assert.equal(hello.type, 'node.welcome', JSON.stringify(hello));
  const claimed = await ask(node, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(claimed.type, 'task.claimed', JSON.stringify(claimed));
  const completed = await ask(node, { type: 'task.complete', id: task.id, token: claimed.token, result: { snap: snap[0] } }, 'task.completed');
  assert.equal(completed.type, 'task.completed', JSON.stringify(completed));
  const done = await publisher.next((m) => m.type === 'task.done' && m.id === task.id, 5000);
  assert.equal(done.id, task.id);

  env.closeAll();
  return { proj, password, projectRev, snapText, contentKeys, media, snap };
}

/** 新成员从一份托管组合取回全部内容，逐项计数 */
async function fetchAll(run, fixture, { username = 'newcomer', host = '127.0.0.1', assetBase = run.assetBase } = {}) {
  const env = docEnv(run.docPort, host);
  const c = await join(env, fixture.proj, { username, role: 'page' });
  const st = await ask(c, { type: 'project.open', projectId: SNAP_PROJECT }, 'project.state');
  const snapText = await getSnapshot(c, SNAP_PROJECT, st.projectRev);
  const listing = await ask(c, { type: 'content.list', kind: 'card-source' }, 'content.listing');
  const r = await ticketOf(c, { kind: 'asset', access: 'r' });
  const okHashes = async (ns, hashes) => {
    let ok = 0;
    for (const h of hashes) {
      const g = await assetReq(assetBase, `${ns}/${h}?t=${encodeURIComponent(r.ticket)}`);
      if (g.status === 200 && sha256hex(g.buf) === h) ok++;
    }
    return ok;
  };
  const out = {
    projectRev: st.projectRev,
    snapText,
    contentKeys: listing.items.map((x) => x.key).sort(),
    media: await okHashes('media', fixture.media),
    snap: await okHashes('snap', fixture.snap),
  };
  env.closeAll();
  return out;
}

/** 目录下全部文件（相对路径，正斜杠） */
function walk(dir, base = dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// ================================================================== SP1

test('SPC1-1 托管组合是一个进程、两个端口：文档服务答 shared/*，素材服务答 /api/asset；素材服务登记的公网地址经 service.endpoints 下发给成员', T, async (t) => {
  const PUBLIC = 'http://sp-public.example.invalid:8788/api/asset';
  const o = mkdirData(A(t, { token: randomToken(), assetPublicUrl: PUBLIC }));
  const run = await hostedFor(t, o);
  assert.equal(run.child.exitCode, null, '进程还在');
  const lk = await fetch(`${run.docBase}/shared/lookup?name=nope-${Date.now()}`);
  assert.equal(lk.status, 404);
  assert.deepEqual(await lk.json(), { ok: false, error: 'no-project' });
  const miss = await assetReq(run.assetBase, `media/${'a'.repeat(64)}`);
  assert.equal(miss.status, 404, '素材服务在另一个端口上答');

  const env = docEnv(run.docPort);
  const proj = await createProject(env, { mode: 'free' });
  const m = await join(env, proj, { username: 'mia' });
  t.after(() => env.closeAll());
  const urls = await (async () => {
    for (let i = 0; i < 100; i++) {
      const u = assetUrls(await endpointsOf(m));
      if (u.length) return u;
      await new Promise((r) => setTimeout(r, 100));
    }
    return [];
  })();
  assert.ok(urls.includes(PUBLIC), `成员从 service.endpoints 拿到 PROMPTCUT_ASSET_PUBLIC_URL：${JSON.stringify(urls)}`);
});

test('SPC1-2 成员不设集群令牌、从非回环来源凭项目凭证进入；快照读写成功；带票据的素材读写成功，不带票据 401', T, async (t) => {
  if (!LAN) return t.skip('本机没有非回环 IPv4，无法模拟非回环来源');
  const o = mkdirData(A(t, { token: randomToken() }));
  const run = await hostedFor(t, o);
  const env = docEnv(run.docPort, LAN);
  t.after(() => env.closeAll());
  const proj = await createProject(env, { mode: 'free', password: 'sp1-pw' });

  // 不带任何鉴权的非回环连接进不来
  assert.equal((await env.handshake([PROTOCOL])).status, 401, '非回环什么都不带 → 401');
  const c = await join(env, proj, { username: 'mia' });
  const list = await members(c);
  assert.ok(list.some((d) => d.username === 'mia'), `成员列表里有自己：${JSON.stringify(list)}`);

  const text = JSON.stringify({ sp1: randomBytes(6).toString('hex') });
  const { projectRev } = await putSnapshot(c, SNAP_PROJECT, text);
  assert.equal(await getSnapshot(c, SNAP_PROJECT, projectRev), text, '快照读回一致');

  const lanAsset = `http://${LAN}:${run.assetPort}/api/asset`;
  const none = await uploadWhole(lanAsset, {});
  assert.equal(none.put.status, 401, `非回环不带票据写 → 401：${none.put.buf}`);
  const rw = await ticketOf(c, { kind: 'asset', access: 'rw' });
  const up = await uploadWhole(lanAsset, { headers: bearer(rw.ticket) });
  assert.equal(up.put.status, 200, up.put.buf.toString());
  assert.equal(up.done.status, 200, up.done.buf.toString());
  const noRead = await assetReq(lanAsset, `media/${up.hash}`);
  assert.equal(noRead.status, 401, '非回环不带票据读 → 401');
  const r = await ticketOf(c, { kind: 'asset', access: 'r' });
  const g = await assetReq(lanAsset, `media/${up.hash}?t=${encodeURIComponent(r.ticket)}`);
  assert.equal(g.status, 200);
  assert.equal(sha256hex(g.buf), up.hash, '读回的字节哈希一致');
  const gb = await assetReq(lanAsset, `media/${up.hash}`, { headers: bearer(r.ticket) });
  assert.equal(gb.status, 200, 'Bearer 读也行');
  const ro = await uploadWhole(lanAsset, { headers: bearer(r.ticket) });
  assert.equal(ro.put.status, 403, '只读票据写 → 403');
});

test('SPC1-3 两个服务共用同一份凭证存储与票据核对：文档服务签的票据素材服务认；签名改一位 401；set-password 后旧票据 401', T, async (t) => {
  if (!LAN) return t.skip('本机没有非回环 IPv4');
  const run = await hostedFor(t, mkdirData(A(t)));
  const env = docEnv(run.docPort, LAN);
  t.after(() => env.closeAll());
  const proj = await createProject(env, { mode: 'free', password: 'sp1-3-pw' });
  const c = await join(env, proj, { username: 'mia' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator' });
  const lanAsset = `http://${LAN}:${run.assetPort}/api/asset`;
  const rw = await ticketOf(c, { kind: 'asset', access: 'rw' });
  const ok = await uploadWhole(lanAsset, { headers: bearer(rw.ticket) });
  assert.equal(ok.put.status, 200);
  const bad = await uploadWhole(lanAsset, { headers: bearer(flipSignature(rw.ticket)) });
  assert.equal(bad.put.status, 401, '签名不对 401');
  const r = await adminOp(creator, proj, 'set-password', { project: credential('sp1-3-new-pw') });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  const stale = await uploadWhole(lanAsset, { headers: bearer(rw.ticket) });
  assert.equal(stale.put.status, 401, '项目代数变了，素材服务同步认出旧票据作废（同进程共用代数）');
});

// ================================================================== SP2（托管端）

test('SPC2-1 托管端管理接口：没设令牌时带任何令牌的握手 401；设了令牌时错令牌 401、对令牌 101；非回环什么都不带 401', T, async (t) => {
  {
    const run = await hostedFor(t, mkdirData(A(t)));
    const env = docEnv(run.docPort);
    assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${randomToken()}`])).status, 401, '没设令牌：管理接口全部 401');
    if (LAN) assert.equal((await docEnv(run.docPort, LAN).handshake([PROTOCOL, `promptcut.token.${randomToken()}`])).status, 401);
    await run.stop();
  }
  {
    const token = randomToken();
    const run = await hostedFor(t, mkdirData(A(t, { token })));
    const env = docEnv(run.docPort);
    assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${randomToken()}`])).status, 401, '错令牌 401');
    assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${token}`])).status, 101, '对令牌 101');
    if (LAN) {
      const lan = docEnv(run.docPort, LAN);
      assert.equal((await lan.handshake([PROTOCOL])).status, 401, '非回环不带鉴权 401');
      assert.equal((await lan.handshake([PROTOCOL, `promptcut.token.${randomToken()}`])).status, 401, '非回环错令牌 401');
    }
  }
});

test('SPC2-2 托管端：三种角色与独立主机都不带令牌、凭项目凭证进入；凭证错被拒', T, async (t) => {
  const host = LAN ?? '127.0.0.1';
  const run = await hostedFor(t, mkdirData(A(t, { token: randomToken() })));
  const env = docEnv(run.docPort, host);
  t.after(() => env.closeAll());
  const proj = await createProject(env, { mode: 'free', password: 'sp2-pw' });
  for (const [role, extra] of [['page', {}], ['agent', { c: 7 }], ['render', { o: { kind: 'user' } }]]) {
    assert.equal(await joinStatus(env, proj, { username: `u-${role}`, role, ...extra }), 101, `${role} 凭证明进入`);
  }
  const hostNode = await join(env, proj, { username: 'rig', role: 'render' });
  const w = await ask(hostNode, { type: 'node.hello', nodeId: 'sp2-host', profile: 'host' }, 'node.welcome');
  assert.equal(w.type, 'node.welcome', `独立主机以 render 角色 node.hello：${JSON.stringify(w)}`);
  assert.equal(await joinStatus(env, proj, { username: 'eve', password: 'wrong-pw' }), 401, '凭证错 401');
  const p = await proofFor(env, proj, { username: 'mallory' });
  assert.equal((await env.handshake([...p.protocols, `promptcut.token.${randomToken()}`])).status, 401, '证明加令牌两项一起 401');
});

// ================================================================== 数据目录（第 1 节）

test('SPC1-4 数据目录布局：docservice/（auth/、tenants/<projectId>/）、assets/{media,snap}/<哈希前两位>/<哈希>、assets/.layout；工作目录里什么都不写', T, async (t) => {
  const cwd = tmpDir(t, 'pc-sp-cwd-');
  const o = mkdirData(A(t, { cwd }));
  const run = await hostedFor(t, o);
  const fx = await populate(run);
  const files = walk(o.dataDir);
  const pid = fx.proj.projectId;
  assert.ok(files.includes(`docservice/auth/projects/${pid}.json`), `凭证在 docservice/auth/ 下：${files.slice(0, 40).join(', ')}`);
  assert.ok(files.some((f) => f.startsWith(`docservice/tenants/${pid}/`)), `共享空间在 docservice/tenants/<projectId>/ 下：${files.slice(0, 40).join(', ')}`);
  assert.ok(files.includes('assets/.layout'), 'assets/.layout 记着布局');
  for (const h of fx.media) {
    assert.ok(files.some((f) => f === `assets/media/${h.slice(0, 2)}/${h}` || f.startsWith(`assets/media/${h.slice(0, 2)}/${h}.`)), `素材 ${h.slice(0, 8)} 在 assets/media/${h.slice(0, 2)}/ 下：${files.filter((f) => f.startsWith('assets/')).join(', ')}`);
  }
  for (const h of fx.snap) {
    assert.ok(files.some((f) => f.startsWith(`assets/snap/${h.slice(0, 2)}/${h}`)), `产物 ${h.slice(0, 8)} 在 assets/snap/${h.slice(0, 2)}/ 下`);
  }
  assert.ok(!files.some((f) => /^assets\/media\/[0-9a-f]{64}/.test(f)), '托管端不用平铺布局');
  const top = fs.readdirSync(o.dataDir).sort();
  for (const d of top) assert.ok(['assets', 'docservice', 'secrets'].includes(d), `数据目录顶层只有 docservice/、assets/、secrets/：${top}`);
  assert.deepEqual(fs.readdirSync(cwd), [], '工作目录没被写');
});

test('SPC1-5 失败即关：数据目录不存在 → 退出码 1、config.error { reason: data-dir }；数据目录是个文件 → 同样', T, async (t) => {
  const base = tmpDir(t, 'pc-sp-dd-');
  const missing = runHosted({ docPort: PORTS.A_DOC, assetPort: PORTS.A_ASSET, dataDir: path.join(base, 'no-such-dir') });
  t.after(() => missing.stop());
  const r1 = await exitWithin(missing, 10_000);
  assert.ok(!r1.timedOut, `数据目录不存在应失败即关；输出：${missing.output()}`);
  assert.equal(r1.code, 1, missing.output());
  assert.ok(missing.lines().some((l) => l.event === 'config.error' && l.reason === 'data-dir'), missing.output());
  assert.equal(fs.existsSync(path.join(base, 'no-such-dir')), false, '不替用户建数据目录');

  const file = path.join(base, 'data-is-a-file');
  fs.writeFileSync(file, 'x');
  const notDir = runHosted({ docPort: PORTS.A_DOC, assetPort: PORTS.A_ASSET, dataDir: file });
  t.after(() => notDir.stop());
  const r2 = await exitWithin(notDir, 10_000);
  assert.ok(!r2.timedOut, notDir.output());
  assert.equal(r2.code, 1, notDir.output());
  assert.ok(notDir.lines().some((l) => l.event === 'config.error' && l.reason === 'data-dir'), notDir.output());
});

test('SPC1-6 集群令牌从 secrets/cluster-token 读，文件不存在才回落环境变量；两处都没有照常启动、管理接口 401', T, async (t) => {
  const fileToken = randomToken();
  const envToken = randomToken();
  {
    const o = mkdirData(A(t, { token: envToken }));
    fs.mkdirSync(path.join(o.dataDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(o.dataDir, 'secrets', 'cluster-token'), `${fileToken}\n`, { mode: 0o600 });
    const run = await hostedFor(t, o);
    const env = docEnv(run.docPort);
    assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${fileToken}`])).status, 101, '文件里的令牌生效');
    assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${envToken}`])).status, 401, '文件在时环境变量不生效');
    assert.ok(!run.output().includes(fileToken), '输出里没有令牌原文');
    await run.stop();
  }
  {
    const run = await hostedFor(t, mkdirData(A(t, { token: envToken })));
    assert.equal((await docEnv(run.docPort).handshake([PROTOCOL, `promptcut.token.${envToken}`])).status, 101, '没有文件：回落环境变量');
    await run.stop();
  }
  {
    const run = await hostedFor(t, mkdirData(A(t)));
    assert.equal((await docEnv(run.docPort).handshake([PROTOCOL, `promptcut.token.${envToken}`])).status, 401, '两处都没有：照常启动，管理接口 401');
  }
});

test('SPC1-7 assets/.layout 启动时核对：与 shard 布局对不上就拒绝启动', T, async (t) => {
  const o = mkdirData(A(t));
  const first = await hostedFor(t, o);
  const layoutFile = path.join(o.dataDir, 'assets', '.layout');
  assert.ok(fs.existsSync(layoutFile), '首次启动写出 assets/.layout');
  const original = fs.readFileSync(layoutFile);
  await first.stop();

  const again = await hostedFor(t, o);
  assert.equal(again.child.exitCode, null, '布局没变：再启动照常');
  await again.stop();

  fs.writeFileSync(layoutFile, 'flat-layout-from-somewhere-else\n');
  const bad = runHosted(o);
  t.after(() => bad.stop());
  const r = await exitWithin(bad, 10_000);
  assert.ok(!r.timedOut, `布局对不上应拒绝启动；输出：${bad.output()}`);
  assert.notEqual(r.code, 0, bad.output());
  fs.writeFileSync(layoutFile, original);
});

// ================================================================== SP3

test('SPC3-1 一轮发布、认领、完成之后全部成员断开，新成员取回的项目快照、内容库条目、素材、产物逐项计数一致，且都在数据目录之下', T, async (t) => {
  const cwd = tmpDir(t, 'pc-sp-cwd3-');
  const o = mkdirData(A(t, { cwd, token: randomToken() }));
  const run = await hostedFor(t, o);
  const fx = await populate(run);
  await new Promise((r) => setTimeout(r, 300));
  const got = await fetchAll(run, fx, LAN ? { host: LAN, assetBase: `http://${LAN}:${run.assetPort}/api/asset` } : {});
  assert.equal(got.projectRev, fx.projectRev, 'projectRev 一致');
  assert.equal(got.snapText, fx.snapText, '快照全文一致');
  assert.deepEqual(got.contentKeys, [...fx.contentKeys].sort(), '内容库条目一致');
  assert.equal(got.media, fx.media.length, '素材逐个取回、哈希一致');
  assert.equal(got.snap, fx.snap.length, '产物逐个取回、哈希一致');

  // 重启后仍在（数据都落在数据目录里，不靠内存）
  await run.stop();
  const again = await hostedFor(t, o);
  const after = await fetchAll(again, fx, { username: 'after-restart' });
  assert.deepEqual(after, got, '重启后逐项一致');
  const files = walk(o.dataDir);
  assert.ok(files.length > 0);
  assert.deepEqual(fs.readdirSync(cwd), [], '工作目录没被写');
});

// ================================================================== SP7

test('SPC7-1 迁移演练：拷数据目录到另一份实例、改地址后，项目、快照、内容库、素材、产物全部可用；projectRev 连续不归零；新地址下发给成员；migrate-check 通过', T, async (t) => {
  const token = randomToken();
  const aData = path.join(tmpDir(t, 'pc-sp-mig-a-'), 'data');
  const bData = path.join(tmpDir(t, 'pc-sp-mig-b-'), 'data');
  fs.mkdirSync(aData, { recursive: true });
  const oA = { docPort: PORTS.A_DOC, assetPort: PORTS.A_ASSET, dataDir: aData, token };
  const a = await hostedFor(t, oA);
  const fx = await populate(a);
  await a.stop(); // 停写

  fs.cpSync(aData, bData, { recursive: true });
  const countOf = (d) => walk(d).length;
  assert.equal(countOf(bData), countOf(aData), '拷完文件数一致');

  const a2 = await hostedFor(t, oA); // 旧服务器保留只读
  const B_PUBLIC = `http://127.0.0.1:${PORTS.B_ASSET}/api/asset`;
  const b = await hostedFor(t, { docPort: PORTS.B_DOC, assetPort: PORTS.B_ASSET, dataDir: bData, token, assetPublicUrl: B_PUBLIC });

  // 迁移核对探针（契约第 6 节）
  const probe = await runProbe(['--role', 'migrate-check', '--from', a2.docBase, '--to', b.docBase], { PROMPTCUT_CLUSTER_TOKEN: token });
  assert.equal(probe.json?.ok, true, `migrate-check 通过：code=${probe.code} out=${probe.out.slice(-800)} err=${probe.err.slice(-800)}`);

  // 按名字查到同一个项目，老口令照样进
  const lk = await (await fetch(`${b.docBase}/shared/lookup?name=${encodeURIComponent(fx.proj.name)}`)).json();
  assert.equal(lk.projectId, fx.proj.projectId);
  const got = await fetchAll(b, fx, { username: 'migrated' });
  assert.equal(got.projectRev, fx.projectRev, 'projectRev 与迁移前一致');
  assert.equal(got.snapText, fx.snapText);
  assert.deepEqual(got.contentKeys, [...fx.contentKeys].sort());
  assert.equal(got.media, fx.media.length, '素材按哈希取回 100% 一致');
  assert.equal(got.snap, fx.snap.length, '产物按哈希取回 100% 一致');

  // 新地址登记给成员
  const env = docEnv(b.docPort);
  t.after(() => env.closeAll());
  const m = await join(env, fx.proj, { username: 'watcher' });
  const urls = await (async () => {
    for (let i = 0; i < 100; i++) {
      const u = assetUrls(await endpointsOf(m));
      if (u.length) return u;
      await new Promise((r) => setTimeout(r, 100));
    }
    return [];
  })();
  assert.ok(urls.includes(B_PUBLIC), `新实例登记新地址：${JSON.stringify(urls)}`);

  // projectRev 连续：下一版是迁移前的 +1
  const next = await putSnapshot(m, SNAP_PROJECT, JSON.stringify({ after: 'migration' }));
  assert.equal(next.projectRev, fx.projectRev + 1, 'projectRev 连续，不归零');
});

test('SPC7-2 migrate-check 对着一份空实例：ok 为 false', T, async (t) => {
  const token = randomToken();
  const oA = mkdirData(A(t, { token }));
  const a = await hostedFor(t, oA);
  await populate(a);
  const c = await hostedFor(t, mkdirData({ docPort: PORTS.C_DOC, assetPort: PORTS.C_ASSET, dataDir: path.join(tmpDir(t, 'pc-sp-c-'), 'data'), token }));
  const probe = await runProbe(['--role', 'migrate-check', '--from', a.docBase, '--to', c.docBase], { PROMPTCUT_CLUSTER_TOKEN: token });
  assert.ok(probe.json, `探针最后一行是 JSON：${probe.out.slice(-400)} ${probe.err.slice(-400)}`);
  assert.equal(probe.json.ok, false, '项目数对不上，不通过');
});
