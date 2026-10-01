# AGENT-ps1-bom：给含中文的 .ps1 加 UTF-8 BOM

分支 `claude/ps1-bom`（基于 main f119a66d），worktree `.worktrees/ps1-bom`。选型 sonnet-dev-high（维护项）。

## 背景

笔记本的系统 ANSI 代码页是 GBK（`[Text.Encoding]::Default.WebName` = `gb2312`，本次再次确认）。
Windows PowerShell 5.1 读不带 BOM 的 .ps1 按 ANSI 解码，不看 chcp。
三份随安装包 / 补丁 / 扩展包发给用户、含中文的脚本因此在中文系统上解析失败。

## 改了什么

| 文件 | 改动 |
|---|---|
| `desktop/scripts/apply-patch.ps1` | 开头加 EF BB BF |
| `desktop/scripts/apply-extension.ps1` | 开头加 EF BB BF |
| `desktop/src-tauri/nsis/report.ps1` | 开头加 EF BB BF |
| `desktop/test/ps1-bom.test.mjs`（新） | 守门测试 |

`git ls-files "*.ps1"` 只有这三份；另外 `.cmd` / `.bat` 里只有 `apply-patch.cmd` 含中文（见「没处理的」）。

## 逐字节对比

加 BOM 用 node 对 Buffer 前置 3 字节，没经过任何编辑器。仓库有 `* text=auto`：index 里是 LF，本机工作区是 CRLF。两层都对比了：

```
blob(git show :<file>) == BOM + blob(git show main:<file>)       三份均为 true（长度各 +3：19824->19827、10484->10487、11549->11552）
工作区文件去掉前 3 字节 == main 的 blob 换成 CRLF 后的字节       三份均为 true（行尾保持原样）
git diff --cached --stat：每份 1 行变动（首行加了不可见的 BOM），无其它行
```

## ParseFile 前后（本机 Windows PowerShell 5.1，只解析不执行）

命令：

```powershell
$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile('<绝对路径>',[ref]$t,[ref]$e); @($e).Count
```

| 文件 | 加 BOM 前 | 加 BOM 后 |
|---|---|---|
| desktop\scripts\apply-patch.ps1 | 5 | 0 |
| desktop\scripts\apply-extension.ps1 | 13 | 0 |
| desktop\src-tauri\nsis\report.ps1 | 4 | 0 |

三份脚本都没有被执行过，只调了 ParseFile。

## 守门测试先红后绿

`desktop/test/ps1-bom.test.mjs`（node:test）三条：判定函数的正反例；枚举结果里一定有那三份（防止枚举失效而空过）；git 跟踪（含未跟踪未忽略）的所有 `*.ps1`，凡含非 ASCII 字节的必须以 EF BB BF 开头，失败信息写明文件名、中文 Windows 上 5.1 按 GBK 读会解析失败的原因、以及修法。

红（临时把三份的 BOM 去掉）：

```
ℹ pass 2
ℹ fail 1
✖ 所有含非 ASCII 字节的 .ps1 都以 UTF-8 BOM（EF BB BF）开头
  AssertionError: 这些 .ps1 含中文等非 ASCII 字节，却没有 UTF-8 BOM：
    desktop/scripts/apply-extension.ps1
    desktop/scripts/apply-patch.ps1
    desktop/src-tauri/nsis/report.ps1
  为什么不行：中文 Windows 上 Windows PowerShell 5.1 读不带 BOM 的脚本按 GBK 解码（不看 chcp），整份脚本会解析失败。…
exit 1
```

绿（`git checkout --` 从 index 还原带 BOM 的版本，并再次逐字节核对仍为 BOM + 原字节）：

```
✔ 判定函数 / ✔ 枚举 / ✔ 所有含非 ASCII 字节的 .ps1 都以 UTF-8 BOM 开头
ℹ tests 3  ℹ pass 3  ℹ fail 0   exit 0
```

## 验证

- `cd desktop && npm test`：tests 19，pass 19，fail 0，退出码 0（含新增 3 条）。
- 仓库根目录（worktree 内）`npx tsc --noEmit`：退出码 0，无输出（零错误）。
- 根目录 `npm test` 按任务要求没跑，留给主会话在集成分支上统一跑。

## 查过的读写点及结论

