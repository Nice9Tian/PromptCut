// C1 页面一侧(`src/ai/cloud/collectBridge.ts`)的单测:不经服务端,只看这张页面自己守的规矩。
// 跑:npm test -- server/test/cloud-tools-c1-page.test.mjs
//
//   C1-PAGE-01  只认发给这张页面的采集请求:版本号 2、带一次性随机数、页面号对得上;别的工具(seek 等)不归它;
//   C1-PAGE-02  同一个请求号重复到达只执行一次并回第一次的答案;同号不同随机数的不答;
//   C1-PAGE-03  网页版(没有本机采集):开始、登录、查登录都回 unsupported,什么都没执行;
//   C1-PAGE-04  开始之前的几道闸:别的项目、正忙、本机没就绪、本机没登录;接下来的下载带的是本机查到的登录态;
//   C1-PAGE-05  回执逐字段拼:只有 { requestId, jobId, assetRef, result },文件名只取最后一段;本机的路径、cookie、用户标识带不出去;
//               没做成只回代号;项目中途换了不往别的项目传;
//   C1-PAGE-06  守门:本文件不挂全局、不听 postMessage 与自定义事件;`src/` 里还没有别处引用它(接线归最后的接线包)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectBridgePage, COLLECT_PAGE_REQUEST_TOOLS, COLLECT_PAGE_REQUEST_VERSION } from '../../src/ai/cloud/collectBridge.ts';
import { collectPageTools } from '../agent/service/collect-bridge.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const PAGE = 'page-initiator';
const NONCE = 'nonce-0123456789abcdef';
const DID = 'cd-0123456789abcdef01234567';
const HASH = 'a'.repeat(64);
const SECRET = { path: 'C:\\Users\\tester\\cookies\\bilibili.txt', file: 'D:\\tmp\\pc-collect-1\\片子 [1080].mp4', user: 'FAKE-USER-1', cookie: 'SESSDATA=FAKE-1' };
let seq = 0;
const req = (tool, args = {}, over = {}) => ({ type: 'page.request', v: 2, id: `request-${String(++seq).padStart(4, '0')}`, nonce: NONCE, runId: 'run1', pageId: PAGE, tool, args, timeoutMs: 1000, ...over });
const startArgs = (over = {}) => ({ delegationId: DID, jobId: 'collect-0123456789ab', projectId: 'P1', url: 'https://www.bilibili.com/video/BV1xx411c7mD', site: 'bilibili', quality: 1080, ...over });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function desk({ project = 'P1' } = {}) {
  const d = { calls: [], ready: true, loggedIn: true, project, storedAfter: 0, pushOk: true, jobStatus: 'done', polls: 0 };
  d.local = {
    status: async () => { d.calls.push('status'); return { ready: d.ready }; },
    cookies: async () => { d.calls.push('cookies'); return { bilibili: { loggedIn: d.loggedIn, userId: SECRET.user, path: SECRET.path } }; },
    download: async (url, opts) => { d.calls.push(['download', url, opts]); return { jobId: 'local-1' }; },
    job: async () => (++d.polls < 2 ? { status: 'running', stage: 'video', percent: 50 } : d.jobStatus === 'done'
      ? { status: 'done', cookiesUsed: true, stderrTail: [SECRET.cookie], items: [{ filename: SECRET.file, path: SECRET.file, hash: HASH, bytes: 1234, title: '标题', duration: 3, width: 1920, height: 1080, vcodec: 'h264', uploader: SECRET.user }] }
      : { status: 'error', message: `失败 ${SECRET.file}` }),
    cancel: async (id) => { d.calls.push(['cancel', id]); },
    login: async (args) => { d.calls.push(['login', args]); return d.loggedIn ? { ok: true, alreadyLoggedIn: true, userId: SECRET.user } : { ok: true, visible: true, windowHandle: 42 }; },
    loginCheck: async (args) => { d.calls.push(['loginCheck', args]); return { ok: true, loggedIn: d.loggedIn, userId: SECRET.user, path: SECRET.path }; },
  };
  d.upload = { projectId: () => d.project, push: async (items) => { d.calls.push(['push', items]); return d.pushOk; }, stored: async () => { d.calls.push('stored'); return d.storedAfter-- <= 0; } };
  d.page = createCollectBridgePage({ pageId: () => PAGE, local: d.local, upload: d.upload, pollMs: 5 });
  return d;
}
const pollUntil = async (page, state) => {
  for (let i = 0; i < 200; i++) { const a = await page.run(req('collect_delegate_poll', { delegationId: DID })); if (a.result.state === state) return a; await sleep(5); }
  throw new Error(`never reached ${state}`);
};

