> 2026-09-27 PC 主会话起草（交接时带进仓库），笔记本主会话在第三次修订后补完、合入（第 1.5 节与第 2～4 节）。文中 scratchpad 路径指写那一段时所在机器的本机，只作记录。2026-09-28 PC 主会话派子智能体（分支 `claude/docs-xm-0928`）补进 HT9 与 W-HT-a 云端一侧的结果（第 1.6、1.7、2、4 节，注明「主会话记录」）。

# HT-a 阶段报告：文档服务的会话模型 + 序号确认

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

## 1.5 合 main、部署、HT7（笔记本主会话，第三次修订后）
- C10a 先合入 main（`d7a6fac`、`eb02779`），再由 `8481bd7` 把 main `eb02779` 合进 `claude/ht-integ`（C10a 的低内存档过渡做法与队列优先级档随之进来），无冲突。
- G0（`8481bd7`）：`npx tsc -b --force` 0；`npm test` 3393 / 3391 / 0 / 2（跳过 cards-layout、skill-gate 两条显式开启）；`ht*.test.mjs` 74/74；`npm run build` 与 `vite build --mode online` 成功。HT 不动渲染路径，G0-R 不跑（主计划第 7 节 HT-a）。
- 部署（阿里云）：2026-09-27T14:07:56Z～14:09:03Z，从 `8481bd7` 的在线构建（index.html + 84 个资源，index sha256 `ed807416…`）`deploy-hosted --save --editor dist-online --doc-public-url wss://8-219-80-16.sslip.io/hosted/ --asset-public-url https://8-219-80-16.sslip.io/media/api/asset`；先备份 pm2 配置为 `pm2.config.cjs.bak-20260927-ht`。集群令牌文件 present（0600），pm2 配置写入 `PROMPTCUT_TRUST_LOOPBACK=0`；`promptcut-hosted` 重载一次（restarts 8）。外网 `/hosted/healthz` 200、带 `sessions`；`/media/healthz` 200；`/editor` 的 index.html 与本地构建相同。
- nginx：2026-09-27T14:09:54Z，`/hosted` 补 `client_max_body_size 2m; proxy_buffering off;`（契约第 12 节，HT-b 才用得上，一并加），备份 `/etc/nginx/sites-available/promptcut.bak-20260927-ht`，`nginx -t` 通过后 reload；`/hosted`、`/media`、`/coord` 的 healthz 与 `/editor` 都 200。
- HT7（外网经 443，`ht7-probe --base https://8-219-80-16.sslip.io/hosted`）：匿名 WebSocket 升级 401、带错令牌升级 401、匿名读素材 401、不带令牌调管理接口 401、带错令牌调管理接口 401，`fails: []`。
- 信任关闭下的 C10a 外网演示（2026-09-27T14:10:09Z～14:25:01Z，创建者从 `8481bd7` 起在 5660）：`ok: true`、`fails: []`。plan 5/5，重卡 300 帧、小尺寸 300；刷新后 3.1 s 回到共享项目；手机低内存档、只 1 个舞台、贴小尺寸，素材原尺寸请求 0、`/@media` 0，播放 6 次采样全抑制，停下 150 ms 画出当前帧；补渲 5 个细任务全完成，改一处后认领顺序 `NNNNNBBBBB`；导出 300 帧只用原尺寸（329）与 `snap/`（300）；作废后旧邀请被拒；桌面手填与粘贴都进；收尾删项目、`lookup` 404。

## 1.6 W-HT-a：断线探针与跨机实测（2026-09-28）
- `claude/ht-w-probe`（`opus-dev`，报告 `docs/archive/agent-reports/AGENT-ht-w-probe.md`）：
  - `scripts/probes/render-queue-proxy.mjs` 加 `--cut-once`（整个进程只切一次，接续那条原样转发）与 `--stdin-control`（往标准输入写 `cut` 就切：探针看到主机手里有任务再切，不用定不准的固定时刻）；
  - 新探针 `scripts/probes/ht-w-probe.mjs`：角色 creator / host / all，`--cut proxy | external`；creator 另起一个只看不认领的旁观节点，跨机也能记下每个任务的认领、放回、完成；判接续用主机 `/api/frames/queue` 的 `resumes` / `opens` 与托管端 `/healthz` 的 `sessions.resumed`（主机端点的 `session.*` 日志打在预渲染进程的控制台上，转不出来，见第 4 节后续项）。
  - 基线：`npx tsc -b --force` 0；`npm test` 3393 / 3391 / 0 / 2（`a8df4b5`，之后只改探针与报告）。
