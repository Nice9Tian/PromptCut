# 三个版本集成基线失败修复报告

任务：定位候选 f9bb0745 的云端 session 测试 CAU-SES-01b（断线保留运行状态并显示重连）失败；工作分支起点 7b4b7106。

范围：仅 `src/ai/cloud/cloud-chat.test.mjs` 及有实际错误证据的直接 session 实现。本报告先独立提交；不改文档对齐工作区，不合并、不推送、不操作节点或用户进程。

原始集成失败：4928 条，4926 通过，1 失败，1 跳过；G0-2 退出 1，duration_ms 66168.1248。失败为等待 `connection === live && lastSeq === 3` 在 3002.2915 ms 超时，不能由之前的通过结果抹去。

已读本工作区开发者指南、必要约束和 brief 现场、分工、未决、工作方式；新用户已定私有切换中止他人在途任务、FIFO、无生产旧对话及四档气泡均不改。

待执行：可控事件复现、最小修复、针对性验证、最终类型与 npm test 各一次。所有尝试、失败和包装器重跑将在此补齐。

## 根因与可控证据

`fakeApi` 每次 yield 后等待 1 ms，原测试每 5 ms 轮询 `live && lastSeq === 3`。第三条事件处理后该状态已同步发布，但流随即抛网络错，session 正常进入 `reconnecting`；第二条流无事件一直挂着，seq 保持 3，因此错过短暂 live/3 的轮询永远等不到谓词。增加等待总时长不能使已过去的状态再次出现。

一次系统 TMP 脚本用显式开始闸门、连续有序事件与受控断线，保证前三条交付发生在原 5 ms 轮询两次观察之间。同步订阅记录：

```text
idle/0/false → connecting/0/false → live/0/false
→ live/1/true → live/2/true → live/3/true → reconnecting/3/true
原轮询结果 timeout；最终 reconnecting/3/streaming=true
all passed: original predicate missed observed live/3; session preserved running
```

复现脚本退出码 0，表示关于“旧谓词超时但 session 行为正确”的断言成立；它不是一次被忽略的绿灯重跑。该脚本只查此竞态，没有测试服务器或端口。脚本、日志在系统 TMP。未发现实现行为错误，已经向主会话报告，因此不修改 session 实现。

## 修复差异

只有 `src/ai/cloud/cloud-chat.test.mjs` 的 CAU-SES-01b 测试（断线保留运行状态并显示重连）改动：

- 使用受控事件流和断线/恢复两个显式闸门，连续交付前三条，不靠 1 ms 定时器造竞态。
- 用同步订阅捕获状态快照并兑现 promise，取代对短暂 `live/3` 的 5 ms 轮询；同样捕获断线发布状态和续接后的 live/4。
- 保留 3000 ms 防卡死超时，未放宽超时。断线前、断线时、新连接等待事件期间和续接后均检查 streaming 为 true。
- 检查续接 after 精确为 `[0, 3]`，新流尚未收到事件时维持 reconnecting，补发 seq 4 后恢复 live；关闭/断线如误发 abort 就使测试失败。
- 注册 `t.after` 释放闸门、关闭 session，断言失败也清理。

实现、UI、产品接口、语义文档均未改；私有切换、FIFO、旧对话和四档气泡不在本任务范围。

## 尝试与验证

1. 读取原集成失败日志，确认唯一 CAU-SES-01b 失败发生在旧 live/3 waitFor；既有集成失败原始 4928/4926/1/1、66168.1248 ms 保留。
2. 可控竞态证明脚本只运行一次，退出 0（旧谓词按设计 timeout，订阅证实曾出现目标状态，session 最终运行状态正确）。
3. 修复后针对性 `npm test -- src/ai/cloud/cloud-chat.test.mjs` 只运行一次：19 tests、19 pass、0 fail、0 skipped、duration_ms 1549.7535，墙钟 1.9119644 秒，退出 0；CAU-SES-01b 为 31.135 ms，无包装器重跑。
4. 提交 `329188e3` 后，最终类型检查只运行一次：先父仓库 `require.resolve('typescript/bin/tsc')`，再 `node <路径> -b --force`，退出 0、零诊断，墙钟 17.7784273 秒。
5. 同一提交最终全量 `npm test` 只运行一次：退出 0，墙钟 74.7827626 秒；CAU-SES-01b 通过，为 47.0492 ms。原始摘要：

```text
ℹ tests 4928
ℹ suites 0
ℹ pass 4927
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 74363.5611
✓ npm test 最终结果：零失败
```

6. 最终 `git diff --check` 零错误。相对起点只有测试文件和本报告；没有实现或其它文档变更。类型与针对性/全量测试均无包装器异常退出或自动重跑，原始集成失败仍保留记录。

日志：系统 TMP 的 `promptcut-session-race-proof.log`、`promptcut-session-fixed-target.log`、`promptcut-session-final-types.log`、`promptcut-session-final-tests.log`。

没有通过反复重跑掩盖原始失败。没有安装依赖、建 junction、改 Python 环境、启动服务、占用任何端口、操作节点或用户进程；所有 Node 命令均使用本命令绝对静默预载及指定 Python/无字节码环境。

## 交回与未达成

报告开工提交 `ed586513`，测试修复提交 `329188e3`，最后报告证据单独提交。工作分支交回后由主会话审查并重跑集成基线；原集成失败不是由这份子分支绿灯自动改为通过。没有待决产品语义或未达成修复项，未进行部署、发版和渲染验收（测试修复不改画面）；所有既有产品决定保持原样。
