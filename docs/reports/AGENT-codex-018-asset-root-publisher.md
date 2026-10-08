# Asset root registry publisher

本包在 codex/018-asset-root-publisher、main 86c810a1 起点实施，仅拥有 publisher、新专用测试及本报告。旧 C10 dcc51 已推分支保持隔离，不修改产品 run-assets 权限接口。

目标：Linux root 外部监督者串行验证精确配置 asset unit 的旧 cgroup/PID 实际关闭，耐久 witness 后保留新 epoch，再以 systemd/kernel 与纯私有 TLS identity 双读发布 active registry。Windows 只做受控模块/CLI 拒绝验证，不伪称 Linux OS 证据。

固定协议参考：G 0cd94730 的 run-assets-current-registry.mjs；canonical hash 使用实际 account/ledger.mjs digestOf。producer 不写 doc checkpoint；root anchor 建立 epoch 1 信任起点，doc owner 必须验完整证据并先持久 checkpoint 后授权。

三级修改前：无 root producer，current 身份与历史关闭不能由同证书推断，生产 run-assets 保持 503。修改后：独立 root 配置精确 scope 的工具，非 active / witness / reserved / active 原子耐久阶段；任一歧义停止且留非 active，不以超时或 ENOENT 推断关闭。

尚未运行：Linux root/systemd/TLS、任何业务服务/监听器、全量；节点执行由 root 另租。

## 固定源码与结果

- 开工：ad3c1e1c。
- 首块：fb0d35e3，首次 npm wrapper target 25/25，0 fail/skip/cancel，123.2865 ms，exit 0；原始 `TEMP/pc-asset-root-publisher-target-1.log`。
- 自审窄修：cefbc620，完整旧 archive/witness 链、unit 参数拒前导横线、bootstrap existing populated group 拒绝；第二轮 26/26，126.1848 ms，exit 0；`TEMP/pc-asset-root-publisher-target-2.log`。类型第一轮 exit 0，`TEMP/pc-asset-root-publisher-types-1.log`。
- 最终源码：617593646328aec1204e9e6ace26fb347f6b0f6f。root 接受初版 Restart=no 边界后，补 stop 前完整旧 OS tuple 重核、cgroup2 文件系统核验、只对 ECONNREFUSED 的有界启动退避。第三轮 27/27，0 fail/skip/cancel，124.134 ms，wrapper wall 1116 ms，exit 0；`TEMP/pc-asset-root-publisher-target-3.log`。最终 `tsc -b --force` exit 0、wall 6871 ms，`TEMP/pc-asset-root-publisher-types-2.log`；node --check、git diff --check 通过。
- 本轮没有失败后盲重跑：后两轮分别对应确定源码变动；所有首次原始日志保留。无全量租约，未跑 full；本阶段 root 指定纯目标/类型/CLI，未跑业务 listener、探针或节点。npm 原有 test-suite/global-setup 会启保护端口 guard 再 teardown，不把 npm 全过程描述为零监听。
- 测试中的 IO 为明确受控事务模型，不是 OS root 证明。CLI 子进程真实执行并等 close，非法 --fixture 拒绝；Windows/nonroot 调生产入口确实拒绝。没有 allowFixtureRoot/force/recover 生产旁路。

## 接口与耐久顺序

新文件 `server/hosted/deploy/asset-root-registry-publisher.mjs` 导出纯协调器 `publishAssetRootRegistry({scope,mode,io})` 供受控验证；生产入口 `runAssetRootPublisher({configFile,mode})` 自行构造 Linux root IO，不接受调用者注入 OS 身份。CLI：`node <source>/server/hosted/deploy/asset-root-registry-publisher.mjs --config <root-owned-absolute-json> --initialize` 或 `--rotate`。JSON 只输出 ok/epoch/recordDigest/anchorDigest 或白名单错误码，不打印密钥、identity 原文、配置或 systemctl stderr。

配置 exact schema：

