/**
 * 舞台源跨文档通道守卫(`scopeGuard.ts`、`harden.ts` 的 6c/6d 步)在真实无头 Chrome 里的核对。不进 `npm test`(文件名不是 `*.test.mjs`)。
 *
 * 搭法:本机两个端口,`127.0.0.1:<port>` 当编辑页,`localhost:<port+1>` 当舞台源(带在线舞台同一份内容安全策略
 * `stageCspHeader` 与 `Origin-Agent-Cluster`),舞台 iframe 带 `sandbox="allow-scripts allow-same-origin"`,与在线页面相同。
 * `harden.ts` 用 rolldown 打成压缩过的 iife 送进舞台(核守卫源码经压缩后仍自足),由编辑页把一段段「卡片代码」送进舞台执行。
 *
 * 核:装上加固之后
 *   - 卡片起的经典线程、模块线程、线程里再起的线程:IndexedDB、Cache Storage、源私有文件系统都用不了,BroadcastChannel、SharedWorker 没有;
 *   - 模块线程里静态 import 的外链模块先于守卫拿到的 indexedDB / caches / navigator.storage / BroadcastChannel,守卫装上后也用不了;
 *   - 别处的地址(同源脚本、data:、撤销了的 blob)起不了线程;拿 `Worker.prototype.constructor`、子类、改数组迭代器都绕不过;
 *   - 运行时那种「blob 引导 + importScripts 同源脚本」的线程照常跑;线程里先有守卫、再调 `denyPersistentStorage` 不报错;
 *   - `window.name` 在 `frame.src = frame.src` 重载前写的,重载后是空的;没装加固时写进去的,装上加固时清掉;
 *   - `history.state`、`location.hash` 跨这种重载的情况(记结论);
 *   - BroadcastChannel、SharedWorker 在文档里没有;`cookieStore.set` 拒绝;
 *   - 锁名按文档隔开:别的文档看不见、占不住本文档的锁;本文档和它的线程照常协调;
 *   - 别的文档写真实 localStorage 的 storage 事件收不到;`navigator.storage.persist()` 回 false。
 * 另有对照:没装加固的舞台文档里同样的写法能存、能广播、锁名看得见(证明这些检查能测出泄漏)。
 *
 * 跑:node src/online/isolation/scopeGuard.browser-check.mjs [--port 6440] [--no-minify]
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { rolldown } from 'rolldown';
import { stageCspHeader } from '../stagePolicy.mjs';
import { PROBE_CHROME_ARGS } from '../../../scripts/probes/probe-chrome.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 6440));
const MINIFY = !argv.includes('--no-minify');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = `http://127.0.0.1:${PORT}`;
const STAGE = `http://localhost:${PORT + 1}`;

let pass = 0; const fails = [];
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  [${typeof detail === 'string' ? detail : JSON.stringify(detail)}]`}`); if (ok) pass++; else fails.push(label); };

/* ---------- 打包 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-scope-guard-'));
async function bundle(input, name) {
  const b = await rolldown({ input, platform: 'browser', logLevel: 'silent' });
  const { output } = await b.generate({ format: 'iife', name, minify: MINIFY });
  await b.close();
  return output[0].code;
}
const hardenEntry = path.join(tmp, 'harden-entry.ts');
fs.writeFileSync(hardenEntry, `export { installStageHardening, denyPersistentStorage } from ${JSON.stringify(path.join(HERE, 'harden.ts').replace(/\\/g, '/'))};\n`);
const dpsEntry = path.join(tmp, 'dps-entry.ts');
fs.writeFileSync(dpsEntry, `import { denyPersistentStorage } from ${JSON.stringify(path.join(HERE, 'harden.ts').replace(/\\/g, '/'))};\nconst r = denyPersistentStorage(self);\n(self as any).postMessage({ t: 'dps', denied: r.denied, errors: r.errors, idb: typeof (self as any).indexedDB });\n`);
const HARDEN_JS = await bundle(hardenEntry, 'PCH');
const DPS_JS = await bundle(dpsEntry, 'PCD');

/* ---------- 舞台页里的代理:记下载入时的原始状态,执行编辑页送来的代码 ---------- */
const AGENT_JS = `
(() => {
  const raw = { name: window.name, state: history.state, hash: location.hash, href: location.href, historyLength: history.length,
    from: (() => { try { const f = window.navigation && navigation.activation && navigation.activation.from; return f ? { url: f.url, state: f.getState() } : null; } catch (e) { return 'err:' + e.message; } })(),
    entries: (() => { try { return window.navigation ? navigation.entries().map((e) => e.url) : null; } catch (e) { return 'err'; } })() };
  window.addEventListener('message', async (e) => {
    const m = e.data || {};
    if (m.t !== 'eval') return;
    let value, error = null;
    try { value = await (new Function('return (async () => {' + m.code + '\\n})()'))(); } catch (err) { error = String(err && err.message || err); }
    parent.postMessage({ t: 'result', id: m.id, value, error }, '*');
  });
  parent.postMessage({ t: 'loaded', frame: new URLSearchParams(location.search).get('f'), raw }, '*');
})();`;
const STAGE_HTML = '<!doctype html><meta charset="utf-8"><title>stage</title><script src="/harden.js"></script><script src="/agent.js"></script>';
const CAPTURE_MJS = `
export const cap = { idb: self.indexedDB, caches: self.caches, storage: self.navigator.storage, BC: self.BroadcastChannel };
export const dbPromise = new Promise((res) => { try { const r = self.indexedDB.open('pc-pre-guard', 1); r.onupgradeneeded = () => { try { r.result.createObjectStore('s'); } catch {} }; r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); } });
await dbPromise; // 顶层 await:等库开好(要是守卫还没装,这里就能写完再让主模块跑)
`;
const RUNTIME_WORKER_JS = `postMessage({ t: 'runtime-ok', idb: typeof self.indexedDB, bc: typeof self.BroadcastChannel });`;

