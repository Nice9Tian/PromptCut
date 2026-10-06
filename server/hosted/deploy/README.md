# 托管端服务器配置模板

重建或换机时用（步骤见 `docs/plan/hosting-migration.md`）。取自 2026-10-06 部署的新云节点（Ubuntu 22.04、nginx 1.18），只含配置，不含证书、集群令牌与任何密钥。部署脚本（`scripts/remote/docservice.mjs deploy-hosted`）不读这些文件。

占位符：

| 占位符 | 换成 |
|---|---|
| `{{DOMAIN}}` | 主站域名（如 `<IP 换成短横线>.sslip.io`）；两个舞台源是 `s1.{{DOMAIN}}`、`s2.{{DOMAIN}}` |
| `{{BIND_ADDR}}` | 服务器自己的地址（有内网地址用内网地址，没有就用公网地址）：nginx 的 `proxy_bind` 与反代目标 |

| 文件 | 放到 | 说明 |
|---|---|---|
| `nginx-site-promptcut.conf` | `/etc/nginx/sites-available/promptcut`，链到 `sites-enabled/` | 主站：`/hosted`（WebSocket 升级头、超时 3600 s、上传上限 2 MB）、`/media`（上传上限 2 GB、不缓冲）反代，`/editor`、`/catalog/` 静态，都带 `Origin-Agent-Cluster: ?1`，`/editor/assets/` 开 `gzip_static` |
| `nginx-site-promptcut-stages.conf` | `/etc/nginx/sites-available/promptcut-stages`，链到 `sites-enabled/` | s1、s2 两个舞台源：只给 `/media`、`/editor`、`/catalog/` |
| `nginx-gzip.conf` | `/etc/nginx/nginx.conf` 的 `http { }` 里 | 动态压缩的类型 |
| `nginx-mime-wasm.conf` | `/etc/nginx/mime.types` 的 `types { }` 里 | 只在 mime.types 没有 wasm 时加 |
| `sysctl-90-promptcut-bbr.conf` | `/etc/sysctl.d/90-promptcut-bbr.conf`，再 `modprobe tcp_bbr`、`echo tcp_bbr > /etc/modules-load.d/promptcut-bbr.conf`、`sysctl -p /etc/sysctl.d/90-promptcut-bbr.conf` | BBR 与 MTU 探测：高延迟、有丢包的线路上 cubic 会把单连接压到每秒十几 KB |

证书：先装好站点配置里不含 ssl 的部分或用发行版默认站点占住 80 端口，再 `certbot certonly --nginx -d {{DOMAIN}} -d s1.{{DOMAIN}} -d s2.{{DOMAIN}}` 签一张三个名字的证书，路径与模板里的 `/etc/letsencrypt/live/{{DOMAIN}}/` 一致。删掉发行版的 `sites-enabled/default`。

## 渲染服务

托管方自带的渲染节点（PM2 应用 `promptcut-render`，契约 `docs/plan/hosted-render-contract.md` 第 7 节）。它和托管服务（`promptcut-hosted`）是两个独立进程，互不重启对方。跑的是**完整仓库加依赖**（要 Vite 转译卡片与页面），不是托管服务那份精简清单。模板与脚本只含占位符与路径，不含证书、令牌与任何密钥：服务私钥在节点上用 keygen 生成，不离开节点、不进环境变量、不进这些文件。

| 文件 | 放到 | 说明 |
|---|---|---|
| `pm2-promptcut-render.config.cjs` | `<部署目录>/pm2.config.cjs`（在仓库外） | PM2 配置：应用名 `promptcut-render`，入口 `server/hosted-render/main.mjs`，cwd 是 `<部署目录>/current`，`autorestart`、`kill_timeout` 20 s、`max_memory_restart` 只量管理进程（300 MB）、`stop_exit_codes: [78]`（自检不过就停着，不反复拉起） |
| `promptcut-render.slice` | `/etc/systemd/system/promptcut-render.slice`，再 `systemctl daemon-reload` | 渲染的全部进程所在的资源组：`MemoryHigh` / `MemoryMax`、`CPUQuota`、`CPUWeight=20`、`IOWeight=20`、`TasksMax=4096`。管理进程用 `systemd-run --scope --slice=promptcut-render.slice` 起工作进程，Chrome 等子进程都落在这一组里。**内存上限由内核执行**（到 `MemoryMax` 先回收文件缓存、回收不下来才在这一组里杀进程）；管理进程自己量内存的看护在这里只兜底，量的是 cgroup 的 `memory.current` 减 `inactive_file`，上限放宽 5%（6G 即 6.3G），内核先动手、不会双杀 |

