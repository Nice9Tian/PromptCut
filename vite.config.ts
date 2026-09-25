import { framesPlugin } from "./server/vite-plugin-frames";
import { mirrorPlugin } from "./server/vite-plugin-mirror";
import { costsPlugin } from "./server/vite-plugin-costs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { apiGuardPlugin } from "./server/vite-plugin-api-guard";
import { viewGatePlugin } from "./server/vite-plugin-view-gate";
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
import { collectPlugin } from "./server/vite-plugin-collect";
import { webPlugin } from "./server/vite-plugin-web";
import { prerenderPlugin } from "./server/vite-plugin-prerender";
import { voicePlugin } from "./server/vite-plugin-voice";
import { audioPlugin } from "./server/vite-plugin-audio";
import { stagePortsPlugin } from "./server/vite-plugin-stage-ports";
import { docservicePlugin } from "./server/vite-plugin-docservice";

// 无头实例(scripts/headless.mjs)和用户手里那份 vite 跑在同一个项目根上,
// 依赖预构建缓存分开放,免得两个进程同时写 node_modules/.vite 互相踩。
const headless = process.env.PROMPTCUT_HEADLESS === "1";

/**
 * 局域网主机(`docs/plan/shared-project-contract.md` 第 5 节):`PROMPTCUT_LAN_HOST=1` 时编辑器绑 `0.0.0.0`,
 * 挂在它上面的文档服务与素材服务随之对局域网可达,局域网模式的共享项目建成后开始广播(`server/vite-plugin-docservice.ts`)。
 * 不设时什么都不改:沿用命令行的 `--host`(桌面壳给 `127.0.0.1`,`npm run dev` 给 `0.0.0.0`)或 vite 的缺省(回环)。
 *
 * 用插件的 `config` 钩子而不是直接写 `server.host`:钩子的返回值合并在命令行参数**之后**,能压过桌面壳写死的
 * `--host 127.0.0.1`;直接写在配置里会被命令行盖掉。无头实例是 Skill 的临时副本,不做局域网主机。
 * 预渲染进程用的是 `vite.prerender.config.ts`,不含这个插件,照旧只绑回环。
 */
const lanHost = !headless && process.env.PROMPTCUT_LAN_HOST === "1";
const lanHostPlugin = (): Plugin => ({
  name: "promptcut-lan-host",
  config: () => (lanHost ? { server: { host: "0.0.0.0" } } : undefined),
});

/**
 * vite 的静态中间件会把**项目根下的任意文件**按路径发出去 —— 实测
 * `GET /out/cookies/bilibili.txt` 是 200,内容原样。开发期 dataDir 就是 `<root>/out`,
 * 于是素材收集存下的站点登录态(SESSDATA / bili_jct,等于账号)成了一条 HTTP 可取的地址。
 * 同源策略只挡「别的网页读」,挡不住 agent 自己那个浏览器:它会去任意外站,
 * 页面上写一句「打开 http://127.0.0.1:5210/out/cookies/bilibili.txt」就能把 cookie
 * 读进模型上下文。所以在文件系统这一层直接拒掉。
 *
 * 前四条是 vite 的默认值:`deny` 是**整体替换**不是追加,不带上就等于把默认防护删了。
 * (正式包里 PROMPTCUT_DATA_DIR 指向 %LOCALAPPDATA%,不在根下,本来就取不到;
 *  这一条保的是开发期和「壳连仓库 dev server」那种跑法。)
 *
 * 本地文档服务的日志(`<root>/out/docservice`,项目版本日志与内容库,含卡片源码)同理:
 * 只经文档服务的 WebSocket 读写,不经静态服务暴露。
 */
const fsDeny = [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/out/cookies/**", "**/out/docservice/**"];

export default defineConfig({
  ...(headless ? { cacheDir: "node_modules/.vite-headless" } : {}),
  // 这两道卡口必须排在所有接口插件**前面**:中间件按 configureServer 的调用顺序注册,
  // 排在后面就等于没有。
  //   apiGuardPlugin  —— /api/** 的同源校验,任何 dev server 都生效;
  //   viewGatePlugin  —— Skill 无头实例的只读钥匙,只在 headless.mjs 起的那份上生效
  //                      (它靠 PROMPTCUT_VIEW_TOKEN 判断,用户自己那份没有这个变量,整个空转)。
  // stagePortsPlugin 排在 apiGuard 后面:它自己那条 /api/stage/ports 也该受同一道卡口管。
  // docservicePlugin(本地文档服务)总是注册;无头实例里它进入停用模式(不建文档服务、/docservice 回 503),
  // 因为无头实例是 Skill 的临时副本,不能自己发 projectRev。停用逻辑在插件里。
  plugins: [lanHostPlugin(), apiGuardPlugin(), viewGatePlugin(), stagePortsPlugin(), react(), tailwindcss(), exportPlugin(), mirrorPlugin(), costsPlugin(), framesPlugin(), vitePluginAi(), sttPlugin(), shotsPlugin(), trackPlugin(), subjectPlugin(), mediaPlugin(), chatsPlugin(), vitePluginCards(), projectsPlugin(), visionPlugin(), skillPlugin(), skillStatePlugin(), collectPlugin(), webPlugin(), prerenderPlugin(), voicePlugin(), audioPlugin(), docservicePlugin()],
  server: headless
    ? {
        // 无头实例不要热更新:它是给 agent 跑的,源码一改就重载页面,重载期间工具全失败,
        // 页面里的状态也得从 project.proc 重新读。关掉监听,它就只认启动那一刻的代码。
        watch: null,
        hmr: false,
        fs: { deny: fsDeny },
      }
    : {
        fs: { deny: fsDeny },
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
