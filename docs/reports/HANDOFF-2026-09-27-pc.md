# 交接（2026-09-27 第二次，PC「PromptCut 主会话（PC）」→ 笔记本「PromptCut M5～M8 开发交接」）

用户定：主会话从 PC 交回笔记本的「PromptCut M5～M8 开发交接」（`local_561569ce-2038-4e64-a40c-31cc4f1d47b4`），PC 这个会话（「PromptCut 主会话（PC）」，`local_854d7157-9891-495b-84d6-cd0aea087a46`）交接后待命，不派活、不合并、不写信箱。本文照 `docs/reports/PAUSE-2026-09-26.md` 的格式写，不含任何令牌、密钥或口令。

- **角色**：主会话回到笔记本；笔记本辅助节点「PromptCut 笔记本辅助测试节点」与新主同在笔记本上（按 `docs/auto_long_work/handoff.md` 第三节重钉待命 goal）；PC 辅助节点「PromptCut M5～M8 PC 辅助测试节点」本次从未派活，按它模板里的「准备（握手）」向新主报到；云端「PromptCut M5～M8 云端工作节点」一直没有回执（第 5 节）。
- **计划要跟着改**：主执行计划第 0.1、0.4、6.1、6.4 节现写的是「主会话在 PC、笔记本辅助」（`8a5d6ff`），新主接手后第一件事按 `handoff.md` 第二节改回当前分工。
- **本机文件**：PC 的 scratchpad 在笔记本上读不到，交接要用的几样已放进仓库：两份阶段报告草稿（第 2 节）、C10 三个分支的任务书（附录 A）、像素基线比较脚本（附录 B）、T9 本机替身脚本（附录 C）。

## 1. 本次（2026-09-27，PC 主会话）完成并在 main 上的

上一份交接 `HANDOFF-2026-09-27.md`（`93bdd24`）之后，main 的第一父链：

| main 提交 | 内容 |
|---|---|
| `8a5d6ff`、`f5e4c9e` | 计划：主会话移到 PC；0.4 节注明播报只在装了 task-announce 的机器上做 |
| `2958b7b`、`f126bf0`、`d2c66de`、`03945fa` | 维护：flaky-timing、V8 `diffProject` 性能余量、codex / agy 的 callId、AI 栏聊天记录窗口化（`REPORT-C6.6.md` 第 9 节） |
| `fa8adaa`、`dc28209`、`c1ac3ca` | 计划：主计划第 9 节端口；C10a 契约第 16 节、HT 契约第 16 节（开工后的裁定） |
| `9236d44`、`6484f1e` | **C6.6 合入**与阶段报告 `REPORT-C6.6.md` |
| `6be10d9`、`c42d52c`、`2e703da` | 维护：skill-gate 改显式开启（`npm test` 永不缺省连 5190）、G0 跳过数改 ≤ 2、坏端口在并行 `npm test` 下不误报 |
| `7d90218`、`19f1dec` | T9 修复两轮（探针场景「原尺寸还在路上」；换档那一轮不多 `load()`、探针黑帧看真实截图） |
| `a347b70`、`5dd7335`、`1dad2b7` | 测试在多份 `npm test` 并行时不互撞；**C6.6 真跨机 T9-X2、T9-X3 补记**（W-T9 全过）；三份维护报告归档 |
| `5cae8db`、`b7635ad` | C10 在线后台舞台可行性探针；**C10 契约第 1 版** `docs/plan/c10-contract.md`（发给用户，不等） |
| `4a82441` | **用户**：在线浏览器模式只加入、不新建、不存草稿（一级）；低内存档不测量（二级，认）；约束加「不原地改 store 里的项目对象」；机制补「人工钉死为重卡」 |
| `bb01107`、`7ff0ea8` | 维护：生成快照的整场景 id 改名线性化（输出逐字节不变，快照键随源码换一次）；C10 契约随用户新定的语义改 |
| `94fb419`…`bcb67a0` | 维护：Tailwind 扫描排除 `docs/` 等非源码范围（改文档不再让开发服务整页重载，用户常驻编辑器也不受打扰） |
| `9f1d4ba` | （用户或别的会话）`docs/auto_long_work/handoff.md` 补辅助节点的 goal 处理 |
| 本文所在的提交 | 本交接文件；`docs/reports/REPORT-C10a.draft.md`、`docs/reports/REPORT-HT-a.draft.md`（阶段报告草稿） |

