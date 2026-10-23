# 网盘连接器任务书

从用户自己的第三方存储（先做 Google Drive）直接把素材取进项目，不必先下载到本机再上传。

分支 `claude/drive-connector`，worktree `.worktrees/drive-connector`。先在本机跑通，0.7.20 结束后再合入 main（2026-10-22 用户定）。

## 1. 用户 2026-10-22 定的

| 条目 | 用户原话 | 落到哪 |
|---|---|---|
| 两条凭据路都要做 | 「长寿命和短寿命都要做。最后决定用哪个是之后的事情，但是两条路都要通。」 | 第 3 节 A2、A3 |
| 凭据可以存云端 | 「现在我授权定：凭证由云端代替保存。」 | 第 3 节 A2；解除 `TODO.md` 里 2026-10-08 搁置的那条 |
| 带宽费用认可 | 「认可新增带宽费用。」 | 解除 `constraints.md`「新增费用要绕」对本项的约束 |
| 排期 | 「先在本机测试跑通，作为单独分支。.20结束后合入。」 | 第 7 节 |
| 先做哪家 | 「可以先做通GoogleDrive，DropBox作为待办。」 | 第 2 节 |
| 本轮范围 | 「可以只做素材页的界面，和业务部分。之后再合入。」 | 第 2 节 |

## 2. 范围

**做**：Google Drive；素材页的界面；业务逻辑（授权、选文件、拉取、入库、两档、断点续传、凭据保管与撤销）；本机跑通。

**不做**（记待办）：Dropbox（接口按可换后端设计，但不实现）；云端节点的生产部署；OneDrive 等其它网盘。

## 3. 两条凭据路

前半段两条路一样：用户在素材页点「从网盘导入」→ Google OAuth（范围只要 `drive.file`，PKCE，`access_type=offline`）→ Google Picker 选文件 → 拿到 fileId 列表。

后半段分叉：

| | A3 短命票 | A2 凭据托管 |
|---|---|---|
| 交给拉取方什么 | 一张 ~1 小时的 access token | refresh token |
| 拉取方存不存 | 只在内存里，这一轮完就弃 | 加密落盘 |
| 谁换新票 | 页面换好了递过去 | 拉取方自己换 |
| 用户关掉页面 | 拉取暂停，排队等下次打开 | 照常拉完 |
| 怎么失效 | 到点自动失效 | 要显式撤销 |

两条都要通，因为 A3 撑不过关页面，而「断了下次接着传」正需要用户不在时也能动。

**为什么 `drive.file` 够用、也必须是它**：它是非敏感范围，不触发 Google 每年一次的第三方安全评估；`drive.readonly` 是受限范围，要评估。而且桌面与移动应用用 Picker 时 Google 只许 `drive.file`。代价是只能碰用户当场选中的文件，搜不了整个网盘——对本功能正好够。

**一张票能拉多大**：access token 寿命 3600 s；200 Mbps 下 `200e6×3600/8 ≈ 90 GB`。正常素材一张票就够，不必中途换。

### A2 的保管规矩

- **按「项目 × 成员 × 提供方」一份**。别的成员读不到，别的项目用不了——和「素材不能跨项目读」同一条线。
- **加密落盘**：用拉取方的服务端密钥 AES-256-GCM 加密后写，临时文件加改名（照 `server/auth/store.mjs` 的写法）。这比现有项目凭证的明文落盘高一档，因为这是第三方凭据。只用 node 内置 crypto，不加依赖。
- **不进日志、不进回包、不进地址**（照 `delegation.mjs` 的规矩）。
- **四个撤销口子**：① 用户在软件里撤；② 用户在 Google 账号页撤——拉取方下次换票拿到 `invalid_grant`，自动清掉并告诉用户；③ 成员被踢或改密退出——跟着成员代数一起失效；④ 项目删除。

### A2 怎么拿到 refresh token（2026-10-23 用户定：不押后，现在就接）

1. 页面发起授权码流程（PKCE），带 `access_type=offline` 与 `prompt=consent`，`redirect_uri` 指向页面自己的来源。
2. 页面拿到**授权码**，不自己兑换，把码和 PKCE 的 verifier 一起交给拉取方。
3. 拉取方用码 + verifier + **客户端密钥**向 Google 换 refresh token，按上面「A2 的保管规矩」加密落盘。页面全程不碰 refresh token。

