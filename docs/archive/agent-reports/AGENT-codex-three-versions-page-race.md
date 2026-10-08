# 云端页面结果测试竞态修复报告

任务：独占定位第二次 root 集成全量中的 CA-REV-10 页面结果测试失败；只修改 `server/test/cloud-agent-page.test.mjs` 和本报告。

工作分支 `codex/three-versions-page-race`，起点 `5525bdab`（含最新 main `bf6e48e6`）；不触碰其它工作区、不合并、不推送。

原始候选 d6ed437c 全量：4928 条、4925 通过、2 失败、1 跳过，duration_ms 115964.235，墙钟 116.45767 秒。本任务只处理 CA-REV-10（页面回答所有权、重复回答、迟到与不重放），用例耗时 6666.34 ms，原断言为前四个完成结果固定排序，实际第四个为第二请求 alice200 而不是首请求重复410；另一失败由 Astra 独占。

已读 AGENTS 入口、开发者指南、建议行为和硬约束。先建报告独立提交。后续：独立受控证据、最小测试修复、针对性与最终类型/全量各一次。禁止通过加 sleep、放宽语义或反复重跑抹去原失败。

## 根因与独立受控证据

已读原 root 日志，确认失败在 `statuses.slice(0, 4)` 固定完成顺序，第四项实际第二个请求 alice200。两个 `page.request` 分别启动 `void answer()`，服务层接受首个 alice 回答即兑现首请求工具 Promise，Agent 可以发布第二个 pause；首请求的重复 HTTP 响应并无先于第二请求回答完成的因果约束。

HTTP 层读完 body 后同步 `service.pageResult()` 再发送 HTTP 回包，因此“工具可继续”与“测试收到回包并记进数组”属于不同观察点。没有证据表明所有权、一次性消费或 HTTP 实现错误；不改实现。

独立证据在系统 TMP 生成仅含原 CA-REV-10 的副本，仍调用当前分支真实回环文档服务、Agent 服务、SSE 与 HTTP，仅把首请求实际 410 回包的客户端观察用 Promise 闸门暂挂，待第二个 alice 回答被记录再释放。没有增加 sleep，也没有修改服务实现或返回值。受控副本先按请求 id 断言真实五次回答，再执行原全球排序断言：

```text
CONTROL: first request duplicate already returned HTTP 410; defer observation until second alice answer
CONTROL: actual HTTP ownership, anonymous denial, success and duplicate per-request all passed:
[[bob,404,not-found],[anon,401,unauthorized],[alice,200,true],[alice,200,true],[dup,410,page-request-gone]]
原 statuses.slice(0,4) 断言失败：第四项 alice200，原期待 dup410。
```

此证明只跑一次，明确保留失败：1 test、0 pass、1 fail、0 skipped、duration_ms 5221.6315，墙钟 5.5601944 秒，退出 1；失败的原断言耗时 1885.2051 ms，无包装器自动重跑。每个请求内四/一次回答全部成立，证明固定全球回复顺序不是语义保证。

## 逐文件差异

- `server/test/cloud-agent-page.test.mjs`：只改 CA-REV-10。按 `page.request.id` 建结果 Map，每次交付同步登记并拒绝重复 id；每请求的 bob404、anon401、alice200、重复410按原有顺序精确比较。第二请求单独精确比较 alice200；断言恰好两个不同 id 和两个回答任务。跟踪 answer Promise，显式 `Promise.all` 等待所有异步答复并传播失败，替代按全球数组长度轮询。两个请求仍并发处理，不人为串行。SSE 请求工具、参数、无 seq、两个工具成功、结束后迟到410、补发无 page.request、不存在404、非法400的断言全部保留。
- 本报告：记录原集成失败、受控证明、修复范围与验证证据。

首份修复没有加 sleep 或放宽权限/一次性/工具结果断言；聚合等待曾失去原 3000 ms 防卡死上限，已在下文 root 审查补充中修正。没有修改实现、产品、UI、接口或语义。

## 尝试与验证

1. 一次受控副本证明，原错误排序断言按预期失败，完整摘要见上文；不是重跑到通过。
2. 修后标准针对性 `npm test -- server/test/cloud-agent-page.test.mjs` 只跑一次：12 tests、12 pass、0 fail、0 skipped、duration_ms 8549.3045，墙钟 8.8410086 秒，退出 0。CA-REV-10 为 1577.3832 ms，无包装器自动重跑。
3. 修复提交 `103620d1` 后类型检查一次：父仓库解析 TypeScript 后执行 `node <路径> -b --force`，退出 0、零诊断，墙钟 14.34742 秒。
4. 同提交全量 `npm test` 一次：退出 0，墙钟 66.688682 秒；CA-REV-10 通过，为 2540.3132 ms。原始摘要：

