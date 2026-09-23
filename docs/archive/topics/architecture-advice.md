# 架构演进建议 (Architectural Advice)

基于对 PromptCut 项目核心代码的重构与评估，为了保持代码库的健康度和 AI 辅助编程的高效性，我提出以下几点后续架构演进的建议：

## 1. 严格控制单文件体积 (Token 防御)
在 AI 参与开发的时代，单文件超过 1000 行（或 30KB）就会显著增加上下文组装的难度和 Token 消耗。
- **建议**：任何新增的 MCP 工具、Store Action 或复杂的 UI 组件，都不应再往中心化的入口文件（如 `project.ts`, `api.ts`）里堆叠，而应当独立成子模块，在入口处进行聚合导出 (Facade Pattern)。

## 2. 状态读写层的防腐 (Anti-Corruption Layer)
虽然目前前端 Store (`src/store/project.ts`) 已经切分，但底层的 `setProject` 等变异函数依然直接暴露。
- **建议**：未来应当引入更严格的数据校验层（Schema Validation）或者只读代理。尤其在涉及多智能体 (Multi-Agent) 或复杂剪辑动作时，防止非法的跨组件篡改导致时间轴状态破裂。

## 3. 异步任务与并发池的标准化
当前的 `vite-plugin-vision.ts` 和前端的 `sttJobs`、`trackJobs` 存在多套手写的任务队列。
- **建议**：后端抽取统一的 `WorkerPool` 基类，前端抽取统一的 `JobStore`。不仅能复用“重试、取消、进度上报”的逻辑，还能统一防止 OOM（内存溢出）和死锁。对于未来的 `vision` 重构，这一点尤为关键。

## 4. MCP Tools 的领域自治
目前所有的 MCP Schema 依然是在一份全局数组中合并。
- **建议**：如果工具集继续膨胀，可将 Schema 定义与该工具的服务端执行逻辑放在同一个文件夹内（按特性组织代码 Feature-Sliced Design），实现“高内聚”。这样删除或修改某个 AI 技能时，能够一次性在同一个目录下完成。

> **备注**：本次会话已为你完成了前端 API、前端 Store 和后端 MCP 配置的初步解耦，为上述建议打下了坚实的地基。
