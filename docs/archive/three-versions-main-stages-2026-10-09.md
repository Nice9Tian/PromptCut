# 2026-10-09 小阶段交付与验证记录

## 首个后台基础模块阶段

基底 main e0e3afc37f04f51f0ea5e85eb9aa392183cf77c0。33 个源码/测试文件从共同候选 cbe8398dccffc84760ed8db734777ee0d88cd607 逐字收回，均为新增模块；未带入 B/G 在途实现，也未修改现有渲染、卡片、舞台或桌面代码。文档来自集成 b9b85722，用户最新主分支决定保留。

固定独立候选 f41c5ff94a33d93b28c2dea5a48b7c2da61a11a6，测试前后同源且 clean，native 自动重跑 0：

| 命令 | 结果 | 耗时 | 原始日志（系统临时目录） |
|---|---|---|---|
| node node_modules/typescript/bin/tsc -b --force | exit0，零错 | 4.844秒 | pc-passed-foundations-f41c5ff9-type.log |
| npm test | 4452项，4450通过、0失败、0取消、2跳过 | 54192.9515ms，墙54.515秒 | pc-passed-foundations-f41c5ff9-full.log |
| npm run build | exit0 | 墙6.890秒 | pc-passed-foundations-f41c5ff9-build.log |

两个跳过：未设置舞台服务的真实卡片布局集成；Windows文件权限不能证明POSIX权限。均不记通过。模块功能目标已实际在完整npm执行：SQLite账本与故障重启、同消息/实例上下文隔离、连续保留任务检查点、素材精确HTTP请求/防重放和真实TLS三角色连接、工作目录/额度/出网隔离；受控registry/sender/media callback的边界仍保留，不冒称生产中央或用户界面交付。此阶段没有改画面；整套历史探针按用户2026-10-09纠偏留到发版前。

## 当前普通档浏览器失败

共同候选cbe8398d的真实探针单次自然结束：exit1/ok:false，2失败、pending0，脚本200227ms/墙200.313秒，native0，源不变clean。用户卡真实源码put/get一致、两个舞台ready；实际成本step176.9ms、capped/重载，当前rev4计划含目标。失败是回读尚未确认文档服务接受同源新片段，未启动独立host。临时项目由本探针删除，6320～6329结束无监听。

原始证据：TMP pc-root-c10-assets-cbe8398d.log/.result.json/-out。开工前集成301c3092的独立对照已单次自然结束：3失败、pending0、1075771ms（墙1075.843秒），独立host原15分钟等待超时及后续两断言失败；源码不变clean，端口和本轮进程已退出。完整比较见[原普通档对照](ordinary-browser-before-work-2026-10-09.md)。这证明旧原探针也未全绿，不能证明两次失败同因或排除新回归。

## 素材异步关闭审查

固定e361受控真实consumer/资源关闭/物理I/O反例证三问题：admit落盘失败后关闭Promise未监督、pause等待admission时拒绝未处理、openRead初始化不在close屏障。第一fd疑点在真实run-resources下未成立，拒绝前fd=-1。首次counter/raw均保留TMP pc-assets-e361-*。

B修后a7d纯目标29/29、零失败取消跳过、393.3215ms，类型exit0/5.453秒；两轮正式首红6项5过1败及13项10过3败保留。新源未做共同/TLS，未收回main。

## 节点Python授权

三个元包3.10.6-1~22.04升3.10.6-1~22.04.1并补python3-venv，实际解释器与采集venv仍Python3.10.12。升级前后nginx/账号/托管PID、启动和重启计数一致，未动本机cuda_Vit。原始私有日志TMP promptcut-node-python-upgrade-5992910b56ab4ac98f0f36576215417b.log；没有凭据值。

## 第二个四阶段功能包

新main候选eba9cf3628733af6a0e9bbb93d6436cf64ee620b，在原已验证f9390dda上保留当前main的新增权限基础。唯一add/add客户端差异是新增verifyAcceptedMessage方法，原方法不变；其余新增基础模块与第一阶段相同。src/online、src/render、src/audio、src/store、server/bakery、frame router及c10-browser-probe与f939逐字相同，git diff为空。没有引入后续B/G传输/中央在途源。

本次候选首轮类型exit0/5.172秒；npm test 5065项/5063通过/0失败/0取消/2跳过，63857.0739ms（墙64.235秒）；build exit0/7.250秒。来源前后同eba9、clean，native自动重跑0。TMP pc-passed-four-stage-eba9cf36-{type,full,build}.log/.result.json。新增权限模块的对应功能测试本轮执行。

