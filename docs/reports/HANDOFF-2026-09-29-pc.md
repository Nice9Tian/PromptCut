# 主会话交接（2026-09-29 第六次，PC →「PromptCut M5～M8 开发交接」）

PC 上的主会话「PromptCut 主会话（PC）」按用户 2026-09-29 的 goal 把主会话交回笔记本上的「PromptCut M5～M8 开发交接」，交接后待命，直到用户明确说恢复。格式照 `PAUSE-2026-09-26.md`（同 `HANDOFF-2026-09-28-pc.md`）。本文不含任何令牌或密钥；取法见各机的 `docs/local.md`。

阶段：`HANDOFF-2026-09-29.md`（第五次交接）第 3 节的 0.7.2 已出完；之后在做第 4、6 节的遗留与性能缺陷（本文叫「第 2 轮」），以及主计划「M8 之后、团队测试之前：存储占用」。两者的代码都在分支上，**都没合入 main**，按 goal 不再审、不合入，留给接手方收尾。本轮的汇总报告是 `docs/reports/REPORT-post-M8.md`（目前只有第 1 轮）。

用到的代号：G0 / G0-R = 通用基线与渲染基线（`guide_files/verification.md`、主计划第 8 节）；六项 = 在线用户卡第二轮的六项修复（`HANDOFF-2026-09-29.md` 第 2 节）；UC2-1 = 本轮发给笔记本辅助节点、因它待命而搁置的指令；frameCode = 渲染代码版本（`server/frame-code.mjs`，桌面节点只认领代码版本相同的在线计划）；inputSig = 层表每层的片段输入签名（stale-layer 引入）；〔裁〕= 会话定的、待用户审的决定。

## 1. 本轮已完成并合入 main（main = release = 交接提交之前的 `35f1fddd`）

| 事项 | main 提交 | 报告 |
|---|---|---|
| **0.7.2**：`--no-ff` 合 `claude/uc2-candidate`（六项）；审 diff 时发现并修了 0.7.1 就有的缺陷——卡片源码静态解析遇到没闭合的 `\u{` 无限循环（在线页面同步到这样的源码会卡死、内存耗尽）；版本号 0.7.1 → 0.7.2（外壳 0.2.6） | `db7aa05e`、`2fbe038d`（修复分支 `claude/card-parse-escape` `c0401057`）、发版 `3aa859e3` | `REPORT-post-M8.md` 第 1 轮（`76eee894`） |
| 存储占用的计划与语义 dry run | `e3a5726a`（`docs/plan/storage-plan.md`，`TODO.md` 指向它） | 计划本身 |
| 探针与测试不再覆盖公共 `%TEMP%\promptcut\port.json`（`PROMPTCUT_NO_PORT_FILE=1`；以前探针起的编辑器会把用户的 MCP 工具调用引过去）；`asset-lan-probe` 先按局域网发现取地址；探针判法三处（`--assert-no-lan` 改为基线排除、`cloud-untouched` 按本轮项目查、`real:tasks` 门槛按片段数） | `35f1fddd`（`claude/probe-hygiene`） | `docs/reports/AGENT-probe-hygiene.md`（已在 main，未归档） |

**0.7.2 的出法与现状**：

