# AGENT 报告：claude/acceptance-019（验收清单按 0.7.19 改写）

- 分支：`claude/acceptance-019`（从 main `c7831156` 切）；worktree `.worktrees/acceptance-019`
- 范围：`scripts/acceptance/**` 与本报告；没动 `src/**`、`server/**`、`scripts/probes/**`、`docs/semantics/**`、`docs/plan/**`
- 端口段：5950～5959（本次没起任何服务；清单里写的是将来跑验收用的端口，沿用清单原来的 5690 段与 8760 段）

文中代号：「〔裁〕」是执行中自己定、等用户审的决定；「wait 项」是清单里标了「等分支合入」的项，本检出缺它要的文件时记「等分支合入」，合入后自己会跑；「合入后不适用」是本次新加的 `retiredWhen` 字段，某个标记出现（如 `src/online/lowMemory.ts` 没了）时运行器把这一项记成「不适用」并写明依据。

## 进度

- [x] 第 1 步：只读盘查，三分类表（「第 1 步」一节）
- [x] 第 2 步：改写清单（「改了什么」一节）
- [x] 第 3 步：新增条目（同上）
- [x] 第 4 步：`--check-coverage` 过（「验证」一节）
- [x] 第 5 步：`--list`、`--dry-run`、tsc、npm test（「验证」一节）

## 第二轮（主会话 2026-10-22 的回信）

提交 `efc462e1`（把 main 合进本分支，带进 `971b35d2` 的 `stage-port-whitelist-probe.mjs`）、`875dd8cb`、本报告最后一次提交。

1. **舞台端口白名单**：RR-stage-gate 改指 `stage-port-whitelist-probe.mjs`（covers 也改了），去掉 `retiredWhen`，从补充项改成缺省就跑，通过标准加 `"fails":[]`；挂到 0.7.19 要求 OB-4。合入后两支都跑：这一项验白名单，V19-ob-* 验三道闸门的舞台那一道。
2. **单测**（主会话授权）：`server/test/four-stage-acceptance.test.mjs` 第 156、364 行改成 `!['V18','V19'].includes(category)`。
3. **补了 5 项 0.7.19 的真实网络验收**（类别 V19、level network，只写怎么验，脚本不跑）：

| 编号 | 验什么 | 要求 |
|---|---|---|
| V19-net-hosted-domain | `https://hosted.visuhive.com/hosted`、`/hosted/hosting`、`/media` 的 healthz 都 200、证书有效、s1/s2 舞台源；0.7.19 桌面版不手填地址能加入与新建；存着旧 IP / sslip.io 地址的 .proc 打开后自动换成新域名且连得上；公网上 IP:8787 连不上 | PRE-5、AB-6 |
| V19-net-multi-project | 节点上两三个带纯色用户卡的测试项目同时看画面与产流：看画面先于产流、各项目轮流、项目内先来先做、一轮最多 K 个，图的颜色都是自己项目的，日志里换装记录对得上；越权探测卡在多项目同时有活时读不到别的项目 | MP-3、MP-4、MP-5、AB-6 |
| V19-net-conflict-merge | 公网在线页面两个账号，甲在应用层断线（服务器侧断 TCP 或 CDP 离线）期间与乙改同一批东西，连回后窗口自己打开、两级、增删冲突、选中无冲突项合并对；同一账号手机看同一张表、处理完桌面按钮消失；断线时导入置灰、刷新后离线改动还在 | CM-1、CM-3、CM-4、CM-5、AB-1、AB-6 |
| V19-net-offline-queue | 真 Agent 服务下，CDP 离线发两条→恢复后按序发出；期间另一台设备发过→不发、标「发送失败」、重新发送；断网发后刷新→恢复后发出 | OQ-1～5、AB-6 |
| V19-net-online-gates | 换成 0.7.19 页面后，公网上电脑浏览器试到第三级、气泡原文、跨源舞台 s1/s2；安卓仿真 4 GB 停在精简模式、身份手机；`?tier=low` 只贴已产好的流（等在线浏览器合入） | OB-3c、OB-3g、AB-6 |

都按现有网络项的规矩写：只用测试账号与测试项目、验完删；断线只在应用层做，不动宿主机网络；三个服务与页面同一提交。

4. **「保存与修改状态检查」查到的**（语义：`product/document-service.md` 第 89 行「保存等待本机修改状态检查完成，前台编辑暂时禁用」；`mechanism/document-service.md` 第 36 行「保存暂时禁用前台编辑，等待本机写完；失败不覆盖上次有效保存，并恢复编辑」。**两处标题都还写着「待实施」**）：

