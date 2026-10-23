// 第三方存储连接器(任务书 `docs/plan/drive-connector-task.md` 第 4 节,D2)。
// 跑:node --test server/test/storage-connectors.test.mjs
//
// 不碰网络:Google Drive 那一层用假的 fetch,拉取那一层用假的 provider(背后是一个 Buffer),
// 入库那一层架一个裸 http server 冒充素材服务。
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test, after } from 'node:test';

import { createGoogleDriveProvider } from '../storage-connectors/google-drive.mjs';
import { pullToFile, partPath, PULL_CHUNK_SIZE } from '../storage-connectors/pull.mjs';
import { importFromStorage, safeName, discardPartial } from '../storage-connectors/import.mjs';
import { createStorageProvider, StorageConnectorError, TRANSIENT_CODES } from '../storage-connectors/index.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-storage-conn-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FILE_ID = '1yTCFUd7FaqZZv-p4D_Q095PKVZ2rveyv';

/** 造一个假 fetch:按 url 决定回什么 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    return handler(String(url), init, calls.length - 1);
  };
  impl.calls = calls;
  return impl;
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ───────────────────────── Google Drive provider ─────────────────────────

test('stat:把 Drive 的字符串 size 转成数字,带上名字和类型', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({ id: FILE_ID, name: 'a.mp4', size: '19603456', mimeType: 'video/mp4' }));
  const p = createGoogleDriveProvider({ token: 'tok', fetchImpl });
  const info = await p.stat(FILE_ID);
  assert.deepEqual(info, { id: FILE_ID, name: 'a.mp4', size: 19603456, mimeType: 'video/mp4' });
  // 只要那几个字段,而且带 supportsAllDrives
  assert.match(fetchImpl.calls[0].url, /fields=id%2Cname%2Csize%2CmimeType/);
  assert.match(fetchImpl.calls[0].url, /supportsAllDrives=true/);
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer tok');
});

test('stat:Google 自家格式没有原始字节,报 not-downloadable', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({ id: FILE_ID, name: '表', mimeType: 'application/vnd.google-apps.spreadsheet' }));
  const p = createGoogleDriveProvider({ token: 'tok', fetchImpl });
  await assert.rejects(() => p.stat(FILE_ID), (e) => e.code === 'not-downloadable');
});

test('stat:没有 size 的回包不蒙混过关', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({ id: FILE_ID, name: 'a.mp4', mimeType: 'video/mp4' }));
  const p = createGoogleDriveProvider({ token: 'tok', fetchImpl });
  await assert.rejects(() => p.stat(FILE_ID), (e) => e.code === 'bad-response');
});

test('HTTP 状态码各归各的 code', async () => {
  const cases = [
    [401, '', 'token-expired'],
    [403, '{"error":{"errors":[{"reason":"downloadQuotaExceeded"}]}}', 'quota'],
    [403, '{"error":{"message":"insufficient permission"}}', 'forbidden'],
    [404, '', 'not-found'],
    [429, '', 'quota'],
    [503, '', 'network'],
  ];
  for (const [status, body, code] of cases) {
    const fetchImpl = fakeFetch(() => new Response(body, { status }));
    const p = createGoogleDriveProvider({ token: 'tok', fetchImpl });
    await assert.rejects(
      () => p.stat(FILE_ID),
      (e) => e instanceof StorageConnectorError && e.code === code && e.status === status,
      `HTTP ${status} 应归成 ${code}`,
    );
  }
});

test('配额与网络算暂时性故障,没权限不算', () => {
  assert.ok(TRANSIENT_CODES.has('quota'));
  assert.ok(TRANSIENT_CODES.has('network'));
  assert.ok(!TRANSIENT_CODES.has('forbidden'));
  assert.ok(!TRANSIENT_CODES.has('token-expired'));
});

test('openRange:发出闭区间的 Range 头,回 206 和流', async () => {
  const body = Buffer.from('0123456789');
  const fetchImpl = fakeFetch(() => new Response(body.subarray(2, 6), {
    status: 206,
    headers: { 'content-range': 'bytes 2-5/10' },
  }));
  const p = createGoogleDriveProvider({ token: 'tok', fetchImpl });
  const res = await p.openRange(FILE_ID, { start: 2, end: 5 });
  assert.equal(res.status, 206);
  assert.equal(fetchImpl.calls[0].headers.Range, 'bytes=2-5');
  assert.match(fetchImpl.calls[0].url, /alt=media/);
  const chunks = [];
  for await (const c of res.stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), '2345');
});

test('令牌传函数时每次请求重取一次(A3 递新票、A2 自己换票都靠这个)', async () => {
  let n = 0;
  const fetchImpl = fakeFetch(() => jsonRes({ id: FILE_ID, name: 'a.mp4', size: '1', mimeType: 'video/mp4' }));
  const p = createGoogleDriveProvider({ token: () => `tok-${++n}`, fetchImpl });
  await p.stat(FILE_ID);
  await p.stat(FILE_ID);
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer tok-1');
  assert.equal(fetchImpl.calls[1].headers.Authorization, 'Bearer tok-2');
});

test('取不到令牌就报 token-expired,不发请求', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({}));
  const p = createGoogleDriveProvider({ token: () => null, fetchImpl });
  await assert.rejects(() => p.stat(FILE_ID), (e) => e.code === 'token-expired');
  assert.equal(fetchImpl.calls.length, 0);
});

test('文件 id 形状不对直接拒,不发请求', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({}));
  const p = createGoogleDriveProvider({ token: 'tok', fetchImpl });
  await assert.rejects(() => p.stat('../../etc/passwd'), TypeError);
  assert.equal(fetchImpl.calls.length, 0);
});

test('工厂:Dropbox 回 not-implemented,未知的 kind 回 TypeError', () => {
  assert.throws(() => createStorageProvider({ kind: 'dropbox', token: 't' }), (e) => e.code === 'not-implemented');
  assert.throws(() => createStorageProvider({ kind: 'onedrive', token: 't' }), TypeError);
});

// ───────────────────────── 分段拉取与断点续传 ─────────────────────────

/** 背后是一个 Buffer 的假 provider;记下每次要的区间 */
function bufferProvider(buf, { kind = 'fake', ignoreRange = false } = {}) {
  const asked = [];
  return {
    kind,
    asked,
    async stat() { return { id: 'x', name: 'x.bin', size: buf.length, mimeType: 'application/octet-stream' }; },
    async openRange(_id, { start = 0, end = null } = {}) {
      asked.push([start, end]);
      if (ignoreRange) return { status: 200, stream: Readable.from([buf]) };
      const slice = buf.subarray(start, end === null ? undefined : end + 1);
      return { status: 206, stream: Readable.from([slice]) };
    },
  };
}

