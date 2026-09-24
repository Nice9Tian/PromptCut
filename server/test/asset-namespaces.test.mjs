/**
 * 素材服务的三个命名空间 `media` / `snap` / `px`（契约 `docs/plan/artifact-transfer-contract.md` 第 1 节，
 * 第 7 节用例 S1～S4）。
 * 跑：node --test server/test/asset-namespaces.test.mjs
 *
 * 只照契约写，不看实现。`asset-service.ts` 照 C5 的办法转译后 import（`fake-asset-service.mjs`），
 * 三个命名空间都注入 memory 实现（`assetServiceMiddleware(root, { stores: { media, snap, px } })`），
 * 分片调小到 1 KiB，免得每条用例都传几十 MB。
 *
 * S3（`media` 的全部行为不变）的主体由 `npm test` 覆盖：`asset-service.test.mjs`、`asset-store-http.test.mjs`
 * 两个文件本分支不改、照旧全过。这里另补契约第 1 节末条：旧写法 `opts.store` 仍然认，当作 `stores.media`。
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createAssetHarness } from './fake-asset-service.mjs';
import { isAssetServicePath } from '../http-guard.mjs';

const harness = createAssetHarness();
after(() => harness.cleanup());

const NS = ['media', 'snap', 'px'];
const CHUNK = 1024;
const TOKEN = crypto.randomBytes(24).toString('base64url');
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const LAN = 'http://192.168.1.50:8080';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const sliceOf = (buf, n) => buf.subarray(n * CHUNK, Math.min(buf.length, (n + 1) * CHUNK));

const put = (base, ns, hash, n, body, headers = {}) => fetch(`${base}/${ns}/${hash}/${n}`, {
  method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream', ...headers },
});
const complete = (base, ns, hash, headers = {}) => fetch(`${base}/${ns}/${hash}/complete`, { method: 'POST', headers });
const chunks = async (base, ns, hash) => (await fetch(`${base}/${ns}/${hash}/chunks`)).json();

/** 一次回包的快照：状态码、一组响应头、回包体（JSON 解析；二进制取 sha256 和长度） */
const HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control',
  'access-control-allow-origin', 'access-control-expose-headers', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-allow-private-network', 'access-control-max-age',
];
async function snap(resPromise) {
  const r = await resPromise;
  const headers = {};
  for (const k of HEADERS) headers[k] = r.headers.get(k);
  headers['last-modified?'] = r.headers.get('last-modified') !== null;
  const buf = Buffer.from(await r.arrayBuffer());
  let body;
  if (String(r.headers.get('content-type') || '').startsWith('application/json')) {
    try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf.toString('utf8'); }
  } else {
    body = { bytes: buf.length, sha256: buf.length ? sha256(buf) : null };
  }
  return { status: r.status, headers, body };
}

/**
 * S2 的剧本：分片、对账、收尾、Range、HEAD、CORS、401。对一个命名空间跑一遍，
 * 返回 [步骤名, 快照] 列表。服务配了令牌、`isTrusted` 恒假：写入要带令牌。
 */
