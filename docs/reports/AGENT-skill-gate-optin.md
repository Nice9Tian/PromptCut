# AGENT 报告：skill-gate 测试改为显式开启

分支 `claude/skill-gate-optin`，从 main `c1ac3ca` 开出。只改了 `server/test/skill-gate.test.mjs` 和本报告。

## 问题

`server/test/skill-gate.test.mjs` 原来的地址是 `process.env.PROMPTCUT_BASE || "http://127.0.0.1:5190"`。用户常驻的编辑器（5190）开着时，`npm test` 会对它发写请求：`/api/skill-mode/close|open`、`/api/skill-lock/acquire|release`，也就是关掉、打开用户编辑器的 SKILL 模式，占用它的独占锁。另外它还会直接改写、删除 `~/Documents/PromptCut-Skill/skill-state.json`（`PROMPTCUT_SKILL_DIR` 的缺省值），这是用户的数据目录。

## 做了什么

- 整份改成一条 `node:test` 用例，靠 `skip` 选项开关，不再用 `process.exit`，跳过时计入 skipped：
  - 不设 `PROMPTCUT_BASE`：跳过，原因写的是「对真实 dev server 跑的集成测试，设 PROMPTCUT_BASE 指向一台自己起的 dev server 才跑；永不缺省连 5190」。
  - `PROMPTCUT_BASE` 的端口是 5190～5192：跳过，并写明原因。
  - `PROMPTCUT_BASE` 不是合法 URL：跳过。
  - **超出任务书的一处**：不设 `PROMPTCUT_SKILL_DIR`，或者它指向用户的 `~/Documents/PromptCut-Skill`，也跳过。原因：测试会直接改写、删除这个目录里的 `skill-state.json`，而且 dev server 也要带同一个值才测得通。只设 `PROMPTCUT_BASE` 还是会写用户数据，所以一并拦下。
  - 显式开启了却连不上：判失败，不再静默跳过。
- 文件头注释改成上面这套规则和 PowerShell 跑法。
- 去掉了「第一个命令行参数是仓库根」的旧用法，闸门模块只按本文件的位置解析。`node --test` 不会传这个参数，而且 `--test` 自己的参数可能被误当成路径。

提交：`200d55a`（报告开头）、`a45cc89`（测试改动）、本报告的收尾提交。

## 其它缺省连 5190～5192 的地方（第 2、3 项）

`npm test` 会载入 `server/test/*.test.mjs`、`src/**/*.test.mjs`、`tools/report-worker/*.test.mjs`。在这些文件里搜 5190～5192：

- 缺省地址指向 5190～5192、而且会真的发请求的，**只有 skill-gate 这一处**。
- 其余命中都是字符串常量或假数据：`api-guard`、`http-guard`、`auth-impl-crypto`、`auth-impl-service`、`auth-spaces`、`render-host-contract`、`sp-routing`、`safe-port`、`audioMute`、`mediaUrls` 这些测试里的 origin、host、URL 字面量；`queue-node-wiring` 用的是 `fakeFetch`；`dev-server-junction` 断言的是拒绝 5191。
- `server/bakery/chrome.mjs` 的 `DEFAULT_URL` 是 5190，但测试里所有 `openBakery` 都被换成了假的或会直接抛错的实现。`card-snapshot-identity` 只拿这个文件的路径当普通文件来写。
- `package.json` 的 `test` 脚本和 `server/test/global-setup.mjs` 不连任何服务。全局准备只在 127.0.0.1 和 ::1 上占住坏端口名单里的端口，这份名单里没有 5190～5192。
- `npm test` 不会载入、但缺省连 5190～5192 的手动脚本（不在本任务范围内，没改，只记下来）：`scripts/io-check.mjs`（5190）、`scripts/timeline-verify.mjs`（5192）、`scripts/catalog-notes.mjs`（5190）、`server/test/cli-setup-ui.mjs`（5192，文件名不是 `.test.mjs`）、`scripts/archive/export-frames-virtual-time.mjs`（5190）。前四个是否也改成显式传地址，由主会话决定。

## 验证

- 不设环境变量时单独跑 `node --test server/test/skill-gate.test.mjs`：tests 1，skipped 1，跳过原因同上。
- 拒绝的情形都试过，每种都是 skipped 1、原因正确：`PROMPTCUT_BASE=http://127.0.0.1:5190`、`http://localhost:5192/`；设了 5680 但没设 `PROMPTCUT_SKILL_DIR`；`PROMPTCUT_SKILL_DIR` 指向用户目录。
- 真跑：自己在 5680 起了一台 dev server（`npx vite --port 5680 --strictPort --host 127.0.0.1`；启动前确认 5680～5682 都空着），`PROMPTCUT_SKILL_DIR`、`PROMPTCUT_DATA_DIR`、`EXPORT/MEDIA/CLI_HOME/WORK/PROJECTS/CHATS/DOCSERVICE_DATA`、`TEMP`、`TMP` 都指到 scratchpad 下的临时目录。设 `PROMPTCUT_BASE=http://127.0.0.1:5680` 和同一个 `PROMPTCUT_SKILL_DIR` 后跑：21 条 PASS，用例 pass 1、fail 0，exit 0。`skill-state.json` 落在临时目录里。跑完用 `taskkill /T` 结束了自己起的进程树（根 PID 67024），确认 5680～5682 已没有监听，删掉了临时目录，worktree 的 `git status` 是干净的。
- `npx tsc -b --force`：exit 0，零错误。
- `npm test`（不设 `PROMPTCUT_BASE`）：exit 0；tests 2994，pass 2992，fail 0，skipped 2。

## 对任务书的更正

任务书说跳过数变成 2 是「原来需要 5190 的那 1 条加上这一条」。实测另一条跳过的是 `cards-layout.test.mjs` 的「集成：/api/cards/layout 对真实项目返回整数框」，它由 `PC_STAGE_TEST_URL` 开启，不设就跳过，**并不连 5190**。原来 skill-gate 在 5190 没开时是打一行 SKIP 后 `exit(0)`，算作通过，不计入 skipped。所以 skipped 从 1 变成 2，多出来的就是 skill-gate 这一条。这个结果是预期的。

## 没做的

- 上面列出的几个手动脚本没改，因为不在文件清单里。
