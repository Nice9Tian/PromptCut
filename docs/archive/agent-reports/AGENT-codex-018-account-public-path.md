# 实际公网账号用户路径探针

开工基底86c810a1216cbfe1f03e9c3cdf482ca365bf0798，独占018-account-public-path工作区与codex/018-account-public-path分支。只写新公网探针、获准专属纯helper/test和本报告，不改产品。根租6500～6509；本叶不启动listener/浏览器/壳，不运行生产注册/项目动作，最终由根运行固定探针。

已读AGENTS开发索引/约束、账号绑定任务/契约相关语义、原account-user-pages-probe与root实际e22ff7f6桌面28项结果。旧探针明确只隔离本地fixture，不能冒充公网验证。新探针将固定https://visuhive.com真实安装页面/服务，两隔离浏览器上下文真实注册随机账号，A登录在线编辑器创建、B取得可见真实链接加入；双方新的官网会话核权威projectId/name与owned/joined，并核网站Cookie恢复编辑器。密码/CSRF/token只RAM，截图先真实键盘清空密码且验证为空；不fetch/native/ready mock、无TLS跳过、无生产删除。

运行边界：默认dry-preflight只校本地参数/已装Chrome/冻结源，没有网络或浏览器；真实生产动作必须显式--run-public，由根发起。结果只记录阶段、HTTP状态/路径、消息type/close code、测试账号名/项目ID等精确归属标识；不记录密码、票据、Cookie、完整URL query或frames。失败原样保留，不自动重跑注册/创建；不把尚未切换后的503记成通过，不删除测试账号/项目，后续清理由根按精确归属标识处理。

静态native阻塞：旧已编译e22.account-probe壳的可信Rust account_editor_port仅允许6340～6347，account_cloud_binding仅允许精确https://127.0.0.1:6388且必pin；不能仅改ENV迁6500或公网，不能用生产identifier回落5210、代理TLS或忽略证书掩盖。已向根报告最小可核选择：另准备保持生产行为不变的唯一隔离测试壳，测试binding精确允许6500/真实visuhive系统CA，cap只main6500，舞台6501/6502、CDP6508；本叶只消费根提供的产物/源等价证据。旧exe优先复用须以真实支持该绑定为条件，否则preflight明确blocked-native-config，不能冒称桌面已测。

专属纯helper/test已向根申请scripts/probes/lib/account-public-path.mjs与scripts/probes/account-public-user-pages-probe.test.mjs；先报告，再实施。没有公网动作、节点/部署、安装、系统CA/代理/DNS/用户端口/用户数据/剪贴板操作。未决调度/删除产品语义不裁定。

## 已实施窄隔离条件与真实首红

根确认阻塞判断并明确扩租lib.rs，仅两个隔离条件函数与实际边界断言；同意两专属helper/test。现在测试identifier `.account-probe`额外只允许精确6500（已有stage派生6501/6502不改），6501/6509等直接作为editor入口均拒；正式identifier仍固定5210、不受ENV覆盖。测试cloud origin精确为https://visuhive.com且pin缺省时使用已有系统CA路径；任意http/www/尾斜线/其它host/其它port或public额外pin均拒；原6388 fixture仍必须严格64小写pin。不是任意端口/TLS旁路，正式产品行为未变，不改stage/main/原生凭据安全模块。

固定2d367f3b2b7a39d450341ef421678bc3de4f2bdf首红：`npm.cmd test -- scripts/probes/account-public-user-pages-probe.test.mjs`，3项/2通过/1失败/0取消跳过、769.7401ms、wall1038ms、exit1、native重跑0，raw `%TEMP%/pc-account-public-pure-red.log`。直接提取真实lib.rs的两个函数、EDITOR_PORT常量和原inline测试（补了边界断言），经隐藏rustc --test在自TMP编译并实际执行；原6500返回Err导致Rust单测101。没有Tauri GUI/cargo/HTTP/浏览器，首红保留。01d591d389ea586c64eebe724ced6d4d76fe1857修上述两函数。

