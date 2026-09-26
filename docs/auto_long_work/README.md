# 长期自动开发的会话提示词

四台角色、五份模板，每份都是「准备（握手）+ goal」两段。规则本身在 `docs/semantics/guide_files/` 和 `docs/plan/Master-Execution-Plan.md`（第 0.4、6.4、6.4b、6.8、10 节），模板只指向它们，不重复。

## 会话与标题

标题固定，跨机认人一律靠标题（另一台机器上看到的句柄和它自己的 `local_` ID 不同）。

| 角色 | 标题 | 模板 | 备注 |
|---|---|---|---|
| PC 主会话 | PromptCut 主会话（PC） | `pc-main.md` | 有 task-announce |
| PC 辅助节点 | PromptCut M5～M8 PC 辅助测试节点 | `pc-helper.md` | 有 task-announce |
| 笔记本主会话 | PromptCut M5～M8 开发交接 | `laptop-main.md` | **没有 task-announce**，goal 里不写播报 |
| 笔记本辅助节点 | PromptCut 笔记本辅助测试节点 | `laptop-helper.md` | 同上 |
| 云端工作节点 | PromptCut M5～M8 云端工作节点 | `cloud.md` | 只能经信箱，单独计费 |

同一时刻只有一个主会话；用哪台机器，就激活另一台的主、这台的辅。主会话之间的交接见 `handoff.md`。

## 顺序

1. 开主会话：发它模板里的「准备」段，做完自检。
2. 开辅助与云端：发各自的「准备」段，它们向主会话报到，主会话回执。
3. 三方到齐：给每个会话钉各自的 goal（方括号填实际标题和 ID）。
4. 切换主会话：按 `handoff.md`，先给现主钉交接 goal，再给新主发接手段，最后重钉两台的 goal。

## 当前的 ID 在哪

本文件夹里的 `local.md` 记着各会话当前的标题、ID、跨机句柄、机器信息和信箱 seq。它是本机文件，不入库（`.gitignore`），每次开新会话或交接后手动更新；另一台机器要用时从这台抄。

## 每次都要手填的

- 〔ID〕：会话自己用 `get_session self` 查，不要从 scratchpad 路径猜。
- 云端环境变量三行（PROBE_MAIL_TOKEN、NODE_USE_ENV_PROXY、PC_CHROME_ARGS）：填进云端会话的环境设置，值不进任何文件。
- 凭证包与子 Agent 套件：新机器第一次用时从 PC 打包，见 `laptop-main.md` 的准备段。