test('分段拉完整份,段数对得上', async () => {
  const buf = crypto.randomBytes(1000);
  const provider = bufferProvider(buf);
  const dest = path.join(TMP, 'whole.bin');
  const seen = [];
  const out = await pullToFile({ provider, fileId: 'x', dest, chunkSize: 300, onProgress: (p) => seen.push(p.bytes) });
  assert.equal(out.bytes, 1000);
  assert.equal(out.segments, 4);          // 300 + 300 + 300 + 100
  assert.equal(out.resumedFrom, 0);
  assert.deepEqual(seen, [300, 600, 900, 1000]);
  assert.deepEqual(provider.asked, [[0, 299], [300, 599], [600, 899], [900, 999]]);
  assert.ok(fs.readFileSync(dest).equals(buf));
});

test('断点续传:只补缺的那一段,内容仍然逐字节一致', async () => {
  const buf = crypto.randomBytes(1000);
  const dest = path.join(TMP, 'resume.bin');
  fs.writeFileSync(dest, buf.subarray(0, 700));   // 上次拉到 700

  const provider = bufferProvider(buf);
  const out = await pullToFile({ provider, fileId: 'x', dest, chunkSize: 300 });
  assert.equal(out.resumedFrom, 700);
  assert.equal(out.segments, 1);                   // 只要了 700..999
  assert.deepEqual(provider.asked, [[700, 999]]);
  assert.ok(fs.readFileSync(dest).equals(buf));
});

test('已经拉完的再调一次:一个请求都不发', async () => {
  const buf = crypto.randomBytes(100);
  const dest = path.join(TMP, 'done.bin');
  fs.writeFileSync(dest, buf);
  const provider = bufferProvider(buf);
  const out = await pullToFile({ provider, fileId: 'x', dest });
  assert.equal(out.segments, 0);
  assert.equal(provider.asked.length, 0);
});

