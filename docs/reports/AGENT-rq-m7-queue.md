# AGENT-rq-m7-queue 报告

分支 `claude/rq-m7-queue`，起点 `origin/claude/c10-integ` `24c2c57`（C10 与 main 的最新改动都在上面）。任务：M7「纯浏览器节点」的队列与凭证一侧（契约 `docs/plan/m7-contract.md`，按第 13 节主会话裁定）。端口段 5720～5729。中途按主会话要求合进了测试分支 `claude/rq-m7-tests`（`8f18461`）对账。

代号：M7 是「纯浏览器节点」这一阶段；D1～D18 是契约第 11 节的待定点与第 13 节的裁定；K1～K11 是测试分支 `server/test/m7-kit.mjs` 文件头写的接口假设；M7-A1～A12 是契约第 10 节的验收编号；F.1、F.7、I 节等指 `docs/plan/render-queue-contract.md` 的节。

## 做了什么（每条裁定怎么落地）

| 裁定 | 落地 | 文件 |
|---|---|---|
| D1 双份出键 | 切分方对浏览器可做的卡（共享档、独立卡、非用户卡图卡、`cardSources` 为空、light / medium、不用只在发布方本机的素材、没被锁）除自己那份外按每个浏览器指纹再出一份；两份都 `input.dual: true`，浏览器那份另带 `input.compositing` 与 `input.bake`（`start / end / count / sampling`），都不带 takeover。**浏览器指纹从哪来**：队列在 plan 的 `task.claimed` 里带 `browserFingerprints`——此刻在线、profile 为 browser、带指纹、连接 `userId` 等于 plan 的 `source.userId`、watch 着这个项目的节点的指纹（去重升序，最多 4 个）。没有这样的节点就不带这一项，切分方只出自己那一份（与原来完全相同）。浏览器指纹等于切分方自己的：只出一份，但带 bake / compositing（浏览器能认领）。 | `render-queue/queue.mjs`（`browserFingerprintsFor`）、`render-node/session.mjs`（把它交给 onTask）、`render-node/local-node.mjs`、`render-node/split.mjs` |
| D1 建锁作废另一份 | 认领建锁、同指纹认领、`card.lock` 建锁时，同锁键、异指纹、`input.dual` 为真、还没做完（open / claimed）的任务进 failed（`superseded`），不加 attempts；认领者收 lease-lost（open 的没有认领者，不发），订阅者收 `task.failed { error: 'superseded' }`，看得见的节点收 `task.closed`。不带 dual 的不动。作废的任务记录发布时当不存在（可以重建，D2 接手要用）。 | `render-queue/queue.mjs`（`supersedeDual`、`isSuperseded`） |
| D2 锁闲置接手 | card-locked 的发布回包与认领回包带 `lockIdleMs`、`lockedByProfile`；发布回包另带 `lockUndone`（锁定方这张卡还没做完的任务数）。续约也刷新锁。切分方的判定 `idleLockTakeover(lockKey, lockedBy, info)`：`lockIdleMs` 严格大于 30 s 且 `lockUndone !== 0` 才接手，没有 `lockIdleMs`（旧队列）不接手；pc（`vite-plugin-frames.ts`）与独立渲染主机（`host.mjs`）都传它。30 s 记在 `render-queue/constants.mjs` 的 `LOCK_IDLE_TAKEOVER_MS`，单测核对等于 `card-lock.mjs` 的 `CARD_LOCK_IDLE_MS`。 | `queue.mjs`（`lockInfo`、`produced`）、`constants.mjs`、`local-node.mjs`、`host.mjs`、`vite-plugin-frames.ts` |
| D9 profile 与 nodeId 绑凭证 | `normalizeOwner` 认 `{ kind: 'browser' }`（票据签发与握手共用）。队列模块对 owner 为 browser 的连接：`node.hello` 的 profile 不是 browser 回 `forbidden`、不登记。nodeId 绑到第一次报到的 userId（节点记录在期间，含断开后的宽限期），别的 userId（不论 owner，含桌面凭证）拿同一个 nodeId 报到回 `forbidden`，原节点不受影响；模块先查（`q.nodeUserOf`）免得把被拒的连接记成节点，队列本体再挡一次。`auth-contract.md` 第 5、6、8 节加了这种归属。 | `auth/protocol.mjs`、`docservice/modules/shared.mjs`（错误文字）、`docservice/modules/render-queue.mjs`、`queue.mjs`、`docs/plan/auth-contract.md` |
| D10 指纹由队列模块算 | `node.hello` 带 `environment: { platform, userAgent, renderer, vendor }`（`pageEnvironment()` 的原始值），模块按 `describeEnvironment({ platform, renderer, vendor, chromeVersion: userAgent })` 算（与测量帧入库路由同一换算），写进交给队列的 `envFingerprint`；`node.welcome` 回 `envFingerprint`。owner 为 browser 的连接一律按它算、自报的不作数，没报 environment 回 `bad-message`；别的连接只在没自报指纹时按它算。 | `docservice/modules/render-queue.mjs`、`queue.mjs`（welcome） |
| D14 非 Chromium | 以 browser 报到、UA 不是 Chromium 内核：回 `error { reason: 'not-chromium' }`，不登记。判法 `isChromiumUserAgent`：有 `Chrome/<数>`、`Chromium/<数>` 或 `HeadlessChrome/<数>`，且不是 `Firefox/`、iOS 的 `CriOS/ FxiOS/ EdgiOS/`（WebKit）。服务端这一侧也挡（主会话裁定 2）。 | `render-node/fingerprint.mjs`、`docservice/modules/render-queue.mjs` |
| D4 / 主会话裁定 1 | 节点侧 `filter.mjs` 加规则 7：纯浏览器的快照任务只收 `tier: 'shared'` 且 `input.compositing === 'independent'`。 | `render-node/filter.mjs` |
| D12 层表 v 3 | `LAYER_MAP_VERSION = 3`：每层带 `candidates: [{ envFingerprint, resultKey, key, dirKey }]`，层上 v 2 的字段等于第一个候选。候选 = 这张卡最近一次切分实际出键的指纹（按发布顺序，切分方自己的在前），再补上这一层自己的指纹（没出现过的排最后）；没有切分记录时只有自己一个候选，本地档只有自己一个候选。写的时机：`local-node` 切分完成、发布回包都回来之后调 `executor.afterSplit(planTask, { tasks })`（最终发布成功的细任务）→ 执行器记候选（`pipeline.recordSplitCandidates`）、带片段清单的 plan 写一次层表（主机用 `publishLayerMap` 选项，PC 用管线的推送队列）；主机不再在切分之前写。页面读法：`parseLayerMap` 认 v 3，`layerCandidates(layer)` 回候选（v 2 当一个候选），`layerRefOf(table, clipId, { alive })` 有活着的候选就整份换成它、不混。 | `artifact-transfer.mjs`（`layerMapOf`、`splitCandidatesOf`）、`frame-pipeline.mjs`（`recordSplitCandidates`、`splitCandidatesFor`）、`prerender-executor.mjs`（`afterSplit`）、`vite-plugin-frames.ts`（主机写层表带候选）、`src/render/snapshotSource.ts` |
| D11 的一半 | `session.mjs` 改从 `constants.mjs` 取常量；`filter.mjs` 改从 `messages.mjs` 取 `isListPlan`（它也在会话的依赖树里）。细任务编排抽成同构的 `render-node/task-runner.mjs`（`createTaskRunner`、`untilAborted`，不引任何模块），`local-node` 改用它、plan 的切分仍在 `local-node`（经 `executePlan` 注入）。`session.mjs` 与 `task-runner.mjs` 的依赖树里没有 `node:` 内置模块（单测静态查）。 | `render-node/session.mjs`、`filter.mjs`、`task-runner.mjs`、`local-node.mjs`、`index.mjs` |

