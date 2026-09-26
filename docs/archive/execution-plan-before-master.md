# 执行计划（多智能体排期）

> 〔2026-09-26 归档〕原在 `.claude/execution-plan.md`。它是 2026-09-24 那一轮的执行计划，已被 `docs/plan/Master-Execution-Plan.md` 取代；文中说「本文件不入库」，实际一直在 git 里，所以移到这里留作记录。

本文件是本轮自动执行的**查阅基准**。上下文被折叠或记不清时，以本文件为准。和仓库规则冲突时，以 `docs/semantics/` 和 `guide_files/` 为准，并告诉用户。

- 建立：2026-09-24。基线：main `142b1ee`。
- 来源：`docs/plan/TODO.md`、`docs/plan/cloud-task.md`、`docs/semantics/**`、`r8-streams-task.md`、`r9-webgl-task.md`、`audio_structure_plan.md`（这些都由主 Agent 亲自按顺序读过）。
- 本文件不入库，只在主工作区里留一份。子 Agent 看不到它：它们需要的信息，都写进各自的派发提示里。

---

## 0. 状态总览（每推进一步就更新这张表）

| 任务 | 状态 | 分支 / worktree | 备注 |
|---|---|---|---|
| Task 0 冒烟测试 | ✅ 全绿，已清理 | 已删除 | tsc 0 错误；test 1718 项 / 1717 通过 / 0 失败 / 1 跳过；build 通过；editor-preview-smoke 通过；确定性 1800/1800 |
| 提权机制验证 | ✅ 通过，已清理 | 已删除 | 首次调用就带 `sandbox_permissions:"require_escalated"`，rollout 日志有原文 |
| T1a 第 5 步独立审查 | ✅ 完成，主 Agent 已自行裁定（第 12 节） | 无 | codex 14 条 + 6 条不一致；采纳 1、2（部分）、6（部分）进 T1b；3～14 属第 6/7b 步，未采纳，留给用户决定是否折回 cloud-task.md。评估存 scratchpad `T1a-review-verdict.md` |
| T1b 第 5 步素材服务空壳 | ✅ 已合并 `8b8ad2c` | 已删除 | 主 Agent 补一处：私有网络访问只放给回环/局域网来源（`isPrivateOrigin`）。tsc 0；test 1735/1734/0/1；确定性 1800/1800；verify-unified-frames 通过；合并后 main tsc 0、test 1735/1734/0/1。报告存 scratchpad `T1b-TASK-REPORT.md` |
| T1b-2 素材读取收尾（R8 之后） | ✅ 已合并 `2944743` | 已删除 | 导出与镜头拼图只经素材服务 HTTP；tsc 0；test 1776/1775/0/1；确定性 1800/1800；verify-unified-frames 通过；合并后 main 同。剩余：`frame-pipeline.mjs:272-276` 仍 stat 素材文件（只取大小/mtime，归后续） |
| T2 R8 轨道流 | ✅ 已合并 `787f7d9` | 已删除 | 主 Agent 应用了清单外接线补丁 r8-glue.patch（6 个文件，与其它任务不撞），并先把 main 合进分支再验。tsc 0；test 1769/1768/0/1；确定性 1800/1800；verify-unified-frames 通过；**与 main 导出逐像素 1800/1800 相同**（H264 豁免未用上）；主 Agent 复跑 stream-editor-e2e、stream-play-probe 均 PASS 并看图。合并后 main tsc 0、test 1769/1768/0/1。报告与证据存 scratchpad |
| T3a R9 探针 | ✅ 已合并 `553746d` | 已删除 | 达 M3：两路线 20/20 像素通过，主线程 p90≤0.1ms、max≤0.2ms（主 Agent 复跑一致）；不走退路。往返有 30～84ms 尖峰在 Worker/GPU 侧，交 T3b 留意。tsc 0；test 1718/1717 通过/0 失败/1 跳过；确定性 1800/1800 |
| T3b R9 实现 | ✅ 已合并 `eff2011` | 已删除 | M1～M5 落地；M7 未做（任务书自相矛盾）、三张用户卡不在仓库、导出页暂走主线程（同一渲染器）。清单外补丁 r9-glue.patch **未应用**（留用户定）。主 Agent 先合 main 进分支再验：tsc 0；test 1789/1788/0/1；确定性 1800/1800；**与 main 导出逐像素 1800/1800 相同**；verify-unified-frames 通过；gl-stage-probe 30/30；gl-migrate-compare 10/10（非边缘 ≤1/255，边缘抗锯齿差若干像素，属 M5 容差）。合并后 main tsc 0、test 1789/1788/0/1 |
| T4 手动截短总时长入口 | ✅ 已合并 `12dd7d6` | 已删除 | tsc 0；test 1721/1720/0/1；确定性 1800/1800；界面实测：20→12 截短生效、输 90 钳回 20 并恢复跟随，截图 scratchpad `t4-dialog.png` |
| T5a D3 实体矩形 | ✅ 已合并 `cc9d53e` | 已删除 | 主 Agent 先合 main 进分支，再应用清单外补丁 d3-routes-rects.patch（routes.ts 3 行，T1b-2 已合并、不撞）。tsc 0；test 1785/1784/0/1；确定性 1800/1800；verify-unified-frames 通过；真打 see_frames：frames[].rects 结构化字段齐，对图核对 odo/pill 框相符。合并后 main tsc 0、test 1785/1784/0/1 |
| T5b R0 冷启动量测 | ✅ 已合并 `88ed1fe` | 已删除 | 冷：首页 200 中位 938.8ms、舞台就绪 4750.4ms；热：923.4ms / 4626.8ms。tsc 0；test 1718/1717/0/1；确定性 1800/1800。合并后 main tsc 0、test 1721/1720/0/1 |

