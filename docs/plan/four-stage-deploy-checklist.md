# 四段连做的部署前检查清单与部署步骤

> **2026-10-08 补记：下面几处已被用户后来的决定取代，照新的办**（`docs/plan/account-binding-task.md`、`docs/semantics/guide_files/verification.md`）。本清单其余步骤仍可参照，但不能再整份照单部署：
>
> - **A3**「0.7.19、0.7.20 不单独出」：改为分 0.7.18、0.7.19、0.7.20 三个版本，各自出。
> - **A4**「只打补丁」：改为每个版本都出完整安装包和兼容补丁；外壳要不要升级由兼容证据定。
> - **B1**「数据目录不动、不备份整份」：清理旧测试项目之前要有一致的备份，并实际验证过能恢复。
> - **B4**「等连续 5 分钟不变、最多等 3 小时」：这三个版本部署切换时可以打断旧测试项目，不以这两条为停点；例外办结后恢复原规定。
> - **新增要核的**：在线页面现在还有一个地址 `https://visuhive.com/editor/`（官网的站点配置在 VisuHive 仓库 `deploy/nginx-site-landing.conf`，里面照抄了本仓库的站点模板，改模板时那边跟着改）。账号后端、PromptCut 服务、网页的先后顺序见 `account-binding-task.md`「两仓库交付、部署与回退」。

给主会话在「最后一次完整验收」通过之后照着做（任务书 `sound-online-render-task.md`「做法与验收节奏」第 4～6 步）。每一步写：做什么、哪条命令、改动前备份什么、怎么核对、不过怎么退。可以逐条打勾。2026-10-07 起草，同日按任务书更新（云端 Agent 的 F、J、K 与完成条件第 8 条）补入。

先说清几件事：

- **新节点连接办法、密钥位置、服务器上的路径细节在本机 `docs/local.md`（不入库）。** 本文凡要用到的地方写「见 docs/local.md」，命令里 `$PROMPTCUT_REMOTE` 是 `user@host`，`$PROMPTCUT_REMOTE_KEY` 是私钥路径。起草本文的子 Agent 没有读那个文件、没有连任何远端。
- 命令取自三处：现有的 `scripts/remote/docservice.mjs`（`deploy-hosted`、`status-hosted` 等）与 `server/hosted/deploy/README.md`；第三段分支 `claude/render-service` 与第四段分支 `claude/cloud-agent` 新增的 `install-render`、`deploy-render`、`status-render`、`stop-render`、`rollback-render`、`keygen-render`、`deploy-agent`、`status-agent`、`stop-agent`、`keygen-agent`（都收 `--dry-run`：只在本机打出要交给远端的脚本，不连远端，**每条先 `--dry-run` 看一遍**）；第二段分支 `claude/online-cards` 新增的 nginx 片段生成脚本 `scripts/gen-stage-policy-nginx.mjs`。这些分支还在收尾，合流后命令名与参数以合流后的 `scripts/remote/docservice.mjs` 文件头与 `server/hosted/deploy/README.md` 为准，本文标了〔待合流核对〕的地方要核一遍。
- 新节点是生产环境：验证只用测试房间与测试凭证，验完删掉；改动前先备份；阿里云不碰；防火墙与系统安全设置不改，需要用户做什么把命令写给用户；令牌、密钥、模型 Key 的值不打印、不进提交、日志或消息。
- 总顺序：**合入前的判断与打补丁 → 动新节点前的准备 → 先改 nginx → 换在线页面 → 重部署托管服务（必须）→ 部署渲染服务 → 部署 Agent 服务**。每部署一样，做那一样的新节点实测（第 D 节）。哪一样实测不过，只退那一样，其余保留（任务书第 6 步）。
- **验证分两级**（`docs/semantics/guide_files/verification.md`「本地验证与真实网络验证」，2026-10-07 用户定）：A 节的完整验收是**本地验证**，过了即可合入 main、发版；D 节的节点实测是**真实网络验证**，只在往节点部署时（部署完跑一遍）、或改到网络这一层时做，不是合入 main 的前提，所以合入可以早于它。清单里两级的项数：`node scripts/acceptance/four-stage-acceptance.mjs --list`（本地验证 104 项、真实网络验证 16 项）。
- **耗时只记录，不当闸门**（同一文件「耗时只记录，不当闸门」）：没有哪一项要等某台机器复核。发版时把各项耗时与机器配置记进 `docs/reports/release-timings.md`（A1 的命令带 `--release-timings` 就出这一节）。

## A. 合入 main 之前

- [ ] **A1 最终提交上的本地验证全过。** 集成分支最终提交上跑 `node scripts/acceptance/four-stage-acceptance.mjs --out work/four-stage/final/<时间戳> --flaky-rerun 1 --release-timings "0.7.18"`（缺省只跑本地验证这一级；清单 `scripts/acceptance/four-stage-manifest.mjs`，用法见文件头；`--list`、`--matrix` 先看一遍）。过的标准：G0 五项、G0-R 的 GR-1～GR-12（像素比对 GR-3 要「0 不同、0 缺失」）、全部探针行、四段各自的行都是「过」；标「manual」的行逐条人工核对。时间数字只记录、不决定过不过，在哪台机器上跑都一样判，没有待复核的项；跑完把 `<out>/release-timings-section.md` 贴进 `docs/reports/release-timings.md`。真实网络验证的 16 项不在这一步，留到本文 D 节、部署时做。`--matrix` 要显示两份任务书的每一条编号验收都有行覆盖。
- [ ] **A2 release 的三条合入条件**（`git_and_release.md`「release 分支」）：
  1. 基线全绿（A1）；
  2. `npm run build` 成功（清单 G0-3）；
  3. 改动涉及桌面壳、Chrome、ffmpeg、内置 Python 或运行时目录布局时，`desktop/` 下的发版构建也成功——**这次不涉及**（依据见 A3），所以这一条不适用；但仍跑 `node --test desktop/test/*.test.mjs`（清单 G0-5）作旁证。
- [ ] **A3 版本号怎么判。**〔2026-10-08 部分已被取代，见文首〕
  - **应用版本 0.7.17 → 0.7.18**（只动了 Node 那一半，末位 +1；任务书已定统一为 0.7.18，文中的 0.7.19、0.7.20 不单独出）。改 `package.json` 的 `version` 与 `package-lock.json` 顶部、`packages[""]` 两处的 `version`，照上一次的发版提交 `073c8cca`（「chore: release v0.7.17 (shell 0.2.7)」，只改这两个文件）。构建在提交之后。
  - **外壳版本 0.2.7 不动。** 依据（起草时逐项查的，合流后再查一遍：`git diff <main 上一版>..<最终提交> --stat -- desktop python package.json`）：
    1. 第一段、第二段、第三段、第四段相对集成分支起点 `326e9069` 的 diff 里，`desktop/`（Rust 外壳、`tauri.conf.json`、发版脚本）与 `python/` 下**没有任何文件**；
    2. 依赖只多了一项 `sucrase@3.35.1`（第二段，浏览器端转译器），Chrome 由 puppeteer 锁定的版本决定（`puppeteer` 版本没动）、ffmpeg 与内置 Python 的打包没动；
    3. 运行时目录布局没变（新增的 `server/hosted-render/`、`server/agent-service/` 只在云节点上跑，桌面版运行副本带不带它们不影响运行）；
    4. 判断题「Node 这一半放到老外壳 0.2.7 上还能不能照常跑」：能。第二段的转译器只在在线构建里按需载入（桌面构建把那一行剪掉，`vite.config.ts` 里读 sucrase 版本的 `cardRuntimeDeps()` 只在在线配置里调用）。
    结论：落在 `git_and_release.md` 表的第一行（只动 Node 那一半），补丁 `shellGeneration` 仍是 `0.2`、`minShellVersion` 不动。
