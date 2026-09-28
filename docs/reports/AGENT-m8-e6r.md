# AGENT-m8-e6r:E6「两种指纹」反方向探针

分支 `claude/m8-e6r`(从 main `a52344a` 拉出),工作区 `.worktrees/m8-e6r`。只改了 `scripts/probes/c10-browser-probe.mjs` 与本报告;没动 `src/`、`server/`。

代号:
- **E6**:M8 计划(`docs/plan/m8-plan.md`)第 2.1 节的第 6 个端到端用例,「两种指纹的节点同时在线」。
- **J-全完 / J-恰一 / J-纯层**:计划第 2 节开头的三条共用判据,分别是任务全部完成、每个任务恰好一次 `task.done`、没有一层混两种指纹。
- **L18**:M8 计划里只记录不判的一项,内容是桌面发布的 plan 领不到环境不同的独立主机。
- **C10 契约第 18 节第 9 条**:页面发布的清单 plan 允许 host 档认领的那条裁定。
- **M7 D1**:M7 契约第 13 节第 1 条裁定。页面(纯浏览器节点)在线时,切分方给浏览器做得了的卡另出一份页面指纹的任务(`input.dual`),谁先认领谁得卡,另一份作废(`superseded`)。

## 1. 改了什么

`scripts/probes/c10-browser-probe.mjs` 加了开关 `--e6-reverse`,复用这个探针原有的页面发布流程与 `--role host`。场景如下:

1. 第 0～2 步照旧:创建者建项目、预渲染,成员凭邀请进入,A1～A4、A2。
2. 第 5 步(A5)的做法:
   - 创建者关掉之前,先记下它发布过的桌面 plan,留给 L18。
   - 页面把主重卡和 8 张额外重卡都改一遍(文字加 `burnMs`,缺省本机替身 120、外网 250,可用 `--e6-burn-ms` 改),然后发布带片段清单的 plan。
   - 起旁观节点(只收不认领,记每个任务的 derivedFrom、要求的指纹、dual、taken、关闭状态),同时起页面 `task.done` / `task.failed` 计数(CDP 读 WebSocket 入站帧,按 seq 去重、记 epoch)。
   - 起 Y:本机替身是本机独立渲染主机,测试指纹 `0c10b0e5f1a9e7d2`,`--max-concurrent 1`;跨机是外部 `--role host`。
   - 旁观节点见到这个 plan 被认领后,X 才上线。
3. X 的两种(`--x-nodes`):
   - `claimer`:协议层节点,profile host、报本机真实指纹。对要求别的指纹、还 open 的细任务各主动 `task.claim` 一次;要求自己指纹的不碰,只计数。它不占端口,Y 认领 plan 后约 0.1 s 就在线。
   - `host`:真的独立渲染主机(真实指纹),端口「基址 +0～+2」,只在外网模式可用。
   - 缺省:本机替身 `claimer`;外网 `claimer,host`。本机替身里 `host` 被拒绝,原因见第 4 节第 1 条。
4. 判据写在结果行 `steps.e6r.checks`,共 9 条:`Y-claimed-plan`、`derived-fingerprints`、`X-online-while-work`、`X-claimed-0`、`J-all-done`、`J-exactly-once`、`J-pure-layers`、`layer-map-covers-done`、`X-differs-from-Y`。各条的意思见文件头「E6『两种指纹』的反方向」一节。
5. L18 只记录:X 拿 host 身份试认领创建者的桌面 plan,记下回包。
6. 主机角色(`--role host`):KV 的 config 里多了 `e6Reverse: true`,有它时主机并发压到 1,并记认领 / 完成的任务 id(读预渲染进程诊断的节点事件与持有表),随 `host.progress` 和结果行 `host` 的新字段 `ids` 交回。KV 不加新键,文件头已写明。

顺带修了原有判据里两处过时的地方(不带新开关时同样生效):

