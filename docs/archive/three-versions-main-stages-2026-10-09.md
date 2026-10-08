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

节点生产旧托管完整一致备份：/root/promptcut-full-backup-20261009-account-cutover（0700，产物0600），58,307文件/3,247,803,549数据字节，无symlink；停旧测试hosted71.445秒后立即恢复，PID24163→269595，账号268732/nginx9395未变。SQLite在线备份schema0/accountCount1/integrityok。hosted-data.tar 3,294,904,320字节/SHA256 a09f078c103b2586a0c78613b2da4fbaa2b70d4b26865f994c319fa60b46eff9；旧代码、配置/nginx/私有PM2快照另保存，未打印秘密值。该步未生成生产v2钥匙、迁移或删除实际数据。TMP pc-hosted-{backup-preflight,full-backup}-20261009.log。

随后从上述实际备份完整恢复到隔离/var/tmp/pc-hosted-restore-20261009-account-cutover：先核两个归档SHA及成员边界，58,307文件的逐个SHA/大小全匹配，3,247,803,549字节一致，无额外文件。用恢复出的旧源码与原真实数据启动隔离6370/6371，文档及素材healthz均200；读取4个共有项目、5个空间、6份项目记录，实际项目模块成功回放6份版本并读出4份正文。HTTP抽读media/snap/px各3份，共9份真实素材，逐份内容哈希全匹配；恢复出的账号库integrityok/schema0/1个账号。自有恢复PID269734已退出、两端口清空；生产hosted269595/account268732/nginx9395前后相同。未删除实际项目、数据或备份；证据TMP pc-hosted-full-restore-20261009.log和节点备份目录restore-result.json。

隔离强化探针的当前全文难题另交Astra，工作区018-browser-doc-read，原失败源码保留；不是main合并门槛。首次工作区准备输错完整ref被Git拒绝，核真实0b1454df96fa8586712e9cea07d4b57b36964b62后才建，无重置/清理。最初6463为用户Discord占用，探针预检即拒、服务未起，未碰该进程；根重分配并确认6600–6609为空后再作有界诊断。该次环境前置不能算产品反例或通过。

强化探针冻结dcc51bc0已推送，未合main：正文contentProjectId与文档服务shared project标识不同，真实项目模块反例及定向16项通过；修正回读后，有界真实浏览器在150.407秒失败于旧join-invite-project菜单。产品新账号入口已经替代该菜单，旧夹具尚未接账号服务，不能退回旧入口使探针通过；该次没有进入全文/主机最终验收，自有6600–6609服务均关。报告在隔离分支docs/reports/AGENT-codex-018-browser-doc-read.md，原始TMP pc-browser-doc-read-2a467e4e-bounded-2.log/.result.json/.postflight.json，fullC10Validated=false。

节点固定源码Linux补查：VisuHive main572a60e在独立真实git历史副本以非root服务用户运行，显式本VH provider，86项全过/零失败/跳过14794.747895ms（墙14.873秒）；PC main eb8228a4的生产配置与真实三服务部署目标14/14零失败/跳过26174.001657ms（墙26.242秒），含account/doc/asset实际PID271019/271031/271043路径及真实head先拒503再ready200/create201/projects200。自有636x/644x均清，生产三PID不变，尚未安装。首次归档脚本根目录成员判断错误、第二次错误假设/usr/bin/node均发生在测试前；已明确现有Node=/usr/local/bin/node v24.21.0，仅修TEMP launcher/其自有stage目录权限，不改全局或产品源码；所有首次日志保留。实际计数从完成的原日志补读，未因报告器格式不同重跑。TMP pc-account-linux-stage-eb8228a4内linux-stage.log、linux-stage-resume.log、linux-test-run-2.log；节点对应visuhive-full-run-2.log与pc-config-and-plan-run-2.log。

