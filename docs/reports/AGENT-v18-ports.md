# AGENT-v18-ports：测试端口不再写死

分支 claude/v18-ports。目标：一次 npm test 里各文件之间、同一台机器上两个 npm test 同时跑，都不因端口互撞。

## 办法
新增 `server/test/free-ports.mjs`：`freePorts(n)` 同时监听 n 个端口 0、读回实际端口再一起关掉（同一次要到的两两不同），`freePort()` 是 n=1。系统分到的是临时端口区间（Windows 49152 起），不落在 5xxx、58xx、59xx。能直接监听 0 再读回的，就不用它。没有一处用跨进程锁或串行段，没有改产品代码，没有删断言。

## 逐文件
| 文件 | 原来写死 | 现在 |
|---|---|---|
| account-hosted-wiring | 5823（账号内部服务，中途关掉再在同一端口重开，还写进子进程环境变量）、5824/5826/5827/5828（doc 服务）、5825（doc 内部）、5829（就绪探测服务） | 5823 改为第一次监听 0、读回后记成 accountPort，重开仍用它（必须同端口，所以不能每次要新的）；其余全部监听 0 并读回 |
| account-v2-install-plan | 6440～6445（写进部署清单、环境文件，由真实的 account/doc/asset 子进程监听） | fixture 改成 async，用 freePorts(6) 生成清单里的三个服务端口和三个内部端口；断言端口已关闭处改用清单里的值 |
| asset-doc-client | 5865 | 监听 0，origin 读回 |
| asset-wiring-integration | 5860～5866、5869（账号、doc、doc 内部、asset 公共、asset 内部、丢 ACK 代理、combo 的 asset） | freePorts(7)，由变量传给 combo、子进程环境变量、受控夹具配置 |
| fixtures/asset-entry-controlled.mjs | 5863/5864 | 从配置 JSON 读 assetPort、assetInternalPort（上面的测试写入） |
| cloud-run-assets-central-mount | 6447 | 监听 0 读回 |
| cloud-run-assets-central-private-tls | 6440/6441/6442 | freePorts(3) |
| cloud-run-assets-central-tls | 6445/6446 | 监听 0（原本就读回 address） |
| cloud-run-assets-current-observer-tls | 6448 | freePorts(1) |
| cloud-run-assets-current-vertical-tls | 6448/6449、6446 | freePorts |

## 没改的，以及原因
- skill-mcp.test.mjs 里的 5881～5885、four-stage-acceptance.test.mjs 里的 5880 等：不是监听端口，是写进假端口文件的数字、移端口函数的纯输入、禁区范围表，不绑定任何东西，所以不会撞，保持原样。skill-mcp 里真正要监听的地方本来就是监听 0。
- 没有"没法改成动态"的情况：证书里不含端口（只有 127.0.0.1），清单与环境变量都由测试自己生成。
- 范围外但还有写死端口的测试（未动，供主会话决定）：account-assembly-central（5770～5775）、account-assembly-fence-transport（5776）、account-executor-assembly（6641）、account-real-runner-sse（6707）、agent-access-http（5790）、agent-run-scope-doc（6712）、agent-worker-settlement-client（6713）、asset-project-close-boundary（5783）等，grep `listen\(\s*[0-9]{3,5}|port: ?[0-9]{4,5}` 可列全。
- 注意：这些端口来自临时区间，别的程序也可能用，要到和使用之间有极小的竞争窗口；三轮并发没遇到。

## 验证
- 改之前：两个 npm test 同时跑上述 11 个文件，A 失败 3 条（EADDRINUSE 127.0.0.1:5823 等），B 失败 2 条（EADDRINUSE 6440、6448），各 64 条。
- 改之后：同样办法连做三轮，每个进程 64 条全过、0 失败、0 个 EADDRINUSE、退出码 0。
- `npx tsc -b --force` 退出码 0。
- 整套 `npm test`（设两个环境变量）：6121 条，通过 6113，失败 0，跳过 8，与 main 一致。

# 第二批

先 `git merge main`（快进到 a21c1db1）。新增 20 个文件的批量验证（`scripts` 外，清单见下）：改之前两个进程同时跑，A 进程 109 条里失败 22、B 进程 105 条里失败 25，大量 `EADDRINUSE`（34 与 38 处）；改之后连做三轮，6 个进程都是 109 条全过、0 失败、0 个 EADDRINUSE。`npx tsc -b --force` 退出码 0；整套 `npm test` 6121 条，通过 6113，失败 0，跳过 8，没有触发重跑。