| 一样 | 结论 | 依据 | 建议补的测试（不归我写） |
|---|---|---|---|
| 保存时暂停前台编辑 | **未实现** | `src/editor/TopBar.tsx` 的 `saveProject`（约第 336～357 行）：挑好落点后 `await settledOrExplain()`（最长等 10 秒）再 `serializeProc()`，等待期间没有任何编辑锁；全仓 `src/` 里搜不到保存时的锁（`editLock`、`isSaving` 之类只有 AI 设置对话框自己的「保存中」） | 实现后：单测断言保存进行中 store 的写入被拦、保存结束（成功或失败）后放开 |
| 等本机写完 | **部分实现** | 有的：`syncManager.ts` 第 1132 行 `whenSaved` → `DocSync.whenSettled`（`src/store/docsync.ts` 第 1145 行）等文档服务确认所有本地待提交操作，10 秒超时则不写并提示「还有修改没等到文档服务确认……这次没有保存」；连着协作时还等恢复日志落盘。没有的：机制第 36 行列的素材入库/上传、本机 Agent、渲染、后台写入都不等；没连文档服务的本地项目直接放行 | 单测：pending 不空时 `whenSaved` 超时 → `writeProcToDisk` 不写文件；补齐后再加「上传队列没空时不保存」 |
| 失败不覆盖上次有效保存、并恢复编辑 | **部分实现** | 等确认失败时在写文件之前就抛错退出，旧文件不动，草稿和「已保存」标记也不更新（`saveDraft`、`markSaved` 都在写成功之后）。写到一半失败：`src/editor/io/proc.ts` 第 273 行 `writeProcToDisk` 直接 `createWritable` → `write` → `close`，没有 `abort()` 也没有显式保护，只是靠浏览器 File System Access API 先写临时副本、`close` 才替换原文件的行为保住旧文件；没有任何测试钉住。「恢复编辑」因为从没禁用，无从谈起 | 单测：假 `showSaveFilePicker` 让 `writable.write` 抛错 → 原文件内容不变、`markSaved` 没调、弹出说明；再加一条等确认超时不写的 |
| （同一行的）固定非本机快照 | 已实现 | 冲突合并那一块：另存带 `base` 与 `baseSha256`，CS-01～06 | — |

另：在线构建里 `saveProject` 是空函数（`ONLINE_BUILD`），这一行只对桌面版保存 `.proc`、`.procp` 有意义。**建议整行记「失败（未达成）」**：第一样没做，另两样只做了一部分。清单里 V19-save-state 仍是人工项，正文换成了上面的结论。

## 结论（给主会话）

- 清单从 **236 项（本地 210、真实网络 26）变成 288 项（本地 257、真实网络 31）**：新增 52 项（类别 `V19`，其中 5 项是第二轮补的真实网络验收），恢复 16 项被误记「不适用」的在线探针（不适用从 20 项降到 7 项），新标不适用 3 项（另有 S2-m2 一项「在线浏览器合入后不适用」）。缺省本地一级（不带补充项）将跑 202 项。
- 「保存与修改状态检查」查清了：暂停前台编辑**未实现**，等本机写完与失败不覆盖旧保存**部分实现**，建议整行记失败（未达成）。见「第二轮」第 4 条。
- 加了一张 **0.7.19 要求表（49 条）**，`--check-coverage` 新增第 ⑤ 类核它，`--v19-map` 打印每条要求由哪些项支撑。守门通过（退出码 0）。
- **在线浏览器那一块没进 main**（不是任务书说的「第二、三步已成」），它的 6 项全写成「等分支合入」，合入后自己会跑；撤档后失去意义的 S2-m2 合入后自动记「不适用」（RR-stage-gate 第一轮也这样处理，第二轮改指另存的白名单探针、不退休）。已对着 `claude/online-browser` 的文件树模拟过：6 项里 5 项变「会跑」，第 6 项（残留检查）只差本分支自己的脚本，两条分支都合入后就跑。
- 没有真跑任何验收项。tsc 0 错误；runner 单测 38/38；`npm test` 见「验证」。
- 要主会话改的探针与单测 7 处，见「要主会话改的探针与测试」；第 1、3 条第二轮已办，第 7 条已查清。

## 盘查时先发现的三件事（影响怎么改）

1. **在线浏览器那一块一行都还没进 main。** 任务书说「第二、三步已成」，但 `git log main..claude/online-browser` 有 16 个提交、`git merge-base` 是 `5f4523d0`，main 上 `src/online/lowMemory.ts` 还在、`stage-gate-probe.mjs` 还是旧的「舞台端口白名单」那一支。所以「按已合入 main 的部分改」落到实处是：撤档、三道闸门、四档气泡的**全部**条目（第二、三、四步）都写成 wait 项（`waitFor: claude/online-browser`），撤档后失去意义的老条目用「合入后不适用」，合入前它们照旧在 main 上跑（main 上它们描述的行为还在），合入后自动记不适用。
2. **0.7.18 的 `STALE_OLD_ENTRY`（18 项「旧入口已废，不适用」）已经过时。** 它写于 2026-10-13；2026-10-17 合入的 `8b09add4`（gemini/v18-online-probes）把这些在线探针改走「会话恢复入口」，报告 `docs/reports/AGENT-v18-online-probes.md` 第 2 节里 S1-4、S1-5、S2-1～S2-5、P-online-user-cards、P-c10-ui、P-online-stage-watch、P-online-stage-handshake、P-online-nav-stress 实跑全过（退出码 0）。不改的话 0.7.19 整套会把这些项记「不适用」，等于没人验「原有在线页面探针不退步」（`online-browser-task.md` 做完的标准第 4 条）。
3. **单测把「老清单的真实网络验证项」钉死为 16 项**（`server/test/four-stage-acceptance.test.mjs` FSA-07 第 156 行、FSA-26 第 364 行：`category !== 'V18'` 的 network 项必须恰好 16）。我不许改 `server/**`，所以 0.7.19 的新条目一律是本地验证级；0.7.19 要在节点上验的东西改写进已有的网络项（S1-r2、S3-r2、S3-r3、S3-r5、V18-queue-node-pressure），不新增网络项。建议主会话把这两处断言改成 `!['V18','V19'].includes(category)`。

