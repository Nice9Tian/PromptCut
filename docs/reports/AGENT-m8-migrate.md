# AGENT-m8-migrate 报告

分支 `claude/m8-migrate`，worktree `.worktrees/m8-migrate`，基于 main 467635f。端口段 5760～5769（本机替身用了 5760～5763、5766～5768）。

任务：M8「换机迁移演练」（M8 是渲染队列全案的最后一个阶段「多端物理联调与全案验收」，换机迁移是它的一项验收）的探针与演练步骤。依据 `m8-plan.md` 第 2.5 节、第 4 节第 7、8 项，以及文末「主会话裁定」的 D7（D7 = 迁移演练的接入方式与旧实例保留期：UFW 临时放行 8777 / 8778，演练完收回；旧实例保留 7 天）。本分支不连阿里云、不动远端；远端要执行的命令写成第 4 节的清单。

## 1. 做了什么

### 1.1 `scripts/probes/shared-project-probe.mjs`（改）

- **`--role inventory`**（新）：迁移前的库存，写成一个 JSON 文件（`--out`）。内容：两个 `/healthz`、`service.endpoints` 里登记的素材地址、管理盘点 `GET /admin/inventory` 原样（共享项目、各空间各项目的 `projectRev`、快照数、内容库条目数、三个命名空间的哈希清单与字节数）。
  - `--seed <种子文件>`：另记种子项目的 `projectRev`、摘要、两类清单（`snapshot-manifest` / `render-manifest`，含层表 `layers:<项目 id>`）的键与哈希，并经数据面把清单引用的块全部取回核一遍。
  - `--scan-dir <数据目录>`：只读扫数据目录里各空间的就绪层（两类清单每个键最后一条的哈希），能覆盖探针进不去的项目（编辑器建的项目）。可以不给 `--hosted` 单独用（停写后在服务器上扫）。
  - `--asset <url>`：管理接口走这个源（阿里云上经 SSH 转发的回环端口，令牌不上公网）。
  - 令牌、口令不写进库存文件；有失败时不写文件。
- **`--role migrate-check --from-inventory <库存文件>`**（新形态）：旧实例不在线，旧的一边读库存文件，比法与原来的 `--from` 相同。另加：
  - `--sample all`：按哈希全部取回（原来至多 100 个）；
  - `projectRev` 分「相等 / 归零 / 落后 / 超前」计数（输出 `revs`），另判「没有归零」；
  - `--seed`：以创建者身份进新实例上的种子项目，核 `projectRev`、摘要、两类清单的键与哈希与库存一致，清单引用的块经数据面（新实例登记的素材地址、只读票据）全部取回、重算 sha256；
  - `--scan-dir <新数据目录>`：逐空间逐键比就绪层；
  - 新实例 `service.endpoints` 里的素材地址等于它配置的公网地址（输出 `registeredAssetTo`；原有输出 `assetUrls` 保持原形，SP 测试靠它）。
- 原有的 `--from`（两边同时在线）行为不变；`server/test/sp-hosted.test.mjs`、`sp-hosting.test.mjs` 26/26 过。

### 1.2 `scripts/probes/m8-migrate-probe.mjs`（新写）

每一步可单独跑（`--step`），用法见文件头。