- [ ] **A4 打补丁。**〔2026-10-08 已被取代，见文首〕 在 PC 主工作区的 `desktop/` 下：`npm run release -- --from-head --patch-only`（源码取自 HEAD，所以先提交、再合入，从 main 上最终那个提交出；上一次 0.7.17 就是这样出的）。
  - 产物：`desktop/release/PromptCut-patch-0.7.18.exe`、`desktop/release/manifest-0.7.18.json`。
  - 取大小与 SHA-256（PowerShell）：`(Get-Item desktop\release\PromptCut-patch-0.7.18.exe).Length`、`Get-FileHash -Algorithm SHA256 desktop\release\PromptCut-patch-0.7.18.exe`、`manifest` 同样取一遍；贴进总报告。
  - **这次补丁会比上一次大很多**：`desktop/scripts/make-patch.mjs` 按 `package-lock.json` 里依赖内容的哈希判断「依赖变没变」，第二段加了 `sucrase`（及它的依赖）后依赖变了，补丁会带上整份 `node_modules`（脚本注释里写的量级是约 196 MB），而不是 0.7.17 那样的 17.9 MB。这是预期内的，要提前告诉用户；产物大小以实际为准。不要用 `--no-deps`（依赖变了脚本会拒绝，装上去会跑不起来）。
  - **有 Agent 会话在跑时不装补丁**（`verification.md`）：补丁会整棵覆盖桌面版运行时副本。装补丁由用户自己做，会话不装；打好补丁只交产物路径、大小、SHA-256。
- [ ] **A5 合入。** 写 main 要用户授权（`suggested_agent_behavior.md` 原则 4）：`git checkout main && git merge --no-ff claude/four-stage`（合并提交写成「合并 claude/four-stage:…」）→ 改版本号提交 → 推送；`release` 判过就 `git checkout release && git merge --ff-only main`。
- [ ] **A6 同一提交。** 记下这个合入后的提交哈希 `<SHA>`：在线页面、渲染服务、Agent 服务**三者必须都从它出**（见 C 节「先决条件」）。之后任何一样要重出，另两样一起重出。

## B. 动新节点之前

- [ ] **B1 备份与回退点的记录**〔2026-10-08 「数据目录不备份」已被取代，见文首〕（都在新节点上，路径见 docs/local.md；`/root/<备份目录>-<日期>` 一类）：
  - 托管服务：`/opt/promptcut-hosted/app`（`deploy-hosted` 会把旧的留成 `server.prev` 一代，但自己再整份拷一份：`cp -a /opt/promptcut-hosted /opt/promptcut-hosted.bak-<日期>`，不含数据目录）、`/opt/promptcut-hosted/pm2.config.cjs`、`~/.pm2/dump.pm2`；
  - 在线页面：`/opt/promptcut-hosted/editor`（整份拷到 `/opt/promptcut-hosted/.editor-backups/editor-0.7.17-<日期>`，上一次换页面时同样做过）；
  - nginx：`cp -a /etc/nginx /root/nginx-backup-<日期>`；
  - 数据目录**不动、不备份整份**（3 GB 级）；只在重启托管服务前后各记一份项目版本盘点（B3）。
- [ ] **B2 同一提交的预检（本机）。**
  - 在线构建与 `<SHA>` 对应：`npx vite build --mode online --outDir <目录>` 之前确认工作区干净、`git rev-parse HEAD` 就是 `<SHA>`；
  - 托管服务的部署清单把新增文件都带上了：`node scripts/remote/docservice.mjs stage-hosted <临时目录>`，数一数 `server/auth/`、`server/docservice/`、`server/hosting/`、`server/asset-store/` 下第三、四段新增的文件（`service-identity.mjs`、`service-client.mjs`、`delegation.mjs`、`service-gate.mjs`、`modules/hosted.mjs`、`asset-store/service-usage.mjs` 等）都在；再用这个暂存目录在本机起一次托管组合、`/healthz` 回 200（上一次部署前做过同样的预检）；
  - 渲染服务与 Agent 服务各自 `--dry-run` 一遍，读脚本里的路径、用户、端口。
- [ ] **B3 项目版本盘点（重启托管服务前后各一次）。** 管理接口只经 SSH 转发，集群令牌在服务器上读进本机进程的环境变量，不落盘、不打印（照 `hosting-migration.md` 第 2 节「M8 演练的实际命令」第 2 步）：
  ```
  ssh -N -L 18787:127.0.0.1:8787 -L 18788:127.0.0.1:8788 "$PROMPTCUT_REMOTE"      # 另开终端挂着
  export PROMPTCUT_CLUSTER_TOKEN=$(ssh "$PROMPTCUT_REMOTE" 'tr -d "\r\n" < <托管数据目录>/secrets/cluster-token')
  node scripts/probes/shared-project-probe.mjs --role inventory --hosted http://127.0.0.1:18787 --asset http://127.0.0.1:18788 --out work/four-stage/final/inventory-before.json
  ```
  重启后：`node scripts/probes/shared-project-probe.mjs --role migrate-check --from-inventory work/four-stage/final/inventory-before.json --to http://127.0.0.1:18787 --to-asset http://127.0.0.1:18788 --sample 100`，要 `ok: true`、各项目 `projectRev`「相等」计数 = 项目数（不归零、不落后）。
- [ ] **B4 等写入停止〔2026-10-08 这三个版本不以此为停点，见文首〕（只读，用户桌面上的 5210 可能在往放在新节点上的项目里写）。** 用 `scripts/acceptance/wait-writes-quiet.mjs`（只发 `GET http://127.0.0.1:5210/api/agent/status` 与 `GET http://127.0.0.1:5210/api/media/upload-queue` 两个请求，别的路径代码里就拒绝，只许回环地址）：
  ```
  node scripts/acceptance/wait-writes-quiet.mjs --quiet-min 5 --max-hours 3
  ```
  输出每次采样一行与最后的 `RESULT {…}`。退出码 0 = Agent 对话不再提交、项目版本（`link.replica.rev`）与上传队列计数连续 5 分钟不变、队列空闲，才可以重启托管服务；退出码 3 = 等满 3 小时仍在写，**停下告诉用户，不要重启**。5210 连不上（桌面版没开）时按「没有桌面端在写」退出 0，结论里会写明——但别处的成员看不到，重启前仍要告知用户。**只在 C3 重启托管服务之前跑；C1、C2、C4、C5 的静态与独立进程操作不用等。** 等的时候先做别的步骤。
- [ ] **B5 用户要做的事清单**（会话不做、写命令给用户）：装补丁（A4）；模型 Key 的加密（C5）；有 systemd 的节点上 `pm2 startup` 打印的那条 `systemctl` 命令若会话没有权限执行时由用户执行；防火墙/安全组不改——本次所有新进程只绑回环、对外只经 nginx 的 443，不需要放行新端口。

## C. 部署（按这个顺序）

### C1 先改 nginx（舞台的策略头与 `/media-s/` 路由、`/agent/` 路由）

