> 2026-09-28 PC 主会话派子智能体起草（分支 `claude/m7-report`，从 M7 集成分支 `claude/rq-m7` 的 `88e70e3` 拉出）。数字从各 AGENT 报告抄，每处注明出处；主会话交来的事实注明「主会话记录」；最终提交 `88e70e3` 上的 G0 / G0-R 与笔记本 M7-T1c 两处还空着，格式是【待填：等什么】。

# M7 阶段报告：纯浏览器节点

契约 `docs/plan/m7-contract.md`（第 1 版发给用户但不等；第 13 节是主会话裁定与 D18 的语义 dry run，节末「探针之后的更正」十条）。

用到的代号（第一次出现时的白话说明）：

- **M7**：主执行计划 `docs/plan/Master-Execution-Plan.md` 第 7 节的「纯浏览器节点」阶段——在线浏览器模式（普通档）的页面在闲时用后台舞台为本人认领到的快照任务逐帧生成快照，推到素材服务，与桌面节点、独立渲染主机共用同一条任务队列。
- **D1～D18**：契约第 11 节的十八个待定点，第 13 节逐条裁定（都标〔裁〕）。**P1～P6**：契约第 8 节的可行性探针问题。
- **M7-A1～A12**：契约第 10 节的十二条验收；**W7**：同一节里的跨机验收（主执行计划第 6.5 节）。
- **E5**：「纯浏览器节点只见本人任务」；**B2**：「纯浏览器只认领 light / medium 共享档快照」（`docs/plan/TASK-distributed-prerender-queue.md` 与 `docs/plan/distributed-prerender-queue.md` 的编号）。**L1**：`docs/plan/cloud-task.md` L 节「后台 iframe 当预渲染者、30 秒内出锚帧」那一条，并入 M7-A4。
- **K1～K11**：测试分支 `server/test/m7-kit.mjs` 文件头写的、对实现接口形状的假设；**A-1～A-9**：验收探针适配处 `scripts/probes/m7-node-adapter.mjs` 对页面诊断形状的假设。
- **层表 v3**：渲染节点写在内容库的 `layers:<项目 id>`，每层多一组 `candidates`（切分实际出键的各个环境指纹各一份），页面按「哪份活着」整层认定一份（D12）。
- **双份出键（dual）**：切分方对浏览器能做的卡按自己的指纹和浏览器的指纹各出一份细任务，先认领者得卡，建锁时作废另一份（`superseded`）（D1）。
- **锁闲置接手**：卡片级指纹锁的锁定方 30 秒没有新产出、这张卡又没做完时，下一次切分的节点用自己的指纹带 `takeover` 接手整张卡（D2）。
- **G0**：通用门槛（类型检查、全量测试、两种构建）；**G0-R**：改到渲染、预渲染、导出时加跑的回归（`docs/semantics/guide_files/verification.md`；主执行计划第 8 节）。`pc-g0r-base` 是 PC 上导出像素基线的目录名。
- **M7-T1、M7-T1b、M7-T1c**（主会话编号）：笔记本（性能基准机）上 M7 带耗时门槛各项的第一、二、三轮复核。
- **run `m7w0928e`**：W7 真跨机那一轮的轮号（经阿里云协调口 KV 对接）；`m7w0928a`、`m7w0928b`、`m7wlocal1` 是它之前的外网试跑。
- **HT-b**：文档服务的 HTTP 长轮询传输（`docs/plan/TODO.md`、`docs/plan/http-transport-contract.md` 第 2 版的 HTTP 部分），HT-a 之后推迟未做。
- **L22**：M8 执行计划 `docs/plan/m8-plan.md`（下称「M8 计划」）第 5 节「要在 M8 之内修的遗留」里「C10a 新的小尺寸到手机变慢」那一条。

## 0. 过程

- 契约第 1 版由 PC 主会话定稿（起草是主会话派的只读调查子 Agent），第 13 节逐条裁定 D1～D18，发给用户不等；C10 合入 main 之后开工。
- 先派可行性探针 `claude/m7-probe`（起点 `24c2c57`，报告 `docs/archive/agent-reports/AGENT-m7-probe.md`）答 P1～P6；要改产品代码的实验放在 `claude/m7-probe-exp`（不合并）。主会话据探针的更正建议写「探针之后的更正」十条（契约第 13 节末）。
- 实现三个分支并行：`claude/rq-m7-tests`（照契约独立写测试）、`claude/rq-m7-queue`（队列与切分方、凭证、层表写入）、`claude/rq-m7-node`（页面节点、舞台生成快照、小尺寸、上传与清单）；另派验收探针 `claude/m7-accept-probe`。
- 验收探针在本机、笔记本、外网各跑几轮，查出 A5 / A6 让路、A10 锁接手、D1 合并补 dual、切分候选落盘、锚帧段优先五处缺陷（第 4 节），都在各自分支修好再并进来。
- 集成分支 `claude/rq-m7` 在 `313b27c` 合 main `3ab63cf`（主会话记录），之后合进锚帧段优先、探针修正与 D1 新判据，到 `88e70e3`。
- W7 真跨机由 PC（用户 A）与笔记本 Chrome（成员 B）经阿里云跑完（第 7.1 节）；云端 Linux 节点当成员 B 那条路因出站代理不支持 WebSocket 升级走不通（第 7.2 节）。

