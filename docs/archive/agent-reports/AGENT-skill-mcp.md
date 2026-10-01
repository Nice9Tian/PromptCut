# AGENT-skill-mcp：A4 SKILL 改为桌面 APP 经 MCP 直连同一个项目

分支 `claude/skill-mcp`（起点 `claude/r5-merge` 的 `a77855df`），worktree `.worktrees/skill-mcp`。做的是计划 `docs/plan/agent-workflow-plan.md` 的 A4（「Agent 与工作方式」计划的第 4 段：桌面 APP 里的 Agent 经 MCP 直接改用户正在用的那个项目），顺带 TODO「工作方式」里的「去掉对话式布局」。

> **醒目**：本段没有改二级语义；有两处建议补语义（一级一条、二级一条，均为 dry run，见第 8 节），以及一处删掉的用户可见功能（「合并 Skill 结果…」菜单，属于计划点名归档的三方合并，见第 4 节）。

## 1. 状态

**完成，验证全绿，停在分支上不合入。** 主会话定：A4 与 A5 同发，A5 在本分支之上接着做，两段等 PC 出完整安装包、实机测过后一起合入。

## 2. 提交

| 提交 | 内容 |
|---|---|
| `139f4e8e` | 建报告 |
| `b8776832` | 报告：未知数的结论 |
| `febced9d` | 服务端：MCP 直连、会话身份、SKILL 闸按类型、登记、分组推送；归档无头实例一套 |
| `fad6ee38` | 页面：AI 栏按会话分组、SKILL 对话框、悬浮窗预览改由页面渲；去掉对话式布局；归档 SkillLock、三方合并等 |
| `212c4d80` | 测试：SM-1～SM-14、SG-1～SG-4，按归档更新旧用例 |
| `1fd2938e` | 探针 `scripts/probes/skill-mcp-probe.mjs`；列工具时取卡片清单不报桌面身份 |

## 3. 未知数的结论（开工时查，只读用户的程序文件，没写任何用户配置）

1. **Claude Code 每个会话一个 stdio MCP 进程。** 本机 Claude 桌面版的「Code」每个会话是一个独立的 `claude.exe`（进程树里 `Claude.exe` 下挂着两个会话各一个 `claude.exe`），stdio MCP 服务由每个 `claude.exe` 自己起。`initialize` 的 `clientInfo` 是 `{ name: "claude-code", title: "Claude Code", version }`（在 `claude-code\2.1.284\claude.exe` 里查到 MCP 客户端就是这样构造的）。它支持 MCP 的 `instructions`（同一个二进制里有「MCP 工具说明与服务端 instructions 各 2048 字符上限」的说明）。`tools/call` 的 `_meta` 只有 `claudecode/toolUseId`（子 Agent 另有 `claudecode/agentId`），没有会话号——所以 Claude Code 按「一个 MCP 进程 = 一个会话」认。
2. **Codex 的 `clientInfo` 是 `codex-mcp-client`，Codex 桌面版能挂 MCP。** `codex.exe`（0.157.1）里 MCP 客户端名就是这个；它读 `~/.codex/config.toml` 的 `[mcp_servers.*]`（桌面版内嵌的就是这个 `codex.exe`，与命令行共用这份配置），所以计划第 3 节「不能就沿用命令行工具那条路」用不上。每次 `tools/call` 的 `_meta` 都带 `threadId`（`docs/archive/agent-reports/AGENT-runner-callid.md` 有实录），所以 Codex 不管是不是多个线程共用一个 MCP 进程，都按线程认身份。`instructions` 在它的初始化结构里有字段，但查不到会不会交给模型，所以 SKILL 提示词不能只靠它。**没有真的用 Codex 桌面版连过来试（要写用户配置），记为待用户项。**
3. **SKILL 提示词放哪〔裁〕**：放 MCP 自己身上，不写用户级 skill 文件——`initialize` 回一段不超过 2000 字的 `instructions`（Claude Code 会拼进系统提示词），另外只在桌面会话的工具列表最前面多一个本地工具 `get_skill_guide`（「开工先调一次」，回完整的做法与汇报约定），Codex 就算不读 `instructions` 也能从工具说明里知道。不写用户级文件就少一处要备份、要撤销的用户配置。
4. **没法区分会话的客户端〔裁〕**：Claude 桌面版的「聊天」（不是 Code）一个应用进程只起一份 MCP，所有聊天共用、`_meta` 里也没有会话号。本段不登记它；若以后要接，退路是「一个 MCP 进程算一个会话」（多个聊天会显示成同一组）。计划说的「会话开头领一个会话号、之后每次调用带上」要给所有工具加参数、并依赖模型每次都记得带，Claude Code 与 Codex 都用不上，不做。