| 步 | 做什么 |
|---|---|
| `seed` | 在源实例建一个自由进入的探针项目：页面角色写入一份空项目（与 `createEmptyProject` 同形，`projectRev` 0→1）；渲染角色当节点发布并完成 4 个细任务，每段 3 帧快照推进 `snap`、段清单写进内容库（键 `<resultKey>:<from>-<to>`，形状同 `server/artifact-transfer.mjs`），再写层表；传一个 256 KiB 素材。写种子文件（0600，含口令，放临时目录，不进仓库） |
| `client` | 以**成员**身份进新实例：① 登记的素材地址是新实例的；② **不重新预渲染**：重发同一批细任务，执行器 `render` 一被调用就记一次并失败——判 `render` 0 次、全部 `task.done`、`task.done` 带回的清单与内容库一致；③ **rev 连续**：`project.open` 的 `projectRev` 等于库存，改一处（项目名）后 = 库存 + 1（`--no-edit` 给第二台客户端，只核不小于库存、不归零）；④ `--ui`：起桌面编辑器，开始页「加入别人的项目」先把托管地址记成旧地址，再在「服务器地址」里改成新地址、加入，核进了编辑器、页面里的项目名是改后的那一版、本机记下的托管地址是新地址；三张截图；`--forbid-host` 给了时页面发往那个主机的请求记失败 |
| `remote-plan` | 打印阿里云演练的命令清单（第 4 节），不连远端 |
| `local` | 本机替身全流程（第 3 节）。`--tamper` 自检：拷完后在目标数据目录删一个快照块、改坏一个，期望失败 |

## 2. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零输出 |
| 全量测试 | `npm test` | 见第 2.1 节 |
| SP 迁移相关测试 | `node --test server/test/sp-hosted.test.mjs server/test/sp-hosting.test.mjs` | tests 26、pass 26、fail 0、skipped 0 |
| 本机替身（不带界面） | `node scripts/probes/m8-migrate-probe.mjs --step local` | 退出码 0，`ok: true` |
| 本机替身（带界面） | `node scripts/probes/m8-migrate-probe.mjs --step local --ui --forbid-host 8.219.80.16 --shots <scratchpad>/shots` | 退出码 0，`ok: true`，看过三张截图 |
| 自检（改坏数据） | `node scripts/probes/m8-migrate-probe.mjs --step local --tamper` | 退出码 1，失败项如预期 |

### 2.1 全量测试

- 第一遍（`npm test`）：tests 3411、pass 3407、fail 2、skipped 2。失败的是 `session-link-page.test.mjs` 的 SL-page-legacy（`read ECONNRESET`，16 s）与 `sp-hosted.test.mjs` 的 SPC1-1（成员 16 s 内没从 `service.endpoints` 拿到素材地址），都是机器满载时的超时类；这两个文件单独重跑 19/19 过；
- 第二遍（`npm test`）：退出码 0，**tests 3411、pass 3409、fail 0、skipped 2**（跳过的两条是要求外部 dev server 的集成测试，与本分支无关）；
- 本分支只动了 `scripts/probes/` 两个文件与本报告（`git diff 467635f --stat`：3 个文件），测试里只有 SPC7 / SP7 调 `migrate-check --from`，已单独确认 26/26。

### 2.2 本机替身结果（带界面那一遍，结果行节选原样）

源 5760 / 5761、目标 5762 / 5763，都是 `server/hosted/main.mjs` 子进程，绑 127.0.0.1，`PROMPTCUT_TRUST_LOOPBACK=0`，令牌在 `<数据目录>/secrets/cluster-token`（同阿里云部署）；编辑器 5766。

库存（`shared-project-probe --role inventory`）：

```
{"ok":true,"role":"inventory",...,"admin":"token","tokenFrom":"file","source":{"doc":"http://127.0.0.1:5760","adminOrigin":"http://127.0.0.1:5761","registeredAsset":"http://127.0.0.1:5761/api/asset","via":"http"},"summary":{"sharedProjects":1,"spaces":2,"projects":1,"assets":{"media":{"count":1,"bytes":262144},"snap":{"count":12,"bytes":1358},"px":{"count":0,"bytes":0}},"seeded":[{"projectId":"sp_inzsh3ipptea3a6g…","projectRev":1,"layers":5,"blobs":12,"verified":1}],"readyLayers":5},"fails":[]}
```

拷数据：两边都是 `files 19, bytes 267993`，15 ms。

核对（`migrate-check --from-inventory … --sample all --seed … --scan-dir …`）：