## 第 1 步：三分类表

### A. 要改写（前提变了，断言、命令或说法要换）

| 编号 | 现在写的 | 为什么要改 | 改成 |
|---|---|---|---|
| RS18-queue | 「云端排队与按轮占用（甲一轮收尾立即让给排队的乙）」，`hosted-render-queue-probe` | 多项目渲染节点取代按轮占用；探针已改成按多项目模式验（13 条，`AGENT-claude-multi-project-render.md`） | 名字与依据改成多项目模式；命令加 `--turn 1`，验「一轮最多连做 K 个」的 K=1 分支（乙-1 → 甲-2 → 乙-2 → 甲-3），和下一条的缺省 K=4 分开，两项不再重复跑同一件事 |
| V18-queue-probe | 「10-16 按轮占用：一轮结束立即让位」，带 `--idle-ms 20000`，已知「14 条」 | 同上；多项目模式下换装不等空闲时长，`--idle-ms` 只管没人排队时的缓存 | 名字改多项目模式（缺省 K=4）；去掉 `--idle-ms`（用生产的 5 分钟，和子 Agent 最终那次跑法一致）；已知改「13 条」 |
| V18-queue-node-pressure（网络） | 0.7.18「三版本共同回归的度量」，按轮占用口径 | 节点上要验的变成多项目模式：两个以上带用户卡的项目同时要画面，不让哪个项目占着、K 与缓存时长的实际表现 | 改写节点上怎么验 |
| RR-stage-gate | 旧 `stage-gate-probe`（舞台端口白名单），`--port --shots` | 在线浏览器分支把同名文件整个改写成「舞台闸门真杀页面进程」探针，参数也换了（`--dist --base-port --only`）；合入后旧命令跑不起来 | 「合入后不适用」（标记：探针里出现 `Page.crash`）；新探针另立 V19 项。**旧的白名单检查因此没有探针了，见「要主会话改探针」** |
| RR-page-stream | 「solo / splitter / desk / mask / slow / lowmem 六场」 | 合入后 `lowmem` 场改名 `lowest`（`?tier=low`），`mobile` 场改核精简模式 | 名字写两种状态；命令不变 |
| X-lowmem-export-compare | 「低内存档逐帧导出与桌面导出逐帧比」 | 探针比的是浏览器逐帧导出与桌面导出（文件头），和低内存档无关，名字是旧的 | 改名，命令不变 |
| S1-5 | 「旧入口已废，不适用」；名字「桌面、在线普通档、低内存档」 | 入口已迁移（8b09add4，73/73 过）；合入后 `lowmem` 段改成 `phone` 段 | 恢复成可跑；名字写两种状态 |
| S1-4、S2-1～S2-5、P-online-user-cards、P-c10-ui、P-online-stage-watch、P-online-stage-handshake、P-online-nav-stress | 「旧入口已废，不适用」 | 同上（8b09add4 实跑全过） | 恢复成可跑；过时的「已知：main 上不过（空项目）」一并改 |
| P-c10-browser-a4 / -full / P-c10-user-card | 「旧入口已废」；名字「在线普通档」 | 成员一半已改走 `resumeRecordFromInvite`（8b09add4），但迁移后没有实跑记录；「普通档」一词随撤档不用 | 恢复成可跑，已知写「迁移后没实跑过」；名字改「在线双舞台」 |
| S4-6 | 「旧入口已废」 | `cloud-agent-ui-lib.mjs` 的 `joinOnline` 已改走恢复入口（8b09add4），没有实跑记录 | 恢复成可跑，已知写明 |
| S4-4 | 名字含「手机占位」 | 合入后手机不再是低内存档的占位（分支改了 O6） | 名字写两种状态 |
| S1-r3、S3-r3（网络） | 「在线普通档」 | 用词随撤档不用 | 改「在线双舞台」 |
| S3-r2（网络） | 「低内存档预渲染重试被云节点认领、产物贴上」，用 `lowmem-online-probe` | 「为弱设备补发的预渲染任务」随撤档撤销，`lowmem-online-probe` 退役；R23 第 1 点要验的「弱设备看得到重卡」现在走：手机身份不认领、清单计划里的流任务由托管渲染服务认领产流、页面贴上 | 改写节点上怎么验 |
| S1-r2（网络） | 换在线页面 | 0.7.19 新增手机版，生产只读检查 `mobile-prod-check` 只能对真地址跑 | 加「换页面之后跑 mobile-prod-check」，covers 登记它 |
| V18-move-probe | 「搬到云端」端到端 | 同一支探针加了〔裁〕H04「放弃这次搬迁」（b3154d94，随 0.7.19 发） | 名字加上，挂到 0.7.19 要求 |
| 排除表 `hosted-render-queue-probe.mjs` | 「云端排队与按轮占用…14 条…」 | 说法过时，而且它本来就被 RS18-queue / V18-queue-probe 登记了 | 从排除表删掉 |
| 排除表 `hosted-render-isolation-probe.mjs` | 「清单里还没有对应的项」 | 已被 V18-queue-isolation-probe 登记 | 从排除表删掉 |
| 排除表 `playback-probe.mjs` | 「R5 历史」 | 新加了「停顿声音」一例（音频看门狗正向验收，0.7.19 前置项） | 从排除表删掉，新 V19 项登记 |
| 排除表 `lowmem-online-probe.mjs`、`c65-editor-probe.mjs`、`reopen-matrix.mjs` | 原因 | lowmem 合入后退役；c65 与 reopen-matrix 的 C 段已随冲突合并窗口改过、仍要手工起托管端，reopen-matrix 的 5 处断言是原有失败、未验 | 原因改写 |
| V18-na-offline-conflict、V18-na-save-state | 0.7.18 表里「归 0.7.19」 | 0.7.18 的行照旧不适用，但现在有 0.7.19 的项了 | 依据里指到 V19 项 |

