# 多人协作重开恢复：实现与验收报告

日期：2026-10-05（保留2026-10-04及此前实际来源）。对应完整授权计划：[collaboration-reopen-recovery-plan.md](../plan/collaboration-reopen-recovery-plan.md)。

## 交付状态

本报告交付专用审核分支中的代码、契约、迁移措施、可复跑探针和实际证据。**尚不宣布完整目标达成**：隔离服务及跨设备公开 HTTPS/WS 链路已验证两项核心行为，受控电脑重启也已真实通过；系统默认 .proc 双击16轮handoff均无匹配测试壳回执。七轮早期记录之外，后续七轮有一轮过期点击、三轮时限保护、一轮几何错误、两轮有效窗口内的错路由；工具阻断不冒称路由实测，有效错路由也不能只归因于用户操作。笔记本普通流、W7、C6.6 两方向及 C10 正式双机复核已通过；一次偶发损坏提示的当时错误来源也未能确定，不能用后续复跑通过抵消它。矩阵中的“部分验证”与“未测”不计为整条通过。公开测试使用短时隔离入口，生产部署仍须用户审核。

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
| 验证 | 新增 `scripts/probes/reopen-{capabilities,baseline,e2e,exit-matrix,wan,wan-peer,online,reboot,native,native-fixture}.mjs`；新增恢复、格式、权限和竞态测试，修正现有隔离测试的目录、环境和压缩夹具。 |

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
| 类型与全量 | 最新实际基线 1ec99174139a3375270bb4edd046506c1ccb7b8c：类型退出0、5418 ms；全量4330/4330，失败/取消/跳过/todo均0，55947.5101 ms，进程墙钟56011 ms。实际 Node 参数对应 npx tsc -b --force 和 npm test；准确命令/原日志摘要见 native-final-baselines.json。faa38f73首轮4329通过/1失败也单独保留。此前各轮与 aba 的4330/4330保留历史，不改写来源。 |
| 桌面独立测试 | aba4c1f9 实际 node --test desktop/test/*.test.mjs（等价 npm test --prefix desktop）退出0；37/37、失败/取消/跳过/todo均0，847.1371 ms（墙钟885 ms）。仅在隔离临时目录用 -WhatIf，未覆盖运行副本。 |
| 网页构建 | b09885db74fa13091b9e3bf59969a0adeb2b1663 已提交后实际 npm run build 退出0、7821 ms、1830模块；独立原日志 SHA f030ac3fdf8857cecd8d3367413613933261941156419c3c718b0badc1ef3e34，见 native-final-baselines.json。463b085b历史0/6800ms仍保留，但原始可变日志被本次构建覆盖，明确标不可再核验；不是通过复核的新证据。aba 的0/6290 ms及113的0/6762 ms与其它历史构建保留。没有发版、安装或覆盖安装包。 |
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

全长 renderer 证据保留 c70b277f 来源。c70b277f 到 d62cd2c3 的产品源码未变；8beb0622 随联动验收修复素材补交等待小尺寸的服务端路径，99859d06 修正在线浏览器验收夹具，e817f7ca 只修桌面测试夹具的启动参数。renderer、decoder、卡片、desktop 产品代码、package 与 vite 源文件仍未变，不把旧渲染证据冒称新 HEAD 的重跑。本轮笔记本正式复核已完成；系统默认文件关联双击16轮handoff尚未通过，不能宣布完整验收全绿或执行条件式 main 合入、发版及安装包覆盖。

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

两位独立Gemini 3.1 Pro High只读顾问完成两轮，冻结权限、无工具调用，完整公开回答已由根Agent读取；会话、实际退出码及累计元数据见上述handoff证据。关于“没有发送通知”的推测被实际代码否定，不采用。30秒最大租约和匹配回执标准保留；主机/成员与已运行窗口的系统双击仍须实际通过。依据解法表规则，已安排Codex max独立只读攻坚，检查执行身份、注册表视图和Shell关联候选；未给它真实关联写入或UI权限。最新构建及根目录基线全绿不能补足这个缺口。

后续七轮全部保留真实退出1，不与前七轮混写原因：run-meGijX的安装版创建16:09:47.784992Z晚于恢复16:09:46.913Z，不能证明新目录候选无效；naCa2u/nQZmzc/48o2lc被即时检查挡住过期点击或导航，没有继续盲点；LX9flc返回`coordinate input geometry is unavailable`，点击结果按未知记录，未观察到匹配误启动；这些均是未完成，不计路由通过。run-dBtkun在旧命令租约下先确认本轮fresh BHID匹配测试壳，armed16:22:39.732Z后才进入新目录，截图/条目确认16:22:41.860Z，真实双击16:22:58.840Z仍启动安装版52696（16:22:59.202969Z），恢复16:23:05.968Z。它实际削弱了“提前枚举目录”这个窄解释。

只关闭本会话创建的Explorer窗口后，它所属50380进程自然退出，用户Shell11120保留；没有主动终止Explorer。随后本会话新建目录进程3388（16:27:20.930806Z，注意早于租约）再试：run-fBmwWR的fresh BHID匹配，armed16:32:43.692Z，观察16:32:45.756Z，截图坐标双击16:33:04.647Z，安装版4056创建16:33:04.904332Z，恢复16:33:09.719Z。这是新的Explorer进程仍错路由的实测，不能扩大成“进程是在租约后创建”的证据。新增误启动46384/52696/4056均核验精确身份后清理，每个各两名直接子进程；共七次的普通启动写入风险保持披露。最后任务目录窗口已关闭，所有短时关联watchdog退出0，完整主机/成员双击及OS已有窗口转发仍未通过。

Codex max攻坚全文及各只读命令已由根Agent审阅，摘要在handoff JSON。相同用户/认证/session/中等权限和一致32/64视图排除了简单上下文错位；原ProgID没有DDE/Delegate/DropTarget等替代字段，但未扫描全注册表、未证明Explorer所有线程从不模拟身份。GetShortPathName把owned文件变成ORIGIN~1.PRO，.pro查询与FindExecutable的Qt Creator字符串精确相等，闭合了旧接口差异，不能再用它当.proc默认执行验证器。[Microsoft对FindExecutable长扩展名行为的说明](https://devblogs.microsoft.com/oldnewthing/20160408-00/?p=93274/)。关联通知flush只保证通知送达，没有保证执行对象重建；缓存仍未定位。[SHChangeNotify契约](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shchangenotify)。三级候选尚未全部穷尽，不解锁缩减验收的二级方案。

补做0/8/16/24秒无UI租约采样，实际退出0，来源b09885db。armed16:52:03.739Z，expires16:52:33.405Z，四次直接读值相对arm为147/8148/16144/24149ms；HKCU/HKCR的32/64视图16项全部精确匹配测试command，savedOriginal匹配全部false。每次fresh recommended枚举正好一个条目且GetName匹配测试壳；16:52:28.848Z恢复完毕、watchdog0，恢复后四视图及推荐条目均回原值。该轮没有UI、原生应用或服务启动，只排除本窗口内持续提前恢复；采样间短暂变化、真实点击引发的变化及旧轮点击前一瞬仍未证明。两轮fresh BHID结束到点击分别隔18.668/20.509秒，原“before click”不改写为即时读值。测试壳已经叫promptcut-recovery-test.exe，安装版叫promptcut.exe，不采用无事实前提的“同名冲突改名”。推荐对象也不是实际Explorer默认执行证明。结果及原日志摘要见native-os-handoff.json的temporalQueries；一次性辅助代码仍在忽略目录，未冒称已提交产品探针。

笔记本任务“核实项目与协作通道”的只读预检已实际返回0，由根Agent通过read_thread取得完整report投影，见 [native-laptop-preflight.json](assets/collaboration-reopen-recovery/native-laptop-preflight.json)。笔记本main为6c8b8cbb、验收WT为aba4c1f9且均干净；目标b09885db/1ec99174对象本机缺失，不能当新版源码已验。未发现现成Sandbox或独立Windows VM；.proc有效查询仍是安装版、无UserChoice；编译工具已在但本轮没有构建/启动fixture。ComputerUse保持停用，未改系统或真实关联。五件远端文件摘要由对端报告，未将其冒称本机文件独立哈希复核；初始参数转义及literal glob错误也独立保留。根Agent已通过直接工具确认接收，未要求对端绕过缺失的发送接口。

以上笔记本预检是初始快照。随后在忽略目录另建source-5998/checkout（codex/native-laptop-fixture-preparation），由单分支bundle取得完整5998b9fd，verify/fetch/fsck均0。初始离线metadata缺android_system_properties 0.1.6，退出101、未开始构建；从根Agent隔离fixture和既有Cargo缓存仅交接公开chrome/ffmpeg/python、锁文件匹配的511份crate及索引，不带应用、身份、项目或全局Cargo配置。资源包628337069字节，SHA-256为698d72516d311e3fb94cae57a553d704c5f161fcb722331db3f043c9bad41420；下载0/7722ms，4940份文件、manifest、Cargo.lock核验0/24875ms，missing/extra均空。首次解压WinError206/退出1保留，改在新目录以扩展长度路径提取后通过，未改系统LongPaths设置。

默认GNU工具链首次构建因缺dlltool.exe而退出1/25484ms，失败回执和日志保留。以子进程RUSTUP_TOOLCHAIN选择已装MSVC、独立CARGO_HOME及离线环境后，cargo metadata --locked --offline --format-version 1实际0/979ms；提交的fixture生成器 --build --standalone-launch实际0/114827ms，FeMRuw测试壳loader校验通过。EXE摘要cbd0ce55e7d8c5a8f10effeefd6debbc0cf5ceccaffd064068c33df88d8903ad，远端证据manifest摘要c356721c5ef5001025a0ef8b748127fffed688b047bf494a7ef6c8ffd349aae4。main仍6c8b8cbb、旧验收WT仍aba4c1f9、新checkout5998b9fd，三处tracked干净、默认GNU工具链未变；未启动产品/服务/浏览器/安装器、未改关联，ComputerUse保持停用。根Agent完整读回远端实际命令输出，但未另下载并独立哈希远端证据文件；本机资源包摘要已复核，两台临时交接服务均关闭。新增投影见native-laptop-preflight.json的sourcePreparation，编译不计系统双击或恢复通过。

台式机补做一次无租约、无导航、无文件点击的UI时序预演，source5998b9fd：自有Explorer50936创建17:14:19.745846Z，激活后的可信截图在参考时刻后23915ms，导航前检查65693ms，随后关闭自有窗口，进程自然退出，保留用户Shell11120。没有关联变化、产品或服务启动。这一轮没有证明整个after-arm路径能可靠在25秒回执窗内完成，也不证明所有优化路径都不能完成；不扩大为默认双击产品失败。结果在native-os-handoff.json的safeTimingRehearsal。用户随后明确默认双击在台式机实测即可，不再要求笔记本跑这个非性能项目；既有笔记本性能基线保持实际来源。

台式机快速补验又保留两轮实际退出1：run-wKJQ47于17:50:25.647Z arm后，由ComputerUse新建Explorer45208（17:50:25.812139Z），确实补到after-arm进程创建；但导航未完成，17:50:55.076Z时限检查挡住文件输入，没有双击、没有误启动，不能计产品路由失败或通过。run-iCv3sk先实际显示original-host文件，17:54:59.792Z arm，F5后观察17:55:00.185Z，17:55:11.725Z真实坐标双击；原安装版53240创建17:55:11.961963Z，17:55:25.800Z关联恢复，watchdog0，无匹配测试壳回执。这次11.933秒内的真实动作仍错路由，不能把快速操作或台式机替代笔记本本身视为通过。核验exe、创建时间及精确测试文件参数后，仅清理53240及两名直接子进程；累计误启动安装版八次，普通启动/草稿写入仍不声称未发生。测试壳二进制保留实际e2552d07来源，harness5998b9fd只含后续测试/报告修改；没有把旧二进制冒称新编译。主机首个OS handoff失败，成员及OS已有窗口转发未执行。证据见native-os-handoff.json的desktopQuickAttempts。

第16轮后的只读核验两次实际退出0：.proc真实ProgID含一个空格，为PromptCut Project；HKCU/HKCR 32/64和fresh GetKey均选这个class，lease路径正确。真正NULL默认verb与显式open的COMMAND/EXE/PROGID及GetKey相同且S_OK；shell默认值为open，唯一定义verb也是open。空字符串查询COMMAND/EXE返回0x80070483，不能当作另一个默认动作。Applications中promptcut.exe和promptcut-recovery-test.exe根在HKCU/HKLM/HKCR的32/64视图均不存在，不凭不存在的路径提出替代修法。根Agent读完两份完整只读快照与实际命令记录，摘要及原文件SHA见handoff JSON的attack.currentRoutingVerification。它们是恢复态读数，不是点击一瞬；连续UI关联采样仍未执行，缓存唯一因果未证明。

## 第 11 节逐项验收

“通过”仅指该行写明的实际层级；“部分验证”表示规定场景仍有明确缺口，不计为整条通过。

| # | 场景 | 结果、证据与未覆盖部分 |
|---|---|---|
| 1 | 原主机关闭应用后重开 | **通过（隔离服务及真实公开链路）**。四组合保持房间/原账户；本机主机重新登记，跨设备公开入口成员实际双向编辑、带票据读素材。生产部署未执行。 |
| 2 | 主机进程重启及电脑重启 | **通过（真实操作系统重启）**。2026-10-04 用户重启后，启动标识与原检查点不同；默认探针未带 `--allow-same-boot`，退出 0。主机/成员新进程、空浏览器、稳定 DPAPI 记录恢复同房间，原 creator/member 角色、云端登记 online；双方编辑读回、版本 12→14、零建房，三类带票据素材各 50k、200/哈希一致。见 [physical-reboot.json](assets/collaboration-reopen-recovery/physical-reboot.json)。已有原生副本切换证据另保留。 |
| 3 | 原成员关闭应用后重开 | **通过**。四组合成员新进程读设备凭证恢复原用户名/权限；远端成员两个新进程亦恢复。 |
| 4 | 成员先打开、主机后打开 | **通过**。LAN 两模式先等待，原主机上线自动加入；主机/成员各改后另一端读回。 |
| 5 | 自由/限定、本机/云端 | **通过**。四组合独立专用房间；云端位置保持 hosted；第二创建者无本机主机绑定。 |
| 6 | proc/procp/草稿/系统双击/刷新 | **部分验证**。proc、真实打包/解包、草稿、真实 open-path 后端及页面刷新通过；独立 Windows 原生壳启动参数 `?open`、已运行窗口实际 `pc-open-file` 事件转发与打开通过，原文件未改。系统默认文件关联16轮handoff均无匹配回执；新增一轮过期点击、三轮时间保护、一轮几何错误均未完成，两轮有效窗口的真实动作仍走安装版。前七轮的通知flush/目录刷新及独立类型也未通过。后台采样与参数/IPC通过均不替代OS动作。关联均恢复，主机/成员默认双击及OS已有窗口转发仍未通过。见native-os-handoff.json。纯在线不新增文件入口。 |
| 7 | 主机离线打开后恢复网络 | **通过（应用层故障注入）**。云端测试进程实际停止，原主机本机修改；云端进程返回后自动登记，成员加入、编辑和带票据读素材。宿主网络未改。 |
| 8 | 地址、端口、运行副本变化 | **通过（服务、独立原生运行副本及真实补丁脚本更新）**。端口变化、稳定路径/设备记录、旧目录迁移与不覆盖新数据测试通过；实际copy-A切换copy-B后新PID、空WebView2恢复。新增主机/普通成员两次真实apply-patch.ps1更新2044文件，保护状态与外壳字节不变，重开后同设备/房间/角色、成员等待加入、4次双向编辑及三类带票据素材均通过。见native-upgrade.json。应用版本未递增；NSIS外层和最终完整安装包未运行，不扩大该范围。 |
| 9 | 无公网直连且外网成员 | **通过（真实公开中继）**。成员在另一机器，经独立临时公开 HTTPS/WS 入口与隔离网关双向编辑、两次凭证重入和三类票据素材读取。SSH 链路结果另存，未混为公开入口证据。IPv6 直连和打洞未实现/未测，按计划 §6 仅交付实际必需可达路径。 |
| 10 | 主机/成员带旧快照重入 | **通过**。四组合旧文件不覆盖最新编辑，版本 5/6/9 连续；DocSync 单测零根替换、服务最新状态优先。 |
| 11 | 离线修改与远端冲突 | **通过（单元及桌面实际交互）**。持久未确认队列后停止成员进程，空浏览器重入旧文件，远端冲突使同步暂停；真实点击重放后主机读回，另一轮丢弃后原离线项目及操作实际保存于备份 API。`reopenRecovery.test.mjs` 保留 expectRev 及身份读取期间新旧操作合并。 |
| 12 | 密码、名单、踢人、禁入 | **通过（真实服务和桌面界面）**。自由/限定中继旧凭证 401、禁入 403、代数失效旧票据；创建者实时改密码后重连，真实界面踢出/解禁、自由模式改项目密码及限定模式移除名单。旧文件不越权，凭证更新后要求真实重新认证。 |
| 13 | 邀请过期/作废 | **现有邀请服务及桌面恢复通过；匿名 LAN 云端邀约流程未交付**。本机及云端自由模式真实正常 SDK 兑换并首次加入，保存文件及设备身份；作废旧码与十秒过期旧码均 404，实际停止成员进程后空浏览器读旧文件仍恢复原身份。见 `matrix-free.json`、`matrix-hosted-free.json`。新网关只覆盖已取得有效身份的恢复，不声称匿名邀请校验/兑换的公网流程完整。 |
| 14 | 多窗口、重复打开、第二设备 | **通过（实际窗口及服务冲突）**。两独立浏览器窗口同时读旧文件，同身份同房间，分别修改后另一窗口和主机读回；重复打开零建房。二十身份双进程合并、同服务多身份、不同活动实例/第二设备拒绝主机占用；创建者第二设备真实连接，无主机私有绑定。 |
| 15 | 恢复中换项目/首页/取消 | **通过（单元及实际桌面界面）**。单元覆盖四阶段迟到结果、重试定时器和节点迟到票据；实际延迟身份请求后换项目通过。本机限定逐项延迟身份读取、主机恢复、发现和接入登记的真实成功回复，再点实际首页，迟到回复不恢复旧连接，刷新仍留首页，Agent/card/render 清旧绑定且本机主机登记撤销。云端自由的两个实际网络阶段同样通过；本机主机恢复及 LAN 发现对云端不适用。未确认身份时取消房间控件禁用；确认创建者后两种位置的实际协作开关取消均成功。见两份 exit 证据；不声称所有模式与阶段的笛卡尔积都逐一实跑。 |
| 16 | 保存/恢复崩溃、磁盘满 | **通过（实际子进程退出与故障注入）**。加密临时记录已写完刷盘、替换前子进程退出码 31，旧原记录逐字节不变、退出锁回收后重试成功；临时文件写入 16 字节后 ENOSPC，原文件不变且重试成功。桌面离线队列跨进程保留，跨进程写入合并。没有对宿主机造成断电或填满真实盘。 |
| 17 | 篡改角色/地址/房间 | **通过（单元及真实桌面恶意关联）**。文件伪造 creator/用户名/as 后仍是普通成员；服务改为隔离恶意收集器后 needs-auth，收集器 HTTP 请求数为 0；换房间 ID 需认证，原文件再打开恢复正确身份。格式拒绝非法 URL/路径，房间作用域和禁止重定向另有单测。 |
| 18 | 清空凭证、新设备打开 | **通过（独立测试设备）**。无记录明确 needs-auth，一次真实认证 UI 后持久保存；后续新进程/空浏览器自动恢复。没有清用户的真实凭证。 |
| 19 | 删除/取消后打开旧文件 | **通过**。原主机及第二创建者两条删除路径，成员离线期间删除亦终止。另在本机限定和云端自由实际关闭协作开关并确认：保留服务端最新内容，返回本地，保存文件无房间关联；旧主机文件为 deleted，云端挑战 410，零自动建房，旧节点绑定撤销。 |
| 20 | 搬迁成功/中断后重开 | **通过（隔离 HTTP、故障注入及实际设置页）**。本机到云端、原生云端到本机及完整往返保持房间/身份/版本；HTTP 两个方向均在部分传输后实际停止两端，再凭同事务续传、成员双向编辑与三类 50k 素材；准备/安装故障、删除及旧登记能力拒绝另有测试。实际设置页搬到云端和云端重启见 [relocation-hosted-ui.json](assets/collaboration-reopen-recovery/relocation-hosted-ui.json)；原生云端搬回、旧 hosted 文件恢复目标主机及目标重启见 [relocation-lan-free-nodes.json](assets/collaboration-reopen-recovery/relocation-lan-free-nodes.json)。搬迁新增公开 WAN、原生壳动作及所有故障组合未逐一实跑，不扩大此层级。 |
| 21 | 旧关联迁移/未知版本 | **通过（桌面及格式/存储）**。真实旧 sessionStorage 身份精确匹配后迁入保护存储，原浏览器记录变 device-vault；旧 localStorage 密码查看记录可靠迁入 settings 后才删除，并在真实密码查看 UI 中以布尔比较核对原值，未输出秘密。空浏览器和新进程可自动恢复。真实未知 v2 提示不支持、再次序列化完整保留；已有新状态不覆盖、旧目录保留，无关联旧文件不按名绑定。 |
| 22 | 主机数据缺失/损坏 | **通过（实际桌面故障提示）**。停止原主机测试进程、暂移 ops 日志，重开显示 damaged，缺失文件不被初始化；恢复日志后原房间可连。另一次停止成员进程后写入损坏保护记录，界面 damaged，损坏字节不被覆写，恢复原测试备份后可连。未从不可信快照导入权限或生成房间。 |
| 23 | Agent/渲染节点/素材 | **通过（恢复、搬回及删除链路）**。实际自动节点启动，主机/成员 Agent 与 render 认证同房间，card 绑定正确；media/snap/px 读回和哈希通过，删除清旧绑定；8 项节点竞态及真实中继 RST 会话接续通过。搬回并真实重启目标后两侧节点认证见 `relocation-lan-free-nodes.json`；专门注入首次重试取票失败后仍自动恢复，相关网关/会话 25 项全部通过（10,975.3284 毫秒）。全渲染任务调度及所有故障组合未扩成无关探针。 |

补交上传的联动复跑先在 d62cd2c3 失败（sokEgk，退出 1，90,890 ms）。日志证实 afterImport 的按哈希补交先把仅有原尺寸的素材入队，小尺寸随后才由转码管理器入队，违背已有 mechanism/asset-service.md 的先小后大规则；另有观察端自动渲染节点参与，使两节点统计失配。8beb0622 修复服务端补交：转码 pending 时回 deferred，由持久两档管理器完成后入队；ready 时页面未写回的小尺寸从本机登记补上，failed/none/unknown 仍按原规则传原尺寸。API 只增可选 deferred 数组，文件版本不改；明确缺失仍报告。探针设置 AUTO_RENDER_NODE=0 隔离观察端，产品的成员自动节点行为仍由重开/搬迁探针验证。旧失败不抵消，RaCK22 的新来源及通过范围单列。

## 失败、跳过与未测记录

失败运行保留而不抵消为通过。初始两项缺环境跳过独列；最终全量跳过 0。未测场景见矩阵和待用户条件。存储偶发失败及独立分类修复的非秘密取证摘要见 [storage-failure-audit.json](assets/collaboration-reopen-recovery/storage-failure-audit.json)。

| 实际问题/失败 | 处置与证据 |
|---|---|
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

尺子：`node --import=./scripts/lib/test-silent-processes.mjs scripts/probes/reopen-native.mjs <owned fixture.json> --os-double-click --allow-temporary-open-command`，或另用`--isolated-default-progid --allow-temporary-default-progid`的明确模式；主机及追加`--member`两角色均须取得本次nonce的匹配原生回执，随后实际恢复、单实例转发、双向编辑及票据素材读取退出0。当前16轮handoff均退出1，工具/时限未完成不冒称路由实测；原生参数/IPC的通过不能替代该尺子。物理桌面由用户明确空闲安排，不结束用户Shell，不改受保护选择。

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 控制文件移出显示目录、独占桌面 | 消除行重排及并发输入 | 2 | 1 | 3 | 463b085b第5轮 | 关闭·无改善 | 正确文件仍启动安装版，不能只怪用户操作 |
| 2 | 2 | 三级 | 1 | 关联通知flush、armed后F5 | 等通知送达后重取目录条目 | 2 | 1 | 3 | faa38f73第6轮 | 关闭·无改善 | 仍走安装版；已有通知，不能采用“未通知”解释 |
| 3 | 3 | 三级 | 2 | 唯一owned ProgID临时默认值 | 避开复用旧ProgID | 3 | 1 | 4 | 1ec99174第7轮 | 关闭·无改善 | 入口和测试树恢复；后台四视图值虽变，Shell有效默认仍为原类型，不能称有效handler已切换 |
| 4 | 4 | 三级 | 3 | 执行身份/视图/候选key只读取证 | 区分用户上下文、视图及Shell选择来源 | 2 | 1 | 3 | Codex max独立攻坚、后台API | 已试·部分 | 同用户/同登录/中等权限、32/64摘要一致；新Shell文件对象在旧命令租约内选测试壳。FindExecutable另选qtcreator，不把它当Explorer调用来源。没有给顾问真实关联写入或UI授权 |
| 5 | 4 | 三级 | 3 | 新的测试Shell进程在租约后创建并枚举 | 区分创建前已有的进程状态 | 3 | 2 | 5 | wKJQ47部分执行 | 已试·部分 | 新45208确实在arm后创建，但导航未完成且guard阻止文件输入，未完成有效双击，本候选仍开放；不提高TTL |
| 6 | 4 | 二级 | — | 改用参数启动或延后默认双击 | 移动门槛而未消掉失败 | 1 | 5 | 6 | — | 锁住 | 三级未穷尽，不能缩减完整终点或把本行判通过 |
| 7 | 5 | 三级 | 4 | 租约生效后才导航到新测试目录 | 避免关联生效前已枚举的目录对象 | 2 | 2 | 4 | dBtkun有效点击 | 关闭·无改善 | 新目录在arm后观察，真实双击仍启动安装版；只关闭“提前枚举该目录”的窄解释 |
| 8 | 6 | 三级 | 7 | 新建任务Explorer进程再进入新目录 | 区分前一目录进程残留 | 2 | 2 | 4 | fBmwWR有效坐标双击 | 关闭·无改善 | 3388新进程仍走安装版；它在arm前创建，不关闭第5行 |
| 9 | 7 | 三级 | 4 | 0/8/16/24秒无UI租约直接值及推荐对象 | 查持续提前恢复或推荐对象固守旧身份 | 2 | 1 | 3 | association-delay-7gMv3m退出0 | 已试·部分 | 16项直接值和四次fresh推荐均测试壳，最后原值恢复；窄变化未复现，不代替点击时刻读数 |
| 10 | 8 | 三级 | 9 | 真实点击期间连续只读值与即时前后时间 | 区分UI触发覆写和执行对象分歧 | 2 | 2 | 4 | 尚未运行 | 开放 | 须先避免再次向用户安装版路由的启动写入风险；不因采样稳定就盲点或认定缓存根因 |

Gemini两轮公开回答和manager静态窄审已完整读取；其建议不是事实证据。窄审提出部分创建残留及清理未完误报0，修后六步故障注入、超时、持有者退出及外部新增值保护实际自测通过。保留注册表复查/删除非事务的并发边界；没有以多个模型同意代替实际OS双击。攻坚顾问最终结果后续按实际证据补记。

## 与计划的差异和仍需条件

1. 初始探针证实云端登记/中继缺失，已纳入实现，而非假定部署支持。新增可审核组合服务和部署文件清单，生产仍旧版本；没有在现有公开端口覆盖它。
2. 现有产品语义的匿名 LAN 邀请校验/兑换、IPv6 公网直连和打洞，比已加入身份重开的最小链路更广。本次新增中继交付已取得有效凭证的恢复，不把这些更广承诺标为完成。
3. 实际代码缺少项目级搬迁流程，但 `workflow/project.md` 已规定「搬到云端」「搬回本机」。据此落实已有语义，修正先前将其误列为计划 §6 排除新流程的解释。已实施两个方向的真实远程传输、设置入口、可信位置切换和中断恢复，原生云端搬回和限定本机完整往返实际界面通过；没有缩减为内部文件复制。新增契约见 [collaboration-relocation-contract.md](../plan/collaboration-relocation-contract.md)。
4. 受控电脑重启已于 2026-10-04 实测通过。用户重启前建立的 `pc-reopen-e2e-MH2SCg` 检查点与当前启动标识不同；按默认模式执行，退出 0。原房间 `sp_e2uowvu7stzt3esqfeh7v4aj63` 保持，creator:host/member:member 认证、成员先等待后自动加入、登记 online、双向编辑及三类带票据 50k 素材均通过，服务版本 12→14，零建房。源提交 `33d7106f`，见 [physical-reboot.json](assets/collaboration-reopen-recovery/physical-reboot.json)。同开机演练与其失败历史仍单列，不改写成真实重启证据。
5. 公开测试入口已绕开占用限制：在已授权隔离测试主机只运行任务自有临时 tunnel 子进程，转发独立网关；免费、无账户、不修改 DNS、防火墙或系统代理，不安装常驻服务。官方二进制核对 GitHub release digest；关闭测试进程后入口失效。此结果不部署生产，生产登记/中继上线由用户最后审核。[Cloudflare 官方临时入口说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。
6. 已生成并运行独立原生测试壳，逐项隔离固定端口、单实例标识、Node数据、导出、日志、WebView2和扩展设置；原生启动参数、单实例转发、运行副本切换和两次真实补丁脚本更新已经通过。系统默认文件关联双击16轮handoff均未通过，新增轮次按过期、guard、工具错误和有效错路由分别登记；最长30秒且守护恢复，没有改UserChoice或安装运行代码。独占桌面仍启动原安装版，须核查实际Shell路由，不能继续盲目重复启动。不能把启动参数或调用后端算作真实默认关联双击。桌面产品约定的默认关联是`.proc`，不把`.procp`的编辑器支持扩大为既有系统关联承诺。
7. 笔记本普通流编码、W7的加载/闲置/长任务、C6.6权威重测以及C10全项真实双机均已通过；来源、完整回执和历史失败见REPORT-collaboration-reopen-laptop-validation.md。C6.6/C10原判据未放宽。系统默认双击未通过，完整条件尚未满足，本分支未合入main。
8. t6nM3X 的单次 damaged 来源仍未确定。已经区分 API/浏览器诊断，并修复独立可复现的暂时存储分类错误，但缺少该次请求的来源证据；后续三次完整探针和 160 次原隔离记录只读读取通过都不是原因证明。若再次发生，按新诊断定位。
9. 搬迁传输包含整个房间目录及所有已完成入库素材，并检查当前项目的明确引用；尚未穷举全部历史操作的语义素材引用，也没有把部分入库中的素材当完成件。这是完整性预检的范围限制，不声称可以补回源服务原本缺失的历史素材。
10. 用户已授权验证成功后合并main、构建并覆盖原安装包；所有必要门槛尚未通过。已经只读定位主仓库`desktop/release/`中与当前应用0.7.14匹配的最新原安装包；绝对位置只写忽略的本机记录。保留审核worktree和待办，满足条件后再备份原包、执行版本更新、合并及发版构建；本次网页构建只用于验证，没有覆盖安装包或用户运行代码。

最终证据审计退出 0：57 份 JSON、118,119 个字段、203 个修改文件，所有报告链接和清单文件存在；审计实际核对93份基线/构建原日志摘要，另1份历史构建原日志被本次可变路径覆盖，明确不可再核验。已检查发布的截图，没有密码、派生 K、登记能力、邀请码或会话秘密。verification.json 保留 16f93bb0/4bd3087f 的原始历史来源，本轮最新基线、构建与全长渲染来源分别见 integration-verification.json；不将历史抽样改写成最新全长结果。纯报告/证据提交不改变产品代码，不重复无变化的检查。

本次没有改产品桌面Rust壳、浏览器、ffmpeg或内置Python；只复制资源并在临时Rust测试副本中做上述隔离变换。没有发版、安装或覆盖用户运行代码。Node服务读取的稳定数据目录及旧数据迁移已在隔离环境验证；真实补丁脚本更新在两类隔离身份上通过，NSIS外层未跑，系统默认双击尚未通过。main与release未前进；误启动原安装版的八次经过已单列，不能宣称其启动写入不存在。本次网页及隔离调试壳构建成功不能替代合入后应执行的集成或桌面发版构建。

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