- **做什么。** 第二段要的两个策略片段、两份站点配置里的 `/media-s/` 与 `/editor/stage.html` 等路由，加第四段的 `/agent/` 路由。**先改 nginx 再换页面**（旧页面在新 nginx 下照常；新页面在旧 nginx 下不会裸奔，但舞台自检认响应头、会判「没有隔离」，本页不执行用户卡与图卡，见 `server/hosted/deploy/README.md`「在线执行用户卡与图卡的隔离」）。
- **命令。**
  1. 本机：`node scripts/gen-stage-policy-nginx.mjs --check`（不一致就不带去，重新生成）；
  2. 把 `server/hosted/deploy/` 里的 `nginx-snippet-promptcut-stage-headers.conf` → `/etc/nginx/snippets/promptcut-stage-headers.conf`、`nginx-snippet-promptcut-editor-policy.conf` → `/etc/nginx/snippets/promptcut-editor-policy.conf`，把 `{{DOMAIN}}`（`<IP 换成短横线>.sslip.io`）与 `{{BIND_ADDR}}`（节点公网地址）换成本节点的值；
  3. 两份站点配置 `nginx-site-promptcut.conf`、`nginx-site-promptcut-stages.conf` 同样替换占位符后，**和现有的 `/etc/nginx/sites-available/promptcut`、`promptcut-stages` 逐段 diff**（现有的是 2026-10-06 部署时从模板来的，别把节点上后来手工改过的东西盖掉）；
  4. 第四段：`nginx-location-agent.conf` 的那一段放进**主站** `server` 块（与 `/hosted`、`/media` 并排；两个舞台源的 `server` 块**不加**，舞台里跑的是卡片代码，不该够得着 Agent 服务），替换 `{{BIND_ADDR}}`、`{{AGENT_PORT}}`（缺省 8790）；
  5. `nginx -t`，**通过再** `systemctl reload nginx`（不重启托管服务）。
- **备份。** B1 的 nginx 整份备份。
- **核对**（README 里写的四条，都对着真地址）：
  - `curl -sI https://s1.<域名>/editor/stage.html`：有 `Content-Security-Policy`（含 `frame-ancestors https://<域名>`）与 `Connection-Allowlist`；页面还没换时 `stage.html` 可能 404，这条放到 C2 之后核；
  - `curl -sI https://s1.<域名>/editor/_iso/ok` 是 204，`/editor/_iso/redirect` 是 302；
  - `curl -s -o /dev/null -w '%{http_code}' -X POST https://s1.<域名>/media-s/0123456789abcdef0123456789abcdef/_grant` 是 403（没有主站的 `Origin`）；
  - `curl -sI https://<域名>/editor` 有 `frame-src`；
  - `curl -s -o /dev/null -w '%{http_code}' https://<域名>/agent/healthz`：Agent 服务还没起时 502 是正常的，C5 之后再核；
  - 旧页面在新 nginx 下照常打开：无头 Chrome 打开 `https://<域名>/editor`，页面错误 0、失败请求 0。
- **最可能出问题的地方（模板没在真 nginx 上验过，只在本机仿 nginx 的代理 `scripts/probes/lib/hosted-proxy.mjs` 上验过）：**
  1. **nginx 1.18 是节点上的版本**（Ubuntu 22.04 的包，比阿里云的 1.24 老）：`map` 里带命名捕获的正则、`if` 里只放 `return`、`add_header … always` 这些都在 1.18 支持，但**逐字逐句 `nginx -t` 一遍比相信模板更可靠**；
  2. **`add_header` 不跨层继承**：location 里只要有一条 `add_header`，server 层的就一条都不继承——模板因此在每个 location 里 `include` 片段。手工合并配置时漏掉一个 location，那个 location 的响应就没有策略头；核对时对 `/editor/assets/…`、`/catalog/…`、`/media`、404 的 `location /` 各 `curl -sI` 一次；
  3. **`Connection-Allowlist` 与 CSP 里的 `webrtc 'block'`**：前者是较新的响应头，nginx 只是原样发出；浏览器是否认由浏览器版本决定（Chrome 152、154 本机实测拦得住 WebRTC，别的浏览器靠页面里的脚本加固，不是浏览器的保证）；
  4. **`/media-s/<会话号>/_grant` 换 cookie**：`Set-Cookie` 带 `Secure; SameSite=Strict`，只在 https 的真实域名上才发得出来；本机仿 nginx 用 `*.localhost` 验的，**真域名 `s1.<域名>` 与主站是同站跨源，cookie 的 `Path`、`SameSite`、第三方 cookie 限制要在真浏览器里验一遍**（D 节第二段实测的第一条）；
  5. **`proxy_bind {{BIND_ADDR}}`**：节点没有内网地址，用公网地址；填错会 502；
  6. **主站 `server` 块与舞台 `server` 块的 `/agent/`**：别加到舞台块里（见上）。
- **不过怎么退。** `nginx -t` 不过：不 reload，改配置或恢复 B1 的备份；reload 之后核对不过：把备份的 `sites-available/*` 与 `snippets/` 放回去、`nginx -t`、reload；整个 nginx 目录有备份，页面与托管服务此时都没动过，退回没有副作用。

### C2 换在线页面（备份旧的；核验三个源）

- **做什么。** 只换静态页面，**不重启托管服务**：同一个提交 `<SHA>` 的在线构建。
- **构建前（K：诊断报告的收集端配置核对，只核变量名与是否有值，不写值）。** 在线构建把 `VITE_DIAG_SUBMIT_URL`、`VITE_DIAG_SUBMIT_TOKEN` 内联进页面脚本（`src/ai/reportSubmit.ts`；它们取自构建机根目录 `.env.local`，已被 .gitignore 忽略）：
  - `.env.local` 里这两个变量都在、都不为空（只看有没有）；
  - 构建后在 `dist-online/assets/*.js` 里查收集端的域名有没有被内联（`grep -l "workers.dev" dist-online/assets/*.js` 一类；**不要**打印提交令牌，更不要把它贴进对话）；没内联：「报告」按钮会灰着、写「还没配收报告的地址」，要回去补 `.env.local` 重新构建；
  - 收集端本身（Cloudflare Worker，`tools/report-worker/`）的 `SUBMIT_TOKEN` 与前端这份一致由用户核对，会话不读它。
- **命令。**
  1. `npx vite build --mode online --outDir <目录>`（本机）；
  2. 上传与换代用上一次的办法（`REPORT-cloud-node-deploy.md` 第 2 节）：本机用 `server/hosted/deploy.mjs` 的 `stageEditorBuild` 生成预压缩 `.gz`，拷成部署目录下的 `.incoming-editor`，在节点上只跑 `editorSwapLines()` 那几行（先整份备份旧的 `editor/`、保留上一代 `assets/`、**保留 `runtime-config.json`**）；**不要用 `deploy-hosted`**（它会换应用目录并重载 PM2，那是 C3 的事）。
  3. 看 `runtime-config.json`：`stageOrigins` 两个舞台源还在；**不要出现 `"onlineCardExec": false`**（那是第二段的总开关，写 false 就整体退回不执行用户卡与图卡）。
- **备份。** B1 的 `editor/` 整份备份。
- **核对。**
  - 三个源（主站、s1、s2）`/editor` 都 200、带 `Origin-Agent-Cluster: ?1` 与 `no-store`，主脚本**相同**、`Content-Encoding: gzip` 带 `Content-Length`、不分块、解压后 SHA-256 三个源一致；`/editor/stage.html` 在 s1、s2 上 200 且带 CSP（C1 里留到这里核的那条）；
  - **内嵌的代码版本与桌面 0.7.18 一致**：页面里的 `__PC_CODE_VERSION__` 是构建时按 `server/frame-code.mjs` 的 `frameCode` 算的，用 `<SHA>` 在本机算一遍对照；
  - 无头 Chrome 打开主站 `/editor`：页面错误 0、失败请求 0、4xx/5xx 0；
  - 舞台自检：在线页面的运行状态报「舞台已隔离」（C1 的响应头生效）——在页面里新建测试房间后看第二段探针的前提断言思路（D 节）。
- **不过怎么退。** 把 B1 备份的 `editor/` 换回去（`mv` 两次）；托管服务没动，退回无副作用。页面退回时 C1 的 nginx 可以留着（旧页面在新 nginx 下照常）。

### C3 重部署托管服务（第三、四段改了文档服务与素材服务，必须重部署）