### B. 要新增（0.7.19 新能力还没有条目；类别 `V19`，每项带 `v19` 指到要求表）

| 要求 | 新条目（探针都是现成的，只引用） | 能不能现在跑 |
|---|---|---|
| 三道闸门与四档气泡：舞台闸门（S1～S14，含气泡原文、查看口、身份、护栏、多标签、iPad） | `V19-ob-stage-gate`：`stage-gate-probe --only S1…S14` | wait（新探针在分支上） |
| 最低一档（S15）、即时渲染闸门（S16、S17、S20）、素材闸门（S18、S19） | `V19-ob-lowest`、`V19-ob-instant-gate`、`V19-ob-media-gate` | wait（第四步） |
| 三道闸门的单测 | `V19-ob-tests`：stageGate、onlineTier、mediaGate、costSearch、settleFrame、mediaTierSmallOnly、l2 | wait |
| 低内存档搜不到残留 | `V19-ob-residue`：新写的 `scripts/acceptance/v19-lowmem-residue.mjs`（只查用户看得见的字样与删掉的模块；不查注释） | wait |
| 真机（iPhone、iPad、安卓）落在哪一档、气泡 | `V19-ob-device`：人工，待用户，不挡发版 | 人工 |
| 多项目：两种模式出的画面相同 | `V19-mp-expand`：`multi-project-expand-probe --url {dev.origin}` | 本机 |
| 多项目：产流键与画面不变 | `V19-mp-stream`：`multi-project-stream-probe` | 本机 |
| 多项目：队列次序 | 改写后的 RS18-queue（K=1）与 V18-queue-probe（K=4）；`V19-mp-tests`（MPQ、MPE、MPI、MSK 与 hosted-render 一组） | 本机 |
| 多项目：隔离 | V18-queue-isolation-probe（49 条，已有）+ `V19-mp-tests` 的 MPI | 本机 |
| 多项目：K 的实测（只出数字） | `V19-mp-turn-bench`：补充项，记耗时 | 本机（缺省不跑） |
| 冲突合并窗口：两级勾选、增删冲突、按项目×用户存、换设备、断网导入置灰、手机同桌面 | `V19-cm-probe`：`conflict-merge-probe`（D1～D6）；`V19-cm-tests`：mergeItems、offlineMerge、pending-merge、cloudSnapshot、onlineSync、card-sync、accountMove | 本机 |
| 冲突合并窗口：卡片源码那一行 | `V19-cm-card`：`card-conflict-probe` | 本机 |
| 手机版冲突横条（mobile-ui C 段）与手机版界面 | `V19-mobile-ui`：`mobile-ui-probe` | 本机 |
| 保存与修改状态检查（固定非本机快照） | `V19-cm-tests` 的 CS-01～06；`V19-save-state`：人工，列出没有探针的部分（暂停前台编辑、等本机写完、保存中断后恢复编辑） | 本机 + 人工 |
| 断网排队四条（排着不报错、恢复按序发、期间别人发过就不发并标失败、重新发送）+ 刷新后还在 | `V19-oq-probe`：`cloud-offline-queue-probe`（19 条）；`V19-oq-tests`：outbox、consent-once | 本机 |
| 老外壳账号入口只给说明 | `V19-os-probe`：`old-shell-account-probe`；`V19-os-tests`：desktopShellOld、oldShellFlow；`V19-os-real-shell`：人工，真 0.2.0～0.2.7 外壳，待用户 | 本机 + 人工 |
| 前置项：手机滤镜入口与真画面 | `V19-mobile-entries`：`mobile-entries-probe` | 本机 |
| 前置项：停顿时声音立刻停 | `V19-stall-audio`：`playback-probe --only 停顿声音` | 本机 |
| 前置项：粘贴授权码、告知只核一次、托管域名、放弃搬迁 | `V19-pre-tests`：cli-setup、consent-once、hosted-migrate、legacy-gone-proof、sp-route、sp-routing、account-move、accountMove；V18-move-probe（改名） | 本机 |
| 随版合入的其它改动（0.7.18 发版后进 main、0.7.19 一起发）：剪辑段、手机版、Agent 开始页、数字框撤销、AI 面板流畅 | 剪辑段一组（单测 + 8 支探针）、`V19-number-input-undo`、手机版一组（单测 + 5 支探针）、`V19-agent-tabs-start`、`V19-agent-tabs-start-mobile`、`V19-agent-panel-smooth` | 本机（端口写死或要账号的标补充） |
| 每版都做：最终产品交互验收、完整安装包、兼容补丁、合入与 release | `V19-release-timings`、`V19-installer`、`V19-patch`、`V19-release-merge`：人工 | 人工 |
| 真实网络环境验收 | 不新增网络项（见上第 3 件），挂到改写后的 S1-r2、S3-r2、S3-r3、S3-r5、V18-queue-node-pressure 等 | 节点 |