```text
ℹ tests 4928
ℹ suites 0
ℹ pass 4927
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 66304.7732
✓ npm test 最终结果：零失败
```

针对性与全量均无异常退出、自动包装器重跑或断言失败。原 root 两项失败仍保留，子分支绿灯不代替 root 收回后的集成验收。

5. `git diff --check` 退出 0；仅 Git autocrlf 换行提示。对起点只改测试和报告，工作区最终干净。

日志为系统 TMP 的 `promptcut-page-race-proof.log`（受控原断言失败）、`promptcut-page-race-target.log`、`promptcut-page-race-types.log`、`promptcut-page-race-full.log`。全量所需模型权重只在该命令进程设为主仓库现有 `out/models`，未安装或改写环境。

所有 Node 测试命令使用父仓库绝对静默预载、指定既有 Python 及无字节码环境；日志在系统 TMP。沿用现有测试端口0随机监听，只使用测试自建回环服务；没有占用用户端口或改宿主机网络。不安装依赖、不建 junction、不改 Python 环境，不触碰节点、main、版本、release 或其它工作区。

## 交回

开工报告提交 `8bcc8234`，测试修复提交 `103620d1`，最终证据单独提交。不合并、不推送。没有待决产品语义，也没有发现需要扩范围的实现错误。另一独占进程树修复不在本分支里；主会话整合两份修复后重跑真正集成基线。

## root 审查补充：答复聚合的有界等待

root 逐行审查 `3e223fa8` 后发现：旧 `waitFor(statuses.length === 5, 3000)` 对答复收齐有 3 秒防卡死上限，首份修复的 `Promise.all(answers)` 失去该上限。本报告原“未放宽超时”因此不准确；第一轮 target/type/full 全绿仍保留原始证据，但不能证明答复永久不完成时测试会及时失败。

本次实质补充不改变按 request ID 的断言和两请求并发，仅将聚合等待改为 `Promise.race([Promise.all(answers), 3000 ms 拒绝])`，并在 `finally` 中清 timer。回答失败照常拒绝，晚到的拒绝也由已挂上的 Promise handler 接住；既有回答 Promise 的即时 catch 与后续聚合传播保持。计时器是原有防卡死 deadline，不是增加 sleep，也没有扩大 deadline。

新修改后针对性、类型和全量各一次作为审查复验，结果待补；不是重复旧提交直到通过。未改其它文件或产品实现。

本次补充验证：

- 标准针对性只跑一次：12 tests、12 pass、0 fail、0 skipped、duration_ms 8574.1558，墙钟 8.8769175 秒，退出 0；CA-REV-10 为 1666.4964 ms，没有包装器自动重跑。
- 系统 TMP 的受控脚本直接提取当前测试的聚合等待源码，注入可控计时器，不等待真实 3 秒：成功时清 timer、回答失败传播同一 Error 并清 timer、计时器参数严格 3000、超时拒绝并清 timer、超时后回答再拒绝也无 unhandledRejection。全部断言通过，退出 0，只运行一次；源码没有新增 sleep。日志 `promptcut-page-race-bounded-proof.log`。

- `c1d3f8c7` 后类型检查一次：父仓库解析 TypeScript，`node <路径> -b --force` 退出 0、零诊断，墙钟 11.4865958 秒。
- 同提交全量 npm test 一次：4928 tests、4927 pass、0 fail、1 skipped，退出 0；duration_ms 64588.2746，墙钟 64.9609395 秒。CA-REV-10 为 2474.822 ms。原始摘要：

```text
ℹ tests 4928
ℹ suites 0
ℹ pass 4927
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 64588.2746
✓ npm test 最终结果：零失败
```

审查补充后的针对性、类型与全量均首次通过，没有失败、异常退出或包装器自动重跑。日志为系统 TMP 的 `promptcut-page-race-bounded-target.log`、`promptcut-page-race-bounded-types.log`、`promptcut-page-race-bounded-full.log`。原受控证明失败和原集成失败没有删除或被重跑结果替代。最终 diff-check 退出 0；对当前审查前提交只增加有界聚合及本报告证据；仍仅原两文件，工作区干净。不合并、不推送。
