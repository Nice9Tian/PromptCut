# AGENT-claude-cli-paste-code

分支 `claude/cli-paste-code`（从 main `141e0be8` 切出）。任务：登录框加「粘贴授权码」输入框，登录任务接上标准输入（出处 `docs/plan/TODO.md`「Claude Code 登录的备用路径用不了：粘贴授权码没有入口」，用户 2026-10-21 定要做，原话「可以。」）。

## 状态

做完，已在分支上提交，未推送、未合并。门槛：类型检查零错误；`npm test` 满载一次跑有 4 项失败（3 个文件，都与本任务无关），单跑复核全过；界面看过图。详见「验证」。

## 做了什么（逐文件）

### 你的清单里的文件

- `server/runners/setup.mjs`
  - `run()` 新增选项 `acceptCode`：为真时子进程 `stdio[0]` 是 `pipe`，否则仍是 `ignore`（安装任务、Codex、Antigravity 的登录都不变）。`windowsHide: true` 原样保留。
  - 只有 **Claude 的登录**（`provider === 'claude'`，`kind === 'login'`）接标准输入。理由：「Paste code here if prompted」是 `claude auth login` 的行为；Codex 备用路径是设备码、Antigravity 走自己的 ConPTY 辅助脚本，都不需要。
  - 任务一结束（成功、失败、超时、取消、启动出错、`dispose`）统一在 `finish()` 里 `stdin.destroy()`，并把任务的 `acceptsCode` 置 `false`。子进程先退出时往管道写会触发 `EPIPE`，给 `stdin` 挂了空的 `error` 监听，免得崩服务。
  - 新增导出 `normalizeAuthCode(input)`：先 `trim()`，只收 `[A-Za-z0-9._~+/=%#-]`，长度 16～512，其余（空白、换行、引号、控制字符、非 ASCII、非字符串）一律抛「授权码格式不对…」。字符集依据：Claude 登录页给的码是 base64url 字符串，码与 state 之间用 `#` 连接。报错信息不带输入内容。
  - 新增服务方法 `submitCode(provider, code)`：只在「这家有正在跑的、没被取消的登录任务、标准输入还开着」时才写，写入 `码 + '\n'`；每条任务最多提交 5 次；成功后只把 `job.message` 设为「授权码已提交，正在确认登录…」，**码不进任何 job 字段**。返回 `publicView(job)`，其中新增布尔字段 `acceptsCode`。
- `server/vite-plugin-ai.ts`（`/api/ai/setup` 的处理函数所在文件）：在 `/api/ai/setup` 上加 `POST`，请求体 `{ provider, code }`，同 `DELETE` 一样要求 `Content-Type: application/json`、同源、体积上限 8 KB；交给 `submitCode`。错误一律回 400 + 一句固定的话；JSON 解析失败单独回「请求不是有效的 JSON」，因为 V8 的 `SyntaxError` 信息里会带一截请求体，直接回显就可能泄漏码。`405` 的提示改成「GET, POST, DELETE only」。请求体不写日志。
- `src/editor/right/AiSetupDialog.tsx`：登录步骤里，**只有当某个登录任务在跑且服务端说它的标准输入接着（`job.acceptsCode`）时**，在「打开登录网页」下面出现一个收着的 `<details>`，标题「浏览器没有自动回到软件？粘贴登录网页给的授权码」；展开后一行说明（授权后页面若显示一串码，复制到这里再点提交；浏览器已自动回到软件、这里显示登录成功的，不用填）、一个密码型输入框（和 API Key 一样遮住）和「提交」按钮，回车也能提交。坏码被服务端拒时显示原因并保留输入；提交成功后立刻清空输入并显示「已提交，正在确认登录…」；任务结束后输入和提示都清掉。码只活在这个组件的一个 `useState` 里，不进诊断报告、不进 `localStorage`、不写日志。控件、样式沿用对话框现有的 `ais-api-field`、`ais-btn`、`ais-detail`。
- `server/test/cli-setup.test.mjs`：新增 11 条用例（见「验证」）。测试替身的 `launch` 现在只在 `stdio[0] === 'pipe'` 时给子进程配 `stdin`，与真的 `spawn` 一致。

