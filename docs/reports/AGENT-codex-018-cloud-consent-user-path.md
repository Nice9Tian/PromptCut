# 018 Cloud Agent 首次告知：实施记录

- 工作区：`018-cloud-assets-central-glue`；本叶 `codex/018-cloud-consent-user-path` 从 `main` 的 `dbda16c3` 开始。旧 `codex/018-run-assets-current` 的 `8c1078f6` 保留且起点前工作树干净。
- 范围：只实现账号 v2 的告知、真实账号端 GET/POST 与浏览器/桌面桥接及前端阻断；不会把旧 CloudIdentity 委托打开，也不会声明 Agent runner 已可用。
- 用户已定文案：`托管方能读到你和云端 Agent 的对话记录，包括私有对话`；操作仅 `我知道了`、`拒绝`。拒绝保留草稿，下一次使用重新提示。
- 入口设计：账号客户端精确查询/提交版本 1 的同意；当前账号和登录绑定在请求前后重核。account v2 项目连接只注入 consent source，换项目或注销撤掉。云端 UI 未取得账号服务同意前不建立会话、读历史、附文件、排队或发送；提交后端仍由真正 Agent 服务复核。
- 验证和未完成项随实施追加。生产模型、实例、节点部署、直接服务端绕过检查由其它模块负责。

## 实际接线与边界

- `client.ts`：在线编辑器用网站 Cookie、当前 CSRF 对精确 `/api/account/cloud-agent-consent` 做 GET/POST；桌面版通过原生固定源桥接用当前 editor Bearer。两个入口都只接受版本 1、当前账号 ID 的服务端答复，请求前后重核登录代次，注销或换账号使在途答复失效。拒绝按钮不发 POST，也不写本地同意许可。
- `syncManager.ts`：只有 account v2 的共享项目连接注入账号 consent source；连接解除/换项目撤销。原 `setCloudIdentity` 的 account 分支仍为 `null`，没有借同意功能开放旧 delegate 票据。
- `useCloud.ts`/面板：未收到当前账号服务端同意时不建立云端会话、不读 info/历史/SSE、不上传附件、不出队或发送。每次真正发送/上传前重新查询；对话 RAM 视图与待发队列按账号绑定代次隔离。明确拒绝保留当前文字和待重试附件；服务器不可达或失权失败即关。
- 面板逐字告知 `托管方能读到你和云端 Agent 的对话记录，包括私有对话`；只有 `我知道了` 与 `拒绝`。成功 POST 后再次使用才会进入现有 Agent 会话路径。Agent 服务未部署时仍按真实 availability 不提供生产 Agent。

## 验证记录