- 基线：`2fbe038d` 上 tsc 0、`npm test` 3856 / 3854 / 0 / 2、构建成功；G0-R 在 `db7aa05e`（代码只差那处解析修复）上全过：导出确定性 1800/1800、与 PC 像素基准 `pc-g0r-base`（`d70fce77`）1800 帧相同、快照重放 PASS、`ready-index` / `stream-produce`（含 `--group`）/ `preview-fallback`（含 `--page-preload`）全过。在线探针（PC 本机替身）：`c10-browser-probe --user-card --only-a4 --no-video` `ok`（用户卡那一步 686.7 s）、`online-user-cards-probe` `ok`、`c10-ui-probe` `ok`（第一次误挂 A7 是 `port.json` 串扰，换端口重跑过；后来的 `claude/probe-hygiene` 修了根因）；阿里云真机路径 `desktop-auto-node-probe --remote` `ok`（458 s，项目已删）。
- **线上 `/editor` = 0.7.2**：`index-lRHxl2a9.js`（`index.html` sha256 `43d471a0530f…`），嵌代码版本 `57568600294c…`，与桌面 0.7.2 一致；主站与 `s1.` / `s2.` 两个舞台子域都是它；上一代 `index-ClP9A_pp.js` 的 assets 保留一代；运行配置 `{"v":1,"stageOrigins":[s1, s2]}`。
- **补丁**：PC 主工作区 `desktop\release\PromptCut-patch-0.7.2.exe`，12,413,364 字节，SHA-256 `22da3bf659f3ad344ec9196970b8fe38e9bb37668b2c33fe5531ad3613cecbe1`；`manifest-0.7.2.json` 基准 0.7.1、外壳代次 0.2、不含依赖（0.7.0、0.7.1、0.7.2 三份清单依赖哈希相同，可从 0.7.0 直接装）。
- **用户还没有装 0.7.2**（已播报通知，未见回复；复测结果没有回来）。0.7.1 及更早的桌面节点不认领 0.7.2 在线页面发的计划（代码版本不同）。

## 2. 进行到一半（都在分支上，都已推 origin，都没合入 main）

### 2.1 第 2 轮：遗留与性能缺陷

| 分支 | 最后提交 | 做什么 | 现状 |
|---|---|---|---|
| `claude/stale-layer` | `ff4a2ce4`（2.3 节） | `HANDOFF-2026-09-29.md` 第 4 节第二条：在线页面改了参数后不再贴旧参数的层。层表每层带 `inputSig`（`src/render/layerInputSig.mjs`，节点与页面共用），页面按当前项目比对；过期后 15 秒内按「结果在路上」显示沙漏，过了按没有结果；导出也不取旧层；契约 `c10-contract.md` 第 9、18 节、`m7-contract.md` D12〔裁〕 | 子 Agent 报：单测、G0-R、`online-stale-layer-probe`、`c10-ui-probe`、`online-user-cards-probe` 都过。**但合进集成分支后 `c10-browser-probe` 用户卡那一步挂了**（见下） |
| `claude/push-scope` | `d848a3ac` | 第 4 节第三条：推送只推绑定项目的产物（`server/push-scope.mjs`，按项目分目录的推送队列，本机节点只为绑定项目发布计划）；老的环境变量路径第一次推送前等登记最多 10 s（`server/asset-select.mjs`）；共享配置可选 `contentId`；契约 `render-queue-contract.md` J.13 补充、新 J.14，`auth-contract.md` 第 11 节〔裁〕 | 子 Agent 报 G0、G0-R、`desktop-auto-node-probe` 两遍全过；主会话在集成分支上复核了 A7（另一个本机项目 120 帧、漏进共享项目素材服务 0 块） |
| `claude/r2-merge` | `2e4b9d48` | 集成分支：main `35f1fddd` + `--no-ff` stale-layer（`b9322dee`）+ push-scope（`b9d4b614`）+ `mechanism/rendering.md` 补「旧输入的层不贴」〔裁〕 | **主会话跑过**：tsc 0；`npm test` 3895 / 3893 / 0 / 2；构建与在线构建成功（`index-CgnR9oYS.js`，frameCode `89dcfbdc…`）；G0-R 全过（导出确定性 1800/1800、像素 1800 相同、快照重放 PASS、`ready-index` / `stream-produce` 两种 / `preview-fallback` 两种都过）；`desktop-auto-node-probe`（本地两遍含 A7）`ok`；`online-user-cards-probe` `ok`；`c10-ui-probe` `ok`。**挂 1 项**：`c10-browser-probe --user-card --only-a4 --no-video --base-port 5690` 用户卡那一步超时（1692 s）——成员页从头到尾没贴上桌面节点渲的用户卡层，最后一直是「需要本地 PC 渲染辅助」图标加徽标，成员页在线来源里这张卡的层是空（`online: null`）。同一探针在 0.7.2 上是过的。怀疑是 inputSig 两边对不上（这个探针里用户卡是成员页自己加的、渲染节点是创建者那台走环境变量的桌面），已让 stale-layer 子 Agent 去查。**没跑**：`online-stale-layer-probe`（主会话的脚本漏传 `--dist`，1 秒就退了，要带 `--dist <在线构建>` 重跑） |
| `claude/uc-latency` | `8b3fd44c`（2.3 节） | 第 4 节第一条、第 6 节第 1 条：浏览器里用户卡要等桌面节点几分钟 | 两处根因已修、PC 上前后对比做了一部分，见下与 2.3 节；没合入任何合流分支 |

