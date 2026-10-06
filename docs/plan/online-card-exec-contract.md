# 契约：在线浏览器执行用户卡与图卡

2026-10-06。任务书 `sound-online-render-task.md` 的决定 C 与第 12～18 条的设计与契约。本文只定做法；实现等主会话回话后再开工。

- 〔裁〕＝本文自行裁定之处，都写了理由，主会话与用户可以推翻。
- 〔待定〕＝本文拿不准、要主会话或用户定的，集中在第 13 节。
- 实测数字出自 `scripts/probes/online-card-isolation-feasibility-probe.mjs`（Chrome for Testing 152.0.7977.75，本机；50 项过、2 项记为缺口）与工作区外的临时目录里量的体积，复现办法见第 14 节。

## 0. 现状里与本文有关的事实

| 事实 | 出处 |
|---|---|
| 桌面版的用户卡就是普通 Vite 模块：`import.meta.glob` 收 `src/cards/user/*.tsx`，JSX 用 automatic 运行时，卡片是具名导出的 `CardDef`（有 `Component`、`card`、`audio` 之一） | `src/cards/user/index.ts`、`tsconfig.json` |
| 图卡不是另一种文件：`CardDef` 上有 `card()` 或 `audio()` 就是图卡。`card()` 在渲染它的那个文档的主线程里跑，用 `<video>` 定位取帧 → `createImageBitmap` → WebGL2；片元着色器是作者写的 GLSL | `src/kernel/cardAuthoring.mjs`、`src/render/cards/GraphCard.tsx`、`mediaSource.ts`、`gpuExecutor.ts` |
| 卡片的 `audio()` 现在在**编辑器页主线程**里跑（`renderEmbeddedCardWav`），不是 Worker；`soundGenerationWorker` 只跑提示音、键盘声的配方 | `src/audio/cardAudio.ts` |
| 在线普通档的舞台是两个与编辑器页同站跨源的 iframe（`s1.<主机>`、`s2.<主机>`），三方都带 `Origin-Agent-Cluster: ?1`；握手失败或低内存档退回**与编辑器页同源**的单舞台 | `c10-contract.md` 第 2 节、`src/online/stageOrigins.ts` |
| 舞台现在**拿着素材只读票据**：编辑器页经 `setMediaPolicy` 下发，舞台把它拼进素材地址的 `?t=` | `src/render/stageRpc.ts`、`src/render/mediaTier.ts:123` |
| 在线页面与舞台现在**没有任何内容安全策略**（nginx 模板与 `index.html` 都没有） | `server/hosted/deploy/nginx-site-promptcut*.conf` |
| 在线逐帧导出在**与编辑器页同源**的导出页（`?export=1`）里活渲轻卡，重卡用预渲染原尺寸 | `src/export/frameCompositor.ts` |
| 桌面版的 Tailwind 在构建时扫 `src/`；在线包的样式表在构建时定死，同步来的卡用到的新类名不在里面 | `src/index.css` |
| 审阅表 `src/cards/capabilities.json` 不在卡片源码同步的范围里（只同步 `.ts` / `.tsx` / `.css`） | `server/card-sync.mjs` |
| 任务的 `requires.cardSources` 用服务端的 `cardCodeIdentity`（闭包里每个文件的路径加内容库同一算法的内容哈希）；页面的成本身份用另一套 `cardSourceVersion`（闭包原文） | `server/vite-plugin-cards.ts`、`src/render/cardSourceVersion.mjs` |

## 1. 转译器

**选 Sucrase 3.35.1（MIT）。** 新增一个运行时依赖 `sucrase`；Tailwind 的运行时编译用仓库已有的 `tailwindcss` 4.3.3（MIT），不算新增。

| 候选 | 体积（压缩后 → gzip） | 许可证 | 要 wasm | 备注 |
|---|---|---|---|---|
| **Sucrase 3.35.1** | 207 KB → **48 KB** | MIT | 否 | TSX、类型剥离、automatic 的 JSX 运行时、ESM 转 CommonJS 都有；转译 166 个卡片与部件文件共 119 ms |
| TypeScript 5.9.3 `transpileModule` | 3.56 MB → 1.02 MB | Apache-2.0 | 否 | 语法最全，已是开发依赖；同样 166 个文件 474 ms；体积是 Sucrase 的 21 倍 |
| @babel/standalone 7.29 | 3.14 MB → 656 KB | MIT | 否 | 无优势 |
| esbuild-wasm 0.28 | 14.0 MB → 3.75 MB | MIT | 是 | 要 `wasm-unsafe-eval` |
| oxc-transform 0.153（wasm） | 3.26 MB → 1.10 MB | MIT | 是 | 与桌面版（Vite 8 用 oxc）同源，但 wasm 版依赖 WASI 与线程，在线页面里起不来的风险高 |
| @swc/wasm-web 1.16 | 18.2 MB → 5.39 MB | Apache-2.0 | 是 | 太大 |

理由〔裁〕：
- 体积最小、纯脚本、不要 wasm，策略里不用加 `wasm-unsafe-eval`。
- 仓库里 `src/cards`、`src/parts`、`server/catalog` 下 166 个非测试的 `.ts` / `.tsx` 全部转译成功（四个用 `import.meta.glob` 的索引文件不是卡片，转得出但执行不了，本来也不执行）。
- **与桌面版不求逐字相同**：桌面用 oxc，输出文本不同，语义相同。在线活渲只要画面等价；预渲染结果的键靠第 5、7 节的运行时版本与环境区分，不与桌面的结果共用一个键。
- Sucrase 有几种写法会**悄悄转错**（实测）：`namespace` 的内容被整个丢掉；`accessor` 类字段被改写成普通字段。另有几种转得出但执行不了：装饰器、顶层 `await`、`import.meta`。所以转译前先做一遍词法预检，遇到下列写法一律报「在线页面不支持这种写法」并退回（第 8 节）：`namespace` / `module X {`、装饰器、`accessor`、顶层 `await`、`import.meta`、动态 `import()`。
- 转译器版本是运行时版本的一部分（第 5 节）。

**在哪里转译**〔裁〕：在**编辑器页**里转（转译只读文本、不执行，Sucrase 不用 `eval`），结果连同依赖表经舞台 RPC 发给两个舞台；按「运行时版本 + 文件键 + 内容哈希」存进编辑器页的 IndexedDB，哈希没变不重转。转译器与 Tailwind 编译器放在一个按需载入的分块里（合计约 122 KB gzip：Sucrase 48 KB + Tailwind 浏览器版同等内容 74 KB），项目里有同步来的用户卡且本页能执行它们时才载入。单个文件上限 512 KB，一张卡的闭包上限沿用现有的 200 个文件〔裁：防坏数据拖住页面〕。

转译选项：`transforms: ["typescript", "jsx", "imports"]`、`jsxRuntime: "automatic"`、`production: true`、`preserveDynamicImport: true`（留着好让预检之外的漏网在执行时报错，而不是被改写）。

## 2. 模块解析

转成 CommonJS 之后，舞台用 `new Function("require", "module", "exports", 代码)` 执行，`require` 由舞台提供。执行前先从转译结果里取出全部 `require` 的名字，把要按需载入的页面自带模块先取到，再同步执行。

| 写法 | 接到哪里 |
|---|---|
| `react`、`react/jsx-runtime`、`react-dom`、`motion`、`motion/react`、`three`、`lottie-web`、`@tsparticles/engine`、`@tsparticles/slim` | 在线页面自带的那一份（同一个实例；重的几样按需载入）。清单与桌面 `create_card` 的白名单（`server/vite-plugin-cards.ts` 的 `ALLOWED_IMPORTS`）一致，只少 `three/*` |
| 相对导入，解析后落在 `src/cards/user/` 下 | 内容库同步来的那份源码，同样转译、执行，按文件键缓存模块实例（有环照 CommonJS 的办法处理） |
| 相对导入，解析后落在页面自带的内置模块上（`src/cards/` 非用户卡部分、`src/parts/`、`src/kernel/`，以及 `src/render/cards/graphValues.ts`） | 页面自带的那一份（构建时用 `import.meta.glob` 列一张按需载入的表，实例与页面自己用的是同一个） |
| 同上，但内容库里有同一路径、且内容哈希与页面自带的不同（桌面端改过的内置文件，随卡的闭包一起同步来的） | 用同步来的那份，只对引它的用户卡生效〔裁：与桌面「改动层优先」一致；内置卡自己仍用页面自带的〕 |
| `./x.css` | 同步来的样式文本作为一个 `<style>` 注入舞台，卡片卸载或换代时撤掉 |
| Tailwind 类名 | 转译时从闭包的源码里取候选类名，用页面带的 Tailwind 编译器按本仓库的主题（`src/index.css`）只生成工具类那一层，随模块一起发给舞台注入；不重复注入基础层 |

**不支持，报「引用了在线页面里没有的模块：<名字>」并退回**：
- 上表之外的包名（含 `three/*`、`@/` 别名）；
- 解析后落在上表范围之外的相对导入（例如引到 `src/editor/`、`src/store/`）；
- 内容库里没有、页面也没带的文件；
- 带查询的导入（`?raw`、`?url`）、JSON 与图片等资源导入；
- 动态 `import()`、`import.meta`（预检已拦）。

