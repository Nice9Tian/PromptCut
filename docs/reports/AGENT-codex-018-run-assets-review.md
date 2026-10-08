# 云 Agent 素材权限只读复核

基底 `7dab214f8dc521ef908141a06b14b7996520f1dd`，分支 `codex/018-run-assets-review`。独占仅本报告；所有产品、测试及其它工作区只读。先开工提交。

复核 createRunAssets/protocol/internal 三角色信任、epoch/nonce/scope、连续 outbox/ACK，与唯一 run provider/instance cap、worker run-resources/ToolJobs 调用链。区分具体源码缺陷与尚未挂生产 seam，不把模拟放行或未部署证明当已通过。

根保留的反例：A837 9/7/2（实例控制过宽、outbox gap）；909 wire UTF8 14/13/1；693 epoch旧工厂；worker3efa sequential retained 反例和 d462 因果修复。原始 `%TEMP%/pc-root-retained-sequential-{3efa,d462}.mjs/.log` 与 `pc-run-assets-mtls-1.log` 不覆盖。

当前仅允许 TMP 无监听纯 Node 反例，可使用真实模块/SQLite/注册 RAM key；不运行 npm wrapper、target/full、listen(0)、服务、探针、节点，不修改实现。进程环境遵守 cuda_Vit/模型路径/静默预加载约定，子进程隐藏；不输出秘密值。开工后读规则、设计与固定代码，再记录首个真实反例或明确通过/未测边界。

## 结论

固定 `7dab214f` 有一个已执行证明、应修复的连续 outbox 校验缺口：尾部事件缺失而 mirror/control 仍在时，当前实现返回倒退的“连续 head”，随后甚至复用旧序号，使已持有该 cursor 的消费者漏掉下一条真实 stop。这是受控持久数据损坏下的 fail-closed 缺陷；**未证明正常 SQLite WAL/FULL 提交或 crash 会产生该损坏，也未证明已部署服务发生泄漏**。没有修改实现或中断根在途测试。

worker d462 的连续 retained checkpoint 修复在同一固定候选中独立正向复验通过。三角色 TLS 原目标日志只读核验，未重新跑；中央/独立 UID/真实 OS 关闭及 B/G asset 数据链未挂载部分继续是待完成项，不是本报告声称已突破的漏洞。

## 必须修复：outbox 尾缺失与序号复用

精确位置 `server/account/run-assets.mjs:42` 的 `mirror()`：44–50 行只遍历现有 outbox 事件核其 seq 与 mirror；59行遇到已存在且摘要一致的 mirror 即 continue，没有核 mirror 对应的 outbox 事件仍在。60行用 `outbox.length + 1` 分配新序号。`eventsSince`（257行起）使用该数组长度作为 head，不能发现孤立 mirror 或已丢尾。

首次纯反例 `%TEMP%/pc-run-assets-review-7dab-counter.mjs` / `.log`，exit0：

1. 真实 `runFixture` 建 SQLite WAL/FULL，RAM Ed25519 key 注册，enqueue→admit→confirmRead，真实 stop→资产 mirror，head=1。
2. 通过 ledger transaction 对本 TMP 数据库受控 `pop()` 尾项，保留原 runControl 与 mirror；模拟持久逻辑损坏，不伪造权限通过。
3. `eventsSince(0)` 实际返回 head=0/events=[]，没有 `run-control-gap`；原 control/mirror 都仍为1，SQLite integrity=ok。

后果反例另存 `%TEMP%/pc-run-assets-review-7dab-tail-reuse.mjs` / `.log`，首exit0：在相同损坏后真实 enqueue 第二条、admit/read，再 stop 第二个 run；新事件 seq=1。旧消费者 `eventsSince(1)` 返回 head=1/events=[]，而第二个真实 grant 已 revoked。连续 consumer 会错过该新控制；不能靠数组现有位置等于 seq 就称连续。

两个反例均直接导入本叶固定产品与真实 SQLite/注册实例 fixture；资产 authenticate/observer/media/closure callbacks 均设置为抛错且未被调用，没有自建 free-allow。无监听、无 wrapper、无模型/工具调用，finally 关闭数据库并仅删除该次 fixture 自建 TMP。原始日志只安全计数、状态和 SQLite 配置，不含 key/proof/ticket。

必要修复边界：由 owner 在 `mirror()` 追加之前双向验证原 control、mirror 与 outbox 事件的一一映射、seq/摘要/位置；历史 ACK cursor 不能高于可信 head。已存在 mirror 却缺事件必须 `run-control-gap`，不能补一个新 seq 或缩小 head。新增回归至少涵盖尾丢、全空但 mirror非空、随后新增真实控制、已有 cursor不漏事件。该建议未在本叶实施，根/owner已收到源码位置与首反例。

## 已核范围与限制

