# AGENT-bake-asset：`bake_card` 的卡片快照改走素材服务

分支 `claude/bake-asset`（起点 `claude/r7-merge` 的 `e4f6e8df`）。任务来自 `docs/plan/TODO.md`「语义与代码的差距」的「Agent 读素材的路径」剩下的最大一条，起点是 `docs/reports/AGENT-asset-path-2.md` 里 `bake_card` 的 dry run。

## 先看这里：接口与数据格式的改动

没有新增素材服务的 HTTP 接口，没有改二级语义。下面几处算改了对外可见的行为或数据格式，都按三级办、标〔裁〕（理由见「〔裁〕」一节）：

1. `bake_card` 与 3D 视图、预取拿到的快照地址从 `/@media/bake-<clipId>-<输入哈希>.png` 变成 `/api/asset/px/<内容哈希>`。工具描述没改（仍说「存进素材库，返回 URL」），用户看不出区别。〔裁〕1
2. 本机素材服务的 `GET /api/asset/px/<hash>`：本机没有这一块、且编辑器连着共享项目的远程素材服务时，先向远程取一次、校验入库再答；以前直接 404。路由、状态码、回包不变。按需拉取发出的请求带一个内部头 `x-promptcut-pull: 1`，收到它的素材服务不再往下拉（防两台互指成环）。〔裁〕4
3. 本机素材服务的 `px` 命名空间有了容量淘汰（在素材服务进程内部做，不开删除接口）。〔裁〕7
4. `/api/vision/bake-status` 回包里没渲过的项 `url` 为 `null`（以前总给算出来的 `/@media/…` 地址，页面只在 `bytes` 是数时才用它，所以页面不用改）。〔裁〕6

## 状态

全部做完，验证全过。代码、单测、探针、〔裁〕7（`px` 的容量淘汰）都已提交；类型检查、全量测试、代码指纹、G0-R 全套、新探针 `bake-asset-probe` 都跑过，每项一遍就过（结果见「验证」）。〔裁〕1～7 已由主会话审过认可。

## 提交

| 提交 | 内容 |
|---|---|
| `ad4777a1` | 文档：建本报告 |
| `b6541a04` | 修复：`bake_card` 的快照经素材服务写进 `px`、读回、盘点；「输入哈希 → 内容哈希」记在 `out/bake-index`；不再直接写、列、删素材目录；老地址不动，同键再要时读时迁移。测试 BKA-1～BKA-7 |
| `937ea76d` | 修复：共享项目里快照推到连着的素材服务；本机素材服务的 `px` 在本机没有时向远程按需拉取（带防成环的头）。测试 BKA-8、BKA-9 |
| `fe87fef7` | 文档：页面预取的注释跟上（`useBakePrefetch.ts`、`bakePlan.ts`，只改注释） |
| `89099fbb` | 测试：探针 `scripts/probes/bake-asset-probe.mjs`（P1～P7） |
| `cd342afa` | 文档：本报告（轻量部分） |
| `eb8c02b2` | 修复：本机素材服务的 `px` 按容量、按最近使用淘汰（`server/asset-store/px-evict.mjs`，接进 `asset-service.ts`）。测试 BKA-10～BKA-14 |

## 做了什么

### 字节与索引（`server/bake-store.mjs`，新文件）

- 快照 PNG 经素材服务客户端（`asset-store/client.mjs` 的 `put`）写进 `px` 命名空间，地址 `/api/asset/px/<sha256>`。素材服务按内容寻址：同一张图只存一份，第二次写入只是一次对账。
- 缓存键仍是 `bakeTarget` 算的 12 位输入哈希。它不等于内容哈希，所以另记一张小索引 `<导出目录>/bake-index/<键>.json`，内容是 `{ key, hash, bytes, width, height, clipId, name, at, pushed? }`。一个键一个文件，原子改名写入。编辑器进程（热备渲染器那条 `ui-render/bake-batch`）和预渲染进程共用它。
- **命中要问素材服务**：索引里有、且 `GET px/<hash>/chunks` 报 `complete` 才算命中（`mechanism/asset-service.md`「同步状态只问素材服务」）。素材服务里已经没有的，当场删掉索引条目，按没渲过处理。
- 盘点（`status`）限 8 个并发问素材服务；淘汰（`evict`）只删索引里对得上的键。
- 素材服务不可达或拒绝时抛 `BakeStoreError`（`kind: 'asset-service'`），消息写明地址与原因，例如 `素材服务不可达(http://127.0.0.1:5970/api/asset),卡片快照没能写入:…`、`素材服务拒绝了写入(…,HTTP 401):…`、`素材服务不可达:取不到素材服务的地址,卡片快照没能写入`。路由原样回 500 `{ ok:false, error }`，Agent 看得到原因。