```json
{
  "v": 1,
  "scope": {
    "authorityId": "probe-doc",
    "serviceIdentity": "probe-asset",
    "uid": 12001,
    "unit": "promptcut-asset-probe.service",
    "cgroupPath": "/sys/fs/cgroup/system.slice/promptcut-asset-probe.service",
    "clientFingerprint256": "<64 lowercase hex>",
    "serverFingerprint256": "<64 lowercase hex>"
  },
  "registryDir": "/var/lib/promptcut-root/asset-probe",
  "identity": {
    "origin": "https://127.0.0.1:6600",
    "keyFile": "/etc/promptcut-root/probe-doc-client.key",
    "certFile": "/etc/promptcut-root/probe-doc-client.crt",
    "caFile": "/etc/promptcut-root/probe-ca.crt"
  }
}
```

示例值不是实际节点配置/端口租约。root 自行给隔离 unit 创建精确配置；config 必须在 registryDir 之外。registryDir 及祖先 root-owned、不可 group/other 写；证书文件同样精确 root-owned regular single-link/no-symlink，工具不修改现有所有者或全局设置。registry/witness/reservation 为公共元数据可读，只有 root 可写。publisher 自身不得位于目标 cgroup 或其后代。

1. `.publisher.lock` wx 外部互斥贯穿全程，锁冲突直接失败；崩溃残锁不凭 PID 猜删。root 其它启停也必须遵守该互斥协议。
2. rotate 读取完整当前 active、anchor、每个 epoch archive/witness；所有 canonical 摘要使用实际 ledger.digestOf。pin 前双读 systemd/proc，核 BootID/startTicks/四 UID/MainPID/InvocationID/ControlGroup/dev/ino；只对配置精确 unit 发命令，不以磁盘数字 PID 发 signal。
3. pin 旧组目录及 events FD；先写 current.state=preparing 和 closing journal。stop 前再次检查完整旧元组；仅 Restart=no、KillMode=control-group、Delegate=no 的真实 unit 允许控制。
4. 精确 unit stop 与 pinned events FD 观察并行。必须真的读到 populated 0、精确旧 PID birth 已消失、boot 不变且 systemd 最终 inactive/MainPID0；路径 ENOENT/旧 FD 不可读/对象不符/超时皆拒。不减去 helper 数量，也不把新 MainPID 算旧 PID。
5. 先 witness-N.json 独占写、文件 fsync、发布并目录 fsync。之后 reservation.json 预留新 UUID/epoch，journal=reserved；再 start 相同配置 unit。
6. reservation exact fields：`{v:1,protocol:'promptcut.asset-root-reservation.v1',authorityId,serviceIdentity,uid,unit,cgroupPath,clientFingerprint256,serverFingerprint256,epoch,instanceId}`。G 已确认仅作 root 分配启动输入，不能作为 current 授权。asset 先起只读 identity/control，业务仍缺 active 失败关闭。
7. 核新 OS 元组 → fresh pinned mTLS identity → 再核同一 OS 元组；private identity exact fields 为原 `{v,serviceId,serviceIdentity,instanceId,pid,startedAt,docClientFingerprint256,internalServerFingerprint256,state}` 加 `authorityId,epoch`。PID/instance/epoch/pins 与 root 预留、真实内核一致；startedAt 只核合法，不作为 PID 出生证明。
8. epoch1 先写 immutable anchor；写 immutable epoch-N.json，再核 OS 元组，发布 current.json active 候选。ef5c 后还必须完成 publication marker 文件及目录 fsync，最后解除 publisher 锁；active 单独可见不授权。文件实际 fsync+rename/link+目录 fsync；exclusive archive 不覆盖已有记录。纯 identity 强制新 TLS、完整读回后等 socket close，握手/身份/协议错误不退避成通过；只有启动尚未 listen 的 ECONNREFUSED 可有限退避且两侧重核 OS 身份。

## 首次信任、checkpoint 与失败恢复

`--initialize` 是 root 对全新专属作用域的明确初始化动作，不是旧实例关闭见证。要求 registryDir 无任何旧记录（仅本次 lock）、精确 unit inactive/MainPID0；已有 cgroup 时必须读到空组。目录缺失不会由工具创建；旧 current/anchor/reservation/transition 存在便拒绝初始化。首次生成的 root anchor 固定 epoch1 的完整 active digest 和 scope。