- 每次合入后 release 都按 `git_and_release.md` 判过并快进；判 release 用的 `npm run build` 都成功。交接前 release = main。
- **基线**（PC，最近一次在 main 线上跑的）：`bcb67a0` 之前的 `bb01107`：类型检查 0；全量测试 3121 / 3119 / 0 / 跳过 2（跳过的两条是显式开启的 cards-layout 与 skill-gate）；`npm run build` 成功。Tailwind 分支 `94fb419` 另跑：3121 / 3119 / 0 / 2，导出 1800/1800 与基准相同。
- **G0-R 基准帧**：PC 上 `.worktrees/pc-main-g0r`（main `bc2652f` 的 1800 帧）一直有效：今天各次 G0-R 与它逐像素比都是 1800/1800 相同。笔记本没有这份基准，要做 G0-R 就先在 main 上跑一次 `verify-determinism` 取 `out/verify-a/frames` 当基准，再用附录 B 的脚本比。

## 2. 进行到一半

| 分支 | 最后提交（已推 origin） | 状态 |
|---|---|---|
| `claude/c10a-integ` | `5b2fccc` | **C10a 集成**。已合 `c10a-web`、`c10a-lowmem`、`c10a-tests`、`c10a-r2` 与 main `7ff0ea8`。本机验收全过：G0（3261 / 3259 / 0 / 2，桌面与在线构建都成功）、G0-R 七项全过（1800/1800 相同、透明拍数 0）、`c10a-demo-probe --local` 三轮全过（在 `c10a-r2` 上）。**阿里云现在跑的就是它**（第 6 节）。外网演示第 1 轮只挂第 2 步（见下一行）。还没合入 main |
| `claude/c10a-aliyun` | `6238595` | 外网演示第 1 轮暴露的三处 C10a 问题，**停在可提交处**（交接收口，报告 `AGENT-c10a-aliyun.md`）：①**已修**——演示第 1 步里预渲染进程先在没连共享配置时渲过第 0 帧与第 28～31 帧（只有原尺寸），重连后队列任务只补没渲过的帧，sink 的完成判据只看原尺寸，于是 5 个任务以 295/300 小尺寸「完成」；现在两档齐才算完成（`createAssetSink` 缺小尺寸回可重试的 incomplete、`scheduleMissingSmall` 补画，单测 ST10～ST13）；②**不是代码缺陷**——手机停在缺小尺寸的第 0 帧，选帧只在同一段里往回找，按兜底占位是对的，① 修掉就好（补单测 OS10 与低内存档缺口选帧）；③**已修**——时间轴波形（`loadWave`）与素材库缩略（`MediaThumb` / `MediaTile`）直接用 `media.url`，绕过两档选择；新增 `previewMediaUrl`（在线给远程地址、低内存档只给小尺寸、地址未就绪给空），单测 LMT9；没改的几处演示路径走不到（媒体菜单量视频尺寸、`SpeakerPicker`、卡片里用的素材与 `/pcm` 音频、`procp.ts` 打包保存），列在报告里。验证：tsc 0；npm test 3268 / 3266 / 0 / 2，新单测都真跑；`--local` R1（`bd2adaa`）327 s 全过（第 1 步 300 帧小尺寸 300、第 2 步 11.6 s 贴上小尺寸且 `/@media` 0、第 3 步两档都齐 300/300、导出 300 帧）。**没做**：第二轮 `--local`、G0-R、重新部署、对阿里云复跑（本机本来就是 300/300，① 的修复只有单测与外网一轮能证） |
| `claude/c10a-r2` | `8de80e1` | 已合进 `c10a-integ`（codex 失活路径审计 + Opus 复核；刷新后回到共享项目；地址未就绪不取 `/@media`） |
| `claude/ht-integ` | `38633a4` | **HT-a 集成**，本机验收全过：tsc 0；npm test 3353 / 3351 / 0 / 2，63 条 HT 全真跑；`ht*.test.mjs` 74/74；页面对真会话层验证；本机信任关闭下 T9 本机替身 `ok`、在线加入 44/44；渲染队列冒烟 PASS。本机判定已按语义改为「转发头每一跳都是回环才算本机」。等 C10a 先合入 main 再合一次 main；还没部署、没跑 HT7 与 W-HT-a |
| `claude/http-transport`、`claude/ht-client`、`claude/ht-tests` | `2a7337d`、`452f6ca`、`f73d3bf` | 已合进 `ht-integ` |
| `claude/c10-tests` | `0c4ca6d` | **C10 契约测试** 60 条（53 条按门跳过，等实现）。**不能单独合进 main**（跳过数会从 2 升到 55，违反 G0），随 C10 集成一起进。它提了 6 个待定点（deadMs 口径、回收 16～64 MiB 的读法、层表形状与版本号、「丢弃」后下载的交互、续签的形状、用户卡跳过快照放哪），见 `AGENT-c10-tests.md` |