async function script(base, ns) {
  const out = [];
  const step = async (name, p) => { out.push([name, await snap(p)]); };

  const size = CHUNK * 2 + 321; // 3 片
  const buf = bytesOf(size, 11);
  const hash = sha256(buf);
  const h = { 'X-Media-Size': String(size), 'X-Media-Ext': 'bin', ...AUTH };

  await step('预检（局域网来源）', fetch(`${base}/${ns}/${hash}/0`, {
    method: 'OPTIONS',
    headers: { Origin: LAN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-media-size, authorization', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('预检（公网来源）', fetch(`${base}/${ns}/${hash}/chunks`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('对账：没见过', fetch(`${base}/${ns}/${hash}/chunks`, { headers: { Origin: LAN } }));
  await step('PUT 不带令牌 401', put(base, ns, hash, 0, sliceOf(buf, 0), { 'X-Media-Size': String(size), Origin: LAN }));
  await step('PUT 令牌错 401', put(base, ns, hash, 0, sliceOf(buf, 0), { 'X-Media-Size': String(size), Authorization: `Bearer ${TOKEN}x` }));
  await step('对账：被拒的不算', fetch(`${base}/${ns}/${hash}/chunks`));
  await step('PUT 第 0 片', put(base, ns, hash, 0, sliceOf(buf, 0), { ...h, Origin: LAN }));
  await step('PUT 第 2 片', put(base, ns, hash, 2, sliceOf(buf, 2), h));
  await step('对账：收了 0、2', fetch(`${base}/${ns}/${hash}/chunks`));
  await step('收尾：缺片', complete(base, ns, hash, { ...AUTH, Origin: LAN }));
  await step('补传第 1 片', put(base, ns, hash, 1, sliceOf(buf, 1), h));
  await step('收尾不带令牌 401', complete(base, ns, hash));
  await step('收尾：到齐', complete(base, ns, hash, { ...AUTH, Origin: LAN }));
  await step('对账：已入库', fetch(`${base}/${ns}/${hash}/chunks`));
  await step('入库后重传', put(base, ns, hash, 0, sliceOf(buf, 0), h));
  await step('入库后再收尾', complete(base, ns, hash, AUTH));

  await step('GET 全件', fetch(`${base}/${ns}/${hash}`, { headers: { Origin: LAN } }));
  await step('GET 大写哈希', fetch(`${base}/${ns}/${hash.toUpperCase()}`));
  await step('Range 100-199', fetch(`${base}/${ns}/${hash}`, { headers: { Range: 'bytes=100-199', Origin: LAN } }));
  await step('Range 跨片', fetch(`${base}/${ns}/${hash}`, { headers: { Range: `bytes=${CHUNK - 10}-${CHUNK + 9}` } }));
  await step('Range 尾 10', fetch(`${base}/${ns}/${hash}`, { headers: { Range: 'bytes=-10' } }));
  await step('Range 开口', fetch(`${base}/${ns}/${hash}`, { headers: { Range: `bytes=${size - 5}-` } }));
  await step('Range 越界 416', fetch(`${base}/${ns}/${hash}`, { headers: { Range: `bytes=${size + 10}-${size + 20}` } }));
  await step('HEAD', fetch(`${base}/${ns}/${hash}`, { method: 'HEAD' }));
  await step('HEAD 带 Range', fetch(`${base}/${ns}/${hash}`, { method: 'HEAD', headers: { Range: 'bytes=0-9' } }));
  await step('GET 带令牌也照常', fetch(`${base}/${ns}/${hash}`, { headers: AUTH }));

  // 409：全件哈希不符
  const small = bytesOf(300, 12);
  const claimed = sha256(Buffer.from('not the same bytes'));
  await step('PUT（哈希不符的内容）', put(base, ns, claimed, 0, small, { 'X-Media-Size': '300', ...AUTH }));
  await step('收尾：hash-mismatch', complete(base, ns, claimed, AUTH));
  await step('对账：丢弃后', fetch(`${base}/${ns}/${claimed}/chunks`));
  await step('收尾：丢弃后是没见过的', complete(base, ns, claimed, AUTH));
  await step('GET 没入库', fetch(`${base}/${ns}/${claimed}`));

  // 分片校验
  const s2 = CHUNK + 10;
  const b2 = bytesOf(s2, 13);
  const h2 = sha256(b2);
  const hh = { 'X-Media-Size': String(s2), ...AUTH };
  await step('越界 416', put(base, ns, h2, 2, Buffer.alloc(10), hh));
  await step('长度不对 400', put(base, ns, h2, 1, Buffer.alloc(11), hh));
  await step('缺 size 400', put(base, ns, h2, 1, Buffer.alloc(10), AUTH));
  await step('分片号前导零 400', put(base, ns, h2, '01', Buffer.alloc(10), hh));
  await step('PUT 第 1 片', put(base, ns, h2, 1, sliceOf(b2, 1), hh));
  await step('size 不一致 409', put(base, ns, h2, 0, sliceOf(b2, 0), { 'X-Media-Size': String(s2 + 1), ...AUTH }));
  await step('对账：校验之后', fetch(`${base}/${ns}/${h2}/chunks`));
  await step('坏哈希 400', fetch(`${base}/${ns}/xyz/chunks`));
  await step('方法不对 405（chunks）', fetch(`${base}/${ns}/${h2}/chunks`, { method: 'POST' }));
  await step('方法不对 405（complete）', fetch(`${base}/${ns}/${h2}/complete`));
  await step('方法不对 405（全件）', fetch(`${base}/${ns}/${h2}`, { method: 'DELETE' }));
  return { out, hash, size };
}

/* ------------------------------------------------------------------ S1 */

test('S1 同一份字节分别传进 media、snap、px：三个命名空间互不可见，一个里有、另一个里 404', async () => {
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const { base, stores } = srv;
  const buf = bytesOf(CHUNK + 77, 1);
  const hash = sha256(buf);
  const upload = async (ns) => {
    for (let n = 0; n < 2; n++) {
      const r = await put(base, ns, hash, n, sliceOf(buf, n), { 'X-Media-Size': String(buf.length) });
      assert.equal(r.status, 200, `${ns} 第 ${n} 片`);
      await r.arrayBuffer();
    }
    const c = await complete(base, ns, hash);
    assert.equal(c.status, 200, `${ns} 收尾`);
    await c.arrayBuffer();
  };
  const visible = async (ns) => {
    const r = await fetch(`${base}/${ns}/${hash}`);
    const body = Buffer.from(await r.arrayBuffer());
    const st = await chunks(base, ns, hash);
    const head = await fetch(`${base}/${ns}/${hash}`, { method: 'HEAD' });
    return { status: r.status, same: r.status === 200 && body.equals(buf), complete: st.complete, received: st.received, head: head.status };
  };
  const expectState = async (have) => {
    for (const ns of NS) {
      const v = await visible(ns);
      if (have.includes(ns)) {
        assert.deepEqual(v, { status: 200, same: true, complete: true, received: [0, 1], head: 200 }, `${ns} 里应当有`);
        assert.notEqual(await stores[ns].stat(hash), null, `${ns} 的数据层里应当有`);
      } else {
        assert.deepEqual(v, { status: 404, same: false, complete: false, received: [], head: 404 }, `${ns} 里应当没有`);
        assert.equal(await stores[ns].stat(hash), null, `${ns} 的数据层里应当没有`);
      }
    }
  };

  await expectState([]);
  await upload('media');
  await expectState(['media']);
  await upload('snap');
  await expectState(['media', 'snap']);
  await upload('px');
  await expectState(['media', 'snap', 'px']);

  // 分片状态同样互不可见：只在 px 收了一片的另一份字节，media、snap 的对账是「没见过」
  const other = bytesOf(CHUNK + 5, 2);
  const oh = sha256(other);
  assert.equal((await put(base, 'px', oh, 0, sliceOf(other, 0), { 'X-Media-Size': String(other.length) })).status, 200);
  assert.deepEqual(await chunks(base, 'px', oh), { size: other.length, chunkSize: CHUNK, received: [0], complete: false });
  for (const ns of ['media', 'snap']) assert.deepEqual(await chunks(base, ns, oh), { size: null, chunkSize: CHUNK, received: [], complete: false }, ns);
  // 另一个命名空间登记了别的 size 也不冲突（各自一份登记）
  const r = await put(base, 'snap', oh, 0, Buffer.alloc(10), { 'X-Media-Size': '10' });
  assert.equal(r.status, 200, 'snap 里同一个哈希按自己的 size 登记，不和 px 冲突');
  await r.arrayBuffer();
});

/* ------------------------------------------------------------------ S2 */

test('S2 snap、px 的分片、对账、收尾、Range、HEAD、CORS、401 规则与 media 相同，字段逐个比较', async () => {
  const runs = {};
  for (const ns of NS) {
    // 每个命名空间一台新服务，剧本从同一个空状态起跑
    const srv = await harness.serve({ chunkSize: CHUNK, token: TOKEN, isTrusted: () => false });
    runs[ns] = await script(srv.base, ns);
    await srv.close();
  }
  const ref = runs.media.out;
  // media 自己先按 C5 契约核几处，免得三家一起错
  const get = (name) => ref.find(([n]) => n === name)[1];
  assert.deepEqual(get('对账：没见过').body, { size: null, chunkSize: CHUNK, received: [], complete: false });
  assert.deepEqual([get('PUT 不带令牌 401').status, get('PUT 不带令牌 401').body], [401, { ok: false, error: 'unauthorized' }]);
  assert.deepEqual(get('对账：收了 0、2').body.received, [0, 2]);
  assert.deepEqual([get('收尾：缺片').status, get('收尾：缺片').body.missing], [400, [1]]);
  assert.equal(get('收尾：到齐').status, 200);
  assert.equal(get('GET 全件').status, 200);
  assert.equal(get('GET 全件').headers['access-control-allow-origin'], '*');
  assert.equal(get('Range 100-199').status, 206);
  assert.equal(get('Range 越界 416').status, 416);
  assert.equal(get('预检（局域网来源）').status, 204);
  assert.equal(get('预检（局域网来源）').headers['access-control-allow-private-network'], 'true');
  assert.equal(get('预检（公网来源）').headers['access-control-allow-private-network'], null);
  assert.deepEqual([get('收尾：hash-mismatch').status, get('收尾：hash-mismatch').body.error], [409, 'hash-mismatch']);

  for (const ns of ['snap', 'px']) {
    const got = runs[ns].out;
    assert.equal(got.length, ref.length);
    for (let i = 0; i < ref.length; i++) {
      const [name, a] = ref[i];
      const [name2, b] = got[i];
      assert.equal(name2, name);
      assert.equal(b.status, a.status, `${ns}「${name}」状态码`);
      for (const k of Object.keys(a.headers)) assert.equal(b.headers[k], a.headers[k], `${ns}「${name}」响应头 ${k}`);
      // 收尾回包里的 `url` 是取回地址，按命名空间不同，单独核（见下）；其余字段逐个比较
      const strip = (body) => (body && typeof body === 'object' && 'url' in body ? { ...body, url: typeof body.url } : body);
      assert.deepEqual(strip(b.body), strip(a.body), `${ns}「${name}」回包`);
    }
    const fin = got.find(([n]) => n === '收尾：到齐')[1].body;
    assert.equal(typeof fin.url, 'string', `${ns} 收尾回包带 url`);
    assert.ok(!fin.url.startsWith('/@media/'), `${ns} 的取回地址不该指向老路由 /@media/（它只对应 media）：${fin.url}`);
  }
});

test('S2b MIME 表补了 text/html → html、video/iso.segment → m4s；X-Media-Ext 优先；三个命名空间一样', async () => {
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const { base, stores } = srv;
  let seed = 100;
  const one = async (ns, headers) => {
    const buf = bytesOf(200, ++seed);
    const hash = sha256(buf);
    assert.equal((await put(base, ns, hash, 0, buf, { 'X-Media-Size': '200', ...headers })).status, 200);
    assert.equal((await complete(base, ns, hash)).status, 200);
    return (await stores[ns].stat(hash))?.ext;
  };
  for (const ns of NS) {
    assert.equal(await one(ns, { 'X-Media-Type': 'text/html' }), 'html', `${ns} text/html`);
    assert.equal(await one(ns, { 'X-Media-Type': 'text/html; charset=utf-8' }), 'html', `${ns} text/html; charset`);
    assert.equal(await one(ns, { 'X-Media-Type': 'video/iso.segment' }), 'm4s', `${ns} video/iso.segment`);
    assert.equal(await one(ns, { 'X-Media-Ext': 'mp4', 'X-Media-Type': 'video/iso.segment' }), 'mp4', `${ns} 扩展名优先`);
    assert.equal(await one(ns, { 'X-Media-Ext': 'm4s' }), 'm4s', `${ns} 直接给扩展名`);
    assert.equal(await one(ns, {}), '', `${ns} 都没给`);
  }
});

/* ------------------------------------------------------------------ S3 */

test('S3 旧写法 opts.store 仍然认、当作 stores.media；只给 stores.media 时 media 的行为与 C5 相同', async () => {
  // 旧写法：只传 opts.store
  const legacy = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null, legacyStore: true });
  const buf = bytesOf(CHUNK + 3, 21);
  const hash = sha256(buf);
  for (let n = 0; n < 2; n++) assert.equal((await put(legacy.base, 'media', hash, n, sliceOf(buf, n), { 'X-Media-Size': String(buf.length), 'X-Media-Ext': 'png' })).status, 200);
  const fin = await complete(legacy.base, 'media', hash);
  assert.equal(fin.status, 200);
  assert.deepEqual(await fin.json(), { ok: true, hash, size: buf.length, complete: true, url: `/@media/${hash}` });
  assert.notEqual(await legacy.stores.media.stat(hash), null, 'opts.store 就是 media 的数据层');
  const got = await fetch(`${legacy.base}/media/${hash}`);
  assert.equal(got.status, 200);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(buf));
  assert.equal(got.headers.get('content-type'), 'image/png');

  // 新写法：media 的回包与旧写法逐字段相同
  const a =await script((await harness.serve({ chunkSize: CHUNK, token: TOKEN, isTrusted: () => false, legacyStore: true })).base, 'media');
  const b = await script((await harness.serve({ chunkSize: CHUNK, token: TOKEN, isTrusted: () => false })).base, 'media');
  assert.deepEqual(b.out, a.out, 'stores.media 与 opts.store 的 media 行为相同');
});

/* ------------------------------------------------------------------ S4 */

test('S4 不认识的命名空间回 400 或 404、不落任何状态；isAssetServicePath 只认三个命名空间', async () => {
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const { base, stores } = srv;
  const buf = bytesOf(100, 31);
  const hash = sha256(buf);
  for (const ns of ['foo', 'snaps', 'pix', 'mediax', 'asset', 'png', 'x']) {
    const p = await put(base, ns, hash, 0, buf, { 'X-Media-Size': '100' });
    assert.ok([400, 404].includes(p.status), `${ns} PUT 回 ${p.status}`);
    await p.arrayBuffer();
    const c = await complete(base, ns, hash);
    assert.ok([400, 404].includes(c.status), `${ns} complete 回 ${c.status}`);
    await c.arrayBuffer();
    for (const tail of ['/chunks', '']) {
      const g = await fetch(`${base}/${ns}/${hash}${tail}`);
      assert.ok([400, 404].includes(g.status), `${ns} GET${tail} 回 ${g.status}`);
      await g.arrayBuffer();
    }
  }
  for (const ns of NS) {
    assert.deepEqual(await stores[ns].chunks(hash), { size: null, chunkSize: CHUNK, received: [], complete: false }, `${ns} 没落任何状态`);
    assert.equal(await stores[ns].stat(hash), null);
    assert.deepEqual((await stores[ns].usage()).blobs, 0, `${ns} 一件都没入库`);
  }

  const h = 'ab'.repeat(32);
  for (const ns of NS) {
    for (const tail of ['', '/chunks', '/complete', '/0', '/12']) {
      assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}${tail}`), true, `${ns}${tail}`);
    }
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}?x=1`), true, `${ns} 带查询串`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}/bogus`), false, `${ns}/bogus`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}`), false, `${ns} 没有哈希`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}/xyz`), false, `${ns} 坏哈希`);
  }
  for (const ns of ['foo', 'snaps', 'pix', 'mediax', 'asset', 'png', 'x', '']) {
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}`), false, `不认 ${JSON.stringify(ns)}`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}/0`), false, `不认 ${JSON.stringify(ns)}/0`);
  }
  assert.equal(isAssetServicePath(`/api/asset/snap/px/${h}`), false);
  assert.equal(isAssetServicePath(`/api/ai/snap/${h}`), false);
  assert.equal(isAssetServicePath(`/@media/${h}`), false);
});
