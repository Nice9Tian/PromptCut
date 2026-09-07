import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { exportPlugin } from "./server/vite-plugin-export";
import vitePluginAi from "./server/vite-plugin-ai";
import { sttPlugin } from "./server/vite-plugin-stt";
import { shotsPlugin } from "./server/vite-plugin-shots";
import { trackPlugin } from "./server/vite-plugin-track";
import { subjectPlugin } from "./server/vite-plugin-subject";
import { mediaPlugin } from "./server/vite-plugin-media";
import { chatsPlugin } from "./server/vite-plugin-chats";
import vitePluginCards from "./server/vite-plugin-cards";
import { projectsPlugin } from "./server/vite-plugin-projects";
import { visionPlugin } from "./server/vite-plugin-vision";
import { skillPlugin } from "./server/vite-plugin-skill";

// 无头实例(scripts/headless.mjs)和用户手里那份 vite 跑在同一个项目根上,
// 依赖预构建缓存分开放,免得两个进程同时写 node_modules/.vite 互相踩。
const headless = process.env.PROMPTCUT_HEADLESS === "1";

export default defineConfig({
  ...(headless ? { cacheDir: "node_modules/.vite-headless" } : {}),
  plugins: [react(), tailwindcss(), exportPlugin(), vitePluginAi(), sttPlugin(), shotsPlugin(), trackPlugin(), subjectPlugin(), mediaPlugin(), chatsPlugin(), vitePluginCards(), projectsPlugin(), visionPlugin(), skillPlugin()],
  server: {
    watch: {
      // 桌面壳的二进制、导出产物、内置 Python 都不是源码;watch 到 exe 会 EBUSY 把 dev server 崩掉
      ignored: ["**/desktop/**", "**/out/**", "**/python/**", "**/node_modules/**"],
    },
  },
});
