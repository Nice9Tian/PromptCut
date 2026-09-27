> 草稿（2026-09-27 PC 主会话写，交接时带进仓库）：合入时补完、去掉 `.draft` 改名为 `REPORT-HT-a.md`，并归档对应的 AGENT 报告。文中 scratchpad 路径指 PC 本机，只作记录。

# HT-a 阶段报告：文档服务的会话模型 + 序号确认（草稿）

契约 `docs/plan/http-transport-contract.md` 第 2 版（2026-09-27 拆分为 HT-a / HT-b；第 16 节是开工后的裁定，`c1ac3ca`）。

## 0. 过程
- `claude/ht-tests`（`opus-dev`，从 main `dc28209` 拉出，提前开工〔裁：只新增测试文件，与 C10a 不冲突〕）：
  - 提交 `1542c7d`、`d763f31`、`dadf7bd`、`16791af`、`0d84758`、`dc50cdd`、`abd7bf5`、`f73d3bf`；报告 `AGENT-ht-tests.md`。
  - 63 条：ht-legacy 3、ht1-session 22、ht2-backpressure 5、ht3-equivalence 1、ht4-client 22、ht5-probe 2、ht6-trust 5、ht7-probe 3；此刻真跑 5 条、跳过 58 条（按 `session.mjs`、`session-link.mjs`、`PROMPTCUT_TRUST_LOOPBACK` 三个门判）。tsc 0；npm test 3057 / 2998 / 0 / 59。
  - 参考实现自检（不提交）：63/63；HT1/2/3/4 + legacy 连跑三次 53/53；两处故意错改（接续后不补发、重发当跳号）都被抓住。
  - 提醒实现方：信任开关接到 `createSharedDocService` 后 `sp-hosting.test.mjs` 的 SPH-SP3（`trustLoopback: false` 且无集群令牌）会失败并挂住，契约第 15 节本就预期要改这个测试文件。
  - HT7：部署后 `node scripts/probes/ht7-probe.mjs --base https://8-219-80-16.sslip.io/hosted`（不给 `--base` 什么都不连）。
- 主会话裁定（契约第 16 节）：WebSocket 接续失败以 4404 / 4410 关闭；HT-a 只验 HT1/HT4 的 WebSocket 部分（主计划第 7 节同步）；假设 H1～H14 集成时对账。

## 1. 实现分支（以 C10a 集成分支为底提前开工〔裁：与 C10a 文件重叠，C10a 合入后合 main〕）
- `claude/http-transport`（续用，`opus-dev-high`，5600～5609；报告 `AGENT-http-transport-ht-a.md`）：`e0515c4` 合 `claude/c10a-integ`（冲突两处：契约取 C10a 一侧；`vite-plugin-frames.ts` 保留第 1 版选端点、加 C10a 的 `cards: null`，留给 ht-client 换成 `createDocEndpoint`）；`723e598` 报告；`d63eaca` 会话层 `session.mjs` + `service.mjs` 接会话项、4009 替换半开、接续失败先接受升级再 4404 / 4410 / 1002 关闭（`ws.mjs` 加 `closeNow`）、`/healthz` 换 `sessions`、模块不许认领 `session.` 前缀、旧客户端不变；`6f30158` `PROMPTCUT_TRUST_LOOPBACK` 接四处、删旧名、`0` 无集群令牌拒启（`cluster-token-required`）、托管 pm2 配置写 `0`、部署脚本无令牌退出 5；`f7b9591` `http-transport.mjs` 重做到会话层之下、不接线，删第 1 版两个测试文件；`2a7337d` 报告。
  - 验证：tsc 0；npm test 3253 / 3251 / 0 / 2；测试方 HT1（WebSocket）+ HT2 + legacy 原样 21 过 9 挂（都在 `resumeStatus` 按旧写法等握手 404 / 410），按第 16 节改那一行后 30/30；HT6 5/5；新长轮询单测 10/10；sp-hosting 14/14；五组合跑两次 45/45。
  - 裁定〔裁〕：`resumeStatus` 集成时在 kit 里对账；**按字节确认**（未确认已收满 64 KiB 立刻 `session.ack`）接受、两端照做、写进契约第 3.3 节（已告知 ht-client）；契约实现记录集成时补第 17 节；`run-t9-local.sh` 的旧变量名合入时改为 `PROMPTCUT_TRUST_LOOPBACK=0` 加现场生成的集群令牌；阿里云 `secrets/cluster-token` 已在（上次部署输出 present）。