要注意的三处：

- **A2 要重定向 URI，A3 不要。** A3 走的是 Google Identity Services 的令牌客户端（弹窗式），只认 JavaScript 来源。A2 的授权码流程要在客户端上登记重定向 URI。开发期先登记 `http://localhost:5321/oauth2callback`；生产的那个等托管域名定下来再加。
- **客户端密钥存哪**：部署配置，不进代码库。本机这一份的位置记在 `docs/local.md`（该文件不入库）。`.gitignore` 里已加 `client_secret*.json` 兜底。
- **「Web 应用」与「桌面应用」可能要各一个客户端**（待定）：Web 类型的授权码兑换要带客户端密钥，适合浏览器版加云端节点；桌面版若要在用户机器上直接兑换，带着密钥分发出去等于公开它，那种情形要改用「桌面应用」类型（PKCE，不要密钥）。本轮只建了 Web 类型，桌面版怎么接等业务层打通后再定。

## 4. 数据流

不新增角色，字节仍然只走素材服务。

```
用户页面 ──OAuth+Picker──> Google
   │ fileId[] + 票
   v
拉取方（本机编辑器进程 / 云端节点）
   │ 经出网闸 GET files.get?alt=media
   v
临时文件 ──ffmpeg 转小尺寸──> 两档
   │ media-ingest（成员本人的素材票据）
   v
素材服务（照常分片、断点续传、两档顺序）
```

- **拉取方是谁**：项目放本机 → 本机编辑器进程；项目放云端 → 云端节点（这才省掉用户上行）。
- **出网**：云端走现有出网闸 `server/agent/service/egress.mjs`，Google 的域名是公网，现有黑名单不挡。
- **入库**：走现有 `server/media-ingest.mjs`，不另开通道。
- **小尺寸谁转**：拉取方当「上传方」自己转，不违反「素材小尺寸由上传方在自己的机器上转码，素材服务不转码」。云端节点需要 ffmpeg（部署项，照 `PROMPTCUT_AGENT_COLLECT_PYTHON` 的样子加一个配置）；节点上没有就只有原尺寸一档，照现有「转不出小尺寸只有原尺寸一档」的退路。

**可换后端**：拉取方只认一个 `StorageProvider` 接口（列文件元信息、取字节流、换票），Google Drive 是第一个实现，Dropbox 以后加一个实现，不改上层。

## 5. 界面（素材页）

改 `src/editor/left/LibrarySection.tsx`：

- `SectionHead` 里「导入媒体」旁边加一个「从网盘导入」。离线时和「导入媒体」一样置灰。
- 点开 → 提供方列表：Google Drive 可用；Dropbox 灰掉，写「待开放」。
- 没授权过 → 先授权，再开 Picker；授权过 → 直接开 Picker。
- Picker 选完 → 确认框：列文件名、大小、预计耗时；一个勾选「让云端替我保管授权（关掉页面也能继续传）」——勾上走 A2，不勾走 A3。
- 导入中：素材库里就出现条目，挂 `pending: true`，和现有本地导入的占位一致；进度随上传队列走。
- 另有一个「已连接的网盘」入口：看连了哪些、什么时候连的、撤销。

## 6. 分步与验收

| 步 | 做什么 | 完成的标志 |
|---|---|---|
| ~~D0~~ | 前置：Google Cloud 登记（见第 8 节） | **已完成 2026-10-23** |
| ~~D1~~ | 探针：Picker + `drive.file` + Range | **已通过 2026-10-23**，结果见下文 6.1 |
| D2 | `StorageProvider` 接口 + Google Drive 实现 + 分段拉取与入库 | **已完成并真机跑通 2026-10-23**，见下文 6.2、6.4 |
| D3 | 断点续传 | 单测已覆盖（见 6.2）。真机「拉到一半杀进程、重启接着拉完」还没单独验 |
| D4 | A2 凭据托管与撤销 | **已完成 2026-10-24**：服务端见 6.3，页面与界面见 6.5。真机「连接」那一下要用户本人在 Google 弹窗里点 |
| D5 | 素材页界面与 HTTP 入口 | **已完成 2026-10-23**，见下文 6.2。界面已在真机上看过 |
| D6 | 隔离验收 | **单测已覆盖 2026-10-23**（见 6.3）。真机复验等 D4 的页面那一半 |