## 4. 做了什么

### 4.1 MCP 直连（`server/mcp-server.mjs`、`server/agent/desktop-mcp.mjs`、`server/vite-plugin-ai.ts`）

- 同一份 `mcp-server.mjs` 服务两类调用方：AI 栏的命令行工具（编辑器在它的 MCP 环境变量里塞 `PROMPTCUT_CALLER=cli`，老的 `PROMPTCUT_AGENT` 也认）照旧带对话 ID；其余一律当桌面 APP 的会话。
- 找实例：`--port` > `PROMPTCUT_PORT` > `--port-file` / `PROMPTCUT_PORT_FILE` > 公共的 `%TEMP%\promptcut\port.json`；每次调用重新找（用户重开过 PromptCut 端口会变）。端口文件没有、坏了、记的进程已退出、端口没人听，都回一句「请先打开 PromptCut，不要反复重试」的说明（原来缺省连 5195）。
- 身份：会话号 `desk-<…>`，Claude Code 一个进程一个，Codex 按 `threadId` 哈希（同一线程换了进程还是同一个身份）；厂商从 `clientInfo` 认（`claude-code` → Claude Code，`codex-mcp-client` → Codex，认不出来用它自报的名字）。每次调用带 `caller { type: 'desktop', key, vendor, label, client, thread? }` 给 `/api/mcp/call`。
- 编辑器那边：`/api/mcp/call` 见到 `caller` 就在登记表里登记（类型 `desktop`，覆盖值恒为空＝跟项目的创造力等级），用 `key` 当对话 ID 进 `callToolInternal`——之后与 AI 栏的 Agent 走同一条路：SKILL 闸、创造力等级、`multiAgent.wrap`（公告板、覆盖与范围提示）、绑了项目副本时 `agent-side` 按对话开文档服务连接（每个会话自己的写入身份）、没绑时 `annotateResult`（「用户正在编辑」）。登记表加了 `label`、`client` 两个字段；覆盖提示与公告板的厂商名优先用 `label`（「Agent desk-…（Claude Code）刚改过」）。
- 编辑界面没打开时，页面侧工具回「编辑台没有打开……请用户打开编辑界面后再试，不要反复重试」（后台运行是 A5）。
- 列工具时顺手取卡片 / 部件清单拼 schema，这两次调用不报桌面身份（不进分组、不受闸管）。

### 4.2 登记（`server/desktop-register.mjs`、`server/vite-plugin-skill.ts`、`src/editor/SkillDialog.tsx`）

- 目标两个：Claude Code 的 `~/.claude.json` 的 `mcpServers.promptcut`（`{ type: "stdio", command, args, env: {} }`，与 `claude mcp add --scope user` 写的形状相同），Codex 的 `~/.codex/config.toml` 的 `[mcp_servers.promptcut]`（只写 `command`、`args`）。条目名固定 `promptcut`，**不写端口**（按端口文件找实例），所以不绑死端口或项目，换项目、重开 PromptCut 不用重登——这是计划风险第 2 条要的隔离。
- 写之前整份配置备份到 PromptCut 自己的状态目录 `<skillRoot>/mcp-register/`（`skillRoot` 缺省 `Documents\PromptCut-Skill`，不写进用户的配置目录）；登记记录记着原来那一条。撤销只动 `promptcut` 这一条：原来有同名条目的还原，原来没有的删掉，配置里别的内容（包括用户在这期间的其它改动）不碰；这一条被用户改过就拒绝撤销并说明。TOML 只按表头切 `[mcp_servers.promptcut]` 及其子表，别的原样保留，撤销后逐字还原；配置里用了别的写法（`[mcp_servers]` 里内联、顶层点号键）就拒绝、不猜。写入一律临时文件 + 改名，写完读回核对。
- 路径可覆盖：`PROMPTCUT_CLAUDE_CONFIG`、`PROMPTCUT_CODEX_CONFIG`、`PROMPTCUT_SKILL_DIR` 或函数参数。单测与探针只写临时目录。
- 接口：`GET /api/skill/desktop-register`（现状）、`POST { target, action: register | unregister }`。界面：顶栏点「SKILL」打开对话框，两张登记卡（状态、配置文件路径、「登记」「撤销登记」，写之前 `confirm` 写明文件路径与备份），「接进来的会话」列表，「进入 SKILL 模式」。