### 预渲染一侧（`server/vision/bake.ts`、`bake-cache.ts`、`routes.ts`）

- `bakeOne`：命中查 `store.lookup`；没命中先做读时迁移（见「兼容」），再渲，渲好的字节经 `store.put` 入库。同键在飞合并（`bakeInFlight`）、优先级规则都不变。函数签名不变（`query-render.test.mjs` 按源码核对的那几行照旧对得上）。
- `bakeClip`：「哪些时刻还没有」改问索引加素材服务，老文件先迁，剩下的合成一趟渲。
- `bakeTarget` 不再回 `url`（地址要渲出来才知道），`name` 只留给读时迁移。
- `bake-cache.ts`：`listBakes` / `evictBakes` 改成读写索引，新增 `bakedOf`（盘点用）；不再 `import` 素材目录和 `node:fs`。
- `bake-status`：先按项目算出这次要的键，再问 `bakedOf`；`orphans`、`totalBytes`、`fileCount` 按索引算。`bake-evict` 删索引条目。`bake`、`bake-batch` 的回包形状不变。

### 共享项目（〔裁〕4、〔裁〕5）

- **推**：本进程登记了连着的远程素材服务时（`setBakeRemote`），快照写进本机素材服务之后再推一份过去，成功后在索引里记 `pushed: <基址>`；没推成的，下次命中时补推。预渲染进程登记的是推送队列按 D7 规则选定的那台（`vite-plugin-frames.ts` 的 `startArtifactPush`；D7 是渲染队列契约里「推送用哪一台素材服务」的选择顺序），编辑器进程登记的是上传队列的目标（`vite-plugin-media.ts` 的 `mediaTierService`）。选定的就是本机素材服务时不推。
- **拉**：别的成员的编辑器拿到卡片参数里的 `/api/asset/px/<hash>` 时，本机素材服务没有这一块，就向当前连接的远程取（`media-pull.mjs` 新增 `fetchRemoteArtifact`，带只读票据），校验 sha256 后经数据层入库再答（`asset-service.ts` 的 `pullArtifactInto`，同一哈希只拉一次）。非本机、没票据的读先被拒，不会替它去远程拉。

### 页面

`useBakePrefetch.ts`、`Scene3DView.tsx`、`bakePlan.ts` 只把 `url` 当不透明地址用，功能上不用改；只改了两处讲「磁盘上的 `out/media`」的注释。贴图地址是同源相对地址：编辑器进程挂着素材服务；预渲染进程的 `/api/asset/*` 经 `assetProxyPlugin` 转给编辑器，所以导出用的渲染器也取得到。

## 〔裁〕