每一步之后基线要全绿：类型检查零错误、全量测试通过（`verification.md`）。

### 6.1 D1 的结果（2026-10-23，`scripts/probes/drive-range-probe.html`）

在 `http://localhost:5321` 上用真实 Google 账号跑的，素材是用户自己 Drive 里一段 18.7 MB 的 mp4。

**两个问题都是「成立」**：

| 验什么 | 结果 |
|---|---|
| `drive.file` 够不够用 | 够。Picker 选中的文件直接读到元信息（`video/mp4`，18.7 MB），不需要受限范围 `drive.readonly`。「选中即授权」成立 |
| `files.get?alt=media` 支不支持 Range | 支持。`Range: bytes=0-1023` 回 **206 Partial Content**、恰好 1024 字节；中段 `bytes=9359604-9360627` 同样回 206、1024 字节，且两段内容的哈希不同——确认是按偏移给字节，不是从头给 |

**由此定下来的两件事**：

- 云端直拉可以**分段取**，断点续传落到片级：断了只补缺的那几段，不用整件重来。第 9 节里「不支持 Range 就只能整件拉」那条退路作废。
- 配合 `media-tiers.mjs` 已有的 faststart 重封装（`moov` 搬到文件头），拉取方可以**先取第 0 片读出帧索引**，再精确算出某一帧落在哪几个字节上。按 12 字节/样本估，8 MiB 的第 0 片装得下 30 fps 下约 6.5 小时素材的索引。

**三条实测到的事实**：

- **access token 寿命 3599 秒**，和设计里按 3600 秒算的一致。
- **Google 会自动多给几个范围**。只申请了 `drive.file`，实际回来的是
  `email profile openid .../auth/drive.file .../auth/userinfo.profile .../auth/userinfo.email`。
  多出来的全是非敏感的 OpenID Connect 基本范围，不用在「数据访问」页里登记，也不影响 CASA 的判定。这从另一个角度印证了第 8.4 节里登录那条线的结论：那几个范围本来就跟着来，不必加。
- `Content-Range` 响应头**在浏览器里**读不到（Google 没在 `Access-Control-Expose-Headers` 里放出来）。不影响探针的判断——状态码和实收字节数就够。拉取代码跑在服务端、没有跨源这回事，读得到；但仍然不拿它当偏移的准，自己记。

### 6.2 D2 的业务层（2026-10-23）

`server/storage-connectors/` 五个文件，只用 Node 内置模块、不引 `.ts`、不加依赖（和 `server/asset-store/` 同一套规矩）：

| 文件 | 管什么 |
|---|---|
| `index.mjs` | 工厂。调用方只认这一层，不认具体哪家网盘 |
| `provider.mjs` | 错误类型、令牌取法、Range 头、HTTP 状态码归类 |
| `google-drive.mjs` | 第一个实现。`stat` 与 `openRange` 两个口 |
| `pull.mjs` | 分段拉到本机临时文件，断点续传 |
| `import.mjs` | 拉完交给 `media-ingest.mjs` 入库，入库成功才删临时文件 |

几处定下来的做法：

- **令牌可以传函数**，每次请求前重取。A3 页面递来的新票、A2 自己换的新票都能接上，不用重建 provider。
- **续传靠临时文件自己的长度**，不另记进度文件。和「同步状态只问素材服务」同一个道理：事实只有一处，不会对不上。临时文件名按 `<kind>-<fileId>.part` 构造，同一份文件重来落在同一个路径上。
- **本层不重试**，拉失败就抛，由调用方决定退避多久。反正是断点续传，再调一次就接着拉。哪些错该重试看 `TRANSIENT_CODES`（`quota`、`network`）。
- **入库失败时临时文件留着**，下次不用重新下载；要主动清掉调 `discardPartial`。
- **Google 自家格式**（`application/vnd.google-apps.*`）没有原始字节，当场回一句说得明白的错，不去 `files.export`。

