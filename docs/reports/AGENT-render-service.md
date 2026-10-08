# 子 Agent 报告：云节点渲染服务常驻（第三段）

分支 `claude/render-service`，worktree `.worktrees/render-service`，起点 `e7d18340`。任务书 `docs/plan/sound-online-render-task.md` 的 D（托管方的渲染身份）与第 20～24 条。

## 第一轮：设计与契约（2026-10-06）

状态：设计稿已写完，等主会话审。这一轮没有改代码、没有起进程、没有连任何远端机器，语义文档也没改。

### 做了什么

- 读了规则六份、任务书、`draft_cloud-node-and-agent.md` 步骤 2、`render-host-contract.md`、`auth-contract.md`、`m7-contract.md` 第 3、5、6 节、`hosting-migration.md`、`TODO.md` 容量一条，语义 `product/hosting.md`、`product/platforms.md`、`product/document-service.md`、`mechanism/hosting.md`、`mechanism/document-service.md`「渲染任务队列」、`workflow/project.md`、`architecture.md`。
- 读了代码：`scripts/render-host.mjs`、`server/hosted/`（`main.mjs`、`combo.mjs`、`deploy.mjs`、`files.mjs`、`deploy/`）、`server/auth/`（握手、票据、凭证存储、协议、来源判断、共享配置、票据源、素材票据）、`server/docservice/`（`shared-service.mjs`、`spaces.mjs`、`modules/shared.mjs`，以及项目、内容、队列模块里按角色把关的地方）、`server/render-node/`（`host.mjs`、`filter.mjs`、`fingerprint.mjs`）、`server/vite-plugin-frames.ts` 的 `startHostNode`、`server/bakery/chrome.mjs` 的启动参数、`scripts/remote/docservice.mjs` 文件头。
- 联网查了 PM2 的进程声明与内存上限、Puppeteer 的沙箱与 Linux 运行库、systemd 的资源控制，依据附在契约末尾。
- 写成 `docs/plan/hosted-render-contract.md`：第 0 节是请主会话先定的三件事，第 1～11 节对应任务给的 11 项，末尾「依据」。

### 验证结果

这一轮没有代码改动，没有跑基线（类型检查、全量测试都没跑）。契约里凡是没有实测依据的点都标了「待实现时验证」。

### 查代码时发现、契约里已经处理的问题

1. `auth.ticket` 允许一条 render 连接给同一个 `userId` 签 `page` 角色的连接票据。对成员无害；托管方的服务身份不拦这条就能自己换成能改项目的连接。契约第 1.5 节用白名单拦。
2. `content.put`、`project.announce`、`project.upload`、`project.snapshot.put` 对 render 角色没有限制；`content.put` 能写 `card-source`（卡片源码属于项目内容）。同样由白名单拦。
3. `spaceOf` 只把管理身份排除在空间外，别的没有 `tenantId` 的身份会落进 `local` 空间。新的控制身份要显式排除（第 1.3 节）。
4. 素材票据的 `rw` 能写素材原件、能删块。服务身份的票据限到只写两个产物命名空间、不能删（第 1.6 节）。
5. `deviceId` 由客户端自报，成员能拼出与服务相同的 `userId`。契约保留 `service:` 开头的用户名（第 1.4 节）。
6. 独立渲染主机把各项目的用户卡装进同一个检出目录，预渲染页面与工作进程的本机接口同源。托管端任何人都能建项目，等于替任意来源执行代码，有跨项目读内容的口子（第 0 节第 1 条、第 7.5 节）。
7. 现有节点报的能力都是 `graphCards: false`，没有任务要求图卡能力（第 0 节第 3 条）。
8. 渲染服务按自己的检出算代码版本，与在线页面不是同一个提交时一个任务都认领不了，也不报错（第 5、7.4 节）。
9. 托管端的渲染服务不认领桌面版发的普通计划任务（现有规则），所以只有桌面成员的项目里它基本没活。这不是缺陷，但验收时别拿桌面发的任务去验它（第 5 节）。

### 没做成的及原因

- 没有实测任何一条：这一轮按要求不改代码、不起进程。
- 新节点的磁盘大小、PM2 版本、是否 cgroup v2 没查：这一轮不连远端。容量上限的数字（20 GiB 或磁盘的四分之一）是占位，待主会话按实际改。

