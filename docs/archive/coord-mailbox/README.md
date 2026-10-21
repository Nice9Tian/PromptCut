# 旧信箱与阿里云协调口（2026-10-21 归档）

## 是什么

- 2026-09-26 起，主会话和云端工作节点之间的指令经阿里云 `8.219.80.16` 上的 HTTP 信箱收发：入口 `https://8-219-80-16.sslip.io/coord`，服务器上的进程叫 `probe-coord`，代码是 `scripts/probes/probe-coord.mjs`。云端工作节点只能经它联系。
- 2026-10-04 前后，在分支 `claude/peaceful-meitner-ef78de` 上做了信箱第二版：服务端核对发件人身份、按会话寻址、发送去重、记下处理状态。它没有合入，也没有部署。

## 为什么归档

- 阿里云那台已经到期注销（2026-10-21 用户告知）。旧信箱和那台机器上的转发都随之停用，云端工作节点也就联系不上了。
- 会话之间的信箱已经另起，是独立仓库 `DevAgent_mailbox`（dev-agents-mailbox），部署在新节点的 `/mailbox` 下。第二版的设计不再沿用。
- 用户原话：「阿里云已经到期注销，可以直接撤文档。清理（归档）关于信箱重构的过期内容。」记录见 `docs/plan/user-decisions-2026-10-21.md`。

## 本目录

| 文件 | 原来在哪 |
|---|---|
| `cloud-worker.md` | `docs/auto_long_work/cloud.md`：云端工作节点的会话提示词 |
| `mailbox-v2-identity.md` | 分支 `claude/peaceful-meitner-ef78de` 上的 `docs/plan/coord-mailbox-identity.md`：信箱第二版的设计，逐字节照抄 |

分支 `claude/peaceful-meitner-ef78de` 的头是 `31d763a4`。除了上面那份设计，它还有 `scripts/probes/probe-coord-v2.mjs`、`server/test/probe-coord-v2.test.mjs`，并改了 `scripts/probes/probe-coord.mjs`、`server/test/bakery-deps.test.mjs`，一共 5 个文件。2026-10-21 在这个提交上打了标签 `archive/coord-mailbox-v2`（已推到 GitHub），然后删掉远端分支。要看代码就 `git checkout archive/coord-mailbox-v2`。

## 还留在仓库里的

- 旧信箱的代码 `scripts/probes/probe-coord.mjs` 和测试 `server/test/probe-coord-mail.test.mjs`，以及几支探针里写死的阿里云地址（只在历史验收里用）。要不要删另定：动代码要在 worktree 里做、过基线。
- `server/auth/hosted-default.mjs` 的 `RETIRED_HOSTED_HOSTS` 里的阿里云地址**要留着**。旧项目文件、恢复凭证里存的还是阿里云地址，打开时靠这张表换成新节点（`docs/semantics/mechanism/hosting.md`）。
- 已经做完的计划和报告（`Master-Execution-Plan.md`、`m8-plan.md`、各份 `HANDOFF-*`、`REPORT-*`）里写到阿里云和旧信箱的地方是当时的记录，原样保留。
