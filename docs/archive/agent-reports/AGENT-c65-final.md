# AGENT 报告：c65-final（C6.5 收尾：合入 main、探针截图时机、Agent 写入的总时长）

分支 `claude/c65-final`（起点 `f892a17` = `claude/c65`），worktree `.worktrees/c65-final`。不推送、不合并。

状态：三项都做完，验证全过（原始关键行见第 4 节）。

依据：
- `c65-design.md` 第 13、14 节；
- `AGENT-c65-integ2.md` 第 7 节遗留（「Agent 在服务端加的卡超出内容末尾时，总时长由页面补写」）；
- `AGENT-c65-u2-probe.md`；
- main 上的 `CODEX-ready-index.md`；
- `project-model.md`「总时长」（经 `src/kernel/duration.ts` 的文件头）。

## 1. 合并 main

`git merge --no-ff main`，合并提交是 `ef92110`（main = `8482e21`）。合并时没有冲突。

- main 这次带进来三个文件：`server/frame-pipeline.mjs` 的三处守卫、`server/test/prerender-costs-root.test.mjs` 新增的一个用例、`docs/reports/CODEX-ready-index.md`。
- 从分叉点 `2e75bec` 到 `f892a17`，C6.5 这一侧没有碰过 `frame-pipeline.mjs` 和 `prerender-costs-root.test.mjs`，用 `git diff --stat 2e75bec f892a17 -- <这两个文件>` 核过，输出为空。所以不存在语义冲突。
- C6.5 改的是「有真身时 `project.announce` 只作查询、以真身 rev 发布」，在 `vite-plugin-prerender` / 文档服务那一侧。第 ⑨ 步的修复是 `FramePipeline.preload` 内部的成本重算与层发布守卫，两边不交叉。合并后 ready-index-probe 连跑两次都通过（4.3 节）。

## 2. 探针截图时机（`scripts/probes/c65-editor-probe.mjs`）

**问题**：截图前只等了 `__pcSyncTest` 回到 `online`，再 `sleep`，没有等打开项目时的卡片测量遮罩。遮罩是 `ProbeGate`，文字是「正在测量卡片 n / N」，挂在 `[data-pc="probe-gate"]` 上。慢机器上遮罩要挂几十秒，member 的两张截图拍到的就是遮罩。本机模式走同一个 `shot()` 和 `openEditor()`，也有同样的隐患。本机模式还多一层问题：遮罩在 `onPointerDown` / `onKeyDown` 上把事件挡掉了，遮罩还在时探针的点击和键盘操作会落空。

**改法**（两种模式共用）：

- 新增 `readyState(page)`。满足两条才算 ready：
  - 没有 `[data-pc="probe-gate"]`；
  - 项目里有片段时，时间轴上至少有一个 `[data-clip-id]` 真的排出来了，即有宽高、落在视口内。
- 新增 `waitEditorReady(page, ms)`：要连续两次 ready（间隔 300 ms）才算，避免撞上测量一轮刚结束、下一轮还没排上的空档。超时不抛错，把最后一次的状态回给调用方。
- `openEditor()`：同步接上之后先等 ready，最多 300 s（`--open-ready-timeout`），超时就抛错并带上当时的状态。等到后打一行 `{"step":"editor.ready",…,"waitedMs",…}`。这样后续所有的点击、打字都发生在遮罩退下之后。
- `shot()`：截图前先等 ready，最多 90 s（`--shot-ready-timeout`）。跨机模式里协调口单步最多等 120 s，所以上限取 90 s，保证不会把对方拖到超时。
  - 每张图打一行 `{"shot":…,"ready":true|false,"waitedMs":…}`。
  - 没等到的那张照样截图，但会记进 `shotsNotReady`：跨机模式在 `fails` 里记 `shot-not-ready:<名字>`，最后一行 JSON 带上 `shotsNotReady`；本机模式多一项 `check('shots-editor-ready')`。