卡片的认定沿用桌面的结构判断（`src/cards/user/index.ts` 的 `isCardDef`）。执行出来的定义只进**舞台与声音线程里的**注册表；编辑器页的注册表照旧只有静态解析出来的视图（`syncedCardView`），外加每张卡的运行状态（第 8 节）。

审阅表不同步：同步来的用户卡在在线页面里按缺省能力（`cardCapabilities` 的缺省）处理；渲染任务里的 `compositing` 以切分方写进任务的为准。〔更正建议〕这使同一张卡在桌面与在线的轻重判定起点可能不同，要不要把审阅表里用户卡的条目也同步，建议另立一项。

## 3. 隔离环境

### 3.1 信任边界

**舞台的整个脚本环境算不可信。** 一旦要执行用户卡或图卡，舞台里就不放任何秘密，而不是在舞台里再分可信、不可信两半。

| 在哪里 | 执行什么 |
|---|---|
| 编辑器页的源 | 不执行任何用户卡、图卡的代码。只做文本层面的事：取源码、静态解析、转译、算身份 |
| 跨源舞台 A、B（`s1`、`s2`） | 用户卡与图卡的**画面** |
| 后台舞台 B 起的专用 Worker | 用户卡与图卡的**声音**（`audio()`） |
| 同源单舞台（握手失败的退路、低内存档） | **不执行**，照现在的做法（第 8 节） |
| 同源导出页 | **不执行**。导出时用户卡、图卡一律用预渲染原尺寸，缺的由渲染节点补（含本页的后台舞台，第 7 节） |

执行的前提（缺一条就不执行，退回原做法）：本页是双舞台且握手成功；舞台源与编辑器页不同源；舞台自检确认策略生效（3.3）；票据交接成功（第 4 节）。

### 3.2 凭什么读不到

| 要护住的 | 凭什么 | 探针实测 |
|---|---|---|
| 父页对象（`parent`、`top`、`opener`、`frameElement`） | 跨源：读任何属性抛 `SecurityError`；`opener`、`frameElement` 为空 | 过 |
| 项目凭证、设备身份、页面内快照库、成本记录、本地备份（都在编辑器页的 `localStorage` / IndexedDB 里） | 存储按源分开，舞台源看不到编辑器页源的任何存储（`localStorage`、IndexedDB、可读 cookie、OPFS、Cache） | 过 |
| 素材票据 | 票据不进舞台的脚本：编辑器页把它交给舞台源的服务端换成 HttpOnly cookie（第 4 节）。`document.cookie`、`cookieStore`、全局变量、性能条目里都没有它 | 过 |
| 协议面 | 舞台只能给父页发 `postMessage`。父页的规矩（新增）：只认 `event.source` 是自己挂的舞台且 `event.origin` 是配置里的舞台源的消息；舞台发来的一切当不可信输入，按形状校验、数字钳到合理范围；父页**从不经 RPC 回传凭证或票据**（`setMediaPolicy` 去掉 `ticket` 字段）；父页不把舞台交来的 HTML 放进自己的活文档（现有导出只把快照放进惰性的 `<template>` 再包成 SVG 图，实现时加一条守门测试钉住） | 父页侧为实现期验收项 |
| Worker 的全局对象 | 没有 `parent`、`document`、`localStorage`；它的源是舞台源，看不到编辑器页的存储 | 过 |

舞台里有什么：这个项目的内容（时间轴、参数）、凭 cookie 读得到的这个项目的素材。这是卡片干活本来就要的，不算秘密；它们带不带得走见 3.3。

实现时要核对的一条：`setProject` 下发给舞台的项目对象里没有邀请码、成员名单之外的凭证类字段；有就在下发前去掉。

### 3.3 凭什么带不走：内容安全策略

现状是**没有任何策略**，要补三处。

**（一）舞台文档与舞台源上所有脚本响应**（nginx 的 `s1` / `s2` 那个 server 块对全部路径加响应头；另在舞台的入口 HTML 里放同文的 `<meta>` 兜底，免得节点的 nginx 没更新时裸奔）：

```
default-src 'none';
script-src 'self' 'unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
media-src 'self' blob:;
font-src 'self' data:;
connect-src 'self';
worker-src blob:;
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors https://<编辑器页的主机>;
webrtc 'block'
```

外加响应头 `X-DNS-Prefetch-Control: off`。

- `'unsafe-eval'` 是执行转译结果必需的；舞台本来就按不可信对待，不靠它防注入。
- `worker-src blob:` 不含 `'self'`：从同源脚本地址起的 Worker 不继承文档的策略（它的策略取自那个脚本自己的响应头），只许从 blob 地址起，blob Worker 继承创建者的策略（实测：同源地址起 Worker 被拦下，blob Worker 里 `fetch`、`WebSocket`、`importScripts`、再起外部 Worker 全被拦下）。页面自己的 Worker（GL、声音）改成「blob 引导 + 引入同源模块」的起法。
- 舞台要单独一个入口 HTML（`stage.html`，同一份脚本包），好让 `<meta>` 只管舞台、不管编辑器页〔裁〕。

**（二）舞台 iframe 的属性**：`sandbox="allow-scripts allow-same-origin"`。不给 `allow-popups`、`allow-top-navigation`、`allow-forms`、`allow-modals`、`allow-downloads`。舞台是跨源地址，`allow-same-origin` 只是让它保有自己的源（读自己源上的素材要它），不会变成编辑器页的源。实测：开新窗口、带走顶层、`_top` 链接都被拦下。

**（三）编辑器页**：响应头加 `Content-Security-Policy: frame-src 'self' https://s1.<主机> https://s2.<主机>`。舞台 iframe **自己跳走**（`location.href = 外部地址`、meta 刷新）归父页的 `frame-src` 管，实测被拦下、外部一个请求都收不到（那台舞台会死掉，由现有的舞台看守重载，见第 8 节）。编辑器页其余指令这次不加〔裁：给整个编辑器页上全套策略影响面大，不在本段范围；只加舞台隔离必需的这一条〕。

**舞台自检**：舞台启动时向一个固定的、不存在的外部地址发一次 `fetch`，确认收到 `securitypolicyviolation`；没收到（策略没生效）就在握手里报 `isolated: false`，本页不执行用户卡。

实测结果（收集站是另一个站的 HTTP 服务，记每条 TCP 连接、UDP 包、HTTP 请求）：

| 带走的办法 | 结果 |
|---|---|
| `fetch`（含 `no-cors`）、XHR、WebSocket、`sendBeacon`、EventSource、WebTransport | 拦下 |
| `<img>`、CSS 背景图、`@import`、`@font-face`、`<link rel=stylesheet>`、`<script src>`、动态 `import()`、`<video>`、`<object>` | 拦下 |
| 子框架载入外部地址、空白子框架里的 `fetch`、`srcdoc` 子框架 | 拦下（继承策略） |
| 表单提交、`<a ping>`、`prefetch` / `preload` / `preconnect` / `dns-prefetch` / `modulepreload` | 收集站 0 连接 0 请求 |
| 自己跳走、meta 刷新、带走顶层、开新窗口、`_top` 链接 | 收集站 0 请求 |
| 注册 Service Worker、从同源脚本地址起 Worker | 拦下 |
| 对照组（去掉策略与 sandbox） | `fetch`、XHR、`sendBeacon`、图片、CSS、脚本、子框架、表单都到得了收集站，证明上面的「收不到」不是探针瞎了 |
| **WebRTC** | **没拦住**，见 3.4 |

没法在本机实测的一条：`dns-prefetch` 对**域名**的解析（探针里的收集站是 IP，没有解析这一步）。外部资料说严格策略下 DNS 预解析仍可能成为低带宽的出口；`X-DNS-Prefetch-Control: off` 是对它的处置，验收探针用 Chrome 的网络日志核（第 10 节）。

### 3.4 缺口：WebRTC〔待定 1〕

`webrtc 'block'` 在 Chrome 152（探针用的）与本机装的 Chrome 154 正式版上**都不生效**：带着这条指令，`new RTCPeerConnection({ iceServers: [...] })` 照样把 STUN 包（UDP）与 TURN 连接（TCP）发到了收集站。WebRTC 不归 `connect-src` 管。TURN 的用户名字段可以带任意数据，作者也可以把自己服务器的 ICE 参数写死在卡里直接建数据通道，所以这是一条完整的外传通道。

Worker 里没有 `RTCPeerConnection`，所以**声音那一半不受影响**；受影响的是画面那一半（要 DOM，只能在窗口里跑）。

能补的只有脚本层面的加固，本文建议做，但它不是浏览器替我们保证的：

1. 舞台在任何卡片代码之前，把 `RTCPeerConnection`、`webkitRTCPeerConnection` 改成不可改的 `undefined`。
2. 不让舞台里出现子框架（子框架是同源的新环境，里面有原装的构造器）：策略加 `require-trusted-types-for 'script'; trusted-types default`，缺省策略拒掉一切含 `iframe` / `frame` / `object` / `embed` 的 HTML 串；`createElement` / `createElementNS` / `customElements.define` 不给造这几种元素；删掉 `XSLTProcessor`；DOM 的插入入口（`appendChild`、`insertBefore`、`replaceChild`、`append`、`prepend`、`before`、`after`、`replaceWith`、`replaceChildren`、`insertAdjacentElement`、`Range.insertNode`）插入前查一遍子树。
3. 兜底：`MutationObserver` 发现子框架就摘掉，并向父页报这张卡，父页本次会话不再挂它。
4. 策略里照样写 `webrtc 'block'`，浏览器哪天开始执行就自动生效。