## 提交

见文末「提交列表」。

## 验证

- 修前失败：新单测 `server/test/m7-queue.test.mjs` + `src/render/m7-layer-candidates.test.mjs` 先提交，跑出 tests 33、pass 2、fail 31（两条过的是「不给浏览器指纹时切分不变」与「浏览器做不了的卡只出一份」两条回归守卫）。
- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`（全量，合进测试分支之后）：退出码 0；tests 3648、pass 3636、fail 0、cancelled 0、skipped 12、todo 0。
  - skipped 12 = 原有 2 条（`/api/cards/layout` 集成、SKILL 闸门集成）+ 测试分支的页面节点 10 条（K10 当节点条件 1、K11 页面节点编排 9：hello 1、第 4.1 节 1、D8 4、D6 3）。这 10 条的门是页面节点文件（`src/online/browserNode.ts` 等），属于页面节点分支，主会话说明本分支不做；所以「跳过 ≤ 2」这一条在合进测试分支之后按 2 + 10 算。
  - 基线（改动前，同一 worktree）：tests 3563、pass 3561、skipped 2、fail 0。
- 测试分支的门：39 条门后用例里，本分支实现的 29 条门全部打开并真跑通过（D4 1、D1 队列 6、D2 队列 4、D9 6、D10 3、D14 1、D1 切分 4、D2 判定 1、D12 v3 3）；另有原来的 todo 1 条（tier）按裁定改成真跑、通过。仍跳过 10 条（页面节点，见上）。
- M7 相关文件单跑：`node --experimental-test-module-mocks --test server/test/m7-*.test.mjs src/render/m7-layer-candidates.test.mjs` → 全过、skipped 10（同上）。
- 桌面节点、独立渲染主机回归：`render-queue-*`、`card-lock-*`、`m6c-*`、`c10*`、`render-host*`、`render-node*`、`queue-node-wiring`、`prerender-executor`、`host-card-code`、`ht3-equivalence`、`artifact-*`、`small-tier` 全过（包在全量里）。
- 探针：见下「探针」一节。
- 负载：机器上同时有十来个子 Agent，全量测试一轮约 50～70 s；本分支单测全部用假时钟或「让出宏任务回合」，没有真实计时断言。

## 改了的现有测试（形状随契约变的，逐条列出）

- `card-lock-queue.test.mjs` Q5、Q10（5 处）、`card-lock-node.test.mjs` N6（1 处）：发布回包逐字段比较，M7 D2 加了 `lockIdleMs / lockedByProfile / lockUndone`，改为只比 F.7 定的那几项（加了 `f7()` 小函数）。
- `render-node-logic.test.mjs` 的 `taskView`、`render-node-session.test.mjs` 的 `view`：纯浏览器的快照夹具补 `input.compositing: 'independent'`（规则 7）。
- `render-queue-inproc.test.mjs` 的 `planContextFor`：`cardSourceVersions` 从 `{ particles: 'builtin:12', … }` 改成 `{}`——c66-host-cards 起这张表只列定制卡，没改过的内置卡不在表里；旧形状会让 I5 的浏览器一张卡也认领不到。
- `m6c-integ.test.mjs` MI-no-isIdle：执行器的键多了 `afterSplit`。
- `small-tier.test.mjs` ST8：层表 `v` 为 3，层上多 `candidates`。
- 测试分支的 `m7-e5-b2.test.mjs`：tier 那条 todo 改成真跑（主会话裁定 1）。`m7-kit.mjs` 没改：实现的形状都对得上它的假设（K6 的 `browser` 选项见下「与契约的出入」第 1 条）。

## 与契约的出入

1. **D1 浏览器指纹的来源**：契约第 3.3 节写「页面在清单计划的 `input.browser` 写 `{ nodeId, envFingerprint }`」。本分支按主会话任务书改为「以文档服务上本项目当前在线的 browser 节点所报的环境为准」：队列在 plan 的 `task.claimed` 里带 `browserFingerprints`。切分方**不读** `planTask.input.browser`（页面自报的）。`splitPlan` 另收一个同名选项 `browser`（`{ envFingerprint }` 或数组）当 `browserFingerprints` 的别名，只为测试分支 K6 的调用形状，生产不用。随之，契约第 3.3 节「页面等 render 会话报到完再发第一份清单计划、最多等 3 s」的意义变成：**页面要先 `node.hello` + `queue.watch`，再发布这一版的清单计划**，否则切分方认领时看不到浏览器（下一版计划会带上）。
2. **D2 闲置按「最后一次产出」算，不按 `touchedAt`**：F.1 规定同指纹的发布也刷新 `touchedAt`（管锁回收）。若 `lockIdleMs` 按它算，切分方每次照锁重发都会把闲置归零，走掉的浏览器的锁永远不闲置。所以另记 `producedAt`（认领、续约、完成、`card.lock` 才算），`lockIdleMs` = 此刻 − `producedAt`；`touchedAt` 行为不变（续约也刷新它，照裁定）。测试分支 K5 写的是「此刻 − touchedAt」，它的场景里两者相同，用例照过。
3. **D2 多带 `lockUndone`，做完了的锁不接手**：契约只写「闲置超 30 s 就带 takeover 重发」。照语义「还缺帧、而锁定方已经有一段时间没有再产出，就用自己的指纹接手整张卡」（`mechanism/rendering.md`；本机锁库的 `cardLockDecision` 同样先判「已齐 → 直接投递」），锁定方这张卡已经全部做完（`lockUndone === 0`）时照锁投递、不重渲。否则 PC 每来一版计划都会把浏览器早已做完的卡整张重渲一遍、层换环境。
4. **作废的任务可以重新发布**：契约与 A.7.1 规定 failed（TTL 内）的任务重复发布只回说明、不重开。被作废（`superseded`）的例外：发布时当它不存在，按新任务处理（锁回到它的指纹上就建，锁还在别处回 card-locked，带 takeover 就接手）。不然 D2 接手时切分方那份的任务 id 正好是早先被作废的那几个，十分钟 TTL 之内接手不了。
5. **D9 绑定的时限**：nodeId 绑在节点记录上，节点断开超过宽限期、记录删掉后绑定一并解除（那时它已经没有认领可抢）。不另存一张永久表。
6. **D12 写层表的时机**：主机原来在切分**之前**按本机视图写（C10 第 18 节第 9 条），现在只在切分完成后写一次（裁定 (b) 的时机）。PC 这边管线自己的几处写（`addBackfill`、`preload`）照旧在，但都按记下的切分候选列候选，后写的赢。层表里自己的指纹即使这一版没发布（照锁只出了浏览器那份），也排在候选末尾——PC 本机的预渲染可能照样产它；多列一个死候选无害，页面按 `task.done` 与清单认定。
7. **规则 7 的「内置卡」读法**：切分方判「`cardSources` 为空」。c66-host-cards 之后这张表只列定制卡（用户卡、改动层里改过的卡），没改过的内置卡本来就不在表里，所以等于「内置、没改过」。
8. **没做 `isolatedCardProject` 挪进共用模块**：契约第 9 节把它列在本分支，但主会话任务书的范围里没有；它在 `frame-pipeline.mjs` 里、是纯函数，挪动要守 G0-R 输出不变。浏览器那份的 `input.bake` 已经带齐它要的参数。需要的话由主会话决定给哪个分支。

## 给页面节点分支的接口说明

**连接与报到**

- render 票据：`auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'browser' } }`（2 分钟，每建会话现签），子协议 `promptcut.ticket.<票据>`。
- 报到：`{ type: 'node.hello', nodeId, profile: 'browser', environment: { platform, userAgent, renderer, vendor }, capabilities, codeVersions: [CODE_VERSION], maxConcurrent: 1, resume }`。不用带 `envFingerprint`（带了也不作数）。
- 回包：`node.welcome { nodeId, envFingerprint, resumed, lost, epoch }`——`envFingerprint` 就是这个页面的指纹（16 位十六进制）。
- 报到被拒（都是 `{ type: 'error', reason, detail, reqId? }`，节点不登记，此后 `queue.watch` 等回 `not-registered`）：
  - `forbidden`：profile 不是 browser；或这个 nodeId 绑在别的 userId 上（换一个 nodeId）。
  - `bad-message`：没带 environment，或 environment 不是四项字符串（每项 ≤ 1024 字符）。
  - `not-chromium`：UA 不是 Chromium 内核。页面自己也应先判（K10），不开 render 连接。
- 报到后 `queue.watch { projects: [<项目 id>] }`（`'all'` 回 forbidden）。**先报到、watch，再发这一版的清单计划**：切分方认领计划时，队列按此刻在线的、同一用户、watch 着这个项目的浏览器节点给指纹。

**浏览器那一份细任务的形状**（`task.opened` / `queue.snapshot` / `task.claimed.task`）

```js
{ id: 'snapshot:<resultKey>:<from>-<to>', kind: 'snapshot', tier: 'shared', resultKey,   // resultKey = sha256(contentKey \n 浏览器指纹)
  range: { unit: 'localFrame', from, to },
  source: { projectId, projectRev, derivedFrom: 'plan:…', userId, tenantId, … },
  input: { clipId, cardId, entryKey: null, contentKey, canvasHeavy: false,
           dual: true,                       // 另一份（切分方的）同时存在；浏览器指纹等于切分方指纹时没有 dual
           compositing: 'independent',
           bake: { start, end, count, sampling } },   // 隔离单卡工程要的，照桌面 isolatedCardProject
  weight: { class: 'medium', estMs: null, frames },
  requires: { envFingerprint: <welcome 回的指纹>, codeVersion, cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false },
  priority: 50 | 10 }