**uc-latency 在查什么、进展**（报告 `docs/reports/AGENT-uc-latency.md`，在它的分支上）：

- 分解了「在线页面发布清单计划 → 桌面节点认领 → 渲 → 推 → 写层表 → 页面贴上」：PC 上改前 `desktop-auto-node-probe` A4 中位数约 230 s，页面发布、认领都在 4 s 内，层表齐到页面贴上不到 0.1 s，**时间全在桌面节点渲那两段上**。
- 根因一（已修，`ba74f3a7`）：A4 里总有一段慢 5～8 倍——预渲染进程主线程被整段预览视频的 PNG 解码、合成、编码占满（换页时取模块几十秒取不完），挪到 worker 线程。
- 根因二（已修，`78d36cdf`）：队列细任务每 4 帧换一页、每批从挂载帧从头回放，改成一段一趟顺推（换一次页、回放一次），另有单测 QSP4～6 与顺推对照探针（`1ed86bd9`、`19ceae14`）。
- 另修：`desktop-auto-node-probe`、`c10-browser-probe` 收尾不再挂住；诊断行 `executor.render-timing`（只记日志）。
- 这支子 Agent 在 18:46 一度把 A4 计时误写到 PC 主工作区的 `desktop-auto-node-probe.mjs`（主会话已还原，备份在主会话 scratchpad），之后只用 worktree。
- 改后的前后对比、G0-R、笔记本复核（它是带耗时门槛的项，以笔记本为准）是否做完，以它交接时的报告为准。

**第 2 轮还没派的**（第二批，出处都在 `HANDOFF-2026-09-29.md` 第 4 节引到的 `REPORT-render-queue-m8.md` 第 13.5 节、`REPORT-M5-M8.md` 第 7.4 节）：代码注释里 41 处旧 `docs/reports/AGENT-…` 路径（`claude/probe-hygiene` 的子 Agent 留着第 4 项等通知）；`SWAP_MS` 按卡种实测；在线舞台握手成功后又断的处理；区分自然进场与从卡中间开始播放；页面只是忙也会被 D2 接手；执行器不标 `snapshotOversize`；舞台互换的生成快照缺互换剧本；探针 `PC_CHROME_ARGS` 别关 TLS 校验的用法说明；纯浏览器节点经公网锚点段 33～37 s；静态解析跨文件引进来的控件。只记录、不修的（理由见各出处）：与 0.7.x 混用的两条、L18、旧版独立主机不产小尺寸、跨节点去重多推约 60 块、云端检出旧、C3 `m8c3c` 17 分钟没领到任务、`claude/join-error` 待用户审。

### 2.2 存储占用（计划 `docs/plan/storage-plan.md`，已在 main）