占位符（模板里写成两层花括号括起来的大写名字）：

| 占位符 | 缺省 | 对应的环境变量（部署脚本在本机读） |
|---|---|---|
| `{{DIR}}` | `/opt/promptcut-render` | `PROMPTCUT_RENDER_DIR`：部署目录 |
| `{{DATA}}` | `/var/lib/promptcut/render` | `PROMPTCUT_RENDER_DATA`：工作进程的数据（帧库、临时目录、卡片同步），可重建的缓存 |
| `{{SECRETS}}` | `/var/lib/promptcut/render-secrets` | `PROMPTCUT_RENDER_SECRETS`：服务私钥目录（属主 root，0700） |
| `{{DOC_URL}}` | `ws://127.0.0.1:8787` | `PROMPTCUT_RENDER_DOC_URL`：文档服务的本机地址，直连，不经 nginx |
| `{{WORKER_PORT}}` / `{{STATUS_PORT}}` | `5400` / `5399` | `PROMPTCUT_RENDER_PORT`（另占 +1、+2）/ `PROMPTCUT_RENDER_STATUS_PORT`（管理进程的诊断口，只绑回环） |
| `{{MAX_CONCURRENT}}` / `{{MAX_PROJECTS}}` | `2` / `16` | `PROMPTCUT_RENDER_MAX_CONCURRENT` / `PROMPTCUT_RENDER_MAX_PROJECTS` |
| `{{MEMORY_MAX}}` / `{{MEMORY_HIGH}}` / `{{CPU_QUOTA}}` | `6G` / `5G` / `400%` | `PROMPTCUT_RENDER_MEMORY_MAX` / `_MEMORY_HIGH` / `PROMPTCUT_RENDER_CPU_QUOTA`（slice 与管理进程的看护共用这几个值） |
| `{{RENDER_USER}}` | `promptcut-render` | `PROMPTCUT_RENDER_USER`：工作进程的系统用户；空串表示与管理进程同一用户（root 或容器里直接跑，Chrome 自动带 `--no-sandbox`） |
| `{{USER_CARDS}}` | `isolated` | `PROMPTCUT_RENDER_USER_CARDS`：`isolated`（内容库里有卡片源码的项目由按项目隔离的工作进程渲，常驻工作进程不碰）或 `off`（退回不接用户卡任务：不起隔离工作进程）。隔离工作进程不用另外配置：端口缺省是工作进程的端口 + 10（`PROMPTCUT_RENDER_ISO_PORT` 可改，另占 +1、+2），数据目录是 `{{DATA}}/iso`（每一轮前后整个清空，属主跟 `{{DATA}}` 走），与常驻工作进程在同一个 slice 里 |
| `{{EDITOR_DIR}}` | `/opt/promptcut-hosted/editor` | `PROMPTCUT_RENDER_EDITOR_DIR`：托管服务部署目录里的在线页面构建，管理进程从它读在线页面的代码版本，与自己比 |
| `{{MAX_MEMORY_RESTART}}` / `{{KILL_TIMEOUT_MS}}` | `300M` / `20000` | 固定值 |

### 先决条件：与在线页面同一个提交

渲染服务的代码版本（`frameCode`）必须与在线页面（和以后的云端 Agent 服务）出自**同一个提交**，否则它一个任务也认领不了，队列也不报错。所以：

1. 先 `deploy-hosted --editor` 发在线页面，再 `deploy-render` 发渲染服务，两次用同一个提交（`deploy-render` 缺省取本机 `HEAD`，只上传提交里的内容，没提交的改动不上传）；
2. 之后每次升级两边一起升。管理进程启动时与之后每 5 分钟比一次，不一致就打 `selfcheck.warn { reason: 'code-version' }`，`/status` 的 `codeVersion.match` 为假；`status-render` 把三者并排打出来，不一致标红。

### 第一次部署（按顺序）

`PROMPTCUT_REMOTE` 是 `user@host`（本机信息见 `docs/local.md`），要 root 或能免密 sudo 的用户。每条命令都收 `--dry-run`：只在本机打出会做什么与要交给远端的脚本，不连远端，先看一遍再跑。