| 范围 | 结论及证据强度 |
|---|---|
| 三角色入口 | 静态核 `run-assets-internal.mjs`：Agent只issue，asset才check/lease/events/ACK；各自pin不同、真实authorized exporter且无forwarded豁免；observer由可信resolver建立。原 `%TEMP%/pc-run-assets-mtls-1.log` 只读核1/1、896.9789ms；同进程真实TLS，不当中央/不同UID证明。 |
| 请求scope | 静态核 protocol exact shapes、fatal UTF8与原bodyText digest、method/path/Range/chunk/body/hash/ticket/resource/nonce绑定。instanceAuthority签完整request；资产回调只产生内部RAM cap，finally release；runProvider从持久grant重建身份。没有发现本次可复现的read→write提升。 |
| nonce/epoch | 首次nonce在签名/current/resource核验后与lease同SQLite事务claim；同nonce重放403、异请求409设计保留。已失doc epoch票据不复活，旧factory issue/check有requireOpen/atCommit门。正常restart不自报历史lease关闭。未把静态核验当新增实测矩阵。 |
| retained/private/stop | A仍调用唯一runProvider，atCommit比完整grant binding/state/fence/readReceipt；没有另造retained名单或creator例外。原已测项见owner日志，本次未用服务重跑。 |
| observer/closure/ACK | 静态核同observer socket+实例绑定，断连将admitted置unknown；lease关闭和control ACK要求独立closure verifier，ACK连续且同cursor同digest幂等；run control自身仍pending，不借资产receipt直接结束整体。真实OS/cgroup verifier缺失不算完成。 |
| worker→Jobs | 独立纯正向 `%TEMP%/pc-run-assets-review-7dab-retained.mjs` / `.log` 首exit0：真实SQLite/注册RAMkey/provider，经ToolRunContextAccess与createRunResources，credential retain到rev3，member retain到rev4；第二checkpoint得到job revision3/fence4/retained，随后update progress .4成功。复用根原反例算法，仅改固定导入路径与输出source，增加本次TMP关闭后清理；旧3efa/d462日志未动。 |
| 资源实际关闭 | 静态核 register先登记actualclose观察再两次实时authorize；fence同步abort，未close和pending registration都阻止complete；child需exit与close及独立tree witness。没有将ToolJobs cancelled解释成OS资源关闭。此轮未启动child/TLS资源矩阵。 |
| 尚未挂接 | 当前 createRunResources/createToolJobs 生产装配未完成；B ProjectAssets/asset实体流、G唯一中央remote-subject registry、current service checks、独立媒体selector、双日志consumer/closure receipt以及worker受限signer仍须各owner完成。缺这些不能启生产；仅接口缺失不报成现有越权。 |

## 执行记录与交接

开工报告 `339a9933`。本轮三个纯脚本均首次exit0（两个证明产品应拒却未拒的反例、一个修复正向），无重试；没有运行 npm/type/full/服务/probe/listen0，根共享租约不受影响。命令 process-only cuda_Vit/PYTHONDONTWRITEBYTECODE/models/静默预加载，未改全局环境或依赖。无子树留存；同步Node结束后工具返回exit0。其它全部源码只读，`git diff --check`通过；相对7dab仅本报告变化。报告源码基点不因报告提交改变。

root及A owner已收到首反例和seq复用后果。后续需owner窄修并在新固定源码复验，保留上述原反例；本次不自行修产品或借根全量结果宣告资产生产链完成。

## 修复后独立复验：df309b06

root将A固定修复 `56dbee2c`（产品 `07d0f222`）no-ff合入本叶，固定对象 `df309b06e0dbbee40383554065089040d1cad1db`。本轮只追加报告，产品/测试仍只读；执行前后 HEAD相同且工作区clean，原7dab脚本/log不覆盖。

新 `%TEMP%/pc-run-assets-review-df309-fixed-counter.mjs` / `.log` 首exit0，直接导入本叶固定真实模块，仍是SQLite/RAM key/runProvider，没有listener、free-allow或npm wrapper：

| 复验 | 实际结果 |
|---|---|
| 原tail loss | 原真实stop镜像head1后受控pop；`assert.rejects`精确核status503/code`run-control-gap`，不返回head0。 |
| 原seq reuse | 接着真实第二条enqueue/admit/read/stop；after=0及after=1都明确gap。事务后outbox仍0、mirror仍1、原真实controls为2；新control没有mirror，没有追加或复用seq。 |
| 无损正常连续流 | 独立新SQLite fixture两次真实run stop：seq严格[1,2]、head2，cursor1只返回第二个control；再次mirror结果完全相同。 |

拒绝是脚本内预期断言通过，不把抛异常误记成执行失败。新反例输出只case、code、计数；未打印身份秘密。两fixture finally实际关闭SQLite并只清本次自建TMP。

新 `%TEMP%/pc-run-assets-review-df309-retained.mjs` / `.log` 首exit0：保持原真实边界与算法，固定导入本叶，credential retain rev3→member retain rev4，第二checkpoint jobrev3/fence4/retained，随后update progress .4成功。ToolJobs/资源注册生产装配与网络仍未在此证明。

静态复核补丁确认 mirror在追加之前反向要求每个mirror对应位置上的event与原control一致，另核ACK cursor/receipt/digest归属当前event。**本报告原已证缺尾/seq复用问题在df309独立复验已解决，无该项剩余阻断。** 本轮未扩大到自然掉电、真实mTLS、中央/不同UID或OS关闭证明；这些限制与原证据保留。没有npm/type/full/probe/listener/节点，根在途7dab C10源码及进程不动。