测试 `server/test/storage-connectors.test.mjs`，23 个用例，不碰网络（Drive 那层用假 `fetch`，拉取那层用背后是 Buffer 的假 provider，入库那层架一个裸 http server 冒充素材服务）。覆盖了分段、续传、整件给、给多了、空文件、六种 HTTP 状态码的归类、文件名消毒、临时文件的留与删。

**踩到并记下的一个坑**：`FileHandle.createWriteStream({ autoClose: false })` 不发 `close` 事件，而 `stream/promises` 的 `pipeline` 要等到 `close` 才算完——五个会落盘的用例全部 15 秒超时。改用 `fs.createWriteStream(dest, { flags: 'r+', start })` 就好了。`pull.mjs` 的 `appendStream` 注释里写了这一条。

### 6.2b D5 的 HTTP 入口与界面（2026-10-23）

服务端两个口，接在 `server/vite-plugin-media.ts` 上（照它原有的惰性 import 惯例，+29 行）：

| 口 | 做什么 |
|---|---|
| `GET /api/media/storage/config` | 下发页面要的三样公开参数。没配环境变量就 `configured: false` 带原因，界面置灰、不报错。**客户端密钥永不下发** |
| `POST /api/media/storage/import` | 拉一份进素材库，回包形状同 `/api/media/upload/<名>`。页面交来的 access token 只过手：不落盘、不进日志、不进回包 |

页面侧四个文件：`io/googlePicker.ts`（取票与选文件）、`io/storageImport.ts`（占位 → 调接口 → 探时长宽高 → `applyUploadedMedia`）、`left/StorageImportButton.tsx`（按钮与网盘菜单）、`left/left.css`（样式，追加在末尾）。`left/LibrarySection.tsx` **只加 7 行**——同期有别的会话在改它，整块逻辑放进单独组件，冲突面压到最小。（事后印证：合 main 时那个文件果然冲突了，但只冲突在一行 import 上，顺手解掉。）

**真机上看过**：按钮在「导入媒体」下面，点开是网盘菜单，Google Drive 可点、Dropbox 灰着标「待开放」。

**一处取舍**：网盘这条路字节不经过页面，所以页面手里没有 `File`，这类素材**暂时不能做语音转写**（`io/stt.ts` 回「素材文件不在内存里」）。这和「打开一个已有项目之后的素材」是同一种情形，不是本条路新引入的，记在第 9 节待办里。

### 6.4 真机端到端（2026-10-23，通过）

用户在 5321 上走完整条路：素材页「从网盘导入 → Google Drive」→ Google 授权 → Picker 选中自己 Drive 里的 `【托业单词神器】墨墨背单词操作.mp4` → 素材进库、片段上时间轴、画面出来。**D2、D5 这条链路算通了。**

过程中暴露出一个缺陷，已修（见下）。

#### 顺带查出并修掉的缺陷：素材入库前预览是坏的

用户的原话是「添加的时候预览失败，但是最终导入成功」。控制台上对应的是

> An empty string ("") was passed to the `src` attribute. This may cause the browser to download the whole page again over the network.

**根因不在网盘这条路，是 `src/render/FrameScene.tsx` 里早就有的。** `mediaTier.ts` 的 `playbackUrl` 在「这份素材还没有可用地址」时回空串，它的文件头写明「调用方拿到 `""` 就不挂 src、不发请求」；而 `FrameScene` 的 `srcOf` 把空串原样传进了 `<video src>`。浏览器把 `src=""` 当成「再下载一遍当前页面」，那一格预览就是坏的。

**为什么以前没人发现**：素材入库前会挂 `pending: true`、`url: ""`，本地导入的这个窗口只有毫秒级，看不出来；从网盘导入要拉几十秒到几分钟，整段都看得见。

**改了三处**，都是把空串转成 `undefined`：`FrameScene.tsx` 的 `srcOf`（根因）、`VideoTrack.tsx` 的 `plan.load[i]?.url` 与 `playbackUrl(image.media, …)`（后两处是写守门测试时顺带查出来的，同一类毛病）。

**加了守门测试** `src/render/emptyMediaSrc.test.mjs`：扫这两份文件里所有 `src={…}`，凡是表达式里有 `playbackUrl(` / `previewMediaUrl(` / `originalMediaUrl(` / `plan.load` 的，必须以 `|| undefined` 收尾。写规则时自己先踩了两个坑，都记在注释里了——`\bsrc` 会从 `data-pc-media-src=` 里匹配出来（data 属性空串无害，要用否定回顾排掉），以及外面已经有 `url ? … : null` 守着的不算风险。

