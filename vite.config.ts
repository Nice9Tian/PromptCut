import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { apiGuardPlugin } from "./server/vite-plugin-api-guard";
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
import { skillStatePlugin } from "./server/vite-plugin-skill-state";

// 无头实例(scripts/headless.mjs)和用户手里那份 vite 跑在同一个项目根上,
// 依赖预构建缓存分开放,免得两个进程同时写 node_modules/.vite 互相踩。
const headless = process.env.PROMPTCUT_HEADLESS === "1";

export default defineConfig({
  ...(headless ? { cacheDir: "node_modules/.vite-headless" } : {}),
  // apiGuardPlugin 必须排在所有接口插件**前面**:它是 /api/** 的同源卡口,
  // 中间件按 configureServer 的调用顺序注册,排在后面就等于没有。
  plugins: [apiGuardPlugin(), react(), tailwindcss(), exportPlugin(), vitePluginAi(), sttPlugin(), shotsPlugin(), trackPlugin(), subjectPlugin(), mediaPlugin(), chatsPlugin(), vitePluginCards(), projectsPlugin(), visionPlugin(), skillPlugin(), skillStatePlugin()],
  server: headless
    ? {
        // 无头实例不要热更新:它是给 agent 跑的,源码一改就重载页面,重载期间工具全失败,
        // 页面里的状态也得从 project.proc 重新读。关掉监听,它就只认启动那一刻的代码。
        watch: null,
        hmr: false,
      }
    : {
        watch: {
          /*
           * 这里每一条都不是源码,而且**漏掉会出人命**:
           *
           * - desktop / out / python:桌面壳的二进制、导出产物、内置 Python。
           *   watch 到正在写的 exe 会 EBUSY 把 dev server 崩掉。
           * - **.lock**:.proc 的独占锁。外壳用共享模式 0 握着它,chokidar 去 fs.watch
           *   立刻拿到 EBUSY,而那是 FSWatcher 的 error 事件 —— **整个 dev server 当场退出**,
           *   连带 sidecar 和编辑器一起没。实测过一次,不是推测。
           * - .pc-projects / .pc-work / .pc-chats:草稿、任务目录、会话历史。都是运行时数据,
           *   改一下就触发一次 HMR 纯属浪费,而且草稿是自动保存的,等于每次保存都重载。
           */
          ignored: [
            "**/desktop/**", "**/out/**", "**/python/**", "**/node_modules/**",
            "**/*.lock",
            "**/.pc-projects/**", "**/.pc-work/**", "**/.pc-chats/**",
          ],
        },
      },
});
