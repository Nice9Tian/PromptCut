import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { exportPlugin } from "./server/vite-plugin-export";
import vitePluginAi from "./server/vite-plugin-ai";
import { sttPlugin } from "./server/vite-plugin-stt";

export default defineConfig({
  plugins: [react(), tailwindcss(), exportPlugin(), vitePluginAi(), sttPlugin()],
});