```
node scripts/remote/docservice.mjs install-render                 # 1. 系统包、服务用户、目录、slice
node scripts/remote/docservice.mjs deploy-render --no-start       # 2. 解包、npm ci、装 Chrome、换 current；不动 PM2（私钥还没有，自检会不过，是正常的）
node scripts/remote/docservice.mjs keygen-render                  # 3. 在节点上生成服务私钥，公钥登记进托管数据目录 secrets/services.json
node scripts/remote/docservice.mjs deploy-render --save           # 4. 正式部署：自检过了才换 current 并 pm2 startOrReload；--save 存档
node scripts/remote/docservice.mjs status-render                  # 5. 看状态：代码版本三者并排、诊断口、资源组、产物容量记账
```

- **系统包**（`install-render` 装，`apt-get install`）：中文字体 `fonts-noto-cjk`、`fonts-noto-color-emoji`、`fonts-liberation`；`ffmpeg`；Chrome 的运行库（Puppeteer 排障页列的那一批：`libnss3`、`libgbm1`、`libgtk-3-0`、`libasound2`〔Ubuntu 24.04 起叫 `libasound2t64`，脚本里自动判〕、`libx11-xcb1`、`libxss1` 等，完整清单见 `server/hosted-render/deploy.mjs` 的 `RENDER_APT_PACKAGES`）。`npm ci` 要编译原生模块时才加 `install-render --with-build-tools`（装 `build-essential`、`python3`）。Chrome 本身不是系统包：`deploy-render` 在发布目录里 `npx puppeteer browsers install chrome-headless-shell`，版本由仓库锁定的 puppeteer 决定。
- **Chrome 必须是 chrome-headless-shell，不能用系统装的 Chrome / Chromium**。预渲染靠受帧控制的页面出帧（`Target.createTarget({ enableBeginFrameControl })` 加 `HeadlessExperimental.beginFrame`），这两样只有 chrome-headless-shell 有；完整版的 Chrome / Chromium（即使以无头方式起）开页时回 `Protocol error (Target.createTarget): Target position can only be set for new windows`，也没有 `beginFrame`。在一台装着 Chromium 141 的 Linux 容器里、把 `PUPPETEER_EXECUTABLE_PATH` 指到它时实测到这条错误；在 Windows 上换成完整版 Chrome 154 复现了同一条——与版本号无关，是「完整版」与「headless-shell」的差别。所以：
  - 版本由仓库锁定的 puppeteer 决定：`package.json` 写 `puppeteer ^25.3.0`，锁定文件里是 25.10.0，它配的是 **chrome-headless-shell 152.0.7977.75**（`node_modules/puppeteer-core/lib/*/puppeteer/revisions.js` 的 `chrome-headless-shell` 一项；升级 puppeteer 后以那里为准）。`deploy-render` 在发布目录里跑 `npx puppeteer browsers install chrome-headless-shell` 装的就是这一版，装在 `<发布目录>/.cache/puppeteer`（PM2 配置里的 `PUPPETEER_CACHE_DIR`）；
  - **不要设 `PUPPETEER_EXECUTABLE_PATH`**（它会让 puppeteer 改用你给的那个可执行文件）。离线环境装不了时，把同一版的 chrome-headless-shell 拷进 `PUPPETEER_CACHE_DIR`，或者把 `PUPPETEER_EXECUTABLE_PATH` 指到一份 **chrome-headless-shell**（不是 `chromium` / `chrome`）；
  - 启动自检的 `chrome-frame` 一项走的就是工作进程开页与出帧的那条路：不行时自检以退出码 78 结束，`selfcheck.error` 里写出实际的 Chrome 版本与期望的版本，不会出现「自检过了、工作进程却一直起不来」。版本不是锁定的那一版但开页与出帧都行时只告警（`chrome-version`）：环境指纹含 Chrome 主版本，它的结果不会与别的节点混用。
