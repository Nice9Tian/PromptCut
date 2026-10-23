# AGENT 报告：claude/guest-fix

任务：修掉游客身份（`claude/guest-identity`，main `1d85c979`）安全审查实测出来的挡发版漏洞 A1、A2、B、C，该修的体验问题 D，并查审查没验的 S2、S3、S9、E。
审查全文在会话 scratchpad 的 `REVIEW-guest-identity.md`（不在仓库里），下面用它的编号：A1/A2 是视频条数能绕过，B 是游客隔天换人，C 是三天清理不回收字节、项目号能被别人占，D 是第 4 条视频被拒后上传队列堵住，S2/S3/S9/E 是审查列的疑点。

分支 `claude/guest-fix`（从 main `1d85c979` 切出），worktree `.worktrees/guest-fix`。没推送，没合并。

## 结论

五条必修都修了，每条都先用审查的探针复现了漏洞，改后有回归测试挡住。查的四条疑点都成立，也一并修了。受影响的测试满载跑了一遍全绿，类型检查零错误。**可以合进 main**；合之前请审下面的〔裁〕，二级的两条单列在「二级〔裁〕」一节。

## 逐条做了什么

### A1 改档位就绕过视频条数

- 原因：`guest-quota.mjs` 只数原尺寸档，档位是页面报的（`X-Media-Tier`）。
- 改法〔裁·三级〕：数一个项目里**不同的视频源**，按「原尺寸档几个、小档几个，取多的那个」数（`videoSourcesOf`）。在线编辑器一条视频传一个原件和一个小档，所以正常用法下这个数就是视频条数；全报小档，小档就有那么多个，照样数到。档位仍是页面说的，最多只能靠「3 个报原件、3 个报小档」多放进 3 个文件：最坏 6 个文件、每个不超过 100 MB，有上限。原先是无限。
- 副作用：第 4 条视频现在**在小档那一片就被拒**（原先小档照收、原件才拒）。改了 `guest-asset-quota.test.mjs` 里按旧行为写的 4 处断言。

### A2 改扩展名也绕过

- 原因：是不是视频按页面报的扩展名（`X-Media-Ext`、整件上传的文件名）判。
- 改法〔裁·三级〕：新文件 `server/asset-store/media-sniff.mjs`，按文件头字节认类型：
  - 认的格式：视频 mp4/mov/m4v（`ftyp`）、WebM/Matroska、AVI、MPEG-TS/PS、FLV、ASF、Ogg Theora；图片 PNG/JPEG/GIF/WebP/BMP/AVIF/SVG；音频 MP3/AAC/WAV/Ogg/FLAC/M4A。
  - **认不出的按视频算**（失败闭合）。只有开头是一段文本的不算视频，因为能播放的视频容器开头一定是二进制。页面报的扩展名是视频的，一律算视频。
- 闸门：
  - **收尾**：先按登记的扩展名和档位数一遍，超了就不收尾，暂存留着。放行入库之后，再按这一条自己的文件头、连同已入库的重数一遍，超了就把刚入库的这一条删掉、回 403 `guest-video-limit`。已入库的文件按哈希记住文件头结论。
  - **整件上传**：报的扩展名不是视频时，先从请求体里读出开头 64 字节认（`asset-service.ts` 的 `peekBody`），读完原样塞回去。

### B 游客第二天回来就换了一个人

- 服务端〔裁·三级〕：`authority.mjs` 的 `issueGuest` 遇到签名对得上、过期不超过 `GUEST_LIMITS.renewGraceMs`（3 天，新加，和游客项目寿命一样长）、没被作废的令牌，续成同一个编号。按「过期之后 3 天」算，不按「第一次领之后 3 天」算：天天来的游客一直是同一个人；超过 3 天没来，他建的项目也早清掉了，这时才换新身份。
- 页面：`client.ts` 的 `guestSession` 每次领到令牌都 `adoptGuestSession` 写回本机。原先续期只在内存里。
- mechanism 原先写「交一张过期的就随机一个新身份」，和 product「下次进来还是同一个人」相反。已按 product 改 mechanism。