test('C1-PAGE-01 only collect requests addressed to this page are run', async () => {
  const d = desk();
  assert.equal(COLLECT_PAGE_REQUEST_VERSION, 2);
  assert.equal(d.page.handles(req('seek', { t: 1 })), false);
  assert.equal(await d.page.run(req('seek', { t: 1 })), null);
  for (const over of [{ v: 1 }, { nonce: undefined }, { nonce: 'short' }, { pageId: 'page-other' }, { id: 'x' }, { type: 'message' }]) assert.equal(await d.page.run(req('collect_login', { site: 'bilibili' }, over)), null);
  const none = createCollectBridgePage({ pageId: () => null, local: d.local, upload: d.upload });
  assert.equal(await none.run(req('collect_login', { site: 'bilibili' })), null, '这张页面还没有在场页面号');
  assert.deepEqual(d.calls, []);
  const ok = await d.page.run(req('collect_login', { site: 'bilibili' }));
  assert.deepEqual([ok.v, ok.nonce, ok.pageId, ok.runId, ok.ok], [2, NONCE, PAGE, 'run1', true]);
});

test('C1-PAGE-02 a repeated request id runs once; same id with another nonce is not answered', async () => {
  const d = desk();
  const ev = req('collect_login', { site: 'bilibili', method: 'browser' });
  const [a, b] = [await d.page.run(ev), await d.page.run(ev)];
  assert.equal(a, b);
  assert.equal(d.calls.filter((c) => c[0] === 'login').length, 1);
  assert.equal(await d.page.run({ ...ev, nonce: 'nonce-fedcba9876543210' }), null);
});

test('C1-PAGE-03 a browser page without local collect answers unsupported and does nothing', async () => {
  const web = createCollectBridgePage({ pageId: () => PAGE });
  for (const [tool, args] of [['collect_delegate_start', startArgs()], ['collect_login', { site: 'bilibili' }], ['collect_login_check', { site: 'bilibili' }]]) {
    const a = await web.run(req(tool, args));
    assert.deepEqual([a.ok, a.code, a.result], [false, 'unsupported', undefined]);
  }
  assert.deepEqual((await web.run(req('collect_delegate_poll', { delegationId: DID }))).result, { state: 'unknown' });
  assert.deepEqual(web.describe(), { delegations: 0, running: 0 });
});

test('C1-PAGE-04 gates before a local download starts; the download uses the login state found on this computer', async () => {
  const refuse = async (arrange, args, code) => { const d = desk(); arrange(d); const a = await d.page.run(req('collect_delegate_start', args)); assert.deepEqual([a.ok, a.result], [true, { accepted: false, code }], code); assert.equal(d.calls.some((c) => c[0] === 'download'), false); };
  await refuse(() => {}, startArgs({ projectId: 'P2' }), 'wrong-project');
  await refuse((d) => { d.ready = false; }, startArgs(), 'local-not-ready');
  await refuse((d) => { d.loggedIn = false; }, startArgs(), 'not-logged-in');
  await refuse(() => {}, startArgs({ site: 'elsewhere' }), 'not-logged-in');
  const bad = await desk().page.run(req('collect_delegate_start', startArgs({ quality: 999 })));
  assert.deepEqual([bad.ok, bad.code], [false, 'bad-args']);

  const d = desk();
  d.storedAfter = 1e9;                                               // 上传一直没好:这一次一直在办
  assert.deepEqual((await d.page.run(req('collect_delegate_start', startArgs({ preset: 'bilibili', allParts: true })))).result, { accepted: true });
  assert.deepEqual(d.calls.find((c) => c[0] === 'download'), ['download', startArgs().url, { quality: 1080, site: 'bilibili', allParts: true, cookies: SECRET.path }]);
  assert.deepEqual((await d.page.run(req('collect_delegate_start', startArgs()))).result, { accepted: true }, '同一次委托再来一遍:不重新下载');
  assert.equal(d.calls.filter((c) => c[0] === 'download').length, 1);
  const busy = await d.page.run(req('collect_delegate_start', startArgs({ delegationId: 'cd-ffffffffffffffffffffffff' })));
  assert.deepEqual(busy.result, { accepted: false, code: 'local-busy' });
  await pollUntil(d.page, 'running');
  await d.page.run(req('collect_delegate_cancel', { delegationId: DID }));
  assert.deepEqual(d.calls.find((c) => c[0] === 'cancel'), ['cancel', 'local-1']);
  assert.deepEqual((await d.page.run(req('collect_delegate_poll', { delegationId: DID }))).result, { state: 'error', code: 'cancelled' });
});