## 1. 分支与合入顺序

| 分支 | Agent | 起点 | 内容 | 报告 |
|---|---|---|---|---|
| `claude/m7-probe` | `opus-dev` | `24c2c57` | 可行性探针 P1～P6，四个探针脚本 | `docs/archive/agent-reports/AGENT-m7-probe.md`（从 `claude/m7-probe` `26ea790` 取来归档；该分支的探针脚本没并进集成分支，见第 12 节） |
| `claude/m7-probe-exp` | 同上 | `24c2c57` | 实验提交 `8b15dfe`、`66fa49c`、`1d2abc7`、`ef4b45b`、`87d3461`、`1058b4c`，不合并 | 同上「做了什么」 |
| `claude/rq-m7-tests` | `opus-dev` | `24c2c57` | 契约测试 47 条（K1～K11），不看实现 | `docs/archive/agent-reports/AGENT-rq-m7-tests.md` |
| `claude/rq-m7-queue` | `opus-dev-high` | `24c2c57` | D1、D2、D4、D9、D10、D11 的一半、D12、D14；第二、三轮修 A10、D1、锚帧段优先 | `docs/archive/agent-reports/AGENT-rq-m7-queue.md` |
| `claude/rq-m7-node` | `opus-dev-high` | `24c2c57` | 页面节点、宿主、舞台 `bakeFrame`、小尺寸、上传器、层表 v3 页面侧、探针之后的更正；A5 / A6 让路修复 | `docs/archive/agent-reports/AGENT-rq-m7-node.md` |
| `claude/m7-accept-probe` | 子智能体 `opus-dev` | `claude/rq-m7-queue` `fdbeb60` | 验收探针 `m7-browser-probe.mjs`（本机、局域网、外网三种模式）、适配处、判定纯函数 `m7-judge.mjs` | `docs/archive/agent-reports/AGENT-m7-accept-probe.md` |
| `claude/join-error` | 子智能体 `opus-dev` | — | 加入项目「连不上」错报成「密码错」的修复，新增 `shared/verify`〔裁〕 | 分支上的 `docs/reports/AGENT-join-error.md`；**未合入，待用户审**（主会话记录） |

合入关系（主会话记录，提交号逐个核过存在）：`claude/rq-m7-tests` → `claude/rq-m7-queue`（`434441e` 合 tests `8f18461`）→ `claude/rq-m7-node`（合过 queue `f8c2879` 与验收探针）；验收探针分支合过 node `9774eda` 与 main `8f92683`；queue 分支 `dc04362` 合验收探针 `56b829b`、`d47365b` 合 node 的让路修复。集成分支 `claude/rq-m7` 的 first-parent（`git log --first-parent 3ab63cf..claude/rq-m7`，旧到新）：

1. `d92fd13` … `fdbeb60`：`rq-m7-queue` 第一轮（D1、D2、D9、D10、D14、D11、D12、规则 7、`task-runner.mjs`、`auth-contract.md`）。
2. `dc04362` 合验收探针 `56b829b`（带页面节点与 main `8f92683`）→ `7ced6ab` 复现 A10 → `119d42a` 修 A10 → `d047ff2` 修 D1 合并补 dual → `d47365b` 合 node 的让路修复（`7329780`）→ `11bbe53` 切分候选落盘 → `a0d751b` 补 dual 后重发 `task.opened` → `24062b3` 报告。
3. `313b27c`：合 main `3ab63cf`（带上 C10、编码提速、粒子卡、放本机素材服务修复与 M8 探针）。
4. `68f9a8a`：合 `rq-m7-queue` 的锚帧段优先（`fdbf19f`，`render-queue-contract.md` B.3〔裁〕）。
5. `4047133`：合验收探针（外网模式、`--role all` 转发 `--base-port` 与 `--timing-authoritative`、D1 判据「每段恰好一份有效」、成员进不了项目时记 WebSocket 实情、收尾删自己的项目）。
6. `88e70e3`：合验收探针（D1-D2-D12 按出键分组判，判定抽成纯函数 `m7-judge.mjs` 加单测，`ca49299`）。