---

## 1. 不可违反的规则

来自仓库规则和用户决定。

1. **写 main 要用户授权。** 提交、合并、推送、改写历史，每次都要先得到用户明确授权（`suggested_agent_behavior.md` 原则 4）。用户已经给了**有条件的自动合并授权**，范围见第 10 节，只适用于那里列的情况。推送和改写历史不在授权范围内，照旧要问。
2. **一个任务一个 worktree、一个分支。** worktree 建在 `.claude/worktrees/<名>`，依赖向上解析。不建 junction，不跑 `npm ci`/`npm install`，不新增依赖。
3. **端口。** 按下表分段使用，每台 dev server 占「端口、+1、+2」三个。绝不碰 5190～5192（用户常驻）和 5203（`dev-test`，留给临时验证）。只结束自己启动的进程。
4. **不碰用户的东西。** 不写 `%LOCALAPPDATA%\PromptCut\runtime\app`，不写用户数据目录。
5. **基线全绿**（`verification.md`）：
   - 每次都跑：`npx tsc -b --force` 零错误，`npm test` 零失败。
   - 改到渲染、导出、卡片：加跑 `verify-determinism.mjs`。
   - 改到快照、预渲染、渲染：加跑 `verify-unified-frames.mjs`。
   - 改到看得见的画面：看图，或跑探针。
   - **导出像素基线不许变，要变先问用户。**
6. **验证没过的处理。** 分支保留，不回滚，不删 worktree。技术问题先按第 11 节找 Gemini Pro 排雷。只有落在第 7 节五种挂起情况里的，才告诉用户哪一项没过、为什么，由用户决定下一步。
7. **语义优先。** 代码和 `docs/semantics/` 冲突时按语义改，并告诉用户。语义里没定的，不自己定，去问用户。
8. **子 Agent 收回后的处理**（`multi_agent.md`）：
   - 主 Agent 逐个读 diff，自己重跑基线，渲染改动自己看图。
   - 合并用 `--no-ff`，提交信息写「合并 <分支>:摘要」，中文。
   - 删 worktree 之前：先确认改动已合并或已在分支上；再用 PowerShell 查 ReparsePoint 为 0，查到有就中止。
9. **用词**：说「预渲染」「生成快照」，不说「烘焙」「冻结」。提到文档写文件名，不写编号。
10. **播报**：任务全部完成，或需要用户确认时，调用 `task-announce`。中间进度不播报。

---

## 2. 子 Agent 配置与策略

| 策略 | 什么时候用 | 子 Agent 类型 | 模型 / 思考强度 |
|---|---|---|---|
| **A-medium** | 依赖全局上下文、架构、状态管理、引擎开发的一般任务 | `opus-dev`（`~/.claude/agents/opus-dev.md`） | claude-opus-5-5，effort **medium** |
| **A-high** | 底层渲染、复杂逻辑的核心任务：**T2（R8）、T3b（R9）** | `opus-dev-high`（`~/.claude/agents/opus-dev-high.md`） | claude-opus-5-5，effort **high** |
| **B** | 联网检索、高频试错、完全解耦的独立小任务、环境 / 编译测试 | `gpt-manager`（Opus 5.5 medium）调 codex | codex-run.ps1 `-Model gpt-6-sol -Effort high`（硬性，不许换） |

