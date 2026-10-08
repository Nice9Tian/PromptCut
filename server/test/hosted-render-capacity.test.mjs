/**
 * HR21：渲染服务产物的容量记账（契约 `docs/plan/hosted-render-contract.md` 第 6 节；`server/asset-store/service-usage.mjs`）。
 * 跑：node --test server/test/hosted-render-capacity.test.mjs
 *
 *   HR21a 记账：凭 `sv` 票据写成的块记一笔（块、大小、项目）；成员写的块不记；渲染服务写一个成员早已写过的块不记
 *   HR21b 上限：到上限只拦渲染服务的写入（507 `service-quota`），成员的写入照常；已记账的块再写不占名额
 *   HR21c 在途占名额：第一片到了、还没收尾的新块先占住上限，并发写冲不穿
 *   HR21d 删项目：清只归这个项目的块；几个项目共有的块不清，最后一个项目删了才清；成员写的块不动
 *   HR21e 重启：记账表回放一致；半行不坏；日志行数明显多于存活条目时压缩
 *   HR21f 成员后来写了同一个块：不再只归渲染服务，删项目时不清
 *   HR21g 上限的算法：`min(20 GiB, 盘总容量的四分之一)`，环境变量可改
 *   HR21h 淘汰的前提（契约第 6 节第 2 条）：清掉的块在内容库清单里还有引用时，页面不会把它当「没有产物」重新发补渲——前提不成立，所以淘汰没有交付
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';

import { startHostedCombo, hostedPaths } from '../hosted/combo.mjs';
import { forgetCredentialStore } from '../auth/store.mjs';
import { createSharedProject, buildAuthProtocols } from '../auth/client.mjs';
import { createWsEndpoint } from '../render-node/ws-transport.mjs';
import { createTicketSource } from '../auth/ticket-source.mjs';
import { createAssetClient } from '../asset-store/client.mjs';
import { createServiceUsage, serviceCapBytes, SERVICE_CAP_ENV, SERVICE_USAGE_FILE } from '../asset-store/service-usage.mjs';
import { wsClient, ask } from './auth-kit.mjs';
import { enrollService, serviceProtocolsFor, requestServiceTicket, TICKET_PREFIX } from './hosted-render-kit.mjs';
import { srcUrl } from '../../src/testing/registerTs.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr21-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
let seq = 0;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** 恰好 n 字节、内容各不相同的块(n 至少 60) */
const bytesOf = (n, tag = '') => {
  const head = Buffer.from(`${tag}:${crypto.randomBytes(8).toString('hex')}:`);
  assert.ok(n >= head.length);
  return Buffer.concat([head, Buffer.alloc(n - head.length, 7)]);
};
const PROTOCOL = 'promptcut.v1';

/** 起一台托管组合：登记表里有 render，端口 0，本机信任关掉；`cap` 是渲染服务产物的上限 */
async function startCombo({ cap, dir } = {}) {
  const dataDir = dir ?? path.join(TMP, `hosted-${++seq}`);
  fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true });
  let key = null;
  if (!dir) key = enrollService(hostedPaths(dataDir).servicesFile, { service: 'render' });
  const logs = [];
  const combo = await startHostedCombo({
    dataDir, docPort: 0, assetPort: 0, host: '127.0.0.1', trustLoopback: false, clusterToken: crypto.randomBytes(32).toString('base64url'),
    ...(cap !== undefined ? { renderCapBytes: cap } : {}), log: (event, fields) => logs.push({ event, ...fields }),
  });
  combo.logs = logs;
  combo.dataDir = dataDir;
  combo.key = key;
  return combo;
}
async function closeCombo(c) {
  await c.close();
  forgetCredentialStore(c.paths.auth);
}

async function newProject(c, name = `hr21-${crypto.randomBytes(3).toString('hex')}`) {
  const creator = { username: 'creator', password: 'creator-pw-1' };
  const password = 'project-pw-1';
  const created = await createSharedProject({ base: `http://127.0.0.1:${c.docPort}`, name, mode: 'free', creator, password });
  return { ...created, creator, password };
}