第三段、第四段对文档服务与素材服务的改动（服务身份与登记表 `service-identity.mjs`/`service-gate.mjs`、委托与对话委托 `delegation.mjs`、握手 `handshake.mjs`、成员列表下发 `modules/hosted.mjs`、渲染服务产物的容量记账 `asset-store/service-usage.mjs`）只有重部署才生效。

- **做什么。** 先 **B4 等写入停止**；再 `deploy-hosted`，换应用目录并重载 PM2：
  ```
  node scripts/remote/docservice.mjs deploy-hosted --save \
    --doc-public-url wss://<域名>/hosted/ --asset-public-url https://<域名>/media/api/asset \
    --stage-origins https://s1.<域名>,https://s2.<域名>
  ```
  不带 `--editor`（页面 C2 已经换了；带了会再换一遍并重写 `runtime-config.json`）；不带 `--write-token`（集群令牌在节点上已经有）。命令里的参数与上一次部署一致，取值见 docs/local.md。**先 `status-hosted` 看现状，再部署。**
- **重启之后马上再设（防止被冲掉）。** `deploy-hosted` 每次重新生成 `pm2.config.cjs`，里面**没有** `PROMPTCUT_AGENT_PUBLIC_URL`（C5 要手工加）与 `PROMPTCUT_HOSTED_RENDER_CAP_BYTES`（可选，渲染服务产物容量上限，缺省 `min(20 GiB, 数据盘四分之一)`）；所以 **C3 要在 C5 的第 4 步之前做完，而且以后每次 `deploy-hosted` 之后都要把这两个环境变量加回去**（这是流程上的一个坑，合流后若 `deploy-hosted` 增加了对应参数就改用参数）〔待合流核对〕。
- **备份。** B1 的托管服务备份与 `pm2.config.cjs`；`deploy-hosted` 自己留 `server.prev` 一代。
- **核对。**
  - 记下**中断时长**（`pm2 reload` 到 `/healthz` 通；本次预期是秒级到十几秒，换机那次停服务到转发生效 72.2 秒是另一回事）；
  - `/hosted/healthz`、`/hosted/hosting/healthz`、`/media/healthz` 都 200；
  - 重启前后各项目版本号不变：B3 的 `migrate-check --from-inventory` 要 `ok: true`；
  - 在线页面（C2 已换）重新进一个测试房间能加入、能改。
- **不过怎么退。** 先停渲染与 Agent（此时还没部署，没有）；把 B1 备份的应用目录与 `pm2.config.cjs` 放回、`pm2 startOrReload` 一遍；`/healthz` 通、版本号与 B3 一致才算退回。数据目录没被动过。

### C4 部署渲染服务

命令与顺序取自 `server/hosted/deploy/README.md`「渲染服务」一节（第三段分支上；〔待合流核对〕）。**与在线页面出自同一个提交**，否则它一个任务也认领不了、队列也不报错。

- [ ] 1. `node scripts/remote/docservice.mjs install-render --dry-run` 看脚本，再不带 `--dry-run` 跑：装中文字体 `fonts-noto-cjk`、`fonts-noto-color-emoji`、`fonts-liberation`、`ffmpeg`、Chrome 的运行库，建系统用户 `promptcut-render` 与目录，写 `promptcut-render.slice`（systemd 资源组）。
- [ ] 2. `node scripts/remote/docservice.mjs deploy-render --commit <SHA> --no-start`：把仓库在 `<SHA>` 的内容 `git archive` 传到 `/opt/promptcut-render/releases/<提交前 12 位>/`，远端 `npm ci`、`npx puppeteer browsers install chrome-headless-shell`（**必须是 chrome-headless-shell，不能用系统的 Chrome/Chromium**；版本由锁定的 puppeteer 决定，本仓库当前是 152.0.7977.75；**不要设 `PUPPETEER_EXECUTABLE_PATH`**），换 `current` 链接，写 PM2 配置，不起进程。`npm ci` 要编译原生模块才加 `install-render --with-build-tools`。
- [ ] 3. `node scripts/remote/docservice.mjs keygen-render`：在节点上生成服务私钥（`/var/lib/promptcut/render-secrets/service-key.json`，0600，不离开节点、不打印），公钥原子追加进托管数据目录的 `secrets/services.json`，文档服务按文件修改时刻重读、不用重启托管服务。`keygen-render --list` 核对登记表里有一把 `render`。托管数据目录是上一次从阿里云整份搬来的：若里面有旧的服务公钥，`--retire` 撤掉。
- [ ] 4. `node scripts/remote/docservice.mjs deploy-render --commit <SHA> --save`：用新发布目录跑 `server/hosted-render/main.mjs --check`（Node 版本、私钥、数据目录、Chrome 能否启动、能否照工作进程的办法开页并出一帧、中文字体、ffmpeg、控制连接握手），**自检过了才换 `current` 并 `pm2 startOrReload`**；退出码 78 = 自检不过、什么都不换，看输出里的 `selfcheck.error`。`--save`：`pm2 save`，并在没装时装 `pm2-root.service`（开机自启）。
- [ ] 5. `node scripts/remote/docservice.mjs status-render`：PM2 在线；诊断口 `codeVersion` 的渲染服务与在线页面**并排且一致**（不一致标红）；资源组有上限（内存 `MemoryMax`/`MemoryHigh`、`CPUQuota` 缺省 6G/5G/400%）；产物容量记账文件在（`<托管数据目录>/assets/.service-usage/render.ndjson`）。
- [ ] 6. 开机自启：`systemctl is-enabled pm2-root` 应是 `enabled`，`pm2 resurrect && pm2 list` 里有 `promptcut-render`（和 `promptcut-hosted`）。**真重启节点会中断托管服务，要用户在场授权；不授权就只核对这三条，D 节「节点重启后自动起来」一行记「待用户授权」。**
- **备份。** 无需（新进程、新目录）；PM2 存档 `~/.pm2/dump.pm2` 在 B1 已备份。
- **不过怎么退。** `node scripts/remote/docservice.mjs stop-render`（`pm2 stop` 并 `pm2 save`；托管服务不动，项目照常用，只是没有云节点预渲染）；升级后有问题用 `rollback-render`（`current` 换回 `.previous` 再重载）。

### C5 部署 Agent 服务

命令与顺序取自 README「Agent 服务」一节（第四段分支上；〔待合流核对〕）。Agent 服务不单独上传代码：用 C4 放上去的那份检出，**三者同一个提交**。

