# AGENT-agent-heavy-followup

分支 `claude/agent-heavy-followup`（自 main `b88dbdec`），worktree `.worktrees/agent-heavy-followup`。未推送、未合并、未部署。

## 任务

线上（2026-10-21，部署 b88dbdec）「云端 Agent 只发重卡」的两个问题：

1. **判定看不见**：判定日志 `agent.render.judged` 走运行器的 `log`，生产的任务进程入口没给 `log`（缺省空函数），全丢了；主服务日志只有 `agent.publish.plan` / `agent.render.published`。
2. **改过参数的卡一律判重**：改任何参数都换成本身份，新身份没有记录，按兜底（非 `direct` 判重）照发。线上 particles 每个旧身份都测得约 2 ms/帧，Agent 每改一次参数还是发。

## 做了什么

### 一、判定看得见

- `server/agent/service/render-clips.mjs`（`createHeavyRenderGate`）：每次判定生成一份摘要 `judged`：`candidates`、`heavy`、`light`、`why`、`records`（有才带）、`estimated`（估了几张，有才带）、`lightClips`（判轻的片段 id，截前 `JUDGED_CLIP_IDS` = 10 个，只为日志看得过来）。照旧记日志 `agent.render.judged`。有判重的随 `emit(clips, { rev, judged })` 交；一张重的都没有时交给新的 `report(judged, { rev })`。
- `server/agent/service/account-runner.mjs`：`render_request` 事件加 `judged` 字段。一张重的都没有时也发一条 `render_request { clips: [], rev, userCards, judged }`。版本号拿不到时同样发片段为空的这一条：以前直接不发，这次判了什么也就看不到。
- `server/agent-service/account-render-requests.mjs`（主服务）：收到带 `judged` 的 `render_request` 就记一条 `agent.render.judged { projectId, runId, ...摘要 }`。项目号取文档服务核过的绑定，摘要只留认得的几项并核形状（张数是非负整数，`why` 是小写短词，id 过 `clipOk`），多余的项丢掉。片段为空时只记日志，不发布，也不记 `render` 事件。
- **向后兼容**：旧主服务见 `clips` 为空就直接返回（原来的代码），不发布；`judged` 是多出来的字段，旧主服务不认也不报错。旧任务进程不带 `judged`，新主服务照旧发布，只是不记判定日志。页面的事件折叠函数（`src/ai/cloud/events.ts`）对不认得的类型原样放过，`render_request` 本来就不显示。
- **任务进程的日志接到标准输出**：`server/agent-service/account-task-worker-config.mjs` 新增 `workerLogLine`，格式 `{ t, event, ...fields }`，和主服务 `main.mjs` 的 `line` 一样，一行一条 JSON。生产入口 `createWorkerConfiguration` 把它当 `log` 交给 `buildWorkerConfiguration`，于是运行器、工具提供者、看画面客户端以前丢掉的日志都进了任务槽单元的系统日志（`StandardOutput=journal`）。量：这些事件和旧托管档主服务记的是同一批，`agent.write` 每次写入一条，其余都是出错、少见的事件，不另加过滤。fork 起法（父子通道那种）的网关把子进程标准输出设成 `ignore`，不受影响；`worker.ready` 那一行照旧。

### 二、改过参数的卡按同一张卡估（三级，〔裁〕）

- `src/editor/agentHeavyClips.ts`：
  - 新增 `cardIdentityGroups(project)`，算出项目里每张卡出现过的成本身份。「同一张卡」的键是卡片 id 加源码版本（`sourceVersionsOf()`），参数、长度、帧率不进键。
  - `judgeHeavyClips(project, records, candidates, opts)` 新增第四个参数 `opts.sameCard`。摊平视图里某个片段的身份没有记录时，把同一张卡别的身份的记录（来自此刻项目里同一张卡的其它片段，加上 `opts.sameCard`）当成这个身份的记录，用 `representativeCosts` 取中位数，和「同一身份多条记录取中位数」是同一条，再照 `planPipelines` 判。同一张卡一条记录都没有，才按原来的兜底（`direct` 判轻，其余判重）。返回值多一个 `estimated`（候选里按估算判的），只作诊断。
  - 没有新数字：估出来的数和查到的数走同一条分派（`clipWeight` 只认 `stepMs`，推帧卡按一拍内追得上算，长片段不另算），这一点和原来有记录时完全一样。没找到页面里现成的「近邻估计」可复用（`src/render`、`src/editor` 里搜过 neighbor、估计、没有记录，只有 `catchUpEstimate.mjs`，那是另一回事：按播放位置估追帧代价）。
