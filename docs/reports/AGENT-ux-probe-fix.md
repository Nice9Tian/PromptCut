# AGENT 报告：ux-probe-fix

分支 `claude/ux-probe-fix`（起点 main `80bf8246`），工作区 `.worktrees/ux-probe-fix`。

任务：查清并修好 `scripts/probes/cloud-agent-ux-ui-probe.mjs` 里一直失败的 5 项（0.7.18 验收遗留）。

## 进度

- 开工，建报告。
- 2026-10-20 复现(`--steps desktop,online`,本机,端口 5790 段):与任务书描述一致,14 项 5 项失败(D A3、D A5、D A6、「等到:接入方式里有可选的『云端』」、「探针自己没出错」)。

## 根因与证据

### D A3 / A5 / A6:渲染服务认领了计划,切出 0 个细任务

- 渲染服务 `/status` 的 `queue.nodes[0]`:`claimed 2, plans 2, completed 0, dedup 0, failed 0`;对话记录里 render 事件 `published → done`(`"plans":1`,3 个片段)。
- 预渲染进程诊断口(`/api/frames/diagnostics` 的 `queue.events`):两次 `executor.plan ... controls:3` 之后 `executor.layer-map cards:0`、`node.plan-split`(derived 为空)、`host.layer-map layers:0`。
- 同一诊断的 `plans[0].controls`:三张卡都是 `tier: "none"`(两张重卡 `frameMode: stateful`)。
- `server/snapshot-tier.mjs`:`snapshotTier()` 一律回 `'none'`(提交 e13c6bcb「撤掉每张卡的 HTML 快照」,对应 2026-10-13 用户定的「快照作废」);`server/render-node/split.mjs` 的 `splitPlan` 对 `tier` 不是 shared/local 的控件直接跳过,所以快照细任务一个都不出;渲染服务又没开轨道流(`capabilities.streams:false`),流任务也没有。
- 语义 `product/rendering.md` 第 43 行:预渲染结果只有轨道流一档(快照 2026-10-13 作废);第 45 行:「生成轨道流」关着时托管方的渲染节点完全不为这个项目产流。
- 结论:**探针过时**。A3/A5/A6 仍按「渲染节点出每张卡的快照、舞台贴快照」断言;探针起的渲染服务也没照部署模板开产流(`server/hosted-render/deploy.mjs` 缺省 `PROMPTCUT_RENDER_STREAMS=1`),项目的「生成轨道流」也没开。不是渲染服务认领条件或代码版本的问题(`render.code-version` 三方 `match:true`,认领诊断无过滤项),和生产上那次 `render.code-mismatch` 无关。

### 第 4、5 项:在线页面的云端 AI 栏停在「正在读取对话权限…」

- 失败当场的页面内容(探针加的排查截图与 `select-cloud.missing` 行):`cloud-ai-panel` 在,显示「正在读取对话权限…」「消息会持久排队，等待执行服务」「正在确认对话权限，确认前暂不能发送。」,没有 `Composer`,所以没有 `[data-pc="ai-provider"]`。
- `src/ai/cloud/useCloud.ts`:`accountMode = ONLINE_BUILD || Boolean(shared?.accountId)`(提交 698b5c15「接入云端Agent账号同意与发送前守门」):在线构建一律按账号模式;`CloudAiPanel` 在账号模式下等对话权限元数据(`metadataReady`)才渲染输入框。
- 本探针在线那一遍进的是「项目名 + 用户名 + 口令」的限定进入项目(非账号项目),账号模式的元数据永远取不到。
- 语义 `product/hosting.md` 第 9 行:云端项目一律核对网站账号,项目密码流程只属于本地项目。`cloud-agent-ui-probe.mjs` 已在 0.7.18 改走账号组合(文件头第 5～10 行)。
- 结论:**探针过时,而且不是改找元素就能修的**。在线那一遍走的是「会话恢复记录 + 口令式限定进入」的云端项目,在线开始页上这条路已经没有,在线构建的云端 AI 栏只认账号项目。第 5 项(探针自己没出错)是第 4 项的异常一路抛到顶层造成的。

## 改了什么(第 1～3 项)

文件:`scripts/probes/cloud-agent-ux-ui-probe.mjs`、`scripts/probes/cloud-agent-ui-lib.mjs`(只动探针,没动产品代码)。

- 渲染服务照部署模板起成能产轨道流(`startStack` 新增 `renderEnv`,探针传 `PROMPTCUT_RENDER_STREAMS: '1'`)。
- 建项目后创建者打开「生成轨道流」(`shared.admin set-hosted-option`,与页面同一个创建者操作),并新增断言「X0 创建者打开『生成轨道流』,渲染服务能产流、看到这一项开着」。
- 「贴着预渲染结果」改看轨道流:`clipOnStage` 多报 `stream`(舞台 `__pcStageDiag().streams.tracks` 里含这个片段的那条流、画了几帧);探针的 `playbackSnapshots` 以「流画出了帧(或旧的快照层有内容)且没有占位」为命中;`onlineLayers` 把层表里的流(`__pcOnlineSnapshots().streams`)也列进来;A6 桌面版那一支核对层表时把 `body.streams` 的片段也算上。断言的强度没降:仍要两张重卡同时贴着、没有占位、出它的环境指纹是渲染服务的、截图不是空白、渲染节点完成数增加且素材服务多出文件。
- 排查用:`--keep` 时把几个服务的输出存进临时目录;`PC_PROBE_RENDER_VERBOSE=1` 打开渲染服务的工作进程输出;选「云端」失败时当场截图并记下 AI 栏内容。

## 验证

- `node scripts/probes/cloud-agent-ux-ui-probe.mjs --steps desktop`(run7):`{"summary":{"ok":true,"total":13,"failed":0}}`,退出码 0。
  - D A3:`renderEvents ["published","progress","done"]`,渲染节点 `completed 0→5`、`failed 0→0`,素材服务文件 `1→36`,全程 `membersEverOnline:false`。
  - D A5:两张重卡 `stream.drawn 2`、`placeholder false`,状态序列 `["stream|stream"]`;层表里两条单卡流 `env 7e57c10d00000002`(渲染服务的指纹);截图 163 种颜色、最多的一种占 36%。看过截图 `D-3-bob-stage-prerendered.png`:图表卡与重卡的橙块都在,不是空白。
  - D A6:层表 `layers:["clip-canvas","clip-stateful","clip-bars"]`(流),对话里「云端渲染中:0/6」「云端渲染完成」。