## 一、测试里的写死端口（都在 server/test/ 下）
| 文件 | 原来 | 现在（只列取端口的改动） |
|---|---|---|
| account-assembly-central | 5770～5775、5779（账号、doc、doc 内部、asset 公共、asset 内部、读控制、combo 的 asset） | 开头 `freePorts(7)`（第一个"必需拒绝"用例 `freePorts(2)`），所有字符串、环境变量改用变量 |
| account-assembly-fence-transport | 5775、5776、5777、5778、5779 | `setup` 传 0，把读回的端口存成 `service.testPort`，其余处引用它（含 ws 地址） |
| account-real-runner-sse | 6707 | 监听 0，请求地址读 `server.address().port`，仅 2 行 |
| account-real-runner（测试） + fixtures/account-real-runner.mjs | 6700～6706、6708、6709 | 夹具给 `startAccountRealRunnerFixture` 加可选参数 `ports`、`agentPort`、`controlPort`，缺省仍是旧值（探针 account-real-runner-probe 依赖旧值）；测试传 `freePorts(9)`。夹具改了 3 行：函数签名、`ports: [...ports], agentPort,`、`controlPort,` |
| agent-access-http | 5790、5791 | `freePorts(2)` |
| agent-read-control-transport | 6600、6601 | `freePorts(2)` |
| agent-runner-control | 5795、5796、5797 | 都改为监听 0 再读回 |
| agent-run-scope-doc | 6712 | 监听 0，读回成 `ownedPort` |
| agent-worker-settlement-client | 6713 | `freePort()`，origin 与监听、诊断文字都用它 |
| cloud-queue-http | 6602、6603 | 6602 用 `freePort()`，6603 监听 0 读回 |
| asset-project-close-boundary、asset-project-workers、asset-project-entries + fixtures/asset-project-service.mjs | 5780～5784、28090 | 夹具默认端口改 0 并读回实际端口，三个测试不再传 port；其余本地监听改 0 |
| operation-wiring-fixture、operation-wiring-child、operation-wiring-crash、run-authority-operation-fixture | 5760、5761、5730 | 夹具默认 0 并读回；child 与 crash 测试不再传 5761 |
| project-selections | 5920 | 监听 0 |
| account-password-user-path、account-logout-confirmation | 6680～6687、28140～28147 | 测试内 `freePorts(8)`（一个给 Agent，七个给底座） |
| account-dual-user-path | 夹具缺省 6380～6388 | 测试传 `freePorts(7)` |

## 二、没有改的数字（不是监听端口）
account-executor-assembly 的 6640/6641（命令行拒绝配置的输入，根本不监听，所以也不碰另一个子 Agent 在改的文件）；account-task-worker-child 6700、agent-worker-session 6700、agent-worker-registration-mtls 6702、cloud-run-assets-current-registry-v2 6553（假配置或"监听前就拒绝"）；agent-run-scope-core 6540（解析 /proc 文本的输入）；hosted-render-*、sp-*、c10-*、api-guard 等里的 5xxx、8xxx（地址字符串或假返回）。夹具缺省值 account-conversation-controls-user-path、cloud-queue-user-path、account-dual-user-path、account-password-user-path 的默认端口表保留，因为 scripts/probes 下的其他探针（account-user-pages、cloud-queue-user-pages、project-member-controls、account-conversation-controls、account-real-runner）把同一批端口写进浏览器地址和舞台地址，改缺省值会连带坏它们；这些探针不是本批范围，仍写死，会和同时跑的探针互撞，留给主会话决定。

## 三、account-password-user-path-probe.mjs（只做了 node --check，没有真跑）
改了：文件开头用 `await freePorts(10)`（导入自 server/test/free-ports.mjs）取代 `PORTS`；`ORIGIN` 取第 7 个端口（HTTPS 入口）；两个舞台端口取第 9、10 个，`STAGES` 由它们拼出 `http://s1.pc.localhost:<端口>`；起舞台处循环 `STAGE_PORTS`；启动底座时传 `ports: PORTS.slice(0,7), agentPort: PORTS[7]`。底座 `fixtures/account-password-user-path.mjs` 本身不用改（本来就接受 `ports`、`agentPort`）。主会话重跑时注意：浏览器的 `--host-resolver-rules` 只映射 s1/s2.pc.localhost 到 127.0.0.1，端口无关，不用改；开头"端口可用"检查现在对刚要到的端口恒真；结果里的 `cleanup.portsFree` 检查的是这次的端口；日志、结果里的端口号每次不同，别拿固定号去匹配。