- 「改之前的身份」从哪来：共享成本记录的 `identityKey` 是不透明的哈希，看不出属于哪张卡，所以靠 Agent 服务自己见过的项目状态。
  - `server/agent/agent-exec.mjs`：`ctx.write` 多一个 `before: base`，即写之前的项目引用。不进事件，不进工具结果：`writeFields` 只挑 `opId` / `rev` / `inverse`。
  - `server/agent/agent-side.mjs`：`onWrite` 交给宿主的对象多一个 `before`。
  - gate 的 `note(clipIds, before)` 把写之前、写之后的项目都记下（先留引用，判定时用 `judge.groups` 折成「同一张卡 → 身份」，折完就放掉引用），判定时作为 `opts.sameCard` 交给判定。`loadHeavyJudge` 回的函数带一个 `groups`，旧的判定替身没有它也照常判。
  - 账号路径（`account-runner.mjs`）和旧托管路径（`create-agent-service.mjs`）都改成 `note(write.clipIds, write.before)`。
- 语义：`docs/semantics/mechanism/agent.md`「只发重卡」下面加了两条子项：「改过参数的卡按同一张卡估」「判定看得见」，都标〔裁〕，三级。`mechanism/rendering.md` 讲的是页面怎么测、怎么写共享记录，这次没动页面的判法，所以不改。

## 验证