producer 不写 doc SQLite，不把输出 checkpointDigest 当授权。G 的 `acceptCurrent` 仍需完整 root 文件/anchor/见证链检查；首次 checkpoint 只能从该明确受信 anchor 建立，以 ledger 事务耐久 `{v,authorityId,epoch,recordDigest,anchorDigest}` 后再暴露 RAM。缺 checkpoint 不由现 readRootRunAssetCurrent 自动创建，不能从任意 current 高 epoch 自举。

更正：未成功发布的中断可能留 preparing，也可能已经让 active/marker 可见；ef5c 后任何未完成失败均保留持久 publisher 锁，自动重跑在 wx 锁门拒绝，不覆盖成新 epoch；没有 force/自动清锁/自动跳过部分写入的恢复入口。root 应核实际 OS、journal 和 owned artifacts 后另制定精确恢复，工具不猜测。新服务可能已起但未发布 active，此时业务应仍失败关闭，工具不在 catch 中盲停可能已变化的 unit。

跨 boot 恢复明确未支持：旧 cgroup 对象不可重获，G 0cd witness schema 也未定义 boot-transition。工具拒绝而非把 ENOENT/新 boot 当旧关闭；这是部署机制限制，不是用户产品语义待定。现基础三角色 plan 的 on-failure 未改；初版不声称该计划已支持 run-assets。Linux stop 后 pinned events FD 是否仍可观察到 empty，必须实际测：若内核移除对象使读取失败，当前安全结果为拒绝，不得把该错误当 empty。

## 受控反例与后续真实 Linux probe

纯目标验证了：错误旧 process 不发 stop；ENOENT 观察不 start；假 closed、替换 boot/cgroup/birth/Invocation 拒绝；witness/transition/reservation/archive/current 各写入失败不发布 active；身份 PID/epoch/id/authority/pin/额外 OS 字段拒绝；identity await 和最后 fsync 夹缝 MainPID 改变拒绝；互斥覆盖整个异步流程；损坏历史 witness 不发 stop；Restart=always/on-failure、Delegate/alias/非整组 KillMode 拒绝；CLI 实际退出关闭。没有用这些模型结果声称真实 cgroup/OS closure。

root 可在**独立测试 unit 与专用 UID**执行如下方案（本 Agent 未创建或执行）：

- root 在目标 cgroup 外启动 publisher；使用已固定源与 G reservation/identity 接线。测试 unit direct ExecStart Node（没有残留 shell wrapper），User 与 config UID 一致，Restart=no/KillMode=control-group/Delegate=no，不修改现生产 unit/default。asset 的只读接口需在 READY 之前/独立于 active registry 可用；不得让 ExecStartPost 等待 registry 与 publisher 相互阻塞。
- 先 `--initialize`，实际检查 scope/anchor/archive/current 摘要，并由 doc 独立 accept/耐久 checkpoint；再 `--rotate`，核旧 BootID/PID/startTicks/Invocation/cgroup 对象、witness、当前新 OS 和完整链，记录服务进程实际 close。
- 用本测试 unit 的后代持有资源：主进程退出而后代仍在不能报 empty。测试 helper 留在 unit 内时不得误报空。另测试同路径 cgroup 重建、错误 PID birth、自动 Restart policy、wrong pin、identity ACK 不可达、producer 在各落盘点中断；应全部失败关闭，保留首次输出。
- producer 源码仅输出摘要；需要 syscall 证据由 root 在隔离目录加 strace 观察真实文件/目录 fsync 和 systemctl/proc 操作。不要输出 TLS private key、nonce、exporter 或真实账号凭证。
- G 的 exporter HMAC 反查、doc acceptCurrent、生产 OS 部署/实际 UID隔离、旧业务 lease/control 完整 ACK 均不由本工具代替。新 epoch active 也不重放旧外部效果，不给历史 unknown 空 ACK。

当前包无生产部署、没有完整 npm/full或实际 Linux root 运行结论；初版三文件固定后又接受下述完成凭据审查，最终状态以下文为准。

## 完成凭据修正：首个真实文件反例

root/Sol 审查指出 617 的原受控 IO 只在 files.set 前注入故障，不能证明 real rename 后 fsync 失败仍 inactive。此前“未成功发布一定非 active”陈述撤回，保留原 27/27 证据范围。

