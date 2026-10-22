# AGENT 报告：claude/stage-guard（舞台源上剩下的跨项目通道）

- 分支：`claude/stage-guard`（从 `gemini/media-cache` 的 `b41d1a42` 开出），worktree `.worktrees/stage-guard`。没有推送、没有合并。
- 任务：在线编辑器的舞台是两个共用的跨源源，哪个项目打开就跑哪个项目的卡片代码。素材地址 `/media-s/<路径号>/media/<哈希>` 里的「路径号」（代码里叫 sid）按账号加项目固定，浏览器把素材缓存一年，谁知道了路径号和哈希就能读到缓存里的素材。上一轮（`4ce9b225`）已把舞台文档的 `localStorage` 等改成只在内存；这一轮堵剩下的：项目 A 的卡片（哪怕没有恶意）把路径号留在舞台源上「活过本文档」或「别的文档同时看得见」的地方，项目 B 的卡片再去读。
- 端口段：6440～6449（跑完核过没有残留监听）。

## 各通道的结论与修法

新模块 `src/online/isolation/scopeGuard.ts` 的 `guardStageScope`（窗口与后台线程共用，是一个自足的函数，线程里用它的源码装），`harden.ts` 新增第 6c 步（装 `installScopeGuard`）与第 6d 步（`isolateWindowState`，只属于窗口的状态）。都排在任何卡片代码之前（`boot.ts` → `bootStageGuard` → `installStageHardening`）。