`--check-coverage` 不认识 0.7.19 的要求，所以加第 ⑤ 类：清单导出 `V19_REQS`（要求表，出处 `online-browser-task.md` 做完的标准、`account-binding-task.md` 逐项验收里归 0.7.19 与每版都做的行、`three-versions-progress.md`「还差什么」0.7.19 与前置项），每条要求至少有一项指向它，项里指到的要求要在表里。

### C. 要删或标不适用（逐个写理由）

| 编号 | 处理 | 理由 |
|---|---|---|
| V18-queue-probe-prod | 不适用 | 它和 V18-queue-probe 的区别只在「空闲满五分钟才关掉装着的项目」（`realIdle`）。多项目模式下别的项目一排上就换装，不等空闲（`hosted-render-queue-probe.mjs` 文件头「下面几条断言换装都发生在远早于它的时候」），两种空闲时长跑出的断言相同；改写后的 V18-queue-probe 本来就用生产的 5 分钟 |
| S2-m2「手机低内存档的表现」 | 合入后不适用（标记：`src/online/lowMemory.ts` 没了） | 低内存档撤销；手机的表现由 V19-ob-stage-gate 的 S10（安卓 4 GB 停在精简模式、身份手机）与 RR-page-stream 的 mobile 场接替。合入前 main 上低内存档还在，照旧是人工项 |
| RR-stage-gate | 合入后不适用（标记：`stage-gate-probe.mjs` 里出现 `Page.crash`） | 同名探针被改写成舞台闸门探针，旧命令跑不起来（见 A 表） |
| X-c10-cost「低内存档完整规则」 | 不适用（现在就是） | 探针成员一半还凭 `#invite=` 等 `join-invite-project`（第 417～418 行），开始页 0.7.18 起没有这个控件，8b09add4 也没迁它；它验的低内存档规则随撤档撤销。单舞台界限搜索由 V19-ob-instant-gate（S20）与 V19-ob-tests（costSearch）接替 |
| X-small-tier「预渲染小尺寸」 | 不适用（现在就是） | `product/rendering.md` 第 44 行：预渲染小尺寸随每张卡的 HTML 快照作废停产（2026-10-13）；探针断言的正是「每个 `<帧>.html` 旁有 `.small.webp`」 |
| X-c10a-demo-local | 仍不适用，依据改写 | 入口 8b09add4 已迁，但在线浏览器分支在文件头标明第 2、2c、4 步按低内存档与已停产的预渲染小尺寸写，撤档后失效，整支要重写主干 |
| X-online-join | 仍不适用，依据不变 | 这支就是测开始页的加入表单，开始页已没有 |

另：同一张表上 V18-na-offline-conflict、V18-na-save-state 两项（0.7.18 表的 2.1-10、2.1-11 行）照旧不适用——它们是 0.7.18 的行；依据里补了「0.7.19 的验收见 V19-cm-*」。

## 改了什么（第 2、3 步）

提交：`c76fd2a4`（运行器）、`273845f3`（清单）、本报告的几次提交。

### 运行器（`acceptance-lib.mjs`、`four-stage-acceptance.mjs`）

- 类别加 `V19`；`V19` 类的项必须写 `v19`（指到要求表）。
- 新字段 `retiredWhen: { missing: 文件 } | { file, text }` 加 `why`：标记出现时运行器把这一项记 `na` 并写明依据，`--list` 与 `--dry-run` 里也标出来；合入前照旧跑。已经 `notApplicable` 的项不许再写它。
- 新字段 `v19`，`validateManifest` 核它指到的要求在表里。
- `--check-coverage` 加第 ⑤ 类：要求表每条至少有一项、项里指到的要求都在表里；顺带报等分支合入的项数与合入后不适用的项数。
- 新 `--v19-map`：每条要求由哪些项支撑、每项在哪能跑（等哪条分支、合入后是否不适用、是否补充项）。
- 没改判定、续跑、端口平移、服务管理的任何逻辑。

### 清单

- 新文件 `scripts/acceptance/v19-manifest.mjs`：要求表 `V19_REQS`（49 条，8 组，每条写出处）、47 个 `V19` 项、`V19_TAGS`（给 50 个老项补 `v19`）。由 `four-stage-manifest.mjs` 接进总清单，并导出 `V19_REQS`。
- 新文件 `scripts/acceptance/v19-lowmem-residue.mjs`：低内存档残留检查（R1 删掉的 5 个模块文件不在；R2 没有 import 它们；R3 引号里没有「低内存」；R4 没有 `'low-memory'`、`DisplayTierPicker`、`__pcBackfill`）。只读；`--ref` 可对着别的分支查。实测：对 main 四条全不过（退出码 1，23 处引号字样、13 处 import 等），对 `claude/online-browser`（`d31659d0`）四条全过（退出码 0）——判得出撤档做没做完。
- `four-stage-manifest.mjs`、`v18-manifest.mjs`：A 表与 C 表的全部改动。`STALE_OLD_ENTRY` 只剩 X-online-join、X-c10a-demo-local；恢复的 16 项在 `OLD_ITEM_KNOWN` 里写明迁移提交与当时的实跑结果（或「迁移后没有实跑记录」）。

### 新增的 47 项

