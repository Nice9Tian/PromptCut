# AGENT 报告：rr-g0r-probes（G0-R 探针适配、渲染重构全量收尾验证与归档）

- **子 Agent 标识**：`rr-g0r-probes`
- **执行模型**：Argon High (`pro`)
- **唯一工作区**：`C:\Users\admin\Documents\PromptCut\.worktrees\rr-g0r-probes`
- **工作分支**：`gemini/rr-g0r-probes`
- **基准提交**：`ce8070ac`（`main` 最新提交，已合入 `rr-rm-snap-server` 渲染重构全部功能项）
- **依据**：任务指令、`render-018-kickoff-other-agents.md` 第 3 节、`docs/plan/render-refactor-progress.md`、`docs/plan/render-refactor-task.md`、`docs/archive/render-refactor/merged-evidence.md`、`user-decisions-2026-10-13.md`、`user-decisions-2026-10-14.md`
- **专属端口段**：`20010–20019`（实际使用 20010 启动隔离 dev server，20011–20012 为关联舞台端口，20015 用于 ready-index 探针）

---

## 1. 任务完成概况

1. **更新 `scripts/probes/preview-fallback-probe.mjs` 适配己二与己三乙**：
   - 移除已废弃的每张卡 HTML 快照覆盖度断言（原 154 行 `layers.html` 检查），改为纯流层等待断言：`if (!layers?.stream || covered(layers.stream, segCount) < segCount) return null;`。
   - 适配己三乙（`d92bcab8`）同屏流像素预算新规则：同屏 6 条以内放行，第 7 条起看像素预算（上限 32 条），超出预算的流平面带 `over: true` 发给舞台（舞台不建解码器 `tracks`，只用于占位符矩形布局）；将原先死板的 `planes <= 6 && tracks <= 6` 断言更新为 `out.overBudget.planesWithin === out.overBudget.tracks && out.overBudget.tracks <= 32`。

2. **更新 `scripts/probes/ready-index-probe.mjs` 适配己二撤快照新契约**：
   - 移除已废弃的 `snapshotPick.mjs` 引用、HTML 选帧（旧 ④）、DOM 快照超限（旧 ⑤）及快照批提前（旧 ⑧）步骤。
   - 全面转为验证 `stream` 层：
     - ① SSE 第一条为 `reset`，随后收到 `done` 及各重卡（`clip-stateful`、`clip-canvas`、`clip-unknown`、`clip-huge`）的 `stream` 层；
     - ② `stream` 层的 `ranges` 随分段生产增长（从 `[[0,0]]` 增至 `[[0,3]]`）；
     - ③ `GET /api/frames/stream/${statefulLayer.key}/manifest` 读到的清单 JSON 与磁盘 `streams/<key>/stream.json` 经 `publicManifest` 对齐后 100% 逐字段相同；
     - ⑥ `clip-unknown` 带有 `streamKind === 'below'` 标记（依赖下层的流），`clip-stateful` 与 `clip-canvas` 处于单卡 `stream` 层；断言帧库根目录下严禁生成 `controls-html` 与 `controls-local` 目录；
     - ⑦ 模拟杀掉预渲染进程（`kill`）并自动恢复拉起后，无需前端重发 `preload`，服务端重放会话版本先发 `reset(localRev: 1)` 再通过 `streamProducer().rescan()` 重建全部 `stream` 层；
     - ⑨ pinned 渲染 9：重算成本后判轻的卡掉出 `prerenderSet`，等待生产者状态与编码器完成清退后删掉其 `streams/<key>` 目录，重跑第三版预渲染时，判重的 `clip-canvas` 流目录完好存在，判轻的 `clip-stateful` 流目录不长回来且不进就绪索引；
     - ⑩ 验证环境指纹进结果键：`diagnostics.environment.fingerprint` 是 16 位十六进制，`snapshotKey === resultKeyOf(contentKey, envFingerprint)`。

3. **G0-R 渲染重构全量收尾验证实跑 100% 通过**：
   - 所有测试均在专有端口段（`20010–20019`）及指定环境变量配置下静默执行，8 项长套件及端到端探针全部以退出码 0 通过。
   - 240 帧导出基线与开工前基线 `A-89c15177\frames` 达成 **240/240 逐字节完全相同**！
   - 验证完成后已优雅终止端口 `20010` 的开发服务器后台任务，确认端口段无任何监听残留。

4. **总结报告撰写与报告归档**：
   - 撰写完整的渲染重构最终报告 `docs/reports/REPORT-render-refactor.md`。
   - 将全部 `docs/reports/AGENT-rr-*.md` 移入 `docs/archive/agent-reports/`。
   - 运行 `eol-audit.mjs` 确认换行符 0 翻转。

---

## 2. G0-R 验证实跑数据与记录

| 验证项 | 运行命令 | 退出码 | 关键结果与指标 |
|---|---|:---:|---|
| **就绪索引探针** | `node scripts/probes/ready-index-probe.mjs --port 20015` | `0` | `fails: []`，`sameJson: true`，`statefulDirBack: false`，`canvasDir: true`，7 项断言全部 PASS |
| **预览兜底探针** | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:20010` | `0` | `PASS`，起播、跳转、超6路流、编辑后 4 场景全过，`planes: 7, tracks: 7 <= 32` |
| **预览兜底（页面预加载模式）** | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:20010 --page-preload` | `0` | `PASS`，4 场景全过，`dense: 673, placeholder: 499`，taskP90 `10.153 ms` |
| **轨道流生产探针** | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:20010` | `0` | `PASS`，全部分段满密度耗时 `24.5s`，alpha 平均误差 `0.0957/255`，旧分段清理 `oldGone: true` |
| **轨道流生产（并组流模式）** | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:20010 --group` | `0` | `PASS`，10 分段并组流产出完成，群组卡片内容颜色隔离正常（`blue: 29509, particles: 1993`） |
| **整帧管线统一验证** | `$env:PC_FRAME_TEST_URL="http://127.0.0.1:20010"; node scripts/verify-unified-frames.mjs` | `0` | `PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A` |
| **导出确定性验证** | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:20010/?export=1" --frames 0-239` | `0` | `Total Frames: 240, Identical: 240, Different: 0. Determinism verified!` |
| **全长像素基线比对** | `node scripts/probes/export-baseline-compare.mjs run --origin http://127.0.0.1:20010 --project "..." --out out/baseline-eval --baseline "...\A-89c15177\frames"` | `0` | **`逐字节:相同 240/240`**，**`✅ 全长导出逐字节相同`** |

---

## 3. 文件修改与归档变更

- 修改文件：
  - `scripts/probes/preview-fallback-probe.mjs`
  - `scripts/probes/ready-index-probe.mjs`
- 新建文件：
  - `docs/reports/REPORT-render-refactor.md`
  - `docs/reports/AGENT-rr-g0r-probes.md`（并连同全部 `AGENT-rr-*.md` 归档）
- 归档操作：
  - `git mv docs/reports/AGENT-rr-*.md docs/archive/agent-reports/`
