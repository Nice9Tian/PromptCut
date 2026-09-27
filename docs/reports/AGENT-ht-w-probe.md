# AGENT 报告：ht-w-probe（W-HT-a 跨机验收探针）

- 分支：`claude/ht-w-probe`（从 `claude/ht-integ` 的 `8481bd7` 建），worktree `.worktrees/ht-w-probe`
- 任务：给 HT-a 的跨机验收 W-HT-a 写探针，并先用本机替身跑通。W-HT-a 是主执行计划第 6.5 节的跨机项：独立渲染主机持有任务时，它到文档服务的传输断一次，要证明会话在保留期内接续、租约不丢、任务恰好完成一次。
- 端口：编辑器 5600～5605、代理 5606、自测用的回声口 5608；临时托管组合 8797 / 8798、临时协调口 8799。没碰 5190～5192、5203～5205、5660～5669。

## 1. 做了什么

### 1.1 `scripts/probes/render-queue-proxy.mjs`

- 加 `--cut-once`：整个代理进程只切一次。和 `--cut-after-ms N` 连用时，第一条「到点时还开着」的连接被切，之后的连接（客户端接续会话时新开的那条）原样转发。到点前自己关掉的连接（取挑战的短 HTTP 请求之类）不算那一次，所以「第一条连接」按「第一条到点还活着的」算。不给这个参数时行为和原来一样。
- 另加 `--stdin-control`（任务书没写，见第 4 节第 1 条）：从标准输入按行读命令，`cut` 表示立刻切断此刻开着的全部连接，算一次切断，也受 `--cut-once` 约束。
- 自测（scratchpad 里的 `proxy-test.mjs`，接一个回声服务）：
  - `--cut-after-ms 300 --cut-once`：第一条被切，第二条留着，日志依次是 `conn.cut`、`conn.close`、`conn.cut-skip`；
  - 旧用法 `--cut-after-ms 300`：两条都切；
  - `--cut-once --stdin-control`：第一次 `cut` 切掉，第二次只回一行 `conn.cut-skip`。

### 1.2 `scripts/probes/ht-w-probe.mjs`（新）

跑法、KV 键和每条断言都写在文件头。要点：

- **creator**：
  - 起编辑器（队列模式，只绑回环），它的预渲染进程就是发布方自己的节点（profile pc，并发 1）；
  - 在托管端建一个自由进入的共享项目；
  - 起一个**旁观节点**：成员 `watcher`、`role: 'render'`，指纹与本机节点相同，只 `queue.watch`、不认领，记下每个任务的 `task.taken`、`task.opened`、`task.closed`。它看到的是队列本身的记录，跨机也看得到；
  - 等主机报到，核对两边的环境指纹和代码版本相同；
  - 推镜像、preload，得到 4 条轨道 × 8 s 的 `r6-canvas`，切成 16 个细任务。参数带本轮的盐，结果键全新；
  - 等细任务全部落定，写 KV `plan`；等主机的结果；最后删掉项目。
- **host**：
  - 从 KV 取配置，写共享项目配置；
  - `--cut proxy`：`url` 指向本机代理（`--cut-once --stdin-control`）；`--cut external`：直连；
  - 起 `render-host.mjs`（IPC，`--max-concurrent 2`）；
  - 每 150 ms 读一次 `/api/frames/queue`，等 `nodes[0].held` 非空，写 KV `host.holding`；
  - 切断：`proxy` 由探针往代理的标准输入写 `cut`；`external` 等 KV `cut.done`；
  - 等 `resumes` 增加，读托管端 `/healthz`；
  - 等 KV `plan`，逐条断言，经 IPC 正常退出。
- **all**：本机两个子进程，端口 5600 / 5603，代理 5606，`--cut proxy`，合并两边的 `checks`。
- `--hosted`、`--coord` 必须显式给，缺省不连任何地址。令牌只从环境变量 `PROBE_MAIL_TOKEN` 取，口令只进 KV 和 `--out` 下的配置文件。

断言共 29 条：creator 15 条、host 14 条。W-HT-a 的四项对应如下：

