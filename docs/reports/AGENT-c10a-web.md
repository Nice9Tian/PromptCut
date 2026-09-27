# AGENT 报告：c10a-web

分支 `claude/c10a-web`，worktree `.worktrees/c10a-web`，起点 `claude/c66-integ` 的 `851ffe9`（主会话裁定：C10a 与 C6.6 的 T9 重叠进行，C6.6 合入 main 后用合并跟上，不 rebase）。端口段 5630～5639。

任务：`docs/plan/c10a-contract.md`（C10a 契约，下称「契约」）第 2～7 节，文案照第 14 节表 A、B。任务书是主会话的 `c10a-tasks.md`「公共部分」与「c10a-web」两节。

## 进度

- [x] 第 2 节：在线构建、`src/online/mode.ts`（逐字节）、`/api` 守卫、在线地址、纯浏览器设备身份
- [x] 第 3 节：`deploy-hosted` 的 `--editor`、`--doc-public-url`、`--asset-public-url`
- [x] 第 5 节：邀请码服务端（含主会话 2026-09-27 的五条裁定）
- [x] 第 4 节：开始页「加入别人的项目」
- [x] 第 6 节：项目设置「多用户协作」
- [x] 第 7 节：二维码
- [ ] 验证里「在线构建产物里搜不到 `/api/`」的**静态**那一条没达成：要改的文件在第 11 节本分支清单之外，见「没做成的」第 1 条，等主会话定

## 提交

| 提交 | 内容 |
|---|---|
| `3becd84` | 报告开工 |
| `16ac2fa` | 邀请码服务端：签发与作废、限时限量、`resolve` / `redeem` 端点、`shared.admin` 三个 op、限速与 `Retry-After`、原文不落盘 |
| `3c75b59` | `deploy-hosted`：`--editor` 在线构建换名上线（旧版 assets 保留一代）、两个公网地址参数写进 PM2 配置 |
| `acc1ba7` | 按主会话裁定改：429 回包带 `retryAfter`、限定进入名单外兑换不扣次数且回包相同；客户端 `resolveInvite` / `redeemInvite` 并读秒数 |
| `753fef1` | 在线构建与页面：`vite --mode online`、`src/online/*`、开始页加入表单、项目设置「多用户协作」、删掉顶栏两个旧入口 |
| `1741d17` | 守卫提前到 `src/online/boot.ts` 装、SSE / XHR 被拦时不抛；加入的人不塞演示卡；探针 `online-join-probe.mjs` |

## 做了什么

### 第 5 节 邀请码服务端

- `server/auth/invite.mjs`（新）：规则都在这里，`http.mjs` / `shared.mjs` 只调它（HT-a 以后改这两个文件时不用跟着动邀请码规则）。
  - 32 字节随机数编 43 个 base64url 字符；`digest = base64url(HMAC-SHA256(serverSecret, code))`；记录 `invite: { id, digest, createdAt, expiresAt, maxUses, used, redeemed, revokedAt }`，`expiresAt` 是毫秒时间戳；
  - 缺省 7 天、次数不限；`expiresInSec` 1 秒～1 年、`maxUses` 正整数或 null，别的回 `bad-message`；
  - 扣次数 `redeemOn`：先核对「未作废、未过期、次数未满」再加一；同一 `userId` 再兑换回 `again` 不扣（次数满了也放行已兑换过的人，作废或过期后不放行）。
- `server/auth/store.mjs`：加邀请码摘要 → 项目号的索引（打开时从磁盘重建；`update` 换邀请码、`remove` 删项目时跟着改），`peekByInviteDigest(digest)`。原文从不落盘。
- `server/auth/http.mjs`：`POST shared/invite/resolve`、`POST shared/invite/redeem`。
  - 未知、作废、过期、用完、**形状不对**一律 404 `invite-invalid`，都计入限速（裁定 4）；
  - 兑换时 `(username, deviceId)` 在禁入表里回 401 `banned`，也计入限速；
  - 自由进入回 `kdf` 与 `project: { salt, key }`（项目口令的 K）；限定进入回 `{ ok, projectId, name, mode }`，**名单外的用户名回包相同、不扣次数**（裁定 3；创建者算名单的一员）；
  - 429 带 `Retry-After` 头（CORS 里 `Access-Control-Expose-Headers` 放出）与回包 `retryAfter`（裁定 1）；
  - 日志只有来源、项目号、结果，不记请求体。