- **本机替身**（临时托管组合 127.0.0.1:8797 / 8798，`PROMPTCUT_TRUST_LOOPBACK=0`，`--role all --cut proxy`）：最终代码 `b9f1c87` 连过两轮（第 10、11 轮）29/29、`ok: true`。第 2、3、5、7 轮也是 29/29；第 4、8、9 轮挂在机器满载（发布方节点报到慢、渲染超时，都发生在断开之后、与传输无关），第 6 轮挂在一条比 W-HT-a 更严的旧断言（已收窄到持有的任务）。凡走到断开的轮次，传输断言都过：`resumes` 0→1、`opens` 1→1，断开到看到接续 538～805 ms，服务端同一个会话 `session.detach code 1006` 后 `session.resume`（gapMs 428～615），持有的任务只认领一次、没被放回、以 done 结束、恰好一次 `task.done`。
- **跨机：PC 当第二渲染节点（PC 窗口项）**，2026-09-27T16:42～16:47Z，run `htwpc0928a`，两边都在 `84af96c`，文档服务在阿里云：
  - 笔记本 creator（`--port 5690 --clips 3 --seconds 6`）：`ok: true`、`fails: []`；两边环境指纹同为 `258acaaa7c5fe509`、代码版本同为 `b8a61596a3c5`；plan 由笔记本本机节点认领并切出 9 个细任务，发布到落定 191 s；完成者笔记本 1、PC 主机 8；10 个任务每个恰好一次 `task.done`；收尾删掉项目。
  - PC 主机（PC-4，`--cut proxy --proxy-target 8.219.80.16:8787 --port 5563`，代理 5566）：`ok: true`、`fails: []`，14 条检查全过。持有 `snapshot:b4bddb8e…:0-59` 时代理把连接 1 切断（活了 52 s），440 ms 后连接 2 接上，探针看到接续 825 ms；`resumes` 0→1、`opens` 1→1（没开新会话，`connectFailed` 0）；托管端 `sessions.resumed` 0→1；持有的任务 taken 1、reopened 0、done 1；主机认领 8、完成 8、`lost` 0、`released` 0，传输始终是 ws。PC 核对过输出里不含信箱令牌。
- 云端那一侧（云端容器当主机、在阿里云上 `ss -K` 外部切断）没跑成：云端（Linux、Chromium 141）与 Windows 发布方的环境指纹不同，桌面发布的 plan 与细任务它按设计领不到（第 1.7 节）。随 HT9 放到 C10 部署之后，用在线页面发布的带片段清单的 plan 来做。
- **云端一侧（补，2026-09-28，主会话记录）**：C10 部署后云端当独立渲染主机跑外网四轮（run `c10s0928b`～`e`，即这四轮的轮号；云端是 Linux、Node 22、无头 Chromium 141、无 ffmpeg、出站只经代理且有多个出口地址），掐线结果：
  - run `c10s0928c` 按主机报到时的出口 160.79.106.23 在服务器侧 `ss -K` 没掐中主机的 WebSocket（主机会话 opens 1、resumes 0）：云端出站代理有多个出口地址（后来在 443 上看到 160.79.106.129 / .133 / .134 / .137 / .141）。
  - `d` 改掐上游：主机侧全过（resumes 1、opens 1、lost 0、6.5 s 接续原会话，托管端 `sessions.resumed` 3）；PC 侧两条失败是探针假阳性，`c10-browser-probe` 修正在 main `e807a0e`。
  - `e`（修好的探针）全过：01:26:02Z 持有 `snapshot:3e9b9605…:180-239`，01:26:06Z 在阿里云上掐 nginx 到文档服务的上游连接（`ss -K dport 8787`）5 条、1 秒内重连 4 条；主机 `resumes` 0→1、`opens` 1→1、6494 ms 接续原会话；托管端 `sessions.resumed` 3→8（掐线后 20 s）、legacy 0；持有的那段 taken 1 / reopened 0 / closed [done] / taskDone 1；云端主机 `host:vm:5425/p0` connectFailed 0；旁观节点被一起掐断后接续（newSessions 0、resumes 1）、漏看 0；页面 5 个任务都恰好一次 `task.done`。
  - 结论：W-HT-a 云端一侧通过——会话接续、租约不丢、恰好一次，且会话客户端接续后不漏推事件。云端容器本身只能经代理出网，「只能出网的节点」一侧也由这几轮（`c`、`d`、`e`）复核；本机另有 CONNECT 代理替身四轮通过（main `8f92683`，`docs/archive/agent-reports/AGENT-m8-connect-proxy.md`）。

