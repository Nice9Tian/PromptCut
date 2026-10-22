/**
 * 舞台源跨文档通道守卫(`scopeGuard.ts`)与舞台文档自己的跨文档状态(`harden.ts` 的 `isolateWindowState`)。
 * 用仿浏览器的全局对象核逻辑;真实无头 Chrome 里的行为由 `scopeGuard.browser-check.mjs` 核(不进 npm test)。
 * 跑:node --test src/online/isolation/scopeGuard.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { guardStageScope, installScopeGuard, newLockPrefix } from "./scopeGuard.ts";
import { denyPersistentStorage, isolateWindowState } from "./harden.ts";

const PREFIX = "pc-0123456789abcdef0123456789abcdef:";

/** 仿浏览器的全局对象:Blob / URL / Worker / 存储 / 通道 / 锁,都可配置可写(和浏览器一样) */
function fakeScope() {
  const scope = {};
  const registry = new Map();
  let n = 0;
  class Blob {
    constructor(parts = [], opts = {}) { this.parts = [...parts]; this.type = opts.type ?? ""; } // 按迭代器读 parts,和 WebIDL 一样
  }
  const URL = {
    createObjectURL(obj) { if (!(obj instanceof Blob)) throw new TypeError("not a blob"); const u = `blob:fake/${++n}`; registry.set(u, obj); return u; },
    revokeObjectURL(u) { registry.delete(String(u)); },
  };
  const spawned = [];
  class Worker { constructor(url, opts) { const blob = registry.get(String(url)); spawned.push({ url: String(url), opts, blob }); this.url = String(url); } }
  class IDBFactory { open() { return "opened"; } deleteDatabase() { return "deleted"; } async databases() { return ["db"]; } cmp() { return 0; } }
  class IDBDatabase { transaction() { return "tx"; } createObjectStore() { return "store"; } deleteObjectStore() {} }
  class CacheStorage { async open() { return "cache"; } async has() { return true; } async delete() { return true; } async keys() { return []; } async match() { return null; } }
  class Cache { async put() {} async add() {} async addAll() {} async match() {} async matchAll() {} async keys() {} async delete() {} }
  class StorageManager { async getDirectory() { return "opfs"; } async persist() { return true; } async persisted() { return true; } async estimate() { return { quota: 1 }; } }
  class StorageBucketManager { async open() { return "bucket"; } async keys() { return []; } async delete() {} }
  class FileSystemHandle { async remove() {} async move() {} }
  class FileSystemDirectoryHandle extends FileSystemHandle { async getFileHandle() {} async getDirectoryHandle() {} async removeEntry() {} async resolve() {} entries() {} keys() {} values() {} }
  class FileSystemFileHandle extends FileSystemHandle { async getFile() {} async createWritable() {} async createSyncAccessHandle() {} }
  class ServiceWorkerContainer { async register() { return "reg"; } async getRegistrations() { return []; } }
  class BroadcastChannel { constructor(name) { this.name = name; } postMessage(m) { return `sent:${m}`; } }
  class SharedWorker {}
  class CookieStore { async set() { return "set"; } async delete() { return "deleted"; } async get() { return null; } }
  const lockCalls = [];
  class Lock { constructor(name) { this._name = name; } get name() { return this._name; } }
  class LockManager {
    request(...args) { lockCalls.push(args[0]); const cb = args[args.length - 1]; return Promise.resolve(cb(new Lock(args[0]))); }
    async query() { return { held: [{ name: `${PREFIX}mine`, mode: "exclusive", clientId: "c1" }, { name: "pc-other:theirs", mode: "exclusive", clientId: "c2" }, { name: "raw", mode: "shared", clientId: "c3" }], pending: [{ name: `${PREFIX}waiting`, mode: "exclusive", clientId: "c1" }] }; }
  }
  Object.assign(scope, {
    Blob, URL, Worker, IDBFactory, IDBDatabase, CacheStorage, Cache, StorageManager, StorageBucketManager, FileSystemHandle, FileSystemDirectoryHandle,
    FileSystemFileHandle, ServiceWorkerContainer, BroadcastChannel, SharedWorker, CookieStore, Lock, LockManager,
    indexedDB: new IDBFactory(), caches: new CacheStorage(), webkitRequestFileSystem: () => {}, sharedStorage: {},
    navigator: { storage: new StorageManager(), storageBuckets: new StorageBucketManager(), locks: new LockManager(), serviceWorker: new ServiceWorkerContainer() },
    cookieStore: new CookieStore(),
  });
  return { scope, registry, spawned, lockCalls };
}

const install = (scope) => guardStageScope(scope, { lockPrefix: PREFIX, source: guardStageScope.toString() });