- **层表 v 3**:M7 D12 起层表是 v 3,而第 0 步、A3 仍要 `v === 2`,每次都判失败或超时。改为 `>= 2`。
- **A5 取到新快照**:按 M7 D1,页面在线时主重卡的新层可能由页面自己出(页面指纹),原判据只认主机指纹,于是超时。现在两种都认,结果行 `newLayer.by` 记是谁出的(host / page);失败时 `a5FreshDiag` 给出精简诊断。

## 2. 本机替身的结果(验证)

命令(端口段 5740～5749:+0～+4 是三个源与托管组合,+5～+7 先给创建者、后给 Y;X 用 claimer 不占端口):

```
node scripts/probes/c10-browser-probe.mjs --e6-reverse --base-port 5740 --out <目录>
```

第二次运行(`e6r2`)退出码 0,用时 761 s。结果行摘录:

```
ok true ms 760983 mode a1-a5+e6-reverse
fails []
pending []
ok Y-claimed-plan {"planId":"plan:sp_mdiiqmt6inprpaw2yl26q5rkbg@11#clips:1mmkinm1mubgzm","watcherTaken":1,"takenBeforeX":true,"inYHeld":true,"yAtPlanTaken":{"claimed":1,"completed":0,"envFingerprint":"0c10b0e5f1a9e7d2"},"ownCopiesRequireY":11,"roundPlans":1,"how":"Y 的持有记录里有这个 plan"}
ok derived-fingerprints {"tasks":17,"yFp":"0c10b0e5f1a9e7d2","pageFp":"258acaaa7c5fe509","byFp":{"0c10b0e5f1a9e7d2":5,"0c10b0e5f1a9e7d2/dual":6,"258acaaa7c5fe509/dual":6},"badOthers":[]}
ok X-online-while-work {"claimer":{"onlineAt":1790587870424,"doneAfter":11},"tasks":11}
ok X-claimed-0 {"claimer":{"fingerprint":"258acaaa7c5fe509","attempts":10,"rejected":{"fingerprint-mismatch":10},"claimed":0,"sameFpSkipped":6,"visibleRound":6,...}}
ok J-all-done {"ok":true,"total":11,"done":11,"notDone":[],"superseded":6,"badSuperseded":[]}
ok J-exactly-once {"ok":true,"total":12,"epochs":["329b6414-2aad-4d67-86a8-0bf4ae8337cf"],"dup":[],"missing":[],"stray":0}
ok J-pure-layers {"ok":true,"layers":3,"observed":22,"unknown":0,"mixed":[],"attributed":11,"tasks":11,"byNode":{"Y":6,"page":5},"inferredPage":5}
ok layer-map-covers-done {"v":3,"cards":3,"uncovered":0,"primaryAllY":true,"layers":[ ...11 层,主指纹都是 0c10b0e5f1a9e7d2... ]}
ok X-differs-from-Y {"yFp":"0c10b0e5f1a9e7d2","xClaimerFp":"258acaaa7c5fe509","xHostFp":null,"pageFp":"258acaaa7c5fe509"}
l18 {"desktopPlans":1,"desktopFingerprint":"258acaaa7c5fe509","hostClaim":[{"id":"plan:p-mul1gvkc-8f67abde@1","type":"task.claim-rejected","reason":"plan-profile","released":null}]}
a5 {"newLayer":{"resultKey":"c35c04c2339b","envFingerprint":"258acaaa7c5fe509","by":"page","ready":60},"shown":{"t":2.3,"planeSig":"12196:1yjsbn0"}}
cleanup {"deleted":"shared.admin.ok","listening":[]}
```

要点:

- Y 在 X 上线之前认领了页面的 plan。X 上线之后这一版又完成了 11 个细任务,所以 X 确实和这一版同时在线。
- X 对要求 Y 指纹的 10 个细任务逐个主动认领,全部回 `fingerprint-mismatch`,认领 0。
- 切出 17 个细任务:Y 自己那份 11 个,页面那份 6 个(M7 D1 的双份)。其中 6 个 dual 被作废,剩下 11 个全部 done;每个恰好一次 `task.done`,只有一个 epoch;没有一张卡混两种指纹。
- 层表主指纹全是 Y。但主重卡(3 张完成过的卡里有 1 张)是页面自己抢到、用页面指纹完成的,层表 v 3 的候选里有它。见第 4 节第 2 条。
- L18:host 身份认领桌面 plan,回 `plan-profile`。