- [ ] 1. `node scripts/remote/docservice.mjs deploy-agent --dry-run`，再 `deploy-agent --no-start`：建数据目录 `/var/lib/promptcut/agent`（0700）与私钥目录、写 PM2 配置，不起进程。
- [ ] 2. `node scripts/remote/docservice.mjs keygen-agent`：给服务名 `agent` 生成密钥并登记公钥（私钥不离开节点）；`keygen-agent --list` 看到一把 `agent`。
- [ ] 3. 托管服务的环境里加 `PROMPTCUT_AGENT_PUBLIC_URL=https://<域名>/agent/v1`（文档服务经成员列表把这个地址下发给页面；不设时页面不出「云端」一项），改完 `pm2 startOrReload promptcut-hosted --update-env`——**这是重启托管服务，要先 B4 等写入停止**；与 C3 相邻时合并成一次重启（C3 之后立刻加这一项、一起 reload），中断时长记一次。
- [ ] 4. nginx 主站 `server` 块里已经在 C1 加了 `/agent/`；这里 `curl -s -o /dev/null -w '%{http_code}' https://<域名>/agent/healthz` 等 Agent 服务起来后应 200。
- [ ] 5. **先用模拟模型提供方验**（Key 还没导入时）：`cd /opt/promptcut-render/current && PROMPTCUT_AGENT_DATA=/var/lib/promptcut/agent node server/agent-service/set-key.mjs --mock`（切到模拟模型，不调用任何真实模型）；然后 `node scripts/remote/docservice.mjs deploy-agent`（正式启动，等 `/healthz`）、`status-agent`（PM2 在线、与渲染服务**代码版本并排一致**、数据目录、有没有配模型——不读 Key）；确认无误后 `deploy-agent --save`（`pm2 save`，节点重启后自启）。
- [ ] 6. 用模拟模型把 D 节的 Agent 实测先跑一遍（隔离、端到端、额度接口）。
- [ ] 7. **模型 Key 的加密分发（F 条，2026-10-07 用户定）。Key 的明文只经用户自己的手，会话全程只接触密文，不向用户要明文。**
  1. **节点报出自己的机器识别码。** 识别码由 `server/runners/machine-id.mjs` 的 `machineCode()` 算出（Linux 上取 `/etc/machine-id` 经 SHA-256 摘要后的 `PCM-XXXXX-XXXXX-XXXXX-XXXXX`；它同时是加密口令，所以只对用户展示，不进仓库、不进日志、不写进报告——要写进报告只写 `redactMachineCode` 的首组）。在节点上取：
     ```
     ssh "$PROMPTCUT_REMOTE" 'cd /opt/promptcut-render/current && node -e "import(\"./server/runners/machine-id.mjs\").then(m=>console.log(m.machineCode()))"'
     ```
     注意要用**跑 Agent 服务的那个系统用户**在**那台节点上**取（识别码取自 `/etc/machine-id`，云厂商重装镜像后会变，变了要重做）。
  2. **给用户的步骤原文**（把下面一段原样发给用户）：
     > 我把云节点的「机器识别码」（`PCM-` 开头，四组五位）发给你。请在你自己的电脑上：双击仓库根目录的 `make-api-share.bat`（第一次会自己编译，要装有 Rust 的 `cargo`；没有就告诉我）；在打开的窗口里填模型的厂商、接口地址、模型名和 API Key，**识别码填我给你的这一串**；点「加密」生成一段以 `PC` 开头的密文，把这段密文发给我。**不要把 Key 本身发给我，也不要把 Key 写进任何对话、文件或截图。** 密文只有那台节点能解开，转发给别人也没用。
  3. **会话把密文送到节点导入。** 导入命令〔待第四段补命令〕：节点上读密文、本机解开、用 `server/runners/config-crypt.mjs` 现有的落盘加密（`custom` 一路，机器指纹派生口令）存成 `<数据目录>/config/keys/custom.key`，并更新 `config/ai.json`（厂商、地址、模型清单，不含 Key）。密文经 ssh 标准输入交给节点上的脚本，不上命令行、不回显、不落盘在会话这一侧。
  4. **导入后核对（只核对末四位与能否调通，不打印 Key）。** 导入命令回的「已保存，末四位 ××××」与用户口头确认的末四位一致；`status-agent` 显示「已配模型」；发一条最短的云端对话（测试项目，如「回复 OK」）看模型调通、用量记录里多一条；用 `admin.mjs usage --project <测试项目>` 查得到。验完删测试项目。
  5. 之后用**真实模型**跑 D 节标「真实模型」的三行。
- [ ] 8. **Agent 服务的运行条件检查项（J 条：云端 Agent 的工具与本机一致）。** 逐项写「节点上有没有、没有怎么装、装不了记未达成」；这一块第四段还在返工，命令细节留占位〔待第四段返工完成后补〕，依赖清单取自 main 上现有的桌面版：

  | # | 工具类 | 要什么（来源） | 节点上有没有 | 没有怎么装 | 装不了 |
  |---|---|---|---|---|---|
  | 1 | 建卡改卡、读写项目、效果、素材引用 | Node 与 Vite 载入工具实现（`server/agent/ssr-host.mjs`）；与渲染服务同一份检出（含依赖） | 有（C4 的 `current`） | — | — |
  | 2 | 看画面（即时渲染，`see_frames`/`query_render`） | `chrome-headless-shell`（与 C4 同一份缓存目录，或 Agent 服务另备）、中文字体、`ffmpeg` | C4 装的是渲染服务用户的缓存目录，**Agent 服务用户能不能读它要核**〔待第四段补〕 | 复用 C4 的 `PUPPETEER_CACHE_DIR` 或为 Agent 服务再装一份 | 记未达成：看画面 |
  | 3 | 语音转文字（`promptcut_stt`） | Python 3（**本体只依赖标准库加 numpy**，`python/README.md`；`asset-path-probe` 的 P7～P11 也要带 numpy 的 Python）+ `PROMPTCUT_PYLIBS` 里的 `faster-whisper`、`ctranslate2`、`onnxruntime`、`av`、`huggingface-hub`、`tokenizers`（`python/requirements-faster-whisper.txt`）；模型按需下载（`PROMPTCUT_MODELS`，small / large-v3，**节点要能出网访问模型仓库，或预先放好**） | 节点有系统 `python3`（REPORT-cloud-node-deploy 1.1 节：已装 python3），没有这些库与模型 | 建 venv、`pip install -r python/requirements-faster-whisper.txt --target $PROMPTCUT_PYLIBS`；模型预下载到 `$PROMPTCUT_MODELS`〔命令待第四段补〕 | 记未达成：语音转文字 |
  | 4 | 镜头切换识别（`promptcut_shots`） | `onnxruntime` + `transnetv2.onnx`（29.6 MB，来源见 `tools/transnetv2/README.md`） | 没有 | 装 wheel（`light` 档的 5 个 wheel 共 26 MB）、拷模型 | 记未达成 |
  | 5 | 主体检测 light 档（`promptcut_subject`） | `onnxruntime` + `yunet.onnx`、`rtdetr_r18vd.onnx`（共 77.5 MB，来源见 `tools/subject/README.md`） | 没有 | 同上 | 记未达成 |
  | 6 | 主体检测 full 档、运动追踪（`promptcut_subject`、`promptcut_track`） | `torch`、`transformers`、`bootstapir_v2.pt`、`grounding-dino-tiny/`（`full` 档：wheel 34 个 177 MB，模型再多约 870 MB；torch 默认 PyPI 轮子带 CUDA 约 2.5 GB，节点无 GPU，用 CPU 索引） | 没有；节点 8 核 16 GB、无 GPU、系统盘 39 GB + 数据盘 40 GB | 装 CPU 版 torch 与模型（放数据盘 `/home`）；运行内存要进 Agent 服务的内存上限预算 | 记未达成：运动追踪、开放词汇主体检测 |
  | 7 | 网页采集（`promptcut_collect`，yt-dlp） | `yt-dlp` 纯 Python 轮子、`ffmpeg`；采集到的视频经素材服务入库，不落在节点上共享目录 | 没有 yt-dlp；ffmpeg 有（C4） | `pip install yt-dlp` 到 `$PROMPTCUT_PYLIBS` | 记未达成 |
  | 8 | 配音（`voice_generate`，服务商 `minimax` / `kling` / `vidu`，`server/voice/`） | 托管方的配音配置（服务商、接口地址、网关令牌，令牌按 `config-crypt.mjs` 的 `voice` 一路落盘）；节点出网到服务商域名；用量记进 G 的用量记录（隔离验收新增第三条） | 没有配置 | 令牌也走加密分发（同 F 条的办法，用户加密、会话导入）〔命令待第四段补〕 | 记未达成：配音 |
  | 9 | 出网限制（隔离验收新增第二条） | 能发网络请求的工具（采集、下载、配音）不能访问节点的回环地址、内网地址、同机别的服务的接口 | 待第四段实现 | 实现方式〔待第四段补〕 | 若做不到，**不开放这些工具并记未达成**，不带着风险上线 |

  - **出网限制怎么核对（节点上的实测，不靠推断）：** 在节点上起一个测试项目的云端对话，让网页采集/下载类工具分别请求：`http://127.0.0.1:8787/healthz`、`http://127.0.0.1:8788/healthz`、渲染服务诊断口 `http://127.0.0.1:5399/status`（缺省，见 README）、Agent 服务自己的端口、`http://169.254.169.254/`（云厂商元数据）、节点内网网段地址，以及一个会 302 重定向到上述地址的外部地址、一个解析到回环的域名（DNS 重绑定）；每一个都要被拒并给出明确原因，且访问日志里这些服务一个请求都没收到。
  - **每项工具的「有没有」怎么核：** 在节点上 `cd /opt/promptcut-render/current` 用 Agent 服务的系统用户跑 `python3 -I -c "import sys,runpy; sys.path.insert(0,'python'); runpy.run_module('promptcut_stt', run_name='__main__', alter_sys=True)" status`（`promptcut_shots`、`promptcut_subject`、`promptcut_track`、`promptcut_collect` 各一遍；输出的 `installed`、`pylibs`、CUDA 等如实报告）；`ffmpeg -version`；`ls $PROMPTCUT_MODELS`。

