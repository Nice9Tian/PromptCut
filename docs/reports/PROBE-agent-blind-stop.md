# 验证记录：看不了画面时不蒙着做下去（第 2、3 层）

分支 `claude/agent-blind-stop`，基线 `main` 的 `72dd9fc9`。
第 1 层（取素材失败给模型人话）已由 PR #20 做完，本分支不碰那条路。

改动范围：`server/harness/agent.mjs`、`server/agent/service/cloud-tools.mjs`、
`server/agent/service/instance.mjs`、`server/ai-system-prompt.md`。没有改到画面，
按 `docs/semantics/guide_files/verification.md`「按改动范围验证」不跑渲染附加项。

## 结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 + 构建 | `npm run build`（`tsc -b && vite build`） | 成功，无 TS 报错 |
| 新增用例 | `npm test -- server/test/agent-round-budget.test.mjs server/test/agent-blind-stop.test.mjs` | 15/15 通过 |
| 影响范围内的既有用例 | 见下 15 个文件 | 146 项：142 通过、4 跳过、**0 失败** |
| 云端工具接线探针 | `node scripts/probes/cloud-tools-wire-probe.mjs` | `PROBE-RESULT pass {"total":40,"ok":40,"fail":0,"skip":0}` |

既有用例按「引用了 `harness/agent.mjs` 或 `ai-system-prompt.md`」加上云端注记那三个文件挑的：
`accept-018-conv-endtoend`、`agent-invalid-tool-name`、`agent-summary-shape`、`agent-truncated-reply`、
`agent-user-message`、`card-authoring-guide`、`cloud-see-frames-dispatch`、`deep-auto`、
`history-token-budget`、`output-cache`、`stream-cut`、`vision-plumbing`、`cloud-agent-look`、
`cloud-tools-wire`、`cloud-tools-p1-media-frames`。

探针要账号服务那批依赖，照 `docs/local.md` 给当前进程设了
`PROMPTCUT_ACCOUNT_PROVIDER_ROOT` 与 `PROMPTCUT_PASSWORD_ORDER_MODULE`（值不抄在这里）。

## 新增用例盯的是什么

`server/test/agent-round-budget.test.mjs`（harness 两道闸）：

1. 过半、只剩四分之一各提醒一次，各只发一次（8 轮 → 剩 4 轮、剩 2 轮）；
2. 最后一轮不提（那一轮本来就要收尾，`left` 为 0）；
3. `deepAuto` 下模型上下文里不出现任何「轮」字——和 `deep-auto.test.mjs` 盯的是同一条约定；
4. 不限轮次（`Infinity`）时没有分母可算，一条都不发；
5. 同一个工具 + 同一个错误连续 2 次 → 硬提示带上原话、点名「不要用同样的参数调第 3 次」、指回决策表；
6. 连续 3 次 → `outcome === 'stalled'`，停下的原因点名那个工具，之后不再往下调；
7. 中间成功过一次就清零，不停；
8. 两次失败的代号不同不算连着；
9. `failureKey` 本身：优先用代号、没代号退回报错文字（带具体参数的报错算不同毛病）、都没有算 `unknown`、不同工具不算同一个毛病。

`server/test/agent-blind-stop.test.mjs`（提示词与云端注记）：

1. 素材模式接上了就不再说「云端还没有」，改说「也能用」并告诉它读不了时怎么办；
2. 没接上照旧说「云端还没有」；缺省按「没接上」算；
3. 两种写法只差素材那一句、行数不变；`look: false` 那一版逐字不变（等于 `CLOUD_SYSTEM_NOTE`）；
4. 「排卡前必须先看素材」那条现在指向决策表，不再是一条没有出口的硬要求；
5. 决策表三条路都在、「硬前提」有可操作的判据、明确排除「重试第三次」和「当它不存在接着做」；
6. 「先落地再打磨」在，且「还剩一半 / 只剩四分之一」的说法和 harness 真发的那两条对得上。

## 没验的

- **真实云端运行没跑。** 「把素材通道关着跑一条按画面排版的要求，期望它 3 轮内交出 `final: true`
  的报告并停下」这一条要动生产节点，本分支不做。等 PR 合入并部署后再在节点上复核。
- **第 3 层会改变模型的节奏**（更早落地、更少打磨），这是有意的；是否变成另一个极端（草草交付）
  只能靠真实运行观察，自动化用例测不出来。

---

# 验证记录：report_progress 加 blocked（第 4 层，另一个 PR）

分支 `claude/agent-blocked-report`，叠在 `claude/agent-blind-stop` 上（提示词里那几处
「停下来等用户」是上一层加的，这一层把它们改成 `blocked: true`，所以要排在它后面）。

改动范围：`server/tools/core.mjs`、`server/progress-report.mjs`、`src/ai/progressReport.ts`、
`src/editor/right/chat/{AgentBubble,ActivityPanel,OpDetailPreview}.tsx`、
`src/editor/right/chat/agent.css`、`server/ai-system-prompt.md`。

| 项 | 结果 |
|---|---|
| 类型检查 | `npx tsc -b --force` 退出码 0 |
| 构建 | `npm run build` 成功 |
| 新增与扩充的用例 | `report-progress`（+3 项）、`progressReport`（+2 项、校验对账加了 6 个 blocked 用例）、`agent-blind-stop`（+1 项） |
| 影响范围内既有用例（25 个文件） | 221 项：217 通过、4 跳过、**0 失败** |
| 云端工具接线探针 | `PROBE-RESULT pass {"total":40,"ok":40,"fail":0,"skip":0}` |

盯住的点：

1. `blocked` 不进 `required` —— 老驱动一个字不改照常收；
2. `blocked: true` **隐含 `final`**，`final` 漏填或填 false 都按收尾算（拒收要白费一个往返，而丢掉这一位用户就不知道球在他那边）；
3. `blocked: false` / 缺省 / `null` 时这一位根本不出现在结果里，老调用的形状逐字不变；
4. 不是布尔就拒收，报错写清收到的是什么；
5. 前端解析和服务端校验仍然逐例对账（校验对账那个用例加了 6 个 blocked 输入）；
6. `reportText` 带上「(停下等用户回话)」—— 换模型 / 回退后的「前情」里不留住这一位，新的那一轮会以为可以接着自己做；空报告不会只剩一句括号；
7. 卡片标题三处（报告卡、操作条上的小结图标、图标详情浮层）原来各写一遍，这次提成 `reportTitle()` 一份，避免只改了其中一处；
8. 操作条上的色调：`blocked` 没填 problems 时原来会显示成 "ok"，改成和有问题一样按 "warn" 画。

## 没验的

- **界面没有在浏览器里实跑过。** 要画出一张 `blocked` 的卡片得有一次真实的 Agent 运行交上这样一份报告；
  而本机的 dev server 以主工作区为 root（`docs/local.md`），从工作区预览要改主工作区的 `launch.json`，
  那台 5190 是用户自己在用的编辑器，不动。改动是 4 行 JSX/CSS，由一个有用例覆盖的布尔驱动；
  合入后在真实运行里看一眼卡片就能确认。
- 色值用的是既有的 `--ui-warn` 令牌，没有引入新颜色。