此前同画面模块真实c10浏览器输出ok:true，fails/pending=[]，独立主机claimed3/completed1、creator关闭后新层来自host，A5 45445ms，A4定位精确层6915ms，总220357ms，cleanup.listening=[]。原始TMP pc-root-c10-52ee07e2a3ae4dcc9191445cc4597280.log/-completion.json和同名前缀截图目录。该运行器固定018-core-verification，当时提交f9390dda。旧探针验证的是原标准用例，不能替代后来真实CPU用户卡强化用例；后者留分支继续。全历史验收只在发版前补完整一次。

## 工作区清理

PromptCut首批实际28个，另两份未合诊断先收回原报告并记录废弃临时菜单插桩，再清其工作区，共30个及30条本机分支。VisuHive旧后端与备份6个已在共同账号分支的提交祖先中，清6个和6条本机分支。每个清理前重核HEAD/完整status/ancestor/绝对父路径/全树reparse=0。未清main、用户旧六个、Antigravity和Documents/Codex其它会话。

准确名称和HEAD见系统TMP pc-worktree-cleanup-20261009-result.json（首28）与vh-worktree-cleanup-20261009-result.json（6）；另两份为018-instance-data-review、018-storage-ui-diagnostic。原证据报告均已进入docs/archive/agent-reports。清理用git worktree remove及git branch -d，未force、未跨壳递归删除。

第二阶段合并main edf61a025c29ea82cfda1e92c21ca99b1a394528并推送，集成cddd9e7e同步并推送。再核相同清理门槛后移除018-passed-four-stage及对应已合分支；PromptCut本轮最终31个、VisuHive6个，共37个。此时任务工作区8个（PC5、VH3）；不包含主工作区、用户旧六个和其它会话。应用/外壳未改版本号；按本任务第11节两次发版之间release留在上一完整版本，不推进到本次部分交付。

## 账号后端交付与最后收尾

VisuHive main合并43cfdf77520d099bc2160c5565bbba7b08d4e120并推送。独立候选d491d00adeeded81a810590c698086a430644996：32个.mjs语法零错（墙1.203秒）；npm test 76项、73通过、0失败、0取消、3POSIX跳过，6481.4458ms（墙6.703秒），源码不变且clean。原site逐字保留；新网站及其合同测试等待后端安装，源码兼容包装尚未部署。实际默认legacy/显式v2原网站协议、cookie保留、CSRF严格拒绝及数据库禁止降级均已在此轮真实HTTP/TLS目标执行；不冒称双账号项目界面走通。TMP vh-backend-main-d491d00-{syntax,full}.log/.result.json；详细原文在VisuHive docs/archive/account-backend-main-2026-10-09.md。

再清三份已收回工作区：PromptCut acceptance-main-baseline；VisuHive 018-account-backend-main、018-account-rollout。再次核完整status为空、HEAD已在各自main祖先中、绝对目录限定.worktrees、全树reparse为0，使用git worktree remove及branch -d。最后实际累计PromptCut32、VisuHive8，共40个；本任务剩6个（PC4、VH2）加用户原有集成four-stage。最后三份逐项证据TMP three-versions-final-worktree-cleanup-20261009.json。保留旧六个与两份其它会话工作区。

下一阶段优先真实双账号桌面与浏览器产品路径。账号UI和原生桥纯目标已过，真实壳、真实TLS入口及双方列表尚待主会话共同验证；素材新关闭修复、中央登记和强化浏览器失败继续留分支。只读模块与纯测试不能替代完整用户路径。

## 账号完整用户路径：共同候选首轮

e5e6e058独立类型零错（墙7.218秒）；五个目标文件22/22、零失败/取消/跳过，2077.1782ms（墙2.344秒），含真实素材mTLS和真实双账号/doc/独立素材子进程。TMP pc-account-path-prerequisites-e5e6e058-{type,target}.log/.result.json。

共同90832022类型零错（墙5.421秒），完整5300/5294通过/2失败/4跳过，75042.799ms（墙75.406秒）、native重跑0：服务端测试反向import scripts触犯原分层；在线产物新账号路径没有登记。修正组织位置并精确登记后，0c66feb1类型零错（墙6.281秒），完整5301/5295通过/2失败/4跳过，75165.4643ms（墙75.594秒）、native重跑0：旧棘轮基线未同步账号许可，guard另外两条精确session/renew字面量未登记。两次原日志不覆盖、不记通过，分别TMP pc-account-user-stage-{90832022,0c66feb1}-{type,full}.log/.result.json。后续只定位并补齐严格清单，不放宽scanner或旧本机接口限制。

