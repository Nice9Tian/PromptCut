# AGENT-v18-move-guard：搬到云端旧流程的防呆

分支 `claude/v18-move-guard`，从 main f87e297a 建，交活前合过一次 main（18acee56）。端口段 28950～28989。

## 做什么

桌面版两个入口（甲：项目设置里勾多用户协作并选云端；乙：本机已开协作房间时点「搬到云端」）走的都是旧办法。账号模式的云端节点只认网站账号。要在改变本机状态之前先问清目标节点接不接受旧办法的导入，不接受就停；另验「搬回本机」。

## 1. 复现（运行证据，不是推断）

环境：真实账号夹具（`startCloudQueueUserFixture`：真账号后端、文档服务、独立素材进程、TLS 边缘）当云端节点；桌面版开发服务器（`PROMPTCUT_NO_PORT_FILE=1`，无头 Chrome）经界面真点。探针 `scripts/probes/move-guard-probe.mjs`，证据 `docs/reports/assets/v18-move-guard/before-evidence.json`，图 `before-*.png`。

节点自己的回答（`node-facts` 一步）：`GET /healthz` 为 200 且带 `accountMode: "v2"`、`accountRequired: true`；`POST /shared/create` 为 403 `account-required`。

**入口甲**（勾多用户协作、放云端、填节点地址、确定）：浏览器先发预检 `OPTIONS /hosted/shared/create`，节点回 403，页面报 `Failed to fetch`，界面原文「连不上云端，设置没有完成。」。没有改任何状态：协作没开、没有房间关联、本机项目还能编辑和保存，云端只收到这一个被拒的预检。与推断一致：提示不准（其实是节点只认账号，不是连不上），但没伤到东西。**不改代码。**

**入口乙**（本机先开协作房间，设置里点「搬到云端」）：**与推断不一致，比推断更糟。**
- 推断说「账号模式下导入口是关着的」。实际是开着的：同一次点击里云端回了 `import-init` 200、`begin` 200、`import-index` 200、`import-file` 200、`import-complete` 200、`publish` 200，只有最后的 `import-activate` 回 503，之后每一轮重试都是 init、begin、publish 各 200 加 activate 503（一次观察里共 6 轮、18 个 503）。
- 503 的原因与推断吻合：账号模式下云端组合的素材口地址是 `{ port: null }`，`server/hosted/combo.mjs` 里搬迁的 `assetBaseOf` 因此得到 `http://127.0.0.1:null`，启动托管时 `new URL` 抛错。
- 本机一侧，点击之前：房间在线、可编辑、无封锁。点击之后：磁盘上的房间记录带 `relocation.phase = frozen`（目标 `https://127.0.0.1:28956/hosted`，只封锁、没有标记已搬走），页面 `shared` 变成空、关联状态是 `waiting-host`、状态 `idle`；再改一次项目名，保存报「协作身份尚未恢复；请等待主机或重新认证后保存。文件内容已保留。」；成员重连用的 `restore-host` 回 409 `relocating`。本机托管同时被注销（云端 `POST /hosting/unregister` 200）。
- 界面原文：设置窗口里停在「正在搬到云端，完成后自动连接原房间…」，不再变化；顶栏「正在等待主机上线，将自动重试。」（图 `before-entry-b-after-click.png`）。
- 云端一侧落了什么：整房数据进了旧库——`docservice/auth/projects/<房间>.json`、`docservice/tenants/<房间>/…ops.ndjson`、`docservice/relocation/<事务>/` 下的暂存与清单、`secrets/relocation/<事务>.json`（共 5 个新文件）。云端已把这次搬迁登记成「已发布」，本机却没标成已搬走，两边对不上。

**搬回本机**（桌面版接上一个账号项目，设置里点「搬回本机」，修之前按钮是露着的）：界面原文「搬迁暂未完成，房间和本机恢复信息已保留。请检查连接、身份或存储后重试。」。**不改状态**：页面一侧 `moveSharedToLan` 因账号项目没有旧办法的房间关联，直接回 `not-ready`，没发任何 `/api/collaboration/*` 请求，也没有任何云端写入；项目仍连着、仍能编辑。与推断一致，点了只是失败。后来用户 2026-10-13 定了「搬回本机」这一版先收起来（`docs/plan/user-decisions-2026-10-13.md` 第 2 节），所以第 2 节第 4 条把它收了。（账号项目的页面是用页面里的替身 native 接上的，探针里写明；桌面开发服务器没有 Tauri 保险箱。）

## 2. 防呆（做了什么）

先问节点，后动手。改了三处，全在三级（用户只会在失败时看到现有的失败句子）：

