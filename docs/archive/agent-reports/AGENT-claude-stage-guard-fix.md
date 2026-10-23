# AGENT 报告：claude/stage-guard-fix

分支 `claude/stage-guard-fix`，从 main `62be41cb` 切出，worktree `.worktrees/stage-guard-fix`。没有推送、没有合并。
任务：处理 2026-10-23 对 `claude/stage-guard`（含 `gemini/media-cache`）安全审查查出的四件事。审查编号的意思：P1 经典脚本线程能绕过守卫、P2 旧项目票据可能交给新项目路径号、P3 加固没装全时卡片照样执行、I1 `Vary: Authorization` 等几处说法不准。
端口段 6460～6469：实际用了 6461、6462（真浏览器核对）、6464、6465（审查的绕过探针）、6466～6468（素材缓存探针，临时副本）。跑之前看到 6463 上有一个不是我起的监听（PID 2420），没碰它，也没用这个端口。

## 提交

| 提交 | 内容 |
|---|---|
| `753b30ec` | 建本报告 |
| `05b7c0f2` | P1 |
| `e6c9006c` | P3 |
| `f82bf53f` | P2 |
| `afe7e8e5` | I1（语义、两份旧 AGENT 报告的更正、`verification.md` 登记） |
| 本次 | 报告写完 |

## 改了哪些文件（主会话解冲突用）

- `src/online/isolation/scopeGuard.ts`（P1，P3 的关键项清单）
- `src/online/isolation/scopeGuard.test.mjs`（P1：新增 OCS-H-17、OCS-H-18；仿全局对象的接口对象改成不可枚举，和浏览器一致；OCS-H-12 的 vm 环境改成「全局对象就是仿全局对象」）
- `src/online/isolation/scopeGuard.browser-check.mjs`（P1：新增 9 条真浏览器用例）
- `src/online/isolation/isolationCheck.ts`（P3：新增 `criticalHardenErrors`）
- `src/online/isolation/isolation.test.mjs`（P3）
- `src/editor/Preview.tsx`（P2：`pushMediaPolicy` 里加 4 行，集中在取票据那一处，别的没动）
- `src/online/stageIsolation.test.mjs`（P2：源码先后核对）
- `docs/semantics/mechanism/asset-service.md`、`docs/semantics/mechanism/platforms.md`、`docs/semantics/product/platforms.md`、`docs/semantics/guide_files/verification.md`（I1）
- `docs/reports/AGENT-claude-stage-guard.md`、`docs/reports/AGENT-gemini-media-cache.md`（I1 的更正）
- `docs/reports/AGENT-claude-stage-guard-fix.md`（本报告）

没改 `harden.ts`：舞台文档里守卫核对不过时不抛错，只记一条 `integrity:` 错误，由 P3 的自检判不执行，所以加固本身不用动。

## P1　经典脚本线程绕过守卫（已修）

原因（审查已实测）：经典脚本的顶层 `function` 声明在整段脚本开跑之前就绑到全局上，比拼在前面的守卫还早。守卫从 `self` 取全局，又从全局名字取 `Object`、`Reflect`、`JSON` 等，所以 `function self(){}` 让守卫装到假对象上，`function JSON(){}` 让包 Worker 那段报错被 `catch` 咽下，线程里再起的线程是原生的。

修法（`scopeGuard.ts`）：

1. 经典脚本的引导改成 `;(守卫源码)(this, 配置)`：顶层的 `this` 就是全局对象，不能被顶层声明遮住。模块线程的守卫模块用 `globalThis`（模块里顶层 `this` 是 undefined；守卫模块排在整个模块图的第一个求值，别的模块的顶层声明改不到全局）。
2. 内置对象能从字面量取的一律从字面量取：`({}).constructor`、`[].constructor`、`"".constructor`、从一次必定抛的 `defineProperty(1, …)` 取 `TypeError`、`(async () => {})().constructor` 取 `Promise`、从数组原型上的符号取 `Symbol`；不再用 `Map`，改用无原型对象。没有字面量的 `Reflect`、`JSON` 核 `typeof === "object"`（函数声明只能造出函数）。
3. 要读的平台接口逐个核：顶层函数声明换过的全局属性是「可枚举、不可配置」（规范 CreateGlobalFunctionBinding）；浏览器原装的接口对象一律不可枚举，所以接口对象（`URL`、`Blob`、`Worker`、`LockManager` 等 18 个）只要可枚举就算被换过，`indexedDB` 这类属性按「可枚举且不可配置」认。
4. 配置里加 `strict`（线程引导里写死为真）：核对不过直接抛错，整段线程脚本不执行；装完之后关键项（`integrity`、`indexedDB`、`caches`、`BroadcastChannel`、`SharedWorker`、`Worker`、`locks`）有错误也抛错。舞台文档里不设 `strict`，核对不过只记一条 `integrity:…` 并什么都不装，由 P3 判不执行。
5. 包 `Worker` 那段失败时 `removeGlobal("Worker")`，不再只记一条错误。
6. 顶层 `let`/`const` 同名的（如 `const JSON = {}`）：守卫一读就是暂时死区的 ReferenceError，整段同样不执行。