908在线首次在Chrome前TypeError退出，2个真实fixture前置通过，没有实际UI；puppeteer.executablePath返回Promise，探针缺await，最小复现与修后真实文件可读独立通过。0c66在线构建exit0、墙1.922秒；实际Chrome路径首次63.010秒：登录及真实创建201、项目会话200，但连接项目失败，未入编辑器/舞台，未完成第二账号和网站列表。Chrome、自有stage/fixture子进程及全部socket实际关闭。TMP pc-account-online-first-{90832022,0c66feb1}-out/result.json；后者failure-1.png显示产品明确连接错误，不算路径通过。

原生壳隔离编译：固定de633源码cargo offline locked check exit0墙35.312秒、限定测试exit0墙38.407秒；修正实际Webview调用身份和退出失败逻辑后，固定908在TMP独立identifier编译exe。首次测试配置写错capability标识，build exit101墙1.782秒；只修TMP配置remote-sidecar后build exit0墙10.781秒，原源码未改。日志均在TMP pc-account-native-compile-oqemhch8内；编译不代表实际IPC、TLS或完整桌面路径通过。

VisuHive节点固定43cfdf77 Linux实际76/76、零失败/跳过、12576.99244ms；现有1个账号一致备份与隔离真实恢复通过后，已用legacy兼容安装，公网/本机HTTP 200、schema0/accountCount1/integrityok、不生成新密钥。恢复启动路径及旧/me断言的两次脚本失败均保留，未改源码来适配验证。安装详情和全部路径见VisuHive docs/archive/account-backend-main-2026-10-09.md；新网站、v2激活与自动备份尚未做。

已安装的账号后台共同分支018-active-run-order再核完整status空、HEAD在main、绝对目录限定、全树reparse0后移除，分支用-d删除；累计PromptCut32/VisuHive9，共41个，任务仍用5个工作区。用户旧六个与其它会话仍保留。

## 桌面与在线完整账号路径小阶段

固定根产品4adc48c2：类型exit0墙5.125秒，完整5303/5299通过/0失败/4跳过75544.0527ms；build/online-build exit0墙7.172/1.859秒。之后1cc、6df、0b1454df只增探针和报告，产品及tests逐字相同；未覆盖两轮首次全量失败。

在线4adc实际7检查6过1败：已入编辑器和取得链接，第二舞台DOM插入早于实际GET，探针断言过早；1cc首次copy等待超时、4检查全过但未完成，截图样式异常。CSS MIME原已有，不能称缺少CSS类型。6df实际Chrome19/19、零失败、complete、5718ms（墙5.875秒），真实创建201/加入200、WSS101与project.state、两账号新网站权威列表、cookie恢复编辑器全过。主编辑器CSS200/text/css；一次恢复页CSS ERR_TOO_MANY_RETRIES仍留证，原因未完全排除。TMP pc-account-online-first-{4adc48c2,1cc0cef4}-out、pc-account-online-diagnostic-6df7d192-out；自有Chrome/舞台/fixture子进程全关。

桌面首错逐轮留证：0c66在Chrome前因隔离USERPROFILE找不到浏览器；4adc原生exit101因测试指纹大写带冒号；1cc严格归一后unknown path。实证TEMP profile缺AppData/Local/Roaming时LocalApplicationData为空，补齐标准目录后6df实际main/agent配置IPC和agent拒绝通过，但login超时、6检查全过未完成。0b1454df实际诊断证明首次submit前disabled=true/connecting；等待真实按钮可用后才点击，没有改权限或模拟结果。

0b1454df真实桌面28/28、零失败、complete、18039ms（墙21秒）：实际main账号桥与agent同URL拒绝、A登录创建、可见项目链接、--quit真实退出、同profile重启DPAPI恢复、退出A切B凭链接加入、双方新网站权威列表与cookie恢复全过。两轮各11个自有PID树、CDP、Vite6340～42、Chrome和fixture子进程均关闭。exe来自908真实Rust构建，当前Rust逐字相同；所有验证身份/端口/目录/模型路径仅临时进程。首次无vault仍显示恢复失败提示，作为独立小修处理，不伪称已修。TMP pc-account-desktop-first-{0c66feb1,4adc48c2,1cc0cef4}-out、pc-account-desktop-pathfix-6df7d192-out、pc-account-desktop-loginready-0b1454df-out。