test('临时文件比源文件还长:丢掉重来,不接到一起', async () => {
  const buf = crypto.randomBytes(100);
  const dest = path.join(TMP, 'toolong.bin');
  fs.writeFileSync(dest, crypto.randomBytes(500));
  const provider = bufferProvider(buf);
  const out = await pullToFile({ provider, fileId: 'x', dest });
  assert.equal(out.resumedFrom, 500);
  assert.deepEqual(provider.asked, [[0, 99]]);
  assert.ok(fs.readFileSync(dest).equals(buf));
});

test('对方忽略 Range、从头给整件:续传时报 range-unsupported', async () => {
  const buf = crypto.randomBytes(1000);
  const dest = path.join(TMP, 'norange.bin');
  fs.writeFileSync(dest, buf.subarray(0, 400));
  const provider = bufferProvider(buf, { ignoreRange: true });
  await assert.rejects(
    () => pullToFile({ provider, fileId: 'x', dest, chunkSize: 300 }),
    (e) => e.code === 'range-unsupported',
  );
});

test('第一段就从头给整件是允许的(start 为 0)', async () => {
  const buf = crypto.randomBytes(200);
  const dest = path.join(TMP, 'whole200.bin');
  const provider = bufferProvider(buf, { ignoreRange: true });
  const out = await pullToFile({ provider, fileId: 'x', dest, chunkSize: 1000 });
  assert.equal(out.bytes, 200);
  assert.ok(fs.readFileSync(dest).equals(buf));
});

test('给多了就截回去并报错,不让多余的字节留在文件里', async () => {
  const buf = crypto.randomBytes(1000);
  const dest = path.join(TMP, 'overrun.bin');
  const provider = {
    kind: 'fake',
    async stat() { return { id: 'x', name: 'x', size: 1000, mimeType: '' }; },
    async openRange() { return { status: 206, stream: Readable.from([buf]) }; },  // 要 300 给 1000
  };
  await assert.rejects(
    () => pullToFile({ provider, fileId: 'x', dest, chunkSize: 300 }),
    (e) => e.code === 'bad-response',
  );
  assert.equal(fs.statSync(dest).size, 0);
});

test('空文件:建出来就完事,不发请求', async () => {
  const provider = bufferProvider(Buffer.alloc(0));
  const dest = path.join(TMP, 'empty.bin');
  const out = await pullToFile({ provider, fileId: 'x', dest });
  assert.equal(out.bytes, 0);
  assert.equal(provider.asked.length, 0);
  assert.ok(fs.existsSync(dest));
});

test('默认分段是 8 MiB,和素材服务的分片对得上', () => {
  assert.equal(PULL_CHUNK_SIZE, 8 * 1024 * 1024);
});

test('临时文件名对同一份文件是稳定的,否则接不上', () => {
  const a = partPath(TMP, 'google-drive', FILE_ID);
  const b = partPath(TMP, 'google-drive', FILE_ID);
  assert.equal(a, b);
  // 路径分隔符不会被带进文件名
  const evil = partPath(TMP, 'google-drive', '../../x');
  assert.equal(path.dirname(evil), TMP);
});

// ───────────────────────── 入库 ─────────────────────────

test('safeName:去掉路径与控制字符,留住扩展名', () => {
  assert.equal(safeName('a/b/c.mp4'), 'c.mp4');
  assert.equal(safeName('..\\..\\x.mov'), 'x.mov');
  assert.equal(safeName(''), 'media');
  assert.equal(safeName('..'), 'media');
  assert.equal(safeName('a\u0000b.mp4'), 'ab.mp4');
  assert.equal(safeName(`${'n'.repeat(300)}.mp4`).length, 180);
});

