# 多人协作重开恢复：实现与验收报告

日期：2026-10-05（保留2026-10-04及此前实际来源）。对应完整授权计划：[collaboration-reopen-recovery-plan.md](../plan/collaboration-reopen-recovery-plan.md)。

## 交付状态

**2026-10-05 更新。** 系统默认 `.proc` 双击已在笔记本真实安装的构建上验收通过，主机、成员两个角色各一遍；完整安装包在笔记本真实安装并运行过；验收矩阵逐条复核见「2026-10-05 验收矩阵逐条复核」。下一段是此前的交付状态原文，保留作历史：其中「尚不宣布完整目标达成」所指的缺口是系统默认双击，已由这次补验关闭。没达成的一项：G0-R 里带耗时门槛的流编码探针在笔记本上没过线（p50 313 ms，门槛 300 ms），同样条件下 main 也过不了，见卡点 11；它等用户在笔记本旁时重测。合入 main、改版本号、发版、覆盖安装包、部署生产托管服务都没有做，等用户另行授权。笔记本的还原还没有完成，也是待用户项，见「2026-10-05 真实安装验收结果」末尾。

**2026-10-06 更新。** 上一段说的没达成的那一项有了新结果：笔记本上的流编码计时项按事先定死的规程正式通过，分支 `a88f4eed` 退出 0，p50 268 ms。此前两次正式测量不过（313、364 ms），事后查明是在笔记本处于限频状态时量的；限频的原因没有查明，这条门槛的余量也很薄，同一轮里 main 量出过 341 ms。三次正式测量都并排留在卡点 11，用户可以推翻这个判定。类型检查、全量测试和 G0-R 在 PC 上能跑的各项在 `a88f4eed` 上也都通过。合入 main、改版本号、发版、覆盖安装包、部署生产托管服务仍然都没有做，等用户另行授权；笔记本的还原仍是待用户项。

本报告交付专用审核分支中的代码、契约、迁移措施、可复跑探针和实际证据。**尚不宣布完整目标达成**：隔离服务及跨设备公开 HTTPS/WS 链路已验证两项核心行为，受控电脑重启也已真实通过；系统默认 .proc 双击19轮handoff均无匹配测试壳回执。七轮早期记录之外，后续七轮有一轮过期点击、三轮时限保护、一轮几何错误、两轮有效窗口内的错路由；工具阻断不冒称路由实测，有效错路由也不能只归因于用户操作。笔记本普通流、W7、C6.6 两方向及 C10 正式双机复核已通过；一次偶发损坏提示的当时错误来源也未能确定，不能用后续复跑通过抵消它。矩阵中的“部分验证”与“未测”不计为整条通过。公开测试使用短时隔离入口，生产部署仍须用户审核。

实现位置：`PromptCut/.worktrees/collaboration-reopen-recovery`，分支 `codex/collaboration-reopen-recovery`，起点 `adc3ae2a31857e6edcf868ddc361fbb20e249f88`。主工作区仅按用户明确要求同步了未提交的静默 Guide，原有文件及其它任务改动保留；原始未提交计划完整带入 worktree，两个副本 SHA-256 均为 `050728C2DC6CEB1C04F7F96BCBEA07477C53A7894C09EE0975AFDCDFA31C25B8`。保留 worktree 和所有分支提交供审核。没有合入或推送 main、发版、安装运行副本、主动修改生产账户/房间或宿主机网络。双击补验共误启动现有安装版八次，它可能执行普通启动/草稿写入；不能再声称用户运行副本从未启动或用户数据绝对未写。具体经过与清理范围见本次补验记录。

此前实现提交：

- `d6e6d118` 探针：记录协作重开基线并保留授权计划。
- `dce4b22b` 修复：持久保存协作关联和身份并补齐主机登记与流式中继。
- `f6778a7d` 修复：统一刷新恢复并补齐注销持久化和跨设备中继验证。
- `5755e60d` 修复：稳定设备与旧数据迁移并保护恢复日志和节点生命周期。
- `4fcf8b06` 修复：接续中继会话并清除终止身份的旧绑定。
- `90dff9d9` 修复：保护首次设备密钥并补齐公开重开和异常验收。
- `47458680` 修：保持恢复密码不变并验证限速和迟到回调。
- `cad3a5c8` 修：区分暂时保护存储故障并保留安全恢复诊断。
- `f950874e` 探针：验证各恢复阶段首页退出和真实协作开关取消。
- `7ab1d09b` 探针：生成不安装不改关联的隔离原生测试壳。
- `4f72d19e` 探针：运行原生启动与单实例打开并核对实际依赖路径。
- `14d32af9` 探针：隔离原生测试设置并等待实际首启界面。
- `d1dab4c4` 探针：补原生普通成员及单实例打开验收。
- `8061db90` 修复：持久封锁搬迁源和切换目录代数，保护旧连接。
- `11061e98` 修复：完整流式传输、本机到云端设置入口及持久中断恢复。
- `ea9a22ed` 修复：云端到本机成员授权、加密续传任务、启动等待及 Agent 重试。
- `4bd3087f` 探针：隔离普通浏览器服务的 AI/CLI/技能配置，核对认证按钮实际命中。
- `724e98b4`、`b1d41be7`、`16f93bb0` 探针：重启验收复用配置隔离，读取夹具实际版本并核对服务端角色、云端登记和三类素材；前两次演练失败独立列明。

后续修复与报告提交可从本分支日志核对。证据目录为 [assets/collaboration-reopen-recovery](assets/collaboration-reopen-recovery/)，其中只收录非秘密结果、已检查截图和校验摘要；不包含保护存储、账户校验文件、邀请码、派生密钥或会话秘密。

本次完整集成复跑新增 `8beb06220594ae82d773cf1ba441869e744d653e`（修复补交素材等待小尺寸、隔离联动观察端）和 `99859d06d6d0af2c3c6ec7d910ac2aac8c224e63`（按实际测量档位修正在线播放夹具）。它们没有修改渲染器、解码器或卡片源码。Windows 静默规则见 [verification.md](../semantics/guide_files/verification.md)，提交 `c06cdbacf86e2f6cc5e849ce187e437eeefaa0eb`；遗漏的原生 fork 路径由 `985e41b14f22f32d4b3cd22e8c7444e5c611ce54` 补齐。

桌面包另有独立测试入口，根目录全量不包含它。补跑时 `0934f1cb` 的桌面 37 项中 35 通过、2 失败、0 取消/跳过/todo，814.1029 ms，实际退出 1（夹具 2SczoB）。失败发生在复制到临时目录的 PowerShell 清单脚本启动阶段：夹具没有像真实安装器一样指定本次进程的执行策略，脚本尚未执行就被默认策略拒绝。`e817f7caa96bc43f822973b3beb3c9ee47eaa9ae` 仅给该测试子进程增加 `-ExecutionPolicy Bypass`，保留 `windowsHide: true`、独立安装目录及 `-WhatIf`；没有改系统/用户执行策略、产品安装器或真实安装目录。修后桌面 37/37 通过的实际来源和耗时见下表；随后该提交的类型与根目录全量重新通过。首轮失败与修后结果分别保留，不能用修后通过删掉首轮记录。

## 实现摘要与文件

| 部分 | 修改及作用 |
|---|---|
| 文件关联 | `src/editor/io/proc.ts`、`procp.ts`、`drafts.ts` 与 `recoveryAssociation.ts` 保存可选的版本化房间关联；内容 ID 与房间 ID 分开。未知版本保留并明确不支持恢复。 |
| 本机身份 | `server/recovery/{descriptor,vault,paths,http}.mjs`、`server/auth/device.mjs` 使用稳定设备目录、Windows 当前用户 DPAPI、原子加密快照、上一版备份、进程互斥写入和原主机绑定。各身份按服务、房间、配置、身份类型和用户名隔离。 |
| 统一恢复 | `coordinator.mjs`、`syncManager.ts`、`collab.ts`、`collabSecrets.ts` 贯通文件、打包文件、草稿、系统路径与刷新入口；重新发现、挑战认证、等已确认项目状态，再挂接共享连接。正常恢复不建房、不生成密码。 |
| 内容连续 | `src/store/{docsync,core,project}.ts`、`actions/coreActions.ts`、`timeline/durationSync.ts` 阻止重入初始化和演示内容污染；保留未确认日志、期望版本及冲突备份；保存等待身份与操作可靠落盘。 |
| 云端登记与中继 | `server/hosting/{service,host,client,protocol,bandwidth,main}.mjs` 实现原设备登记、独占在线租约、认证发现、出站 HTTP/WS 流式中继、票据摘要授权、权限代数与禁入镜像、删除墓碑。 |
| 服务接线 | `server/hosted/{combo,files}.mjs`、`vite-plugin-docservice.ts`、`asset-service.ts`、`docservice/{service,shared-service}.mjs` 与 `vite.config.ts` 接入登记、稳定目录和素材鉴权；补齐部署文件清单，但没有部署生产服务。 |
| 生命周期 | `link.ts`、`enterFailure.ts`、`server/render-node/session-link.mjs` 接续中继路由及终止错误；`cardSync.ts`、`renderNodeHandoff.ts` 与同步管理中的 Agent 绑定串行处理，迟到票据不得交给新连接。 |
| 显式搬迁 | `server/recovery/relocation*.mjs`、`server/hosting/relocation*.mjs` 和 `server/hosted/relocation.mjs` 实现目录事务、源封锁、完整私有暂存及 HTTP 双向传输；`vault.mjs` 保护目标设备续传任务，设置页复用统一恢复。 |
| Agent 重开 | `server/agent/doc-link.mjs` 更新中继接续的页面委托票据，取票或首次握手失败继续现有退避；网关核验后剥除专用票据，原服务仍严格验证会话。 |
| 界面 | `RecoveryActions.tsx`、`SyncChips.tsx`、`CollabSection.tsx`、`MembersPanel.tsx` 区分协作已开启与瞬时连接状态，显示等待、认证、拒绝、删除、冲突及损坏；创建者改密码后更新本机记录与实时重连证明。 |
| 语义 | `docs/semantics/workflow/project.md`、`product/document-service.md`、`product/hosting.md` 只补授权计划 §10 的重开承诺；`mechanism/hosting.md` 记录实际契约与实现边界。 |
| 补丁静默执行 | desktop/scripts/patch-installer.nsi 在既有 PROMPTCUT_PATCH_NONINTERACTIVE 开关下以 nsExec 隐藏命令窗口，保留原交互入口；scripts/probes/reopen-native-upgrade.mjs 与 reopen-native.mjs 增加真实NSIS外壳更新验收。 |
| 验证 | 新增 `scripts/probes/reopen-{capabilities,baseline,e2e,exit-matrix,wan,wan-peer,online,reboot,native,native-fixture}.mjs`；新增恢复、格式、权限和竞态测试，修正现有隔离测试的目录、环境和压缩夹具。 |
| 真实安装验收 | `scripts/probes/reopen-installed.mjs`（已装构建的系统双击，主机与成员两个角色）、`reopen-installed-lib.mjs` 与 `reopen-installed-query.ps1`（回执判定、清单核对、只读的关联与进程查询）、`reopen-remote-host.mjs`（另一台机器上的隔离主机）、`reopen-public-gateway.mjs`（让临时公开入口在多机验收期间在线）、`reopen-wan-member.mjs`（只能出网的外部成员）、`reopen-sealed.mjs`（跨机器只传公钥与密文）、`reopen-installed-state.mjs`（安装前备份、验收后还原，不删文件）。都只是探针与工具，不改产品代码。 |

完整修改文件清单见 [changed-files.txt](assets/collaboration-reopen-recovery/changed-files.txt)。测试与探针都使用各自临时目录和专用房间；独立编辑器使用 5203/5206/5209，第二创建者 5215，基线 5212，在线浏览器 5223，每个编辑器另占 +1/+2 舞台端口。遇占用不结束用户进程。测试服务结束后只停止本任务创建的子进程。

## 语义、契约与旧数据

普通 `.proc` 顶层可选 `collaboration` v1：`roomId`、规范化 `service`、`where: lan|hosted` 和非秘密 `hint`。`.procp` 与草稿复用同一序列化。角色、用户名、密码、K、主机登记密钥及过期票据不写入已知格式的描述。另存仍关联同一房间，复制文件不会复制权限。没有可靠关联的旧文件仍作为本地项目打开，不按同名绑定。

Windows 凭证由当前用户 DPAPI 保护；非 Windows 使用独立私有设备密钥与 AES-GCM，不用硬件指纹当加密密钥。私有密钥经刷盘后独占发布，首次并发启动不覆盖已发布密钥；实际双进程加密写入二十身份后全部可读。稳定目录位于 `PROMPTCUT_DATA_DIR/collaboration/`，文档状态位于同目录下 `docservice/`。显式测试覆盖 `PROMPTCUT_DOCSERVICE_DATA` 仍保留。设备身份首次完整发布到 `device.json`，以后复用。加密快照临时写入、刷盘、原子替换，保留 `.bak`；损坏不猜测恢复、不写空状态。多进程更新重新读取最新快照并持互斥锁，只有原锁进程已退出才回收，不结束其它进程。

旧运行目录 `out/docservice/` 仅在稳定目录不存在时先完整复制，再原子登记；原目录保留，新目录已有内容不覆盖，外部链接拒绝自动迁入。旧浏览器记录仅在服务与房间精确匹配时迁入，可靠写入后才替换旧记录。旧文件缺少主机绑定或服务权限状态时不会因创建者密码自动启动主机；需原服务备份或明确认证。电脑重启夹具保留真实 DPAPI 记录与稳定设备文件，不依赖旧页面存储。

云端登记同房间更新，固定原主机设备与私有登记密钥；租约 30 秒、续约 10 秒，在线同时要求有效租约与隧道。不同设备或仍活动的另一实例返回冲突。云端只保存专用校验派生值、盐、名字、名单、禁入、邀请码校验副本与租约；不保存本机项目/素材字节，不接收可直接在主机认证的原 K。

成员获得最长 15 分钟的房间路由能力，主机仍独立认证并签发会话/素材票据。中继只代理规定的文档和素材路径，固定回环目标，禁止本机管理接口及重定向。用户/设备的双向所有通道累计默认 1 MiB/s，服务累计 16 MiB/s；最多 256 通道，单通道及隧道待发缓冲各限 4 MiB。页面接续保留会话与未确认队列，同时重新发现路由；网关核验后去掉自己的路由项，原服务严格核验会话秘密。

恢复退避从 500 毫秒增长到 30 秒，遵守 Retry-After。网络错误保留关联和身份；可信认证失败、禁入、删除、主机冲突、存储损坏终止盲目重试。删除/取消原子保存本机墓碑与云端注销待办，注销失败跨重启重试；成功注销不移除本机墓碑。旧文件不会恢复已注销房间。丢失或损坏服务状态不会初始化空房间。

本机存储将明确的读取/保护进程超时、占用或资源暂缺，以及确认仍存活的写锁，返回 `recovery-storage-busy` 并退避重试；解密、摘要、格式或无法确认的锁错误仍是终止的 `recovery-storage`。诊断只有固定阶段、固定错误类别及耗时，未知错误代码变为 OTHER，不返回原异常、路径或保护内容。Windows 保护进程采用遇错即停及严格 Base64 响应检查。该分类通过故障注入复现并修正，是独立证实的问题；不能据此认定此前偶发失败也是相同原因。

云端托管项目仍由云端实际托管，恢复创建者/成员连接。创建者第二设备只能恢复创建者权限，不自动接管本机主机。

显式搬迁落实现有项目工作流程，自动重开仍只跟随可信位置。房间 ID、账户和操作版本不变，目录代数递增；源先可靠封锁，完整目标 ready 后才 publish。本机到云端只由实际源设备启动；云端到本机首次由已有成员或创建者证明目标设备，云端源实际导出和发布，不增加创建者的第四项特权。目标事务、源传输能力和新登记密钥在请求前加密落盘；云端只存能力摘要，同事务中断续传不要求已封锁源再签挑战。任务完成前协调器等待，完成后设备目标绑定优先于旧文件提示。删除/取消清任务并留注销待办，迟到完成不能复活。完整契约见 [collaboration-relocation-contract.md](../plan/collaboration-relocation-contract.md)。

## 基线与开工能力探针

初始类型检查退出 0。初始全量：4,251 项，4,249 通过、0 失败、2 跳过（舞台界面测试缺测试 URL；PowerShell 外部 deflate 夹具缺模块）。**两项初始跳过不算通过**。后续独立舞台提供 URL，deflate 夹具改用 .NET 并确认 ZIP 方法 8，最终没有跳过。

上一组类型与全量基线对应已提交版本 `16f93bb0`，其产品源码与 `ea9a22ed` 相同，只补重启探针隔离及证据核对。见 [verification.json](assets/collaboration-reopen-recovery/verification.json)：`npx tsc -b --force` 退出 0；`npm test` 全量 4,316 项全部通过、0 失败、0 取消、0 跳过、0 todo，54,847.4761 毫秒。早期渲染抽样来自 `4bd3087f` 的隔离环境：两次导出帧 0–9，10 帧逐像素相同、0 不同；统一帧验证覆盖实际视频/卡片、随机重放、精确 seek、缓存和累计帧、PNG 帧表与 10 帧存储，全条退出 0。上述历史记录保持原来源；本轮完整集成补验见下一节，不以十帧抽样替代全长门槛。各原始日志对应的提交、实际退出码和 SHA-256 分别记录于 verification.json，不把初始、历史及最终日志混写为一个版本。PC 的功能结果不能证明笔记本的性能门槛通过。

提交后 `npm run build` 对应 `16f93bb0`，退出 0，实际耗时 7,972 毫秒，1,830 模块。构建使用隔离配置、数据、导出和素材目录，没有安装产物；native config/Lottie eval/动态导入/chunk size 及 doc plugin 扩展名解析提示均为警告。

阶段历史另保留：`14d32af9` 全量 4,286/4,286，52,190.099 毫秒；原生普通成员及打开修复后 `d1dab4c4` 4,286/4,286，52,795.4009 毫秒；源搬迁封锁版本 `8061db90` 4,294/4,294，52,784.1366 毫秒；本机到云端版本 `11061e98` 4,308/4,308，53,758.1702 毫秒；双向搬迁产品版本 `ea9a22ed` 4,316/4,316，54,911.0132 毫秒，报告提交 `dc8b2412` 构建退出 0、7,616 毫秒。五轮全量均零失败/取消/跳过/todo；这些记录只证明各自版本，不代替当前基线。前一组最终原始日志另保留于忽略目录 `work/baseline-ea9/`。

重启探针补充前的 `4bd3087f` 全量 4,316/4,316、54,708.7969 毫秒、零失败/跳过，构建退出 0、7,593 毫秒；其类型/测试/渲染/构建原始日志与来源表另保留于忽略目录 `work/baseline-4bd/`。

初始能力证据见 [capability-baseline.json](assets/collaboration-reopen-recovery/capability-baseline.json)：

| 能力 | 开工结果 | 本次结果与边界 |
|---|---|---|
| 文档、版本、账户持久化 | 已有；真实子进程停止/重启，PID 改变，原房间、账户认证和成员编辑，版本 1→2 | 稳定目录与防空初始化补齐；桌面主机/成员/云端真实子进程重启再次验证 |
| 云端登记、发现、租约、中继 | 源码/部署 `hosting/register/challenge/resolve/relay` 均 404；部署健康检查 200，但 hosting 健康检查 404 | 新增独立登记和流式中继；隔离真实服务与远端测试主机通过；生产未更新 |
| 系统秘密保护 | Windows CurrentUser DPAPI 实测退出 0 | 实际保护存储跨实例读取，磁盘无明文 K；跨进程写入合并与退出锁回收通过 |
| 公网 HTTP/WS 测试入口 | 远端随机隔离端口不可公开访问；已有允许的公开入口均被现有服务占用 | 原有 SSH 测试链路保留；后续通过免费临时 HTTPS/WS 入口，远端成员真实加入、两次凭证恢复、双向编辑及三类素材核对；未改防火墙/反代/现有服务 |