- 顺手修了两处漏掉的反斜杠：`/s+/` 应为 `/\s+/`，一处是我新加的、一处是原有的跟踪日志。
- 没改的一处：`remote-flash.png` 那一张仍直接调 `page.screenshot`，因为它要在 1.5 s 的描边消失前抓拍。它截图之前那一页早已 ready 过（前面有 `v2-page-*`），所以不会拍到遮罩。

**效果**（本机实测）：本机阶段第二个页面（`?join=`）等了 `waitedMs 3759` 才 ready，旧代码会在这段时间里截图、点击。其余页面在这台机器上 0.3 s 左右就 ready。跨机四张截图都是 `ready: true`，我逐张看过（4.6 节）。

提交：`7f7d922`、`9637dd4`、`ee47d1c`。

## 3. Agent 写入的总时长（`server/agent/agent-exec.mjs`、`server/agent/ssr-host.mjs`）

按主会话的裁定，总时长的连带更新放进服务端那一次 Agent 写入，随同一批 ops 提交；页面收到后不再补写；页面自己的编辑仍按原规则在页面侧更新。

- `ssr-host.mjs` 另外载入 `src/kernel/duration.ts`，把 `contentEndOf` / `effectiveDuration` / `manualDurationFor` 作为 `host.durationRules` 交出去。规则只有 kernel 这一份，服务端不另写一套。
- `agent-exec.mjs` 新增导出的纯函数 `settleDuration(before, after, rules)`。`runRoute` 在 handler 跑完、`diffProject` 之前调用它，所以总时长的改动和 handler 的改动在同一批 ops 里、同一个 `opId`、同一个 rev。逆操作也由这份差异算出，所以「撤销这一步」会连总时长一起撤回。它的规则与页面现有的两处代码一一对应：
  - 页面时间轴的 effect（`src/editor/timeline/index.tsx`）按 `effectiveDuration(内容末尾, duration, durationManual)` 算目标；`actions.syncDuration` 在差值不到 1e-6 时不写、要写时至少 1 s。`settleDuration` 用的是同样的门槛。
  - 手动截断值是页面状态，服务端拿不到，所以按项目自己推，与 `pageStateAfterRemote` 推手动值用的是同一条 `manualDurationFor`：
    - 这次写入改了总时长（例如 `set_project_meta` 截断），按改后的值推；
    - 否则按改前的值推：改前总时长比内容末尾短，说明截断过。
  - 只有片段（`tracks`）或总时长变了才计算。页面时间轴的 effect 也只跟着这两样跑，所以只改名一类的写入不会碰总时长。
- 页面一侧一行没改。页面收到的这批操作里，片段和总时长已经一起到位；它按自己的规则再算一遍，结果和当前值相同，就不再写。页面自己的编辑照旧由时间轴的 effect 更新总时长。

**单测**：新文件 `server/test/agent-c65-duration.test.mjs`，DUR-1～DUR-4。

页面一侧用的是真的 `src/store/docsync.ts`（DocSync），连真的文档服务（WebSocket）。总时长照页面那两处代码算：收到远端改动时用 `pageStateAfterRemote` 推手动值，时间轴 effect 的判断加上 `syncDuration` 的门槛。这里不 `bindStore`，因为服务端 store 是同一进程里的单例，执行器正在用它。

- DUR-1：`settleDuration` 纯函数的各种情形：跟着内容走、截断后保留、改了总时长就按改后的值推、拉长会夹回内容末尾、只改名不碰、空项目保留原值、至少 1 s。
- DUR-2：Agent 用 `add_clip` 加一张 10～14 s 的卡，原内容末尾是 5 s。结果：
  - 文档服务里只有这一次提交（rev 2），总时长已是 14；
  - 页面补写次数为 0；
  - 紧接着的 `update_clip` 落地为 rev 3，`stats.stale` 为 0；
  - 页面、文档服务、Agent 副本三份的总时长都是 14，页面与真身逐项相同。