- `npx tsc -b --force`：退出码 0。
- `npm test`（带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`、`PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`）：退出码 0，**tests 7359、pass 7344、fail 0、cancelled 0、skipped 15**，耗时 192.8 秒，结尾「npm test 最终结果：零失败」。这一遍跑完后只把一个用例改了号（AR-10 改 AR-13，见下），改号后单独跑过这个文件里的这个用例：通过。
- 新用例（编号是测试名前缀）：
  - `src/editor/agentHeavyClips.test.mjs`
    - **JH-06**：改参数前的身份有三条记录（1.8 / 2.2 / 90 ms），新身份没有记录。不给 `sameCard` 时照兜底判重；给了就按中位数 2.2 ms 判轻、不发，`estimated` 里有它。改之前测得 40 ms 时估出来也重、照发。新身份自己的记录到了就按它自己的，不再估。此刻项目里同一张卡的别的片段（参数、长度都不同）有记录时，不用 `sameCard` 也估得出。
    - **JH-07**：同一张卡一条记录都没有时照原来（stateful 判重、direct 判轻）；别的卡的记录不借；源码版本不同的不算同一张卡。
  - `server/test/render-heavy-gate.test.mjs`
    - **HG-06**：有判重的时摘要随 `emit` 交；一张重的都没有时交给 `report`；判轻的 id 截前 10 个；退路时摘要里的 `why` 是 `no-records`。
    - **HG-07**：写之前（`before`）和写之后的身份都折进 `opts.sameCard`；没有 `groups` 的判定函数照常判；`close` 之后不再记。
    - **HG-08 端到端**（真文档服务、真 vite 载入缝、真判定模块、托管档服务、发布替身）：页面只测过改之前的粒子卡（2.1 ms）；Agent 把它 `quantity` 从 80 改到 120，同时改一张一条记录都没有的 blur-text。发布的只有 `["fresh"]`。判定日志：`{"candidates":2,"heavy":1,"light":1,"why":"judged","records":1,"estimated":1,"lightClips":["lite"]}`。
    - **HG-09**：`workerLogLine` 一行一条 JSON 写到标准输出。
    - HG-05（上一分支的端到端）结果不变：发布 `["S~Y","hvy","norec"]`。`norec` 现在是按同一张卡 `hvy` 的 40 ms 估出来判重的（`estimated: 1`）。
  - `server/test/account-render-publish.test.mjs`
    - **AR-13**（主服务一侧，回执形状和内部口交上来的一样）：带 `judged` 的 `render_request` 记 `agent.render.judged`，项目号取核过的绑定，照发；片段为空、`rev: null`、只带摘要的，只记日志，不发布，也不记 `render` 事件；旧事件不带摘要照发、不记；形状不对的项丢掉（`token` 这类多余字段不进日志），连 `candidates` 都没有的整条不记。原来编号是 AR-10，全量测试里发现 AR-10 已被别的文件用了三次，改了号。
    - **AR-12**（要账号后端，真实任务进程经 mTLS 内部口进生产形状的主服务）：第一轮一张 blur-text（没有记录，重）加一张 lottie（direct，轻），只发 blur-text；主服务日志 `master.agent.render.judged` 为 `{candidates:2, heavy:1, light:1, records:0, why:"judged", lightClips:[<lottie 片段>]}`，事件库里的 `render_request` 带 `judged`。第二轮只改 lottie，不发新计划；主服务日志 `{candidates:1, heavy:0, light:1, why:"judged", lightClips:[<lottie 片段>]}`。
    - 为了能断言，测试夹具 `server/test/fixtures/account-runner-process.mjs` 的主服务日志过滤改成：`agent.render.judged` 的字段原样保留（原来除 `code` 外的字段全被去掉）。
  - AR-09、AR-11（真实任务进程、剪辑段 `段id~卡id`）照旧通过。
- 没有界面改动，没看图。

## 没做成的、已知缺口

1. **不跨任务进程记身份**：账号模式一轮一个进程。如果上一轮改出来的身份一直没人测（没有成员在线），这一轮又改，「改之前」的那一版也没有记录，只能借此刻项目里同一张卡别的片段；都没有就照兜底判重、照发。彻底的办法是页面写成本记录时顺带写「同一张卡」的键（卡片 id 加源码版本的哈希），这样 Agent 能直接按卡找记录。这要改文档服务成本记录的数据格式（`cost.put` / `cost.list` 加字段，页面也要改），属于改数据格式，这次没做，列为建议。
2. **估算的粒度**：同一张卡参数差别很大时（比如粒子数量 80 和 400）估得不准，可能把其实重的判轻、少发。少发能自己补回来：成员打开项目时，页面会按自己的实测再发清单计划。这一点和上一分支报告里的「共享记录只有单帧耗时」是同一类误差。
3. `before` 是一次工具调用里最后一次写入之前的项目。一次调用写多次时（一键流程这类），中间几次的「之前」不记；写之后的项目每次都记。
4. 用户卡的「同一张卡」键用的是服务端注册表里的源码版本。对不上页面 `user:online:` 前缀的那些，原本就查不到记录，估也估不出（同上一分支的缺口 4）。

## 对任务书 / 语义的更正建议

- 任务书说「同一张卡（same cardId / same card source identity）」。我取的是两者同时相同：卡片 id 相同、源码版本也相同。源码被 Agent 改过的用户卡不借旧源码的记录，偏保守（判重、照发）。如果要跨源码版本借，改 `cardGroupOf` 一处即可。
- 建议后续把「同一张卡」的键写进共享成本记录（见缺口 1），属于数据格式改动，要按二级、三级的规则办。

## 部署清单（本分支未部署，按 `docs/local.md` 的惯例做）

**Agent / 渲染树** `/opt/promptcut-render/releases/35f7b2abb9db`（Agent 主服务和任务槽跑在这里）：

- `server/agent/service/render-clips.mjs`
- `server/agent/service/account-runner.mjs`
- `server/agent/service/create-agent-service.mjs`
- `server/agent/agent-exec.mjs`
- `server/agent/agent-side.mjs`
- `server/agent-service/account-render-requests.mjs`
- `server/agent-service/account-task-worker-config.mjs`
- 整份 `src/` rsync 进去：改了 `src/editor/agentHeavyClips.ts`，任务进程经 SSR 载它。

**文档服务树** `/opt/promptcut-v2/releases/35f7b2ab/pc`：文档服务自己的文件（`server/docservice/*`）这次没改，**不用换、不用重启 `promptcut-doc-v2`**。为了两棵树一致，上面 `server/agent/**`、`server/agent-service/**` 七个文件可以一起换，不重启文档服务。

**在线前端**：页面代码没改，但 `frameCode` 哈希整份 `src/`，`agentHeavyClips.ts` 变了，代码版本就变了。要从这个提交重建 `dist-online` 换上，否则 `render.code-version` 对不上。

**要重启的服务**：

- `promptcut-agent`（主服务，`account-render-requests.mjs` 换了）。任务槽每一代新开进程，会读新文件（`account-task-worker-config.mjs`、运行器）。
- `pm2 promptcut-render`（`src/` 换了）。
- 换之前先 `systemctl show <单元> -p ExecStart` 确认目录，并确认 6 个任务槽都是 inactive。

**上线后核验**：

- `journalctl -u promptcut-agent | grep agent.render.judged`：每次 Agent 改卡都有一条，带 `projectId`、`runId`、`candidates/heavy/light/why/records`；只改轻卡时也有，`heavy:0`。
- Agent 改 particles 的参数后：这条日志 `why:"judged"`、`estimated:1`、`lightClips` 里有这个片段；`agent.publish.plan` 里没有它；对话里不再出现「云端渲染中」。
- 任务槽单元的系统日志里出现 `{"t":…,"event":"agent.write",…}`、`{"event":"agent.render.judged",…}` 这类行，以前只有 `worker.ready`。

## 提交

- `e612ae3b` 报告开工
- `4ec2dfe5` 实现
- `6b9bd5a3` 测试
- `1656c215` 语义
- `b913c153` 用例改号 AR-13
- 本报告终稿另一个提交
