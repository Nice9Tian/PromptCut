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