```
"revs":{"projects":1,"equal":1,"zeroed":0,"behind":0,"ahead":0},
"assets":{"media":{"from":1,"to":1,"bytes":[262144,262144],"equal":true},"snap":{"from":12,"to":12,"bytes":[1358,1358],"equal":true},"px":{"from":0,"to":0,"bytes":[0,0],"equal":true}},
"sample":{"total":13,"checked":13,"ok":13,"bytes":263502,"ratio":1,"bad":[]},
"seeded":[{"projectRev":[1,1],"layers":5,"blobs":12,"verified":{"total":12,"ok":12,"ratio":1,"bad":[]}}],
"readyLayers":{"to":5,"from":5,"equal":true},
"assetUrls":{"from":"http://127.0.0.1:5761/api/asset","to":"http://127.0.0.1:5763/api/asset"},"fails":[]
```

客户端：

```
"rerender":{"tasks":4,"done":4,"renders":0,"claimed":4,"completed":0,"dedup":4,"failed":0,"doneMsgs":4,"manifestsMatch":4,"created":4}
"rev":{"inventory":1,"open":1,"afterEdit":2}
"ui":{"editor":"http://127.0.0.1:5766","oldHosted":"http://127.0.0.1:5760","enterMs":2058,"storedHostedUrl":"http://127.0.0.1:5762","projectName":"m8迁移探针-mukb6g9r-028c32（迁移后）","forbiddenRequests":0,"pageErrors":[]}
```

时间线（从探针启动算，ms）：源起来 439、种子 1823、库存 2330、源停写 3234、拷数据 3267、目标起来 3687、核对 4387、客户端（含起编辑器）30128。

看过的图：`client-1-new-address.png`（加入表单、托管地址已改成 `http://127.0.0.1:5762`）、`client-2-entered.png`（进了编辑器，顶栏项目名是「m8迁移探针-…（迁移…」、成员 1 人）。

### 2.3 自检（`--tamper`）

删掉一个快照块、改坏另一个快照块的首字节后，退出码 1，失败项：

- 核对：`snap：哈希集合与字节数一致 {"from":12,"to":11,...}`；`按哈希取回的全部相符（11/12）`（坏的那个 200 但 sha256 不符）；种子项目「清单引用的块经数据面…全部取回、sha256 相符（10/12）」；
- 客户端：`renders: 1`，缺块那一段被认领后走了渲染（执行器按设计失败），`task.failed`；判「render 0 次」失败。
- 旁证：改坏但还在的那个块，产物库的「在不在」判断照样当它在（去重只看块是否收全，不重算内容），所以只靠去重发现不了静默损坏，靠的是核对里的逐个 sha256。

## 3. 本机替身怎么对应九步

| `hosting-migration.md` 第 2 节 | 本机替身 | 阿里云（第 4 节） |
|---|---|---|
| 1 准备新服务器 | — | 同一台，演练实例 8777 / 8778 |
| 2 部署代码 | 目标用同一份代码 | B：`deploy-hosted --instance drill --write-token` |
| 3 旧服务器停写 | 结束源子进程 | D：`pm2 stop promptcut-hosted` |
| 4 拷数据 | `fs.cpSync` + 文件数 / 字节数 | E：`rsync -a` + `find | wc -l` / `du -sb` |
| 5 拷环境 | 令牌随数据目录；公网地址换成目标的 | 令牌随数据目录；公网地址由 `deploy-hosted` 写进 PM2 配置 |
| 6 启动自检 | 目标子进程 + `migrate-check --from-inventory` | F、G |
| 7 抽查字节 | `--sample all` + 种子项目的数据面取回 | G |
| 8 切客户端 | `client --ui` | H |
| 9 收尾 | 删临时目录 | I |

## 4. 阿里云演练命令清单（主会话执行）

由 `node scripts/probes/m8-migrate-probe.mjs --step remote-plan --stamp 20260928` 生成，原样：

