# 账号登录与云端项目用户入口实施报告

2026-10-09；工作分支`codex/018-account-wiring`；开工固定起点`26cbf7e07cb44a169b8aafe6cf1fae4500026e94`，tracked/untracked均干净。旧B素材叶保持冻结，不改其源或恢复机制。

目标为真实账号登录→新建云端项目→第二账号凭链接加入→双方网站列表有项目，并给桌面版和在线浏览器完整入口。本叶只负责PromptCut开始页、编辑器云端进入/登录恢复桥；网站列表与真实后端接线由root协同，不用受控ready替代完整链。

租约：`src/StartPage.tsx/css`，`src/editor/io`、`src/editor/sync`中账号登录/云端创建加入所需文件，新`src/account/`、专属tests/probe和本报告；desktop仅安全凭据存储及UI桥最小必要文件，具体路径先报告root。禁止修改server/account、server/hosted、素材store、Agent、B/G源、全局测试脚本/端口守门或环境安装。

开工已读AGENTS入口、developer_guide索引、suggested_agent_behavior、constraints；继续核账号任务书/产品语义/真实account-hosted API与已有前端和桌面桥。先交可复用入口与最小清单再实现；网站账号模式不在localStorage存长期凭据，桌面复用现有vault原则或报告缺机制。后端503原样准确呈现并交真实依赖，不绕ready/ACL。

验证未开始。6340～6349仅自身临时fixture；纯类型/无监听可做，任何监听目标/full先报命令待root排窗。Astra6320～6329在运行，不碰用户/其它Agent端口。所有数据日志TMP、子树windowsHide/绝对silent preload，Python仅进程cuda_Vit/models；不push/merge/节点/新worktree/install/junction。首红、具体源码与raw结果随后补记；用户路径功能探针实际通过才记阶段。

## 第一个可审实施块（尚未产品验收）

新`src/account/client.ts`严格消费VisuHive `account/app.mjs`的`/api/account/me`、`login/logout/projects`、`editor/session/renew`；网页请求cookie与CSRF同源，向doc`/hosted/shared/account/create|join|session`使用短期access bearer且credentials omit（真实doc public接口拒Cookie）。长期网站/editor凭据不写localStorage/sessionStorage；官网remember由服务器Cookie寿命决定。桌面login/recover/logout只走native桥；账号access只在RAM，恢复token只在DPAPI文件。

StartPage在线入口替换旧云房间口令，桌面新增云账号入口且保留本地新建/草稿/LAN。新AccountProjects显示登录、云端新建、链接加入、网站权威两列表/失败重试；桌面打开官网查看两列表，不新增Bearer list API。新建固定requestId与initialProject重试，已成功create但session503时保留projectId，不能重复创建。join重试固定requestId。进入后提供真实项目链接复制操作。列表故障显示不可用，不造空列表。

syncManager账号专用进入复用SyncLink和server projection，initialize:false不上传本地空根；WebSocket协议只用真实connectionTicket，每次resume/重建重新问session。旧auth.ticket/service.watch/shared.watch在v2明确禁用，因此账号素材分支用HTTP session assetTicket续签与已部署nginx`/media/api/asset`路径，旧LAN机制不改。账号selection.set/clear启用现有read发布者；旧Agent票据/节点/卡片同步不能凭旧协议绕入v2，本块没有伪造这几项授权，真实接线依赖其它owner。

root已追加租`src/editor/media/assetTiers.ts`账号素材分支、desktop新`account_vault.rs`与lib注册。〔裁〕现Cargo无HTTP crate且不能安装依赖，采用固定官网HTTPS的PowerShell/.NET桥，stdin传凭据、CREATE_NO_WINDOW、stderr不回显、禁redirect/Cookie/任意header/path，20s HTTP超时、1MiB请求/2MiB响应上限；URL只`https://visuhive.com`且请求只三个doc路径，账号三登录路径由固定operation生成。调用者核main WebView label+真实5210根URL；卡片/子WebView边界还需真实壳探针证实，不拿静态核代替。恢复文件独占新account-v1子目录，DPAPI CurrentUser、当前SID/SYSTEM ACL、tmp继承私有ACL、文件Flush(true)与原子替换；进程内串行桥，恢复前先持久requestId供丢响应后幂等重取。没有密码或access落盘。旧壳缺command明确提示使用桌面新版或在线页面，不降级明文存储。非Windows安全vault暂无实现，明确拒绝。

