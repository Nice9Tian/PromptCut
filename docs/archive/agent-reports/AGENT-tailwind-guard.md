# AGENT-tailwind-guard

分支 `claude/tailwind-guard`，工作区 `.worktrees/tailwind-guard`，起点 main `2fa0c1a`，端口段 5830～5839（本任务没起开发服务，没占端口）。

## 任务

M8 遗留 L12（M8 执行计划第 5 节遗留清单第 12 条：Tailwind 扫描范围）：加一条守门测试，列出 `src/`、`server/` 下被 Tailwind 扫描到、后缀不是代码或样式、也没被排除的文件，出现就失败，并在失败信息里说怎么处理。

## 扫描配置的结论

- Tailwind 4（`tailwindcss`、`@tailwindcss/vite` 均为 4.3.3），没有 `tailwind.config.*`，也没有 `postcss.config.*`；配置只在入口样式 `src/index.css`：`@import "tailwindcss";` 没写 `source()`，所以插件以 Vite 的 root（仓库根）为 base 扫全部文件，再减去 19 条 `@source not`（`tailwind-scan` 分支加的：`docs`、`archive`、`python`、`desktop`、`tools`、`scripts`、`server/test`、`out`、`dist`、`data`、`work`、`.worktrees`、`.claude`、`**/*.md`、`**/*.json`、`proto.html`、`*.bat`、`.git`、`.gitattributes`）。扫描器另按 `.gitignore` 跳过忽略的路径。
- `vite.config.ts` 里两处用了 `tailwindcss()`（开发与在线构建、预渲染构建），入口都是同一个 `src/index.css`。
- 读 `@tailwindcss/vite` 的 `dist/index.mjs` 核对过：扫描源 = root 为 null 时 `{ base: Vite root, pattern: "**/*" }`，接上 `compiler.sources`；再 `new Scanner({ sources })`。
- 按同样方式实测当前扫描表：1083 个文件，全部是代码或样式——`src/` 的 tsx 217、ts 281、mts 27、mjs 187、css 41，`server/`（不含 `server/test`）的 tsx 78、ts 39、mjs 209、cjs 1，根目录的 `index.html`、`vite.config.ts`、`vite.prerender.config.ts`。
- `src/`、`server/` 下已跟踪的非代码后缀：json 65、md 16、cmd 2。json 与 md 被 `**/*.json`、`**/*.md` 排除；两个 `.cmd`（`server/test/fake-collect.cmd`、`fake-python.cmd`）在被排除的 `server/test` 里。**现有违例：无**，没改 `src/index.css`，也没挪文件。

## 守门测试

新文件 `src/tailwind-scan.test.mjs`（与 `src/layering.test.mjs` 同处、同写法，`npm test` 的 `src/**/*.test.mjs` 自动带上）：

- 不在测试里另抄一份排除规则：用插件自己用的 `@tailwindcss/node` 的 `compile` 和 `@tailwindcss/oxide` 的 `Scanner`，按插件的方式从 `src/index.css` 算出扫描源，拿真实的扫描文件表。排除表因此只有一处（`src/index.css`）。两个包都是 `@tailwindcss/vite` 已装的依赖，没新增依赖。
- 第 1 条：扫描表里 `src/`、`server/` 下后缀不在白名单（`.ts .tsx .mts .cts .js .jsx .mjs .cjs .css`，即插件只热更新不整页重载的那些）里的文件，出现就失败；失败信息列出文件，并给两种处理：挪出 `src/`、`server/`，或在 `src/index.css` 加 `@source not`。
- 第 2 条（防排过头）：`src/`、`server/`（不含 `server/test`）下所有已跟踪的 `.tsx` 以及 `index.html` 都必须在扫描表里，否则界面类名不会生成样式。
- 和任务书的一处不同：扫描器本身会扫没被 git 忽略的未跟踪文件，所以守门也覆盖它们（新加的文件没提交之前就会报），不只查已跟踪的。
- 耗时：单跑约 0.3 s。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零输出 |
| 全量测试 | `npm test` | 退出码 0；tests 3428、pass 3426、fail 0、skipped 2；新测试两条都过 |
| 加 `src/zz-guard-probe.json` | `node --test src/tailwind-scan.test.mjs` | **仍是绿**（pass 2）：`.json` 被 `@source not "../**/*.json"` 排除，不在扫描表里 |
| 加 `src/zz-guard-probe.txt` | 同上 | 退出码 1，第 1 条失败，信息见下 |
| 删掉临时文件 | 同上 | pass 2、fail 0；`git status` 干净 |
| 临时删掉 `**/*.json` 那行再放 `.json` | 同上 | 第 1 条失败，列出 64 个（63 个已跟踪 json 加探针文件）；已 `git checkout` 还原 |
| 临时加 `@source not "../server/catalog"` | 同上 | 第 2 条失败（「这些 .tsx 被 src/index.css 的 @source not 排除了…」）；已还原 |

`.txt` 探针的失败信息原文：

```
✖ Tailwind 扫描到的 src/、server/ 文件只有代码与样式 (2.835ms)
  AssertionError [ERR_ASSERTION]: Tailwind 会扫描下面 1 个非代码文件，开发服务里改它们会让所有打开的页面静默整页重载：
    src/zz-guard-probe.txt
  处理（二选一）：
    1. 挪走：放到 src/、server/ 以外（文档进 docs/，测试夹具进 server/test/，运行时产物进被 git 忽略的 out/ 或 data/）；
    2. 排除：在 src/index.css 的排除表里加一行 @source not "../<路径或 glob>";（路径相对于 src/index.css）。
    不要为此排除 src/、server/ 下的 .ts/.tsx/.mjs 等源码：界面类名在里面（见本文件下一条检查）。
```

导出确定性、画面探针没跑：只加了一个测试文件，没改运行时代码和样式。

## 对任务书的更正建议

- 任务书的验证步骤「在 `src/` 下加一个 `.json` 临时文件，守门测试变红」按现状做不到：`src/index.css` 早已用 `@source not "../**/*.json"` 排除了所有 JSON，JSON 不会被扫描，也就不会触发重载，守门不该报。改用 `.txt` 验证变红；另外临时去掉 JSON 那行排除，证明 JSON 一旦被扫描也会被拦。
- 守门只查 `src/`、`server/`。根目录和其它顶层目录（例如新建一个不在排除表里的顶层目录并放 `.md` 以外的文件）不在守的范围；需要的话可以再加一条「`src/`、`server/` 以外只许 `index.html` 和两个 vite 配置」的检查，但本机工作区根目录有没跟踪的临时文件时会误报，所以没加，交主会话定。
- 执行计划 L12 那一行的「疑在 `claude/hygiene`」可以改掉：`claude/hygiene` 相对 main 没有提交，L12 由本分支做。
