# restructure_planning

渲染管线重整的全部计划文档都在这个文件夹里（2026-09-22 从仓库根和 `docs/` 集中过来）。**总入口是 `render_pipeline_restructure.md`**（只放计划本身）；**做了什么、没做什么、验到了什么在 `render_pipeline_restructure_check.md`**，章节和总入口一一对应；各步的协议全文、实测报告和过程材料在它们旁边。旧任务书 `AGY-TASK-cloud-doc-and-write-race.md` 已在 2026-09-22 整体舍弃，还有价值的内容都在下面这几份里。

- `r2-r7-task.md`：R2～R7 六步的协议全文（约 150 KB），自成一体。由任务书第 111 版的对应节折进第 75 轮的处理意见和 2026-09-22 的几条决定而成；**折叠稿还没经过独立审查**，文首写了读法、路径表和六步各读哪几节。
- `r8-streams-task.md`：R8 轨道流的协议全文（旧任务书目标 G + 第 75 轮意见）。编码原型（`g0-b-stream-prototype.md`）的结论已回填。未经独立审查。
- `r9-webgl-task.md`：R9 共享 WebGL 渲染器的协议全文（旧任务书目标 M + 第 75 轮意见；粒子卡不迁、位图换 webp 搁置、像素映射的上下文并进来）。未经独立审查。
- `cloud-task.md`：云端 / 文档服务那一半（旧任务书第 5～10 步：素材上云、快照上云、卡片源码同步、改动竞态、Agent 直写文档服务、离线与模式切换、Agent 的只查询进程、在线浏览器模式）的协议全文，文末列了 6 个要定的问题。未经独立审查。
- `landed-notes.md`：已落地那几步在旧任务书里留下的验收口径和「不做」条目，原文照录。
- `future_planning.md`：以后再做的事（第 1 条：桌面版给只有原片的云端素材补转小版）。
- `g0-a-webview2-probe.md` / `g0-b-stream-prototype.md`：桌面壳探针（硬解、毛玻璃、进程隔离）和轨道流编码原型的实测报告。
- `r75/agy-r75-NN.md`：第 75 轮十份分步审查报告（2026-09-19，每份只审一步；1～6 号是执行者走查加行号核对，7～10 号是设计级）。报告里的任务书行号指的是 `AGY-TASK-cloud-doc-and-write-race.md` 第 111 版，源码行号指的是提交 `b5c65dc`——解耦之后一部分已经过期。
- `r75/fold-notes.md`：主会话对这十份报告和三项实测逐条的处理意见（采纳 / 不采纳 / 改哪一句）。`restructure_planning/render_pipeline_restructure.md` 第 3 节是它的摘要；云端 / 文档服务那一半的结论只在这里有。
- `r75/a0-acceptance.md`：能力审计两条验收的补核结果（89 张卡 `unknown` 为 0；5 份旧 `.proc` 都能打开）。
