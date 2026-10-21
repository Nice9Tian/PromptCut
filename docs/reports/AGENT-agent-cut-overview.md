# AGENT-agent-cut-overview

分支 `claude/agent-cut-overview`(自 main 90ae8cff)。任务:云端 Agent 明明有就地改别的剪辑里片段的工具,线上(2026-10-21)新对话里仍然 `switch_cut` -> `update_clip` -> `switch_cut`(两次尝试两次都这样)。

判断(三级,不改语义):模型要先拿到 clipId,而它自然先读的 `get_project`(`tracks` 是激活剪辑的)和工具回包里的 `timeline` 只有激活剪辑的片段;切过去是它「看进」剪辑2 的办法,`list_cuts({cutId})` 是多出来的一跳,它不走。补充一个事实:云端 `get_project` 其实带着原始的 `cuts[]`(停放剪辑的全部序列和 params),但埋在整份项目 JSON 里,模型没把它当作「可编辑的片段清单」。

## 做了什么

### 1. 停放剪辑的片段索引(`src/kernel/agentScopes.mjs` 末尾,新增 `parkedCutsIndex` / `otherCutsHint`)

- `parkedCutsIndex(project, opts)`:只列没激活的剪辑。每条:`cutId`、`name`、`duration`、`trackCount`、`clipCount`、`clips`。每个片段:`id`、`trackId`、`cardId` / `mediaId` / `cutSegmentOf`(剪辑段引用了谁)、`cardName`(有卡片注册表的一侧才带)、`label`(超过 24 字截断)、`start`、`end`;不带 params。外加一句 `note`:这些片段不用 `switch_cut`,把 clipId 交给 `update_clip` 等十个工具就地改,`trackId` 用它自己的序列 id,切换会让所有成员的界面一起翻。
- 有上限:总共 60 个片段、每条剪辑 30 个;超出的给 `omitted` 计数和 `more`(「用 list_cuts({ cutId: "…" }) 看这条的全部」)。单剪辑项目返回 null(回包形状不变)。
- `otherCutsHint(project)`:轻量版,只给「别的有内容的剪辑」的 cutId / name / clipCount 和一句指路,用在每次工具回包的 `timeline` 里(不列片段,省 token)。
- 放在 `agentScopes.mjs` 而不是新建文件:Agent 服务的独立入口只许经 `server/agent/ssr-host.mjs` 引用 `src/`,而且部署到节点的 `src` 清单只有 `agentScopes.mjs` 和 `creativity.mjs` 两个文件(`accept-018-rest-ssr-seam.test.mjs`、`account-root-entry-probe.test.mjs` 守着)。第一次我新建了 `cutsIndex.mjs`,这 4 个守门测试立刻红了(见验证),所以挪了进去,并由 `ssr-host.mjs` 转出。

### 2. 谁带它

| 位置 | 变化 |
|---|---|
| `get_project`(页面 handler `src/mcp/handlers/project.ts`、云端副本 `server/agent/agent-exec.mjs` 的 `projectView`、桌面镜像 `server/agent/service/instance.mjs`) | 回包最前面多 `parkedCuts`(只在有停放剪辑时);页面侧带 `cardName`,云端副本没有注册表所以只有 `cardId` + `label` |
| `list_cuts` 不带 `cutId`(`src/mcp/handlers/effects.ts`) | 多 `parkedCuts`;带 `cutId` 时仍是那条的 `timeline`,不重复索引,且 `timeline` 里去掉 `otherCuts` |
| 所有带 `timelineDigest` 的回包(`src/mcp/tools/toolEcho.ts`) | `timeline.otherCuts`(只在别的剪辑有内容时) |
| 就地改停放剪辑的回包(`src/mcp/clipCut.ts`) | 去掉 `timeline.otherCuts`:那里的 `timeline` 是以停放剪辑当激活算的,「别的剪辑」是颠倒的,`cutNote` 已说明 |
| `switch_cut` 回包(`effects.ts`) | 多 `note`:已切换到「X」;切换会改共享的激活剪辑、让所有成员的界面一起翻;只是改已有片段不需要它,clipId 在 `list_cuts` / `get_project` 的 `parkedCuts`;之前激活的那条已停放,里面的片段同样可以直接改 |

### 3. 说明与系统提示词

