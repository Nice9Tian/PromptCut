# AGENT-agent-publish-heavy

分支 `claude/agent-publish-heavy`（自 main `90ae8cff`），worktree `.worktrees/agent-publish-heavy`。未推送、未合并。

## 问题

`product/agent.md`「发出任务后可以离开」承诺托管方渲染节点生成的是**被改动的重卡**给成员预览用的轨道流。代码里云端 Agent 的发布路径（`render-clips.mjs` 挑片段 → `render-request.mjs` / 账号模式的主服务发清单计划）把写到的卡片段一律放进清单，渲染节点又把清单里的片段一律当重卡产流（`server/render-node/local-node.mjs` 的 `listPlanOverrides`），所以轻卡（线上 particles，约 2 ms/帧）也被产流，每改一次参数对话里就出「云端渲染中 0/3」。依据 `docs/plan/cloud-agent-contract.md` 第 16.2 节的旧说法「Agent 服务没有成本记录的判定……全部按重卡处理」，和 2026-10-21 的产品语义冲突。

## 页面怎么判轻重（复用的规则）

- 在线页面的清单计划用的是 `heavyCardClips()` = `planDispatch.currentPlan().prerenderSet`，也就是 `planPipelines(knownCardsOnly(flatPlanProject(p)), costs, fps, { tuning, identityKeys, frameModes, deadMs: layerSwapMs })`，身份来自 `costIdentity.ts` 的 `clipIdentityOf`。`__pcPreviewDiag().snapshotFeed.heavy` 也来自同一张表。
- 不认得的卡按 `clipWeight` 兜底：声明 `direct` 的判轻，其余判重。
- 跨机器共享的实测放在文档服务的成本记录里（`cost.put` / `cost.list`，`server/docservice/modules/costs.mjs`）。同一身份有多条记录时取中位数（`boundarySearch.mjs` 的 `representativeCosts`）。

## 做了什么

1. **`src/editor/agentHeavyClips.ts`**（新）：`judgeHeavyClips(project, records, candidates)`。判法照页面原样：`clipIdentityOf` → 共享记录取中位数 → `planPipelines`（deadMs 用 `layerSwapMs`）→ `prerenderSet` 与候选取交集。没有任何新数字。和页面有一处不同：页面会先用 `knownCardsOnly` 去掉未知卡，这里不去，因为服务端注册表认不出的卡（还没登记进来的项目用户卡）要照原来判重、照发。
2. **`server/agent/service/render-clips.mjs`**：新增 `loadHeavyJudge(loadModule)`，经 ssr-host 载入缝取上面那个函数（先载注册表）。新增 `createHeavyRenderGate`，流程是：写入那一刻按原来的 picker 挑候选（剪辑段的 `<段id>~<卡id>` 照旧），攒满 `delayMs` 再判，只把判重的交出去；`flush()` 马上判。退路：判定模块载不了、成本记录读不到、判定抛错时，候选全部交出（等于原来的做法），并记日志 `agent.render.judged { candidates, heavy, light, why, records }`。
   - 攒的时长用预渲染重试同一个防抖 `RENDER_REQUEST_DEFAULTS.debounceMs`（3 秒），不是新数字。原因：Agent 改参数会换成本身份，要等在线成员的页面把新身份测完、写进文档服务，才有记录可用。
3. **`server/agent/service/instance.mjs`**：新增 `costRecords(agent)`，经这个对话的文档服务连接发 `cost.list`，失败回 null。
4. **`server/docservice/service-gate.mjs`**：云端 Agent 代成员的连接白名单加 `cost.list`，只读。`cost.put` 仍然拒。
5. **接线**：
   - `account-runner.mjs`（账号模式，线上走这条）：`onWrite` 只调 `renderGate.note`；`settle()` 结束前 `flush`，保证在终态事件之前报完 `render_request`；`drain` / `close` 时关掉 gate。
   - `create-agent-service.mjs`：每个对话一个 gate，攒的时长取 `render.debounceMs`（`render-request.mjs` 新暴露）；一轮结束时先 `flush` gate，再 `render.flush`；`closeEntry` 和删对话时关 gate。
6. **语义（三级，标〔裁〕）**：`mechanism/agent.md`「补发预渲染任务」加了「只发重卡」一条；`mechanism/document-service.md`「成本记录」加了「Agent 连接只读」一条。
7. **看画面（see_frames）不受影响**：它走 `prerenderPost` 即时渲染，不经过这条发布路径。

## 验证