test('C1-PAGE-05 the receipt is built field by field: nothing local leaves; failures are codes only', async () => {
  const d = desk();
  d.storedAfter = 2;
  await d.page.run(req('collect_delegate_start', startArgs()));
  const done = await pollUntil(d.page, 'done');
  assert.deepEqual(done.result.receipt, { requestId: DID, jobId: 'collect-0123456789ab', assetRef: { projectId: 'P1', hash: HASH, size: 1234 },
    result: { items: [{ assetRef: { projectId: 'P1', hash: HASH, size: 1234 }, name: '片子 [1080].mp4', kind: 'video', title: '标题', duration: 3, width: 1920, height: 1080, vcodec: 'h264' }], cookiesUsed: true } });
  assert.deepEqual(d.calls.find((c) => c[0] === 'push'), ['push', [{ hash: HASH, name: '片子 [1080].mp4' }]]);
  // 服务端那一侧的白名单原样收得下这份回执
  assert.deepEqual(collectPageTools().collect_delegate_poll.answer({ ok: true, result: done.result }).result.receipt, done.result.receipt);
  const check = await d.page.run(req('collect_login_check', { site: 'bilibili' }));
  const login = await d.page.run(req('collect_login', { site: 'bilibili' }));
  assert.deepEqual([check.result, login.result], [{ loggedIn: true }, { opened: false, alreadyLoggedIn: true }]);
  const sent = JSON.stringify([done, check, login]);
  for (const value of Object.values(SECRET)) assert.equal(sent.includes(value) || sent.includes(JSON.stringify(value).slice(1, -1)), false);

  for (const [arrange, code] of [[(x) => { x.jobStatus = 'error'; }, 'local-download-failed'], [(x) => { x.pushOk = false; }, 'upload-failed'], [(x) => { x.local.job = async () => null; }, 'local-download-failed']]) {
    const e = desk(); arrange(e);
    await e.page.run(req('collect_delegate_start', startArgs()));
    const out = await pollUntil(e.page, 'error');
    assert.deepEqual(out.result, { state: 'error', code });
    assert.equal(JSON.stringify(out).includes('pc-collect'), false);
  }
  // 下载期间用户切到了别的项目:不往别的项目里传
  const moved = desk();
  moved.local.job = async () => { moved.project = 'P9'; return { status: 'done', items: [{ filename: 'a.mp4', hash: HASH, bytes: 10 }] }; };
  await moved.page.run(req('collect_delegate_start', startArgs()));
  assert.deepEqual((await pollUntil(moved.page, 'error')).result, { state: 'error', code: 'upload-failed' });
  assert.equal(moved.calls.some((c) => c[0] === 'push'), false);
});

test('C1-PAGE-06 guard: no global hooks in the page module; nothing in src/ wires it yet', () => {
  const text = fs.readFileSync(path.join(SRC, 'ai', 'cloud', 'collectBridge.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const word of ['window.', 'globalThis.', 'postMessage', 'addEventListener', 'localStorage', 'document.', 'fetch(']) assert.equal(text.includes(word), false, word);
  assert.deepEqual([...COLLECT_PAGE_REQUEST_TOOLS], ['collect_delegate_start', 'collect_delegate_poll', 'collect_delegate_cancel', 'collect_login', 'collect_login_check']);
  const users = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.mjs$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('createCollectBridgePage')) users.push(path.relative(SRC, p).replaceAll('\\', '/')); } };
  walk(SRC);
  // 最后的接线包把它接到 useCloud.ts / session.ts 时,这里加上那一个文件
  // 接线在 accountPage.ts 一处(它把采集的页面执行器与播放头、网页接管的执行器合成一个入口)
  assert.deepEqual(users.sort(), ['ai/cloud/accountPage.ts', 'ai/cloud/collectBridge.ts']);
});
