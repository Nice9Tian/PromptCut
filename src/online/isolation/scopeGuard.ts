/**
 * 舞台源上的跨文档通道守卫:舞台文档与它(以及它里面的代码)起的每一个后台线程都装同一份。
 *
 * 为什么要有:舞台是两个共用的跨源源,哪个项目打开就跑哪个项目的卡片代码。卡片参数里带着本项目的路径号
 * (`/media-s/<路径号>/media/<哈希>`,`docs/semantics/mechanism/platforms.md`「路径号按账号加项目固定」);
 * 浏览器把素材缓存一年,谁知道了路径号和哈希就能读到缓存里的素材。项目 A 的卡片(哪怕是没有恶意、只是图省事的卡)
 * 只要能把参数留在舞台源上「活过本文档」或「别的文档同时看得见」的地方,项目 B 的卡片就能拿到。
 * 舞台文档里的 `localStorage` 等由 `harden.ts` 的 `denyPersistentStorage` 收走;本文件管剩下的:
 *
 * - **后台线程**:`Worker` 换成包装过的构造函数,只认本文档(本线程)用 `URL.createObjectURL` 建的 blob 地址,
 *   起线程时拼一个新 blob:经典脚本是「本守卫的源码 + 调用」拼在原脚本前面;模块是第一句 `import` 一个只含守卫的 blob 模块
 *   (模块按静态 import 在源码里的先后深度优先求值,守卫模块排第一,先于原脚本引的一切)。所以每个线程(含线程里再起的线程)
 *   第一句就装本守卫。认不出的地址(别处建的 blob、撤销了的 blob、`data:`、同源脚本地址)直接抛错;
 *   **经典脚本的顶层声明比守卫还早**(整段脚本开跑之前,顶层 `function` 声明就绑到全局上、顶层 `let`/`const`/`class` 进暂时死区),
 *   所以守卫:① 装在顶层的 `this` 上(它遮不住),不从 `self`、`globalThis` 取;② 内置对象尽量从字面量取(`({}).constructor` 等),
 *   取不到字面量的 `Reflect`、`JSON` 核 `typeof`(函数声明只能造出函数);③ 要用的平台接口核一遍有没有被顶层函数声明改掉
 *   (函数声明留下的是「可枚举、不可配置」的自有属性,浏览器原装的接口对象不可枚举、可配置);
 *   ④ 线程里(`strict`)核对不过、或关键项(存储、通道、`Worker`)没装上,就抛错,整段脚本不执行;包 `Worker` 失败时把 `Worker` 收走。
 *   顶层 `let`/`const`/`class` 同名的,守卫一读就是 ReferenceError,同样整段不执行。
 *   舞台的内容安全策略本来就只许 `worker-src blob:`。`SharedWorker` 不给(多个文档共用一个线程,本身就是跨文档通道)。
 * - **持久存储**(线程里同样有):IndexedDB、Cache Storage、旧式文件系统、`openDatabase`、`sharedStorage` 的全局入口沿原型链改成 `undefined`;
 *   另外把这些接口原型上的读写方法一律改成抛错或拒绝(纵深防御:万一有代码先于守卫拿到了 `indexedDB`、`caches`、
 *   `navigator.storage` 对象或开好的库,也开不了库、开不了事务、写不进缓存、打不开文件)。
 *   源私有文件系统、存储桶拒绝;`navigator.storage.persist()` 回 false;Service Worker 注册拒绝(内容安全策略本来也拦)。
 * - **同源实时通道**:`BroadcastChannel` 不给(发消息的原型方法也改成抛错);
 *   Web Locks 的锁名按本文档加一段随机前缀(`lockPrefix`),本文档和它起的线程共用一个前缀,
 *   互相之间照常能用锁协调;别的文档(别的项目)的锁既看不见(`query()` 只回本前缀的)、也抢不到、也占不住同名的。
 * - **`cookieStore` 写入**:`set`、`delete` 拒绝(舞台文档里 `harden.ts` 第 6 节已锁过的,这里认作已锁)。
 *
 * **必须是自足的函数**:线程里没有模块,起线程时用 `guardStageScope.toString()` 拼出源码送进去,
 * 所以函数体里不能引用本模块或别的模块里的任何名字,只能用标准内置对象;单测在一个只带标准内置对象的 `vm` 环境里执行它的源码核这一点。
 *
 * 已知限制(都写进 AGENT 报告):
 * - 经典脚本的线程:拼在前面的守卫让原脚本开头的 `"use strict"` 不再是指令(原脚本按非严格模式跑;函数里自己写的 `"use strict"` 照旧)。
 *   在舞台里没法同步读出原脚本的文字来判断,`importScripts(blob:)` 又被 `script-src` 拦,所以只能这样。
 * - 模块线程:静态 import 只能引 blob 地址(`worker-src blob:`,外链模块整个图按 worker 目的地核,实测拦下),
 *   都排在守卫模块之后求值;动态 `import()` 发生在运行期,更在守卫之后。
 * - 只防「别的项目的卡片读到本项目卡片无意留下的路径号」;刻意作恶的卡片本来就能把本项目的素材直接发到外网(出口不限,2026-10-08 用户定)。
 */

