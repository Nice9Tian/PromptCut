# AGENT 报告：watch-ignore（TODO R0：仓库根 dev server 冷启动）

分支 `claude/watch-ignore`，起点 main `a6663d56`。端口段 5740～5749（用过 5740～5742、5745，已全部关掉）。

## 状态

配置那一半做完并提交；验收里「150k 文件时 pageMs 两遍 ≤ 15 s」**单靠配置达不到**（20.6 s），差的那一截在 `src/index.css`，不在本任务可改的范围里，停在这里请主 Agent 定（见「没做成的」）。

## 原因

帧库 15 万个 `.html` 落在 Vite 根目录下时，冷启动慢是三件事叠在一起，用实验逐个分开（量测都在本 worktree、笔记本、`r0-coldstart.mjs`）：

1. **依赖扫描把帧库当入口（最大头，约 170 s）。** 没给 `optimizeDeps.entries` 时，Vite 8 以 `**/*.html` 为入口做依赖扫描（`node_modules/vite/dist/node/chunks/node.js` 的 `computeEntries` / `globEntries`），只排除 `node_modules` 与 `build.outDir`（`dist`），`out/frame-library` 下 15 万个快照 `.html` 全被当成入口交给 rolldown 扫一遍。只把入口限定到 `index.html`（监听不动）：pageMs 222 s → 20.6 s，httpMs 17.7 s → 3.2 s。
2. **监听忽略在 worktree 里全部失效（正确性问题，冷启动上贡献很小）。** `server.watch.ignored` 原样交给 Vite 打包的 chokidar 3.6，chokidar 用 anymatch → picomatch 的**缺省选项（dot: false）**去匹配**绝对路径**。dot: false 时 `**` 不跨过以点开头的一段，而 worktree 的绝对路径里有 `.worktrees`，于是名单里每一条（`**/out/**`、`**/desktop/**`、`**/*.lock` ……）连同 Vite 自带的 `**/node_modules/**`、`**/.git/**` 都不生效（`picomatch("**/*.lock")` 对 worktree 里的 `x.proc.lock` 同样是 false）。最小实验：
   `picomatch("**/out/**")("D:/VectorMPEG7/PromptCut/out/x")` → true；`("D:/VectorMPEG7/PromptCut/.worktrees/watch-ignore/out/x")` → false；加 `{dot:true}` 两个都 true。
   反过来在仓库根起服务时 glob 生效（按上面的实验推断，没在主工作区实测），但名单里没有 `.worktrees/`，47 个 worktree 的源码与各自的 out/ 全在监听里。
   所以在 worktree 里起的 dev server，`.proc` 锁那条防 EBUSY 的保护此前也是失效的。`server.fs.deny` 用的是 `dot: true`，不受影响。
3. **Tailwind 的源码目录清单每次都把整棵树走一遍（剩下的约 10 s，而且每次热更新都再走一遍）。** `@tailwindcss/vite` 4.3.3 生成 CSS 时读 oxide `Scanner` 的 `globs`（插件里的 “Register dependency messages” 一步）。这个 getter 在自动探测模式（`@import "tailwindcss";` 不带 `source(...)`）下遍历 Vite 根下的全部目录，**不管 `@source not "../out"` 和 .gitignore**。直接调 oxide 量（`tw-scan.mjs`）：`scan()` 243 ms、只扫 1177 个文件、一个都不在 out/ 里；但 `scanner.globs` 帧库在 10.1 s、帧库移走 0.17 s、把帧库挪到被 `@source not` 排除的 `tools/` 下仍 11.0 s。`DEBUG=tailwindcss` 下 dev server 里同样是 “Register dependency messages 11074 ms”。临时去掉 tailwind 插件（仅实验）：依赖扫描 14.3 s → 2.8 s、pageMs 8.9 s。这一步还让**每次改源码的热更新晚到约 11.8 s**（帧库在时实测 `hot updated` 在改文件后 11 820 ms 才到；帧库不在时 4 s 窗口内就到）。

主会话量到的「帧库放仓库外、经 `PROMPTCUT_EXPORT_DIR` 指过去就快」与此一致：三件事都只看 Vite 根下有什么；扫帧库的服务端代码不是原因（给 vite 进程挂 fs 钩子追踪，没有任何 JS 调用碰 frame-library）。

## 改法（已提交）

- 新增 `server/vite-scan-ignore.mjs`，两个导出：
  - `watchIgnored(root)`：返回判断函数，按**相对项目根的路径段**判断，与根的绝对路径长什么样无关。段名单：`.git`、`node_modules`、`test-results`（Vite 缺省的三条，同受 dot 问题影响，一并兜住）、`desktop`、`out`、`python`、`.pc-projects`、`.pc-work`、`.pc-chats`、`.worktrees`（新加）；另加以 `.lock` 结尾的一律忽略。项目根外的路径（配置依赖、env 文件）不在这里忽略。语义与原来的 `**/x/**` 相同：任意深度的同名目录都算。
  - `DEP_SCAN_ENTRIES = ["*.html", "src/**/*.html", "desktop/ui/**/*.html", "scripts/**/*.html"]`：与原先 `**/*.html` 实际找到的 7 个页面完全相同（debug 日志里的入口列表逐条核对过），但不去翻 out/ 等大目录。
- `vite.config.ts`：桌面分支 `optimizeDeps.entries` 用上面的清单、`server.watch.ignored: [watchIgnored(ROOT)]`（`ROOT` 取配置文件所在目录）；无头分支 `watch: null` 不变；在线分支（`--mode online`）也加上同样两项（构建用不上，防有人拿它起开发服务）。
- `vite.prerender.config.ts`：同样两项。预渲染进程也是一台 Vite 开发服务器，原来有同样的 glob 与入口问题。

