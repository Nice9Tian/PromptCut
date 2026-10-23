# 交接：0.7.19 / 0.7.20 已发出，下一版（0.7.21）要带什么

接手先读本文，再读 `docs/plan/TODO.md`。开工指令是 `docs/plan/release-019-020-kickoff.md`，那一轮的结果写在 `docs/reports/REPORT-019-020.md`。

几个代号的白话：**〔裁〕**是执行中由会话自己定下、等用户合入前审的决定；**二级**是用户看得见的行为变化，**三级**是用户看不出区别的机制。

## 1. 现在的状态

| | |
|---|---|
| `main` | 见 `git log`；0.7.20 发版提交是 `0629bbc9adfacff2a0bff81cb185ea39fc2f97d8` |
| `release` | `0629bbc9`（0.7.20） |
| 应用 / 外壳版本 | 0.7.20 / 0.2.8 |
| 生产节点 `149.88.94.84` | 跑 0.7.20，健康检查 `version` 与 `codeVersion` 均为 `0.7.20`，五服务 active，`render.code-version match: true` |
| 官网下载 | 发 0.7.20（`https://visuhive.com/download/PromptCut-setup.exe`，473,453,478 字节） |
| VisuHive 账号后端 | 装在 `/opt/promptcut-v2/releases/vh-8dbce56/`，含撤回定序与 `overLimit` 上报 |

两版的安装包、补丁哈希与各项耗时在 `docs/reports/release-timings.md` 的 `## 0.7.19`、`## 0.7.20` 两节。

## 2. 下一版必须带的两件事

### 2.1 R01 返工（用户 2026-10-23 推翻了〔裁〕）

**用户原话**：「那条裁定我推翻，把 clip-path 那一行拿掉，R01 按做不通处理并返工。」

被推翻的是：给剪辑段的嵌套场景层挂 `clip-path: inset(0)`（`src/render/CutSegmentScene.tsx`），效果是段里的毛玻璃不再透过段去模糊段外面的层。它是 R01（毛玻璃带着下层产流）能做通的前提。

- **这条行为现在还在生产上**：它随 0.7.20 出包、部署、官网在发。用户决定**不单独发 0.7.21 撤它，随下一版一起发**。
- **返工已完成并合入 `main`**（合并提交见 `git log`，分支 `claude/revert-r01` 已删）。clip-path 与其注释拿掉；剪辑段里依赖下层的卡回到没有流、在嵌套场景里活渲；**R02 保住了**（拿掉 clip-path 后重跑端到端全过，读数与上一轮一致：剪辑段里的卡与精确活渲差 0.383/255、顶层 0.565/255）；浏览器给嵌套卡生成快照字偏约 4 像素的修复保留（独立缺陷）。
- **新增单测 CB-r01** 钉住「剪辑段里依赖下层的卡没有流、嵌套场景不挂 clip-path」，防这条被推翻的行为日后悄悄回来。
- **截图代码指纹不变**（`server/bakery/capture-below.mjs` 一字未改，主会话 diff 核过与 main 逐字相同）→ **下一版部署不会再触发全量重产**。代价：该文件里留着两小段走不到的代码与一句过时注释，等下次本来就要改截图代码时一并清掉（现在清要再重产一轮，不值）。0.7.20 在线上为剪辑段毛玻璃产过的那些流退回后没人引用，不必删。
- 主会话在合并结果上复跑：tsc 零错误；全量 7684 条、真失败 0（2 失败 + 1 取消经单跑复核 12 条 12 过）；两种构建通过；**与 `5f4523d0` 的全长导出逐字节相同 1800/1800**；导出确定性 Identical 1800 / Different 0；快照重放 PASS。
- 语义已标注：`product/rendering.md` 里用户 10-22 那句要求**保留不删**（仍是目标），但注明前半「毛玻璃带下层产流」2026-10-23 尝试后退回、目前做不到，要重做先得找到不改变段外模糊行为的办法；后半（在线浏览器替剪辑段重卡产流）已做到。

### 2.2 「速度」入口（已做完并验过，2026-10-23 交给发版的会话）

分支 **`claude/clip-speed`**（worktree `.worktrees/clip-speed`），已把 `main` 合进分支（合并提交 `7155f22c`，复核提交 `ccf8fa53`），**没推送、没合 main**。规格原文在 `docs/plan/three-versions-progress.md` 的「『速度』入口」一条。逐条的做法、证据与复核在 `docs/reports/AGENT-claude-clip-speed.md`（末尾「主会话复核」一节是主会话自己跑的）。

主会话自己跑出来的门槛：`tsc` 退出码 0、输出 0 字节；全量 `npm test` **7885 条、7869 过、真失败 0**（那 2 条单跑 13/13 全过，是负载抖动）；两种构建都 0；键比对 **57/57「全部相符」**；与开工提交 `5f4523d0` 的全长导出 **逐字节相同 1800/1800**。