- `server/docservice/modules/shared.mjs`：`invite-create`（作废旧的、签发新的，回 `{ op, code, expiresAt, maxUses, linkOrigin }`）、`invite-revoke`、`invite-status`（平铺 `{ op, active, expiresAt, maxUses, used, revokedAt }`，裁定 2）。证明、限速同其余 op；不加代数、不断连接。
  - `linkOrigin` 是契约之外多给的一个字段：托管端公网源（`PROMPTCUT_DOCSERVICE_PUBLIC_URL` 的源），页面拼 `<源>/editor#invite=<码>` 用；没设为 null。
- `server/docservice/shared-service.mjs` 透传 `linkOrigin`；`server/hosted/combo.mjs` 加 `publicOriginOf(docPublicUrl)`（`wss://x/hosted/` → `https://x`）传进去。
- `server/auth/rate-limit.mjs`：加只读的 `retryAfterMs(remote)`。
- 挂载模式（局域网主机）用同一个 `createSharedHttp` 与模块，同一组端点与 op 自然都有（契约第 5 节「放本机的项目」）。

### 第 3 节 部署

- `server/hosted/deploy.mjs`：`checkPublicUrl`（文档服务收 ws(s)/http(s)，素材服务只收 http(s)，写错抛错不换缺省）；`hostedPm2Config(inst, host, { docPublicUrl, assetPublicUrl })` 给了就用；`editorSwapLines()`：`.incoming-editor` 整体换名成 `editor/`，上一代自己的 assets 清单在 `editor/.assets-own`，逐个补进新版（新版同名的不盖），所以只留一代。
- `scripts/remote/docservice.mjs deploy-hosted` 加三个参数；`--editor` 先在本机核对目录里有 `index.html` 与 `assets/`，scp 成 `<部署目录>/.incoming-editor`。只改了脚本与单测，没连阿里云。阿里云上的用法：
  `deploy-hosted --editor <dist-online> --doc-public-url wss://8-219-80-16.sslip.io/hosted/ --asset-public-url https://8-219-80-16.sslip.io/media/api/asset`

### 第 2 节 在线构建与入口

- `vite.config.ts`：`defineConfig(({ mode }) => mode === "online" ? onlineConfig : desktopConfig)`。在线构建 `base: "/editor/"`、`outDir: "dist-online"`、`define` 出 `import.meta.env.VITE_PC_ONLINE = "1"`，只挂 React 与 Tailwind（其余插件都是编辑器进程的 `/api/**` 与开发期中间件）。桌面构建与开发服务走原配置，未变（`npx vite build` 实测照常）。
- `src/online/mode.ts`：逐字节照契约第 2 节（仓库里的 blob 是两行加结尾换行，LF）。
- `src/online/apiGuard.ts` + `src/online/boot.ts`：`ONLINE` 时装（开发与生产构建都装，不另设开关，裁定 5）。同源 `/api/`（及 base 下的 `api/`）：`fetch` 回被拒的 Promise；`EventSource` 给一个已关闭、随即发 `error` 的替身；XHR 的 `send` 不发请求、随即发 `error`；`sendBeacon` 回 false。被拦的路径记进 `window.__pcApiBlocked`。
  - 守卫放在 `boot.ts`、由 `main.tsx` 第二个引入：有模块一载入就取 `/api/cards/scopes`，放在 `main.tsx` 正文里装会晚一步（第一次探针实测漏了 7 条）。
  - `EventSource` 原先写成同步抛错，在 React effect 里直接把整棵界面卸掉（第一次探针在线页面进编辑器后全黑），改成替身。
- `src/online/device.ts`：纯浏览器设备身份，128 位随机 id（base64url 22 字符）、「浏览器名 · 系统名 · 随机 4 位」，存在 localStorage `pc.online.device`；iPad 报桌面 UA 时按触点数认成 iPadOS。
- `src/online/invite.ts`：`#invite=` 读后即清（`history.replaceState`，只清带 `invite=` 的片段，路径与查询串保留）、粘贴链接解析、`<源>/hosted/` 与保留末尾斜杠的 WebSocket 地址。
- `src/editor/sync/syncManager.ts`：`ONLINE` 时设备取浏览器身份、不连本机文档服务、离开共享项目就是断开；不绑 Agent 服务端与卡片源码同步；本地备份照实提示存不下来。
- `src/Shell.tsx`：在线页面不认 `?editor`、`?draft`、`?open`、`?headless`，打开就是开始页。`src/main.tsx` 的 `?stage` 等入口照旧（同源单舞台是本页 `?stage=1` 的 iframe，`c10a-lowmem` 要用）。
- `src/editor/TopBar.tsx`：在线页面把新建项目、打开项目、保存、打包保存、本地备份置灰（title「在线浏览器模式暂不支持，请在桌面版里做」）。