- **服务用户**：`install-render` 建系统用户 `promptcut-render`（`useradd --system --no-create-home --shell /usr/sbin/nologin`，无登录权限）。工作进程用它跑，Chrome 沙箱照常开着；它读不到托管数据目录与私钥目录（都是 0700）。要在只能以 root 跑的环境（容器）里跑，把 `PROMPTCUT_RENDER_USER` 设成空串，Chrome 自动带 `--no-sandbox` 并打日志说明。
- **keygen**：私钥写进 `{{SECRETS}}/service-key.json`（0600，目录 0700，属主 root），公钥原子追加进托管数据目录的 `secrets/services.json`；文档服务按文件修改时刻重读，不用重启托管服务。`keygen-render --list` 看登记表；**换钥**：再跑一次 `keygen-render`（两把公钥并存）→ `pm2 restart promptcut-render` → 确认新钥生效后 `keygen-render --retire <旧 kid>`；**撤销**：`keygen-render --retire <kid>`，这个服务的连接随即被关。托管数据目录若是从旧节点整份搬来的，要把旧公钥撤掉，再在新节点上生成新钥。
- **用户卡的隔离**（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节）：工作进程里的页面请求闸、出口代理与同步文件预检随代码生效，没有开关要配。排查「渲染页的某个请求被拦了」时看管理进程日志里的 `[page-gate] deny …` 行；确要放开，先用 `PROMPTCUT_PAGE_GATE=log`（写进 PM2 配置的 `env`，只记不拦，**排查完立刻去掉**）看清它发的是什么，再改放行表。`PROMPTCUT_RENDER_LOAD_HIGH` 缺省等于核数，一般不用配。别把别的服务的凭证放进渲染服务的环境变量：名字像秘密的不会传给工作进程，名字不像的会。上线前在节点上跑一遍 `node scripts/probes/hosted-render-isolation-probe.mjs`（全在回环上、用的是假凭证，端口 5800～5807 与 8770、8771）。
- **自检**：`deploy-render` 用新发布目录跑 `server/hosted-render/main.mjs --check`（Node 版本、私钥、数据目录、Chrome 能否启动、能否照工作进程的办法开页并出一帧、中文字体、ffmpeg、控制连接握手）。**过了才换 `current`**；退出码 78 什么都不换，旧的照常跑，看输出里的 `selfcheck.error` 行。

### 按提交分目录、升级与回退

```
<部署目录>/
  releases/<提交前 12 位>/   仓库在那个提交的完整内容（git archive 上传，不含 .git）＋ node_modules ＋ Chrome
  current -> releases/<…>    PM2 的 cwd
  .previous                  换链接之前 current 指的那一份
  pm2.config.cjs             由模板填出来的，不含秘密
```

- **升级**：`deploy-render`（可加 `--commit <引用>`）。新提交解进新的 `releases/<id>/`，`npm ci`、装 Chrome，自检过了才原子换 `current` 链接，再 `pm2 startOrReload`（重载时管理进程先放回手里的认领、结束进程树）。`--keep <n>` 控制旧发布目录留几份（缺省 5，`current` 与 `.previous` 指的两份不删）。
- **回退**：`rollback-render`（缺省回到 `.previous`，或 `--to <发布目录名>`）。就是把 `current` 换回去再重载；那份必须还在 `releases/` 里。
- **停**：`stop-render`（`pm2 stop` 并 `pm2 save`，节点重启后保持停止）；`--delete` 连 PM2 的登记一起删。托管服务不动。

### PM2 存档与开机自启

节点重启后要靠两步才会自己起来：`pm2 save`（存当前进程清单）与 `pm2-<用户>.service`（开机时 `pm2 resurrect`）。`deploy-render --save` 做前者；后者在 `pm2-<用户>.service` 没装、且机器有 systemd 时由每次正式部署（不带 `--no-start`）补装 `pm2 startup systemd`（与 `deploy-hosted` 相同）。手工做法与核对：

```
pm2 save
pm2 startup systemd -u root --hp /root        # 按输出提示执行它打印的那条 systemctl 命令
systemctl is-enabled pm2-root                 # 期望 enabled
pm2 resurrect && pm2 list                     # 期望 list 里有 promptcut-render（和 promptcut-hosted）
```

节点重启后是否真的自动起来，由负责部署的人最后在新节点上定怎么验（重启会中断托管服务）。

### 没有 systemd 时