| 分支 | 最后提交 | 内容 | 已验证（子 Agent 报，主会话核过的另注） |
|---|---|---|---|
| `claude/storage-leaks` | `8df0dabb` | 计划 A 部分（泄漏修复，三级）：`playback-*.mov` 用完即删、中止的 tmp 影片当场删、死进程的溢出目录与临时文件启动时清、导出结束后删中间文件（只留 `preview.mp4`、`overlay.mov`、`project.json`）、同秒导出加 `-2` 后缀、`export-vision-*` 遗留清、导出对话框文案改成实话（`server/storage-leftovers.mjs`） | 单测；实导 3 个项目改前改后成片与透明层逐字节相同；G0-R 全过 |
| `claude/storage-cap` | `477191c0` | 计划 B 部分服务端：帧库使用索引（`usage.json`）、上限、按最近使用淘汰、清理缓存、`/api/storage*`（`server/frame-library-storage.mjs`、`server/storage-routes.mjs`）；多进程只一个进程做淘汰（`.storage/owner.json` 心跳） | 单测 21 条；`storage-cap-probe` 两遍 `ok`；G0-R 全过 |
| `claude/storage-ui` | `ef0f07b2` | 计划 B 部分界面：开始页「存储」一块、标题栏「存储…」、`/api/exports*`（`server/exports-list.mjs`、`server/vite-plugin-exports-list.ts`） | 单测 10 条；`storage-ui-probe` `ok`；主会话看过截图 `u5-storage-mocked.png` |
| `claude/storage-semantics` | `14f14718` | 语义：`workflow/project.md`（开始页「存储」、导出后只留成片与透明层）、`product/platforms.md`（预渲染缓存、清理缓存、导出产物）、`mechanism/platforms.md`「帧库」、`glossary.md`「帧库」，全部标〔裁〕 | 文档 |
| `claude/storage-semantics-2` | `79369f2a` | `mechanism/platforms.md`「帧库」按实现修订（GB 按 1024³、24 小时全量重扫、启动 2 分钟后才判淘汰、多进程、遗留形态与时机、推送段遇已删键直接丢、60 秒刷新占用） | 文档 |
| `claude/storage-merge` | `a852d4a1` | 合流：`claude/r2-merge` + 上面五支 + 接成一体（导出目录规则只留一份、`/api/storage` 的导出一栏用 `summarizeExports`、每次判淘汰时清遗留、推送段遇已删键记 `push.evicted` 丢掉、GB 按 1024³、`GET /api/storage` 数字过期时后台重量）；报告 `docs/reports/AGENT-storage-merge.md` | 子 Agent 报：tsc 0；`npm test` 3952 / 3950 / 0 / 2；构建成功、在线构建没有 `/api/storage`、`/api/exports` 调用；两个存储探针用真接口 `ok`；实导一次只剩三样、能在列表里删；G0-R 在第一轮全过（第二轮只改了单位与刷新，没再跑）。主会话看过截图 `u8-fresh-bytes.png`（真接口：「5.0M / 上限 50.0G（缺省）」、导出 3 份） |

**存储占用没验证的**（主会话没自己重跑）：`claude/storage-merge` 上的 G0 与 G0-R；它继承了 `claude/r2-merge` 的 `c10-browser-probe` 回归，**合入前必须先修掉**；真机（用户 PC）上看开始页「存储」、清一次缓存（待用户项）。

**存储占用的〔裁〕**（播报过、用户可推翻）：入口放开始页第五块与标题栏「存储…」；导出结束后删逐帧图片等中间文件；缺省上限 50 GB（磁盘小于 500 GB 取 10%，下限 5 GB，都按 1024³）；30 分钟、10 分钟、2 分钟、5 分钟、24 小时、60 秒这些时间数。

**装上后的第一次运行**（发版时要写进给用户的通知）：用户 PC 的帧库约 282 GB，装上带存储占用的版本后，启动约 2 分钟会按 50 GB 上限一次清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。

### 2.3 收尾交代（交接时让在途的两个子 Agent 做到可提交处提交后停下）