test("OCS-H-11 守卫是自足的:源码拿出来在只带标准内置对象的环境里照样装得上(线程里就是这么跑的)", () => {
  const src = guardStageScope.toString();
  const { scope } = fakeScope();
  // 只给标准内置对象(vm 新环境)和仿全局对象:函数体引用了外面的名字就会 ReferenceError
  const ctx = vm.createContext({ fakeSelf: scope });
  const r = vm.runInContext(`(${src})(fakeSelf, ${JSON.stringify({ lockPrefix: PREFIX, source: src })})`, ctx);
  assert.equal(r.errors.length, 0, [...r.errors].join("; ")); // 别的环境里的数组:不用 deepEqual(原型不同)
  for (const k of ["Worker", "indexedDB", "BroadcastChannel", "SharedWorker", "LockManager.request", "CookieStore.set", "IDBFactory.open"]) assert.ok(r.denied.includes(k), k);
  assert.equal(scope.indexedDB, undefined);
  // installScopeGuard 用的就是这份源码
  assert.match(fs.readFileSync(new URL("./scopeGuard.ts", import.meta.url), "utf8"), /source: guardStageScope\.toString\(\)/);
  assert.match(newLockPrefix(), /^pc-[0-9a-f]{32}:$/);
});

test("OCS-H-12 卡片起的线程:只认本页建的 blob 地址;经典脚本前面拼守卫,模块第一句 import 守卫模块;绕不过去", async () => {
  const { scope, registry, spawned } = fakeScope();
  const OrigWorker = scope.Worker;
  const r = install(scope);
  assert.deepEqual(r.errors, []);
  const card = new scope.Blob(["postMessage(1)"]);
  const url = scope.URL.createObjectURL(card);

  // 经典脚本:新 blob = 守卫源码 + 原 blob
  const w = new scope.Worker(url, { name: "n", type: "classic" });
  assert.ok(w instanceof OrigWorker && w instanceof scope.Worker);
  const s = spawned.at(-1);
  assert.notEqual(s.url, url, "起的是新拼的 blob");
  assert.equal(registry.has(s.url), false, "经典脚本:新拼的地址起完就撤");
  assert.deepEqual(s.opts, { type: "classic", name: "n" });
  assert.equal(s.blob.parts.length, 2);
  assert.equal(s.blob.parts[1], card);
  assert.ok(s.blob.parts[0].includes("function guardStageScope") && s.blob.parts[0].includes(JSON.stringify(PREFIX)), "第一段是守卫源码与本文档的锁名前缀");
  // 守卫源码在新环境里能跑(线程里第一句)
  const inner = fakeScope();
  vm.runInContext(s.blob.parts[0], vm.createContext({ self: inner.scope }));
  assert.equal(inner.scope.indexedDB, undefined);
  assert.equal(typeof inner.scope.BroadcastChannel, "undefined");
  assert.notEqual(inner.scope.Worker, undefined, "线程里的 Worker 也包过(再起的线程同样装守卫)");
  const nestedUrl = inner.scope.URL.createObjectURL(new inner.scope.Blob(["1"]));
  new inner.scope.Worker(nestedUrl);
  assert.ok(inner.spawned.at(-1).blob.parts[0].includes("function guardStageScope"), "线程里再起的线程同样先装守卫");

  // 模块:第一句静态 import 守卫模块(只建一个,不撤)
  new scope.Worker(url, { type: "module" });
  const m = spawned.at(-1);
  assert.match(m.blob.parts[0], /^import "blob:fake\/\d+";\n$/);
  const preludeUrl = JSON.parse(m.blob.parts[0].slice("import ".length, -2));
  assert.ok(registry.get(preludeUrl).parts[0].includes("function guardStageScope"));
  scope.URL.revokeObjectURL(preludeUrl);
  assert.ok(registry.has(preludeUrl), "守卫模块的地址卡片撤不掉");
  new scope.Worker(url, { type: "module" });
  assert.equal(spawned.at(-1).blob.parts[0], m.blob.parts[0], "同一个文档只建一个守卫模块");

  // 认不出的地址一律不起
  for (const bad of ["/worker.js", "https://x.test/w.js", "data:text/javascript,1", "blob:fake/999"]) assert.throws(() => new scope.Worker(bad), /PromptCut 舞台/, bad);
  const revoked = scope.URL.createObjectURL(new scope.Blob(["1"]));
  scope.URL.revokeObjectURL(revoked);
  assert.throws(() => new scope.Worker(revoked), /PromptCut 舞台/);
  assert.throws(() => scope.Worker(url), /new/);
  // 带 # 的地址照认
  new scope.Worker(`${url}#frag`);
  assert.equal(spawned.at(-1).blob.parts[1], card);

  // 绕路:原构造函数拿不回来、换不掉
  assert.equal(scope.Worker.prototype.constructor, scope.Worker);
  assert.throws(() => { OrigWorker.prototype.constructor = OrigWorker; }, TypeError);
  assert.equal(Reflect.set(scope, "Worker", OrigWorker), false);
  assert.throws(() => Object.defineProperty(scope, "Worker", { value: OrigWorker }), TypeError);
  assert.throws(() => Object.defineProperty(scope.URL, "createObjectURL", { value: () => "" }), TypeError);
  // 子类照常
  class Sub extends scope.Worker {}
  const sub = new Sub(url);
  assert.ok(sub instanceof Sub && sub instanceof OrigWorker);
  assert.ok(spawned.at(-1).blob.parts[0].includes("function guardStageScope"));
  // 改数组迭代器丢不掉守卫那一段
  const origIter = Array.prototype[Symbol.iterator];
  Array.prototype[Symbol.iterator] = function* () { yield this[this.length - 1]; };
  try { new scope.Worker(url); } finally { Array.prototype[Symbol.iterator] = origIter; }
  assert.equal(spawned.at(-1).blob.parts.length, 2);
  assert.ok(spawned.at(-1).blob.parts[0].includes("function guardStageScope"));
});