容器等没有 systemd 的环境：`install-render` 检测到没有 `/run/systemd/system` 就跳过 slice 并打一行说明；`deploy-render` 同样不装 `pm2-<用户>.service`。渲染服务的管理进程自检报 `selfcheck.warn { reason: 'no-cgroup' }`（无 cgroup 上限，只靠进程内看护）并**继续**，不是退出：并发上限、背压、管理进程自己每 5 秒量工作进程整棵树实际占的物理内存（逐进程累加 `smaps_rollup` 的 `Pss`，共享页只算一份；不是累加 VmRSS——Chrome 多进程的共享页会被重复计入，空着的常驻树就量出 6 GB 多而误杀；超过硬上限就结束这棵树，先结束隔离工作进程；量不了的那一拍不判，记 `render.memory-unmeasured`）、降优先级照常生效。只有在有 systemd 的节点（Ubuntu 22.04）上才用 slice。PM2 的 `stop_exit_codes` 要较新的 PM2 才认；不认时自检不过会被反复拉起，用 `pm2 stop promptcut-render` 手动停，或改用带退避的重启（`exp_backoff_restart_delay`）。

### 容量

渲染服务写成的预渲染块在托管服务的素材服务里单独记账（`<托管数据目录>/assets/.service-usage/render.ndjson`），上限 `min(20 GiB, 托管数据目录所在盘总容量的四分之一)`，`PROMPTCUT_HOSTED_RENDER_CAP_BYTES`（设在 `promptcut-hosted` 的环境里）可改。到上限只拦渲染服务的写入（507 `service-quota`），成员不受影响；删项目时清只归它的块。`status-render` 末尾列记账文件的行数与大小。

## Agent 服务

托管方的云端 Agent 服务（契约 `docs/plan/cloud-agent-contract.md`）：一个不带页面的 Node 进程（PM2 应用 `promptcut-agent`，入口 `server/agent-service/main.mjs`），只绑回环，对外只经 nginx 的 `/agent/`。它用服务名 `agent` 的服务身份连文档服务的控制连接；每个请求的委托票据、每一轮的对话委托都交文档服务核验。它不持有集群令牌、任何成员的口令或项目密钥。

| 占位符 | 缺省值 | 说明 |
|---|---|---|
| `DIR` | `/opt/promptcut-render` | 与渲染服务共用的部署目录；Agent 服务的 `cwd` 是 `DIR/current` |
| `DATA` | `/var/lib/promptcut/agent` | 数据目录（0700）：`config/`（模型配置、Key 的密文、额度）、`tenants/`（对话）、`usage/`（用量流水）、`tmp/` |
| `SECRETS` | `/var/lib/promptcut/agent-secrets` | 服务私钥目录（0700），里面是 `service-key.json`（0600） |
| `DOC_URL` | `ws://127.0.0.1:8787` | 文档服务的本机地址（控制连接只认本机发起） |
| `AGENT_PORT` | `8790` | Agent 服务的端口（只绑 127.0.0.1） |
| `PUBLIC_ORIGIN` | 空 | 对外的源，只做格式检查并记进日志，可不填 |
| `HEAP_MB` / `MAX_MEMORY_RESTART` / `KILL_TIMEOUT_MS` | `1536` / `2G` / `8000` | V8 老生代上限、常驻内存超过即由 PM2 重启、重启前给的收尾时间 |

模板：`pm2-promptcut-agent.config.cjs`（PM2）、`nginx-location-agent.conf`（主站 `server` 块里的 `/agent/` 一段；两个舞台源的 `server` 块不加）。

### 先决条件：与在线页面、渲染服务同一个提交

Agent 服务不单独上传代码：它用 `deploy-render` 放上去的那份检出（完整仓库加依赖，要 vite 与 `src/`）。Agent 服务发布的补渲计划带着这份检出的代码版本，渲染服务只认领代码版本相同的计划，在线页面也按同一个代码版本找预渲染的结果。所以**三者必须出自同一个提交**：先换在线页面、`deploy-render`，再 `deploy-agent`。`status-agent` 把 Agent 服务与渲染服务的代码版本并排，不一致标红。

Agent 服务自己不开 Chrome；预渲染用的 chrome-headless-shell 只属于渲染服务（见上面「渲染服务」一节）。含用户卡的项目由渲染服务的隔离工作进程渲（同时最多一个、冷启动约 10 秒），所以云端 Agent 建卡、改到用户卡片段之后的补渲比只有内置卡的项目慢。

**云端 Agent 的工具与本机一致**（契约第 9 节）。与节点有关的几件事：