- `claude/ht-client`（`opus-dev-high`，5610～5619，从 `aa9a85b` 拉出；报告 `AGENT-ht-client.md`）：13 个提交——`08b3449` 报告开工；`69d3070` `server/render-node/session-link.mjs` 的 `createDocEndpoint`（`index.mjs` 导出）；`e533bf1` 用例 `session-link.test.mjs` 与最小会话服务端桩 `session-gateway-kit.mjs`；`f05b739` `vite-plugin-frames.ts` 三处改用 `createDocEndpoint`、`doc-link.mjs` 每条对话连接一个会话；`25422e9` 页面 `SyncLink` 讲会话（`dropFor` 改为结束会话，新增 `cutTransport`、`__pcSyncTest.cut/link`）与页面用例；`91bad41` 两个探针加 `--transport auto|ws`（`http` 退出码 2）；`6dad2a3`、`3856521` 只改注释；`9a69753`、`821d59a` 网关桩加 HTTP 直通、旧客户端直通、`cutAll` 与「旧服务端」前端；`c724836` 按字节确认（满 64 KiB 单发 `session.ack`）；`452f6ca` 报告。
  - 验证：tsc 0；npm test 3258 / 3256 / 0 / 2；测试方 `ht4-client` 22 条临时拷入 19 过 3 跳（`HT4-real-*` 要服务端会话层）；叠上服务端文件预演（不提交）HT4 22/22（含 3 条 real）、HT3 与 ht-legacy 全过、HT5 自动与强制 ws 都过，HT1 7 条、HT2 2 条失败都因 kit 的 H5 还按握手 404 / 410（第 16 节已改 4404 / 4410）；`session-link` 11 条、`session-link-page` 4 条各连跑 3 遍稳定。
  - 页面验证（5610～5616）：托管组合 5613/5614 + 会话网关 5615 + dev server 5610；加入共享项目后 `setProject` 改 6 次，中间服务端掐断一次、页面关一次 WebSocket：页面版本 7 = 服务端版本 7 = 1 + 6，`project.op` 6 条、opId 6 个不同，页面轨道与服务端逐项相同，同步状态全程 `online`，接续 2 次、会话 1 个、丢弃 0；截图有「断前 1、服务端断开期间 ×3、页面断开期间 ×2」。
  - 偏离契约（交集成写进第 17 节）：旧服务端退化（第一条不是 welcome 就「一条传输一个会话」，250 ms 无消息发 `session.ack {ack:0}` 探测）；页面未确认上限 32 MiB（节点 1 MiB）；只有 1005/1006/1011/1012/1014/1015 算传输故障会接续；4410 上报 code 4410、原码在 reason；契约外接口 `onConnectFail`、`renew: false`、`dropTransport()`、`welcomeTimeoutMs`。
- 主会话对 ht-client 所提问题的裁定〔裁〕（交 `claude/ht-integ`）：上面的偏离接受并写进第 17 节；**4410 的上报**不许改变用户看得到的行为——原关闭码属于「连着时收到也不重连」的一类就按原码报给上层、不重建（例如脱开期间项目被删，页面照旧提示「项目已删除」），否则报 4410 并重建；`server/card-sync.mjs` 等仍用旧 `createWsEndpoint` 的几处不在 HT-a 接入清单，走旧客户端路径、行为不变，列进第 17 节与 `TODO.md` HT-b 条目作后续项；按字节确认写进第 3.3 节。
- `claude/ht-integ`（`opus-dev-high`，5620～5629，从 `aa9a85b` 拉出；报告 `AGENT-ht-integ.md`）：`8853896` 报告开工；`ec9f03c` 合 http-transport（无冲突）；`fd5dc42` 合 ht-client（4 处冲突按裁定处理：`vite-plugin-frames.ts` 取客户端并保留 `hostAssetClient` 的 https 一行，`shared-config.mjs` 取客户端去掉 `transport`，`render-node/index.mjs` 两边导出都留，探针取客户端）；`8698ead` 合 ht-tests；`6cd2314` 合 main `19f1dec`；`1561818` kit 假设对账（H5 读 4404/4410 关闭码折成 404/410，H7、H11 补注，判据不动）；`d5a1d66` 4410 的 reason 带原码且属 4003/4004 时按原码报给上层、不重建（节点与页面共用一处，新单测节点 9 条、页面 3 条，关掉检查有 6 条失败）；`b03823b` 服务端 64 KiB 确认的单测（服务端原已照做，`ACK_BYTES`）；`fdb7c7d` 契约第 3.3、3.4、4.1～4.4 节与新第 17 节（17.1 裁定、17.2 客户端偏离、17.3 服务端补充：`retainMs`/`tombstoneMs`、`/healthz` 计数、长轮询 409、`bad-ack`；17.4 假设对账）；`9405848` `TODO.md` HT-b 条目下记后续项；`de3dbed` `online-join-probe` 认 `PROMPTCUT_TRUST_LOOPBACK=0`；`b257192`、`0d1a70c`、`232897d` 报告。
  - 验证（`de3dbed`）：tsc 0；npm test 3347 / 3345 / 0 / 2，HT 63 条全真跑（legacy 3、ht1 22、ht2 5、ht3 1、ht4 22、ht5 2、ht6 5、ht7 3）；`ht*.test.mjs` 连跑 3 遍 74/74；页面对真会话层（信任关闭、现场集群令牌、同形前缀代理）：页面版本 7 = 服务端 7 = 1 + 6，`project.op` 6 条、opId 不重，页面与服务端项目整份 JSON 相同，状态全程 `online`，端点 open 1、resume 2、close 0、丢弃 0，服务端 `/healthz` resumed 0 → 2；**脱开期间删项目**：服务端以 4004 结束会话，重连后页面弹与连着时相同的阻断框「项目已被创建者删除。回开始页新建或打开别的项目。」（关掉检查时 30 s 内不弹）；T9 本机替身（信任关闭）`ok`、fails 空（plan 8/8、观察端先小后大黑帧 0、主机 5 认领 5 完成、恰好一次 8/8、无缺块）；在线加入（信任关闭）44/44；`stream-produce-probe` 与 `--group` PASS；旧客户端：ht-legacy 3/3、HT2-legacy-compare、SL-page-legacy 过，现有测试期望未改。
  - 集成方列的与语义的出入：只有 WebSocket（HT-a / HT-b 拆分，不算偏离）；`card-sync.mjs`、管理令牌连接（`asset-announce`）与几个探针仍是旧客户端，一次断线就断开；**本机信任是开关**，语义要求经同机反向代理转来的请求不算本机，开关缺省 1 时用户自己在本机托管服务前加代理仍被当本机；服务端没有会话层时客户端退化，语义没写。
