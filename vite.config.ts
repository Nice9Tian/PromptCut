import { framesPlugin } from "./server/vite-plugin-frames";
import { mirrorPlugin } from "./server/vite-plugin-mirror";
import { costsPlugin } from "./server/vite-plugin-costs";
import { defineConfig, type Plugin, type UserConfig } from "vite";
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

/*
 * 卡片、部件文件不做 Fast Refresh(C6.6 集成 3b)。它们导出的是卡片定义(对象),不是纯组件,
 * Fast Refresh 本来就接不住:插件先把文件当成自接的边界,页面里校验不过再 invalidate,
 * 于是每改一张卡,编辑器页面和两个舞台各自再触发一轮热更新(实测晚到 3 s),正好打断在跑的重测。
 * 排除之后热更新直接沿导入链走到 `src/cards/index.ts`(它自己接住、重装整套卡片),一次就完。
 */
const REACT_REFRESH_EXCLUDE = [/\/node_modules\//, /\/src\/cards\//, /\/src\/parts\//];

const desktopConfig: UserConfig = {
  ...(headless ? { cacheDir: "node_modules/.vite-headless" } : {}),
  // 这两道卡口必须排在所有接口插件**前面**:中间件按 configureServer 的调用顺序注册,
  // 排在后面就等于没有。
  //   apiGuardPlugin  —— /api/** 的同源校验,任何 dev server 都生效;
  //   viewGatePlugin  —— Skill 无头实例的只读钥匙,只在 headless.mjs 起的那份上生效
  //                      (它靠 PROMPTCUT_VIEW_TOKEN 判断,用户自己那份没有这个变量,整个空转)。
  // stagePortsPlugin 排在 apiGuard 后面:它自己那条 /api/stage/ports 也该受同一道卡口管。
  // docservicePlugin(本地文档服务)总是注册;无头实例里它进入停用模式(不建文档服务、/docservice 回 503),
  // 因为无头实例是 Skill 的临时副本,不能自己发 projectRev。停用逻辑在插件里。
  plugins: [lanHostPlugin(), apiGuardPlugin(), viewGatePlugin(), stagePortsPlugin(), react({ exclude: REACT_REFRESH_EXCLUDE }), tailwindcss(), exportPlugin(), mirrorPlugin(), costsPlugin(), framesPlugin(), vitePluginAi(), sttPlugin(), shotsPlugin(), trackPlugin(), subjectPlugin(), mediaPlugin(), chatsPlugin(), vitePluginCards(), projectsPlugin(), visionPlugin(), skillPlugin(), skillStatePlugin(), collectPlugin(), webPlugin(), prerenderPlugin(), voicePlugin(), audioPlugin(), docservicePlugin()],
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
};

/**
 * 在线构建（C10a 契约 `docs/plan/c10a-contract.md` 第 2 节〔裁〕）：`vite build --mode online` 产出 `dist-online/`，
 * `base: "/editor/"`，编译期常量 `import.meta.env.VITE_PC_ONLINE === "1"`（`src/online/mode.ts` 的 `ONLINE`）。
 *
 * - 只挂 React 与 Tailwind：上面那些插件都是编辑器进程的 `/api/**` 接口与开发期的中间件，在线页面没有编辑器进程；
 *   卡片的改动层（`vite-plugin-cards` 的 pre 插件）是本机用户的定制，也不进在线构建；
 * - 桌面构建（`vite build`）与开发服务（`vite`）照旧走 `desktopConfig`，不受影响；
 * - `dist-online/` 由 `scripts/remote/docservice.mjs deploy-hosted --editor dist-online` 部署到托管端的 `<部署目录>/editor/`，
 *   nginx 在 `/editor` 下提供（契约第 2 节「nginx」）。
 */
/*
 * C10 契约第 7 节(主会话 2026-09-28 的补充约束):在线页面发布的清单计划写 `requires.codeVersion`,由构建时按渲染节点同一套算法
 * (`server/frame-code.mjs` 的 `frameCode`,换行统一成 LF)算出、以 `__PC_CODE_VERSION__` 嵌进页面(`src/online/buildInfo.ts`)。
 * 只在在线构建里算(遍历 src/ 一次)。
 * 不压缩 CSS(`cssMinify: false`,M7 探针 P2 之后主会话裁定):快照把根元素上的 CSS 自定义属性按原文内联,压缩过的 CSS
 * (`0.4` → `.4`、`150ms` → `.15s`)会让在线页面生成的快照与桌面(未压缩)逐字节不同、像素相同 —— 同指纹同结果键下混两种字节。
 */
const onlineConfig = async (): Promise<UserConfig> => {
  const { frameCode } = await import("./server/frame-code.mjs");
  const codeVersion = frameCode(process.cwd());
  return {
    base: "/editor/",
    plugins: [react({ exclude: REACT_REFRESH_EXCLUDE }), tailwindcss()],
    define: { "import.meta.env.VITE_PC_ONLINE": JSON.stringify("1"), __PC_CODE_VERSION__: JSON.stringify(codeVersion) },
    build: { outDir: "dist-online", emptyOutDir: true, cssMinify: false },
  };
};

export default defineConfig(async ({ mode }) => (mode === "online" ? onlineConfig() : desktopConfig));