| W-HT-a 的要求 | 断言 |
|---|---|
| 断开前主机至少持有 1 个任务 | `host:held-before-cut` |
| 断开后是会话接续，不是新会话 | `host:cut`、`host:session-resumed`（`resumes` 0→1）、`host:not-new-session`（`opens` 1→1）、`host:same-session-to-end`、`host:healthz-resumed`（托管端 `sessions.resumed` 增加） |
| 被持有的任务没被放回、没被别人认领、没有 `lease-lost` | `host:held-no-lease-lost`（持有的任务没有 `lease-lost`，断开到接续后 35 s 内主机任何任务都没有；这段以外的记进 detail）、`host:not-released`（`released` 为 0）、`host:held-single-claim`（旁观节点看到的认领 ≤ 1 次、认领后没有再 open、以 done 关闭，发布方本机节点没认领过它） |
| 全部任务完成，每个任务恰好一次 `task.done` | `creator:all-done`、`creator:done-exactly-once`（16 个细任务加 plan，共 17 个，每个都是 1）、`creator:host-worked` |

## 2. 验证

### 2.1 本机替身

- 组合：临时托管组合 `server/hosted/main.mjs`，只绑 127.0.0.1:8797 / 8798，`PROMPTCUT_TRUST_LOOPBACK=0`，集群令牌现场生成；临时协调口 8799，`PROBE_MAIL_TOKEN` 现场生成；`--role all --cut proxy`。
- 起法同文件头「本机替身」一段；自测用的是 scratchpad 里的 `run-htw.sh`。

| 轮 | 代码 | 结果 | 要点 |
|---|---|---|---|
| 1 | `d31f47e` | `ok: false` | 27 过、2 不过：`cut`、`session-resumed` 要求主机日志里有 `docservice.session.*`，但那几行打在预渲染进程的控制台上，编辑器不转出来（第 3 节第 1 条）。其余全过，服务端日志有 `session.detach code 1006`、`session.resume gapMs 494`，是同一个 connId |
| 2 | `380b7ea` | **`ok: true`，`fails: []`，29/29** | 持有 1 个任务，`resumes` 0→1，`opens` 1→1，切断到看到接续 544 ms；`sessions.resumed` 0→1；主机认领 12、完成 12，`lost` 0，`released` 0；持有的任务 taken 1、reopened 0、以 done 关闭、task.done 1；全部 16 个细任务完成（本机节点 4 个、主机 12 个），17 个任务每个恰好一次 task.done；服务端 `session.detach conn-4 code 1006`、`session.resume conn-4 gapMs 448`；代理日志：conn 1 被切（活了 4728 ms），conn 2 是接续那条，活到主机退出，没被切；主机退出码 0 |
| 3 | `380b7ea` | **`ok: true`，`fails: []`，29/29** | `resumes` 0→1，`opens` 1→1，切断到看到接续 780 ms；`sessions.resumed` 0→1；本机节点 5 个、主机 11 个；持有的任务 taken 1、reopened 0、done 1；服务端 `session.resume conn-4 gapMs 571`。主机 `failed: 1`：有一个别的任务失败一次、按可重试放回，被重新做完，仍然恰好一次 task.done（第 3 节第 3 条） |
| 4 | `a8df4b5` | `ok: false` | 发布方本机节点 240 s 内没报到（`creator-node-active`）。托管端日志里它的连接 21 s 就建成了，是诊断在机器忙时读得慢；主机随后白等了 20 min。已改成等 7 min、记下最后一次看到的状态，creator 提前收尾时写 `abort`（`8527a6f`） |
| 5 | `8527a6f` | **`ok: true`，29/29** | `resumes` 0→1，`opens` 1→1，538 ms 看到接续；`sessions.resumed` 0→1；本机节点 4 个、主机 12 个；持有的任务 taken 1、reopened 0、done 1；主机 `failed: 1`，原因「导出页 60 秒没就绪」（机器忙，按可重试放回后重做完） |
| 6 | `8527a6f` | `ok: false`，28/29 | 传输各项全过（`resumes` 0→1，`opens` 1→1，服务端 `session.resume gapMs 477`，持有的任务 taken 1、done 1）。只有旧的 `no-lease-lost` 没过：主机 `lost: 1`，丢的是**别的**任务，不是断开时持有的那个。当时的断言要求主机任何任务都不丢租约，比 W-HT-a 严；队列没有记丢的时刻。改成 `held-no-lease-lost`，每 3 s 收一次带时刻的丢租约事件（`b9f1c87`） |
| 7 | `b9f1c87` | **`ok: true`，29/29** | `resumes` 0→1，`opens` 1→1，558 ms；`sessions.resumed` 0→1；本机节点 3 个、主机 13 个；`lost` 0、`failed` 0；服务端 `session.resume gapMs 493`；plan 720 s |
| 8 | `b9f1c87` | `ok: false`，26/29 | 传输各项全过（`resumes` 0→1，`opens` 1→1，645 ms，`session.resume gapMs 615`，持有的任务 taken 1、done 1，断开前后 35 s 内没有丢租约）。挂在机器忙：主机丢了 3 次别的任务的租约，分别在断开后 230 s、385 s、856 s，是停滞回收（画面 120 s 不动）；其中一个任务 3 次都做不完，以 `stalled` 失败，所以 `all-done`、`done-exactly-once` 不过（它的 task.done 是 0 次，不是多次）；plan 1133 s 超过 20 min 时限，creator 没等到主机结果（`host-result`） |
| 9 | `b9f1c87`，`--clips 3 --seconds 6 --timeout-min 40` | `ok: false`，26/29 | 传输各项全过（`resumes` 0→1，`opens` 1→1，795 ms，`session.resume gapMs 559`，持有的任务 taken 1、done 1）。挂在机器忙：一个别的任务在断开后 125 s 被停滞回收，之后两次都报「导出页 60 秒没就绪」，3 次用完以失败告终，所以 `all-done`、`done-exactly-once`、`host-worked` 不过 |
| 10 | `b9f1c87`，同上参数 | **`ok: true`，29/29** | 9 个细任务：本机节点 1 个、主机 8 个；`resumes` 0→1，`opens` 1→1，538 ms；`sessions.resumed` 0→1；`lost` 0、`failed` 0；服务端 `session.resume gapMs 485`；plan 520 s |
| 11 | `b9f1c87`，同上参数 | **`ok: true`，29/29** | 本机节点 1 个、主机 8 个；`resumes` 0→1，`opens` 1→1，805 ms；`sessions.resumed` 0→1；服务端 `session.resume gapMs 568`；主机 `lost: 1`，丢的是别的任务，在断开后 466 s，在 35 s 窗口外，只记进 detail；plan 624 s |