- **备份。** 无需（新进程、新目录）；托管服务环境变量改动前备份 `pm2.config.cjs`（B1）。
- **不过怎么退。** `stop-agent`（托管服务与渲染服务不动；页面的「云端」一项会报连不上）；要让页面不出「云端」一项：去掉托管服务的 `PROMPTCUT_AGENT_PUBLIC_URL` 并重启（要等写入停止），或 `keygen-agent --retire <kid>` 撤公钥；在线页面退回上一版（C2 的备份）；Key 有问题：`set-key.mjs --clear` 删掉。

### 先决条件：渲染服务、Agent 服务、在线页面必须出自同一个提交

怎么核对（每次部署与升级之后都做）：

1. 本机：`git rev-parse HEAD`（`<SHA>`）。
2. 在线页面：内嵌的 `__PC_CODE_VERSION__`（`frameCode` 的结果）——从页面脚本里取，或看渲染服务诊断口并排显示的「在线页面」一栏。
3. 渲染服务：`status-render` 里 `codeVersion` 一栏（渲染服务、在线页面并排，`match` 应为真，不一致标红）；发布目录名 `releases/<SHA 前 12 位>` 与 `current` 链接指向。
4. Agent 服务：`status-agent` 里与渲染服务的代码版本并排（不一致标红）；它用的就是 `current` 那份检出。
5. 不一致的后果：渲染服务一个任务也不认领、队列也不报错；Agent 服务发布的补渲计划没有渲染节点认领、在线页面按另一个代码版本找预渲染结果找不到。管理进程每 5 分钟比一次，不一致会打 `selfcheck.warn { reason: 'code-version' }`。

## D. 真实网络验证：每部署一样之后，在新节点上做的实测

这一节就是验证的第二级（`verification.md`「本地验证与真实网络验证」）。**只在往节点部署时做，部署完跑一遍；不部署就不做。** 只改到网络这一层（连接、重连、中继、票据、nginx 配置、部署脚本）而不重新部署全部服务时，做 D0 里与改动有关的那几行。它只验真网络才有的东西：nginx 与证书、延迟与断线重连、部署出来的几样服务是不是同一个提交、节点环境缺不缺东西，以及任务书点名要在节点上走通的体验验收；功能对不对已经由本地验证（A1）验过，这里不重复判。

### D0 照着执行的清单（与验收清单的 16 项「真实网络验证」逐项对应）

先把这 16 项打出来、建一份空的结果记录（脚本不上节点，只把每项记成「在节点上做」）：

```
node scripts/acceptance/four-stage-acceptance.mjs --list --level network
node scripts/acceptance/four-stage-acceptance.mjs --level network --out work/four-stage/node/<时间戳>
```

然后按部署顺序逐条做、逐条打勾。每条写：清单编号、做什么、用哪条命令或下面 D1 表的哪一行、过的标准。全部用测试房间与测试凭证，验完删掉；重启托管服务之前先 B4。不过的那一样照 E 节退，其余保留，写明原因、告诉用户。

**C1（改 nginx）之后**

- [ ] **S2-r1** 舞台策略头、`/media-s/` 路由、证书。C1「核对」的 `curl` 各条逐条跑（`stage.html` 那一条等 C2 之后补）；`curl -sI https://<域名>/editor` 看证书链没有报错、`openssl s_client -connect <域名>:443 -servername <域名> </dev/null 2>/dev/null | openssl x509 -noout -dates` 记到期日（主站与 s1、s2 各一次）。过：响应码与响应头与 C1 写的一致；证书在有效期内。

**C2（换在线页面）之前与之后**

- [ ] **S4-r7**（之前）在线构建里诊断报告收集端的配置：C2「构建前」三条。过：两个变量都有值、收集端域名被内联；不打印令牌。
- [ ] **S1-r2** 页面换成与桌面同一提交：C2「核对」四条。过：三个源主脚本相同、`__PC_CODE_VERSION__` 与 `<SHA>` 算出来的一致、无头打开页面错误 0、失败请求 0。
- [ ] **S2-r1**（补）`curl -sI https://s1.<域名>/editor/stage.html` 带 CSP 与 `Connection-Allowlist`；页面里新建测试房间，运行状态报「舞台已隔离」；`_grant` 的 cookie 在真 Chrome 里发得出来。
- [ ] **S1-r3** 在线合成与在线导出：D1 表「R4、R5」一行。过：导出的成片有声、位置对齐、取消不留半截。
- [ ] **S4-r7**（之后）在新节点的在线页面里点一次「报告」，收集端收到一份、再删掉。
- [ ] 清单外·延迟与断线重连：无头 Chrome 以成员身份进测试房间，记加入用时与一次编辑到另一成员看到的用时（只记录）；在服务器侧断那条 TCP（不动宿主机网络，`constraints.md`），页面顶栏先显示断开、之后自动重连、重连后改动不丢。

**C3（重部署托管服务）之后**

- [ ] 清单外·R22 中断时长与版本号：D1 表「R22」一行。过：三个 `/healthz` 200、B3 的 `migrate-check --from-inventory` 回 `ok: true`；中断时长记进总报告。

**C4（部署渲染服务）之后**

- [ ] **S3-r1** 渲染服务部署本身：C4 第 1～6 步逐步做完。过：`deploy-render --save` 的自检过（退出码不是 78）、`status-render` 里 PM2 在线、资源组有上限、`pm2-root` 是 `enabled`。
- [ ] 清单外·同一个提交：「先决条件」一节第 1～4 条。过：在线页面、渲染服务的 `codeVersion` 并排一致（Agent 服务在 C5 之后再核一次）。
- [ ] 清单外·节点环境缺不缺东西：`deploy-render` 自检的输出逐项看（Node 版本、Chrome 能否启动并出一帧、中文字体、ffmpeg）；缺的记下来。
- [ ] **S3-r2** 低内存档的补渲被云节点认领、产物贴上：D1 表「R23 第 1 点」一行。
- [ ] **S3-r3** 在线普通档判重的层交给云节点渲：D1 表「R23 第 2 点」一行（`c10-browser-probe --site https://<域名> --no-host --only-a4`）。
- [ ] **S3-r4** 用户卡与图卡的任务它能渲，越权探测卡读不到：D1 表「R23 第 3 点」一行。**核心项**，不过就停掉渲染服务。
- [ ] **S3-r5** 新建项目自动接活、关开关后不接、删项目后断开、用它的身份编辑被拒：D1 表「R23 第 4 点」「R23 第 5 点」两行。
- [ ] **S3-r6** 进程被杀自动拉起；节点重启后自动起来（重启要用户在场授权，不授权只核对 C4 第 6 步的三条并记「待用户授权」）：D1 表「R23 第 6 点」一行。
- [ ] **S3-r7** 满载时文档服务响应与素材下载速度前后对比、资源上限生效：D1 表「R23 第 7、8 点」一行。数字只记录；判的是上限确实生效（`worker.exit` 的 reason `oom`、`render.degraded`）。