| # | 通道 | 结论 | 修法 |
|---|---|---|---|
| 1 | 卡片自建的 `Worker`（经典、模块、线程里再起的线程） | 真实存在：线程里 IndexedDB、Cache Storage、OPFS、BroadcastChannel 都在（浏览器对照实测） | `URL.createObjectURL` / `revokeObjectURL` 包一层，记下本文档建的 blob 地址 → Blob；`Worker` 换成包装过的构造函数，只认这些地址，别处的（同源脚本、`data:`、撤销了的 blob、别的文档建的 blob）一律抛错。**经典脚本**：新 blob = 守卫源码与调用 + 原 Blob。**模块**：新 blob = `import "<守卫模块>";\n` + 原 Blob。线程里第一句装同一份守卫，线程里的 `Worker` 也包过（嵌套线程同样）。`Worker.prototype.constructor` 指回包装过的；子类照常；`new Blob(parts)` 用的 parts 自带迭代器（`next`、`value`、`done` 都是自有属性），卡片改 `Array.prototype[Symbol.iterator]` 或数组迭代器的 `next` 丢不掉守卫那一段（真浏览器里核过）。 |
| 1a | 模块线程的静态 import 先于本体求值 | 实测：舞台的 `worker-src blob:` 让模块线程的**静态 import** 按 worker 目的地核，外链（含同源 http）模块整个图被拦（没装加固的对照文档里同样拦）；能抢先跑的只有卡片自建的 **blob 模块**，它还能顶层 `await` 等库写完再让主模块跑（对照实测：守卫之前拿到 IndexedDB 并开了库） | 所以模块线程不是把守卫拼在前面，而是第一句 `import` 一个只含守卫的 blob 模块（每个文档 / 线程建一个，不撤销，卡片也撤不掉）：模块按静态 import 在源码里的先后深度优先求值，守卫模块排第一，先于原脚本引的一切。动态 `import()` 发生在运行期，更在其后。另外纵深防御：IDBFactory、IDBDatabase、CacheStorage、Cache、StorageManager.getDirectory、StorageBucketManager、FileSystem*Handle 原型上的读写方法改成抛错 / 拒绝，万一有代码先拿到了这些对象也开不了库、开不了事务、写不进缓存。**任务书预想的「模块线程的外链静态 import 先于守卫求值」这一条限制已不存在**。 |
| 1b | 运行时自己的线程（`spawnWorker.ts` GL 线程、`soundSpawn.ts` 声音线程） | 在舞台文档里起，同样经包装过的 `Worker`，第一句装守卫 | 两个文件没改：构建产物里都是「blob 引导 + `importScripts(同源地址)`」的经典脚本，守卫拼在前面不影响。声音线程入口自己再调 `denyPersistentStorage(self)`：`denyPersistentStorage` 的 `refuse` 改成「已经锁死的认作已拒绝」，`guardStageScope` 对同一全局对象装第二遍也不重复包 Worker，两边都不报错（单测 OCS-H-13，真浏览器「线程里先有守卫、再调 denyPersistentStorage」核过 `errors: []`）。两个现有探针里 GL 线程（E5 反色）、声音线程（E3 听得到）都正常。 |
| 2 | `window.name` | 真实存在：没装加固时写的值跨 `frame.src = frame.src` 重载留下（实测） | 装加固时先清空真实的 `window.name`，之后本文档里的读写只在内存（真实的一直是空串）。 |
| 3 | `BroadcastChannel`、`SharedWorker` | 舞台运行时不用（`stageGate.ts` 的 BroadcastChannel 只在编辑器页跑：舞台地址带 `?stage=1`，`boot.ts` 的 `editorPage` 为假）；卡片守则不许用全局对象 | 文档与线程里都改成 `undefined`（锁死）；`BroadcastChannel.prototype.postMessage` 也改成抛错（先拿到构造函数的也发不出去）。 |
| 4 | `cookieStore` 写入 | 舞台文档里 `harden.ts` 第 6 节本来就把 `CookieStore.prototype.set/delete` 锁成拒绝（上一轮之前就有）；`document.cookie` 只读 | 守卫里同样处理（线程里只有 Service Worker 才有 cookieStore，有就锁）；遇到第 6 节已锁的认作已锁、不报错。真浏览器：`cookieStore.set`、`delete` 都回「PromptCut 舞台:不能写 cookie」，`document.cookie` 写不进。 |
| 5 | Web Locks 锁名（`navigator.locks`） | 真实存在：`navigator.locks.query()` 列出同源所有文档持有和排队的锁名（对照实测能看到别的文档的锁名） | **按文档加随机前缀**（`pc-<32 位十六进制>:`），不整个拒绝：本文档和它起的线程共用一个前缀（前缀随守卫源码一起送进线程），彼此照常能用锁协调；`query()` 只回本前缀的、去掉前缀；`Lock.name` 去掉前缀；以 `-` 开头的保留名原样交给浏览器报错。别的文档看不见、占不住、也抢不到本文档的锁。选它而不是拒绝：最少打扰（用锁协调的卡和库照常工作），又把跨文档那一面整个切断。 |
| 6a | 会话历史：`history.state`、`location.hash`、Navigation API | `frame.src = frame.src` 之后 `history.state`、`location.hash` 不留（实测）。**但 Navigation API 是真实通道**：新文档的 `navigation.activation.from` 能读到同一 iframe 上一个文档的地址（含卡片改的 `#…`）和它用 `navigation.updateCurrentEntry` 存的状态，`navigation.entries()` 列出之前条目的地址（对照实测读到 `{"sid":"ctl-nav"}`）；`history.back()` 也能退回上一个文档的条目 | 窗口里：`navigation` 整个改成 `undefined`；`history.pushState` / `replaceState` 的状态只在本文档内存、不改地址（真实条目里一律是 null），`history.back` / `forward` / `go` 不动；文档载入时地址带 `#…`（只可能是退回到卡片自己加的条目，编辑页给的舞台地址没有）先去掉。 |
| 6b | 别的文档写真实 `localStorage` 的 `storage` 事件 | 舞台源上写真实存储的只有取档结论（键里只有内容哈希），没有路径号；仍是同源别的文档在写什么的实时信号 | 窗口上最先在捕获阶段截住、不往下传（`onstorage` 和卡片加的监听都收不到，实测）。 |
| 6c | `navigator.storage.persist()` / `persisted()` | 一个跨文档、跨会话可读的标志 | `persist()` 回 false（照浏览器拒绝时的样子）。`estimate()` 照旧（能写的存储都收走了，它不再反映卡片写的东西）。 |
| 6d | Service Worker 注册 | 内容安全策略 `worker-src blob:` 本来就拦（Service Worker 不能是 blob 地址） | 纵深防御：`ServiceWorkerContainer.prototype.register` 拒绝。 |
| 6e | `sharedStorage` | Chrome 152 里还有（对照文档 `typeof sharedStorage === "object"`）；写入跨会话保留，读取只能在 worklet 里经输出门（选地址、聚合报告），带宽很低 | 收走全局入口。 |
| 6f | `document.domain` | 舞台带 `Origin-Agent-Cluster: ?1`，setter 不起作用；两个舞台本就同源同站，无意义 | 不处理。 |
| 6g | `history.length` | 只是一个数字（同一 iframe 前后文档能数条目）；`pushState` 已不加条目，要靠刻意改 `location.hash` 去编码 | 记作残余（刻意编码，超出本次范围）。 |
| 6h | HTTP 缓存计时、取档结论键（`pc.playable.<n>:<哈希>`，值 0/1）按位编码 | 都要 A 刻意编码、B 事先知道要读哪些键 / 地址 | 不处理（刻意作恶的 A 不在威胁模型内：它本来就能把自己的素材直接发到外网）。 |
| 6i | `navigator.credentials.store`、通知、推送、文件选择器 | 舞台 iframe 的 `sandbox` 只开 `allow-scripts allow-same-origin`；这些要用户手势或权限 | 不处理。 |