- 已合入 main、worktree 还留着的分支：`bad-ports-concurrency`、`c10-contract`、`c10-probe`、`c66-integ`、`c66-t9-fix`、`c66-t9-verify`、`skill-gate-optin`、`snapshot-ids`、`tailwind-scan`、`test-parallel-safe`（都已推 origin）。
- **阶段报告草稿**：`docs/reports/REPORT-C10a.draft.md`、`docs/reports/REPORT-HT-a.draft.md`，合入时补完、去掉 `.draft`、归档对应的 AGENT 报告。草稿里的 scratchpad 路径指 PC 本机，只作记录。

## 3. 恢复后按顺序要做的事

顺序仍是主计划第 4 节的「C10a → HT-a → C10 其余 → M7 → M8」。

1. **C10a**：
   1. 收 `claude/c10a-aliyun`（第 2 节）：主会话审 diff（`93a0ed0` 改了队列 sink 的完成判据、`bd2adaa` 改了在线页面的素材地址），合进 `claude/c10a-integ`，再跑一轮 `--local`，重跑 G0 与 G0-R（改到 `src/render/mediaTier.ts` 与预渲染的 sink，G0-R 必跑）。
   2. 重新部署阿里云：在干净检出上 `vite build --mode online`，`PROMPTCUT_REMOTE=root@8.219.80.16 PROMPTCUT_REMOTE_KEY=<密钥路径> node scripts/remote/docservice.mjs deploy-hosted --save --editor <在线构建目录> --doc-public-url wss://8-219-80-16.sslip.io/hosted/ --asset-public-url https://8-219-80-16.sslip.io/media/api/asset`；先备份 pm2 配置。部署脚本的「回环 healthz」偶尔在进程监听前就查，外网 `/hosted/healthz` 再核一次即可。
   3. 对阿里云跑 `node scripts/probes/c10a-demo-probe.mjs --port <你的端口> --out <仓库外目录>`（站点缺省阿里云）。要核三件：第 1 步 `small === 300` 且没有 `missingSmall`；第 2 步手机贴上小尺寸、`relMedia 0`（没有 `/@media` 与原尺寸请求）；若第 1 步仍缺小尺寸，节点日志里要有 `sink.small-incomplete`、任务重试而不是 `done`。**跑的期间不要改那个工作区里的文件**（Tailwind 的整页重载 main 已修，`c10a-integ` 合 main 之后才有）。
   4. 合入 main；把草稿补成 `REPORT-C10a.md`，归档 `AGENT-c10a-*`（web、lowmem、tests、integ、r2、aliyun）与同期维护报告（`AGENT-snapshot-ids`、`AGENT-tailwind-scan`）；播报。
   5. 待用户项：真手机扫码（第 5 节）。
2. **HT-a**：`ht-integ` 合 main（C10a 之后）→ G0 → 从 `ht-integ` 部署（部署脚本这时会写 `PROMPTCUT_TRUST_LOOPBACK=0`，服务器上要有集群令牌，缺了部署脚本以 5 退出）→ HT7：`node scripts/probes/ht7-probe.mjs --base https://8-219-80-16.sslip.io/hosted` → 信任关闭下再对阿里云跑一次 C10a 演示探针 → 合入 → W-HT-a（笔记本第二渲染主机实例持有任务时断一次传输，断言会话接续、租约不丢、任务完成）→ 草稿补成 `REPORT-HT-a.md`。契约第 12 节建议 nginx `/hosted` 补 `client_max_body_size 2m; proxy_buffering off;`（HT-b 才用得上，可一并加）。
3. **C10 其余**：契约 `docs/plan/c10-contract.md`（第 1 版 + 用户 2026-09-27 定的语义），任务书在附录 A。等 C10a、HT-a 都合入后从 main 拉 `c10-browser`、`c10-ui`；`c10-tests` 已写好（合并时把 main 合进去、kit 对账）。部署时主会话在阿里云加 `s1.8-219-80-16.sslip.io`、`s2.8-219-80-16.sslip.io` 两个子域（certbot 扩展证书，免费；nginx 给两个子域提供 `/editor` 舞台页与 `/media` 反代，编辑器页与舞台页都带 `Origin-Agent-Cluster: ?1`）。
4. **M7**：主计划第 7 节 M7（已并入 L1 的两条验收；生成快照 id 改名的维护项已做完，`bb01107`）。
5. **M8**：照主计划第 7 节。