- `desktop/scripts/make-patch.mjs`（333 行）：`fs.copyFileSync` 拷 `apply-patch.ps1` 与 `apply-patch.cmd`（后者改名「安装更新.cmd」），按字节拷，BOM 保留。`mustHave` 只查存在。345 行起的 `patch-installer.nsi` 同样是拷。该文件里的 sha256（119 行）算的是 payload 文件，不含安装器脚本。
- `desktop/scripts/make-extension.mjs`（491 行）：`copyFileSync` 拷 `apply-extension.ps1`，保留 BOM。
- `desktop/scripts/build-release.mjs`（126 行）：`copyFileSync` 把三个安装器文件从 HEAD 的 worktree 拷到 `.cache/release-installer`，保留 BOM。
- `desktop/src-tauri/nsis/hooks.nsh`：`report.ps1` 用 NSIS `File` 指令按字节装进包里（101 行），保留 BOM。`pc-kill-leftovers.ps1` 是用 `FileWrite` 逐行写的，那几行 FileWrite 全是 ASCII（grep 非 ASCII 只命中一行注释），不受影响。
- `desktop/scripts/patch-installer.nsi`：只 `ExecWait powershell -File …\apply-patch.ps1`，不读内容。
- 脚本自身：`apply-patch.ps1` / `apply-extension.ps1` 只用 `$MyInvocation.MyCommand.Path` 取目录，不读自身内容。`report.ps1` 里的 `Set-Content -Encoding UTF8` 是写报告 txt，与脚本自己的编码无关。
- 测试：`desktop/test`、`server/test`、`test/`（`test/` 目录不存在）下没有读这三份 .ps1 内容的断言（grep `apply-patch|apply-extension` 无命中）。`server/test/sp-route.test.mjs` 的 SPC6-3 把 `.ps1` 也读成 utf8 字符串，只做 `includes('8.219.80.16')`，BOM 不影响。
- 开头的 `<#` 注释块：ParseFile 0 错误，BOM 位于 `<#` 之前不影响注释块解析。

## 没处理的（发现，未改，供主会话定夺）

1. `desktop/scripts/apply-patch.cmd` 含中文（第 2、3 行的 `rem` 注释）而且没有 BOM，`chcp 65001` 在第 4 行才执行。**不能给 .cmd 加 BOM**（cmd 会把 BOM 当作第一行命令名的一部分，`@echo off` 失效）。这两行是 rem，被 GBK 读成乱码最多是多读几个字节、不执行，之前的真机路径也没出过问题；我没有改它。若想彻底稳妥，可把 rem 注释改成纯 ASCII，但那是改产物文案，没在这次范围里。
2. `server/claude-desktop.ts` 的 `runPs` 把脚本写成 `send-prompt.ps1`，用 `writeFileSync(file, lines.join("\r\n"), "utf8")`，没有 BOM。脚本模板本身是 ASCII，但里面会拼进任务目录名和提示文本（`psStr(...)`）；若这些含中文，同样的 GBK 问题会让脚本解析失败。这是运行时生成的脚本，不在「随包发给用户的 .ps1」之内，也不在本任务清单里，所以没动。要修的话在写文件时前置 `﻿` 即可。`server/runners/setup.mjs` 那条走 `-EncodedCommand`，不落 .ps1 文件，不受影响。`scripts/probes/m8-outbound-probe.mjs` 的 `tcp-sample.ps1` 是探针（`TCP_PS1` 模板我没细查是否含中文）。
3. 对任务书的更正：任务书提到 `desktop/test/prepare-runtime-filter.test.mjs` 作风格参照，该文件在本 worktree 的 main 里不存在，我照 `desktop/test/make-extension.test.mjs` 的风格写。

## 没做成的

无。

## 续做：运行时写出的 .ps1 一律带 BOM

主会话续派：把「没处理的」第 2 条一并修掉。

### 改了什么

| 文件 | 改动 |
|---|---|
| `server/claude-desktop.ts` | 新增并导出 `writePsScript(file, lines)`：写文件时前置 `"﻿"`，内容其余不变；`runPs` 改调它。脚本内容和调用方式（`powershell.exe -File`）没动 |
| `scripts/probes/m8-outbound-probe.mjs` | `tcp-sample.ps1` 写出时前置 `'﻿'`（`TCP_PS1` 里有 31 个非 ASCII 字符，是中文注释） |
| `server/test/claude-desktop.test.mjs` | 加一条 `writePsScript` 的测试 |