```

- 节点侧过滤（`filter.mjs`）对纯浏览器：规则 0 本人、1 指纹 / 代码版本、2 不要流与转码、3 非用户卡图卡、4 light / medium、6 不收 plan、**7 只收 `tier: 'shared'` 且 `input.compositing === 'independent'`**。
- 会话与细任务编排可以直接用：`server/render-node/session.mjs` 的 `createNodeSession`（依赖树同构）与 `server/render-node/task-runner.mjs` 的 `createTaskRunner({ nodeId, session: () => session, executor: { render }, sink: { has, put, resultFor? }, emit })`；把 runner 的 `onTask` / `onLost` 交给会话。runner 的规矩与桌面相同：认领到先 `progress(0)`，`sink.has` 为真就 `complete({ ranges, dedup: true, …清单 })`，否则 `render → put → complete({ ranges, …清单 })`，没收全 `fail('sink-incomplete', true)`，丢认领丢结果。runner 不做 plan（收到就不可重试失败，正常不会发生）。

**作废与锁**

- 切分方那份先被认领（或反过来），另一份收到：订阅者 `task.failed { id, error: 'superseded' }`、看得见的节点 `task.closed { id, state: 'failed' }`（或 `state: 'hidden', reason: 'card-locked'`）。**这是「另一份活着」，不是失败**：页面把这一个候选当死，改认另一个候选。
- 认领被锁挡回：`task.claim-rejected { id, reason: 'card-locked', state: 'open', version, lockedBy, lockIdleMs, lockedByProfile }`；会话照旧丢掉这个候选。
- 浏览器认领一段后走掉：锁闲置严格超过 30 s、这张卡没做完，下一次有人发布计划时切分方带 takeover 接手整张卡，浏览器那份作废（手里还有的收 `task.lease-lost { reason: 'superseded' }`）；页面整层换候选。没人再发布计划时不会接手（契约第 3.4 节的限制）。

**层表 v 3**（内容库 `snapshot-manifest` 类，键 `layers:<项目 id>`）

```js
{ v: 3, kind: 'layer-map', projectId, entryKey, fps, width, height, span: 60, at,
  layers: [{ clipId, kind: 'html' | 'local', tier, firstFrame, count, entryKey, contentKey,
             key, resultKey, dirKey, envFingerprint,                 // = candidates[0]，v 2 的读法照旧
             candidates: [{ envFingerprint, resultKey, key, dirKey }, …] }] }   // 切分方自己的在前，浏览器的在后