还没合入 main。

## 2. 各分支做了什么（摘要，证据在各自报告）

- **m7-probe**（`AGENT-m7-probe.md`）：
  - P6：页面静态引 `session.mjs` 时在线构建不失败（摇树），但开发服务器整页白屏；要改两处 import（`session.mjs`、`filter.mjs`），不是契约写的一处。
  - P1：跨源 + OAC 下所有运行父页长任务 0；逐帧顺推比 4 帧一批从头推快 4～7 倍（`probe-slow-stepped` 顺推 60 帧 2.9～3.2 s）；Lottie 每帧约 0.77 s、每帧 570～660 KB，超 300 KB 上限。
  - P2：DOM 独立卡的字节差逐条能解释、像素相同（在线构建压缩 CSS、`will-change`）；画布卡顺推不等价；必须加就绪闸；在线构建缺 `/catalog/`，Lottie 空白。
  - P3：`foreignObject` 出小尺寸不污染画布，但必须把全局样式表一并放进去；带上后内置卡预乘差 > 16 的像素 ≤ 0.88%。
  - P4：60 块 + 60 小尺寸上传主文档长任务 0；查出同一哈希并发推送会撞（`400 incomplete`），上传器要按哈希单飞。
  - P5：页面转隐藏时放回与 `visibilitychange` 同一任务发出；隐藏超过约 5 分钟后续约间隔拉到 60 s；页面被浏览器挂起（Chrome 的 frozen 生命周期状态）再恢复时 Chrome 立即关掉 WebSocket，要当一次重连。
  - 耗时数字全在忙机上测，只报数。
- **rq-m7-tests**（`AGENT-rq-m7-tests.md`）：47 条（现跑 7 条守回归、门后 39 条、todo 1 条）；参考实现自检 46 过、1 todo，30 个变异全判红。本分支基线（门关）tests 3610、pass 3568、skipped 41、todo 1。
- **rq-m7-queue**（`AGENT-rq-m7-queue.md`「做了什么」与第二、三轮）：
  - D1 双份出键：浏览器指纹由队列在计划的 `task.claimed` 里给出（此刻在线、同一用户、watch 着本项目的浏览器节点的指纹）；建锁时作废另一份（`superseded`，不加 attempts），作废的任务可重发。
  - D2：card-locked 的回包带 `lockIdleMs`、`lockedByProfile`、`lockUndone`，闲置从最后一次产出算；切分方 `idleLockTakeover` 严格超 30 s 且没做完才接手。
  - D9 / D10 / D14：render 票据 `owner: { kind: 'browser' }`，只能以 browser 报到、nodeId 绑 userId；指纹由队列模块按页面报的原始值算、`node.welcome` 回给页面；非 Chromium 回 `not-chromium`。
  - D12 层表 v3（候选、切分完成后写一次）；D11 一半（两处 import、同构 `task-runner.mjs`）；节点侧规则 7。
  - 第二轮修 A10、D1 合并补 dual、D12 切分候选落盘；第三轮修 `pickCandidate`（锚帧段优先）。
  - 基线：第二轮后 tests 3752 / pass 3750 / skipped 2；第三轮后 3753 / 3751 / 0 / 2。
- **rq-m7-node**（`AGENT-rq-m7-node.md`「做了什么」）：
  - 页面节点 `src/online/browserNode.ts`（资格、编排、D6 用任务的 `projectRev`、D8 让路）与宿主 `src/editor/browserNodeHost.ts`（每 250 ms 判资格、render 连接与票据、闲的判据、让路来源、父页推送）。
  - 舞台 `bakeFrame` RPC（逐帧顺推、就绪闸 20 s、每帧回包超时 120 s）；小尺寸 `src/render/bakeSmall.ts`（带全局样式表的 `foreignObject`）；单飞队列第四种活 `bake`。
  - 上传器 `src/online/snapUploader.ts`（按哈希单飞、`incomplete` 重查）；清单计划等节点报到最多 3 s；层表 v3 候选认定（页面侧）。
  - `isolatedCardProject` 挪进 `src/kernel/isolatedCard.mjs`；在线构建关 CSS 压缩与 Tailwind 构建期优化；守门测试 `src/pageNodeImports.test.mjs`；只在测试里开的「只切分」开关 `PROMPTCUT_TEST_PLAN_ONLY`。
  - 终验（`bb18234`）：tsc 0；npm test 3663 / 3661 / 0 / 2；页面节点 10 条门全开全过；端到端 run5 `"ok":true`。
  - 补：A5 / A6 让路修复（`7329780`）。