源码里用的是 `﻿` 转义，不是肉眼看不见的字面 BOM 字符。

### 全仓盘点（运行时生成 .ps1 再交给 powershell 跑的地方）

对 `server/ desktop/ src/ scripts/` 里 `.ps1`、`-File`、`powershell|pwsh` 逐个看过：

- `server/claude-desktop.ts` `runPs`：已修。
- `scripts/probes/m8-outbound-probe.mjs` `tcp-sample.ps1`：已修。
- `server/runners/setup.mjs`：把官方 `install.ps1` 用 `Invoke-WebRequest -OutFile` 下载到 `installers/` 再执行，文件内容来自对方服务器，不是我们生成的，不动；它外层走 `-EncodedCommand`，不落 .ps1。
- `server/runners/cli-runtime.mjs`、`install.mjs`：`-EncodedCommand`，或只是 URL 字符串，不落 .ps1。
- `server/codex-desktop.ts`、`scripts/probes/*` 其余、`desktop/scripts/smoke-procs.mjs` 等：都是 `-Command` 单行，不写文件。
- `desktop/src-tauri/nsis/hooks.nsh` 的 `pc-kill-leftovers.ps1`（NSIS 逐行 `FileWrite`）：内容全是 ASCII，不需要 BOM（上一轮已核）。

### 测试先红后绿

`server/test/claude-desktop.test.mjs` 新测试 `writePsScript:写出的 .ps1 以 UTF-8 BOM 开头…`：目录名含中文，断言文件前 3 字节是 EF BB BF、只有一个 BOM、BOM 之后与 `lines.join('\r\n')` 一字不差。

红（临时把 `"﻿" + lines` 改成 `"" + lines`）：

```
✖ writePsScript:写出的 .ps1 以 UTF-8 BOM 开头(…)
  AssertionError [ERR_ASSERTION]: 文件必须以 EF BB BF 开头
ℹ pass 15  ℹ fail 1
```

绿（还原）：`ℹ pass 16  ℹ fail 0`。

### 本机 ParseFile（PowerShell 5.1，只解析不执行）

样本由新代码 `writePsScript` 写在含中文的路径下（`...\scratchpad\中文目录\send-prompt.ps1`），内容仿 `sendPromptViaUia` 里拼进去的 `psStr(path.basename(dir))` 和 `psStr(prompt)`（含中文目录名、中文提示）；对照组是旧写法（`writeFileSync(file, lines.join("\r\n"), "utf8")`，无 BOM）。没有执行 `sendPromptViaUia`，那会真去操作窗口。

| 文件 | ParseFile 错误数 | 中文字符串字面量 `'补丁任务目录'` 解析出的值 |
|---|---|---|
| 旧写法，无 BOM | 0 | **乱码**（U+741B U+30E4 U+7AF5 …），与原文不等 |
| 新代码，带 BOM | 0 | 正确（U+8865 U+4E01 U+4EFB U+52A1 U+76EE U+5F55），与原文相等 |
| `TCP_PS1`（探针）无 BOM / 带 BOM | 0 / 0 | 只有注释含中文，无字面量可比 |

说明：这些样本在 GBK 下语法上碰巧仍然合法，所以错误数前后都是 0，没有拿到「前 N 个错、后 0 个错」的对照。真正的后果是字符串被读成乱码：`sendPromptViaUia` 拿任务目录名去匹配界面上的「目录芯片」按钮，无 BOM 时目录名含中文就匹配不上，表现为 `NOCHIP` 而不是解析失败。上一节三份发布脚本的 5 / 13 / 4 个错是它们里面有会被 GBK 吃掉的字符，那是另一类现象。

### 验证

- 根目录 `npx tsc --noEmit`：退出码 0，无输出。
- `node --test server/test/claude-desktop.test.mjs`：tests 16，pass 16，fail 0。
- `cd desktop && npm test`：tests 19，pass 19，fail 0。
- `node --check scripts/probes/m8-outbound-probe.mjs`：通过。
- 根目录整套 `npm test` 未跑（按任务要求）。

`apply-patch.cmd` 里 chcp 之前的中文 rem 注释维持不动，「没处理的」第 1 条保留。上面「没处理的」第 2 条现已处理。
