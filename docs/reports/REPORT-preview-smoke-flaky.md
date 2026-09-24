# Editor preview smoke 偶发失败排障报告

## 范围与环境

- 工作树及分支：`claude/fix-preview-smoke-flaky`；没有修改主工作区、main，也没有暂存或提交。
- 按 `AGENTS.md` 依次阅读了开发指南索引、`suggested_agent_behavior.md`、`constraints.md`、`verification.md`、`multi_agent.md`、`rendering.md`、`cards.md`。
- 开发服务器命令：`npx vite --port 5240 --strictPort --host 127.0.0.1`。实际输出：`VITE v8.2.2 ready`，`Local: http://127.0.0.1:5240/`，舞台端口 `5241 / 5242`。首次沙箱内启动因原生模块读取及子进程 `spawn EPERM` 失败，提权后在本工作树启动成功。最后确认监听 PID 42376 的父进程链通向本次启动的 PID 32300，仅结束 PID 42376；`netstat` 确认 5240～5242 已无监听。

## 根因与证据

**这是探针采样竞态，不是播放器在停稳后仍领先 store 的同步故障。** `actions.pause()` 只同步把 `store.playing` 改为 `false`；播放器随后在 `Preview.tsx` 的 effect 中异步给舞台发 `pause()`，以回包的 `stoppedAt` 更新 `store.t` 并调用 `setTime(..., { settle: true })`。旧探针紧接 `actions.pause()` 读取 `store.t`，之后才跨进程读取舞台 DOM；这两个数来自不同的拍。`rendering.md` 规定舞台逐帧报告时刻、编辑界面播放头跟随舞台，因而应以停拍后的舞台时刻检验。

- 自然基线命令 `node scripts/probes/editor-preview-smoke.mjs --origin http://127.0.0.1:5240` 连续 10 次：**0/10 失败**，但 10 次均有 `store.t=1.5`（第 45 帧）、舞台 `[46,46]` 的同方向一帧偏差，已触及原判据容差边缘。
- 诊断插桩在 `actions.pause()` 后仅阻塞父页 130 ms，舞台仍独立运行；旧判据连续 **3/3 失败**。三次采样均为 `store.t=1.5`、舞台 `[49,49]`，`swapInFlight=true`。其后等舞台暂停 RPC，得到 `stoppedAt=1.6666666667 / 1.6666666667 / 1.6333333333`，store 分别自然更新到相同值，舞台帧分别为 `[50,50] / [50,50] / [49,49]`。诊断输出留在 `out/preview-smoke-stress-*.json` 与 `out/preview-smoke-stress-summary.txt`（忽略目录）。诊断插桩已移除。
- 未在本机自然运行中复现题述的精确数值 `1.3 / [41,41]`；插桩复现了相同方向、相同 `swapInFlight` 状态且超过 ±1 帧的失败，并证实停稳后两侧收敛。
- `git blame` 指向 `b5c65dca` 引入原始暂停后立即断言，`2d73576` 将原先同页一次读取改为先读父页 `playT`、再通过 Puppeteer 读跨源舞台帧，扩大了采样窗口；`3cd1749` 让无参数探针检验当时已切换的缺省双舞台，普通运行遂经过此路径。R8 合并 `787f7d9`、R9 合并 `eff2011` 可能改变负载和时间窗口，但这次复现无需它们的渲染修改。已有确定的因果复现和停稳后的对账，未做 bisect，因此也没有进入需要 `git bisect reset` 的状态。

## 修改

- 仅修改 `scripts/probes/editor-preview-smoke.mjs`：stage 模式播放 1 秒后只调用应用的 `actions.pause()`。探针不向舞台发送暂停 RPC；它等待播放器自行停拍，读取父页状态、舞台诊断与本地帧、再读父页状态。仅当前后父页时刻和 front 身份一致、舞台已停且 `beatLastSec === store.t` 时接受样本。10 秒内不收敛就失败。legacy 模式沿用原有读取方式。
- 原来的本地帧误差容差仍为 ±1；没有放宽容差。若播放器漏停、停在错误时刻或帧不跟随时刻，探针仍失败。该判据对应 `rendering.md` 的「按帧走，慢帧就等」「播放头跟随舞台」「停下就精确」。没有修改渲染或快照路径。