没有改 `stageIsolation.ts` 的单向规矩、`execGate.ts`、上报（`breach`）路径；`HardenReport` 只加了一个可选的诊断字段 `scopeGuarded`。

### 为什么没改 `src/editor/Preview.tsx`

任务书允许把原地换项目时的 `frame.src = frame.src` 换成「重建 iframe 元素」（新的浏览上下文，`window.name`、会话历史、Navigation API 状态一并清空）。它覆盖面更大，但这次没改，因为：

1. 卡片代码能读到的那几条（`window.name`、`navigation.activation` / `entries()`、`history.back()`、`history.state`）已在舞台文档一侧全部关掉，并在真浏览器里核过；
2. Preview 里三个舞台 iframe（`single`、`dualA` 预热 / 正式、`dualB`）的 key、ref、预热与盖板衔接交织在一起，改 key 触发重挂有回归风险，而原地换项目的整条路径（托管组合、两个项目、同一页面里换）目前没有端到端探针能核；
3. 剩下只有一条要用户手动操作才走得通的路（见「残余风险」1）。

建议后续在补「原地换项目」端到端探针时一起改成重建 iframe。

## 残余风险（如实写明）

1. **用户按浏览器「后退」+ 卡片自己改了地址**：A 的卡片用 `location.hash = …`（拦不住，`Location` 不可改）或 `location.search = …` 把路径号写进地址，会在 iframe 的会话历史里留下条目；换到 B 之后若用户在编辑页按浏览器「后退」，这个 iframe 可能退回 A 的那个条目，新文档里 B 的卡片读 `location.search` 就能看到（`#…` 那一段会在装加固时去掉）。要 A 刻意把参数写进地址、再加用户的操作；重建 iframe 能彻底关掉（见上节）。
2. **经典脚本线程开头的 `"use strict"`**：守卫拼在前面后，原脚本开头的 `"use strict"` 不再是指令，原脚本按非严格模式跑（函数里自己写的照旧）。舞台里没法同步读出原脚本的文字来判断，`importScripts(blob:)` 又被 `script-src` 拦，所以只能这样。卡片本来就不许起线程（新加的守则第 6 节第 6 条）。
3. 第 6g、6h 两条要 A 刻意编码，按威胁模型不处理。

## 提交

- `5411595a` 报告：开 AGENT 报告。
- `db7c9551` 舞台源跨文档通道守卫：`scopeGuard.ts`（新）、`harden.ts`（6c、6d、`isolateWindowState`、`refuse` 认已锁、`scopeGuarded` 诊断字段）、`scopeGuard.browser-check.mjs`（真浏览器核对脚本，不进 `npm test`）。
- `9fbde8c8` 单测 `scopeGuard.test.mjs`（OCS-H-11～16）；同一全局对象再装一遍不重复包 Worker。
- `92f35102` `server/card-authoring-guide.md` 第 6 节加第 6 条：不起后台线程、不用跨页通道和浏览器存储、不存参数。
- 本报告的最后一次提交。

## 验证

### 类型检查

- `npx tsc -b --force`：退出码 0，无输出（实现后、全量测试后各跑一次）。

### 单元测试