/** 成员：凭证连接 + 素材客户端（`rw`） */
async function member(c, p, username = 'alice') {
  const base = `http://127.0.0.1:${c.docPort}`;
  const deviceId = `hr21-${crypto.randomBytes(6).toString('hex')}`;
  const ep = createWsEndpoint({
    url: `ws://127.0.0.1:${c.docPort}`,
    protocols: () => buildAuthProtocols({ base, projectId: p.projectId, username, deviceId, deviceName: 'hr21', as: 'member', password: p.password, role: 'page' }),
    backoff: { baseMs: 50, maxMs: 200 },
  });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('连不上')), 10_000); ep.onOpen(() => { clearTimeout(t); resolve(); }); });
  const ticket = createTicketSource(ep, { access: 'rw' });
  const client = createAssetClient({ base: `http://127.0.0.1:${c.assetPort}/api/asset`, ticket });
  /** 不先对账、直接 PUT 一片再收尾(两路同时推同一内容时会发生;素材客户端见到已入库会跳过,走不到这里) */
  async function rawPut(ns, buf) {
    const hash = sha256(buf);
    const headers = { Authorization: `Bearer ${await ticket()}`, 'X-Media-Size': String(buf.length), 'X-Media-Ext': 'm4s' };
    const chunk = await fetch(`http://127.0.0.1:${c.assetPort}/api/asset/${ns}/${hash}/0`, { method: 'PUT', headers, body: buf });
    const done = await fetch(`http://127.0.0.1:${c.assetPort}/api/asset/${ns}/${hash}/complete`, { method: 'POST', headers: { Authorization: headers.Authorization } });
    return { chunk: chunk.status, done: done.status };
  }
  return { client, rawPut, close: () => { ep.close(); } };
}