const TOP_HTML = `<!doctype html><meta charset="utf-8"><title>editor</title><body><script>
window.loads = {}; let seq = 0; const waiting = new Map();
window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.t === 'loaded') (window.loads[m.frame] ||= []).push(m.raw);
  if (m.t === 'result') { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
});
window.addFrame = (id, query = '') => { const f = document.createElement('iframe'); f.id = id; f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.src = '${STAGE}/stage.html?f=' + id + query; document.body.appendChild(f); };
window.reloadFrame = (id) => { const f = document.getElementById(id); f.src = f.src; };
window.callFrame = (id, code) => new Promise((res) => { const n = ++seq; waiting.set(n, res); document.getElementById(id).contentWindow.postMessage({ t: 'eval', id: n, code }, '${STAGE}'); });
</script></body>`;

const stageHeaders = { 'Content-Security-Policy': stageCspHeader(EDITOR), 'Origin-Agent-Cluster': '?1', 'Cache-Control': 'no-store' };
const servers = [];
const listen = (port, host, handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(port, host, () => res(s)); servers.push(s); });
await listen(PORT, '127.0.0.1', (req, res) => {
  if (req.url.startsWith('/top.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(TOP_HTML); return; }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.writeHead(404); res.end();
});
const stageFiles = {
  '/stage.html': ['text/html; charset=utf-8', STAGE_HTML], '/harden.js': ['text/javascript', HARDEN_JS], '/agent.js': ['text/javascript', AGENT_JS],
  '/capture.mjs': ['text/javascript', CAPTURE_MJS], '/runtime-worker.js': ['text/javascript', RUNTIME_WORKER_JS], '/dps-worker.js': ['text/javascript', DPS_JS],
  '/same-origin-worker.js': ['text/javascript', 'postMessage("same-origin")'],
};
await listen(PORT + 1, 'localhost', (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204, stageHeaders); res.end(); return; }
  const f = stageFiles[new URL(req.url, STAGE).pathname];
  if (!f) { res.writeHead(404, stageHeaders); res.end(); return; }
  res.writeHead(200, { ...stageHeaders, 'Content-Type': f[0] }); res.end(f[1]);
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-scope-guard-profile-'));
const browser = await puppeteer.launch({ pipe: true, headless: true, userDataDir: profile, args: [...PROBE_CHROME_ARGS] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(`${EDITOR}/top.html`);
  const loads = (id) => page.evaluate((i) => (window.loads[i] || []).length, id);
  const waitLoad = async (id, n) => { for (let k = 0; k < 100; k++) { if ((await loads(id)) >= n) return true; await sleep(100); } return false; };
  const call = async (id, code) => { const r = await page.evaluate((i, c) => window.callFrame(i, c), id, code); if (r.error) throw new Error(`${id}: ${r.error}`); return r.value; };
  const raw = (id, n) => page.evaluate((i, k) => window.loads[i][k], id, n);

  // A、C:装加固的舞台;D:没装加固的对照(同一个源)
  for (const id of ['A', 'C', 'D']) await page.evaluate((i) => window.addFrame(i), id);
  for (const id of ['A', 'C', 'D']) check(`舞台 ${id} 载入`, await waitLoad(id, 1));

  // A 先在没装加固时往 window.name 里写(模拟旧文档留下的东西),整页重载后再装
  await call('A', `window.name = 'pre-leak-sid'; return window.name;`);
  await page.evaluate(() => window.reloadFrame('A'));
  check('A 重载(加固前写过 window.name)', await waitLoad('A', 2));
  check('对照:没装加固时写的 window.name 跨 frame.src = frame.src 重载留下来了', (await raw('A', 1)).name === 'pre-leak-sid', (await raw('A', 1)).name);

  const install = `const r = PCH.installStageHardening({}); return { errors: r.errors, scopeGuarded: r.scopeGuarded, storageDenied: r.storageDenied };`;
  const repA = await call('A', install);
  const repC = await call('C', install);
  check('加固装上没有错误', repA.errors.length === 0 && repC.errors.length === 0, [...repA.errors, ...repC.errors].join('; ') || '');
  console.log(`      scopeGuarded: ${repA.scopeGuarded.join(', ')}`);
  check('装上加固时清掉了真实的 window.name', await call('A', `return window.name;`) === '');

  /* ---------- 文档里的通道 ---------- */
  const docChannels = `return { BC: typeof BroadcastChannel, SW: typeof SharedWorker, idb: typeof indexedDB, caches: typeof caches, sharedStorage: typeof window.sharedStorage,
    ctorOk: Worker.prototype.constructor === Worker };`;
  const dA = await call('A', docChannels);
  check('文档:BroadcastChannel、SharedWorker 没有', dA.BC === 'undefined' && dA.SW === 'undefined', dA);
  check('文档:Worker.prototype.constructor 指回包装过的 Worker', dA.ctorOk === true);
  const dD = await call('D', docChannels);
  check('对照(没装加固):BroadcastChannel、SharedWorker 都在', dD.BC === 'function' && dD.SW === 'function', dD);

  const cookie = await call('A', `let set; try { await cookieStore.set('pc-leak', 'x'); set = 'written'; } catch (e) { set = 'rejected:' + e.message; }
    let del; try { await cookieStore.delete('pc-leak'); del = 'deleted'; } catch (e) { del = 'rejected'; }
    document.cookie = 'pc-leak2=y'; return { set, del, cookie: document.cookie, typeofStore: typeof cookieStore };`);
  check('cookieStore.set、delete 拒绝;document.cookie 写不进', cookie.set.startsWith('rejected') && cookie.del === 'rejected' && !cookie.cookie.includes('pc-leak'), cookie);
  // 对照:没装加固时走到浏览器自己的 cookieStore(本搭法里舞台是第三方上下文,浏览器自己也可能拒,只核走到的不是守卫)
  const cookieD = await call('D', `try { await cookieStore.set('pc-ctl', 'x'); await cookieStore.delete('pc-ctl'); return 'written'; } catch (e) { return 'rejected:' + e.message; }`);
  check('对照(没装加固):cookieStore.set 走的是浏览器自己的实现', !cookieD.includes('PromptCut'), cookieD);

  const persist = await call('A', `return { persist: await navigator.storage.persist(), estimate: typeof (await navigator.storage.estimate()).quota };`);
  check('navigator.storage.persist() 回 false,estimate 照旧', persist.persist === false && persist.estimate === 'number', persist);

  /* ---------- 卡片起的线程 ---------- */
  const CHECKS = `async function checks() {
    const r = { idb: typeof self.indexedDB, caches: typeof self.caches, BC: typeof self.BroadcastChannel, SW: typeof self.SharedWorker };
    try { await navigator.storage.getDirectory(); r.opfs = 'open'; } catch (e) { r.opfs = 'denied'; }
    try { r.idbOpenNative = /native code/.test(Function.prototype.toString.call(IDBFactory.prototype.open)); } catch (e) { r.idbOpenNative = 'n/a'; }
    try { await navigator.locks.request('pc-probe', { ifAvailable: true }, () => {}); r.locks = 'ok'; } catch (e) { r.locks = 'err:' + e.message; }
    return r;
  }`;
  const nestedSrc = `${CHECKS}\nchecks().then((r) => postMessage(r));`;
  const classicSrc = `${CHECKS}
    (async () => {
      const r = await checks();
      const u = URL.createObjectURL(new Blob([${JSON.stringify(nestedSrc)}], { type: 'text/javascript' }));
      const nw = new Worker(u);
      r.nested = await new Promise((res) => { nw.onmessage = (e) => res(e.data); nw.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; });
      postMessage(r);
    })();`;
  const spawn = (src, opts = '{}') => `
    const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(src)}], { type: 'text/javascript' })), ${opts});
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`;
  const isGuarded = (r) => r && r.idb === 'undefined' && r.caches === 'undefined' && r.BC === 'undefined' && r.SW === 'undefined' && r.opfs === 'denied' && r.idbOpenNative === false && r.locks === 'ok';

  const cw = await call('A', spawn(classicSrc));
  check('卡片起的经典线程:存储、广播都用不了,锁照常', isGuarded(cw), cw);
  check('经典线程里再起的线程同样', isGuarded(cw.nested), cw.nested);
  const cwD = await call('D', spawn(classicSrc));
  check('对照(没装加固):经典线程里 IndexedDB、Cache、OPFS、BroadcastChannel 都在', cwD.idb === 'object' && cwD.caches === 'object' && cwD.opfs === 'open' && cwD.BC === 'function', cwD);

  // 舞台的 worker-src 只许 blob:,模块线程的静态 import 按 worker 目的地核:外链模块引不进来(实测记结论),能抢先跑的只有卡片自建的 blob 模块
  const remoteStatic = await call('D', spawn(`import { cap } from '${STAGE}/capture.mjs'; postMessage({ ok: typeof cap.idb });`, `{ type: 'module' }`));
  check('模块线程里静态 import 同源 http 模块:被舞台的 worker-src blob: 拦下(没装加固的对照文档里同样)', !!remoteStatic.error, remoteStatic);
  const remoteDynamic = await call('A', spawn(`try { const m = await import('${STAGE}/capture.mjs'); postMessage({ idb: typeof m.cap.idb }); } catch (e) { postMessage({ err: String(e) }); }`, `{ type: 'module' }`));
  check('模块线程里动态 import 的外链模块在守卫之后求值,拿不到存储入口', remoteDynamic.idb === 'undefined', remoteDynamic);
  // 卡片自己建一个 blob 模块 X(先拿存储入口、顶层 await 等库开好再写),在模块线程里静态引它
  const moduleSrc = `import { cap, dbPromise } from '__CAPTURE_URL__';
    ${CHECKS}
    const r = await checks();
    r.capIdb = typeof cap.idb;
    try { cap.idb.open('pc-leak'); r.capIdbOpen = 'opened'; } catch (e) { r.capIdbOpen = 'denied'; }
    try { await cap.caches.open('pc-leak'); r.capCaches = 'opened'; } catch (e) { r.capCaches = 'denied'; }
    try { await cap.storage.getDirectory(); r.capOpfs = 'opened'; } catch (e) { r.capOpfs = 'denied'; }
    try { new cap.BC('pc-leak').postMessage('x'); r.capBC = 'sent'; } catch (e) { r.capBC = 'denied'; }
    const db = await dbPromise;
    r.preDb = db ? 'opened-before-guard' : 'none';
    if (db) { try { db.transaction(['s'], 'readwrite'); r.preDbTx = 'tx'; } catch (e) { r.preDbTx = 'denied'; } }
    const u = URL.createObjectURL(new Blob([${JSON.stringify(nestedSrc)}], { type: 'text/javascript' }));
    const nw = new Worker(u, { type: 'module' });
    r.nested = await new Promise((res) => { nw.onmessage = (e) => res(e.data); nw.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; });
    postMessage(r);`;
  const spawnModuleWithX = `const x = URL.createObjectURL(new Blob([${JSON.stringify(CAPTURE_MJS)}], { type: 'text/javascript' }));
    const src = ${JSON.stringify(moduleSrc)}.replace('__CAPTURE_URL__', x);
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`;
  const mw = await call('A', spawnModuleWithX);
  check('卡片起的模块线程:存储、广播都用不了', isGuarded(mw), mw);
  check('模块线程静态 import 的卡片自建 blob 模块:求值时守卫已经装上,拿到的存储入口都是空的、写不进',
    mw.capIdb === 'undefined' && mw.capIdbOpen === 'denied' && mw.capCaches === 'denied' && mw.capOpfs === 'denied' && mw.capBC === 'denied' && mw.preDb === 'none', mw);
  check('模块线程里再起的模块线程同样', isGuarded(mw.nested), mw.nested);
  const mwD = await call('D', spawnModuleWithX);
  check('对照(没装加固):同样的 blob 模块在守卫之前拿到 IndexedDB 并开了库', mwD.capIdb === 'object' && mwD.preDb === 'opened-before-guard', { capIdb: mwD.capIdb, preDb: mwD.preDb, error: mwD.error });

  const refused = await call('A', `const out = {};
    const tryW = (k, f) => { try { f(); out[k] = 'constructed'; } catch (e) { out[k] = 'threw'; } };
    tryW('sameOrigin', () => new Worker('/same-origin-worker.js'));
    tryW('dataUrl', () => new Worker('data:text/javascript,postMessage(1)'));
    const u = URL.createObjectURL(new Blob(['postMessage(1)'])); URL.revokeObjectURL(u);
    tryW('revoked', () => new Worker(u));
    tryW('call', () => Worker(URL.createObjectURL(new Blob(['1']))));
    return out;`);
  check('别处的地址(同源脚本、data:、撤销了的 blob)起不了线程,不带 new 调用报错', Object.values(refused).every((v) => v === 'threw'), refused);

  const escape = await call('A', `const src = ${JSON.stringify(nestedSrc)};
    const run = (W) => new Promise((res) => { const w = new W(URL.createObjectURL(new Blob([src]))); w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message }); }; });
    const viaCtor = await run(Object.getPrototypeOf(new Worker(URL.createObjectURL(new Blob([''])))).constructor);
    class Sub extends Worker {}
    const viaSub = await run(Sub);
    const AIP = Object.getPrototypeOf([][Symbol.iterator]());
    const origIter = Array.prototype[Symbol.iterator], origNext = AIP.next;
    let viaIter, viaNext;
    Array.prototype[Symbol.iterator] = function* () { yield this[this.length - 1]; };
    try { viaIter = await run(Worker); } finally { Array.prototype[Symbol.iterator] = origIter; }
    AIP.next = function () { const r = origNext.call(this); if (!r.done && typeof r.value === 'string' && r.value.includes('PromptCut')) return origNext.call(this); return r; };
    try { viaNext = await run(Worker); } finally { AIP.next = origNext; }
    return { viaCtor, viaSub, subInstance: new Sub(URL.createObjectURL(new Blob(['']))) instanceof Worker, viaIter, viaNext };`);
  check('经 Worker.prototype.constructor 起的线程同样装了守卫', isGuarded(escape.viaCtor), escape.viaCtor);
  check('Worker 的子类照常能用、同样装了守卫', isGuarded(escape.viaSub) && escape.subInstance === true, escape.viaSub);
  check('改 Array.prototype[Symbol.iterator] 丢不掉守卫', isGuarded(escape.viaIter), escape.viaIter);
  check('改数组迭代器的 next 丢不掉守卫', isGuarded(escape.viaNext), escape.viaNext);

  const rt = await call('A', spawn(`importScripts(${JSON.stringify(`${STAGE}/runtime-worker.js`)});`));
  check('运行时那种「blob 引导 + importScripts 同源脚本」的线程照常跑,里面也装了守卫', rt.t === 'runtime-ok' && rt.idb === 'undefined' && rt.bc === 'undefined', rt);
  const dps = await call('A', spawn(`importScripts(${JSON.stringify(`${STAGE}/dps-worker.js`)});`));
  check('线程里先有守卫、再调 denyPersistentStorage(声音线程的做法):不报错', dps.t === 'dps' && dps.errors.length === 0 && dps.idb === 'undefined', dps);

  /* ---------- 锁名 ---------- */
  await call('A', `navigator.locks.request('sid-lock-0123', () => new Promise(() => {})); await new Promise((r) => setTimeout(r, 100)); return 1;`);
  const lockA = await call('A', `const q = await navigator.locks.query();
    const own = await navigator.locks.request('sid-lock-0123', { ifAvailable: true }, (l) => l ? 'got' : 'blocked');
    const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify("navigator.locks.request('sid-lock-0123', { ifAvailable: true }, (l) => postMessage(l ? 'got' : 'blocked'));")}])));
    const inWorker = await new Promise((res) => { w.onmessage = (e) => res(e.data); });
    return { held: q.held.map((l) => l.name), own, inWorker };`);
  check('本文档 query() 看到自己的锁(名字去掉了前缀),同名再要拿不到', lockA.held.includes('sid-lock-0123') && lockA.own === 'blocked', lockA);
  check('本文档起的线程和本文档共用锁名(照常协调)', lockA.inWorker === 'blocked', lockA.inWorker);
  const lockC = await call('C', `const q = await navigator.locks.query();
    const got = await navigator.locks.request('sid-lock-0123', { ifAvailable: true }, (l) => l ? 'got:' + l.name : 'blocked');
    return { names: [...q.held, ...q.pending].map((l) => l.name), got };`);
  check('别的文档(装了加固)看不见 A 的锁名,同名的锁照拿', lockC.names.length === 0 && lockC.got === 'got:sid-lock-0123', lockC);
  const lockD = await call('D', `const q = await navigator.locks.query(); return q.held.map((l) => l.name);`);
  check('对照(没装加固):真实锁名带着文档前缀,不是卡片起的名字', lockD.some((n) => /^pc-[0-9a-f]{32}:sid-lock-0123$/.test(n)) && !lockD.includes('sid-lock-0123'), lockD);

  /* ---------- storage 事件 ---------- */
  for (const id of ['C', 'D']) await call(id, `window.__se = []; addEventListener('storage', (e) => window.__se.push(e.key)); window.onstorage = (e) => window.__se.push('on:' + e.key); return 1;`);
  await call('A', `localStorage.setItem('pc.playable.1:' + 'a'.repeat(64), '1'); return 1;`);
  await sleep(600);
  const seC = await call('C', `return window.__se;`), seD = await call('D', `return window.__se;`);
  check('别的文档写真实 localStorage:装了加固的文档收不到 storage 事件', seC.length === 0, seC);
  check('对照(没装加固):收得到', seD.length > 0, seD);

  /* ---------- 重载:window.name、history.state、location.hash ---------- */
  const before = await call('A', `window.name = 'leak-sid-A'; history.pushState({ sid: 'leak-sid-A' }, '', '?sid=leak-sid-A'); location.hash = '#leak-sid-A';
    const out = { name: window.name, state: history.state, search: location.search, hash: location.hash, nav: typeof navigation, len: history.length };
    history.back(); history.go(-1); await new Promise((r) => setTimeout(r, 300)); out.stillHere = location.hash; return out;`);
  check('装了加固:卡片照常读写 window.name、history.state(只在本文档);pushState 不改地址;navigation 没有;back/go 不动',
    before.name === 'leak-sid-A' && before.state?.sid === 'leak-sid-A' && before.search === '?f=A' && before.nav === 'undefined' && before.stillHere === '#leak-sid-A', before);
  await page.evaluate(() => window.reloadFrame('A'));
  check('A 第二次重载', await waitLoad('A', 3));
  const after = await raw('A', 2);
  console.log(`      装了加固的文档重载后(加固前读到的原始值):${JSON.stringify(after)}`);
  check('装了加固的文档写的 window.name,frame.src = frame.src 重载后是空的', after.name === '', after.name);
  check('history.state 不跨 frame.src = frame.src 重载', after.state === null, after.state);
  check('location.hash 不跨 frame.src = frame.src 重载', after.hash === '', after.hash);
  check('新文档经 navigation.activation.from 读到的上一个条目里没有路径号(地址只有卡片能改的 hash,状态是空)',
    !after.from || (typeof after.from === 'object' && after.from.state === undefined && !String(after.from.url).includes('sid=')), after.from);
  const afterInstall = await call('A', install.replace('return {', 'return { nav: typeof navigation, len: history.length,'));
  check('A 重载后再装加固:没有错误,navigation 没有', afterInstall.errors.length === 0 && afterInstall.nav === 'undefined', afterInstall.errors.join('; '));
  // 对照:没装加固的 D 同样写,看哪些会留下
  await call('D', `window.name = 'ctl'; history.replaceState({ sid: 'ctl' }, ''); navigation.updateCurrentEntry({ state: { sid: 'ctl-nav' } }); location.hash = '#ctl'; return 1;`);
  await page.evaluate(() => window.reloadFrame('D'));
  check('D 重载', await waitLoad('D', 2));
  const ctl = await raw('D', 1);
  console.log(`      对照(没装加固)重载后:${JSON.stringify(ctl)}`);
  check('对照:没装加固时 window.name 留下来(说明这条通道真实存在)', ctl.name === 'ctl', ctl.name);
  check('对照:没装加固时新文档经 navigation.activation.from 读得到上一个文档的地址 hash 与状态(说明这条通道真实存在)',
    ctl.from && String(ctl.from.url).includes('#ctl') && ctl.from.state?.sid === 'ctl-nav', ctl.from);
  // 地址带 # 载入的舞台文档(只可能是退回到上一个文档自己加的条目):装加固时去掉
  await page.evaluate(() => window.addFrame('E', '#leak-sid-E'));
  check('E 载入', await waitLoad('E', 1));
  const hashE = await call('E', `const before = location.hash; PCH.installStageHardening({}); return { before, after: location.hash, href: location.href };`);
  check('地址带 #… 载入的文档:装加固时去掉', hashE.before === '#leak-sid-E' && hashE.after === '', hashE);
  // 卡片自己 location.reload():history.state 会不会留(只影响同一个项目的同一个文档,记结论)
  await call('C', `history.replaceState({ sid: 'self-reload' }, ''); setTimeout(() => location.reload(), 10); return 1;`);
  check('C 自己 reload', await waitLoad('C', 2));
  const selfReload = await raw('C', 1);
  console.log(`      卡片自己 location.reload() 之后:state=${JSON.stringify(selfReload.state)} name=${JSON.stringify(selfReload.name)}`);

  check('舞台里没有控制台错误(除了预期的拒绝)', consoleErrors.filter((t) => !/PromptCut|Content Security Policy|Refused/.test(t)).length === 0, consoleErrors.slice(0, 5));
} finally {
  await browser.close();
  for (const s of servers) s.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 留着也无妨 */ }
}
console.log(`\nscopeGuard browser check (${MINIFY ? 'minified' : 'not minified'}): ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exitCode = 1; }