- 〔裁〕1（三级）快照地址改成 `/api/asset/px/<内容哈希>`。语义要求预渲染产物进素材服务，`px` 是像素产物的命名空间（`artifact-transfer-contract.md` 第 1 节）。换成 `media` 命名空间也能跑，但会把产物混进素材索引，所以没选。
- 〔裁〕2（三级）「输入哈希 → 内容哈希」的索引放在 `<导出目录>/bake-index/`。按 dry run 的建议放在预渲染一侧：它只是缓存记录，不是字节，也不在素材服务的存储目录里。另一个方案是放在素材服务上的元数据里，但那要加接口，所以没选。
- 〔裁〕3（三级）页面预取的淘汰（`bake-evict`）只删索引条目，字节不经 HTTP 删。素材服务没有删除接口；加删除接口算改对外接口，而且同一张图可能被多个键、多个成员引用，删字节要先有引用计数。字节的回收交给素材服务自己的容量淘汰，见〔裁〕7。
- 〔裁〕4（三级）本机素材服务的 `px` 按需拉取，外加防成环的内部头。没有它，其它成员拿到 `/api/asset/px/<hash>` 只会 404，满足不了「共享项目里其它成员看得到同一份快照」。做法照 `media` 已有的按需拉取（`media-pull.mjs`），只是产物小，整件取、不边落盘边服务。
- 〔裁〕5（三级）推送是「写入后顺手推一份，失败了下次命中时补推」，没有持久队列。预渲染进程已有的推送队列（`artifact-push.mjs`）按帧库的段组织，快照不在帧库里，塞进去要改它的数据格式。
- 〔裁〕6（三级）`bake-status` 没渲过的项 `url: null`，理由见文首。
- 〔裁〕7（三级，主会话第一轮审查要求补）本机素材服务 `px` 的容量淘汰，照 `mechanism/platforms.md`「帧库」的思路定数字与时机（数字集中在 `server/asset-store/px-evict.mjs` 的 `PX_EVICT_DEFAULTS`）：
  - **范围**：只管 `px`（可再生的像素产物：卡片快照、轨道流分段、PNG 缓存帧）。淘汰器只拿到 `px` 那一个数据层，`media`（素材原件）和 `snap` 碰不到。只在 `px` 用缺省 fs 数据层时开；注入了自己的数据层的（托管组合）不开；`PROMPTCUT_PX_EVICT=0` 关。
  - **上限**：缺省 10 GiB；所在磁盘总容量小于 500 GiB 时取总容量的 2%；`PROMPTCUT_PX_CAP_BYTES` 可改（测试、排查用）。帧库是 50 GiB / 10%；`px` 里主要是几十 KB 一张的快照和推送用的分段，取帧库的五分之一。
  - **最近使用**：素材服务每答一次这一块（取回、对账、收尾）就记一次使用时刻，攒 30 秒写进 `<px 目录>/.usage.json`，淘汰前也写一次；没记过的取文件修改时刻。「正在被索引引用」没有另做判据：卡片快照的索引每次命中、页面每轮盘点（4～60 秒一次）都会问对账，还在用的快照自然一直是新的。这样素材服务不用读预渲染一侧的索引，不带项目语义。
  - **淘汰**：总量超过上限时，按最近使用时刻从旧到新删，删到上限的 90%；30 分钟内用过的不删；删不掉的（文件被占用）跳过，下一轮再试。经数据层的 `list` / `stat` / `remove` 动字节。
  - **时机**：启动后等 2 分钟判第一次；之后每次 `px` 有新块入库时判，最多每 5 分钟一次。
  - **多进程**：同一个 `px` 目录可能被几个进程的素材服务同时管（编辑器、无头实例）。判淘汰前独占创建 `<px 目录>/.evict-lock`，拿不到就跳过这一轮；锁文件超过 3 分钟没更新算死锁，删掉再拿；做完就放。帧库是「一个进程常驻做、心跳 1 分钟」，这里只在判的那一刻拿锁，因为 `px` 没有要常驻维护的使用索引。
  - **淘汰之后**：卡片快照再被要时，索引问对账得到「没有」，删索引条目、重渲（BKA-13）；流与帧的拉取方照旧当没有。
  - 托管端、远程素材服务（NAS、云端）的容量不在本段范围：托管组合注入自己的数据层，不开这个淘汰。

## 兼容（老项目里存着的 `/@media/bake-….png`）

- 素材目录里以前落下的 `bake-*.png` 一个不删、一个不动。素材服务的老读路由 `/@media/<文件名>`（`vite-plugin-media.ts`）照旧答它们，所以老项目参数里的地址照常能取，导出也照常能取（预渲染进程经代理走同一条路由）。
- **读时迁移**：同一个键再被要时（Agent 再调 `bake_card`、3D 视图、预取），先经素材服务的老读路由 `GET /@media/bake-<clipId>-<键>.png` 取一次。这是走接口，不是读目录。取到的是 PNG，就推进 `px`、记进索引，回新地址，不重渲。取不到（404）或不是 PNG 才渲。只认 `bake-…png` 形状的名字，不能拿来读任意文件。
- 这些旧文件不再计入盘点，也不再被淘汰删掉（以前 `evictBakes` 会删），会一直留在素材目录里。