### 4.3 AI 栏按身份分组（`server/agent/desktop-activity.mjs`、`src/ai/desktopSessions.ts`、`src/editor/right/DesktopSessionsStrip.tsx`）

- 编辑器进程在每次桌面会话调用前后记：谁、正在跑什么、最近的调用、`report_progress` 交的报告（按服务端同一套校验，拒收的不算）；变了经 SSE `agent.desktop` 整份推给页面（节流 100 毫秒，页面一连上推一份），`GET /api/agent/desktop` 给诊断与探针（多带类型与生效的等级）。页面不主动请求，在线构建没有多出来的 `/api` 调用。
- AI 栏每个页签顶上（紧挨共享项目的远端 Agent 那一行）每个会话一组：厂商标签、会话短号、「正在修改 · update_clip」/「上一步：读取 · get_project」/「上一步失败：…」，展开是最近 5 份报告，用 AI 栏同一个 `ReportCard`（`user-workflow.md`「进度可见」：显示方式与 AI 栏里 Agent 的进度条目相同）。

### 4.4 SKILL 闸按调用方类型（`server/skill-gate.mjs`）

- 原来：只在无头实例进程（`PROMPTCUT_HEADLESS=1`）里拦，SKILL 关着时拒绝一切工具。现在：`checkGate(tool, callerType)`，只拦登记过的 `desktop` 会话，SKILL 关着时拒绝（包括只读的），说明里点名工具、说项目没改、别重试、请用户在顶栏切到 SKILL；AI 栏的 `api` / `cli` 不拦；没登记也没报身份的调用（测试、诊断脚本直接 POST）按 `unknown` 不拦——与原来「只管认得出来的那一类」一致，不然用户 Documents 里的状态文件会让所有直接调 `/api/mcp/call` 的测试变红。
- 状态文件路径不变（Rust 外壳 `skill_shell.rs` 在读），只写 `active / since / closedAt / closedBy`；外壳读的 `jobId`、`procPath` 不再写，它按没有处理。`/api/skill-mode/open` 不再收任务信息；SKILL 模式下 `.proc` 独占锁照常加（原来为了让无头实例写、外壳读而跳过）。
- SKILL 悬浮窗的「上一步动作」预览保留：原来由无头实例的页面渲，现在桌面会话做成一次操作、SKILL 开着时编辑器经 SSE 发 `skill.preview`，用户这份页面只对时间轴操作渲一张交回 `/api/skill-mode/last-action`（SKILL 关着时服务端不收）。

### 4.5 归档（从代码里删掉，git 历史留着；最后一个含它们的提交是 `b8776832`）

删掉的文件：`scripts/headless.mjs`、`scripts/pc-tool.mjs`（任务目录里给 agent 用的命令行，`save`/`status` 只对无头实例有意义）、`server/skill-templates.mjs`、`server/claude-desktop.ts`、`server/codex-desktop.ts`（深链拉起新对话）、`server/vite-plugin-view-gate.ts`（无头实例的只读钥匙）、`src/headless.ts`（`window.__pcHeadless` 自动写回）、`src/editor/right/SkillLock.tsx/.css`（SKILL 下锁住 AI 面板——多个 Agent 现在经文档服务同改一个项目，不再有「整份覆盖」的风险，语义也要求打开界面时 AI 栏照常显示桌面会话）、`src/editor/io/combineImport.ts`、`src/kernel/combine.ts`（三方合并）及它们的测试 `server/test/claude-desktop.test.mjs`、`codex-desktop.test.mjs`、`skill-gate-e2e.mjs`、`src/kernel/combine.test.mjs`。

