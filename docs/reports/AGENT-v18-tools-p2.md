# AGENT-v18-tools-p2：云端 Agent 工具包 P2（语音转写）

分支 `claude/v18-tools-p2`，从 main `d7075a58` 分出。任务来源：`docs/plan/cloud-agent-tools-implementation.md` 工具拆包表 P2 一行。

状态：进行中（开工提交；下面各节随提交补全）。

## 范围

P2 一行要求的工具：`stt_status`、`stt_install`、`transcribe_media`（现有的 `get_transcript` 读项目副本里的 `media.transcript`，不在这一包里改）。

独占文件：`server/agent/service/perception/stt.mjs`、`python/promptcut_stt/`、`server/test/cloud-tools-p2*.test.mjs`、`scripts/probes/cloud-tools-p2*.mjs`、本报告。
不碰：F0 三个模块（只调用）、`server/vite-plugin-stt.ts`（归 D 包）、`cloud-tools.mjs` 工具表和所有中央接线文件（归 G 包）。

## 进度

- [ ] Python 侧
- [ ] stt.mjs
- [ ] 单测
- [ ] 真实素材探针
- [ ] 基线（tsc、npm test）
