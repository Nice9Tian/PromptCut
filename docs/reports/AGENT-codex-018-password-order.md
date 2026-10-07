# 改密顺序见证与完整操作历史

负责 0.7.18 的顺序见证消费、不可变 prepared/accepted 记录、提交与 fence 恢复、完整 before/after 历史。仅在授权新增路径实施，不挂载现有业务，不执行 0.7.20 补偿，不操作其它工作区或部署。

起点 `721677b7`。上位依据为 main 的 `account-binding-task.md`，实现设计见 `three-versions-018-design.md`，方案必须经过故障验证才算成立。

先实证时钟偏差、reserve 夹缝、seal ACK 丢失、fence 先行和改密前依赖 doc 的五类反例，再实现账号统一序列与文档提交恢复。实际 SQLite provider 单独只读引用验证，不把内存夹具当持久性证明。

## 验证与交接

首先运行 `npm test -- server/test/password-order-counterexamples.test.mjs`：5/5 通过，77.4395 ms，退出码 0，无重试。通过表示五类错误方案的反例成立，不表示正确实现已通过。原始输出：UTC 的 naiveSelected=false / actualAfterPassword=true；reserve-password-seal 的 naiveSelected=false / correctSelected=true；丢 ACK 盲重做 effects=2；stop/private 两例 accepted=false 却 wronglyVisible=1；doc 离线时 passwordWritten=false，违反密码先成功流程。系统临时目录保留完整日志。

## 卡点 1：跨服务接受顺序和持久恢复

尺子为专用测试及故障探针中的错误区间、重复外部效果、穿 fence 次数全部为 0。

| 行 | 层 | 候选 | 因果机制 | g | h | f | 状态与证据 |
|---|---|---|---|---|---|---|---|
| 1 | 三级 | 各服务 UTC 比较 | 无统一序，时钟回拨可逆序 | 1 | 5 | 6 | 关闭，反例成立 |
| 2 | 三级 | reserve 时分序 | 尚未接受时分序导致夹缝漏选 | 1 | 5 | 6 | 关闭，反例成立 |
| 3 | 三级 | 丢 ACK 重跑业务 | 外部效果重复，不能恢复同一修改 | 1 | 5 | 6 | 关闭，反例成立 |
| 4 | 三级 | prepared 无条件重放 | fence 前未接受却在 fence 后落地 | 1 | 5 | 6 | 关闭，stop/private 反例成立 |
| 5 | 二级 | 改密前等 doc 在线 | 违反用户已定密码先成功流程 | 1 | 5 | 6 | 禁止，反例成立，不解锁 |
| 6 | 三级 | 共享 SQLite seal 序列、完整 prepared、同锁 fence | seal 与密码同序；恢复只复用同一确定修改 | 3 | 0 | 3 | 本包成立：33项实际进程突停/缺证据、4项真实mTLS控制链、6项历史探针；既有业务挂载交owner，未冒称集成完成 |

最终交付接口、全部尝试与原始结果、持久性证据、未挂载范围和限制；由主会话集成复验。

## 首批接口与证据

新增 `openOperationHistory`：SQLite WAL/FULL 保存 prepared、accepted、materialized、fence 和完整 item before/after。用独立 SQLite 独占事务持有进程写入权，崩溃由 OS 释放，不按旧 PID 清锁。`createPasswordOrder` 文档协调器提供 submit/fence/recover/resolveWitness；owner 必须把所有项目写和屏障接入同一实例。`checkGate` 必填；没有服务持久 ACK 不返回 complete=true。`createAccountOrderClient` 只接受 owner 配好的 mTLS transport，不接受用户 URL。

首次真实 foundation SQLite 核心测试出现两类失败：临时目录删除钩子先于数据库关闭（Windows EPERM）；journal 的 payload.kind 覆盖事件 kind 导致检查不到 fence-committed。修正为保留 TMP 故障证据、每例关闭句柄，以及事件类型最后赋值。第二次 `npm test -- server/test/password-order-core.test.mjs` 7/7，通过，623.6579 ms，退出码 0，无自动重试。该轮用真实 provider（foundation 5a61229），不是 portable simulator；真实 crash 矩阵仍待执行。

## 第二块：真实故障、控制屏障与历史留存