- 当初担心的两处高风险都落地并有实证：
  - **预渲染身份键**——缺省 1 倍时不进键，`clip-speed-key-compare.mjs` 实测 57/57 逐字相同；只有 `speed !== 1` 才由 `withMediaRates` 给 `@clip/<id>/source` 加 `rate`。顺带踩实一条：变速声音的重采样一度写进了 `audio-mix.mjs`，键比对立刻掉到 **45/57**（它在 `frame-code.mjs` 的 `SNAPSHOT_FILES` 里），挪到 `mux-audio.mjs` 才回到 57/57。
  - **声音**——变速的视频段不出原声；可以音画分离，分出来的声音随倍率变调（用户 2026-10-23 定「可以分离，失真问题记待办」）。选变调不选保调的理由写在 `mechanism/project-model.md`。
- 「像素基线演示项目里没有变速段」这一条已照办：`clip-speed-key-compare.mjs` 另造了带变速段的项目，核的是变速段的取帧时刻（`vision@9` 从 `1.2` 变成 `2.2`）和混音清单（变速段的 `v-fx` 从清单里消失＝不出原声）；演示项目那边则用全长 1800 帧逐字节相同证明缺省 1 倍的路一步没动。
- **语义**：二级（`product/project-model.md`）与三级（`mechanism/project-model.md`）已由发版会话写进 `main`（`7e61bba8`），五条还没人审的〔裁〕登记成 `docs/plan/release-021-rulings.md` 的 V21-21～25。**一级（`workflow/editing.md`）仍然空着**——速度是一个新的用户操作，按规矩会话不许写，要先把「修改前／修改后」给用户过目。建议的措辞在报告「语义要改哪几句」第 3 条。
- **还没消掉的三条风险**（别替它圆场）：① 子 Agent 自曝前两轮混音实证走的是同一条路（探针用 `data:` 地址，Chrome 混音退回了 ffmpeg），这一轮才真的两条路都走到；② 「首帧取到素材第 0 帧」的竞态在开工提交上 4 遍没复现、当前代码 7 遍复现 1 次，按**未排除**交出；③ **在线浏览器导出的变速声音一次没测过**，已记进 `TODO.md`。
- 界面探针 `clip-speed-ui-probe.mjs` 主会话自己跑 **13/14**，唯一不过的 P5 已定位为探针回 seek 的节奏问题（取样时播放头在 7.5 秒，而被测段 2 倍后只占 `[0,3)`），不是产品缺陷；要稳下来改探针。

## 3. 发版与部署的做法（这一轮踩实了的）

### 版本号
`git_and_release.md`「版本号」表第一行：只动 Node 那一半 → 应用版本末位 +1、外壳不动，老用户走更新补丁。两版都是这样（外壳一直是 0.2.8）。先查 `git diff --stat <上一发版提交>..HEAD -- desktop/src-tauri/src/ desktop/src-tauri/Cargo.toml desktop/src-tauri/tauri.conf.json`，无输出才能按第一行办。

### 出包
在 **`desktop/` 目录**下跑 `npm run release -- --from-head`（仓库根**没有** `release` 脚本）。`--from-head` 自己在 `desktop/.cache/release-src` 建临时 worktree 取 HEAD 源码，所以出包自带隔离。约 750～870 秒。

### 锁提交
用户 2026-10-23 定：**不冻结别的分支，出包前锁一次提交即可**。但这一轮发现**锁定与构建之间仍有窗口**——0.7.20 就被另一个会话的纯文档提交插队，包其实按 `0629bbc9` 构建而不是我锁的 `4c7dec7a`。
**改进做法**：在构建脚本开头核对 `git rev-parse HEAD` 等于锁定值，不等就停。若仍发生插队，**按实际构建的提交记发版号**，不要记原本锁的那个。

### 部署
照 `/root/pc-claude-0720-0629bbc9/deploy-0720.sh`（由 0.7.19 那份改来，`local.md` 里有完整历史）。要点：

1. 先核服务实际跑在哪棵树、六个任务槽全 inactive，否则停手；
2. **先换在线前端，再重启渲染服务**（反了会报 `render.code-mismatch`）；
3. 服务端文件两棵树都换：文档服务树 `/opt/promptcut-v2/releases/35f7b2ab/pc`、渲染树 `/opt/promptcut-render/releases/35f7b2abb9db`；
4. **本版移除的文件两棵树都要删**（`rsync` 不删提交里已删的文件）；
5. 整份 `src/` 进渲染树并清残留；
6. **`package.json` 也要换**（0.7.19 那次漏了，线上代码新了版本号还是旧的——脚本里已补上这一步）；
7. 解包与 rsync 之后 `find … -perm /022 -exec chmod go-w {} +`，否则 `promptcut-agent-root` 报 `root-code-untrusted` 起不来；
8. 重启顺序：文档服务（+ rotate）→ agent → agent-root → render；
9. 核：五服务 active、`127.0.0.1:8791/healthz` 的 `version` 与 `codeVersion` 正确、`render.code-version match: true`。

