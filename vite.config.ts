import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { exportPlugin } from "./server/vite-plugin-export";
import vitePluginAi from "./server/vite-plugin-ai";
import { sttPlugin } from "./server/vite-plugin-stt";
import { shotsPlugin } from "./server/vite-plugin-shots";
import { mediaPlugin } from "./server/vite-plugin-media";
import { chatsPlugin } from "./server/vite-plugin-chats";
import vitePluginCards from "./server/vite-plugin-cards";
import { projectsPlugin } from "./server/vite-plugin-projects";

export default defineConfig({
  plugins: [react(), tailwindcss(), exportPlugin(), vitePluginAi(), sttPlugin(), shotsPlugin(), mediaPlugin(), chatsPlugin(), vitePluginCards(), projectsPlugin()],
  server: {
    watch: {
      // 桌面壳的二进制、导出产物、内置 Python 都不是源码;watch 到 exe 会 EBUSY 把 dev server 崩掉
      ignored: ["**/desktop/**", "**/out/**", "**/python/**", "**/node_modules/**"],
    },
  },
});