源码Git对象比对e22ff7f6到开工86c810a1：Rust src/build.rs/Cargo.toml/Cargo.lock无差异。旧e22.exe实际SHA256为64f12b5cb86e50cc71e3acd9e99bd1f4f7a99d5504d2e74a681bb1749f7919a2，符合根归档，但其隔离条件不支持6500/public，不能用它声称本期公网壳通过。新增条件必须由根另编唯一identifier、仅main6500 capability、TMP源/输出，旧28项只是本地fixture历史证据。

## 公网探针行为与使用

新入口account-public-user-pages-probe.mjs第一import为no-user-dirs，固定公共origin且不接受host/password参数。默认或--dry-preflight只核本地已装Chrome文件路径/冻结源与可选native产物，不启动浏览器、不联系生产。--run-public才创建两个随机pcpub标识账号，密码随机只RAM；通过实际网站register表单/在线editor登录、A创建显示链接/B加入、双方fresh网站会话登录列表、同网站Cookie恢复editor。结果只保存account名称/精确新accountId/projectId/name供根后续准确处理，项目链接不含旧share/key；不会删除任何生产账号或项目。真实服务503/UI错误会导致原阶段失败，未知错误文字不落盘。

在线验证使用真实已安装editor/site与实际HTTPS阶段iframe，核两个不同HTTPS舞台origin的真实GET200、真实create响应ID与可见链接一致、join相同ID、权威owned/joined项目ID/name。保留旧已验证输入Ctrl+A/Backspace、等待实际submit enabled、固定UI诊断、安全截图清密码及实际WS101/message type/close code，未mock request/native/ready、未忽略TLS、未读/写OS剪贴板。独立Chrome contexts使用正常权限拒绝走产品可见链接fallback，资源诊断仅path/status/MIME而无query/header/body秘密。

可选native参数：--desktop-exe `<TMP exe>` --desktop-sha256 `<root精确64小写hash>` --desktop-source-root `<TMP实际编译仓库根>` --desktop-profile-root `<尚不存在的TMP child>`。preflight核exe完整hash，并逐字核TMP编译源的lib.rs/account_vault.rs/build.rs/Cargo.toml/Cargo.lock与当前冻结源，不接受旧已编exe假称新源；root测试Tauri config/identifier/cap单独由根核。根须预启动仅自有Vite6500及stage6501/6502，生产origin真https://visuhive.com，WebView2 CDP6508。隔离USERPROFILE/APPDATA/LOCALAPPDATA/TMP及标准子目录在own profile；实际configuration IPC核main/agent存在、公网origin、agent调用账号桥被拒。复用原实际28路径：A桌面登录创建、--quit等PID树/6508实际关闭、相同私有profile重开DPAPI恢复A、实际UI退出→B登录凭链接加入、两fresh网站列表核native项目。可选native在在线路径之后，沿用同两账号另一个精确标记项目。没有Security.setIgnoreCertificateErrors、无6388代理、无用户安装。

命令：默认预检 `node scripts/probes/account-public-user-pages-probe.mjs --dry-preflight --out <新TMP child>`；根实际线上窗口 `node scripts/probes/account-public-user-pages-probe.mjs --run-public --out <新TMP child>`，native另附上述四参数。out拒覆盖旧目录，profile必须新建且与evidence分开；保留首失败截图/raw，生产测试记录绝不自动清理或重试。退出时只关自己contexts/Chrome/唯一TMP壳，Windows以PID/parent公开元数据核自有树实际结束，不查询cmdline；归属未知则保留失败/目录，仍请求自己壳--quit，不结束别人的进程。仅own profile曾由本探针创建且资源关闭后才清，native预检拒绝时不删除调用者已有目录。证据JSON/截图与启动stderr保留在TMP。

## 已执行与未执行