### C 三天清理不回收素材字节、项目号能被别人占

- 素材字节〔裁·三级〕：新文件 `server/asset-store/project-reaper.mjs`，作为素材服务访问事件消费者的参与者，接在 `server/hosted/asset-runtime.mjs`。收到 `project-access-changed`、`reason: 'delete'` 的事件后：
  1. 先把项目号记进待删清单 `project-reaper.json`（落盘）；
  2. 当场调 `removeProject(id, { recreatable: true })`，删整个项目库目录；
  3. **删完才回执**。素材服务每次读写核权前都先追齐访问事件，所以删除之后的写入一定排在删干净之后；
  4. 当场试 3 次都删不成，也照样回执（不卡住别的项目的撤权）。这时这个号在本进程里一直按 `project-gone` 拒，后台按 1 秒、10 秒、1 分钟、10 分钟退避接着删，删成才放开；
  5. 起服务时先把清单里没删完的删完。
- 配套改了 `project-stores.mjs` 的 `removeProject`：
  - 加 `recreatable` 选项：删干净后撤掉「已删除」标记，同一个号以后能再建一个**空**库。缺省行为不变，原有测试守着。
  - 先标删除、再删目录：删失败时这个号一直是 `project-gone`。
  - 上一次删到一半的能再删一次。
- 部署：素材子进程的部署清单 `server/hosted/files.mjs` 补上 `media-sniff.mjs`、`project-reaper.mjs`。不补的话，独立部署的素材子进程起不来。这是 `account-move.test.mjs` 跑红才发现的。
- 项目号〔裁·三级〕：`createProject` 遇到已删除的项目号，**只有原创建者能再用**，别人回 409 `project-id-taken`。原想一律不许重用，但 `account-move.test.mjs` 第 10 条守着一级语义（`workflow/project.md`「本地项目搬到云端搬上去还是同一个项目」）：账号「放弃这次搬迁」删掉云端半成品之后再搬，还是原来的项目号。所以留了原创建者这一个口子。旧字节在那之前已经由素材服务删掉。
- 账号项目被创建者删掉时，字节也一样删（机制相同）。项目删了就再也进不去，留着字节只是占盘。

### D 第 4 条视频被拒后上传队列整条堵住

- 改法〔裁·二级，用户看得见〕：
  - `mediaUploadQueue.ts` 遇到 403 且错误是 `PERMANENT_REFUSALS`（`guest-video-limit`、`guest-file-too-large`、`guest-read-only`）中的一种时，这一项整项出队、记成被拒，不进退避，后面的照常传，并调 `onRejected`。别的 403（票据之类）仍照旧退避。
  - 新文件 `src/editor/left/uploadRejectedNotice.ts`：订阅被拒事件，在素材库分区的底部提示条（停 8 秒）和手机版编辑页的 toast 里说一句「『four.mp4』没有传上云端：游客最多上传 3 条视频。要传更多，请注册一个账号。」。文案照 `accountErrorText`，原先这句在上传路径上没人用。
- `mediaUploadQueue-guest.test.mjs` 原先把「第 4 项留在队里等退避」当成正确行为守着，已改成：被拒的整项出队，排在后面的图片传上去。

## 顺带查的四条

| # | 结论 | 怎么处理 |
|---|---|---|
| S2 `gateWholeMediaWrite` 失败时放开 | **成立**。变异实测：把 catch 改回 `next()`，核权第一次回 503 的那次整件上传回 200，第 4 条视频进库（`S2 {"status":200,...}`） | 改成照错误回（503 `authority-unavailable`），不往下放 |
| S3 `/api/media/adopt` 挂暂存 | **按成立处理**。路径上 adopt 只查「在媒体目录里」，分片暂存 `.chunks/<哈希>/data` 就在媒体目录里，挂进库时不经收尾的计数。变异实测时那个 adopt 请求挂住不回（没深究是哪一层卡住），所以没拿到「挂进去了」的直接证据 | 游客一律不能 adopt（回 403 `guest-adopt-forbidden`）：这条路给素材收集用，游客用不到。账号的 adopt 没动 |
| S9 登录后游客身份只在页面作废 | **成立**（读代码：服务端没有任何作废入口，令牌一直能续） | 同一条公开路由带 `revoke: true` 就作废：编号记进 `revokedLogins`，之后核不过、续不了。页面在 `login()` 和「我有账号，去登录」（`leaveGuest`）时发，发不出去也不拦着登录 |
| E 续期也算进每 IP 每小时 20 次 | **成立**（读代码：`take` 在读请求体之前） | 只有要发**新**身份时才数（`issueGuest` 的 `admitNew`）。拿不出能续的旧令牌的，照样数 |