## 验证

### 修复前自然基线

命令：`node scripts/probes/editor-preview-smoke.mjs --origin http://127.0.0.1:5240`，连续 10 次。各次输出结论行中的 `fails=[]`；完整输出在 `out/preview-smoke-baseline-*.json`。
此前有两次无效环境尝试：输出目录 `out` 尚不存在时无法保存结果；未提权运行 Puppeteer 时退出码 1、`spawn EPERM`。两者未计入基线；创建输出目录并提权后才开始表中的连续 10 次。

| 次数 | 退出码 | `store.t` | 舞台帧 | 结论 |
|---:|---:|---:|---|---|
| 1 | 0 | 1.5 | 46,46 | PASS |
| 2 | 0 | 1.5 | 46,46 | PASS |
| 3 | 0 | 1.5 | 46,46 | PASS |
| 4 | 0 | 1.5 | 46,46 | PASS |
| 5 | 0 | 1.5 | 46,46 | PASS |
| 6 | 0 | 1.5 | 46,46 | PASS |
| 7 | 0 | 1.5 | 46,46 | PASS |
| 8 | 0 | 1.5 | 46,46 | PASS |
| 9 | 0 | 1.5 | 46,46 | PASS |
| 10 | 0 | 1.5 | 46,46 | PASS |

诊断命令：同一探针临时加 `--stress-pause-race`，各次退出码均为 1，失败结论均为 `after 1s of playback the stage local frame follows store.t`；`store.t=1.5`、舞台帧 `49,49`。暂停后对账：第 1 次 `stoppedAt=1.6666666667`、store 同值、帧 `50,50`；第 2 次同值和同帧；第 3 次 `stoppedAt=1.6333333333`、store 同值、帧 `49,49`。该临时开关不在最终文件中。

### 修复后正式压力运行

命令：`node scripts/probes/editor-preview-smoke.mjs --origin http://127.0.0.1:5240`，最终只读采样版本连续 10 次。全部退出码 0、`fails=[]`；暂停瞬间 `atPause=1.5`，收敛后 `store.t=stoppedAt=1.5333333333333334`、帧 `46,46`。逐次完整输出在 `out/preview-smoke-final-*.json`。

| 次数 | 退出码 | 结论行 |
|---:|---:|---|
| 1 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |
| 2 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |
| 3 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |
| 4 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |
| 5 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |
| 6 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |
| 7 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |
| 8 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |
| 9 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |
| 10 | 0 | PASS；`atPause=1.5, t=stoppedAt=1.5333333333333334, frames=46,46, fails=[]` |

### 基线命令

- `npx tsc -b --force`：退出码 0，零错误、无输出。
- `npm test`：首次在沙箱中因子进程 `spawn EPERM` 失败，提权重跑退出码 0；输出末尾 `tests 1795`、`pass 1794`、`fail 0`、`skipped 1`。
- `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5240/?export=1"`：退出码 0。输出：两次导出各 1800 帧；`Total Frames: 1800`、`Identical: 1800`、`Different: 0`、`All frames are identical. Determinism verified!`。
- `node scripts/verify-unified-frames.mjs`：未运行。本次只修改探针，不涉及快照、预渲染或渲染路径，按 `verification.md` 无需运行。
- 最终代码上的 `npx tsc -b --force` 再次退出码 0，零错误；`npm test` 再次退出码 0，`tests 1795`、`pass 1794`、`fail 0`、`skipped 1`。`node --check scripts/probes/editor-preview-smoke.mjs` 退出码 0；`git diff --check` 无空白错误。

## 未完成事项与建议

- 无剩余未完成项。未做 bisect 和 `verify-unified-frames.mjs` 的原因见上文。未新增依赖、未安装软件、未暂存或提交。
- 建议在探针开发说明中写明：跨进程比较播放头和舞台帧时，先等待播放器停拍，并确认父页时刻和 front 身份在采样前后不变；不需要修改产品语义。