test("OCS-H-13 持久存储与同源通道:全局入口没有,先拿到的对象也用不了;cookieStore 写拒绝;persist 回 false;装两次、再调 denyPersistentStorage 都不报错", async () => {
  const { scope } = fakeScope();
  const captured = { idb: scope.indexedDB, caches: scope.caches, storage: scope.navigator.storage, BC: scope.BroadcastChannel, db: new scope.IDBDatabase(), sw: scope.navigator.serviceWorker };
  const bc = new captured.BC("x");
  const r = install(scope);
  assert.deepEqual(r.errors, []);
  for (const k of ["indexedDB", "caches", "webkitRequestFileSystem", "sharedStorage", "BroadcastChannel", "SharedWorker"]) {
    assert.equal(scope[k], undefined, k);
    assert.equal(Reflect.set(scope, k, {}), false, k);
  }
  assert.throws(() => captured.idb.open("leak"), /持久存储/);
  assert.throws(() => captured.idb.deleteDatabase("leak"), /持久存储/);
  await assert.rejects(captured.idb.databases(), /持久存储/);
  assert.equal(captured.idb.cmp(1, 2), 0, "不相干的方法照旧");
  assert.throws(() => captured.db.transaction(["s"], "readwrite"), /持久存储/);
  await assert.rejects(captured.caches.open("c"), /持久存储/);
  await assert.rejects(new scope.Cache().put("k", "v"), /持久存储/);
  await assert.rejects(captured.storage.getDirectory(), /持久存储/);
  assert.equal(await captured.storage.persist(), false);
  assert.deepEqual(await captured.storage.estimate(), { quota: 1 });
  await assert.rejects(scope.navigator.storageBuckets.open("b"), /持久存储/);
  await assert.rejects(new scope.FileSystemFileHandle().createWritable(), /持久存储/);
  assert.throws(() => new scope.FileSystemDirectoryHandle().entries(), /持久存储/);
  await assert.rejects(captured.sw.register("/sw.js"), /Service Worker/);
  assert.throws(() => bc.postMessage("leak"), /BroadcastChannel/);
  await assert.rejects(scope.cookieStore.set("a", "b"), /cookie/);
  await assert.rejects(scope.cookieStore.delete("a"), /cookie/);
  assert.equal(await scope.cookieStore.get("a"), null);
  assert.throws(() => Object.defineProperty(scope.IDBFactory.prototype, "open", { value: () => "x" }), TypeError);

  // 再装一遍(线程里先有引导、模块又装):不报错
  assert.deepEqual(install(scope).errors, []);
  // 声音线程:引导装过守卫后再调 denyPersistentStorage
  const d = denyPersistentStorage(scope);
  assert.deepEqual(d.errors, []);
  assert.ok(d.denied.includes("StorageManager.getDirectory"));

  // 舞台文档里 harden.ts 第 6 节先锁了 cookieStore:认作已锁、不报错
  const doc = fakeScope();
  Object.defineProperty(doc.scope.CookieStore.prototype, "set", { value: async () => { throw new TypeError("earlier lock"); }, writable: false, configurable: false });
  const r2 = install(doc.scope);
  assert.deepEqual(r2.errors, []);
  assert.ok(r2.denied.includes("CookieStore.set"));
});

