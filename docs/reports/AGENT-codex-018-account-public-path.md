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