- **stale-layer**（最后提交 `ff4a2ce4`，报告第 8 节）：这个回归**不是签名两边对不上**——它自己的分支上同一个探针 `ok`（用户卡 522 s 贴上），节点写层表算的签名与成员页算的都是 `i1-7d741a8c3803f58e`；在 `claude/r2-merge` 上复现跑到一半按交接停下，停下时成员页的可用层里有用户卡、两边签名一致，环境变量路径的共享配置没写 `contentId` 所以 push-scope 不限范围、层表照写。剩下两种可能都没验证：① 字节或清单没按时到——端到端本来要 520 s 左右，主会话那一轮机器上同时跑着好几个子 Agent 的探针，用户卡那一步 1203 s 撞上 1200 s 时限；② push-scope 把段扣住或推晚了。补了单测 SIG-7（节点侧对项目的加工不改签名）。下一步：在 `claude/r2-merge` 上机器空闲时重跑，失败后看成员页 `__pcOnlineSnapshots()` 的 `stale`、`skipped` 与那一层的 `ready`，和创建者推送队列统计里的 `outOfScope`、`deferred`、`layerMapsOutOfScope`。加单测之后没重跑 tsc 与 `npm test`（只加了测试）。
- **uc-latency**（最后提交 `8b3fd44c`，报告 `docs/reports/AGENT-uc-latency.md`）：
  - 根因一（`ba74f3a7`）：预渲染进程在自己那趟后台预渲染末尾出预览视频，用 `pngjs` 在主线程逐帧解码、合成、编码，CPU 剖析里超过 70% 的主线程时间在它；这段时间换页取模块几十秒，一段 60 帧从约 22 s 拖到 170～210 s。挪到 worker 线程（`server/bakery/frame-video-worker.mjs`），起不来时退回原路，单测核过产出逐字节相同。
  - 根因二（`78d36cdf`）：队列细任务每 4 帧开一个新页、从头回放；改成一段 60 帧一趟（换一次页、回放一次），画布重卡与桌面播放头要过的段仍按 4 帧一批；开关 `PROMPTCUT_QUEUE_SINGLE_PASS=0` 关掉。等价性（`queue-single-pass-probe`，19 张共享卡）：14 张 120 帧逐字节相同（含用户卡），`lottie` 像素相同，`particles` 仍按批；`mu-word-rotate` 不同——原来按批的产出从第 32 帧起就与正常逐帧活渲对不上，一趟顺推在不同的 84 帧里有 79 帧与活渲一致；两张基于计时器的测试卡两种做法都不确定。**这一条改变个别卡的队列产出，且与计划文档 `docs/plan/queue-executor-design.md` 第 3 节的写法相反，留不留要接手方定**（不留就设开关为 0 或撤 `78d36cdf`，只留根因一约 3.9 倍）。
  - PC 上的前后对比：A4（改动 → 贴上）6 遍改前中位数 230 s → 改后 26.2 s / 21.2 s（约 9～11 倍）；只修根因一 59.5 s；A3（成员进项目 → 贴出用户卡）105 s → 40.8 s / 36.9 s；一段 60 帧 22～27 s → 7.1～11.1 s；`c10-browser-probe` 用户卡那一步 686.7 s（0.7.2 数）→ 75.3 s / 75.3 s。
  - **没验的**：三遍改后的 `desktop-auto-node-probe` 里有一遍 A4 卡了 30 分钟（节点连着、空闲、一直没认领新计划），原因没查明，当时探针不记等待，之后 `a5301a54` 让探针每处等待都记一行，重跑因端口没释放没起来——**用根因二之前要先复查这一条**；`c10` 的第三遍改后与三遍改前没跑；`npm test`、G0-R、笔记本复核都没跑（改了预渲染与队列执行，G0-R 必跑；耗时以笔记本为准）。只跑了 tsc 0、新单测 9 条、核过共享快照键不变（`snapshotCode` 仍是 `00a5264bf8a0…`；排障时加在 `server/bakery/chrome.mjs` 的日志已撤，它在快照键里）。
  - 它提的另立任务：`mu-word-rotate` 第 32 帧起与导出对不上影响所有预渲染路径；队列与推送队列都推同一块、素材服务回 400（push-scope 的范围）；节点一次只渲一段。
  - 这支子 Agent 早先用 .NET 相对路径误写过一次主工作区的 `desktop-auto-node-probe.mjs`（主会话已还原）；storage-cap 也误写过一个空文件与一次原样写回（主会话已删、内容没变）。

## 3. 接手后按顺序要做的事

