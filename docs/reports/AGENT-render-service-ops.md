# 子 Agent 报告：渲染服务的容量记账、部署脚本与模板、界面开关（第三段第 3、4 批）

分支 `claude/render-service-ops`，worktree `.worktrees/render-service-ops`，起点 `7b7b1fd8`（第 1 批完成）。契约 `docs/plan/hosted-render-contract.md`。

## 状态

第 3、4 批做完，轻量验收全过（见「验证」）。容量三条里前两条做到，第三条（按最久没人在线淘汰）验证了前提、前提不成立，没有交付。没有连任何远端，没有碰新节点。

名词：**HR21、HR22、HR24** 是契约第 10.1 节的单测编号——HR21 容量记账、HR22 部署脚本的纯函数、HR24 界面的显示条件。**托管组合** 是托管端上文档服务加素材服务的那一对进程。

## 分工与接手

前一个子 Agent 做到一半被中断，留下四次提交（`8d1bf2a2` 开工、`71635914` 界面、`521a8ee1` 容量、`1f45d2b8` 部署模板与脚本），报告只写了开工。接手后逐项复核：

- 复核方式：读三次提交的全部 diff；跑它的三个测试文件（26 项全过）；把它写好但没跑过的界面探针 `scripts/probes/hosted-render-ui-probe.mjs` 完整跑了一遍（19 项断言全过，见下）；`docservice.mjs` 的六个新子命令逐个干跑。
- 复核结论：已提交的东西都能用，没有返工。
- 我补的：`server/hosted/deploy/README.md` 的「渲染服务」一节（`bf52432d`、`dccc195e`）、`docs/plan/hosting-migration.md` 的第 2a 节（`dccc195e`）、第 4 批的浏览器端验证与截图、容量第 3 条前提的核对结论、全部轻量验收、本报告。

## 做了什么

### 第 4 批：界面（`71635914`）

- `src/editor/sync/hostedServices.ts`：纯逻辑（解析成员列表顶层的 `hosted`、显示条件、`hosted-service-changed` 落到状态上、成员列表拆成成员与服务行）。**按服务名渲染一行**：第四段加 `agent` 只要往 `HOSTED_SERVICE_ROWS` 与 `HOSTED_SERVICE_TEXT` 各加一项。
- `src/editor/sync/HostedServiceRows.tsx`（原名 `HostedServices.tsx`，与 `hostedServices.ts` 只差大小写，Windows 上会冲突，`521a8ee1` 改名）：项目设置里多用户协作那一组的勾选行；放云端且 `available` 才出现，缺省勾上；创建者点它走 `CreatorFlow`（验证创建者身份）再确认，其他成员只读（禁用，另带「只有创建者能改」）。
- `MembersPanel.tsx`：服务行显示为「托管方的渲染节点」（按 `service` 字段，不看用户名），排在成员之后、不计入成员数、没有踢人按钮，手里有认领时带「渲染中」；加 `HostedServiceDialog`（确认关闭或打开）。
- `syncManager.ts`：`shared.members.list` 带出 `hosted`；`hosted-service-changed` 通知落到状态并弹一条气泡；`setHostedService` 调 `shared.admin { op: 'set-hosted-service' }`；离开项目、回本机时清掉 `hosted`。
- `CollabSection.tsx` 接上，`sync.css` 补一点样式。

### 第 3 批：容量记账（`521a8ee1`）

- `server/asset-store/service-usage.mjs`：对带 `sv` 的素材票据写成的块单独记账，追加写 `<托管数据目录>/assets/.service-usage/render.ndjson`、启动回放、行数过多时压缩；上限 `min(20 GiB, 托管数据目录所在盘总容量的四分之一)`，`PROMPTCUT_HOSTED_RENDER_CAP_BYTES` 可改；第一片到了还没收尾的新块先占名额（并发写冲不穿上限），2 小时没收尾放掉。
- `server/asset-service.ts`：到上限回 **507 `service-quota`**，只拦渲染服务，成员写入照常；成员后来写了同一个块则该块不再「只归渲染服务」。
- `server/hosted/combo.mjs`：接记账；监听凭证库的 `remove` 变更，**删项目时清只归它的块**（几个项目共有的块等最后一个项目删了才清）；`/healthz` 同类的清单接口多带 `serviceUsage` 状态。

### 第 3 批：部署脚本与模板（`1f45d2b8`，我补 README 与迁移文档）