**跨仓库的硬顺序**（带撤回功能的版本必须守）：**先装 VisuHive 账号后端 → 再上 PromptCut 文档服务 → 最后推 VisuHive `site/`**。反了的话，改密退出时真有要撤的修改就撤不掉，续办器不登记结束见证，网页 45 秒后显示「退出没有确认完成」。

### 安装包放官网（用户 2026-10-23 定，每次发版都做）
步骤在 `docs/local.md`「发版后把安装包放一份到官网服务器」。要点：先传成以点开头的临时名 → 两边 `sha256` 比对一致 → 改名 + `ln -sfn PromptCut-setup.exe` → `curl -sI` 核 200 与 `Content-Length`。**不要放进 `/var/www/landing/`**（那里每 5 分钟带 `--delete` 同步）。旧版本留最近两三个。

## 4. 验收的取舍（照做可省十几小时）

- 整套本地清单有 259 项，但开工指令要的是「**归这一版的每一行都有结论**」。按 `v19` 标记筛出归本版的项（0.7.19 是 92 项，覆盖它的 50 条要求）即可，其余记「未跑」并写明理由。「失败」「未跑」本来就是允许的结论。
- 跑之前先过 `node scripts/acceptance/four-stage-acceptance.mjs --check-coverage`（五项守门）。新加的探针要登记进清单或写明排除原因，否则这一关不过。
- 判断某条失败是不是本版引入的，**最快的办法是在合并前的提交上跑同一支探针做对照**。这一轮有两条就是这么定性的（`RR-stage-gate`、`P-claim-gate` 在 `efd24aec` 上同一断言同样失败）。其余看清单项的 `known` 字段，里面常有「某年某月在 main 上实跑不过」的现成记录。
- 31 项 `[在节点上做]` 的远端项多是人工流程。试过 S3-r3（`c10-browser-probe --site https://visuhive.com`）：跑不动，要带鉴权的协调口（`PUT c10b.latest` 回 401）和已登录账号把项目放云端。要做得先备那套配置。

## 5. 这一轮查出、没修的（都已进 `docs/plan/TODO.md`）

都经实测确认**不是 0.7.19／0.7.20 引入的**：

- 舞台闸门判安卓只看 `userAgentData.platform`，非安全来源下那条「不到 8 GB 不往上试」的保护静默失效（生产走 HTTPS 不受影响；安卓模拟器实测：`http://10.0.2.2` 下两个属性都不存在，经 `adb reverse` 走 `localhost` 后报 `deviceMemory:4`、`platform:"Android"`）。
- 舞台端口白名单拦掉正当的 `/@media/<hash>`。
- 渲染队列「plan 切分完、细任务全部落定」等不到（`claim-gate`、`S3-1`、`c10-browser-full` 的 A5 同一族）。
- 长 id 数组的批量增删是平方级（`json-ops.mjs`，16000 片段上撤 16000 处要 11.7 秒；页面提交走同一条路）。
- `authority.mjs` 的 `verify` 里 `refs` 无上限增长（更早查出，仍在表上）。

## 6. 还欠用户的

- **真机核对清单**：iPhone/iPad Safari 的崩溃重载行为、真安卓的进程隔离、窄屏上气泡位置、真手机的解码上限。无头和模拟器核不了，需要真设备。
- **安装包冒烟、补丁演练**：用户 2026-10-22 定记待办、不挡发版。
- **在线浏览器那一块的 15 条〔裁〕**（三级 10、二级 5）已在对话里逐条交过，也写进 `docs/archive/agent-reports/AGENT-claude-online-browser.md`，用户尚未逐条表态。
- **撤回那块的 6 条语义待定**（「N 处」怎么数、私有任务在区间里的修改撤不撤、要不要单独的撤回进度显示等），在 `docs/archive/agent-reports/AGENT-claude-logout-rollback.md` 第六节。

## 7. 做法备忘（这一轮栽过的坑，别重蹈）

- **退出码 0 不等于跑完**。全量测试两次出现退出码 0 但日志只有几十 KB、没有汇总行的假通过。判据取 `ℹ tests N` 汇总行与日志大小。
- **Windows 路径分隔符**：账号测试的两个环境变量必须用**反斜杠**；凡是拿命令行传进来的路径去和 `path.join`／`path.normalize` 的结果比字符串，两边都要先过 `path.resolve`。详见 `docs/local.md`。
- **多会话共用这个仓库**：别用 `git add -A`，按路径显式暂存；清理 worktree 前先单独确认没有 `node_modules` 目录联接（这一步不许和删除串在一条命令里）；批量杀进程前先看命令行，用户自己的 Chrome 和装好的 PromptCut 运行时副本混在里面。
- **守门测试会扫到构建产物**：`desktop/src-tauri/runtime/`、`target/` 是 gitignore 的产物，跑过一次发版构建再跑全量会误红。已修，但遇到类似现象先想这一条。
- **放宽任何守门之后要做反证**：故意制造一次违规，确认它还抓得到，再提交。
- **二级〔裁〕里会改变用户可见画面的那类，合并前单独等用户一句话**。这一轮按「先合、可事后推翻」处理，结果让一个用户不认可的行为进了生产，返工代价比等一句话大得多。