### 6.6 A2 真机跑通（2026-10-24，通过）

用户在面板上点「连接」，走完 Google 的离线授权。四项逐个核过：

| 核什么 | 结果 |
|---|---|
| 界面 | `Google Drive · 连接于 2026/10/24 · 断开` |
| `GET …/connections` | 有那一行（`projectId: local`、`grantedScope: …/auth/drive.file`），**回包里没有任何令牌样的字段** |
| 落盘的凭据 | `out/storage-credentials/connectors/<哈希>.json`：明文只有 `v / projectId / userId / provider / grantedScope / createdAt / updatedAt`，令牌在 `iv + tag + data` 里；整份文件里**没有 Google refresh token 的特征串 `1//`**。密钥另存 `connector-key`。`out/` 本来就在 `.gitignore` 里 |
| **不带令牌导入** | `POST …/storage/import {"kind":"google-drive","fileId":"1yTC…"}`（**请求体里没有 token**）→ 成功 |

最后一项是 A2 真正要证明的东西，结果：

- `pulled: { bytes: 18719209, total: 18719209, resumedFrom: 0, segments: 3 }` —— 18.7 MB 分 **3 段**取回来，分段拉取对着真 Drive 成立
- 落库哈希 `a1391c41…` 与之前走 A3 那次**完全相同**，`deduped: true`
- 两档都在（原尺寸 + 小尺寸）
- 回包里没有令牌

能成只有一条路径：请求里没有令牌 → 用存着的 refresh token 向 Google 换了一张 access token → 用它取字节。没有凭据时这条路会当场报 `no-credential`（单测覆盖过）。

#### 顺带修掉的缺陷：Picker 取消后卡在「从网盘导入中…」

用户报「什么也没导入、点取消，会卡在等待导入」。原因是 `pickDriveFiles` 只在回调里的 `CANCELLED` / `PICKED` 两种 action 上收尾，而 Picker **只在点「取消」按钮时才保证发 `CANCELLED`**；用右上角的 × 关掉、按 Esc、点到对话框外面都可能不发。那样这个 Promise 永远不落地，调用方的 `finally` 轮不到，按钮就一直显示「从网盘导入中…」。

修法：留住 `builder.build()` 回来的对话框对象，每 400 ms 看一次 `isVisible()`，**先看见它开过**、之后变成不可见就当取消（不加这个前提，第一次轮询会把还没开出来的对话框当成取消）。`isVisible()` 调不动（对象已销毁）同样当取消。

### 6.3 D4 的 A2 业务层（2026-10-23）

三个文件，仍是只用 Node 内置模块：

| 文件 | 管什么 |
|---|---|
| `google-oauth.mjs` | 授权码兑换、换票、撤销。令牌与密钥不进日志、不进错误信息 |
| `credentials.mjs` | refresh token 加密落盘，按「项目 × 成员 × 提供方」分格 |
| `managed-token.mjs` | 接上、按需换票、断开，串成给 `createStorageProvider({ token })` 用的那个函数 |

几处定下来的做法：

- **加密落盘，而且和那一格绑死**。AES-256-GCM，密钥是 `<dir>/connector-key` 里的 32 字节（首次用时随机生成，`wx` 开，几个进程同时起也只有一份）。**AAD 取「项目 × 成员 × 提供方」那一格的标识**——把文件挪到另一个项目或另一个成员的格子里，解密直接失败。单测里真做了这个搬运来验。
- **写入走临时文件加改名**，照 `server/auth/store.mjs` 的做法，中途断电不留半份。
- **`list` 只回元信息，一个令牌都不带**（给「已连接的网盘」那个管理界面用）。单测里断言了结果 JSON 里不许出现令牌。
- **`invalid_grant` 当场清掉凭据，不退避重试**。用户在 Google 账号页撤销、改密码、令牌过期都回它，再试一百次也是它。这是四个撤销口子里的第二个。
- **`disconnect` 撤销失败也删本地那份**。用户点了「断开」，本地就不该再留着能用的凭据；Google 那边没撤成就在回包里说一句，由界面提示用户去账号页再撤一次。
- **几路同时要票只换一次**（`inflight` 合并），免得并发拉取把 Google 的换票接口打出限流。

