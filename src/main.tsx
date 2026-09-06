import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import Editor from "./Editor";
import ExportView from "./ExportView";

const q = new URLSearchParams(location.search);
const view = q.has("export") ? <ExportView /> : q.has("proto") ? <App /> : <Editor />;
createRoot(document.getElementById("root")!).render(<StrictMode>{view}</StrictMode>);