| 组 | 编号 | 命令要点 | 前置服务 | 通过标准 |
|---|---|---|---|---|
| 在线浏览器（wait） | V19-ob-tests | `scripts/test-suite.mjs` 11 个测试文件 | — | 零失败、零跳过、无失败的 todo |
| | V19-ob-stage-gate | `stage-gate-probe --dist {dist} --base-port 5690 --out {item} --only S1…S14` | online-build | 退出码 0、`"ok":true` |
| | V19-ob-lowest | 同上 `--only S15` | online-build | 同上 |
| | V19-ob-instant-gate | 同上 `--only S16,S17,S20` | online-build | 同上 |
| | V19-ob-media-gate | 同上 `--only S18,S19` | online-build | 同上 |
| | V19-ob-residue | `scripts/acceptance/v19-lowmem-residue.mjs` | — | 退出码 0、`"ok":true` |
| | V19-ob-device | 人工（真机） | — | — |
| 多项目 | V19-mp-tests | 多项目 4 个 + hosted-render 一组 + 看画面接线测试 | — | 零失败、零跳过 |
| | V19-mp-expand | `multi-project-expand-probe --url {dev.origin} --out {item}` | dev | `"ok":true`、`"diffPixels":0` |
| | V19-mp-stream | `multi-project-stream-probe --url {dev.origin} --out {item}` | dev | 同上 |
| | V19-mp-turn-bench（补充、记耗时） | `multi-project-turn-bench --base-port 5690 --doc-port 8760 --asset-port 8761` | — | 退出码 0（只出数字） |
| 冲突合并 | V19-cm-tests | mergeItems、offlineMerge、pending-merge、cloudSnapshot、onlineSync、card-sync、accountMove、c10-ui-gates | — | 零失败、零跳过 |
| | V19-cm-probe | `conflict-merge-probe --dist {dist} --out {item} --base-port 5690 --base2-port 5693 --doc-port 8760 --asset-port 8761` | online-build | `"ok":true` |
| | V19-cm-card | `card-conflict-probe --port 5690 --doc-port 8760 --out {item}` | — | `"ok":true` |
| | V19-save-state | 人工（三处没有探针） | — | — |
| 断网排队 | V19-oq-tests | outbox、consent-once | — | 零失败、零跳过 |
| | V19-oq-probe | `cloud-offline-queue-probe --port 5690` | — | `"ok": true` |
| 老外壳 | V19-os-tests | desktopShellOld、oldShellFlow | — | 零失败、零跳过 |
| | V19-os-probe | `old-shell-account-probe --port 5690 --out {item}` | — | 退出码 0、结果行 fails 为空 |
| | V19-os-real-shell | 人工（安装包，待用户） | — | — |
| 前置项 | V19-mobile-entries | `mobile-entries-probe --dist {dist} --out {item} --base-port 5690 --doc-port 8760 --asset-port 8761` | online-build | `"ok":true` |
| | V19-stall-audio | `playback-probe --port 5690 --only 停顿声音` | — | `"fails":[]` |
| | V19-pre-tests | cli-setup、consent-once、hosted-migrate、legacy-gone-proof、sp-route、sp-routing、account-move、accountMove（要账号环境变量） | — | 零失败、零跳过 |
| 随版合入 | V19-cut-tests | 剪辑段 19 个测试文件 | — | 零失败、零跳过 |
| | V19-cut-nesting-ui、V19-cut-panel、V19-number-input-undo | `… --origin {dev.origin} --out {item}` | dev | 退出码 0 |
| | V19-cut-flatten、V19-cut-look、V19-cut-audio、V19-cut-card-sound、V19-cut-ffmpeg-media | `… --port 5690 --out {item}`（自己起编辑器） | — | 退出码 0 |
| | V19-cut-online-e2e | `cut-online-e2e-probe --dist {dist} --base-port 5690 --out {item}` | online-build | 退出码 0 |
| | V19-mobile-tests | src/mobile 三个测试文件 | — | 零失败、零跳过 |
| | V19-mobile-ui、V19-mobile-business | `… --dist {dist} --out {item} --base-port 5690 --base2-port 5693 --doc-port 8760 --asset-port 8761` | online-build | `"ok":true` |
| | V19-mobile-input-zoom、V19-mobile-agent、V19-agent-tabs-start-mobile | `… --dist {dist} --base-port 5690 --doc-port 8760 --asset-port 8761` | online-build | `"ok":true` 或退出码 0 |
| | V19-mobile-agent-view、V19-agent-tabs-start | `… --port 5690 --out {item}` | — | 退出码 0 |
| | V19-agent-panel-smooth（记耗时，要账号环境变量） | `agent-panel-smooth-probe --dist {dist} --site-root {visuhive}/site --out {item} --base-port 5690` | online-build | `"completed":true`、`"failed":0` |
| | V19-mobile-account（补充，要账号环境变量） | `mobile-account-probe --dist {dist} --site-root {visuhive}/site --out {item} --base-port 5690` | online-build | `"ok":true` |
| 发版动作 | V19-release-timings、V19-installer、V19-patch、V19-release-merge | 人工 | — | — |

端口都按清单原约定（探针自己起的东西用 5690 段、串行用，文档与素材服务 8760 段），单测 FSA-05 核过不踩禁区（5190～5192、5203～5205、5210～5212、5720～5839、8770～8799）。端口写死、不随这段走的只有 V19-mobile-account（舞台源 6341、6342），所以标了补充项。

## 项数