- **m7-accept-probe**（`AGENT-m7-accept-probe.md`）：取证尽量不靠页面诊断（CDP 抓 WebSocket、进程内 `describe()`、替身节点）；本机、局域网、外网（`--site`）三种模式；查出 A6 play-yield、A10、D1 三条，分别交页面与队列分支修；D1 判据先改成「每段恰好一份有效」、再改成按出键分组（`m7-judge.mjs`）。

## 3. G0 与 G0-R

### G0

| 提交 | tsc | npm test（总 / 过 / 败 / 跳过） | 构建 | 出处 |
|---|---|---|---|---|
| `313b27c`（集成分支合 main） | 退出码 0 | 3754 / 3752 / 0 / 2 | `npm run build` 与在线构建（`vite build --mode online`）都通过；代码版本 `ddf69b5e…` | 主会话记录 |
| `88e70e3`（最终集成；合入提交只多探针脚本与文档） | 退出码 0 | 3758 / 3756 / 0 / 2 | 合入前在 `4540315`（= `88e70e3` + 可行性探针脚本 + 本报告）上 `npm run build` 与在线构建都通过 | 主会话记录 |

跳过的 2 条是 main 原有、显式开启的两条（`/api/cards/layout` 集成、SKILL 闸门集成）。M7 的门（契约测试 39 条）在合进页面节点分支后全部打开（`AGENT-rq-m7-queue.md` 第二轮基线、`AGENT-rq-m7-node.md` 终验）。

### G0-R

| 项 | `313b27c`（主会话记录） | `88e70e3` |
|---|---|---|
| `verify-determinism` | 1800 / 1800 相同 | 1800 / 1800 相同 |
| 与 `pc-g0r-base` 逐像素 | 1800 相同 | 1800 相同，不同 0、缺 0、多 0 |
| `verify-unified-frames` | PASS | PASS |
| `ready-index-probe` | fails [] | fails [] |
| `stream-produce-probe --group` | PASS | PASS |
| `preview-fallback-probe` 兜底透明拍 | 0（beats 290 / 277） | 0（beats 278 / 274） |

- 分支上的旁证：`rq-m7-node` 在 `isolatedCardProject` 挪动之后跑 `verify-determinism` 1800 / 1800 相同、两遍与 `pc-g0r-base` 都 1800 / 1800 / 0（`AGENT-rq-m7-node.md` 验证第 7 条）；`rq-m7-queue` 跑 `ready-index-probe` fails []、`stream-produce-probe --group` PASS（`AGENT-rq-m7-queue.md`「探针」）。
- `313b27c` 之后并入的只有锚帧段优先（队列选段）、探针修正与判定纯函数，不碰桌面导出路径。

## 4. 集成中查出的缺陷与修法

| # | 提交 | 问题 | 修法 | 出处 |
|---|---|---|---|---|
| 1 | `7329780`（node），合入 `d47365b` | **A5 / A6 让路不及时**：播放、拖动时后台活的门关了，正在做的那一帧挡在舞台里，节点按 D8 等「当前帧做完」，于是既不出帧也不放回，停下后约 5.2 s 才放回 | 让路之后当前帧 1 s（`YIELD_FRAME_MAX_MS`）内做不完就像页面隐藏那样中止、立即放回〔裁〕；单测 4 条，修前 3 条失败 | `AGENT-rq-m7-node.md`「补：A5 / A6 让路修复」；`AGENT-m7-accept-probe.md` 第二段 |
| 2 | `7ced6ab`、`119d42a` | **A10 锁不接手**：切分方从本机锁库已知锁在浏览器指纹上时照锁出键，发布合并进离线用户的任务、不被拒，收不到闲置信息，永远不接手 | 队列对指纹不同的切分节点照锁发布的回包也带 `lockIdleMs / lockedByProfile / lockUndone`；`local-node` 对这类回包照 D2 判接手；单测 M7Q-A10c～f 修前失败 | `AGENT-rq-m7-queue.md` 第二轮 |
| 3 | `d047ff2`、`a0d751b` | **D1 合并不补 dual**：页面报到前那一版只出 pc 单份，下一版按双份发来时 pc 那份合并进已有任务、没有 dual，浏览器先认领后它不被作废 | 合并时补上 dual（换新对象，还 open 就重发 `task.opened`）；锁已在别的指纹上时当场作废 | 同上 |
| 4 | `11bbe53` | **切分候选只在内存**：pc 重启后写的层表只剩 pc 一个候选 | 落盘到库根 `split-candidates.json` | 同上 |
| 5 | `fdbf19f`，合入 `68f9a8a` | **锚帧段优先级被冲淡**：`pickCandidate` 在排序后的前 4 个里随机挑，锚帧段（优先级 50）与普通段（10）混在一起；笔记本 M7-T1 的 A4 85.3 s 挂在这（与 M8 计划 L22 同一件事） | 只在排头那一档、同一整数名次里随机挑；`render-queue-contract.md` B.3 第 2 步〔裁〕；单测 M7Q-PICK-1 修前失败 | `AGENT-rq-m7-queue.md` 第三轮；主会话记录 |
| 6 | `9810ea4`、`775b177`（探针） | 探针 `--role all` 没把 `--base-port`、`--timing-authoritative` 转给子角色，笔记本那轮计时判不出 | 转发 | 主会话记录；`AGENT-m7-accept-probe.md` 第四段 |
| 7 | `ca49299`（探针），合入 `88e70e3` | D1-D2-D12 旧判据在笔记本挂：h1、h3 页面忙时锁闲置 > 30 s 被 pc 按 D2 接手、重新出键，0-59 两个出键下各一份有效 | 判据按出键分组：得卡那一组每段恰好一份有效，另一组整份作废；中途被 D2 接手只作说明；判定抽成纯函数加单测 | 主会话记录 |
| 8 | `claude/join-error` `23ccfee`（未合入） | 加入项目时连接根本没建成就断（如出站代理挡了 WebSocket 升级），页面一律报成「用户名或密码不对」 | 新增服务端接口 `shared/verify`〔裁〕，`enterShared` 打开前就断时拿新证明问一次再报；**待用户审** | 主会话记录；`AGENT-m7-accept-probe.md` 第四段 |

