import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ExportView from "./ExportView";

const isExport = new URLSearchParams(location.search).has("export");
createRoot(document.getElementById("root")!).render(
  isExport ? <ExportView /> : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
);