| | 改前（main `c7831156`） | 改后 |
|---|---|---|
| `--list` 总数 | 236 | **288** |
| 本地验证 | 210 | **257** |
| 真实网络验证 | 26 | **31**（第一轮不变；第二轮主会话授权改单测后补 5 项 V19） |
| 其中 V19 类 | — | 52（真实网络 5、补充项 2、人工 7、等分支合入 6） |
| 不适用 | 20 | 7（另 S2-m2 一项在线浏览器合入后不适用） |
| 带 `v19` 的项 | — | 103（52 个新项 + 51 个老项） |
| 缺省本地一级将跑（`--dry-run`） | — | 202 项（其中 3 项记不适用） |
| 本地一级连补充项（`--dry-run --include-optional`） | — | 257 项 |
| 真实网络一级（`--dry-run --level network`） | — | 31 项 |

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（设好两个账号环境变量） | 退出码 0；`ℹ tests 7585`、pass 7570、**fail 0**、cancelled 0、skipped 15、200 秒；末行「npm test 最终结果：零失败」；日志 8530 行（有汇总行，不是短日志） |
| 运行器单测 | `node scripts/test-suite.mjs server/test/four-stage-acceptance.test.mjs server/test/four-stage-acceptance-v18.test.mjs` | 38/38 过（含 FSA-05 端口禁区、FSA-06 类别都有项、FSA-07 网络项 16、V18-06 真清单合格） |
| `--list` | `node scripts/acceptance/four-stage-acceptance.mjs --list` | 退出码 0；`共 283 项:本地验证 257,真实网络验证 26` |
| `--dry-run` | `--dry-run --out <scratchpad>` | 退出码 0；`将跑 201 项`（3 项标 [不适用]）；`--include-optional` 257 项；`--level network` 26 项 |
| `--check-coverage` | 见下 | 退出码 0，守门：通过 |
| `--v19-map` | `--v19-map` | 退出码 0，49 条每条都有项 |
| 残留检查脚本 | `v19-lowmem-residue.mjs` / `--ref claude/online-browser` | main 退出码 1（四条不过）；分支退出码 0（四条全过） |
| 合入前后模拟 | 用 `retiredReason` 与 wait 判据分别对 `HEAD`、`claude/online-browser` 文件树求值 | HEAD：RR-stage-gate、S2-m2 照跑，6 个 V19-ob 等合入；分支：前两项不适用，V19-ob 五项会跑，V19-ob-residue 只差本分支脚本 |

`--check-coverage` 输出：

```
① scripts/probes 下 322 个文件
都登记了或写明了排除原因
② 0.7.18 的 38 行:每行至少有一条清单项
③ 清单项引用的测试文件与探针脚本:都在仓库里
标了「等分支合入」的项,缺的文件单列(11 个,预期缺):
  等 claude/online-browser(11):
    V19-ob-tests  src/online/stageGate.test.mjs、onlineTier.test.mjs、mediaGate.test.mjs、src/editor/costSearch.test.mjs、
                  src/render/settleFrame.test.mjs、src/render/mediaTierSmallOnly.test.mjs
    V19-ob-stage-gate / -lowest / -instant-gate / -media-gate / -residue  src/online/stageGate.ts
④ 全量测试的跳过名单(G0-2):14 条;每条都写了名字、所在文件、原因
⑤ 0.7.19 的要求 49 条:每条至少有一项
其中等分支合入的 6 项(claude/online-browser);某分支合入后不适用的 2 项,本检出上已经不适用 0 项
守门:通过
```

（改前 main 上同一命令退出码 1：28 个探针没登记，全是 0.7.18 发版后新加的。）

**第二轮复验**（合了 main、改了单测、加了 5 项网络项之后）：

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0 |
| 运行器单测（同上两个文件） | 38/38 过，含改过的 FSA-07、FSA-26 |
| `npm test` 全量 | 退出码 1：`ℹ tests 7585`、pass 7561、fail 8、cancelled 1、skipped 15、249 秒（日志 8596 行，有汇总行）。8 条失败全在账号任务进程一带的计时类测试，和清单无关 |
| 失败的 7 个文件逐个单跑 | **全过 37/37**：accept-018-auth-agent-path 9/9、account-master-production 1/1、account-render-publish 12/12、account-runner-process 1/1、account-worker-lifecycle 10/10、agent-worker-settlement-client 3/3、asset-wiring-integration 1/1 |
| `--list` | `共 288 项:本地验证 257,真实网络验证 31` |
| `--dry-run` | 缺省 202 项（3 项 [不适用]）；`--include-optional` 257；`--level network` 31 |
| `--check-coverage` | 退出码 0；① 323 个文件都登记（多出的是 `stage-port-whitelist-probe.mjs`）；⑤ 49 条每条有项；合入后不适用 1 项；守门：通过 |
| `--v19-map` | 退出码 0 |

满载失败的判断：这 7 个文件都起真任务进程、真账号后端，有 30～160 秒的等待；第一轮全量在几乎同样的代码上 0 失败；单跑全过；本分支第二轮只改了 `scripts/acceptance/**` 和这个单测文件的两行断言，碰不到它们。同一组文件在冲突合并那一块的报告里也有满载假失败的记录。

没跑的：整套验收的任何一项（按任务书不跑）。

## 要主会话改的探针与测试（我没改，不归我）