首次强制类型：`node C:/Users/admin/Documents/PromptCut/node_modules/typescript/bin/tsc -b --force`，exit1、3错误、wall7.2038s，raw`%TEMP%/pc-account-user-path-type-1.log`。分别为ensureDevice可空、默认randomUUID推断模板字符串、误写不存在onSharedMessage；已在本块精确修为设备空值拒、requestId:string、实际onSideMessage。第二次同命令exit0、零类型错误、wall7.5243s，raw`%TEMP%/pc-account-user-path-type-2.log`。使用绝对silent preload/规范PSModulePath，无业务listener。

新增client受控协议目标和Windows真实DPAPI/ACL/原子替换目标尚未执行；不会把JS/native mock当真实登录链。PC全量、桌面check/build、双账号真实browser+doc+asset路径及截图尚未执行，等待root测试窗口与真实configured中央。backend503是可见未完成状态。本块源码提交后再申请目标；不借其它候选测试数字。

2026-10-09首次窄pure `npm.cmd test -- src/account/client.test.mjs src/account/desktopVault.test.mjs` 于固定`cc144c2a`：2文件级/0过/2失败/0取消跳过，447.1618ms、wall828ms，raw`%TEMP%/pc-account-user-path-target-1.log`。无业务listener；原global guards保留。client在Node24 strip-only入口因constructor parameter property失败，不是权限断言失败；改显式status/code字段。Windows真实DPAPI首次封存/解密通过，但第二次File.Replace(tmp,file,$null)由PowerShell绑定出空backup路径，真实报路径非法；改为.NET真实null `[NullString]::Value`，保持原子替换，不能删原文件后move代替。这是实际运行发现的产品bug，保留首红。PS owned child自然close，TMP目录finally清理；后续仅固定修正后同目标有因复验。

同目标修后固定`7b350daa`第二次：5/5、零失败取消跳过、338.3682ms、wall608ms，raw`%TEMP%/pc-account-user-path-target-2.log`，原npm wrapper未重跑(native retry0)。4条client为受控fetch/native adapter，1条Windows真DPAPI/目录ACL/第二次原子replace只碰自建TMP，不是Tauri完整IPC/真实密码登录。没有HTTP/WS业务服务监听。官网链接已对齐实际`/account`。

后续root核要求避免用户5210～12：改Rust可信AccountBridgeBinding，setup从实际主服务origin与当前Tauri identifier的app_data_dir构造；native不信JS port/目录，核主窗口label+exact origin+根path。生产identifier恒5210；仅独立identifier结尾`.account-probe`允许process-only `PROMPTCUT_ACCOUNT_TEST_EDITOR_PORT`且限定6340～6347，统一主服务预检/sidecar args/启动poll与两个stage预检，测试壳app_data按独立identifier隔离。配置/构建/实际壳probe仍由root窗口安排，不能调用用户安装壳app_data。新增Rust纯端口绑定unit及账号素材HTTP票据受控renew/stop目标待跑；不把这些证明成真实Tauri或双账号产品链。

固定`c5a2d2f8`扩展pure首次命令`npm.cmd test -- src/account/client.test.mjs src/account/desktopVault.test.mjs src/account/assetTicket.test.mjs src/editor/media/assetTiers.test.mjs src/editor/media/uploadTarget.test.mjs`：23/22过/1文件级失败/0取消跳过，2269.5119ms、wall2541ms，raw`%TEMP%/pc-account-user-path-related-1.log`。新assetTicket测试静态import会先于registerTs loader初始化，导致真实module扩展名解析失败；已改为与原assetTiers/uploadTarget测试一致的await dynamic import，不改变产品或断言。17条旧素材LAN/在线轮询上传回归及此前5条均过；此结果不能写整套通过。