## 验证

已跑（每次只跑一个测试文件，`node --test`，需要的带 `--experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs`，与 `npm test` 的参数相同）：

| 项 | 结果 |
|---|---|
| `server/test/bake-store.test.mjs`（新，BKA-1～BKA-14） | 14 过 0 失败 0 跳过，退出码 0 |
| 加淘汰后重跑 `asset-namespaces` / `asset-service` / `media-pull` / `asset-client` / `asset-store-http` / `c66-fetch` / `c66-upload` / `c66-integ` / `artifact-transfer` / `artifact-push` / `perception-asset-path` / `collect-plugin` / `sp-hosting` / `blob-store-conformance` | 6 / 12 / 11 / 6 / 6 / 9 / 4 / 6 / 8 / 7 / 10 / 17 / 14 / 47 过，均 0 失败 0 跳过 |
| `query-render.test.mjs` | 16 过 0 失败 |
| `asset-namespaces` / `asset-service` / `media-pull` / `asset-client` / `asset-store-http` / `c66-fetch` / `c66-upload` | 6 / 12 / 11 / 6 / 6 / 9 / 4 过，均 0 失败 |
| `artifact-push` / `media-tiers` / `queue-node-wiring` / `query-render-2` / `m7-uploader` / `local-origin` / `env-fingerprint-keys` / `media-hash` / `vision-media-source` / `render-host` / `ai-visual-shared` / `audio-asset-path` / `collect-plugin` / `c66-integ` / `artifact-transfer` | 7 / 14 / 11 / 11 / 4 / 6 / 18 / 11 / 3 / 11 / 3 / 8 / 17 / 6 / 8 过，均 0 失败 0 跳过 |
| 代码指纹 `snapshotCode` / `captureCode` | `00a5264bf8a062ff6e0b5ed0516cccd1` / `86e443cb6fa838aef64788af6822fd68`，与基准相同 |
| 改到的服务端 TS 用 typescript 逐个转译（查语法）、`.mjs` 用 `node --check` | 全部通过 |

单测用例（BKA = bake asset）：

- BKA-1：PNG 经真 HTTP 的素材服务（fs 实现）写进 `px`，地址按 sha256，取回字节相同，再查命中；素材目录里没有 `bake-*.png`，索引目录里只有 `<键>.json`；
- BKA-2：索引里有、素材服务里没有，按没渲过处理，并删掉索引条目；
- BKA-3：老地址照常能取；读时迁移经老读路由把旧文件推进 `px`，字节相同，旧文件不动；不是 PNG 的不迁；名字不像老格式的不去取；
- BKA-4：素材服务不可达、拒绝时回清楚的错，分三种：取不到地址、连不上、401；
- BKA-5：盘点只报收全的；淘汰只删对得上的键，字节还在；
- BKA-6：写入后推到远程；推失败时下次命中补推；
- BKA-7：源码守门，`bake.ts` / `bake-cache.ts` 不引 `mediaDir`，也不引 `node:fs`；
- BKA-8：另一个成员的本机素材服务按需拉取；远程也没有时照旧 404；拉回的字节不对时不入库；`pullArtifact: null` 能关掉；非本机、没票据的读先 401；防成环（远程那台自己也指着自己，不等超时）；
- BKA-9：登记的「远程」就是本机时不推；
- BKA-10：淘汰计划（纯函数），超上限按最近使用删到 90%，保护期内的不删，没超不删；上限的三种取法；
- BKA-11：真的素材服务（fs）里 `px` 超上限，按最近使用删到 90%（刚取过的那块留下），比上限大得多的 `media` 原件一个字节不碰；
- BKA-12：30 分钟保护期内的不删；锁被别人拿着就跳过，死锁 3 分钟后接手；
- BKA-13：快照被淘汰后再要，索引问对账得到「没有」，删索引条目，回到重渲那条路；
- BKA-14：注入了自己的 `px` 数据层、`pxEvict: null`、`PROMPTCUT_PX_EVICT=0` 时都不开。