- DUR-3（对照）：同样的加卡由一个不带总时长的写入方提交时，这个页面模拟会补写一次（rev 3）。这证明 DUR-2 里「不补写」的断言不是空的。
- DUR-4：Agent 先用 `set_project_meta { duration: 3 }` 截断，页面记下手动值 3；再加一张超出末尾的卡，总时长保持 3。页面没有补写，下一次写入没有被拒，三份一致。

**反向核对**：临时把 `settleDuration` 那一行注释掉再跑，DUR-2 失败在 `页面没有补写总时长`，其余三条通过；恢复后四条全过。

提交：`6153a41`。

## 4. 验证（原始关键行）

端口：

| 用途 | 端口 |
|---|---|
| 本分支 dev server | 5530（舞台 5531、5532） |
| main 基线（临时 worktree `.worktrees/c65f-main-baseline`，`8482e21`） | 5533（舞台 5534、5535） |
| ready-index-probe | 5536 |
| queue-mode-probe | 5539 / 5542 / 5545 |
| 局域网主机编辑器 | 5548（`PROMPTCUT_LAN_HOST=1`） |
| 跨机 creator / member 编辑器（探针自起） | 5551 / 5554 |
| 协调口 | 5559（绑 `0.0.0.0`） |
| render-host-probe | 5400～5409 |
| 托管组合 | 8790 / 8791（数据目录在 scratchpad `final/hosted-data`） |

dev server 都用 `PROMPTCUT_PUSH=0 npx vite --port … --strictPort --host 127.0.0.1` 启动。日志在 scratchpad 的 `final/` 下。

### 4.1 类型检查与全量测试

```
npx tsc -b --force
tsc exit=0   (无诊断输出)

npm test
npm test exit=0
ℹ tests 2951
ℹ pass 2950
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
```

改动之后先单独跑了相关测试：

```
node --test server/test/agent-c65.test.mjs server/test/agent-c65-pagestate.test.mjs server/test/c65b-agent.test.mjs server/test/c65b-undo.test.mjs
exit=0  ℹ tests 40  ℹ pass 40  ℹ fail 0

node --test server/test/agent-c65-duration.test.mjs
✔ DUR-1 settleDuration:跟内容走、截断保留、改了总时长按改后的推、只改名不碰、空项目保留、至少 1 s
✔ DUR-2 Agent 加一张超出末尾的卡:总时长随同一次提交跟上;页面不补写;紧接着第二次写入不被拒;三份总时长一致
✔ DUR-3 对照:同样的加卡由不带总时长的写入方提交时,页面按自己的规则补写一次总时长(以前 Agent 就是这样)
✔ DUR-4 截断之后:Agent 截断总时长、再加一张超出末尾的卡,总时长保持截断值;页面不补写,下一次写入不被拒
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

### 4.2 导出确定性、与 main 逐像素、快照重放一致

```
node scripts/verify-determinism.mjs --url "http://127.0.0.1:5530/?export=1"      # 本分支
exit=0
Total Frames: 1800
Identical: 1800
Different: 0
All frames are identical. Determinism verified!

node scripts/verify-determinism.mjs --url "http://127.0.0.1:5533/?export=1"      # main 8482e21
exit=0
Total Frames: 1800
Identical: 1800
Different: 0
All frames are identical. Determinism verified!

node <scratchpad>/cmp-frames.mjs <c65-final>/out/verify-a/frames <c65f-main-baseline>/out/verify-a/frames
{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}

PC_FRAME_TEST_URL=http://127.0.0.1:5530 node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5530
exit=0
PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.
```

### 4.3 ready-index-probe（连跑 2 次）

```
node scripts/probes/ready-index-probe.mjs --port 5536     # 第 1 次
run 1 exit=0
  "statefulDirBack": false,
  "canvasDir": true,
  "fails": []
node scripts/probes/ready-index-probe.mjs --port 5536     # 第 2 次
run 2 exit=0
  "statefulDirBack": false,
  "canvasDir": true,
  "fails": []
