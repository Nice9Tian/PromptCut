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
8. epoch1 先写 immutable anchor；写 immutable epoch-N.json，再核 OS 元组，最后唯一 current.json active 原子发布。文件实际 fsync+rename/link+目录 fsync；exclusive archive 不覆盖已有记录。纯 identity 强制新 TLS、完整读回后等 socket close，握手/身份/协议错误不退避成通过；只有启动尚未 listen 的 ECONNREFUSED 可有限退避且两侧重核 OS 身份。

## 首次信任、checkpoint 与失败恢复

`--initialize` 是 root 对全新专属作用域的明确初始化动作，不是旧实例关闭见证。要求 registryDir 无任何旧记录（仅本次 lock）、精确 unit inactive/MainPID0；已有 cgroup 时必须读到空组。目录缺失不会由工具创建；旧 current/anchor/reservation/transition 存在便拒绝初始化。首次生成的 root anchor 固定 epoch1 的完整 active digest 和 scope。

producer 不写 doc SQLite，不把输出 checkpointDigest 当授权。G 的 `acceptCurrent` 仍需完整 root 文件/anchor/见证链检查；首次 checkpoint 只能从该明确受信 anchor 建立，以 ledger 事务耐久 `{v,authorityId,epoch,recordDigest,anchorDigest}` 后再暴露 RAM。缺 checkpoint 不由现 readRootRunAssetCurrent 自动创建，不能从任意 current 高 epoch 自举。

未成功发布的中断留 preparing/journal/已有 immutable 证据，自动重跑 rotate 会拒绝 inactive current，不覆盖成新 epoch；没有 force/自动清锁/自动跳过部分写入的恢复入口。root 应核实际 OS、journal 和 owned artifacts 后另制定精确恢复，工具不猜测。新服务可能已起但未发布 active，此时业务应仍失败关闭，工具不在 catch 中盲停可能已变化的 unit。

跨 boot 恢复明确未支持：旧 cgroup 对象不可重获，G 0cd witness schema 也未定义 boot-transition。工具拒绝而非把 ENOENT/新 boot 当旧关闭；这是部署机制限制，不是用户产品语义待定。现基础三角色 plan 的 on-failure 未改；初版不声称该计划已支持 run-assets。Linux stop 后 pinned events FD 是否仍可观察到 empty，必须实际测：若内核移除对象使读取失败，当前安全结果为拒绝，不得把该错误当 empty。

## 受控反例与后续真实 Linux probe

纯目标验证了：错误旧 process 不发 stop；ENOENT 观察不 start；假 closed、替换 boot/cgroup/birth/Invocation 拒绝；witness/transition/reservation/archive/current 各写入失败不发布 active；身份 PID/epoch/id/authority/pin/额外 OS 字段拒绝；identity await 和最后 fsync 夹缝 MainPID 改变拒绝；互斥覆盖整个异步流程；损坏历史 witness 不发 stop；Restart=always/on-failure、Delegate/alias/非整组 KillMode 拒绝；CLI 实际退出关闭。没有用这些模型结果声称真实 cgroup/OS closure。

root 可在**独立测试 unit 与专用 UID**执行如下方案（本 Agent 未创建或执行）：

- root 在目标 cgroup 外启动 publisher；使用已固定源与 G reservation/identity 接线。测试 unit direct ExecStart Node（没有残留 shell wrapper），User 与 config UID 一致，Restart=no/KillMode=control-group/Delegate=no，不修改现生产 unit/default。asset 的只读接口需在 READY 之前/独立于 active registry 可用；不得让 ExecStartPost 等待 registry 与 publisher 相互阻塞。
- 先 `--initialize`，实际检查 scope/anchor/archive/current 摘要，并由 doc 独立 accept/耐久 checkpoint；再 `--rotate`，核旧 BootID/PID/startTicks/Invocation/cgroup 对象、witness、当前新 OS 和完整链，记录服务进程实际 close。
- 用本测试 unit 的后代持有资源：主进程退出而后代仍在不能报 empty。测试 helper 留在 unit 内时不得误报空。另测试同路径 cgroup 重建、错误 PID birth、自动 Restart policy、wrong pin、identity ACK 不可达、producer 在各落盘点中断；应全部失败关闭，保留首次输出。
- producer 源码仅输出摘要；需要 syscall 证据由 root 在隔离目录加 strace 观察真实文件/目录 fsync 和 systemctl/proc 操作。不要输出 TLS private key、nonce、exporter 或真实账号凭证。
- G 的 exporter HMAC 反查、doc acceptCurrent、生产 OS 部署/实际 UID隔离、旧业务 lease/control 完整 ACK 均不由本工具代替。新 epoch active 也不重放旧外部效果，不给历史 unknown 空 ACK。

当前包无生产部署、没有完整 npm/full或实际 Linux root 运行结论；固定三文件 clean 交根审查及后续独立实证。
