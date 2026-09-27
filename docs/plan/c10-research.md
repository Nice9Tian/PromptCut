# C10 其余 / M7 浏览器行为调研

> 来源：codex（`gpt-6-sol` / `high`，只读联网），2026-09-27 查，thread `01a0e00f-840a-72f3-a7f5-4b55c61ad929`；主会话照原文收录，只把浏览器页面生命周期的 frozen 译作「挂起」（`constraints.md` 用词）。取舍见 `c10-contract.md` 第 17 节；第 Q1 第 5 条「L1 的 iframe 最好与编辑器同源」已被探针推翻（`c10-contract.md` 第 15、18 节）。

以下建议按仓库现有边界制定：在线普通档由后台 iframe 生成快照，L2 用 IndexedDB 缓存；手机和 iPad 属低内存档，不启动后台预渲染，也不当纯浏览器节点。鉴权契约采用 **PBKDF2-HMAC-SHA256，60 万次、16 字节盐、32 字节输出**，再用派生密钥做 HMAC-SHA256 挑战应答；素材票据有效期为 15 分钟，连接票据为 2 分钟。参见 [目标 L](/C:/Users/admin/Documents/PromptCut/docs/plan/cloud-task.md:372)、[平台语义](/C:/Users/admin/Documents/PromptCut/docs/semantics/product/platforms.md)、[鉴权契约](/C:/Users/admin/Documents/PromptCut/docs/plan/auth-contract.md:26)。

下文的缓存容量和调度数值是**建议的产品预算**，不是浏览器保证值。本次没有在目标设备上做性能实测。

## Q1 IndexedDB 配额与淘汰

### 结论

