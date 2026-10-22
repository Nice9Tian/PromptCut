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
- 返工在分支 **`claude/revert-r01`**（worktree `.worktrees/revert-r01`）。要求：拿掉 clip-path；R01 按「做不通」退回，不要留画面对不上的半成品；R02（在线浏览器替剪辑段重卡产流）尽量保住，但要实测验证它不依赖 clip-path；顺带修的那个真缺陷（浏览器给嵌套卡生成快照没带继承样式、字偏约 4 像素，`src/render/snapshot/inlineStyles.ts`）**保留**，那是独立 bug 修复。
- **接手必看**：`server/bakery/capture-below.mjs` 当初进了截图代码指纹，0.7.20 上线时所有轨道流已全部重产过一轮。这次退回**很可能让指纹再变一次、再重产一轮**。合并前确认返工报告里写了指纹变不变，据此安排部署窗口。

### 2.2 「速度」入口（前置项，至今未合）

分支 **`claude/clip-speed`**（worktree `.worktrees/clip-speed`）。规格在 `docs/plan/three-versions-progress.md` 的「『速度』入口」一条，**以那里的原文为准**。

- 用户定过：**做完不先进 `main`，等用户审过〔裁〕再合**。所以接手时它大概率还躺在分支上，不要直接合。
- 两处高风险：**预渲染身份键**——缺省 1 时必须不进键（否则线上已有快照全失效、要全部重产），只有 `speed !== 1` 才计入；**声音**——〔裁〕已定「第一版变速段原声自动静音并在界面写明」，不做保调变速（浏览器离线混音没有保调变速、ffmpeg 有 `atempo`，两边不一致会破坏「导出与预览一致」）。
- 像素基线演示项目里没有变速段，全量比对测不到这个新功能，必须另造一个带变速段的项目做逐帧比对。

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