验证：

- 单测 `node --test src/online/isolation/scopeGuard.test.mjs`：`ℹ pass 8`、`ℹ fail 0`。新增的 OCS-H-17 在「全局对象就是仿全局对象」的 vm 里跑「引导 + 卡片脚本」：遮住 `self` 守卫照样装上；遮住 `JSON`、`Reflect` 整段不执行（`PromptCut 舞台:integrity:…(JSON)`）；`let Reflect`、`const JSON` 是 ReferenceError；遮住 `Object`/`String`/`Symbol`/`Promise`/`TypeError`/`Array`/`Map` 守卫不受影响；线程里再起的线程同样。OCS-H-18 核包 Worker 失败时 Worker 被收走、`strict` 下抛「关键项没装上(Worker:…)」、舞台文档里核对不过记 `integrity:`。
  - 注意：Node 的 vm 对已有的全局属性不按规范改属性特征（实测函数声明之后仍是可配置、原来不可枚举的仍不可枚举），所以接口对象被换这一类在单测里是按规范显式模拟的；真实行为由下面的真浏览器核对用真的顶层声明核。
- 真浏览器 `PROMPTCUT_NO_PORT_FILE=1 node src/online/isolation/scopeGuard.browser-check.mjs --port 6461`：退出码 0，`scopeGuard browser check (minified): 57 passed, 0 failed`（原来 49 条，新增 9 条全过，原有的也全过，含「加固装上没有错误」）；`--no-minify` 同样 `57 passed, 0 failed`。新增几条的原文：
  ```
  PASS  P1 经典线程顶层 function self(){}:…  [{"idb":"undefined","bc":"undefined","caches":"undefined","open":"threw"}]
  PASS  P1 经典线程顶层 function JSON(){}:核对不过,整段脚本不执行  [{"error":"Uncaught TypeError: PromptCut 舞台:integrity:内置对象或平台接口在守卫之前被改过(JSON)"}]
  PASS  P1 经典线程顶层声明遮住 Reflect、Blob、URL、Worker、LockManager、BroadcastChannel:都整段不执行
  PASS  P1 经典线程顶层 const JSON:…  [{"error":"Uncaught ReferenceError: Cannot access 'JSON' before initialization"}]
  PASS  P1 嵌套:外层 function JSON(){} 再起线程 —— 外层整段不执行
  PASS  P1 嵌套:线程里再起的线程顶层 function self(){} 同样收住  [{"nested":{"idb":"undefined",…,"open":"threw"},"idbOuter":"undefined"}]
  PASS  P1 嵌套:线程里再起的线程顶层 function JSON(){} 同样整段不执行
  PASS  对照(没装加固):同样的 function JSON(){} 线程能开 IndexedDB  [{"idb":"object","bc":"function","caches":"object","open":"opened"}]
  ```
- 审查的绕过探针（复制到 scratchpad，改成指向本 worktree、端口 6464/6465）：退出码 0。原来 `shadowSelf` 是 `{"idb":"object",…,"open":"opened"}`，现在 `{"idb":"undefined","bc":"undefined","caches":"undefined","open":"throw:…"}`；原来 `shadowJSON_nested` 的里层能开库，现在整段不执行：`"error:Uncaught TypeError: PromptCut 舞台:integrity:内置对象或平台接口在守卫之前被改过(JSON)"`；`hardenErrors: []`；AudioWorklet 那一项不变（全是 undefined）。

## P3　加固没装全照样执行（已修）

`isolationCheck.ts` 新增 `criticalHardenErrors(errors)`：加固报告里以 `storage:localStorage:`、`storage:sessionStorage:`、`storage:indexedDB:`、`storage:caches:` 开头的，以及 `scope:<关键项>:`（关键项与 P1 守卫里的同一份 `SCOPE_GUARD_CRITICAL`：`integrity`、`indexedDB`、`caches`、`BroadcastChannel`、`SharedWorker`、`Worker`、`locks`）开头的，算关键项错误。`judgeIsolation` 的 `hardened` 改成「装了，而且没有关键项错误」，否则原因是 `not-hardened`，走原有的「这个舞台不执行用户卡」那条退回路。

比任务书多加了一项 `locks`（锁名前缀没装上，别的文档就看得见本文档的锁名，也是跨文档通道）。纵深防御那几层（原型方法改抛错，如 `scope:IDBFactory.open:`）、旧式文件系统入口、`window:` 那几项没装上不挡执行。