/** 渲染服务：控制连接、给某个项目要票据、开数据连接、要素材票据；`put` 直接按素材服务的 HTTP 写一个块 */
async function renderService(c) {
  const env = {
    async http(rel, { method = 'GET', body } = {}) {
      const r = await fetch(`http://127.0.0.1:${c.docPort}/${rel}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: r.status, json, text };
    },
  };
  const p = await serviceProtocolsFor(env, c.key);
  const control = wsClient(`ws://127.0.0.1:${c.docPort}/`, p.protocols);
  await control.opened;
  const open = [control];
  const tickets = new Map();
  async function ticketFor(projectId) {
    if (tickets.has(projectId)) return tickets.get(projectId);
    const r = await requestServiceTicket(control, projectId);
    assert.equal(r.type, 'hosted.ticket.ok', JSON.stringify(r));
    const data = wsClient(`ws://127.0.0.1:${c.docPort}/`, [PROTOCOL, TICKET_PREFIX + r.ticket]);
    await data.opened;
    open.push(data);
    const t = await ask(data, { type: 'auth.ticket', kind: 'asset', access: 'rw' }, 'auth.ticket.ok');
    assert.equal(t.type, 'auth.ticket.ok', JSON.stringify(t));
    tickets.set(projectId, t.ticket);
    return t.ticket;
  }
  const assetUrl = (rel) => `http://127.0.0.1:${c.assetPort}/api/asset/${rel}`;
  async function put(projectId, ns, buf, { complete = true, hash = sha256(buf) } = {}) {
    const ticket = await ticketFor(projectId);
    const headers = { Authorization: `Bearer ${ticket}`, 'X-Media-Size': String(buf.length), 'X-Media-Ext': ns === 'snap' ? 'html' : 'm4s' };
    const chunk = await fetch(assetUrl(`${ns}/${hash}/0`), { method: 'PUT', headers, body: buf });
    const chunkBody = await chunk.json().catch(() => null);
    if (!complete || chunk.status !== 200) return { hash, status: chunk.status, body: chunkBody };
    const done = await fetch(assetUrl(`${ns}/${hash}/complete`), { method: 'POST', headers: { Authorization: `Bearer ${ticket}` } });
    return { hash, status: done.status, body: await done.json().catch(() => null), chunkStatus: chunk.status };
  }
  async function finish(projectId, ns, hash) {
    const ticket = await ticketFor(projectId);
    const done = await fetch(assetUrl(`${ns}/${hash}/complete`), { method: 'POST', headers: { Authorization: `Bearer ${ticket}` } });
    return { status: done.status, body: await done.json().catch(() => null) };
  }
  return { put, finish, ticketFor, close: () => { for (const x of open) x.close(); } };
}

const stored = async (c, ns, hash) => !!(await c.stores[ns].stat(hash));

test('HR21a 记账:sv 票据写成的块记一笔;成员写的不记;渲染服务写成员早已写过的块不记', async (t) => {
  const c = await startCombo({ cap: 1_000_000 });
  t.after(() => closeCombo(c));
  const p = await newProject(c);
  const svc = await renderService(c);
  t.after(() => svc.close());
  const m = await member(c, p);
  t.after(() => m.close());

  const a = bytesOf(1000, 'a');
  const r1 = await svc.put(p.projectId, 'px', a);
  assert.equal(r1.status, 200, JSON.stringify(r1));
  assert.equal(c.serviceUsage.has('px', sha256(a)), true, '渲染服务写的块记账了');
  assert.deepEqual(c.serviceUsage.projectsOf('px', sha256(a)), [p.projectId]);
  assert.equal(c.serviceUsage.usedBytes(), 1000);

  const s = bytesOf(700, 's');
  assert.equal((await svc.put(p.projectId, 'snap', s)).status, 200);
  assert.equal(c.serviceUsage.usedBytes(), 1700, 'snap 也记');

  const mine = bytesOf(4000, 'member');
  await m.client.put('px', mine, { ext: 'm4s' });
  assert.equal(await stored(c, 'px', sha256(mine)), true);
  assert.equal(c.serviceUsage.has('px', sha256(mine)), false, '成员写的块不记');
  assert.equal(c.serviceUsage.usedBytes(), 1700);

  const dup = await svc.put(p.projectId, 'px', mine);
  assert.equal(dup.status, 200, '成员已写过的块,渲染服务再写也是 200(没有新字节)');
  assert.equal(c.serviceUsage.has('px', sha256(mine)), false, '别人写的块不算渲染服务的');
  assert.equal(c.serviceUsage.usedBytes(), 1700);

  // 写素材原件:仍然 403(第 1 批的限制不退步)
  const ticket = await svc.ticketFor(p.projectId);
  const media = bytesOf(100, 'media');
  const bad = await fetch(`http://127.0.0.1:${c.assetPort}/api/asset/media/${sha256(media)}/0`, { method: 'PUT', headers: { Authorization: `Bearer ${ticket}`, 'X-Media-Size': '100' }, body: media });
  assert.equal(bad.status, 403);
  assert.equal(c.serviceUsage.usedBytes(), 1700, '被拒的写入不记');
});

test('HR21b 上限:到上限只拦渲染服务(507 service-quota),成员照常;已记账的块再写不占名额', async (t) => {
  const c = await startCombo({ cap: 2500 });
  t.after(() => closeCombo(c));
  const p = await newProject(c);
  const svc = await renderService(c);
  t.after(() => svc.close());
  const m = await member(c, p);
  t.after(() => m.close());

  const b1 = bytesOf(1000, 'b1');
  const b2 = bytesOf(1000, 'b2');
  const b3 = bytesOf(1000, 'b3');
  assert.equal((await svc.put(p.projectId, 'px', b1)).status, 200);
  assert.equal((await svc.put(p.projectId, 'px', b2)).status, 200);
  const over = await svc.put(p.projectId, 'px', b3);
  assert.equal(over.status, 507, JSON.stringify(over));
  assert.equal(over.body?.error, 'service-quota', '明确的原因');
  assert.equal(c.serviceUsage.usedBytes(), 2000);
  assert.equal(await stored(c, 'px', sha256(b3)), false, '被拦的块没落盘');
  const chunks = await fetch(`http://127.0.0.1:${c.assetPort}/api/asset/px/${sha256(b3)}/chunks`, { headers: { Authorization: `Bearer ${await svc.ticketFor(p.projectId)}` } }).then((r) => r.json());
  assert.deepEqual(chunks.received, [], '没有收到任何分片');

  // 成员不受影响,而且写得比渲染服务的上限还大
  const big = bytesOf(50_000, 'member-big');
  await m.client.put('px', big, { ext: 'm4s' });
  assert.equal(await stored(c, 'px', sha256(big)), true, '成员的写入不受上限影响');
  assert.equal(c.serviceUsage.usedBytes(), 2000, '成员写的不记账');

  // 已记账的块再写:没有新字节,不占名额,不被拦
  assert.equal((await svc.put(p.projectId, 'px', b1)).status, 200);
  assert.equal(c.serviceUsage.usedBytes(), 2000);
  // 成员写的块渲染服务再写:没有新字节,不被拦
  assert.equal((await svc.put(p.projectId, 'px', big)).status, 200);

  // 上限之内还放得下的照常
  const small = bytesOf(400, 'small');
  assert.equal((await svc.put(p.projectId, 'px', small)).status, 200);
  assert.equal(c.serviceUsage.usedBytes(), 2400);
});

test('HR21c 在途占名额:第一片到了还没收尾的新块先占住上限,并发写冲不穿;失败的写入放掉名额', async (t) => {
  const c = await startCombo({ cap: 2500 });
  t.after(() => closeCombo(c));
  const p = await newProject(c);
  const svc = await renderService(c);
  t.after(() => svc.close());

  const x = bytesOf(1500, 'x');
  const y = bytesOf(1500, 'y');
  const first = await svc.put(p.projectId, 'px', x, { complete: false });
  assert.equal(first.status, 200);
  assert.equal(c.serviceUsage.reservedBytes(), 1500, '在途的块占着名额');
  assert.equal(c.serviceUsage.usedBytes(), 0, '没收尾的不算已记账');
  const second = await svc.put(p.projectId, 'px', y, { complete: false });
  assert.equal(second.status, 507, '第二个 1500 放不下(1500 + 1500 > 2500)');
  assert.equal(second.body?.error, 'service-quota');
  const done = await svc.finish(p.projectId, 'px', sha256(x));
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal(c.serviceUsage.usedBytes(), 1500);
  assert.equal(c.serviceUsage.reservedBytes(), 0, '收尾后名额换成了记账');

  // 哈希对不上:这次写入失败,名额放掉
  const z = bytesOf(900, 'z');
  const wrongHash = sha256(Buffer.from('not-the-content'));
  const bad = await svc.put(p.projectId, 'px', z, { hash: wrongHash });
  assert.equal(bad.status, 409, JSON.stringify(bad));
  assert.equal(c.serviceUsage.reservedBytes(), 0, '哈希对不上,在途名额放掉');
  assert.equal(c.serviceUsage.usedBytes(), 1500);
});

test('HR21d 删项目:清只归它的块;几个项目共有的块最后一个项目删了才清;成员写的块不动', async (t) => {
  const c = await startCombo({ cap: 1_000_000 });
  t.after(() => closeCombo(c));
  const p1 = await newProject(c);
  const p2 = await newProject(c);
  const svc = await renderService(c);
  t.after(() => svc.close());
  const m = await member(c, p1);
  t.after(() => m.close());

  const only1 = bytesOf(800, 'only1');
  const shared = bytesOf(900, 'shared');
  const only2 = bytesOf(700, 'only2');
  const memberBlock = bytesOf(600, 'member');
  await svc.put(p1.projectId, 'px', only1);
  await svc.put(p1.projectId, 'snap', shared);
  await svc.put(p2.projectId, 'snap', shared); // 内容相同,第二个项目也写到了
  await svc.put(p2.projectId, 'px', only2);
  await m.client.put('px', memberBlock, { ext: 'm4s' });
  assert.deepEqual(c.serviceUsage.projectsOf('snap', sha256(shared)).sort(), [p1.projectId, p2.projectId].sort(), '同一个块记两个项目');
  assert.equal(c.serviceUsage.usedBytes(), 800 + 900 + 700, '共有的块只算一份字节');

  // 删项目 1(凭证存储删记录就是共享项目的 delete 走的那一步)
  assert.equal(c.credentialStore.remove(p1.projectId), true);
  await waitFor(async () => !(await stored(c, 'px', sha256(only1))), '只归项目 1 的块被清');
  assert.equal(await stored(c, 'snap', sha256(shared)), true, '共有的块还在');
  assert.equal(await stored(c, 'px', sha256(only2)), true);
  assert.equal(await stored(c, 'px', sha256(memberBlock)), true, '成员写的块不动');
  assert.equal(c.serviceUsage.usedBytes(), 900 + 700);
  assert.deepEqual(c.serviceUsage.projectsOf('snap', sha256(shared)), [p2.projectId]);

  assert.equal(c.credentialStore.remove(p2.projectId), true);
  await waitFor(async () => !(await stored(c, 'snap', sha256(shared))) && !(await stored(c, 'px', sha256(only2))), '项目 2 删了,剩下的也清');
  assert.equal(c.serviceUsage.usedBytes(), 0);
  assert.equal(await stored(c, 'px', sha256(memberBlock)), true, '成员写的块始终不动');
});

test('HR21e 重启:回放一致;半行不坏;行数明显多于存活条目时压缩', async (t) => {
  const c1 = await startCombo({ cap: 1_000_000 });
  const dataDir = c1.dataDir;
  const key = c1.key;
  const p = await newProject(c1);
  const svc = await renderService(c1);
  const a = bytesOf(500, 'ra');
  const b = bytesOf(600, 'rb');
  await svc.put(p.projectId, 'px', a);
  await svc.put(p.projectId, 'snap', b);
  const before = c1.serviceUsage.status();
  svc.close();
  await closeCombo(c1);

  // 崩溃留下半行:回放时跳过
  const file = path.join(dataDir, 'assets', '.service-usage', SERVICE_USAGE_FILE);
  fs.appendFileSync(file, '{"op":"add","ns":"px","hash":"abc');
  const c2 = await startCombo({ dir: dataDir, cap: 1_000_000 });
  c2.key = key;
  t.after(() => closeCombo(c2));
  assert.equal(c2.serviceUsage.usedBytes(), before.usedBytes);
  assert.equal(c2.serviceUsage.blockCount(), 2);
  assert.equal(c2.serviceUsage.has('px', sha256(a)), true);
  assert.deepEqual(c2.serviceUsage.projectsOf('snap', sha256(b)), [p.projectId]);

  // 压缩:大量 add / drop 之后启动时重写成只含存活条目
  const dir = path.join(TMP, `compact-${++seq}`);
  const u = createServiceUsage({ dir, capBytes: 1e9, options: { compactSlack: 5, compactFactor: 1 } });
  const h = (i) => sha256(Buffer.from(`block-${i}`));
  for (let i = 0; i < 20; i++) u.record({ ns: 'px', hash: h(i), size: 10, projectId: 'pa' });
  for (let i = 0; i < 18; i++) u.dropProject('pa');
  assert.ok(u.lineCount() > 30);
  const u2 = createServiceUsage({ dir, capBytes: 1e9, options: { compactSlack: 5, compactFactor: 1 } });
  assert.equal(u2.blockCount(), 0, 'drop-project 回放后一块不剩');
  assert.ok(u2.lineCount() <= 5, `压缩后行数 ${u2.lineCount()}`);
  assert.equal(fs.readFileSync(path.join(dir, SERVICE_USAGE_FILE), 'utf8').trim(), '', '压缩后的文件只含存活条目(这里是空的)');
});

test('HR21f 成员后来写了同一个块:不再只归渲染服务,删项目时不清', async (t) => {
  const c = await startCombo({ cap: 1_000_000 });
  t.after(() => closeCombo(c));
  const p = await newProject(c);
  const svc = await renderService(c);
  t.after(() => svc.close());
  const m = await member(c, p);
  t.after(() => m.close());
  const z = bytesOf(800, 'z');
  await svc.put(p.projectId, 'px', z);
  assert.equal(c.serviceUsage.has('px', sha256(z)), true);
  const raw = await m.rawPut('px', z); // 内容相同:数据层已入库,成员这一笔没有再写字节,但块从此也是成员的
  assert.deepEqual(raw, { chunk: 200, done: 200 });
  assert.equal(c.serviceUsage.has('px', sha256(z)), false, '摘账');
  assert.equal(c.credentialStore.remove(p.projectId), true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await stored(c, 'px', sha256(z)), true, '删项目没有清它');
});

test('HR21g 上限的算法:min(20 GiB, 盘总容量的四分之一);环境变量可改;盘容量取不到就是 20 GiB', () => {
  const GiB = 1024 ** 3;
  assert.equal(serviceCapBytes({ env: {}, diskTotal: null }), 20 * GiB);
  assert.equal(serviceCapBytes({ env: {}, diskTotal: 1000 * GiB }), 20 * GiB, '大盘取 20 GiB');
  assert.equal(serviceCapBytes({ env: {}, diskTotal: 39 * GiB }), Math.floor(39 * GiB * 0.25), '小盘取四分之一');
  assert.equal(serviceCapBytes({ env: {}, diskTotal: 80 * GiB }), 20 * GiB, '80 GiB 的盘正好两者相等');
  assert.equal(serviceCapBytes({ env: { [SERVICE_CAP_ENV]: '12345' }, diskTotal: 39 * GiB }), 12345, '环境变量优先');
  assert.equal(serviceCapBytes({ env: { [SERVICE_CAP_ENV]: 'abc' }, diskTotal: 40 * GiB }), 10 * GiB, '不是数就不认');
  assert.equal(serviceCapBytes({ env: { [SERVICE_CAP_ENV]: '0' }, diskTotal: 40 * GiB }), 0, '0 是合法值(等于不让写)');
});

test('HR21h 淘汰的前提不成立:块被清掉、清单还列着它时,页面不会重新发补渲(所以契约第 6 节第 2 条没有交付)', async () => {
  const { OnlineSnapshotSource, LAYER_MAP_PREFIX } = await import(srcUrl('render/snapshotSource.ts'));
  const H = (n) => n.toString(16).padStart(64, '0');
  const content = new Map();
  const fetches = [];
  const deps = {
    async request(msg) {
      if (!content.has(msg.key)) return { type: 'content.item', kind: msg.kind, key: msg.key, missing: true };
      return { type: 'content.item', kind: msg.kind, key: msg.key, body: structuredClone(content.get(msg.key)), hash: 'x' };
    },
    assetBase: () => 'https://h.example/media/api/asset/',
    authHeaders: async () => ({ Authorization: 'Bearer RT' }),
    // 素材服务里这些块已经被淘汰:一律 404
    async fetch(url) { fetches.push(url); return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) }; },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  content.set(`${LAYER_MAP_PREFIX}p1`, { v: 1, kind: 'layer-map', projectId: 'p1', fps: 30, span: 60, at: 1, layers: [{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 60 }] });
  const frames = [];
  const small = [];
  for (let f = 0; f < 60; f++) { frames.push([f, H(1000 + f), 10]); small.push([f, H(5000 + f), 20]); }
  content.set('R:0-59', { v: 1, kind: 'snapshot', resultKey: 'R', range: { from: 0, to: 59 }, frames, small });
  const src = new OnlineSnapshotSource(deps);
  src.subscribeReady('s', 0, () => {});
  src.setProject('p1');
  src.focus(0, 30);
  await src.tickNow();
  await new Promise((r) => setTimeout(r, 20));
  await src.tickNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(fetches.length > 0, '页面在取块,而且取不到');
  assert.equal(src.coverage('a'), 'full', '清单还列着,页面认为这一层整段都有产物');
  assert.equal(src.frameConfirmedMissing('a', 5), false, '页面不会确认「这一帧没有产物」,所以补渲的判据(按清单判)不会触发');
  assert.ok(src.stats.errors > 0, '只是一直取不到、下一轮再取');
});

async function waitFor(fn, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) assert.fail(`等 ${what} 超时`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