1. 新文件 `server/recovery/relocation-preflight.mjs`：`legacyImportAccepted({ service })`，对目标服务发一个只读 `GET {service}/healthz`（节点本来就有的口子，账号模式节点在里面报 `accountMode` / `accountRequired`）。账号模式回 `account-mode`；问不到、非 200、不是 JSON、答得不像文档服务回 `relocation-network`（确认不了就不动手）；暂时性的失败退避后再问一次。
2. `server/recovery/http.mjs` 的 `move-hosted` 分支：在新开一次搬迁（`!unavailable`，即本机房间没封锁）之前调预检，不过就回 409 `account-mode` 或 503 `relocation-network`，不进 `startMove`。已经封锁、正在续传的同一次搬迁不预检。
3. 节点一侧（防旧版桌面）：`server/hosted/relocation.mjs` 的 `handle` 在账号模式下对 `/hosting/relocation/import-*` 一律回 403 `account-required`；`combo.mjs` 传一个参数。账号模式的节点从此不收旧办法的整房导入。

4. `src/editor/sync/CollabSection.tsx` 一行：「搬回本机」按钮的显示条件加上 `!shared.accountId`，账号办法的云端项目里不再显示；旧办法的云端房间照旧显示，`moveLan` 与 `moveSharedToLan` 一字未动。按钮本来是独立一行，收起后没有空位也没有孤零零的分隔线（见 `after-move-back-button-hidden.png`，对照修之前的 `before-move-back-before-click.png`）。

不新增任何界面文字。页面在 `recoveryRequest` 收到非 200 就返回失败，`CollabSection.tsx` 按现有逻辑显示「搬迁暂未完成，原房间信息已保留。检查连接或存储后重试。」。「先确认」没有新加节点口子，用了现有的 `/healthz`，所以没有新的节点只读查询。

### 改后表现（`after-evidence.json`，图 `after-*.png`）
- 入口乙，账号模式节点：`move-hosted` 回 409；云端在这一步只收到 `GET /hosted/healthz` 200（另有 `POST /hosting/register`，是本机已开的 LAN 房间照常的在线登记续期，点击之前建房时就在做，与搬迁无关）；本机：房间记录 `relocation` 为空、`shared` 仍是 `lan`、状态 `connected`/`online`、改项目名后保存成功、`restore-host` 回 200；云端新增文件 0 个。界面原文「搬迁暂未完成，原房间信息已保留。检查连接或存储后重试。」。
- 节点直接回答：`import-init` 回 403 `account-required`。
- 入口乙，旧模式节点（对照）：「已搬到云端，仍是原房间。」，`shared.where` 变 `hosted`，本机记录已搬走（图 `after-legacy-entry-b-after-click.png`）。
- 入口甲：与修之前一致（没改代码，表现本就不伤人）。
- 搬回本机：账号项目的设置里按钮不在了（探针 `moveBackButtonPresent: false`；设置段落依次是多用户协作、放在、项目名、云端 Agent、邀请码、改密码一行、踢人说明，无空位）；旧办法搬完的云端房间里按钮仍在（探针 `moveLanButtonShown: true`）。

## 3. 验证

- 新测试 `server/test/move-guard.test.mjs`（端口全部向系统要）：5 个用例。①预检各分支（账号模式、`accountRequired`、非 200、非 JSON、答得不像、抛错、地址不合法、暂时失败后重试）；②真实账号夹具节点：点搬到云端后本机房间记录、主机绑定、操作日志逐项不变，没有搬迁暂存目录，没封锁，`move-status` 为 `idle`，`restore-host` 照放行，房间还能再编辑（rev 加一），再点一次结果相同；云端（经记录用的转发）只收到 `GET /healthz`；`import-init` 回 403 `account-required` 且云端没有新增搬迁暂存；③节点连不上：503，本机不变；④旧模式节点：整条搬迁走完，源端记为 `relocated`，云端拿到原房间；⑤读源码确认「搬回本机」的显示条件含 `!shared.accountId` 且功能代码没删。
- 反证：把三份修改的文件换回修之前的版本，②③两个用例失败（状态码 200 对 409/503），①④通过；换回后全部通过。
- 命令与结果见本报告末尾的「基线」一节。

## 4. 没碰的、碰了的