## 四、两处偶发超时（只调时限）
- agent-live-selection 第 101 行（等 8000 ms）：等的是模型脚本调用 get_selection 后的 `tool_result` 事件。`onEvent` 在 `startHostedRun` 时就挂上，事件不会漏；慢的是第一次用到代理工具时 vite `ssrLoadModule` 现编译一批 ts 模块，吃 CPU。单独跑整份文件 1.5 秒。结论：时限紧，没有时序问题。放宽到 30000 ms。
- cloud-agent-runs CA-PAGE-01（第 603 行等 20000 ms）：等 c-p1 的 `tool_result`。订阅用 `subscribe(..., 0, ...)` 从头回放，订阅晚了也不丢；脚本先睡 400 ms 再调 add_cut，同样首次加载工具模块。单独跑该用例 1.9 秒。结论：时限紧，没有时序问题。放宽到 60000 ms（整个用例超时 240 s 不变）。时限只防卡死，不是通过条件。

# 第三批：real-runner 忙时失败并卡住、npm test 看门

## 一、为什么失败
`account-real-runner.test.mjs` 等一轮真实运行结束（`runner_done` 且 `activeRuns===0`），时限 40 秒，整条用例时限 90 秒。机器忙时（五六个子 Agent 同时跑测试）这一轮要跑得更久，于是 40 秒超时抛 `actual-runner-output-timeout`（加上启动约 6 秒，对上"46 秒后失败"）。单独跑 11 秒。**和第二批改的 `fixtures/account-real-runner.mjs` 的端口参数无关**：端口只是换了取法，不影响耗时；失败原因是时限紧加这一轮没跑完。没有发现时序问题（轮询 `rows` 是读当前状态，不是等一次性事件）。

## 二、为什么失败后进程不退出（已用小实验复现）
把等待时限临时改成 300 毫秒让它必然失败，复现了"进程不退出"（120 秒仍在，被 timeout 杀掉）。根因：失败时这一轮还在跑，`finally` 里关执行器会被产品拒绝（`account-runner-pending`，因为不许在运行中收尾），`fixture.close()` 在 `cloud-queue-user-path.mjs` 的 `close()` 里关到一半抛出，后面的 HTTPS 入口、combo、账号服务等端口（`TCPServerWrap` 等）都没关，进程因此退不出。`close()` 里是顺序 await，前面一个抛出就跳过后面所有收尾——这个文件现在有别的子 Agent 在改，我没碰。

改法（只动测试）：`finally` 里先等 `activeRuns===0`（最多 90 秒）再收尾，这样关的时候是干净的；等待时限 40 秒放宽到 120 秒、用例时限 90 秒放宽到 240 秒（只防卡死）。未做的：`cloud-queue-user-path.mjs` 的 `close()` 应改成每一步各自 try/catch、全部执行完再汇总抛出，建议归另一个子 Agent。同类"失败就不收尾"的写法：我查了用这批底座的测试，其余都用 `try/finally` 或 `t.after` 收尾；唯一的共同隐患就是上面这个 `close()` 的"中途抛出跳过后面"。

## 三、npm test 的保险
评估：
- (a) node 自带 `--test-force-exit` + `--test-timeout`（node v24.19.0 支持）。小实验：失败后还有监听的文件，加 `--test-force-exit` 后 0.16 秒退出，仍记失败；永不结束的测试靠 `--test-timeout` 在时限到时记为失败（`test timed out after N ms`）并退出；测试自己写了更长 `timeout` 的不受影响（实验：自带 30 秒时限的测试跑 6 秒通过，没时限的被 3 秒时限判失败）；通过但留着监听的文件仍记通过、整体零失败。对每个文件的子进程都生效。
- (b) 在 `scripts/test-suite.mjs` 自己做看门：node 的测试运行器只启一个父进程，每个文件是它的孙进程，要从事件流里找出文件对应的进程再杀进程树，实现复杂，且容易误杀。
选 (a)：`scripts/test-suite.mjs` 的 `baseArgs` 加了 `--test-force-exit` 和 `--test-timeout=1200000`（20 分钟，环境变量 `PROMPTCUT_TEST_TIMEOUT_MS` 可改，验证看门时改小用）。不改变通过与失败的判定。限制：被强制退出的文件不会单独点名（强制退出只发生在测试都结束之后，失败仍按失败点名）；因超时失败的测试按名字出现在"failing tests"里。

验证（用完已删，不在仓库里）：`out/zz/` 下三个小文件。①失败且留着监听的文件，②永不结束且有定时器的测试，两者一起用 `PROMPTCUT_TEST_TIMEOUT_MS=8000 npm test -- …`：在 8 秒内结束，列出两个失败（含 `test timed out after 8000ms`），最终"仍有失败"，退出码 1。③通过但留着监听的文件：通过、"零失败"、退出码 0。