```
# M8 换机迁移演练：阿里云命令清单（m8-migrate-probe.mjs --step remote-plan 生成；主会话执行，每步记时刻与输出）
# 约定：PC 上 PROMPTCUT_REMOTE=<user@host>（本机信息见 docs/local.md），PROMPTCUT_CLUSTER_TOKEN 已设（不回显）；
#       W=<PC 上放种子、库存、截图的临时目录（不进仓库）>；演练在 8.219.80.16 上的第二份实例 promptcut-drill（8777 / 8778）。

## A. 备份（动 pm2 与 UFW 之前）
ssh "$PROMPTCUT_REMOTE" 'cp -a /opt/promptcut-hosted/pm2.config.cjs /opt/promptcut-hosted/pm2.config.cjs.bak-20260928-m8; [ -f /opt/promptcut-drill/pm2.config.cjs ] && cp -a /opt/promptcut-drill/pm2.config.cjs /opt/promptcut-drill/pm2.config.cjs.bak-20260928-m8; pm2 save && cp -a ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak-20260928-m8; ufw status numbered > /root/ufw-status.bak-20260928-m8.txt; ls -la /opt/promptcut-hosted /opt/promptcut-drill 2>&1 | head -20'
ssh "$PROMPTCUT_REMOTE" 'pm2 describe promptcut-drill | grep -E "status|script path" || echo "no drill"; du -sb /var/lib/promptcut/hosted /var/lib/promptcut/drill 2>/dev/null; df -h /var/lib/promptcut'

## B. 演练实例：删旧的 HT 第 1 版进程、旧数据挪开，部署当前 main
ssh "$PROMPTCUT_REMOTE" 'pm2 delete promptcut-drill || true; if [ -d /var/lib/promptcut/drill ]; then mv /var/lib/promptcut/drill /var/lib/promptcut/drill.old-20260928-m8; fi'
node scripts/remote/docservice.mjs deploy-hosted --instance drill --write-token --doc-public-url ws://8.219.80.16:8777 --asset-public-url http://8.219.80.16:8778/api/asset
#   （deploy-hosted 会 pm2 startOrReload 并查两个 /healthz；PROMPTCUT_TRUST_LOOPBACK=0 要令牌，所以带 --write-token。不加 --save）
node scripts/remote/docservice.mjs status-hosted --instance drill
#   演练实例先停，数据目录换成空的（部署时建的空目录与令牌文件挪开），等第 E 步拷数据
ssh "$PROMPTCUT_REMOTE" 'pm2 stop promptcut-drill && mv /var/lib/promptcut/drill /var/lib/promptcut/drill.deploy-20260928-m8 && install -d -m 700 /var/lib/promptcut/drill && ls -la /var/lib/promptcut/drill'
#   UFW 临时放行（D7：演练完收回）
ssh "$PROMPTCUT_REMOTE" 'ufw allow 8777/tcp comment "m8-drill 20260928"; ufw allow 8778/tcp comment "m8-drill 20260928"; ufw status | grep -E "8777|8778"'

## C. 停写之前：种子与库存（PC；管理接口经 SSH 转发，令牌不上公网）
ssh -N -L 18787:127.0.0.1:8787 -L 18788:127.0.0.1:8788 -L 18777:127.0.0.1:8777 -L 18778:127.0.0.1:8778 "$PROMPTCUT_REMOTE"   # 另开一个终端挂着，演练完关掉
node scripts/probes/m8-migrate-probe.mjs --step seed --hosted http://127.0.0.1:18787 --seed "$W/seed.json"
node scripts/probes/shared-project-probe.mjs --role inventory --hosted http://127.0.0.1:18787 --asset http://127.0.0.1:18788 --seed "$W/seed.json" --out "$W/inventory.json"
#   （E1 --keep 留下的项目、C10 页面建的项目：在库存的 inventory.spaces 里，按 projectRev 与哈希集合一起核；它们的层表在内容库条目数里）

## D. 停写（此刻在线的成员会断开：先在对话里报时刻）
ssh "$PROMPTCUT_REMOTE" 'date -Is; pm2 stop promptcut-hosted; pm2 describe promptcut-hosted | grep status'

## E. 拷数据并核对文件数与总字节数
ssh "$PROMPTCUT_REMOTE" 'date -Is; time rsync -a /var/lib/promptcut/hosted/ /var/lib/promptcut/drill/; date -Is'
ssh "$PROMPTCUT_REMOTE" 'for d in hosted drill; do echo "$d files=$(find /var/lib/promptcut/$d -type f | wc -l) bytes=$(du -sb /var/lib/promptcut/$d | cut -f1)"; done'

## F. 启动演练实例并自检
ssh "$PROMPTCUT_REMOTE" 'pm2 start promptcut-drill && sleep 2 && pm2 describe promptcut-drill | grep -E "status|restarts"'
node scripts/remote/docservice.mjs status-hosted --instance drill

## G. 核对（PC）：rev、哈希全部取回、种子项目的就绪层
node scripts/probes/shared-project-probe.mjs --role migrate-check --from-inventory "$W/inventory.json" --to http://127.0.0.1:18777 --to-asset http://127.0.0.1:18778 --seed "$W/seed.json" --sample all

## H. 切客户端（PC 界面改地址；笔记本当第二成员）
node scripts/probes/m8-migrate-probe.mjs --step client --hosted http://8.219.80.16:8777 --seed "$W/seed.json" --inventory "$W/inventory.json" --ui --old-hosted <PC 桌面版原来的托管地址> --editor-port <主会话端口段> --shots "$W/shots"
#   笔记本（种子文件经协调口或 scp 带过去，用完删）：PROMPTCUT_HOSTED_URL=ws://8.219.80.16:8777 node scripts/probes/m8-migrate-probe.mjs --step client --hosted http://8.219.80.16:8777 --seed <种子文件> --inventory <库存文件> --no-edit
#   PC、笔记本的真实编辑器进 E1 留下的项目、preload：诊断 queue.stats 里 completed 0、dedup = 细任务数（第 2.5 节第 9 步，手工看）

## I. 收尾：主实例回来，演练实例停，UFW 收回
ssh "$PROMPTCUT_REMOTE" 'date -Is; pm2 stop promptcut-drill; pm2 start promptcut-hosted; sleep 2; pm2 describe promptcut-hosted | grep -E "status|restarts"'
node scripts/remote/docservice.mjs status-hosted
ssh "$PROMPTCUT_REMOTE" 'ufw delete allow 8777/tcp; ufw delete allow 8778/tcp; ufw status | grep -E "8777|8778" || echo "8777/8778 已收回"'
ssh "$PROMPTCUT_REMOTE" 'pm2 list'
#   确认 promptcut-hosted online、promptcut-drill stopped 后再 pm2 save（开机自启按这份）；演练前的 dump 在 ~/.pm2/dump.pm2.bak-20260928-m8
#   演练实例的数据目录 /var/lib/promptcut/drill 与 drill.deploy-* / drill.old-* 保留到 M8 报告写完再删；
#   真正换机时旧服务器保留只读 7 天（D7），下线前核新数据目录文件数不少于旧的。
#   演练期间演练实例上的写（client 的改名）不回流主实例；种子项目留在主实例里，报告写完后由创建者删除。
```

