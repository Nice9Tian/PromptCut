# ready-index G0-R 修复报告

分支：`claude/fix-ready-index`，基线：`2e75bec`。

## 根因与复现

探针第 ⑨ 步先向编辑器写四条成本记录，确认预渲染进程读到记录，再用新会话对同一内容键发 `preload`。它在 180 秒内等待诊断里的 `clip-stateful.picked === false`，随后检查这张轻卡既不进 HTML 就绪层，也不再生成快照目录。探针的判定和超时均未改。

main 上同一命令 `node scripts/probes/ready-index-probe.mjs --port 5530` 连续两次分别退出 0、1。失败轮的原始结果为：

```text
"count": 4,
"added": 4,
"updated": 0
"planAfter": null
"超时:按新 costs 重算出的预渲染集合",
```

失败时直接查询预渲染进程，`GET /api/data/costs?device=r6-probe-device` 已返回 4 条，与诊断中四张卡的 `costKey` 都匹配；按相同输入调用 `prerenderSetOfPlan` 得到 `clip-canvas,clip-huge,clip-unknown`，而进程里的旧集合仍含 `clip-stateful`。当时旧会话的整帧 MOV / 视频后台任务还在产帧。`FramePipeline.preload` 把新会话的 `adoptCardPlan` 排在同一条 `this.background` 串行链后面，成本虽已到达，集合却必须等长任务结束才重算；快慢不同使它偶发越过 180 秒。

第一次将重算提前后，探针进一步捕捉到旧批次已持有 `target`，在撤层之后还能重新写出轻卡目录；原始失败行为是 `"statefulDirBack": true`。因此还需要在快照收集、提交以及层发布前检查当前集合。

## 提交范围对比

按任务要求对比 `d9b62e8`（M6c 集成）与 `685756a`（SP 合并）：

```text
git diff --quiet d9b62e8 685756a -- server/frame-pipeline.mjs server/ready-index.mjs server/prerender-set.mjs server/vite-plugin-costs.ts server/vite-plugin-prerender.ts scripts/probes/ready-index-probe.mjs
relevant-diff-exit=0
```

这段历史中，SP 的服务端改动集中在托管、认证、发现、文档服务、素材服务及 Vite 绑定；上述第 ⑨ 步成本重算与预渲染串行路径没有改动。M6c 集成报告记有一次 G0-R 通过，main 本次又出现一过一败，说明单次通过不足以排除该时序竞争。没有证据将这个潜伏问题归因于 SP 的具体代码改动，因此没有对非确定性结果执行 git bisect。

## 改动

- `server/frame-pipeline.mjs`：已有 card plan 的新 preload 在认领会话前，用最新成本重算集合；旧后台批次在收集、提交快照和发布就绪层前重新检查卡是否仍在集合中。
- `server/test/prerender-costs-root.test.mjs`：用一个停在 `acquire` 的旧后台任务验证新会话不必等它完成就能看到新成本。

## C6.5 已知缺陷

按任务约定跳过。`docs/plan/c65-design.md` 仍将 Agent 直接写文档服务列为待落地设计；`git ls-tree -r --name-only HEAD server/agent` 没有输出。main 上没有 C6.5 的服务端 Agent 写入和 `expectRev` 路径，所述“页面补写总时长使下一次 Agent 写入 stale”不在本分支代码中。

## 验证原始结果行

验证编辑器由本 worktree 启动在 `127.0.0.1:5533`，舞台端口为 `5534/5535`。探针自己的编辑器使用 `5530`。

```text
node --test server/test/prerender-costs-root.test.mjs server/test/ready-index.test.mjs
ℹ tests 13
ℹ pass 13
ℹ fail 0

npx tsc -b --force
exit_code: 0 （无诊断输出）

npm test
ℹ tests 2760
ℹ pass 2759
ℹ fail 0
ℹ skipped 1
exit_code: 0

node scripts/probes/ready-index-probe.mjs --port 5530  # 修复后第 1 次
"statefulDirBack": false,
"canvasDir": true,
"fails": []
exit_code: 0

node scripts/probes/ready-index-probe.mjs --port 5530  # 修复后第 2 次
"statefulDirBack": false,
"canvasDir": true,
"fails": []
exit_code: 0

node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5533
"beats": 275,
"transparentBeats": 0,
"placeholderDelay": 27,
"pageErrors": [],
"fails": [],
"notes": []
PASS
exit_code: 0

node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5533 --page-preload
"beats": 277,
"transparentBeats": 0,
"placeholderDelay": 25,
"pageErrors": [],
"fails": [],
"notes": []
PASS
exit_code: 0

$env:PC_FRAME_TEST_URL='http://127.0.0.1:5533'; node scripts/verify-unified-frames.mjs
PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.
exit_code: 0

node scripts/verify-determinism.mjs --url "http://127.0.0.1:5533/?export=1"
Total Frames: 1800
Identical: 1800
Different: 0
All frames are identical. Determinism verified!
exit_code: 0
```