**C5（部署 Agent 服务）之后**

- [ ] **S4-r1** Agent 服务部署并用模拟模型实测：C5 第 1～6 步；D1 表「C5 之后（模拟模型）」的六行（隔离 C4 与 C4a～C4c、端到端 C6、额度 C7、资源 C9、诊断报告 K1）。隔离是**核心项**，任何一条不过就停 Agent 服务。
- [ ] 清单外·同一个提交：`status-agent` 里与渲染服务的代码版本并排一致。
- [ ] 清单外·节点环境缺不缺东西：C5 第 8 步的运行条件表逐项填「有没有」，做不了的工具逐项记未达成。
- [ ] **S4-r2** 「关掉软件照常运转」用真实部署走通：D1 表「C8b、U1～U6」一行的做法，先用模拟模型走一遍。
- [ ] （导入 Key 之后）**S4-r4** 真实模型的端到端：D1 表「C8、C8a」一行。
- [ ] （导入 Key 之后）**S4-r5** 真实模型下「关掉软件照常运转」六条：D1 表「C8b、U1～U6」一行。
- [ ] （导入 Key 之后）**S4-r6** 真实模型走示例句：D1 表「C8c」一行。

**做完之后**

- [ ] 把 16 项各自的结果（过 / 不过 / 未达成与原因、证据路径）填进总报告；测试房间、邀请码、测试成员都删掉；F 节的清单记进本机 `docs/local.md`。

### D1 各项怎么验（D0 引用的表）

全部用**测试房间与测试凭证**，验完删掉（项目、邀请码、测试成员）；探针对着真地址跑，不写令牌、口令进命令行（用环境变量或探针自己生成的一次性凭证）。「探针」列写的是仓库里现有或分支上已有的探针；探针原本只对本机替身的，写明「改对真地址的办法」。

| 部署之后 | 任务书条目 | 实测什么 | 用什么 | 指向 | 备注 |
|---|---|---|---|---|---|
| C1 之后 | 第二段 R19 后半 | nginx 策略头、`/media-s/`、舞台自检 | `curl` 四条（C1 核对）；页面换版后无头打开看舞台「已隔离」；`online-card-security-probe` 的 A1 前提断言思路 | `https://<域名>`、`s1.`、`s2.` | 真域名上 `_grant` 的 cookie 要在真 Chrome 里验 |
| C2 之后 | R10 | 三个源主脚本相同、代码版本与桌面 0.7.18 一致、无页面错误 | 本文 C2 核对；`c10a-demo-probe --site https://<域名>`（上一次换页面时用过） | 真地址 | 第 1～6 步全走完；测试项目验完删 |
| C2 之后 | R4、R5（在线一半） | 在线合成与在线导出有声、位置对齐、取消不留半截 | `sound-ab-probe` 的在线段思路；对真地址：创建者桌面版建放云端的测试项目，无头 Chrome 以成员身份加入，放内置提示音、键盘声、有声卡，直接导出，量音轨 | 真地址 | `sound-ab-probe` 是本机替身，要对新节点需改写成 `--site` 形态〔待补〕；或手工按清单做 |
| C2 之后 | R15（第二段功能的真实路径） | 在线浏览器直接画出用户卡、图卡，判重走预渲染 | `online-card-exec-probe`、`online-card-graph-probe` 同样需改写成对真地址；至少手工放一张用户卡一张图卡，截图 | 真地址 | 本机替身上的版本已在 A1 过 |
| C3 之后 | R22 | 中断时长、各项目版本号前后不变 | B3 的 `migrate-check --from-inventory`；`/healthz` 三个 | SSH 转发的回环端口 | 中断时长贴进总报告 |
| C4 之后 | R23 第 1 点 | 手机仿真低内存档打开含重卡的测试项目，补渲任务被云节点认领、产物贴上 | `c10a-demo-probe --site https://<域名>` 的第 2、3 步（低内存档加入、改重卡参数、贴回新键）；外加看 `status-render` 里认领计数 | 真地址 | 创建者的桌面渲染节点不要开（`--no-host` 思路），好确认是云节点接的 |
| C4 之后 | R23 第 2 点 | 在线普通档判重的层交给云节点，结果贴回 | `c10-browser-probe --site https://<域名> --no-host --only-a4`（外网模式） | 真地址 | A5 记「待外部主机」是正常的；本次要的是云节点接活 |
| C4 之后 | R23 第 3 点（**不因缺夹具退成不接用户卡任务**） | 用户卡、图卡任务它能渲；越权探测卡在隔离工作进程里读不到别的项目的内容与素材、节点上的凭证与令牌、工作进程自己的本机接口、工作目录以外的文件 | 把越权探测卡（`scripts/probes/fixtures/online-card-attacks/`，只含只属于测试的假凭证）放进测试项目，发清单计划让渲染服务渲；取回夹具写的结果对象逐项断言「被拒」 | 真地址 | 探针若只有本机形态，就写一个对真地址的小脚本复用夹具〔待补〕；隔离做不到 = 第三段核心项不过，停掉渲染服务 |
| C4 之后 | R23 第 4 点 | 新建项目不配置就接活；创建者关开关后不接；删项目后断开 | `hosted-render-probe` 的 `work`、`switch`、`delete` 三步的断言思路，手工对真地址做：新建测试项目看 `status-render` 诊断口出现这个项目、项目设置里关「托管方的渲染节点」再发计划确认不认领、删项目后确认断开 | 真地址 | 成员列表里应有「托管方的渲染节点」一行 |
| C4 之后 | R23 第 5 点 | 用它的身份提交一次编辑被拒 | `hosted-render-probe` 的 `forbidden` 步思路 | 真地址 | 项目版本号不变 |
| C4 之后 | R23 第 6 点 | 进程被杀自动拉起恢复接活；节点重启后自动起来 | `ssh "$PROMPTCUT_REMOTE" 'pm2 pid promptcut-render'` 然后只结束管理进程，等 pm2 拉起，再发一个计划做完；重启节点要用户授权（C4 第 6 步） | 真节点 | 重启会中断托管服务，先 B4 |
| C4 之后 | R23 第 7、8 点 | 满载渲染时文档服务响应与素材下载速度前后对比；资源上限生效 | 空闲与满载各量 `/healthz` 往返（每次 20 次取中位数、p95）与一个固定素材的下载速度，写数字；把并发或内存上限调小一档观察超限表现（`worker.exit` 的 reason `oom`、降并发 `render.degraded`） | 真节点 | 改上限用 `PROMPTCUT_RENDER_*` 环境变量重新 `deploy-render`，测完调回 |
| C5 之后（模拟模型） | C4 | 隔离：甲读不到乙的项目、改不了；一个项目的对话拿不到另一个项目的内容、素材、对话记录；伪造或过期的身份证明被拒；只读成员改不了；创建者关开关后对话被停 | `cloud-agent-auth-probe`、`cloud-agent-isolation-probe` 的断言思路，对真地址；这两个探针起的是本机整套，对新节点需改写成只用真地址的版本〔待补〕；更稳的是在新节点上用两个测试项目、三个测试成员手工逐条验并截图 | 真地址 | 核心项；任何一条不过：停 Agent 服务 |
| C5 之后（模拟模型） | C4a、C4b、C4c（2026-10-07 新增） | 工具读写按项目隔离；出网工具不能访问回环、内网、同机服务；配音记进用量 | 第四段补的探针与上面 C5 第 8 步的出网限制核对 | 真节点 | 命令待第四段补 |
| C5 之后（模拟模型） | C6 | 端到端：桌面版建协作项目放云端；在线成员在 AI 栏让云端 Agent 改文案、挪片段、调卡片参数；桌面与另一成员都看到、署名「〈成员名〉的云端 Agent」；撤销；两成员同时各开一对话互不串；进程被杀自动拉起、进行中的对话明确报中断可重开 | `cloud-agent-ui-probe` 与 `cloud-agent-ux-ui-probe` 的断言思路，对真地址；被杀自动拉起手工做 | 真地址 | |
| C5 之后（模拟模型） | C7 | 额度接口：把测试项目额度设成很小，超出被明确拒绝并告知原因，设回不限恢复，用量记录查得到项目、成员、模型与用量 | `cloud-agent-run-probe` 的 D 组思路；节点上用 `admin.mjs quota set/clear/show`、`admin.mjs usage` | 真节点 | 改完即生效，不重启 |
| C5 之后（模拟模型） | C9 | 节点资源：Agent 服务有并发与内存上限，满载时同机文档服务响应与素材下载速度前后对比 | 同 C4 的量法，Agent 满载用模拟模型的重脚本发满节点级并发（6 轮） | 真节点 | 数字写进总报告 |
| C5 之后（模拟模型） | K1 | 诊断报告：云端对话出报告，下载与提交；在线页面不经 `/api/*`；不含凭证票据 Key | 页面里点「下载」「报告」；收集端（`report-inbox.bat`）收到后删掉；单测的断言见第四段 | 真地址 | 先核 C2 的收集端配置 |
| C5 导入 Key 之后 | C8、C8a | **真实模型**：第 6 条端到端再走一遍 | 同 C6 一行，模型是真实提供方 | 真地址 | 用量记录里查得到 |
| C5 导入 Key 之后 | C8b、U1～U6 | **真实模型 + 整件事做成的标准**：创建者在桌面版（另用在线浏览器再验一遍）对放云端的项目发一个跑一段时间、改多处、触发重卡重渲的任务；确认被云端接下后**完全退出软件**（桌面连托盘一起退出、浏览器关标签页、电脑不再连着）；云端自己把事做完；另一位成员进项目看到改动一条条出现、署名「〈创建者〉的云端 Agent」、画面是渲好的；创建者重开软件回到同一项目看到完整对话与结果、预渲染在、撤销能撤；中途想停的能停、可在另一台设备接着看；出错不悄悄丢 | `cloud-agent-ux-probe`、`cloud-agent-ux-ui-probe` 是它的本机回归项；**新节点上要用真实部署走通一遍，并有真安装版桌面的连托盘退出**（探针里的「结束进程」是本机等价物） | 真节点 | 样本路径与证据贴进总报告 |
| C5 导入 Key 之后 | C8c | **真实模型**：示例句「为我快速创建一个视频告诉我软件都可以做什么。」走一遍 | 云端 Agent 对放云端的测试项目发这一句，留对话过程、工具调用清单、成片或项目的样子与用量 | 真地址 | 配音、建卡等工具用上了多少，记未达成项 |