**结论**：最终代码 `b9f1c87` 的第 10、11 轮连着过（`ok: true`、`fails: []`、29/29）。第 8、9 轮失败的原因见上表和第 3 节第 3 条。

跑第 8～10 轮时，这台机器的 CPU 占用是 100%，空闲内存 2.7 GB / 32 GB，主要是别的 claude 进程和屏保，不是本任务起的，没有动它们。各轮失败的原因都是渲染超时或停滞，发生在传输断开之后几分钟，和传输无关。**W-HT-a 本身的传输断言（`held-before-cut`、`cut`、`session-resumed`、`not-new-session`、`same-session-to-end`、`healthz-resumed`、`held-no-lease-lost`、`not-released`、`held-single-claim`）在走到断开的各轮（第 2、3、5～11 轮）全部通过（第 6 轮按新判据也通过；第 4 轮没走到断开）。**

### 2.2 基线

- `npx tsc -b --force`：退出码 0，零错误（在 `a8df4b5` 和最终的 `b9f1c87` 上各跑了一次）。
- `npm test`（在 `a8df4b5` 上跑；之后的提交只改了 `scripts/probes/ht-w-probe.mjs` 和报告，不在测试范围里）：tests 3393，pass 3391，fail 0，skipped 2（`/api/cards/layout` 集成、SKILL 闸门，都要真实 dev server）。第一次跑时 PATH 里没有 ffmpeg，skipped 13，其中 11 条是「没有 ffmpeg」；补上 ffmpeg 的 PATH 重跑，得到上面的数。
- G0-R 和导出像素基线：没跑。改动只在两个探针脚本和报告里，不碰渲染、导出、卡片。

## 3. 发现