- **素材写入**：PM2 模板里的 `PROMPTCUT_AGENT_ASSET_URL`（缺省 `http://127.0.0.1:8788`，同机素材服务的回环地址）。云端 Agent 导入素材、配音入库时凭代成员的素材票据写进它，权限不超过成员本人。
- **工作目录**：`<DATA>/work/<项目>/<主人键>/<对话>/`（附件、下载的文件、合成的语音）。一个对话 2 GiB、一个项目 8 GiB 封顶；对话删除、项目删除时清掉。`status-agent` 报占用。
- **出网闸**：按模型给的地址发请求的工具不能访问回环、内网、`169.254.169.254` 与本机各网卡的地址。**生产不要设 `PROMPTCUT_AGENT_EGRESS_TEST_ALLOW`**（只给探针）；`status-agent` 与 `/healthz` 的 `egressTestAllow` 必须是 `false`。出网闸只管 Agent 服务进程自己发的请求；以后接上会起子进程的工具（下载器、浏览器）时，另用系统级的办法兜底：给这些子进程一个独立的非特权用户，并按用户限制它的出网（例如 `iptables -A OUTPUT -m owner --uid-owner <那个用户> -d 127.0.0.0/8 -j REJECT`，内网段同理；这是改防火墙，命令由用户执行，会话不动）。
- **配音**：托管方的配音服务地址与令牌走与模型 Key 相同的加密分发（`import-key-agent --service voice`）；没配时 `voice_generate` 回「还没有配置配音服务」。每次调用记进用量流水（`kind: "service"`）。
- **可选的 ffprobe**：装了 ffmpeg（`ffprobe` 在 PATH 上，或设 `PROMPTCUT_FFPROBE`）时，导入的音视频带时长与宽高；没有时图片与 WAV 照常，其余不带。
- **这一版还没接上的工具**（看画面、语音识别与镜头、追踪、主体识别、音效合成、网页采集与网页接管）要的东西列在契约第 9.9 节；现在不用为它们装任何东西。

### 第一次部署（按顺序）

1. 渲染服务已按上一节部署好（`current` 指向要用的提交）。
2. `node scripts/remote/docservice.mjs deploy-agent --no-start`：建数据目录与私钥目录、写 PM2 配置，不起进程。
3. `node scripts/remote/docservice.mjs keygen-agent`：在节点上给服务名 `agent` 生成密钥并登记公钥（等价于在节点上运行 `node server/hosted-render/keygen.mjs --hosted-data <托管数据目录> --secrets <SECRETS> --service agent`）。私钥不离开节点、不打印。
4. 托管组合（`promptcut-hosted`）的环境里加 `PROMPTCUT_AGENT_PUBLIC_URL=https://<主站域名>/agent/v1`，按「重启托管服务前先确认没有正在写入的客户端」的规矩重启它一次。文档服务经成员列表把这个地址下发给页面；不设时页面不出「云端」一项。
5. nginx 主站 `server` 块里加 `nginx-location-agent.conf` 的那一段，`nginx -t && systemctl reload nginx`。
6. `node scripts/remote/docservice.mjs deploy-agent`，确认 `/healthz` 有应答；`status-agent` 看代码版本一致；确认无误后 `deploy-agent --save`（`pm2 save`，节点重启后自启）。
7. 导入模型 Key（加密分发，见下一节：节点报出机器识别码，用户在自己的电脑上生成密文，会话把密文送到节点导入）。导入之前先用 `set-key.mjs --mock` 切到模拟模型验一遍。

### 模型 Key 的加密分发（及配音等别的外部服务的 Key）

〔用户 2026-10-07 定〕Key 不经会话、不进命令行与日志、不进仓库：节点报出自己的**机器识别码** → 用户在**自己的电脑**上用仓库根目录的 `make-api-share.bat` 把 Key 加密成**只有这台节点解得开的密文**（明文只经用户自己的手）→ 会话把密文送到节点、在节点本机解开，按现有的落盘加密存进数据目录。会话全程只接触密文。信封与桌面版「API 分发」是同一套（PBKDF2-SHA256 + AES-256-GCM，口令是机器识别码）。

