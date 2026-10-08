# 联合验收竞态

基底 `a9029eb3405f6b13574946392014c90adbaa2723`，独占分支 `codex/018-validation-races`。先处理collect-plugin素材夹具清理，再处理M7浏览器探针跨层观测。授权文件为fake-asset-service、collect-plugin测试及相关新增fixture/test，m7-browser-probe、m7-judge及对应诊断测试；不改其它生产文件，必要时先精确申请扩租。

原联合full第二轮4934/4932/1fail/1skip、78168.3187ms：collect-plugin after cleanup rmSync素材TMP根EPERM。事后没有原持锁者证据，不据残留目录编根因。原M7共同runner耗时877s仅两项fail：M7-A4三anchor与completed已到，但onlineDiag两层仍旧；D12第三层两份各5段仍有效/winner null。先区分观测时序与真实提交错误，不改用户已定舞台分源/素材隔离标准，不加任意sleep或盲重跑。

日志、证书、fixture产物只放系统TMP。端口独占5800–5809，开前核空；用户及其它任务端口禁碰。禁止push/merge/deploy/清其它任务数据，隐藏整条子进程链，不打印凭据。定向+types+完整npm以及相关定向和一次真正full M7保留首次结果/耗时，分块早提交。

## 素材夹具第一块

已证明生命周期缺口，而未证明原全量 EPERM 的具体持有者。真实 HTTP `?tiers=1` 返回后，实际 createTierManager 仍在后台等待其可执行程序查询；受控子进程 cwd 位于本 fixture TMP，由 IPC 显式放行。旧 HTTP close + 原 rmSync 顺序稳定得到 EPERM，childClosed=false；新 cleanup 到达 manager.idle 后仍不删除，放行实际 child close、最终 tiers 持久化后才删除。另以真实 HTTP 与延迟 `_destroy` 回调的 Readable 证明响应结束不能替代源流 close。

修复只在测试 harness：登记 middleware promise 与 pipe 源流 close；停止 HTTP 后等待这些工作、自己 root 的既有 tier manager.idle，以及 upload queue 停止与 working=false 后最后持久链。生产全局服务表只读取/移除本 fixture root，绝不创建新转码任务或操作其它根。rmSync 仍单次执行且错误传播。

第一次定向 `TMP/promptcut-validation-races-target-1.log`：20 tests、18 pass、0 fail、2 cancelled，exit1，60266.03ms。受控门控最初选 MP4，其可执行查询在同步重封装阶段，阻塞 HTTP，两个新测试各 30s timeout；after 释放拥有的子进程并清理。改为不走重封装的 MKV 后第二次 `TMP/promptcut-validation-races-target-2.log`：20/20、0 fail/cancel/skip，exit0，27522.1808ms；旧 rmSync 反例 23649.7141ms，新收口204.1557ms，流 close103.6962ms。新增负向 fixture 的上限改为60s以容纳 Windows 同步 rm 失败内置重试，并记 rmMs；既有 collect 语义、10s job 时限、原断言均不改。

源码7620aed4验收：`TMP/promptcut-validation-races-types-1.log` 类型0错，exit0，wall6847.5649ms；`TMP/promptcut-validation-races-full-1.log` 全量首次4936 tests /4935 pass /0 fail /0 cancelled /1 skip，duration77672.7596ms，wall78083.1568ms，exit0，没有自动重试。相比原失败全量的4934，去掉文件级after失败计数并新增3条。所有原业务断言保留，auth修复未触碰。此块不宣称原失败的唯一持锁者已证。

## M7 观测修复与受控反例

真实 createRenderQueue 反例已证：旁观采样先存 open，浏览器 claim 把异指纹整份 superseded；随后重复 publish 在同一轮先删 superseded 记录、再以 card-locked 拒建。下一次 describe 没有该任务，旧 god Map 不移除缺席项，故永久留下 open；延长 sleep 也无法修这个历史缓存。现在 D12 用当前 describe 优先；当前没有记录时必须同时有本页 publisher 实收 task.failed/error=superseded 与无指纹 watcher 最新 failed 终态才算作废。重新 opened 清掉 watcher 终态；当前仍 open/claimed/done、普通失败、只有消失、只有旧作废证据都不能过。旧纯判据 judgeDualClip 不变，逐任务把 sampled/current/publisher/watcher 证据写进结果。