看过的图:`e6r2/shots/a4-settled-live.png`。成员页在 0.50 s 处显示活渲,测试视频加卡片正常,时间轴 13 个片段,没有占位,也没有报错遮罩。

### 第一次运行(`e6r1`)为什么没过、怎么改的

第一次 9 条里失败 6 条(原文摘录):

```
FAIL Y-claimed-plan {"watcherTaken":1,"yClaimedPlans":[],"roundPlans":2}
FAIL derived-require-Y {"tasks":21,"byFp":{"0c10b0e5f1a9e7d2":13,"258acaaa7c5fe509":8}}
FAIL X-claimed-0 {"claimer":{"attempts":21,"rejected":{"fingerprint-mismatch":13},"claimed":8}}
FAIL J-all-done {"total":21,"done":9, notDone: 10 个 failed、2 个 open}
```

原因有三处,都在探针,不在生产代码:

1. **M7 D1 的双份**。本机替身里页面与 X 在同一台机器上,指纹相同(都是 258a)。切分方给页面另出的那份(dual、要求 258a),X 本来就可以认领。第一版 claimer 认领后立刻放回,这一下把卡锁到了 258a,切分方自己那份被作废,于是出现大量 failed,扰乱了这一版。
   - 改法:X 不碰要求自己指纹的任务,只计数。
   - 判据改为:要求 Y 的细任务 X 认领 0;J-全完、J-恰一按没被作废的任务判,作废的只许是 dual 的;J-纯层按卡(内容键)判。
2. **Y 认领 plan 的证据**。执行器不发 `node.claimed` 事件(`server/render-node/task-runner.mjs` 只报 completed / dedup / lost / failed)。改为从诊断的持有表、在跑表里收认领,并在 plan 被认领的那一刻记下 Y 的认领计数作旁证。第二次运行是直接从 Y 的持有记录里查到这个 plan 的(`inYHeld: true`)。
3. **层表**。v 3 的层有 candidates,判据改为「每张卡的候选里含完成那一份的指纹」,另外单独记「主指纹全是 Y」。

## 3. 基线

- `npx tsc -b --force`:退出码 0,没有输出。
- `npm test`:退出码 0,共 3758 个测试,通过 3756,失败 0,跳过 2。
- 原有 `c10-browser-probe` 本机替身(不带新开关):`ok: true`、`fails: []`,详见第 3.1 节。

### 3.1 原有本机替身(不带新开关)

命令:`node scripts/probes/c10-browser-probe.mjs --base-port 5740 --out <目录>`

改完之后(`base2`)退出码 0,用时 326 s:

```
{"ok":true,"fails":[],"pending":[],"mode":"a1-a5","ms":326287,"cleanup":{"deleted":"shared.admin.ok","listening":[]},"layer0":3,
 "a5":{"claimant":"0c10b0e5f1a9e7d2","newLayer":{"resultKey":"e8065d11146a","envFingerprint":"258acaaa7c5fe509","by":"page","ready":60},"shown":{"t":2.13,"planeSig":"12196:1yjsbn0"}},
 "play":{"longTasks":0,"distinct":57}}
```

改之前,同一检出上不带新开关跑过一次(`base1`,当时 e6r1 刚跑完),`ok: false`,失败 21 条:层表 v 2 判据、A5 新快照超时(与上面两处过时判据一致),另有舞台握手失败(`handshake: failed`、只握上舞台 A)引出的 A1～A4、A2 一串。改后再跑全过,舞台握手那一串没有复现。原因没查实,只在这里记一笔:可能是本机偶发,也可能是与前一轮收尾挨得太近。

## 4. 没做成的,与建议

