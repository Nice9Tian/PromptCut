# 真实项目操作的可信顺序接线

基底74a6b67c，独占分支codex/018-operation-wiring。范围为project.mjs、actor.mjs、新operation-wiring.mjs、专属operation-wiring测试/探针和本报告；既有password-order/history若需接口扩展先向根说明。中央装配、其它owner、VH和部署不改。0.7.18仅记录完整历史与可信顺序，不实现补偿或新UI。

验收目标：真实WebSocket两个页面经project.op写原项目store；账号身份只从连接principal取得；v2在同一项目提交锁中核实时权限、完整prepared持久化、reserve、再核fence、seal签名、accepted持久化、原store持久落地后才ok/广播。LAN v1保持现状。重启只恢复同一prepared，sealed ACK丢失不重新工具或模型；未sealed失权不得恢复落地。历史SQLite和原store之间明确权威及恢复协议，不以两份最终一致代替原子性证明。fence先关闭后续提交，实际收口后才完成ACK。

现状只读发现：project.op目前同步append日志后更新内存与广播；createFileStore.append是appendFileSync而非fsync，writeBlob/rewrite有原子刷盘。既有order coordinator只materialize历史SQLite镜像。需要把原store写入纳入已接受记录的恢复阶段，不能只在project.op外层等待旧coordinator并默认镜像一致。

预定三级机制候选：以已验签accepted历史及其完整before/after/提交元数据为恢复权威，原project store为持久可校验投影；同项目锁覆盖准备基准读取、接受、原store刷盘与可见性。任何缺证据或未知较新原store状态失败关闭，不覆盖猜测。具体接口读完现状后交根审查。所有反例/故障原始日志与临时账号、项目、证书置系统TMP，仅操作自身子进程并等close。独占端口5760–5769开前核空。

验证计划：先真实旧路径反例，再受控WS/crash矩阵、定向npm、类型与一次完整npm；每次失败完整保留。原模块级故障证明仅作前置，不能当本次生产接线已通过。根负责最终中央挂载与节点密钥隔离，本包不自行宣告项目结束。

首反例 `TMP/promptcut-operation-wiring-before.{mjs,log}` 真实两个WS、createFileStore、原projectModule：注入拒绝协调器但gate调用0，project.op.ok rev1、另一页收到广播，重建projectModule仍读到修改；actor缺accountId。exit0表示反例的断言通过，不表示旧生产接线正确。

根批准窄扩password-order的transact/materializeAccepted，以及history显式基准rev。另initializeProject回调在同一锁内登记真实原store基准；历史缺失但原store已带orderProjection标记时拒绝重建。LAN路径不改；尚未中央挂接的v2只读沿用既有authority gate，v2 project.op缺协调器明确order-unavailable；已经有orderProjection的项目缺协调器连读取也拒绝。首次接线定向 `TMP/promptcut-operation-wiring-target-1.log` 2/2、exit0、10210.0445ms，验证实际账号provider/credential与doc authority、真实双WS、完整原store快照、身份伪造忽略、同op不同actor拒绝、重启恢复。此时尚未完成crash/fence全矩阵，不能作为最终验收。

持久投影通过原store.writeBlob的临时文件fsync+rename，再显式fsync实际目标、Linux父目录fsync、原store及文件双读回全字段校验；Windows目录descriptor不支持，单独标示耐久边界，不能声称Windows断电目录项保证。恢复投影只读完整prepared/result，不执行外部工具。生产组装接口为createOperationWiring({history,account,verifyWitness,authority,projection,docAuthorityId,runProvider?,...})，传入projectModule({operationCoordinator})；runProvider缺失拒绝run，不默认retained授权。其余中央挂载由根处理。
