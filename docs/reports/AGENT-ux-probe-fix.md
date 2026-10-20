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
- `npx tsc -b --force`:退出码 0,零错误。
- `npm test`(设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`):第一遍 7204 项里 1 项取消(`server/test/asset-project-workers.test.mjs:97` 真实 ffmpeg 转码 20 秒超时,当时另一位子 Agent 也在跑,机器忙;单独重跑这个文件 11/11 通过);第二遍全量:`tests 7204, pass 7190, fail 0, cancelled 0`(14 项跳过),「npm test 最终结果：零失败」,退出码 0。本分支只改了探针脚本,不进 `npm test`。
- `cloud-agent-ui-probe.mjs --base-port 29003 --dist <本分支现打的在线构建>`:`{"summary":{"total":28,"failed":0}}`,退出码 0(不带 `--dist` 时它找主仓库根下的 `dist-online/`,worktree 里没有,先报 ENOENT,不是本次改动带坏的)。

## 没做成的:第 4、5 项(在线浏览器那一遍)

在线构建的云端 AI 栏只认账号项目(`useCloud.ts`:`accountMode = ONLINE_BUILD || …`),而这支探针整套是口令式限定进入的云端项目、在线页面靠会话恢复记录进入。按语义(`product/hosting.md` 第 9 行)云端项目一律走网站账号,这条路在产品里已经不存在,所以不是「改找元素、改等待」能修的:

- 受影响的不只 `online` 一步:`stop` 的 B3、`spaced`(K1～K3)、`usercard`(UC1、UC2)、`errors`(E1～E5)发起方都是在线页面上的创建者,全部要先选「云端」。2026-10-20 的整轮里这些步骤其实一步都没跑到(在线那一遍抛出的异常直接到了顶层),所以「只差 5 项」是低估。
- 要让它们重新有效,得把这支探针迁到账号组合上(参照 `cloud-agent-ui-probe.mjs` 0.7.18 的迁法:VisuHive 真账号后端、账号模式文档服务、登录、开始页新建云端项目、首次使用时的告知对话框、成员邀请),并且给账号组合接上真的渲染服务(现在 `startRunnerProcessFixture` 里只有渲染替身)。这已经是重写整支探针(约 1000 行),超出本任务「只改找元素与等待」的范围,也会碰到桌面版那一遍(无头 dev server 页面没有 Rust 壳里的账号保管,`cloud-agent-ui-probe.mjs` 迁移时就把桌面阶段整个拿掉了)。
- 没有为了让探针变绿去跳过这些步骤或放宽断言。

需要主会话 / 用户定:A. 立一个任务把 ux-ui 探针迁到账号组合(含真渲染服务);B. 在线发起的那几步在账号模式下由别的探针承担,ux-ui 探针收窄为桌面版发起(把缺省 `--steps` 改成 `desktop`,在线各步标注「待迁到账号组合」);C. 其它。

## 产品与语义上的发现(不是本次改的)

- **语义冲突(生产上也存在)**:`product/agent.md` 第 41 行承诺「被改动的重卡由云节点上托管方的渲染节点渲出来并入库，全程不需要任何成员的设备在线」;`product/rendering.md` 第 45 行定「生成轨道流」关着时托管方的渲染节点完全不为这个项目产流,而且这一项要创建者在权限分组里才能打开(缺省关)。快照作废后,项目没开这一项时,云端 Agent 改完重卡,渲染服务认领计划、切出 0 个任务,对话里却照样显示「已把 3 个片段交给云端渲染」「云端渲染完成」(本次复现的就是这个现象)。建议用户定:要么 agent.md 那句加上「项目开了『生成轨道流』时」,要么 Agent 侧在计划切出 0 个任务时不说「云端渲染完成」(改说「这个项目没开生成轨道流,由成员设备播放时自己产」之类)。
- 生产节点没有去查:根因已在本机定位,与 `render.code-mismatch` 无关;本次没改服务端,不需要。

## 部署

- 只改了 `scripts/probes/` 下两个探针文件,没有改 `server/`、`src/`:不需要重启任何服务,也不需要同步渲染树。
- 整支缺省跑一遍(run8,全部步骤):15 项 13 过 2 不过,只剩「等到:接入方式里有可选的『云端』」与「探针自己没出错」(都是在线那一遍,见上节);X0、D A1～A7 全过;退出码 2。