## 1.7 HT9：两轮没过的原因与改到的做法
- 第 1 轮（`ht9a0927`，2026-09-27T14:37Z）：笔记本 creator 第一次往协调口写配置回 401（同一时刻观察端与云端用同一个令牌读都正常，原因没查明），重跑。
- 第 2 轮（同一轮号，14:44～14:55Z）：云端主机 14:45:28Z 就绪、卡片同步已连上，但**认领 0**；笔记本 creator 挂在「plan 没落定」。查实：
  - 桌面发布方的 plan 带 `requires.envFingerprint`（发布方指纹，`render-queue-contract.md` J.3）与 `preferNode` 独占窗口（M6c X4），队列又规定 `host` 不认领 plan；笔记本本机节点 0.3 s 内认领并切分，细任务都带笔记本的指纹，云端（`linux`、Chromium 141）按指纹前置过滤领不到。早上 T9-X1～X3 能过，是因为当时的主机（笔记本）与发布方（PC）指纹相同。
  - 笔记本软件渲染 10 分钟只做完 8 个细任务里的 3 个，plan 没在时限内落定。
  - 同一轮观察端没换上原尺寸：原尺寸到齐后页面重新加载元素，冲掉了已经发出的 seek，之后没有别的重渲染就一直停在 0 秒（另开 `claude/tier-reload-seek` 修）；当时阿里云到笔记本的下载只有 140～170 KB/s。
- 这是代码比语义严的地方（语义：第一个认领 plan 的渲染节点切分；独立渲染主机能认领全部）。C10 契约第 18 节第 9 条〔裁〕：在线页面发布的 plan 带片段清单、不带指纹与独占窗口，带清单的 plan 独立主机也能认领并用自己的指纹切分；桌面 plan 仍按 X4。HT9 因此改为 C10 部署后跑：在线页面发布 → 云端当独立渲染主机认领并完成（同时算 C10-A5 的外网复验），再在它持有任务时从阿里云切一次（W-HT-a 的云端一侧）。
- **结果（2026-09-28，主会话记录）**：按上面改到的做法，在线页面发布带清单的 plan，云端当独立渲染主机认领并完成。run `c10s0928b` 因 PC 额度挂起中止；`c` 认领 3、完成 1、失败 0、ws，新层用云端指纹 `0326290ea8e62e3d`、就绪 60、播放中换上 `main-v2`；`e` 认领 3、完成 1、失败 0、ws，新层指纹 `0326290ea8e62e3d`、就绪 42、播放中 `main-v2`，creator ok、`fails: []`，主机结果 ok、released 1。在线构建与主机代码版本 `81266bce…`。**HT9 通过**，同时算 C10-A5 外网（`REPORT-C10.md` 第 7 节）。

## 2. 验收
| 编号 | 结果 |
|---|---|
| G0 | 通过（第 1.5 节） |
| HT1、HT2、HT4、HT6 | `ht*.test.mjs` 全真跑全过（HT1、HT4 只验 WebSocket 部分，契约第 16 节） |
| HT3 | 只跑「只走 WebSocket」与「中途断开再接续」两种，通过 |
| HT5 | 自动与强制 ws，通过（`ht5-probe` 用例） |
| HT7 | 外网通过（第 1.5 节） |
| HT8 | 归 HT-b（`TODO.md`） |
| HT9 | 通过（2026-09-28，主会话记录）：C10 部署后在线页面发布带清单的 plan，云端当独立渲染主机认领并完成（run `c10s0928e`，第 1.7 节）。此前两轮没过，原因是桌面 plan 的指纹与 X4 限制 |
| W-HT-a | 通过：本机替身最终代码连过两轮 29/29；跨机由 PC 当独立渲染主机，持有任务时切一次传输，会话接续、租约不丢、恰好一次完成（第 1.6 节）。云端一侧也通过（run `c10s0928d`、`e`，第 1.6 节；主会话记录） |
| PC 窗口项 | 通过：PC 当第二渲染节点做断线接续（第 1.6 节，PC-4） |
| 信任关闭下的演示 | 通过（第 1.5 节） |

## 3. 顾问调用记录
- HT 第 1 版的查资料见契约第 13 节（codex，`gpt-6-sol` / `high`）。
- HT-a 这一轮没有调 codex 或 Gemini：服务端、客户端、测试、集成都由 Opus 完成，问题在回退梯次第 1 级内解决。
- W-HT-a 断线探针（第 1.6 节）同样没有调 codex 或 Gemini。

## 4. 待跨机复核项 / 待用户项
- 待跨机复核：没有剩下的。HT9 与 W-HT-a 的云端一侧已由云端复核（run `c10s0928c` / `d` / `e`，第 1.6、1.7 节；主会话记录）。
- 后续项：主机端点的 `session.*` 日志转出来，或在 `/api/frames/queue` 的节点诊断里加脱开次数（第 1.6 节）；桌面发布的 plan 仍领不到环境不同的独立主机，与语义的出入留作记录（C10 契约第 18 节第 9 条）。
- 待用户项：审〔裁〕——契约第 16、17 节（含「本机按真正的发起方判断」的实现、4410 按原码上报的规则、按字节确认）。
- 与语义的出入（集成方列、主会话认可）：只有 WebSocket 传输（HT-a / HT-b 拆分，不算偏离）；`server/card-sync.mjs` 等仍用旧客户端的几处一次断线就断开（`TODO.md` HT-b 条目下的后续项）；服务端没有会话层时客户端怎么退化，语义没写。
