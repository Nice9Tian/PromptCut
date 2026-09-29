# AGENT 报告：storage-leaks

分支 `claude/storage-leaks`，起点 main `e3a5726a`。任务：`docs/plan/storage-plan.md` 的 A 部分（泄漏修复，三级缺陷，不改语义）。没有改 `docs/semantics/`。

## 做了什么

新模块 `server/storage-leftovers.mjs`（遗留形态的识别与删除、导出中间文件、导出目录命名），其余按任务书逐条：

| # | 遗留 | 改法 | 文件 |
|---|---|---|---|
| 1 | `mov\playback-<uuid>.mov` | 改名 `playback-<pid>-<uuid>.mov`；`PlaybackMovStore.dispose()` 关文件并删；会话结束（`close`）、换到另一版（另一个 entry）、`FramePipeline.close()` 时删；正常退出时 `process.once('exit')` 同步删；强杀的由启动清理按 pid 删。旧版不带 pid 的 `playback-<uuid>.mov` 超过 1 小时没动就删 | `server/frame-mov.mjs`、`server/frame-pipeline.mjs` |
| 2 | `mov\full-<pid>.tmp.mov` | `MovFrameStore.suspend()` 中止后删临时 MOV；`streamPngVideo().abort()` 等 ffmpeg 退出后删输出文件（导出分片、流式透明层也因此中止即删）；启动清理删死 pid 的（整场景与 `controls\<键>\mov\` 两处） | `server/frame-mov.mjs`、`server/bakery/ffmpeg.mjs` |
| 3 | `html-cache\live-<pid>-*` | 启动清理删死 pid 的 | `server/frame-pipeline.mjs`（发起）、`server/storage-leftovers.mjs` |
| 4 | `preview-<pid>.tmp.mp4` | `tracks\<键>\` 与 `<键>\` 两处：出错路径原本就删，补上复制那一步的出错删除、`abort` 抛错不再盖掉原错误；启动清理删死 pid 的 | `server/frame-pipeline.mjs` |
| 5 | 导出中间文件 | `/api/export` 的渲染子进程退出后（成功、取消、失败都做），先收拾目录再报状态：顶层除 `preview.mp4`、`overlay.mov`、`project.json` 以外全删；删不掉（孙进程还占着）隔 1～4 秒重试 4 轮；`--no-video` 的导出把 `frames` 当产物留下。分片合并成 `overlay.mov` 后立刻删 `parts\`（命令行导出也受益）。同一秒两次导出不再复用目录：`export-<时刻>` 被占就用 `-2`、`-3`…（不带 recursive 的 mkdir 占位，并发也不撞） | `server/vite-plugin-export.ts`、`server/bakery/export-unified.mjs`、`server/storage-leftovers.mjs` |
| 6 | `export-vision-<pid>-*` | 删除改成等删完、失败退避重试 5 次，还不行记日志；dev server 起来时清死 pid 的 | `server/vision/render.ts`、`server/vite-plugin-export.ts` |
| 7 | 导出对话框文案 | 完成：「视频已保存。只含卡片的透明层（overlay.mov）在产物目录里。」；已停止：「渲染已停止。中间文件已清掉；重新导出会另建一个产物目录。」 | `src/editor/ExportDialog.tsx` |
| 8 | 启动清理放哪、怎么判 pid | 帧库：`FramePipeline` 构造时，只对名为 `frame-library` 的根、每进程每根一次，不等（编辑器进程与预渲染进程各做一遍，只删死 pid 的，互不干扰）。导出目录：`exportPlugin` 的 `configureServer`。pid 死活：`process.kill(pid, 0)`，ESRCH 为死，EPERM 与其它错误按活（Windows、Linux 同一套）；本进程恒为活。只认 64 位十六进制键目录下的上述文件名；符号链接、junction（含目录里藏着的）整条跳过；删不掉的跳过并记日志 | `server/storage-leftovers.mjs` |

## 提交

- `73161381` 报告：开工
- `20786690` 泄漏修复主体
- `0f984b2b` `claimExportDir` 挪进 `storage-leftovers.mjs`；单测
- `c9c00317` 视觉临时导出的删除改成 `render.ts` 内的退避重试
- `46db4363` 报告与 `storage-leftovers.mjs` 文件头

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出 0 |
| 新单测 | `node --test server/test/storage-leftovers.test.mjs` | 11/11 过（遗留形态只清该清的、链接跳过、导出成功只剩三样、取消失败无大块中间文件、同秒并发三次得 `-2`/`-3`、`suspend` 与 `abort` 后临时文件不在、播放 MOV 的换版本/会话结束/关闭三处删、`FramePipeline` 只清真帧库根） |
| 全量测试 | `npm test` | 第一次：3859 过、1 挂（`see-frames-rects.test.mjs`：它把 `render.ts` 转译到临时目录、只替换已知的 import，我新加的 `../storage-leftovers.mjs` 解析不到——真问题，不是负载）。改成 `render.ts` 内联重试后单独重跑 17/17 过；第二次全量 3865 过、0 挂、2 跳过，退出 0 |
| 实导对照 | 起点提交上先导（`export-before`），改后再导（`export-after`），`scratchpad\storage-leaks\run-export.mjs` 用 demo 时间轴拼项目 POST `/api/export` | 三种项目的 `preview.mp4` / `overlay.mov` sha256 改前改后逐字节相同：6 秒单片 `b37ace6c…` / `15a4e207…`；30 秒 workers 4 `5dabb225…` / `5751cecf…`；16 秒有间隔、确实分出 `parts\` 的 `90f79531…` / `78cb9723…`（改前两次导出同 hash，确认确定）。改前目录有 `frames\`（21～88 MB）、`media\`、`parts\`（74 MB）；改后每个目录只有 `overlay.mov`、`preview.mp4`、`project.json` |
| 取件 / 同秒 / 取消 | `run-extra.mjs` | 同时发两次导出得 `20260929-193824` 与 `20260929-193824-2`，都完成、内容相同；完成后经 `/api/export/<id>/file/…` 取件 200，sha256 与盘上一致；30 秒导出渲到第 88 帧取消，状态 `cancelled`，目录只剩 `project.json` |
| 启动清理（真 dev server） | 在临时导出目录里用一个已退出的 pid 造遗留后重启 | 视觉遗留日志「删 1 个」；帧库在第一次 `/api/frames` 请求后：死 pid 的 `full-*.tmp.mov`、`playback-*.mov`、`html-cache\live-*`、`tracks\*\preview-*.tmp.mp4` 全删，`full.mov`、`preview.mp4` 留下。另外把跑完探针的 dev server 连同预渲染进程 `taskkill /T /F`（模拟桌面壳强杀），它留下 11 个 `live-50836-*`，重启后清为 0 |
| G0-R 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5700/?export=1"` | 1800/1800 相同 |
| 像素基线 | `compare-frames.mjs …pc-g0r-base\out\verify-a\frames …storage-leaks\out\verify-a\frames` | total 1800、identical 1800、different 0、missing 0、extra 0 |
| 快照重放 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5700` | PASS（见下「环境」） |
| 就绪索引探针 | `node scripts/probes/ready-index-probe.mjs --port 5703` | 退出 0，`fails: []` |
| 轨道流探针 | `stream-produce-probe --origin http://127.0.0.1:5700`、`--group` | 两次都 PASS，`fails: []` |
| 预览兜底探针 | `preview-fallback-probe --origin http://127.0.0.1:5700`、`--page-preload` | 两次退出 0、PASS，`transparentBeats` 全 0 |

