# AGENT-v18-ports2：测试里剩下的写死端口

分支 claude/v18-ports2，只改测试文件。做法：向系统要空闲端口（`server/test/free-ports.mjs`）。

## 新增的取端口函数（free-ports.mjs）
- `freePortRange(count)`：要一段连续都空闲的端口，夹具里「基准端口 + 代号」那种用法用。
- `runnerPorts()`：给 `startRunnerProcessFixture` 的一整组端口（combo 七个、agent、masterEvents、look、renderWorker、identityBase 与 controlBase 各一段十六个连续端口）。

## 已改（原来写死的端口 → 现在）
| 文件 | 原端口 | 现在 |
|---|---|---|
| cloud-tools-w1-browser.test.mjs | 28380 | freePort() |
| cloud-tools-w1-egress.test.mjs | 28390～28393，另有一处字面 `mixed.test:28390`、`SITE_PORT + 5`（会在端口接近上限时溢出） | freePorts(5)；字面端口改成 SITE_PORT；`+5` 改成另取的 OTHER_PORT；注释里的端口改成占位 |
| cloud-tools-w1-restart.test.mjs | 28400、调试口 28401 | freePorts(2) |
| cloud-tools-w1-site.mjs | 只有注释提到端口段 | 改注释 |
| account-runner-process.test.mjs | 夹具缺省 28220～28250 段 | `ports: await runnerPorts()` |
| account-master-production.test.mjs | 28680～28720 | runnerPorts()，断言里读 `f.ports.masterEvents` |
| accept-018-auth-agent-path.test.mjs | 28713～28734 | runnerPorts() |
| accept-018-conv-endtoend.test.mjs | 28691～28699、28705～28739 | 去掉 base 参数、runnerPorts() |
| accept-018-conv-runner-fixture.mjs | ACCEPT_BASE_PORT 28580 起 9 个 | freePorts(9)；去掉 base 参数与 ACCEPT_BASE_PORT 导出（只有 endtoend 用） |
| accept-018-files-account-fixture.test.mjs | 28590～28596 | freePorts(7) |
| cloud-tools-c1-bridge.test.mjs | SOURCE_PORT 28830 | freePort() |
| cloud-tools-p1-shots-real.test.mjs | 28601 | freePort() |

accept-018-conv-controls 与 accept-018-conv-readexception 两个文件本身没有写死端口（只用 accept-018-conv-stack.mjs，里面不开端口），不用改。

## 没改，留在表里
| 文件 | 端口 | 原因 / 留给谁 |
|---|---|---|
| server/test/fixtures/account-real-runner.mjs | REAL_RUNNER_PORTS 6700 段、agentPort 6706、controlPort 6709 | 别的分支在改；测试 account-real-runner.test.mjs 已传 freePorts，只有不传的调用者才落到缺省 |
| server/test/fixtures/cloud-queue-user-path.mjs | 缺省 6520 段、6526 | 同上 |
| server/test/fixtures/account-dual-user-path.mjs | 缺省 6380 段；内部 `assetPort: 6389` 写死 | 同上；用它的测试都已传 freePorts，但内部 6389 仍写死 |
| server/test/fixtures/account-password-user-path.mjs | 缺省 6680 段、6687；内部 `assetPort: 6539` | 夹具，本次没碰；测试已传 freePorts，内部 6539 写死 |
| server/test/fixtures/account-conversation-controls-user-path.mjs | 缺省 6620 段、6627，断言 agentPort 在 6620～6639；内部 `assetPort: 6539` | 夹具内部断言端口段，没动 |
| server/test/fixtures/account-executor-visible.mjs | 缺省 6640～6642；探针里 6643 | 测试已传 `[0,0,0]` |
| server/test/fixtures/account-runner-process.mjs | RUNNER_PORTS 28220～28250 段 | 保留作缺省；现在所有测试都显式传 runnerPorts() |
| server/test/cloud-tools-w1-host.test.mjs | 28380 | 只是字符串（假会话，不监听），不会撞 |
| server/test/fixtures/accept-018-auth-kit.mjs | 手动设 ACCEPT018_AUTH_PORT_BASE 才用 28560～28599，缺省随机 | 非写死 |
| 其余（5399、5190、6700、8445 等） | 出现在配置、断言文字、伪造数据里 | 不监听，不会撞 |

## 探针脚本（scripts/probes/，不在范围）里还有写死的端口（节选）
cloud-tools-w1-browser-probe.mjs（28411）、account-conversation-controls-probe.mjs（6620 段）、account-executor-visible-probe.mjs（6643）、account-public-user-pages-probe.mjs（6508）、account-user-pages-probe.mjs（6348）、asset-root-cgroup-os-probe.mjs（6540）、below-diff-measure-probe.mjs（27800、27804、27810）等，以及一批 `--port 5xxx` 的缺省值。

## 验证
见提交后追加。