验证：`node --test src/online/isolation/isolation.test.mjs`：`ℹ pass 10`、`ℹ fail 0`。OCS-H-03 里补了 10 种关键项错误各判 `not-hardened`，7 种非关键或名字只是前缀相近的（`storage:localStorageX:`、`scope:WorkerX:`）仍通过。真浏览器里 Chrome 的加固 `errors` 是空的（上面「加固装上没有错误」PASS），所以 Chrome 上不会因此误判。

## P2　旧项目的票据交给新项目的路径号（已修，改动 4 行）

`Preview.tsx` 的 `pushMediaPolicy`：取票据前记下 `JSON.stringify([remoteAssetBase(), stageSidScope()])`（素材连接的地址加作用域：账号、素材连接的项目号、打开的项目号），`await remoteAssetTicket()` 之后再读一次，不一致就 `return`，这一次推送作废。换素材连接有 `subscribeRemoteAssets` 的通知、换作用域有隔离会话的通知，都会再推一次，所以不会停在没有策略的状态。和分支里「换项目空档不执行用户卡」同一思路。周围代码没动。

验证：在 `stageIsolation.test.mjs` 现有的「接线（源码核对）」那条用例里补了先后核对：`scopeBefore` 在 `await remoteAssetTicket()` 之前、`if (scopeKey() !== scopeBefore) return;` 在它之后、在 `iso.setScope(stageSidScope())` 之前。变异核对：把那一行删掉，这个文件 `ℹ pass 15`、`ℹ fail 1`；还原后 `ℹ pass 16`、`ℹ fail 0`。
没有端到端复现：要真实的托管组合在同一页里换项目，和审查一样没做。

## I1　说法更正（没改代码）

- **缓存头**：`Vary: Authorization` 那句不在 `mechanism/platforms.md`，在 `mechanism/asset-service.md` 的「缓存头」条，改在了那里（任务书写的是 platforms.md，这里更正）。补的话：带这个头是为了上游的正确性；舞台那条路上浏览器的请求不带 `Authorization`，缓存键实际只有地址，这个头分不开账号；跨账号、跨项目不互通靠路径号只有本账号本项目知道加 `private`；不能改成 `Vary: Cookie`。标〔裁〕，三级。
- **`mechanism/platforms.md`「舞台源上的存储」**：「每个后台线程第一句都装同一份守卫」后面补上经典脚本的实际做法（装在顶层 `this` 上、字面量取内置对象、核对不过或关键项没装上整段不执行、包 Worker 失败收走 Worker），并补一句 P3（关键项没装上，自检判「加固没装上」，这个舞台不执行用户卡）。两处各标〔裁〕，三级。原文没有「绕不过去」四个字，那是 AGENT 报告里的说法。
- **两份旧 AGENT 报告**：在原句后面加「〔2026-10-23 审查后更正：…〕」，原文保留。
  1. `AGENT-claude-stage-guard.md` 表 1 那一行：「线程里第一句装同一份守卫」对经典脚本不成立，写明怎么绕、已在本分支修；表 1a 那一行注明模块线程那条成立。
  2. `AGENT-gemini-media-cache.md` 审查节「问题 2」：「`Vary` 是第二道」在 cookie 这条路上不成立，写明原因和真正靠什么。
  3. `AGENT-gemini-media-cache.md` 发现表第 2 行「已修，`843d05a3`」改成「已改」，注明证据只有单测和源码先后核对、没有端到端探针，`plan.reload` 之后真的整页重载没有测试管着，并提到 P2 已在本分支修。`AGENT-claude-stage-guard.md` 自己在「没做的」里已经写了缺端到端，正文没有写成「已修」，所以那一份没在这一点上改。
- **`verification.md`「按改动范围验证」**：补一条：改到舞台加固要跑 `scopeGuard.browser-check.mjs`，改到素材长期缓存头要跑 `media-cache-probe.mjs`，两支不进 `npm test`。没有把它们塞进 `npm test`。

## 〔裁〕清单

### 二级（用户看得到区别，请主会话打印给用户）