测试 `server/test/storage-credentials.test.mjs`，22 个用例，不碰网络。

### 6.5 D4 的页面那一半与管理界面（2026-10-24）

**又加了四个口**（接在 `vite-plugin-media.ts` 上）：

| 口 | 做什么 |
|---|---|
| `POST /api/media/storage/connect` | 页面交来授权码与 PKCE verifier，这一侧换出 refresh token 存起来。回包不带任何令牌 |
| `GET /api/media/storage/connections` | 列出已连接的网盘，只回元信息 |
| `POST /api/media/storage/disconnect` | 向网盘撤销并删掉存着的那份 |
| `GET /oauth2callback` | 授权弹窗的落地页，把授权码 `postMessage` 回开它的页面然后自己关掉 |

落地页只发给**同源**的开启方（`postMessage(msg, location.origin)`），授权码不会漏给别的源，页面上也不显示它。

**这里踩过一个坑（2026-10-24）**：素材中间件的总入口有一行前缀过滤 —— `if (!pathname.startsWith("/@media/") && !pathname.startsWith("/api/media/")) return next();`。`/oauth2callback` 两个前缀都不沾，于是被放给了 vite 的 SPA 兜底：**授权弹窗里渲染出整个编辑器**，授权码永远回不到开它的页面，A2 连不上。这个地址不能改前缀（要和 Google 控制台登记的重定向 URI 逐字一致），所以在总入口那一行放它过来，路径抽成常量 `OAUTH_CALLBACK_PATH`。

**为什么第一次没发现**：当时只用 curl 核了状态码与 `content-type`，两样都是 `200 / text/html` —— vite 的 `index.html` 也是这两样。教训是**核正文**。已补 `server/test/storage-oauth-callback.test.mjs`：把中间件架在裸 http server 上、`next()` 回 404 冒充 SPA 兜底，核正文里有没有来源标记、是不是编辑器那张 `index.html`、有没有落到兜底。撤掉修复后这条测试 4 条里红 3 条，装回去全绿（验过）。

**页面侧**：`googlePicker.ts` 加 `requestDriveAuthCode`——自己生成 PKCE verifier 与 S256 challenge、带 `access_type=offline` 与 `prompt=consent` 开弹窗、按 `state` 对上回来的消息。**页面不兑换授权码**，兑换要客户端密钥，那东西只在编辑器进程这一侧。

**界面**：网盘菜单下面多一行「已连接的网盘…」，点进去是管理面板——每家网盘一行，显示「未连接 / 连接于 <日期> / 不支持托管」，右边是「连接」或「断开」。已托管的网盘在菜单里带一个「已托管」标。

**两条路在界面上怎么分**：Picker 本身**总要一张当场的票**（它要在页面里列文件），所以托管与否都会走一次 `getDriveToken`；区别只在「拉字节」那一段——已托管就不把票递下去，拉取方用自己保管的凭据换票，于是几个 G 的大文件拉一小时也不会半路因为票过期而断掉。

**客户端密钥**：从 `PROMPTCUT_GOOGLE_CLIENT_SECRET` 读；没配就 `canManage: false`，界面上「连接」按钮置灰并说明原因，A3 照常可用。另有 `PROMPTCUT_GOOGLE_REDIRECT_URI`，要和 Google 控制台里登记的重定向 URI 逐字一致。

**验证**：`tsc -b` 零错误；`storage-connectors` + `storage-credentials` + 守门测试共 68 条全过，另跑受影响的 9 个文件 136 条全过；真机上配齐五样后 `config` 回 `canManage: true`、`connections` 回空表、`/oauth2callback` 回 200 text/html，管理面板渲染正确（见截图）。**「连接」那一下要用户本人在 Google 弹窗里点**，和 Picker 那一下同理。

## 7. 排期

本机跑通后分支留着，0.7.20 结束后合入 main。不插队 0.7.19～0.7.20 的连做。

## 8. 前置：开发方的一次性登记

### 8.1 两边是谁做什么