重的验证（主会话发「可以跑重活」之后，提交 `c86d6b4b`；另一个子 Agent maint-3 同时在这台机器上用 5990～6009 跑重活，带耗时门槛的项只作参考）：

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 0 错误，退出码 0 |
| 全量测试 | `npm test` | tests 4145、pass 4143、fail 0、cancelled 0、skipped 2，退出码 0 |
| 代码指纹 | `snapshotCode` / `captureCode` | `00a5264bf8a062ff6e0b5ed0516cccd1` / `86e443cb6fa838aef64788af6822fd68`，不变 |
| G0-R 导出确定性 | 自己起 dev server（5980，`PROMPTCUT_NO_PORT_FILE=1`），`node scripts/verify-determinism.mjs --url "http://127.0.0.1:5980/?export=1"` | 1800 / 1800 相同，退出码 0（单遍导出 210.7 s，整段 609 s） |
| G0-R 与基准逐像素 | 本分支的 `out/verify-a/frames` 与 `.worktrees/main-g0r/out/verify-a/frames` 逐帧解码比 RGBA | 1800 帧相同，不同 0、缺 0、多 0 |
| G0-R 快照重放 | `PC_FRAME_TEST_URL=http://127.0.0.1:5980 node scripts/verify-unified-frames.mjs` | PASS，退出码 0 |
| G0-R 流式生产 | `stream-produce-probe --origin …5980`；再加 `--group` | 两种都 PASS、`fails: []`、退出码 0；分段编码 p50 279 ms（门槛 300 ms，参考） |
| G0-R 预览退回 | `preview-fallback-probe --origin …5980`；再加 `--page-preload` | 两种都 PASS、`fails: []`、透明拍 0，退出码 0 |
| G0-R 就绪索引 | `ready-index-probe --port 5984` | `fails: []`，退出码 0 |
| 查询渲染 | `query-render-probe --port 5987` | `fails: []`，退出码 0 |
| 新探针 | `bake-asset-probe --port 5970`（远程计数服务 5975） | 通过 33、失败 0，退出码 0 |

`bake-asset-probe` 的要点：

- P1：`bake_card` 回 `/api/asset/px/b8633179…`，渲一张 11.2 s。预渲染进程的推送队列建起来了（`push.started {"docservice":"editor","asset":"http://127.0.0.1:5975/api/asset"}`），计数的远程素材服务收到了这一块的分片与收尾，从它那儿读回的字节相同。素材目录里没有 `bake-*.png`，索引记着这个内容哈希。
- P2：同样的参数再要，`cached`，32 ms。
- P3：3D 视图那条路（编辑器进程）也推到了远程（日志 `bake.pushed`），页面加载得出图。
- P4：预取的盘点、批量、淘汰都照常；淘汰之后字节仍取得到。
- P5：老地址照常能取；同一个键再要走读时迁移，123 ms，不重渲，内容哈希就是旧文件的。
- P6：scene-3d 贴上 px 地址的贴图后，渲出来与不贴时不同（`60786e76…` 对 `ad52e7d8…`），渲染器取到了贴图。
- P7：只在远程上的 PNG，页面按 `/api/asset/px/<hash>` 加载得出来，是 40×30；第二次是本机命中。

跑完只停了自己起的进程：5980 的 dev server 用 `taskkill /T` 结束，探针各自收尾；5970～5989 上没有残留监听。

## 没做成的、局限

- **托管端、远程素材服务的 `px` 仍没有上限**：本段只给本机素材服务加了淘汰（〔裁〕7），托管组合注入自己的数据层，不开。要不要给托管端加、数字多少，另定。
- 淘汰器的锁与使用记录都放在 `px` 目录里，是按目录的；如果以后本机素材服务的 `px` 换成非 fs 的数据层（没有 `list`），淘汰不开，要另写。
- **在线浏览器模式**（没有本机编辑器进程）：卡片参数里的 `/api/asset/px/<hash>` 不会被换成远程素材服务的绝对地址（`mediaTier.ts` 的 `remoteMediaUrl` 只认 `/@media/<hash>`）。改前的 `/@media/bake-….png` 在那种模式下同样取不到，所以不是这次改坏的，只是没顺手补上。
- 推送没有持久队列（〔裁〕5）：进程在推完之前退出，下次命中这个键时才补推。别的成员如果先要这一块，在补推之前看不到。
- 探针 P1 的「远程收到推送」依赖预渲染进程建起推送队列：要 `PROMPTCUT_PUSH=1` 加上编辑器里挂的文档服务（J.12，渲染队列契约里「编辑器里的文档服务只在显式打开推送时才算」那一条）。实跑确认建起来了（`push.started`）。缺省的开发环境不设 `PROMPTCUT_PUSH`，只有共享项目或显式打开时才推，这一点与 C6.4 的口径一致。