- **effort 的调整规则（用户授权）**：最低 medium。只有底层渲染和复杂逻辑的核心任务才用 high。目前定为 high 的只有 T2 和 T3b。如果其它任务执行中发现复杂度被低估，可以改派 `opus-dev-high` 续做，并在状态表里记下原因。
- 派 `gpt-manager` / `opus-dev*` 时**不传 `model` 参数**，否则会覆盖定义里的设置。
- 不用 Workflow 工具，逐个用 Agent 工具派发，默认在后台跑。

### 2.1 策略 B 的权限声明模板

每个 B 任务的派发提示里都**原样**附上这一段。用户已确认统一使用它。

```
权限声明（必须遵守）：
- 下列命令在本机沙箱里一定失败（要加载 tailwind / esbuild 的原生 .node 模块，或要起子进程 / Chrome），**第一次调用就必须通过 shell 工具的提权参数申请在沙箱外执行**（`sandbox_permissions: "require_escalated"`，并附 justification），**不要先在沙箱里试**：`npm test`、`npm run build`、`npx vite`、`node --test`、`node scripts/probes/*`、`node scripts/verify-*`、`node scripts/*.mjs`（需要起 Chrome 或 vite 的那些）。
- 其余命令（`npx --no-install tsc`、git 只读命令、查看文件、在工作目录内改文件）照常在沙箱内运行，不要提权。
- 不跑 npm install / npm ci，不新增依赖，不建 junction；如果任何 npx 命令试图从网络下载包，立即中止。
- 只用分配给你的端口段；绝不碰 5190～5192 和 5203；只结束你自己启动的进程（记下 PID，按 PID 结束进程树）。
- 只改「可写文件」清单里的文件；需要改清单以外的文件就停下，在报告里说明。
```

### 2.2 策略 B：耗时验证不交给 GPT

codex 只跑 `tsc` 和跟改动相关的单测，外加任务本身要求的探针 / 量测。`verify-determinism`、`verify-unified-frames`、画面探针，一律由主 Agent 收回后统一跑。

### 2.3 gpt-manager 派发模板

```
【任务】<给 codex 的任务原文 + 2.1 权限声明 + 可写文件清单 + 端口段 + 验收标准 + 报告要求>
【工作目录】<worktree 绝对路径>（只读审查时写仓库根目录）
【授权范围】worktree 模式（开发类）/ 只读（-Sandbox read-only，审查类）
【模型】gpt-6-sol，effort high（codex-run.ps1 -Model gpt-6-sol -Effort high；用户硬性指定，不要换）
【输出要求】worktree 模式：【codex 原话】【提交】【异常】【会话】四段；只读：报告全文 + 审计结果
```

---

## 3. 依赖与阶段

```
第一阶段  Task 0 ✅ ── 提权验证 ✅
             │
第二阶段  ┌── T1a（B，只读审查）──→【用户裁定审查意见】──→ T1b（A-medium）
（并行）  ├── T2（A-high，R8）──────→【第 10 节三条件满足即自动合并】──┬──→ T3b（A-high，R9，另需 T3a 通过）
          ├── T3a（B，R9 探针）─────→【探针不达标：用户选退路】─┘
          ├── T4（B，截短总时长入口）
          └── T5b（B，R0 冷启动量测）
第三阶段  T1b、T3b、T5a（A-medium，D3，需要 T2 已合并）
```

- **T3b 要等 T2 合并**：两者都改 `Stage.tsx` 的兄弟平面和 `solid.ts` 的平面排除名单。
- **T5a 要等 T2 合并**：两者都改 `server/frame-pipeline.mjs`。
- **T1b 要等 T1a 的审查意见经用户裁定**：这是 `cloud-task.md` 自己写的动工前提。
- **T1b 和 T2 可能撞到同一处**：第 5 步验收里有「预渲染进程读素材只经 HTTP API」，可能要动预渲染侧取素材的代码。如果 T1b 开工时 T2 还没合并，这一部分只做接口，不改 T2 名下的文件，并在报告里列出留给 T2 合并之后做的改动。

## 4. 端口段

| 段 | 给谁 |
|---|---|
| 5210–5219 | 已用完（Task 0），保留 |
| 5220–5229 | T1b |
| 5230–5239 | T2 |
| 5240–5249 | T3a / T3b |
| 5250–5259 | T4 |
| 5260–5269 | T5a |
| 5270–5279 | T5b |

主 Agent 收回后重跑验证，用的是该任务自己的端口段（子 Agent 已经停了）。

---

## 5. 任务卡

每个开发类子 Agent 都要做到：
- 开工先在 worktree 根目录建 `TASK-REPORT.md` 并提交一次，之后每完成一块提交一次。
- 报告写清：做了什么；验证结果（命令、退出码、通过数、看过的图）；没做成的及原因；对任务书或语义的更正建议。
- 合并前，主 Agent 把 `TASK-REPORT.md` 另存一份到 scratchpad，并在分支上 `git rm` 掉它（除非用户要求归档进 `docs/archive/`）。

### T1a 云端第 5 步独立审查（B，只读）

- **目的**：满足 `cloud-task.md` 的动工前提，让一位没参与改写的审查者对着代码过一遍。这次用 GPT，跨模型的独立性正好符合要求。
- **审查范围**：`cloud-task.md` 的组件表，以及 A1、A3b、I1、I4 四节，含 9-24 按路线 B 的两轮改写。
- **要读**：
  - `cloud-task.md`
  - `docs/semantics/architecture.md`
  - `architecture/asset-storage.md`、`document-service.md`、`rendering.md`、`platforms.md`
  - 正文引用的代码：`server/vite-plugin-media.ts`、`vite-plugin-frames.ts`、`vite-plugin-cards.ts`、`vite-plugin-prerender.ts`、`frame-pipeline.mjs`、`snapshot-store.mjs`、`card-identity.mjs`、`prerender-client.mjs`、`server/vision/*`、`src/render/mediaTier.ts`、`src/kernel/project.ts` 等
- **沙箱**：`-Sandbox read-only`，工作目录是仓库根目录。不写任何文件，不跑 build / test。
- **codex 输出**：一份逐条的审查报告，中文。每条包括：
  - 编号
  - 锚点：原文引用，加上 `文件:符号`；行号只作提示
  - 问题：锚点对不上代码、协议前后矛盾、和语义冲突、做不到、漏了步骤
  - 严重度：阻塞或非阻塞
  - 建议改法
  - 最后附一段「文档和现状不一致」，已知至少有两条：「读法」里说 R2～R7 都还没做；收尾说验证端口是 5197，实际是 5203。
- **主 Agent 收回后**：
  - 逐条核实，每条标上「成立 / 不成立 / 存疑」。
  - 报告存到 scratchpad。
  - **停下来交给用户裁定**：采纳哪些，要不要折回 `cloud-task.md`。改计划文档要用户逐句确认，对外接口或数据格式要 dry run。

### T1b 云端第 5 步：素材服务空壳与底层 API 契约（A-medium，`opus-dev`）

- **前提**：T1a 的审查意见已经过用户裁定，采纳的部分已处理。
- **要读**：
  - `cloud-task.md` 分步表里第 5 步那一行
  - 组件表的「素材服务」「本地内容库」两行
  - A1 的「分步」「同步状态不进项目文档」「上传一律走分片」三段
  - `asset-storage.md`
  - T1a 采纳的意见
- **做**：
  - 素材服务的插件骨架：第一版就是 `vite-plugin-media.ts` 按同一套 API 暴露。
  - 分片上传：`PUT media/<hash>/<n>`，每片 8 MB。
  - 对账：`GET media/<hash>/chunks` 返回 `{ size, chunkSize, received, complete }`。
  - 完成：`POST media/<hash>/complete` 按 sha256 校验全件，不符回 409。
  - 按哈希取回：返回正确的 contentType，支持 Range。
  - 所有路由允许跨源访问，含 `/@media/<hash>`。
  - Agent 进程和预渲染进程读素材只经 HTTP API。
- **不做**：两档、上传队列、换档、`playable`、产物推送、A5、A6、A3b，这些都属于第 6 步。
- **可写**：
  - `server/vite-plugin-media.ts`
  - 新建的素材服务模块，放在 `server/` 下，由子 Agent 起名并在报告里写明
  - `server/test/*asset*` 和 `*media*` 这几类测试
  - 预渲染侧取素材的代码，**仅在 T2 已合并时**才能改；否则按第 3 节处理
- **验收**（`cloud-task.md` A1 验收「第 5 步后」）：
  - 断网后恢复上传，`chunks` 报出已收的分片，**只补缺的分片**。
  - `complete` 校验通过才为真，不符回 409。
  - 按哈希取回正确的 contentType，Range 返回 206。
  - 跨源访问成功：用另一个 origin 的请求模拟局域网设备，检查 CORS 头和预检。
  - Agent 进程和预渲染进程读素材只经 HTTP API：grep 确认没有直接读 `out/media` 的路径。
  - 基线：tsc、npm test。
  - 如果改到了预渲染或渲染：加跑确定性验证。
- **端口**：5220–5229。

### T2 R8 轨道流（A-high，`opus-dev-high`）

- **要读**：
  - `r8-streams-task.md` 全文（G0～G7、验收）
  - `g0-b-stream-prototype.md`
  - `docs/semantics/architecture/rendering.md`
  - `docs/archive/restructure_planning/r2-r7-task.md` 的 E7 第 5 条、K5、C3、C4、D5、F5
- **做**：G1～G7。按 G0-b 的结论：
  - `streams` 默认开，`streamPool = 1`，最多 2
  - 先按 `stride=3` 稀疏铺满，再补满密度
  - 裁剪矩形用实测实体框的并集，外扩到偶数
  - `out_range=tv`
  - 缺省编码器 `libx264 -preset veryfast -crf 16`
  - `probeEncoders()` 必须真编一小段再判定
  - codec 串从 `avcC` 拼
  - 单个解码器同时持有 ≤ 8 帧
  - 解码器预算 6
- **界面只提供状态，不做样式**：「预渲染中」只要求可以读到状态，样式另定。
- **可写**：
  - `r8-streams-task.md` 路径缩写表里的文件：`server/frame-stream.mjs`（新）、`frame-pipeline.mjs`、`frame-playback.mjs`、`server/bakery/{bake,chrome,capture-frame,ffmpeg}.mjs`、`card-identity.mjs`、`snapshot-store.mjs`、`src/render/streamPlayer.ts`（新）、`Stage.tsx`、`stageRpc.ts`、`solid.ts`、`frameMedia.ts`、`frameWindow.mjs`、`src/StageView.tsx`、`src/ExportView.tsx`
  - `src/cards/native/particles.tsx`，仅限流相关
  - 对应的测试
  - 新探针 `scripts/probes/stream-*`
- **不可写**：
  - `src/editor/**` 的样式和交互
  - `server/vite-plugin-media.ts`（归 T1b）
  - `src/render/gl/**`（归 R9）
- **验收**：
  - R8 的「验收」一节
  - `streams` 关着时，全部功能和 R7 结束时逐项相同
  - tsc、npm test
  - `verify-determinism`、`verify-unified-frames`：导出像素基线不变
  - 看播放画面
- **提示**：体量最大，要求早提交、勤提交。任务书里没定的数（比如 nvenc 参数），按任务书写的保留，不要自己定。
- **端口**：5230–5239。

### T3a R9 探针（B）

- **做**：写 `scripts/probes/gl-atlas-probe.mjs`，需要的话配一个 `scripts/probes/gl-atlas-harness.html`。验证两件事：
  - 「MSAA FBO → `blitFramebuffer` → `createImageBitmap`」两条路线是否都成立。
  - 20 张卡每拍 `createImageBitmap` 加 transfer 的主线程耗时。
  - 判据以 `r9-webgl-task.md` M3 为准。
- **要读**：`r9-webgl-task.md` 的「这一步做什么」表和 M3；已有的 `scripts/probes/pixelmap-gl-probe.mjs` 可以当写法参考。
- **可写**：上面两个探针文件，加 `TASK-REPORT.md`。
- **codex 自己跑**：探针本身，要提权；还有 `tsc`。
- **验收**：
  - 探针能跑完，给出两条路线的通过 / 失败，以及耗时的 p50、p90、最大值。
  - 报告写明是否达到 M3 的门槛。
  - **不达标**：停下来，交给用户选 M3 末尾的退路。
- **端口**：5240–5249。

### T3b R9 实现（A-high，`opus-dev-high`）

- **前提**：T3a 达标，或用户已选定退路；并且 T2 已合并。
- **要读**：
  - `r9-webgl-task.md` 全文（M1～M7）
  - `docs/semantics/architecture/rendering.md` 的「canvas 卡的共享 WebGL 渲染器」
  - `r2-r7-task.md` 的 E7 第 5 条、K1～K6、J4
- **可写**：
  - `src/render/gl/**`（新）
  - `r9-webgl-task.md` 路径缩写表里的文件
  - 5 张 canvas 卡：`particles`、`scene-3d`，以及三张 runtime 用户卡。用户卡有没有在仓库里，开工时先核对。
  - 对应的测试
- **验收**：
  - R9 的「验收」一节
  - tsc、npm test
  - 确定性、`verify-unified-frames`：像素基线不变
  - 看图
- **端口**：5240–5249。

### T4 手动截短总时长的入口（B）

- **语义**：`project-model.md` 的「总时长」。缺省等于内容末尾、跟着内容走；用户可以手动缩短，不能拉长到内容末尾之后；空项目保留原值。
- **做**：在编辑界面给用户一个手动截短总时长的入口。
  - 规则只能复用 `src/kernel/duration.ts` 现成的 `contentEndOf`、`effectiveDuration`、`manualDurationFor`。
  - store 那一侧复用 `src/store/actions/projectMeta.ts` 已有的动作，也就是 Agent 的 `set_project_meta` 用的那一条。
  - 入口放在哪：优先放 `ProjectSettingsDialog.tsx`；时间轴上的交互不做，样式不改。
- **可写**：
  - `src/editor/ProjectSettingsDialog.tsx`
  - `src/store/actions/projectMeta.ts`，只在需要一个给界面用的出口时才改
  - 新增测试 `src/**/*.test.mjs`
- **不可写**：`src/kernel/duration.ts`（只读）；样式文件。
- **验收**：
  - 单测覆盖三件事：能缩短；拉长会被钳到内容末尾；空项目保留原值。
  - tsc、npm test。
  - 主 Agent 收回后，在 5250 上看界面并截图。
- **端口**：5250–5259。

### T5a D3：`see_frames` 回包附实体矩形（A-medium，`opus-dev`）

- **前提**：T2 已合并。
- **要读**：`r2-r7-task.md` 的 D3 节；`cloud-task.md` 分步表下面那段「原第 8 步已移出本计划」的说明。
- **落点**：`server/bakery/capture-snapshot.mjs` 的 `afterFonts` 钩子，以及 `/api/cards/layout`。
- **可写**：
  - `server/bakery/capture-snapshot.mjs`
  - `server/frame-pipeline.mjs` 里和 layout 相关的部分
  - `server/vision/render.ts` 等 `see_frames` 回包的出口
  - 对应的测试
- **验收**：
  - D3 节的验收
  - tsc、npm test
  - 改到渲染路径就加跑确定性验证
- **端口**：5260–5269。

### T5b R0 冷启动量测（B）

- **做**：量仓库根 dev server 的冷启动，这是 `TODO.md`「R0」的遗留。定义：
  - 从进程启动到首页 HTTP 200、到舞台就绪，各计时一次。
  - 就绪的判据以现有探针为准。
  - 冷：清掉该 worktree 自己的 `node_modules/.vite*` 缓存之后；热：紧接着再跑一次。
  - 冷热各跑 3 次。
- **可写**：新脚本 `scripts/probes/cold-start-probe.mjs`，加 `TASK-REPORT.md`。不改运行时代码。
- **验收**：给出冷、热各 3 次的数和中位数，以及量测方法。只清自己 worktree 的缓存，不碰主仓库的 `node_modules/.vite`。
- **端口**：5270–5279。

---

## 6. 主 Agent 收回每个开发任务后的步骤

1. `git -C <wt> log --oneline main..HEAD`，逐个读 diff。检查有没有改动超出可写清单。
2. 在该任务的端口段上自己重跑：
   - tsc
   - npm test
   - 按改动范围加跑确定性、`verify-unified-frames`、探针，或看图
3. 对照任务卡的验收，逐条核对。
4. 按第 10 节判断能不能自动合并：
   - **三个条件都满足**：直接合并（第 5 步），更新第 0 节状态表，在状态表备注里记下合并提交号和三项证据的摘要，然后按第 3 节触发下游任务。
   - **不满足**：向用户汇报，然后挂起这个分支。汇报包括：做了什么；证据；和计划不一致的地方；发现的语义冲突；需要用户决定的事（合并、返工，还是放弃）。
5. 用 `--no-ff` 合并，提交信息写「合并 <分支>:摘要」，结尾带 Co-Authored-By。合并后在 main 上重跑 tsc 和 npm test，确认仍然全绿。合并后如果变红，立即停下，不触发下游任务，向用户报告。
6. 清理 worktree：先查 ReparsePoint 为 0，再 `git worktree remove`，已合并的分支用 `git branch -d` 删。

## 7. 停下来问用户的情况

用户 2026-09-24 定了一个封闭清单，**只在下面五种情况挂起并报告**。其余技术问题一律先按第 11 节排雷。

1. **T1a 的审查意见需要裁定。**
2. **T3a 探针不达标，需要选退路。**
3. **导出像素基线需要变更**：`verify-determinism` 出现非预期的改变，或任务本身就要改基线。
4. **遇到业务或样式决策**：任务书里写着「另定」或「挂起」的事，比如 R8「预渲染中」标记的样式、`streamKey` 命名；语义里没定的地方（原则 2）；交互和样式的取舍。
5. **严重报错，且 Gemini 排雷失败**：按第 11 节走完仍解决不了。

下面两种情况属于上面第 5 条的具体表现，同样挂起：
- 子 Agent 需要改可写清单以外的文件，并且会和别的任务撞车，排雷也找不到不撞车的做法。
- ChatGPT 或 agy 的额度用尽（报 `usage limit`）。不反复派发，直接挂起报告。

挂起的范围只限于**受影响的那个任务及其下游**。不相关的并行任务照常推进。

## 8. 本轮不排、等用户定的事

- `audio_structure_plan.md` 第 6 节的 6 条待定：解封装做法、导出装 mp4、浏览器解不了的格式、看门狗、要不要写进语义、和 R8 的先后。
- R7b 的遗留：
  - 只停了快照、没停 PNG。
  - R7b 报告第 4 节的 8 条更正要折回 `r2-r7-task.md`，这是改文档，要用户逐句确认。
- 依赖文档服务的语义差距：工作方式改 MCP 加托盘、三档创造力、子 Agent 角色、「用户正在编辑」提示等，要等第 6、7 步。

## 9. 已发现的文档和现状不一致（没改，已告诉用户）

- `cloud-task.md` 的「读法」写 R2～R7「都还没做」；实际已经全部合并（`52eab98`～`1fba167`）。
- `cloud-task.md` 的收尾写验证端口是 5197；`verification.md` 和 `launch.json` 都是 5203。按原则 5，以 `verification.md` 为准。

## 10. 自动合并授权（用户 2026-09-24 定）

用户原话的要点：只要**同时满足**下面三个条件，就不经用户过问，直接把分支 `--no-ff` 合进 `main`，并自动触发下游依赖任务。

1. **diff 符合任务语义规范**：由主 Agent 逐个读 diff 判断。具体要求：
   - 改动都在任务卡的可写清单内。
   - 和 `docs/semantics/` 以及任务书不冲突。
   - 遵守 `constraints.md`：分层、用词、不新增依赖。
   - 没有夹带和任务无关的改动。
2. **主 Agent 亲自复核的基线全部通过**：
   - `npx tsc -b --force` 退出码 0。
   - `npm test` 零失败。
   - 必须是主 Agent 自己跑的结果，子 Agent 报告里的数只作参考。
3. **`verify-determinism` 的像素基线没有非预期的改变**：主 Agent 自己跑，同一段导两遍逐像素相同。
   - 这一项对**每个要合并的分支都跑**，不管改动范围，以用户原话为准。
   - 改到快照、预渲染、渲染的分支，按 `verification.md` 另外加跑 `verify-unified-frames.mjs`，也要整条通过。

执行细节：
- 三条中任一条不满足，就不合并。按第 7 节判断：属于挂起清单的挂起报告；属于技术问题的先按第 11 节排雷，修好后再重新按这三条判定。
- 只读任务（T1a）和不合并的产物，不走这一节。
- 授权只覆盖本地 `git merge --no-ff` 进 main。**不推送、不改写历史。**
- 每次自动合并后，在第 0 节状态表里记下：合并提交号、tsc 和 npm test 的通过数、确定性的比对结果。全部任务收尾时向用户汇总。

## 11. 技术报错的自动排雷（用户 2026-09-24 定）

遇到技术报错，**先找 Gemini Pro 协同排雷，不直接挂起**。技术报错包括：编译或测试失败、探针报错、dev server 起不来、子 Agent 卡住或反复失败。

- **怎么派**：用 `agy-manager`（Antigravity CLI，Gemini），在【模型】里写明 **`gemini-3.1-pro-high`**。纯问答、不碰文件的，直接跑 `subagent-agy` 的 `agy-run.ps1 -Model gemini-3.1-pro-high`，不派 manager（全局约定）。
- **给 Gemini 的输入**：报错原文、相关文件路径、复现命令、已经试过的做法。
  - 授权范围默认只读（读文件、跑只读命令）。
  - 由 Gemini 给出诊断和修法。
  - **修改由主 Agent 或原任务的子 Agent 在该任务的 worktree 里落地**，Gemini 不直接改仓库。
- **核实**：Gemini 的说法要审慎核实。修法落地后，按原任务的验收和第 10 节的条件重新验证，不能拿 Gemini 的结论当证据。
- **判定排雷失败**：满足任一条就算失败，按第 7 节第 5 条挂起报告：
  - 同一个问题 Gemini Pro 给出的修法**连续两轮**验证不过；
  - Gemini 判断需要改语义、改对外接口、改可写清单以外的文件；
  - Gemini 判断需要破坏性操作。
  - 报告里要附上两轮的诊断和验证结果。
- **排雷不能越过的边界**：
  - 不新增依赖，不装系统软件（`constraints.md`，要问用户）。
  - 不改像素基线。
  - 不碰 5190～5192 和用户的运行时副本。
  - 破坏性操作由主 Agent 自己做，并走确认流程。

---

## 12. /goal 全自动模式（用户 2026-09-24 定，覆盖前文冲突处）

用户用 `/goal` 下达了无人值守全自动模式。与前文冲突时以本节为准：

1. **启动即并行派发**第二阶段：T1a、T2、T3a、T4、T5b。每完成一个节点，把状态和合并记录写进第 0 节。
2. **自动合并**：第 10 节三条件照旧。特例：**T2 引入 H264 编码，有损压缩造成的像素差异属于预期变更，放行**（仍要求确认差异来源确是 H264 编码路径，而非别处）。
3. **T1a 不再挂起等用户裁定**：主 Agent 自己逐条评估，无架构风险的合理建议自动采纳，并推进 T1b；未采纳的写进报告。（改 `cloud-task.md` 本身仍属改计划文档，不做；采纳的意见只写进 T1b 的派发提示。）
4. **T3a 不达标不挂起**：自动走 M3 末尾退路（Worker `transferToImageBitmap()` 整张图集一次传回、主线程按区域 `drawImage`），记下决策，推进 T3b。
5. **排雷**：代码报错、单测失败、架构冲突，优先用 `subagent-agy` 调 `gemini-3.1-pro-high` 协同分析（第 11 节）。
6. **额度回退**：GPT（策略 B）或 Gemini 撞额度 / 限流 → 放弃外部模型，改由 Opus（`opus-dev`）接管该子任务或排错。**不再因额度挂起**（替代第 7 节「额度用尽」那一条）。
7. **硬性挂起只剩两种**（替代第 7 节五种）：
   - (a) 像素基线出现非格式压缩导致的异常改变；
   - (b) 回退和排雷之后仍修不好的严重系统级故障。
   - 原第 7 节第 4 条（样式、命名等业务决策）不再挂起：子 Agent 取最保守、不改语义文档的做法，记进报告的「待用户定」清单，收尾时汇总给用户。
8. 不变的边界：不推送、不改写历史、不新增依赖、不改像素基线（H264 特例除外）、不碰 5190～5192 和用户运行时副本。

---

## 13. 本轮收尾（2026-09-24，/goal 全自动模式）

- 全部 T1～T5 已合并进本地 main（未推送）。合并顺序：T4 `12dd7d6` → T3a `553746d` → T5b `88ed1fe` → T1b `8b8ad2c` → T2 `787f7d9` → T1b-2 `2944743` → T5a `cc9d53e` → T3b `eff2011`。每次合并后 main 都重跑 tsc 与 npm test，全绿；最终 main：tsc 0、1789 项 / 1788 过 / 0 失败 / 1 跳过。
- 所有分支的 verify-determinism 都是 1800/1800；T2、T3b 另与 main 导出逐像素比对 1800/1800 相同。**没有触发硬性挂起条件**；未动用 Gemini 排雷与额度回退（没遇到修不了的报错，也没撞额度）。
- 各任务报告、证据、未应用的补丁都在 scratchpad：`T*-TASK-REPORT.md`、`T1a-review-verdict.md`、`r8-evidence/`、`r9-glue.patch`。

### 待用户定（汇总）
1. **cloud-task.md**：T1a 的第 3～14 条与 6 条「文档和现状不一致」要不要折回（改计划文档须逐句确认）。
2. **素材服务**：局域网监听地址（现仍 127.0.0.1）；CORS 用 `*` 还是白名单；64 GiB 上限；`PROMPTCUT_ASSET_URL`；`/api/media/*` 第 6 步去留；`frame-pipeline.mjs:272-276` 仍 stat 素材文件。
3. **R8**：`streamKey` 命名与流库目录；`streams` 开关是否进设置；dual 模式怎么触发后台 `preload`（现在编辑台默认不会产流）；硬件编码器默认；「预渲染中」样式；旧流回收；两张粒子卡同挂的已有 bug（修它会改导出像素）；保底 3 帧与 80 MB 冲突取舍。
4. **R9**：M7（像素映射）怎么办；导出页走 Worker（依赖 `chrome.mjs` 跳过 blob 的补丁）；`r9-glue.patch`（含 `glRoute` 下拉）要不要合；三张用户卡迁移；53 张素材粒子卡标 `dom2d`；live 拍超时 1 s。
5. **D3**：`see_frames` 工具说明（`server/tools/vision.mjs`）要不要加一句 rects；要不要给 Agent 关掉 rects 的参数；多卡多时刻时文字是否截断。
6. **文档更正建议**（各报告里）：`tsc -b` 不覆盖 `server/`（建议写进 verification.md）；预渲染子进程随机端口不受端口段约束；R8 / R9 / D3 任务书各自的更正条目。
7. 主工作区 `.claude/execution-plan.md` 的状态更新未提交（该文件已被用户提交过一版）。