export interface ScopeGuardConfig {
  /** Web Locks 锁名前缀:一个舞台文档一份随机串,它起的线程沿用 */
  lockPrefix: string;
  /** `guardStageScope` 自己的源码(拼线程的引导脚本用) */
  source: string;
  /**
   * 线程里为真(引导脚本里写死):守卫核对不过、或关键项没装上,就抛错,整段脚本不执行。
   * 舞台文档里不设:核对不过、关键项没装上记进 `errors`,由舞台自检(`isolationCheck.ts`)判「加固没装上」、不执行用户卡。
   */
  strict?: boolean;
}

/** 关键项:这些没装上,线程不执行、舞台自检判「加固没装上」(`errors` 里以「名字:」开头的项) */
export const SCOPE_GUARD_CRITICAL = ["integrity", "indexedDB", "caches", "BroadcastChannel", "SharedWorker", "Worker"] as const;

export interface ScopeGuardResult {
  /** 收走或改掉的入口(诊断) */
  denied: string[];
  /** 没装上的项(诊断) */
  errors: string[];
}

/**
 * 在一个全局对象(窗口或线程)上装守卫。同一个全局对象装两次不报错(第二次认作已锁)。
 * **自足**:见文件头;改这个函数时别引用函数体外的任何名字。
 */