- `server/tools/project.mjs` `get_project`:说明 `tracks` 只是激活剪辑的,别的剪辑的片段在最前面的 `parkedCuts`,不用 `switch_cut`。
- `server/tools/cuts.mjs`:`list_cuts` 开头就写「用户要你改的片段在别的剪辑里时,先看返回的 `parkedCuts`,不要 switch_cut」;`switch_cut` 开头写清只在用户明说要切、或要在别的剪辑里新增/删除/切分/复制片段、看画面时才用,切过去再切回来是两次多余的写入。`switch_cut` 没删。
- `server/ai-system-prompt.md` 多条剪辑一条:把「不要 `switch_cut`」及理由提到最前,指路 `parkedCuts`,后面原有的 add_clip/序列/导出只作用于激活剪辑、`switch_cut` 何时才用保留。

## 验证结果

- `npx tsc -b --force`:退出码 0,零错误(最终提交上重跑)。
- `npm test`(`PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`,`PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`),最终提交上:**退出码 0,tests 7341,pass 7326,fail 0,skipped 15**,「npm test 最终结果:零失败」。
- 第一次全量(索引还在新建的 `src/kernel/cutsIndex.mjs`)有 5 项红,全是同一个原因:新文件被独立入口直接引用 `src/` 且不在节点拷贝清单里——`SEAM-1`、`SEAM-2`、`SEAM-3`(`accept-018-rest-ssr-seam.test.mjs`)、`CA-SEAM-01`(`cloud-agent-service.test.mjs`)、「要拷到节点的那几样就够」(`account-root-entry-probe.test.mjs`,节点上少一个文件就载不起来)。把代码挪进 `agentScopes.mjs` 并由 `ssr-host.mjs` 转出后,这 5 项和其余全部通过。
- 新增测试(都通过):
  - `src/kernel/cutsIndex.test.mjs` 7 项:单剪辑为 null、只列停放的(含剪辑段 `cutSegmentOf`、素材段、空剪辑、缺 duration 兜底 30)、以 `activeCutId` 为准、`cardName` 与标签截断、总量与每条剪辑的上限及 `omitted`/`more`(输出小于 2 万字)、坏数据不抛、`otherCutsHint`。
  - `src/mcp/handlers/parkedCutOverview.test.mjs` 8 项:`get_project` 的 `parkedCuts` 排第一、单剪辑没有、`list_cuts` 带不带 `cutId`、回包 `timeline.otherCuts` 的有无(含就地改停放剪辑时没有、别的剪辑为空时没有)、`switch_cut` 的 `note`、`get_project`/`list_cuts`/`switch_cut` 说明措辞、系统提示词里「不要 switch_cut」排在 `add_clip、序列` 之前、**模型流程**:一个只读 `get_project` 的 `parkedCuts` 去找「剪辑2 里的『粒子背景』」的 mock 模型,调用序列恰为 `get_project`、`update_clip`,没有 `switch_cut`,只改了数量(`{count:120, color 不变}`),`activeCutId` 与激活剪辑 tracks 原样。
  - `server/test/agent-parked-cut-edit.test.mjs` +2(真文档服务 + 真执行器,云端副本路径):PK-4 mock 模型只读云端 `get_project`(第一个键是 `parkedCuts`,`rev` 之后只加 1)找到并改好停放剪辑里的片段,调用序列 `['get_project','update_clip']`,文档服务里的 `activeCutId` 仍是 `cutA`;PK-5 `list_cuts({})` 带 `parkedCuts`、激活剪辑的回包 `timeline.otherCuts`、`switch_cut` 的 `note` 且仍能切。原有 PK-1~3 照过。
- 没看图、没跑渲染探针:不碰渲染、舞台、预渲染。没有在真模型上重跑线上那句话(这需要部署后的云端 Agent 和真实模型)。

## 没做 / 已知限制

- 没有在线上复现验证:是否真的让模型不再 `switch_cut`,只能部署后再用同一句话试(见下「请用户定的事」)。我只能保证 `get_project` / `list_cuts` / 回包里确实把 clipId 摆出来了,且 mock 模型照着它就不会切。
- 云端 `get_project` 里 `parkedCuts` 没有 `cardName`(服务端副本里没有卡片注册表,不引入新的 `src/` 引用);只有 `cardId` + `label`。用户说的卡名(如「粒子背景」)若既不是标签、`cardId` 也对不上,模型得先 `get_clip` 核对。可后续让执行器经已载入的 host 给卡名。
- 每次工具回包多了 `timeline.otherCuts`(约百来字),只在别的剪辑有内容时出现。
- `add_cut` 默认也会切过去,没改它的回包(任务只要求 `switch_cut`)。
- 没动 `server/agent/service/render-clips.mjs`(另一个 Agent 负责发布)。