新增真实 TMP counter：实际 file write+fsync+rename 已使 current.state=active 可读；在紧随其后的 directory barrier 注入失败，旧协调器 finally 仍删除 publisher.lock。首次 npm wrapper 28 tests /27 pass/1 fail/0 skip，138.4368 ms，exit1，TEMP/pc-asset-root-publication-red-1.log。错误为断言要求 lock 在场却实际 ENOENT，active 可见断言已过。Windows directory barrier 是受控故障边界，不冒称 Linux syscall/powerloss；文件操作和 CLI均真实。


## 完成凭据最终协议与验证

- 首红固定 df0deb04：真实 TMP 写入与 rename 后的受控目录 barrier 失败，active 可见而旧 finally 删锁；28/27pass/1fail，138.4368 ms，exit1，原始 TEMP/pc-asset-root-publication-red-1.log 保留。
- 最终产品 source ef5c92d9：同一 wrapper 32/32、0fail/skip/cancel，165.9398 ms，wall1132ms，exit0；TEMP/pc-asset-root-publication-green-1.log。最终 types --force exit0/wall7322ms，TEMP/pc-asset-root-publication-types-1.log。源码测中不变、diff-check 通过。
- G account_wiring_sol 已明确确认相同接受协议。本包不改 G 文件，不声称已完成 doc acceptCurrent 的实际联验。

完成文件为 `publication-<epoch>.json`，exact schema：

```text
{v:1, protocol:'promptcut.asset-root-publication.v1', authorityId, epoch,
 registryDigest, anchorDigest, closureWitnessDigest:null|sha256, reservationDigest}
```

摘要全部用实际 ledger.digestOf 的完整规范对象，epoch1 closureWitnessDigest=null。root producer 读取历史时也要求每个 epoch 的准确 marker。原617没有marker的数据不能被自动当完整发布；本任务没有该格式生产存量，不提供猜测迁移。

**接受条件是 marker 与无锁共同成立。** producer 在任何 mutation 前耐久创建 `.publisher.lock`（文件 fsync、目录 fsync）；active 文件和目录 fsync、marker 文件和目录 fsync全部成功后才解除该锁。目录 fsync失败可能使 active 或 marker 已可见，这不是回滚；失败路径只关闭锁FD，保留锁文件。突然进程退出同样不自动清锁。消费者必须对全部 root-owned 证据与 lock 不存在做前后检查，再在 SQLite 内耐久 checkpoint；marker可见但锁在场一律503。服务身份和 exporter反查仍需原完整证据，marker不是新cap。

`writePublisherArtifact` 与 `openPublisherLock` 是文件原语测试 seam，生产CLI没有注入参数；生产调用只在 Linux root/配置与目录核验之后。TMP测试使用真正 file write、file fsync、rename或hardlink、读取和锁文件；Windows目录fsync边界使用受控 callback，明确不是Linux持久性/自然掉电证明。

新增实际文件场景：

1. current rename后目录barrier报错：实际active可读，lock实际保留，不能接受。
2. publication hardlink+临时名删除后目录barrier报错：marker实际nlink1/active实际存在，lock保留，第二publisher wx实际EEXIST。
3. marker目录barrier尚在等待：marker已可读，但lock仍在；只有barrier成功后才删锁，marker的registry/anchor/reservation/closure摘要全部核对。
4. 最后unlock已经unlink、随后锁目录barrier失败：抛 `publisher-unlock-result-unknown`。此时active与marker的barrier已经完成，不能因CLI exit1声称inactive；消费者仍按完整证据判定。若掉电后锁复现只会失败关闭。根不得将缺锁、独立marker或CLI退出码单独当完成证明。
5. 历史marker缺失、anchor/reservation/closure摘要错误拒绝rotate，不发unit stop。

部署恢复限制仍保留：所有root启停共用同一外锁；Restart=no/Delegate=no/精确cgroup；跨boot不支持；未知ENODEV/ENOENT不能closed；root需要显式核对与恢复失败事务，不能简单删除残锁来绕过未知的发布结果。当前业务生产run-assets仍无据503；独立account/doc/asset基础部署不被本包宣告覆盖。

最终只改原3文件；无业务listener、full、节点、main写入、push或merge。真实Linuxroot/cgroup与G checkpoint联验由root后续分窗口执行。

## 独立 Linux pinned-cgroup OS smoke（尚未节点执行）