〔裁〕root授权最小真实壳fixture机制，实施前后边界：原production native仅固定`https://visuhive.com`、系统TLS校验；保留。仅Tauri独立identifier结尾`.account-probe`允许Rust setup读取process-only cloudOrigin且必须严格等于`https://127.0.0.1:6388`、64hex SHA256证书pin必填；native固定请求路径在该exactTLS入口上执行且仅接受pin证书，不改系统CA/代理/DNS/生产验证。G/root准备真实TLS反代account/doc/asset，不能JS给origin/pin。nativeconfiguration只给主编辑器非秘密cloudOrigin供WS/项目链接匹配；vault仍当前独立identifier app_data_dir内，生产identifier不读测试override。该机制是三级测试隔离选择，不写成用户逐条特别批准；真实壳/双网页目标未执行前不能标完整用户路径通过。

固定`1c32c71d`扩展pure第二次同5文件：23/23，2234.4117ms、wall2496ms，raw`%TEMP%/pc-account-user-path-related-2.log`；同源强制type3零错，wall6618ms、raw`%TEMP%/pc-account-user-path-type-3.log`。不冒称该源之后新增cookie隔离/项目cache范围已测。静态继续发现asset-runtime拒Cookie，因此account素材轮询显式omit，same-base换项目须清completeHash及通知remote切换；LAN保留旧行为。HTML img/video自带同源Cookie问题交root/G ingress清Cookie，不改后端凭据规则。另Tauri build.rs/capability未登记新命令是实际IPC未接通缺口，已申请窄租，真实cargo/壳probe仍待办。

root追加精确租后，build.rs只登记`account_bridge`，新增capabilities/account.json：仅main、local:false、exact生产`http://127.0.0.1:5210/*`、allow-account-bridge；原default capability不改。测试Tauri config必须嵌另一个单exact实际6340主origin的同权限capability（不要把stage6341/42列remote），独立identifier与Rustbinding再核。由于工作树无binaries/target，真实cargo应在root隔离验证树准备已装sidecar/runtime闭包与TMP target后执行，不能复制/调用用户安装壳：`cargo check --offline --locked --manifest-path desktop/src-tauri/Cargo.toml`；`cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml --lib account_probe_binding_is_identifier_and_port_scoped`。这两个命令尚未执行，不安装Cargo依赖，不冒称壳compile通过。测试配置identifier须唯一`.account-probe`结尾，process-only编辑器端口6340、cloudOrigin精确https://127.0.0.1:6388、G公共服务器证书SHA256 pin；配置嵌精确6340 account权限，app_data自动另目录，不操作已有用户目录。启动壳/6388真实入口仍等root窗口。

## 当前固定交付与验证边界

产品固定源码`de633822eaa62018fe88f12281556358578d27aa`，包含`1c32c71d`之后的`39ec5565`账号素材Cookie/cache隔离与`de633822`manifest/capability/测试origin链接修正。固定源同5文件pure第三次：24/24、零失败取消跳过，2238.0967ms、wall2508ms、exit0、native重跑0，raw`%TEMP%/pc-account-user-path-related-3.log`。新增第24条在真实assetTiers实现上以受控fetch核同源账号GET的credentials omit、同base换project清旧hash；不是实际nginx/asset网络验证。原global-setup坏端口guards保留，无本叶HTTP/WS/TLS业务listener；owned PowerShell子进程等待实际close且TMP自建vault清理。

同固定源强制type4：绝对TypeScript路径、`tsc -b --force`，exit0零错、wall6865ms，raw`%TEMP%/pc-account-user-path-type-4.log`。测前后HEAD均de633822，tracked/untracked干净，diff --check通过；没有在测试期间改源码。累计首红仍保留：type1的3个实现错误、target1两个文件级失败（Node strip语法与实际DPAPI Replace）、related1新loader初始化失败；其余既往绿色只对应各自固定source。