## 4. 要在 M8 之内修的已知遗留

- `REPORT-C6.6.md` 第 11 节各条（撤销后时间轴不刷新、旧词「原片 / 小版」、确定判重的探针卡、主机把用户卡写进检出目录、`create_card` 带 overwrite 被改动层旧版盖住、`vite-plugin-frames.ts` 里断掉的 `AGENT-c6-4-pipeline.md` 引用）。
- 缺省连 5190～5192 的手动脚本：`scripts/io-check.mjs`、`scripts/timeline-verify.mjs`、`scripts/catalog-notes.mjs` 等（`AGENT-skill-gate-optin.md`）。
- 几个测试起 Vite 用了缺省固定 HMR 端口 24678，全量测试每次打出约 17 行「端口被占」，从没让用例失败（`AGENT-test-parallel-safe.md`）。
- 页面侧 `src/render/cardSourceVersion.mjs` 拼卡片源码不统一换行：CRLF 检出（Windows）与 LF 检出算出的成本身份键不同；同一提交在两个工作区做在线构建，9 个分块哈希不同就是它（服务端的代码版本 C6.6 已统一换行）。M7 之前评估。
- `c10a-demo-probe` 两处小毛病：第 3 步「整段重渲完成」只要求每段有清单、不要求帧齐（三轮那一刻都是 244/300 帧）；页面导航计数把清掉 `#invite` 这类同页跳转也算一次（`AGENT-c10a-r2.md`）。
- Tailwind 扫描：以后在 `src/` 或 `server/` 下新增 `.md` / `.json` 以外的非代码文件（`.txt`、`.yaml` 等）仍会触发整页重载，要在 `src/index.css` 的排除表里补一行（`AGENT-tailwind-scan.md`）。
- 生成快照剩下的代价在样式内联：1400 个元素约 0.8 s（`AGENT-snapshot-ids.md`），M7 逐帧生成快照前看一眼。
- HT-b 的后续项记在 `docs/plan/TODO.md` HT-b 条目下（`card-sync.mjs` 等没接会话层的旧客户端等）。
- 在线页面仍直接用 `media.url` 的几处（演示路径走不到）：媒体菜单量视频尺寸、`SpeakerPicker`、卡片里用的素材与 `/pcm` 音频、`procp.ts` 打包保存（`AGENT-c10a-aliyun.md`）；C10 其余里改走 `previewMediaUrl`。

## 5. 跨机、信箱与指令

- **信箱**（`https://8-219-80-16.sslip.io/coord`，2026-09-27T10:5x 只读核对）：
  - `to-cloud` 最后一条是 seq 8（【W-开工-2】主会话换到 PC、请报到并复测经代理连 `/hosted/`，2026-09-26T23:15:59Z），**没有回执**；
  - `to-local` 已处理到 seq 6，之后没有新消息，下一条从 seq 7 起读。PC 的后台等待已在交接时停掉。
- **已发未回执的指令**：云端 W-开工-2（seq 8）。笔记本辅助节点：L-1（局域网 TCP 双向可达）、V-1（V8 复核）、T9-X1、T9-X2、T9-X3 都已回执；最后告诉它「待命，下一条会是 HT-a 部署后的 W-HT-a，发之前先列内容」，W-HT-a 还没发。
- **笔记本辅助节点**：从 PC 看的跨机句柄 `bridge:session_01PV3KgnNLRBDsBVpFRpKvfB`；它用 `.worktrees/lt-<指令编号>` 的约定、端口 5560～5579、`C:\program files\nodejs\node.exe`；没有 task-announce。
- **待跨机复核**：
  - C6.6：云端当独立渲染主机那一遍（兼作原 HT9 的硬验收）——云端不在线，登记不等；放本机版 T9（PC 窗口项，不挡合入）。
  - HT-a：W-HT-a（第 3 节第 2 步）。
  - C10a：W-C10a 可选的无头手机视口预检，已由演示探针的手机仿真覆盖。