新增精确租赁文件 `scripts/probes/asset-root-cgroup-os-probe.mjs`，初始09d3f326，最终源码e00fbd832239f73e7f5177dbb5c5ca15ce434139。publisher/G 源码仍保持 ef5c 冻结，不借此脚本扩调度/部署。脚本自包含仅 Node builtins，可由 root 复制这一份到隔离节点运行。

Root 纠正 VM systemd=249 后采用 Type=simple，不使用250以后才支持的ExitType=cgroup。只创建随机 `pc-asset-cgroup-proof-<16hex>.service`，使用root传入的既有专属asset用户（不创建账号）。Restart=no / KillMode=control-group / Delegate=no / TimeoutStopSec=5s；root观察器在目标cgroup外。systemd的User可显示精确用户名或其真实UID，两者都绑定root已解析的唯一用户；实际/proc四UID仍严格核对。

单轮流程：

1. Linux真root gate；核root network namespace与PID1一致；只读/proc/net/tcp和tcp6确认6540–6549全部无LISTEN；随机unit LoadState必须not-found。任一前置不符即失败，不动占用者。
2. 新建自己的TMP目录（或`--out`明确不存在的绝对目录），只将其data目录chown给该asset用户。保留脚本副本、metadata manifest、父子真实文件和result.json，不删现场。
3. root仅listen127.0.0.1:6540，transient unit真正Node parent/child各自打开并file.sync一个文件FD、连接该TCP。root把两端hello的PID/fd与真实MainPID、/proc startTicks/UID/cgroup、/proc/fd路径交叉核；hello自身不算身份依据。
4. 在stop前固定打开旧cgroup目录和events FD，记录dev/ino/boot。只发一次systemctl stop自己随机unit，发令前核Id/Description/User/ControlGroup归属，不发送数值PID kill。
5. parent收到SIGTERM立即exit；child在自己的SIGTERM handler延迟约2秒继续持有原FD/TCP，之后真实close文件、TCP并exit。此延迟只制造负例窗口，完成判据是实际资源状态；没有加长判据或第二轮。
6. root与stop并发每10ms读取同一events FD、原PIDbirth是否消失、child原fd是否仍持有和TCP是否未EOF。在main已退出而child fd/TCP仍在且populated1时记录negativeObserved，不能closed。随后必须真的从固定旧FD读到populated0且父子birth消失、两个peer实际EOF+close、unitinactive/MainPID0、stop成功才ok。
7. 若固定FD实际报ENODEV/ENOENT等，原码进入eventsReadError，不改读新路径、不将异常当empty。没有观察到负例或empty一律okfalse；不重跑到绿。unit只在自己的归属被核实后stop，cleanup不会再次stop；自己的TCP与FD实际close，目录保留。20秒工作预算加cleanup总30秒门，超过总预算也失败并记录wallMs。

Root 独立执行示例（**本Agent未执行，参数需root确认实际专属用户和新目录**）：

```sh
/usr/bin/node /path/to/fixed/asset-root-cgroup-os-probe.mjs --user promptcut-asset --out /tmp/pc-asset-cgroup-proof-one-shot > /tmp/pc-asset-cgroup-proof-one-shot.log 2>&1
```

Node二进制与脚本副本必须可由该用户执行/读取。脚本默认自动mkdtemp，也可省略--out；每次打印实际outputDirectory/unit等metadata。不要把错误后换参数再次跑当首轮通过。保留stdout和目录result.json；即使前置/内核不支持的结果也照实保留。unit是transient，不写生产unit，不改基础account/doc/asset服务与任何安全设置；此测试不包含publisher互斥交叉、真实TLS/HMAC、doc checkpoint或完整业务资源ACK。

本机仅执行syntax及纯CLI guard：最终node --check exit0；--help exit0；Windows --user入口exit1且code=probe-linux-root-required；非法--force exit1且code=probe-cli-invalid。原始TEMP/pc-asset-root-cgroup-cli-{help,platform,invalid}-1.log及最终-2.log保留，均未开启listener/guard/npm。没有运行Linux进程、systemd或节点；实际kernel pinnedFD行为仍待root唯一窗口。