## 更正建议（语义文件没改，以下是 dry run）

- `docs/plan/TODO.md`「Agent 读素材的路径」
  - 改前：剩 `bake_card`（产物直接写素材目录）……
  - 改后：`bake_card` 已改（`claude/bake-asset`：产物进 `px`、输入哈希到内容哈希的索引在 `out/bake-index`、老地址读时迁移）；剩配音试听、音色设计 / 复刻试听；另记「`px` 没有容量淘汰」一条待定。
- `docs/semantics/mechanism/asset-service.md` 加一节「预渲染产物的容量」（三级，〔裁〕7）
  - 改前：（无）
  - 改后：「本机素材服务里的像素产物（`px`）可再生，有容量上限：缺省 10 GiB，所在磁盘总容量小于 500 GiB 时取总容量的 2%。素材服务每答一次某块就记一次使用时刻；总量超过上限时按最近使用从旧到新删，删到上限的 90%，30 分钟内用过的不删。启动 2 分钟后判第一次，之后在有新块入库时判，最多每 5 分钟一次；几个进程管同一个目录时只让拿到锁的那一个做。素材原件与 HTML 快照不在此列。淘汰在素材服务内部做，不对外提供删除。托管端与远程素材服务的容量另定。」
- `docs/semantics/mechanism/asset-service.md`「本地内容库」之后加一条（三级）
  - 改前：（无）
  - 改后：「本机素材服务在本机没有某块预渲染产物、且连着远程素材服务时，向远程整件取一次、校验入库再答；按需拉取发出的请求带标记，收到的素材服务不再往下拉。」
- `docs/semantics/mechanism/asset-service.md`「预渲染的产物」加一条（三级）
  - 改前：（只有「认领任务的渲染节点先推送再报完成」）
  - 改后：加「不经任务队列的单张卡片快照（`bake_card`、3D 视图的贴图）按输入哈希缓存，输入哈希到内容哈希的对应由产出方本机记着，命中仍以素材服务的对账为准。」

## 需要主会话决定的事

1. `px` 的回收：已按主会话第一轮审查补上容量淘汰（〔裁〕7），数字已认可；托管端、远程素材服务的容量由主会话另记 TODO。
2. 合并（`--no-ff`）还是返工。

## 主会话审查（2026-09-30，笔记本主会话）

- 审过 `server/bake-store.mjs`（快照写进 `px`、输入哈希到内容哈希的索引、命中以素材服务的对账为准、老地址读时迁移）、`server/asset-service.ts` 的按需拉取（核 sha256、同一哈希只拉一次、失败都当没有回 404、防成环的内部头）与 `server/asset-store/px-evict.mjs`。托管组合注入自己的数据层，所以托管端既不按需拉取、也不开淘汰，行为不变。
- 主会话要求补本机 `px` 的容量淘汰（以前这些快照在素材目录里有页面的预算管着，改走素材服务后不能没人管上限），已做，〔裁〕7 的数字认可（10 GiB、小盘 2%、删到 90%、30 分钟保护、锁 3 分钟）。〔裁〕1～7 照留，待用户审。
- 采纳语义 dry run：`mechanism/asset-service.md` 补单张快照的缓存、按需拉取与「预渲染产物的容量」一节（三级〔裁〕，措辞略缩）。托管端与远程素材服务的产物容量另记 TODO。
- 主会话在集成分支 `claude/r8-merge`（本分支加 `claude/maint-3`）上重跑整套，`bake-asset-probe` 33 项全过，其余见 `docs/reports/REPORT-post-M8.md` 第 8 轮。合入 main `ec983fc0`。