环境：dev server 一律 `PROMPTCUT_NO_PORT_FILE=1`、端口 5700（舞台 5701/5702），就绪索引探针自带 5703；跑完都由我 `taskkill /T` 停掉，结束前确认 5700～5705 无监听、没有指向本 worktree 的 node 进程。实导用 `PROMPTCUT_EXPORT_DIR` 指到 scratch；**G0-R 另起一台不带 `PROMPTCUT_EXPORT_DIR` 的**：`verify-unified-frames.mjs` 把测试视频写进 `<仓库>/out/media` 再经 `/@media/` 读，dev server 的导出目录被改到别处时它 404（第一次这么跑挂在 `Video decode failed`，与改动无关）。

## 没做成 / 没做的

- 帧库的启动清理是「本进程第一次建帧服务时」，不是进程一起来就做：帧服务在第一次 `/api/frames` 请求时才建，而发起点若放到进程启动要改 `server/vite-plugin-frames.ts`（不在清单里）。编辑器一打开项目就会触发，实际差别不大。
- `frame-archive.mjs` 没改：死进程的 `live-*` 由启动清理处理，属主进程自己的照旧由 `dispose` 删。
- 没处理的遗留形态（不在计划里）：`atomic()` 写到一半的 `<文件>.<pid>.<随机>.tmp`、导出目录下的 `.export-staging\media\`（上传了素材但没开始导出时留下）。
- `pc-g0r-base` 只读，没动。用户的 `Videos\PromptCut` 没读没写。

## 对计划的更正建议

1. 第 3.3 节「遗留文件」应补两处形态：`controls\<键>\mov\full-<pid>.tmp.mov`（独立卡的 MOV 也用 `MovFrameStore`）、`<键>\preview-<pid>.tmp.mp4`（整场景目录下也有）。
2. 旧版不带 pid 的 `playback-<uuid>.mov` 按「超过 1 小时没动」删，这是新增的三级数字，语义里该记一笔（`storage-leftovers.mjs` 的 `LEGACY_PLAYBACK_AGE_MS`）。
3. 计划说「启动时与每次淘汰时一并清」：`storage-cap` 做淘汰时直接调 `sweepFrameLibrary(root)` 即可；导出列表 / 「只删中间文件」（`POST /api/exports/<id>/prune`）可直接用 `pruneExportDir(dir)` 与 `EXPORT_KEEP`，目录名的同秒后缀格式是 `export-YYYYMMDD-HHMMSS-<n>`（n 从 2 起），与第 4 节「可带同秒重名后缀」一致。
4. 失败的导出「留已有的成片或透明层」有一处细节：单进程流式写 `overlay.mov` 的路径在渲染出错时，`streamPngVideo().abort()` 现在会把写了一半的 `overlay.mov` 删掉（它本来就不完整）；只有渲完、在合成或混音阶段失败的，透明层才留下。若语义要「失败也总有透明层」，这里要另议。
5. 只有 `/api/export`（界面导出）收拾产物目录；命令行 `npm run export`、`verify-determinism` 这类直接调 `exportFrames` 的不删 `frames\`（验证要用），只在分片合并后删 `parts\`。
6. 任务书让 G0-R 与实导共用一台带 `PROMPTCUT_EXPORT_DIR` 的 dev server；`verify-unified-frames.mjs` 在那种配置下必挂，建议 G0-R 的说明写明「不设 `PROMPTCUT_EXPORT_DIR`」。