探针里做了第 1、2 步的一个初版（不含插入入口那一层）：试了 21 条从子框架拿回构造器的路，19 条拦下，**2 条拿到了**（XSLT 生成元素、XHR 以文档类型取回同源 HTML 再 `importNode`）。这两条用「删 `XSLTProcessor`」和「插入入口检查」能堵，但这说明它是逐条堵的性质，不能证明没有第三条。

要定的是：
- **甲（建议）**：按上面四步加固后交付，把这一条如实写进语义与报告：凭证、票据、本机存储、父页对象由浏览器的跨源规则保证读不到；向外发请求由策略拦下，WebRTC 一项靠脚本加固，不是浏览器保证；万一被绕过，带得走的是这个项目自己的内容与素材，带不走凭证与票据。
- **乙**：画面那一半只在「舞台自检确认 WebRTC 真被拦下」的浏览器上执行。按今天的 Chrome 就是全都不执行，用户卡与图卡的画面照旧走预渲染，只有声音在线执行。任务书第 15 条的画面部分做不成。

任务书第 14 条写的是「不能向任意外部地址发请求带走数据」，这一条按字面在今天的 Chrome 上做不到浏览器级的保证，所以列为待定，不自行裁。

### 3.5 声音的后台线程

**结论：专用 Worker，由后台舞台 B 起，源是舞台源，从 blob 地址引导。**

- blob Worker 继承舞台文档的策略，网络出口与舞台相同（实测全拦下）；Worker 里没有 WebRTC、没有 DOM、够不到父页。
- 不用「编辑器页里的 sandbox 子框架再起 Worker」〔裁〕：那样要在编辑器页的源下多养一种隔离环境，`srcdoc` 子框架还会继承编辑器页将来的策略；舞台源已经是现成的隔离边界，一条边界比两条好核。代价是低内存档与同源单舞台没有这条线程，它们不在线合成用户卡的声音（第 8 节）。
- 数据流：编辑器页 →（RPC）后台舞台 → Worker：转译好的模块、项目里这张卡用得到的那一段、节点、采样范围；Worker → 舞台 → 编辑器页：Float32 采样块（可转移的缓冲区）。打包成 WAV、凭读写票据上传、提交产物记录仍在编辑器页做，与现在相同，读写票据不出编辑器页。
- Worker 里的模块表：`react`、`react/jsx-runtime`、`motion`、`motion/react`、`three` 与 kernel 的模块给真的；`lottie-web`、`@tsparticles/*` 这类一载入就要 DOM 的给占位，用到就抛「声音代码里不能用 <名字>」。同一个文件里既有画面又有 `audio()` 的卡，顶层要是碰了占位就算这张卡的声音在线合成不了，退回（第 8 节）。
- 超时由舞台 `terminate()`，死循环掐得断；时限按片段时长给，上限写进 `mechanism/`〔裁：缺省每秒声音 2 秒墙钟、最少 10 秒〕。
- **读素材采样的音频图卡**（`sources[名].block()` 要素材的 PCM）本期不在线合成〔裁〕：桌面靠编辑器进程的 ffmpeg 路由取采样块，远程素材服务没有这条路由；在浏览器里用 `decodeAudioData` 解出来的采样与 ffmpeg 的不逐样本相同（重采样器不同、AAC 的起始延迟处理不同），会造成同一身份两种声音。这类卡判为「要渲染节点」，面板写明原因。不读素材的音频图卡、有声用户卡照常在线合成。

## 4. 图卡

### 4.1 素材怎么进舞台

**票据由编辑器页持有，交给舞台源的服务端换成 HttpOnly cookie；舞台用不带票据的相对地址取素材。字节仍由舞台直接按 Range 从自己源上的反代取，不经编辑器页中转。**

1. 编辑器页每个页面会话生成一个随机的 `sid`（不是秘密），握手后与每次续票后，向每个舞台源各发一次带凭据的跨源请求：`POST https://sN.<主机>/media-s/<sid>/_grant`，`Authorization: Bearer <只读票据>`，`credentials: "include"`。
2. nginx 在 `s1` / `s2` 上对这个地址只做一件事：核 `Origin` 是编辑器页的源，回 204 并 `Set-Cookie: pc_rt=<票据>; Path=/media-s/<sid>/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`（票据有效期 15 分钟）。
3. 舞台取素材的地址从 `/media/media/<哈希>?t=<票据>` 换成 `/media-s/<sid>/media/<哈希>`。nginx 把 `/media-s/<sid>/…` 反代到素材服务，并把 cookie 换成 `Authorization: Bearer` 头；只放行 `GET` / `HEAD`。素材服务自己不改（它本来就认 Bearer 的只读票据）。
4. `setMediaPolicy` 不再带 `ticket`，改带 `sid`。同源单舞台与低内存档照旧用 `?t=`（那里不执行用户代码）。

为什么不让编辑器页取字节再递给舞台〔裁〕：也实测了这条路（编辑器页取成 Blob 再 `postMessage`，舞台 `createObjectURL`，64 MB 的 Blob 递过去 2～9 ms，不污染画布），它能用，但视频要整个文件先下完才能用，没有 Range，几百兆的素材会占满内存与磁盘配额。cookie 这条路保留了现在的 Range 流式读法，票据同样不进舞台的脚本。

实测：授权请求 204（约 310 ms，含预检）；cookie 在舞台里读不到；凭它取到的图片与视频帧画进 2D 画布、传进 WebGL2 纹理后读得回像素（不污染）；换一个 `sid` 的路径回 401；舞台起的 Worker 里用绝对地址同样取得到。

边界说明：卡片代码**读不到票据**，但能**用**它读这个项目的素材（图卡本来就要读）。票据本身不限定哈希（`auth-contract.md` 第 8 节的〔裁〕），所以知道别的项目某个素材哈希的代码也读得到那份字节；哈希是 256 位的内容摘要，猜不出来。这一点与现状相同，不是本次引入的。

跨源条件：舞台读的是自己源上的反代，同源，不需要 CORS、不需要给媒体元素设 `crossOrigin`、不需要 COEP / CORP。素材服务现有的响应头够用（`Accept-Ranges`、`Content-Range` 都有）。**两个舞台源必须与编辑器页同站**（现在的 `s1.` / `s2.` 子域就是），否则第三方 cookie 的限制会让授权失败；失败按「票据交接不成功」处理，不执行用户代码。

### 4.2 GPU 执行与解码

照桌面的办法原样跑在舞台的主线程里：`<video>` 定位取帧、`createImageBitmap`、`CardGpuExecutor` 的 WebGL2。代码不用分叉，只是素材地址换成 4.1 的。上游节点递归、片元着色器都在舞台里。

### 4.3 图形能力不够怎么判〔裁〕

舞台第一次要挂图卡时判一次，结果随握手之后的状态消息报给编辑器页。满足任一条就算不够，这台设备本次会话的图卡全部退回：

- 拿不到 WebGL2 上下文，或带 `failIfMajorPerformanceCaveat: true` 时拿不到；
- `UNMASKED_RENDERER_WEBGL` 是软件渲染（`swiftshader`、`llvmpipe`、`software`、`basic render`）；
- `MAX_TEXTURE_SIZE` 小于项目画幅的长边；
- 运行中丢过一次 WebGL 上下文（现有的 `webglcontextlost` 上报；现有规则是丢一次就把本会话降到低内存档，不动）。

单张图卡另有两种退回：它的视频输入这台设备解不了（`<video>` 报错，例如没有 HEVC 解码）；执行抛错（着色器编译失败等）。

## 5. 身份与缓存键

**在线卡片运行时版本**：一个字符串常量，形如 `ocr1:sucrase@3.35.1:tailwindcss@4.3.3`。`ocr1` 是本文定义的加载器与模块表的版本，改了模块解析规则、预检规则、Worker 模块表就加一；转译器、Tailwind 的版本取自实际打进包的版本（构建时注入）。

| 键 | 进什么 | 与桌面的关系 |
|---|---|---|
| 转译缓存（编辑器页 IndexedDB） | 运行时版本、文件键、内容库的内容哈希 | 桌面没有这一层 |
| 舞台里已载入的模块 | 运行时版本、闭包里每个文件的键与哈希；任一变了整张卡换代 | — |
| 卡片代码身份（任务的 `requires.cardSources`、节点报的 `cardSourceVersions`） | 与桌面同一算法：闭包里每个文件的仓库相对路径加内容哈希。把 `cardCodeIdentity` 的算法抽成浏览器与 Node 共用的模块，页面按内容库的哈希与页面自带文件的哈希算，与桌面算出同一个值（内容库的哈希与桌面的 `sourceHash` 是同一算法） | 相同，这样任务才对得上 |
| 成本身份（轻重判定） | 现有的 `cardCostKey(节点, 源码版本, fps, 帧数)`，源码版本照现有的 `user:<闭包原文>` | 相同。记录里的 `device` 串对用户卡、图卡的记录追加运行时版本，换转译器后旧记录不再命中〔裁〕 |
| 预渲染结果键 | 内容键 × 环境指纹（不变）；纯浏览器节点做用户卡、图卡任务时用带运行时版本的那个环境指纹（第 7 节） | 不同环境不同键；同一台机器上的桌面节点与浏览器节点也不共用 |
| 声音产物 | 不变：现有的声音源码版本（`audioSourceVersion`）加参数〔裁〕 | 相同。`audio()` 是纯数值计算，转译器不改变算术；键相同才能做到「判重的用已有产物」。产物记录里另记是哪种运行时合成的，只作诊断。〔待定 3〕 |