test('importFromStorage:拉下来、入库、删临时文件', async () => {
  const buf = crypto.randomBytes(5000);
  const seen = [];
  const asset = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, bytes: Buffer.concat(chunks).length });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, hash: 'a'.repeat(64), ext: 'mp4', name: '片子.mp4', bytes: Buffer.concat(chunks).length }));
    });
  });
  await new Promise((r) => asset.listen(0, '127.0.0.1', r));
  after(() => asset.close());
  const base = `http://127.0.0.1:${asset.address().port}`;

  const provider = {
    kind: 'google-drive',
    async stat() { return { id: FILE_ID, name: '片子.mp4', size: buf.length, mimeType: 'video/mp4' }; },
    async openRange(_id, { start, end }) {
      return { status: 206, stream: Readable.from([buf.subarray(start, end + 1)]) };
    },
  };

  const out = await importFromStorage({ provider, fileId: FILE_ID, tmpDir: TMP, origin: () => base });

  assert.equal(out.hash, 'a'.repeat(64));
  assert.equal(out.source.kind, 'google-drive');
  assert.equal(out.source.fileId, FILE_ID);
  assert.equal(out.pulled.bytes, 5000);
  // 和用户自己导入走同一条路:带 tiers=1
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /^\/api\/media\/upload\/.*\?tiers=1$/);
  assert.equal(seen[0].bytes, 5000);
  // 入库成功就把临时文件删掉
  assert.ok(!fs.existsSync(partPath(TMP, 'google-drive', FILE_ID)));
});

test('入库失败时临时文件留着,下次接着拉', async () => {
  const buf = crypto.randomBytes(800);
  const asset = http.createServer((req, res) => { res.statusCode = 503; res.end('nope'); });
  await new Promise((r) => asset.listen(0, '127.0.0.1', r));
  after(() => asset.close());
  const base = `http://127.0.0.1:${asset.address().port}`;

  const id = 'keepPartial123';
  const provider = {
    kind: 'google-drive',
    async stat() { return { id, name: 'x.mp4', size: buf.length, mimeType: 'video/mp4' }; },
    async openRange(_i, { start, end }) { return { status: 206, stream: Readable.from([buf.subarray(start, end + 1)]) }; },
  };

  await assert.rejects(() => importFromStorage({ provider, fileId: id, tmpDir: TMP, origin: () => base }));
  const part = partPath(TMP, 'google-drive', id);
  assert.equal(fs.statSync(part).size, 800);

  await discardPartial({ kind: 'google-drive', fileId: id, tmpDir: TMP });
  assert.ok(!fs.existsSync(part));
});

// ───────────────────────── HTTP 层(route.mjs)─────────────────────────

import { storageConfig, parseImportBody, statusForCode, handleStorageImport, pullTmpDir } from '../storage-connectors/route.mjs';

test('storageConfig:没配环境变量就 configured:false 并说明原因', () => {
  const cfg = storageConfig({});
  const drive = cfg.providers.find((p) => p.kind === 'google-drive');
  assert.equal(drive.configured, false);
  assert.match(drive.reason, /PROMPTCUT_GOOGLE_CLIENT_ID/);
  // 没配好时连空的 clientId 都不下发,省得页面以为有
  assert.equal(drive.clientId, undefined);
});