固定40dde513fc7e85680da77d12d22ac2af18d94824一次pure目标4/4、0失败取消跳过、865.6661ms、wall1128ms、exit0、native重跑0；raw `%TEMP%/pc-account-public-pure-green.log`。包括参数显式写入/路径限制、资源query秘密丢弃/严格project链接、真实Rust编译执行边界目标、实际新CLI dry中browser not-started/network空/accountNames和ownedProjects未产生。原npm wrapper38坏端口guard保留；没有自建业务listener/Chrome/壳/公网。另同40dde独立dry命令exit0、wall185ms（probe内部31ms），raw `%TEMP%/pc-account-public-dry-40dde513.log`及out/result.json：checks0、completed=false、dryPreflightPassed=true、source unchanged、public not-contacted，不能把预检当用户路径通过。

随后只补own进程树关闭与权威列表有界等待、未完成response body应先随浏览器关闭再收口，以及public-run结果分类；这些行为需要根真实窗口验证，当前未执行Browser/GUI路径。固定1a4b42becc7e70a4a1f59c08e7a7045d6b26d7e5的一次pure复验4/4、0失败取消跳过、501.1601ms、wall768ms、exit0、native重跑0，raw `%TEMP%/pc-account-public-pure-final.log`；source before/after同一SHA且clean。该证据早于下述native观测修正，不冒用为新源码结果。

## 最终静态自查修正与冻结证据

静态查src/account/client.ts真实分支：desktop模式全部request由native桥发送，原生HTTPS不会出现在CDP页面Network。新probe初稿enterNewProject/joinProject误将在线CDP create/join响应等待复用于native，虽没有执行native，也会错误超时；这是本叶探针错误，不是生产账号接口错误。8401396e4bf708930617194e9736428def703bb2仅修观测：在线仍要求真实HTTP create/join ID，两个分支均核真实收到WSS project.state.projectId；native结合实际可见链接和后续官网fresh会话owned/joined精确projectId/name验证。server/docservice/modules/project.mjs的open返回真实project.state顶层projectId，绝不使用页面自报数据或mock网络。

CDP只从project.state收到/ project.open发出的真实文本帧提取严格sp_加26位base32公开项目ID，附消息type；所有正文、actor、sid、ticket、错误reason都丢弃。纯目标增加invalid JSON/null/type/含query项目ID拒绝和秘密字段不留存断言，不把该纯测试算WSS握手通过。840固定源码一次`npm.cmd test -- scripts/probes/account-public-user-pages-probe.test.mjs`：5项/5通过/0失败取消跳过、502.851ms、wall758ms、exit0、native重跑0；raw `%TEMP%/pc-account-public-pure-state-8401396e.log`。before/after均8401396e4bf708930617194e9736428def703bb2且clean；wrapper原38坏端口guards不绕开，无业务listener、Chrome、native或公网HTTP。真实Rust函数加其inline边界断言仍经rustc编译和实际执行，但未cargo/Tauri构建或实际IPC。

所有三.mjs node --check与git diff --check通过。末次6500～6509检查无listener。本叶只五文件变动：lib.rs两个隔离条件及实际断言、新公共页面探针、纯helper、专属pure目标、本报告；未改网站/服务器/凭据vault/stage/渲染/Agent/旧探针。报告最终提交只追加证据，不再更改上述840源码。

实际公网用户路径、真实Chrome/WebView2、root新TMP壳构建/IPC、实际6500～6509服务器、整套npm/type/build、生产账号创建与项目写入、节点部署均未由本叶运行。无需依赖切换前503推断成功；必须由根以固定源码按--run-public运行，原生须先有新的精确6500/public系统CA隔离构建，旧e22.exe不合条件。cleanup只关闭本探针own资源并清自建profile，保留evidence/未知进程归属目录；不会删除任何公网测试账号/项目。最终用户路径是否通过，待根真实结果独立认定。

## 根公网首败与探针初始化窄修