相对导入的闭包本来就在源码版本与代码身份里（两套算法都跟着相对导入走）；包（`react`、`motion` 等）的版本由在线构建的代码版本覆盖。

## 6. 轻重判定

用户卡与图卡一旦在本页「能运行」（第 8 节的状态是 `ready`），就和内置卡走同一套：给成本身份、进后台舞台的常驻探针与测量、按成本记录判轻重、轻的活渲、重的贴预渲染结果并发布补渲。具体是把现在「在线模式下一律剔除」的几处判断从「是不是用户卡或图卡」换成「这张卡在本页能不能运行」：`src/editor/costIdentity.ts` 的 `dropLocalOnly`、`src/render/placeholderHost.ts` 的 `needsLocalPc` / `unsupportedHere`、`src/editor/snapshotFeed.ts` 的 `localOnlyOf`、`src/editor/stageSwap.ts`、`src/StageView.tsx` 的 `localOnlyAll`、`src/render/Stage.tsx:237`。不能运行的仍按现在的规则（按重卡、不测、贴结果、缺了出图标）。

测量门（等卡片源码第一次同步完再测）保留，再加一条：等同步来的卡第一次载入有了结果（成功或失败都算）。

**声音**：接并行分支 `claude/sound-ab` 按任务书 B 做的那一套。写本文时那个分支只有一个建报告文件的提交，没有代码也没有语义落点，所以这里按任务书 B 的原文约定接口，实现时对齐它的实际形状〔依赖〕：

- B 提供：声音的成本身份与记录、判轻判重、静音测量、「判重的用已有产物、没有就交给渲染节点」的分派。
- 本段提供：一个「合成宿主」的实现，输入（卡、节点、采样范围、项目片段），输出采样块，可取消，可静音测量（只算不播）。内置卡用 B 的宿主（编辑器页自己的 Worker）；同步来的用户卡与图卡用本文 3.5 的舞台 Worker 宿主。B 的分派按卡的来源选宿主。
- 现有五处「在线不执行卡片声音」的守卫（`src/audio/cardAudio.ts` 两处、`src/editor/io/cardAudioGeneration.ts`、`src/render/cards/audioSources.ts`、`src/editor/left/CardAudioForm.tsx`）由 B 改成走分派；本段只保证：在编辑器页的源里，`evaluateCardAudio` 对同步来的卡永远不被直接调用（加守门测试）。

## 7. 纯浏览器节点认领用户卡与图卡任务

不变的：只认领当前登录用户自己产生的任务；不要本机转码；不认领流、清单计划、本地档；低内存档不当节点；只做独立卡。

改的：

1. **节点能力**：能执行时节点报 `capabilities.userCards: true`；图形能力够时再报 `graphCards: true`；`cardSourceVersions` 报本页已载入成功的每张卡的代码身份（第 5 节）。同步来的卡换代后一小段时间不报（沿用桌面的 `CARD_CODE_SETTLE_MS` 的意思）。
2. **环境指纹**：页面在 `node.hello` 的原始值里多报一项 `cardRuntime`（运行时版本）。文档服务照旧自己算指纹，`node.welcome` 多回一个 `cardEnvFingerprint` = 现有三项（系统、显卡类别、Chrome 主版本）再加 `cardRuntime` 一起取摘要；`envFingerprint` 不变。内置卡的任务照旧用 `envFingerprint`，结果键一个字不变；用户卡、图卡的任务用 `cardEnvFingerprint`。
3. **切分**：页面发布清单计划时在 `input.browser` 里多带 `cardEnvFingerprint` 与 `cardSources`（本页载入成功的卡的代码身份）。切分方（桌面或独立渲染主机）的 `browserEligible` 去掉「不是用户卡图卡」「`cardSources` 为空」两条，换成：这张卡要的代码身份在 `input.browser.cardSources` 里；用户卡、图卡给浏览器的那一份细任务，`requires.envFingerprint` 写 `cardEnvFingerprint`。其余条件不变（共享档、独立卡、light / medium、不用只在发布方本机的素材、不是 Lottie 素材卡、没超体积上限）。
4. **认领**：`checkClaimable` 规则 1 对浏览器节点，任务带 `userCards` 或 `graphCards` 时拿 `node.cardEnvFingerprint` 比；规则 3 照旧按能力；规则 1 的卡片代码比对照旧，现在浏览器有得比了。
5. **结果键不串**：结果键 = 内容键 × 环境指纹。桌面节点的指纹里没有 `cardRuntime` 这一段，浏览器做用户卡、图卡用的指纹里有，所以即使两者在同一台机器上（系统、显卡、Chrome 主版本都相同），键也不同；环境不同更不同。锁照旧按卡：谁先认领谁得锁，一层只出自一种环境。
6. **别的成员能贴上**：层表照旧记每层的环境指纹与输入签名，在线页面按输入签名贴（不挑环境），所以浏览器节点做完的层别的在线成员能贴上。桌面成员按自己的键找，找不到这份，仍由桌面节点按桌面的键渲（与现在内置卡跨环境时相同）。
7. **执行**：仍在后台舞台的 `bake` 工作项里逐帧生成快照；用户卡、图卡在那里是活组件，与内置卡同一条路。

**图卡任务的一个风险**〔待定 2〕：图卡的画面是一张画布，快照里是整屏图的 data 地址，M7 的结论是浏览器里超过体积上限（300 KB）的帧会被丢弃，画布卡（`canvasHeavy`）因此不给浏览器。图卡按时间直接求值，没有画布卡「逐帧顺推不等价」的问题，但体积问题一样。实现时先量：1080p 的图卡帧若普遍超限，图卡任务就认领不了，这一项记「图卡任务浏览器节点不认领」的范围说明，图卡的预览活渲不受影响。要不要为图卡单开一个体积上限，是队列契约的改动，建议到时由主会话定。

服务端要动的文件在 `server/render-node/`（`fingerprint.mjs`、`filter.mjs`、`split.mjs`）与文档服务处理 `node.hello` 的地方；后者与第三段可能撞车（第 12 节）。

## 8. 失败时怎么退回

每张同步来的卡在本页有一个运行状态，由舞台报给编辑器页，参数面板与时间轴据此显示：

| 状态 | 什么时候 | 预览 | 参数面板的说明 |
|---|---|---|---|
| `ready` | 转译、载入、注册都成功 | 与内置卡相同（第 6 节） | 无 |
| `loading` | 源码取到了，还在转译或载入 | 当结果在路上：沙漏，不出图标 | 无 |
| `unsupported-syntax` | 预检拦下，或转译报错 | 原做法 | 「在线浏览器不能运行这张卡：用了在线页面不支持的写法（<哪一种>，<文件>）。画面由渲染节点提供。」 |
| `missing-module` | 引用了不支持的模块 | 原做法 | 「在线浏览器不能运行这张卡：引用了在线页面里没有的模块 <名字>。画面由渲染节点提供。」 |
| `load-error` | 执行模块顶层抛错、导出里没有卡片定义 | 原做法 | 「在线浏览器不能运行这张卡：载入时出错（<错误的第一行>）。」 |
| `gpu` | 图卡，图形能力不够（4.3） | 原做法 | 「这台设备的图形能力不够，图卡的画面由渲染节点提供。」 |
| `media` | 图卡，它的视频输入这台设备解不了 | 原做法 | 「这台设备解不了这段素材，图卡的画面由渲染节点提供。」 |
| `runtime-error` | 运行中抛错（React 错误边界接住）、或两次把舞台带死 | 原做法，本次会话不再挂它 | 「这张卡在在线浏览器里运行出错，本次改由渲染节点提供画面。」 |
| `not-isolated` | 本页不满足 3.1 的前提（同源单舞台、策略没生效、票据交接失败） | 原做法 | 「这个页面没有隔离的运行环境，用户卡与图卡的画面由渲染节点提供。」 |
| `low-memory` | 低内存档 | 原做法 | 「这台设备在低内存档，不运行用户卡与图卡的代码。」 |

「原做法」＝现在的规则原样：按重卡，贴预渲染结果，没有就发补渲，这一帧没有可贴的结果又轮到本机渲染时显示「电脑 + 离线」图标与「需要本地 PC 渲染辅助」，时间轴徽标的出现条件同图标。文案、图标、确认缺料的规则（`c10-contract.md` 第 9 节）都不改，只是触发它的卡从「所有用户卡、图卡」缩小到「本页运行不了的用户卡、图卡」。

声音的退回：声音线程里合成不了的（3.5 的三种：顶层碰了占位模块、读素材采样、超时或抛错），按任务书 B 的规则当判重处理：用已有产物，没有就交给渲染节点；面板写明原因。

**源码更新**：页面每 5 秒重列一次内容库（现有）。某张卡闭包里任一文件的哈希变了：重新转译变了的文件 → 把新一代模块发给两个舞台 → 舞台换掉注册表里这张卡并重挂用到它的片段 → 源码版本变了，成本身份跟着变，重新测量；节点报的代码身份跟着变。新一代载入失败时旧一代撤下、按失败状态退回，不拿旧代码画新版本。