- 模板（`server/hosted/deploy/`，占位符写成两层花括号括起来的大写名字，不含证书、令牌与任何密钥）：`pm2-promptcut-render.config.cjs`（应用名 `promptcut-render`，入口 `server/hosted-render/main.mjs`，cwd `<部署目录>/current`，`stop_exit_codes: [78]`）、`promptcut-render.slice`（`MemoryHigh`、`MemoryMax`、`CPUQuota`、`CPUWeight=20`、`IOWeight=20`、`TasksMax=4096`）。
- `server/hosted-render/deploy.mjs`（纯函数）：参数校验、模板填充（认不得的占位符与残留花括号抛错）、六条远端脚本、`planRenderCommand`（参数解析）。
- `scripts/remote/docservice.mjs` 六个子命令，都收 `--dry-run`：`install-render`、`deploy-render [--commit] [--save] [--no-start] [--keep]`、`status-render`、`stop-render [--delete]`、`rollback-render [--to]`、`keygen-render [--list | --retire <kid>] [--instance-name] [--release]`。契约点名的四个（`install-render`、`deploy-render`、`status-render`、`keygen-render`）都在，另加了 `stop-render` 与 `rollback-render`。
  - `deploy-render`：本机 `git archive` 指定提交 → scp → 远端解到 `releases/<提交前 12 位>/`、`npm ci`、`npx puppeteer browsers install chrome-headless-shell`、用新配置跑 `--check`，**自检过了才换 `current` 并 `pm2 startOrReload`**；退出码 78 什么都不换；`--save` 做 `pm2 save`；`pm2-<用户>.service` 没装且有 systemd 时补装；没有 systemd 打一行说明并跳过。
  - 与托管服务的部署清单（`server/hosted/files.mjs`）的关系：**清单不用变**。渲染服务跑完整仓库，不进暂存目录；`server/asset-store/` 是整目录拷的，`service-usage.mjs` 与它引的 `px-evict.mjs` 随之去（HR22e 断言了，并真起一次托管端的现有闭合单测 SPH-deploy 不红）。
- `server/hosted/deploy/README.md`「渲染服务」一节：占位符表与缺省值、先决条件「与在线页面同一个提交」、第一次部署的五条命令、系统包与 Chrome 的运行库、服务用户、keygen 与换钥撤钥、按提交分目录升级与回退、PM2 存档与开机自启（手工做法与核对命令）、没有 systemd 时的降级、容量。
- `docs/plan/hosting-migration.md` 第 2a 节：渲染服务的迁移与重建（什么带什么不带：`render/` 不拷、私钥不拷、登记表随托管数据目录过去后撤旧公钥、新节点重新生成；七步）。

## 验证

（环境：Windows，node 24.19.0，`C:\Program Files\nodejs`。）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | 退出码 0；4482 项，4481 通过、0 失败、1 跳过（第 1 批后是 4456 / 4455 / 1，本批新增 26 项） |
| 构建 | `npm run build` | 退出码 0（`tsc -b` 与 `vite build` 都过；只有原有的 INEFFECTIVE_DYNAMIC_IMPORT 提示） |
| 本批新增单测 | `node --test server/test/hosted-render-capacity.test.mjs server/test/hosted-render-deploy.test.mjs src/editor/sync/hostedServices.test.mjs` | 26 项，26 通过、0 失败 |
| 界面浏览器端 | `node scripts/probes/hosted-render-ui-probe.mjs --out work/four-stage/render-service` | 19 项断言全过，退出码 0 |

### 单测逐条

| 编号 | 文件 | 内容 | 结果 |
|---|---|---|---|
| HR21a | `server/test/hosted-render-capacity.test.mjs` | `sv` 票据写成的块记一笔；成员写的不记；渲染服务写成员早已写过的块不记 | 过 |
| HR21b | 同上 | 到上限 507 `service-quota`，只拦渲染服务，成员照常；已记账的块再写不占名额 | 过 |
| HR21c | 同上 | 第一片到了还没收尾的新块先占名额，并发写冲不穿；失败放掉名额 | 过 |
| HR21d | 同上 | 删项目清只归它的块；几个项目共有的块最后一个项目删了才清；成员写的块不动 | 过 |
| HR21e | 同上 | 重启回放一致；半行不坏；行数过多时压缩 | 过 |
| HR21f | 同上 | 成员后来写了同一个块：不再只归渲染服务，删项目时不清 | 过 |
| HR21g | 同上 | 上限的算法：`min(20 GiB, 盘总容量/4)`；环境变量可改；盘容量取不到就是 20 GiB | 过 |
| HR21h | 同上 | **淘汰前提的核对**：见「容量三条」 | 过（断言的是前提不成立） |
| HR22a～e | `server/test/hosted-render-deploy.test.mjs` | 参数缺省与不合格拒绝；模板占位符闭合；PM2 配置求值后的字段与不含秘密；slice 单元；install、deploy、rollback、stop、status、keygen 的脚本文本；命令行 `--dry-run` 不连远端、错参数退出码 2；托管部署清单不变 | 过（十项） |
| HR24a | `src/editor/sync/hostedServices.test.mjs` | 解析、显示条件、通知落状态、服务行在成员之后不计数 | 过（四项） |
| HR24b | 同上 | 放本机、无 `hosted` 字段、`available` 为假时没有这一项；放云端且 `available` 时出现、缺省勾上、创建者能改、成员只读；点勾选把「要改成什么」交给上层 | 过（三项） |