## 5. 验收 M7-A1～A12

本机环境：托管组合 + 三个源的仿 nginx 前缀代理（OAC、两个跨源舞台）+ 在线构建 + A 的桌面编辑器当 pc 节点（开 `PROMPTCUT_TEST_PLAN_ONLY` 只切分）+ 无头 Chromium 当成员 B（`AGENT-m7-accept-probe.md`「做了什么」）。笔记本各轮由主会话跑（主会话记录）。

| 编号 | 本机（run13，集成前的验收探针分支；`AGENT-m7-accept-probe.md` 第三段） | 笔记本 M7-T1b（`4047133`，计时按判定；主会话记录） | 备注 |
|---|---|---|---|
| A1 E5 分发 | 过 | 过 | W7 外网也过 |
| A2 E5 认领 | 过 | 过 | 同上 |
| A3 B2 | 过 | 过 | W7：页面侧过，服务端那条外网模式看不到 |
| A4 30 秒锚帧 | 计时 pending（PC 参考值 124.8 s，很忙）；其余四条过 | **过**：page-within-30s 26.8 s（锚帧段顺序 h3 11.2 s → h1 19.1 s → h2 26.8 s） | M7-T1（`9810ea4`）挂在 85.3 s，根因见第 4 节第 5 条；W7 经公网 63.0 s，只作观察（第 7.1 节） |
| A5 拖动让路 | 计时 pending；其余过 | **过**：626 ms | — |
| A6 播放、隐藏、更急的活 | 过 | 过 | 第 4 节第 1 条修后 |
| A7 低内存档与单舞台不当节点 | 过 | 过 | — |
| A8 产物互通 | 过 | 过 | — |
| A9 小尺寸 | 过 | 过（主会话单列） | — |
| A10 共存与接手 | 过 | 过 | 第 4 节第 2～4 条修后 |
| A11 凭证 | 过 | 过 | W7 外网看不到其中两条 |
| A12 主文档长任务 | 计时 pending（参考值 0） | **过**：长任务 0 | — |
| D9、D10、D14 | 过 | 过 | — |
| D1-D2-D12 | 按新判据三张卡都是 pc 那份整份作废、两个候选都在 | 旧判据挂 → 判据改按出键分组（第 4 节第 7 条） | 新判据的笔记本一轮见下行 |
| 最终一轮 M7-T1c（`88e70e3`，主会话记录） | — | 第 2 次跑（run `muku8rvfd6f7`）fails []，16 项全过，只 W7/cross-machine 待（本机替身；真跨机见 7.1 的 `m7w0928e`）；A4 27.6 s（锚帧段 h1 11.9 s → h2 19.8 s → h3 27.6 s，没夹别的段）、A5 695 ms、A12 长任务 0；D1-D2-D12 新判据过（h1、h3 中途被 D2 接手，只作说明）；bakeMs p50 117 / p95 162。第 1 次跑 3.5 分钟时页面导航 180 s 超时（暂时性故障），退避 60 s 重跑 | 笔记本回执 M7-T1c |