## 回归证据

改前，审查的三个探针改成指向本 worktree，在没改的代码上跑（`scratchpad/gfix/before.log`，exit 0，6/6 通过；这些探针断言的是「漏洞存在」）：

```
PROBE-1 [[200,200],[200,200],[200,200],[200,200],[200,200]] stored mp4/small,mp4/small,mp4/small,mp4/small,mp4/small
PROBE-2 [[200,200],[200,200],[200,200],[200,200],[200,200]] stored jpg/original,jpg/original,jpg/original,jpg/original,jpg/original
PROBE-0 [[200,200],[200,200],[200,200],[403,404]]
PROBE-3 done 3 failures 1 items ["v-4","img"] imageStored false retryMsg ["PUT 第 0 片回 403"]
PROBE-5 same id? false renewed false
PROBE-5 back on own project {"status":403,"code":"not-listed"}
PROBE-4 reuse result {"projectId":"sp_…","authorityId":"reuse-doc","contentId":"c","accessRevision":3}
PROBE-4 B on pid {"access":"rw","creator":true}
PROBE-4 A bytes still there for pid {"size":58,"ext":"mp4"}
```

改后，进了仓库的回归测试（断言「挡住了」）输出的关键行：

```
A1 [[200,200],[200,200],[200,200],[403,null],[403,null]]                       ← 全报小档：第 4 条起 403
A1 mixed [200,200,200,200,200,200,403,403]                                     ← 3 原件 + 3 小档后拦
A2 [[200,200,null],[200,200,null],[200,200,null],[200,403,"guest-video-limit"],[200,403,"guest-video-limit"]]  ← 报成 jpg 的 mp4，第 4 条收尾 403、已删
A2 whole [[200,null],[200,null],[200,null],[403,"guest-video-limit"]]          ← 整件上传起名 .jpg
S2 {"status":503,"error":"authority-unavailable","hash":null}
S3 403 guest-adopt-forbidden
C reuse {"status":409,"code":"project-id-taken"}                               ← PROBE-4 反过来
C reaped {"dirAExists":false,"pending":[],"logs":["asset.project-reaped"]}
D {"done":4,"failures":1,"rejected":1,"items":[],"codes":["guest-video-limit"]} ← PROBE-3 反过来：图片传上去了
```

B 的回归在 `account-guest-authority.test.mjs`「游客隔天回来……」：25 小时后续成同一个编号，自己的项目 `rw`、`creator: true`；连续 5 天隔天来一直是同一个人；过期超过 3 天才换人。C 的端到端在 `asset-wiring-integration.test.mjs` 末尾：真的文档服务加独立的素材子进程，删项目 A 之后等它的项目库目录消失，项目 B 不受影响。

改后用**原版**审查探针再跑一遍（`scratchpad/gfix/after.log`，exit 1，4 条红）：它们断言的是漏洞存在，所以变红说明漏洞不在了。

```
PROBE-1 [[200,200],[200,200],[200,200],[403,404],[403,404]] stored mp4/small,mp4/small,mp4/small   ← A1 挡住
PROBE-3 done 4 failures 1 items [] imageStored true retryMsg []                                    ← D 不再堵
PROBE-5 same id? true renewed true / back on own project {"access":"rw","creator":true}             ← B
PROBE-4 reuse result {"status":409,"code":"project-id-taken"} / B on pid {"status":404,"code":"no-project"}  ← C 的项目号
PROBE-2 [[200,200]×5] stored jpg/original×5                                                        ← 仍「通过」，见下
PROBE-4 A bytes still there for pid {"size":58,"ext":"mp4"}                                         ← 仍在，见下
```