1. **修 `c10-browser-probe` 用户卡回归**：看 stale-layer 子 Agent 的收尾报告（分支见文末），在它的修复上重跑 `c10-browser-probe --user-card --only-a4 --no-video` 与 `online-stale-layer-probe --dist <在线构建>`（都要过），再合进 `claude/r2-merge` 与 `claude/storage-merge`。
2. **uc-latency 收尾**：先复查改后 A4 卡 30 分钟那一遍（探针现在每处等待都记日志）；定根因二（一段一趟顺推）留不留（2.3 节）；补 `npm test`、G0-R、`c10-browser-probe` 的改前改后各三遍，耗时在笔记本复核；过了再合进合流分支。
3. **最终合流验证**（在 `claude/storage-merge` 加上面两处之上）：G0；G0-R；探针 `desktop-auto-node-probe`（两遍）、`online-user-cards-probe`、`c10-ui-probe`、`c10-browser-probe --user-card`、`online-stale-layer-probe`、`storage-cap-probe`、`storage-ui-probe`；看开始页「存储」截图。全过后 `--no-ff` 合入 main、判 release；把本轮的 `AGENT-*` 报告归档到 `docs/archive/agent-reports/`；写 `REPORT-post-M8.md` 第 2 轮。
4. **出 0.7.3**：版本号（根目录 `package.json` 与 `package-lock.json` 两处）0.7.2 → 0.7.3、外壳 0.2.6；部署 `/editor`（先在服务器备份 `editor/` 与 `runtime-config.json`，上传到 `/opt/promptcut-hosted/.incoming-editor` 后执行 `server/hosted/deploy.mjs` 的 `editorSwapLines()`，**不要**用会连带重部署托管服务的 `deploy-hosted --editor`；核三个地址的 index 与代码版本、无头打开无页面错误）；`desktop-auto-node-probe --remote`；PC 上出补丁（`cd desktop && npm run release -- --from-head --patch-only`，基准清单 `manifest-0.7.2.json` 在 PC 主工作区 `desktop\release\`）；通知用户（含 2.2 节「装上后的第一次运行」）。
5. 第二批遗留（2.1 节末）。
6. 手动起 dev server 做验证时带 `PROMPTCUT_NO_PORT_FILE=1`；`verify-unified-frames` 要在**不设** `PROMPTCUT_EXPORT_DIR` 的 dev server 上跑（它把测试视频写在仓库的 `out/media`）。

## 4. 待跨机复核、待用户项、待修的性能缺陷

- **待跨机复核**：0.7.2 的带耗时门槛项在笔记本复核（`ready-index-probe`、`stream-produce-probe` 含 `--group`、`preview-fallback-probe` 含 `--page-preload`，以及在线探针的耗时：用户卡那一步 686.7 s、真机路径 A3 291 s、A4 86 s）；`asset-lan-probe` 跨机实跑（笔记本对 PC 上放本机的项目，核 `source: 'lan'`）；uc-latency 改后的耗时；用户装 0.7.2 后的真机复测；第 6 项「本机当主机的项目」端到端（要 `PROMPTCUT_LAN_HOST=1`，会弹防火墙）；M8 留下的真热点、真手机扫码与 iOS 导出。
- **待用户项**：① 装 0.7.2 并复测（`REPORT-post-M8.md` 第 1.6 节）；② 在笔记本辅助会话里说恢复（它仍在用户给的「下线后待命」下，UC2-1 已搁置）；③ 审〔裁〕：stale-layer（inputSig、15 秒）、push-scope（J.13 / J.14、`contentId` 缺省不限范围）、存储占用（2.2 节）；④ 以后装带存储占用的版本时知道第一次运行会清缓存；⑤ `cloud-untouched` 真正按用户查要给托管端加只读接口，要不要做；⑥ 沿用 `HANDOFF-2026-09-29.md` 第 8 节其余各项（`claude/join-error`、演练数据目录删不删等）。
- **待修的性能缺陷 / 观察项**：浏览器里用户卡出结果慢（uc-latency 在修）；纯浏览器节点经公网锚点段 33～37 s；stale-layer 子 Agent 报的两处原有闪烁（暂停时用户卡偶尔在旧层与沙漏之间闪一下；播放中重卡每拍在快照与占位之间交替）；改卡片**代码**（不是参数）时 inputSig 不覆盖，要等节点换键重写层表；存储占用的剩余风险（非主进程内存里被删 entry 回到那一版时按缺帧重渲、`atomic()` 的半截临时文件与 `.export-staging\media` 不清）。

## 5. 环境现状

- **PC**：主工作区干净（交接提交之前 `35f1fddd`）。本轮的 worktree 都保留：`uc2-merge`、`card-parse-escape`、`report-post-m8`、`storage-plan`、`probe-hygiene`、`push-scope`、`storage-leaks`、`storage-cap`、`storage-ui`、`storage-semantics`、`storage-semantics-2`、`storage-merge`、`r2-merge`、`uc-latency`、`stale-layer`、`handoff-pc-0929`；像素基准 `.worktrees/pc-g0r-base`（`d70fce77`）保留，别删。worktree 都没有 `node_modules` 的 junction（依赖向上解析到主仓库），`uc2-merge` 里有一份 `npm ci` 装的真 `node_modules`。主会话起的 dev server 都已停；`%TEMP%\promptcut\port.json` 还指着本轮探针起过的端口，用户的编辑器下次启动会重写。
- **笔记本辅助节点**「PromptCut 笔记本辅助测试节点」：仍在用户 2026-09-28 给它的「下线后待命」下；UC2-1（0.7.2 的在线探针与带时限的渲染探针）它回复「收到但暂不执行」，主会话已回它「UC2-1 搁置，恢复后先向主会话报到、按届时的新指令做」。
- **云端**「PromptCut M5～M8 云端工作节点」：空闲，挂在 `to-cloud` 上；检出仍是旧的 `29e6e837`，再派它当渲染主机前先检出当前 main。本轮没派它干活。
- **信箱**（`https://8-219-80-16.sslip.io/coord`）：`to-local` 已处理到 **33**（33 是云端对 PC 接手通知的回执；之后没有新消息）；`to-cloud` 本轮 PC 发过 **29**（TAKEOVER-5，已回执）与 **30**（本次交接通知【HANDOFF-6】，回执会到 `to-local` 34 起）。
- **已发未回执的指令**：云端没有；笔记本辅助只有搁置的 UC2-1（不算待回执）。
- **子 Agent**：交接时在途的 uc-latency、stale-layer 已做到可提交处提交并停下（2.3 节）；其余本轮子 Agent 都已交回；没有在跑的。
- **阿里云 `8.219.80.16`**（2026-09-29 交接前只读核对）：`promptcut-hosted` online（自 2026-09-28T18:56:38Z，重启 16 次，本轮没重启、没重部署服务端）；`/editor` 是 0.7.2（1 节）；`probe-coord` online；`promptcut-drill` stopped；`pm2-logrotate` online；备份在 `/root`：`editor-backup-20260929-072.tgz` 与 `editor-runtime-config-20260929-072.json`（换 0.7.2 之前的）、`editor-backup-20260929-uc.tgz` 与 `editor-runtime-config-20260929-uc.json`（换 0.7.1 之前的）、`m8-probe-projects-backup-20260928.tar.gz`；磁盘 8.8G / 40G；内存用 689 / 1613 MB。本轮在阿里云上建的探针项目（真机路径那一个）已用创建者凭证删掉。
- **顾问调用记录**：本轮主会话与子 Agent 都没有调 codex 或 Gemini（没有卡到要攻坚的问题；c10-browser-probe 回归交接时还在查）。

## 交接时补记

- 本轮分支都已推 origin（最后提交）：`claude/uc2-merge` `3aa859e3`、`claude/card-parse-escape` `c0401057`、`claude/report-post-m8` `d4b83553`、`claude/storage-plan` `8869083a`、`claude/probe-hygiene` `f4d24b8a`（以上都已合入 main）；`claude/stale-layer` `ff4a2ce4`、`claude/push-scope` `d848a3ac`、`claude/r2-merge` `2e4b9d48`、`claude/uc-latency` `8b3fd44c`、`claude/storage-leaks` `8df0dabb`、`claude/storage-cap` `477191c0`、`claude/storage-ui` `ef0f07b2`、`claude/storage-semantics` `14f14718`、`claude/storage-semantics-2` `79369f2a`、`claude/storage-merge` `a852d4a1`（以上都没合入）。
- 本次交接通知：`to-cloud` seq **30**（【HANDOFF-6】，叫云端改听「PromptCut M5～M8 开发交接」并回执）；跨会话消息已通知「PromptCut 笔记本辅助测试节点」（手头做到可回执处回执、之后待命）与「PromptCut M5～M8 开发交接」（接手）。
- 本轮的子 Agent 都已停下；主会话交接后待命。
