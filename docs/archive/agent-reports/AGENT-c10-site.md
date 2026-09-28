# AGENT 报告：c10-site（C10 浏览器探针的外网模式与独立主机角色）

分支 `claude/c10-site`，起点 `24c2c57`（claude/c10-integ）。端口段 5420～5429。只改了 `scripts/probes/c10-browser-probe.mjs` 与本报告。

## 做了什么

`scripts/probes/c10-browser-probe.mjs`（用法全写在文件头）：

- `--site <源>`（外网模式）：不起本机托管组合与代理。页面 `<源>/editor`、文档服务 `<源>/hosted/`、素材服务 `<源>/media/api/asset`；
  两个舞台源读 `<源>/editor/runtime-config.json` 的 `stageOrigins`（读不到记失败、退回 `s1.<主机>`、`s2.<主机>`；`--stage-origins` 可覆盖，仍核一致）。
  创建者 = 本机桌面 dev server（+5～+7）连远端，成员 = 本机无头 Chrome 普通档（1600×1000）。A1～A4 判据不变，
  只有「播放 10 秒主文档长任务 0」在外网模式只报数、记入结果行的 `pending`（待笔记本复核）。
- `--role host --run <id>`：从协调口 KV `c10b.<run>.config` 读文档服务地址、项目 id、成员口令，起 `scripts/render-host.mjs`（IPC），
  写 `host.ready`（nodeId、profile、环境指纹、代码版本、传输、平台）、`host.progress`（认领 / 完成 / 失败数与传输，变了才写），
  等 `finish` / `abort` / 超时后经 IPC 正常退出，结果写 `host`。`--run latest` 取 10 分钟内的 `c10b.latest`；`--test-fingerprint` 只给本机自测用。
- `--role creator`（外网缺省；本机替身里给它就用 KV 等外部主机）：A5 先照旧核「没有节点在线时改一处 → 页面发布清单计划、open 等着、不报错」，
  然后写 KV `config`，等外部主机报到（`--host-wait-min`，缺省 15 分钟），报到后 15 分钟内认领并完成至少一段，
  再 10 分钟内页面取到它产的新快照（层换了新键、`envFingerprint` 等于主机报的指纹、`snap/` 就绪）、播放中贴着新快照；最后写 `finish`、收主机结果行（2 分钟）。
  记下认领方的 nodeId、profile、环境指纹、实际传输（`transport`、`resumes`、`legacy`、`opens`、`connectFailed`），新增一条核「认领方经 WebSocket」。
  没有主机报到：A5 后半记「待笔记本主机」（`steps.a5.pendingHost`、结果行 `pending`），不算失败；`--no-host` 直接这样记。出错收尾写 `abort`。
- 本机替身（不给 `--site`、不给 `--role`，即 `all`）：A5 照旧由探针自起本机主机（测试指纹），判据不变。

## 验证

机器负载：同时有十来个子智能体在跑测试与探针。

| 轮 | 命令 | 结果 |
|---|---|---|
| 本机替身 all | `node scripts/probes/c10-browser-probe.mjs --dist <在线构建> --out <目录>` | 退出码 0，`ok: true`、`fails: []`，417 s；长任务 0、采样 67、主重卡不同帧 57、投递 270、占位 t=0.1 fit 7 deadMs 23.3；snap 338、px 0；L2 costs 4；重开不重测、refetched 0、l2Hits 3；A5 主机 `host:DESKTOP-GS40TCK:5425/p0` claimed 3 / completed 1、transport ws、新层指纹 0c10b0e5f1a9e7d2、ready 31、播放贴着 main-v2；项目已删、端口全放 |
| 本机替身 creator + host（经阿里云协调口 KV，run `c10loc0928a`） | 同上加 `--role creator --run c10loc0928a`；另一进程 `--role host --run c10loc0928a --port 5425 --test-fingerprint 0c10b0e5f1a9e7d3` | 两边退出码 0、`ok: true`；主机报到 11 s；认领方 profile host、指纹 0c10b0e5f1a9e7d3（与页面、创建者都不同）、transport ws、resumes 0；新层 ready 31；主机退出码 0、released 1；结果与日志里没有令牌 |
| 外网（阿里云） | 待主会话「开始外网」 | 见下 |

## 第二轮（2026-09-28，主会话改由云端节点当外网一轮的独立主机）

分支快进到 `297bc27`（C10 刷新提交），其上加了 `51519ed`、`a48b05b`。

### 云端没有 ffmpeg，主机能不能做在线页面计划切出的任务

