/**
 * 账号办法的「搬到云端」对着真服务:真的账号服务、文档服务、独立的素材服务进程(`fixtures/account-dual-user-path.mjs`,两个账号)。
 * 用的是真的账号客户端(`src/account/client.ts`,桌面外壳的账号桥换成直接发请求的替身)、真的流程(`accountMove.ts`)、
 * 真的内容上传与读回(`SyncLink` + `DocSync`,WebSocket 带根证书)。本机一侧(关协作、进项目、素材入队)是替身,只记被调了没有;
 * 真页面、真本机房间的那一遍在探针 `scripts/probes/account-move-probe.mjs`。报告 `docs/reports/AGENT-v18-move.md`。
 *
 * 跑:npm test -- server/test/account-move.test.mjs(要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE)
 *
 * 一条用例(服务只起一次):
 *   1  本地项目搬上去,正文大于新建接口的 1 MiB 上限:新建请求体很小(占位),正文经文档连接分片写入;
 *      第二个账号凭项目号加入后读到的内容与本机逐字段相同;云端只多出一个项目
 *   2  没登录:停在核对,云端没有新项目
 *   3  名字重(全站唯一):回 name-taken,云端没有新项目,本机一侧什么都没被调;换个名字搬成
 *   4  正文传到一半传输被掐:会话接续,照样落地,内容一致
 *   5  正文传到一半会话断掉(不只是传输):重建会话后补发,照样落地
 *   6  中途云端不可用(取票据一直回 503):失败,本机一侧什么都没被调,云端项目留着(内容还是占位);
 *      恢复后再点一次:同一个项目号,新建接口没有再建第二个;别的账号用同一个名字新建回 name-taken;云端项目总数只加一
 *   7  新建的回包丢了(请求到了云端):本机只知道结果不确定;再点一次用同一个请求号,拿回同一个项目
 *   8  不是账号模式的节点(新建接口回 404):not-account-cloud,本机一侧什么都没被调
 *   9  同一个账号从两台设备各搬一个不同的本地项目:互不相干(「按账号、不依托设备」的本地项目那一半)
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WS from 'ws';
import { startAccountDualUserFixture } from './fixtures/account-dual-user-path.mjs';
import { freePorts } from './free-ports.mjs';

const M = await import(srcUrl('editor/sync/accountMove.ts'));
const { createAccountClient, projectLink } = await import(srcUrl('account/client.ts'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function memoryStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}

/** 一份正文很大的项目:`chars` 个汉字左右(UTF-8 下每个 3 字节) */
function bigProject(id, name, chars) {
  const clips = [];
  const per = 2000;
  for (let i = 0; i * per < chars; i++) clips.push({ id: `c-${i}`, cardId: 'mu-title', start: i, end: i + 1, params: { text: `${i}:` + '字'.repeat(per) } });
  return { version: 1, id, name, width: 1920, height: 1080, fps: 30, duration: Math.max(30, clips.length), themeId: 'midnight', media: [],
    tracks: [{ id: 't-1', name: '序列 1', clips }, { id: 't-2', name: '序列 2', clips: [] }] };
}

