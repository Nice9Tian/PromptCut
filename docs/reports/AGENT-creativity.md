# AGENT-creativity：A1 创造力等级与堵 set_project_meta 口子

分支 `claude/creativity`，起点 main `1ef55bb2`。任务是 `docs/plan/agent-workflow-plan.md` 的 A1（「A1」指该计划第 2 节分段表的第一段：创造力等级 + 堵 `set_project_meta` + Agent 会话登记表）。

## 状态

代码、单测、界面探针都已完成，基线全绿。没推送、没合并。

提交：

| 哈希 | 内容 |
|---|---|
| `b8622343` | 建报告 |
| `80cae462` | 功能：等级定义、项目字段、项目设置、AI 栏按页覆盖、会话登记表、入口闸门、堵 `set_project_meta` |
| `6c6610eb` | 测试 CR-1～CR-10 |
| `8ad3af41` | 项目设置选项改短文案；界面探针 `scripts/probes/creativity-probe.mjs` |
| （本次） | 报告 |

## 做了什么

### 1. 堵口子：`set_project_meta` 只收声明过的字段

- **实现层**（`src/mcp/handlers/project.ts`）：新增 `SET_PROJECT_META_FIELDS = name、width、height、fps、duration、themeId`（与工具 schema 的 properties 一一对应，CR-2 核对）。参数里有别的键就抛错，整次不执行、一个字段都不写，报错列出不认的字段；带 `creativity` 时多一句「只能由用户在项目设置或 AI 栏里改，Agent 不能写」。页面（`src/ai/mcpExecutor.ts` 走路由表）和 Agent 服务端（`server/agent/agent-exec.mjs` 的 `runRoute` 经 `ssr-host` 载入同一份 handler）跑的都是这一份，所以「页面侧与服务端侧两份实现」实际上是同一个函数，两条执行路径都测了（CR-1、CR-3）。
- **入口**（`server/agent/strict-args.mjs`，在 `callToolInternal` 里调）：`set_project_meta` 带 schema 没声明的参数，MCP 与 API 两条入口、绑没绑项目副本都在这里先拒。只管 `STRICT_ARG_TOOLS` 里的工具（现在只有它），别的工具不受影响。
- store 的 `setProjectMeta` action 没加运行时过滤：编辑器界面自己用它写 `camera3dFov`、`glRoute` 和这次新加的 `creativity`，那是用户操作，不是 Agent 的入口。

### 2. 创造力等级

- **定义**：`src/kernel/creativity.mjs`（+ `.d.mts`）：`low | medium | high`，出厂 `high`；`projectCreativity(project)` 字段缺省或不认识时按「高」；`effectiveCreativity(override, projectLevel)` 覆盖值优先。页面和服务端共用。
- **项目文档**：`Project.creativity?: CreativityLevel`（`src/kernel/project.ts`）。选「高」时不落字段（与旧项目存盘结果一致），选低 / 中时写值。同步改动提示的字段名加了「创造力等级」（`src/editor/sync/labels.ts`）。
- **项目设置**：`ProjectSettingsDialog.tsx` 在「三维渲染」下加「创造力等级」下拉，选项「低 · 只改参数」「中 · 可改代码和表达式」「高 · 可新建卡片和效果」，悬停给整句说明；随「确定」一起写。
- **AI 栏按对话覆盖**：`AgentTab` 加 `creativity: CreativityLevel | null`（null = 跟项目），存在本机 `localStorage` 的页签列表里，不进项目文档（计划第 4 节第 3 条〔裁〕）。输入区「⋯」运行选项弹层里加「创造力」下拉：「跟项目（当前项目等级）/ 低 / 中 / 高」；设了覆盖值时「⋯」上挂提示点。它按页存、不按驱动存（换驱动不改变这个对话能改到多深）。
- **随请求带给服务端**：`useAiChat.ts` 发 `/api/ai/chat` 时带 `creativity`（这一页的覆盖值）和 `projectCreativity`（页面这一刻的项目默认）；分工模式的 `runRoleTask.ts` 也带上同一页的覆盖值（否则它发的请求会把登记表里这一页的覆盖值冲成「跟项目」）。
- **Agent 会话登记表**：`server/agent/agent-sessions.mjs`，对话 ID → `{ type: api | cli | desktop, vendor, role, override, registeredAt, lastSeen }`。`/api/ai/chat` 每条消息登记一次（类型按 provider：`api` 为 api，其余为 cli；厂商 API 直连取设置里的 `api.vendor`，其余取 provider 名；角色先都是 `main`）。**没登记过的对话 ID 按桌面 APP 会话**（跟项目，不收覆盖值）；SKILL 无头实例（`PROMPTCUT_HEADLESS=1`）里一律按桌面 APP 会话。只在内存，上限 256 条。
- **项目默认等级从哪读**（`vite-plugin-ai.ts` 的 `currentProjectCreativity`）：绑了项目副本读副本（文档服务最新版）→ 否则读页面推来的镜像 → 否则用页面发消息时报的 `projectCreativity` → 都没有按「高」。
- **闸门**：`server/agent/creativity-gate.mjs` 的 `checkCreativity`，在 `callToolInternal` 里排在只读锁、SKILL 闸、严格参数检查之后，交给执行之前。被拒回 `{ ok: false, error, creativity: { current, required, tool } }`，服务端日志记 `agent.creativity-denied`。
- **系统提示**：`/api/ai/chat` 拼给模型的末尾一行加上「创造力等级「X」（来源）：这一档允许什么。越级的工具调用会被拒绝，被拒就停下告诉用户，不要绕」。
- **MCP 工具清单不按等级隐藏**（可选项，没做）：CLI 的 MCP 是全局登记的，一个 MCP 进程服务一个对话但工具清单只在启动时列一次，等级会在对话中途变；靠闸门拒绝更一致。