## 对任务书或语义的建议

- 语义没有冲突,没改语义文件。可选的三级补充(未写,等用户定):`docs/semantics/mechanism/agent.md` 或 `mechanism/project-model.md` 「剪辑的存法」第 8 行后加一句:「Agent 先读的 `get_project`、`list_cuts` 带停放剪辑的片段索引(`parkedCuts`,`src/kernel/agentScopes.mjs` 的 `parkedCutsIndex`,有上限),回包 `timeline` 带 `otherCuts` 提示,使模型拿得到 clipId、不必为了看进别的剪辑而 `switch_cut`。」
- 提醒:Agent 服务的独立入口对 `src/` 的引用被守得很严(节点只拷 `agentScopes.mjs`、`creativity.mjs`);以后要在服务端复用页面侧纯逻辑,放进这两个文件之一并经 `ssr-host.mjs` 转出。

## 部署清单(均未部署)

改到的文件:

| 位置 | 文件 |
|---|---|
| `server/`(Agent 服务:工具定义、系统提示词、执行器) | `server/tools/project.mjs`、`server/tools/cuts.mjs`、`server/ai-system-prompt.md`、`server/agent/agent-exec.mjs`、`server/agent/ssr-host.mjs`、`server/agent/service/instance.mjs` |
| `src/`(Agent 服务经 ssrLoadModule 载入的工具实现;同时是在线前端的一部分) | `src/kernel/agentScopes.mjs`(+`agentScopes.d.mts`,**节点上本来就有这个文件**,这次是改它)、`src/mcp/handlers/project.ts`、`src/mcp/handlers/effects.ts`、`src/mcp/tools/toolEcho.ts`、`src/mcp/clipCut.ts` |

- **Agent 树 `/opt/promptcut-render/releases/35f7b2abb9db`**:上表 `server/` 与 `src/` 两批**同批**放进去,再重启 `promptcut-agent`。必须同批:`ssr-host.mjs` 现在转出 `agentScopes.mjs` 的 `parkedCutsIndex`,`agent-exec.mjs` 从 `ssr-host.mjs` 取它;只上 `server/` 而 `src/kernel/agentScopes.mjs` 还是旧的,服务启动时会因缺少这个导出而起不来。
- **文档服务那棵树**(上一次 `agent-cut-edit` 同样处理的那棵):`server/` 那批按上次的习惯同步(`tools/`、`ai-system-prompt.md` 若它也在读);它不执行工具,`agent-exec.mjs` / `instance.mjs` / `ssr-host.mjs` 只在 Agent 服务里用。若这棵树的 `server/agent/` 与 Agent 树是同一份拷贝,则和 Agent 树一起换。
- **渲染树**:`src/` 那批(`agentScopes.mjs` 等),保持与 Agent 树一致;渲染服务本身不执行这些工具,不必为此重启 render 服务。
- **在线前端**:`src/mcp/*`、`src/kernel/agentScopes.mjs` 在前端包里(浏览器/桌面页面里执行 Agent 工具的路径用的就是这些);要让桌面/在线页面路径的 Agent 也带 `parkedCuts`,需重新构建发布。只关心云端 Agent 时前端可以不动。
- 其余:这批没有新依赖、没有新文件需要拷到节点(`cutsIndex.mjs` 只是中间产物,已并入 `agentScopes.mjs` 且不在最终分支里)。

## 请用户定的事

1. 是否合并 `claude/agent-cut-overview`(我未合并、未推送、未部署)。
2. 部署后,用同一句话「把剪辑2里『粒子背景』卡的粒子数量改成 120,别的不动」,剪辑1 激活、新对话,各试几次,看是否还有 `switch_cut`。如果仍有:下一步候选是让云端执行器给 `parkedCuts` 带卡名,或在 `switch_cut` 被调用且目标里有用户要改的片段时直接拒并指路(这会改变 `switch_cut` 的行为,属于二级,需要你定)。
3. 是否把上面「对任务书或语义的建议」里的三级补充写进 `mechanism/`。