root执行前只读指出umask077入口问题：e00的--out分支mkdir755可能实为700，manifest mode644也受umask影响。最终窄补对**仅新建成功**的out/root显式chmod755，对新manifest显式chmod644，probe副本原已有chmod644；data显式700后chown专属asset用户。--out已存在时mkdir先EEXIST，绝不chmod既有路径，不改全局umask。最终syntax0/help0/Windowsguard1/非法CLI1，TEMP/pc-asset-root-cgroup-cli-{help,platform,invalid}-3.log；尚未节点执行。

## Linux OS smoke 首次真实运行：失败，原证据保留

root唯一实际运行固定886cd6b5（脚本SHA256 4a7f957074cb66da8b0b63d8ed80bd26676adead7f543e1c2ddc3f896b84629e），Node24.21/systemd249。root回传原始日志 `TEMP/pc-root-cgroup-os-886cd6b5-once.log`；VM保留 `/var/tmp/pc-root-cgroup-os-886cd6b5/once-output/result.json`。本Agent未执行节点。

wall2283ms，okfalse，negativeObserved=true，emptyObserved=false。244ms旧FD读populated1，主子都在；268ms mainBirthGone=true，child仍持真实FD/TCP且populated1，负例成立；2261ms childEOF/close但birth仍在/populated1；2273ms两个birthgone，固定旧events FD读ENODEV，未读到populated0。唯一stop次数1且exit0，unitinactive/MainPID0、bothEOF/close真，6540–6549已清空。root独立核实际生产account274484/doc274497/asset273011/nginx9395的PID与NRestarts0均未变。

结论是**旧cgroup空对象取证失败**，不是可接受关闭。没有以PID消失、EOF或ENODEV代替empty，也不重复同一smoke。原纯模型/CLI验证不覆盖此内核行为。下一机制必须可靠保留空对象到root读取，再准许其移除；尚未改producer、G或节点。

## 首红后的三级解法表：保留真实空容器到取证完成

本节是机制提案，尚未实施或节点验证。修改前：将服务自身会被systemd自动回收的叶cgroup作为closure scope。拟修改后：root显式启动并保持一个只容纳该服务的独占slice，以该真实祖先cgroup作为closure scope；仍另存服务自己的准确cgroup路径、MainPID/birth及unit invocation，不能把两者混称同一对象。不改变用户功能或关闭标准，不修改Delegate权限，不影响独立账号成果。

| 候选（均为三级） | 证据与判断 | 状态 |
| --- | --- | --- |
| 原服务叶固定FD，缩短轮询间隔 | 真实886首红在pop1之后直接ENODEV；加密采样仍与systemd删除竞赛，不能保证对象保留 | 排除，不重跑 |
| RemainAfterExit=yes保留服务 | systemd v249 service.c:1000–1003在SERVICE_EXITED显式unit_prune_cgroup；active/exited本身并不保留叶对象 | 排除，不试验 |
| 同一被观测组内放保活helper或ExecStopPost | helper仍属递归populated集合，活着就不能观察真实空；减去helper不是内核empty证明 | 排除 |
| root持久管理独占ACTIVE slice，服务为其唯一子树 | v249 slice_start建立cgroup并置ACTIVE；slice_stop才置DEAD。ACTIVE不会被unit_may_gc卸载，StopWhenUnneeded=no不会因子服务停止而自动stop。内核populated递归覆盖全部子孙 | 最小候选，须独立真实OS验证 |
| root另行管理工作负载cgroup并迁移进程 | 可另设计生命周期，但涉及进程迁移、控制器与systemd归属交叉，影响大于普通Slice=配置；当前不实施 | 保留后备，未证明 |

原首红与systemd249删除路径一致：unit.c的unit_notify在inactive/failed时调用unit_prune_cgroup；cgroup.c:2399–2429调用cg_trim_everywhere并释放对象。固定打开FD不等于阻止cgroup离线。没有内核trace，因此这里不冒称定位到本次删除syscall的确切执行时刻。

依据仅取官方固定版本源码与内核文档：

