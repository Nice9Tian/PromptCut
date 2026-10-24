# 验证证据：render-host 等就绪超时那条路漏了收尾

分支 `claude/render-host-sweep`。机器：本机 PC（Windows 11）+ 云节点 149.88.94.84（Linux）。日期 2026-10-24。

## 事故与根因

云端 Agent 在项目 `sp_gxmnxgw5j6qgstffwglr2tlyih` 第 2 轮里 5 次 `see_frames` 看时间轴画面、1 次 `render_card_audio` 全败，码是 `iso-failed`（`server/hosted-render/look.mjs:355`，隔离工作进程重试超过 `isoRetries` 次）。

链条（节点日志逐条对上）：

1. `scripts/render-host.mjs` 的等就绪超时那条路（240 秒）只做了 `killTree()` 就 `process.exit(1)`，**漏了 `sweepTree()`**。
2. `killTree` 只发给编辑器那一个进程组，而预渲染进程与它的 Chrome 各自是进程组的组长（`server/hosted-render/worker.mjs` 的注释写明了这一点，`sweepTree` 就是为此存在的），收不到信号。
3. 于是每起一次工作进程留下 14 个 Chrome。从 2026-10-23 22:18 起每 4 分钟一轮，攒到 **414 个**，占掉 **107 个 inotify 实例**（`fs.inotify.max_user_instances` 是 128）。
4. 下一个 Vite 建文件监听时 `inotify_init()` 回 EMFILE：`Error: EMFILE: too many open files, watch '…/server/frame-code.mjs'` → 编辑器进程退出 → 工作进程永远等不到就绪 → 240 秒超时 → 再漏 14 个。自我维持的循环，重启了 63 次。
5. 另外漏了 164 个 puppeteer profile 目录和一个 9.5 GB 的 node 编译缓存，磁盘到 76%。

## 改了什么

`scripts/render-host.mjs`：抽出 `finishTree()`（结束进程组 + 按记号清逃出去的后代），收到停止信号和等就绪超时两条路都走它；编辑器自己挂了那条路本来就有 `sweepTree()`，保持原样（它是同步的，紧接着 `process.exit(1)`）。文件头的退出说明补上第三条路。

## 测试

新增 `server/test/render-host-sweep.test.mjs`：

| 用例 | 验什么 | 结果 |
|---|---|---|
| RHS1 | 收尾两步都做，且编辑器赖着不走时照样 sweep | 通过 |
| RHS2 | 编辑器痛快退出时不白等满 waitMs | 通过 |
| RHS3 | 源码里三条退出路径**都**落到收尾 | 通过 |
| RHS4 | 真起一个带记号、自成进程组的孤儿，收尾后它没了 | 本机 Windows 上跳过（那边 `killTree` 用 `taskkill /T` 带走整棵树，不走记号这条路）。它要在 Linux 上才有意义，部署后在云节点上真跑一遍，结果记在 `docs/local.md` |

**RHS3 是真能拦住这个 bug 的**：把修复临时退回去（`not-ready` 那行改回只 `killTree()`）再跑，RHS3 当场红；改回来就绿。

| 命令 | 结果 |
|---|---|
| `npm test -- server/test/render-host-sweep.test.mjs server/test/render-host.test.mjs server/test/render-host-contract.test.mjs server/test/hosted-render-process.test.mjs` | 45 通过 / 1 跳过（RHS4，Windows）/ 0 失败 |
| `npx tsc -b --force` | 退出码 0 |
| `npm run build` | 成功 |

影响范围怎么算：改的文件自己的测试，加上另外三支跑 render-host 与工作进程树管理的测试。

## 节点上的止血与验证

1. `fs.inotify.max_user_instances` 128 → 1024，写进 `/etc/sysctl.d/91-promptcut-inotify.conf`（兜底，不是根治）。
2. 停渲染服务 → 杀掉 401 个泄漏的 `chrome-headless-shell`（只认 `/opt/promptcut-render/releases/` 这条路径，没碰 Agent 的浏览器）→ 删掉 164 个残留 profile 与 9.5 GB 的 node 编译缓存。inotify 占用 131 → 23，磁盘 76% → 50%。
3. 重启渲染服务：`[render-host] ready`，隔离工作进程 `isolation.ready startMs: 25008`，`look.done … status:200, ok:true, worker:"isolated"`。
4. 真跑一轮：在项目里让云端 Agent 调一次 `see_frames` 看时间轴第 5 秒，`✓查看 · see_frames`，它答「第 5 秒画面中央是你那张户型图，略微逆时针倾斜，摆在深藏青色的暗角背景上，一道金色扫描线正横着扫过图的中部，图下方有一行很小、很淡的『原始户型图 · 扫描校正』字样」——确实出了图。

节点上的操作记录写在 `docs/local.md`（不入库）。
