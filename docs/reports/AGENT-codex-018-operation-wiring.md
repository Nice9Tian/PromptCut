# 真实项目操作的可信顺序接线

基底74a6b67c，独占分支codex/018-operation-wiring。范围为project.mjs、actor.mjs、新operation-wiring.mjs、专属operation-wiring测试/探针和本报告；既有password-order/history若需接口扩展先向根说明。中央装配、其它owner、VH和部署不改。0.7.18仅记录完整历史与可信顺序，不实现补偿或新UI。

验收目标：真实WebSocket两个页面经project.op写原项目store；账号身份只从连接principal取得；v2在同一项目提交锁中核实时权限、完整prepared持久化、reserve、再核fence、seal签名、accepted持久化、原store持久落地后才ok/广播。LAN v1保持现状。重启只恢复同一prepared，sealed ACK丢失不重新工具或模型；未sealed失权不得恢复落地。历史SQLite和原store之间明确权威及恢复协议，不以两份最终一致代替原子性证明。fence先关闭后续提交，实际收口后才完成ACK。

现状只读发现：project.op目前同步append日志后更新内存与广播；createFileStore.append是appendFileSync而非fsync，writeBlob/rewrite有原子刷盘。既有order coordinator只materialize历史SQLite镜像。需要把原store写入纳入已接受记录的恢复阶段，不能只在project.op外层等待旧coordinator并默认镜像一致。

预定三级机制候选：以已验签accepted历史及其完整before/after/提交元数据为恢复权威，原project store为持久可校验投影；同项目锁覆盖准备基准读取、接受、原store刷盘与可见性。任何缺证据或未知较新原store状态失败关闭，不覆盖猜测。具体接口读完现状后交根审查。所有反例/故障原始日志与临时账号、项目、证书置系统TMP，仅操作自身子进程并等close。独占端口5760–5769开前核空。

验证计划：先真实旧路径反例，再受控WS/crash矩阵、定向npm、类型与一次完整npm；每次失败完整保留。原模块级故障证明仅作前置，不能当本次生产接线已通过。根负责最终中央挂载与节点密钥隔离，本包不自行宣告项目结束。

首反例 `TMP/promptcut-operation-wiring-before.{mjs,log}` 真实两个WS、createFileStore、原projectModule：注入拒绝协调器但gate调用0，project.op.ok rev1、另一页收到广播，重建projectModule仍读到修改；actor缺accountId。exit0表示反例的断言通过，不表示旧生产接线正确。

根批准窄扩password-order的transact/materializeAccepted，以及history显式基准rev。另initializeProject回调在同一锁内登记真实原store基准；历史缺失但原store已带orderProjection标记时拒绝重建。LAN路径不改；尚未中央挂接的v2只读沿用既有authority gate，v2 project.op缺协调器明确order-unavailable；已经有orderProjection的项目缺协调器连读取也拒绝。首次接线定向 `TMP/promptcut-operation-wiring-target-1.log` 2/2、exit0、10210.0445ms，验证实际账号provider/credential与doc authority、真实双WS、完整原store快照、身份伪造忽略、同op不同actor拒绝、重启恢复。此时尚未完成crash/fence全矩阵，不能作为最终验收。

持久投影通过原store.writeBlob的临时文件fsync+rename，再显式fsync实际目标、Linux父目录fsync、原store及文件双读回全字段校验；Windows目录descriptor不支持，单独标示耐久边界，不能声称Windows断电目录项保证。恢复投影只读完整prepared/result，不执行外部工具。生产组装接口为createOperationWiring({history,account,verifyWitness,authority,projection,docAuthorityId,runProvider?,...})，传入projectModule({operationCoordinator})；runProvider缺失拒绝run，不默认retained授权。其余中央挂载由根处理。

第二块增加同锁内ok/广播、立即assertUnfenced入口检查、受影响真实WS退订/关闭和分片发送取消。fence成功仍需已接受完整投影及acknowledgeFence持久ACK；没有提供ACK不会宣称完成。beforeProjection也完整保留原store的writers/history/opIds等，落地前除body/rev还核这些基准元数据。原store已rename但未完成回包的重试仍重新完成fsync，不能以读回代替耐久。未恢复或投影失败时内部bodyOf隐藏，外部project.open走同锁恢复。

`TMP/promptcut-operation-wiring-target-2.log` 50/50、exit0、13175.0763ms（原LAN project ops、旧order核心、真实接线及19实际子进程切点）；`...target-3.log` 40/40、exit0、13284.3342ms（更多拒绝/损坏边界，以及旧actual-provider33切点）；`...target-4.log` 58/58、exit0、15682.505ms（原LAN回归、接线核心、扩展至25真实子进程切点）。每个新切点都实际exit73并等ChildProcess close后重开SQLite和原store，未seal保持基准rev1，sealed重建准确rev2，工具结果外部日志始终一条；含fence请求/提交/ACK前后重启，fence仍拒新写。受控stop/private/delete、ACK丢失、原store失败、成员权限rw→r、旧凭证撤销、时钟100→90、两页并发、另账号同值写版本均有正反断言。损坏较新投影/同rev内容/actor、缺prepared journal、缺account witness、缺history全部needs-reconciliation且不覆盖原store。

本包provider固定只读foundation580bec81325e09a92a805f8d33bb7353a45503d8、order7eab5535462ebb1980d37be7579f419d382e3efa，测试经真实SQLite/credentials/authority接口调用；账号transport在本包fixture内直接调用，不能冒称新增mTLS传输证明（其真实传输由已收foundation包与根中央挂接覆盖）。`TMP/promptcut-operation-wiring-types-1.log` 类型0错、exit0、工具wall7.4654s。完整npm等待root全量端口lease，不与其它owner全量相撞；上述测试尚未替代最终固定源码全量。

根扩租 `scripts/probes/operation-wiring-probe.mjs` 后新增两张实际Chromium页面（两个独立BrowserContext、不同账号），仍只访问自建fixture，不是生产UI验收。`TMP/promptcut-operation-wiring-browser-1.log` exit0、519.4845ms，Chrome/152.0.7977.75：reserve门控期间原store rev1、ok0、广播0；放行后账号A写rev2、账号B同值写rev3且保留版本依赖，重启原store+SQLite再经页面WS打开得到rev3/2条accepted，伪造actor未采用。浏览器自建TMP profile，完成后等待自己的Browser ChildProcess close；fixture先关真实socket、再等coordinator idle，最后关SQLite，未操作其他进程。root已移交全量lease，最终提交冻结后开始完整npm，首结果保留。