## 对照表（`server/agent/creativity-gate.mjs` 的 `TOOL_CREATIVITY`，唯一一处）

表里没有的工具需要「低」（谁都能用）。

| 工具 | 需要 | 理由 |
|---|---|---|
| `create_card`，同名用户卡已存在 | 中 | 整篇重写已有的卡 = 改它的代码。不带 `overwrite` 时实现回 409 并指向 `edit_card`，按中算能让中档拿到那句更有用的话 |
| `create_card`，卡不存在（含 `overwrite: true` 但卡不存在、id 非法） | 高 | 新建卡片 |
| `edit_card`（用户卡、内置卡） | 中 | 改已有卡片的源码 |
| `create_filter`、`create_pixel_map`、`create_audio_fx` | 高 | 新建效果 |
| `update_filter`、`update_pixel_map`、`update_audio_fx`，动到定义（ops、params、source、where、to、mode、colorSequence） | 中 | 改效果的表达式 / 步骤 / 参数声明 |
| `update_*` 只改 `name`、`description` | 低 | 只改库里显示的名字和说明 |
| 其余（`add_clip`、`update_clip`、`apply_card`、`apply_filter` / `apply_pixel_map` / `apply_audio_fx`、组合卡与部件工具、`remove_*`、`measure_audio`、读工具等） | 低 | 用已有的卡片 / 效果 / 部件、改参数、内置测量 |

「卡在不在」按生效的那一份判（`card-overrides.mjs` 的 `effectiveIsFile`，改动层优先），只查 `src/cards/user/<id>.tsx`；id 不是 kebab-case 就不去碰文件系统。

## 〔裁〕

以下是语义没写到、按语义的意思定的三级细节（改了用户看不出区别之外的部分都属机制），合入前请审：

1. **〔裁〕`apply_card` 算「低」**：它把已有的卡片定义应用到片段、传实例参数，属于「用已有的卡片、改参数」。
2. **〔裁〕组合卡（`add_composite`、`add_part`、`set_part`、`remove_part`、`move_part`、`set_clip`）算「低」**：部件是已有的，拼装和改参数不写代码、不写表达式。
3. **〔裁〕「内置测量方法」= 现有的 `measure_audio`**（ffmpeg EBU R128），以及读项目、看画面这类读工具；「自定义测量代码」指计划 A6 的新工具，进表时标「高」。
4. **〔裁〕`update_*` 只改名字 / 说明算「低」，动到定义算「中」**：效果的参数声明（default、min、max）也算定义——它改的是所有挂着这个效果的片段；逐段改参数值走 `apply_*` 的 `params`，是「低」。
5. **〔裁〕`create_card` 碰上已存在的同名用户卡（带不带 `overwrite`）都按「中」**；卡不存在按「高」。
6. **〔裁〕删除效果（`remove_filter` 等）算「低」**：不新建、不改代码；删除本身另有理由门槛。
7. **〔裁〕没登记过的对话 ID 当桌面 APP 会话（跟项目）**：AI 栏的对话每条消息都先登记，登记表外的调用只可能来自 SKILL 无头实例或手工挂上的 MCP 客户端。
8. **〔裁〕项目选「高」时不落 `creativity` 字段**：与旧项目的存盘结果一致；读时缺省即「高」。
9. **〔裁〕`glRoute`（三维渲染路线）与三维透视不进 `set_project_meta`**：任务书写了「以工具 schema 里声明的为准」，schema 里没有这两项；三维透视本来就走 `set_camera3d`。任务书列的「三维透视强度、三维渲染路线」因此不在白名单里。

## 验证

- **单测**：`node --test server/test/creativity-gate.test.mjs` → 11 条全过（CR-1～CR-10，CR-4 分 a/b 两条，入口检查与 CR-4c 合在 CR-5）：
  - CR-1 页面侧（路由表 → editorApi）带 `tracks`、`media`、`fooBar` 被拒，项目对象身份不变；
  - CR-2 `SET_PROJECT_META_FIELDS` 与 schema 一致，schema 不含 `creativity`；
  - CR-3 服务端侧（`createAgentExecutor` + 假文档服务链接）带 `cuts` 被拒、零提交；只带 `name` 提交一次；
  - CR-4a/b 页面侧、服务端侧写 `creativity` 被拒、不提交；
  - CR-5 入口严格检查只管 `set_project_meta`；入口也拒 `creativity`；
  - CR-6 三档 × 对照表 18 行，外加「高档对清单上每个工具都放行」「表里每个工具都真实存在」；
  - CR-7 `create_card` 已存在 = 中、不存在 = 高、非法 id 不查文件系统；
  - CR-8 报错写明当前等级、要的等级、来源、怎么调；
  - CR-9 登记表：覆盖优先、跟项目、覆盖可高于项目、重新登记改回跟项目、未登记 = 桌面 APP、桌面会话不收覆盖、无头实例一律跟项目、非法覆盖值当没设；
  - CR-10 旧项目缺字段 / 非法值按高。
