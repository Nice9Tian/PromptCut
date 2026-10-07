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
| 6 | 三级 | 共享 SQLite seal 序列、完整 prepared、同锁 fence | seal 与密码同序；恢复只复用同一确定修改 | 3 | 1 | 4 | 开放，待实现与故障实证 |

最终交付接口、全部尝试与原始结果、持久性证据、未挂载范围和限制；由主会话集成复验。
