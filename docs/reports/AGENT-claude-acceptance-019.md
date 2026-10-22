# AGENT 报告：claude/acceptance-019（验收清单按 0.7.19 改写）

- 分支：`claude/acceptance-019`（从 main `c7831156` 切）；worktree `.worktrees/acceptance-019`
- 范围：`scripts/acceptance/**` 与本报告；没动 `src/**`、`server/**`、`scripts/probes/**`、`docs/semantics/**`、`docs/plan/**`
- 端口段：5950～5959（本次没起任何服务；清单里写的是将来跑验收用的端口，沿用清单原来的 5690 段与 8760 段）

文中代号：「〔裁〕」是执行中自己定、等用户审的决定；「wait 项」是清单里标了「等分支合入」的项，本检出缺它要的文件时记「等分支合入」，合入后自己会跑；「合入后不适用」是本次新加的 `retiredWhen` 字段，某个标记出现（如 `src/online/lowMemory.ts` 没了）时运行器把这一项记成「不适用」并写明依据。

## 进度

- [x] 第 1 步：只读盘查，三分类表（本节下方）
- [ ] 第 2 步：改写清单
- [ ] 第 3 步：新增条目
- [ ] 第 4 步：`--check-coverage`
- [ ] 第 5 步：`--list`、`--dry-run`、tsc、npm test

## 盘查时先发现的三件事（影响怎么改）

1. **在线浏览器那一块一行都还没进 main。** 任务书说「第二、三步已成」，但 `git log main..claude/online-browser` 有 16 个提交、`git merge-base` 是 `5f4523d0`，main 上 `src/online/lowMemory.ts` 还在、`stage-gate-probe.mjs` 还是旧的「舞台端口白名单」那一支。所以「按已合入 main 的部分改」落到实处是：撤档、三道闸门、四档气泡的**全部**条目（第二、三、四步）都写成 wait 项（`waitFor: claude/online-browser`），撤档后失去意义的老条目用「合入后不适用」，合入前它们照旧在 main 上跑（main 上它们描述的行为还在），合入后自动记不适用。
2. **0.7.18 的 `STALE_OLD_ENTRY`（17 项「旧入口已废，不适用」）已经过时。** 它写于 2026-10-13；2026-10-17 合入的 `8b09add4`（gemini/v18-online-probes）把这些在线探针改走「会话恢复入口」，报告 `docs/reports/AGENT-v18-online-probes.md` 第 2 节里 S1-4、S1-5、S2-1～S2-5、P-online-user-cards、P-c10-ui、P-online-stage-watch、P-online-stage-handshake、P-online-nav-stress 实跑全过（退出码 0）。不改的话 0.7.19 整套会把这些项记「不适用」，等于没人验「原有在线页面探针不退步」（`online-browser-task.md` 做完的标准第 4 条）。
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