- `npx tsc -b --force`：退出码 0。
- `npm test`（带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`）：退出码 0，**tests 7334、pass 7319、fail 0、cancelled 0、skipped 15**，耗时 218.5 秒。AR-09 和 AR-11（真实账号任务进程，含剪辑段 `段id~卡id`）、CA-RENDER-01～03、CA-AUTH-05 都通过。
- 新测试（用例编号是测试名的前缀）：
  - `src/editor/agentHeavyClips.test.mjs`，JH-01～05：有记录时轻的不发、重的发、多条取中位数；没记录时 stateful 判重、direct 判轻、未知卡判重；剪辑段里的卡同一条规则，同卡各实例共用记录；和页面的 `planPipelines` 表一致，挤不下的判重。
  - `server/test/render-heavy-gate.test.mjs`：
    - HG-01～04：攒批期间写进来的记录用得上、退路、flush 和 close、剪辑段候选。
    - **HG-05 端到端**：真文档服务、真 vite 载入缝、托管档服务、发布替身。Agent 改了 5 个片段，**发布的只有 `["S~Y","hvy","norec"]`**；轻的粒子卡 `lite` 和剪辑段里的轻卡 `S~X` 都没发。判定日志为 `{"candidates":5,"heavy":3,"light":2,"why":"judged","records":4}`。
- 没有界面改动，没看图。

## 已知缺口

1. **刚改过参数、页面还没测完的卡**：身份变了、没有记录，stateful 卡按现有兜底判重，照发。有成员在线时，页面一般在 3 秒内测完写进记录，判定就用得上；时间不够时这一次照发。没人在线时永远等不到记录，按判重发。这是现有规则（「没有记录的卡判重」）的直接结果，没有另编数字。线上 particles 那个现象能不能消掉，取决于页面测完写记录是否赶在 3 秒内，需要上线后看 `agent.render.judged` 日志确认。
2. **共享记录只有单帧耗时**，没有 `catchUpMs` / `kind` / `seekOk`，所以按「一拍内追得上」算权重。页面本机记录里如果长推帧卡被判成 `over-catchup`（例如超过约 8 秒的粒子片段），这里可能判轻、不发。少发可以自愈：成员打开项目时，页面会按自己的判法再发清单计划。
3. 账号模式下写入一侧攒 3 秒、主服务再攒 3 秒，发布最多晚约 3 秒。
4. 用户卡：服务端注册表里有、但身份前缀和页面的 `user:online:` 对不上时，查不到记录，判重，和原来一样。

## 对任务书 / 语义的更正建议

- `docs/plan/cloud-agent-contract.md` 第 16.2 节「Agent 服务没有成本记录的判定……全部按重卡处理」已过时，建议改成指向 `mechanism/agent.md`「只发重卡」。`render-request.mjs` 文件头的同一句已改。
- 白名单加 `cost.list` 我按三级处理（用户看不出区别，只读、成员本来就能读）。主会话若认为属于接口变更、要按二级办，请复核〔裁〕。

## 部署清单（需主会话按 `docs/local.md` 的惯例做；本分支未部署）

**Agent / 渲染树** `/opt/promptcut-render/releases/35f7b2abb9db`（Agent 主服务和任务槽跑在这里）：

- `server/agent/service/render-clips.mjs`
- `server/agent/service/render-request.mjs`
- `server/agent/service/instance.mjs`
- `server/agent/service/account-runner.mjs`
- `server/agent/service/create-agent-service.mjs`
- `server/docservice/service-gate.mjs`
- 整份 `src/` rsync 进去，其中新增 `src/editor/agentHeavyClips.ts`（任务进程经 SSR 载它）。

**文档服务树** `/opt/promptcut-v2/releases/35f7b2ab/pc`：

- `server/docservice/service-gate.mjs`（必须换，否则 `cost.list` 被拒，退回全发）。
- 上面五个 `server/agent/service/*` 也一起换，保持两棵树一致。

**在线前端**：页面代码本身没改，但 `frameCode` 会哈希整份 `src/`，新增文件会改变代码版本。所以要从这个提交重建 `dist-online` 换上，否则 `render.code-version` 对不上。

**要重启的服务**：

- `promptcut-doc-v2`，重启后紧跟 `asset-root-registry-publisher.mjs --rotate`。
- `promptcut-agent`（主服务）。任务槽每代新开会读新文件。
- `pm2 promptcut-render`（`src/` 换了）。
- 换之前先 `systemctl show <单元> -p ExecStart` 确认目录，并确认 6 个任务槽都是 inactive。

**上线后核验**：Agent 改一张轻卡后，日志应出现 `agent.render.judged why:"judged"`，且 `light ≥ 1`；对话里不再出现这张卡的「云端渲染中」。

## 提交

- `ab09a75e` 报告开工
- `d381c9ab` 实现
- `eca1590d` 测试
- `3ca41259` 语义
- 本报告终稿另一个提交