真实 OnlineSnapshotSource 反例已证：初次层表只有 PC 候选，浏览器 markAlive 已发生而下一张候选层表回包被门控，debug 仍选 PC；放行真实 loadMap 后选 browser。现在 A4 在原 gateLift+600000ms 总截止内等待真实页面各重层指纹匹配，记录第一次样本、最终样本、次数、收敛耗时；时间本身不能判通过，持续错误有负向测试。完成耗时原值仍只记录，未恢复30s门槛。

M7定向第一次 `TMP/promptcut-validation-races-m7-target-1.log`：7/6/1fail、134.0971ms、exit1，新实队列fixture错用了带PC指纹观察者（它收到hidden而非failed）；改为原探针的无指纹观察者后 `...m7-target-2.log` 7/7、121.1975ms、exit0。实队列输出 sampled=open,current=null,published=card-locked,publisher=superseded,watcher=failed；真实页面来源两次采样 first=PC,last=browser。原877s日志没有这些逐任务证据，所以这里只证明可执行失败路径，不追认原两次fail的唯一根因；真实full M7仍待跑。

根协调者精确扩租既有 `server/test/m7-judge.test.mjs`。01521f94组合首验 types0/exit0/wall16879.7006ms；完整npm `TMP/promptcut-validation-races-full-2.log` exit1、wall97906.1341ms（计数如下次补记），唯一失败是 bakery-deps 的 server→scripts 依赖方向约束，新建 m7-observation.test 不在白名单。按根批准将4条实队列/真实来源控制测试并入已登记的 m7-judge.test，删除仅本包新文件；依赖守卫和白名单均不改。此次修改为明确失败修复后的必要复验，不因偶发失败反复重跑。

2a5ae175固定复验：定向+依赖守卫10/10、130.1101ms；types0，定向+types合计wall6120.7134ms；`TMP/promptcut-validation-races-full-3.log` 全量4940/4939pass/0fail/0cancel/1skip、77770.8906ms、wall78203.0255ms、exit0，无自动retry。补全上轮full-2：4940/4938pass/1fail/0cancel/1skip，97420.8639ms，唯一依赖方向失败。

### 根审查后的历史边界修正

在2a5在途完整M7期间仅于TMP跑独立反例、没有改在途源码或中断。`TMP/promptcut-validation-races-m7-review-counterexample.{mjs,log}` 真实队列依次superseded→同ID takeover重开(version又为1)→controlled-decode-error普通fail→推进600001ms过TTL，当前记录消失；旧历史superset与watcher最新failed会错误返回true。由此修复为：无指纹watcher必须从真实首次task.opened开始完整连续观察首代，同ID终态后opened/active snapshot进入下一代，初始snapshot、断线、epoch变更、隐藏或漏掉重开的迹象都不允许历史fallback。发布方改保存接收顺序seq、type、error、epoch、version（缺失明确null），采用最新终态，且epoch必须匹配；当前describe有记录仍是权威，普通failed绝不当superseded。

首轮真实M7（仍为2a5、尚未含此修正）`TMP/promptcut-validation-races-m7-full-1.log`：16项、54部分、fails=[]、pending=[]、aggregate ok=true，outer exit0、wall873683.6414ms、creator ms873442，角色exit creator0/node1。node单角色summary保留服务器专属项缺席为pending，all以creator并入双方实际parts后的完整账本判定；不把node退出码改写成0。A4首样本即三层browser、worstSinceGate20011ms仅记录；D12 pass。它只证明审查前源码，不能代替审查修正后的验收。

审查修正定向 `TMP/promptcut-validation-races-m7-target-4.log` 12/12、413.3233ms、exit0。包含真实重开/普通失败/TTL反例、真实瞬时删除正向、首snapshot(open/failed)、断线后snapshot、epoch变更、未见opened却taken、当前普通失败、错误publisher epoch/done的负向。