- **类型检查**：`npx tsc -b --force` → 退出码 0。
- **全量测试**：`npm test` → tests 4046、pass 4044、fail 0、skipped 2（main 上 4035 条，多出的 11 条是本次新增），退出码 0。最后一次提交后重跑结果相同。
- **代码指纹**：`snapshotCode` = `00a5264bf8a062ff6e0b5ed0516cccd1`，`captureCode` = `86e443cb6fa838aef64788af6822fd68`，都没变。
- **界面探针**：起 dev server（`PROMPTCUT_NO_PORT_FILE=1 npx vite --port 5760 --strictPort --host 127.0.0.1`），`node scripts/probes/creativity-probe.mjs --origin http://127.0.0.1:5760 --shots <目录>` → 15 项全过，退出码 0：
  - P1 新项目缺省「高」，三个选项，切「低」确定后项目文档里 `creativity = 'low'`；
  - P2 不带对话 ID 的 `create_card` 被拒（当前「低」、要「高」，来源「桌面 APP 会话跟随项目的默认等级」）；
  - P3 `set_project_meta({ creativity: 'high' })` 被拒，项目仍是「低」；
  - P4 运行选项缺省「跟项目(低)」，改「中」后本机页签存 `medium`，项目默认不变；
  - P5 发消息的请求体带 `creativity: 'medium'`、`projectCreativity: 'low'`（拦了 fetch，没真的起模型）；
  - P6 真的经 `/api/ai/chat` 登记「中」（provider 给了不存在的名字，登记在起模型之前，起模型那步直接报错，不花额度）：`edit_card` 过闸、`create_card` 仍被拒且报错写「中」「这个对话单独设的」；对照：不带对话 ID 的 `edit_card` 被拒（要「中」）。
  - 看过的图：项目设置对话框（「创造力等级」一行，选「低 · 只改参数」，与其它行对齐、不折行）；运行选项弹层改前（「创造力：跟项目(低)」）与改后（「中」，「⋯」上出现提示点）。第一轮截图时发现选项整句太长把标签挤成两行，已改短文案后重截。
  - 探针结束时把项目等级和页签覆盖改回缺省；dev server 已停（只停了自己起的那个进程）。

## 没做成的 / 需要注意的

- **MCP 工具清单不按等级隐藏**：可选项，没做，理由见上。
- **等级切换后的短暂窗口**：用户在项目设置里改等级后，服务端要等副本 / 镜像追上（实测不到一秒）才按新等级判；这段时间里按旧等级。探针 P2 因此轮询等待。改到低档之前刚发出的调用可能仍按高档放行。
- **登记表的厂商与角色**：先按 provider 填，角色都是 `main`；A3 多 Agent、A4 桌面 APP 直连时再按调用方类型细分。
- **页面上的 A1 以外的旧入口**：分工模式的角色任务沿用发起页的覆盖值；它们本身在 A3 要归档。

## 对任务书或语义的更正建议（dry run，未改 `docs/semantics/`）

1. 任务书与计划第 2 节把 `set_project_meta` 的白名单写成「名称、画幅、帧率、总时长、主题、三维透视、三维渲染路线」，但工具 schema 只声明了前五项加 `duration`；三维透视走 `set_camera3d`，渲染路线 Agent 没有工具可写。建议计划改为「以 schema 为准：name、width、height、fps、duration、themeId」。
   - 修改前（计划 A1 行）：「只收声明过的字段（名称、画幅、帧率、总时长、主题、三维透视、三维渲染路线）」
   - 修改后：「只收 schema 声明过的字段（名称、画幅宽高、帧率、总时长、主题；三维透视走 `set_camera3d`，三维渲染路线只在项目设置里改）」
2. `user-workflow.md`「创造力等级」表里「只改参数」可以补一句口径，避免后续对 `update_*` 的参数声明、组合卡拼装各自理解。建议放三级（`mechanism/agent.md`）而不是一级：
   - 修改前：（`mechanism/agent.md` 无此条）
   - 修改后（新增一节「创造力等级的判定」）：「工具需要的等级集中在 `server/agent/creativity-gate.mjs` 的对照表：新建卡片 / 效果要高；改已有卡片源码、整篇重写已有卡片、改效果定义（表达式、步骤、参数声明）要中；其余（用已有卡片 / 效果 / 部件、改片段参数、只改效果名字说明、内置测量）要低。没登记的调用方按桌面 APP 会话，跟随项目等级。」