1. **舞台端口白名单这件事合入后没有探针了。** `claude/online-browser` 把 `scripts/probes/stage-gate-probe.mjs` 整个改写成舞台闸门探针（`git diff --stat` 918 行），原来那支验 `server/stage-gate.mjs`「舞台端口来的请求缺省全拒、只放白名单」（用户卡用卡片模块里的 fetch/WebSocket 逐个调 Agent 绑定、项目写入、素材写入、`/@fs/` 等全部 403）的探针没了，清单里 RR-stage-gate 只能合入后标不适用。建议合入前把 main 上的旧版本另存成新文件名（例如 `stage-port-gate-probe.mjs`），我这边再加一项指向它。这是安全一带的回归缺口。
2. **素材闸门有两条没有探针场景**：「压低网速先拉小尺寸、恢复后改回」「导入更大的素材不重测、直接拿上限比」（`online-browser-task.md` 做完的标准第 3 条第 4 点）。`stage-gate-probe` 的 S18、S19 只验载入原尺寸时崩与解码上限；这两条现在只有 `mediaGate.test.mjs` 的单测。建议在 `stage-gate-probe` 加场景（网速可用 CDP `Network.emulateNetworkConditions` 在应用层压，不碰宿主机网络）。
3. **单测钉死老清单的网络项数**：`server/test/four-stage-acceptance.test.mjs` 第 156 行与第 364 行断言 `category !== 'V18'` 的网络项恰好 16。0.7.19 若要新增节点上的验收项，要先把它改成 `!['V18','V19'].includes(category)`。
4. **`cloud-offline-queue-probe.mjs` 没有 `--out`**，截图写死在仓库的 `out/offline-queue/`。建议加 `--out`，清单再改成 `{item}`。
5. **`mobile-account-probe.mjs` 两个舞台源写死 6341、6342**，不随 `--base-port` 走；建议随 `--base-port` 走，清单就能去掉「补充」。
6. **`c10-cost-probe.mjs`、`c10a-demo-probe.mjs` 要重写主干或正式退役**：前者成员一半还走 0.7.18 起没有的 `join-invite-project`，后者第 2、2c、4 步按低内存档与已停产的预渲染小尺寸写。
7. **保存与修改状态检查**里「暂停前台编辑、等本机写完、保存中断后恢复编辑且保留旧保存」三处没有任何探针或单测指得上（冲突合并那一块的报告只写了固定非本机快照），清单里先是人工项 V19-save-state。请主会话判：已实现就补测，未实现记未达成。

另记两条现状（不用改探针）：`reopen-e2e.mjs --matrix` 在 main 上更早一步失败（原有），所以冲突合并改的 5 处断言没验，排除表里写明了；`hosted-render-isolation-probe` 的残余面「非账号模式下凭本项目票据按哈希读得到别的项目的块」是语义待定（多项目渲染报告第 5 条），不是探针问题。

## 依赖在线浏览器合入才能跑的条目

| 编号 | 现在 | 合入后 |
|---|---|---|
| V19-ob-tests | 等分支合入（缺 6 个测试文件） | 跑 |
| V19-ob-stage-gate | 等分支合入（缺 `src/online/stageGate.ts`、探针里没有 `Page.crash`） | 跑 |
| V19-ob-lowest（第四步） | 同上 | 跑 |
| V19-ob-instant-gate（第四步） | 同上 | 跑 |
| V19-ob-media-gate（第四步） | 同上 | 跑 |
| V19-ob-residue | 等分支合入（缺 `src/online/stageGate.ts`） | 跑 |
| RR-stage-gate | 跑 `stage-port-whitelist-probe.mjs` | 照跑（第二轮改，不退休） |
| V19-net-online-gates（真实网络） | 节点上无从验 | 换成合入后的在线页面再验 |
| S2-m2 | 人工（低内存档表现） | 不适用 |
| S1-5、S2-1、S2-2、P-online-user-cards、RR-page-stream、S4-4、P-m7-browser | 跑 main 上的探针 | 跑分支改写后的同名探针（断言按撤档改过；名字与已知里写明了两种状态） |

模拟结果（第一轮，对 `HEAD` 与 `claude/online-browser` 两棵文件树分别求值，见「验证」）：合入后 S2-m2 记不适用（RR-stage-gate 当时也是，第二轮已改为不退休）；5 个 wait 项变「会跑」；V19-ob-residue 只差本分支的脚本，两条分支都合入后就跑。

## 对任务书的更正

1. 任务书说在线浏览器「第二、三步已成」：在分支上是成了，但 **main 上一行都没有**（`git log main..claude/online-browser` 16 个提交）。所以第 1 项的条目全按 wait 处理，不是「按已合入 main 的部分」。
2. 任务书说「清单里凡提低内存档的条目 10 处」：按名字与命令数，直接以低内存档为前提的是 RR-page-stream、X-c10-cost、X-lowmem-export-compare（名字是旧的，实际与低内存档无关）、S1-5、S1-r3（普通档字样）、S2-m2、S3-r2、S3-r3（普通档字样）、排除表的 lowmem-online-probe、S4-4（手机占位），另有 P-c10-browser-* 的「在线普通档」字样。都处理了。
3. 「速度」入口（`three-versions-progress.md` 前置项第 1 件的后一半）不在 main、定了不先进 main，清单里没有它的项；进 main 后再补。
4. `hosted-render-queue-probe` 改写后是 **13 条**（不是清单原先写的 14 条）。