- `node scripts/test-suite.mjs src/online/isolation/scopeGuard.test.mjs src/online/isolation/isolation.test.mjs`：`ℹ tests 16` / `ℹ pass 16` / `ℹ fail 0`。
- 定向（引用到改动文件的测试，加声音线程、卡片运行时）：`node scripts/test-suite.mjs src/online/isolation/scopeGuard.test.mjs src/online/isolation/isolation.test.mjs src/online/stageIsolation.test.mjs src/online/cardRuntime/onlineCardsG.test.mjs server/test/card-authoring-guide.test.mjs src/online/cardRuntime/soundThread.test.mjs src/online/cardRuntime/cardRuntime.test.mjs src/online/stagePolicy.test.mjs src/online/modeImportGuard.test.mjs` → `ℹ tests 89` / `ℹ pass 89` / `ℹ fail 0`。
- 新用例：OCS-H-11 守卫自足（源码在只带标准内置对象的 `vm` 环境里照样装得上）；OCS-H-12 线程包装（经典 / 模块的拼法、嵌套、认不出的地址、撤销、`#`、constructor、子类、改迭代器）；OCS-H-13 存储与通道（先拿到的对象也用不了、cookieStore、persist、装两遍、再调 `denyPersistentStorage`、第 6 节已锁）；OCS-H-14 锁名前缀；OCS-H-15 `window.name`、会话历史、`navigation`、storage 事件、`#` 去掉；OCS-H-16 加固接线顺序。
- **变异核对（去掉守卫会红）**：脚本逐条改坏、跑、还原（脚本在会话临时目录，不入库），15 条全红：

  ```
  RED  M1 守卫引用函数体外的名字  -> OCS-H-11, OCS-H-12
  RED  M2 不包 Worker  -> OCS-H-12, OCS-H-13
  RED  M3 parts 不带自己的迭代器  -> OCS-H-12
  RED  M4 不废 IDBFactory 原型方法  -> OCS-H-11, OCS-H-13
  RED  M5 不收 BroadcastChannel  -> OCS-H-11, OCS-H-12, OCS-H-13
  RED  M6 锁名不加前缀  -> OCS-H-14
  RED  M7 window.name 不隔离  -> OCS-H-15
  RED  M8 history 状态写真实条目  -> OCS-H-15
  RED  M9 加固不装通道守卫  -> OCS-H-16
  RED  M10 不收 navigation  -> OCS-H-15
  RED  M11 不截 storage 事件  -> OCS-H-15
  RED  M12 模块线程把守卫拼在前面(不先 import)  -> OCS-H-12
  RED  M13 不拒 cookieStore 写入  -> OCS-H-11, OCS-H-13
  RED  M14 denyPersistentStorage 不认已锁  -> OCS-H-13
  RED  M15 守卫模块地址能被撤  -> OCS-H-12
  mutation check: all caught
  ```

### 真实浏览器核对（无头 Chrome 152，仓库的 puppeteer）

`node src/online/isolation/scopeGuard.browser-check.mjs --port 6440`：编辑页 `127.0.0.1:6440`，舞台源 `localhost:6441`（在线舞台同一份 `stageCspHeader` 与 `Origin-Agent-Cluster: ?1`，iframe 带 `sandbox="allow-scripts allow-same-origin"`）；`harden.ts` 用 rolldown 打成**压缩过的** iife 送进舞台（核守卫源码经压缩后仍自足）。舞台 A、C 装加固，D 是同源没装加固的对照。