- **〔裁：stage-guard-fix 2026-10-23，二级〕`docs/semantics/product/platforms.md`「舞台一律跨源隔离」那一条后面加一句。**
  - 修改前：「若托管端的反向代理没有配好隔离环境，则自动不执行用户卡与素材效果卡，表现同「退回」。」
  - 修改后：在上句后接「某个浏览器上舞台的隔离限制（存储、跨页通道、后台线程）装不全时同样不执行，表现同「退回」；卡片自己起的后台线程如果在脚本顶层改掉了浏览器内置对象或接口的名字（卡片作者守则本来不许用后台线程），这个线程整个不执行。」
  - 用户看得到的变化：（P3）某个浏览器上加固装不全，以前卡片照常执行、拿到真实存储，现在这个舞台不执行用户卡，卡片退回预渲染结果或渲染节点；（P1）后台线程脚本顶层写了 `function JSON(){}`、`function Blob(){}` 这类声明的卡片，以前能跑，现在这个线程不跑。守规矩的卡（守则第 2.4 节、第 6 节本来就不许用后台线程和全局对象）看不出区别。Chrome 上实测加固没有错误，P3 不会在 Chrome 上触发。
  - 解法表：三级扫过。线程那边想过「把卡片脚本包进函数里，让顶层声明不再是全局声明」（用户看不出区别），但这样会改掉守规矩的线程脚本的语义（比如 `function onmessage(e){}` 不再挂到全局上），不成立；读出脚本原文再另起一段执行要靠 `eval` 或 `importScripts(blob:)`，舞台的内容安全策略都不许。剩下的只有「核对不过就不执行」，用户看得到区别，所以按二级办。P3 没有不改行为的修法（问题就是本该不执行时执行了）。

### 三级

- `mechanism/asset-service.md`「缓存头」：`Vary: Authorization` 的作用与跨账号隔离靠什么（I1）。
- `mechanism/platforms.md`「舞台源上的存储」：经典脚本守卫的做法（P1）；关键项没装上自检判没加固（P3）。

## 跑过的命令与结果

测试命令都在 worktree 里跑，同一条命令里设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`（反斜杠路径）和 `PROMPTCUT_NO_PORT_FILE=1`。没跑全量 `npm test`。

- `npm test --` 25 个文件：scopeGuard、isolation、stageIsolation、stagePolicy、stageGate、stageHandshake、mediaGate、modeImportGuard、projectAddress、asset-media-cache-headers、stage-policy-nginx、asset-project-http、layering、c10a-single-stage、measureGate、onlineCardsL、stageSwapBaseline、stageSwap、stageBridge、stageCards、exportModes、probe-timings、windows-hide-silent-spawn、bake-store、bakery-media（后面几个会读到改过的语义文件）。结果 `ℹ tests 217`、`ℹ pass 217`、`ℹ fail 0`、`✓ npm test 最终结果：零失败`，退出码 0。
  - 这之前的一轮（17 个文件）有一个文件级失败：`stageIsolation.test.mjs` 里我新加的变量名和同一用例里已有的 `before` 重名（SyntaxError）。单跑复核确认是这个原因，改名后单跑 `ℹ pass 16`、`ℹ fail 0`，再进上面那一轮全过。不是偶发失败。
- `npm test --` 审查列过的另外 5 个文件（asset-service、card-authoring-guide、cardRuntime、soundThread、onlineCardsG）：`ℹ tests 57`、`ℹ pass 57`、`ℹ fail 0`。
- `npx tsc -p tsconfig.json --noEmit`：没有输出，零错误。
- `node src/online/isolation/scopeGuard.browser-check.mjs --port 6461`：退出码 0，`57 passed, 0 failed`（压缩、不压缩各一次）。
- 审查的绕过探针（scratchpad 副本，端口 6464/6465）：退出码 0，输出见 P1。
- `media-cache-probe.mjs`：脚本里端口写死在 6420～6422（别人在用的段），所以在 `scripts/probes/` 下临时复制了一份、只把三个端口改成 6466～6468，跑完就删了，没有提交。退出码 0，28 项 PASS，末行 `media-cache-probe: PASS`，另有 `INFO session2 stage transferSize=0 (hasPerfEntry=true)`。

## 没做的与原因

- P2 的竞态没有端到端复现，要真实的托管组合在同一页里换项目（和审查、两份旧报告一样缺）。
- 只测了 Chrome。Firefox、Safari 上函数声明之后的属性特征是不是照规范（P1 的接口对象核对靠这个），以及那些浏览器上加固有没有关键项错误（P3 会不会让那里不执行用户卡），没有核。
- `scripts/probes/online-card-security-probe.mjs`（加固在真浏览器里的另一支探针）没跑：要起整套服务，不在本任务指定的验证里。主会话合入前可以视情况跑。

## 对任务书或语义的更正建议

- 任务书说 `Vary: Authorization` 的说法在 `mechanism/platforms.md` 缓存头那一条；实际在 `mechanism/asset-service.md`「缓存头」，已改在那里。
- `media-cache-probe.mjs` 的端口写死在 6420～6422，和派活时分端口段的做法冲突，以后谁跑都得临时改一份。建议给它加一个 `--port` 参数（本分支没改，不在清单里）。
- 关键项清单比任务书多了 `locks`，理由见 P3。

## 能不能合

我的判断：能合。改动只在舞台加固、自检和 `Preview.tsx` 一处，受影响的测试、类型检查、两支真浏览器核对都过了；唯一的行为变化是上面那条二级〔裁〕，要用户审。