- 本机 run12 的三条 fail 与原因在 `AGENT-m7-accept-probe.md` 第二段；run13 原始结果行在第三段。
- M7-A4 的夹具由「3 张重 Motion 卡」改述为「3 张实测为重的独立内置卡」〔裁〕：Motion 卡在快机器上判轻、不产任务（`AGENT-m7-accept-probe.md`「发现的缺口」第 5 条）；验收用 `probe-slow-stepped`。
- 在线构建与桌面的快照比对（`AGENT-rq-m7-node.md` 验证第 6 条）：ticker、slow 60/60 逐字节相同；pill 46/60 相同、其余 14 帧只差 `will-change`、像素相同；小尺寸与桌面 CDP 小位图 ticker 0、slow ≈ 0.05%、pill ≤ 0.88%。

## 6. 〔裁〕清单（供用户审）

本集成分支上共 **30 条**：契约第 13 节 D1～D18 共 18 条（第 1～18 行），之后 12 条（第 19～30 行）。另有 `claude/join-error` 的 1 条不在本分支（第 31 行，不计入 30）。契约第 13 节末「探针之后的更正」十条也都标〔裁〕，其中第 4 条单列为第 26、27 行，其余九条照契约那张表，不另列。

| # | 出处 | 定了什么 | 依据 |
|---|---|---|---|
| 1 | 契约第 13 节 D1 | 切分方对浏览器可做的卡按两种指纹各出一份，先认领者得卡、建锁时作废另一份 | 计划级；语义不改 |
| 2 | D2 | 回包带 `lockIdleMs` / `lockedByProfile`，闲置超 30 s 切分方带 `takeover` 重发；续约也刷新 `touchedAt` | 三级；30 s 是三级数字 |
| 3 | D3 | 后台舞台加生成快照工作项 | 探针 P2 过 |
| 4 | D4 | 只收独立卡 | 比二级「只认领……快照任务」更窄，属节点自选 |
| 5 | D5 | 浏览器用 `foreignObject` 出小尺寸 WebP | 探针 P3 量化差别（第 5 节末条） |
| 6 | D6 | 用任务的 `projectRev`，取不到就放回 | 计划级 |
| 7 | D7 | 父页推送 | P1、P4 父页无长任务 |
| 8 | D8 | 当前帧做完就放回；页面隐藏时不等当前帧 | 二级「手里那一批做完为止」照做，细则三级 |
| 9 | D9 | render 票据带 `owner: { kind: 'browser' }`，队列模块固定 profile、nodeId 绑 userId | `auth-contract.md` 第 5、6、8 节加一种归属 |
| 10 | D10 | 页面报原始值，队列模块算指纹、`node.welcome` 回给页面 | 归一规则只有一处；写进三级语义（第 10 节） |
| 11 | D11 | `session.mjs` 改 import；细任务编排抽成同构模块 | 工程；探针 P6 查出还要改 `filter.mjs` |
| 12 | D12 | 层表 v3 带候选，切分完成后写一次 | 数据格式 v2 → v3，读旧 v2 当一个候选 |
| 13 | D13 | 同键任务归属维持 `source.userId`（用户定过的 Q2） | 本阶段不改 |
| 14 | D14 | 一期只在 Chromium 内核的浏览器上当节点 | 三级；写进三级语义（第 10 节）；服务端也挡 |
| 15 | D15 | 30 秒从加载遮罩撤下起算；测试开关 `PROMPTCUT_TEST_PLAN_ONLY` 让 pc 只切分 | 带耗时门槛，笔记本判 |
| 16 | D16 | 开发构建不当节点，本机验收一律用在线构建 | 计划级 |
| 17 | D17 | W7：PC 当用户 A、笔记本 Chrome 当成员 B | 云端已归档 |
| 18 | D18 | 两句三级语义（第 10 节） | 契约第 13 节 dry run |
| 19 | 主会话记录（`ca49299`） | D1-D2-D12 判据按出键分组，中途被 D2 接手只作说明 | 第 4 节第 7 条 |
| 20 | `render-queue-contract.md` B.3（`fdbf19f`） | `pickCandidate` 只在最高一档同一名次里随机 | 第 4 节第 5 条 |
| 21 | 契约第 10 节 M7-A4、第 13 节 D15 | M7-A4 夹具改述为「3 张实测为重的独立内置卡」 | 第 5 节 |
| 22 | `AGENT-rq-m7-queue.md`「与契约的出入」第 1 条 | 浏览器指纹以文档服务上本项目在线的 browser 节点所报为准，切分方不读页面自报的 `input.browser` | 页面自报的不可信；页面改为先报到、watch 再发计划 |
| 23 | 同上第 2 条 | 锁闲置从最后一次产出算，不按 `touchedAt` | 按 `touchedAt` 算，切分方每次照锁重发都会把闲置归零 |
| 24 | 同上第 3 条 | 回包多带 `lockUndone`，锁定方已做完的卡不接手 | 否则 PC 每来一版计划都把浏览器做完的卡整张重渲 |
| 25 | 同上第 4 条 | 被作废（`superseded`）的任务可重新发布 | 否则 D2 接手时十分钟 TTL 内发不进 |
| 26 | 契约「探针之后的更正」第 4 条 | 在线构建关 CSS 压缩（`cssMinify: false`）与 Tailwind 插件构建期优化（`optimize: false`） | 否则浏览器产的每帧字节都与桌面不同（同指纹不同字节） |
| 27 | 同上 | 不去掉快照里的 `will-change`（pill 14 / 60 帧只差它，像素相同） | 去掉会换 `snapshotCode`、现有快照键一次性失效 |
| 28 | `7329780` | 让路后当前帧 1 s 内做不完就中止、立即放回 | 第 4 节第 1 条 |
| 29 | `AGENT-rq-m7-node.md`「与契约不一致之处」第 2 条 | D8 细则：全段帧已齐、只剩收尾时来了播放 / 拖动 / 更急的活，照常完成不放回；隐藏仍立即放回 | 三级 |
| 30 | 主会话指派（`fda8036`） | `isolatedCardProject` 挪到 `src/kernel/isolatedCard.mjs`，桌面改调它、行为不变 | 队列分支出入第 8 条没做，主会话改派页面分支；G0-R 旁证 1800 相同 |
| 31 | `claude/join-error` `23ccfee`（**不在本分支，未合入**） | 新增服务端接口 `shared/verify`，区分「连不上」与「密码错」 | 第 4 节第 8 条；待用户审 |