### 第 4 节 开始页「加入别人的项目」

- `src/editor/sync/JoinForm.tsx`（新），`src/StartPage.tsx` 在「开始创作」下面放一段；在线页面只有这一段。
- 三条路径同一张表：项目名、你的用户名、密码（占位文字说明自由进入填项目密码、限定进入填名单里的密码）；凭邀请链接先 `resolve`，显示项目名与进入方式，自由进入只要用户名（`redeem` 拿 K 后照常握手），限定进入要名单里的用户名和密码；`resolve` 失败退回完整表单加表 A 文案。
- 「我是创建者」：这台设备记得创建者名（C6.5 的 `pc.shared.creators`）时预填并置灰，以 `as: 'creator'` 进入。
- 粘贴邀请链接：取链接的源，文档服务在 `<源>/hosted/`。
- 服务器地址：在线页面是本页的源；桌面版手填用内置托管地址（可在「服务器地址」里改，沿用 C6.5 的 `pc.shared.hostedUrl`），**并像 C6.5 的「打开共享项目」那样在局域网里找同名项目**（旧入口删了之后，放本机的项目的成员还要有路进来），几个候选并列供挑。
- 进入前新开一个空项目当起点，内容以文档服务为准。表 A 文案原样照抄；用户名规则照服务端 `isUsername`（输入框限 64 字符，首尾空白提交时去掉）。

### 第 6、7 节 项目设置「多用户协作」、二维码

- `src/editor/sync/CollabSection.tsx`（新）挂在 `ProjectSettingsDialog.tsx` 底部；动作在 `src/editor/sync/collab.ts`（新）。多用户协作不写进项目文档。
- 勾上的缺省：放本机、自由进入、创建者用户名取设备名、项目密码与创建者密码各自动生成 16 个字符（去掉易混字符）、存在本机 `pc.shared.local`。点对话框「确定」才开始设置（语义「勾上并保存」），对话框留着显示进度与结果。
- 放云端：`POST shared/create`（云端地址可改）→ 以创建者进入、当前项目根替换写进去 → `invite-create` → 邀请链接、二维码（`server/qr.mjs` 的 `qrSvg`，M 纠错、四模块留白、黑白、240 CSS 像素）、复制按钮、有效期与已用次数（用本机记下的创建者密码现查 `invite-status`，只读）。「作废并重新生成邀请码」先弹表 B 确认，再当场输创建者密码。离线拦下（表 B）。
- 放本机：沿用 C6.5 的本机托管；表 B 两行提示；编辑器没以局域网主机方式启动时给 C6.5 的重启提示。不出邀请链接。
- 已开启时列出项目名、项目密码（带复制）；C6.5 的改项目密码 / 改名单、改创建者密码、已禁入的设备、删除项目挪进来（复用 `MembersPanel.tsx` 的 `CreatorFlow`，成员浮层里的也还在）；改了密码同步本机记下的那份。
- 取消勾选：表 B 确认 → 先核对创建者密码（`list-bans`，无副作用）→ 放云端的等本地提交落地、把被引用素材的原尺寸交给编辑器进程的预取队列并轮询本地库到齐（一分钟没进展算失败）→ `delete` → 本机项目以根替换回到 `local` 空间。中途失败恢复勾选并给表 B 文案。自己删项目的 4004 不弹「项目被删」阻断框。
- 旧入口：`TopBar.tsx` 的「新建共享项目」「打开共享项目」两项与对话框删掉；`SharedDialogs.tsx` 只留托管地址、名单编辑器、局域网重启提示、局域网查找四个部件。
- 顺带修了一处：编辑器挂上时给空项目塞演示卡，原来只认 `?join=`；从开始页加入的页面与在线页面也跳过（改在 `syncManager.ts` 的 `isJoinPage`，没碰 `Editor.tsx`）。第一次探针实测每个加入的人都往共享项目里加了 10 张卡。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | tests 3098、pass 3097、fail 0、skipped 1（`集成:/api/cards/layout 对真实项目返回整数框`，要 5190） |
| 邀请码实现单测 | `node --test server/test/invite-impl.test.mjs` | 15/15（INV-1～14，INV-5 独立模式与挂载模式各一） |
| 相关旧测试 | `node --test server/test/invite-impl.test.mjs server/test/auth-*.test.mjs server/test/c65-shared-admin.test.mjs` | 127/127 |
| 部署参数单测 | `node --test server/test/deploy-editor.test.mjs server/test/sp-hosting.test.mjs` | 18/18（DEP-4 在本机 bash 里真跑两轮换名，核对只留一代） |
| 在线纯逻辑单测 | `node --test src/online/online-impl.test.mjs` | 6/6 |
| 在线构建 | `npx vite build --mode online --outDir <scratchpad>/c10a-web-dist-online` | 退出码 0；`index.html` 里资源都在 `/editor/assets/` |
| 桌面构建 | `npx vite build --outDir <scratchpad>/…` | 退出码 0（只验证没被在线模式影响，产物已删） |
| 端到端探针 | `node scripts/probes/online-join-probe.mjs --dist <在线构建> --out <scratchpad>/c10a-web-shots` | 39/39，退出码 0 |