未过的强化C10探针、judge及其新增测试留原共同分支并已推送。main候选ff4f04cf529ac73c7cce28a36490d473fbb1821e与完整账号验证源没有生产代码差异，仅恢复该旧探针与对应测试。实际类型exit0墙7.250秒；完整5291/5287通过/0失败/0取消/4跳过68894.4272ms（墙69.265秒）；build/online-build exit0墙8.610/1.750秒；源不变clean、native重跑0。这是改变合并范围后的新候选验证，非覆盖首次失败。TMP pc-account-path-main-ff4f04cf-{type,full,build,online-build}.log/.result.json。

VisuHive后端兼容安装之后，新网站收回main30a9908a并推送。网站381939e语法34文件零错；full80/71过/0失败/9跳过6654.5617ms，显式provider只补未执行目标两个文件10/10零跳过242.97ms；三项POSIX跳过保留。详细证据在其docs/archive/account-backend-main-2026-10-09.md。隔离真实在线/桌面验证含新网站，生产账号v2和项目/独立素材服务仍待接线激活，不称公网新项目已可用。

## 首次无桌面凭据的独立小修

实际运行原account_vault.rs内完整PowerShell SCRIPT，无vault recover stdout为''，Rust解析JSON失败；首红2项/1过1败499.3122ms（墙0.763秒），未发HTTP、不读生产凭据。仅把null结果输出字面JSON null，其他结果、DPAPI/ACL/原子替换不变；修后同目标2/2零失败505.8325ms（墙0.764秒），首次原log不覆盖。TMP pc-account-vault-fresh-{red,green,type}.log。

根精确共同e22ff7f6a544535142e1022caf8dd662990a7d03：类型exit0墙6.531秒；full5292/5288通过/0失败/0取消/4跳过68819.9617ms（墙69.156秒）；build/online-build exit0墙8.578/1.812秒；源不变clean、native0。TMP pc-account-fresh-vault-e22ff7f6-{type,full,build,online-build}.log/.result.json。

对应真实Rust重新离线locked编译exit0墙17.140秒。第一次临时准备脚本误把capability的identifier当文件名，FileNotFoundError，在cargo/原生启动前结束；实际文件remote.json，修的只有TEMP脚本，首错保留。新exe SHA256 64f12b5cb86e50cc71e3acd9e99bd1f4f7a99d5504d2e74a681bb1749f7919a2；原908已验证exe原字节另存pc-account-native-compile-oqemhch8/verified-90832022/promptcut.exe，未损失原证据。

新exe实际桌面28/28、complete、零失败、17600ms（墙20.734秒），首次登录按钮可用时errorVisible=false/errorCode=none。真实登录/创建/加入、同profile重启保护凭据恢复、切账号、两网站权威列表与cookie恢复仍全过；两轮各11个自有PID、CDP、Vite、Chrome和fixture均关。TMP pc-account-native-fresh-e22ff7f6/result.json、pc-account-desktop-fresh-e22ff7f6-out/result.json。所有目录和识别号只在TEMP，未触碰用户正在运行的编辑器。

小阶段main72967e43及网站main30a9908a收回后，再核6458f7a4的素材工作区和99c6379的网页工作区：各HEAD已在main、完整status空、绝对.worktrees边界、全树reparse0；PC仅有可再生成的tsconfig.tsbuildinfo，VH无ignored文件。用git worktree remove和branch -d清2个，累计PC33/VH10，共43个，任务剩3个。详细TMP three-versions-user-path-worktree-cleanup-20261009.json；用户旧六个/其它会话不动。

首次空凭据小修完成实际新壳28项验证并合main c3ad6156推送后，018-account-wiring工作区HEAD7d2d94779f8b4119b1622a9734a89e1bc4913ad5再核已在main、完整status空、全树reparse0和绝对.worktrees边界，用git worktree remove及branch -d移除。累计PC34/VH10，共44个。之后仅为仍需执行的账号到文档精确证书修复建VisuHive/018-account-doc-identity；本任务实际活跃工作区为PC两个及VH一个。

## 生产配置的离线预检和文档服务身份