## 5. 与 `hosting-migration.md` 对不上的地方（建议改文档，不涉语义）

1. **第 2 步「部署代码，先不启动」做不到**：`deploy-hosted` 一定 `pm2 startOrReload`；PM2 配置写了 `PROMPTCUT_TRUST_LOOPBACK=0`，数据目录里没有令牌就停手（退出码 5），所以部署演练实例要带 `--write-token`，起来的是一份空实例。清单里的做法：部署、查 healthz 后立即 `pm2 stop`，把部署时建的数据目录挪开、换成空目录，等第 4 步拷数据。建议文档写成「部署后先停、清空数据目录」，或给 `deploy-hosted` 加一个不启动的开关（改脚本，本分支没做）。
2. **第 4 步没说目标数据目录必须是空的**：`rsync -a` 往有东西的目录里拷不会删多余文件，演练实例上还有 HT 第 1 版留下的数据，库存会对不上。清单里先挪开（`drill.old-*`、`drill.deploy-*`）。
3. **第 5 步「拷环境变量文件」已过时**：现在服务器上没有单独的环境变量文件——令牌在 `<数据目录>/secrets/cluster-token`，随数据目录走；两个公网地址由部署脚本写进 PM2 配置（仓库外、无秘密）。第 1 节末段「服务器上的环境变量文件……要单独拷」也应一起改。
4. **第 6 步「与旧服务器停写前记下的一致」有窗口**：库存在停写之前取，这之间有人写，`projectRev` 就会「超前」而判失败。建议库存紧挨着停写取（清单 C 紧接 D）；探针输出 `revs.ahead` 单列，便于区分「演练期间有人写」与「丢了数据」（后者是 `behind` / `zeroed`）。
5. **第 7 步「至少 100 个或全部」**：M8 用全部（`--sample all`），数据量小，全取也就几秒到几分钟。
6. **第 8 步切客户端，没说正开着的页面**：页面刷新后回到共享项目靠 `sessionStorage` 里记的候选地址（`syncManager.ts` 的 `resumeShared`），迁移时刻正开着的页面会一直重连旧地址（「连不上」不清记录），要回开始页、在加入表单里改地址重进。在线页面（`/editor`）与邀请链接的源是文档服务公网地址的源，换机后旧邀请链接失效，要重发。建议写进第 8 步。
7. **第 1、8 步没提 nginx、证书与域名**：正式实例在 nginx 之后，公网地址是 `wss://8-219-80-16.sslip.io/hosted/`、`https://…/media/api/asset`，这个域名由 IP 派生，换服务器就换域名，所有客户端地址、在线页面地址、邀请链接都变。真正换机要补「新服务器装 nginx 与证书、按 C10a 契约第 2 节加路由」一步。演练用明文端口（D7），不经过这一段。
8. **第 9 步「旧服务器保留只读」**：托管组合没有只读模式，停写就是 `pm2 stop`，「保留只读」实际是「保留数据、不启动」。保留期按 D7 写 7 天。