- PROBE-2 仍收下 5 条：它的夹具字节是一段文本（`video original 0 <uuid>`），按文件头认就不是视频，收下是对的。用真的 mp4 开头报成 jpg 的情形在 `guest-fix-regression.test.mjs` 的 A2，第 4 条起被拒。
- PROBE-4 的「A 的字节还在」：这个探针直接操作数据层，没起素材服务的事件消费，回收机制根本没接上。回收在 `guest-fix-cleanup.test.mjs`（参与者单测）和 `asset-wiring-integration.test.mjs`（真的素材子进程）里验了。

## 验证

所有测试命令都设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:UsersadminDocumentsVisuHive`、`PROMPTCUT_PASSWORD_ORDER_MODULE=C:UsersadminDocumentsVisuHiveaccountpassword-order.mjs`、`PROMPTCUT_NO_PORT_FILE=1`，用 `node scripts/test-suite.mjs <文件…>` 跑。没跑全量 `npm test`。

- **满载一轮**：75 个受影响的测试文件一起跑。清单是引用了这次改动模块的全部测试文件，加上任务点名的那几份：`src/account/guest*.test.mjs`、`server/test/account-guest*.test.mjs`、`server/test/asset-service.test.mjs`、`src/online/mediaUploadQueue*.test.mjs`、`src/layering.test.mjs`，以及只读界面的三份。结果 **exit 0，tests 485 / pass 485 / fail 0 / cancelled 0**，用时 402 秒（`scratchpad/gfix/full.log`）。满载没有失败，所以不需要单跑复核。
- 满载之后又改了一处：整件上传读开头时对面断开不留悬着的等待（`0f616bf0`）。改后重跑相关的 5 个文件：**exit 0，40 / 40**。
- 过程中单跑的几轮：
  - 本分支新写的回归：`guest-fix-regression` 7 条、`guest-fix-cleanup` 3 条；
  - 游客身份 7 个文件 60 / 60；
  - 清理相关 8 个文件 45 / 45，含真的素材子进程端到端；
  - 队列与分层 13 / 13。
  - 第一次跑 `account-move.test.mjs` 红过两次，都是真问题、已修：素材子进程部署清单漏了新文件；项目号一刀切撞上「放弃搬迁后再搬」。
- **变异**：把 S2 的修法改回 `next()`，回归测试 S2 那条变红（`S2 {"status":200,...}`），证明它真的守着。同一轮里 S3 那条挂住，我结束了这轮自己起的 3 个 node 进程，文件已还原。
- **类型检查**：`npx tsc -b --force` exit 0、零输出。满载之后、最后一处改动之后各跑了一次。
- 没起 dev server，没占端口。测试里的服务都监听 0 端口（系统分配），素材子进程端口来自 `free-ports.mjs`（系统分配）。没碰 5190～5192、5203、6410～6479。

## 二级〔裁〕（用户看得见，请主会话转给用户）

1. **被限额拒掉的那一个素材不再自动重试，界面说一句为什么，后面的照常传**（D）。写进了 `product/document-service.md`「游客」下面一条子项，标〔裁〕待用户审。用户看到的变化：游客传第 4 条视频时，素材库底部（手机版是 toast）出现「『某某』没有传上云端：游客最多上传 3 条视频。要传更多，请注册一个账号。」，图片等后面的素材照常传上云端。原先什么也不说，后面的素材全堵在本机。
2. 第 4 条视频现在在**小档**那一步就被拒（A1 的连带结果）。用户看得见的差别只有一点：原先第 4 条视频的小档预览会传上去，原件不会；现在两样都不传，并出上面那句话。这一点在用户的口径「总视频素材不能大于三条」之内，所以归三级，只在这里提一句。

其余〔裁〕都是三级（用户看不出区别），写在 `mechanism/document-service.md`「游客」和 `mechanism/asset-service.md`「项目删掉，库也删掉」：A1 的「取多的」数法、A2 的文件头认类型和「认不出按视频算」、B 的续期宽限 3 天、C 的回收时机（回执前当场删）和「删掉的项目号只有原创建者能再用」、S2 失败闭合、S3 游客不能 adopt、E 限流只数新身份。

## 待用户项

两条都写进了 `docs/plan/TODO.md` 新加的「待用户项」一节。会话没给数字、没关功能。

- **A3 游客没有总字节上限**：图片、音频不限条数，每个 100 MB。不要登录，每个 IP 每小时 20 个新身份，就是一个磁盘耗尽口子。修了 C 之后，占的盘最多留 3 天，风险降了但还在。
- **S8 游客自己的项目默认开着云端 Agent**：匿名用户能触发托管方的模型费用。语义没写。

## 没做成的与原因

- **D 的界面没截图**：要起在线编辑器、以游客进云端项目、传 4 个视频，要整套托管后端。只验了文案和订阅（`mediaUploadQueue-guest.test.mjs`，`uploadRejectedText` 的整句断言）。`LibrarySection`、`MobileEditor` 的接线只过了类型检查。建议主会话在发版的真机验收里看一眼。
- **删项目之后，文档服务存的项目内容、云端 Agent 服务按项目存的对话目录（`tenants/<项目>/…`）删不删**：这一轮没查，只修了素材字节。已写进 mechanism「还没做的」。
- **流（`StreamStore`，素材数据目录下的 `streams/`）**不在项目库目录里，删项目不会删到它。没查它有没有按项目回收。
- **S3 变异时 adopt 请求挂住不回**：没深究原因，已用「游客一律不能 adopt」绕开。账号的 adopt 能把分片暂存挂进库，这一点没动：账号不受限额，挂进去也只是它自己的字节。

## 对任务书或语义的更正建议

- 审查建议的「`createProject` 不许重用已删除的 projectId」不能一刀切：会撞上一级语义（放弃搬迁后再搬还是同一个项目号）。实际做的是「只有原创建者能重用」，配合回执前删干净字节。
- 审查 S4（Agent 对话和任务两处不经 `permission()`）不在这次的清单里，没动。`permission()` 注释「判在这一个口子上」仍与实情不符（审查第 3 节第 5 条）。
- `mechanism` 原先把「档位、扩展名能伪造」写成「可以接受、兜底是三天清理」。修了 A1、A2、C 之后，这段已经改成实情。

## 改了哪些文件

代码：
- `server/asset-store/media-sniff.mjs`（新）
- `server/asset-store/project-reaper.mjs`（新）
- `server/asset-store/guest-quota.mjs`
- `server/asset-store/index.mjs`
- `server/asset-store/project-stores.mjs`
- `server/asset-store/blob-store.mjs`（只改注释）
- `server/asset-service.ts`
- `server/hosted/asset-runtime.mjs`
- `server/hosted/files.mjs`
- `server/account/authority.mjs`
- `server/account/guest.mjs`
- `server/docservice/modules/account-projects.mjs`
- `src/account/client.ts`
- `src/online/mediaUploadQueue.ts`
- `src/editor/left/uploadRejectedNotice.ts`（新）
- `src/editor/left/LibrarySection.tsx`
- `src/mobile/MobileEditor.tsx`

测试：
- `server/test/guest-fix-regression.test.mjs`（新）
- `server/test/guest-fix-cleanup.test.mjs`（新）
- `server/test/guest-asset-quota.test.mjs`
- `server/test/account-guest-authority.test.mjs`
- `server/test/account-guest-route.test.mjs`
- `server/test/asset-wiring-integration.test.mjs`
- `server/test/asset-store-tier.test.mjs`（只改注释）
- `src/account/guestClient.test.mjs`
- `src/online/mediaUploadQueue-guest.test.mjs`

文档：
- `docs/semantics/mechanism/document-service.md`
- `docs/semantics/mechanism/asset-service.md`
- `docs/semantics/product/document-service.md`（只加一条〔裁〕子项）
- `docs/plan/TODO.md`
- `docs/archive/agent-reports/AGENT-claude-guest-asset-quota.md`、`AGENT-claude-guest-video-count.md`（各在开头加一段更正）
- 本报告