### 不在你的清单里、但改了的文件（原因）

- `src/ai/types.ts`：`CliSetupJob` 加可选字段 `acceptsCode?: boolean`。前端要靠它知道「现在有没有地方可粘」，类型必须跟着加。
- `src/editor/right/AiSetupDialog.css`：给上面那块加了十来行样式（收起的标题、一行输入加按钮、按钮不折行、说明字号），属于对话框自己的样式文件。
- `server/test/cli-paste-code-ui.mjs`（新）：浏览器里看界面的手动脚本，用法同 `cli-setup-ui.mjs`（`BASE=… node …`，不给地址不跑），所有 `/api/ai/*` 在浏览器里拦截，不装东西、不登录、不碰真实登录命令。截图存 `out/`。

## 验证

### 类型检查

`npx tsc -b --force`：退出码 0，零错误。

### 单测

`node --test server/test/cli-setup.test.mjs`：28 项全过（原 17 + 新 11）。新增 11 项覆盖：

1. 只有 Claude 登录配标准输入管道，Codex / Antigravity 登录与所有安装任务仍是 `ignore`，`windowsHide` 全为 `true`；
2. 码按「一行」写进子进程标准输入；码不在 `list()`、`submitCode` 返回值里，也没有出现在 `console.*`、`process.stdout` 里；CLI 把码回显到 stdout / stderr，同样不外泄；
3. 20 种坏输入（空、过短、过长、中间空格、多行、`\r\n`、引号、`&&`、NUL、ANSI 转义、非 ASCII、`undefined`、`null`、数字、带 `toString` 的对象、数组）在写入前被拒，子进程标准输入一个字节都没收到，报错里没有输入内容；
4. 没有在等码的任务时被拒（无任务、`__proto__`、Codex 登录、安装任务、已取消的登录）；
5. 成功、失败、超时、取消、启动出错五种结束方式下 `stdin.destroyed === true` 且 `acceptsCode === false`，之后再提交被拒；
6. `dispose` 也关标准输入；
7. 子进程先退出后写入（`EPIPE`）不崩；
8. 每条任务最多 5 次提交；重试登录时计数和管道都是新的；
9. **真子进程**：起一个真的 Node 进程当登录命令，码送进去后以 0 退出，任务成功；码不对以 3 退出，任务失败且返回给界面的内容里没有码；取消时标准输入随任务关掉。

### 接口（对着真的 dev server，端口 5830）

用 `curl` 打 `POST /api/ai/setup`（没有任何登录任务在跑，也没有起真的登录）：无任务 400「现在没有在等授权码的登录任务」；坏形状 400；坏 JSON 400「请求不是有效的 JSON」（不回显请求体）；缺 `Content-Type` 415 类提示；`Origin: http://evil.test` 被拒；`PUT` 405；9000 字节请求体回「请求体超过 8KB」。

### 界面（看过图）

`BASE=http://127.0.0.1:5830 node server/test/cli-paste-code-ui.mjs`：退出码 0，输出 `PASS`。断言：没有登录任务时不出现；任务没接标准输入时不出现；任务接着时出现且默认收着；输入框是密码型；空码不能提交；带空格的坏码被拒、显示原因、输入保留、按钮仍可点；好码回车提交、请求体正是 `{provider, code}`、输入框清空、显示「已提交」；任务结束后整块消失，页面 HTML 里不留码。截图（仓库 `out/` 下，不入库）：

- `C:\Users\admin\Documents\PromptCut\.worktrees\cli-paste-code\out\cli-paste-code-1-collapsed.png`（收着）
- `C:\Users\admin\Documents\PromptCut\.worktrees\cli-paste-code\out\cli-paste-code-2-open-empty.png`（展开、空）
- `C:\Users\admin\Documents\PromptCut\.worktrees\cli-paste-code\out\cli-paste-code-3-rejected.png`（坏码被拒）
- `C:\Users\admin\Documents\PromptCut\.worktrees\cli-paste-code\out\cli-paste-code-4-submitted.png`（已提交）