浏览器给的是**整个源**的存储额度，IndexedDB 与同源其他受配额管理的数据共享它；额度也不等于当前可用磁盘空间。浏览器发生存储压力时通常按源的最近使用情况回收，可能一次清掉整个源的数据，页面不能指望事前通知。PromptCut 的 L2 应当是可从素材服务重建的缓存，自行实行按快照块计量的 LRU。[MDN 配额与淘汰说明](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)、[WebKit 存储政策](https://webkit.org/blog/14403/updates-to-storage-policy/)

### 依据

[WebKit 存储政策](https://webkit.org/blog/14403/updates-to-storage-policy/)明确给出 Safari 17 起的源配额、跨源 iframe 配额、整源 LRU，以及 `estimate()`、`persist()` 的启发式授予方式。[WebKit ITP 说明](https://webkit.org/tracking-prevention/)把 IndexedDB 列入「连续七个 *Safari 使用日* 没有与网站交互后清除」的脚本可写存储，并注明主屏幕 Web App 的豁免。[Storage Standard](https://storage.spec.whatwg.org/)和 [IndexedDB 规范](https://www.w3.org/TR/IndexedDB/)分别说明估算、持久模式与空间不足时的写入错误。

### 浏览器差异

| 浏览器 | 普通模式下的源配额与持久化 | 私密模式 |
|---|---|---|
| Chrome / Edge | Chromium 源配额最高约为磁盘总容量的 **60%**；`persist()` 根据站点使用情况自动准许或拒绝，通常不弹窗。 | 数据临时保存并在私密会话结束后删除；**没有可作为产品常量的统一 IndexedDB 上限**。 |
| Firefox | 默认取磁盘总容量 **10% 与 10 GiB 中较小者**，同站点的源受组限制；获准持久化后最高为磁盘总容量的 **50%，上限 8 TiB**，不受该组限制。`persist()` 会向用户请求权限。 | 版本行为曾变化；当前不能套用普通模式配额，应以实际打开、写入结果判断，结束会话后不得期待保留。 |
| Safari macOS | Safari 17／macOS 14 起，浏览器应用的单源最高约 **60%**、所有源合计最高约 **80%**；`persist()` 按启发式判断，例如是否作为独立 Web App 打开。跨源 iframe 的配额约为主框架源配额的 **1/10**。 | 临时会话；不能承诺固定容量或跨会话保留。 |
| Safari iOS / iPadOS | Safari 17／iOS、iPadOS 17 起大体沿用上述 WebKit 浏览器配额，但实际仍受设备剩余空间和系统回收影响。主屏幕 Web App 有单独的数据容器及 ITP 七天规则豁免。 | 临时会话、容量不可承诺；低内存档尤其应按写入失败设计。 |
| Android Chrome | 使用 Chromium 配额模型；百分比不能当成手机实际可写字节数，系统低空间和页面回收会先起作用。 | 同样不承诺固定上限，结束私密会话即丢失。 |

上述百分比是浏览器的**最高配额计算方式**，并非对 PromptCut 的预留空间；`navigator.storage.estimate()` 返回估算值，也不能替代捕获 `QuotaExceededError`。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)、[WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)

### 解决路径

1. HTTPS 在线页启动时尝试 `navigator.storage?.estimate()`；只有用户确实需要保存难以重建的数据时，才在用户操作后尝试 `persist()`。快照可从素材服务恢复，**不要把 `persist()` 成功当作 L2 正确性的前提**。明文局域网 HTTP 页面没有 `navigator.storage` 时，直接使用内部预算。[Storage API](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API)
2. 建议普通档先设 **256 MiB** 的压缩快照软上限，低内存档 **64 MiB** 且只存小尺寸档；如果拿到估算值，再把上限收紧到 `min(上述上限, 估算剩余额度的 10%)`。具体数值应在真实项目的块大小分布和目标设备上校准。计量使用写入的 deflate 字节数，另留索引与其他同源数据的余量。
3. 用现有 `[kind, key, localFrame]` 键复用块；维护压缩字节数和最近访问时间。先清理未被当前项目使用、可从服务重新下载、且**不在上传队列**中的旧块。删除块与更新 `ranges` 放在一致的事务中；命中缺失块时从清单重新拉取或交给 L1 生成。
4. 写入失败时先回收一批 LRU 块，再重试**一次**；仍失败就停写本地缓存，继续通过网络或当前会话内存使用快照。重新打开时核查 `costs`、`snapshots`、`ranges` 的一致性，不把 `costs` 命中误当作快照仍在。
5. L1 iframe 尽量与编辑页同源。跨源 iframe 在 Safari 不但有独立、较小的分区配额，数据也不能直接与父页共用；若跨源，只让父页负责 L2 写入，通过 `postMessage` 传结果。

### 已知的坑

Safari 的七天规则对「在线编辑器的快照库」意味着：用户一周多没有**交互**后，下次可能整库为空；仅后台访问或定时器活动不能当作续期。主屏幕 Web App 有豁免，但普通 Safari 标签页没有这项承诺。浏览器自行淘汰通常没有可依赖的逐项通知；`QuotaExceededError` 只报告当前写入失败。私密窗口及用户手动清站点数据也会让 `costs` 与快照一起消失。[WebKit ITP](https://webkit.org/tracking-prevention/)、[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria/)

## Q2 局域网明文 HTTP 的 API 与挑战应答

### 结论

`http://192.168.x.x:port` **不是安全上下文**；不能把 `localhost` 的例外套用到局域网 IP。此时 `crypto.subtle`、`crypto.randomUUID()`、Service Worker、`navigator.storage`（因而包括 `estimate()`／`persist()`）及 WebCodecs 的受限接口不可作为可用能力；`crypto.getRandomValues()` **仍可用**。普通 IndexedDB、`fetch`、WebSocket、Dedicated Worker 仍可按各自条件使用。安全上下文判断以 `window.isSecureContext` 和实际特性检测为准。[安全上下文规范](https://www.w3.org/TR/secure-contexts/)、[MDN 受限 API 列表](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts/features_restricted_to_secure_contexts)、[Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Crypto)

### 依据

[Web Crypto Level 2](https://www.w3.org/TR/webcrypto-2/)将 `subtle` 限于安全上下文；[MDN `getRandomValues()`](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues)明确称它是 `Crypto` 中可用于非安全上下文的成员。[MDN `Navigator.storage`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/storage)和[受限 API 列表](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts/features_restricted_to_secure_contexts)覆盖 Storage API、Service Worker 与 WebCodecs。仓库[鉴权契约](/C:/Users/admin/Documents/PromptCut/docs/plan/auth-contract.md:273)还规定口令原文按 UTF-8 编码、不做 NFC，HMAC 密钥使用派生出的原始 32 字节。

### 浏览器差异

| 浏览器 | 局域网明文 HTTP 的判断 |
|---|---|
| Chrome / Edge | 上述安全上下文限制适用；`localhost` 可视作可信源，`192.168.*` 不可。 |
| Firefox | 同一安全上下文边界；WebCodecs 还应逐接口检测，不能从「浏览器支持 WebCodecs」推断某种编解码器可用。 |
| Safari macOS | 同一边界；WebCodecs 本身的编解码器和版本差异另算。 |
| Safari iOS / iPadOS | 同一边界，且低内存档按平台语义不做 L1／M7。 |
| Android Chrome | 同 Chromium 边界；纯 JS KDF 在手机上的耗时更需按设备测量。 |

### 解决路径

- 安全上下文用 `crypto.subtle.importKey('raw', …, 'PBKDF2', false, ['deriveBits'])`，再以 `{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }` 派生 **256 位**；HMAC 用 `importKey('raw', K, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])`。非安全上下文保持**同一协议参数与字节编码**，改由专用 Worker 中的纯 JS 实现计算。
- 首选候选库是 [@noble/hashes](https://github.com/paulmillr/noble-hashes)：MIT，持续维护，提供 `pbkdf2Async`、HMAC、SHA-256 的分模块导入；其 README 报告单独 SHA-256 约 **2.8 KB gzip**，这**不是 PBKDF2＋HMAC 的总包体积**，应以实际构建测量。可用 `pbkdf2Async(sha256, passwordBytes, saltBytes, { c: 600000, dkLen: 32 })`，`hmac(sha256, K, messageBytes)`。
- 若纯 JS 在目标手机上过慢，可评估 [hash-wasm](https://github.com/Daninet/hash-wasm) 作为第二实现：主许可证 MIT，SHA-256 模块标称约 **7 KB gzip**，PBKDF2／HMAC 还要计算额外封装体积；它是 **Wasm 而非纯 JS**，打包前须核其嵌入 C 源码的许可。[许可证](https://github.com/Daninet/hash-wasm/blob/master/LICENSE)。[CryptoJS 的维护状态及旧 PBKDF2 默认值问题](https://github.com/brix/crypto-js/security/advisories/GHSA-xwcq-pm8m-c4vf)使它不适合作为新兜底的首选。
- 在构建验收中用相同口令、原始盐、nonce 和用途串与 `node:crypto` 逐字节对拍；重连每次重新取挑战，绝不复用 nonce。Worker 计算期间显示进度／等待状态，不占编辑页主线程。

**耗时口径：**目前没有 PromptCut 目标浏览器的 60 万次 SHA-256 实测，不能报一个可信的固定毫秒数。[hash-wasm 作者基准](https://github.com/Daninet/hash-wasm#benchmarks)是在 Ryzen 9 7900X／Chrome 131 上对**1000 次 SHA-512**测得 588 次操作／秒（Wasm）、395 次／秒（noble）；线性外推到 60 万次约为 **1 秒、1.5 秒量级**，但算法、机器及浏览器均不同，**不是本协议的实测结果**。实现前应在桌面及 Android 的目标机跑 60 万次 SHA-256 的中位数与较慢分位，尤其检查手机是否达到数秒以上。

### 已知的坑

纯 JS 的比较循环不能承诺真正的常量时间。服务端应先确认解码结果恰为 32 字节，再用 `crypto.timingSafeEqual` 比较 HMAC；Node 文档也提醒外围代码仍可能泄露时序。[Node `timingSafeEqual`](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)。明文 HTTP 上的纯 JS 密码学只解决 **缺少 `subtle` 的兼容性**；页面脚本和传输本身仍可被同网段中间人篡改或观察，这一点不能由挑战应答消除。[安全上下文规范的威胁说明](https://www.w3.org/TR/secure-contexts/)

## Q3 媒体元素鉴权

### 结论

`<video>`、`<audio>`、`<img>` 的 `src` 没有设置任意 `Authorization` 请求头的接口。对 PromptCut 已定的素材服务，最直接且与契约一致的方案是：**元素用 15 分钟只读票据 `?t=`，程序化 `fetch` 和上传用 Bearer**；每个 Range 请求重新验票。[HTML `crossorigin` 属性](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/crossorigin)、[仓库票据契约](/C:/Users/admin/Documents/PromptCut/docs/plan/auth-contract.md:183)

### 依据

[MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)说明带 `Authorization` 的跨源 `fetch` 需要正确的预检与响应头；[Cookie 属性](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)说明跨站 Cookie 的 `SameSite=None; Secure` 要求；[Chrome 的 Service Worker Range 指南](https://web.dev/articles/sw-range-requests)记录了 Range 转发的历史兼容问题；[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)定义 Range、206、`Content-Range`。

| 做法 | 可取之处 | 代价与限制 |
|---|---|---|
| `src="/media/…?t=<只读票据>"` | 原生播放、拖动与 Range 都保留；HTTPS 同源和局域网 HTTP 跨源均可用。 | 票据在请求目标中，可能进入服务、代理、调试和错误日志；过期后续 Range 会 401。 |
| Cookie | 元素自动携带，URL 不含票据。 | 跨站需 `SameSite=None; Secure`，在明文 HTTP 不成立；第三方 Cookie 还会受 Safari、Firefox 的阻断／分区及用户设置影响。不同端口但**同主机名**属于跨源而未必跨站，仍不能把 Cookie 当作普适跨源方案。 |
| Service Worker 拦截并加 Bearer | 元素可继续用无票据 URL，Worker 代发有头 `fetch`。 | 只在安全上下文可注册；须处理受控页面、更新、失效、Range 原样转发、206／416 与 CORS，复杂度高。 |
| `fetch`＋Blob URL，或 MediaSource＋`fetch` | `fetch` 可加 Bearer；小图片／短素材可用 Blob URL。 | Blob URL 可能一次占用整个媒体的内存；MSE 需自己管理分段、缓冲、seek、codec 与回收。Safari 尤其 iOS 的 MSE／Managed Media Source 支持不宜直接等同桌面，必须用 `MediaSource.isTypeSupported()` 和目标机验证。[WebKit Safari 17 媒体说明](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/) |

### 浏览器差异

| 浏览器 | 对选型的影响 |
|---|---|
| Chrome / Edge | HTTPS 下 Service Worker 和 MSE 可作备选；Chrome 87 起已修复 Service Worker 转发 Range 的已知问题。 |
| Firefox | 同样不能给元素加头。Service Worker 的 Range 历史行为与 Chromium 不同；采用时必须在当前目标版本做 206、seek 测试，不能照搬旧示例。 |
| Safari macOS | 原生媒体请求常依赖 Range；MSE 可用性还取决于 codec。跨站 Cookie 默认受 ITP 限制。 |
| Safari iOS / iPadOS | 原生媒体路径应优先；MSE／Managed Media Source 有设备和版本差异，且低内存档不适合整文件 Blob。 |
| Android Chrome | 与桌面 Chromium 基本同 API，但 Blob 整文件与 MSE 缓冲更容易触及内存压力。 |

### 解决路径

- **HTTPS 同源 `/media`：**沿用 `GET/HEAD /media/…?t=<r 票据>` 给媒体元素；`fetch(url, { headers: { Authorization: 'Bearer …' } })` 用于快照块、程序化下载和写请求。页面和媒体响应设置 `Referrer-Policy: no-referrer`；访问日志只记路径、不记查询串，响应 `Cache-Control: no-store`，均与鉴权契约一致。播放跨过 15 分钟票据有效期时，在即将过期或收到媒体错误后取新票据、更新 `src` 并恢复播放位置，实际 seek 行为逐浏览器验证。
- **局域网 HTTP 跨源：**同样用只读查询票据给元素，用 Bearer 给 `fetch`。素材服务按实际 `Origin` 返回允许的 CORS 源；带 Bearer 的预检允许 `Authorization`、`Range`（若显式设置）及所用方法，需读取 Range 元信息时暴露 `Content-Range`、`Accept-Ranges`、`Content-Length`。明文页不能依赖 Service Worker；不要把跨站 Cookie 当主路径。
- 若以后确需用 Service Worker，拦截范围必须限于素材 URL；复制原请求的 `Range` 与必要属性，透传服务端 `206`、`Content-Range` 和 `416`，对每种浏览器测试首播与拖动。[Range 实践](https://web.dev/articles/sw-range-requests)

### 已知的坑

查询票据最确定的泄漏面是**请求 URL 日志**；`Referer` 泄漏取决于谁把含票据的 URL 当作后续请求的来源及其 referrer policy，不能简单声称每个媒体 `src` 都会把票据作为其他请求的 `Referer`。默认策略虽通常减少跨源泄漏，仍应由页面与媒体响应显式设 `no-referrer`。[Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)。票据刷新必须照顾浏览器自动发出的后续 Range；给首次请求验票后放行整段播放不符合现有契约。

## Q4 L1／M7 后台 iframe 节流

### 结论

应把「后台舞台」理解为**用户仍看着编辑器时、在编辑工作空隙运行的舞台**，不能承诺标签页真正隐藏后仍在 30 秒内完成预渲染。后台标签或隐藏 iframe 的 `requestAnimationFrame` 常停止，`requestIdleCallback` 没有及时执行保证，计时器和 Worker 会被节流，iOS Safari 甚至可能挂起整个标签页。目标 L 中「页面不可见时按每 8 帧让出」不能作为跨浏览器的进度保证，需要在执行契约中写成暂停／恢复规则。[MDN Page Visibility](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)、[WebKit 省电机制](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/)

### 依据

[Chrome 88 计时器规则](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)区分可见页面、隐藏后每秒检查，以及隐藏超过 5 分钟且满足链式计时器等条件后的**每分钟一次** intensive throttling。[Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)说明页面可被挂起（frozen）或丢弃，挂起时任务队列暂停。[MDN `requestIdleCallback`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback)建议给必要工作设置 `timeout`，但该 API 不是全浏览器统一基线；WebKit 曾报告回调迟迟不执行的问题。[WebKit 问题报告](https://bugs.webkit.org/show_bug.cgi?id=268152)

### 浏览器差异

| 浏览器 | L1／M7 要按什么假设设计 |
|---|---|
| Chrome / Edge | 隐藏标签的 rAF 停止；定时器先受预算限制，符合条件的链式定时器在长期隐藏后可能每分钟才被检查一次；页面可挂起（frozen）／丢弃。活动 WebSocket 不等于渲染计时器免节流。 |
| Firefox | 后台计时器也实行时间预算；隐藏 iframe 的 rAF 不可靠。Worker 可运行不等于有固定 CPU 份额或唤醒周期。 |
| Safari macOS | 不活动标签的 rAF 停止、计时器节流，App Nap 还会降低优先级；`requestIdleCallback` 应做特性检测并配合超时／回退。 |
| Safari iOS / iPadOS | 标签页可能整体挂起；WebSocket 可能断开，Worker 不能充当持续运行的渲染主机。按平台语义，此类设备也不运行 L1／M7。 |
| Android Chrome | Chromium 规则之外还可能被移动系统暂停、回收页面；恢复应按一次新会话核对。 |

同源 iframe 可以直接协调角色、任务和本源 IndexedDB；跨源 iframe 只能通过 `postMessage` 交换受验证的消息，Safari 还会给它独立存储分区与较小额度。**两者都不因“在 iframe 里”获得后台运行豁免**。[安全上下文的 iframe 继承规则](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)、[WebKit 跨源 iframe 配额](https://webkit.org/blog/14403/updates-to-storage-policy/)

### 解决路径

1. 普通档仅在 `document.visibilityState === 'visible'`、没有播放／拖动／探针任务、前台操作冷却结束后认领新批次。每批最多生成一帧或一个可界定的小单元，再检查 `AbortSignal`／角色代数与输入状态。单次 `__pcCreateSnapshot()` 若不可中断，用户操作发生时让**当前一帧**结束，随后立即停。
2. 可见时优先 `requestIdleCallback(callback, { timeout: 1000 })`；回调只在 `deadline.timeRemaining()` 足够且前台仍空闲时推进。无此 API 或回调长期未到，可用低频 `setTimeout` 再检查门闸，绝不把 `timeout` 视为强制开工命令。Worker 可承担压缩／哈希等非 DOM 工作，HTML 快照生成仍受页面线程调度。
3. `visibilitychange` 到 hidden 时停止认领并尽快保存进度；当前批完成后放下任务。`pageshow`、`visibilitychange` 到 visible、WebSocket 重连时，先核会话、租约和清单，再幂等续做。M7 服务端任务租约／心跳应允许暂停和超时重派，不能假定后台页面一直在线。
4. 不用静音音频、忙轮询、短周期 Worker 计时器或维持 WebSocket 来规避节流。这些做法耗电，也不能抵御挂起与丢弃。L 节的「30 秒内生成锚帧」验收应在**前台可见且空闲**的条件下执行。

### 已知的坑

`requestIdleCallback` 即使存在也可能长期不回调；`timeout` 回调的 `didTimeout` 并不代表此刻有空闲预算。WebSocket 收到消息不保证后续渲染及时执行。移动浏览器丢弃页面时可能来不及发 `pagehide`／`beforeunload`，任务状态必须能从服务端和 L2 重建。[Chrome 生命周期指南](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

## Q5 M7 纯浏览器节点的 WebSocket 凭证

### 结论

保留现有契约的子协议握手：`new WebSocket(url, ['promptcut.v1', 'promptcut.ticket.' + ticket])`，或首次登录用 `promptcut.auth.<base64url(JSON)>`。服务器在握手阶段验凭证、绑定身份与角色，成功时**只回显 `promptcut.v1`**。这让无效连接在升级前被拒绝，也满足 M7 按登录凭证筛选本人任务的要求。子协议字段是握手头，**并非保密通道**；仍要清洗代理和应用日志。[WebSockets Standard](https://websockets.spec.whatwg.org/)、[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html)、[现有鉴权契约](/C:/Users/admin/Documents/PromptCut/docs/plan/auth-contract.md:86)

### 依据

[WebSockets Standard](https://websockets.spec.whatwg.org/)要求每个 `protocols` 值符合 HTTP token 语法且不得重复，否则构造器抛 `SyntaxError`。[RFC 6455 第 4、11 节](https://www.rfc-editor.org/rfc/rfc6455.html)规定客户端可提供多个候选子协议，而服务端只能选择其中**一个或不选**；响应不能回显两项。[MDN WebSocket 构造器](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)给出浏览器 API 边界。

### 浏览器差异

| 浏览器 | 凭证方案的实际差异 |
|---|---|
| Chrome / Edge | `WebSocket` 构造器都不能设置任意请求头；子协议握手可用。后台挂起、重连时须重新取得一次性挑战或新票据。 |
| Firefox | 同一协议语法与回显规则；私密模式／防跟踪设置使 Cookie 路径更难预测，子协议不依赖它。 |
| Safari macOS | 同一语法；后台挂起后按新连接处理。跨站 Cookie 受 ITP 阻断，不适合替代子协议。 |
| Safari iOS / iPadOS | 同一语法，但按平台语义不应启用 M7；即使连接成功也不能保证后台持续在线。 |
| Android Chrome | 同 Chromium 语法；移动系统暂停后要重新握手、核租约。 |

### 解决路径

- 子协议 token 只使用 ASCII 安全集：当前 `promptcut.v1`、点号与**无填充 base64url**编码符合要求；原始 JSON、空格、逗号、`/`、`=` 不应直接作为协议值。`protocols` 数组中同一值不能重复。票据契约已有 **≤2048 字节**总长限制；另外给完整握手头和证明 JSON 设实现上限，在 nginx／Node 代理链实测拒绝超长请求。RFC 没有给出跨代理通用的安全最大头长。
- 服务端解析所有提供的值，严格执行「版本协议一项、鉴权项至多一项」；验证角色、项目、设备和票据代数后再升级。响应 `Sec-WebSocket-Protocol: promptcut.v1`，不要回显凭证。访问日志、错误日志、追踪系统均不得记录原始 `Sec-WebSocket-Protocol`；只记拒绝原因和非敏感身份标识。
- 重连每次调用契约中的 `protocols()` 生成新证明；一次性 nonce 不得复用，2 分钟连接票据应在**发起握手时**检查有效。升级后仍须执行任务级授权：分发器和队列两层按当前 principal 过滤，特别是自由进入时的「同名不同设备」。浏览器提供的 `Origin` 可做额外来源检查，但它不是凭证，非浏览器客户端可伪造。[MDN WebSocket 服务端说明](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers)
- 「连上后第一条消息认证」可作为将来的备选，但那会先发 HTTP 101，再要求服务端在认证前禁止任何订阅、任务和消息，设短认证超时、未认证连接上限，并用关闭帧而非握手 401 报错。Cookie 路径虽省去显式 token，却要处理跨站 Cookie、CSWSH 和严格的 `Origin` 校验；不建议替换当前契约。[OWASP WebSocket 安全指南](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)

### 已知的坑

子协议凭证避开了**URL 查询串访问日志**，却仍可能进入代理的**请求头日志**或 APM；`wss` 只保护传输途中，不能替代日志清洗。多个 `Sec-WebSocket-Protocol` 请求头在 HTTP 层可等同一份候选列表，服务器不能只看第一行；响应只能有一个选中协议。服务端若回显 `promptcut.ticket.…`，浏览器会认为它是选中的协议，且把票据暴露在响应头与 `ws.protocol`。连接已建立后的撤权还需服务端主动关闭或持续校验代数，不能仅靠握手时的两分钟票据到期。