- [systemd v249 service.c](https://raw.githubusercontent.com/systemd/systemd/v249/src/core/service.c)：SERVICE_EXITED亦主动prune。
- [systemd v249 cgroup.c](https://raw.githubusercontent.com/systemd/systemd/v249/src/core/cgroup.c)：unit_prune_cgroup及递归trim。
- [systemd v249 unit.c](https://raw.githubusercontent.com/systemd/systemd/v249/src/core/unit.c)：unit_may_gc（343起）拒收ACTIVE；unit_is_unneeded（1878起）先检查stop_when_unneeded；inactive通知（2437起）prune。
- [systemd v249 slice.c](https://raw.githubusercontent.com/systemd/systemd/v249/src/core/slice.c)：slice_start（204起）与slice_stop（222起）；没有以cgroup空通知自动停止slice的处理器。
- [Linux cgroup v2文档](https://docs.kernel.org/admin-guide/cgroup-v2.html#un-populated-notification)：populated=0表示自身及全部后代没有live process，状态递归传播；并不需要保留已被删除的服务叶才能读取祖先的真实空状态。

最小可验证方案只修改已有OS smoke文件（须root裁定下一步后实现），不新增文件、不改publisher/G格式或现有生产unit：

1. 独立随机slice名与service名，两者首次not-found；root显式启动slice，核ACTIVE、StopWhenUnneeded=no、精确ControlGroup及InvocationID。采用不带连字符的随机slice主体避免名字隐含额外slice层级，路径仍从systemd读取而非推测。
2. 真实service仅增加普通Slice=归属；Restart=no/KillMode=control-group/Delegate=no均不变。root观察者仍在外，slice中不放sentinel/观察者/stop helper，也不放生产服务。
3. root核service的Slice、ControlGroup与/proc真实父子归属，确认service路径是slice路径的严格后代、无其它已知unit/进程混入；固定打开slice目录和events FD并记录boot/dev/ino，与服务自己的tuple分别保存。独占外锁覆盖创建、停止、取证与销毁，禁止该段时间再次启动服务。
4. 和首轮一样只发一次service stop，保留main先退出、child延迟2秒仍持真实文件/TCP的负例。此次须从同一个已固定slice events FD看到pop1负例，之后看到pop0；还须原父子birth消失、真实双EOF/close和service inactive/MainPID0。slice必须仍ACTIVE且同一InvocationID/dev/ino，没有换FD或新建路径代替旧对象。
5. root将上述实际结果文件fsync并对目录fsync完成，才允许显式stop这个自己创建的slice。若写证据失败，不能把后续清理当已签发closure；若ENODEV/ENOENT/身份变化/未观察负例则失败，保留原结果，不重跑。同组意外进程不能由probe随意终止；应失败并保留归属待root处理。
6. 一轮仍总预算30秒、自己的service TimeoutStopSec=5；预检6540–6549空，生产PID/NRestarts前后只读核对。此方案是新增因果机制后的单轮实验，不是重复886原机制。

如果真实OS实验通过，后续publisher与G必须另约显式schema：保留serviceCgroup及service unitInvocation；新增closureScope的sliceUnit/sliceInvocationId/cgroup{path,bootId,dev,ino}并绑定同epoch、authority和真实包含关系。所有root启停仍走同一互斥锁，只有真实旧scope空且证据耐久后才能预留/启动下一代。现v1 exact schema不能静默把serviceCgroup改成slice路径，更不能仅把本方案说明或服务已inactive当witness。现有跨boot不支持、marker+无锁接受协议保持，生产run-assets继续失败关闭。

本轮只有报告更新和官方资料只读，无本地listener、npm/type/full、systemd或节点执行；886脚本及publisher源码均未改。实际slice可观测性、publisher互斥交叉、TLS/G checkpoint与自然掉电仍未证明。

## 获准的独占slice实验源码（Linux尚未运行）

root随后精确扩租同一个OS smoke文件和本报告，未允许改publisher/G。解法表选择第4行：g=2（现探针加真实slice生命周期与双identity）、h=1（仍需目标VM一次真实FD实验）、f=3；第5行g=4/h=3/f=7，保留后备。其余三行已剪，无开放二级候选；关闭判据未改变。

固定源码 `b9d802dc4de9214d3e177c98339f8afd735f1269`，脚本当前文件SHA256 `394a2aa7a2a7726da142fcd760b9c5fdb27ebc7404fc146c0774a5198b41fb23`。仅修改 `scripts/probes/asset-root-cgroup-os-probe.mjs`。首红886与原publisher继续保留，不能使用新scope实验倒写旧叶FD为通过。

v249语法已核：systemd-run只有`--slice`，没有`--slice-property`；[run.c](https://raw.githubusercontent.com/systemd/systemd/v249/src/run/run.c)把它写成service的Slice属性。显式创建slice使用现有系统D-Bus `StartTransientUnit`，签名`ssa(sv)a(sa(sv))`，properties仅Description与StopWhenUnneeded=false，aux为空；[dbus-manager.c](https://raw.githubusercontent.com/systemd/systemd/v249/src/core/dbus-manager.c)定义此签名，[dbus-unit.c](https://raw.githubusercontent.com/systemd/systemd/v249/src/core/dbus-unit.c)支持该bool属性。无新unit文件、daemon-reload、Delegate权限或系统安全配置。

新版重要边界：

- 新slice为`pcassetproof<16hex>.slice`，新service仍`pc-asset-cgroup-proof-<samehex>.service`；两者先not-found。slice启动后核真实ACTIVE/Transient/StopWhenUnneeded=no/InvocationID/ControlGroup。slice无ExecContext，因此User必须空或不存在；其身份依据是root通过system manager创建的精确随机unit/description/invocation与cgroup对象，不假造User=root。实际服务与父子/proc四UID仍严格核dedicated asset UID。
- 启动服务前固定slice目录及eventsFD，记录boot/dev/ino，真实初始inventory只有scope且pop0。服务运行后真实inventory必须恰好scope+唯一service目录，PID恰好实际父子，pop1；root observer不得在scope下。初始pop0不会设置最终emptyObserved。
- 结果`closureScope`保存sliceUnit/invocation/boot/真实cgroup{path,dev,ino}；`before.service`另存实际serviceUnit/invocation/uid/boot/自身cgroup，`before.main/child`存真实pid/startTicks/uid/归属。不再把原before.cgroup单字段混称服务叶与祖先。
- 与886同样只stop一次自有service，保留main退出而child仍持FD/TCP且scope pop1的真实负例。固定原slice FD观察最终pop0，原父子birthgone、真实EOF/close、serviceinactive/MainPID0且slice仍ACTIVE、同InvocationID/dev/ino才能通过。ENODEV/ENOENT仍失败，没有以路径重开替代。
- 清理前再次读scope原FD空、完整inventory空、旧birth消失；在scope仍ACTIVE时，`closure-result.json`先真实file fsync与directory fsync。随后再次核同scope/空才stop自身slice；最终`result.json`也耐久写，记录sliceCleanup实际结果。closure-result是释放前证据，不等于整个probe通过；最终CLI与result.json还要求slice stop成功/实际inactive和654x无监听。
- 任何证据写入失败、scope归属不明、旧FD异常、意外进程/子组或预算耗尽，不stop未知scope，记录`probe-slice-retained`及随机名称/路径等metadata供root处理。不会为了清干净而杀未知PID/停止其它unit。强制关闭本观察器socket不计入真实EOF成功断言，成功断言在强制清理前已经采集。
- 工作预算仍20秒、总界限30秒，service TimeoutStopSec=5秒。所有systemctl/busctl调用有剩余预算；超界失败。父/子2秒延迟仍只用于负例，未加完成宽限。

本机最终验证（固定b9源码）：node --check exit0；--help exit0；Windows正常入口 exit1=`probe-linux-root-required`；非法--force exit1=`probe-cli-invalid`，git diff --check通过。原始TEMP `pc-asset-root-cgroup-slice-{syntax,help,platform,invalid}-1.log`（初版）与`-2.log`（b9最终）均保留；第二轮有因是最后补足失败结果输出和部分启动清理空值保护后的固定源码验证。没有本地业务listener、npm guard/目标/full/type或任何Linux运行。

Root单次执行命令不变，必须新out路径、真实专属用户和本节固定脚本hash：`node <fixed-script> --user <actual-asset-user> --out <new-unique-directory>`。需同时保留stdout、closure-result.json（若已到达）和result.json；首轮886 result不得覆盖。只有root下一次真实实验通过后，才讨论publisher/G显式双scope接口；当前生产run-assets仍503，此实验不证明TLS、业务资源ACK或跨进程完整部署。