export function guardStageScope(scope: object, config: ScopeGuardConfig): ScopeGuardResult {
  "use strict";
  const denied: string[] = [];
  const errors: string[] = [];
  const g = scope as Record<string, any>;
  /*
   * 0. 内置对象。经典脚本线程里守卫是拼在卡片脚本前面的,卡片的顶层 `function Object(){}` 之类在守卫之前就把同名全局换掉了;
   * 字面量的原型链换不掉(守卫之前没有任何代码运行,原型都是原装的),所以能从字面量取的一律从字面量取,不读全局名字。
   */
  const O = ({}).constructor as ObjectConstructor;
  const defineProperty = O.defineProperty;
  const getOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
  const getPrototypeOf = O.getPrototypeOf;
  const hasOwn = O.prototype.hasOwnProperty;
  const ArrayC = ([] as unknown[]).constructor as ArrayConstructor;
  const Str = "".constructor as StringConstructor;
  let TypeErr = undefined as unknown as TypeErrorConstructor;
  try { defineProperty(1 as unknown as object, "x", {}); } catch (e) { TypeErr = (e as { constructor: TypeErrorConstructor }).constructor; }
  const P = (async () => undefined)().constructor as PromiseConstructor;
  const Sym = O(O.getOwnPropertySymbols(ArrayC.prototype)[0]).constructor as SymbolConstructor;
  // 没有字面量的两个:函数声明只能造出函数,还是对象就是原装的
  const shadowed: string[] = [];
  const R = typeof Reflect === "object" && Reflect !== null ? Reflect : null;
  const J = typeof JSON === "object" && JSON !== null ? JSON : null;
  if (!R) shadowed[shadowed.length] = "Reflect";
  if (!J) shadowed[shadowed.length] = "JSON";
  /*
   * 要读的平台接口:顶层函数声明把它换掉之后,全局上留下的是「可枚举、不可配置」的自有属性(规范 CreateGlobalFunctionBinding)。
   * 接口对象(构造函数)浏览器原装的一律不可枚举,所以接口对象只要可枚举就算被换过;全局属性与方法(`indexedDB` 等)原装的可枚举、可配置。
   * 本守卫与舞台加固自己锁的都不可枚举。
   */
  const IFACES = ["URL", "Blob", "Worker", "SharedWorker", "BroadcastChannel", "IDBFactory", "IDBDatabase", "CacheStorage", "Cache",
    "StorageManager", "StorageBucketManager", "FileSystemHandle", "FileSystemDirectoryHandle", "FileSystemFileHandle", "ServiceWorkerContainer",
    "CookieStore", "LockManager", "Lock"];
  const ATTRS = ["indexedDB", "caches", "webkitRequestFileSystem", "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL",
    "webkitResolveLocalFileSystemSyncURL", "openDatabase", "openDatabaseSync", "sharedStorage"];
  for (let i = 0; i < IFACES.length + ATTRS.length; i++) {
    const iface = i < IFACES.length;
    const name = iface ? IFACES[i] : ATTRS[i - IFACES.length];
    const d = getOwnPropertyDescriptor(scope, name);
    if (d && d.enumerable && (iface || !d.configurable)) shadowed[shadowed.length] = name;
  }
  if (shadowed.length) {
    let names = "";
    for (let i = 0; i < shadowed.length; i++) names += (i ? "," : "") + shadowed[i];
    const what = "integrity:内置对象或平台接口在守卫之前被改过(" + names + ")";
    if (config.strict) throw new TypeErr("PromptCut 舞台:" + what);
    errors[errors.length] = what;
    return { denied, errors };
  }
  const apply = R!.apply;
  const construct = R!.construct;
  const promiseReject = P.reject;
  const promiseResolve = P.resolve;
  const promiseThen = P.prototype.then;
  const stringify = J!.stringify;
  const strIndexOf = Str.prototype.indexOf;
  const strSlice = Str.prototype.slice;
  const arraySlice = ArrayC.prototype.slice;
  const arrayPush = ArrayC.prototype.push;
  const MARK = Sym.for("promptcut.stageGuard");
  const ITER = Sym.iterator;
  const prefix = Str(config.lockPrefix);
  const source = Str(config.source);

  // 与 `SCOPE_GUARD_CRITICAL` 同一份(守卫自足,不能引用外面的名字;单测核两边一致)
  const CRITICAL = ["integrity", "indexedDB", "caches", "BroadcastChannel", "SharedWorker", "Worker"];
  const fail = (what: string, e: unknown) => { errors.push(what + ":" + (e && (e as Error).message)); };
  const message = (what: string) => "PromptCut 舞台:" + what;
  const thrower = (what: string) => function () { throw new TypeErr(message(what)); };
  const rejecter = (what: string) => function () { return apply(promiseReject, P, [new TypeErr(message(what))]); };

  /** 全局入口沿原型链改成 `undefined`,锁死 */
  const removeGlobal = (key: string) => {
    try {
      let hit = false;
      for (let o: object | null = scope; o; o = getPrototypeOf(o)) {
        if (!apply(hasOwn, o, [key])) continue;
        defineProperty(o, key, { value: undefined, writable: false, configurable: false, enumerable: false });
        hit = true;
      }
      if (hit && !apply(hasOwn, scope, [key])) defineProperty(scope, key, { value: undefined, writable: false, configurable: false, enumerable: false });
      if (hit) denied.push(key);
    } catch (e) { fail(key, e); }
  };

  /** 把 `target[key]` 换成 `fn` 并锁死。已经锁过的(不可配置、不可写)认作已锁:守卫在任何卡片代码之前装,锁只可能是自己(或舞台加固)上的 */
  const replace = (target: object | null | undefined, key: string, fn: unknown, label: string): boolean => {
    if (!target) return false;
    try {
      const d = getOwnPropertyDescriptor(target, key);
      if (!d) return false;
      if (!d.configurable && !d.writable) { denied.push(label); return true; }
      if (typeof fn === "function") defineProperty(fn, MARK, { value: true });
      defineProperty(target, key, { value: fn, writable: false, configurable: false, enumerable: !!d.enumerable });
      denied.push(label);
      return true;
    } catch (e) { fail(label, e); return false; }
  };
  const protoOf = (name: string): object | null => {
    try { const C = g[name]; return C && typeof C === "function" && C.prototype ? C.prototype : null; } catch { return null; }
  };
  const neuter = (ctor: string, methods: string[], make: (what: string) => () => unknown, what: string) => {
    const proto = protoOf(ctor);
    if (!proto) return;
    for (let i = 0; i < methods.length; i++) {
      const d = getOwnPropertyDescriptor(proto, methods[i]);
      if (d && typeof d.value === "function") replace(proto, methods[i], make(what), ctor + "." + methods[i]);
    }
  };

  /* ---------- 1. 持久存储:先废原型上的读写方法(外链模块事先拿到的对象也用不了),再收全局入口 ---------- */
  const STORE = "不能用持久存储";
  neuter("IDBFactory", ["open", "deleteDatabase"], thrower, STORE);
  neuter("IDBFactory", ["databases"], rejecter, STORE);
  neuter("IDBDatabase", ["transaction", "createObjectStore", "deleteObjectStore"], thrower, STORE);
  neuter("CacheStorage", ["open", "has", "delete", "keys", "match"], rejecter, STORE);
  neuter("Cache", ["put", "add", "addAll", "match", "matchAll", "keys", "delete"], rejecter, STORE);
  neuter("StorageManager", ["getDirectory"], rejecter, STORE);
  neuter("StorageBucketManager", ["open", "keys", "delete"], rejecter, STORE);
  neuter("FileSystemHandle", ["remove", "move"], rejecter, STORE);
  neuter("FileSystemDirectoryHandle", ["getFileHandle", "getDirectoryHandle", "removeEntry", "resolve"], rejecter, STORE);
  neuter("FileSystemDirectoryHandle", ["entries", "keys", "values"], thrower, STORE);
  neuter("FileSystemFileHandle", ["getFile", "createWritable", "createSyncAccessHandle"], rejecter, STORE);
  {
    // 「这个源的存储别清」只是一个标志,但它跨文档、跨会话可读(`persisted()`),照浏览器拒绝时的样子回 false
    const proto = protoOf("StorageManager");
    if (proto && typeof getOwnPropertyDescriptor(proto, "persist")?.value === "function") {
      replace(proto, "persist", function persist() { return apply(promiseResolve, P, [false]); }, "StorageManager.persist");
    }
  }
  neuter("ServiceWorkerContainer", ["register"], rejecter, "不能注册 Service Worker");
  const GLOBALS = ["indexedDB", "caches", "webkitRequestFileSystem", "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL",
    "webkitResolveLocalFileSystemSyncURL", "openDatabase", "openDatabaseSync", "sharedStorage"];
  for (let i = 0; i < GLOBALS.length; i++) removeGlobal(GLOBALS[i]);

  /* ---------- 2. 同源实时通道 ---------- */
  neuter("BroadcastChannel", ["postMessage"], thrower, "不能用 BroadcastChannel");
  removeGlobal("BroadcastChannel");
  removeGlobal("SharedWorker");

  /* ---------- 3. cookie 写入(Service Worker 与窗口里才有 cookieStore) ---------- */
  neuter("CookieStore", ["set", "delete"], rejecter, "不能写 cookie");

  /* ---------- 4. Web Locks:锁名按本文档加前缀 ---------- */
  try {
    const LM = protoOf("LockManager");
    const LockP = protoOf("Lock");
    const origRequest = LM ? getOwnPropertyDescriptor(LM, "request")?.value : undefined;
    const origQuery = LM ? getOwnPropertyDescriptor(LM, "query")?.value : undefined;
    const strip = (name: unknown): unknown => {
      const s = typeof name === "string" ? name : Str(name);
      return apply(strIndexOf, s, [prefix]) === 0 ? apply(strSlice, s, [prefix.length]) : s;
    };
    if (LM && typeof origRequest === "function") {
      replace(LM, "request", function request(this: unknown) {
        // eslint-disable-next-line prefer-rest-params
        const args = apply(arraySlice, arguments, []) as unknown[];
        if (args.length > 0) {
          const name = typeof args[0] === "string" ? args[0] : Str(args[0]);
          // 以 `-` 开头的是保留名:原样交给浏览器,让它照规矩报错
          if (apply(strIndexOf, name, ["-"]) !== 0) args[0] = prefix + name;
        }
        return apply(origRequest, this, args);
      }, "LockManager.request");
    }
    if (LM && typeof origQuery === "function") {
      replace(LM, "query", function query(this: unknown) {
        const only = (list: unknown) => {
          const out: unknown[] = [];
          const arr = list as { length: number; [i: number]: { name?: unknown; mode?: unknown; clientId?: unknown } } | null;
          if (!arr) return out;
          for (let i = 0; i < arr.length; i++) {
            const it = arr[i];
            if (!it || typeof it.name !== "string" || apply(strIndexOf, it.name, [prefix]) !== 0) continue;
            apply(arrayPush, out, [{ name: apply(strSlice, it.name, [prefix.length]), mode: it.mode, clientId: it.clientId }]);
          }
          return out;
        };
        return apply(promiseThen, apply(origQuery, this, []), [(snap: { held?: unknown; pending?: unknown } | null) => ({ held: only(snap && snap.held), pending: only(snap && snap.pending) })]);
      }, "LockManager.query");
    }
    const nameGet = LockP ? getOwnPropertyDescriptor(LockP, "name")?.get : undefined;
    if (LockP && nameGet) {
      const d = getOwnPropertyDescriptor(LockP, "name")!;
      if (d.configurable) {
        defineProperty(LockP, "name", { configurable: false, enumerable: !!d.enumerable, get(this: unknown) { return strip(apply(nameGet, this, [])); } });
        denied.push("Lock.name");
      }
    }
  } catch (e) { fail("locks", e); }

  /* ---------- 5. 后台线程:每个线程第一句装本守卫 ---------- */
  try {
    const URLC = g.URL as { createObjectURL?: (o: unknown) => string; revokeObjectURL?: (u: string) => void } | undefined;
    const BlobC = g.Blob as (new (parts: unknown[], opts?: unknown) => Blob) | undefined;
    const OrigWorker = g.Worker as (new (url: string, opts?: unknown) => object) | undefined;
    const origCreate = URLC ? getOwnPropertyDescriptor(URLC, "createObjectURL")?.value : undefined;
    const origRevoke = URLC ? getOwnPropertyDescriptor(URLC, "revokeObjectURL")?.value : undefined;
    if (typeof OrigWorker === "function" && (OrigWorker as unknown as Record<symbol, unknown>)[MARK] === true) {
      denied.push("Worker"); // 这个全局对象已经装过(再装一遍不重复包)
    } else if (typeof OrigWorker === "function") {
      if (!URLC || typeof origCreate !== "function" || typeof origRevoke !== "function" || typeof BlobC !== "function") {
        // 包不了就不给起线程
        removeGlobal("Worker");
      } else {
        const blobs = O.create(null) as Record<string, Blob | undefined>;
        const keyOf = (url: unknown) => {
          const s = typeof url === "string" ? url : Str(url);
          const i = apply(strIndexOf, s, ["#"]) as number;
          return i >= 0 ? (apply(strSlice, s, [0, i]) as string) : s;
        };
        const blobProto = BlobC.prototype;
        const isBlob = (o: unknown): boolean => {
          for (let p = o !== null && typeof o === "object" ? getPrototypeOf(o) : null; p; p = getPrototypeOf(p)) if (p === blobProto) return true;
          return false;
        };
        replace(URLC, "createObjectURL", function createObjectURL(obj: unknown) {
          const url = apply(origCreate, URLC, [obj]) as string;
          if (isBlob(obj)) blobs[url] = obj as Blob;
          return url;
        }, "URL.createObjectURL");
        replace(URLC, "revokeObjectURL", function revokeObjectURL(url: unknown) {
          const key = keyOf(url);
          if (preludeUrl && key === preludeUrl) return undefined; // 守卫模块的地址不让撤
          delete blobs[key];
          return apply(origRevoke, URLC, [url]);
        }, "URL.revokeObjectURL");
        /*
         * 经典脚本的引导装在顶层的 `this` 上:它就是全局对象,卡片的顶层声明遮不住(`self`、`globalThis` 遮得住)。
         * 模块里顶层 `this` 是 undefined,守卫模块用 `globalThis`:守卫模块排在整个模块图的第一个求值,别的模块的顶层声明只在各自模块里,改不到全局。
         */
        const cfg = stringify({ lockPrefix: prefix, source, strict: true });
        const prelude = ";(" + source + ")(this, " + cfg + ");\n";
        const preludeModuleSource = "(" + source + ")(globalThis, " + cfg + ");\n";
        /*
         * 模块线程不能把守卫源码拼在前面就完事:模块里的静态 import 先于模块本体求值。舞台的 `worker-src blob:` 让模块线程的
         * 静态 import 只能引 blob 地址(外链模块整个图都按 worker 目的地核,`http:` 不在 `worker-src` 里,实测拦下),
         * 卡片自己建的 blob 模块就能抢在守卫之前跑(还能顶层 await 等存储写完)。所以模块线程的第一句是
         * `import "<守卫模块>"`:模块按 import 在源码里的先后深度优先求值,守卫模块排第一,先于原脚本引的一切。
         * 守卫模块的地址本线程(文档)只建一个、不撤销(内容不变;撤销了之后起的模块线程就载不到它),卡片也撤不掉它。
         */
        let preludeUrl = "";
        const preludeModule = () => {
          if (!preludeUrl) preludeUrl = apply(origCreate, URLC, [construct(BlobC, [partsOf(preludeModuleSource, ""), { type: "text/javascript" }])]) as string;
          return preludeUrl;
        };
        /*
         * `new Blob(parts)` 按迭代器读 parts:卡片代码能改 `Array.prototype[Symbol.iterator]` 或数组迭代器的 `next`,
         * 借此把守卫那一段丢掉。这里给 parts 自带一个迭代器,`next`、`value`、`done` 都是自有属性,改原型影响不到。
         */
        const partsOf = (a: unknown, b: unknown) => {
          const list = [a, b];
          defineProperty(list, ITER, {
            value: function () {
              let i = 0;
              const it = {};
              defineProperty(it, "next", {
                value: function () {
                  const r = {};
                  defineProperty(r, "done", { value: i >= 2, enumerable: true });
                  defineProperty(r, "value", { value: i < 2 ? (i === 0 ? a : b) : undefined, enumerable: true });
                  i++;
                  return r;
                },
              });
              return it;
            },
          });
          return list;
        };
        const GuardedWorker = function Worker(this: unknown, url: unknown, options?: unknown) {
          if (new.target === undefined) throw new TypeErr("Failed to construct 'Worker': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
          const blob = blobs[keyOf(url)];
          if (!blob) throw new TypeErr(message("只能从本页用 URL.createObjectURL 建的 blob 地址起后台线程"));
          // 选项只读一遍、抄成新对象(读第二遍可能变);守卫源码作为经典脚本、模块都能跑,类型怎么变都先装守卫
          const o = options !== null && typeof options === "object" ? options as { type?: unknown; name?: unknown; credentials?: unknown } : null;
          const opts: { type?: unknown; name?: unknown; credentials?: unknown } = {};
          if (o) {
            const type = o.type, name = o.name, credentials = o.credentials;
            if (type !== undefined) opts.type = type;
            if (name !== undefined) opts.name = name;
            if (credentials !== undefined) opts.credentials = credentials;
          }
          // 经典脚本:守卫源码直接拼在前面。模块:第一句静态 import 守卫模块(见上),它先于原脚本里所有静态 import 求值
          const head = opts.type === "module" ? "import " + stringify(preludeModule()) + ";\n" : prelude;
          const wrapped = construct(BlobC, [partsOf(head, blob), { type: "text/javascript" }]);
          const wurl = apply(origCreate, URLC, [wrapped]) as string;
          try {
            return construct(OrigWorker, [wurl, opts], new.target === GuardedWorker ? OrigWorker : new.target);
          } finally {
            apply(origRevoke, URLC, [wurl]);
          }
        } as unknown as { prototype: object };
        defineProperty(GuardedWorker, "prototype", { value: OrigWorker.prototype, writable: false });
        defineProperty(GuardedWorker, MARK, { value: true });
        // 实例的 constructor 指回包装过的(不然 `Worker.prototype.constructor` 就拿回了原构造函数)
        defineProperty(OrigWorker.prototype, "constructor", { value: GuardedWorker, writable: false, configurable: false, enumerable: false });
        let hit = false;
        for (let o: object | null = scope; o; o = getPrototypeOf(o)) {
          if (!apply(hasOwn, o, ["Worker"])) continue;
          defineProperty(o, "Worker", { value: GuardedWorker, writable: false, configurable: false, enumerable: false });
          hit = true;
        }
        if (hit) denied.push("Worker");
      }
    }
  } catch (e) {
    // 包不上就不给起线程(不能把错咽下去、留着原生的 Worker:线程里再起的线程就没有守卫了)
    fail("Worker", e);
    removeGlobal("Worker");
  }

  if (config.strict) {
    for (let i = 0; i < errors.length; i++) {
      for (let k = 0; k < CRITICAL.length; k++) {
        if (apply(strIndexOf, errors[i], [CRITICAL[k] + ":"]) === 0) throw new TypeErr(message("关键项没装上(" + errors[i] + ")"));
      }
    }
  }
  return { denied, errors };
}

/** 一个舞台文档的锁名前缀:随机 128 位 */
export function newLockPrefix(): string {
  const bytes = new Uint8Array(16);
  try { crypto.getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return `pc-${hex}:`;
}

/** 在舞台文档上装守卫(源码取自本函数,线程里沿用同一份) */
export function installScopeGuard(scope: object, lockPrefix: string = newLockPrefix()): ScopeGuardResult {
  return guardStageScope(scope, { lockPrefix, source: guardStageScope.toString() });
}