## 7. 跨机：W7 与云端

### 7.1 W7 真跨机（run `m7w0928e`；主会话记录）

- 布置：PC 当用户 A 连阿里云；笔记本 Chrome 当成员 B 连阿里云；阿里云部署的是 `4047133` 的构建。
- 结果：W7 `cross-machine` 过；M7-A1、A2、A5～A10、A12、D9、D10、D14 过；A3 页面侧过，服务端那条外网模式看不到（本机那轮已验）；A11 两条外网看不到（服务端日志与 `describe()`、服务端结束会话；本机已验）。
- A4 经公网 63.0 s：家里上行到阿里云慢，加上页面忙时被 pc 按 D2 接手。A4 的计时按契约以笔记本本机那轮（M7-T1b，26.8 s）为准，这条记为经公网的观察。
- 层表 h1、h2 指向 pc 指纹、`ready 0`：测试开关让 pc 只切分不渲染，被接手的那份没人做；产品里 pc 不开这个开关，不会发生。

### 7.2 云端不能当纯浏览器节点（主会话记录）

- 云端的出站代理对 Chromium 做 TLS 中间人，中间人路径不支持 WebSocket 升级（握手 404）；Node 走 CONNECT 隧道不受影响（所以云端当独立渲染主机能跑）。
- 云端拒绝关 TLS 校验（这是对的）；改为导入代理根证书，仍连不上 WebSocket。
- 结论：只能经这类代理出网的浏览器，要靠 HTTP 长轮询传输（HT-b）才能加入项目、当节点。这是 HT-b 的现实依据。
- 同一现象在页面上被错报成「用户名或密码不对」，由第 4 节第 8 条修（未合入）。

### 7.3 待跨机复核项

| 项 | 状态 |
|---|---|
| W7（契约第 10 节） | 过（7.1） |
| M7-A4 等计时项（笔记本） | M7-T1b 过；M7-T1c 过（A4 27.6 s） |
| E5 放云端（M8 计划第 2.1 节） | 归 M8 |

## 8. 顾问调用记录

- 本阶段没有调 codex 或 Gemini。核过：五份 AGENT 报告（`AGENT-m7-probe.md`、`AGENT-rq-m7-tests.md`、`AGENT-rq-m7-queue.md`、`AGENT-rq-m7-node.md`、`AGENT-m7-accept-probe.md`）与契约全文里都没有 codex、Gemini、agy 的调用记录；契约由主会话派的只读调查子 Agent 起草。
- 第 10 节两处三级语义是定计划时在契约第 13 节做的 dry run（「修改前 / 修改后」），不是执行中卡住后的改动，所以没有走「codex 与 Gemini 各出一轮」的穷尽步骤。
- 第 6 节第 20 行（B.3）改的是计划契约，不是语义。

## 9. 待用户项

