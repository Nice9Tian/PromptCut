// M7 探针 P6 的实验文件(只在 claude/m7-probe-exp 上,不进最终提交):页面直接引渲染节点的会话状态机,
// 看 `vite build --mode online` 能不能构建、页面里能不能跑。
import { createNodeSession } from "../../server/render-node/session.mjs";
(window as unknown as { __m7CreateNodeSession?: unknown }).__m7CreateNodeSession = createNodeSession;