test('storageConfig:配齐三样就能用一次性授权(A3)', () => {
  const cfg = storageConfig({
    PROMPTCUT_GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    PROMPTCUT_GOOGLE_API_KEY: 'AIzaKEY',
    PROMPTCUT_GOOGLE_PROJECT_NUMBER: '727415172612',
    PROMPTCUT_GOOGLE_CLIENT_SECRET: 'THE-REAL-SECRET',
    PROMPTCUT_GOOGLE_REDIRECT_URI: 'http://localhost:5321/oauth2callback',
  });
  const drive = cfg.providers.find((p) => p.kind === 'google-drive');
  assert.equal(drive.configured, true);
  assert.equal(drive.clientId, 'cid.apps.googleusercontent.com');
  assert.equal(drive.appId, '727415172612');
  assert.equal(drive.scope, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(drive.reason, undefined);
  // 客户端密钥的**值**永远不下发给页面。
  // （不能扫 /secret/i:没配密钥时 manageReason 里会正当地提到环境变量名 PROMPTCUT_GOOGLE_CLIENT_SECRET。）
  assert.ok(!JSON.stringify(cfg).includes('THE-REAL-SECRET'));
});

test('storageConfig:缺一样就不算配好', () => {
  for (const missing of ['PROMPTCUT_GOOGLE_CLIENT_ID', 'PROMPTCUT_GOOGLE_API_KEY', 'PROMPTCUT_GOOGLE_PROJECT_NUMBER']) {
    const env = {
      PROMPTCUT_GOOGLE_CLIENT_ID: 'a', PROMPTCUT_GOOGLE_API_KEY: 'b', PROMPTCUT_GOOGLE_PROJECT_NUMBER: 'c',
    };
    delete env[missing];
    const drive = storageConfig(env).providers.find((p) => p.kind === 'google-drive');
    assert.equal(drive.configured, false, `缺 ${missing} 时不该算配好`);
  }
});

test('storageConfig:Dropbox 只占位,标明还没做', () => {
  const box = storageConfig({}).providers.find((p) => p.kind === 'dropbox');
  assert.equal(box.configured, false);
  assert.match(box.reason, /还没做/);
});

test('parseImportBody:形状不对一律 bad-request', () => {
  // 注意:「不带 token」不在这张表里 —— A2 做出来之后那是合法的(让这一侧用托管凭据换票),
  // 对应的用例在 storage-credentials.test.mjs 里。
  const bad = [
    {},
    { kind: 'onedrive', token: 't', fileId: 'f' },
    { kind: 'google-drive', token: '', fileId: 'f' },
    { kind: 'google-drive', token: 'x'.repeat(5000), fileId: 'f' },
    { kind: 'google-drive', token: 't' },
  ];
  for (const body of bad) {
    assert.throws(() => parseImportBody(body), (e) => e.code === 'bad-request', JSON.stringify(body));
  }
  assert.deepEqual(
    parseImportBody({ kind: 'google-drive', token: 't', fileId: 'f', name: 'a.mp4' }),
    { kind: 'google-drive', token: 't', fileId: 'f', name: 'a.mp4' },
  );
});

test('statusForCode:页面据此分辨重试、重新授权还是认错', () => {
  assert.equal(statusForCode('bad-request'), 400);
  assert.equal(statusForCode('token-expired'), 401);
  assert.equal(statusForCode('forbidden'), 403);
  assert.equal(statusForCode('not-found'), 404);
  assert.equal(statusForCode('quota'), 429);
  assert.equal(statusForCode('network'), 502);
  assert.equal(statusForCode('whatever'), 500);
});

test('pullTmpDir:固定一个目录,断点续传才认得上', () => {
  assert.equal(pullTmpDir({}), pullTmpDir({}));
  assert.equal(pullTmpDir({ PROMPTCUT_STORAGE_PULL_DIR: '/x/y' }), '/x/y');
});

test('handleStorageImport:从假 Drive 一路拉到入库', async () => {
  const buf = crypto.randomBytes(3000);
  const posted = [];
  const asset = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      posted.push(Buffer.concat(chunks));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, hash: 'b'.repeat(64), ext: 'mp4', name: 'v.mp4', bytes: 3000 }));
    });
  });
  await new Promise((r) => asset.listen(0, '127.0.0.1', r));
  after(() => asset.close());

  // 假的 Google:元信息一条,字节按 Range 切
  const driveFetch = async (url, init = {}) => {
    if (!String(url).includes('alt=media')) {
      return new Response(JSON.stringify({ id: FILE_ID, name: 'v.mp4', size: String(buf.length), mimeType: 'video/mp4' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const m = /bytes=(\d+)-(\d*)/.exec(init.headers?.Range || '');
    const start = Number(m?.[1] ?? 0);
    const end = m?.[2] ? Number(m[2]) : buf.length - 1;
    return new Response(buf.subarray(start, end + 1), { status: 206 });
  };

  const tmpDir = path.join(TMP, 'route-pull');
  const out = await handleStorageImport(
    { kind: 'google-drive', token: 'tok', fileId: FILE_ID, name: 'v.mp4' },
    { origin: () => `http://127.0.0.1:${asset.address().port}`, tmpDir, fetchImpl: driveFetch },
  );

  assert.equal(out.hash, 'b'.repeat(64));
  assert.equal(out.source.kind, 'google-drive');
  assert.equal(out.pulled.total, 3000);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].equals(buf), '送进素材服务的字节要和网盘上的逐字节一致');
});

test('handleStorageImport:网盘回 401 时错误带得出 token-expired', async () => {
  const driveFetch = async () => new Response('', { status: 401 });
  await assert.rejects(
    () => handleStorageImport(
      { kind: 'google-drive', token: 'tok', fileId: FILE_ID },
      { origin: () => 'http://127.0.0.1:1', tmpDir: path.join(TMP, 'route-401'), fetchImpl: driveFetch },
    ),
    (e) => e.code === 'token-expired' && statusForCode(e.code) === 401,
  );
});