- 第一次跑全量测试有 5 条失败：`SPR-6a`、`SPC6-3`（守门扫工作树，扫到我当时放在 worktree 里的 `dist-online/`，里面有打包进去的缺省托管 IP）和 `SPC1-4`、`SPC3-1`、`SPC7-1`（与在线构建同时跑，上传收尾 404；单跑 12/12）。之后在线构建一律出到 scratchpad、不与测试同时跑，重跑全量 0 失败。
- 探针（全在本机：托管组合 5634/5635、代理 5633 代替 nginx、桌面编辑器 5630～5632；没连阿里云）逐项：
  - create：缺省放本机、创建者名取设备名、两样密码 16 字符；放云端开启成功；链接是 `http://127.0.0.1:5633/editor#invite=<43 位>`（源取自 `docPublicUrl`）；二维码 240×240；托管端查得到项目、邀请码 `resolve` 得到同一项目号；
  - online（手机视口 390×844、触屏）：代理的三条路由与缓存头（`/editor` no-store、`/editor/assets/*.js` immutable、深路由回 `index.html`）；凭链接进入后 `location.hash` 已清空、只要用户名；手填自由进入、「我是创建者」、粘贴链接、限定进入手填、限定进入凭链接（要名单里的用户名和密码）都进得去；创建者那边看到 5 人；密码错、找不到项目、链接格式不对、用户名为空各给表 A 原文；加入的人没往项目里加片段（10 → 10）；**全部页面的网络记录里 `/api/` 请求 0 条**；
  - desktop：桌面版开始页手填、「我是创建者」、粘贴链接三条都进得去，片段数不变；
  - regen：表 B 确认原文；重新生成后旧链接在在线页面上给「这个邀请链接已失效…」并退回完整表单，新链接能进；
  - cancel：表 B 确认原文；「多用户协作已关闭，内容已拉回本机。」；托管端 `lookup` 回 404；编辑器回到本机空间。
- 看过的图（在 scratchpad 的 `c10a-web-shots/`）：`create-1-invite-qr.png`（设置里的链接、二维码、有效期、创建者操作）、`online-1-invite-form.png`（手机上凭链接的精简表单）、`online-1-invite.png`（手机上进了编辑器，时间轴上是创建者的片段）、`desktop-0-start-page.png`（桌面开始页的加入表单）、`regen-2-old-link.png`（旧链接的失效提示）、`cancel-1-done.png`（取消后的状态）。
- 守卫拦下的调用（运行时，没有发出去）：`/api/ai/config`、`/api/ai/providers`、`/api/ai/setup`、`/api/cards/scopes`、`/api/chats/list`、`/api/data/playhead`、`/api/data/project`、`/api/mcp/events`、`/api/media/remote`、`/api/media/upload-queue/target`、`/api/prerender/info`、`/api/skill-mode`、`/api/stt/status`。这些入口在本分支清单之外，集成时按契约「隐藏、置灰或走在线替代」逐个处理（其中预览相关的归 `c10a-lowmem`）。

## 没做成的及原因