- 压缩版：`scopeGuard browser check (minified): 49 passed, 0 failed`，退出码 0；不压缩（`--no-minify`）：`49 passed, 0 failed`。
- 摘要（全部 PASS）：
  - 加固装上没有错误；装上时清掉了真实的 `window.name`（对照：没装加固时写的值跨 `frame.src = frame.src` 留下来了）。
  - 文档里 `BroadcastChannel`、`SharedWorker` 没有（对照都在）；`Worker.prototype.constructor` 指回包装过的。
  - `cookieStore.set`、`delete` 回「PromptCut 舞台:不能写 cookie」，`document.cookie` 写不进（对照走的是浏览器自己的实现）。
  - `navigator.storage.persist()` 回 false，`estimate()` 照旧。
  - 卡片起的经典线程、线程里再起的线程：`indexedDB`、`caches` 是 `undefined`，OPFS 拒绝，`BroadcastChannel`、`SharedWorker` 没有，`IDBFactory.prototype.open` 不是原生的，锁照常（对照：IndexedDB、Cache、OPFS、BroadcastChannel 都在）。
  - 模块线程静态 import 同源 http 模块：被 `worker-src blob:` 拦（对照文档里同样）；动态 `import()` 的外链模块在守卫之后求值，拿到的 `indexedDB` 是 `undefined`。
  - 卡片起的模块线程、它静态 import 的卡片自建 blob 模块（先拿存储入口、顶层 `await` 等库开好）：拿到的入口都是空的、开不了库；模块线程里再起的模块线程同样（对照：同样的 blob 模块在守卫之前拿到 IndexedDB 并开了库）。
  - 同源脚本、`data:`、撤销了的 blob 起不了线程，不带 `new` 调用报错；经 `Worker.prototype.constructor`、`Worker` 子类、改 `Array.prototype[Symbol.iterator]`、改数组迭代器 `next` 起的线程都装了守卫。
  - 运行时那种「blob 引导 + `importScripts` 同源脚本」的线程照常跑、里面也装了守卫；线程里先有守卫、再调 `denyPersistentStorage`：`errors: []`。
  - 锁：A 的 `query()` 看到自己的锁（去掉前缀），同名再要拿不到，A 起的线程同样拿不到（共用前缀）；C（装了加固）看不见 A 的锁、同名的锁照拿；D（没装加固）看到的真实锁名是 `pc-<32 位>:sid-lock-0123`。
  - storage 事件：A 写真实 `localStorage`，C 收不到（`addEventListener` 和 `onstorage` 都没有），D 收得到。
  - 装了加固的 A：`window.name`、`history.state` 本文档照常读写，`pushState` 不改地址，`navigation` 没有，`back`/`go` 不动；`frame.src = frame.src` 重载后 `window.name` 空、`history.state` 为 null、`location.hash` 空；对照 D 重载后新文档经 `navigation.activation.from` 读到上一个文档的 `#ctl` 和 `{"sid":"ctl-nav"}`，`navigation.entries()` 列出之前三个条目的地址。
  - 地址带 `#leak-sid-E` 载入的文档：装加固时去掉。
  - 舞台里没有意外的控制台错误。

### 现有探针（`npx vite build --mode online` 之后，退出码 0）

- `node scripts/probes/online-card-exec-probe.mjs --dist dist-online --base-port 6440 --doc-port 6445 --asset-port 6446`
  - 第一次：`{"ok":false,"pass":60,"fail":1}`，不过的是「E3 测量期间扬声器无输出」，`during` 里有一次 `createObjectURL`（`audio/wav`）。这个记录是探针挂在**编辑页顶层文档**上的钩子（`window.__pcAudioLog`，探针第 327～344 行）记的，编辑页不装舞台加固、本分支没碰，属于计时上的偶发。
  - 第二次（同一构建，单独再跑）：`{"ok":true,"pass":61,"fail":0}`，E3 那条 `{"during":[],"playingDuring":0}`。GL 线程（E5 反色像素对）、声音线程（E3 听得到、生成并入库）、卡片执行都正常。
- `node scripts/probes/online-card-security-probe.mjs --dist dist-online --base-port 6440 --doc-port 6443 --asset-port 6444`：退出码 0，`{"ok":true,"pass":113,"fail":0,"gaps":[]}`。
- 跑完 6440～6449 上没有监听。

### 全量测试

