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
| `promptcut-render.slice` | `/etc/systemd/system/promptcut-render.slice`，再 `systemctl daemon-reload` | 渲染的全部进程所在的资源组：`MemoryHigh` / `MemoryMax`、`CPUQuota`、`CPUWeight=20`、`IOWeight=20`、`TasksMax=4096`。管理进程用 `systemd-run --scope --slice=promptcut-render.slice` 起工作进程，Chrome 等子进程都落在这一组里 |

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
| `{{USER_CARDS}}` | `isolated` | `PROMPTCUT_RENDER_USER_CARDS`：`isolated`（有用户卡的项目在按项目隔离的工作进程里渲）或 `off`（不接用户卡任务） |
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
- **服务用户**：`install-render` 建系统用户 `promptcut-render`（`useradd --system --no-create-home --shell /usr/sbin/nologin`，无登录权限）。工作进程用它跑，Chrome 沙箱照常开着；它读不到托管数据目录与私钥目录（都是 0700）。要在只能以 root 跑的环境（容器）里跑，把 `PROMPTCUT_RENDER_USER` 设成空串，Chrome 自动带 `--no-sandbox` 并打日志说明。
- **keygen**：私钥写进 `{{SECRETS}}/service-key.json`（0600，目录 0700，属主 root），公钥原子追加进托管数据目录的 `secrets/services.json`；文档服务按文件修改时刻重读，不用重启托管服务。`keygen-render --list` 看登记表；**换钥**：再跑一次 `keygen-render`（两把公钥并存）→ `pm2 restart promptcut-render` → 确认新钥生效后 `keygen-render --retire <旧 kid>`；**撤销**：`keygen-render --retire <kid>`，这个服务的连接随即被关。托管数据目录若是从旧节点整份搬来的，要把旧公钥撤掉，再在新节点上生成新钥。
- **自检**：`deploy-render` 用新发布目录跑 `server/hosted-render/main.mjs --check`（Node 版本、私钥、数据目录、Chrome 能否启动、中文字体、ffmpeg、控制连接握手）。**过了才换 `current`**；退出码 78 什么都不换，旧的照常跑，看输出里的 `selfcheck.error` 行。

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

容器等没有 systemd 的环境：`install-render` 检测到没有 `/run/systemd/system` 就跳过 slice 并打一行说明；`deploy-render` 同样不装 `pm2-<用户>.service`。渲染服务的管理进程自检报 `selfcheck.warn { reason: 'no-cgroup' }`（无 cgroup 上限，只靠进程内看护）并**继续**，不是退出：并发上限、背压、管理进程自己每 5 秒量工作进程整棵树的常驻内存（超过硬上限就结束这棵树）、降优先级照常生效。只有在有 systemd 的节点（Ubuntu 22.04）上才用 slice。PM2 的 `stop_exit_codes` 要较新的 PM2 才认；不认时自检不过会被反复拉起，用 `pm2 stop promptcut-render` 手动停，或改用带退避的重启（`exp_backoff_restart_delay`）。

### 容量

渲染服务写成的预渲染块在托管服务的素材服务里单独记账（`<托管数据目录>/assets/.service-usage/render.ndjson`），上限 `min(20 GiB, 托管数据目录所在盘总容量的四分之一)`，`PROMPTCUT_HOSTED_RENDER_CAP_BYTES`（设在 `promptcut-hosted` 的环境里）可改。到上限只拦渲染服务的写入（507 `service-quota`），成员不受影响；删项目时清只归它的块。`status-render` 末尾列记账文件的行数与大小。