1. **静态检查没过**：在线构建产物里还剩 124 种、201 处 `/api/` 字面量。运行时一条都发不出去（守卫加请求记录两条都已验证），但要让打包剪掉它们，得在约 50 个文件里把调用包进 `if (!ONLINE)` 或改走在线替代，都在契约第 11 节本分支清单之外：
   `src/ai/{attachments,chatStore,collect,debug,envCollect,mcpExecutor,orchestrate,runRoleTask,shots,subject,track,triage,useAiChat,voice,web}.ts`、`src/editor/{SkillDialog.tsx,cardScope.ts,demote.ts,probeRunner.ts,snapshotFeed.ts}`、`src/editor/io/{drafts,mediaUpload,mediaUrls,openPath,procCards,procLock,procp,stt}.ts`、`src/editor/media/assetTiers.ts`、`src/editor/preview/{Scene3DView.tsx,useBakePrefetch.ts}`、`src/editor/right/{AiSetupDialog,ApiSharePanel,ToolVisual}.tsx`、`src/editor/timeline/ShotMarkers.tsx`、`src/mcp/{apiUrl,common}.ts`、`src/mcp/handlers/{cards,vision}.ts`、`src/render/{dataMirror,frameClient,mediaTier,prerender,snapshotSource,streamPlayer}.ts`、`src/skill/skillMode.ts`。
   本分支清单里的文件已处理干净（`/api/docservice/device`、`/api/project-backups`、`/api/agent/ticket`、`/api/docservice/lan-discover` 在产物里都已剪掉）。需要主会话定：扩本分支清单、交给集成分支，还是把验收改成「运行时守卫 + 请求记录为零」。
2. `shared/challenge` 的 429 只加了 `Retry-After` 头，回包体没加 `retryAfter`：auth 契约的 AU8 契约测试逐字比对这个回包体（`{ ok: false, error: 'rate-limited' }`），先改测试不合规矩。邀请码两个新端点两样都带。契约修订后改 AU8 再加。界面读秒数时先看回包、没有再看头，两种都接得住。
3. 托管端在 nginx 之后，所有来源都是回环，邀请码与挑战的失败都不计入限速（与现有挑战同一个问题）。归 HT-a（`PROMPTCUT_TRUST_LOOPBACK` / 取转发头），本分支没动。
4. 放本机（局域网主机）的开启与取消没有实测：要编辑器以 `PROMPTCUT_LAN_HOST=1` 启动，探针只跑了放云端。代码沿用 C6.5 的局域网路径。
5. 取消勾选时拉回素材原尺寸那一步，探针项目里没有素材，只走了「没有要拉的」分支。
6. 真手机扫码是待用户项（契约第 12 节），没做。

## 对契约或语义的更正建议

1. 契约第 5 节 `invite-create` 的回包建议写进 `linkOrigin`（托管端公网源），否则桌面版创建者连的是 `http://8.219.80.16:8787` 这样的直连地址时拼不出 `https://…/editor` 的链接。
2. 契约第 2 节 nginx：`location /hosted/` 对不带斜杠的 `/hosted` 回 301，WebSocket 升级跟不了重定向。本分支凭源走 `/hosted/` 的连接都保留末尾斜杠（`src/online/invite.ts` 的 `hostedWsUrlOf`）；而 `server/auth/route.mjs` 的 `wsBaseOf` 会去掉斜杠，桌面版若把托管地址手填成 `wss://…/hosted/` 会连到 `/hosted`。建议 nginx 另加 `location = /hosted`，或在契约里写明页面一律带斜杠。
3. `.gitignore` 建议加 `dist-online`，`SPR-6a` / `SPC6-3` 守门建议排除它（worktree 里留着在线构建就会让这两条失败）。
4. 契约第 5 节「像手填密码那样把 K 缓存在本机」：C6.5 的手填路径只在这次连接的内存里缓存 K（断线重连用），不落盘。本分支照 C6.5 做；要落盘的话属于新行为，建议在契约里写清楚。
5. 表 A 没覆盖的几处界面文字是本分支加的：「服务器地址」「手动填写项目信息」「正在核对邀请链接…」、表单占位文字、名单外项目的候选标签（`[云端]` / `[本机 · 局域网]`）；表 B 之外加了「这台设备上没有邀请链接（链接只存在签发它的那台设备上）。」「踢人：在顶栏的成员列表里……」「要创建者密码才能取消。」。建议交互稿补上。
6. 邀请码状态用本机记下的创建者密码自动查（`invite-status` 只读）。语义「每次都要出示」管的是特权操作；若主会话认为只读查询也算，就改成点一下再输密码。
7. 在线页面顶上还是桌面版的窗口标题栏（文件、编辑、视图、帮助与窗口按钮），`WindowTitleBar` 不在本分支清单里。