- `npm test`（单独一条命令，设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`、`PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`）：退出码 1，`ℹ tests 7694` / `ℹ pass 7667` / `ℹ fail 12` / `ℹ cancelled 0` / `ℹ skipped 15`，用时约 354 秒（比上一轮的 195 秒慢得多，同机另有 Agent 在跑探针）。比上一轮多 6 条，正好是新增的 OCS-H-11～16。
- 12 条失败都在服务端（云端 Agent、多成员在场、迁移、Codex 凭证），多数是 30 秒超时，分在 6 个文件；与舞台无关。逐个单独重跑（`npm test -- <文件>`，同样两个环境变量）全过：
  - `server/test/cloud-agent-runs.test.mjs`：30 / 30 / 0
  - `server/test/cloud-agent-service.test.mjs`：18 / 18 / 0
  - `server/test/codex-auth-state.test.mjs`：27 / 27 / 0
  - `server/test/multi-agent-presence.test.mjs`：6 / 6 / 0
  - `server/test/reopen-relocation-transfer.test.mjs`：3 / 3 / 0
  - `server/test/user-editing.test.mjs`：11 / 11 / 0
- 测试在 worktree 里留下的 `node_modules/`（只有 `.vite`、`.vite-temp`）和 `data/`（只有 `auth`）：核过没有 junction 或其它重解析点后删掉；主仓库的 `node_modules` 完好。

## 对语义的更正建议（本次没有改 `docs/semantics/`，交主会话定）

**`product/platforms.md`「卡片在隔离环境里用的浏览器存储不跨会话、不跨项目留存」**（二级）：

- 修改前：「卡片代码在舞台里用到的本地存储只在这一次打开期间有效，关掉、刷新或换项目就没了；数据库、缓存存储、文件系统一类的持久存储不给用。卡片作者守则本来就不许卡片用本地存储……守规矩的卡看不出区别。」
- 修改后（建议）：「卡片代码在舞台里用到的本地存储、窗口名、浏览历史状态只在这一次打开期间有效，关掉、刷新或换项目就没了；数据库、缓存存储、文件系统一类的持久存储不给用，卡片自己起的后台线程里同样；同一浏览器里别的页面之间的实时通道（广播频道、共享线程）不给用，锁只在这一次打开（及它起的线程）里互相看得见。卡片作者守则本来就不许卡片用全局对象、本地存储、后台线程和跨页通道（`server/card-authoring-guide.md` 第 2.4 节与第 6 节），守规矩的卡看不出区别。」

**`mechanism/platforms.md`「舞台源上的存储」**（三级），把最后一句

- 修改前：「卡片自己开的 Worker、`window.name`、`BroadcastChannel` 这几条要卡片代码刻意去写才走得通，这三个版本不设出口护栏、恶意卡本来就能把本项目的素材直接发出去，所以不另拦，记作残余风险。」
- 修改后（建议）：「舞台源跨文档通道守卫（`src/online/isolation/scopeGuard.ts`，舞台加固第 6c、6d 步）另管：卡片在舞台里起的每个后台线程（含线程里再起的）第一句都装同一份守卫——`Worker` 只认本文档用 `URL.createObjectURL` 建的 blob 地址，经典脚本把守卫拼在前面，模块第一句静态 import 一个只含守卫的 blob 模块（`worker-src blob:` 让模块的静态 import 只能是 blob，守卫模块排第一）；线程里同样收走持久存储，IndexedDB、Cache Storage、源私有文件系统接口原型上的读写方法也一并失效；`BroadcastChannel`、`SharedWorker`、`sharedStorage`、Navigation API 不给用；`cookieStore` 写入与 Service Worker 注册拒绝；`navigator.storage.persist()` 回 false；Web Locks 的锁名按文档加随机前缀（本文档与它起的线程共用）；`window.name`、`history.state` 只在本文档内存（装加固时清空真实的 `window.name`，`pushState` / `replaceState` 不改地址，`history.back` / `forward` / `go` 不动）；别的文档写真实存储的 `storage` 事件截住。残余：卡片刻意改 `location.search` 后用户在编辑页按浏览器后退，旧条目可能被退回到；经典脚本线程开头的 `"use strict"` 不再生效。」

**对任务书的更正**：任务书预想模块线程「静态 import 的外链模块先于守卫求值」是要写进文档的限制。实测舞台的 `worker-src blob:` 本来就拦下模块线程里的外链静态 import（模块线程的整个静态 import 图按 worker 目的地核），真正能抢先的是卡片自建的 blob 模块，而且它能顶层 `await` 等存储写完；本分支用「第一句 import 守卫模块」把它关掉了，这条限制不再存在。

## 没做的及原因

- 没改 `src/editor/Preview.tsx`（见上「为什么没改」）。
- 没改 `src/render/gl/spawnWorker.ts`、`src/online/cardRuntime/soundSpawn.ts`、`soundWorker.ts`：运行时线程经包装过的 `Worker` 自动带上守卫，两个探针里 GL 与声音线程都正常；双装不报错靠 `harden.ts` 的 `refuse` 与守卫自身的幂等。
- 没有把真浏览器核对放进 `scripts/probes/`（另一个 Agent 在那里写探针）；它在 `src/online/isolation/scopeGuard.browser-check.mjs`，文件名不是 `*.test.mjs`，不进 `npm test`。它只读引用 `scripts/probes/probe-chrome.mjs` 的启动参数与 `src/online/stagePolicy.mjs` 的舞台策略。
- 原地换项目的端到端核对（真实托管组合、两个项目、同一页面里换）仍没有，与上一轮相同。
