# 任务：在生产节点上把云端 Agent 的「运行素材」部署起来

2026-10-18 写（Claude 主会话）。交给 Antigravity 的 Argon 新会话做。

## 0. 一句话

云端 Agent 的任务进程凭这条任务自己的授权读写项目素材库，这一块叫「运行素材」（run assets）。代码在 0.7.18 里都有，**生产节点上一直没开**。所以云端 Agent 现在：不能 `import_media`（把附件、网址装进素材库），不能用 `see_frames({ source: "media" })` 看素材库里的图和视频，配音、音效、卡片配音这类往素材库写文件的工具，以及感知、一键流程、网页操作这一批工具提供者都没建起来。本任务把它在节点上开起来、验通。

## 1. 背景

### 1.1 现在线上是什么样（2026-10-18 01:30 JST 左右，以 `docs/local.md`「新节点 0.7.18 正式部署与清理记录」为准，**开工先重读一遍那一节的最新记录**）

- 节点 `root@149.88.94.84`，连法见 `docs/local.md`「新云节点」（带密钥、`BatchMode=yes`、`ConnectTimeout`；后台命令必须自己会结束）。
- 服务实际跑的目录（17:00 UTC 起，由 `gemini/cloud-agent-stuck-slot` 那次部署切过去）：
  - 文档服务 `promptcut-doc-v2`：`/opt/promptcut-v2/releases/35f7b2ab/pc`
  - Agent 主服务 `promptcut-agent`、root 调度 `promptcut-agent-root`、6 个任务槽 `promptcut-agent-task-slot-a..f`：`/opt/promptcut-render/releases/35f7b2abb9db`
  - 素材服务 `promptcut-asset-v2`：**自己核**（它可能还在旧目录）。
  - 在线编辑器 `/opt/promptcut-hosted/editor`：main `fb472090` 构建。
  - 之后 17:21 UTC 主会话又就地换了 `35f7b2ab` 两个目录里的 4 个文件（附件发送时进素材库，见 `docs/local.md`）。
  - **换任何文件之前，先 `systemctl show <单元> -p ExecStart` 看它实际跑的是哪个目录**；10-17 主会话就踩过「换进了已经不用的旧目录」。
- 环境文件：`/etc/promptcut-account-v2/promptcut-doc-v2.env`、`promptcut-asset-v2.env`；root 调度配置 `/etc/promptcut/agent-root/agent-root.json`；每槽设置 `/etc/promptcut/agent-slots/<槽>/worker-settings.json`（root 每开一代写，不手写）。
- 现状核实过的事实：
  - 文档服务环境里**没有** `PROMPTCUT_DOC_RUN_ASSETS_ENABLED` 这一组；素材服务环境里**没有** `PROMPTCUT_ASSET_RUN_ENABLED` 这一组；节点上**没有**素材一侧的 root 登记目录；root 配置的 `worker` 里**没有** `runAssets`。
  - 现在 `import_media` / `see_frames(source: media)` 回 `run-assets-unconfigured`（main `fb472090` 起明说、不重试）。
  - 页面一侧的上传（左侧「导入媒体」、云端对话附件发送时进素材库）走的是成员自己的素材票据，**和运行素材无关**，已经能用；本任务不能把它弄坏。

### 1.2 要读的

- `docs/plan/four-stage-deploy-checklist.md`：搜「运行素材」「可选：看画面与运行素材」「环境变量名（不写值）」——两侧开关和变量的全名单、「账号版安装计划不生成这些变量，也不初始化素材一侧的 root 登记目录……待部署时核对」这句。
- `server/hosted/deploy/README.md`「工具要的节点依赖」一节（`worker.runAssets` 与 `worker.tools`）。
- 文档服务一侧：`server/hosted/main.mjs` 读 `PROMPTCUT_DOC_RUN_ASSET_*` 那段（约 215～245 行）、`server/hosted/combo.mjs` 里 `runAssets` / `mountRunAssets` / `createRunAssetPrivateClient`、`server/hosted/run-assets-current-registry-v2.mjs`。
- 素材服务一侧：`server/hosted/asset-main.mjs` 读 `PROMPTCUT_ASSET_RUN_*` / `PROMPTCUT_ASSET_ROOT_*` 那段。
- 素材 root 登记：`server/hosted/deploy/asset-root-registry-publisher.mjs`（外部 root 监督，文件头写了失败时留锁、要显式恢复）、`server/hosted/asset-root-registry-schema-v2.mjs`。
- 任务进程一侧：`server/agent-service/account-task-worker-config.mjs` 文件头（`runAssets` 的形状）、`server/agent-service/account-root-main.mjs`。
- 以前的报告：`docs/reports/AGENT-codex-018-run-assets-current-v2.md`、`AGENT-codex-018-run-assets-current.md`、`AGENT-codex-018-cloud-project-assets.md`、`AGENT-v18-assets.md`。
- 探针：`scripts/probes/asset-root-cgroup-os-probe.mjs`、`scripts/probes/account-tools-perms-linux.mjs`（期望末行 `PASS 26/26`，Linux 上以 root 跑）。
- 语义：`docs/semantics/product/asset-service.md`、`docs/semantics/mechanism/asset-service.md`、`docs/semantics/workflow/materials.md`（10-18 刚改了附件那一条）。

