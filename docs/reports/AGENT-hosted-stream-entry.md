# AGENT 报告：项目设置里「托管方的渲染节点」下加「生成轨道流」入口

分支 `claude/hosted-stream-entry`（从 main 的 `a783e12e` 建出）。2026-10-12。

## 结论

入口做完：项目设置「多用户协作」里，渲染节点那一行下面缩进多一行「生成轨道流」；文档服务把这一项记在 `hosted.render.streams` 并通知成员。**渲染服务认领任务时看不看它，这次没做**（任务书明确不在范围内）。类型检查零错误，`npm test` 零失败，新探针 22 项全过且 `fails: []`，原有界面探针 19 项全过，三张截图在。

## 范围

- 做：界面一行勾选；文档服务记下、成员列表带出、创建者操作 `set-hosted-option`、通知其余成员；契约补第 3.1 节。
- 不做（没碰）：`server/hosted-render/`、`server/render-node/`、`scripts/render-host.mjs`；`docs/semantics/`、`docs/plan/render-refactor-task.md`；别的开关。

## 做了什么

### 文档服务

- `server/auth/service-identity.mjs`：新增 `HOSTED_OPTIONS`（`render: ['streams']`、`agent: []`）与 `hostedOptionEnabled`（记录里没有算开）；`hostedStateOf` 给渲染节点多带 `streams: boolean`。成员列表顶层与目录条目（`hosted.mjs` 的 `viewFor` 调的同一个函数）都因此带上，没有改 `hosted.mjs`。
- `server/docservice/modules/shared.mjs`：
  - 新增创建者操作 `set-hosted-option { service, option, enabled }`：服务要在 `HOSTED_SERVICES` 里且登记表里有、`option` 要是该服务登记过的、`enabled` 要是布尔，否则 `bad-message`；落盘 `hosted.render.streams`；不加代数、不断连接、不动认领；给本空间其余成员连接（不含服务连接、不含发起的那条）发 `shared.notice { event: 'hosted-option-changed', service, option, enabled }`。
  - `set-hosted-service` 原先写 `[name]: { enabled }` 会整条换掉；改成 `{ ...原来的, enabled }`，保留同服务下别的字段。
- 契约 `docs/plan/hosted-render-contract.md` 新增 3.1 节（标〔裁〕）。

### 界面（`src/editor/sync/`）

- `hostedServices.ts`：`HostedServiceState` 多可选 `streams`；`parseHosted` 只在是布尔时收；`hostedOptionRowsOf`（出现条件与置灰条件）；`applyHostedOptionChange`（通知落到状态上，旧托管端没报 `streams` 时原样返回）；文案放 `HOSTED_OPTION_TEXT`，照任务书原文。
- `HostedServiceRows.tsx`：渲染节点那一块里缩进挂子行；渲染节点关着时加 `pc-collab-hosted-sub--off`（透明度 0.45）并禁用；成员只读并带「（只有创建者能改）」。`sync.css` 加缩进与置灰样式。
- `MembersPanel.tsx`：`Flow` 多一支 `hosted-option`，`HostedOptionDialog` 走和别的行一样的创建者确认。`CollabSection.tsx` 接线。
- `syncManager.ts`：`setHostedOption`（账号项目一律 `forbidden`，账号那条路没有渲染节点）；收 `hosted-option-changed`，只在关闭时给别的成员弹「创建者关闭了轨道流，托管方的渲染节点不再为这个项目生成轨道流。」。

## 验证