- 另两条分支在改的文件：我碰了 `server/recovery/http.mjs`（加 1 行引入，在 `move-hosted` 分支里加 5 行，见 `git diff`，在原第 144 行之后）；新增了 `server/recovery/relocation-preflight.mjs`。`src/editor/sync/` 下只碰了 `CollabSection.tsx` 一行（「搬回本机」的显示条件加 `!shared.accountId`）；没碰 `syncManager.ts`、`link.ts`、`cardSync.ts`、`labels.ts`，没碰 `server/recovery/` 其它文件和 `account-projects.mjs`。
- 另碰了 `server/hosted/combo.mjs`（1 行）和 `server/hosted/relocation.mjs`（3 处，共 7 行）。
- 夹具 `server/test/fixtures/cloud-queue-user-path.mjs` 没改（合 main 带来的 9 行改动是别的分支的）。

## 5. 没做成的与原因

- **已经被旧版本封锁的本机房间解不开**：以前版本点过搬到云端、本机房间已被标成 `frozen` 的用户，现在的预检不会解封（设计上「不用解除源封锁来掩盖失败」，没有解封操作）。这类房间会继续按每秒一次的续传去撞节点，现在撞到的是 403 `account-required`，会停下并标成终止，房间仍是封锁的。要不要做解封，要用户定（见下）。
- **旧版桌面软件**：还是会先封锁再失败。节点一侧只能保证云端不再被写入，管不了本机。
- 入口甲提示不准没改（见下，等用户定句子）。

## 6. 〔裁〕

- 〔裁〕三级：账号模式节点的 `/hosting/relocation/import-*` 回 403（任务书背景写的是「导入口在账号节点上是关着的」，实测并没有关，所以补上）。用户看到的差别只有旧版软件失败得更早。依据：`suggested_agent_behavior.md` 执行时的裁定规则，先扫三级。
- 〔裁〕三级：预检问的是 `/healthz` 而不是新加节点口子（现有口子够用，没有新增面）。

## 7. 对任务书或语义的更正建议

- 任务书背景「旧办法的导入口在这种节点上是关着的」不符合实际（见第 1 节入口乙），已由第 2 节第 3 条补上。
- `docs/plan/collaboration-relocation-contract.md` 已补一段「搬到云端动手之前先预检目标节点」。语义文档（`docs/semantics/`）没改。建议主会话合入时在 `workflow/project.md` 的搬迁动作里补一句：搬到云端前会先确认目标云端接受旧办法，不接受则不改动本机房间（这是一级语义，要用户定）。
- 夹具里的项目 `initialProject` 是 `{ tracks: [] }`，编辑器接上它会因缺少 `fps` 等字段崩溃（`toFixed`）。探针用页面里造的完整空项目新建账号项目绕开；以后做账号办法的人要知道。

## 8. 要用户定的事（白话）

1. **失败提示的句子**。账号办法做出来之前，这道防呆就是用户点「搬到云端」时的实际表现。入口乙我选的现有句子是「搬迁暂未完成，原房间信息已保留。检查连接或存储后重试。」（现有三句里最贴切：「原房间信息已保留」是真的，本机房间原样可用；缺点是后半句让人去查网络，而重试永远不会成功）。账号模式下三处都在用现有句子，不新增：入口甲「连不上云端，设置没有完成。」（其实是这个云端只认网站账号）；入口乙「搬迁暂未完成，原房间信息已保留。检查连接或存储后重试。」（重试永远不会成功）；搬回本机「搬迁暂未完成，房间和本机恢复信息已保留。请检查连接、身份或存储后重试。」（现已收起，不再出现）。前两句都会误导用户去检查网络。我建议的新句子（草稿，由你定）：入口甲「这个云端只接受网站账号，不能用旧的房间方式开启协作。」；入口乙「这个云端只接受网站账号，旧的协作房间搬不上去。本机房间没有改动，可以继续用。」。选项：采用、改写、不改。后果：不改则用户遇到时仍会反复重试；建议采用并改写成你的口吻。
2. **已被旧版本封锁的房间要不要做解封或转换**。后果：不做，这类房间只能靠备份恢复（它的内容在本机磁盘上完整，只是不再接受连接）。建议做，但要先定产品语义（是解封成原样，还是转成本地项目），因为一旦云端已记录「已发布」，两边状态要对齐。
3. 账号办法下的「搬到云端」：用户已定要做（搬完关本机协作、提示发新链接、旧邀请码作废、按账号算有权搬），由主会话另派人，不在本块。

## 9. 给做账号办法「搬到云端」的人：摸到的事实