| 固定源码/阶段 | 实际结果 | 原始证据 |
|---|---|---|
| `698b5c15` 初块 | 强制类型 exit 0；专属 9/9，0 fail/skip | `%TEMP%/pc-consent-698b5c15/target.out.log` |
| 浏览器 Origin 反例，修前 | `client.test` 7 项中 1 fail，真实 VH 路由规则下 Bearer POST 被 `bad-origin` 拒；没有把此测试绿判生产通过 | `%TEMP%/pc-consent-online-origin-red/first.out.log` |
| `a6eee0ef` 纯回归 | 36/36，0 fail/skip，exit 0；尚未修在线 Origin，测试当时未覆盖它 | `%TEMP%/pc-consent-a6eee0ef/target.out.log` |
| `d61f5b2a` 真实 Chrome 首次 | exit 1，Puppeteer 可执行路径未 await；自有端口随后为空 | `%TEMP%/pc-consent-browser-d61f5b2a/browser.err.log` |
| `bd10c38c` 浏览器加载 | exit 1，页面探针模块尚未就绪；浏览器、服务、6650 均已关闭 | `%TEMP%/pc-consent-browser-bd10c38c/browser.out.log` |
| `24167198` 浏览器加载诊断 | exit 1，404 路径明确指向浏览器安全依赖 `/server/*.mjs` 未由隔离 Vite 入口放行；6650 已关闭 | `%TEMP%/pc-consent-browser-ae34d27c/browser.out.log` |
| `2b41892a` 首次完整浏览器 | 真 VH `createApp`、两个隔离 Chrome context、真实账号注册/第二设备登录：13/13 检查，exit 0，wall 2286 ms；浏览器、服务器与 6650 关闭 | `%TEMP%/pc-consent-browser-2b41892a/browser.out.log` |
| `9cd1dcf5` 加迟到 GET 与队列核验 | 真后端/Chrome 15/15，exit 0，wall 2319 ms；纯目标 38/38，0 fail/skip，exit 0；强制类型 exit 0 | `%TEMP%/pc-consent-browser-9cd1dcf5/browser.out.log`、`%TEMP%/pc-consent-9cd1dcf5/target.out.log` |
| `dcfbb72d` 注销视图撤销后最终源码 | 真后端/Chrome 15/15、exit 0、wall 2323 ms，纯目标 38/38、0 fail/cancel/skip、exit 0、wall 1651 ms，强制类型 exit 0；前后 `6650–6659` 零监听 | `%TEMP%/pc-consent-browser-dcfbb72d/browser.out.log`、`%TEMP%/pc-consent-dcfbb72d/target.out.log` |
| 许可竞态首红（`5c3f6d54` 产品＋新增反例） | 5 项 3 pass/2 fail、exit 1：被覆盖 GET 错借 UI 缓存 `accepted=true`；A 旧绑定错借 B 的同意，失败原文完整保留 | `%TEMP%/pc-consent-race-red/target.out.log` |
| `9202c240` 初修 | 32/32、0 fail/skip，强制类型 exit 0；真 VH/Chrome 19/19、exit 0、wall 2489 ms，6650–6659 收口零监听 | `%TEMP%/pc-consent-race-fixed/target.out.log`、`%TEMP%/pc-consent-browser-9202c240/browser.out.log` |
| `0267f863` 同账号新绑定与弹窗清理补齐 | 33/33、0 fail/cancel/skip、exit 0、duration 1542.6 ms；强制类型 exit 0；真 VH/Chrome 19/19、exit 0、wall 2730 ms，浏览器与服务器显式关闭且 6650–6659 零监听 | `%TEMP%/pc-consent-race-final/target.out.log`、`%TEMP%/pc-consent-race-final/type.log`、`%TEMP%/pc-consent-browser-0267f863/browser.out.log` |
| 根联合候选 `c5bae31a` 首次 full | type 0；full 5318/5313 pass/1 fail/4 skip、0 cancel、71418 ms、未重跑。唯一红 C10A-API-03：实际在线产物新增精确 `/api/account/cloud-agent-consent`，在线清单仍旧7账号路径，产品代码未回退 | `%TEMP%/pc-consent-root-c5bae31a-full.log` |
| 告知路由精确棘轮登记 | 在线清单、基线 `accountPaths`、C10-RA 固定数组仅各加这一条，旧本机19条不变。C10A 在线与桌面真实构建及 C10-RA 合并定向17/17、0 fail/cancel/skip、exit 0、wall 4112 ms；未重跑 full/Chrome | `%TEMP%/pc-consent-ratchet-8paths/target.out.log`、`%TEMP%/pc-consent-ratchet-8paths/diff-check.log` |

这轮修复把许可判断与展示缓存分开：被后发 GET/POST 覆盖的旧 GET 不修改展示状态，也不能放行本次 send；`requireCloudConsent` 在发起与返回时核当前账号和绑定代次，并要求当前服务端刷新结果仍有效。对话、digest、标题和会话键包含账号及绑定代次；发送、附件上传、队列出队和插队在等待同意之后再次核当前绑定，迟到的旧请求不再把 A 草稿用于 B。新增真实同页 A→B 换账号验证旧草稿/队列不展示、不产生 Agent POST，另有同账号换绑定纯回归。

限定截图只在告知首次出现、拒绝后草稿保留时保存：`%TEMP%/pc-cloud-consent-shots-e7908e46524a/notice.png` 与 `%TEMP%/pc-cloud-consent-shots-e7908e46524a/refusal.png`。`--out` 只允许新建的 `%TEMP%/pc-cloud-consent-shots-<12 hex>` 子目录；只输出这两个固定文件名与状态，不抓密码输入、任意 DOM、凭证。人工已看图，前者为告知及两个按钮，后者为拒绝后保留的测试草稿。截图属于隔离 React 探针。

浏览器探针的 `cloud.available=true` 是隔离 UI 条件，`/agent/v1` 明确回 503；它只证明同意前不调用 Agent、拒绝草稿/队列保留、同意持久/跨设备、旧委托仍关闭。它**不证明**生产 Agent 已可运行、真实模型或桌面 Rust IPC：纯测试里的 `native` 是注入回调，根需另验 Rust IPC/离线编译。页面唯一 404 是 `/favicon.ico`，不属于产品接口。6650–6659 在开始前全空；fixture 的 Chrome profile、服务与监听由自身 finally 关闭，原日志只含状态/路径，不含密码、Cookie 或票据。全量 `npm test` 与节点验收留给根的联合固定源码；本叶没有执行。

真后端探针只从本机 `VisuHive main@1b3b0029eddf951225a8a2912597dc46854e9041` 导入 `openStore/createApp/createCredentials`，使用独立 RAM SQLite、临时 Chrome profile 和只在本地 6650 的 HTTP。只测同意用户路径，不混用未部署的 Agent 运行器。最终源码提交与报告提交分别以 Git 记录为准；没有合并、推送或改节点。