环境变量：`PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`、`PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，无输出（零错误） |
| 全量测试 | `npm test` | 退出码 0；5523 个用例，通过 5519，失败 0，跳过 4（非本次引入）；末行「npm test 最终结果：零失败」 |
| 文档服务单测（新） | `node --test server/test/hosted-stream-option.test.mjs` | 10 个全过：HS1 纯函数、HS2 创建者能改并落盘、HS3 订阅者收刷新、HS4 非创建者被拒、HS5 校验（未知 option、未知 service、agent 没有 streams、非布尔）、HS6 没有渲染服务与放本机被拒、HS7 两个开关互不冲掉、HS8 通知只发给别的成员连接、HS9 向后兼容、HS10 目录条目带 streams |
| 页面单测（新增到既有文件） | `node --test src/editor/sync/hostedServices.test.mjs` | 22 个全过（原有 12 个 + 新增 HS10～HS12 共 10 个：解析、出现条件、置灰条件、通知落到状态上、文案、组件渲染、点勾选、旧托管端不显示） |
| 受影响的既有单测 | `node --test` 跑 hosted-render-access / actsfor / identity / cloud-agent-auth | 前三个文件与新测试文件一起跑 33 个全过（其中新文件 10 个）；cloud-agent-auth 单独跑 21 个全过；这四个文件里原来对 `hosted` 整体形状的断言补了 `streams: true`（共 12 处） |
| 新探针 | `node scripts/probes/hosted-stream-entry-probe.mjs --out docs/reports/assets/hosted-stream-entry`（端口 5760 / 5763 / 5764） | 退出码 0；`{"summary":{"ok":true,"total":22,"fails":[]}}` |
| 原有界面探针不退步 | `node scripts/probes/hosted-render-ui-probe.mjs --out <临时目录> --desktop-port 5760 --doc-port 5763 --asset-port 5764`（原默认 8782/8783 不在分到的端口段里，所以改了端口） | 退出码 0；`{"summary":{"ok":true,"total":19,"failed":[]}}`（U1～U6 与页面错误全在） |

新探针（隔离托管端 + 本 worktree 的 dev server + 创建者与成员两个浏览器上下文）走的内容：S1 创建者看到缩进在渲染节点下的一行，缺省勾上可点；S2 成员看到勾着、禁用、带「只有创建者能改」；S3 创建者取消勾选，弹窗是约定的话，成员 5 s 内跟着变并收到提示；S4 渲染节点关掉，这一行置灰（透明度 0.45、禁用，点击不弹创建者验证），成员那端同样；S5 渲染节点再开，这一行恢复可点且仍是关（没被冲掉）；S6 再勾上，成员跟着变且没有提示；S7 渲染节点再关一次，这一行置灰勾着，随后恢复；S8 无页面错误。

### 看过的图（2 倍清晰度，只截「多用户协作」那一块，字清楚）

- `C:\Users\admin\Documents\PromptCut\.worktrees\hosted-stream-entry\docs\reports\assets\hosted-stream-entry\on.png`：渲染节点勾着，下面缩进一行「生成轨道流」勾着，说明是「托管方的渲染节点为这个项目生成轨道流，重卡在在线浏览器里播放更流畅。」
- `...\off.png`：轨道流没勾，说明是「已关闭：托管方的渲染节点只为这个项目生成快照，不生成轨道流；已经生成的保留。」
- `...\disabled.png`：渲染节点没勾（「已关闭…」），下面那一行整行变淡、勾选框灰着，是置灰的样子。

### 第一次没过的

- 开发过程中我自己写的两条文档服务新测试第一次跑挂过：HS4 里我误以为「成员的连接拿着创建者口令也会被拒」，实际现有的创建者操作只看证明（口令），不看连接身份，与既有 op 一致，那条断言是我写错的，已删；HS7 里用 `agent` 开关但没登记 agent 服务，改成登记两个服务。都是测试自己的问题，不是实现问题，之后全过。
- 正式验证（tsc、`npm test`、两个探针）都是第一次就过。

## 与任务书不一致、或需要主会话注意的地方

1. **清单外改动（单测里的既有断言）**：`server/test/hosted-render-access.test.mjs`、`hosted-render-actsfor.test.mjs`、`hosted-render-identity.test.mjs`、`cloud-agent-auth.test.mjs` 里原来整体比对 `hosted` 的断言，因为 `hosted.render` 多了 `streams`，必须补 `streams: true`（共 12 处）。它们属于「server/test/ 下对应的单测」，我按清单里这一条改了，这里单独指出。
2. **新增的测试和探针文件**：`server/test/hosted-stream-option.test.mjs`、`scripts/probes/hosted-stream-entry-probe.mjs`（照任务书允许的新增）。
3. **没有碰 `server/docservice/modules/hosted.mjs`**：目录条目靠同一个 `hostedStateOf` 自动带上 `streams`，不用改它。
4. 原有界面探针的默认文档、素材端口 8782/8783 不在分到的 5760～5769 里，我跑它时用参数改到 5763/5764，没改探针文件。

## 没做成的

没有。渲染服务那一半（认领任务时看不看这一项）按任务书没做。

## 对计划的更正建议、渲染服务那一半以后怎么接

- 目录条目（渲染服务订阅的 `hosted.project`）里已经有 `hosted.render.streams`，而且改选项后目录会推一条新的（新单测 HS10 钉住了）。渲染服务接这一半时不用再问文档服务，读目录条目即可。是否在条目顶层另带一个好过滤的字段，等接的时候再定。
- 注意目录条目里 `enabled`（渲染节点开关）与 `streams` 是两码事：关掉渲染节点会断服务连接并放回认领，关 `streams` 不会。渲染服务应该是「`enabled && streams` 才产轨道流」，而不是「`streams` 关了就不接这个项目」。
- 一个小建议：渲染节点那一行关着时，轨道流这一行置灰但仍显示它自己的说明「渲染节点为这个项目生成轨道流…」，读起来像是在生成。文案按任务书写的，没动；用户看过截图再定要不要在置灰时加一句「（渲染节点关着，暂不生效）」。
- `docs/plan/hosted-render-contract.md` 第 3 节里原有的「界面」条只提了渲染节点一个勾选，我在 3.1 里补了子选项；语义文档（`workflow/project.md`、`product/hosting.md`）没改，按任务书由主会话统一列给用户。需要写进语义的有：项目设置里多一行「生成轨道流」（一级，用户看得到）；记录里 `hosted.render.streams` 缺省开、创建者操作与通知（二级）。

## 提交

见最后一条消息里的哈希列表。