- **待用户项**：
  - C10a 部署后的真手机扫码：iPhone 相机、微信各一次（C10a 契约第 12 节）；iOS 逐帧导出的最长时长与体积。
  - 笔记本回收站里的凭证压缩包 `promptcut-laptop-credentials.zip`，可选清空。
  - agy 配置里 145 条常驻 MCP 放行规则（91 条 `mcp(promptcut/*)`、54 条 `mcp(winauto/*)`）是否保留。
  - 审〔裁〕（发给用户、不等）：C10 契约（L1 并入 M7、子域 + OAC、配额数字）；HT 契约第 17 节（含「本机按真正的发起方判断」）；C10a 的「刷新后回到刷新前打开的共享项目」（建议补一级语义，并审「派生的 K 按标签页放 `sessionStorage`」能否接受）；生成快照改名后快照键换一次；Tailwind 排除后 CSS 少 266 字节（删的规则只出现在测试、探针、文档里）。
  - 修 skill-gate 之前，你若在 5190 开着编辑器、恰逢子 Agent 跑全量测试，测试会关掉并重开编辑器的 SKILL 模式（已修，`6be10d9`）。

## 6. 阿里云 `8.219.80.16` 现状（2026-09-27T10:5x 只读核对）

- **pm2**：`promptcut-hosted` 跑 `claude/c10a-integ` 的 `5b2fccc`（2026-09-27T10:26:16Z 部署，含 `/editor` 在线构建；**没设 `PROMPTCUT_TRUST_LOOPBACK`，缺省 1**，靠 nginx 的 `proxy_bind 172.19.0.47` 让上游看到的不是回环），重启 6 次；`probe-coord`；`promptcut-drill`（8777 / 8778，HT 第 1 版，没动）；`pm2-logrotate`。
- **pm2 配置备份**：`pm2.config.cjs.bak-20260926`、`.bak-20260927-c66`、`.bak-20260927-c10a`、`.bak-20260927-c10a2`。两个公网地址由部署参数写对，不用再手改。
- **nginx**：`/coord` → `127.0.0.1:8799`；`/hosted` 是前缀 `location /hosted` 加 `rewrite ^/hosted/?(.*)$ /$1`（带不带末尾斜杠都行）→ `172.19.0.47:8787`；`/media` → `172.19.0.47:8788`（`client_max_body_size 2g`）；`/editor` 四段（`= /editor` 与 `= /editor/index.html` 回 index.html 带 `no-store`，`^~ /editor/assets/` 带 `immutable`，`/editor/` 回落 index.html；都带 `no-referrer`、`nosniff`）。备份 `/etc/nginx/sites-available/promptcut.bak-20260927-c10a`。`nginx -t` 通过。
- **UFW**：22、80、443、8787、8788。
- **证书**：certbot 管 `8-219-80-16.sslip.io`（80 与 443 在监听），C10 要加两个舞台子域时照此扩展。
- **核对**：外网 `/hosted/healthz`、`/media/healthz` 200；`/editor` 的 index.html 与部署产物 sha256 相同；匿名 WebSocket 升级 401（C10a 第一次部署时核过）。
- **资源**：磁盘 4.3G / 40G（12%），内存用 629 / 1613 MB、可用 983 MB，负载约 0.3。
- **云端测试项目**：T9 与演示探针建的项目收尾都删了（`lookup` 404）。

## 7. 顾问调用记录（归入各阶段报告）