```
1. 取节点的机器识别码（会话做）：
     node scripts/remote/docservice.mjs machine-id-agent
   等价于在节点上运行  cd <检出目录> && node server/agent-service/machine-id.mjs ，标准输出只有一行 PCM-XXXXX-XXXXX-XXXXX-XXXXX。
2. 把这串码交给用户，用户在自己的电脑上生成密文（步骤见本节末，原文由会话转给用户）。
3. 用户交回密文（以 PCAI1. 开头的一整段）后，会话把它存进一个本机的临时文件，送到节点导入：
     node scripts/remote/docservice.mjs import-key-agent --file <密文文件> [--service model|voice] [--dry-run]
   等价于在节点上运行
     PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/import-key.mjs --file <密文文件> [--service model|voice]
   （密文也可以从标准输入给：…import-key.mjs < 密文.txt；密文不能写在命令行上）。
   密文经 ssh 标准输入进远端脚本，写到 <数据目录>/tmp/（0600），导入完——成功或失败——都删掉。
4. 看到「已导入…  厂商 / 模型 / Key 末四位」就是成了；运行中的服务下一轮对话起就用它，不用重启。
```

- **按服务名导入**：`--service model`（缺省）是对话用的模型：写 `<数据目录>/config/ai.json`（厂商、接口地址、模型清单、token 上限）与 `config/keys/custom.key`（`PCENC1.` 落盘密文）。`--service voice` 是配音：写 `config/voice.json` 与 `config/keys/voice.key`（`PCVOC1.`，与对话 Key 是两把，互不相通）；生成密文时「API 地址」填配音网关的地址，「模型」填配音提供方（minimax / kling / vidu 之一，空 = minimax），「厂商」随便选。读出用 `server/agent-service/service-keys.mjs` 的 `readServiceKey(dataDir, service)`。以后加别的服务，只在它的服务表里加一项，命令行与远程子命令不用改。
- **报错**：不是密文（不以 PCAI1. 开头）、格式不对、被截断、头部异常、已过期、厂商不对、没写模型，各有明确的中文原因；**密文不是按这台机器的识别码生成的，与密文在传输中被改过，在密码学上分不出来，报同一句**（「解不开：这份密文不是按这台机器的识别码生成的……或者内容在传输中被改过」）。任何一种都不写任何文件。输出里只有厂商、模型清单与 Key 的末四位，不打印 Key、不打印密文。
- **识别码稳定性**：Linux 上取 `/etc/machine-id`（取不到再取 `/var/lib/dbus/machine-id`），加盐取 SHA-256 的前 100 位，不掺主机名、IP、用户名：换账号、改主机名、改 IP 都不变；**重装系统、或从镜像克隆后重新生成 machine-id 才会变**，变了就要重新生成密文、重新导入（落盘加密用的也是这个指纹，所以重装后原来存的 Key 同样解不开，要重新导入）。两个都取不到时退到「主机名 + 平台 + 架构 + 网卡」的兜底，稳定性差，`machine-id.mjs` 会警告。
- **换 Key**：重新生成密文再导入一次（替换并写明）。**删掉 Key**：`PROMPTCUT_AGENT_DATA=… node server/agent-service/set-key.mjs --clear`。**切到模拟模型**（验收与排查用，不调用任何真实模型）：`… set-key.mjs --mock`；换回真实模型就再导入一次密文。
- `set-key.mjs` 里交互式录入明文的那一路保留，**仅供本机调试**（用户本人坐在节点终端前、手边没有密文时）：它不接受命令行与环境变量里的 Key、标准输入不是终端时拒绝、运行时会先说明这是调试用法。正式录入一律走加密分发。
- 这层封装挡的是「明文躺在文件里」，挡不住能以同一个系统用户在节点上运行程序的人（口令是机器自己算出来的）。

**给用户的步骤（会话转述）**：收到节点的机器识别码（形如 PCM-XXXXX-XXXXX-XXXXX-XXXXX）后，在自己的电脑上：

1. 双击仓库根目录里的 `make-api-share.bat`（第一次会先编译一两分钟，需要装了 Rust；编译过的直接打开）。窗口标题是「PromptCut · 生成 API 分发密文」，停在「生成密文」页。
2. 「① 本机识别码」一栏粘贴收到的识别码（大小写、横线随意，别抄错字符）。
3. 「② 填要分发的 API 配置」：「厂商」下拉里选 anthropic / openai / gemini；「API 地址」用厂商官方地址就留空；「模型」填模型清单（多个用 | 隔开，第一个是缺省，例如 `模型甲|模型乙`）；「API Key」填 Key（勾「显示」可以核对）。配音那一份：「API 地址」填配音网关地址，「模型」填 minimax / kling / vidu 之一，「厂商」随便选，「API Key」填配音的令牌。
4. 「③ 可选」里「留言」可以写一句；**「有效期（天）」留空**（设了会过期，过期的密文会被节点拒收）；「maxTokens」留空用缺省 4096。
5. 点「生成密文」，出现「生成成功，共 … 个字符」；想先自己验一遍：切到「校验密文」页，填同一个识别码，把密文粘进去点「解开看看」，能看到厂商 / 模型 / 末四位就对。
6. 回到「生成密文」页点「复制密文」，把那一整段**以 PCAI1. 开头的密文**粘贴回给会话（密文本身是加密的，发给会话没关系；**不要**把明文 Key 发给任何人）。
7. 换 Key 或再加配音，重复 2～6。

