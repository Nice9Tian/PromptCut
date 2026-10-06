# AGENT 报告：claude/online-cards（第二段：在线浏览器执行用户卡与图卡）

任务书 `docs/plan/sound-online-render-task.md` 的决定 C（在线浏览器执行用户卡与图卡）与第 12～18 条。worktree `.worktrees/online-cards`，分支 `claude/online-cards`，起点 `e7d18340`。

## 第一轮：设计与契约（已交，等主会话审）

### 做了什么

- 写了 `docs/plan/online-card-exec-contract.md`：转译器选型、模块解析、隔离环境与内容安全策略、图卡素材数据流、身份与缓存键、轻重判定的接法、纯浏览器节点认领、退回办法、语义逐字稿、安全与功能验收探针的设计、原有探针要改的断言、文件清单与分工。
- 写了可行性探针 `scripts/probes/online-card-isolation-feasibility-probe.mjs`（不依赖在线构建与新包）。
- 这一轮没改产品代码，没改语义文档，没装依赖（候选转译器在工作区外的临时目录里单独装来量）。

### 验证结果

| 命令 | 结果 |
|---|---|
| `node scripts/probes/online-card-isolation-feasibility-probe.mjs` | 退出码 0；50 项过，2 项记为缺口（不算探针失败）。Chrome for Testing 152.0.7977.75 |
| 临时目录里量体积（esbuild 压缩后 gzip -9） | Sucrase 48 KB；TypeScript 1.02 MB；@babel/standalone 656 KB；esbuild-wasm 3.75 MB；oxc wasm 1.10 MB；swc wasm 5.39 MB；Tailwind 浏览器版 74 KB |
| 临时目录里用 Sucrase 转译仓库 166 个卡片与部件文件 | 166 个全部转出，119 ms（TypeScript 474 ms）；四个用 `import.meta.glob` 的索引文件转得出但执行不了（不是卡片） |
| 单独试 `webrtc 'block'` | Chrome for Testing 152（默认、开实验性网页平台功能）与本机装的 Chrome 154.0.8037.98 都没拦住，STUN 包照样到了本机的 UDP 监听端口 |
| Worker 里有没有 `RTCPeerConnection` | 没有（`undefined`） |

探针过的 50 项分五组：读不到父页对象与编辑器页的存储、票据；非导航与导航类的外传都到不了收集站；对照组（去掉策略与 sandbox）到得了；凭 HttpOnly cookie 取到的图片与视频帧进 2D 画布、WebGL2 纹理读得回像素；宿主递 Blob 的另一条路也读得回。

两项缺口：
1. WebRTC 不受内容安全策略管，STUN / TURN 的包到得了收集站。
2. 用脚本加固（去掉构造器、Trusted Types 拒掉带子框架的 HTML、不给造子框架元素）的初版试了 21 条路，2 条仍能从子框架拿回构造器（XSLT、XHR 以文档类型取回再 `importNode`）。

### 没做成的及原因

- `dns-prefetch` 对域名的解析没法在本机实测（收集站是 IP），留给验收探针用 Chrome 的网络日志核。
- 没在真的在线构建上跑（本轮只做最小探针）。
- `claude/sound-ab` 写本契约时只有一个建报告文件的提交，声音在线合成的接口按任务书 B 的原文约定，实现时要对齐。

### 对任务书或语义的更正建议

- 任务书说「`workflow/editing.md` 里『需要本地 PC 渲染辅助』出现的条件」：一级文档里没有这句话，出现条件在 `product/platforms.md`、`product/rendering.md`、`glossary.md` 与 `c10-contract.md` 第 9 节，一级不用改。
- 任务书第 14 条「不能向任意外部地址发请求带走数据」在今天的 Chrome 上对 WebRTC 做不到浏览器级的保证，契约列为待定 1。
- 任务书写第二段在新节点上「只换静态页面」：本段还要改 nginx（策略头与 `/media-s/` 两条路由），要与换页面一起做。
- 在线页面与舞台现在没有任何内容安全策略；舞台现在拿着素材只读票据（在地址的 `?t=` 里）。两条都由本段补。
- 在线逐帧导出在与编辑器页同源的导出页里活渲，所以导出时用户卡、图卡一律用预渲染原尺寸，不在导出页执行。
- 审阅表不随卡片源码同步，同步来的用户卡在线上按缺省能力处理，建议另立一项。
- 同步来的卡用到的 Tailwind 类名不在在线包的样式表里，要在页面里补生成（用仓库已有的 `tailwindcss`）。

### 等主会话定的

见契约第 13 节，共七条；其中第 1 条（WebRTC 缺口选甲还是乙）建议开工前定。