第一版截图里「提交」按钮在窄栏里折成两行、说明字号比上下文大，已改成不折行和 12px，终稿的「已提交」截图（4）已确认按钮一行、说明字号一致；脚本最后一次运行重新生成了全部四张。

### `npm test`

设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE` 两个环境变量（本机值，没有写进任何文件）。

- **满载（机器上还有别的任务在并行跑）整套一次**：7437 项，通过 7418，失败 4，跳过 15。退出码 1。失败的是 3 个文件：
  - `server/test/cloud-see-frames-dispatch.test.mjs`（1 项）
  - `server/test/cloud-tools-p4-subject.test.mjs`（1 项，进程树被杀的用例）
  - `server/test/multi-agent-presence.test.mjs`（2 项，MA-X2 与 MA-X2～X4，用时 20 秒上下，是在场状态的时序用例）
  - 三个文件都不碰我改的代码；`cli-setup.test.mjs` 和扫描 `windowsHide` 的守门测试在这一轮都过了。
- **单跑复核（`npm test -- <文件>`）**：三个文件各第一次单跑就全过：`cloud-see-frames-dispatch` 1/1，`cloud-tools-p4-subject` 29/29，`multi-agent-presence` 6/6，退出码均为 0。没有用到第二次复核。
- 另：满载那轮里 `CA-RENDER-01` 没有失败。

## 没做成的及原因

- **没有用真的 `claude auth login` 端到端走一遍**：那会操作用户真实的登录状态，不属于测试范围。取而代之：服务层用「真子进程当登录命令」验证管道、关闭和失败路径；界面层在浏览器里拦截接口验证。码到了真的 Claude Code 之后它认不认（尤其是 `码#state` 这种形状是否就是它要的整串）没有实机验证，**需要用户在没有默认浏览器的环境（远程桌面等）实际走一次**，那是这条备用路径真正的验收。
- **`server/test/cli-setup-ui.mjs` 在 main 上已经是坏的**（我没改它）：它找 `.ais-row`，而对话框现在是「卡片网格 → 点进详情」的结构，所以早就跑不通。我另写了 `cli-paste-code-ui.mjs` 覆盖这次要看的部分，没有去重写旧脚本（不在任务范围）。建议主 Agent 另派一个小任务，要么按新结构重写它，要么删掉。
- 接口层（`vite-plugin-ai.ts` 里那段 POST）没有自动化测试，只有上面的 `curl` 实测：该处理函数写在 Vite 插件里，没有不起开发服务器就能挂上的办法。如果要自动化，得先把这批 `/api/ai/*` 处理函数抽成可单独挂的模块，范围比这条任务大。

## 对任务书或语义的更正建议

- `docs/semantics/` 里完全没有 CLI 登录这一块（`product/agent.md`、`mechanism/agent.md`、`workflow/` 都搜不到「授权码」「claude auth login」「AI 设置」登录步骤）。这次的行为变化（Claude 登录备用路径可粘贴授权码；接口 `POST /api/ai/setup`；码不落日志、不回显、形状校验）是用户看得见的新能力，按「三级」属于二级，建议主 Agent 把它记到 `product/agent.md`（或新建一小节）并在 `mechanism/agent.md` 记机制那一半（只有 Claude 登录接管道、形状 `[A-Za-z0-9._~+/=%#-]{16,512}`、最多 5 次、任务结束关标准输入）。我没有动任何 `docs/semantics/**`。
- `docs/plan/TODO.md` 第 60 行那一条，合入后可标办结；它原文说「`stdio: ['ignore', 'pipe', 'pipe']`」在 `server/runners/setup.mjs` 的写法已改为按任务决定。
- 授权码的字符集是按「base64url 加 `#`」推断的，没有拿到 Claude Code 的官方说明。如果真机发现码里还有别的字符（或比 512 长），只需改 `setup.mjs` 里 `AUTH_CODE_SHAPE` 一处。
