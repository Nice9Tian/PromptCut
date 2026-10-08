# 云端 Agent 剩余工具实施拆包记录

工作树 `codex/018-cloud-tools-plan`，基底 `bb0266fafe5f66e27d8c53000b2340f10f139780`。本叶只写新工程实施计划与本报告，不改工具源码、coverage 索引、用户语义、main 或节点。目标是把已拍板的 0.7.18 云端工具缺口拆成可并行、文件独占、可验证的小包，供根会话审读后派发。

已完成只读审读：`three-versions-018-design.md` 的工具逐名表与 19 包租约、`cloud-agent-task.md`/`account-binding-task.md` 与渲染补充中的最新拍板、`cloud-agent-tool-coverage.md` 的 23 pending + 其它缺口、`cloud-tools.mjs`/`account-runner.mjs`/`instance.mjs`、现有 Hosted collect/asset/look 接口、桌面 `server/vite-plugin-{stt,shots,track,subject}.ts`、`server/tools/{ai,browser,vision}.mjs`、`src/ai/cloud/pageRequests.ts`，及四个 `python/promptcut_*` CLI 文件。没有读取密钥值、安装依赖或运行服务。

交付 [云端 Agent 剩余工具实施拆包](../../plan/cloud-agent-tools-implementation.md)：先定义可信 `ToolRunContext`、项目素材、持久作业、fence/cancel/close 共用接口；F0 基础包后以 P1 镜头识别与 `see_frames(source:media)` 成对贯通为最小真实能力链。P2–P4 感知、P5 workflow、P6 audio JS、W1 隔离 web7、W2 本人页面反向通道、C1 本机采集代下、V1 `get_gif` 用户可视记录、D 桌面薄壳和 G 最后中央接线均给出独占文件、依赖、实际产物与账号版验收。工程接口是建议，未被写成用户逐字段拍板。

边界保持：已有 Hosted 20 个工具的可达性及旧测试不代表 account-v2 验收；此前全员选区 `3f17b10a` 的真实 doc＋模拟模型证明不能推作生产实例/mTLS 完成。`spawn_agent` 三版本关闭，用户卡外链正常。RS18 单活跃、RS19 有条件双项目、RS20 磁盘交替至少三项目、全生产场景自定义卡与 `see_frames` 端到端低于五分钟优先目标均单列；五分钟内提前让位、补渲故障 A/B、删除细节仍未决，未代用户裁定。

本叶为文档设计，未运行 type、target、full、probe，也未改 coverage 索引或任何源码。交付前仅做 Markdown 路径/关键词与 `git diff --check` 检查；源码和生产验收状态保持 pending，由根按依赖派实施。