### 9.1 旧流程每一步做什么、哪一步改了什么（入口乙，修之前的行为）
1. 页面 `moveSharedToHosted`（`src/editor/sync/syncManager.ts` 约 1648 行）：只有关联（`association`）存在且 `where === 'lan'`、当前连接是共享项目才进，否则立刻回 `not-original-host`。先 `whenSaved` 等本机保存、等身份保存。
2. `POST /api/collaboration/move-hosted`（`server/recovery/http.mjs`）：核对本机设备就是当初的主机（保护存储里的主机绑定）；房间记录不存在回 `host-data-missing`；已搬走回 200 `complete`；然后 `startMove`。（新加：这里之前先预检。）
3. `startMove` → `prepareRelocationSnapshot`（`relocation-files.mjs`）：把整个租户目录（项目正文操作日志、修订、费用、事件）加 `media/snap/px` 三个素材库里的全部文件做成清单，算摘要，检查正文里引用的素材都在（缺了回 `relocation-materials-missing`）；写 `<数据目录>/relocation/<事务>/` 暂存；**随后同步 `freezeRoom`：本机房间记录写入 `relocation.phase = frozen`**——**这是第一个改本机状态的点**，从此本机所有成员连接和页面编辑都被拒（`roomUnavailableReason` 为 `relocating`）。
4. 同一个函数里接着停本机托管（`hosts.delete` 加 `worker.stop`，向云端 `POST /hosting/unregister`）——第二个改状态的点。
5. 异步 `transferRelocationToHosted`（`relocation-transfer.mjs`）向目标服务依次发：`import-init`（云端生成目标登记密钥）、`begin`、`import-index`、`import-file`（逐文件 PUT，300 秒超时）、`import-complete`（云端安装暂存）、`publish`、`import-activate`，最后 `markRoomMoved` 把本机记录改成 `moved`。控制请求 10 秒超时，网络、429、502、503、504 按 500 毫秒到 30 秒退避重试。
6. 页面拿到第 2 步的 200 就当作成功：解除共享连接，关联改成 `waiting-host`，起恢复协调器，等它在云端发现同一房间后自动接入，界面才显示「已搬到云端，仍是原房间。」。
7. 云端 `import-activate` 里的 `recover` 要起托管：`assetBaseOf()` 在账号模式是 `http://127.0.0.1:null`，`new URL` 抛错，回 503。

### 9.2 修之前我复现到的每一个状态码（账号模式节点）
- 入口甲：浏览器预检 `OPTIONS /hosted/shared/create` 403（节点对 `/shared/*` 的所有方法回 403 `account-required`）；直接 `POST /shared/create` 同样 403 `account-required`。
- 入口乙：页面一侧 `journal` 200、`host-state` 200、`move-hosted` 200、`cancel-host` 200、`select` 200（轮询七次）、`restore-host` 409 `relocating`。云端一侧 `unregister` 200、`import-init` 200、`begin` 200、`import-index` 200、`import-file` 200、`import-complete` 200、`publish` 200、`import-activate` 503，此后每轮 init、begin、publish 各 200 加 activate 503，反复（一次观察里 6 轮、18 个 503）。
- 修之后：`move-hosted` 409 `account-mode`，云端只收到 `GET /healthz` 200；`import-init` 403 `account-required`。旧模式节点 `move-hosted` 200，搬完。
- 搬回本机：修之前点了没有任何请求。

### 9.3 节点一侧旧导入口在哪关的
`server/hosted/relocation.mjs` 的 `handle`（`/hosting/relocation/import-*`），账号模式（`combo.mjs` 传 `accountMode: !!accountRuntime`）一律 403 `account-required`。`/shared/*` 的创建、加入等本来就在 `server/docservice/shared-service.mjs` 第 204 行附近对账号模式回 403。**`/hosting/register`（本机房间的在线登记）与 `export-*`（旧办法云端房间搬回本机）没有关**，账号模式节点上仍可达；与本任务无关，没动。节点的 `GET /healthz` 带 `accountMode: 'v2'`、`accountRequired: true`、`assetReady`。