相对基底owned完整差异为15文件：开始页2、账号模块/专用tests6、syncManager/assetTiers2、Rust桥/lib/build3、新窄capability1、报告1；未修改server、Cargo依赖、default capability、用户目录或其它工作树。cargo工具绝对路径`C:/Users/admin/.cargo/bin/cargo.exe`，root可在隔离树用上述offline/locked命令，设置`CARGO_TARGET_DIR`到本次TMP；测试Tauri config的`app.security.capabilities`须包含原default/生产account引用与另一个仅main、local:false、remote.urls=[http://127.0.0.1:6340/*]、permissions=[allow-account-bridge]的独立inline能力。不得把6341/6342 stage或任意localhost加进账号能力；实际资源由root准备，不调用用户安装壳。

本轮未执行cargo check/unit/build、真实Tauri IPC/子WebView拒绝、6388 TLS pin正反向、桌面恢复/WS Origin、两个网页账号创建/链接加入/网站两列表/显著分享截图、完整npm或节点公网。完整用户路径仍待root把真实G配置与此固定源组合验证，服务端503继续准确可见；不把pure/类型绿写成功能阶段完成。账号进入保持现有server projection，未接旧Agent/auth.ticket/节点/卡片同步；creator前端状态暂保守false，不借页面自报creator授管理员权。真实后端身份/权限仍唯一权威。HTML img/video Cookie剥离依赖root/G受信入口，后端素材票据验证不改成信Cookie。此处缺口需要真实产品探针继续，不用受控ready或native mock补作证据。

## 双网页探针与两个额外精准修复（尚未实际网页验收）

root新租仅新增`scripts/probes/account-user-pages-probe.mjs`及报告，保持原UI冻结；后续Astra只读发现两处真实源码问题，root分别追加精准原生桥/client退出租。锁定Cargo.lock的tauri2.11.5真实源码`webview/webview_window.rs`的CommandArg先检查window.is_webview_window，多webview窗口失败在guard前；`webview/mod.rs`的Webview CommandArg直接取实际调用者。独立`aa49ec86964739c515ef5dc700b6d2e98afdc11a`改命令参数为Webview，核实际webview.label=main与所属window.label=main、可信exactorigin/rootpath/no-userinfo；不移除agent child、不放宽capability、不改配置。只核源码接口，cargo/真实IPC待root独立壳验证，不能用compile或DPAPI测试证明IPC。

退出原实现native结果不check、网站finally总清RAM，503会让UI显示退出但保留vault。先新增纯失败断言，原产品`aa49`+新test首红：`npm.cmd test -- src/account/client.test.mjs`，5/4过/1失败、223.0182ms、wall579ms、exit1，raw`%TEMP%/pc-account-user-path-logout-red.log`，实际Missing expected rejection。独立修复`807c2b16c2218e97ccae9cecc12db1a57bcd8aee`检查native结果，503/协议错误抛给UI且保留RAM；native401依据原桥已删vault视明确终止，网站失败不在finally伪清状态。未改变服务器退出范围。固定807同client+desktopVault两文件：6/6、零失败取消跳过、464.5289ms、wall728ms、exit0、native重跑0，raw`%TEMP%/pc-account-user-path-logout-green.log`。该纯client路径用受控响应；真实WindowsDPAPI/ACL/Replace仍仅TMP，未验证Tauri IPC。

网页探针固定`c054c73f1cdb3b2728c5b2682149a962906eb7e2`，234行；`node --check scripts/probes/account-user-pages-probe.mjs`、diff --check通过，尚未执行探针/启动业务listener。实际依赖G固定`ceba99b36a79c33e88ac37e127bc3301054fa218`（报告7fc4de09）的`startAccountDualUserFixture({publicHandler})`，采用真实account/doc/独立asset子进程及6388TLS路由；publicHandler只给非API静态，真实API/WS/media优先，不吞503。静态网站来自root核定clean heldsite `C:/Users/admin/Documents/VisuHive/.worktrees/018-account-site-compat/site`、HEAD`01601a911117415dc180c2130a0c274f75de8d54`；PC来自root另构建的真实compiled dist-online，探针不构建或使用dev mock。网站当前DOM只显示项目名，探针同时核实际页面发起的权威/projects响应exact projectId/name与owned/joined可见文字，不假称DOM已展示ID。该静态页原“还在开发中”提示尚在，本叶不修改VH自动上线源。

运行接口：`node scripts/probes/account-user-pages-probe.mjs --dist <真实compiled目录> --site-root <held016/site> --fixture-module <共同源码G probe文件> --out <本次TMP子目录>`；配置真实provider根及password-order路径为fixture要求的process env。需root独立窗口：G6380～6385和6388共7监听，加本探针6341/6342 stage共9，独立asset child和一个自建TMP profile的headless Chrome（pipe不占调试TCP）。stage路径来自compiled stage.html，响应头复用stageSecurityHeaders/editorSecurityHeaders，runtime-config准确s1.pc.localhost:6341/s2.pc.localhost:6342；断言两舞台确有加载。Chrome仅自身acceptInsecureCerts接受fixture证书，不改系统CA/代理/DNS；真实壳精确pin正反向另验。

两隔离editor context实际输入官网账号表单；A新建唯一项目（不是fixture预建baseline），真正进入编辑器后点击可见分享按钮。〔裁〕临时浏览器context正常拒绝clipboard权限，使产品已有可见URL fallback出现，不写用户OS剪贴板，也不注入navigator/fetch/native/ready mock；B粘贴该可见URL并真实加入。另两个fresh website context在/login实际登录，到/account核两权威列表；再打开editor核共享Cookie恢复无需再次密码。截图先清除可见密码输入或已卸载/隐藏表单；结果仅安全phase/check/project/name/network method/path/status，不记录凭据、完整HTTP body/响应、Cookie、CSRF、ticket或proof。所有fixture数据/日志/图片/profile在TMP；await context/Chrome实际close、stage server/socket实际close、fixture独立child与各服务close后才输出收口，不把源码检查当页面通过。

固定c054强制type5零错exit0，wall6846ms，raw`%TEMP%/pc-account-user-path-type-5.log`；测前后source未变且工作树干净。未执行网页探针、业务服务、全量、Cargo/真实壳、节点部署。完整用户路径继续标未验，下一步由root将G+此固定源码收共同验证树后执行真实在线页面，再由root/Astra验隔离桌面。原de633的24目标/type4仅对应旧固定源，未借给本新probe作通过证据。

## 可选实际桌面模式与共同首红转交

root共同`908320223268951f94ad9b14026e75666b572b57`独立full首次5300/5294过/2失败/4跳过、75.043s，由root保留raw，不归本叶执行。其一为既有在线产物API棘轮未登记账号客户端实际5条：独立`7640d367200bcb57795ac4504053e5a0bc866101`只改授租`server/test/c10a-online-api-paths.json`，登记me/login/logout/projects和editor/动态session/renew的产物前缀并补契约来源，不放宽scanner/逐条一致断言，不追加桌面editor/login/recover。另一为G server→scripts fixture边界，原owner另固定`a072567e992391562d2dda6da628f0422e25414d`纯移动实现到server/test/fixtures并保scripts reexport，探针import/options/result无需改。本叶还只读发现`src/online/apiGuard.ts`实际fetch同源/api全拒会阻账号入口，已向root报最小精准例外范围，未获租前不改/不绕fetch。root的TMP原生第一次build因测试capability名字误配失败、修正后另验；本叶不借其compile进展作IPC通过。

root追加同probe/报告租约，实际桌面模式源码`3c15c1b398747606198fcb31dfe35ec478d262e0`，随后仅收紧owned PID存活判定：只有ESRCH才算消失，EPERM/其它未知保持alive，不自由确认子树已关。新增可选`--desktop-exe <TMP隔离构建.exe> --desktop-profile-root <TMP子目录>`，拒用户安装exe或非TMP profile；root准备唯一`.account-probe`identifier、6340 exact权限与自有Vite6340～6342。本模式不再起6341/42 stage，compiled在线静态仍用于官网Cookie恢复后的在线页面。只该exe子进程隐藏spawn，USERPROFILE与WebView2 userData在给定TMP，TEST_EDITOR_PORT6340、CLOUD_ORIGIN6388、fixture leaf精确pin、CDP6348为process-only；不改系统CA/代理/DNS，原生HTTP不受WebView CDP影响。暂不自行启动服务或exe。

实际步骤为连接该自有WebView2 CDP，核main/所属window实际label、agent_webview_info ready/port、main真实account_bridge.configuration；再把自有agent webview导航到相同main URL并实际invoke账号configuration，要求真实拒绝，不能以mock__TAURI/换子WebView代替。CDP Security.setIgnoreCertificateErrors仅本测试WebView2环境供临时WSS；原生HTTP仍走Rust/.NET精确pin。default native context对6340空clipboard权限以产品可见链接fallback取地址，不触用户OS剪贴板。A真实桌面表单登录→新建→链接，独立exe --quit并等待原child close、退出前真实CIM PID树全消失与6348 TCP关闭；主窗口X/后台不算。相同TMP profile重启核真实DPAPI恢复A无需密码，然后导航根、真实UI退出成功、B表单登录/同链接加入；两官网fresh Chrome context仍真实login核owned/joined。桌面nativeHTTP状态不可由浏览器network假造，本模式不借在线201/200断言，靠真实UI、WSS打开与官网权威ID/name组合证明。

新增模式仅`node --check`与diff --check通过，尚无真实桌面/网页执行结果；没有本叶监听、exe启动、full或安装。独立TMP/Cargo/壳/在线首结果仍待root窗口，所有首错按具体source保留，未把rootB/G的真实TLS/WSS模块目标当本probe已过。Chrome与fixture关闭失败继续记失败并收其它owned资源，不报成功；无法证明的native资源保持cleanup失败，交root处置，不结束非自建进程。

root随后精准授`src/online/apiGuard.ts`及实际原test`src/online/c10a-api-guard.test.mjs`。新增真实守卫纯反例（受控window/fetch只用于guard单测，不用于网页probe），原c703产品+新test首次`npm.cmd test -- src/online/c10a-api-guard.test.mjs`：2/1过/1失败、134.2057ms、wall423ms、exit1，raw`%TEMP%/pc-account-user-path-api-guard-red.log`，实际me TypeError被拦。独立修复`2585a6aa0b50e31a93d48be55a4864d60904ab44`仅fetch允许顶层编辑器base根/index文档、same-origin Cookie模式、exact me/projects GET及login/logout/editor/session/editor/renew POST；stage.html、stage查询、嵌入页、其它文档、未知account、桌面editor/login/recover/logout、所有旧本机API仍拒；EventSource/XHR/beacon仍用原判据全拒。不宽放account前缀、不更换原fetch、不改stage网络出口政策。已列6个完整route对应产物5条literal（editor动态后缀），区别如实保留。

固定2585一次修后pure：`npm.cmd test -- src/online/c10a-api-guard.test.mjs src/online/c10a-api-guard-desktop.test.mjs src/online/online-impl.test.mjs`，9/9零失败取消跳过、136.4892ms、wall420ms、exit0、native重跑0，raw`%TEMP%/pc-account-user-path-api-guard-green.log`。原桌面不装guard与API路径判定/设备/邀请回归保留。该源强制type6 exit0零错、wall5295ms、raw`%TEMP%/pc-account-user-path-type-6.log`；测前后固定2585且clean。没有本叶业务listener/full/桌面或网页probe执行；root原908在线first/full与TMP native编译是另source证据。当前共依赖root将G a072、ratchet764、desktop3c/c703、guard2585组合后实际运行。真实壳隔离artifact由root准备`pc-account-native-compile-oqemhch8/target/debug/promptcut.exe`、identifier`com.promptcut.validation.oqemhch8.account-probe`（固定Rust908），本叶未启动或修改artifact。

root实际908在线首次已读`%TEMP%/pc-account-online-first-90832022-out/result.json`：sourceBefore/After同908，wall1583ms；2 fixture前置检查过，phase preflight TypeError，completed=false，没有截图/网页网络/Chrome进程，因此此次不是apiGuard失败，也不能称2/2用户路径通过。自有6341/42均listening=false/sockets0，fixture.closed/childClosed=true，profileRemoved=true。root只读最小复现定位当前已装puppeteer.executablePath返回Promise，旧getChromePath将Promise传fs.access导致ERR_INVALID_ARG_TYPE。本次精确只加await，不改其它2e82冻结源；guard缺口仍有独立pure首红，不能倒填为本次实际first原因。

最小独立验证在2e82+该一行修改上用`node --input-type=module`直接import已装puppeteer/fs/assert，`await executablePath()`后断言typeof为string并实际fs.access；exit0、wall153ms，raw`%TEMP%/pc-account-chrome-path-await.log`，未输出Chrome路径/凭据、未启动浏览器或监听，无重跑。probe node --check/diff --check过，未再次执行在线/桌面/full/type；该纯文件发现修复不冒称页面链通过。原908结果与日志由root完整保留。

## 账号入口棘轮资产补齐

root固定0c66feb181df28711dae7161d7528023f323eeca首次full：5301/5295通过/2失败/4跳过、75.165s，raw `%TEMP%/pc-account-user-stage-0c66feb1-full.log`。本叶不重跑全量。两失败分别是旧C10-RA-01把已批准账号入口当成本机增项，以及C10A-API-03未登记apiGuard实际产物的editor/session、editor/renew精确字面量；此前764仅5条登记不足，保留该首红，不用type绿盖过。

本块只改server/test/c10a-online-api-paths.json、c10-api-ratchet-baseline.json、c10-ui-gates.test.mjs与本报告。精确登记7条：editor/动态拼接字面量、editor/renew、editor/session、login、logout、me、projects；来源account-binding-task.md/account-binding-contract.md及真实client/apiGuard。旧本机baseline从历史集合只删至现19条，账号7条独立accountPaths并在测试中固定集合；unknown/account editor/login或recover、原已删ai/chat、任意本机增项及重复均拒。允许继续删除旧本机项，scanner及真实构建逐条相等断言未变，不修改apiGuard或扩大工具/API授权。下一步固定源，仅一次npm wrapper运行c10-ui-gates与c10a-online-build两文件，Vite实际在线/桌面构建只写TMP；无浏览器/业务listener/full。

固定b8e60380ef9ff1ca46ee1dca8293d46209264ac3一次目标：`npm.cmd test -- server/test/c10-ui-gates.test.mjs server/test/c10a-online-build.test.mjs`，17/17通过、零失败取消跳过、3702.3346ms、wall3982ms、exit0、native重跑0，raw `%TEMP%/pc-account-ratchet-seven-1.log`。真实Vite在线及桌面构建成功，产物扫描7账号+19旧本机路径精确一致；未知账号/桌面账号恢复入口/旧本机增项/重复负向均过。测前后source b8e60380不变且clean。只使用原npm guards，无浏览器或业务listener，未全量、未另跑types；测试资产修改不借此前type/full当本块独立证据。

root同0c66在线首次63.010s completed=false：真实me/login/session200、新建201/account session200，进入编辑器超时；failure-1显示连接云端失败，stageDocuments为空。raw `%TEMP%/pc-account-online-first-0c66feb1-out/result.json`及failure-1.png由root保留，Chrome/fixture/端口实际关闭。此为真实用户链未通过，与上面棘轮build修正分开。下一步仅静态查accountWS协议/握手，补探针安全HTTP握手status/pathname、消息type、close code，不输出URL完整query、headers、protocol票据或完整frame；不自行启动fixture/Chrome，不凭推断改生产权限或ready。

## 真实浏览器握手诊断补充

root授权仅给pages probe补安全CDP元数据：真实/hosted/ WS创建、握手HTTP status/pathname、文本消息type、close frame两字节code及closed/frame-error标记。CDP在页面导航前Network.enable，普通在线页与实际native main共用，teardown detach；没有替换WebSocket/fetch/native、没有读取或落盘完整URL/query、headers/protocol/ticket/frame正文/close reason。若Chrome握手本地拒绝而没有close frame，仅记closed而不捏造close code。node --check/diff --check通过，尚未运行fixture/浏览器，此增量不是实际握手已测证据。

静态定位：syncManager.ts enterAccountProject初连只返回account票据protocol，session-link.mjs只追加session.new；service.mjs仅offered包含promptcut.v1才echo，ws.mjs否则不回Sec-WebSocket-Protocol。G真实WSS fixture明确提供v1+account并断言服务回v1，因此纯fixture已过不证明原新页面实际offer正确。root确认这是新入口遗漏既有标准协议，随后批准最窄补初连/恢复v1，生产修复将另独立提交并用真实SyncLink socket pure目标验证；不改服务Cookie/ACL/ready或代理安全规则。

安全握手诊断固定35d94a48584179229b800a82af8712d73afa1bb0，仅probe/报告。实际传输协议修复固定47b1ac3882ce7f8de9f4f0f03dfdc45070d9a8eb：client.ts新增accountConnectionProtocols，syncManager初连/恢复共用标准v1+当前账号票据；reconnect.test.mjs通过真实SyncLink/createDocEndpoint捕捉实际受控WebSocket constructor参数与消息。没有改服务端协议echo、Cookie/鉴权/ACL/ready、LAN连接、全局测试配置或G夹具。

固定47b一次纯目标 `npm.cmd test -- src/editor/sync/reconnect.test.mjs src/account/client.test.mjs`：9/9、零失败取消跳过、427.3331ms、wall713ms、exit0、native重跑0，raw `%TEMP%/pc-account-ws-v1-pure-1.log`。新增断言初次实际socket含v1/account/session.new，欢迎后project.open有正确projectId及seq1；断传输后resume现取更新票据、仍有v1及原sid/ack，欢迎ack1后不重open或重放已确认消息。受控Socket只在内存，无监听；client凭据接口仍受控fetch/native，不是浏览器/壳完整通过。实际root0c66首次连接失败截图与日志保留，静态因果被root确认后才修，不声称用pure证据推翻首次失败。

同47b强制type `node <主仓库node_modules>/typescript/bin/tsc -b --force`：exit0零错、wall6488ms，raw `%TEMP%/pc-account-ws-v1-type-1.log`。两次测前后source同47b、clean，未启动业务服务/Chrome/桌面exe/TLS fixture/full，也没有节点/环境/依赖操作。后续需要root共同源重建并实际在线/桌面复验；新增CDP观察仅nodecheck，尚未在Chrome验证，保持这项证据边界。

## 两舞台真实请求等待

root固定4adc实际在线首次4.117s，协议修复后A新建201/session200/真实101，收到session.welcome与project.open/opened，已进入编辑器并取得可见项目链接与新projectId。唯一失败为both-compiled-stage-policy-origins-used：DOM已存在两iframe，但断言当刻stageDocuments仅6341 GET。原探针先等待DOM插入后立刻断言服务器网络记录，不能保证第二次HTTP请求已到达。最窄只在该原断言前复用已有有界waitFor等待6341与6342两条真实stage GET，不伪造记录、不放宽两来源要求、不修改舞台政策/产品/超时。等待仍超时则保留同名失败，不以DOM替代网络证据。node --check/diff --check通过；本叶未启动listener/Chrome/full，真实重验仍由root安排，首次4adc结果保留。

另root桌面首次0c66因隔离USERPROFILE使Puppeteer定位TMP空cache而fs.access失败，native尚未启动；root将为测试子进程显式设置现成Chrome的PUPPETEER_EXECUTABLE_PATH。这是root测试进程配置原因，本次不改getChromePath/产品、不安装Chrome，也不声称nativeIPC已有通过证据。