## 6. 没做的与待核

- **真实编辑器的「不重新预渲染」没有自动化**：`client` 用的是探针自己的细任务，走的是真实的队列去重路径（清单在、块齐就 `dedup`），但不是编辑器的 preload。`m8-plan.md` 第 2.5 节第 9 步要 PC 与笔记本的编辑器进 E1 留下的项目、看诊断 `queue.stats`（`completed` 0、`dedup` = 细任务数），清单 H 里写成手工一步。要自动化可以给 `client` 加 `--editor <url>` 读 `/api/prerender/info` → `/api/frames/diagnostics`，本分支没做（本机要真预渲染一遍，这台机器此刻很忙）。
- `--scan-dir` 在阿里云上要把探针拷到服务器上才能跑，清单没列；种子项目与管理盘点已覆盖三条判据，编辑器建的项目靠 `projectRev` 与哈希集合。需要时：`scp scripts/probes/shared-project-probe.mjs scripts/probes/probe-coord.mjs <远端>:/opt/promptcut-hosted/app/scripts/probes/` 后在服务器上 `node … --role inventory --scan-dir /var/lib/promptcut/hosted --out …`（停写后）。
- 界面一段只在本机替身里跑过，没有在真实托管端跑过；`--forbid-host` 只看页面的 HTTP 请求，WebSocket 连接不在 puppeteer 的 `request` 事件里。

## 7. 提交

（收尾时补）