### 界面的浏览器端验证

探针起的东西：隔离的托管组合（`server/hosted/main.mjs`，端口 8782、8783，临时数据目录，`PROMPTCUT_TRUST_LOOPBACK=0` 加一份临时集群令牌）、用 keygen 生成的登记表（所以 `render` 报 `available: true`）、本 worktree 的 dev server（5760，临时数据目录，`PROMPTCUT_PUSH=0`）、无头 Chrome 里创建者与成员各一个页面（各自的浏览器上下文 = 各自一台设备）、一个假扮渲染服务的客户端（照契约握手、订阅目录、取票据、开数据连接）。跑完探针自己清掉进程与临时目录；之后核对过 5760、8782 没有监听。

断言结果（每项一行 JSON，全部 `ok: true`）：

| 编号 | 断言 | 结果 |
|---|---|---|
| U1 | 没开协作时没有这一组；创建表单里没有；创建者放云端开启后，项目设置出现「托管方的渲染节点」，缺省勾上、可点 | 过 |
| U2 | 成员加入后在自己的项目设置里看到同一项：勾着、禁用、带「只有创建者能改」 | 过 |
| U3 | 目录清单里这个项目 `enabled`、`active`、`members` 为真、`hosted.render.available` 为真；假的渲染服务连上后，成员列表出现「托管方的渲染节点」：在成员之后、没有踢人按钮、不计入成员数 | 过 |
| U4 | 创建者取消勾选（验证创建者身份、确认）：创建者的勾选取消；**成员那边开着的设置窗口 5 秒内跟着变**并弹一条气泡；服务连接以 4003 `service-disabled` 关闭；关着时要票据回 `service-disabled`；成员列表里服务行消失 | 过 |
| U5 | 再勾上：两端勾选都回来；服务能重新连；服务行回来 | 过 |
| U6 | 手里有认领时服务行带「渲染中」 | 过 |
| — | 页面无报错 | 过 |

放本机的项目没有这一项：由 HR24b（组件测试，`where: 'lan'` 与没有 `hosted` 字段）覆盖；探针没有单开一个放本机的页面，因为本机项目走挂载模式，根本不发 `hosted` 字段（HR12 在第 1 批已测）。

截图（看过两张）：

- `C:\Users\admin\Documents\PromptCut\work\four-stage\render-service\ui-1-creator-settings.png`：创建者的项目设置，「多用户协作」组里出现勾上的「托管方的渲染节点」，下面一行提示。
- `C:\Users\admin\Documents\PromptCut\work\four-stage\render-service\ui-2-member-members-list.png`：成员的成员列表，两位成员之后一条分隔线，下面是「托管方的渲染节点」，没有踢人按钮，顶栏计数是「成员: 2 人」。
- 另存：`ui-3-member-settings-readonly.png`（成员只读）、`ui-4-member-settings-off.png`（关闭后成员那边跟着变）。

### 干跑记录

不连任何远端，不设 `PROMPTCUT_REMOTE`：

```
deploy-render --dry-run --save          退出码 0（打出 git archive 与 scp 命令，再打出交给远端 bash 的脚本，135 行；
                                          脚本里搜 token / secret / password / BEGIN 只有路径名与注释里的「秘密」二字，没有任何值）
install-render | status-render | stop-render | rollback-render | keygen-render --list | keygen-render --retire AbCd1234
                                         各 --dry-run  退出码 0
deploy-render --bogus（无 --dry-run、无 PROMPTCUT_REMOTE）  退出码 2
```

## 容量三条各自做没做到

