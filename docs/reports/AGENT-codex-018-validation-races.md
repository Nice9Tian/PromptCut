# 联合验收竞态

基底 `a9029eb3405f6b13574946392014c90adbaa2723`，独占分支 `codex/018-validation-races`。先处理collect-plugin素材夹具清理，再处理M7浏览器探针跨层观测。授权文件为fake-asset-service、collect-plugin测试及相关新增fixture/test，m7-browser-probe、m7-judge及对应诊断测试；不改其它生产文件，必要时先精确申请扩租。

原联合full第二轮4934/4932/1fail/1skip、78168.3187ms：collect-plugin after cleanup rmSync素材TMP根EPERM。事后没有原持锁者证据，不据残留目录编根因。原M7共同runner耗时877s仅两项fail：M7-A4三anchor与completed已到，但onlineDiag两层仍旧；D12第三层两份各5段仍有效/winner null。先区分观测时序与真实提交错误，不改用户已定舞台分源/素材隔离标准，不加任意sleep或盲重跑。

日志、证书、fixture产物只放系统TMP。端口独占5800–5809，开前核空；用户及其它任务端口禁碰。禁止push/merge/deploy/清其它任务数据，隐藏整条子进程链，不打印凭据。定向+types+完整npm以及相关定向和一次真正full M7保留首次结果/耗时，分块早提交。

## 素材夹具第一块

已证明生命周期缺口，而未证明原全量 EPERM 的具体持有者。真实 HTTP `?tiers=1` 返回后，实际 createTierManager 仍在后台等待其可执行程序查询；受控子进程 cwd 位于本 fixture TMP，由 IPC 显式放行。旧 HTTP close + 原 rmSync 顺序稳定得到 EPERM，childClosed=false；新 cleanup 到达 manager.idle 后仍不删除，放行实际 child close、最终 tiers 持久化后才删除。另以真实 HTTP 与延迟 `_destroy` 回调的 Readable 证明响应结束不能替代源流 close。

修复只在测试 harness：登记 middleware promise 与 pipe 源流 close；停止 HTTP 后等待这些工作、自己 root 的既有 tier manager.idle，以及 upload queue 停止与 working=false 后最后持久链。生产全局服务表只读取/移除本 fixture root，绝不创建新转码任务或操作其它根。rmSync 仍单次执行且错误传播。

第一次定向 `TMP/promptcut-validation-races-target-1.log`：20 tests、18 pass、0 fail、2 cancelled，exit1，60266.03ms。受控门控最初选 MP4，其可执行查询在同步重封装阶段，阻塞 HTTP，两个新测试各 30s timeout；after 释放拥有的子进程并清理。改为不走重封装的 MKV 后第二次 `TMP/promptcut-validation-races-target-2.log`：20/20、0 fail/cancel/skip，exit0，27522.1808ms；旧 rmSync 反例 23649.7141ms，新收口204.1557ms，流 close103.6962ms。新增负向 fixture 的上限改为60s以容纳 Windows 同步 rm 失败内置重试，并记 rmMs；既有 collect 语义、10s job 时限、原断言均不改。