**舞台被带死**：卡片代码让舞台跳走或卡死时，现有的舞台看守（心跳 15 秒、重载、三次后退回同源单舞台）照常工作。新增：重载前记下当时挂着哪些同步来的卡，同一张卡两次在场就标 `runtime-error`；退回同源单舞台后所有同步来的卡变 `not-isolated`。

**低内存档**：不预渲染、不当渲染节点、单个同源舞台，这些都不动。它不执行用户卡与图卡的代码（没有隔离环境），表现与现在完全相同：有预渲染小尺寸就贴，判重缺产物的发补渲，没有结果时显示图标与提示；声音用已有产物，没有就等渲染节点。**不需要动低内存档的现有规则。**

**在线导出**：导出页与编辑器页同源，不执行。用户卡与图卡在导出时一律当重卡，用预渲染原尺寸；缺的由导出前的核对拦下并等待，渲染节点（含本页后台舞台）补上后继续。任务书 A 的「导出时先生成声音」对用户卡、图卡的声音走 3.5 的舞台 Worker。

## 9. 语义改写的逐字稿

任务书 C 用户已定。实现阶段照此落，本轮不改文件。标〔裁〕的是本文加进 `mechanism/` 的数字与办法。

〔更正〕任务书说「`workflow/editing.md` 里『需要本地 PC 渲染辅助』出现的条件」：`workflow/editing.md`、`workflow/production.md`、`user-workflow.md` 里都没有这句话，出现条件写在 `product/platforms.md`、`product/rendering.md`、`glossary.md` 与 `c10-contract.md` 第 9 节。所以一级文档不用改。

### 9.1 `docs/semantics/product/platforms.md`

**（1）「在线浏览器模式」最后一条**

修改前：

> - 用户卡、图卡与内置卡一样：有预渲染结果就照贴，没有就照常发布补渲任务，由桌面版等渲染节点渲，结果到了自动换上。这台设备跑不了用户卡、图卡的代码，所以只有这一帧没有预渲染结果、又轮到这台设备自己渲染时，该片段在预览里显示「电脑 + 离线」图标和「需要本地 PC 渲染辅助」（见 rendering.md「兜底顺序」），不透明、不显示沙漏；时间轴上的片段同样提示「需要本地 PC 渲染辅助」，出现条件与图标相同。

修改后：

> - 在线浏览器可以执行经文档服务同步来的用户卡与图卡，画面和声音都算，和内置卡一样按轻重区分：判轻的在浏览器里跑，判重的用预渲染结果、没有就交给渲染节点。图卡要的素材原尺寸经素材服务凭票据取。
> - 用户卡与图卡只在隔离环境里执行，拿不到项目凭证与票据；图卡取素材用的那张票据由宿主代取，不交给卡片代码。编辑页面本身不执行它们的代码。
> - 转译失败、引用了在线页面里没有的模块、或这台设备的图形能力不够时，这张卡退回原来的做法：有预渲染结果就照贴，没有就照常发布补渲任务，由渲染节点渲，结果到了自动换上；只有这一帧没有预渲染结果、又轮到这台设备自己渲染时，该片段在预览里显示「电脑 + 离线」图标和「需要本地 PC 渲染辅助」（见 rendering.md「兜底顺序」），不透明、不显示沙漏；时间轴上的片段同样提示「需要本地 PC 渲染辅助」，出现条件与图标相同。参数面板说明这张卡为什么没在浏览器里运行。

**（2）「渲染节点」表里纯浏览器一行**

修改前：

> | 纯浏览器 | 在线浏览器模式的后台舞台 | 只认领当前登录用户自己产生的、不需要本机转码的快照任务，且一期只限内置卡片 |

修改后：

> | 纯浏览器 | 在线浏览器模式的后台舞台 | 只认领当前登录用户自己产生的、不需要本机转码的快照任务；内置卡片、用户卡、图卡的都可以，前提是这张卡在本页能运行 |

**（3）「面向的平台」低内存档「停下」一条里的一句**

修改前：

> 用户卡、图卡这台设备画不出来：有这一帧的预渲染结果就照贴，同内置卡；没有才显示明确的提示（「电脑 + 离线」图标和「需要本地 PC 渲染辅助」，见 `rendering.md` 的「兜底顺序」），不算占位符。

修改后：

> 低内存档不执行用户卡、图卡的代码：有这一帧的预渲染结果就照贴，同内置卡；没有才显示明确的提示（「电脑 + 离线」图标和「需要本地 PC 渲染辅助」，见 `rendering.md` 的「兜底顺序」），不算占位符。

同一节「补渲」一条的「用户卡、图卡也一样（由桌面版等渲染节点渲）」不改（低内存档仍然如此）。

**（4）「卡片声音的平台边界」**（这一节先由第一段按任务书 B 改写；下面的「修改前」是 B 改之前的现文，「修改后」是 B 与 C 都落之后应有的全文，第一段落了 B 之后本段只补最后一句）

修改前：

> - 有声动效卡的在线预览和导出消费已经同步的 WAV 产物，不因此允许在线执行用户卡片声音代码；没有有效产物时明确提示需要在本地生成。

修改后：

> - 在线浏览器可以自己合成声音，和画面一样按轻重区分：判轻的在浏览器里合成，判重的用已有产物、没有就交给渲染节点；测量合成耗时的时候静音，不出声。
> - 内置的提示音、键盘声、内置有声卡如此；用户卡与图卡的声音同样可以在线合成，只在隔离的后台线程里执行。要读素材采样的音频图卡不在线合成，用已有产物或交给渲染节点。

### 9.2 `docs/semantics/product/rendering.md`「兜底顺序」第七条

修改前：

> - 这台设备渲染不了的卡（在线浏览器模式下的用户卡、图卡，见 `platforms.md`）同样照兜底顺序贴预渲染结果；只有这一帧没有预渲染结果、又轮到这台设备自己渲染（活渲或停下追精确）时，才显示「电脑 + 离线」图标和「需要本地 PC 渲染辅助」，不显示沙漏，预渲染结果到了自动换上。它同样只出现在预览里，位置和层级规则与占位符相同。

修改后：

> - 这台设备运行不了的卡（在线浏览器模式下转译失败、引用了页面里没有的模块、图形能力不够的用户卡与图卡，以及低内存档下的全部用户卡与图卡，见 `platforms.md`）同样照兜底顺序贴预渲染结果；只有这一帧没有预渲染结果、又轮到这台设备自己渲染（活渲或停下追精确）时，才显示「电脑 + 离线」图标和「需要本地 PC 渲染辅助」，不显示沙漏，预渲染结果到了自动换上。它同样只出现在预览里，位置和层级规则与占位符相同。

### 9.3 `docs/semantics/glossary.md`「占位符」

修改前：

> | 占位符 | 兜底顺序尽头在卡片位置显示的沙漏加噪点，只出现在预览里；在线浏览器模式下轮到本机渲染、又渲染不了的卡（用户卡、图卡且没有预渲染结果）另显示「需要本地 PC 渲染辅助」 | 二 | product/rendering.md |

修改后：

> | 占位符 | 兜底顺序尽头在卡片位置显示的沙漏加噪点，只出现在预览里；在线浏览器模式下轮到本机渲染、这台设备又运行不了的用户卡或图卡，没有预渲染结果时另显示「需要本地 PC 渲染辅助」 | 二 | product/rendering.md |

### 9.4 `docs/semantics/mechanism/rendering.md`

**（1）「低内存档」界限搜索下的一条**

修改前：

> - 用户卡、图卡这台设备渲染不了，不参加搜索，按重卡。

修改后：

> - 低内存档不执行用户卡、图卡的代码，它们不参加搜索，按重卡。

**（2）「停下追一帧」最后一句**

修改前：

> 在线浏览器模式下用户卡、图卡不追：有这一帧的预渲染结果（预渲染小尺寸）就照贴，没有才显示「需要本地 PC 渲染辅助」的提示。

修改后：

> 低内存档下用户卡、图卡不追：有这一帧的预渲染结果（预渲染小尺寸）就照贴，没有才显示「需要本地 PC 渲染辅助」的提示。

**（3）「旧输入的层不贴」里的一句**

修改前：

> 过期后 15 秒内当结果在路上（用户卡、图卡显示沙漏，时间轴不挂徽标），过了还没等到新层按没有结果处理（图标、徽标）。

修改后：

> 过期后 15 秒内当结果在路上（本页运行不了的用户卡、图卡显示沙漏，时间轴不挂徽标），过了还没等到新层按没有结果处理（图标、徽标）；本页能运行的用户卡、图卡与内置卡同样处理。

**（4）换帧成本里的一句**：「认不出卡种的（页面上没有定义的用户卡、图卡）取 3 毫秒。」改为「认不出卡种的（本页运行不了的用户卡、图卡）取 3 毫秒。」

### 9.5 `docs/semantics/mechanism/platforms.md`（新增一节，全部〔裁〕）