配置校验固定c28a998726a3b8624a116348446f08b643449b14仅取两个新文件，未整合其旧private中央登记改动。真实反例首轮8项4过4败：缺字段、IP SAN前缀误认、同钥匙换路径、缺doc pin；首修8项7过1败为旧断言预期需改成更早的完整schema拒绝。最终目标9/9零失败/跳过、9034.0105ms，强制类型退出0；原始TMP pc-account-v2-deploy-config-53bbe-review-{red,after}.log、pc-account-v2-deploy-config-review-{9-target,final-type}.log。该模块只读既有root配置，产出path-only环境和公开登记；未生成私钥、实例或ready，未部署。

VisuHive的doc叶证书精确绑定固定0aa9c962，在原CA和主机名验证上加pin；真实目标7/7，根完整83项74过零失败9跳过6538.8493ms。首红误用npm exec缓存下载另版Node已如实归档；最终用本机已有Node24，未擅自动缓存或CUDA环境。PC真实双账号fixture补上实际doc pin来使用新严格接口。详细首败与最终记录见VisuHive docs/archive/account-backend-main-2026-10-09.md。

根共同候选fb0f486dde9ea010221714db39532e63cd5bfbb5：强制类型零错墙6.657秒；完整5301/5297通过/0失败/0取消/4跳过69555.2631ms（墙69.906秒）；build/online-build退出0墙8.484/1.765秒；源码前后不变clean、native重跑0。此全量包括新增9项真实证书/密钥清单与实际双账号TLS服务目标。TMP pc-account-prod-config-fb0f486d-{type,full,build,online-build}.log/.result.json。

使用同候选实际在线构建、VisuHive main精确pin的新后端和新网站，真实Chrome19/19、零失败、complete、5562ms（墙5.703秒）；创建/加入/双方网站列表/cookie恢复仍全过。browser、两舞台6341/42、fixture子进程关闭，profile清理，source不变；没有模拟权限或ready。TMP pc-account-online-prod-config-fb0f486d-out/result.json及log。

VisuHive精确证书包以572a60eac5607b601c415e29e9c2a23293c9d08a合main并推送后，018-account-doc-identity再核HEADecb35579已在main、完整status空、全树reparse0、无ignored、绝对.worktrees边界，移除工作区并branch-d。累计PC34/VH11，共45个，本任务仍用PC两个工作区。TMP three-versions-doc-identity-cleanup-20261009.json。

## 三服务生产接线与完整托管备份

只收ea298821租内四文件，报告归档至agent-reports，不带其旧private中央登记改动。根候选50e3f1a2c05e2d109099da11910c3819829f5e58类型退出0墙6.547秒；全量5306/5302通过/0失败/0取消/4跳过69722.0022ms（墙70.078秒）；build/online-build退出0墙8.984/1.750秒；source不变clean、native重跑0。全量内本包五个目标都实际执行，真实账号/doc/独立asset创建及素材追齐后开放会话/权威项目列表通过，三个进程close，6440–45清空。原始TMP pc-account-prod-plan-50e3f1a2-{type,full,build,online-build}.log/.result.json；初次模块路径和teardown失败见归档原报告，未覆盖日志。安装计划只产配置，尚未在节点执行。

节点生产旧托管完整一致备份：/root/promptcut-full-backup-20261009-account-cutover（0700，产物0600），58,307文件/3,247,803,549数据字节，无symlink；停旧测试hosted71.445秒后立即恢复，PID24163→269595，账号268732/nginx9395未变。SQLite在线备份schema0/accountCount1/integrityok。hosted-data.tar 3,294,904,320字节/SHA256 a09f078c103b2586a0c78613b2da4fbaa2b70d4b26865f994c319fa60b46eff9；旧代码、配置/nginx/私有PM2快照另保存，未打印秘密值。没有生成生产v2钥匙、迁移或删除实际数据；恢复仍待验证，不能据备份完成就删除。TMP pc-hosted-{backup-preflight,full-backup}-20261009.log。

隔离强化探针的当前全文难题另交Astra，工作区018-browser-doc-read，原失败源码保留；不是main合并门槛。首次工作区准备输错完整ref被Git拒绝，核真实0b1454df96fa8586712e9cea07d4b57b36964b62后才建，无重置/清理。最初6463为用户Discord占用，探针预检即拒、服务未起，未碰该进程；根重分配并确认6600–6609为空后再作有界诊断。该次环境前置不能算产品反例或通过。