根实际f20公网首轮7.25秒，9检查8通过/1失败：register-0成功，register-1没有POST便real-registered失败；ownedAccounts为空。根原始`%TEMP%/pc-account-public-f20e318c-first.log`及`%TEMP%/pc-account-public-f20e318c-first-out/result.json`/截图保留，Chrome/Vite6500～6502由根实际close，native未跑；实际留下1测试账号、无项目，本叶不删任何生产账号/日志/数据。这里是根执行结果，不是本叶运行。

源码事实更正：f20 registerAccount原本每次createBrowserContext并contexts.push，并非defaultBrowserContext；Cookie共享诊断不成立。网站site/assets/account.js的register在await fillWho()后才addEventListener submit，而原probe只等domcontentloaded就填/点击，未等初始化和真实handler。HTML默认GET、初始按钮可用使未初始化表单有原生GET窗口；不保存或打印其query/输入值。根确认真实初始化race并将另派VH页面安全小修，本叶不跨租修改网站或用probe绿掩盖其产品窗口。

固定72ac4ad70ca16ecaa4b3b2d53c00630655859dbe：保留独立context并加非default/不复用对象、page所属context实际断言；填写前等正常/me返回匿名、真实nav显示login/register、实际submit按钮enabled，以及CDP DOMDebugger只读确认现存form的submit listener。没有注入handler、DOM值、fetch拦截或读Cookie；只有监听真实已安装逻辑完成后才按原输入/点击提交。该DOMDebugger接缝尚待根真实浏览器复验，纯目标不冒称通过。

实际v2后端account/app.mjs的POST/register返回嵌套account.id/name，原字段本身正确，不是top-level accountId。异步CDP response.json可能因成功导航失效，因此新增页面正常/me响应作为公共ID回填，不添加API请求；只接受精确pcpub marker对应的严格acc_24位hex，去重记录accountId+marker，session/CSRF/其它字段丢弃。register成功后必须页面name匹配且真实/me公共ID已记，便于根精确处理测试数据；任意top-level ID、非自身marker、畸形ID一律不记录。

同72ac一次纯npm wrapper目标6/6，0失败取消跳过，762.744ms、wall1028ms、exit0、native重跑0；before/after同SHA、clean，raw `%TEMP%/pc-account-public-register-pure-72ac4ad7.log`。包含真实Rust边界编译执行、实际dry CLI零网络、公共account字段严格筛选负向；没有Chrome/网站/壳/公网注册或业务listener，原wrapper保护guards保留。三个.mjs node --check、git diff --check通过。随后只报告提交，未更改Rust或其它产品文件，等根固定后一次真实公网复验，不自行重跑。

根指出DOMDebugger objectId必须属于同一CDP session，7aa54d1141f8e9f16f732e51507fdb05d5056d5e窄修单probe文件：用registrationCdp Runtime.evaluate只读获得现存form对象，在同session getEventListeners并finally releaseObject。不用Puppeteer主session ElementHandle ID，不注入DOM/handler。一次纯目标6/6、0fail/skip/cancel、502.2813ms、wall764ms、exit0、native重跑0，raw `%TEMP%/pc-public-register-cdp-pure-7aa54d11.log`；source clean，nodecheck/diffcheck通过。未真实浏览器/业务listener/公网，之后只报告再冻结；网站产品初始化风险仍待新VH独立叶修正。

## 根公网第二轮未完成与真实控件等待窄修

根固定9ccdcf3bb1767a89d4761c6926f7acc684984ee8第二轮实际退出1、wrapper wall69.812秒（result内部66802ms）。已执行16检查均通过、0检查失败，但completed=false，phase online-a-create、TimeoutError；不能称完整路径16/16通过。两个真实测试账号注册成功，公开精确ID已由result记录，ownedProjects为空；编辑器/me/login/editor-session/projects均200，没有create请求或WSS，desktop not-run。首轮f20失败与第二轮`%TEMP%/pc-account-public-9ccdcf3b-second.log`、`%TEMP%/pc-account-public-9ccdcf3b-second-out/result.json`及截图全部保留；自有Chrome/Vite6500～6502实际关闭由根报告，本叶没有公网执行或删除这些账号。

