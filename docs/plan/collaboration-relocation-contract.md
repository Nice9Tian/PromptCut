# 协作房间搬迁契约

落实 `collaboration-reopen-recovery-plan.md` 的生命周期验收和 `../semantics/workflow/project.md` 已有搬迁动作。自动重开只恢复当前可信位置，不能启动搬迁或接管另一设备。创建者权限仍按 `../semantics/product/document-service.md` 的三项特权执行；本机源服务的物理参与是完整搬迁的条件，不额外把普通操作改成创建者特权。

## 目录与封锁

事务 ID 为 `move_` 加 32 位小写十六进制，房间 ID 沿用 `sp_` 加 26 位 base32。源代数从 1 起，目标代数严格加 1。目标包含规范化的已信任 `service`、`where`（lan/hosted）及 LAN 目标设备 ID；hosted 目标的 deviceId 为 null。最终清单含 projectRev、文档及权限记录摘要、完整素材清单摘要（SHA-256）。

`POST /hosting/relocation/{begin,ready,publish,state}` 的 Authorization 是登记密钥，不能以保存的校验摘要代替。begin/publish 使用当前源密钥；提交后的同事务源密钥只允许核对及幂等完成原事务，不能再登记或删房。ready 使用新目标密钥，state 可由同事务源或目标读取。所有请求精确核对房间、事务、代数、目的地及清单，冲突不改变原状态。begin 的 service 必须等于服务端固定配置身份。

目录 prepared 时旧线上能力立即撤销；目标 ready 之前 publish 拒绝。提交替换实际设备及登记校验值，保留原房间、非秘密位置和事务摘要。无搬迁记录的旧目录兼容代数 1；已知搬迁字段损坏则失败关闭。删除在任何阶段为最终状态，重试不能复活。

源账户记录增加可选 `relocation` 版本 1：roomId、txnId、phase（frozen/moved）、epoch/targetEpoch、target 和 manifest。目标安装期间使用 staging。记录先可靠写入再替换内存；已有页面、Agent、渲染节点、会话接续、邀请码和票据都检查当前记录。目标安装清除旧模块缓存及会话，尚未提交的目标不能认证。

## 私有数据传输和安装

`docservice/relocation/<txnId>/index.json` 及其文件只在服务器私有目录，不进入普通项目文件、静态服务、浏览器或报告。包括完整源账户记录和房间目录清单；全件素材用规范的 `/` 分隔相对路径及字节数/摘要表示。拒绝逃逸、符号链接、重复路径、清单摘要变化或素材名与内容摘要不符。临时文件独占创建、刷盘后原子替换，保留原房间和目标旧目录。安装未完成时保持 staging，重开仍不可接入，同事务可补齐。激活精确匹配可信目录发布结果并检查安装内容；后续幂等激活不覆盖新编辑。

云端部署组合接收 `/hosting/relocation/import-{init,index,file,complete,activate}`。init/index/complete/activate 是 POST JSON，file 是 PUT 流；roomId/txnId/path 查询参数不含秘密。所有端点先验证目录当前或同事务源登记权限。init 仅接受服务端自身的固定 hosted 目标，私有保存新登记密钥，返回摘要及目标设备；index 对照可信 prepared 清单，file 严格限定该清单中的路径、长度和 SHA-256。未完成文件不发布，已经验证的文件重试不覆盖。complete 校验完整暂存、安装并用目标密钥确认 ready；activate 只接受 committed 状态。目标启动后扫描自己的私有事务，已提交的事务自动激活并登记新位置。

源运输器仅向设备记录已信任的同一服务发送登记能力和私有清单，禁跟随重定向；网络/429/502/503/504 重试，控制请求超时 10 秒、单件传输超时 300 秒，有限即时重试后由持久搬迁任务从 500 毫秒退避至 30 秒重试。尊重 Retry-After；认证与契约冲突明确报告，不用新房间、新口令或解除源封锁来掩盖失败。

本机恢复 API 的 move-hosted/move-status 只允许真正本机来源及同源守卫。源凭证、设备绑定和服务身份取自设备保护存储；必须是实际源设备。支持页内启动、状态查询及服务重开后的自动续传；世代检查阻止旧页面启动迟到动作。已授权的持久搬迁不因页面离开而回滚，旧页面回调不能污染新项目。成功后现有统一协调器发现同房间的云端位置，另存文件更新 where，旧文件仍按可信目录恢复。

当前独立服务 HTTP 链路和实际「搬到云端」界面已经实现并有隔离验证；「搬回本机」的远程源授权/导出适配和界面接入仍在实施，不能据内部 LAN 目标安装测试声称完整双向流程已交付。具体结果以 `../reports/REPORT-collaboration-reopen-recovery.md` 的逐项验收为准。