| 阶段 | 用途 | 问题 | 结论 | 采纳 |
|---|---|---|---|---|
| C6.6 | 见 `REPORT-C6.6.md` 第 8 节 | — | — | — |
| C10a | 攻坚（codex worktree，`gpt-6-sol` / `high`） | 演示 R2：手机层表 900 s 不更新、相对地址取素材 404 | thread `01a0e1d3-f195-7782-8599-66011ae576d7`，两次各跑满 1800 s 时限；失活路径审计与多处修复，主会话提交为 WIP `050065d`，交 `opus-dev-high` 复核做完（`claude/c10a-r2`） | 采纳（复核后改了三处会让桌面退化的地方） |
| C10 / M7 | 查资料（codex，只读联网） | Q1 IndexedDB 配额；Q2 明文 http 页面缺的 API；Q3 媒体鉴权；Q4 后台 iframe 节流；Q5 WebSocket 子协议凭证 | `docs/plan/c10-research.md`；thread `01a0e00f-840a-72f3-a7f5-4b55c61ad929` | 契约第 17 节；Q1 第 5 条被探针推翻 |
| C10 | 交互与文案（Gemini，`gemini-3.1-pro-high`） | 离线提示、素材导入、后台预渲染可见性、放本机从浏览器进入、新建与草稿、含用户卡的项目 | `docs/plan/c10-ux-draft.md`（第 4 版） | 核对后采纳，契约第 17 节表 A |
| C10 | 可行性探针（`opus-dev`） | 子域 + OAC 隔离、后台节拍、IndexedDB、舞台读素材 | `scripts/probes/c10-stage-probe.mjs`、`AGENT-c10-probe.md` | 契约第 2、4、15 节 |

## 8. 环境现状

- **PC**：主检出在 main，干净；worktree 见第 2 节，分支都已推到 origin；`.worktrees/merge-test`（分离头，`5b2fccc`，外网演示的创建者从这里起）与 `.worktrees/pc-main-g0r`（G0-R 基准帧）留着，别删。
- **PC 主会话**：交接后待命，直到用户明确说恢复。它起过的后台进程（信箱等待、分支监视）都已停。

## 附录 A：C10 其余三个分支的任务书（未派）

公共部分（三份都带）：先读 `docs/semantics/developer_guide.md` 及它索引的 `guide_files/` 全部（子 Agent 协议在 `multi_agent.md`），再读契约 `docs/plan/c10-contract.md`、`docs/plan/c10a-contract.md` 与契约「依据」里的语义各节；与语义冲突时以语义为准。工作区 `git worktree add .worktrees/<短名> -b claude/<分支> main`；只用给的端口段；不碰 5190～5192、5203～5205 与用户常驻编辑器、桌面版运行时副本、用户数据目录；令牌不打印、不进提交；先建报告 `docs/reports/AGENT-<分支>.md`；收尾 tsc 0、npm test 0 失败、跳过 ≤ 2，报告写提交、证据、偏离、待定。

- **`claude/c10-browser`（`opus-dev-high`，5420～5429）**：契约第 2～7、12 节——普通档两个舞台（运行配置给舞台源，`deploy-hosted` 加 `--stage-origins`；三方 OAC；读不到或握手失败退回同源单舞台；低内存档仍单舞台；舞台用相对地址读自己源上反代的 `/media`；大块产出压缩成可转移 `ArrayBuffer`；后台舞台 `opacity: 0` 原位叠放、父页判空闲经 RPC 发开始 / 停止、舞台里 `setTimeout(0)` 逐帧、页面隐藏就停、父页 rAF 间隔持续 > 500 ms 暂停后台活；`hostCapabilities` 照实报）；测量（加载遮罩下测完、新卡在后台舞台测、`costs` 以 `mode=build` 进 L2）；L2（三张表 `costs`、`snapshots`、`ranges`，写入即就绪，256 / 64 MiB 软上限、自有 LRU、一个事务回收 16～64 MiB 再试一次、接 `error` 与 `abort`、不依赖 `persist()`；低内存档换掉 C10a 的内存 LRU、只存小尺寸）；L3（普通档按层表与清单取预渲染原尺寸进 L2、层表补共享档内容键与产出环境指纹、一层只取一种环境、预取前后 2 秒）；L4 与 K5（按拍换快照、在线播放不受 33 ms 节流、`swapMs` 进预算、装不下占位、暂停在后台舞台渲到精确活渲再互换）；页面发布 `plan`；逐帧导出续签票据。验证：G0 + G0-R 全套；本机真浏览器验收 C10-A1～A5、A9、A10（本机托管组合 + 仿 nginx 前缀代理 + 两个跨源舞台端口 + OAC；A5 用独立渲染主机的本机替身）。
- **`claude/c10-ui`（`opus-dev`，5700～5709）**：契约第 9、10、11、19 节——用户卡与图卡（预览图标、不贴别人快照、时间轴小徽标 +「该模式暂不支持自定义卡」、片段照常可编辑）；置灰（表 A 文案、点了不发请求、`/api` 棘轮只减不增）；离线（顶栏措辞按表 A、HT-a 接续期间不闪、离线且有未提交时常驻提示 + `beforeunload`）；本地备份不写进浏览器存储，「丢弃」或被覆盖时当场给「下载备份」（JSON）；素材服务 `POST merge/<projectId>/<共享键>` 回 501；计划文档勘误。验证：G0；C10-A6、A7、A8 的截图与网络记录；低内存档回归。
- **`claude/c10-tests`**：已做（第 2 节）。