实际 Foundation provider 只读路径为 VisuHive `.worktrees/018-account-foundation`；最终 source `49ec9b4`、报告 HEAD `580bec8`。本分支不复制/修改它的数据库实现。测试显式设置 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT` 与 `PROMPTCUT_PASSWORD_ORDER_MODULE`；无前者的 portable core 是独立模拟器，crash 测试明确 skip，不能当真实持久性证明。

新增真实子进程 `process.exit(73)` 矩阵覆盖 24 个 prepared/reserve/seal/accepted/materialize/cancel/fence/ACK 边界、3 个密码 hash/event/outbox 事务边界、2 个 logout-complete 事务边界，另有 4 个账号见证/文档记录/完整 payload 缺失或损坏拒绝恢复案例，共 33 项。只退出本测试当前子进程，不按 PID 清理；SQLite OS 锁恢复，不重跑准备前的外部调用标记。这里的 effects=1 是隔离调用标记，未调用模型或真实工具。FULL/WAL 的证据范围是进程突停恢复，未模拟物理断电/损坏存储硬件。

真实网络探针创建 TMP 临时证书，在独占 5760/5761 上启动隔离 HTTP doc + 实际 Foundation internal mTLS。seal 已提交后销毁 ACK，切私请求在等待收口时立即关闭 SSE/读取/新写；丢 ACK 查询同一 sealed 后只物化一次，再持久 fence 与服务 ACK 才 complete=true。旧 run 后续写 403、private 字节 0、另项目正常写；asset 证书 403、无证书 TLS 失败。此为隔离 fixture 产品链，未冒称既有业务已挂载。

private/agent-disabled fence 必须带当次 current/queued/preparing `runIds` 快照；旧 run 永久拒绝，新 run 在实时权限恢复后仍须 checkGate 通过。private 快照也包含 owner 当前 run，使后来 retained 退出不能绕过 private。delete 永久项目、stop 精确 run、credential 精确旧 login+精确 retained tuple。恢复 requested fence 在账号查询前先重放 onFenceRequested，单项目排队不阻塞其它项目。成功屏障线性化点是 accepted 结清后 `fence-committed` FULL 提交；对外 complete 还需 owner durable ACK 和本地持久 receipt。

已执行后续证据（各轮均退出 0，无自动重试）：
- VH provider 首轮 7/7，160.614 ms；日志 `visuhive-018-order-provider-first.log`。
- PC core+crash 首轮 8/8，1893.6816 ms，23 子案例；日志 `promptcut-018-order-crash-first.log`，目录 `pc-order-faults-K59Qy1`。
- 第一轮 password-order-probe 27/27，wall 3.2252673 s；日志 `promptcut-018-order-probe-first.log`，目录 `pc-order-probe-644db8af6a444d379ce70358f23c8d28`。
- 新增 run/fence/区间边界后 12/12，1970.1401 ms；日志 `promptcut-018-order-edges-first.log`，目录 `pc-order-faults-WjMWxv`。
- 扩展 crash 矩阵 33/33（1 test），2982.1881 ms；日志 `promptcut-018-order-crash-expanded-first.log`，目录 `pc-order-faults-fUMeas`。
- operation-history-probe 6/6，6 ops/25 journal records/rev6；完整源码值、相同值他人版本、稳定 ID 结构/删除 before、根替换、完整日志重建、checkpoint 与两侧重启均通过。日志 `promptcut-018-history-probe-first.log`，目录 `pc-history-probe-5c522a2011024deda0db8a763da3db90`。

以上日志/目录均位于 `C:\Users\admin\AppData\Local\Temp`。唯一测试失败仍是首轮 core 7 tests/1 pass/6 fail/703.3687 ms：5 个清理 EPERM 与 1 个 journal.kind 覆盖，日志 `promptcut-018-order-core-first.log`；两处修正后有因重验，无盲重试。检索一次 Windows wildcard rg 报路径错误，仅检索命令，未运行测试或改文件。

## 挂载契约与未做事项

生产 owner 必须：所有 doc 写/stop/private/delete 走同一 coordinator；prepared 输入已含确定外部结果，不传回调重跑模型；checkGate 在恢复 account 事件/head 与服务持久 cursor 后核当前项目/成员/开关/run/queue/readReceipt；onFenceRequested 同步关闭读取/工具后续派发，失败保持拒绝；acknowledgeFence 只能返回实际持久服务 receipt。API 只公开 submit/fence/recover，内部 resolveWitness 不给绕锁入口。schema v2 未支持旧历史迁移，未来 schema 直接拒绝；缺完整链 needs-reconciliation。history 数据库是本包可恢复文档提交记录/快照，既有 doc 状态与广播的适配由 owner 接入，同一 prepared 不得再次执行外部效果。

四服务 ACK 的来源真实性由 Foundation mTLS/各服务持久应用保证；logout proof 中 connection/project cursor 的完整枚举由 doc owner 提供，本模块不凭 body.pendingSeals=0 信任结清，而会查账号实际 reserved 记录。账号不裁决项目权限。本包没有部署、公网、真实桌面/浏览器 UI、既有服务挂载或 0.7.20 补偿，均留主会话各 owner 集成验证。

## 全量发现与修复：依赖方向

PC 首轮全量在源 `d3392fee`：4948 tests / 4946 pass / 1 fail / 1 skip，67498.9349 ms，wall 67.8873369 s，exit1。唯一失败 `bakery-deps`：server/test 导入 scripts 的故障矩阵违反依赖方向。原始日志 `promptcut-018-order-full-final.log` 保留。修复为矩阵实现放入本任务已授权 `server/test/password-order-fixture.mjs`，scripts 只向 server re-export，单测直接导入同层夹具；没有修改规则或扩大授权路径。定向依赖+全部 order tests 20/20，3438.3732 ms，exit0，无自动重试；日志 `promptcut-018-order-deps-fixed.log`，33 子案例目录 `pc-order-faults-i5XDv4`。因此重新跑 types/full 与 probe，非盲重试。

修复前最终源类型零错误（wall 8.7642925 s），VH 完整 npm 26/26 pass、0 fail/skip，3427.1994 ms，wall 3.7278466 s；password-order 实际探针 37/37，wall 3.8484109 s，目录 `pc-order-probe-final-9994fd320eee4e969847bd5bff1415a9`。原日志分别 `promptcut-018-order-types-final.log`、`visuhive-018-order-full-final.log`、`promptcut-018-order-probe-final.log`。

## 最终源码复验与未关闭基线

最终业务/测试源码 `7aec017f`（VH源码`2a2d41b`，Foundation source`49ec9b4`/报告HEAD`580bec8`）上：

| 项 | 结果 | 耗时 | 原始日志（系统TMP） |
|---|---|---|---|
| `npx tsc -b --force` | exit0，零错误 | wall 8.3020974 s | `promptcut-018-order-types-fixed.log` |
| 依赖规则+全部order目标测试 | 20 tests / 20 pass / 0 fail / 0 skip；33实际故障子项 | 3438.3732 ms | `promptcut-018-order-deps-fixed.log` |
| password-order-probe | 37 pass / 0 fail，exit0 | wall 4.1509713 s | `promptcut-018-order-probe-fixed.log` |
| operation-history-probe | 6 pass / 0 fail，exit0；6ops/25journal/rev6 | wall 0.3340701 s | `promptcut-018-history-probe-fixed.log` |
| VH `npm test` | 26 tests / 26 pass / 0 fail / 0 skip，exit0 | 3427.1994 ms；wall3.7278466s | `visuhive-018-order-full-final.log` |
| PC 修复后 `npm test` | **4949 tests / 4947 pass / 1 fail / 1 skip，exit1** | 119101.9849 ms；wall119.664562s | `promptcut-018-order-full-fixed.log` |

没有自动 retry。修复后 PC 全量唯一失败为既有 `server/test/sp-hosting.test.mjs:35` 全局 after 清理临时目录，Windows `EPERM`；不是 native crash，因此测试 runner 没有自动重跑。本包新增用例与依赖规则通过。未手动重复全量以求绿，也没有把该次全量说成通过。

只读排查：失败路径 `C:\Users\admin\AppData\Local\Temp\pc-sp-hosting-j4f8NT`，当前残留目录名 stage-19、stage-data-20、tok-9；未读凭证内容、未删除目录、未结束旧 PID。该测试 :294 与 :548 的 t.after 只调用自己 child.kill() 不等待 close，runMain/runProbe 有基于 exit 的返回；这只是文件占用/生命周期的待证候选，尚未识别具体持锁者，不能宣称根因已证。文件不在授权路径，已把原始结果与候选交 root 指派 owner；本包不越界修改。**全量零失败闸门仍未关闭，须 owner 修复/集成复验。**

最终 probe 产物：`pc-order-probe-fixed-bde531c638264423a09c89981b4d8fbf`、`pc-history-probe-fixed-891a72cd4c7e4b51b6a9d7149a63f335`（均系统TMP）；包含可审 JSON、逐 subprocess 原始 child.log、故障数据库与隔离证书。证书仅在TMP，不入仓库。diff仅本任务授权13个新增文件，类型/画面范围未涉及渲染，不跑G0-R。最终仅补报告，无代码变化。

## 追加授权：托管测试子进程生命周期

root 在全量失败后明确扩展独占范围到 `server/test/sp-hosting.test.mjs`，只修测试自己启动的 child 生命周期和清理。新增 owned ChildProcess 登记；runMain 的非 listening 返回、runProbe 输出解析都等 `close` 而非 `exit`；两处 t.after await 自己 child 的 stop+close；全局清理先结清所有本测试拥有的 child。终止只针对仍未退出的当前 ChildProcess 对象，不按旧数字 PID，不全局 kill，不修改 production/main/combo。等待有 10s 上界；未 close 则失败保留现场，不继续删目录，未增加原有 rmSync 重试次数。

因果证据：真实 held-cwd child 握手后，删其 cwd 得到 EBUSY；kill 返回时 lifetime.closed=false；await close 后删除成功。该专用例 `node --test --test-name-pattern=SPH-lifecycle server/test/sp-hosting.test.mjs` 1/1 pass，151.7476ms，日志 `promptcut-018-sp-held-cwd.log`。该反例证明旧 fire-and-forget cleanup 存在可观测生命周期窗口；不追溯声称本次原 EPERM 的具体持锁者已查明。

此前尝试的“孙进程继承 stdout 使父 exit 后 close 一直挂起”在本 Windows 环境未成立：首轮新增例期待 closed=false，却观察 true。该轮原14项全部pass、新例fail，共15/14/1/0，25414.0388ms，exit1，日志 `promptcut-018-sp-lifecycle-first.log`；故弃用不成立的跨平台管道假设，改用上面实际成立的 held-cwd/kill 反例。没有隐去失败或盲重复。官方 Node 文档区分 exit 与 stdio close：[Node child_process 文档源码](https://github.com/nodejs/node/blob/main/doc/api/child_process.md)；首次nodejs.org直链抓取404后查询官方源码，未据失败链接作证。