1. **主机端点的 `session.*` 日志看不到。** `vite-plugin-frames.ts` 把 `docservice.session.open / detach / resume / close` 打到预渲染进程的控制台，但 `vite-plugin-prerender.ts` 只留这个进程最后 30 块输出（出错时用），不转给编辑器，`render-host.mjs --verbose` 也拿不到。探针因此改用 `GET /api/frames/queue` 的 `resumes`、`opens` 判接续；日志里将来有这几行时，会记进 detail 作旁证。建议列一条后续项：把预渲染进程的 `[queue-node]` 行转出来，或在 `/api/frames/queue` 的节点诊断里加 `detaches`（端点 `stats()` 本来就有）。本次不在文件清单里，没动。
2. **跨机指纹。** 细任务的 `requires.envFingerprint` 取切分方（发布方本机节点）的指纹，指纹由 `os`、Chrome 版本和 WebGL renderer 算出。队列开着指纹前置过滤，主机指纹不同就看不到、也认领不了这些细任务。所以「笔记本当 creator（win32）、云端容器当主机（linux）」这一组合认领不到任务，探针会在 `creator:host-fingerprint` 当场失败并写 `abort`。可行的做法：
   - (a) creator 与 host 都在云端容器里跑，只切 host 那条连接；
   - (b) 笔记本当 creator、笔记本第二实例当主机（`--cut proxy`），这一组合指纹相同；
   - (c) 主会话若另有办法让云端主机认领（例如 W-T9 当时是怎么做的），以那个为准。建议主会话下指令前先核对一次指纹。
3. **机器忙时的渲染失败。** 第 3、5 轮各有一次可重试的失败，重做后完成；第 8、9 轮各有一个任务 3 次都做不完，失败了。原因是「导出页 60 秒没就绪」和停滞回收（120 s 画面不动）。这些都与传输无关，也都不是断开时持有的那个任务。主机的 `failed` / `lost` 事件现在每 3 s 收一次，记进结果的 `failedEvents`，带离断开的毫秒数（`sinceCutMs`）。建议真跨机时用负载轻的机器，或者用 `--clips 3 --seconds 6` 这类更轻的时间轴。
4. 本机替身一轮约 7 分钟，大头是 preload 和 16 个细任务的渲染：这台机器同时有别的重活，plan 从发布到落定约 420 s。

## 4. 与任务书的出入与建议

1. **切断时机用标准输入按需触发，不用固定的 `--cut-after-ms`。** `--cut-after-ms N` 从连接建立时起算，而主机的连接在起来时就建好了，离认领还有几十秒到几分钟，时长和机器忙闲有关，N 定不准。所以给代理另加了 `--stdin-control`：探针看到主机手里有任务，再往代理写 `cut`。`--cut-once` 按任务书实现了，也测过；探针启动代理时两个参数都带上，保证接续那条不会再被切。
2. **断言没用主机日志。** 原因见第 3 节第 1 条，改用诊断计数加托管端 `/healthz`。
3. **任务书的第三种跑法**（笔记本当 creator、云端当主机）受第 3 节第 2 条的指纹问题影响，建议改成 creator 与 host 都在云端容器里跑，下面给了命令模板。

## 5. 给主会话的跑法模板（只写要设的变量名）

### 5.0 PC 当主机（主会话 2026-09-28 定的第二种跑法：笔记本 creator、阿里云文档服务、PC 当主机、代理切断）

- **PC 这一侧的命令**：环境变量 `PROBE_MAIL_TOKEN`（与笔记本的相同）。命令是 `node scripts/probes/ht-w-probe.mjs --role host --cut proxy --proxy-target 8.219.80.16:8787 --hosted https://8-219-80-16.sslip.io/hosted --coord https://8-219-80-16.sslip.io/coord --run <id> --port 5603 --out <目录>`。
  - `--run` 可以不给，这时从 KV `htw.latest` 取 creator 写的那一轮；要先起 creator。
  - 代理在 PC 的 127.0.0.1:5606；编辑器占 5603～5605，不和 PC 常驻的 5190～5192 冲突。