删掉的代码与界面：`/api/skill/start`、`/api/skill/jobs*` 路由（在线 `/api` 棘轮基线随之删去三条，只减不增）；`submit_merge`；`skillMode.ts` 里跟着任务自动开闸、替 agent 合并的轮询；编辑台所有权令牌（`?owner=`、`editorOwner`、`/api/mcp/status` 的 `editorOwned`）与带钥匙的只读链接（`?view=`、`x-pc-owner`）；**顶栏「⋯」与标题栏「视图」菜单里的「合并 Skill 结果…」**（它就是没有基线的三方合并，计划点名归档；删用户看得见的功能按「对齐」属一级，但计划 A4 已写明归档三方合并，这里照做并写明）。

`PROMPTCUT_HEADLESS` 核对过谁在用：只有 `scripts/headless.mjs` 会设它。文档服务的停用模式、帧库推送与渲染节点、素材上传队列、卡片同步、自动渲染节点、端口文件、`vite.config.ts`（缓存目录、关热更新、不做局域网主机）里按它分的支都只为无头实例存在，删掉；渲染主机与探针起子进程时把它从环境里删掉的清单保留（防旧环境带进来，无害）。页面参数 `?headless=1` **保留**：探针与测试拿它开「自动化页面」（不塞演示卡、不接文档服务、不弹素材迁移框），与无头实例无关，只删了它的自动写回钩子。`/api/skill/open-path`（双击 `.proc`、桌面壳启动参数）与 SKILL 无关，保留在同一个插件里。

### 4.6 去掉对话式布局

顶栏开关只剩「传统式 / SKILL」（`ModeSwitch.tsx`、`.css` 两格）；删 `src/editor/layoutMode.ts`、`src/editor/preview/MiniScrubber.tsx`（只在对话式下显示）；`railLayout.ts` 的 `visibleItems` / `effectiveActive` 去掉模式参数，删 `sideVisible` 与 `railStore.useSideVisible`；`Editor.tsx`、`right/index.tsx`、`DockHost`、`DockPages`、`RailBar`、`agentAttention`、`pageNodes`、`Preview.tsx` 里按对话式分的支删掉（左栏、时间轴、右栏总在）；诊断报告的「模式」改成「传统式 / SKILL」，不再收 `pc.layout.mode`（旧报告里的 `layout` 字段读得进来，不影响）。用户之前存的 `pc.layout.mode = chat` 不再被读，打开就是传统式。

## 5. 〔裁〕清单（三级，语义没写到的细节）

1. 会话身份：Claude Code 一个 MCP 进程一个会话，Codex 按 `threadId`；Claude 桌面版「聊天」不登记（第 3 节）。
2. SKILL 提示词放 MCP 的 `instructions`（≤2000 字）加本地工具 `get_skill_guide`，不写用户级 skill 文件。
3. 找实例的优先级与失败时的说明（第 4.1 节）；每次调用重新找。
4. 登记：条目名 `promptcut`、只写 `command` + `args`、不写端口；备份与登记记录放 `<skillRoot>/mcp-register/`；撤销只还原这一条，被用户改过就拒绝；TOML 遇到别的写法拒绝。
5. SKILL 闸：只拦登记过的桌面会话；没报身份的调用不拦。
6. AI 栏分组的数字：每个会话留最近 20 次调用、30 份报告，界面显示最近 5 份；最多 16 个会话；2 小时没动静且没有调用在跑的不显示；推送节流 100 毫秒；只在内存里。
7. 分组放在每个 AI 页签顶上，而不是给每个桌面会话开一个 rail 页签：它没有输入框、没有文字回复，做成页签会多出一整套用不上的对话界面；「单独显示、标明厂商和正在进行的操作」都满足。
8. SKILL 模式下 `.proc` 独占锁照常加。
9. 悬浮窗预览由用户这份页面渲，只对时间轴操作。

## 6. 验证

**已跑（单个测试文件，符合禁令）**：

| 命令 | 结果 |
|---|---|
| `node --test server/test/skill-mcp.test.mjs` | 14 过 0 失败（SM-1～SM-14） |
| `node --test server/test/skill-gate.test.mjs` | 4 过 0 失败（SG-1～SG-4） |
| `node --test server/test/skill-last-action.test.mjs` | 4 过 0 失败（SKILL-LA-1～4） |
| `node --test server/test/mcp-callid.test.mjs server/test/mcp-bridge-timeout.test.mjs` | 2 过 |
| `node --experimental-test-module-mocks --test server/test/runner-callid.test.mjs` | 11 过 |
| `node --test server/test/port-file.test.mjs server/test/no-user-dirs.test.mjs` | 11 过 |
| `node --test server/test/auto-render-node.test.mjs server/test/creativity-gate.test.mjs`（与上两份同一批） | 全过（该批 33 过 1 败，败的是端口文件那条，已修，重跑 6 过） |
| `node --test server/test/proc-lock.test.mjs` | 9 过 |
| `node --test src/ai/envReport.test.mjs` | 15 过 |
| `node --experimental-test-module-mocks --test src/editor/dock/railLayout.test.mjs` | 20 过 |
| 改过的 `.ts/.tsx` 逐个用 TypeScript 转译检查语法 | 0 个语法错误（不是类型检查） |

