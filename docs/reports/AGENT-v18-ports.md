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
