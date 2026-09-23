# PromptCut dev server 冷启动量测（R0）

日期：2026-09-24。工作目录：本 worktree 根目录。量测脚本：`scripts/probes/cold-start-probe.mjs`。

## 口径

- 每轮从启动 `npx vite --port 5270 --strictPort --host 127.0.0.1` 的进程前一刻开始，用 Node `performance.now()` 计时。5271、5272 是它的舞台代理端口；每轮确认三个端口空闲，完成后按启动时记录的 PID 结束自己的进程树。没有使用 5190～5192 或 5203。
- 「首页 HTTP 200」是轮询 `GET /` 首次收到状态码 200 的时刻，记录在响应头到达时。轮询间隔 20 ms。
- 「舞台就绪」是打开 `/?editor&nosetup=1&preview=stage`，按 `editor-preview-smoke.mjs` 的判据先等 `iframe[data-pc="stage-frame"]`，再等 `!!frontStage()`。随后核对两个舞台代理端口都已启动。舞台等待轮询间隔 50 ms。
- Chrome 在每轮计时前启动，且每轮使用新浏览器，避免把 Chrome 启动时间算进 dev server 耗时或复用浏览器缓存。首页首次 200 的请求发生在编辑台导航之前；舞台数字包含这次请求以及随后的编辑台加载和握手。
- 连跑三组「冷 → 热」。冷轮前清缓存，热轮紧随冷轮且保留其缓存；每一轮都重启 dev server。

## 缓存

用 Vite `resolveConfig({}, 'serve')` 在本 worktree 根目录确认，实际 `cacheDir` 是**本 worktree 的** `node_modules/.vite`。依赖虽从上层主仓库解析，Vite 缓存仍写进本 worktree。冷轮只清本 worktree `node_modules` 下名称以 `.vite` 开头的缓存；本次清理到 `.vite`、`.vite-prerender`、`.vite-temp`。主仓库 `node_modules/.vite` 未删除或修改，也未用 `--force`。脚本若在别的环境解析出 worktree 外的缓存，则保留该缓存，冷轮改用 `--force`。

## 结果

单位：毫秒。括号内是启动进程 PID。

| 组 | 冷：HTTP 200 | 冷：舞台就绪 | 热：HTTP 200 | 热：舞台就绪 |
|---|---:|---:|---:|---:|
| 1 | 932.5 (39912) | 4750.4 | 929.3 (25476) | 4573.4 |
| 2 | 938.8 (37660) | 4652.8 | 885.1 (39640) | 4677.0 |
| 3 | 1146.5 (43804) | 4870.3 | 923.4 (43784) | 4626.8 |
| **中位数** | **938.8** | **4750.4** | **923.4** | **4626.8** |

## 验证

- `node scripts/probes/cold-start-probe.mjs`：退出码 0；六轮均取得 HTTP 200、`frontStage()` 就绪，且两个舞台代理端口正常。
- `npx --no-install tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；1718 项中通过 1717、跳过 1、失败 0。
- 测后 5270～5272 无监听进程；`git status --short` 仅显示本报告和新探针两个未跟踪文件。未运行安装命令，未新增依赖，未改运行时代码。