### 在线页面的诊断报告（构建时带两个变量）

〔用户 2026-10-07 定〕云端对话与本机对话都能出诊断报告，两种去向：「保存为文件」（在线页面是浏览器本地下载）与「提交」（页面直接请求诊断报告收集端 `tools/report-worker/`，存起来，用 `report-inbox.bat` 取回）。在线页面里报告在页面内生成，下载与提交**都不经编辑器进程的 `/api/*`**；提交是页面对收集端外部地址的跨源 POST（`text/plain`，简单请求、无预检），收集端的响应本来就带 `Access-Control-Allow-Origin`，收集端不用改、不用重新部署。

提交地址与令牌是**构建期**变量，写在构建在线页面的那台电脑的 `.env.local` 里（或构建时的环境变量），`npx vite build --mode online` 会把它们编进页面：

| 变量 | 说明 |
|---|---|
| `VITE_DIAG_SUBMIT_URL` | 收集端的地址（与桌面版「诊断」窗口的「提交」是同一个） |
| `VITE_DIAG_SUBMIT_TOKEN` | 与收集端那边 `SUBMIT_TOKEN` 相同的串。它随页面一起发给所有访问者，**不是真正的密钥**，挡的是随手 curl；真要防滥用在收集端按 IP 限流 |

没配 `VITE_DIAG_SUBMIT_URL` 时，对话框里「提交」按钮置灰并说明原因，用户仍可「复制」或「保存为文件」。**换了这两个变量要重新构建并换在线页面。** 报告内容是这段对话的过程、出错原因、客户端与版本信息，已脱敏：不含委托票据、对话委托、模型 Key 与提交令牌。

### 额度与用量（托管方在节点上运行，改了即生效，不用重启）

```
cd /opt/promptcut-render/current
PROMPTCUT_AGENT_DATA=/var/lib/promptcut/agent node server/agent-service/admin.mjs quota set <projectId> --tokens <N> [--window total|month|day] [--runs <N>]
PROMPTCUT_AGENT_DATA=/var/lib/promptcut/agent node server/agent-service/admin.mjs quota clear <projectId>
PROMPTCUT_AGENT_DATA=/var/lib/promptcut/agent node server/agent-service/admin.mjs quota show [<projectId>]
PROMPTCUT_AGENT_DATA=/var/lib/promptcut/agent node server/agent-service/admin.mjs usage [--project <projectId>] [--since 2026-10-01] [--json]
```

现在不设上限：任何能进云端项目的成员都能用托管方的 Key 跑模型，对外开放之前先按项目把上限发下去。节点级的并发上限（全节点 6 轮、每个项目 3 轮、每位成员 2 轮）在 `<数据目录>/config/limits.json` 的 `node` 里，缺省就有。

### 升级与回退

- 升级：换在线页面 → `deploy-render --commit <提交>`（换 `current`）→ `deploy-agent`（重载；进行中的对话会被记为「中断」，主人回来说一句就接着做）。
- 回退：`rollback-render` 把 `current` 换回上一份，再 `deploy-agent` 重载一次。在线页面同样退回那个提交。
- 只停 Agent 服务：`stop-agent`（托管服务与渲染服务不动）；在线页面的「云端」一项会报连不上。要让页面不出这一项，去掉托管组合的 `PROMPTCUT_AGENT_PUBLIC_URL` 并重启它，或撤掉 `agent` 的公钥（`keygen-agent --retire <kid>`）。
- 换服务密钥：`keygen-agent`（新旧公钥并存）→ `pm2 restart promptcut-agent` → `keygen-agent --retire <旧 kid>`。
- 四个子命令都收 `--dry-run`：只打印要交给远端的脚本，不连任何远端。