**重验证（主会话放行后跑；机器上主会话同时在合并、构建、部署，有负载）**：

| 命令 | 跑了几遍 | 结果 |
|---|---|---|
| `npx tsc -b --force` | 1 | 退出码 0，0 行输出 |
| `npm test`（ffmpeg 已放进 PATH） | 1 | 退出码 0；tests 4065，pass 4064，fail 0，skipped 1（`集成:/api/cards/layout 对真实项目返回整数框`，原来就跳过；原来的 `skill-gate.test.mjs` 是要手动开的集成测试、会计进跳过，现在换成单测，跳过少了一条），84 s。含 `c10a-online-build.test.mjs`：C10A-API-01～06、C10-MERGE-01（两份产物里都没有「合并 Skill 结果」）、C10-TITLEBAR-01 全过；在线构建的 `/api` 清单与棘轮一致 |
| `snapshotCode` / `captureCode` | 1 | `00a5264bf8a062ff6e0b5ed0516cccd1` / `86e443cb6fa838aef64788af6822fd68`，与任务书给的相同 |
| `node scripts/probes/skill-mcp-probe.mjs --shots …`（端口 5880～5882） | 2 | 两遍都是 35 过 0 败（K0～K9）。第 1 遍看截图发现 SKILL 对话框里 Codex 那张卡被长路径撑出对话框右边，给登记卡加 `min-width: 0` 后跑第 2 遍，截图正常 |

看过的截图（第 2 遍，存在会话临时目录 `scratchpad/skill-mcp/shots2`）：
- `skill-dialog.png`：两张登记卡并排，状态「未登记（还没有这个配置文件，登记时会新建）」，路径是探针的临时目录；「接进来的会话」一行 Claude Code，上一步失败 update_clip（传统式下被闸拦下的那次）；AI 栏里那组显示闸的拒绝说明。
- `ai-bar-groups.png`：AI 栏顶上两组——Codex（本轮小结：已完成、问题）与 Claude Code（阶段 · 粗剪），厂商标签、会话短号、「上一步 处理 · report_progress」。
- `ai-bar-busy.png`：Claude Code 那组描强调色边框，写「正在等待 · wait」，报告卡照常。

截图里另见到：AI 栏下方原有的「Agent 操作记录」（文档服务的事件日志）把桌面会话记成「Agent『第 N 个对话』」，没写厂商——那是文档服务事件里的对话序号，本段没改，列入第 7 节。

## 7. 没做成的及原因

- 真的登记到用户的 Claude Code / Codex、真的用桌面 APP 连过来试：要写用户配置，按任务书不做，列为待用户项。
- `desktop/README.md` 的 SKILL 悬浮窗几节、`docs/` 里提到无头实例的旧报告没改：不在本段的文件清单；`desktop/README.md` 已在 `docs/plan/TODO.md`「文档」里挂着。
- Rust 外壳没动：SKILL 模式下桌面版仍会 `hide()` 主窗（`skill_shell.rs` 的 `enter`），WebView2 被隐藏后页面侧工具可能停摆。主会话已定 A4 与 A5 同发、由 A5 解决，本段不做临时绕法。
- AI 栏下方「Agent 操作记录」对桌面会话只写「Agent『第 N 个对话』」，没带厂商（文档服务事件里的对话序号）；分组里有厂商，这里没改，可在 A5 或之后顺手补。

## 8. 对计划或语义的更正建议（dry run，语义文件没改）