- 审〔裁〕：契约第 13 节 D1～D18 与「探针之后的更正」，本报告第 6 节 30 条；尤其第 22～25 行（队列侧与契约原文不同的四处）、第 20 行（B.3）、第 27 行（`will-change` 留着）。
- 审 `claude/join-error`（新增服务端接口 `shared/verify`〔裁〕），决定合不合。
- 阿里云上残留三个探针项目 `m7ap-m7w0928a`、`m7ap-m7w0928b`、`m7ap-m7wlocal1`：口令只在当时的进程内存里，要在阿里云上按名删（`AGENT-m7-accept-probe.md` 第四段）。

## 10. 语义改动（D18，三级，〔裁〕）

按契约第 13 节 D18 的 dry run 写进，按原文措辞最小插入，都标〔裁〕注明出处：

1. `docs/semantics/mechanism/rendering.md`「舞台」：
   - 原文：「**后台舞台**：负责测量卡片成本，以及为只能靠全局时钟推进的卡整场景补跑，补跑完与可见舞台互换。」
   - 新文：「**后台舞台**：负责测量卡片成本，以及为只能靠全局时钟推进的卡整场景补跑，补跑完与可见舞台互换。在线浏览器模式（普通档）下，它还在闲时为认领到的快照任务逐帧生成快照〔裁：M7 纯浏览器节点加的一句，出处 `docs/plan/m7-contract.md` 第 13 节 D18 的 dry run（三级）〕。」
2. `docs/semantics/mechanism/platforms.md`「渲染节点」，在现有一条之后加一条：
   - 原文：（无）
   - 新文：「纯浏览器节点的环境指纹由文档服务按页面报来的原始值算，页面不自己算；一期只在 Chromium 内核的浏览器上当节点〔裁：M7 纯浏览器节点新加的一条，出处 `docs/plan/m7-contract.md` 第 13 节 D18 的 dry run（三级）〕。」

实现与这两句一致（`AGENT-rq-m7-queue.md`「需要主会话定的事」第 4 条、`AGENT-rq-m7-node.md`「与契约不一致之处」第 8 条）。

## 11. 遗留（去向：M8 维护或另立）

| 遗留 | 出处 | 去向 |
|---|---|---|
| 页面只是忙也会被 D2 接手，已做的帧白费（锁闲置只看产出，不看页面是在忙还是走了） | 主会话记录；W7 与 M7-T1b 的 D1 一项 | M8 维护或另立 |
| 执行器不标 `snapshotOversize`，切分只按卡种（Lottie、画布卡）挡浏览器 | `AGENT-rq-m7-node.md`「没做成的」第 3 条 | M8 维护或另立 |
| 阿里云上残留三个探针项目 | 第 9 节 | 用户或主会话按名删 |
| 探针的 `PC_CHROME_ARGS` 只透传参数，别用来关 TLS 校验 | 主会话记录 | 探针用法说明 |
| `will-change` 的字节差（第 6 节第 27 行） | `AGENT-rq-m7-node.md`「没做成的」第 1 条 | 下一次动快照代码时一起定 |
| 舞台互换时生成快照跟着后台位置走，没有专门的互换剧本验 | 同上第 4 条 | M8 维护 |
| 纯浏览器经只支持 CONNECT 的代理出网 | 第 7.2 节 | HT-b |
| `claude/join-error` 未合入 | 第 4 节第 8 条 | 待用户审 |

## 12. 报告归档

本分支挪进 `docs/archive/agent-reports/` 的（`git mv`）：`AGENT-rq-m7-queue.md`、`AGENT-rq-m7-node.md`、`AGENT-rq-m7-tests.md`、`AGENT-m7-accept-probe.md`。`AGENT-m7-probe.md` 不在集成分支上，从 `claude/m7-probe` `26ea790` 原样取来放进同一目录。

- `docs/plan/m7-contract.md` 第 13 节末两处引用随改到新路径。
- 仍写着旧路径 `docs/reports/AGENT-…` 的地方（本分支只写文档，没改）：`server/test/m7-kit.mjs` 文件头注释；各归档报告正文里互相引用的旧路径（历史原文，不改）。
- `claude/m7-probe` 的四个探针脚本（`m7-build-probe.mjs`、`m7-bake-probe.mjs`、`m7-upload-probe.mjs`、`m7-visibility-probe.mjs`）没并进集成分支；集成分支上有页面节点版 `m7-bake-node-probe.mjs`。要不要并进由主会话定。
- 没挪的：`docs/reports/AGENT-join-error.md` 在 `claude/join-error` 上，随它合入时再归档。

## 13. 占位清单

- 第 3 节：`88e70e3` 的 G0 与 G0-R 已补（主会话记录）。
- 第 5 节、第 7.3 节：笔记本 M7-T1c 已补（主会话记录）。