1. **记账与上限（到上限 507、只拦服务、不影响成员）**：做到，HR21a～c、g。
2. **删项目时清只归它的块**：做到，HR21d、e、f。
3. **超过上限九成时按「最久没人在线」整项目淘汰、24 小时内在线的不清**：**没有交付**。契约第 6 节写明这一条有前提：清掉的块在内容库清单里还有引用时，在线页面与低内存档必须按「没有产物」重新发补渲，而不是卡住。我核对了前提，**不成立**：HR21h 用真的 `OnlineSnapshotSource`（`src/render/snapshotSource.ts`）让素材服务对该层的块一律回 404、内容库里清单还在，结果页面认为这一层 `coverage` 为 `full`、`frameConfirmedMissing` 为假，只把 404 当暂时错误（`stats.errors` 增加）、下一轮再取，永远不会重新发补渲。**缺什么才能交付**：在线页面一侧把「清单列着、块取回稳定 404」判成「没有产物」重新发补渲，或淘汰时同时把内容库里对应的清单项撤掉；前者在 `src/render/snapshotSource.ts`（不在本批范围）。此外还要「按项目最近一次有成员在线的时刻」的记录，文档服务现在没有对外给的现成接口（目录模块有 `members` 与 `active` 的实时值，但不留最近在线时刻）。按契约的退路，先只交付 1、2。托管端磁盘靠上限本身兜住：渲染服务到上限就停写（不丢成员数据），代价是上限满之后新的云节点预渲染产物写不进、直到删项目释放空间。

## 没做成的

- 容量第 3 条（淘汰），原因见上；这是契约允许的退路，不是失败。
- 没有做「新节点上才能验」的东西：`install-render` 装系统包、非 root 用户下 Chrome 沙箱、`systemd-run --scope` 与 slice、PM2 `stop_exit_codes` 在节点 PM2 版本上是否有效、节点重启后自启。模板与脚本的文本由单测与干跑核对，真执行留给新节点。
- 渲染服务的入口 `server/hosted-render/main.mjs` 与 `--check` 不在本分支（并行分支 `claude/render-service` 在写）；PM2 模板按契约第 7 节的路径与环境变量名写。我核对过那个分支里用到的 `PROMPTCUT_RENDER_*` 名字，与模板、`renderInstance` 一致。合流后才能真跑一次 `deploy-render` 的自检那一步。

## 转交并行分支（`claude/render-service`）的问题

1. **507 `service-quota` 的处理还没有**：契约第 6 节要求「渲染服务把任务报失败（不重试）、暂停认领 10 分钟并打 `render.quota`」。那个分支里没有这三个词。素材服务客户端（`server/asset-store/client.mjs`）对 5xx 会按 `retries` 重试，用尽后抛出的错误带 `err.status === 507` 与 `err.body.error === 'service-quota'`，渲染服务要在这里识别、不要再重试、改成报失败并暂停认领。
2. **非 root 用户跑 Vite 要有可写位置**：`deploy-render` 以 root 解包 `releases/<id>/`（`umask 022`，别的用户只读），而工作进程以 `promptcut-render` 跑；Vite 的预构建缓存默认写在检出目录的 `node_modules/.vite`，那里它写不了。仓库里没有设 `cacheDir`。建议工作进程启动时把 Vite 缓存目录指到 `PROMPTCUT_RENDER_DATA` 下（我没验，新节点上第一次非 root 部署要看这一点）。
3. 模板里 PM2 的 `PUPPETEER_CACHE_DIR` 是 `<部署目录>/current/.cache/puppeteer`，对应 `deploy-render` 装 Chrome 的位置 `releases/<id>/.cache/puppeteer`；自检用新发布目录里的那份（还没换 `current`）。入口若改变找 Chrome 的办法，要同步。

## 对契约与任务书的更正建议

1. 第 7.4 节写的是 `install-render`、`deploy-render`、`status-render`、`keygen-render` 四个子命令，实现里多了 `stop-render`、`rollback-render`（升级与回退要有回退入口，停也需要），建议契约加上。
2. 第 6 节第 2 条（淘汰）的前提实测不成立，建议契约把它改成「前提：在线页面把『清单列着、块 404』判成没有产物（`snapshotSource.ts`），归第二段或之后的专项」，并把它的验收单独记，不再算在本段 HR21 里。已有的探针 `hosted-render-evict-probe.mjs`（契约第 10.2 节）也同此：前提不成立之前写不出「最终贴上」那一步。
3. 第 6 节「记账」写「同一个块被几个项目写到就记几个项目」，实现里还加了两条规则（成员后来写了同一个块则不再只归渲染服务；写之前已由成员入库的块不记），契约建议补这两句，否则「只归它的块」含义不明。
4. 契约第 7.4 节「PM2 存档与开机自启」写在 `deploy-render` 成功后 `pm2 save`；实现是 `--save` 才存（缺省不存，与 `deploy-hosted` 一致，免得第一次试部署就把状态写进开机清单），建议在契约里写明是 `--save`。
5. 任务书第 21 条没有问题；第 24 条（界面）按契约做，只是「创建者特权」那句语义改写还没落（契约第 9.3 节已有逐字稿，语义不在本批改）。

## 需要用户决定的事

没有新的待用户项。第 3 条淘汰是否另立专项，由主会话在合流时定。合并请照任务书的集成节奏（本批不合入、不发版、不动新节点）。