## 本轮合入前完整验证（2026-10-04）

本轮逐项证据、实际 Node 命令、来源提交、退出码、原始日志 SHA-256 和未测/跳过结果见 [integration-verification.json](assets/collaboration-reopen-recovery/integration-verification.json)。原始日志与全长导出帧保留在任务自有临时目录；JSON 使用脱敏目录代号。基线执行的是 package 脚本对应的 Node 参数，表中 npx/npm 是等价仓库入口，不伪称执行了未调用的外层命令。

| 检查 | 实际结果和证据范围 |
|---|---|
| 类型与全量 | 最新实际基线 2f2650b32cf47f0560654cfe724724c10bbefd16：类型退出0、5149 ms；全量4330/4330，失败/取消/跳过/todo均0，57362.7036 ms，进程墙钟57417 ms。实际 Node 参数对应 npx tsc -b --force 和 npm test；准确命令/原日志摘要见 native-final-baselines.json。4c5474e4的4330/4330（65414.4937 ms）、faf6b74b（53607.0186 ms）及此前1ec和faa首轮4329/1失败均保留原来源。 |
| 桌面独立测试 | 2f2650b3 实际 node --import=./scripts/lib/test-silent-processes.mjs --test desktop/test/*.test.mjs 退出0，37/37、失败/取消/跳过/todo均0，907.8663 ms。4c5474e4的37/37（826.9148 ms）、faf6b74b（900.5122 ms）与aba历史另保留。用隔离目录和测试进程执行；没有覆盖用户运行副本。 |
| 网页构建 | 已提交且干净的 b7ccb0dfbc59c4cb3629612ddf586ccd574936b8 实际 npm run build 退出0、6425 ms、1830模块，独立原日志SHA b23c61fdcf644ef1bfdbd0da9f4efdee35d0a5183971e4ecb5dcb99cca0ee5d3；b7相对2f只改报告/证据。4c的0/6981ms、faf的0/6713ms及b098历史0/7821ms分别保留。463b历史原日志被可变路径覆盖，仍明确不可再核验。没有覆盖原安装包。 |
| 完整桌面候选包构建 | fb1d2ab06a23da6328a18e0aedb2d2a9592091fa 的独立源码仓库实际 Node npm-cli.js run release -- --from-head（等价桌面 npm run release -- --from-head）退出0、548956 ms；运行时组装、Rust release、NSIS完整setup和真实补丁EXE均构建成功，2497件清单SHA逐件匹配、三个安装器文件匹配提交。Python刷新/检查及runtime --check均0。使用隔离诊断配置，未安装、未发版、未覆盖原包；修后轮2次进程后台采样可见自有窗口0，首次两次13进程采样另保留。首次静默等待器挂起的外层退出1、被精确清理的等待器4294967295、npm退出码未取回，不计通过；修后直接等待process handle，自测成功0/失败7回传均正确。见 [desktop-candidate-build.json](assets/collaboration-reopen-recovery/desktop-candidate-build.json)。 |
| 全长导出确定性 | 113b425c 实际默认60秒、30fps、1920×1080项目两遍完整1800/1800帧相同、0不同，315983 ms，退出0。aba仅修改两个探针，产品和 renderer 未变；不把113的实跑改写成aba复跑。 |
| 与 main 全长像素对账 | 113b425c candidate 与只读 adc3ae2a main 基准各实际1800帧，0不同/0缺失，退出0。具体日志及来源见 fixed-baselines.json；不是十帧抽样。 |
| 统一帧 | 113b425c 全条实际退出0、8394 ms，实际视频/卡片、seek、随机重放、缓存与帧表均覆盖。初次错误根路径404仍保留。 |
| 就绪索引 | ready-index 退出 0、170,120 ms；测试自有预渲染服务真正停止并重启后的扫盘恢复也覆盖，fails: []。 |
| 普通及组轨道流 | 普通流已由笔记本在113正式复核：编码三值264/294/307 ms，p50=294≤300，最大442742 B、alpha.mean 0.0956/0.069，F5三流恢复、重产出0。组流44,225 ms的PC功能结果保留；--group按原脚本不执行编码p50门槛，未把PC值当笔记本值。 |
| 预览兜底 | 普通退出 0、99,251 ms；page-preload 单独 FK2RDo 退出 0、83,423 ms，均 fails: []。初次串行启动时端口未释放的错误不抹除。 |
| 共享导入与打包 | 素材补交修复后最新共享导入 99859d06d6d0af2c3c6ec7d910ac2aac8c224e63 实际退出 0、18,646 ms，失败 0；打包 99859d06d6d0af2c3c6ec7d910ac2aac8c224e63 实际退出 0、26,496 ms，失败 0。三件素材上传与后加入成员读取/解码、空设备三份素材及导出音频的原始结果按日志来源保留。正常重入仍无初始化权限。 |
| 队列压测与对照 | 四轮退出 0；8 节点默认锁定 race 8、steady 0，对照 prefilter off 共 400 次 cardLocked（steady 396），lock-first 全 0；20 项目×10 节点、500 任务的观察者归属全部正确，外房间事件 0。角色均为同一台 PC 的子进程，不能替代跨设备。 |
| 纯浏览器节点 | 113 正式真实双机 W7 creator 汇总退出0、17项/59parts全过、fails/pending空；笔记本 node 实际退出3，26个适用parts全过，5个creator专属空项如实pending。A4最慢22945≤30000 ms，A5闲置前500ms认领0、实测638ms恢复，播放及预渲染主文档longtask均0。旧同机6项pending不删除，也不当成新正式结果。 |
| 节点故障集成 | e3 服务真实停止/重启、e2 应用层停顿与任务接管、e4 交错 Agent 修改均退出 0，fails: []。e6 正方向退出 0、446,847 ms，20 任务全完、其它指纹认领 0；脚本明确跳过反方向，跳过仍保留。e1 退出 0、1,599,319 ms：真实 50 任务完成数 15/18/17，模拟 50 任务全完；多节点与重新单机生成的 3,000 HTML 全部逐字节相同，styleOrderOnly 0。旧多场景 harness 的起点 HEAD 与运行中辅助修正范围限制保留，不改写为不可变源码的验收。 |
| 卡片同步接续 | d62cd2c3 退出 0、32,076 ms：成员 opens 1→1、resumes 0→1、版本 2 只装一次；安装 586 ms、重测 1,801 ms；舞台重载 0、黑帧 0。已查看成员 v2 画面。均为 PC 功能及参考计时。 |
| 搬迁复用及界面 | d62cd2c3 退出 0、29,963 ms，源服务真正停止；同房间切到目标，版本 1→2；4 项 ready 复用、renders 0、4 份清单匹配；素材原件 262,144 字节、12 件 snap 迁入，px 原夹具为空；旧地址→新地址→进入页面，禁止请求 0、页面错误 0。已查看进入画面。 |
| 素材/卡片/节点联动 | aba4c1f9 两个真实设备、交换角色的正式两轮均通过。笔记本observer权威重测2140≤5000 ms，1249采样覆盖换档、黑帧0；反向PC observer1062采样、黑帧0且覆盖换档，两轮都是帧75→75。8任务恰一、8清单、480块无缺失。六个角色实际退出均0；旧113反向零采样与旧6187ms失败保留。见 laptop-c66-aba.json。 |
| 在线 plan 反向指纹 | aba4c1f9 正式全项真实双机 C10 creator/PC独立Yhost均0，fails/pending空，9条E6检查全过；实际Y Chrome150指纹de57ec1a7cffba6b，与笔记本Chrome152的258acaaa7c5fe509不同。15任务中9个live全完成、6个superseded；3纯层/18次观察无混层。X是原协议claimer，未夸大为独立X渲染主机。轻卡3秒实判light，seek在3.033秒产生估时判断（因rate不足不交换）；自然0→299连续、breaks0、longtask0。见 laptop-c10-aba.json。 |
| 在线导出票据续签 | 99859d06d6d0af2c3c6ec7d910ac2aac8c224e63 实际退出 0、381,242 ms；失败 0。实际 300 帧导出 124588.5 ms，隔离票据时限 20000 ms，续签 9 次/失败 0、素材换票 18 次，等待原尺寸重试 5 次。只在 PC 隔离替身执行。 |
| 电脑重启 | 33d7106f 默认探针退出 0，actualComputerRestart:true，原检查点恢复原房间及原身份；登记 online、版本 12→14、双方编辑、三类票据素材均通过。 |

Windows 静默要求已经写入 guide_files/verification.md（完整提交 c06cdbacf86e2f6cc5e849ce187e437eeefaa0eb）。测试预加载辅助及后代使用 windowsHide；其修正没有改产品 ffmpeg 或运行副本。新增四例实际子进程检查覆盖 Promise 的 stdout/stderr、child、错误回包、显式隔离目录及 fork IPC。辅助脚本曾清除显式测试目录（全量 25 例失败、e6/e1 启动失败），后又破坏 Promise 输出并导致一次本任务流探针挂起；失败、停止和修正分别保留在 JSON。只有经身份核实的本任务挂起进程树被停止，没有结束用户进程。修后普通流实际解码通过。用户再次指出前台弹窗后，核实本任务深层 render-worker 的 fork 没被辅助脚本覆盖；四个窗口按测试进程链、控制台创建时刻与程序标题确认后最小化，未杀进程。985e41b1 补 fork；原生 fork 子进程仍存活时实测新增可见命令窗口 0、IPC 正常，退出 0，之后桌面复查可见命令窗口 0。前台问题不能仅以写入 guide 或外层 windowsHide 宣称解决。后续真实联动复跑仍有 107 个本任务进程存活时，可见命令窗口实测为 0。

用户再次核对原路径的 guide 时，发现两条静默规则已在专用分支提交，但原工作区尚未同步。已按用户明确要求将同样两条纯文档规则同步到原工作区 `docs/semantics/guide_files/verification.md`，作为未提交文档改动保留；没有提交 main 或混入产品合并，原计划文件保持不变。最新一轮测试结束后，检查本任务进程及桌面控制台，可见命令窗口均为 0；这只报告检查时的实际结果，不据此否认用户此前看到的弹窗。

全长 renderer 证据保留 c70b277f 来源。c70b277f 到 d62cd2c3 的产品源码未变；8beb0622 随联动验收修复素材补交等待小尺寸的服务端路径，99859d06 修正在线浏览器验收夹具，e817f7ca 只修桌面测试夹具的启动参数。renderer、decoder、卡片、package 与 vite 源文件仍未变；faf6b74b修改desktop补丁NSIS外壳，9a17a778修改隔离探针时限与截止机制。旧渲染证据保持实际来源，不冒称新 HEAD 的重跑。本轮笔记本正式复核已完成；系统默认文件关联双击19轮handoff尚未通过，不能宣布完整验收全绿或执行条件式 main 合入、发版及安装包覆盖。

已查看本轮三张画面：[卡片版本 2 接续](assets/collaboration-reopen-recovery/integration-card-sync-v2.png)、[搬迁后进入项目](assets/collaboration-reopen-recovery/integration-migration-entered.png)、[联动成员视频与源码更新提示](assets/collaboration-reopen-recovery/integration-t9-member-v2.png)；来源及 SHA-256 见 [联动截图与检查记录](assets/collaboration-reopen-recovery/integration-images.json)。截图只证明实际可见内容，帧号、素材清单及无黑帧由探针测量。

最新相关产品修复提交为113b425c（同身份热更新保留测量）与aba4c1f9（两份正式探针的初始化/轻卡前提）。[笔记本与双机补充报告](REPORT-collaboration-reopen-laptop-validation.md)逐项保留顾问调用、纯函数/只读诊断、失败和正式通过；[fixed-baselines.json](assets/collaboration-reopen-recovery/fixed-baselines.json)与[aba-baselines.json](assets/collaboration-reopen-recovery/aba-baselines.json)保留实际全量、渲染与构建来源。原主机/成员重启链路、恢复vault/coordinator/目录登记/中继代码在33d7106f真实电脑重启之后未改变；后来产品变化仅测量重排和补交素材先小后大的修正，旧重启与公开WAN证据仍如实注明原提交。

主执行计划第8节的视频取帧节奏与seek竞态附加探针本次未复跑：本分支没有修改取帧、解码、图卡视频源或frameMedia.ts，未触发该条必跑条件；不是把未跑项计为通过。带计时门槛的普通流与真实双机项已在笔记本执行，其余G0-R计算与功能项在PC执行。

## 桌面、在线及跨设备证据

四种桌面组合均真实停止并重启主机/成员/云端测试进程；用空浏览器存储、新端口、旧文件重入。两个身份为 `creator:host` 与 `member:member`，恢复的新建房间调用数均为 0。保存文件前后共四次双向修改均由另一端读回；素材 media/snap/px 各 50,000 字节，带重新取得的票据读取，字节数与 SHA-256 核对通过。

| 组合/链路 | 稳定房间与版本 | 证据 |
|---|---|---|
| 本机·限定 | 同房间，版本 6；主机离线打开、登记重试、成员等待后自动加入；创建者改密码再重连、第二创建者不接管、删除清旧绑定 | [lan-restricted.json](assets/collaboration-reopen-recovery/lan-restricted.json) |
| 本机·自由 | 同房间，版本 6；第二创建者删除，原主机也持久注销，成员离线期间删除后明确终止 | [lan-free.json](assets/collaboration-reopen-recovery/lan-free.json) |
| 云端·限定 | 同房间，版本 5；创建者/成员恢复，托管位置保持 hosted | [hosted-restricted.json](assets/collaboration-reopen-recovery/hosted-restricted.json) |
| 云端·自由 | 同房间，版本 5；位置、身份及票据恢复 | [hosted-free.json](assets/collaboration-reopen-recovery/hosted-free.json) |
| 跨设备外网中继 | Windows 原主机与远端 Linux 成员/隔离网关，三个新成员进程，版本 3→7→9，后两次读取原设备凭证，无密码交互，三命名空间哈希通过 | [wan.json](assets/collaboration-reopen-recovery/wan.json)；标明 `publicHttp:false` 时只证明实际 SSH 测试代理链路 |
| 跨设备公开 HTTPS/WS·自由 | 独立临时公开入口；Windows 原主机与远端 Linux 成员均走公开入口，房间连续，版本 3→7→9；后两次新成员进程不输入密码，三命名空间各 50k 哈希通过 | [wan-public-free.json](assets/collaboration-reopen-recovery/wan-public-free.json)，`publicHttp:true`、`temporary-public-https-tunnel` |
| 跨设备公开 HTTPS/WS·限定 | 独立名单中的远端成员，原主机重启后两次新进程凭原记录自动恢复；同房间与版本 3→7→9、双向编辑、三类票据素材核对 | [wan-public-restricted.json](assets/collaboration-reopen-recovery/wan-public-restricted.json)，`publicHttp:true` |
| 恢复主体代码·公开 HTTPS/WS·限定 | `sp_3xq3wmyogm4cm4qvvdwjrivp3j`，版本 3→7→9；远端成员三个独立 PID 149317/149397/149460，后两次凭原设备记录恢复；主机真实重启、双向编辑和三类 50k 素材核对通过 | [wan-public-restricted-latest.json](assets/collaboration-reopen-recovery/wan-public-restricted-latest.json)，实际源码 `5ece2b4e`，当时产品源码与 `ea9a22ed` 一致；不改写为后续素材补交修改后的重跑 |
| 恢复主体代码·公开 HTTPS/WS·自由 | `sp_dstshzdvkgx3ii6cxck2dsdzet`，版本 3→7→9；远端成员三个独立 PID 150252/150325/150387，后两次凭原设备记录恢复；主机真实重启、双向编辑、三类 50k 素材及节点认证通过；本轮测试服务的提供商配置隔离已实际断言 | [wan-public-free-latest.json](assets/collaboration-reopen-recovery/wan-public-free-latest.json)，实际源码 `4bd3087f`；真实点击命中且 `speechPromptDismissed:false`，来源范围同上 |
| 桌面扩展矩阵·自由 | 离线日志跨真实成员进程重启，真实重放/丢弃界面与落盘备份、多窗口双向编辑、迟到身份回复取消、旧浏览器身份迁入后新进程自动恢复、踢出/解禁及改密码、损坏提示 | [matrix-free.json](assets/collaboration-reopen-recovery/matrix-free.json) |
| 桌面扩展矩阵·限定 | 同上，加名单移除后真实认证；从系统路径打开后回首页并刷新留在首页，扩展操作后的持久版本 12 | [matrix-restricted.json](assets/collaboration-reopen-recovery/matrix-restricted.json) |
| 云端自由扩展矩阵 | 邀请兑换加入、作废/过期拒绝旧码、成员真实重启后凭原身份重入；旧密码查看记录迁入保护存储并在真实 UI 核对；设置不生成新密码；暂时存储故障 2.016 秒后自动恢复，认证冷却 60.395 秒后重新认证，最终版本 11 | [matrix-hosted-free.json](assets/collaboration-reopen-recovery/matrix-hosted-free.json) |
| 本机限定·首页退出及协作取消 | 身份读取、主机恢复、LAN 发现、接入并登记四个实际请求成功后延迟回复；实际点首页、迟到回复、刷新，旧连接及节点绑定均清除，主机登记撤销；恢复后真实关闭协作保留最新内容，旧文件不得重建房间 | [exit-lan-restricted.json](assets/collaboration-reopen-recovery/exit-lan-restricted.json) |
| 云端自由·首页退出及协作取消 | 身份读取、成员挑战接入两个实际网络阶段逐项退出；身份未确认时协作开关禁用，确认创建者后真实取消保留最新内容并注销房间；云端没有本机主机恢复和 LAN 发现阶段，这两项不适用 | [exit-hosted-free.json](assets/collaboration-reopen-recovery/exit-hosted-free.json) |
| 独立原生壳·启动参数及单实例转发 | 本机限定房间 `sp_6gaxnlr6vkvodi4zcasvj35imd`，版本 5；真实正常退出后 PID 45416→31344，从另一运行目录以原文件启动、空 WebView2 配置、稳定设备身份；成员 PID 49580→54108，先等待后自动加入；四次双向编辑、三命名空间 50k 哈希、原文件不变、零恢复建房；实际第二启动事件正确转发给已有窗口 | [native.json](assets/collaboration-reopen-recovery/native.json)；系统默认文件关联双击和安装升级未操作 |
| 独立原生壳·普通成员 | 房间 `sp_sj3cwhe2yaliev4tkfncxpclzx`，版本 5；原生成员 PID 35096→36972，主机 PID 31176→40536；真实首轮认证 UI，之后旧文件/空 WebView2 及运行副本切换自动恢复普通成员，creator/hostBinding 均 false；四次编辑、三类 50k 素材、原文件不变及零建房 | [native-member.json](assets/collaboration-reopen-recovery/native-member.json)；[已检查截图](assets/collaboration-reopen-recovery/native-member-restored.png) |
| 独立原生壳·主机复跑 | 房间 `sp_l47bcyc5rghylvo2p2vcjmovhz`，版本 5；主机 PID 19248→38656，成员 PID 48228→29524，真实首轮认证；原主机绑定、等待后加入、四次编辑和三类 50k 素材连续 | [native-host-repeat.json](assets/collaboration-reopen-recovery/native-host-repeat.json)；[已检查截图](assets/collaboration-reopen-recovery/native-host-repeat-restored.png) |
| 原生云端自由房间·设置页搬回本机 | `sp_mruimbzao2upcus5ti2wcdv72v`，版本 5→7；实际点击设置动作，旧 hosted 文件恢复真正目标主机，保存位置 lan；真实停止/重启目标服务后双方 Agent/render 认证，双方各改一次、三类 50k 素材哈希一致；恢复建房 0 | [relocation-lan-free-nodes.json](assets/collaboration-reopen-recovery/relocation-lan-free-nodes.json)；[已检查设置完成截图](assets/collaboration-reopen-recovery/relocation-lan-free-ui.png) |
| 限定本机房间·完整往返及节点 | `sp_xtra4kb4fr54z2cyvujhmb6u3m`，原恢复版本 6，搬到云端后原文件跟随 hosted、真实云端重启；再搬回原设备版本 9→11，旧 hosted 文件恢复主机、真实目标重启、双方 Agent/render 认证；每方向双方各改一次、三类 50k 素材哈希一致，恢复建房 0 | [relocation-roundtrip-restricted.json](assets/collaboration-reopen-recovery/relocation-roundtrip-restricted.json)；[已检查云端完成截图](assets/collaboration-reopen-recovery/relocation-roundtrip-hosted-ui.png)、[本机完成截图](assets/collaboration-reopen-recovery/relocation-roundtrip-lan-ui.png) |
| 纯在线自由/限定 | 浏览器真实刷新后恢复同一成员；双向编辑、版本 4、托管仍 hosted；桌面本机接口请求数 0 | [online-free.json](assets/collaboration-reopen-recovery/online-free.json)、[online-restricted.json](assets/collaboration-reopen-recovery/online-restricted.json) |
| 新配置隔离后的纯在线自由/限定 | `4bd3087f` 两种模式分别实际刷新，原身份、双向编辑、版本 4 和 hosted 连续；桌面本机 API 请求数都为 0 | [online-free-latest.json](assets/collaboration-reopen-recovery/online-free-latest.json)、[online-restricted-latest.json](assets/collaboration-reopen-recovery/online-restricted-latest.json) |
| 电脑重启夹具演练 | 真实主机/成员新进程、空浏览器、稳定设备/DPAPI、双向修改、50k 带票据素材哈希通过；`actualComputerRestart:false` | [reboot-dry-run.json](assets/collaboration-reopen-recovery/reboot-dry-run.json)，**不算电脑重启通过** |
| 最新重启夹具演练及默认门槛 | `16f93bb0`，同房间 `sp_e2uowvu7stzt3esqfeh7v4aj63`，服务端角色 creator:host/member:member；版本 10→12、双方编辑、云端登记 online、零建房、三命名空间各 50k 票据读取 200/哈希通过、空浏览器且未加载真实提供商凭证。默认模式实际退出 2 并保留夹具，没有启动服务 | [reboot-dry-run-latest.json](assets/collaboration-reopen-recovery/reboot-dry-run-latest.json)、[reboot-probe-audit.json](assets/collaboration-reopen-recovery/reboot-probe-audit.json)；仍为 `actualComputerRestart:false`，**不算电脑重启通过** |

已检查等待主机、无凭证认证表单、连接成功、删除及纯在线恢复截图。另已逐张检查扩展矩阵的冲突重放/丢弃、踢出、未知版本、缺主机日志、坏保护记录、密码失效及暂时存储等待八张截图。认证截图密码输入为空；密码失效明确提示重新认证且本地内容保留；等待状态保留协作开关和本地内容，没有显示“未开启协作”。暂时存储等待明确显示保留原身份、自动重试；其恢复有独立 API 故障注入、单元和真实浏览器证据。

另已检查实际首页退出和两种位置的协作取消画面；发布的 [本机取消截图](assets/collaboration-reopen-recovery/cancel-lan-restricted-ui.png) 与 [云端取消截图](assets/collaboration-reopen-recovery/cancel-hosted-free-ui.png) 显示关闭协作、保留最新项目及清除房间关联，密码输入为空。首页截图仅保留于隔离探针目录，不发布无关的扩展配置画面。

已检查并发布 [原生恢复截图](assets/collaboration-reopen-recovery/native-restored.png)：原生主窗口显示恢复后的最新项目，首启设置已关闭；画面中的缺少语音引擎提示属于隔离壳现有扩展状态，未安装扩展或执行账户操作。首轮被设置弹窗遮挡的截图没有发布；其设置读取未覆盖到探针隔离，后续以专用 AI/CLI/技能配置路径补齐，并在真实测试实例断言未加载用户提供商凭证。

原生壳来自干净提交 `4f72d19e` 的跟踪源码，`cargo build --locked --offline` 在新临时目录编译成功，49.05 秒；二进制 SHA-256 为 `6dbd26160cd06e296e49c65b3ef70c51c02a22ee943d2af4c12a84c1123b6e27`。探针 `14d32af9` 对该副本做验收，二者间只改探针，不改产品源码。生成器只在临时源码中替换端口、目录、浏览器配置与测试来源权限，使用独立应用标识隔离单实例及插件状态，拒绝复用占用端口。文件启动/事件转发/项目打开/恢复业务代码保持原逻辑；没有生成安装包或改变系统文件关联。生成副本中的未使用变量/函数提示及链接器信息不影响编译退出 0。

补充普通成员和主机复跑使用同一 `4f72d19e` 原生二进制与其运行时副本，探针来自 `d1dab4c4`；是原生打开及核心恢复的历史证据，不将其扩大为后来新增搬迁代码的原生壳验收。补充截图中的语音扩展建议属于隔离壳现有首启 UI，测试只关闭提示，没有安装引擎或调用真实提供商；普通成员实际首轮认证及新连接已分别断言，未把已有窗口的旧连接当单实例打开成功。

实际电脑重启补验：`node --import=./scripts/lib/test-silent-processes.mjs scripts/probes/reopen-reboot.mjs <重启前隔离目录>`，源码 `33d7106f943e38a21d4db5a2e749d0d2a35915aa`，退出 0。两个主进程均新建，浏览器存储为空，提供商配置隔离成立。原检查点、原文件、凭证和设备绑定未替换；三命名空间素材按原夹具哈希读取。证据见 [physical-reboot.json](assets/collaboration-reopen-recovery/physical-reboot.json)。

## 原生安装更新与系统双击补验

新增提交不改产品桌面 Rust、渲染器或恢复业务源码：`422ee2e9`、`18b7ebb7` 实施真实补丁更新及子进程模块路径隔离；`6cead05a`、`e2552d07` 提供不继承父测试环境的私有原生启动；`2ade9991`、`ccdf8113`、`7e8e46b0` 实施短时打开命令、独立恢复守护及实际 Explorer handoff；`463b085b` 把控制文件移入预先存在的子目录，避免它们改变 Explorer 根目录文件排序；`faa38f73` 等待Shell关联通知送达；`1ec99174` 增加临时独立文件类型和异常清理自测，并修正文件锁测试的完成时序。来源、耗时和原日志摘要见 [native-final-baselines.json](assets/collaboration-reopen-recovery/native-final-baselines.json)。

`faa38f73` 的类型退出0，全量4330项中4329通过、1失败，56682.6337 ms；失败是 `server/test/proc-lock.test.mjs` 并发接管用例，记录了两个赢家。其固定2500 ms持有窗口可能早于慢启动竞争者结束，不能据此声称产品一定同时双赢。`1ec99174` 只改该测试，让赢家活到全部竞争者已报告尝试；不改产品锁实现。单文件9/9、退出0/5181.2943 ms，随后完整4330/4330、类型0。第一次网页构建调用被私有脚本的纯报告未提交检查提前拒绝（外层退出1，npm未启动）；保留该失败，不冒称网页编译失败。

主机和普通成员两次 `--patch-upgrade` **通过**，见 [native-upgrade.json](assets/collaboration-reopen-recovery/native-upgrade.json)。实际使用提交中的 `desktop/scripts/apply-patch.ps1`，摘要 `0800b2b8ef1981eeb866bb4adcf490c18dae4c8dbdbae816890a921d6d95e8bb`，在任务安装副本 copy-B 上更新2044个文件；没有修改安装器代码或伪造版本。应用版本仍为0.7.14，是旧 `4f72d19e` 源码到新提交的真实代码更新；最终发版版本号尚未变更。主机安装来源18b7ebb7，实际补丁退出0/17172 ms；成员来源e2552d07，退出0/8095 ms。两个方向更新后验证文件摘要、外壳字节不变、data/member保护状态字节不变，再由真实原生新进程重开；主机creator/hostBinding为true，普通成员两项为false。分别保持房间、版本到5、零建房、4次双向编辑、三命名空间50k带票据素材哈希一致。没有运行NSIS外层安装器，不能扩大为最终完整安装包验收。首次模块路径失败及不完整旧夹具失败也保留在同一证据中。

系统默认 `.proc` 双击 **尚未通过**，见 [native-os-handoff.json](assets/collaboration-reopen-recovery/native-os-handoff.json)。已有原生参数启动、单实例转发及新私有启动冒烟均通过；它们不等于系统双击。七次真实 Explorer handoff最终均退出1、无本次匹配的原生启动回执，不计通过。第一次在准备阶段超时，没有改关联；第2—6次只短时替换当前用户已有 ProgID 的打开命令；第7次暂时把`.proc`默认字符串指向本次新建的独立测试类型，原ProgID命令未改。独立守护和finally均恢复原值（退出0），第7次测试类型也已清理。没有改UserChoice、账户、安全设置或安装运行代码。所有关联控制文件仅留在忽略的隔离目录，公开证据只含布尔结果和摘要。

用户明确告知前四次期间正同时操作电脑；此后取得独占桌面时间再测试。第5次在静态目录、fresh截图及HKCR打开命令精确匹配测试壳的条件下仍走原安装版（创建14:53:39.274479Z，armed14:53:26.886Z，恢复14:53:52.984Z）。第6次等待通知完成并真实F5刷新仍失败（PID39928，创建15:13:23.563821Z，armed15:13:05.465Z，恢复15:13:31.843Z）；第7次独立测试类型仍失败（PID49016，创建15:29:25.078918Z，armed15:29:08.539Z，恢复15:29:35.247Z）。这些UTC时刻均在各自租约内；不能只归因于用户操作或未发送通知。四次误启动PID38772/42284/39928/49016均核验时间、exe和隔离文件参数，只清理这四个新启动的匹配进程及各两名同次直接子进程，不结束其它进程。正常关闭曾被几何/截图或输入保护挡住，后改用精确进程身份清理。没有主动编辑用户项目/账户、安装或覆盖运行代码，但运行版可能执行正常启动及草稿写入，不能断言用户数据绝对未写。误开的测试JSON所属编辑器已不在本次可操作窗口列表，未擅自结束其进程。

后台只读API诊断没有启动应用：旧ProgID命令租约内，AssocQueryString的`.proc`及ProgID command/exe均匹配隔离壳，恢复后回原值；COM有效默认类型始终是原ProgID。首次COM包装调用失败，修正后的查询成功，分别保留，不抹去部分失败。独立ProgID诊断证明32/64位HKCU/HKCR直接读取的`.proc`默认字符串四项均为测试类型，AssocQueryString和COM有效默认仍为原类型。这是“注册表默认值与Shell实际选择不同”的证据，不能把新模式说成有效handler已切换。后续同一租约窗口的IQueryAssociations及owned文件的IShellItem.BHID_AssociationArray查询也分别确认：旧命令模式的null/open两动词均选择测试壳；独立类型模式仍选择原类型。SHGetAssocKeys未导出，完整key数组查询未通过，不能被脚本退出0掩盖。FindExecutable返回42、三期同摘要；只读候选枚举将该摘要对应到qtcreator.exe，和安装PromptCut不同，不能拿它证明Explorer实际调用来源。诊断是忽略目录内未提交的一次性辅助代码，其原结果及日志摘要在handoff JSON；尚不能把缓存定为唯一原因，也不冒称已提交产品探针或实际双击成功。

独立类型守护在已提交1ec99174上自测退出0：正常恢复、超时、持有者退出均恢复并清理；六个创建中断点的arm故意退出1，watchdog均0、入口恢复且测试类型删除；外部入口变化保留并退出71，外部测试类型新增值保留并退出79，后者不算完整清理成功。只读审查曾指出部分创建残留与清理未完误报0两处缺陷，已按实际自测修正。注册表复查和单节点删除不是跨进程事务，不能承诺扫描后并发新增状态也绝对不会被触及；额外子树并发窗口未作确定性测试，保持残余风险记录。

两位独立Gemini 3.1 Pro High只读顾问完成两轮，冻结权限、无工具调用，完整公开回答已由根Agent读取；会话、实际退出码及累计元数据见上述handoff证据。关于“没有发送通知”的推测被实际代码否定，不采用。该阶段30秒最大租约和匹配回执标准保留；后续明确opt-in的90秒探针只改变操作窗口，详见新增记录；主机/成员与已运行窗口的系统双击仍须实际通过。依据解法表规则，已安排Codex max独立只读攻坚，检查执行身份、注册表视图和Shell关联候选；未给它真实关联写入或UI权限。最新构建及根目录基线全绿不能补足这个缺口。

后续七轮全部保留真实退出1，不与前七轮混写原因：run-meGijX的安装版创建16:09:47.784992Z晚于恢复16:09:46.913Z，不能证明新目录候选无效；naCa2u/nQZmzc/48o2lc被即时检查挡住过期点击或导航，没有继续盲点；LX9flc返回`coordinate input geometry is unavailable`，点击结果按未知记录，未观察到匹配误启动；这些均是未完成，不计路由通过。run-dBtkun在旧命令租约下先确认本轮fresh BHID匹配测试壳，armed16:22:39.732Z后才进入新目录，截图/条目确认16:22:41.860Z，真实双击16:22:58.840Z仍启动安装版52696（16:22:59.202969Z），恢复16:23:05.968Z。它实际削弱了“提前枚举目录”这个窄解释。

只关闭本会话创建的Explorer窗口后，它所属50380进程自然退出，用户Shell11120保留；没有主动终止Explorer。随后本会话新建目录进程3388（16:27:20.930806Z，注意早于租约）再试：run-fBmwWR的fresh BHID匹配，armed16:32:43.692Z，观察16:32:45.756Z，截图坐标双击16:33:04.647Z，安装版4056创建16:33:04.904332Z，恢复16:33:09.719Z。这是新的Explorer进程仍错路由的实测，不能扩大成“进程是在租约后创建”的证据。新增误启动46384/52696/4056均核验精确身份后清理，每个各两名直接子进程；共七次的普通启动写入风险保持披露。最后任务目录窗口已关闭，所有短时关联watchdog退出0，完整主机/成员双击及OS已有窗口转发仍未通过。

Codex max攻坚全文及各只读命令已由根Agent审阅，摘要在handoff JSON。相同用户/认证/session/中等权限和一致32/64视图排除了简单上下文错位；原ProgID没有DDE/Delegate/DropTarget等替代字段，但未扫描全注册表、未证明Explorer所有线程从不模拟身份。GetShortPathName把owned文件变成ORIGIN~1.PRO，.pro查询与FindExecutable的Qt Creator字符串精确相等，闭合了旧接口差异，不能再用它当.proc默认执行验证器。[Microsoft对FindExecutable长扩展名行为的说明](https://devblogs.microsoft.com/oldnewthing/20160408-00/?p=93274/)。关联通知flush只保证通知送达，没有保证执行对象重建；缓存仍未定位。[SHChangeNotify契约](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shchangenotify)。三级候选尚未全部穷尽，不解锁缩减验收的二级方案。

补做0/8/16/24秒无UI租约采样，实际退出0，来源b09885db。armed16:52:03.739Z，expires16:52:33.405Z，四次直接读值相对arm为147/8148/16144/24149ms；HKCU/HKCR的32/64视图16项全部精确匹配测试command，savedOriginal匹配全部false。每次fresh recommended枚举正好一个条目且GetName匹配测试壳；16:52:28.848Z恢复完毕、watchdog0，恢复后四视图及推荐条目均回原值。该轮没有UI、原生应用或服务启动，只排除本窗口内持续提前恢复；采样间短暂变化、真实点击引发的变化及旧轮点击前一瞬仍未证明。两轮fresh BHID结束到点击分别隔18.668/20.509秒，原“before click”不改写为即时读值。测试壳已经叫promptcut-recovery-test.exe，安装版叫promptcut.exe，不采用无事实前提的“同名冲突改名”。推荐对象也不是实际Explorer默认执行证明。结果及原日志摘要见native-os-handoff.json的temporalQueries；一次性辅助代码仍在忽略目录，未冒称已提交产品探针。

笔记本任务“核实项目与协作通道”的只读预检已实际返回0，由根Agent通过read_thread取得完整report投影，见 [native-laptop-preflight.json](assets/collaboration-reopen-recovery/native-laptop-preflight.json)。笔记本main为6c8b8cbb、验收WT为aba4c1f9且均干净；目标b09885db/1ec99174对象本机缺失，不能当新版源码已验。未发现现成Sandbox或独立Windows VM；.proc有效查询仍是安装版、无UserChoice；编译工具已在但本轮没有构建/启动fixture。ComputerUse保持停用，未改系统或真实关联。五件远端文件摘要由对端报告，未将其冒称本机文件独立哈希复核；初始参数转义及literal glob错误也独立保留。根Agent已通过直接工具确认接收，未要求对端绕过缺失的发送接口。

以上笔记本预检是初始快照。随后在忽略目录另建source-5998/checkout（codex/native-laptop-fixture-preparation），由单分支bundle取得完整5998b9fd，verify/fetch/fsck均0。初始离线metadata缺android_system_properties 0.1.6，退出101、未开始构建；从根Agent隔离fixture和既有Cargo缓存仅交接公开chrome/ffmpeg/python、锁文件匹配的511份crate及索引，不带应用、身份、项目或全局Cargo配置。资源包628337069字节，SHA-256为698d72516d311e3fb94cae57a553d704c5f161fcb722331db3f043c9bad41420；下载0/7722ms，4940份文件、manifest、Cargo.lock核验0/24875ms，missing/extra均空。首次解压WinError206/退出1保留，改在新目录以扩展长度路径提取后通过，未改系统LongPaths设置。

默认GNU工具链首次构建因缺dlltool.exe而退出1/25484ms，失败回执和日志保留。以子进程RUSTUP_TOOLCHAIN选择已装MSVC、独立CARGO_HOME及离线环境后，cargo metadata --locked --offline --format-version 1实际0/979ms；提交的fixture生成器 --build --standalone-launch实际0/114827ms，FeMRuw测试壳loader校验通过。EXE摘要cbd0ce55e7d8c5a8f10effeefd6debbc0cf5ceccaffd064068c33df88d8903ad，远端证据manifest摘要c356721c5ef5001025a0ef8b748127fffed688b047bf494a7ef6c8ffd349aae4。main仍6c8b8cbb、旧验收WT仍aba4c1f9、新checkout5998b9fd，三处tracked干净、默认GNU工具链未变；未启动产品/服务/浏览器/安装器、未改关联，ComputerUse保持停用。根Agent完整读回远端实际命令输出，但未另下载并独立哈希远端证据文件；本机资源包摘要已复核，两台临时交接服务均关闭。新增投影见native-laptop-preflight.json的sourcePreparation，编译不计系统双击或恢复通过。

台式机补做一次无租约、无导航、无文件点击的UI时序预演，source5998b9fd：自有Explorer50936创建17:14:19.745846Z，激活后的可信截图在参考时刻后23915ms，导航前检查65693ms，随后关闭自有窗口，进程自然退出，保留用户Shell11120。没有关联变化、产品或服务启动。这一轮没有证明整个after-arm路径能可靠在25秒回执窗内完成，也不证明所有优化路径都不能完成；不扩大为默认双击产品失败。结果在native-os-handoff.json的safeTimingRehearsal。用户随后明确默认双击在台式机实测即可，不再要求笔记本跑这个非性能项目；既有笔记本性能基线保持实际来源。

台式机快速补验又保留两轮实际退出1：run-wKJQ47于17:50:25.647Z arm后，由ComputerUse新建Explorer45208（17:50:25.812139Z），确实补到after-arm进程创建；但导航未完成，17:50:55.076Z时限检查挡住文件输入，没有双击、没有误启动，不能计产品路由失败或通过。run-iCv3sk先实际显示original-host文件，17:54:59.792Z arm，F5后观察17:55:00.185Z，17:55:11.725Z真实坐标双击；原安装版53240创建17:55:11.961963Z，17:55:25.800Z关联恢复，watchdog0，无匹配测试壳回执。这次11.933秒内的真实动作仍错路由，不能把快速操作或台式机替代笔记本本身视为通过。核验exe、创建时间及精确测试文件参数后，仅清理53240及两名直接子进程；累计误启动安装版八次，普通启动/草稿写入仍不声称未发生。测试壳二进制保留实际e2552d07来源，harness5998b9fd只含后续测试/报告修改；没有把旧二进制冒称新编译。主机首个OS handoff失败，成员及OS已有窗口转发未执行。证据见native-os-handoff.json的desktopQuickAttempts。

第16轮后的只读核验两次实际退出0：.proc真实ProgID含一个空格，为PromptCut Project；HKCU/HKCR 32/64和fresh GetKey均选这个class，lease路径正确。真正NULL默认verb与显式open的COMMAND/EXE/PROGID及GetKey相同且S_OK；shell默认值为open，唯一定义verb也是open。空字符串查询COMMAND/EXE返回0x80070483，不能当作另一个默认动作。Applications中promptcut.exe和promptcut-recovery-test.exe根在HKCU/HKLM/HKCR的32/64视图均不存在，不凭不存在的路径提出替代修法。根Agent读完两份完整只读快照与实际命令记录，摘要及原文件SHA见handoff JSON的attack.currentRoutingVerification。该组是恢复态读数，不是点击一瞬；后续租约内实际默认查询及F5取证见下段，缓存唯一因果仍未证明。

本轮静默补丁提交faf6b74b457930903e31ba49c02773785b7d606b采用NSIS官方nsExec隐藏命令窗口，仅在脚本已有的非交互环境开关下启用；4c5474e43d38732319b95dcc706c0c4ab4922560纠正探针的实际入口命令元数据。[NSIS官方插件说明](https://nsis.sourceforge.io/NsExec_plug-in)。主机run-xQdu53、普通成员run-hqcKqp均实际编译并执行提交的补丁EXE后正常重开，退出0；NSIS编译1096/1634ms，更新8699/15654ms，载荷2048件。两轮均4f72d19e旧运行时变成当前代码、版本仍0.7.14，保护目录及外壳字节不变，原房间、原设备、正确creator/host与普通member角色、等待自动加入、版本5、4次双向编辑、三类50k票据素材均通过，恢复建房0。故意指定任务自有不存在的安装目录时EXE实际返回1，负例验证命令退出0且目录仍不存在。主机faf原回执的外层command误写下层PS命令，wrapper.command和新投影明确实际EXE入口；原始回执未改。首次run-ye98XG因PVG副本已含相同probeRunner代码被更新前保护检查挡住，退出1，未生成清单或执行安装器；改用未更新的Zb副本，没有放宽断言。见[native-nsis-upgrade.json](assets/collaboration-reopen-recovery/native-nsis-upgrade.json)。完整setup安装包仍未执行。

实际默认解析新增三轮独立诊断，退出码0、1、0；不加入16次OS handoff的计数。DbytMa的0/8/16/24秒新PS查询、UbRPrF的相同时点及18:33:34.109–34.263Z真实F5刷新前后，真正NULL默认verb与显式open在flags0/noFixups下COMMAND/EXE均匹配测试壳，GetKey成功且四视图前后值匹配，结束后原值恢复/watchdog0。UbRPrF单击选择因关联已恢复被guard挡住，没有发出文件启动动作。jLqihq高频查询第11次退出1，前10项匹配，原stderr未保留，原因未知；其提前恢复让UI输入被guard挡住，不能当作关联覆写证据。只读AppDefaults日志启用、现存1936件，17:45–18:05UTC窗口无事件，不推断当时发生了默认关联重置。见[native-default-query.json](assets/collaboration-reopen-recovery/native-default-query.json)。新查询证明这几次采样中的默认解析已切换，不证明Explorer真实执行或点击瞬间；没有新增误启动。自有Explorer窗口已关闭、进程自然退出，用户Shell保留。

补充只读身份核验退出0：当前Explorer11120与新隐藏PS32884的用户、登录身份、会话、integrity8192一致，均明确non-AppContainer，GetPackageFullName均返回15700（显式无package）。旧四份上下文只覆盖11120/50380，未覆盖后来已退出的新GUI进程，不能补判相同；Explorer线程token和package graph未读。私有helper现在独有文件保存未来错误stdout/stderr和SHA，恢复态复查0，未故意注入错误；不能找回jLqihq已丢失的原输出或宣布其原因已修。摘要见native-default-query.json的currentContext/queryFailureCapture。

全局默认动作登记只读检查退出0，实际223ms：HKCU/HKLM/HKCR的32/64位视图共32条static verb、72条ContextMenuHandler及92条Inproc登记，直接指向原安装版或测试壳的命令候选0；PerceivedType六视图均缺失，未猜查其它类型。缺失50key/98value单列，读取错误和截断0，没有COM激活、菜单方法调用、关联写入或文件invoke。它只关闭“已登记全局静态命令直接指向原版”的窄解释；第三方扩展登记存在不证明动态改默认动作，登记字符串SHA也不是DLL内容SHA。实际完整快照与命令摘要见native-default-query.json的globalDefaultRegistrations。

台式机又增加三轮退出1且没有文件invoke：f1ZM64和89RaFa在导航前/提交前被30秒guard阻止；Ams3k6在明确启用90秒守护后，19:03:36.687Z arm，目录在有效窗口内显示原文件，但观察到Windows Security网络提示后停止，没有点击允许/取消。19:05:02.194Z原关联恢复、watchdog0；5秒间隔19次fresh默认查询退出0、无query错误，结果含还原后的原值，不当作双击证据。服务退出后提示仍在，原进程归属未知；自有标签关闭尝试经激活及新截图重试一次，两次均被PickerHost非目标检查拒绝，没有输入落到安全提示。新90秒仅探针显式opt-in、默认30秒保留，30/90持有者退出及全部自测0；回执截止修正为真实expiresAt减5秒。没有新增旧版误启动；自有目录进程8688随后按exe与精确CIM创建时刻核验并清理退出0，用户Shell11120原创建时刻保留；首次Process对象精度比较因相差2ticks被保护拒绝、没有停止进程，核对两API实际精度后才完成。安全提示未操作，仍须用户手动关闭后继续UI。见native-os-handoff.json的extendedWindowAttempts/extendedLeaseSafety及native-default-query.json的extendedDirectorySampling。

完整桌面构建补验使用审核提交fb1d2ab0的独立Git仓库，避免标准构建器的worktree prune影响其他任务；只复制测试夹具的公开组件，不读取原运行副本的配置。该候选包保留应用0.7.14/外壳0.2.7并使用明确的loopback诊断测试配置，只证明当前源码可以完整构建。它不替代版本更新后的正式发版，也不替代setup安装或系统默认双击。19:21和19:32的两次只读桌面复查均仍显示Windows Security提示，没有向安全提示或项目文件发送输入；观察用15964/17400只按exe和精确创建时刻清理，用户Shell不变。

20:12的台式机复查中，ComputerUse重连后成功取得新观察窗口的截图，仍看见Node.js的Windows Security网络访问提示。用户建议采用系统全屏截图和鼠标坐标点击；现有受支持API仅提供指定窗口截图，系统全屏接口不可用，不能宣称已经切换。未向提示或项目文件发送输入，也未新增OS handoff。观察进程8528只在核验exe与精确创建时刻后清理，用户Shell11120保留。安全提示需用户手动取消；这次只读观察不替代系统双击验收。

### 2026-10-05 接手与路线改定：笔记本真实安装验收

用户把本任务从上一个执行会话交给新的主会话（PC）。接手时只读清点：worktree 干净、HEAD `613ce6e6`、领先 main 70 个提交；`.proc` 关联为原值（`PromptCut Project` 指向已装的 `promptcut.exe "%1"`，无 UserChoice、无遗留测试类型）；没有本任务残留进程，5190～5230 无监听；按标题查不到 Windows 安全提示窗口，不知道当时点的是哪个按钮。清点没有改任何文件或系统设置。

用户当日决定，主会话逐条确认后执行：

- 本分支推送到 origin，只推这一支，不碰 main、release。推送前扫描了分支新增行，没有发现令牌、私钥、远端主机地址、局域网地址、用户目录路径或机器名。
- 系统默认 `.proc` 双击验收换路线：在笔记本上真实安装候选包，由安装器登记关联，再在资源管理器里真双击。PC 不再临时改写关联，也不再启动已装的正式版。卡点 10 解法表第 5、10、12 行因此停止，新增第 13 行。
- 本轮的完成条件与分工：安装包由笔记本从分支构建并真实安装，双击由笔记本会话做；成员角色的主机放在 PC 上，用隔离数据目录和隔离端口起；云端会话只当 Node 层的外网成员，公网入口沿用任务自有的临时入口，不部署生产。合入 main、改版本号、发版、覆盖安装包、部署生产托管服务都等用户另行授权，不沿用以前的授权。
- 上一轮的电脑操作是另一个工具做的，可能有缺陷，它的操作经验不一定适用于本轮。上文 19 轮 handoff 的记录保持原样，本轮不据此对 Windows 的行为下结论。

这条路线只改验证方式，不改语义，也不降门槛：两个角色的冷启动双击、已开窗口转发、原房间原身份恢复、双向编辑与带票据素材读取仍须全部通过。真实安装会使用笔记本真实的数据目录与 WebView2 配置，并覆盖笔记本已装的 0.7.14，所以先备份、后还原；还原只用改名与复制，不删除文件。做法见 [collaboration-reopen-installed-acceptance.md](../plan/collaboration-reopen-installed-acceptance.md)。

### 2026-10-05 真实安装验收结果

系统默认 `.proc` 双击在笔记本真实安装的构建上通过，主机、成员两个角色各一遍，证据见 [installed-host.json](assets/collaboration-reopen-recovery/installed-host.json) 与 [installed-member.json](assets/collaboration-reopen-recovery/installed-member.json)。全程没有任何会话改写文件关联，关联只由安装器登记。

**构建、备份、安装。** 笔记本在独立的 git 仓库里从 `613ce6e6` 跑发版构建脚本（`node desktop/scripts/build-release.mjs --from-head`），退出 0、912.7 秒，产出 `PromptCut-0.7.14-setup.exe`（437,638,866 字节，SHA-256 `4bfab5777fc11985d451345f6c6c3c5e59392f7d5c1dcb406ea42439348c4c15`）；补丁清单的 2498 个文件与运行副本逐文件一致。诊断提交地址用的是回环占位值，所以它是验收用的候选包，不是发版包；版本号没有改。安装前用 `reopen-installed-state.mjs` 备份了安装目录、应用数据、WebView2 配置和导出目录共 54,741 个文件，备份后比对一致。安装用安装器自带的静默方式（`/S`），退出 0、68 秒，没有安全提示。装后只读预检确认 `.proc` 的有效打开程序就是这份构建：运行副本摘要一致，2498 个文件缺 0、不同 0；`.proc` 与 `PromptCut Project` 两个注册表键和装前完全相同，卸载登记只有 `EstimatedSize` 变了。

**主机角色**（已装的构建当原主机；探针 `e7d0d1ec`，退出 0）。探针经资源管理器启动应用，建限定进入的本机房间，让本机替身成员在真实界面上认证加入并互相编辑，再让应用正常退出。笔记本会话用命令打开文件夹窗口，在窗口里对 `original-host.proc` 真实双击：应用带着这份文件启动，恢复为原房间的创建者与主机，重新登记上线；先打开并等着的成员自动加入；设备身份不变；之后双方各改一次，成员带票据读写三个命名空间各 50,000 字节。应用开着时再双击同一份文件，没有新窗口，已开的窗口收到一次 `pc-open-file` 并换成新的连接。恢复过程建房 0 次，原文件不变。

**成员角色**（已装的构建当普通成员，主机在 PC；探针 `d8ef01ef`，两端都退出 0）。PC 用 `reopen-remote-host.mjs` 在隔离数据目录和 5296 端口起主机并建房间。笔记本上的应用载入主机的项目文件，在真实的恢复身份表单里认证为成员，与 PC 主机互相编辑，保存出 `original-member.proc` 后正常退出，PC 主机随即下线。笔记本会话真实双击这份文件：应用冷启动后在成员数的位置显示「正在等待主机上线，将自动重试」；PC 主机从自己的文件恢复上线后，成员不经任何输入自动加入，身份是普通成员、没有主机绑定；双方再各改一次，成员带票据读写三类素材；应用开着时第二次双击同样只转给已开的窗口。主机文件里的提示地址是 PC 的回环地址，成员只能经中继到达主机。

**外网成员。** 云端节点在只能出网的容器里（Node v22.22.0）用 `reopen-wan-member.mjs` 当 Node 层成员：主机被双击重开并恢复之后，它经任务自有的临时公开入口认证进同一个房间，带票据读回三个命名空间各 50,000 字节并校验摘要，再做一次编辑，主机和本机成员都读到；退出 0、22.6 秒，第二次连接用的是它自己设备上的恢复记录。它的口令在自己的进程内存里生成，交给主机的只有用主机公钥封装的密文，信箱和消息里没有出现过口令。临时入口的隧道程序与官方发布的摘要一致；入口随进程结束失效，没有部署生产。

四次双击的回执（四次都是已装的 `promptcut.exe`、命令行带那份文件、没有被拒的启动）：

| 角色 | 哪一次 | 探针就绪 | 进程创建 | 进程号 | 父进程 |
|---|---|---|---|---|---|
| 主机 | 冷启动 | 11:58:47.876Z | 11:59:01.671Z | 5872 | `explorer.exe` 1640，11:58:53.726Z 创建 |
| 主机 | 应用已开 | 12:01:53.663Z | 12:02:06.225Z | 6208 | 同上 |
| 成员 | 冷启动 | 13:03:28.908Z | 13:13:00.425Z | 28608 | `explorer.exe` 5600，13:03:55.775Z 创建 |
| 成员 | 应用已开 | 13:15:42.899Z | 13:15:56.740Z | 12844 | 同上 |

父进程就是会话用 `explorer.exe "<文件夹>"` 打开的那个文件夹窗口所在的资源管理器进程；打开 `.proc` 的动作只有窗口里的鼠标双击。

没成功的尝试都保留，不用后来的通过抵消：

| 尝试 | 结果 | 处置 |
|---|---|---|
| 笔记本会话申请电脑操作授权 | 被拒，当时没人在机器旁；会话没有绕 | 用户到场后批准 |
| 外壳打开替身：探针请资源管理器按默认关联打开文件，探针 `c673369f` | 没做完。冷启动与外网成员都通过；应用开着时第二次打开在功能上发生了，但探针的监视没来得及读到那个转瞬即逝的进程，一直空等 | `fdd350e6` 起监视直接向系统查询新进程 |
| 主机角色第一遍真实双击，探针 `fdd350e6` | 退出 1，没到双击：建房返回 name-taken，已装的应用保留着上一遍的同名房间 | `e7d0d1ec` 起房间名每次唯一 |
| 成员角色第 1 轮，探针 `e9fc7c4c` | 退出 1，应用还没启动：主机项目文件正在复制时被探针读到（EBUSY） | `d8ef01ef` 起读不到或不完整就再看；笔记本改用改名放入 |
| 成员角色第 2 轮，探针 `d8ef01ef` | 退出 1，停在首次认证：临时公开入口运行 2 小时 12 分后在 12:40:58Z 断开 | 暂时性故障；重启入口与 PC 主机后第 3 轮通过 |
| 成员角色第 3 轮的第一次双击 | 屏保起来后会话截不到图、发不出输入；之后一次点在窗口挪动前的旧位置，一次因输入法进程抢了前台被工具拒绝 | 用户到场退了屏保；这两次都没有打开任何东西 |
| 临时公开入口第一次启动 | 15 次探测内从 PC 连不上 | 重试即通 |
| PC 上用隔离测试壳演练的一次 | 连不上应用的调试端口，60 秒超时。时间上吻合本机动态端口走到 Node 拒连的 10080，当时没有记录端口号，原因不能确认 | 探针起记录端口，挑到这类端口时明确报出 |
| 全量测试第一次 | 4342 项里 1 项失败：新单测没登记进依赖方向守门的名单 | `8a6cbbaa` 登记后全过 |

观察到、但不算失败的：

- 主机角色里，外网成员改了项目名之后，主机界面提示「你的近期修改已被 wan-member 覆盖」并留了本地备份。探针让主机和外网成员先后改同一个字段。
- 外壳打开替身那一遍里，11:30:28Z 主机登记断开约 5 秒后自己连回，当时没有任何操作；原因没有查。
- 成员角色首次认证的表单没有截到图，那一分钟屏保挡着；探针是经应用自带的调试端口在真实表单里输入的。
- 候选版运行之后，四个目录相对备份的变化：安装目录新增 189、改 1375；应用数据新增 36、改 1；WebView2 配置新增 1225、少 112、改 2725；导出目录新增 7463、改 2。

**还原没有完成，是待用户项。** 笔记本会话运行还原时退出 1：整目录改名只挪动了 3 个小文件，真实的安装目录没动，其余三个目录没碰，没有删除任何东西。原因已查实：Claude 桌面应用是打包应用，它派生的进程看到的 AppData 是真实目录与应用私有层的合并视图，那 3 个文件只在私有层，改名也只发生在私有层。所以笔记本现在装着的仍是候选版（能用，「提交诊断报告」不可用），数据是验收后的状态；备份完整，在真实目录里。还原要由用户在普通终端里运行同一条命令；工具从 `5254bd1c` 起在打包应用派生的会话里会直接拒绝并说明。笔记本会话已在它的对话里把这条命令写给用户；私有层里被挪开的那个目录（3 个文件、386 字节）只有桌面应用的会话看得见，不影响真实安装。

本轮的基线与渲染附加项（代号：G0 是每次都要过的类型检查与全量测试，G0-R 是改到渲染时要加跑的那一组）：

| 项 | 在哪跑、对应提交 | 结果 |
|---|---|---|
| 类型检查 `npx tsc -b --force` | PC，`05ab07c6` | 退出 0，6,165 ms |
| 全量测试 `npm test` | PC，`05ab07c6` | 4342 项全过，失败、取消、跳过、todo 都是 0，63,504 ms |
| 导出确定性 `verify-determinism.mjs` | PC，`05ab07c6` | 两遍各 1800 帧，1800 相同、0 不同，463,598 ms |
| 导出与快照重放一致 `verify-unified-frames.mjs` | PC，`05ab07c6` | PASS，10,388 ms |
| 与 main 的全长像素对账 | PC，候选 `05ab07c6` 对 main `adc3ae2a` | 两边各 1800 帧，逐字节相同 |
| `ready-index-probe` | PC，`05ab07c6` | 退出 0，`fails: []`，70,775 ms |
| `stream-produce-probe --group` | PC，`05ab07c6` | 退出 0，`fails: []`，33,492 ms |
| `preview-fallback-probe` 与 `--page-preload` | PC，`05ab07c6` | 都退出 0，`fails: []`，88,249 / 89,817 ms |
| `stream-produce-probe` 普通模式（带耗时门槛，以笔记本为准） | 笔记本，`a88f4eed` | 正式一轮通过：退出 0，1080p 全幅流 15 帧分段编码 p50 268 ms（258 / 268 / 278），门槛 300 ms，其余各条也过。此前两次正式测量不过（`7d7ead70` 上 313 ms，`a88f4eed` 上 364 ms），是在笔记本处于限频状态时量的，并排保留。见下文卡点 11 |

PC 上这一组先后跑了三遍。第一遍分散在三个提交上：`5254bd1c`（类型检查与全量测试）、`222198e7`（确定性、重放一致、像素对账）、`7d7ead70`（各探针）。第二遍在 `05ab07c6` 上整组重跑，上表 PC 各行是第二遍；第一遍的数字留在 [installed-verification.json](assets/collaboration-reopen-recovery/installed-verification.json) 里，结论相同。第三遍在 `a88f4eed` 上整组重跑，也全过，数字在同一个文件的 g0rThirdRun 里。从 `613ce6e6` 到 `05ab07c6`，`src/`、`server/` 的产品代码和 `desktop/` 都没有变化，变的只有 `scripts/probes/` 下的探针、`server/test/` 下的单测和 `docs/`；`05ab07c6` 之后的提交只改 `docs/`。集成用的脚本三遍都在流探针之后停下：它在上一台测试编辑器释放端口之前就去起下一台，预览兜底那两项没启动；三遍都是随后单独补跑通过。PC 上普通模式的流探针三遍也都退出 0（第二遍 54,559 ms，第三遍 50,500 ms），但计时项不以 PC 为准。主执行计划第 8 节的视频取帧节奏与 seek 竞态两个探针这次没跑：分支没有改取帧、解码、图卡视频源或 `frameMedia.ts`。

## 第 11 节逐项验收

“通过”仅指该行写明的实际层级；“部分验证”表示规定场景仍有明确缺口，不计为整条通过。

| # | 场景 | 结果、证据与未覆盖部分 |
|---|---|---|
| 1 | 原主机关闭应用后重开 | **通过（隔离服务及真实公开链路）**。四组合保持房间/原账户；本机主机重新登记，跨设备公开入口成员实际双向编辑、带票据读素材。生产部署未执行。 |
| 2 | 主机进程重启及电脑重启 | **通过（真实操作系统重启）**。2026-10-04 用户重启后，启动标识与原检查点不同；默认探针未带 `--allow-same-boot`，退出 0。主机/成员新进程、空浏览器、稳定 DPAPI 记录恢复同房间，原 creator/member 角色、云端登记 online；双方编辑读回、版本 12→14、零建房，三类带票据素材各 50k、200/哈希一致。见 [physical-reboot.json](assets/collaboration-reopen-recovery/physical-reboot.json)。已有原生副本切换证据另保留。 |
| 3 | 原成员关闭应用后重开 | **通过**。四组合成员新进程读设备凭证恢复原用户名/权限；远端成员两个新进程亦恢复。 |
| 4 | 成员先打开、主机后打开 | **通过**。LAN 两模式先等待，原主机上线自动加入；主机/成员各改后另一端读回。 |
| 5 | 自由/限定、本机/云端 | **通过**。四组合独立专用房间；云端位置保持 hosted；第二创建者无本机主机绑定。 |
| 6 | proc/procp/草稿/系统双击/刷新 | **通过（2026-10-05 起；此前为部分验证）**。proc、真实打包/解包、草稿、真实 open-path 后端及页面刷新通过；独立 Windows 原生壳启动参数 `?open`、已运行窗口实际 `pc-open-file` 事件转发与打开通过，原文件未改。系统默认文件关联19轮handoff均无匹配回执；新增一轮过期点击、三轮时间保护、一轮几何错误均未完成，两轮有效窗口的真实动作仍走安装版。前七轮的通知flush/目录刷新及独立类型也未通过。后台采样与参数/IPC通过均不替代OS动作。关联均恢复，主机/成员默认双击及OS已有窗口转发仍未通过。见native-os-handoff.json。纯在线不新增文件入口。 2026-10-05：系统默认双击在笔记本真实安装的构建上通过，主机与成员两个角色各有冷启动和应用已开两次真实双击的进程回执，之后原房间原身份恢复、成员等待后自动加入、双向编辑、带票据素材读取都有证据，见 installed-host.json 与 installed-member.json。本行此前关于 19 轮 handoff 的记录保持原样。 |
| 7 | 主机离线打开后恢复网络 | **通过（应用层故障注入）**。云端测试进程实际停止，原主机本机修改；云端进程返回后自动登记，成员加入、编辑和带票据读素材。宿主网络未改。 |
| 8 | 地址、端口、运行副本变化 | **通过（服务、独立原生运行副本及真实补丁脚本更新）**。端口变化、稳定路径/设备记录、旧目录迁移与不覆盖新数据测试通过；实际copy-A切换copy-B后新PID、空WebView2恢复。新增主机/普通成员两次真实apply-patch.ps1更新2044文件，保护状态与外壳字节不变，重开后同设备/房间/角色、成员等待加入、4次双向编辑及三类带票据素材均通过。见native-upgrade.json。应用版本未递增；后续提交的真实NSIS补丁外层两角色亦通过（各2048件、0建房、4次双向编辑及三类50k票据素材），故意缺安装目录的退出码1正确传递，见native-nsis-upgrade.json；最终完整setup安装包未运行，不扩大该范围。 2026-10-05：完整 setup 安装包已在笔记本真实安装并运行（从分支构建，静默安装退出 0，覆盖原有的 0.7.14；装后设备身份与恢复都正常）。版本号没有递增，诊断提交用占位值，不是发版包。 |
| 9 | 无公网直连且外网成员 | **通过（真实公开中继）**。成员在另一机器，经独立临时公开 HTTPS/WS 入口与隔离网关双向编辑、两次凭证重入和三类票据素材读取。SSH 链路结果另存，未混为公开入口证据。IPv6 直连和打洞未实现/未测，按计划 §6 仅交付实际必需可达路径。 2026-10-05：另有第三个网络里的外网成员——云端容器，只能出网——经临时公开入口认证进被双击重开的房间，读三类带票据素材并编辑，见 installed-host.json 的 externalMember。 |
| 10 | 主机/成员带旧快照重入 | **通过**。四组合旧文件不覆盖最新编辑，版本 5/6/9 连续；DocSync 单测零根替换、服务最新状态优先。 |
| 11 | 离线修改与远端冲突 | **通过（单元及桌面实际交互）**。持久未确认队列后停止成员进程，空浏览器重入旧文件，远端冲突使同步暂停；真实点击重放后主机读回，另一轮丢弃后原离线项目及操作实际保存于备份 API。`reopenRecovery.test.mjs` 保留 expectRev 及身份读取期间新旧操作合并。 |
| 12 | 密码、名单、踢人、禁入 | **通过（真实服务和桌面界面）**。自由/限定中继旧凭证 401、禁入 403、代数失效旧票据；创建者实时改密码后重连，真实界面踢出/解禁、自由模式改项目密码及限定模式移除名单。旧文件不越权，凭证更新后要求真实重新认证。 |
| 13 | 邀请过期/作废 | **现有邀请服务及桌面恢复通过；匿名 LAN 云端邀约流程未交付**。本机及云端自由模式真实正常 SDK 兑换并首次加入，保存文件及设备身份；作废旧码与十秒过期旧码均 404，实际停止成员进程后空浏览器读旧文件仍恢复原身份。见 `matrix-free.json`、`matrix-hosted-free.json`。新网关只覆盖已取得有效身份的恢复，不声称匿名邀请校验/兑换的公网流程完整。 |
| 14 | 多窗口、重复打开、第二设备 | **通过（实际窗口及服务冲突）**。两独立浏览器窗口同时读旧文件，同身份同房间，分别修改后另一窗口和主机读回；重复打开零建房。二十身份双进程合并、同服务多身份、不同活动实例/第二设备拒绝主机占用；创建者第二设备真实连接，无主机私有绑定。 |
| 15 | 恢复中换项目/首页/取消 | **通过（单元及实际桌面界面）**。单元覆盖四阶段迟到结果、重试定时器和节点迟到票据；实际延迟身份请求后换项目通过。本机限定逐项延迟身份读取、主机恢复、发现和接入登记的真实成功回复，再点实际首页，迟到回复不恢复旧连接，刷新仍留首页，Agent/card/render 清旧绑定且本机主机登记撤销。云端自由的两个实际网络阶段同样通过；本机主机恢复及 LAN 发现对云端不适用。未确认身份时取消房间控件禁用；确认创建者后两种位置的实际协作开关取消均成功。见两份 exit 证据；不声称所有模式与阶段的笛卡尔积都逐一实跑。 2026-10-05：补跑了此前没跑的两种组合，本机自由与云端限定，都退出 0，见 exit-lan-free.json、exit-hosted-restricted.json；四种组合现在都实跑过，各自适用的阶段逐项退出。 |
| 16 | 保存/恢复崩溃、磁盘满 | **通过（实际子进程退出与故障注入）**。加密临时记录已写完刷盘、替换前子进程退出码 31，旧原记录逐字节不变、退出锁回收后重试成功；临时文件写入 16 字节后 ENOSPC，原文件不变且重试成功。桌面离线队列跨进程保留，跨进程写入合并。没有对宿主机造成断电或填满真实盘。 |
| 17 | 篡改角色/地址/房间 | **通过（单元及真实桌面恶意关联）**。文件伪造 creator/用户名/as 后仍是普通成员；服务改为隔离恶意收集器后 needs-auth，收集器 HTTP 请求数为 0；换房间 ID 需认证，原文件再打开恢复正确身份。格式拒绝非法 URL/路径，房间作用域和禁止重定向另有单测。 |
| 18 | 清空凭证、新设备打开 | **通过（独立测试设备）**。无记录明确 needs-auth，一次真实认证 UI 后持久保存；后续新进程/空浏览器自动恢复。没有清用户的真实凭证。 |
| 19 | 删除/取消后打开旧文件 | **通过**。原主机及第二创建者两条删除路径，成员离线期间删除亦终止。另在本机限定和云端自由实际关闭协作开关并确认：保留服务端最新内容，返回本地，保存文件无房间关联；旧主机文件为 deleted，云端挑战 410，零自动建房，旧节点绑定撤销。 |
| 20 | 搬迁成功/中断后重开 | **通过（隔离 HTTP、故障注入及实际设置页）**。本机到云端、原生云端到本机及完整往返保持房间/身份/版本；HTTP 两个方向均在部分传输后实际停止两端，再凭同事务续传、成员双向编辑与三类 50k 素材；准备/安装故障、删除及旧登记能力拒绝另有测试。实际设置页搬到云端和云端重启见 [relocation-hosted-ui.json](assets/collaboration-reopen-recovery/relocation-hosted-ui.json)；原生云端搬回、旧 hosted 文件恢复目标主机及目标重启见 [relocation-lan-free-nodes.json](assets/collaboration-reopen-recovery/relocation-lan-free-nodes.json)。搬迁新增公开 WAN、原生壳动作及所有故障组合未逐一实跑，不扩大此层级。 |
| 21 | 旧关联迁移/未知版本 | **通过（桌面及格式/存储）**。真实旧 sessionStorage 身份精确匹配后迁入保护存储，原浏览器记录变 device-vault；旧 localStorage 密码查看记录可靠迁入 settings 后才删除，并在真实密码查看 UI 中以布尔比较核对原值，未输出秘密。空浏览器和新进程可自动恢复。真实未知 v2 提示不支持、再次序列化完整保留；已有新状态不覆盖、旧目录保留，无关联旧文件不按名绑定。 |
| 22 | 主机数据缺失/损坏 | **通过（实际桌面故障提示）**。停止原主机测试进程、暂移 ops 日志，重开显示 damaged，缺失文件不被初始化；恢复日志后原房间可连。另一次停止成员进程后写入损坏保护记录，界面 damaged，损坏字节不被覆写，恢复原测试备份后可连。未从不可信快照导入权限或生成房间。 |
| 23 | Agent/渲染节点/素材 | **通过（恢复、搬回及删除链路）**。实际自动节点启动，主机/成员 Agent 与 render 认证同房间，card 绑定正确；media/snap/px 读回和哈希通过，删除清旧绑定；8 项节点竞态及真实中继 RST 会话接续通过。搬回并真实重启目标后两侧节点认证见 `relocation-lan-free-nodes.json`；专门注入首次重试取票失败后仍自动恢复，相关网关/会话 25 项全部通过（10,975.3284 毫秒）。全渲染任务调度及所有故障组合未扩成无关探针。 |

补交上传的联动复跑先在 d62cd2c3 失败（sokEgk，退出 1，90,890 ms）。日志证实 afterImport 的按哈希补交先把仅有原尺寸的素材入队，小尺寸随后才由转码管理器入队，违背已有 mechanism/asset-service.md 的先小后大规则；另有观察端自动渲染节点参与，使两节点统计失配。8beb0622 修复服务端补交：转码 pending 时回 deferred，由持久两档管理器完成后入队；ready 时页面未写回的小尺寸从本机登记补上，failed/none/unknown 仍按原规则传原尺寸。API 只增可选 deferred 数组，文件版本不改；明确缺失仍报告。探针设置 AUTO_RENDER_NODE=0 隔离观察端，产品的成员自动节点行为仍由重开/搬迁探针验证。旧失败不抵消，RaCK22 的新来源及通过范围单列。

### 2026-10-05 验收矩阵逐条复核

把上表里标着「部分验证」「未测」或带保留的行逐条过了一遍。没列出的行（2、3、4、5、7、10、11、12、14、17、18、19、21、22）原本就是通过，没有保留。

| # | 原来的保留 | 这一轮 |
|---|---|---|
| 1 | 生产托管服务没有部署新的登记与中继接口 | 不补。部署生产要用户另行授权；隔离服务和真实公开链路上的证据不变 |
| 6 | 系统默认双击没过 | **补上了**：笔记本真实安装的构建，主机、成员两个角色都通过 |
| 8 | 完整 setup 安装包没运行过 | **补上了**：从分支构建的完整安装包在笔记本真实安装并运行。正式版本号的发版包仍要等合入后再出 |
| 9 | IPv6 直连与打洞没做 | 不在本任务范围，维持原写法。另补了第三个网络里的外网成员 |
| 13 | 匿名局域网邀请的云端流程没交付 | 不在本任务范围，维持原写法 |
| 15 | 没有把所有模式都实跑 | **补上了**两种缺的组合，四种模式现在都实跑过。云端托管没有本机主机恢复和局域网发现这两个阶段，不适用 |
| 16 | 没有让宿主机真的断电或把真实磁盘写满 | 不补。那会损坏用户的机器和数据；进程在替换前真实退出、写入中途注入磁盘满的证据不变 |
| 20 | 搬迁没有在公开外网上跑，原生壳里的搬迁动作和全部故障组合没有逐一跑 | 不补。搬到云端需要一套公网可达的完整托管服务（文档服务加素材服务），任务自有的临时入口后面只有登记与中继，没有这一套；另搭就是新的部署。隔离 HTTP、故障注入和实际设置页的证据不变 |
| 23 | 没有把全部渲染任务调度和故障组合扩成探针 | 不补。那是渲染队列自己的验收，已由它的探针覆盖，不属于重开恢复 |

另有两条不在矩阵里的保留，也没有变化：一次偶发的「损坏」提示（探针 t6nM3X）来源仍然不明，这一轮没有再出现；搬迁前的完整性预检只查当前项目明确引用的素材，没有穷举历史操作里的引用。

## 失败、跳过与未测记录

失败运行保留而不抵消为通过。初始两项缺环境跳过独列；最终全量跳过 0。未测场景见矩阵和待用户条件。存储偶发失败及独立分类修复的非秘密取证摘要见 [storage-failure-audit.json](assets/collaboration-reopen-recovery/storage-failure-audit.json)。

| 实际问题/失败 | 处置与证据 |
|---|---|
| 完整包构建首次静默等待器没有返回完成回执 | setup与补丁已生成，但Start-Process -Wait在构建子进程均退出后仍等待；仅停止身份核验的自有等待器，外层实际退出1，等待器4294967295，npm最终退出码未知，不计完整通过。改为保有句柄并直接WaitForExit；0/7自测均正确，新的独立仓库完整复跑退出0。原始失败日志与修后日志分别保留。 |
| 第一轮界面认证按钮受首次 AI 设置弹窗遮罩拦截 | 事件命中与截图证明；探针使用已存在的 `nosetup` 测试入口/关闭设置弹窗，不改真实账户。已复跑真实认证成功。 |
| system-path 恢复空项目时演示卡/自动时长写入污染旧离线日志 | 修复恢复标志及旧日志读取前的持久化时机；四组合真实路径与版本验证通过。 |
| 全量曾出现托管清单断言、H4/SPR-2e 路径及 bake 自动清理夹具失败 | 修正新文件清单；单位夹具不继承基线编辑器私有文档目录；清理夹具隔离时钟/端口。后续全量零失败。 |
| G0-R 统一帧素材 404 | 独立舞台使用自己的素材根，探针支持 `PC_FRAME_MEDIA_DIR`；两项 G0-R 后续通过。 |
| 渲染节点探针曾因禁用 PUSH/固定环境配置未启动 | 修正测试环境为自动节点配置；真实节点与权限认证通过，不改变产品开关默认值。 |
| 节点迟到绑定与同房间迟到票据两项新增测试失败 | 串行绑定/撤销及连接代次；8 项测试全通过。 |
| 删除探针 LgfPqe/XeO5XF/rfkRUa/JqoGji 在旧文件墓碑阶段超时 | 单独终止协议错误修复仍失败；真实会话接续测试揭示缺路由项及原服务严格拒绝额外项；网关剥除路由项后接续通过。最终又定位隧道 Duplex 销毁未关闭成员 TCP，修复后真实自由/限定服务测试与桌面删除复跑通过。 |
| 新真实接续测试最初使用主动 close 的探针，随后原服务拒绝额外路由项 | 改用真实 TCP 测试代理 RST，不用刷新/主动关闭冒充网络中断；确认接续只建一条会话，路由核验后剥除。 |
| 新 reconnect 单测静态 TS import 未经仓库测试加载器 | 使用仓库现有动态 srcUrl 加载方式；终止/暂时/迟到错误三项通过。 |
| 私有设备密钥首次发布的竞态测试失败 | 已存在文件仍因旧 exists 判断被覆盖；改为刷盘后独占发布，陈旧判断与真实双进程加密存储测试通过。首次失败断言曾输出隔离测试密钥字节，已改布尔断言，后续失败不打印秘密；没有真实用户凭证。 |
| 扩展桌面探针 EwORS0 因开发服务自动刷新中断 | 探针执行时修改了服务依赖，引发执行上下文销毁；不算通过，固定代码后完整复跑。 |
| 扩展桌面探针 NwV1Zj 在首页阶段超时 | 实际已退连接并清入口，但 shared/members 仍旧；已清显示状态。又发现 URL 中旧启动参数会刷新重开旧项目，补清启动参数并加入首页刷新探针。 |
| 扩展桌面探针 BqHMHj 在密码恢复阶段未自动加入 | 探针误以为改回相同密码等于恢复原 K，实际上新盐产生新凭证；保持产品重新认证要求，修探针为真实认证 UI，后续自由模式通过。 |
| 限定公网首轮 ql4lia 在入口启动阶段不通 | 尚未创建测试房间。退避后重试 QSi33c 实际公开 HTTPS/WS、双向编辑和三类票据素材通过，不把健康检查或 SSH 回退算公开证据。 |
| 4,282 项全量第一次 4,281 过、1 失败 | `codex-auth-state.test.mjs` 登录失效状态已正确，Windows 异步结束子进程前即时存活断言竞争。改为原有有界等待确认退出，相关 26 项通过，全量复跑 4,282 过、0 失败/跳过；没有改真实账户或调用登录。失败日志保留在忽略目录 work。 |
| 扩展邀请探针 7Dhb6h / qwpUF7 失败 | 首轮手拼双斜线 URL 导致 fetch 失败，改用正常 SDK 端点；次轮模糊“member”文本选中了 invited-member，改为原成员设备对应的实际显示名。复跑结果单独记录，不按此前步骤已走过宣称整条通过。 |
| 扩展邀请探针 v4OsLP / Wil2ko 在密码阶段超时 | 脱敏端点证据显示认证 401 后挑战 429；同来源连续错误认证触发一分钟五次失败、60 秒冷却。保留服务限制，探针允许按实际 Retry-After 等待；yD5YUV 完整通过，记录 `observed:true`、冷却 60 秒、随后实际重新认证。没有将 429 改成权限绕过。 |
| 云端扩展探针 t6nM3X 出现一次 damaged | 当时主机 connected、成员 damaged，认证 401 两次且没有 429；未记录本机 API/浏览器日志的错误来源。停止所有测试进程后，隔离保护记录可解密、摘要有效，两份持久日志格式可恢复，但这只能排除持久文件损坏，不能排除当时读取/保存或内存操作异常。后续 Dw7xvX、eUSdVu 完整通过，分别实际等待 60.382/60.470 秒认证冷却；**原因未定，不计作已修复**。现在补固定类别 API 诊断与独立浏览器日志恢复诊断，未输出原异常/秘密。 |
| 新存储分类测试首次 19 项中 17 过、2 失败 | 故障注入证实 EBUSY 被 API 判成永久损坏，暂时错误界面仍称等待主机；改为明确暂时类别、固定诊断与等待本机存储。修后 19 项全过、0 失败/跳过，5,385.4322 毫秒。真实损坏仍停止重试且原字节保留。 |
| 补充只读存储审计首次夹具路径不存在 | 首次引用未落盘的 member.proc，在开始读取前 ENOENT；改用已存在的 matrix-home.proc。随后原隔离失败记录连续 160 次读取全部成功、27,774 毫秒、原字节未变且无存储写入。仍不能证明 t6nM3X 当时的错误来源。 |
| 原生首轮云端进程退出 1、随后 sidecar 缺 Vite | 两次启动阶段取证表明隔离数据目录未先创建，尚未启动原生窗口；补目录后原生 sidecar 报 Cannot find module，实际依赖从父检出解析而 worktree 只有缓存。按托管组合既有 data-dir 契约和实际 require.resolve 结果修正夹具，复制实际依赖而不做 junction，重新编译；失败均不计通过。 |
| 原生首启画面被设置弹窗遮挡，补等待后一次超时 | 首轮功能断言通过但截图被晚到的首次设置遮挡，未将该截图发布；补配置隔离和未加载用户凭证断言。等待误放在首页，而设置只在进入编辑器后出现；一次 run-RjSffY 超时，未建测试房间。将等待移到实际编辑器阶段后，run-RHTyGL 完整验收及截图通过；没有改产品弹窗逻辑。 |
| 原生新增探针后全量 4,285 过、1 失败 | 唯一失败为 no-user-dirs 守门，缺规定的首个副作用 import；补齐后相关五项全过（64.8045 毫秒），当时修后全量 4,286 过、0 失败/跳过。失败原始日志保留于忽略目录 work。 |
| 原生普通成员 x0sgBi/F9E2mb/dJZXTs/X7d2zi 失败 | 首轮缺具体阶段、随后真实认证被语音扩展提示遮挡，命中截图取证后只关闭隔离提示。单实例探针一度把已有连接当新打开成功，改为等待共享连接对象实际替换且 connected；mb05jB 普通成员及 zM8OTr 主机复跑分别通过。早期失败仍保留，不修产品首启提示。 |
| 搬迁界面 mmvxCe 在打包入口失败 | 根 Agent 在活跃探针期间编辑了加载的依赖，触发 Vite 页面上下文失效，`window.probe` 不再存在；不计通过。固定源码后 wocUll 限定完整往返通过。 |
| 搬回界面 mcucd1/Vx9G29/9PmKpK 在目标重启后节点超时 | 实际目标绑定、编辑和角色取证显示成员 page/render 存在而成员 Agent 缺失。网关取票接续修复的 RST 单测先通过，但完整界面仍失败；进一步复现首次取票失败后重试停止。补自动重试后 mGeGBQ 完整自由云端搬回、真实目标重启及两端全部节点认证通过；不把先前仅完成搬迁步骤算整条通过。 |
| 新 Agent 取票暂缺测试首次 2 失败、1 通过 | 强制结束原会话，再使首个新票据请求暂时失败；两个模式都在 5 秒期限内未恢复，复现订阅重试未继续。修后真实自由/限定网关及会话 25 项全部通过，完整界面结果另列。 |
| 当前公开自由探针 0YZfEU 在本机成员首次认证阶段失败 | 成员 needs-auth、按钮存在，物理点击前后均未命中按钮，捕获事件为 DIV，没有创建表单或认证请求，存储/日志诊断无失败。原诊断未记录该 DIV 的具体类名，不能认定唯一原因。补实际命中等待、仅在阻挡时真实忽略可选提示及完整配置隔离后，3QnEa0 全部通过；本次并未需要关闭语音提示，故不能倒推原失败就是语音提示。见 [失败取证](assets/collaboration-reopen-recovery/wan-free-auth-click-failure.json)。 |
| 重启演练 `724e98b4` 在版本断言失败，退出 1 | 探针误读根层 version；原夹具实际将版本 6 保存在 evidence 数组最后一项。修为校验实际层级，不将 undefined 比较失败认定为服务版本回退。见 [重启探针审计](assets/collaboration-reopen-recovery/reboot-probe-audit.json)。 |
| 重启演练 `b1d41be7` 在三类素材断言失败，退出 1 | 初次失败未分别记录各命名空间状态。隔离目录取证确认旧夹具 snap/px 完成文件在任务 worktree 的 out/asset-store，新指定的夹具 artifacts 目录尚无这两件；逐件验证原 50k 字节与 SHA-256 后，仅复制该夹具哈希的两件产物并保留源文件，没有改项目或凭证。恢复探针没有自动回退/补文件逻辑。`16f93bb0` 新进程演练三类均 200；旧失败仍单列，不冒充电脑重启通过。 |

在线浏览器首轮 ijXt9C 在 8beb0622 实际退出 1、391,592 ms：反向指纹九项全部为 true，但自然进场及卡中间起播的三条播放断言失败。未修改的 main adc3ae2a 用 --only-a4 的排障子集 eOYjEj 也实际退出 1、139,837 ms、同三条失败；它不是完整 C10 通过结果。只读连接本任务无头浏览器，按 probeRun 的 clipId/identityKey 精确匹配 L2 记录，证实四秒打字机整段追帧 11.7 ms，落在 (a) 档，旧夹具误认它是 (b) 档。99859d06 保留打字机及其传输检查，另放六秒 chapter-bar，并新增实际测量 catchup-b 且 vtOk=false 的前提断言，不注入成本、不改阈值、不修改产品播放规则；连续播放及中间起播的原断言保留。新运行结果单列，旧失败不改写。

## 解法表与顾问调用

### 卡点 4：节点和中继终止竞态

尺子：`node --test src/editor/sync/renderNodeHandoff.test.mjs server/test/reopen-hosting.test.mjs server/test/session-link.test.mjs src/editor/sync/reconnect.test.mjs`；桌面 `node scripts/probes/reopen-e2e.mjs --restricted --nodes --password-change --roles` 和 `--delete-offline` 变体。要求零失败、实际成员 deleted 且旧绑定全部清除。

| 行 | 轮/层 | 候选与因果 | g | h | f | 状态与实测 |
|---|---|---|---|---|---|---|
| 1 | 1/三级 | 按发出顺序完成节点绑定/撤销，代次拒绝旧票据 | 2 | 1 | 3 | 已试·过：新增两项先失败，修后 8 项全过 |
| 2 | 2/三级 | 可信挑战终止错误进入共享身份清理，不把 410 当断网 | 2 | 2 | 4 | 已试·部分：单元通过；rfkRUa 桌面仍失败，说明尚未到新建会话证明路径 |
| 3 | 3/三级 | 接续先更新网关路由，网关核验后剥除路由项，保留原会话秘密/队列 | 3 | 1 | 4 | 已试·部分：真实 RST 接续通过；JqoGji 删除仍失败，浏览器下游未断开 |
| 4 | 4/三级 | Duplex close 同步关闭成员 TCP，让客户端得知断线并核验删除 | 3 | 1 | 4 | 已试·过：真实自由/限定中继及完整桌面复跑通过 |
| 5 | 4/二级 | 放宽终止等待或只刷新页面判通过 | — | — | — | 关闭·剪：不能证明注销及旧连接撤销；未采用 |
| 6 | 4/三级 | 免费隔离公开入口；受控重启与独立测试壳 | 3 | 1 | 4 | 公开入口后续已绕开：不改宿主网络，不覆盖既有服务，自由/限定实测通过。电脑重启及独立原生副本切换已通过；系统默认双击仍待物理/隔离条件，其它工作继续完成 |

应用了 [with-agy SKILL](C:/Users/admin/.codex/skills/with-agy/SKILL.md) 的咨询流程。只读 manager 与两位 Gemini Pro High 顾问，不委派产品代码修改。完整原始响应、元数据及执行流保留在 worktree 的忽略目录 `work/agy/`。

首次 UI 冻结评审：A 会话 `12535d33-ad88-43f3-9bf8-1ef9b7fed80a`，成功退出 0、51.735 秒；B `e55246a9-f885-40b9-93c0-a7527cc28f21`，成功退出 0、30.948 秒。A 的未证实生命周期推测没有采用；B 的遮罩候选由主 Agent 的事件/截图核实后采用。

终止定稿评审：A `900e0e74-7e58-4a04-a4d3-19cd1879ef01` 首次 8.264 秒、进程退出 0，但越权请求读取命令被拒且无公开回答；保留失败尝试后做一次仅回答续轮，91.130 秒、退出 0。B `be912f59-3ff9-4134-b927-cacd680cceda`，41.912 秒、退出 0。两份完整意见保留，顾问没有运行测试。关于 stop 必须合成 fatal 事件的意见由实际共享清理调用顺序否定；关于租约延迟的意见由服务同步 deleted 写入否定；1006 推论也不能替代后续实际发现的下游 TCP 未关闭证据。主 Agent 以真实测试裁定。

### 卡点 5：扩展验收发现的持久化与首页边界

尺子：`node --test server/test/reopen-recovery.test.mjs`（当时 17 项、0 失败/跳过，卡点 6 后增至 19 项）；`reopen-e2e.mjs --matrix` 与限定模式变体。只改实际机制和测试，不新增工作流程。

g 表示实现与验证代价，h 表示预计剩余缺口，两者按 1–5 档估计，f 为两者之和；用于选择候选，不以耗时判停。

| 行 | 层 | 候选与原因 | g | h | f | 状态与实测 |
|---|---|---|---|---|---|---|
| 1 | 三级 | 非 Windows 首次密钥独占发布，避免陈旧 exists 判断覆盖另一实例 | 2 | 1 | 3 | 已试·过：先复现失败；修后陈旧判断和实际双进程二十加密身份全部可读 |
| 2 | 三级 | 首页清旧 shared/members/blocked，删除旧 URL 启动参数 | 2 | 1 | 3 | 已试·过：首页已退连接却留旧显示；限定模式真实首页及系统路径首页后刷新通过 |
| 3 | 三级 | 同一明文密码重新设置会有新盐/K，探针应重新认证 | 1 | 1 | 2 | 已试·过：不放宽权限；真实 UI 输入后恢复 |
| 4 | 三级 | 在原子替换前实际结束子进程，在部分临时写后注入 ENOSPC | 2 | 1 | 3 | 已试·过：原加密记录逐字节不变，退出锁回收和后续重试成功 |
| 5 | 三级 | 只运行隔离临时公开入口，避免碰现有公开服务或系统网络 | 3 | 1 | 4 | 已试·过：自由/限定公开 HTTPS/WS 均实际加入、重开和读素材；首轮入口不通保留记录 |
| 6 | 三级 | 已关联房间的设置表单不再生成隐藏的备用密码 | 1 | 1 | 2 | 已试·过：实际打开设置后生成计数不增加；新创建的实际 UI 仍提供两样默认密码 |
| 7 | 三级 | 扩展权限探针遵守同来源失败后的实际冷却 | 1 | 1 | 2 | 已试·过：Wil2ko 的脱敏记录含认证 401、挑战 429；不关闭生产限速。yD5YUV 实际等待 60 秒冷却后进入认证提示并由真实认证 UI 重新加入 |

### 卡点 6：一次损坏提示的来源不明与暂时存储错误分类

尺子：`node --test server/test/reopen-recovery.test.mjs`；`node scripts/probes/reopen-e2e.mjs --hosted --matrix --nodes --trust --password-change --roles`。要求损坏字节不变、明确暂时故障按 Retry-After 保留身份自动恢复；历史 t6nM3X 的原因另行标识，不能以复跑成功替代取证。

| 行 | 层 | 候选与原因 | g | h | f | 状态与实测 |
|---|---|---|---|---|---|---|
| 1 | 三级 | 分开记录本机 API 固定阶段和浏览器日志恢复失败计数 | 1 | 2 | 3 | 已试·部分：后续 eUSdVu 全过，未重现 t6nM3X，不能倒推出当时原因；诊断保留 |
| 2 | 三级 | 只按明确 OS/保护进程暂时类别重试；摘要、解密、格式仍失败关闭 | 2 | 1 | 3 | 已试·过（独立分类问题）：两项新增测试先失败，修后 19 项全过；真实桌面等待与自动重入亦已走过，完整结果见矩阵证据 |
| 3 | 三级 | 放宽损坏判断、忽略失败或将全部错误无限重试 | — | — | — | 关闭·剪：没有证据区分真损坏，会隐藏不可恢复错误，未采用 |
| 4 | 三级 | 认定 DPAPI 超时、并发写或日志异常就是 t6nM3X 原因 | — | — | — | 关闭·剪（无机制证据）：顾问假设未被该次请求诊断证明；原因未定保留 |

只读顾问 A 会话 `e1292b7e-a898-484b-b2f8-f3893642fec9`，退出 0、30.3359006 秒；B `ab6b5b98-3817-4af4-abef-a611a73e4cf5`，退出 0、30.9267246 秒。两位 Gemini Pro High 均未调用工具；主 Agent 已阅读完整原文及元数据。manager 核查指出：DocSync.restoreJournal 位于浏览器身份 hook，不在 recovery HTTP catch 中；节点解绑来自加载前生命周期，不能证明损坏清理因果；事后持久记录有效不能证明当时内存/请求正常。上述纠正和原始意见均保留在忽略目录 `work/agy/storage-damaged/manager-storage/`，未把假设当结论。

### 卡点 7：原生普通成员认证及单实例打开

尺子：独立原生壳以普通成员首次实际认证，正常退出后切换运行副本，以空 WebView2 打开旧文件；主机后上线，成员自动加入，四次双向编辑及三类 50k 素材通过。单实例事件必须出现新的共享连接对象并实际 connected。

| 行 | 层 | 候选与原因 | g | h | f | 状态与实测 |
|---|---|---|---|---|---|---|---|
| 1 | 三级 | 记录真实按钮命中对象、点击及表单生命周期，区分遮罩和组件重挂 | 1 | 2 | 3 | 已试·过：实际语音扩展提示拦截，关闭隔离提示后真实认证通过 |
| 2 | 三级 | 等待新共享连接而非已有窗口仍 connected | 1 | 1 | 2 | 已试·过：普通成员 mb05jB 与主机 zM8OTr 新 PID、原身份、原房间均通过 |
| 3 | 三级 | 将焦点/DPI 或组件重挂当原因并改产品表单 | — | — | — | 关闭·剪：截图/事件证明遮罩，稳定最终 DOM 也不能证明从未重挂，未采用无证据产品改动 |

只读顾问 A `4e0543f8-c949-4089-9817-c4a66d3fbc80`，退出 0，24.9126402 秒，输入/输出/思考/缓存/总 token 为 18,340/2,742/1,836/0/21,082；B `f6d19d69-0d0e-4178-8b63-39eb9b921226`，退出 0，26.8095018 秒，18,232/2,972/1,882/0/21,204。均无工具调用；manager、原始回答、元数据和提示保留 `work/agy/native-member-auth/manager-native/`，根 Agent 全文读取后用真实点击取证裁定。

### 卡点 8：已有搬迁语义缺实际事务、运输器及用户入口

尺子：`node --test server/test/reopen-relocation*.test.mjs server/test/reopen-recovery.test.mjs`；两个方向在部分传输后真实停止两端、同事务续传，源拒绝旧认证、目标发布后成员编辑和三类 50k 素材；实际设置往返及目标重启原房间连续、恢复建房 0。

| 行 | 层 | 候选与原因 | g | h | f | 状态与实测 |
|---|---|---|---|---|---|---|---|
| 1 | 三级 | 目录 CAS、精确事务/代数/目标/清单及可靠源封锁，完整私有暂存后发布 | 3 | 2 | 5 | 已试·过：旧登记/票据/邀请码/接续拒绝，部分安装保持不可接入、重试不覆盖后续编辑，显式删除最终 410 |
| 2 | 三级 | 固定已信任服务的服务器间 HTTP 流式运输与启动续传，源实际参与 | 3 | 2 | 5 | 已试·过：三个真实 HTTP 测试全过（5,495.1287 毫秒），两个方向部分传输后两端重启；普通成员可显式搬回，不凭文件接管 |
| 3 | 三级 | 首次请求前加密保存目标任务；任务完成前统一恢复等待，完成后可信目标绑定优先 | 2 | 1 | 3 | 已试·过：恢复 25 项全过（9,459.3889 毫秒），含 ENOSPC、跨实例读取、注销/迟到完成、启动扫描前等待及终止错误；实际自由云端搬回与限定完整往返通过 |
| 4 | 三级 | 用本机身份日志或旧文件快照代替完整服务/素材搬迁 | — | — | — | 关闭·剪：日志不含完整服务器账户、租户和素材；不等价于已有语义 |
| 5 | 二级 | 规定所有搬迁仅创建者可做，或所有本机离线打开必须先访问目录 | — | — | — | 关闭·剪：无语义依据新增第四特权或破坏正常离线使用；源设备参与与用户角色分别核验 |

顾问调用沿用 A `fea9c404-8f0f-4c13-a26b-2b7ce12f404c`、B `19538716-2f28-47df-aeaa-1b9799bbed89`、C `ab7ffe1d-4b8c-4803-b280-48cbec283a6b`，模型 Gemini 3.1 Pro High。三轮均仅回答、无工具/服务/测试/账户访问，全部退出 0；原始响应、元数据、执行流和 manager 核查完整保留 `work/agy/project-relocation/manager-relocation/`，根 Agent 已全文读取。

| 会话/轮 | CLI 记录秒数 | 输入/输出/思考/缓存/总 token |
|---|---|---|
| A/1 | 23.5229334 | 18,303/2,695/1,805/0/20,998 |
| B/1 | 32.3433552 | 18,169/3,348/1,924/0/21,517 |
| C/1 | 25.2005923 | 18,168/2,916/1,666/0/21,084 |
| A/2 | 192.0880402 | 27,274/5,726/3,827/16,694/33,000 |
| B/2 | 192.2647097 | 27,715/6,526/3,919/16,781/34,241 |
| C/2 | 186.8011949 | 73,455/5,310/3,145/8,203/78,765 |
| A/3 | 3,030.1654774 | 95,778/9,609/6,499/16,694/105,387 |
| B/3 | 3,045.2898811 | 93,218/12,218/8,037/16,781/105,436 |
| C/3 | 3,028.8733399 | 95,066/9,035/5,503/16,689/104,101 |

第三轮耗时按 CLI 元数据原值记录，可能含持续会话累计时间，不推定为该轮独立运行耗时。分歧与裁定如下；顾问成功退出不等于其主张得到验证。

| 意见 | 核验与裁定 |
|---|---|
| 正常 source stop 会删除事务，或 publish 可复活已删除房间 | 正常 stop 的 deleted 缺省 false 保留事务；显式 deleted:true 为最终 410，测试覆盖准备/ready 后删除。没有全局屏蔽真正删除。 |
| 新目标摘要可冒充登记密钥 | 真实端点拒绝传入校验摘要或错误原密钥；新登记原文为 43 字符服务器能力，只有摘要进入目录/页面。 |
| 同步安装存在异步毫秒窗口、Buffer 邀请密钥双重编码、Windows 反斜线绕过 | 先可靠 staging 且安装同步执行；实际失败注入后不可认证。原 store 暴露 raw Buffer，搬迁前邀请码在新服务仍能兑换。传输清单使用明确 `/`，路径逃逸/链接/重复/摘要篡改测试拒绝；未按无证据假设扩大协议。 |
| 清单全件等于所有语义引用一定完整 | 不等价。已增加当前项目明确引用的 original/small/CAS 缺素材预检，缺失时源仍可编辑；未穷举全部历史操作中的语义素材引用，属于完整性范围限制。 |
| 只有内部复制，缺远程运输/设置动作/持久控制器 | 评审当时成立；后续实现两个方向真实 HTTP 运输及设置动作，实际服务中断、UI 往返证据分别验证。 |
| 必须增加创建者第四特权或让正常本机打开依赖在线目录 | 现有三项特权及离线语义不支持；保持显式动作、源物理参与、目标设备证明和正常离线恢复。 |

### 卡点 9：搬回后成员 Agent 缺失

尺子：`node --test server/test/reopen-hosting.test.mjs server/test/session-link.test.mjs`；实际目标服务重启后主机/成员各有 page、Agent 和 render 认证；票据、素材和双向编辑仍正确。

| 行 | 层 | 候选与原因 | g | h | f | 状态与实测 |
|---|---|---|---|---|---|---|---|
| 1 | 三级 | Agent 接续从页面重新取委托票据，网关核验后剥除专用票据 | 2 | 1 | 3 | 已试·部分：真实 RST 两模式通过，但 9PmKpK 完整目标重启仍缺成员 Agent，不能宣布修完 |
| 2 | 三级 | 新订阅在取票或首次握手失败时继续现有退避，关闭/解绑仍取消 | 2 | 1 | 3 | 已试·过：新增暂缺取票断言先在两模式失败，修后 25 项全过；mGeGBQ 自由云端搬回及 sW4WQ5 限定往返均实际目标重启、全部节点认证通过 |
| 3 | 三级 | 放宽原服务接续认证或认定固定节点开关/4404 无限重试就是原因 | — | — | — | 关闭·剪：page/render 已认证排除 blanket 配置错误；现有会话层处理 4404/4410，保留严格认证，无证据不改 |

只读顾问 A `481a76ad-6c24-4af9-8878-fb3869777d96`，退出 0，25.7663979 秒，输入/输出/思考/缓存/总 token 为 18,795/2,572/1,438/0/21,367；B `98fdb85b-4fa4-4f03-a30f-e6b20d433c86`，退出 0，46.958611 秒，18,804/5,089/3,822/0/23,893。无工具调用，完整原文/提示/执行流/元数据保留 `work/agy/relocation-agent-resume/manager-agent/`。两位均提出取票/初次握手未持续重试的假设，实际故障注入证实这个代码缺口；原失败界面没有细分当时究竟哪一种先发生，不反推唯一原因。B 的无限接续及其它位置假设未获实证，不采用。

### 卡点 10：系统双击无法路由到隔离测试壳

尺子：`node --import=./scripts/lib/test-silent-processes.mjs scripts/probes/reopen-native.mjs <owned fixture.json> --os-double-click --allow-temporary-open-command`，或另用`--isolated-default-progid --allow-temporary-default-progid`的明确模式；主机及追加`--member`两角色均须取得本次nonce的匹配原生回执，随后实际恢复、单实例转发、双向编辑及票据素材读取退出0。当前19轮handoff均退出1，工具/时限未完成不冒称路由实测；原生参数/IPC的通过不能替代该尺子。物理桌面由用户明确空闲安排，不结束用户Shell，不改受保护选择。

尺子（2026-10-05 用户改定路线后启用；上一段旧尺子保留作历史）：笔记本从本分支构建完整安装包并真实安装，关联只由安装器登记，任何会话都不改写关联。`node --import=./scripts/lib/test-silent-processes.mjs scripts/probes/reopen-installed.mjs --manifest <该次构建的清单> --app-src-hash <该次构建的运行副本摘要>` 的主机角色与追加 `--member` 的成员角色各退出 0；成员角色的主机由 PC 用 `reopen-remote-host.mjs` 在隔离数据目录和隔离端口上起。每个角色须有：只读预检确认 `.proc` 的有效打开程序就是已装的被测构建、运行副本逐文件对上清单；冷启动与已开窗口两次资源管理器双击各有进程回执（已装的 `promptcut.exe`、命令行带那份文件、父进程 `explorer.exe` 且早于它创建、创建时刻晚于就绪时刻）；随后原房间原身份恢复、成员等待后自动加入、4 次双向编辑、三类带票据素材读取、恢复建房 0、原文件不变。做法见 [collaboration-reopen-installed-acceptance.md](../plan/collaboration-reopen-installed-acceptance.md)。

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 控制文件移出显示目录、独占桌面 | 消除行重排及并发输入 | 2 | 1 | 3 | 463b085b第5轮 | 关闭·无改善 | 正确文件仍启动安装版，不能只怪用户操作 |
| 2 | 2 | 三级 | 1 | 关联通知flush、armed后F5 | 等通知送达后重取目录条目 | 2 | 1 | 3 | faa38f73第6轮 | 关闭·无改善 | 仍走安装版；已有通知，不能采用“未通知”解释 |
| 3 | 3 | 三级 | 2 | 唯一owned ProgID临时默认值 | 避开复用旧ProgID | 3 | 1 | 4 | 1ec99174第7轮 | 关闭·无改善 | 入口和测试树恢复；后台四视图值虽变，Shell有效默认仍为原类型，不能称有效handler已切换 |
| 4 | 4 | 三级 | 3 | 执行身份/视图/候选key只读取证 | 区分用户上下文、视图及Shell选择来源 | 2 | 1 | 3 | Codex max独立攻坚、后台API | 已试·部分 | 同用户/同登录/中等权限、32/64摘要一致；新Shell文件对象在旧命令租约内选测试壳。FindExecutable另选qtcreator，不把它当Explorer调用来源。没有给顾问真实关联写入或UI授权 |
| 5 | 4 | 三级 | 3 | 新的测试Shell进程在租约后创建并枚举 | 区分创建前已有的进程状态 | 3 | 2 | 5 | wKJQ47部分执行 | 已试·部分；关闭·剪（方向已关） | 新45208确实在arm后创建，但导航未完成且guard阻止文件输入，未完成有效双击，本候选仍开放；不提高TTL；2026-10-05 用户定 PC 不再改写关联，本行不再继续 |
| 6 | 4 | 二级 | — | 改用参数启动或延后默认双击 | 移动门槛而未消掉失败 | 1 | 5 | 6 | — | 锁住 | 三级未穷尽，不能缩减完整终点或把本行判通过 |
| 7 | 5 | 三级 | 4 | 租约生效后才导航到新测试目录 | 避免关联生效前已枚举的目录对象 | 2 | 2 | 4 | dBtkun有效点击 | 关闭·无改善 | 新目录在arm后观察，真实双击仍启动安装版；只关闭“提前枚举该目录”的窄解释 |
| 8 | 6 | 三级 | 7 | 新建任务Explorer进程再进入新目录 | 区分前一目录进程残留 | 2 | 2 | 4 | fBmwWR有效坐标双击 | 关闭·无改善 | 3388新进程仍走安装版；它在arm前创建，不关闭第5行 |
| 9 | 7 | 三级 | 4 | 0/8/16/24秒无UI租约直接值及推荐对象 | 查持续提前恢复或推荐对象固守旧身份 | 2 | 1 | 3 | association-delay-7gMv3m退出0 | 已试·部分 | 16项直接值和四次fresh推荐均测试壳，最后原值恢复；窄变化未复现，不代替点击时刻读数 |
| 10 | 8 | 三级 | 9 | 真实点击期间连续只读值与即时前后时间 | 区分UI触发覆写和执行对象分歧 | 2 | 2 | 4 | 默认解析与F5前后取证 | 已试·部分；关闭·剪（方向已关） | DbytMa/UbRPrF真实default API及四视图均测试壳；只做F5，无文件invoke，不能关闭点击触发的解释；高频第11查询1且stderr缺失，原因未知，不认为已证明缓存；2026-10-05 用户定 PC 不再改写关联，本行不再继续 |
| 11 | 9 | 三级 | 4 | 全局静态verb和菜单扩展登记只读枚举 | 查默认动作是否由其它已登记命令直接指定 | 2 | 2 | 4 | global-defaults只读退出0/223ms | 关闭·无改善 | 直接目标引用0、无读错或截断；只关闭静态命令解释，不排除动态扩展行为，未运行扩展或文件invoke |
| 12 | 10 | 三级 | 5 | 明确启用90秒探针守护及真实到期截止 | 容纳每步约9秒的CU往返，保留默认30秒、还原与匹配回执标准 | 2 | 1 | 3 | Ams3k6目录已显示，自测及30/90ownerexit0 | 已试·部分；关闭·剪（方向已关） | 时限中断已绕过，但观察到安全提示停止；无文件invoke，PickerHost拦截关闭输入，不把未完成判路由失败或成功；2026-10-05 用户定 PC 不再改写关联，本行不再继续 |
| 13 | 11 | 三级 | 4 | 笔记本真实安装候选包：安装器按产品流程登记 `.proc`，资源管理器真双击；不再临时改写关联 | 被测程序就是系统登记的默认程序，不再有「注册表值已变而 Shell 实际选择未变」的分歧，也没有租约时限；凭已装程序的进程路径、带那份文件的命令行、父进程为资源管理器和启动地址取证 | 3 | 1 | 4 | `reopen-installed.mjs` 主机与 `--member` 两角色在笔记本各退出 0 | 已试·过 | 2026-10-05 用户定。只改验证方式，不改语义、不降门槛；PC 只做不启动正式版的演练。结果：主机、成员两个角色在笔记本各退出 0，四次真实双击都有进程回执；卡点 10 关闭。其间的失败与修正见「2026-10-05 真实安装验收结果」 |

Gemini两轮公开回答和manager静态窄审已完整读取；其建议不是事实证据。窄审提出部分创建残留及清理未完误报0，修后六步故障注入、超时、持有者退出及外部新增值保护实际自测通过。保留注册表复查/删除非事务的并发边界；没有以多个模型同意代替实际OS双击。攻坚顾问最终结果后续按实际证据补记。

### 卡点 11：笔记本上 1080p 全幅流的分段编码耗时没过线

要满足的是 G0-R 里带耗时门槛的那一项：`node scripts/probes/stream-produce-probe.mjs --origin <隔离的 dev server>` 在笔记本上退出 0。现在观察到的是它只挂一条，「1080p 全幅流 15 帧分段编码 ≤ 300 ms」，p50 在 311～367 ms 之间；分段字节数（428,801）、alpha 误差（0.0956）、重启后重新生产的段数（0）等其余各条都过。尺子就是这条命令的退出码和它报的 p50。上一轮（2026-10-04）同一台机器上这一项量过两次：237 / 248 / 273，p50 248，开跑前 CPU 0～3%；264 / 294 / 307，p50 294，没有记当时的 CPU。

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 等机器空闲后再测：CPU 连续 4 次低于 15% 才开跑，只测一次 | 去掉别的进程争 CPU | 1 | 2 | 3 | 笔记本，`7d7ead70` | 已试·部分 | 第一次没过闸就测，p50 335（CPU 约 18.5%）；过闸后的正式一次 p50 313（312 / 313 / 342），仍不过。过闸到开跑的几秒里 CPU 又回到 15% 以上。无人值守时屏保自己占 4～8%，桌面应用和显卡浮层再占几个点，底噪就在 13～17% |
| 2 | 2 | 三级 | — | 核对分支在编码路径上有没有改代码 | 排除代码原因 | 1 | 3 | 4 | `git diff adc3ae2a HEAD` | 已试·部分 | `server/bakery`、`frame-stream`、`frame-pipeline`、`frame-service`、`src/render`、探针本身、`package.json` 与锁文件都是 0 个文件有差异；`vite.config.ts` 只多了一条禁止对外提供的目录。代码上找不到这条耗时会变的原因，但它不能让这一项过线 |
| 3 | 2 | 三级 | 1 | 同样条件下 main 与分支交替各测两次（只比较，不用于判定通过） | 区分分支带来的退步和机器此刻的状态 | 1 | 2 | 3 | 笔记本，main `adc3ae2a` 对分支 `7d7ead70` | 已试·部分 | main 的 p50 是 358、311，分支是 357、367，四次都不过，单次编码值的范围互相重叠；同一个提交两次之间差得比两个提交之间还大。看不出分支比 main 慢，main 此刻也过不了 |
| 4 | 3 | 三级 | 1 | 用户在机器旁、屏保不在前台时，按第 1 行的规程正式重测分支，再测一次 main | 去掉屏保和无人值守时的底噪 | 1 | 1 | 2 | 笔记本，分支 `a88f4eed` 对 main `adc3ae2a`，2026-10-05 15:36～15:42Z | 关闭·无改善 | 用户在机器旁，屏保进程不在，两道闸都过（四次 5 秒平均：分支前 11.5、9.5、9.8、8.7，main 前 14.5、10.2、8.7、9.5）。分支 p50 364（289 / 364 / 381），main p50 376（362 / 376 / 388），都退出 1，都只挂这一条。屏保不在也不过，读数和屏保在跑时差不多，「屏保占 CPU」解释不了当时的慢。事后查明这一轮是在笔记本处于限频状态时量的，见第 11、13 行 |
| 5 | 3 | 二级 | — | 改门槛，或改成按与 main 的相对差来判 | — | — | — | — | — | 锁住 | 改门槛要用户确认（`verification.md`）；三级层还有第 4 行没试 |
| 6 | 4 | 三级 | 2 | 核对被计时的那段代码和量它的探针，从上次修到过线以来有没有改过 | 区分「代码变慢了」和「机器当时慢」 | 1 | 3 | 4 | `git rev-parse <提交>:server/bakery/ffmpeg.mjs`，探针文件同样比 | 已试·部分 | 都没改过。探针计时的是 `openStreamSegmentEncoder` 这一段（起 ffmpeg、喂 15 张 PNG、收尾），它所在的 `server/bakery/ffmpeg.mjs` 在修复合入的 `501a7dd7`、main 的 `adc3ae2a` 和本分支上是同一个文件对象；`stream-produce-probe.mjs` 也是。所以从那次修复起，笔记本上先后量出的读数都出自同一份代码，见表后的读数记录。读数的差别来自机器当时的状态；这个结论同样不能让这一项过线 |
| 7 | 4 | 三级 | 1 | 只读核对笔记本的电源、功耗方案和频率 | 排除用电池、省电模式、降频这类不用人到场就能去掉的原因 | 1 | 3 | 4 | 笔记本只读查询，2026-10-05 15:13～15:16Z | 关闭·无改善 | 接着电源，电量 100%；功耗方案 Balanced，Windows 电源模式是「最佳性能」；华硕自带的性能模式查不到。Ryzen 7 6800H，8 核 16 线程；低负载下频率是标称的 78.8～83.4%，负载上来后会不会升高这次没测。屏保在跑，占 4.7%，约合 0.75 个核；桌面应用的三个进程合计约 5.2%；总占用 11～18%，平均 13.4%。编码器是 libx264，纯 CPU 编码，后台占掉的核直接算进编码耗时。开机约 45 小时没重启。没找到不用人到场就能去掉的原因 |
| 8 | 4 | 三级 | 1 | 会话用模拟输入退掉屏保，或结束屏保进程，再测 | 去掉屏保占的 CPU | — | — | — | — | 关闭·剪（禁止） | 屏保不是会话启动的进程，不由会话结束；电脑操作工具在屏保挡着时拒绝输入，用脚本绕过去就越出了用户给的范围 |
| 9 | 4 | 二级 | — | 在本分支里改编码参数或并行方式，给这条门槛找回余量 | 耗时降到线下 | — | — | — | — | 锁住 | 要改本轮已定的做法：这一轮只改验证方式、不动产品代码，两个角色的验收证据也都对着没动过的产品代码；本分支本来不碰编码路径。三级层第 4 行还没试。要不要在 main 上另开任务做，由用户定 |
| 10 | 5 | 三级 | 4 | 对照 2026-10-04 的结果文件，看慢在哪一段 | 把「整机都慢」和「只有某一段慢」分开 | 1 | 3 | 4 | 仓库里的 laptop-stream.json、laptop-stream-fixed.json 对这一轮的回执 | 已试·部分 | 截 15 张 1080p 帧的耗时和 10-04 差不多（10-04 是 1158、1025 ms，这一轮限频时 1156、1137、1185），x264 编码慢了约四成（248、294 对 364、376）。Node、Chrome、ffmpeg 的版本和软件渲染方式两天相同。截帧主要吃单核并含固定等待，编码吃多核（切片线程封顶 8），所以先往多核上查。状态恢复后截帧也快了一些（970～1081） |
| 11 | 5 | 三级 | 10 | 量单线程与全核满载时的频率和吞吐（8 秒纯计算负载），并只读查处理器电源设置 | 看多核是不是被限频 | 1 | 2 | 3 | 笔记本，2026-10-05 15:50～16:05Z | 已试·部分 | 当时处在限频状态：16 线程满载时 `% Processor Performance` 从第一秒起平在标称的 74%（73.8～75.4），8 线程 81%，单线程时 16 个逻辑核里最高的也只到 95.6%；吞吐 16 线程是单线程的 8.03 倍，8 线程 5.98 倍。系统这边没有限制：睿频模式是积极，最大处理器状态 100%，不驻留核，接着电源，电源模式「最佳性能」。同一台机器 16:18Z 以后空闲时就有 104～115%，重负载下 100～118%（第 13、15、16 行），所以这不是固定的功率上限，是那段时间的一种状态；第 7 行 15:13Z 读到的「低负载 79～83%」也属于这种状态。原因没有查明 |
| 12 | 5 | 三级 | 10 | 编码那一段有谁在抢核、有没有内存压力（诊断性再跑一次探针，每约 300 ms 采样；不算数） | 找出占着核的进程 | 1 | 3 | 4 | 笔记本，分支 `a88f4eed`，15:53～15:55Z | 已试·部分 | 那一次 p50 366（292 / 366 / 380），也是限频状态下的。探针以外的进程合计占用中位 10.7%（4.8～19.1%）；常驻的是承载笔记本会话的桌面应用进程，5～9%，约合 1.4 个逻辑核；其余超过 3% 的只偶尔出现。探针忙的时段里频率读数中位 74.7%，整段没有一行到 100%；这时探针自己的进程树占到全部逻辑核的 85% 以上。内存没有压力：可用 15.2 GB，换页 0 |
| 13 | 6 | 三级 | 12 | 让笔记本会话静下来再测：后台脚本自己跑，会话结束当前一轮、不做任何事（诊断，不算数） | 去掉桌面应用在会话活跃时占的核 | 1 | 2 | 3 | 笔记本，分支 `a88f4eed` 与 main `adc3ae2a`，16:16～16:22Z | 已试·部分 | 两次都退出 0：分支 p50 238（237 / 238 / 294），main p50 261（239 / 261 / 293）。空闲时总 CPU 中位 4.9%，桌面应用各进程合计约 2%，屏保不在；运行期间频率读数中位 109～110%。和 15:53Z 那次（p50 366、频率约 75%、桌面应用 5～9%）差别很大。这是当天第一次量到过线 |
| 14 | 6 | 三级 | 11 | 请用户确认华硕的风扇 / 性能档，愿意的话切回平时用的那一档或让机器歇一歇、重启，再测 | 去掉全核功率上限 | — | — | — | 笔记本会话在它的对话里问了用户 | 关闭·剪（方向已关） | 用户的原话：「笔记本就是这性能，自动睿频。」他没有说要换档、歇机或重启。第 13 行也说明那不是固定的档位上限。会话没有动任何模式开关 |
| 15 | 7 | 三级 | 13 | 用会话静止的量法做一轮正式测量：后台脚本，先静置 150 秒，过闸，分支一次，再过闸，main 一次；规程和判法事先定死，只做一轮 | 在没有限频、没有会话占核的状态下量 | 1 | 1 | 2 | 笔记本，分支 `a88f4eed` 与 main `adc3ae2a`，16:32～16:42Z | 已试·过 | 分支退出 0，p50 268（258 / 268 / 278），其余各条也过；过闸四次 5.4、4.7、8.1、7.7，运行期间频率读数中位 109%，桌面应用约 2%。屏保在分支开跑前一刻起来了，两次运行期间都在，平均占约 3%，一阵一阵的，最高到 26%。main 对照这一次退出 1，p50 341（331 / 341 / 342）；它的频率读数和桌面应用占用与分支那次看不出差别，慢在哪里没有查到。按事先定的判法：分支这一次退出 0，计时项通过 |
| 16 | 7 | 三级 | 15 | 对照：会话在前台等着命令时再跑一次分支（诊断，不算数） | 分辨「会话活跃就会拖慢」和「那段时间机器另有限频」 | 1 | 3 | 4 | 笔记本，分支 `a88f4eed`，16:42～16:44Z | 已试·部分 | 也过了：p50 260（249 / 260 / 297），重负载时频率读数中位 106.6%，桌面应用约 2%，屏保在。所以「只要会话在前台等命令就会拖慢」不成立。13:54Z～15:55Z 那段时间为什么限频没有查明：可能是机器当时另有原因、之后自己解除了，也可能是那段时间会话的活动（频繁收发长消息、截图、电脑操作）比单纯等命令重得多。能确定的只是：频率读数约 75% 和桌面应用占 5～9% 同时出现、同时消失 |

这一项现在的状态：按第 15 行通过。此前两次正式测量不过（第 1 行的 313、第 4 行的 364），和这一次并排保留；那两次是在笔记本处于限频状态时量的，限频的原因没有查明。用户可以推翻这个判定。第 5、9 两行（二级）没有解锁。顾问：第 4 行没过、第 14 行被用户的答复关掉之后请了一次思路顾问，记录见本节末尾；攻坚顾问没有调用，因为尺子只能在笔记本上跑，codex 在 PC 上跑不了，它能动手改的只有编码路径，那是第 9 行。

这条断言在笔记本上的读数记录（p50，单位 ms；`501a7dd7` 之后各次量的是同一份代码）：

| 时间 | 读数 | 当时的状态与出处 |
|---|---|---|
| 2026-09-27 | 355～397 | 修之前，当时记为性能缺陷（`TODO.md`「已修」条目的原文） |
| 2026-09-28 | 207～224 | 修完，`501a7dd7` 合入 main，只改编码参数的装配，产出逐字节不变（同上）。修复当时就量过它随后台占用的变化：CPU 2～4% 时 6 轮中位数 211，背景 8～13% 时各轮 245～276（`docs/archive/agent-reports/AGENT-perf-encode-2.md`） |
| 2026-09-30 | 261 | 当时的最终合流（同上） |
| 其后一轮 | 287 | 那一跑时屏保在占 CPU，当时留了话：屏保不在时也逼近门槛就要查（`REPORT-post-M8.md` 第 7.5 节） |
| 2026-10-04 | 248 | 本分支上一轮的第一次正式测量，开跑前 CPU 0～3%（`REPORT-collaboration-reopen-laptop-validation.md`，laptop-stream.json） |
| 2026-10-04 | 294 | 同一天稍后的正式复跑，没有记当时的 CPU（同上，laptop-stream-fixed.json） |
| 2026-10-05 | 335、313；对照 main 358、311，分支 357、367 | 这一轮，无人值守，屏保在跑，CPU 13～17% |
| 2026-10-05 15:36～15:42Z | 分支 364，main 376 | 正式重测：用户在场，屏保不在，过闸时 CPU 8.7～11.5%；事后查明当时处在限频状态 |
| 2026-10-05 15:53Z | 366 | 诊断，不算数；重负载时频率读数约 75%，桌面应用占 5～9% |
| 2026-10-05 16:19～16:22Z | 分支 238，main 261 | 诊断，不算数；会话静止，屏保不在，频率读数 100% 以上 |
| 2026-10-05 16:37～16:42Z | 分支 268，main 341 | 正式一轮：会话静止，屏保在跑，频率读数 100% 以上 |
| 2026-10-05 16:42Z | 260 | 对照诊断，不算数；会话在前台等命令，屏保在跑，频率读数 100% 以上 |

同一份代码在这台机器上从 207 量到过 367，读数跟着后台占用走：修复时 CPU 2～4% 是 211 上下，背景 8～13% 是 245～276；这一轮背景 13～17%，是 311～367，已经超出修复时量过的范围。记着屏保在跑的几次是 287～367；开跑前 CPU 只有 0～3% 的那一次是 248；261 和 294 两次没有记当时的后台占用。按这些读数，屏保不在时重测有可能过线，但 2026-10-04 同一天里就量出过 248 和 294，后一个离门槛只有 6 ms，过了也说明不了余量够。重测如果仍然贴线或超线，就该在 main 上另开任务：先多测几次把这条读数的分布量清楚，再定是找回余量还是改门槛，两样都要用户定。

更正（2026-10-06）：本节开头原先写的是「上一轮同一台机器空闲时（CPU 7～11%）这一项是 264 / 294 / 307」，其中的 CPU 读数安错了地方，已改。「空闲 7～11% 时 p50 283」是笔记本会话在本轮回执里引用的它自己更早的一次记录，量的是 2026-09-28 第一次提速合入时的 `211695db`，那时 `server/bakery/ffmpeg.mjs` 还不是现在这一份，不能和上表 `501a7dd7` 之后的读数直接比；它的结果文件不在仓库里。

正式重测之后的经过（2026-10-06 补）。上面「屏保不在时重测有可能过线」这句推断当时没有应验：用户在场、屏保不在的那一轮仍是 364 和 376。随后的只读诊断发现，15:13Z 到 16:05Z 的几次读数里笔记本一直处在限频状态：全核满载时频率读数只有标称的 74%，没有任何核超过 100%，而系统的电源设置没有任何限制；同一段时间里承载笔记本会话的桌面应用常驻占 5～9% CPU。16:18Z 以后这两个现象一起消失：空闲时频率读数就在 104% 以上，桌面应用约占 2%。在这种状态下分支量了三次，238、268、260，都过线；main 量了两次，261 过线，341 不过。

结论三句话。第一，计时项按事先定死的规程在第 15 行通过；此前两次正式测量不过，是在限频状态下量的；三次都并排留着，用户可以推翻这个判定。第二，限频的原因没有查明，对照（第 16 行）排除了「会话在前台等命令就会拖慢」这个简单解释。第三，这条门槛的余量很薄：正常状态下 main 自己就量出过 341，屏保一阵一阵的占用就足以让它越线。分支与 main 成对量过五组（限频时 357 对 358、367 对 311、364 对 376，正常时 238 对 261、268 对 341），看不出分支比 main 慢；被计时的代码两边是同一份。

留给用户的事：这条门槛在 main 上要不要另开任务处理，把读数的分布和它对后台占用的敏感度量清楚，再定找回余量还是改门槛；以后在笔记本上测带耗时门槛的项，建议同时记录重负载下的 `% Processor Performance`，读数低于 100% 的那一次不作数，要不要写进 `verification.md` 由用户定。

顾问调用记录（卡点 11）。思路顾问 Gemini（`gemini-3.1-pro-high`，经本机 agy 无头模式，纯问答，不给文件和工具），会话 `c6cc09ce-93d0-4f00-83ed-e9e485f8eb5f`，退出 0，67.0 秒，25,533 token，没有工具调用；提示词和回答原文留在 `work/installed-run/advisor-11/`，不入库。它给了四条假设，都只当假设：一，后台的桌面应用造成缓存颠簸和上下文切换，建议不带这个应用再量一次，与第 13 行同向，已做；二，长时间开机加常驻负载吃掉了睿频的热与功耗预算，建议用第三方硬件监控工具记录有效频率与温度，下载运行第三方工具要用户同意，没有做，频率读数已由系统计数器取得（第 11、13 行）；三，Node 事件循环拥堵使经 stdin 喂数据变慢，它假设探针的 Node 进程承载着桌面应用，这不符合事实，而且编码时探针进程树占到全部逻辑核的 85% 以上，不是在等数据，不采用；四，8 条切片线程里有两条被排到同一个物理核的两个逻辑核上，一帧要等最慢的那条，这能解释读数为什么对后台占用特别敏感，手头约 300 ms 的采样间隔分辨不了，没有验证。

## 与计划的差异和仍需条件

1. 初始探针证实云端登记/中继缺失，已纳入实现，而非假定部署支持。新增可审核组合服务和部署文件清单，生产仍旧版本；没有在现有公开端口覆盖它。
2. 现有产品语义的匿名 LAN 邀请校验/兑换、IPv6 公网直连和打洞，比已加入身份重开的最小链路更广。本次新增中继交付已取得有效凭证的恢复，不把这些更广承诺标为完成。
3. 实际代码缺少项目级搬迁流程，但 `workflow/project.md` 已规定「搬到云端」「搬回本机」。据此落实已有语义，修正先前将其误列为计划 §6 排除新流程的解释。已实施两个方向的真实远程传输、设置入口、可信位置切换和中断恢复，原生云端搬回和限定本机完整往返实际界面通过；没有缩减为内部文件复制。新增契约见 [collaboration-relocation-contract.md](../plan/collaboration-relocation-contract.md)。
4. 受控电脑重启已于 2026-10-04 实测通过。用户重启前建立的 `pc-reopen-e2e-MH2SCg` 检查点与当前启动标识不同；按默认模式执行，退出 0。原房间 `sp_e2uowvu7stzt3esqfeh7v4aj63` 保持，creator:host/member:member 认证、成员先等待后自动加入、登记 online、双向编辑及三类带票据 50k 素材均通过，服务版本 12→14，零建房。源提交 `33d7106f`，见 [physical-reboot.json](assets/collaboration-reopen-recovery/physical-reboot.json)。同开机演练与其失败历史仍单列，不改写成真实重启证据。
5. 公开测试入口已绕开占用限制：在已授权隔离测试主机只运行任务自有临时 tunnel 子进程，转发独立网关；免费、无账户、不修改 DNS、防火墙或系统代理，不安装常驻服务。官方二进制核对 GitHub release digest；关闭测试进程后入口失效。此结果不部署生产，生产登记/中继上线由用户最后审核。[Cloudflare 官方临时入口说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。
6. 已生成并运行独立原生测试壳，逐项隔离固定端口、单实例标识、Node数据、导出、日志、WebView2和扩展设置；原生启动参数、单实例转发、运行副本切换和两次真实补丁脚本更新已经通过。系统默认文件关联双击19轮handoff均未通过，新增轮次按过期、guard、工具错误和有效错路由分别登记；早期最长30秒且守护恢复，后续仅明确opt-in的隔离探针最多90秒并以真实到期时间截止，没有改UserChoice或安装运行代码。独占桌面仍启动原安装版，须核查实际Shell路由，不能继续盲目重复启动。不能把启动参数或调用后端算作真实默认关联双击。桌面产品约定的默认关联是`.proc`，不把`.procp`的编辑器支持扩大为既有系统关联承诺。
7. 笔记本普通流编码、W7的加载/闲置/长任务、C6.6权威重测以及C10全项真实双机均已通过；来源、完整回执和历史失败见REPORT-collaboration-reopen-laptop-validation.md。C6.6/C10原判据未放宽。系统默认双击未通过，完整条件尚未满足，本分支未合入main。
8. t6nM3X 的单次 damaged 来源仍未确定。已经区分 API/浏览器诊断，并修复独立可复现的暂时存储分类错误，但缺少该次请求的来源证据；后续三次完整探针和 160 次原隔离记录只读读取通过都不是原因证明。若再次发生，按新诊断定位。
9. 搬迁传输包含整个房间目录及所有已完成入库素材，并检查当前项目的明确引用；尚未穷举全部历史操作的语义素材引用，也没有把部分入库中的素材当完成件。这是完整性预检的范围限制，不声称可以补回源服务原本缺失的历史素材。
10. 用户已授权验证成功后合并main、构建并覆盖原安装包；所有必要门槛尚未通过。已经只读定位主仓库`desktop/release/`中与当前应用0.7.14匹配的最新原安装包；绝对位置只写忽略的本机记录。保留审核worktree和待办，满足条件后再备份原包、执行版本更新、合并及发版构建；本次网页构建只用于验证，没有覆盖安装包或用户运行代码。
11. 2026-10-05 用户改定：系统默认双击改在笔记本真实安装候选包后验收，见上文「2026-10-05 接手与路线改定」和卡点 10 第 13 行；第 6 条里 PC 临时改写关联的做法不再继续。上一条的合入、发版与覆盖安装包授权不再沿用，到那一步由用户另行授权。
12. 2026-10-05 结果：系统默认双击与完整安装包的真实安装都已通过，第 6 条的缺口关闭。没达成的一项：笔记本上带耗时门槛的流编码探针没过线，见卡点 11。仍需用户决定或授权的事：合入 main；改版本号、发版构建、覆盖安装包；部署生产托管服务的登记与中继接口；在笔记本的普通终端里运行还原，或决定保留候选版；让笔记本亮屏约 10 分钟以便正式重测计时项。
13. main 在本轮期间前进了：origin/main 从 `adc3ae2a` 到 `f951553c`，12 个提交，是别的工作合入的测试启动脚本（`npm test` 改由 `scripts/test-suite.mjs` 启动）和文档草稿，不涉及渲染与编码。本分支仍基于 `adc3ae2a`，上面的基线都是在分支自己的提交上跑的。把现在的 main 合进本分支只有一处冲突：`server/test/bakery-deps.test.mjs` 的守门名单，两边各加了条目。合入前要先合 main、解这一处冲突，再把基线重跑一遍。
14. 2026-10-06 补记。`05ab07c6` 上把类型检查、全量测试和 G0-R 在 PC 上能跑的各项整组重跑了一遍，全过，数字见上文基线表。origin/main 仍是 `f951553c`；用 `git merge-tree` 预演把它合进本分支（不动任何引用和工作区），仍然只有 `server/test/bakery-deps.test.mjs` 一处冲突，`docs/plan/TODO.md` 能自动合并。主工作区（main，`a1b4b626`，比 origin/main 少 1 个提交）里有两处没提交的内容：`docs/semantics/guide_files/verification.md` 的改动，和没跟踪的 `docs/plan/collaboration-reopen-recovery-plan.md`。这两份与本分支里的同名文件逐字节相同，内容不会丢，但合并时会挡路，要先让开。计时项补了两条只读核对，见卡点 11 第 6、7 行和读数记录：被计时的代码自 2026-09-28 修复以来没有变过；笔记本接着电源、没发现省电或降频设置。计时项仍是没达成，正式重测仍等用户在机器旁。
15. 2026-10-06 计时项。用户在笔记本旁、屏保不在时的正式重测没过（分支 364 ms，main 376 ms）；随后查明当时笔记本处在限频状态；状态恢复后按事先定死的规程再做一轮正式测量，分支 `a88f4eed` 退出 0、p50 268 ms，记为通过，三次正式测量并排保留。第 12 条里「让笔记本亮屏约 10 分钟以便正式重测」这一件已经做完。留给用户的事：认不认可这个判定；这条门槛在 main 上要不要另开任务处理（同一轮里 main 量出过 341 ms，余量很薄）；要不要把「同时记录重负载下的频率读数，低于 100% 的那一次不作数」写进 `verification.md`。经过、读数和顾问调用记录见卡点 11。类型检查、全量测试和 G0-R 在 PC 上能跑的各项在 `a88f4eed` 上又整组跑了一遍，全过。

最终证据审计退出 0：60 份 JSON、124,690 个字段、207 个修改文件，所有报告链接和清单文件存在；审计实际核对105份基线/构建原日志摘要，另1份历史构建原日志被本次可变路径覆盖，明确不可再核验。已检查发布的截图，没有密码、派生 K、登记能力、邀请码或会话秘密。verification.json 保留 16f93bb0/4bd3087f 的原始历史来源，本轮最新基线、构建与全长渲染来源分别见 integration-verification.json；不将历史抽样改写成最新全长结果。纯报告/证据提交不改变产品代码，不重复无变化的检查。

本次没有改产品桌面Rust壳、浏览器、ffmpeg或内置Python；只复制资源并在临时Rust测试副本中做上述隔离变换。没有发版、安装或覆盖用户运行代码。Node服务读取的稳定数据目录及旧数据迁移已在隔离环境验证；真实补丁脚本及提交的NSIS补丁外层在两类隔离身份上均通过，完整setup安装包未跑，系统默认双击尚未通过。main与release未前进；误启动原安装版的八次经过已单列，不能宣称其启动写入不存在。本次网页及隔离调试壳构建成功不能替代合入后应执行的集成或桌面发版构建。

可复跑命令：

Windows 复跑下列 Node 命令时，在 `node` 后附加 `--import=./scripts/lib/test-silent-processes.mjs`，沿用本轮已验证的静默预加载入口；各探针仍须用独立目录、测试服务及必要的测试配置。实际本轮完整参数和来源记录在 integration-verification.json。

```text
node scripts/probes/reopen-baseline.mjs --render
node scripts/probes/reopen-e2e.mjs --restricted --nodes --password-change --roles
node scripts/probes/reopen-e2e.mjs --nodes --roles --delete-from-second --delete-offline
node scripts/probes/reopen-e2e.mjs --hosted --restricted --nodes --password-change --roles
node scripts/probes/reopen-e2e.mjs --hosted --nodes --password-change --roles
node scripts/probes/reopen-online.mjs
node scripts/probes/reopen-online.mjs --restricted
node scripts/probes/reopen-e2e.mjs --wan --nodes
node scripts/probes/reopen-e2e.mjs --matrix --nodes --trust
node scripts/probes/reopen-e2e.mjs --restricted --matrix --nodes --trust --password-change
node scripts/probes/reopen-e2e.mjs --hosted --matrix --nodes --trust --password-change --roles
node scripts/probes/reopen-e2e.mjs --exit-matrix --cancel-ui --restricted --nodes --roles
node scripts/probes/reopen-e2e.mjs --hosted --exit-matrix --cancel-ui --nodes --roles
node scripts/probes/reopen-e2e.mjs --hosted --move-lan --nodes
node scripts/probes/reopen-e2e.mjs --restricted --move-hosted --move-lan --nodes
node --test server/test/reopen-relocation*.test.mjs
node scripts/probes/reopen-native-fixture.mjs --build
node scripts/probes/reopen-native.mjs <生成的fixture.json>
```

WAN 仅在环境变量提供已授权测试主机与密钥路径时运行，不将账号、地址或密钥路径写入报告。可选 `PC_REOPEN_PUBLIC_TUNNEL_BIN` 指向该主机独立临时目录里的已核对 cloudflared 二进制。没有公开入口时明确输出 `publicHttp:false`，不能转写为公开验证通过。临时公网工具仅用于测试，不是产品运行依赖。