官网反代冻结4e1c946f根独立完整npm90/86通过/0失败/0取消/4跳过7290.8178ms（墙7.5秒）；Linux实际nginx专门目标4/4、零失败/跳过297.504668ms（墙0.59秒），三个精确账号路径/query、其它hosted旧rewrite、素材Cookie清除与WS101均通过。Windows启动脚本首次两次引号/ESM URL错误均在测试前，改TEMP启动器后才执行全量；源未变，日志保留，Sol独立核对。VH main ea1937a已收回推送；准确工作区HEAD3b2eeea在main、完整status空、ignored0、全树reparse0/绝对边界确认后清掉，累计PC34/VH12共46个。TMP vh-public-routing-root-full{,-run-2,-run-3}.log、vh-public-routing-root-linux-first.log、three-versions-public-routing-cleanup-20261009.json；详细阶段报告已移VH docs/archive/agent-reports/。

仅为仍需做的公网真实路径新增PC018-account-public-path，Sol准备固定探针，根会话运行公网写入；尚未创建公网测试账号或项目。Astra完成的强化探针保留已推冻结分支，在干净同物理018-browser-doc-read切新018-asset-root-publisher分支做OS登记工具，旧源码未覆盖/删除。当前实际活跃PC四工作区，角色逐个列进进度；不是本任务旧六个及外部工作区不动。

## 生产单元路径小阶段

独立第三次根候选4c041cfc完整5309项/5305通过/0失败/4跳过、70320.2711ms（墙70.656秒），强制类型0、两种构建0、native重跑0。三份真实单元解析以及复杂cwd与真实环境文件读取均通过，详见 [独立单元报告](agent-reports/AGENT-codex-018-account-v2-working-directory.md)。此前引号、反斜杠、EnvFile glob三个实际失败保留。配置角色/私钥已一次生成并核角色间读拒绝，尚未切换旧服务。

公网临时桌面编译源f20e318c，cargo offline/locked成功墙16.281秒，独立TMP exe SHA256 9bb3f757d89c09b8b937c68d8473d711f8c9b76b7c50a14f0c45343cc4258a5c，能力仅main6500、实际公网系统CA、编译5源文件逐字一致。首次准备断言把CRLF工作树和LF git show误当不同，发生在cargo之前；已以逐字工作树并正规化git内容双核更正，没有改产品代码。公网探针还没运行。

## 真实生产三角色与账号启动修正

切换前再做schema0/原1账号在线SQLite备份及32字节凭据私有拷贝，实际读取integrityok/字段相同/凭据字节一致；第一次准备因要求旧环境中并不存在的两个nginx snippet而停，没有重跑数据库备份，确认旧环境不存在后继续，TEMP pc-account-pre-v2-cutover-backup-{,resume-}20261009.log保留。

原3单元首启动失败：account对正确0600且ReadOnlyPaths保护的凭据无条件chmod→EROFS，doc account-unavailable，asset正常；root停止自身新account/doc自动重启（首段约17次），数据库已schema2且原账号字段未变，未回滚或更换钥匙。Sol af6f2df9仅正常key避免metadata写，非安全权限仍修或拒；根a01ae0bc独立全量93/89通过/0失败/4skip6671.6512ms墙6890ms，node syntax2项0，本VH无TS。真实Linux保持私钥只读、3服务active/NRestarts0、3健康200、key字节/0600/原账号字段不变。VH合b79ec16推送；root验证clean/noignored/reparse0/ancestor后清此VH工作区，累计47=PC34+VH13；原始TEMP vh-key-boot-deploy-a01ae0bc/actual-unit.log及vh-key-boot-cleanup-20261009.json。账号/me匿名200/null是原v2契约，未改成401。

