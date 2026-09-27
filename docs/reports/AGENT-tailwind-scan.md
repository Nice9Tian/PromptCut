# AGENT-tailwind-scan

分支 `claude/tailwind-scan`，工作区 `.worktrees/tailwind-scan`，起点 main `7ff0ea8`，端口 5680～5689（只用了 5680 及其舞台端口 5681、5682）。

## 任务

开发服务里 Tailwind v4 的 Vite 插件（`@tailwindcss/vite` 4.3.3）自动扫描项目文件找类名；扫到的非模块文件（`docs/` 下的 `.md` 等）一改，它不打日志就让所有打开的页面整页重载（`AGENT-c10a-r2.md`「接手」一节查实）。在入口样式里用 `@source not` 把不含界面类名的范围排除出扫描，并证明样式不变、重载消失。

## 机制（读插件源码核对过）

- 入口 `src/index.css` 只有 `@import "tailwindcss";`，没写 `source()`，插件以 Vite 的 root（仓库根）为 base、`**/*` 自动扫描。扫描器按 `.gitignore` 和 `.git/info/exclude` 跳过忽略的路径，所以 `out/`、`dist/`、`/data/`、`.worktrees/` 本来就不在扫描里（在主工作区实测过：1828 个文件里没有这几处）。
- 扫到的文件挂在 CSS 模块下当 asset。`hotUpdate` 里：改动的文件只对应 asset 时，扩展名是 `.js/.ts/.jsx/.tsx`（含 c/m 前缀）或 CSS 的直接放过；扩展名已有同类真实模块在模块图里的（如 `.json`）也放过；其余（`.md`、`.toml`、`.bat`、`.html` 等）直接发 `full-reload`，不打日志。
- 另外 `vite.config.ts` 的 `server.watch.ignored` 已忽略 `desktop/`、`out/`、`python/`，这三处的改动连 watcher 都到不了。

## 排除表

改前扫描 1830 个文件（工作区里；主工作区 1828，差的是工作区的 `.git` 文件和一个临时脚本），其中非模块文件：md 254、json 73、py 52、toml 14、rs 14、txt 10、html 7、ps1 3、cmd 3、xml 2、nsi 2、bat 2 等。

界面类名只在三处：`src/` 的组件、`index.html`、`server/` 下的卡片源码（`server/catalog/magicui/*.tsx` 大量用 Tailwind 类，`server/bakery/bake.mjs` 也有 `className`）。所以 `server/` 不整个排除，只排 `server/test`。

`src/index.css` 里加的 `@source not`（路径相对于该文件）：

| 排除 | 为什么 |
|---|---|
| `../docs`、`../archive` | 文档与归档 |
| `../python`、`../desktop`、`../tools`、`../scripts` | Python、桌面壳、小工具、脚本与探针（含 `scripts/probes` 的 harness html） |
| `../server/test` | 测试与夹具 |
| `../out`、`../dist`、`../data`、`../work`、`../.worktrees`、`../.claude` | 产物、运行时数据、工作区；前几项本已被 git 忽略，写上是为了不依赖 `.gitignore` / 本机的 `info/exclude` |
| `../**/*.md`、`../**/*.json` | 散在 `src/`、`server/` 里的说明文档（如 `src/ai/roles/*.md`、`server/card-authoring-guide.md`）和数据文件（`server/catalog/**.json` 粒子与 Lottie 配置） |
| `../proto.html`、`../*.bat`、`../.git`、`../.gitattributes` | 根目录的原型页、批处理和 git 文件 |

改后扫描 1030 个文件，只剩 `src/`（708）、`server/`（318，不含 `server/test`）、`index.html`、两个 vite 配置；扩展名只剩 tsx/ts/mts/mjs/cjs/css/html，不再有会触发整页重载的非模块文件。

## CSS 对比（改前 / 改后各构建一次）

- `npm run build`（桌面）：改前 `index-CyPNd2Uj.css` 299683 字节，改后 `index-1EWTl5HA.css` 299417 字节，**不相同**，少 266 字节。
- `npx vite build --mode online`（在线）：与桌面构建逐字节相同（改前两者 sha256 都是 `3bcbe355…`，改后都是 `b79d3903…`），差异同上。
- 差异全部是删掉的规则，没有新增或改动：

| 删掉的规则 | 改前是谁让它生成的 | 被扫描的源码里有没有用 |
|---|---|---|
| `.animate-spin`、`--animate-spin`、`@keyframes spin` | `server/test/cards.test.mjs` | 没有（只有 `animate-spin-around`，那条在 `magicui-animations.css` 里，不受影响） |
| `.left-10000` | `scripts/probes/c10-stage-probe.mjs`、`docs/reports/AGENT-c10-probe.md` | 没有 |
| `.flex-shrink` | `docs/archive/agent-reports/AGENT-chat-list-window.md` | 没有（卡片用的是 `flex-shrink-0`，仍在） |
| `.flex-grow,.grow` | `server/test/*.test.mjs` | 没有 |
| `.tab-1`、`.tab-9` | `server/test/docservice-*.test.mjs`、`docs/plan/distributed-prerender-queue.md` | 没有 |

  「没有」是用 `(^|[^-\w])类名([^-\w]|$)` 在 `src/`、`server/`（不含 `server/test`）、`index.html`、vite 配置的 ts/tsx/mjs/mts/cjs/html 里逐个搜的结果。这些规则只是测试和文档里的字碰巧像类名生成出来的，界面没有元素用它们，可以接受。
- Agent 新写的卡片落在 `src/cards/` 下，仍在扫描范围内；卡片编写指南说的「Tailwind 自带 4 个动画」（spin 等）照样按需生成，只是不再因为测试文件里出现过而预先带着。

## 重载对照

临时探针（没入库，放在会话 scratchpad 的 `tw/tw-reload-probe.mjs`）：puppeteer 打开 `http://127.0.0.1:5680/`，在 `window` 上打标记、监听主框架导航，每步改一个文件后等 4 秒看标记还在不在；最后给 `src/StartPage.tsx` 的 `sp-bar-spacer` 加 `bg-[#123457]`，轮询元素类名、样式表里是否出现该规则和计算后的背景色，然后还原。开发服务都在工作区里用 `npx vite --port 5680 --strictPort --host 127.0.0.1` 起。

| 步骤 | 改前（`src/index.css` 临时换回 main 的） | 改后 |
|---|---|---|
| `docs/semantics/glossary.md` 原样重写 | 整页重载 | 未重载 |
| `out/tw-probe.txt` 写入 | 未重载 | 未重载 |
| `server/README.md` 原样重写 | 整页重载 | 未重载 |
| `tools/api-share-gui/Cargo.toml` 原样重写 | 整页重载 | 未重载 |
| `server/test/fixtures/voices.json` 原样重写 | 未重载 | 未重载 |
| `src/StartPage.tsx` 加 `bg-[#123457]` | 热更新，未重载，背景 `rgb(18, 52, 87)` | 热更新，未重载，背景 `rgb(18, 52, 87)` |

- 改前服务端日志里 `reload` 出现 0 次，与接手一节的「不打日志」一致。
- `out/` 改前也不重载：它被 `.gitignore` 忽略、不在扫描里，而且 `server.watch.ignored` 本来就忽略它。`.json` 改前也不重载：模块图里已有 `.json` 模块，插件对这个扩展名放过。第一版探针还试过 `python/` 下的 `.py`，改前改后都不重载，原因是 watcher 忽略 `python/`，所以换成了 `server/README.md` 和 `Cargo.toml`。

## 验证