## 2. 要做到什么（验收）

1. 两侧开关、登记目录、`worker.runAssets` 都配好，服务起得来、`/healthz` 正常，`account-tools-perms-linux.mjs` 末行 `PASS 26/26`。
2. 真实云端对话里逐项验通，每一项把证据（工具回包、日志、账本或素材库里那一条）直接贴在对话里：
   - `import_media`：一个对话附件（`work:attachments/…`）、一个 http(s) 图片地址，都进素材库；
   - `see_frames({ source: "media", mediaId })` 能看到素材库里的一张图；
   - 往素材库写文件的工具至少一个（配音 `voice_generate` 或音效，取节点上配得起来的那个）写成功；
   - 回归：页面「导入媒体」、云端对话附件发送时进素材库、不带附件的普通消息，都照常。
3. 用户在项目 `sp_4lcukykm2blylc5lok7za46yu3` 里重发那条「户型图 60 秒一镜到底」的请求时，Agent 能看到户型图（这一条不由你发消息，做完请用户发、你看结果）。
4. `docs/local.md` 那一节补上这次部署的记录（改了哪些文件、变量名（不写值）、登记目录、备份在哪、怎么回退）。

## 3. 边界与约束

- **同一时间只有一个会话往节点上部署。** 开工前看 `docs/local.md` 最新记录和节点上最近改过的文件（`find /opt/promptcut-* /etc/promptcut* -newermt '-2 hours'`），有别人正在部署就停下问用户。10-17 两个会话同时部署，把 Agent 服务弄挂过一分钟。
- **有任务在跑时不重启任何服务**（重启 root 或主服务会把在跑的任务记成失败）。先核账本里没有 `currentRunId`、队列里没有 `queued/preparing/running`。
- 改之前一律备份：环境文件、`/etc/promptcut/` 整份、要换的代码文件；写清回退步骤。最低限度的回退是两侧开关写回不开、root 配置去掉 `runAssets`、重启。
- 素材 root 登记的发布器失败时会**留着锁**等人恢复（看它的文件头），不要删锁硬来；卡住了照解法表走，做不到就停下报告。
- uid、cgroup 路径、单元名、指纹这些值在节点上实测得出，不要猜；指纹从证书算，不抄文档里的示例。
- 只在应用层动，不改宿主机网络（防火墙、路由、代理、网卡）。
- 不碰账本里的业务数据；要改账本先问用户。
- 代码要改的话：在 worktree（`.worktrees/<名>`、分支 `gemini/<名>`）里改，基于最新 main，过基线（`npx tsc -b --force` 零错误、`npm test` 零失败；跑之前设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`，值在 `docs/local.md`）再合入 main；部署到节点时**基于服务实际在跑的那个目录**，不要把 main 上别的会话还没部署的改动夹带上去（10-17 主会话的做法：节点现有版本 + 只套自己的差异）。
- 规矩照 `AGENTS.md` → `docs/semantics/developer_guide.md` 和 `guide_files/`。会让用户看到不同的改动（比如工具的说法、提示）按二级语义办：先给用户看「修改前 / 修改后」。

## 4. 要停下问用户的情况

- 发现有别的会话正在往节点上部署；
- 需要新增费用、换机型、或需要人在机器旁做的物理操作（按 `constraints.md`「新增费用要绕，不停」先找不花钱的路，绕不过记待用户项）；
- 要删数据、改账本、改宿主机网络；
- 素材 root 登记卡在留锁状态、解法表扫空。

## 5. 汇报

报告写 `docs/reports/AGENT-<分支名或任务名>.md`：做了什么（节点上每一步的命令要点和结果）、验收第 2 节每一项的证据、没做成的和原因、回退步骤、需要用户拍板的事（白话、带背景、编号、给选项和建议）。