root公共部署：162静态文件及onlineCardExec:true，nginx精确account路由、素材Cookie剥离、允许卡片外链CSP、编辑/舞台分源。信任编辑源仅canonical visuhive和原sslip，grant不对任意Origin放行；模板cookie map缺分隔空格在部署渲染时补齐，模板源码后续单独收修。旧editor整目录保留editor-pre-v2-20261009、旧5份配置/数据/钥匙备份保留。nginx-t0及正常CA HTTPS官网/编辑器/账号me/双舞台/原编辑地址/runtime均200；还不算公网完整用户路径。日志TEMP pc-account-public-{prepare,install}-20261009.log。

每日账号备份unit/timer真实安装，手动一次成功并实际读schema2/integrityok/账号2（原1＋首次公网自建1），备份key与原字节一致、三文件mode600，timer active下次2026-10-09 02:17UTC，没有保留期删除。路径/日志TEMP vh-account-daily-backup-20261009/actual-backup.log，节点/private目录及旧备份均保留。

首次公网f20e318c：9check8通过1失败，墙7.25秒，停register-1，network显示第一注册POST200、第二只有GETme没有POST；真实留下1自建随机账号、无project，native未运行。Chrome owned7进程和Vite6500–2全部close。root初误断cookie共享；完整源码本已独立context，实际是register() awaitfillWho后才挂submit而probe仅等DOMContentLoaded的初始化race。原截图/JSON/日志TEMP pc-account-public-f20e318c-first{.log,-out/result.json}保留，禁止打印原URL/query/密码。Sol新探针等待实际匿名me/nav/submit listener且回填精确自身account公共ID；页面敏感表单本身另作独立守门，不靠探针等待掩盖它。

## 网页表单与第二次真实公网

VisuHive实际表单源码3f95ac07，冻结报告e7af5956。四页共7表单显式POST、初始disabled，脚本在首次await前安装同步capture守门；真实/me成功及业务submit handler安装后才自动启用。首红18项7通过11失败；修后专属18项全过70.1408ms，均保留raw。根固定e7af独立npm test104项/100通过/0失败/4跳过/0取消6670.5956ms，墙6875ms，native重跑0；syntax2项0、无TypeScript、源码不变且clean。报告归档后合VisuHive main1b3b002并push，TEMP vh-form-readiness-root-e7af5956-full.{log,result.json}。专属测试执行实际JS/HTML的受控DOM与延迟/me，不冒充Chrome或公网。

实际部署五份网页/脚本，原文件逐个备份在节点/root/promptcut-account-cutover-eb8228a4/form-readiness-1b3b002/before。首次定位误以唯一root在/opt，实际landing配置同时有两个/var/www/landing和editor root，断言在任何备份/写live前停止；只读定位后以准确/var/www/landing继续，同一上传包未重做。正常CA公网五URL200、字节SHA均等于main；账号/doc/asset/nginx PID与重启状态均不变，未写账号数据。TEMP vh-form-readiness-deploy-1b3b002/deploy{,-resume}.log保留。

第二次公网固定PC9ccdcf3b（探针源码7aa54d11），TMP实际exe仍f20源且5Rust文件逐字同，SHA9bb3f757…。wrapper墙69.812秒，probe66802ms，exit1：16个已执行check为真但completedfalse，online-a-create Timeout；注册两账号POST200，编辑器login/editor-session/projects200，无任何create请求/WSS，无project，native未运行。新自建公共账号ID acc_d6ec0d30a99509d45ff9eb7b（pcpub_273dfc4dae47_a）、acc_86cc4f3a0cd633ec91574f7d（_b）均保留供准确清理。Chrome own7进程+Vite PID42180/6500–2已关，源码不变clean，native重跑0；TMP pc-account-public-9ccdcf3b-second{.log,.result.json,-out/result.json}。已登录截图button仍busy；失败最终截图已恢复enabled、项目名已填。源码setAccount先显示，再await列表，finally解busy；探针只等account-name便点击disabled create，未触发请求。下一窄修等真实可交互，不改产品disabled，不把此超时计作完整通过。

