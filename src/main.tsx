// 渲染面的时钟必须比 motion 先装好,所以这一行必须排在最前面(见 render/stageClockEntry.ts)
import "./render/stageClockEntry";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./skins/skins.css";
import App from "./App";
import Shell from "./Shell";
import ExportView from "./ExportView";
import AudioMixView from "./AudioMixView";
import StageView from "./StageView";
import { ONLINE } from "./online/mode";
import { installApiGuard } from "./online/apiGuard";
import { captureInviteFromLocation } from "./online/invite";

// 在线浏览器模式(C10a 契约第 2 节):同源 `/api/*` 在浏览器里就地拒掉,漏网的调用记进 window.__pcApiBlocked
if (ONLINE) installApiGuard({ base: import.meta.env.BASE_URL });
// 邀请链接的 `#invite=`:读进内存后马上把 `#` 片段清掉,再向服务器提交(契约第 4 节「读邀请码」)
captureInviteFromLocation();

// 不包 StrictMode:它的双重挂载会打断 Motion 带 delay 的进场动画(卡片停在 initial 不动)。
// 在线构建里 `?stage` 照样要:同源单舞台是本页 `?stage=1` 的 iframe(src/editor/previewMode.ts)
const q = new URLSearchParams(location.search);
const view = q.has("audioMix") ? <AudioMixView /> : q.has("export") ? <ExportView /> : q.has("stage") ? <StageView /> : q.has("proto") ? <App /> : <Shell />;
createRoot(document.getElementById("root")!).render(view);