1. **本机替身里的 X 只能是协议层节点(claimer)**。5740～5749 这 10 个端口中,托管组合与三个源占 5 个,Y(先是创建者)占 3 个,放不下第二台独立渲染主机(render-host 固定占「端口、+1、+2」)。「真的独立渲染主机当 X」(`--x-nodes host`)只在外网模式可用,本机没有验证过。它的代码与 Y 的本机主机、`--role host` 同形。建议跨机时两种都开(外网缺省就是 `claimer,host`)。
2. **E6 反方向的判据要按 M7 D1 读**。任务书写的「层表里这一版的层都是 Y 的指纹」,在页面在线时并不成立:切分方给页面另出一份,谁先认领谁得卡。本机实测主重卡是页面(258a)抢到的,层表 v 3 的主指纹仍写 Y,候选里才有 258a。语义上这不算混层(一张卡只出自一种指纹),J-纯层判的正是这个。建议把计划里 E6 反方向的判据改成「每张卡只出自一种指纹,要求 Y 的细任务 X 认领 0」,不要写「全部层都是 Y」。
   - 跨机时页面在 PC、X 也在 PC,指纹相同,同样的情况会出现。
   - 若要纯 Y,可以在 X 上线前关掉页面,但页面是发布方,要收 `task.done`,不能关。这一条要主会话定。
3. **本检出的原有判据过时**:层表 v 2 与 A5 新快照两处,本分支已改。建议合入时一起看。
4. **跨机没有跑**:按任务书,本分支只做本机替身。跨机命令见第 5 节。
5. **没有跑 `npm ci`**:`multi_agent.md` 规定子 Agent 不跑 `npm ci`、依赖向上解析到主仓库的 `node_modules`,这与任务书「先 `npm ci`」冲突,按仓库规则办。tsc、测试、探针都能照常跑。
6. 本机替身里 J-纯层有 5 个任务是按「没有被 Y 记到、done、要求页面指纹」推断为页面完成的(`inferredPage: 5`)。页面没有自己的认领记录可读,这 5 个的完成者指纹用的是探针独立算出的页面指纹。

## 5. 跨机命令

- PC 起 creator(页面与 X);笔记本起 Y。协调口缺省 `https://8-219-80-16.sslip.io/coord`,开了信箱时两边都要环境变量 `PROBE_MAIL_TOKEN`(只从环境变量取,不进命令行)。
- `<id>` 两边相同(1～24 个 `[A-Za-z0-9_-]`),也可以笔记本用 `--run latest`。
- `<Y>` 是 16 位十六进制,不能等于 PC 的真实指纹,例如 `0c10b0e5f1a9e7d2`。

PC(外网模式;X 缺省 `claimer,host`,X 主机占 `<PC 段起点>` +0～+2,创建者编辑器占 +5～+7):

```
node scripts/probes/c10-browser-probe.mjs --site https://8-219-80-16.sslip.io --e6-reverse --run <id> --base-port <PC 段起点> [--coord <协调口>] [--host-wait-min 15] [--out <目录>]
```

笔记本:

```
node scripts/probes/c10-browser-probe.mjs --role host --run <id> --test-fingerprint <Y> --port <笔记本端口> [--coord <协调口>] [--out <目录>]
```

同一台机器上自测跨机协议(协调口由自己起,端口都在 5740～5749 之内;没有实际跑过):

```
node scripts/probes/probe-coord.mjs serve --port 5748
node scripts/probes/c10-browser-probe.mjs --role creator --e6-reverse --base-port 5740 --coord http://127.0.0.1:5748 --run <id>
node scripts/probes/c10-browser-probe.mjs --role host --run <id> --coord http://127.0.0.1:5748 --port 5745 --test-fingerprint <Y>
```

## 6. 提交

分支 `claude/m8-e6r`,在 `a52344a` 之上:

- `8a4d8f7` 报告:建文件
- `58332eb` 探针:加 `--e6-reverse`
- `39a8ee7` 探针:按 M7 D1 双份判;X 不碰自己指纹的任务;层表 v 3 也认
- `120e95a` 探针:A5 新快照认主机或页面自己出的层,失败时给精简诊断
- `1ede602` 报告:本机替身结果、跨机命令与建议
- 本条所在的提交:报告补基线结果