此表单工作区已核main祖先、clean/未跟踪0/ignored0/全树reparse0后git worktree remove与本机branch-d，无force，远端分支保留。TEMP vh-form-readiness-cleanup-20261009.json；累计48=PC34+VH14，在用PC4/VH0，旧6与其它会话未动。

## 首次真实Linux进程组关闭取证

固定Astra886cd6b5，脚本SHA4a7f957074cb66da8b0b63d8ed80bd26676adead7f543e1c2ddc3f896b84629e，在systemd249/node24.21真实唯一瞬态unit pc-asset-cgroup-proof-66f1b663560e6a51，专属asset UID995、端口6540；未启动生产publisher/doc接收。wall2283ms/exit1，stop只一次且exit0，负例已观察：268ms父出生消失，但子仍持文件FD/TCP，populated1；2261ms子关闭FD与连接但出生仍在；2273ms两个出生均消失，固定旧eventsFD读ENODEV，没观察到pop0，emptyObservedfalse，不能将未知视为空。最终两个EOF/close真、unitinactive/MainPID0，6540–49清空。生产account274484/doc274497/asset273011/nginx9395前后PID相同且NRestarts0/active。实际失败原文TEMP pc-root-cgroup-os-886cd6b5-once.log，节点/var/tmp/pc-root-cgroup-os-886cd6b5/once-output/result.json；不原码重复跑，交Astra列保留可观察空对象的三级解法，此模块仍不合main。

## 第三轮公网完整用户路径小阶段

真实固定2d2fcd11完整58/58、0失败、completedtrue，probe38116ms/wrapper41.25秒；实际桌面壳两次运行/IPC隔离/DPAPI退出重开/换账号加入与两方fresh网站列表全部通过，原两轮失败仍保留。根已逐张看实际在线创建者列表、加入者列表和native编辑器，三幅安全截图随仓库归档。集成候选074769e5类型0/全量5309项5305通过0失败0取消4跳过70369.6038ms墙70.75秒/native重跑0，两构建0。58项不是模仿原测试回包，online create201/join200/WSS101与project.state精确编号，网站owned/joined编号精确一致；native真实HTTP在Rust进程，不冒称CDP读到它。仅本阶段用户路成立，未声称Agent/用户卡重渲/成员显示或全部附带事件都验过。详细首败/源码/端口/PID/测试记录见[独立公网报告](agent-reports/AGENT-codex-018-account-public-path.md)；公网注册账户及两个项目尚未删，后续按准确清单和备份做。

main产品合d948acb3已push；首次文档stage含已gitmv删除的旧报告路径，git add失败，commit仅提交已stage的报告rename，未丢正文/截图；根随后显式stage现存路径，8ac0441f提交全部102行进度/实际截图/补充报告，main37920dff合入并push，local/origin main0/0。没有把此误stage隐成“一次提交全部包含”。旧release073c8cca按用户每版发完才进安排继续保留。

完成公网worktree018-account-public-path先push冻结2d2fcd11，再核mainancestor、clean/未跟踪0/ignored0/reparse0，git worktree remove及本机branch-d，无force、远端分支保留；根结果TEMP pc-public-path-cleanup-20261009.json。累计49=PC35+VH14，当前在用3，旧六个与非本任务目录未动。Sol新的浏览器夹具还在只读拟边界，未空建新工作区。

独占slice候选f8fb7f75第一实际运行首段失败：wall28ms、probe-unit-exists、未造输出dir/监听/worker/active slice，生产4PID均不变。真实249 systemctlshow未知合法slice自动合成loaded/inactive/dead、Transientno、FragmentPath/SourcePath/ControlGroup/InvocationID均空，不能拿service not-found判据直接套slice；原stdout节点/var/tmp/pc-root-cgroup-slice-f8fb7f75/once.log和TEMP pc-root-cgroup-slice-f8fb7f75-once.log保留。交Astra按pristine加载区分真占用，未直接放宽任何已active/有配置unit、未重复原码跑；OS机制仍待真正实验。