1. **`docs/semantics/mechanism/agent.md` 加一节「桌面 APP 接入」（三级）。**
   - 修改前：（没有这一节。）
   - 修改后：
     > ## 桌面 APP 接入
     > - 桌面 APP 的每个会话起一份 stdio MCP 服务（`server/mcp-server.mjs`），按端口文件（`%TEMP%\promptcut\port.json`）找用户正在用的实例；找不到、进程已退出、端口没人听时回说明，不重试。
     > - 身份：Claude Code 一个 MCP 进程一个会话；Codex 按 `tools/call` 的 `threadId`。厂商从 `initialize` 的 `clientInfo` 认。登记表里类型 `desktop`，创造力等级跟项目。
     > - SKILL 提示词：`initialize` 的 `instructions`（≤2000 字）与桌面会话才有的本地工具 `get_skill_guide`。
     > - 登记：写 Claude Code 的 `~/.claude.json` 与 Codex 的 `~/.codex/config.toml`，条目名 `promptcut`，只写命令与脚本、不写端口；写之前整份备份到 `<skillRoot>/mcp-register/`；撤销只还原这一条，被用户改过就拒绝。
     > - SKILL 闸只拦登记过的桌面会话，SKILL 关着时拒绝一切工具；AI 栏的 Agent 与没报身份的调用不拦。
     > - AI 栏分组：每个会话留最近 20 次调用、30 份报告，显示最近 5 份；最多 16 个会话；2 小时没动静的不显示。〔裁：2026-09-30 `claude/skill-mcp`，出处 `docs/plan/agent-workflow-plan.md` A4〕
2. **`docs/semantics/product/agent.md`「接入」补一条（二级，建议由用户确认）**：
   - 修改前：「所有 Agent 通过同一套工具接口操作项目……」「每个 Agent 会话有自己的身份……」
   - 修改后（在两条后面加）：「桌面 APP 的会话只在 SKILL 模式下能操作项目；传统式下它的调用被拒绝并说明原因，项目不变。」——代码原来就有这道闸（只拦无头实例），语义没写；现在按类型拦，行为用户看得见。
3. **`docs/semantics/user-workflow.md`「Agent 接入方式」桌面 APP 一段补一条（一级，只 dry run）**：
   - 修改前：「通过 MCP 接入本软件，权限与 AI 栏里的 Agent 相同。」
   - 修改后：「通过 MCP 接入本软件，权限与 AI 栏里的 Agent 相同。用户在软件里一键登记到桌面 APP（可撤销），之后在桌面 APP 里新开会话即可。」
4. **计划 `docs/plan/agent-workflow-plan.md` 第 3 节 A4**：「Codex 桌面版能否挂 MCP 先实测，不能就沿用命令行工具那条路」→ 改为「Codex 桌面版与命令行共用 `~/.codex/config.toml`，能挂 MCP（二进制核对，真机连接待用户试）」。
5. **`docs/plan/TODO.md`「工作方式」**：「去掉对话式布局」与「SKILL 改为桌面 APP 经 MCP 直接接入」两项合入后划掉，剩「关闭编辑界面转为托盘和悬浮窗后台运行」（A5）。

## 9. 待用户项

1. 在 PromptCut 顶栏点「SKILL」→「登记」到 Claude Code（写 `~/.claude.json`）与 Codex（写 `~/.codex/config.toml`），各自新开一个会话，让它调一次 PromptCut 的工具，看 AI 栏里是否出现对应厂商的分组；试完可在同一处「撤销登记」。
2. 在 Codex 里确认两件没法离线核实的事：它会不会把 MCP `instructions` 交给模型（不交也没关系，有 `get_skill_guide`）；工具调用是否每次都弹批准（本段没替用户设成自动批准）。

## 10. 主会话的决定（2026-09-30）与剩下要定的

1. 删「合并 Skill 结果…」菜单项：认可（语义里的 SKILL 是桌面 APP 经 MCP 直接改同一个项目，没有「合并」这一步）。
2. 删 `scripts/pc-tool.mjs`：认可。全仓 grep（含 `docs/`、`desktop/`、`scripts/README.md`；`server/skill-templates.mjs` 已随本段删掉）确认除 `docs/archive/` 里的历史记录、本报告与 SM-13 棘轮外没有别处引用。
3. A4 与 A5 同发：同意；本段停在分支上不合入，A5 在本分支之上接着做。
4. 语义：三级「桌面 APP 接入」一节主会话合入时写；二级「传统式下桌面 APP 的调用被拒」与一级「在软件里一键登记到桌面 APP」先不写进语义文件，列给用户定（第 8 节第 2、3 条的 dry run 保留）。