> ## 在线执行用户卡与图卡
>
> - **在哪里执行**：画面只在与编辑页面跨源的两个舞台里执行；声音只在后台舞台起的专用后台线程里执行；编辑页面的源、同源的单舞台、导出页都不执行。本页不是双舞台、舞台的内容安全策略没生效、或素材票据交接不成功时不执行，按「需要渲染节点」处理〔裁：`online-card-exec-contract.md` 第 3 节〕。
> - **转译**：编辑页面用 Sucrase 把源码转成 CommonJS，结果存本页，内容哈希没变不重转；转译前先拦下它会转错或执行不了的写法（`namespace`、装饰器、`accessor`、顶层 `await`、`import.meta`、动态 `import()`）。单个文件上限 512 KB，一张卡的闭包上限 200 个文件〔裁：同上第 1 节〕。
> - **模块**：卡片能引的包与桌面相同，少 `three/` 下的子路径；相对导入引到用户卡目录的用同步来的源码，引到页面自带的卡片、部件、kernel 模块的用页面那一份；样式类名由页面带的 Tailwind 编译器按源码里出现的类名补生成〔裁：同上第 2 节〕。
> - **舞台的内容安全策略**：脚本、样式、图片、媒体、字体、连接都只许本源（另许 `data:`、`blob:` 的图片与媒体），后台线程只许从 `blob:` 起，不许子框架、表单、插件；舞台 iframe 带 `sandbox`，只开脚本与保有自己的源两项；编辑页面的策略限定舞台 iframe 只能载入舞台源〔裁：同上 3.3〕。
> - **WebRTC**：浏览器眼下不按策略拦它，舞台在执行卡片代码前去掉它的构造器并禁止出现子框架；这是脚本层面的加固，不是浏览器的保证〔裁：同上 3.4；待用户定〕。
> - **素材票据**：编辑页面把只读票据交给舞台源的服务端，换成卡片代码读不到的 cookie，只在本页会话的那一段路径上有效，有效期与票据相同（15 分钟）；舞台用不带票据的地址按 Range 取素材〔裁：同上第 4 节〕。
> - **图形能力**：拿不到 WebGL2、是软件渲染、最大纹理尺寸小于画幅长边、或运行中丢过上下文，算这台设备的图形能力不够〔裁：同上 4.3〕。
> - **在线卡片运行时版本**：加载规则的版本加转译器与 Tailwind 的版本。它进转译缓存的键、成本记录的设备串；纯浏览器节点做用户卡与图卡任务时，环境指纹在系统、显卡类别、Chrome 主版本之外再加它，所以结果不与桌面节点的共用一个键〔裁：同上第 5、7 节〕。
> - **声音线程的时限**：每秒声音给 2 秒墙钟，最少 10 秒，到时掐掉〔裁：同上 3.5〕。

同一文件「渲染节点」下「纯浏览器节点的环境指纹由文档服务按页面报来的原始值算……」一条后面补一句：「做用户卡、图卡任务时用的指纹另加在线卡片运行时版本，同样由文档服务算。」

### 9.6 `docs/semantics/mechanism/cards.md`

「声画同片段」一节末尾加一条：

> - 在线浏览器里，同步来的用户卡与图卡的 `audio()` 在舞台源的专用后台线程里执行；线程里没有 DOM，一载入就要 DOM 的包（`lottie-web`、`@tsparticles/*`）在那里是占位，声音代码用到就算在线合成不了〔裁：`online-card-exec-contract.md` 3.5〕。

### 9.7 `docs/plan/c10-contract.md`

**第 1 节范围表那一格**：「用户卡、图卡：有预渲染结果照贴，没有才出图标与时间轴提示（第 9 节，2026-09-29 改）」改为「用户卡、图卡：本页能运行的与内置卡相同；运行不了的有预渲染结果照贴，没有才出图标与时间轴提示（第 9 节，2026-10-06 改）」。

**第 9 节**开头加一段，并逐条改：

> 2026-10-06 用户改语义（任务书 `sound-online-render-task.md` 决定 C）：在线浏览器可以执行同步来的用户卡与图卡，做法见 `online-card-exec-contract.md`。本节下面各条里的「用户卡、图卡」自此读作「**本页运行不了的**用户卡、图卡」（转译失败、引用了页面里没有的模块、图形能力不够、本页没有隔离的运行环境、低内存档）；本页能运行的与内置卡走同一套（第 3、6 节）。

- 「识别」一条：「进注册表作『已知但本机不能运行』的条目」改为「进注册表作同步卡的条目，并交给舞台转译载入；载入成功的在舞台里是能运行的卡，失败的仍是『已知但本机不能运行』」；「这份视图不进主注册表，本机仍不运行这张卡」改为「这份视图不进编辑页面的主注册表，编辑页面仍不执行这张卡的代码」；「始终不执行用户源码」改为「编辑页面始终不执行用户源码」。
- 「预览」一条：「它们在这台设备上一律按重卡：播放中抑制、不活渲，停下不追。」改为「本页运行不了的在这台设备上按重卡：播放中抑制、不活渲，停下不追。」；末句「纯浏览器节点仍不认领用户卡、图卡的细任务（M7 契约照旧）」改为「纯浏览器节点认领本页能运行的用户卡、图卡的细任务（`online-card-exec-contract.md` 第 7 节）」。
- 「时间轴」一条：「片段是这台设备跑不了的卡」不改（意思已经对），后面补「（本页能运行的用户卡、图卡不算）」。
- 「测量」一条末尾补：「同步来的卡还要等第一次载入有了结果。」
- 「音频图卡」一条末尾补：「2026-10-06 起：不读素材采样的音频图卡在线合成；读素材采样的不在线合成，用已有产物或交给渲染节点，面板说明原因。」

**第 10 节**里引用的「一期只支持内置卡片」一句是说合并 `.proc` 里的卡进本机卡片目录，与执行无关，改为「本机没有进程」即可。

**第 20 节 C10-A6**：末尾补「本页能运行的用户卡、图卡另见 `online-card-exec-contract.md` 第 11 节的验收」。

### 9.8 `docs/plan/m7-contract.md`

- 开头「依据」里「一期只限内置卡片」改为「内置卡片与本页能运行的用户卡、图卡（2026-10-06 改，`online-card-exec-contract.md` 第 7 节）」。
- 第 1 节范围表：「轨道流、要转码的任务、本地档（整场景）快照、用户卡、图卡、改过源码的卡：不认领（语义『一期只限内置卡片』；规则 1～4）」改为「轨道流、要转码的任务、本地档（整场景）快照、本页运行不了的用户卡与图卡、改过源码的内置卡：不认领（规则 1～4）；本页能运行的用户卡、图卡可以认领（2026-10-06 改）」。
- 3.2：「不要转码、不是流；不是用户卡、图卡；`requires.cardSources` 为空（……）」改为「不要转码、不是流；用户卡、图卡要节点报了对应能力；`requires.cardSources` 里每张卡的代码身份节点手里都有（没改过的内置卡由 `codeVersion` 覆盖，契约 B.4 末）」。
- 3.3：「（共享档、medium、独立卡、非用户卡图卡、`cardSources` 为空、没锁在第三种环境上）」改为「（共享档、light / medium、独立卡、要的卡片代码身份在 `input.browser.cardSources` 里、没锁在第三种环境上）」；「再按浏览器的指纹出一份」后补「用户卡、图卡用 `input.browser.cardEnvFingerprint`」。
- 4.4：「外部字体在这条路上会退回系统字体，只影响用户卡（内置卡只用系统字体，用户卡不进浏览器）」改为「……只影响用户卡（内置卡只用系统字体）；用户卡自 2026-10-06 起会进浏览器，用到外部字体的用户卡小尺寸与桌面有差异，记在范围说明里」。
- 第 10 节 M7-A3：「heavy 快照、流、plan、本地档、用户卡、改过源码的卡」改为「heavy 快照、流、plan、本地档、本页运行不了的用户卡与图卡、改过源码的内置卡」；另加一条 M7-A3b：「本页能运行的用户卡、图卡任务照常认领并完成」。

### 9.9 `docs/plan/render-queue-contract.md`

J.4 规则 3 的文字不改（仍按能力比），表下加一句注：「纯浏览器节点自 2026-10-06 起在本页能运行时报 `userCards` / `graphCards` 为真；规则 1 对它的用户卡、图卡任务比的是 `cardEnvFingerprint`（`online-card-exec-contract.md` 第 7 节）。」B.2 节点描述里加 `cardEnvFingerprint` 一项。

## 10. 安全验收探针的设计（任务书第 14 条）

新探针 `scripts/probes/online-card-security-probe.mjs`，在可行性探针的摆法上换成真的在线构建与本机托管组合：仿 nginx 的代理开三个源，带第 3.3、4.1 节的全部响应头与两条 `/media-s/` 路由；另起一个不同站的收集站（记 TCP 连接、UDP 包、HTTP 请求）。创建者把两张卡的源码 `content.put` 进内容库：一张恶意用户卡（`Component` 加 `audio()`），一张恶意图卡（`card()` 加 `audio()`），各自把试探结果画在自己的画面里并存进舞台的一个全局变量（探针经 CDP 进舞台的帧去读，不经父页）。Chrome 开网络日志。