### 9.4 账号办法要上去的东西各在哪、量级限制
- 账号项目的编辑器状态：`shared.accountId` 有值、`where: 'hosted'`、`association` 为空（`enterAccountProject`，`syncManager.ts` 约 1114 到 1165 行）。旧的 `moveSharedToHosted` 与 `moveSharedToLan` 以没有房间关联为由在页面一侧就返回，没有可复用的状态机。
- **项目正文**：本机项目就是页面里的 `project` 对象。账号新建 `client.create(name, initialProject, requestId)`，即 `POST /hosted/shared/account/create`（`server/account/authority.mjs` 的 `createProject`：名字 1 到 200 字符、不能含控制字符，同名未删项目回 409 `name-taken`）。`initialProject` 写进 `tenants/<id>/projects/` 的快照与首条日志（`account-hosted.mjs` 的 `initializeProject`，同一 `requestId` 重放幂等，内容不同回 503 `initialization-conflict`）。**请求体上限 1 MiB**（`server/docservice/modules/account-projects.mjs` 第 17 行，超了回 413 `body-too-large`）。创建策略 `createPolicy` 可限制每个账号建几个（缺省不限）。超过 1 MiB 的正文要先建项目再经文档连接分批写入：WebSocket 与 HTTP 传输单帧上限默认 1 MiB（`maxFrameBytes`），单次项目操作 `MAX_OPS_BYTES` 为 256 KiB（`modules/project.mjs`）。
- **卡片源码、内容库**：走文档服务的内容模块（`modules/content.mjs`），键 1 到 512 字符、单条内容默认 256 KiB（`MAX_BODY_BYTES`）、列表最多 1000 条；编辑器进程里的同步器（`server/card-sync.mjs`，页面一侧 `cardSync.ts`）在页面接上共享项目时自动绑定并上传用到的卡。账号项目上这条链是否照常工作，我没验。
- **素材两档（原尺寸、小尺寸）及 `snap`、`px`**：字节不进文档服务，走独立素材进程，按内容哈希寻址；账号会话里的 `assetTicket` 用来上传，页面一侧现成的是 `collab.ts` 的 `queueExistingMedia`，走 `/api/media/upload-queue/enqueue`（先小后大）。旧办法的搬迁是把 `media/snap/px` 三个库里**全部文件**连同租户目录整体搬走，账号办法不能照搬，要按项目引用的哈希上传。素材单件大小限制看素材服务配置，我没查。
- **对话和剧本**：账号模式下云端 Agent 对话由账号一侧的对话服务管（`server/account/conversation-*.mjs`），请求体上限 1 MiB；它们不在项目正文里，旧房间里的对话不会随房间搬。剧本存放位置我没追到，需要的人自己确认。
- **没有密码**：旧房间的成员、项目密码、创建者口令、邀请码都带不过去；用户已定提示把新项目链接发给旧成员、旧邀请码作废，有权搬的按账号算（页面一侧创建者判断是会话里的 `creator`）。
- 本机原文件里的 `collaboration` 描述（`roomId`、`service`、`where`）要有对应的新表示，否则重开文件仍按旧办法恢复；已被旧版本封锁的房间不会自己解开（第 5 节）。

### 9.5 做的时候会踩的坑
- 账号模式的云端组合里素材口地址是 `{ port: null }`，任何拼 `http://127.0.0.1:${assetAddr.port}` 的旧代码都得到 `127.0.0.1:null`。
- 夹具里的项目 `initialProject` 是 `{ tracks: [] }`，编辑器接上会因缺少 `fps` 等字段崩溃（`toFixed`）；探针用页面里造的完整空项目新建账号项目绕开。
- 桌面开发服务器里没有 Tauri 账号保险箱；探针（`scenarioC`）在页面里用替身 native，把 `recover`、`request` 转给 Node 侧发，账号办法的界面探针可以沿用。
- 浏览器直接连云端会遇到跨域预检；账号模式节点对 `/shared/*` 的 OPTIONS 也回 403，页面只看到 `Failed to fetch`。
- 探针和测试起账号节点：`server/test/fixtures/cloud-queue-user-path.mjs` 的 `startCloudQueueUserFixture`（要两个环境变量；`ports` 给 7 个、`agentPort` 一个；返回的 `ports.doc` 是不走 TLS 的文档服务口，`fixtureDir/doc` 是云端数据目录）。

## 基线

合 main（a0a322de 之后）后：
- `npx tsc -b --force`：退出码 0，无输出。
- `npm test`（设了两个环境变量）第一遍（合 main 之前）：6484 个用例、6463 通过；失败只有 `c66-integ.test.mjs` 里两个用例（已知机器忙时偶发，单独重跑 14 项含它全过）。
- 合 main 之后又跑全量：日志里有四处失败（`account-master-production`、`account-runner-process`、`agent-live-selection`、`asset-project-workers` 各一个用例），且日志没有末尾汇总行。把这四个文件单独重跑：`account-master-production`、`agent-live-selection`、`asset-project-workers` 全过；`account-runner-process`（「真实运行器在任务进程里」）两次单独重跑都失败（`send runner_message_3: selection-page-unavailable`，期望 202、实得 403），把我改的三个服务端文件换回 main 的版本再跑仍然失败，所以与本块无关，是合进来的 main 上的问题（来自上一块的新用例），请主会话核对。
- 本块 `server/test/move-guard.test.mjs` 5 个用例全过；`windows-hide-silent-spawn` 守门测试过（含新探针）。
- 探针两遍（修之前、修之后加旧模式对照）退出码 0，每遍前后查可见窗口无新增，收尾子进程均已关。