- **笔记本这一侧**：`PROBE_MAIL_TOKEN`，`node scripts/probes/ht-w-probe.mjs --role creator --hosted https://8-219-80-16.sslip.io/hosted --coord https://8-219-80-16.sslip.io/coord --run <id> --port 5600`。建议加 `--clips 3 --seconds 6 --timeout-min 40`，机器忙时不容易超时。
- **前提**：
  1. PC 的检出与笔记本在同一个提交（至少渲染与卡片代码相同）。creator 核对两边的代码版本与环境指纹，不同就在 `creator:host-fingerprint` 失败，并写 `abort` 让主机收尾；
  2. PC 的依赖装好，预渲染 Chrome 能起（与 T9 时相同）；
  3. PC 能出网到 `8.219.80.16:8787`（明文 WebSocket 与 HTTP 挑战都经代理走这里）和 `8-219-80-16.sslip.io:443`（协调口、`/hosted/healthz`、素材服务 `/media`）。阿里云的 UFW 与安全组已放行 8787；
  4. PC 的 5603～5606 空着；
  5. 指纹：主会话说两边的预渲染 Chrome 都是 SwiftShader、T9-X1～X3 就是这一组合，应当相同；探针会当场核对。
- **判读**：PC 那一行的 `checks` 里有 W-HT-a 的各项；笔记本那一行有 `all-done`、`done-exactly-once`、`host-worked`。若只挂在后面这几项、`failedEvents` 是渲染超时或停滞，属于机器忙，与传输无关。

- **本机替身**：环境变量 `PROBE_MAIL_TOKEN`；托管组合另要 `PROMPTCUT_CLUSTER_TOKEN`、`PROMPTCUT_DATA_DIR`、`PROMPTCUT_DOCSERVICE_HOST=127.0.0.1`、`PROMPTCUT_DOCSERVICE_PORT=8797`、`PROMPTCUT_ASSET_PORT=8798`、`PROMPTCUT_TRUST_LOOPBACK=0`：
  - `node server/hosted/main.mjs`
  - `node scripts/probes/probe-coord.mjs serve --port 8799`
  - `node scripts/probes/ht-w-probe.mjs --role all --cut proxy --hosted http://127.0.0.1:8797 --coord http://127.0.0.1:8799 --out <目录>`
- **笔记本 creator、阿里云文档服务、笔记本第二实例当主机（代理切断）**：两个进程都要 `PROBE_MAIL_TOKEN`：
  - `node scripts/probes/ht-w-probe.mjs --role creator --hosted https://8-219-80-16.sslip.io/hosted --coord https://8-219-80-16.sslip.io/coord --run <id> --port 5600`
  - `node scripts/probes/ht-w-probe.mjs --role host --cut proxy --proxy-target 8.219.80.16:8787 --hosted https://8-219-80-16.sslip.io/hosted --coord https://8-219-80-16.sslip.io/coord --run <id> --port 5603`（代理在 5606）
  - 前提：阿里云 8787 对笔记本可达（UFW 与安全组已放行）。
- **云端容器当主机（外部切断）**：要 `PROBE_MAIL_TOKEN`、`NODE_USE_ENV_PROXY=1`、`PC_CHROME_ARGS=--no-sandbox`，命令是 `node scripts/probes/ht-w-probe.mjs --role host --cut external --hosted https://8-219-80-16.sslip.io/hosted --coord https://8-219-80-16.sslip.io/coord --run <id>`；creator 同上，但受第 3 节第 2 条限制，建议 creator 也放在容器里跑。
  - 主会话看到 KV `htw.<id>.host.holding` 后，在阿里云上杀连接：
    1. 先 `ss -tnp state established '( sport = :443 )'`，找容器出口地址（W-开工报到的出口 IP）连到 nginx 443 的连接；
    2. 再 `ss -K state established '( sport = :443 )' dst <容器出口IP>`。
  - 这样会连带切断同一出口地址到 443 的其它连接：容器里的协调口长轮询会自动重试；creator 也在容器里时，它的连接同样会被切，并各自接续，断言不受影响。
  - 退路：`ss -K` 要内核支持 `INET_DIAG_DESTROY`，杀完用同一条 `ss -tn` 确认连接没了。没杀掉时改杀 nginx 到文档服务的上游连接：`ss -K state established '( dport = :8787 )' src 172.19.0.47`。这会切断经 nginx 的全部会话，它们都会接续，断言照样成立。
  - 然后 `PUT /coord/kv/htw.<id>.cut.done`（带 `X-Mail-Token`）。

## 6. 状态

提交在 `claude/ht-w-probe` 上，没推送、没合并。探针的最终代码是 `b9f1c87`。