- 主会话对集成方待定事项的裁定〔裁〕：C10a 先合 main，再让 ht-integ 合 main（C10a 后来的三个提交随 main 进来）；先合 main `1dad2b7`（含 `claude/test-parallel-safe`，sp-kit 已改系统分配端口）；**本机判定按语义补上**：套接字对端是回环且转发头（`Forwarded` 的 `for=`、`X-Forwarded-For` 每一跳、`X-Real-IP`）里没有非回环地址才算本机，只收紧不放宽，按语义修代码、不改语义；做完重跑 G0、HT、T9 本机替身与在线加入。
- `claude/ht-integ` 第二轮：`442aa8b` 合 main `1dad2b7`（无冲突）；`4a57814` 本机按真正的发起方判断——新文件 `server/auth/origin.mjs` 的 `isLocalOrigin`（对端回环且 `Forwarded` 的每个 `for=`、`X-Forwarded-For` 每一跳、`X-Real-IP` 都是回环才算本机；`for=unknown`、混淆名与主机名都算非回环；开关为 0 时一律不算），接到文档服务握手与共享端点（`shared-service.mjs` 缺省、`vite-plugin-docservice.ts`）、素材服务（托管组合 `isTrusted`、`asset-service.ts` 的 `isLoopbackRequest`）、管理接口 `adminAllowed`、编辑器 `/api` 守卫 `fromLocalClient`；经代理的回环来源在创建者操作限速里记成 `proxied:<对端>`，不再享受本机豁免；核过仓库里没有给本机服务加转发头的一方（vite 无 `server.proxy`、舞台端口代理只写自己的 `x-pc-stage-client`、测试与探针的同形代理原样透传、桌面壳不做 HTTP 转发）；新单测 `local-origin.test.mjs` 6 条（托管组合上 7 组头 × 握手 / 读素材 / 管理：开关 1 时直连与全回环链 101 / 404 / 200、其余 401；开关 0 全 401；去掉转发头检查 6 条挂 4 条）；`77a5b06` 契约第 10 节与第 17.1 节第 5 条；`38633a4` 报告。
  - 重跑：tsc 0；npm test 3353 / 3351 / 0 / 2，HT 63 条全真跑；`ht*.test.mjs` 74/74；T9 本机替身（信任关闭）`ok`、fails 空（plan 8/8、`cardRevAfterEdit` 2；观察端 `joinMs` 376、先小后大、`covered`、黑帧 0；主机认领 5 完成 5、恰好一次 8/8、无缺块）；`online-join-probe`（信任关闭，托管组合报 `trustLoopback: false`）44/44。
  - 与语义的出入剩三条（只有 WebSocket 属 HT-a / HT-b 拆分；`card-sync.mjs` 等旧客户端；服务端无会话层时的退化语义未写），本机信任一条已按语义修掉。

## 2. 验收
（填）

## 3. 顾问调用记录
（填；HT 第 1 版的查资料见契约第 13 节）