| 组 | 试什么 | 断言 |
|---|---|---|
| 项目凭证 | `parent.*`、`top.*`、舞台源的 `localStorage` / IndexedDB / OPFS / Cache / cookie 全部枚举；全局变量与模块闭包里找凭证的形状 | 读父页属性抛 `SecurityError`；枚举结果里没有创建者与成员的凭证串（探针知道它们的值，逐个比） |
| 素材票据 | `document.cookie`、`cookieStore.getAll()`、`performance.getEntries()` 的地址、DOM 里所有 `src` / `data-pc-media-src`、全局变量、`mediaTierPolicy()`（卡能经相对导入引到的页面模块） | 都不含票据串，也不含 `?t=` |
| 本机存储 | 上面的枚举再加 `navigator.storage.estimate()`、`indexedDB.databases()` | 没有编辑器页写的库名（页面内快照库、成本表、设备身份） |
| 父页对象 | `parent`、`top`、`opener`、`frameElement`、`window.frames`、`window.length`、给父页发伪造的 RPC 回包与各种 `StageEvent` | 读不到；父页对伪造消息不崩、不把超范围的数写进成本记录与快照库（探针读父页状态核） |
| 外传 | 第 3.3 节表里的每一种，加导航类五种，加 WebRTC（STUN、TURN）、加对域名的 `dns-prefetch` | 收集站 0 连接 0 包 0 请求；网络日志里没有对收集站域名的解析；顶层地址没变、没开出新窗口 |
| 声音线程 | 同一张卡的 `audio()` 里：`self.parent`、`document`、`localStorage`、`indexedDB.databases()`、`fetch` / WebSocket / `importScripts` / 再起 Worker / `RTCPeerConnection` | 前三个是 `undefined`；库名里没有编辑器页的；网络全拦下；`RTCPeerConnection` 是 `undefined` |
| 对照 | 同一张恶意卡在去掉策略与 sandbox 的摆法里跑 | 收集站收得到，证明探针看得见 |
| 编辑器页不执行 | 卡的模块顶层往 `globalThis` 写一个记号 | 编辑器页、导出页、同源单舞台（另开一页强制握手失败）、低内存档（另开一页仿手机）里都没有这个记号；两个舞台里有 |
| 加固 | 第 3.4 节那 21 条路再加实现时想到的 | 取决于〔待定 1〕：选甲则每条都拿不到构造器、收集站 0 包；选乙则断言「自检判未隔离、画面不执行」 |

## 11. 功能验收与原有探针

### 11.1 任务书第 15 条

新探针 `scripts/probes/online-card-exec-probe.mjs`：本机托管组合加在线构建；创建者一侧不起桌面编辑器（证明没有任何预渲染产物时也画得出来），卡片源码直接 `content.put`。五张卡：用户画面卡、用户有声卡、带相对导入的用户卡（引一个同目录文件、一个 `../native/hud`、一个 `.css`）、带视频输入源的图卡、音频图卡。

| 项 | 怎么验 |
|---|---|
| 判轻的直接画出来 | 层表为空、没有任何 `snap/` 请求时，舞台里这几张卡的片段是活组件、没有图标、时间轴没有徽标；截图；图卡取一个像素比对视频帧的颜色 |
| 听得到声音 | 不靠人听：探针读混音输入端的采样（非零、时长对），测量期间输出端为静音（沿用第一段给 B 写的断言办法） |
| 改参数即时生效 | 在参数面板改文字与数字，下一帧舞台里的 DOM 跟着变；另一成员看得到 |
| 判重的仍走预渲染或渲染节点 | 放一张故意很慢的用户卡（每帧忙等），测量后判重：播放中不活渲、清单计划含它、探针替渲染节点写层后贴上 |
| 三种退回 | 各放一张：用 `namespace` 的、引 `lodash` 的；图形能力不够用 Chrome 参数 `--disable-gpu --disable-software-rasterizer` 另开一页。断言：按原做法（图标、徽标、发布补渲），参数面板出现第 8 节对应的那句说明 |
| 源码更新后跟着换 | `content.put` 新一版（改一个颜色）：10 秒内舞台里的画面换了、成本身份换了、节点报的代码身份换了 |
| 低内存档 | 仿手机另开一页：两个舞台里都没有执行记号；表现与现有 `online-user-cards-probe` 的低内存档断言相同 |

### 11.2 任务书第 16 条

在 `m7-browser-probe.mjs` 里加一组（同一套协调办法）：

- 本人发布的用户卡任务、图卡任务各若干：纯浏览器节点认领并完成，层表里那一层的环境指纹是 `cardEnvFingerprint`；另一成员的在线页面贴得上。
- 别人发布的同类任务：认领 0 次（规则 0）。要转码的、流：认领 0 次（规则 2）。
- 同一张卡桌面节点与浏览器节点各做一份：两个结果键不同（探针直接比键），层表里一层只出自一种环境。
- 浏览器节点手里没有这张卡的代码身份（内容库里是另一版）：认领 0 次（规则 1）。

### 11.3 原有探针要改的断言（任务书第 17 条）

`online-user-cards-probe.mjs`：同步卡 `probe-synced-card` 现在在普通档能运行，下列断言按新语义改；为了继续覆盖「运行不了」的那条路，再加一张故意运行不了的同步卡 `probe-broken-card`（源码里用 `namespace`），把原来针对 s2～s7 的图标、徽标、沙漏断言原样挪到用它的片段上。

| 行 | 原断言 | 改成 |
|---|---|---|
| 441～447 | 没有层的同步卡 s2 是「需要本地 PC 渲染辅助」 | s2（能运行）：没有层时是活组件、没有图标；原断言挪到坏卡片段 |
| 465 | 时间轴 s2 有徽标 | s2 没有徽标；坏卡片段有 |
| 524、526～527 | 乙：s2、s3 确认之后是图标加徽标 | 乙：s2、s3 是活组件；坏卡片段确认之后是图标加徽标 |
| 578、656～657 | 测量从没测过同步卡片段 | 测量在同步卡**载入成功之后**才测它；坏卡片段从没被测过 |
| 580 | 测量门在卡片源码第一次同步完时开 | 测量门在卡片源码同步完且第一次载入有结果时开 |
| 595～605 | 小片段图标、缩放、沙漏的大小（s4～s7） | 这几段换成坏卡，断言不变 |
| 671～672 | s2 产物到了换上快照、撤掉图标 | 坏卡片段：同原断言；s2：判重时贴层的断言挪到 11.1 |
| 476 | 清单计划含用户卡与同步卡片段 | 清单计划含判重的与坏卡的；判轻的能运行的同步卡不在预渲染集合里 |
| 697、706 | 低内存档：补渲含 s3、舞台上 s3 是图标 | 不变（低内存档不执行） |

`c10-browser-probe.mjs --user-card`：仓库用户卡 `mu-animated-shiny-text` 是在线包里构建时就有的卡（不是同步来的），它在在线页面里本来就有定义。

| 行 | 原断言 | 改成 |
|---|---|---|
| 1757 | 成员页发布的清单计划含用户卡片段（页面一律按重卡） | 标签去掉「页面一律按重卡」；用户卡判重时清单计划含它（探针把这张卡的成本记录预置成重） |
| 1776～1777 | 桌面节点渲出、成员页贴上；那一层出自创建者的桌面节点 | 保留，前提改为「这张卡判重且成员页不当节点」（探针给成员页带 `?node=0` 或现有的关节点开关）；另加一条：不预置成本时成员页直接活渲、没有图标 |

`c10-ui-probe.mjs`：A6 那一组断言的是「有层照贴、不挂徽标、点得选中、改动同步」，新语义下仍成立，不用改；只需把探针里用户卡的成本预置成重，保证它仍走贴层那条路。

`m7-browser-probe.mjs`：

| 行 | 原断言 | 改成 |
|---|---|---|
| 1004、1006 | `forbiddenClasses` 含 `userCard`、`graphCard`，替身节点认领 0 次 | 替身节点仍报 `userCards: false`，断言不变（规则 3 本身没变） |
| 1247～1248、1262、1927 | 真页面对 `userCards` / `graphCards` 任务认领 0 次 | 这两类从禁止清单移到两组新断言：页面**有**对应代码身份的认领并完成（11.2）；**没有**的认领 0 次 |

`m7-node-probe.mjs`：没有相关断言，不改。

`online-stale-layer-probe.mjs`、`desktop-auto-node-probe.mjs`，以及单测 `src/editor/onlineUserCards.test.mjs`、`src/render/c10a-l17-lowmem.test.mjs`、`server/test/c10-ui-gates.test.mjs`：里面有按旧规则写的用例，实现时逐个过，改法同上（「所有用户卡、图卡」→「本页运行不了的」），改了哪条在报告里逐条列。

桌面版：本段不改桌面的渲染路径（新代码都在 `ONLINE` 分支或在线专用模块里），但动了 `Stage.tsx`、`placeholderHost.ts`、`mediaTier.ts` 这些共用文件，所以照任务书跑一次完整的渲染附加项，与 main 像素 0 差异。

## 12. 文件清单与分工建议

### 12.1 会新增或改的文件