| | 谁 | 几次 | 做什么 |
|---|---|---|---|
| **开发方登记** | 你 / VisuHive | 整个产品**一次** | 在 Google Cloud Console 登记「PromptCut」这个应用，拿一组 client ID 与 API 密钥，编译进软件 |
| **终端用户授权** | 每个用户 | 每人点几下 | 素材页点「从网盘导入」→ Google 登录页 → 勾同意 → Picker 里选自己的文件 |

**终端用户不碰 Google Cloud Console，也不建任何项目。** 他们登录的就是自己的 Google 账号，取的就是自己网盘里的文件——「用户直接用自己的 Google Drive」正是这个设计要达到的，开发方登记只是让 Google 认得「PromptCut」这个应用。

**为什么躲不掉**：Drive 的 OAuth 只认登记过的应用，没有 client ID 连授权请求都发不出去。所有接 Drive 的软件都有且只有一组这样的登记。Google Cloud Console 不是企业产品，个人 Google 账号就能建；**Drive API 和 Picker API 都不要求绑付款账号**，这一步不产生费用。

### 8.2 上线给任意用户用

把 OAuth 同意屏幕从「测试」切到「正式」。以下是 2026-10-23 在控制台上实地核到的，不是从文档推的：

- **`drive.file` 确实是非敏感范围。** 加进去之后落在「您的非敏感范围」一栏，「您的敏感范围」「您的受限范围」两栏都空（重新载入页面后复核过）。所以 CASA 安全评估不适用。
- **测试模式下有 100 人上限，与范围无关，而且是终身额度。** 控制台「受众群体」页原话：「当发布状态设置为『测试』时，仅测试用户可以访问应用。在应用验证之前，允许的用户数上限为 100，并且会计入应用的整个生命周期。」开发期不要乱加测试用户。切「正式」之后这个上限是否解除，上线时实测。
- **要切「正式」，先得把「品牌塑造」页填完。** 控制台里「发布应用」按钮是灰的，旁注「如需发布应用，您必须在品牌页面中完成配置」。那一页要应用首页地址、隐私政策地址、服务条款地址，并要验证域名所有权。
- **这是产品侧的前置，不是技术活**：三个地址必须是 VisuHive 的真实页面，隐私政策里要写明拿用户的 Drive 数据做什么。排期时要算进去。
- **开发与探针阶段停在「测试」模式**就够，不影响本任务书任何一步。

### 8.3 两条不用登记的路，都不够格当主路

- **让用户粘贴 Drive 分享链接**：不需要任何登记，但只对「任何知道链接的人都可查看」的文件管用，走的是非官方的 `uc?export=download`，大文件会撞上病毒扫描中间页，Google 改一次就坏一次。可以留作兜底，不能当主路。
- **让每个用户自己建 OAuth 客户端**（rclone 的做法）：等于把下面六步摊给每一个用户做，正是要避免的。

### 8.4 这个 Cloud 项目与账号登录共用（2026-10-23 用户定）

VisuHive 的账号登录（Google 登录）和网盘连接器**共用这一个 OAuth 客户端**，不各建一个。用户原话：「5830 是登录那边加的，两边就共用这一个 OAuth 客户端。」

- **好处**：同一个产品一组登记，用户只看到一次 Google 授权页，授权一次两边都能用。
- **代价**：同意屏幕的范围列表是两边共享的。
- **配套的硬规矩：这个 Cloud 项目的范围列表只许加非敏感范围。** 要加敏感或受限范围的，另建一个 Cloud 项目，不要加在这里。理由：把范围压在 `drive.file` 上就是为了躲开 CASA 安全评估；同一个客户端上只要出现一个敏感范围，网盘连接器会被一起拖进验证流程，前面的功夫白费。
- **实际上这个项目可以一直只有 `drive.file` 一个范围**〔2026-10-23 登录那条线实测，本会话未复核〕：账号登录走的是 Google Identity Services 的 ID 令牌流程（`google.accounts.id`），`openid` / `email` / `profile` 是 OpenID Connect 登录本身隐含的，不是「数据访问」页里要列的 API 范围——`email`、`email_verified`、`name` 直接在 ID 令牌里。对方用真实 Google 账号在 `https://localhost:5830` 登录成功时，同意屏幕的数据访问里只有 `drive.file`。ID 令牌流程也不需要重定向 URI，那一栏归网盘连接器独用。
- **已获授权的 JavaScript 来源两边合用，各管各的几条，不要删别人的**：

  | 来源 | 谁的 |
  |---|---|
  | `http://localhost:5321`、`http://127.0.0.1:5321` | 网盘连接器的 D1 探针 |
  | `http://localhost:5830`、`http://127.0.0.1:5830` | 账号登录 |