### 对任务书或语义的更正建议

- 任务书第 23 条「含用户卡、图卡的任务它能渲」：建议拆成用户卡、图卡两项分别验；图卡取决于第二段给图卡任务定的能力位。
- `workflow/project.md` 与 `product/document-service.md` 的「创建者特权只有三项」与 D 的开关不一致，契约第 9.3 节给了建议稿，要主会话确认是否在 D 的授权内。
- `render-host-contract.md` 第 7 节「限制」（多项目共用一个改动层）在托管端不再只是「不会渲错」的限制，而是隔离问题；实现阶段在那一节补一句指向本契约第 7.5 节。
- `TODO.md`「托管端与远程素材服务的产物容量」：本段只管渲染服务自己写的块，成员写的块仍然没有上限，那一条不能删，改成写明剩下的范围。

## 第二轮：第 1 批实现（2026-10-06）

主会话审过契约后按它开工；中途两次追加裁定（任务书加「用户体验验收」；第四段契约对通用骨架的要求），都并入了这一批与契约。

### 做了什么

- 契约按裁定更新：第 0 节裁定表、`actsFor`、`active` 新判据与 `hosted.demand`、`hosted` 开关统一形状、「创建者特权四项」的逐字稿、无 systemd 降级、代码版本告警、新增第 5a 节「没有成员在线时的预渲染」（含 R1～R9 的对应与 R9 的估计）、文末「实现记录」。
- 代码（第 1 批：服务身份、目录、白名单、开关的服务端）：
  - 新增 `server/auth/service-identity.mjs`、`server/docservice/modules/hosted.mjs`、`server/docservice/service-gate.mjs`、`server/hosted-render/keygen.mjs`；
  - 改 `server/auth/`（`protocol`、`handshake`、`http`、`tickets`、`store`、`asset-tickets`）、`server/docservice/`（`shared-service`、`spaces`、`router`、`service`、`modules/shared`、`modules/render-queue`）、`server/asset-service.ts`、`server/hosted/combo.mjs`；
  - 测试 `server/test/hosted-render-kit.mjs`、`hosted-render-identity.test.mjs`、`hosted-render-access.test.mjs`、`hosted-render-actsfor.test.mjs`。
- 没有改语义文档（放到最后一批），没有起浏览器，没有连任何远端。

### 验证结果

- `npx tsc -b --force`：退出码 0。
- `npm test`（全量）：退出码 0。首轮根汇总 tests 4446 / pass 4444 / fail 1 / skipped 1，失败的是 `server\test\media-pull.test.mjs` 整个文件进程异常退出（exitCode=1、已报用例 0、stderr 0 行，测试脚本按 nodejs/node#65756 那一类处理），脚本单独重跑它 11 项全过，最终「零失败（1 个异常退出文件重跑通过）」。合起来 4456 项、4455 通过、1 跳过，比合流基线（4432 项）多的 24 项就是本批新增的。之后把 `media-pull.test.mjs` 单独又跑了 3 次，每次 11 项全过。
- 第一次全量跑卡在 `codex-auth-state.test.mjs`（主会话提过的已知偶发卡死）：日志 14 分钟没有新输出，只结束了本轮测试起的进程树后重跑，上面是重跑的结果。
- 新增的 24 个用例（HR1～HR15，其中 HR1、HR2、HR5、HR7、HR8、HR11、HR15 各有两到三个用例）全过。

### 没做成的及原因

- 白名单清单还没在整套演练里对过实际流量（第 2 批接上代理模式后对）。
- 第 5a 节 R3～R5 的单测、「有成员在线的项目优先」、代码版本告警、无 systemd 降级都在后面的批次。
- 第 5a 节 R4 里「细任务的订阅者含切分方，所以不随 Agent 的发布连接断开而丢」是读契约得出的，没有核对代码，标了待第 2 批核对。

### 对任务书或语义的更正建议

- 第四段「保持到入库最多 30 分钟」对 200 个片段的计划不够（契约第 5a 节 R9：一般约 70 分钟，最坏约 8 小时，都是估算）。建议改成按「多久没有进度」判，或把每个计划的片段上限降到 20 上下。
- `auth-contract.md` 第 8 节写素材服务的写入含 `remove`，实际 HTTP 接口没有删除路由，实现阶段更新那份契约时顺手改掉。