- 在线页面发布的清单计划切出的是卡片快照段（`snapshot:<键>:<from>-<to>`，`server/prerender-executor.mjs` 走 `renderCardSnapshotRange` / `renderSceneSnapshotRange`），
  产 HTML 快照与 PNG 小尺寸，用的是 Chrome，不调 ffmpeg；帧库里 MOV 副本（`writeMov`）起不来时只记 `writerError`，不影响快照结果。
- 要 ffmpeg 的是轨道流任务（H.264 编码器）：`render-host` 缺省 `PROMPTCUT_STREAMS=0` 不开；开了也由 `StreamProducer.capable()` 探不到编码器
  而报 `streams: false`（`nodeCapabilities`），队列不给它流任务。能力照实报，不用改产品代码。
- 实测（本机模拟：主机子进程 PATH 去掉 ffmpeg 目录、`LOCALAPPDATA` 指空目录，`--host-no-ffmpeg`）：主机里 `ffmpeg` 找不到（`found: false`），
  照常起、认领、切分、完成，报给队列的能力 `{ userCards: true, graphCards: false, transcode: false, streams: false }`，主机日志里没有提到 ffmpeg / ENOENT 的行。
- 没在 Linux 上实跑（这台只有 Windows）；Linux 上 `findFfmpeg` 找不到时返回 Windows 兜底路径，只在上面两处被调，同样只影响 MOV 副本与流。

### --cut proxy | external

见文件头「持有任务时断一次传输」。判据：主机 `resumes` 0→1、`opens` 不变、`/healthz` 的 `sessions.resumed` 增加、到最后 `opens` 不变、`released` 0；
creator 一侧旁观节点看持有的任务 taken 1 / reopened 0 / done 1，成员页恰好一次 task.done、没有重复的 task.done；A5 照旧。

### 验证

- `npx tsc -b --force`：退出码 0。`npm test`：tests 3624、pass 3622、fail 0、skipped 2，退出码 0。
- 本机 `--role all --cut proxy --host-no-ffmpeg`（第一次）：退出码 0、`ok: true`，1344 s（CPU 100%，快照段一段 75～178 s）；持有的是 plan，接续 773 ms，判据全过。
- 改成优先在持有细任务时断之后再跑一轮（`a48b05b`）：退出码 0、`ok: true`、`fails: []`，1088 s。
  - A1～A4：长任务 0、主重卡不同帧 54、投递 270、占位出现；snap 330、px 0；重开 refetched 0、l2Hits 3。
  - 持有 `snapshot:13f331bd…:0-59`；断前 opens 1 / resumes 0 / sessions.resumed 0，断后 resumes 1 / opens 1 / transport ws / 接续 767 ms / sessions.resumed 1；
    会话日志 session.open → session.detach(1006) → session.resume(gapMs 592)。
  - 持有的任务 taken 1、reopened 0、closed [done]、页面 task.done 1；页面收到的 task.done 无重复。
  - A5：新层指纹 0c10b0e5f1a9e7d2、ready 60、播放中贴着 main-v2；主机 ffmpeg found false、能力 streams false。项目已删、端口全放。

## 第三轮（2026-09-28，外网 run c10s0928d 两条假阳性的修正）

- 诊断：①成本记录转写那条在掐线前一分钟判，读到 calls 4 / ok 3 / failed 0，差的一条在途（`Preview.tsx` 先 calls++、应答回来才 ok++），探针 `ok > 0` 就判；
  ②旁观节点用旧客户端 `createWsEndpoint`，上游全掐后重连成一条没有 hello / watch 的新连接，之后收不到 task.closed；页面（`createDocEndpoint`）接续后恰好一次 task.done。都不是会话层缺陷。
- 改（`532c296`）：转写等 `calls = ok + failed` 且条数够了再判；`openConn`（旁观节点与探针自己的核对连接）改用 `createDocEndpoint`，
  新会话时（onOpen）重发 hello / watch，接续计数进结果；旁观节点漏看（没见到关闭、没见到重新 open、页面恰好一次 task.done）单列进 `pending`，不判失败。
- 验证：本机 `--role all --cut proxy --host-no-ffmpeg` 退出码 0、`ok: true`、`fails: []`、703 s；转写 calls 4 / ok 4 / records 4；
  持有 `snapshot:92d5c2e7…:0-59`，断前 opens 1 / resumes 0 / sessions.resumed 0，断后 resumes 1 / opens 1 / ws / 729 ms / sessions.resumed 1；
  taken 1 / reopened 0 / closed [done] / 页面 task.done 1，旁观节点 newSessions 0 / resumes 0（本机代理只经过主机那条），missedByWatcher []。
  `npx tsc -b --force` 退出码 0；`npm test` tests 3634 / pass 3632 / fail 0 / skipped 2。