test("OCS-H-14 锁名按文档加前缀:本文档照常用,别的文档的锁看不见", async () => {
  const { scope, lockCalls } = fakeScope();
  install(scope);
  const name = await scope.navigator.locks.request("sid-lock", (l) => l.name);
  assert.equal(lockCalls.at(-1), `${PREFIX}sid-lock`, "真实锁名带前缀");
  assert.equal(name, "sid-lock", "回调里看到的名字去掉了前缀");
  await scope.navigator.locks.request("opt", { ifAvailable: true }, () => {});
  assert.equal(lockCalls.at(-1), `${PREFIX}opt`);
  await scope.navigator.locks.request("-reserved", () => {});
  assert.equal(lockCalls.at(-1), "-reserved", "保留名原样交给浏览器报错");
  const q = await scope.navigator.locks.query();
  assert.deepEqual(q, { held: [{ name: "mine", mode: "exclusive", clientId: "c1" }], pending: [{ name: "waiting", mode: "exclusive", clientId: "c1" }] });
});

/** 仿窗口:`name` 是原型上的访问器(真实值在闭包里),有 History、navigation、事件监听 */
function fakeWindow({ name = "", hash = "" } = {}) {
  const real = { name, state: null, url: `/editor/stage.html?stage=1${hash}`, moves: 0 };
  const proto = {};
  Object.defineProperty(proto, "name", { configurable: true, enumerable: true, get: () => real.name, set: (v) => { real.name = String(v); } });
  const w = Object.create(proto);
  class History {
    get state() { return real.state; }
    pushState(s, _u, url) { real.state = s; if (url !== undefined) real.url = url; }
    replaceState(s, _u, url) { real.state = s; if (url !== undefined) real.url = url; }
    back() { real.moves--; } forward() { real.moves++; } go(n) { real.moves += n; }
  }
  w.History = History;
  w.history = new History();
  Object.defineProperty(w, "navigation", { configurable: true, enumerable: true, get: () => ({ activation: { from: { url: "leak" } } }) });
  w.location = { get hash() { const i = real.url.indexOf("#"); return i >= 0 ? real.url.slice(i) : ""; }, pathname: "/editor/stage.html", search: "?stage=1" };
  const listeners = [];
  w.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
  w.structuredClone = structuredClone;
  return { w, real, listeners };
}

test("OCS-H-15 舞台文档自己的跨文档状态:window.name 清空并只在内存;会话历史只在内存、不走动;navigation 没有;storage 事件截住;地址上的 # 去掉", () => {
  const { w, real, listeners } = fakeWindow({ name: "leak-from-last-project", hash: "#leak" });
  const r = isolateWindowState(w);
  assert.deepEqual(r.errors, []);
  assert.equal(real.name, "", "真实的 window.name 清空了");
  assert.equal(w.name, "");
  w.name = "sid-of-this-project";
  assert.equal(w.name, "sid-of-this-project", "本文档里照常读写");
  assert.equal(real.name, "", "真实的 window.name 一直是空的");
  assert.throws(() => Object.defineProperty(w, "name", { get: () => real.name }), TypeError, "改不回来");

  assert.equal(real.url, "/editor/stage.html?stage=1", "载入时地址上的 # 去掉了");
  w.history.pushState({ sid: "x" }, "", "?sid=x#y");
  assert.deepEqual(w.history.state, { sid: "x" });
  assert.equal(real.state, null, "真实条目里没有状态");
  assert.equal(real.url, "/editor/stage.html?stage=1", "地址不改");
  w.history.replaceState({ sid: "z" }, "");
  assert.deepEqual(w.history.state, { sid: "z" });
  assert.throws(() => w.history.pushState(() => {}, ""), /could not be cloned/, "克隆不了照样抛错");
  w.history.back(); w.history.go(-2); w.history.forward();
  assert.equal(real.moves, 0, "不在会话历史里走动");
  assert.equal(w.navigation, undefined);
  assert.equal(Reflect.set(w, "navigation", {}), false);

  const storage = listeners.find((l) => l.type === "storage");
  assert.ok(storage && storage.capture === true, "捕获阶段监听 storage");
  let stopped = false;
  storage.fn({ stopImmediatePropagation: () => { stopped = true; } });
  assert.ok(stopped, "storage 事件不往下传");
});

test("OCS-H-16 接线:舞台加固装上通道守卫与本文档状态隔离(在 MutationObserver 兜底之前、任何卡片代码之前)", () => {
  const harden = fs.readFileSync(new URL("./harden.ts", import.meta.url), "utf8");
  const body = harden.slice(harden.indexOf("export function installStageHardening"));
  const scoped = body.indexOf("const scoped = installScopeGuard(w);");
  const own = body.indexOf("const own = isolateWindowState(w);");
  const storage = body.indexOf("const storage = denyPersistentStorage(w);");
  assert.ok(storage > 0 && scoped > storage && own > scoped, "6b 存储 → 6c 通道守卫 → 6d 本文档状态");
  assert.ok(own < body.indexOf("new w.MutationObserver"));
  assert.match(body, /scopeGuarded: \[\.\.\.scoped\.denied, \.\.\.own\.denied\]/);
  assert.equal(typeof installScopeGuard, "function");
});