| 块 | 文件 |
|---|---|
| 运行时（新增，`src/online/cardRuntime/`） | `version.ts`（运行时版本）、`precheck.mjs`（写法预检）、`transpile.ts`（Sucrase 与 Tailwind，编辑器页用）、`transpileCache.ts`、`hostModules.ts`（包与内置模块的表）、`loader.ts`（舞台里执行 CommonJS、注册、换代、状态）、`cardCodeIdentity.mjs`（与服务端共用的代码身份）、`soundWorker.ts` 与 `soundHost.ts`（舞台 Worker）、`gpuCapability.ts`、`harden.ts`（3.4 的加固）、`isolationCheck.ts`（策略自检） |
| 舞台与协议 | `src/render/stageRpc.ts`（`loadUserCards`、`synthCardAudio`、状态事件；`setMediaPolicy` 去票据）、`src/StageView.tsx`、`src/render/Stage.tsx`、`src/render/placeholderHost.ts`、`src/render/mediaTier.ts`、`src/render/cards/mediaSource.ts`、`src/render/cards/audioSources.ts`、`src/kernel/registry.ts`（运行时注册的卡与运行状态）、新入口 `stage.html` 与 `vite.config.ts`（在线构建多一个入口；Worker 的起法） |
| 编辑器页 | `src/editor/Preview.tsx`（iframe 的 `sandbox`、票据授权、发模块、校验舞台消息）、`src/editor/sync/onlineCardSources.ts`（转译与下发）、`src/editor/costIdentity.ts`、`src/editor/snapshotFeed.ts`、`src/editor/stageSwap.ts`、`src/editor/measureGate.ts`、`src/editor/lowMemorySearch.ts`、`src/editor/timeline/localPcBadge.ts` 与 `ClipView.tsx`、参数面板（`src/editor/left/paramsView.ts`、`Inspector.tsx`、`CardAudioForm.tsx`）、`src/online/stageWatch.ts`、`src/online/stageHandshake.ts`、`src/online/browserNode.ts`、`src/online/planPublisher.ts`、`src/export/onlineExport.ts`（导出时用户卡一律当重卡） |
| 服务端与部署 | `server/render-node/fingerprint.mjs`、`filter.mjs`、`split.mjs`；文档服务处理 `node.hello` / `node.welcome` 的地方；`server/vite-plugin-cards.ts`（`cardCodeIdentity` 改为调共用模块）；`server/hosted/deploy/nginx-site-promptcut-stages.conf`、`nginx-site-promptcut.conf`、`README.md`；`scripts/remote/docservice.mjs` 的 `deploy-hosted`（多一个入口文件） |
| 探针与测试 | 新：`online-card-security-probe.mjs`、`online-card-exec-probe.mjs`；改：第 11.3 节各项；各探针里仿 nginx 的代理（加响应头与 `/media-s/`，建议抽成一个共用的 `scripts/probes/lib` 模块）；各块的单测 |
| 文档 | 第 9 节各处；`package.json` 加 `sucrase` |

### 12.2 拆法

| 块 | 内容 | 谁 | 依赖 | 量 |
|---|---|---|---|---|
| S 安全隔离 | 舞台入口与策略、`sandbox`、票据换 cookie（nginx 模板、探针代理、`Preview`、`mediaTier`）、父页消息校验、加固与自检、Worker 起法、安全探针 | opus-dev | 无；最先做，别的块都要它的舞台入口与探针代理 | 大 |
| T 转译接入 | 预检、转译与缓存、模块表、加载器、注册与换代、运行状态、Tailwind、代码身份共用模块 | opus-dev | S 的舞台入口（可先在旧入口上做，后并） | 大 |
| G 图卡在线执行 | 素材地址、图形能力判定、图卡挂载与退回、音频图卡的范围 | opus-dev | S 的票据、T 的加载器 | 中 |
| A 声音线程 | 舞台 Worker 宿主、模块表的占位、与 B 的分派对接、导出前生成 | opus-dev（隔离相关）或 sonnet-dev-high 照 3.5 做 | T；`claude/sound-ab` 落定 | 中 |
| L 轻重与界面 | 六处判断换成「能不能运行」、测量门、面板说明、徽标、导出页规则 | sonnet-dev-high | T 的运行状态 | 中 |
| N 浏览器节点与队列 | 能力、指纹、切分、认领、M7 探针新断言 | sonnet-dev-high，opus-dev 审 | T 的代码身份 | 中 |
| P 探针与旧断言 | 功能探针、11.3 的改写、单测 | sonnet-dev-high | L、N | 中 |
| D 语义与契约 | 第 9 节落文件 | sonnet-dev-high | 待定项定了之后 | 小 |

S 与 T 可以并行开工（T 先不依赖新入口）；G、A、L、N 在 T 的加载器有了之后并行；P、D 收尾。按子 Agent 的轮次估：S、T 各两到三轮，其余各一到两轮，再加一轮集成与完整渲染附加项。

### 12.3 可能撞车的文件

| 对方 | 文件 | 怎么避 |
|---|---|---|
| `claude/sound-ab`（第一段 A、B） | `src/audio/cardAudio.ts`、`src/editor/io/cardAudioGeneration.ts`、`src/render/cards/audioSources.ts`、`src/editor/left/CardAudioForm.tsx`、`src/export/browserExport.ts` 与 `onlineExport.ts`、`src/online/` 里声音相关的新文件、`product/platforms.md`「卡片声音的平台边界」、`mechanism/` 的声音数字 | 本段在这些文件里只加「按卡的来源选宿主」的接口点，等 sound-ab 合进集成分支后再接；块 A 排在它之后 |
| 第三段（云节点渲染服务） | 文档服务处理 `node.hello` / `node.welcome` 的地方、`server/render-queue/`、`server/render-node/filter.mjs` 与 `split.mjs`（第三段的托管方渲染节点也要认领用户卡、图卡任务）、`server/hosted/deploy/` 的模板与 README、`product/platforms.md`「渲染节点」表 | 块 N 的服务端改动尽量只落在 `server/render-node/`；`node.welcome` 多回一个字段是加法；nginx 模板两段改的是不同的 server 块与不同的 location，合流时手工并；「渲染节点」表本段改纯浏览器一行、第三段加托管方一行 |

## 13. 拿不准、要主会话或用户定的

1. **WebRTC 缺口**（3.4）：选甲（脚本加固后交付，如实写明不是浏览器保证）还是乙（画面只在浏览器真拦得住 WebRTC 时执行，今天等于不执行）。这一条决定第二段的画面部分做不做，建议在开工前定。
2. **图卡任务的体积上限**（第 7 节末）：实现时先量；超限的话是接受「图卡任务浏览器节点不认领」，还是改队列契约给图卡单开上限。
3. **声音产物的键不带运行时版本**（第 5 节）：本文裁为不带，好与桌面的产物通用；若主会话认为「转译器版本都要进」对声音也要字面执行，就改成带，代价是在线合成的与桌面合成的声音互不通用。
4. **读素材采样的音频图卡本期不在线合成**（3.5）：本文裁为退回；要做的话得给远程素材服务加取采样块的路由（服务端改动），或接受浏览器解码与 ffmpeg 不逐样本相同。
5. **编辑器页只加 `frame-src` 一条策略**（3.3）：给编辑器页上全套策略是更大的一件事，本文裁为不在本段做。
6. **审阅表不同步**（第 2 节末）：同步来的用户卡在线上按缺省能力处理，建议另立一项把用户卡的审阅条目也同步。
7. **nginx 要改**：策略头与 `/media-s/` 两条路由都要动新节点的 nginx（改配置后 `nginx -t`、reload，不重启托管服务）。任务书写第二段在新节点上「只换静态页面」；按「做法与验收节奏」这一步本来就挪到最后统一做，届时换页面与改 nginx 要一起，顺序是先改 nginx 再换页面。旧页面在新 nginx 下照常工作（旧的 `/media` 路由保留）；新页面在旧 nginx 下自检不过，自动不执行用户卡，不会裸奔。

## 14. 依据

**探针**（可行性，已提交）：`node scripts/probes/online-card-isolation-feasibility-probe.mjs`，端口 5720、5721、5727，约 1 分钟，退出码 0；最后一行 JSON 里 `notes` 是两条缺口。

**体积与转译**（工作区外的临时目录里单独装包量的，没动仓库的 `package.json`）：各候选用 esbuild 压缩打包后 gzip -9 的字节数；Sucrase 与 TypeScript 各转一遍仓库里 166 个卡片与部件文件，比通过数与耗时；十二种写法逐个转译再 `new Function` 试语法。复现：临时目录里 `npm i sucrase esbuild-wasm @babel/standalone typescript@5.9.3 @swc/wasm-web oxc-transform @tailwindcss/browser esbuild`，按上面的办法量。

**WebRTC**：本机实测 `Content-Security-Policy: webrtc 'block'` 之下 Chrome for Testing 152.0.7977.75（默认、开实验性网页平台功能两种）与本机安装的 Chrome 154.0.8037.98 都照样把 STUN 包发到了本机的 UDP 监听端口。

**外部资料**：
- W3C《Content Security Policy Level 3》（`webrtc` 指令的定义、`frame-src` 管子框架的导航、本地方案的文档继承策略）：https://www.w3.org/TR/CSP3/
- w3c/webrtc-nv-use-cases 第 35 号议题「WebRTC bypass CSP connect-src policies」：https://github.com/w3c/webrtc-nv-use-cases/issues/35
- Sansec 的报告，实例说明 WebRTC 可以绕过严格策略外传数据：https://sansec.io/research/webrtc-skimmer
- csp-sandbox-egress-lab，量严格策略加 sandbox 之下还剩哪些出口（导航、DNS 预解析、WebRTC），结论是策略本身不是出口防火墙：https://github.com/ejc3/csp-sandbox-egress-lab
- w3c/webappsec 第 656 号议题「CSP and data exfiltration」：https://github.com/w3c/webappsec/issues/656