```

### 4.4 stream-produce-probe、preview-fallback-probe

```
node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5530 --json …/spp.json
spp exit=0   PASS
{"group":false,"produceMs":20048,"streams":3,"layers":3,"fails":[]}

node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5530 --group --json …/spp-group.json
spp-group exit=0   PASS
{"group":true,"produceMs":16025,"streams":1,"layers":1,"fails":[]}

node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5530 --out out/pf-probe --json …/pf-plain.json
pf plain exit=0   PASS
{"total":{"beats":270,"transparentBeats":0,"placeholderDelay":27,"taskP90":12.306},"readyLayers":{"html":1,"stream":1},"pageErrors":[],"fails":[],"notes":[]}

node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5530 --page-preload --out out/pf-probe --json …/pf-pp.json
pf page-preload exit=0   PASS
{"total":{"beats":276,"transparentBeats":0,"placeholderDelay":36,"taskP90":16.228},"readyLayers":{"html":4,"stream":1},"pageErrors":[],"fails":[],"notes":[]}
```

不带 `--page-preload` 那一次的 `taskP90` 是 12.3 ms。integ2 报告里记的是 26.96 ms，当时存疑；这次没有复现。

### 4.5 queue-mode-probe、render-host-probe（本机 H1/H2/H3）

```
node scripts/probes/queue-mode-probe.mjs --queue-port 5539 --normal-port 5542 --docservice-port 5545
qmp exit=0
{"ok":true,"tasks":5,"done":5,"identical":true,"differentFrames":0,"identicalIgnoringStyleOrder":true,"differenceSummary":{},"streamTasks":0,"streamDone":0,"streamCompare":null,"x5":{"readyAfterMs":108509,"firstPlanClaim":{"id":"plan:queue-mode-probe@1","afterPreloadMs":820,"preload":["html"]},"firstFineClaim":{"id":"snapshot:5cfc864e…:0-59","afterPreloadMs":2834,"preload":["html"]},"claimedWhileNotReady":4,"fineClaimedBeforeReady":true},"fails":[]}
```

render-host-probe 的编排照 `AGENT-m6-host.md` 第 3 节，脚本是 scratchpad 的 `final/run-rhp.sh`，由 `run-rhp-i2.sh` 改了 worktree 和 state 目录。所有角色退出码都是 0：

```
host-a exit 0 / host-b exit 0 / host-c exit 0 / host-bad exit 0 / check-r1 exit 0 / check-r2 exit 0 / auth-check exit 0 / creator exit 0
creator  {"rounds":[{"round":"r1","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":0,"pcCompleted":2,"pcPlanClaimed":true,"preloadMs":113032},{"round":"r2","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":2,"pcCompleted":3,"pcPlanClaimed":true,"preloadMs":107711}],"ok":true,"fails":[]}
host-a   {"ok":true,"claimed":2,"completed":2,"seen":4,"connected":true,"handshake":101,"connectFailed":0,"exitCode":0,"fails":[]}
host-b   {"ok":true,"claimed":1,"completed":1,"seen":4,"connected":true,"handshake":101,"connectFailed":0,"exitCode":0,"fails":[]}
host-c   {"ok":true,"claimed":0,"completed":0,"seen":2,"connected":true,"handshake":101,"codeVersion":"test-code-version-mismatch","exitCode":0,"fails":[]}
host-bad {"ok":true,"claimed":0,"completed":0,"seen":0,"connected":false,"handshake":401,"connectFailed":12,"exitCode":0,"fails":[]}
check-r1 {"ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"completedByNode":{"pc":2,"host-a":2,"host-b":1},"sumCompleted":5,"reused":0,"differentFrames":0,"identicalBytes":true,"identical":true,"fails":[]}
check-r2 {"ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"completedByNode":{"pc":3,"host-c":0,"host-bad":0},"sumCompleted":3,"reused":2,"differentFrames":0,"identicalBytes":true,"identical":true,"fails":[]}
auth-check {"ok":true,"wrongPassword":401,"rightPassword":101,"ticket":true,"wrongStatuses":[401,401,401,401,401],"afterFiveWrong":101,"challengeInCooldown":"ok","fails":[]}
```

- H1：check r1 的 `duplicateDone` 0、`missingDone` 0，PC 2 + host-a 2 + host-b 1 = 5，`identicalBytes: true`。
- H2：host-c `seen 2`、`claimed 0`，check r2 `identicalBytes: true`。
- H3：host-bad `handshake 401`、`connectFailed 12`、`claimed 0`。

### 4.6 c65-editor-probe

**本机 + 共享**：

```
node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5530 --hosted http://127.0.0.1:8790 --out out/c65-editor-shots --phases local,shared
```

退出码 0，35 项全过：原来的 34 项，加上新增的 `shots-editor-ready`。

```
{"check":"V2-page-real","ok":true,"edits":[100,100],"a":{"sha256":"9d3fd00b…0b1f","rev":146,"status":"online"},"b":{"sha256":"9d3fd00b…0b1f","rev":146,"status":"online"},…}
{"check":"undo-partial-notice","ok":true,"notice":"撤销了，但这几处被后续的新修改覆盖，未做退回：\n×\n片段「模糊浮现 @2.0s」 (由 你在另一个页面 修改)",…}
{"check":"offline-replay","ok":true,"c5":"重放2","c7":"B7-重放"}
{"check":"agent-undo-step","ok":true,"reverted":{"found":true,"done":true,"state":"done"},"before8":null,"now":null}
{"check":"new-shared-hosted","ok":true,"created":"创建成功，已进入项目。",…}
{"check":"open-shared-enter","ok":true,"a":{"sha256":"e3a2b08f…7aae","rev":1,"status":"online"},"b":{"sha256":"e3a2b08f…7aae","rev":1,"status":"online"}}
{"check":"kicked-blocking-dialog","ok":true,"blocked":"你已被创建者踢出该项目，无法继续编辑。想回来，找创建者撤销。\n开始页"}
{"check":"delete-project","ok":true,"aAfter":"local"}
{"check":"shots-editor-ready","ok":true}
{"summary":{"total":35,"passed":35,"failed":[]}}
{"step":"editor.ready","url":"http://127.0.0.1:5530/?editor&join=p-muhr34ew-be5e9f53","waitedMs":3759,"clips":10,"visible":6}
```

22 张截图都是 `"ready":true`，完整日志在 scratchpad 的 `final/c65ep-ls.log`。我看了 `v2-page-b.png`，也就是等了 3.8 s 的那一页：时间轴上有片段，没有遮罩。右侧那一串「被覆盖」气泡是 V2 两页交错编辑时的正常画面。

**局域网**：

```
PROMPTCUT_LAN_HOST=1 PROMPTCUT_PUSH=0 npx vite --port 5548 --strictPort
node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5548 --hosted http://127.0.0.1:8790 --out out/c65-editor-shots --phases lan
```

退出码 0：

```
{"check":"lan-host-editor","ok":true,"device":{"deviceId":"pc-vqxCRm0vQRfjWbzscI-4fc","deviceName":"DESKTOP-GS40TCK-vqxC","lanHost":true,"localEditor":true}}
{"check":"new-shared-lan","ok":true,"created":"创建成功。让成员在同一个网段下查项目名就能进。记住本机要保持开着。"}
{"check":"open-shared-two-candidates","ok":true,"cands":"[局域网模式] 主机：DESKTOP-GS40TCK-vqxC\nc65-lan-muhr5jbj\n[互联网模式] 托管在阿里云\nc65-lan-muhr5jbj","title":"找到两个同名项目，你要进哪一个？"}
{"check":"shots-editor-ready","ok":true}
{"summary":{"total":4,"passed":4,"failed":[]}}
```

验完以创建者身份删掉了这个局域网项目，用的是 `out/c65-final/lan-cleanup.mjs`（不入库；由 integ2 那份改成按名字查 projectId）：

```
{"lookupBefore":{"ok":true,"projectId":"sp_c7yfzqbrmzaqtbrijxuw6iwe7u","name":"c65-lan-muhr5jbj","mode":"free"}}
{"enter":{"ok":true},"del":{"ok":true,"op":"delete"}}
{"lookupAfter":404,"body":"{\"ok\":false,\"error\":\"no-project\"}"}
```

**跨机模式，本机一轮局域网**：creator 和 member 各起一个编辑器实例，member 经本机局域网 IP 192.168.50.96 连接。

```
node scripts/probes/c65-editor-probe.mjs --role creator --mode lan --coord-port 5559 --coord-host 0.0.0.0 --spawn-editor 5551 --out out/u2/lan-creator
node scripts/probes/c65-editor-probe.mjs --role member --coord http://192.168.50.96:5559 --spawn-editor 5554 --device-id pc-u2-member-probe-0001 --device-name u2-member-laptop --out out/u2/lan-member
```

两边退出码都是 0。截图行：

```
creator {"step":"editor.ready","url":"http://127.0.0.1:5551/?editor","waitedMs":302,"clips":10,"visible":6}
creator {"shot":"…\\out\\u2\\lan-creator\\creator-1-created.png","ready":true,"waitedMs":305}
creator {"shot":"…\\out\\u2\\lan-creator\\creator-2-saw-member-edit.png","ready":true,"waitedMs":310}
member  {"step":"editor.ready","url":"http://127.0.0.1:5554/?editor","waitedMs":346,"clips":10,"visible":6}
member  {"shot":"…\\out\\u2\\lan-member\\member-1-entered.png","ready":true,"waitedMs":316}
member  {"shot":"…\\out\\u2\\lan-member\\member-2-saw-creator-edit.png","ready":true,"waitedMs":310}
```

creator 最后一行（节选）：

```
{"ok":true,"role":"creator","mode":"lan","projectId":"sp_eb743o42ntehz3j4ieyr6ujweg","rev":1,"where":"lan","sha256":"339cc77a…68d3","member":{"entered":{"ok":true,"rev":1,"sha256":"339cc77a…68d3","hostRev":1,"where":"lan","base":"http://192.168.50.96:5551/docservice/","candidate":"u2-df7ddcba · [局域网模式] 主机：DESKTOP-GS40TCK-vqxC","enterMs":257},…},"memberEditSeenMs":43,"memberEditSinceGoMs":110,"memberEdit":{"clipId":"c-muhr6fhd-5","value":"u2-member-df7ddcba","memberCommitMs":57.3,"seenClipId":"c-muhr6fhd-5","flash":true},"creatorEdit":{"clipId":"c-muhr6fhd-6","value":"u2-creator-df7ddcba","commitMs":53.5},"creatorEditSeenMs":22,"final":{"page":{"sha256":"2f8d9865…8f01","rev":3,"status":"online"},"host":{"rev":3,"sha256":"2f8d9865…8f01"},"member":{"sha256":"2f8d9865…8f01","rev":3,"status":"online"}},"deleted":true,"fails":[]}
```

member 最后一行（节选）：

```
{"ok":true,"role":"member","mode":"lan","coord":"http://192.168.50.96:5559","hosted":"http://127.0.0.1:9","enterMs":257,"where":"lan","base":"http://192.168.50.96:5551/docservice/","entered":{"page":{"sha256":"339cc77a…68d3","rev":1,"status":"online"},"host":{"rev":1,"sha256":"339cc77a…68d3"},"creatorRev":1,"creatorSha256":"339cc77a…68d3"},"creatorEditSeenMs":22,"creatorEdit":{"clipId":"c-muhr6fhd-6","seenClipId":"c-muhr6fhd-6","flash":true},"final":{"page":{"sha256":"2f8d9865…8f01","rev":3,"status":"online"},"host":{"rev":3,"sha256":"2f8d9865…8f01"}},"fails":[]}
```

**四张截图我逐张看过**（1440×900，未入库）：

| 文件 | 看到的 |
|---|---|
| `C:\Users\admin\Documents\PromptCut\.worktrees\c65-final\out\u2\lan-creator\creator-1-created.png` | 「成员: 1 人」；时间轴两条序列，序列 1 上六个片段（数字滚动、模糊浮现、环形进度、打字机、文字轮换、翻牌计数器）；没有测量遮罩 |
| `…\out\u2\lan-creator\creator-2-saw-member-edit.png` | 「成员: 2 人」；同一条时间轴，第一个片段「数字滚动」带青色描边（别人的改动到了） |
| `…\out\u2\lan-member\member-1-entered.png` | 「成员: 2 人」；时间轴与创建者相同；右上角「阿里云连不上」气泡（局域网模式故意给的死地址）；没有遮罩 |
| `…\out\u2\lan-member\member-2-saw-creator-edit.png` | 第二个片段「模糊浮现」的副标题变成 `u2-creator-df7ddcba`，带青色描边 |

### 4.7 收尾

- 我起的进程都用 `taskkill /T /F` 结束了：
  - vite 5530，树根是 bash 的 npx，PID 53856；
  - vite 5533，PID 35216；
  - 局域网主机 vite 5548，树根 npx，PID 39724；
  - 托管组合，PID 46916。
- 跨机两个编辑器（5551、5554）由探针自己起、自己结束，日志里有 `editor.stopped`。ready-index、queue-mode、render-host 各角色自起的进程随角色退出。
- 结束后 5530～5559、5400～5409、8790～8799 都没有监听；命令行带 `c65-final`、`c65f-main` 或 `hosted/main` 的 node 进程为 0 个。
- 没碰 5190～5192，没结束别人的进程，主工作区的 `.claude/launch.json` 没动（没用浏览器面板）。
- 临时 worktree `.worktrees/c65f-main-baseline`：删之前在 PowerShell 里查过 `reparse points: 0`，然后 `git worktree remove --force`，之后 `removed: True`。
- 没建 junction，没跑 `npm ci`，没装东西。

## 5. 与任务书、设计稿不一致之处，以及建议

1. **只有片段或总时长变了才算总时长。** 页面时间轴的 effect 只跟着 `tracks`、`duration`、`durationManual` 跑，所以只改名一类的写入不碰总时长，即使改前的项目本来就不一致也不在这里顺手改（DUR-1 里有这一条）。这样服务端和页面对同一次写入触发与否完全一致。
2. **服务端推出来的手动截断值和页面的可能不同，但算出的总时长相同。** 页面的 `durationManual` 可能是过期的：先截断，再删卡让内容末尾比截断值还短，这时手动值还留着，总时长等于内容末尾。服务端据此推出「没截断」。我按 `effectiveDuration` 逐种情形核过：
   - 服务端改了总时长时，页面收到后会先用 `pageStateAfterRemote` 把手动值换成推出来的那个，再跑 effect；
   - 服务端没改时，页面按自己的手动值算出的目标也等于当前值。
   所以两种情况下页面都不补写。
3. **设计稿第 14 节没有写这一条。** 建议补一句「Agent 在服务端的写入若改了片段或总时长，总时长按 `kernel/duration.ts` 的规则随同一批 ops 更新，页面不再补写」。改语义和设计稿不在我的清单里，我没动。
4. **跨机模式截图的等待上限取 90 s**，协调口单步最多等 120 s，留出了余量。如果真机上测量遮罩超过 90 s，那张图会记 `shot-not-ready`、整轮判失败，而不是拍一张遮罩假装通过。需要时可以用 `--shot-ready-timeout` 调大，但要同时考虑对方的 120 s。

## 6. 需要主会话决定

- 合并、返工还是放弃。
- 第 5 节第 3 条：设计稿第 14 节要不要补那一句。