## 附录 B：像素基线比较脚本

G0-R「导出像素与 main 基准逐帧相同」用。放在仓库外（例如 scratchpad）运行，`pngjs` 从仓库的 `node_modules` 取；用法 `node compare-frames.mjs <基准 frames 目录> <待比 frames 目录>`，输出一行 JSON，0 不同、0 缺失、0 多出才退出 0。

```js
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [baseDir, candDir] = process.argv.slice(2);
const require = createRequire(path.join('<仓库根>', 'package.json'));
const { PNG } = require('pngjs');

const list = (d) => fs.readdirSync(d).filter((f) => f.endsWith('.png')).sort();
const a = list(baseDir);
const b = new Set(list(candDir));
let identical = 0, different = 0, missing = 0;
let worst = null;
const diffs = [];
for (const f of a) {
  if (!b.has(f)) { missing++; continue; }
  b.delete(f);
  const pa = PNG.sync.read(fs.readFileSync(path.join(baseDir, f)));
  const pb = PNG.sync.read(fs.readFileSync(path.join(candDir, f)));
  if (pa.width !== pb.width || pa.height !== pb.height) { different++; diffs.push(f); continue; }
  let n = 0;
  const da = pa.data, db = pb.data;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) { n++; i |= 3; }
  if (n === 0) identical++;
  else { different++; diffs.push(f); if (!worst || n > worst.pixels) worst = { frame: f, pixels: n }; }
}
console.log(JSON.stringify({ base: baseDir, cand: candDir, total: a.length, identical, different, missing, extra: b.size, worst, firstDiffs: diffs.slice(0, 10) }));
process.exit(different === 0 && missing === 0 && b.size === 0 ? 0 : 1);
```

## 附录 C：T9 本机替身

临时托管组合（只绑回环）+ 临时协调口 + `c66-t9-probe.mjs --role all`。HT-a 合入后信任开关的变量名是 `PROMPTCUT_TRUST_LOOPBACK=0`，并要现场生成集群令牌（`PROMPTCUT_CLUSTER_TOKEN`）；合入前的旧名是 `PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1`。端口按主计划第 9 节挑，协调口令牌现场生成、不打印。

```bash
WT="$1"; OUT="$2"; mkdir -p "$OUT"; DATA=$(mktemp -d)
export PROBE_MAIL_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
cd "$WT"
PROMPTCUT_DATA_DIR="$DATA" PROMPTCUT_DOCSERVICE_HOST=127.0.0.1 PROMPTCUT_DOCSERVICE_PORT=8794 PROMPTCUT_ASSET_PORT=8795 \
  PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1 node server/hosted/main.mjs > "$OUT/hosted.log" 2>&1 &
HOSTED_PID=$!
node scripts/probes/probe-coord.mjs serve --port 8796 > "$OUT/coord.log" 2>&1 &
COORD_PID=$!
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8794/healthz >/dev/null 2>&1 && curl -fsS http://127.0.0.1:8795/healthz >/dev/null 2>&1 && break; sleep 1; done
node scripts/probes/c66-t9-probe.mjs --role all --hosted http://127.0.0.1:8794 --coord http://127.0.0.1:8796 --out "$OUT/roles" > "$OUT/probe.stdout" 2> "$OUT/probe.stderr"
CODE=$?
kill $HOSTED_PID $COORD_PID 2>/dev/null; rm -rf "$DATA"; tail -n 3 "$OUT/probe.stdout"; exit $CODE
```