提交：`8cb4f0e5`（报告开工）、`65a2d740`（修复）、本报告的提交。

## 验证

帧库用脚本生成：`out/frame-library/controls-html/<600 个 64 位十六进制键>/<250 个>.html`，共 150 000 个；量完已删。

| 场景 | httpMs | pageMs |
|---|---|---|
| 改前，150k | 17 684 | 222 428 |
| 只修监听（实验），150k | 15 380 | 190 808 |
| 只限依赖扫描入口（实验），150k | 3 173 | 20 644 |
| **改后（已提交），150k，第 1 遍** | 3 224 | **20 551** |
| **改后（已提交），150k，第 2 遍** | 3 118 | **20 756** |
| 改前，空帧库 | 3 225 | 10 540 |
| **改后，空帧库**（两遍） | 3 220 / 3 125 | **10 335 / 9 998** |
| 改后 + `src/index.css` 显式源（实验，未提交），150k，两遍 | 3 098 / 3 239 | **9 861 / 10 033** |
| 只改 `src/index.css`、配置用改前（实验），150k | 16 665 | 176 158 |

- 空帧库不比改前慢（10.0～10.3 s 对 10.5 s）。
- 150k 时改后 20.6 s，**没达到 ≤ 15 s**；配上 `src/index.css` 的改动后 10 s，与空帧库相同。两处缺一不可（只改 CSS 仍 176 s）。
- 热更新：自己起 dev server（5740）、无头 Chrome 打开编辑器，写 `out/hmr-probe.html` 和 `out/frame-library/controls-html/hmr-probe/x.html`：服务端与页面都无任何更新；给 `src/voice/VoiceSettingsDialog.tsx` 追加一行：服务端 `[vite] (client) hmr update /src/voice/VoiceSettingsDialog.tsx, /src/index.css`，页面收到 `[vite] hot updated: /src/voice/VoiceSettingsDialog.tsx`、`/src/index.css`。改前配置同样测一遍，结果相同（只证明没把该监听的挡掉）。
- 预渲染配置冒烟：`createServer({ configFile: 'vite.prerender.config.ts' })` 起在 5745，`/?export=1` 回 200，`server.watch.ignored` 是一个函数，out 下路径判忽略、src 下路径判不忽略，`optimizeDeps.entries` 是上面的清单。
- 忽略函数单测（临时脚本）：worktree 根与仓库根两种根，`out`、`out/frame-library/..`、`desktop/x.exe`、`archive/python-cards/python/a.py`、`node_modules/.vite/x`、`x.proc.lock`、`.pc-projects/a.proc`、`.git`、`test-results/a` 判忽略；根本身、`src/main.tsx`、`server/vite-plugin-ai.ts`、`.env`、`outer/a.ts`、根外的 `package.json` 判不忽略；以仓库根为根时 `.worktrees/x/src/a.ts` 判忽略、`src/a.ts` 不忽略。
- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0，tests 4035、pass 4033、fail 0、skipped 2。
- `npm run build`：退出码 0（`✓ built in 1.96s`）。
- `npx vite build --mode online --outDir out/dist-online`：退出码 0（`✓ built in 1.73s`）。
- 5740～5749 用完无监听；构建产物、生成的帧库、dev server 在 worktree 里建的 `out/`、`data/` 已删。

## 没做成的

**150k 文件时 pageMs ≤ 15 s 没达到（改后 20.6 s）**：剩下约 10 s 是 Tailwind（原因第 3 条），只能在 `src/index.css` 里改，任务书写了不改 `src/`，按协议停下，请主 Agent 定。建议的改动（已实验，未提交）：

```css
@import "tailwindcss" source(none);
@source "../src";
@source "../server";
@source "../index.html";
```

其余 `@source not ...` 行保持不变。核对过：用 `@tailwindcss/node` 的 `compile` + oxide `Scanner` 对本 worktree 生成 CSS，改前改后**逐字节相同**（101 475 字节）；扫描文件清单只少了 `vite.config.ts`、`vite.prerender.config.ts` 两个（本来就没有界面类名）；`globs` 从 10～11 s 降到 0.12 s，与帧库大小无关。不要写成 `@source "../*"`：那样会把 `tsconfig.tsbuildinfo`、`.gitignore`、png 也纳入，`tsc` 一跑就触发整页重载。

改它的代价要主 Agent 掂量：`src/index.css` 在 `server/frame-code.mjs` 的 `frameCode` 遍历范围内（`src/` 下的 `.css` 都算），改了代码身份就变，已有帧库的结果键随之失效、要重新预渲染，在线构建嵌的 `__PC_CODE_VERSION__` 也跟着变。

## 对任务书的更正建议

- 「`server.watch.ignored` 没起作用」只对 worktree 成立：在仓库根起服务时 `**/out/**` 应当是生效的（推断）。真正的大头是依赖扫描入口和 Tailwind，监听修好对冷启动几乎没有贡献（190.8 s 对 222.4 s），但它是正确性问题（worktree 里 desktop/python/.pc-* 的改动会进监听、仓库根会监听全部 worktree），照样该修。
- 在仓库根起的 dev server 也有第 3 条：Tailwind 的目录遍历不看 `@source not`，所以 `.worktrees/` 下全部 worktree（连同它们各自的 out/ 帧库）每次冷启动、每次热更新都会被走一遍。`src/index.css` 那处改动对仓库根同样有用。