## E. 每一样的回退办法（汇总）

| 动了什么 | 回退 | 影响 |
|---|---|---|
| nginx（C1） | 放回 B1 的 `/etc/nginx` 备份，`nginx -t`，reload | 无 |
| 在线页面（C2） | 换回 B1 的 `editor/` 备份；保留 `runtime-config.json` | 页面回到上一版（0.7.17），舞台不再执行用户卡 |
| 托管服务（C3） | 放回应用目录备份与 `pm2.config.cjs`，`pm2 startOrReload`；核对 B3 | 渲染与 Agent 服务此时连不上，要先停 |
| 渲染服务（C4） | `rollback-render` 或 `stop-render`（`--delete` 连登记删） | 项目照常用，没有云节点预渲染 |
| Agent 服务（C5） | `stop-agent`；页面不出「云端」去掉托管服务环境变量重启（等写入停止）；撤公钥 `keygen-agent --retire <kid>`；Key `set-key.mjs --clear` | AI 栏的「云端」一项不可用 |
| 服务私钥 | 撤销 `keygen-render --retire <kid>` / `keygen-agent --retire <kid>`，连接随即被关 | |

## F. 部署后要记进本机 `docs/local.md` 的清单（那个文件不入库，这里只列清单）

- 新节点上多出的进程：`promptcut-render`（PM2；管理进程与工作进程、诊断口端口）、`promptcut-agent`（PM2；端口 8790，只绑回环）；PM2 存档与 `pm2-root.service`；
- 多出的目录：`/opt/promptcut-render/`（`releases/`、`current`、`.previous`、`pm2.config.cjs`）、`/var/lib/promptcut/render`（可重建的缓存）、`/var/lib/promptcut/render-secrets`（私钥，0700）、`/var/lib/promptcut/agent`（对话、模型配置与 Key 密文、用量、额度）、`/var/lib/promptcut/agent-secrets`（私钥，0700）、`/etc/systemd/system/promptcut-render.slice`、`/etc/nginx/snippets/promptcut-*.conf`；
- 多出的系统包与用户：`fonts-noto-cjk`、`fonts-noto-color-emoji`、`fonts-liberation`、`ffmpeg`、Chrome 运行库；系统用户 `promptcut-render`；`chrome-headless-shell` 的版本与位置；Agent 服务用的 Python 环境、`PROMPTCUT_PYLIBS`、`PROMPTCUT_MODELS`（若装了）；
- 备份的位置与保留期：`/root/nginx-backup-<日期>`、`/opt/promptcut-hosted.bak-<日期>`、`/opt/promptcut-hosted/.editor-backups/editor-0.7.17-<日期>`；
- 环境变量名（不写值）：托管服务的 `PROMPTCUT_AGENT_PUBLIC_URL`、`PROMPTCUT_HOSTED_RENDER_CAP_BYTES`；渲染服务的 `PROMPTCUT_RENDER_*` 取值；在线构建的 `VITE_DIAG_SUBMIT_URL`、`VITE_DIAG_SUBMIT_TOKEN`（只记「在 `.env.local`」）；
- 机器识别码只记首组（`redactMachineCode`）；Key 的末四位；
- 本次的提交 `<SHA>`、三者同一提交的核对结果、补丁的大小与 SHA-256、中断时长、各项目版本号前后对照；
- 已知坑：`deploy-hosted` 会冲掉手工加的托管服务环境变量（见 C3）；节点上 nginx 是 1.18；云厂商重装镜像会换 `/etc/machine-id`，Key 要重新分发。

## G. 起草时发现的、最终验收前要先处理的问题

1. `deploy-hosted` 每次重新生成 `pm2.config.cjs`，不带 `PROMPTCUT_AGENT_PUBLIC_URL`（C3、C5）。建议第四段让 `deploy-hosted` 接一个参数，或让 `deploy-agent` 负责把这一项写进去。
2. 第二段新增依赖 `sucrase` 使 0.7.18 补丁会带整份 `node_modules`（A4）：要提前告诉用户补丁变大；若想继续出小补丁，需要另想办法（用户决定）。
3. 第二段的 `online-card-exec-probe`（任务书第 15 条的功能验收）起草时分支上还没有，现在已有（清单 S2-2）；第三、四段的探针是本机整套，对新节点的实测要么改成对真地址的版本，要么手工逐条做（D0 里逐条写了用哪一行的做法）。
4. `c10a-demo-probe` 的断言「导出用的是素材原尺寸」在新节点上历史上挂着（`REPORT-cloud-node-deploy.md` 6.5），做 D 节 C2 那一行时会再遇到，已知、不是新问题。
