# PromptCut C10a 查资料：解决路径

查阅日期：2026-09-27。本文供写契约时取舍，**建议值不是浏览器保证值**。仓库背景只读核对了 `D:\VectorMPEG7\PromptCut\docs\plan\Master-Execution-Plan.md` 的 0.2、7 节，`cloud-task.md` 的目标 L、L6，`product/platforms.md` 和 `workflow/project.md` 的“多用户协作”。其中 C10a 的约束是：`/editor` 与 `/hosted`、`/media` 同源；邀请链接仅带令牌；手机和 iPad 只预览两类小尺寸产物、允许原尺寸逐帧导出、不承担预渲染；渲染节点产出原尺寸时顺带产小尺寸。以下“建议”不替代现有语义。

## Q1　移动浏览器内存、媒体和低内存档判定

**结论与出处。** 未找到官方数字：iOS/iPadOS Safari 近两年各版本、Android Chrome 各设备没有统一的“单标签页可用内存”公开上限，也没有浏览器可读的剩余内存阈值或标签页被杀的精确触发公式。WebKit 工程师在 [bug 277848](https://bugs.webkit.org/show_bug.cgi?id=277848) 中称 iPhone WebContent 进程约 **1.5 GB 软限制**，越过后可能遭 jetsam；这是 iPhone 12 Pro、iOS 17.5.1 案例的说明，**不是所有 iPhone/iPad 的上限**。标签页还会因全机内存压力、后台优先级、GPU/解码器分配失败被丢弃；[Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) 明确说资源压力下的 discard 不发事件，恢复时重新加载。Android Chrome 同样**未找到官方统一数字**。可供**工程起点**的保守经验预算是低内存预览的常驻像素面加解码缓存尽量低于约 128–256 MiB；这个区间是基于 800×600 RGBA 一面约 1.83 MiB、1080p 一面约 7.91 MiB，加上多份中间面可能翻倍而作的容量估算，**不是公开测得的浏览器安全阈值**，须用真机压测校准。

`<video>` 可创建数量、同时**成功解码**数量、硬件解码器实例数是三个不同问题。**未找到官方数字：Safari/Chrome 未公布面向网页的统一同时解码或硬件实例上限。** Android 原生 [`CodecCapabilities.getMaxSupportedInstances()`](https://developer.android.com/reference/android/media/MediaCodecInfo.CodecCapabilities#getMaxSupportedInstances()) 按编解码器报告上界，且文档强调运行时可能更少；网页不能据此推断自己的配额。建议低内存档初始只保持 **1 个活跃视频解码源**，切源时暂停、清 `src` 并 `load()`，真机实测后才允许 2 个；这是保守策略，不是系统上限。[`MediaCapabilities.decodingInfo()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo) 和首帧试放可判单个配置可播、流畅倾向，不能证明并发容量。

Canvas 的**单画布尺寸**与**累计画布内存**也要分开：[MDN canvas](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/canvas) 记载 iOS 单画布通常有 4096×4096 像素边界，超过可能不可用；[WebKit bug 187279](https://bugs.webkit.org/show_bug.cgi?id=187279) 记录过 iOS 累计 canvas 内存限制从 448 MB 收紧，不能拿旧值作现行配额。WebGL 同时活动上下文的跨版本上限**未找到官方数字**；[WebKit bug 218305](https://bugs.webkit.org/show_bug.cgi?id=218305) 的旧重现是在第 17 个上下文触发“过多”，[另一个旧 bug](https://bugs.webkit.org/show_bug.cgi?id=200031) 在视频纹理下第 9 个出错，均非可依赖的 2024–2026 保证。Chrome 的[实现](https://chromium.googlesource.com/chromium/src/+/d3ed6532f7299a2bdb430b4cc836e97a358c4601/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc) 通过 GPU 配置取限制；应复用 **1 个 WebGL 上下文**，监听 `webglcontextlost`/`webglcontextrestored`，不用时主动释放资源。参见 [MDN WebGL 实践](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)。

`navigator.deviceMemory` 只给粗粒度、可被钳位的内存档，[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory) 标记为非广泛可用；[caniuse](https://caniuse.com/mdn-api_navigator_devicememory) 显示 Android Chrome 支持，iOS/iPadOS Safari 不支持。`hardwareConcurrency` 是浏览器可用逻辑线程的估计，浏览器可故意报低，不能当 RAM 指标（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency)）。[WebKit 官方说明](https://webkit.org/blog/9674/new-webkit-features-in-safari-13/) 指出 iPad Safari 多数时候给 macOS 桌面 UA，分屏时甚至会变化；WebKit [bug 212937](https://bugs.webkit.org/show_bug.cgi?id=212937) 建议按能力而非 Mac/iPad UA 分支。`(pointer: coarse)` 表示**主**指针粗略，不等于“移动设备”；接键盘/触控板会改变结果，触屏笔记本也可能匹配（[MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/pointer)）。

**建议的可实现规则。** 首屏加载期间先用保守资源预算，同步特征检测后定档；低内存档判据建议为：`deviceMemory <= 4`（若有）**或**〔`pointer: coarse` / `any-pointer: coarse` 命中、`maxTouchPoints >= 2`，并且 `max(screen.width, screen.height) <= 1600`〕**或**低资源症状（`webglcontextlost`、连续视频解码失败、受控缓存分配失败）命中。已知 iPad 桌面 UA 时不看 UA；`hardwareConcurrency <= 4` 仅作记录和降并发辅助，不单独判低内存。判据未命中时进入普通档；页面设置允许手动强制低内存档或普通档，记在设备本地；切到高档要提示并在下一次场景加载时生效。这样规则可用注入的 `deviceMemory`、屏幕、触点数与 media-query 桩做单测；真机矩阵至少 iPhone Safari 17/18/26、iPad Safari 17/18/26（触控板有/无）、Android Chrome 低/高配、触屏 Windows 笔记本。**风险/不确定：** 阈值 4 GiB、1600 逻辑像素和 128–256 MiB 都是 C10a 待真机验证的策略值；大屏 Android 平板可能漏判，触屏笔记本可能误判，故需手动覆盖与遥测。

## Q2　后台节流、freeze/discard 与重连

**结论与出处。** [MDN `setTimeout`](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout) 说明 Chrome 后台计时器常按每秒检查，满足隐藏超过 5 分钟、长链定时器、静默等条件时可变为每分钟检查；这些是 Chrome 的策略而非跨浏览器 SLA。[`requestAnimationFrame`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) 在多数后台页/隐藏 iframe 暂停。[WebKit 官方说明](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/) 进一步指出 iOS 页签在可能时会被完全暂停。[Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) 的 `freeze` 会暂停可挂起的任务，`discard` 无事件，恢复是新加载，可在支持时看 `document.wasDiscarded`，但其文档特别标注 Android 支持需另跟踪。移动端 `pagehide`/`unload` 并不可靠（[MDN `pagehide`](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)）。iOS 锁屏/切 App 后 WebSocket 会断还是仅暂停**没有官方稳定时限**；[WebKit bug 245350](https://bugs.webkit.org/show_bug.cgi?id=245350) 曾报告切 App 会断线，不能依据 `readyState === OPEN` 判仍可收发。

**建议做法。** `visibilitychange` 到 hidden 时立即保存未提交的轻量本地状态，停止预览动画和新任务、关闭非必需视频源；可保留 WS 但视为**可能失效**，不要依靠心跳计时器在后台准时运行。`pagehide` 可补关连接以利 bfcache。`visibilitychange` 到 visible、`pageshow`（包括 `event.persisted` 为 true）、Chrome `resume`、`online`，以及首次加载时，统一调用幂等的 `ensureConnected()`：如果无连接、握手超时、或最后一次服务端心跳/序号确认距今超过约 **30 秒经验值**，先废弃旧 socket，再指数退避加抖动重连；新连接按项目会话/最后确认序号拉增量或快照，不以本地 `readyState` 作事实。`pageshow.persisted` 表示 bfcache 恢复，`document.wasDiscarded` 若为 true 则走完整状态恢复。MDN 的 [WebSocket 客户端指南](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications) 示范 `pagehide` 关闭、`pageshow` 重连。**风险/不确定：** 30 秒不是浏览器超时；代理半开、iOS 锁屏、长期后台均须真机演练。不要让低内存页在 hidden 时按仓库 L1 “每 8 帧让出”继续预渲染：L6 本来禁止它起后台渲染节点。

## Q3　邀请码、片段、作废与二维码

**结论与出处。** 邀请码是可重复使用但可限时限量的**不透明 bearer 令牌**，与项目密码独立；这和仓库 `workflow/project.md` 的语义相符。[OWASP 的 URL 令牌建议](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) 要求 CSPRNG、足够长、妥善存储、过期和防暴力尝试；其“单次使用”是密码重置语境，不能机械套在可限量邀请上。建议服务端 `crypto.randomBytes(32)`：**256 位**随机，base64url 无填充后 **43 字符**；从 24 字节 / 192 位起也已很强，32 字节便于留余量。项目数据库只存 `SHA-256(token)` 或带服务端密钥的 `HMAC-SHA-256(token)` 作为索引，以及 `expiresAt`、`maxUses`、`used`、`revokedAt`、`generation`；随机高熵令牌可以用快速摘要，与低熵用户密码要用慢哈希的场景不同。令牌原文只在生成后返回创建者用于展示/复制，不落日志、持久明文或埋点；客户端只通过 HTTPS 请求体或受保护握手递交，核验后换项目会话凭证。作废原子更新状态并立即在所有新加入请求上查库；已有成员会话是否失效要另写清，不应误称“作废邀请码会踢走成员”。

[RFC 3986](https://www.rfc-editor.org/rfc/rfc3986#section-3.5) 与 [RFC 9110 §7.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-7.1) 规定 fragment 在客户端处理、不属于 HTTP 请求目标，因此通常不进 nginx 访问日志，也不会作为 `Referer` 的 fragment 发出（[RFC 9110 §10.1.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.1.3)）。**但 fragment 不等于秘密保险箱**：浏览器历史、复制/分享、截图、页面 JS/扩展可见；[RFC 9110 §17.11](https://www.rfc-editor.org/rfc/rfc9110.html#section-17.11) 还提醒跨站重定向可能把原 fragment 继承到新地址。链接建议用 `https://8-219-80-16.sslip.io/editor#invite=<base64url>`，**/editor 直接回 200，避免首跳重定向**；启动时先读 `location.hash`、校验键名和字符长度，把令牌暂存内存后立即用 [`history.replaceState`](https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState) 清掉当前历史条目的 fragment，再向同源服务提交。设置 `Referrer-Policy: no-referrer`、CSP，杜绝第三方脚本接触令牌。历史中清除后的当前条目不再显示令牌，但浏览器同步历史、外部分享记录不能追溯清除。

限时建议默认 **7 天**，不限量默认 `null`；创建者可选短期和 `maxUses`。这些是产品经验值，**未找到适用于本产品的邀请码官方期限数字**。限量核销必须一次数据库事务或条件更新完成：“`revokedAt IS NULL AND now < expiresAt AND (maxUses IS NULL OR used < maxUses)`”时 `used = used + 1`，同一事务创建成员/授权记录；重复提交同一加入请求用幂等键防重复扣次。限额指**成功加入次数**而非扫码或打开次数。多个服务实例共享一个一致性写库；缓存若延迟传播会破坏“立即作废”，作废后核验须读主库或严格失效缓存。所有失败返回统一错误并按 IP/项目/令牌前缀限速；服务端不要在日志记 token。

**二维码容量。** 示例固定域名的链接带 43 字符 token 约 **86 个 ASCII 字节**（实际编码按最终域名重算）；[DENSO WAVE 容量表](https://www.qrcode.com/en/about/version.html) 给字节模式 Version 6/M = 106 字节、Version 7/Q = 86 字节，故该示例可用 **V6/M（41×41 模块）**，想用 Q 则 **V7/Q（45×45）刚好放下**；换域名或加参数可能升版本。DENSO WAVE [建议四模块 quiet zone](https://www.qrcode.com/en/howto/code.html)，M 约 15%、Q 约 25% 纠错（[出处](https://www.qrcode.com/en/about/error_correction.html)）。固定高对比度、留白、至少约 220–280 CSS 像素显示，再做真实相机扫码；像素值是易扫的设计经验值，**未找到官方通用最小显示尺寸**。

**扫码保留 fragment 的风险。** 普通浏览器按 URL 导航应保留 `#` 供页面读取（[MDN `location.hash`](https://developer.mozilla.org/en-US/docs/Web/API/Location/hash)），但**未找到 Apple 相机和微信内置浏览器对所有版本、扫码入口和中间跳转“必保留 fragment”的官方保证**。尤其 URL 规范允许重定向继承或覆盖 fragment，扫码平台还可能先走安全检查/外链拦截。因此 C10a 必须用 iOS 相机 Safari、微信 iOS/Android 内置浏览器实测 `location.hash` 与首个文档请求、301/302/308 路径；短链或微信分享重写不应作为唯一入场路。失败时允许用户粘贴**完整邀请链接**到开始页解析，手填项目名/密码路仍保留。**风险：** 如果微信网关改写或吞掉 fragment，无法靠 nginx 恢复原 token；只能改善入口或换经审议的链接承载方式。

## Q4　浏览器端二维码生成库

**结论与出处。** 推荐 [Project Nayuki QR Code generator 的 TypeScript/JavaScript 实现](https://github.com/nayuki/QR-Code-generator/tree/master/typescript-javascript)：源码 [`qrcodegen.ts`](https://github.com/nayuki/QR-Code-generator/blob/master/typescript-javascript/qrcodegen.ts) 自带 MIT 许可、约 **40.1 KB 源文件**、不依赖运行时包、可选 Version 1–40 和纠错级别。C10a 仅需要本地把短 ASCII URL 编码为二维码，页面用该库给出的模块矩阵画到 Canvas 或 SVG。这里的 40.1 KB 是 GitHub 显示的源码大小，**不是构建后的 gzip 大小**；提交契约时用实际 Vite 产物量度增量，若体积不合适再评估同许可的替代库。常见 [`qrcode` 包](https://github.com/soldair/node-qrcode/blob/master/package.json) 是 MIT，但有三个运行依赖，不满足“零依赖”偏好。

**建议做法。** 固定只编码 `/editor#invite=...` 完整 HTTPS URL，自动选最小版本、M 纠错；黑白和四模块留白，旁边给“复制邀请链接”。不把令牌发到第三方二维码 API，也不自己重写 QR 的模式选择、Reed–Solomon 纠错、掩码评分和版号容量边界；直接用成熟实现更容易覆盖边界。**风险/不确定：** Nayuki 的 TS 文件是 namespace 形式，接入 Vite 的具体打包方式需在项目构建里试；许可声明须随打包保留。二维码图片仍会被用户转发，作废依赖服务端而非二维码本身。

## Q5　Vite SPA 的 `/editor` 与 nginx 1.24

**结论与出处。** [Vite 文档](https://vite.dev/guide/build#public-base-path) 要求部署到子路径时构建配置 `base: '/editor/'`；被代码拼接的 URL 要用 `import.meta.env.BASE_URL` 或显式同源 API 路径。nginx 的 [`try_files`](https://nginx.org/en/docs/http/ngx_http_core_module.html#try_files) 可做 SPA 回落，[官方 WebSocket 文档](https://nginx.org/en/docs/http/websocket.html) 要求代理显式传 `Upgrade` / `Connection`，1.24 需 `proxy_http_version 1.1`。`/media` 的 Range 应由上游正确返回 206、`Content-Range`、`Accept-Ranges`（[MDN Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)）；nginx 不应把媒体请求回落到 HTML，也不要在媒体上 gzip 改变字节语义。nginx 自带 [gzip 模块](https://nginx.org/en/docs/http/ngx_http_gzip_module.html)；Brotli 是额外模块，不能假定 1.24 内置。下例是**可参考配置**，放进现有 443 `server` / `http` 后用实际端口与证书路径替换，并先 `nginx -t`：

```nginx
# http {} 中，不能放进 server {}
map $http_upgrade $pc_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name 8-219-80-16.sslip.io;
    # ssl_certificate /现有证书路径;
    # ssl_certificate_key /现有密钥路径;

    # Vite dist 目录部署为 /srv/promptcut/editor/index.html 与 assets/
    root /srv/promptcut;
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/css application/javascript application/json image/svg+xml;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;

    # 邀请码入口 /editor 原样 200，避免首跳重定向。
    location = /editor {
        try_files /editor/index.html =404;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
    location = /editor/index.html {
        try_files /editor/index.html =404;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
    # 此目录只放 Vite 带内容哈希的产物；缺资源返回 404。
    location ^~ /editor/assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
    location /editor/ {
        try_files $uri /editor/index.html;
    }

    # 与页面同源；不改上游路径，适配 WS 与 HTTP 长轮询。
    location ^~ /hosted {
        proxy_pass http://127.0.0.1:8760;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $pc_connection_upgrade;
        proxy_read_timeout 75s;
        proxy_buffering off;
    }
    location ^~ /media {
        proxy_pass http://127.0.0.1:8761;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Range $http_range;
        proxy_set_header If-Range $http_if_range;
        proxy_request_buffering off;
        proxy_buffering off;
        gzip off;
    }
}
```

**建议做法。** `/editor`、`/editor/`、深路由和刷新都返回同一份无缓存 HTML；上例中 `/editor/` 走 `/editor/` location 后内部回落到精确匹配的 `/editor/index.html`。带哈希资源长缓存、缺资源 404；Vite `public/` 中未带哈希的文件别放进 `assets/`。旧版 HTML 引用的旧哈希资源至少保留到活动页升级/刷新完成，原子切换新构建。`/hosted` 原路径透传，75 秒读超时要高于服务端心跳/长轮询等待时间；请求体大小、认证、CSP/`connect-src`、WebSocket 子协议和上游真实端口按现有部署核对。`/media` 的 Range 必须用 `curl -H "Range: bytes=0-1023"` 验 206 和 1024 字节，上传分片按现有上限配 `client_max_body_size`。**风险/不确定：** 上游 8760/8761 和静态目录仅是示例；若既有部署路径或反代重写规则不同，先按真实拓扑替换。Brotli 只有安装并验证模块后才开，gzip 已足够完成 demo。

## Q6　低内存档逐帧导出

**结论与出处。** WebKit [Safari 16.4 发布说明](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/) 说从 16.4 起支持**视频部分** WebCodecs；[caniuse](https://caniuse.com/webcodecs) 将 iOS 16.4–18.7 标为“部分支持”，Android Chrome 自 Chrome 94 系列支持 WebCodecs。这里不能推断每台机都有 H.264 `VideoEncoder`、AAC `AudioEncoder` 或指定分辨率。[MDN `VideoEncoder.isConfigSupported()`](https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder/isConfigSupported_static) 提供逐配置试探；[MDN codec 选择](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection) 建议 H.264 + AAC + MP4 作为广泛兼容输出。**未找到官方数字：Safari/Android Chrome 没有统一的 H.264 编码最大宽高**。H.264 标准自身有 level 上限：[ITU-T H.264 Annex A](https://www.itu.int/rec/dologin_pub.asp?id=T-REC-H.264-202408-I%21%21PDF-E&lang=e&type=items) 中 Level 4.0 的 MaxFS 为 8192 个宏块，能容纳 1920×1080（8160 个宏块）约 30 fps；Level 5.1 的 MaxFS 为 36864 个宏块，能容纳 3840×2160（32400 个宏块）约 30 fps，但[WebCodecs AVC 注册](https://w3c.github.io/webcodecs/avc_codec_registration.html) 并不要求浏览器实现 H.264。实际设备上限取决于芯片、编码 profile/level、帧率、并发负载。契约应先探项目原尺寸，例如 1920×1080/30，再探较低配置；不能因为 1080p 成功就承诺 4K 成功。透明层不能直接靠通常的 H.264 MP4 保留 alpha，要单列透明导出格式能力测试。

WebCodecs 只吐 `EncodedVideoChunk`，不封装 MP4。旧 [`mp4-muxer` 仓库](https://github.com/Vanilagy/mp4-muxer/blob/main/README.md) 已明确停维护，作者推荐 [Mediabunny](https://github.com/Vanilagy/mediabunny)：零运行依赖、tree-shakable、仓库宣称最小约 **5 KB gzip**（是最小用例而非本项目实测）；**许可证 MPL-2.0，不是 MIT**，若修改库源码并分发须公布被修改的库文件，需在依赖审查时确认。Mediabunny 的 [`StreamTarget`](https://mediabunny.dev/api/StreamTarget) 支持 `WritableStream` 与写入背压，适合 MP4 增量封装；Chrome 有 `showSaveFilePicker` 时可接 `FileSystemWritableFileStream`，但 [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker) 标明该 API 非广泛可用，iOS Safari 不能假定有直接文件写入。

**建议做法。** 启动前检查 HTTPS、`VideoEncoder`、`isConfigSupported({codec:'avc1...', width, height, bitrate, framerate})`，另单测 AAC 与目标容器支持；有能力时按帧号确定时间戳，合成**一帧**到复用的原尺寸 canvas/OffscreenCanvas，构造 `VideoFrame` → `encode()` → 立即 `frame.close()`；`encodeQueueSize` 控制在约 **2–3 帧经验阈值**，`dequeue` 后再取下一帧，输出 chunk 交给具有背压的 MP4 writer，最终 `flush()`/`finalize()`/`close()`。[MDN WebCodecs 指南](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API) 明确提醒队列无界会耗尽视频内存、帧需显式关闭。1080p RGBA 一面约 7.91 MiB、4K 一面约 31.64 MiB，实际峰值还包括解码帧、GPU 纹理、编码器参考帧、MP4 缓冲、页面自身；一次只保留当前与下一素材的 Range 窗口，低内存档导出时暂停预览并释放小尺寸缓存，原尺寸资源按需读取，不整片 `arrayBuffer()`、不把所有 chunk 放数组。用浏览器性能工具/真机长片记录峰值、失败帧号和重试结果。**“逐帧写出”只有写入 sink 真正流式时成立**；若最终以 `Blob` 全部聚合给 iOS 下载，峰值会随片长增长，须在契约标明 iOS 可验证时长/文件体积上限，不能称恒定内存。

没有 `VideoEncoder` 或原尺寸 H.264 不支持时，可提供 **PNG 帧序列 ZIP 的次级交付**：每帧 `canvas.toBlob('image/png')` 后流式写一条 ZIP 条目，丢弃该帧数据；[zip.js](https://github.com/gildas-lormeau/zip.js) 支持 WritableStream/ZIP64（[API](https://gildas-lormeau.github.io/zip.js/api/classes/ZipWriterStream.html)），但在 iOS 缺持续文件 sink 时 ZIP 最终下载仍可能全量驻内存。PNG 序列也**不等价于“导出成片”**，通常无混音音轨；[Safari 的 MediaRecorder](https://webkit.org/blog/11353/mediarecorder-api/) 虽能产 H.264/AAC MP4，但它录实时 `MediaStream`，不能保证离线逐帧推进的时间戳和帧完整性，不能暗中替换此路径。因此遇到此能力缺口，应明确提示“此浏览器不能完成本尺寸的视频导出，请在支持设备/桌面版导出”，PNG 序列仅用户主动选的备用产物；这处是否满足一期“手机允许导出视频”的语义，**需在 C10a 契约前明确验收设备与能力边界**。已有的重卡预渲染原尺寸只读取、不在手机重渲；原尺寸未到齐照语义等待上传方。

## Q7　预渲染小尺寸：三类产物及生成位置

**结论与仓库依据。** `cloud-task.md` A1 已把**素材小尺寸**定为等比缩到 **800×600 以内**的 H.264，`product/platforms.md` 要求手机/iPad 平时只看“预渲染小尺寸和素材小尺寸”、导出用原尺寸；C10a 明确渲染节点产出原尺寸时顺带产小尺寸并推素材服务。故预渲染小尺寸建议统一约束为 **fit within 800×600，不放大，保持项目画幅比例**：16:9 为约 800×450，9:16 为约 337×600，4:3 为 800×600。这个尺寸是**与仓库素材档一致的工程选择**，不是外部规范数字；高 DPR 手机会显得软，可在验收后加 1.5× 档，仍不得让低内存默认拉原尺寸。[MDN canvas](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/canvas) 的 iOS 画布上限与 [WebGL 内存实践](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices) 支持控制像素面大小。以下三类产物不要误认为手机都要播放流：`cloud-task.md` L4/L5 规定在线浏览器模式**没有轨道流实现**，C10a 的手机预览以小尺寸快照为主。

| 原产物 | 建议的小尺寸衍生物 | 生成与读取 |
|---|---|---|
| HTML 快照（含 DOM/CSS，canvas 卡快照可能内嵌图片） | 对需要在低内存档显示的**重层**，在渲染节点的受控舞台把该帧合成/截图成独立 ≤800×600 PNG 位图；原 HTML 保留用于普通档和原尺寸导出。不要把同一份大 HTML 只靠 CSS `transform: scale` 称作小尺寸：嵌入图仍可能原大、DOM 成本不减。若小 HTML 里只有可缩图片，可再探索保留文字可选中的小 HTML，但不是 C10a 的必要前提。 | 同一渲染任务、同一帧的原快照就绪后，在渲染节点生成位图并分别按内容哈希上传；低内存页只取小 PNG/小清单。 |
| PNG 像素快照 | 从原图或同一渲染帧等比缩图得 ≤800×600 PNG；保 alpha、色彩配置，避免二次反复缩放。 | 渲染节点生成原 PNG 的同时缩一次，两份分别上传；清单关联同一帧/版本。 |
| fMP4 init/分段流 | **仅为后续能播放流的客户端预备**独立小流：≤800×600、H.264 8-bit 4:2:0、约 0.8–1.5 Mbps/30 fps 的初始经验参数，源帧率高时可保帧率并按比例提高码率；关键帧与分段边界对齐现有 R8 的 15 帧分段，保独立 init/索引。 | 有 ffmpeg 的渲染节点编码原流时顺带编码一条小流，或对原流转码；C10a 低内存页面**不消费流**，别让小流成为手机 demo 的前置。 |

**建议做法。** 在内容库清单给原尺寸/小尺寸各自明确键、宽高、格式、内容哈希、帧区间及派生所用的渲染版本；尺寸档不能混入同一 `ranges` 判重，必须保证“原尺寸就绪”不被“小尺寸就绪”冒充。任务完成条件和通知应覆盖两档上传成功；低内存页的 L2 只缓存小档，并为每项目设例如 **64 MiB 初始 LRU 上限**，该值属经验预算、**未找到官方浏览器配额保证**，需通过 [`navigator.storage.estimate()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate) 看配额估计并做 QuotaExceeded 降级。导出临时取原尺寸，不把它常驻 L2。移动端看预渲染重层时，若小档缺失，应显示等待渲染节点/占位符而不静默拉原档；轻卡活渲是否可见按现有能力闸处理。**风险/不确定：** HTML 生成 PNG 会损失文本选中、部分交互与 DOM 特效的实时性，但低内存档本就只看预渲染结果；逐帧 PNG 还可能显著增加网络与存储，须测每分钟产物字节数并利用内容哈希去重、LRU 清理；需真机比较截图颜色、字体、透明合成及不同纵横比。像素图和流的码率是起步参数，无官方适用本产品的固定值；若既有 HTML 快照协议要求保留某些可交互信息，小位图只作预览派生，不修改原快照。

## 七题总表

| 题号 | 结论一句话 | 建议做法一句话 |
|---|---|---|
| Q1 | 移动浏览器没有统一内存、解码器和 WebGL 配额，设备信号只能作保守估计。 | 以粗指针/屏幕与 `deviceMemory` 组合判低内存档，默认单视频解码、单 WebGL 上下文并允许手动覆盖。 |
| Q2 | 后台计时器、rAF 和 WebSocket 都不能保证持续运行，discard 还可能无事件。 | 在可见性和 `pageshow` 恢复时幂等检查心跳并按会话序号重连补状态。 |
| Q3 | 256 位随机邀请码放 URL fragment 可避开 HTTP 请求日志，但仍会暴露于历史与脚本。 | 服务端只存令牌摘要，事务核销限额、作废即查主库，扫码首屏读入后清除 fragment。 |
| Q4 | Nayuki 的 MIT 零依赖 QR 编码器满足短邀请链接生成，源码约 40.1 KB。 | 本地编码完整 HTTPS 邀请链接，M 纠错并实测构建体积与扫码成功率。 |
| Q5 | Vite 的 `/editor/` base 配合 nginx SPA 回落即可与同源 `/hosted`、`/media` 共存。 | HTML 禁缓存、哈希资源长缓存，WebSocket 显式升级，媒体 Range 透传且不压缩。 |
| Q6 | Safari 16.4 起有视频 WebCodecs，但 H.264 原尺寸编码与 iOS 持续文件写出没有统一保证。 | 运行时探编码能力并逐帧限队列流式封装 MP4，失败时明确设备限制并可选 PNG 序列。 |
| Q7 | 预渲染小尺寸应与素材小尺寸统一在 800×600 包围盒内，HTML 重层需独立小位图。 | 渲染节点产原档时同步生成并上传小快照，手机只取小档，原档仅供导出临时读取。 |