```

- 页面读法（已在 `src/render/snapshotSource.ts`）：`parseLayerMap` 认 v 1～3；`layerCandidates(layer)` 回候选（v 2 当一个候选，v 1 与缺指纹的没有）；`layerRefOf(table, clipId, { alive })`：`alive` 是认定活着的结果键集合（由 `task.done` 与清单得出），候选里有活着的就整份换成它（结果键、指纹、线上键同出一个候选），没有 `alive` 或认不出回第一个候选。
- 清单键照旧 `<resultKey>:<from>-<to>`，按候选的 `resultKey` 查。

## 探针

- `node scripts/probes/ready-index-probe.mjs --port 5720`（探针自己起 dev server，舞台 5721、5722）：退出码 0，`fails: []`。
- `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5723 --group`（本 worktree 的 vite 起在 5723，舞台 5724、5725）：退出码 0，`fails: []`、`PASS`；组流三张卡、重启后 `producedAfterRestart: 0`。跑完只结束了自己起的那棵进程树（5723 的 vite 及其子进程）。
- 两个探针都在 CPU 很忙时跑（十来个子 Agent 并行），没有带耗时门槛的判据。

## 需要主会话定的事

1. 与契约的出入第 1～4 条（浏览器指纹的来源、闲置按产出算、`lockUndone`、作废的任务可重发）是按语义与任务书做的取舍，请审；若要回到契约原文（页面写 `input.browser`），切分方加读 `planTask.input.browser` 一行即可，但它是页面自报的。
2. `isolatedCardProject` 挪进共用模块给哪个分支（出入第 8 条）。
3. 合进测试分支后全量跳过 12 条（2 + 页面节点 10），页面节点分支集成后才会回到 2。
4. D18 的三级语义措辞（「纯浏览器节点的环境指纹由文档服务按页面报来的原始值算……一期只在 Chromium 内核的浏览器上当节点」）与本分支的实现一致，按裁定在 M7 合入 main 时写进语义。

## 提交列表

`git log --oneline --first-parent 24c2c57..HEAD`（旧到新）：

```
d92fd13 文档:报告(开工)
87db46b 测试:M7 单测(修前 31 项失败)
80c9e99 功能:切分双份出键(D1)
d16fa27 功能:队列侧 D1 D2 D9 D10
aeba51a 功能:队列模块 D9 D10 D14、归属 browser
8f177bd 重构:session.mjs / filter.mjs 的 import(D11)、会话传 browserFingerprints
434441e 合并 claude/rq-m7-tests(8f18461)
90a7f8e 功能:filter 规则 7;页面读层表 v3
fbefcac 重构:task-runner.mjs、idleLockTakeover、afterSplit
38f87ac 功能:层表 v3 写入方;pc 与主机传 idleLockTakeover
23bd770 测试:进程内锁闲置接手、afterSplit 时机
5243266 文档:auth-contract 第 5、6、8 节
322bffe 文档:报告正文
(本提交) 文档:报告补探针与提交列表
```

## 第二轮：验收探针查出的 M7-A10 与 D1-D2-D12（2026-09-28）

合进 `claude/m7-accept-probe`（56b829b）与 `claude/rq-m7-node`（bab9f46）后查。

**M7-A10（锁闲置接手）**，两个原因：

1. 队列侧缺陷（已修）：切分方从本机锁库已知这张卡锁在浏览器指纹上时，照锁出键，发布合并进离线用户的那几份，不会被拒，也就收不到锁的闲置情况，永远不接手。修法：指纹不同的切分节点照锁发布时，队列回包也带 `lockIdleMs / lockedByProfile / lockUndone`（不带 lockedBy）；合并已有任务、回包带 `lockedBy` 的同样带。`local-node` 对这两种回包照 D2 判：闲置严格超 30 s 且没做完，就按自己的指纹带 takeover 重发，照锁发的那几份不算发布成功。单测 M7Q-A10c～f 修前失败、修后通过。
2. 探针时机：开 b2 时项目版本没变，b2 发的清单计划与 b1 那一版同 id、已 done，队列只回 task.done，没人重新切分（契约第 3.4 节：接手只在有人重新切分时发生）。探针改法（已改）：开 b2 后 `touchLight` 改一处轻卡参数，让页面按新版本重发。

**D1-D2-D12（双份出键、作废、层表 v3）**，三个原因：

1. 队列侧缺陷（已修）：页面报到之前那一版只出了 pc 单份；下一版按双份发来时 pc 那份合并进已有任务，没有 dual，浏览器先认领后不会被作废（留成死任务）。修法：合并时补上 dual（换新对象，还 open 就重发 task.opened）；锁已在别的指纹上时当场作废。
2. D12 缺陷（已修）：切分候选只在内存，pc 重启后写的层表只剩 pc 一个候选。修法：落盘到库根 `split-candidates.json`。
3. 探针判据的时机：这一项在 A10 之后判（pc 已重启，离 A4 已过 10 分钟 DONE_TTL，锁随任务过期被回收，之后的切分没有浏览器、只出 pc 一份，层表按实际出键就只剩 pc），并且假定页面总是先得卡（`pcSuperseded === pcDual`）；宿主全开时 pc 先得卡也合契约（那时作废的是页面那份）。建议：把这一项挪到 A4 之后、A10 之前判，判据改成「每张卡恰好一份被作废（看先认领者是谁）」。

**验收探针**（`node scripts/probes/m7-browser-probe.mjs --role all --out <scratchpad>/m7ap/run3`，跑前 5450～5459 空着，跑完空着）：M7-A10 三条全过——

- `server-idle-takeover` pass：锁 `258acaaa7c5fe509`（页面）→ `43ba7c6261e7f8e5`（pc），takeoverMs 230458；
- `server-race-one-env-per-card` pass：w1、w2 各只有一种指纹；
- `page-layer-switched` pass：b2 上 z1 层指纹 = pc 指纹，ready 61。

run2 作废：跑的中途我提交了一处 `server/frame-pipeline.mjs`，pc 的代码版本随工作区变了，与在线构建的代码版本对不上，pc 不再认领计划（`pcFilter: code-version`）。教训：探针跑着时不改工作区。

**基线**：`npx tsc -b --force` 退出码 0；`npm test` 退出码 0，tests 3752、pass 3750、fail 0、skipped 2（合进页面节点分支后，页面节点的门都打开了）。