只读定位src/account/AccountProjects.tsx：登录先setAccount(current)让账号名称出现，再await refreshLists()；外层perform的finally才setBusy(false)。第二轮最后account-name completed诊断真实为submitDisabled=true、busy=processing、errorCode=none。原probe loginEditor只等账号名称便返回，enterNewProject直接输入/点击cloud-create，没有等busy解除，所以disabled点击无动作，之后等待编辑器超时。截图时序须区分：online-a-logged-in是处理中的早截图；failure-3最终实际已填本次marker项目名、create/join已启用，不能把它描述成一直未命名或一直disabled。该定位不要求修改产品登录、列表或请求流程。

0e0b845756605e41f4958f935eaee666f6c889e8先提交两项实际探针函数反例：从当前probe读取并执行enterNewProject/joinProject，受控DOM控件保持disabled，观察到两函数均过早填写。一次原npm wrapper纯目标8项/6通过/2失败/0取消跳过、588.8919ms、wall855ms、exit1，raw `%TEMP%/pc-public-enabled-controls-red.log`。它是无业务listener的受控时序反例，不是新增公网执行；原全局坏端口保护guard照常保留。

7c6ae634cf6c3745998c179fa08303862842b4ca只改三个探针文件：lib新增waitForEnabledForm读取真实可见按钮/输入的disabled/readOnly和现存账号名称；create/join填写前等待真实可用、填写后再次等待再按原page.click提交。保持原TIMEOUT、真实键盘清空/填写、进入编辑器、真实响应ID/WSS项目状态及网站权威列表断言，不强改disabled、不注入handler/输入值、不增加失败写入重试。固定projectSteps记录create/join的form-ready、input、submit-ready、click、editor阶段，只记可见性、禁用状态、已知busy/error分类，不记输入值、用户名、密码、query、ticket或任意DOM文本。

官网登录使用与注册相同的真实匿名/me完成、匿名nav、可用控件和同CDP session现存submit listener检查，填写后再核enabled才真实提交；注册原检查保留并统一该小接缝。固定websiteSteps只记goto-login、login-form-ready、username/password-input、submit-ready、submit阶段，以及form/input/button可见和disabled/anonymousNav布尔，不保存实际字段值。网站已由根独立修复HTML敏感表单初始化安全窗口，探针等待不代替该产品修复，也不修改或访问已经清理的VH工作区。

同7c6一次`npm.cmd test -- scripts/probes/account-public-user-pages-probe.test.mjs`纯目标10/10、0失败取消跳过、512.0005ms、wall768ms、exit0、native重跑0，raw `%TEMP%/pc-public-enabled-controls-green-7c6ae634.log`。source before/after均7c6ae634cf6c3745998c179fa08303862842b4ca，工作区clean。实际函数反例转绿：控件未启用时不填写；填写期间另一个disabled窗口出现时不点击；官网真实函数在受控匿名初始化/现存handler未就绪时不填写，即使按钮可用仍等待handler；hidden/disabled/readOnly/无账号的真实浏览器predicate拒绝且不修改DOM。受控VM页和CDP adapter只用于纯时序测试，不能冒称Chrome、官网、实际/me、真实handler或实际用户路径已验证。既有实际Rust隔离函数编译执行、秘密筛选和实际dry CLI零网络目标继续通过。

三个.mjs node --check及git diff --check通过。本阶段相对9cc只变更probe/helper/test/本报告；desktop/src-tauri/src/lib.rs及所有产品代码逐字不变。命令环境仅该进程canonical PSModulePath、绝对file URL silent preload、cuda_Vit与主out/models；原npm wrapper的保护guard不mock。未跑TS/full/build、业务listener、Chrome/WebView2、native壳、节点或公网HTTP；没有权限/ready/Cookie/TLS旁路。最终报告提交只补证据，源码冻结，等待根以固定源实际第三轮；原失败不抹除，不自行重复公网注册。