### 8.5 六步（一次性，由你做）

1. 打开 Google Cloud Console，新建一个项目（或用现成的）。
2. 启用两个 API：**Google Drive API** 和 **Google Picker API**。
3. 「OAuth 同意屏幕」：User Type 选 External，填应用名、支持邮箱。范围**只加 `.../auth/drive.file`**（加了 `drive.readonly` 就要安全评估，别加）。开发阶段把自己的 Google 账号加进「测试用户」。
4. 「凭据」→ 新建 OAuth 客户端 ID → 类型选 **Web application** → 已获授权的 JavaScript 来源填 `http://localhost:5321`（探针用的端口，见第 6 节 D1）。
5. 再新建一个 **API 密钥**（Picker 要用），建议限制到 Picker API。
6. 把 **client ID**、**API 密钥**、**Cloud 项目编号**（纯数字，Picker 的 appId）三样给我。都不是秘密，会直接出现在页面里；client secret 不要给、PKCE 流程也用不上。

## 9. 待办

### 9.0 待用户项（2026-10-23 整理，都不挡继续开发）

1. ~~**真机端到端还差最后一步**~~ **2026-10-23 已跑通**，见 6.4。
2. **切「正式」**：要让任意用户用，得把同意屏幕从「测试」切到「正式」，前提是填完「品牌塑造」页——应用首页、隐私政策、服务条款三个真实地址加域名所有权验证。产品侧的事，不是代码。
3. **测试模式 100 人是终身额度**（控制台原话「会计入应用的整个生命周期」），别拿它当随手可加的测试名单。
4. **A2 要用客户端密钥**：代码已经做完（第 6.3、6.5 节），但正式部署前要决定 `PROMPTCUT_GOOGLE_CLIENT_SECRET` 与 `PROMPTCUT_GOOGLE_REDIRECT_URI` 在部署配置里怎么放。本机那一份的位置在 `docs/local.md`（不入库）。
5. **「连接」那一下要用户本人点**：和 Picker 同理，授权弹窗是独立窗口，会话碰不到。

### 9.1 技术待办

- Dropbox：接口留着，实现以后做。满 50 个链接用户要过生产审批。
- Google Drive 有个没写进文档的下载配额（社区报 10 TB/天，官方 [Usage limits](https://developers.google.com/workspace/drive/api/guides/limits) 只写了每分钟请求配额）。撞上是 403 `downloadQuotaExceeded`。拉取失败要能退回「让用户自己的电脑下载再上传」这条路。
- ~~Drive 的 `files.get?alt=media` 支不支持 Range，官方文档没写明，D1 探针验。~~ **2026-10-23 实测支持**，见 6.1。
- 写拉取代码时不要依赖 `Content-Range` 响应头：跨源读不到，要自己记偏移（6.1）。
- 云端节点的 ffmpeg 部署配置。
- **网盘导入的素材暂时不能语音转写**：页面手里没有 `File`，`io/stt.ts` 回「素材文件不在内存里」。和「打开已有项目之后的素材」同一种情形。要修就得让 STT 改成按内容哈希向素材服务取字节，而不是从页面内存里取——那是 `io/stt.ts` 的改动，不属于本任务书。
- **共享项目里的网盘导入**：现在 `POST /api/media/storage/import` 照 `vite-plugin-collect.ts` 的样子只传 `origin`，没带 `ownership` 与素材票据，所以只在本机项目里管用。共享项目要补这两样。

## 10. 不做的

- 不碰 `drive.readonly` 等受限范围。
- 不搜用户整个网盘，只认他当场选中的文件。
- 不把素材留在节点的临时目录：入库后立刻删（照 `hosted-collect.mjs` 的规矩）。
- 不改哈希寻址，不做 fMP4，不做「边传边取某一帧」——理由见会话里的探索结论：小尺寸比原尺寸小 1:67，先传完小尺寸这条现有规则已经覆盖了这个窗口。
