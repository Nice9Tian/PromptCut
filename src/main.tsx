import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import Editor from "./Editor";
import ExportView from "./ExportView";

// 不包 StrictMode:它的双重挂载会打断 Motion 带 delay 的进场动画(卡片停在 initial 不动)。
const q = new URLSearchParams(location.search);
const view = q.has("export") ? <ExportView /> : q.has("proto") ? <App /> : <Editor />;
createRoot(document.getElementById("root")!).render(view);