test('账号办法的搬到云端:真的账号服务与文档服务', { timeout: 300_000 }, async (t) => {
  const fixture = await startAccountDualUserFixture({ ports: await freePorts(7) });
  t.after(() => fixture.close());
  const ca = fs.readFileSync(fixture.caFile);
  const origin = fixture.origin;
  const wsUrl = `${origin.replace(/^https:/, 'wss:')}/hosted/`;
  class CaWebSocket extends WS { constructor(url, protocols) { super(url, protocols, { ca }); } }

  const requests = [];
  const post = (route, body, token) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    requests.push({ route, bytes: Buffer.byteLength(data) });
    const req = https.request(new URL(route, origin), { method: 'POST', ca, timeout: 20_000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(e); } });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });

  /** 桌面外壳账号桥的替身:登录、凭恢复凭证续、带访问令牌的请求(路径白名单照外壳的);`fault(path)` 可以让某个请求出故障 */
  function bridge() {
    const b = { vault: null, fault: null };
    const out = (r) => (r.status === 200 || r.status === 201 ? r.body : { ok: false, status: r.status, code: r.body?.code ?? r.body?.error });
    b.native = async (operation, args = {}) => {
      if (operation === 'login') {
        const r = await post('/api/account/editor/login', args);
        if (r.status === 200) b.vault = { recoveryToken: r.body.recoveryToken, deviceId: args.deviceId };
        return out(r);
      }
      if (operation === 'recover') {
        if (!b.vault) return null;
        const r = await post('/api/account/editor/recover', { recoveryToken: b.vault.recoveryToken, deviceId: b.vault.deviceId, requestId: randomUUID() });
        if (r.status === 200) b.vault.recoveryToken = r.body.recoveryToken;
        return out(r);
      }
      if (operation === 'request') {
        assert.ok(['/hosted/shared/account/create', '/hosted/shared/account/join', '/hosted/shared/account/session', '/hosted/shared/account/admin', '/hosted/shared/account/members'].includes(args.path), `外壳不放行的路径 ${args.path}`);
        assert.ok(Buffer.byteLength(JSON.stringify(args)) < 1024 * 1024, '外壳的账号桥一次请求不能超过 1 MiB');
        const fault = b.fault?.(args.path);
        if (fault === 'unreachable') return { ok: false, status: 0, code: 'network' };
        if (typeof fault === 'number') return { ok: false, status: fault, code: fault === 404 ? 'no-route' : 'authority-unavailable' };
        const r = await post(args.path, args.body, args.accessToken);
        if (fault === 'drop-response') return { ok: false, status: 0, code: 'network' };
        return out(r);
      }
      throw new Error(`bad operation ${operation}`);
    };
    return b;
  }
  async function signedIn(i, deviceId) {
    const b = bridge();
    const client = createAccountClient({ online: false, origin, device: { deviceId, deviceName: deviceId }, native: b.native });
    const account = await client.login(fixture.accounts[i].name, fixture.accounts[i].password, false);
    return { b, client, account };
  }
  const a = await signedIn(0, 'move-device-a');
  const other = await signedIn(1, 'move-device-b');

  const tenantsDir = (() => {
    const walk = (dir, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name === 'tenants') return path.join(dir, e.name);
        if (depth > 0) { const hit = walk(path.join(dir, e.name), depth - 1); if (hit) return hit; }
      }
      return null;
    };
    return walk(path.join(fixture.fixtureDir, 'doc'), 2);
  })();
  assert.ok(tenantsDir, '找不到云端文档服务的项目目录');
  /** 云端文档服务里有内容的项目号(每个账号项目一个目录) */
  const cloudProjects = () => fs.readdirSync(tenantsDir).filter((n) => /^sp_[a-z2-7]{26}$/.test(n)).sort();
  const baseline = cloudProjects().length;

  /** 一台桌面上打开的一个本地项目:真的账号客户端与内容连接,本机一侧是替身 */
  function desk(who, local, { storage = memoryStorage(), link = {} } = {}) {
    const d = { local, storage, calls: [], stages: [], links: [], ticketFault: null, entered: null };
    const linkTo = (projectId) => ({
      url: wsUrl, WebSocketImpl: CaWebSocket, ...link,
      ticket: async () => {
        if (d.ticketFault) throw d.ticketFault;
        return (await who.client.session(projectId, { minRemainingMs: 60_000 })).connectionTicket;
      },
      onLink: (l) => { d.links.push(l); d.onLink?.(l); },
    });
    d.deps = {
      source: () => (d.entered ? null : { kind: 'local', contentId: d.local.id }),
      account: async () => who.client.account ?? await who.client.restore(),
      create: (name, stub, requestId) => { d.calls.push('create'); return who.client.create(name, stub, requestId); },
      snapshot: async () => structuredClone(d.local),
      current: () => d.local,
      upload: (projectId, snapshot) => { d.calls.push('upload'); return M.uploadProjectContent(linkTo(projectId), projectId, snapshot).then((r) => { d.lastUpload = r; return r; }); },
      read: async (projectId) => { d.calls.push('read'); return (await M.readProjectContent(linkTo(projectId), projectId, d.local)).project; },
      saveLocal: async () => { d.calls.push('save'); },
      enter: async (x) => { d.calls.push('enter'); d.entered = x; },
      queueMedia: async () => { d.calls.push('queue'); return { queued: 0, missing: [] }; },
      attempts: M.createAttemptStore(storage),
      newRequestId: () => `move-${randomUUID()}`,
      stub: (name, contentId) => ({ version: 1, id: contentId, name, width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips: [] }] }),
      linkOf: (projectId) => projectLink(origin, projectId),
      onStage: (s) => d.stages.push(s),
    };
    d.move = (name = d.local.name) => M.moveToAccountCloud(d.deps, { name });
    d.attempt = () => d.deps.attempts.get(who.account.id, d.local.id);
    d.touchedLocal = () => d.calls.filter((c) => ['save', 'enter', 'queue'].includes(c));
    return d;
  }
  /** 另一个账号凭项目号加入,读到的内容 */
  async function readAs(who, projectId) {
    await who.client.join(projectId, randomUUID());
    const r = await M.readProjectContent({ url: wsUrl, WebSocketImpl: CaWebSocket,
      ticket: async () => (await who.client.session(projectId, { minRemainingMs: 60_000 })).connectionTicket }, projectId, { tracks: [] });
    return r.project;
  }

  await t.test('1 本地项目搬上去,正文大于 1 MiB', async () => {
    const local = bigProject('local-content-1', '搬迁测试·大正文', 500_000);
    const bytes = Buffer.byteLength(JSON.stringify(local));
    assert.ok(bytes > 1024 * 1024, `正文要大于 1 MiB,实际 ${bytes}`);
    const d = desk(a, local);
    const mark = requests.length;
    const r = await d.move();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.projectId, /^sp_[a-z2-7]{26}$/);
    assert.equal(r.link, `${origin}/editor?project=${r.projectId}`);
    assert.deepEqual(d.calls, ['create', 'upload', 'read', 'save', 'enter', 'queue']);
    const create = requests.slice(mark).filter((q) => q.route === '/hosted/shared/account/create');
    assert.equal(create.length, 1);
    assert.ok(create[0].bytes < 2048, `新建请求体只带占位,实际 ${create[0].bytes} 字节`);
    assert.equal(d.lastUpload.wrote, true);
    assert.equal(d.lastUpload.rev, 2, '占位是第 1 版,正文是第 2 版');
    assert.equal(d.attempt(), null);
    const seen = await readAs(other, r.projectId);
    assert.equal(M.sameContent(seen, local), true, '第二个账号读到的内容与本机逐字段相同');
    assert.equal(seen.tracks[0].clips.length, local.tracks[0].clips.length);
    assert.equal(cloudProjects().length, baseline + 1);
    console.log(`1 正文 ${bytes} 字节,新建请求体 ${create[0].bytes} 字节,落地版本 ${d.lastUpload.rev},第二个账号读到 ${seen.tracks[0].clips.length} 个片段`);
  });

  await t.test('2 没登录', async () => {
    const b = bridge();
    const client = createAccountClient({ online: false, origin, device: { deviceId: 'move-device-none', deviceName: 'none' }, native: b.native });
    const d = desk({ client, account: { id: 'acc_none' } }, bigProject('local-content-2', '没登录的项目', 2000));
    const before = cloudProjects().length;
    const r = await d.move();
    assert.deepEqual(r, { ok: false, error: 'login-required', stage: 'check', localClosed: false, cloud: null });
    assert.deepEqual(d.calls, []);
    assert.equal(cloudProjects().length, before);
    assert.equal(d.storage.map.size, 0);
  });

  await t.test('3 名字重', async () => {
    const d = desk(other, bigProject('local-content-3', '搬迁测试·大正文', 2000));
    const before = cloudProjects().length;
    const r = await d.move();
    assert.equal(r.ok, false); assert.equal(r.error, 'name-taken'); assert.equal(r.stage, 'create'); assert.equal(r.cloud, null); assert.equal(r.localClosed, false);
    assert.deepEqual(d.calls, ['create']);
    assert.equal(cloudProjects().length, before);
    assert.equal(d.attempt(), null);
    const again = await d.move('搬迁测试·换了名字');
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.name, '搬迁测试·换了名字');
    assert.equal(cloudProjects().length, before + 1);
    assert.equal(M.sameContent(await readAs(a, again.projectId), d.local), true);
  });

  await t.test('4 正文传到一半传输被掐', async () => {
    const local = bigProject('local-content-4', '搬迁测试·掐传输', 700_000);
    const d = desk(a, local);
    const cuts = [];
    let resumes = 0;
    // 上传的那条连接(第一条):根替换发出去之后掐两次传输
    d.onLink = (l) => {
      if (d.links.length !== 1) return;
      const timer = setInterval(() => {
        if (l.ds.unconfirmed > 0 && cuts.length < 2) cuts.push(l.cutTransport());
        resumes = Math.max(resumes, l.stats()?.resumes ?? 0);
        if (d.entered) clearInterval(timer);
      }, 15);
    };
    const r = await d.move();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(cuts.includes(true), `至少掐到一次(${JSON.stringify(cuts)})`);
    assert.equal(M.sameContent(await readAs(other, r.projectId), local), true);
    assert.ok(resumes >= 1, '会话在同一条连接上接续过(不是重建)');
    console.log(`4 掐了 ${cuts.filter(Boolean).length} 次传输,会话接续 ${resumes} 次,内容一致`);
  });

  await t.test('5 正文传到一半会话断掉', async () => {
    const local = bigProject('local-content-5', '搬迁测试·断会话', 700_000);
    const d = desk(a, local);
    let dropped = 0;
    d.onLink = (l) => {
      if (d.links.length !== 1) return;
      const timer = setInterval(() => {
        if (l.ds.unconfirmed > 0 && !dropped) { dropped++; l.dropFor(300); }
        if (dropped || d.entered) clearInterval(timer);
      }, 10);
    };
    const r = await d.move();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(dropped, 1);
    assert.equal(M.sameContent(await readAs(other, r.projectId), local), true);
  });

  await t.test('6 中途云端不可用:本机没动;恢复后再点一次,没有多出重名项目', async () => {
    const local = bigProject('local-content-6', '搬迁测试·中途 503', 300_000);
    const d = desk(a, local, { link: { timeoutMs: 2500 } });
    const before = cloudProjects().length;
    d.ticketFault = Object.assign(new Error('authority-unavailable'), { status: 503, code: 'authority-unavailable' });
    const failed = await d.move();
    assert.equal(failed.ok, false); assert.equal(failed.error, 'upload-failed'); assert.equal(failed.stage, 'upload'); assert.equal(failed.localClosed, false);
    assert.match(failed.cloud.projectId, /^sp_[a-z2-7]{26}$/);
    assert.deepEqual(d.touchedLocal(), [], '本机一侧什么都没被调');
    assert.equal(d.attempt().projectId, failed.cloud.projectId);
    assert.equal(cloudProjects().length, before + 1, '云端项目建了一个(内容还是占位)');
    d.ticketFault = null;
    const stub = (await M.readProjectContent({ url: wsUrl, WebSocketImpl: CaWebSocket, ticket: async () => (await a.client.session(failed.cloud.projectId)).connectionTicket }, failed.cloud.projectId, { tracks: [] })).project;
    assert.equal(stub.tracks[0].clips.length, 0, '失败时云端内容还是占位');
    const creates = d.calls.filter((c) => c === 'create').length;
    const r = await d.move('换了名字也不另建');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.projectId, failed.cloud.projectId, '接着用同一个项目');
    assert.equal(r.name, '搬迁测试·中途 503');
    assert.equal(d.calls.filter((c) => c === 'create').length, creates, '没有再发新建');
    assert.equal(cloudProjects().length, before + 1, '云端项目总数只加一');
    assert.equal(M.sameContent(await readAs(other, r.projectId), local), true);
    await assert.rejects(other.client.create('搬迁测试·中途 503', d.deps.stub('搬迁测试·中途 503', 'x'), randomUUID()), (e) => e.status === 409 && e.code === 'name-taken');
    assert.equal(cloudProjects().length, before + 1);
  });

  await t.test('7 新建的回包丢了:再点一次用同一个请求号,拿回同一个项目', async () => {
    const local = bigProject('local-content-7', '搬迁测试·回包丢失', 3000);
    const d = desk(a, local);
    const before = cloudProjects().length;
    a.b.fault = (p) => (p === '/hosted/shared/account/create' ? 'drop-response' : null);
    const failed = await d.move();
    assert.equal(failed.ok, false); assert.equal(failed.error, 'network'); assert.equal(failed.stage, 'create'); assert.equal(failed.cloud, null);
    assert.deepEqual(d.touchedLocal(), []);
    const kept = d.attempt();
    assert.ok(kept && !kept.projectId, '本机只知道结果不确定');
    assert.equal(cloudProjects().length, before + 1, '其实云端已经建了');
    a.b.fault = null;
    const r = await d.move();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(cloudProjects().length, before + 1, '同一个请求号,没有建第二个');
    assert.equal(M.sameContent(await readAs(other, r.projectId), local), true);
    a.b.fault = (p) => (p === '/hosted/shared/account/create' ? 503 : null);
    const d2 = desk(a, bigProject('local-content-7b', '搬迁测试·云端 503', 3000));
    const f2 = await d2.move();
    assert.equal(f2.error, 'create-failed'); assert.deepEqual(d2.touchedLocal(), []);
    assert.equal(d2.attempt().requestId.startsWith('move-'), true);
    a.b.fault = null;
    assert.equal((await d2.move()).ok, true);
    assert.equal(cloudProjects().length, before + 2);
  });

  await t.test('8 不是账号模式的节点', async () => {
    const d = desk(a, bigProject('local-content-8', '搬迁测试·旧节点', 2000));
    const before = cloudProjects().length;
    a.b.fault = (p) => (p === '/hosted/shared/account/create' ? 404 : null);
    const r = await d.move();
    a.b.fault = null;
    assert.equal(r.ok, false); assert.equal(r.error, 'not-account-cloud'); assert.equal(r.cloud, null); assert.equal(r.localClosed, false);
    assert.deepEqual(d.touchedLocal(), []);
    assert.equal(d.attempt(), null);
    assert.equal(cloudProjects().length, before);
    assert.match(M.moveFailureText(r, 'local'), /不接受网站账号/);
  });

  await t.test('9 同一个账号从两台设备各搬一个本地项目', async () => {
    const second = await signedIn(0, 'move-device-a2');
    assert.equal(second.account.id, a.account.id);
    const d1 = desk(a, bigProject('local-content-9a', '搬迁测试·设备一', 2000));
    const d2 = desk(second, bigProject('local-content-9b', '搬迁测试·设备二', 2000));
    const [r1, r2] = await Promise.all([d1.move(), d2.move()]);
    assert.equal(r1.ok, true, JSON.stringify(r1)); assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.notEqual(r1.projectId, r2.projectId);
    // 另一台设备上的同一个账号也是创建者,能直接进(不用加入)
    const fromOtherDevice = (await M.readProjectContent({ url: wsUrl, WebSocketImpl: CaWebSocket,
      ticket: async () => { const s = await second.client.session(r1.projectId); assert.equal(s.creator, true); return s.connectionTicket; } }, r1.projectId, { tracks: [] })).project;
    assert.equal(M.sameContent(fromOtherDevice, d1.local), true);
  });
  await sleep(50);
});
