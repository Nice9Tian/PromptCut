# AGENT-codex-test-env 报告

分支 `claude/codex-test-env`，起点 main `d20b6aad`。任务：让 `server/test/codex-desktop.test.mjs` 不再依赖本机装了哪种 codex，并查同类测试。只改了测试，没动产品代码。

## 做了什么

### 1. `server/test/codex-desktop.test.mjs`

- 根因：`createCodexTask` 取 `process.env.PROMPTCUT_CODEX_EXE || resolveCli("codex")`，测试没设前者，`resolveCli` 就去查本机（`LOCALAPPDATA`、`APPDATA\npm`、`where.exe`）。本机装了 npm 版时解析到 `codex.cmd`，`cliCommand` 把它改写成 `node <codex.js> app-server --stdio`，所以旧断言 `['app-server','--stdio']` 挂了。
- 改法：每个用例用 `withCodexExe(fakeExe, …)` 把 `PROMPTCUT_CODEX_EXE` 设成临时目录里的假路径（win32 为 `codex.exe`，其它平台为 `codex`），跑完在 `finally` 里恢复（原来没有就删掉）。`PROMPTCUT_CODEX_EXE` 一设，`||` 短路，`resolveCli` 根本不会被调用。`cliCommand` 对不以 `.cmd/.bat` 结尾的路径原样返回 `{command: exe, args}`，不查文件存在，所以假路径走得通。
- 原先写在 `spawn` mock 里的三条断言（参数 `['app-server','--stdio']`、`windowsHide: true`、不 `detached`）保留，改为 mock 记录每次 spawn 的 `{command, args, options}`，用例里用 `assertSpawnedAppServer` 断言，并多断言了 `command` 就是假 exe。
- 新增 3 个用例：
  - 解析到 npm 垫片（临时目录里建 `codex.cmd` + `node_modules/@openai/codex/package.json` + `bin/codex.js`）时，用 `process.execPath` 起，参数前面是脚本路径（仅 win32 跑，其它平台 skip）。
  - 垫片找不到入口脚本时，退到隐藏窗口的 PowerShell（`-NonInteractive -WindowStyle Hidden -NoLogo …`，仅 win32 跑）。
  - `withCodexExe` 成功和抛错两种情况下都恢复环境变量。
- 临时目录用 `after()` 清掉。垫片只建在临时目录，不碰本机真实的 npm 全局目录。

### 2. 同类测试排查（`server/test/` 下 334 个文件）

只有 `server/codex-desktop.ts`、`runners/index.mjs`（`resolveExe`）、`runners/quota.mjs`、`runners/setup.mjs`、`runners/auth.mjs` 会调 `resolveCli`。逐个看了引用到的测试：

| 文件 | 结论 |
|---|---|
| `agy-stdin.test.mjs` | 有依赖，已改。断言 `args.includes('--input-format')`、`indexOf('--model')` 等；claude/agy 若解析到只有裸 `.cmd` 的 npm 垫片，`cliCommand` 会把实参包进 `-EncodedCommand`，断言就挂。用把 `APPDATA` 指到放了裸 `claude.cmd/agy.cmd` 的临时目录模拟，改前 7 个挂 5 个。 |
| `claude-prompt-file.test.mjs` | 同上，已改。同样的模拟，改前 6 个挂 3 个。 |
| `agy-denied.test.mjs`、`runner-callid.test.mjs` | 不断言 spawn 的实参，只断言事件流；上面的敌对环境下仍全过，没改。 |
| `cli-setup.test.mjs` | 已自己给 `resolveCli`/`cliCommand` 注入 `env/home/platform/root/lookup`，且按 win32 显式传参，没改。 |
| `quota.test.mjs`、`cli-loop.test.mjs`、`codex-tool-errors.test.mjs`、`codex-mcp-permissions.test.mjs` | 不走真实的 CLI 解析；敌对环境下全过，没改。 |

agy-stdin、claude-prompt-file 的改法：新增测试辅助 `server/test/fake-cli-home.mjs`（`useFakeCliHome()`），把 `PROMPTCUT_CLI_HOME` 指到临时目录并放好空的 `claude/claude.exe`、`codex/codex.exe`、`agy/agy.exe`（非 win32 无后缀）。`resolveCli` 的第一个候选就是 `<PROMPTCUT_CLI_HOME>/<名>/<名>.exe`，存在即返回，`cliCommand` 对 `.exe` 原样返回，因此与本机无关。顺带 `cliEnv('codex')` 要建的 `codex-home` 也落在临时目录。每个测试文件是独立进程，在文件顶层设、`after()` 里恢复并删临时目录。

没有改不了的。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| codex-desktop 单测（本机原状，npm-global 在 PATH 里） | `node --experimental-test-module-mocks --test server/test/codex-desktop.test.mjs` | 退出 0，7 测 7 过 |
| 去掉 PATH 里 npm-global | `PATH=$(echo "$PATH" \| tr ':' '\n' \| grep -vi npm-global \| paste -sd:) node … codex-desktop.test.mjs` | 退出 0，7 测 7 过（此时 `where.exe codex` 只剩桌面版 `…\Programs\OpenAI\Codex\bin\codex.exe`，被 `resolveCli` 排除） |
| 敌对环境（`APPDATA`、`LOCALAPPDATA` 指到只含裸 `codex.cmd` 的临时目录） | 同上加这两个环境变量 | codex-desktop 7/7 过 |
| 其它测试在同一敌对环境 | `cli-setup`、`quota`、`cli-loop`、`codex-tool-errors`、`codex-mcp-permissions`、`agy-denied`、`runner-callid`、改后的 `agy-stdin`、`claude-prompt-file` | 全部 0 失败（15/14/8/9/1/11/11/7/6 过） |
| 类型检查 | `npx tsc -b --force` | 退出 0，无输出 |
| 全量 | `npm test` | 退出 0；tests 4226、pass 4224、fail 0、cancelled 0、skipped 2 |

（旧总数 4223/4221/0/2；多出的 3 是新增的 3 个 codex-desktop 用例。）没看图：不涉及渲染。

## 没做的与建议

- 没有更正任务书的地方。一点补充：任务书说「装 npm 版时 `resolveCli` 解析到 `codex.js`」，实际是解析到 `codex.cmd`，再由 `cliCommand` 改写成 `node codex.js …`；新增的 npm 垫片用例就是据此造的（临时 `.cmd` + `package.json` + 入口脚本）。
- `agy-denied`、`runner-callid` 虽目前不依赖本机，但若以后在其中加 spawn 实参断言，需同样调用 `useFakeCliHome()`。

## 提交

见 `git log claude/codex-test-env`：开工报告一次，测试改动一次，终稿报告一次。不推送、不合并、未删 worktree。
