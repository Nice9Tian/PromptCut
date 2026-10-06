# 托管组合的换机迁移

状态：**已真实换机**（2026-10-06，阿里云 → 新云节点，记录见第 2 节末「2026-10-06 真实换机记录」）；此前**已演练**（2026-09-28，M8：同一台阿里云上的第二份实例，结果见 `docs/reports/REPORT-render-queue-m8.md` 第 6 节）。起草时（2026-09-26）托管组合还没有部署素材服务，下面几条是当时的安排：
- 主执行计划的 SP 阶段负责把它做成真能跑：实现导出、导入，并在本机演练（验收 SP7）；
- M8 验收「换机迁移后项目、素材、预渲染产物全部可用」：在同一台阿里云服务器上起第二份实例做演练，不临时租服务器；
- 真正的换机，等团队测试通过、用户换新服务器时再按本文做一次；
- 具体命令见第 2 节末「M8 演练的实际命令」。

托管组合指放云端的共享项目所在的那台服务器，现在是阿里云 `8.219.80.16`。上面跑两个服务：
- 文档服务，公网端口 8787；
- 素材服务，公网端口 8788。

## 1. 能整体迁移的前提（SP 保证）

**地址都是配置项**，代码里不写死：

| 配置项 | 在哪 | 管什么 |
|---|---|---|
| `PROMPTCUT_DOCSERVICE_PUBLIC_URL` | 服务器 | 文档服务对外宣布的地址 |
| `PROMPTCUT_ASSET_PUBLIC_URL` | 服务器 | 素材服务登记给文档服务、由它下发给成员的地址 |
| 缺省托管地址 | 客户端代码里的一处常量 | 新建或加入放云端的项目时要连的地址。加入项目的界面上可以改 |
| `PROMPTCUT_HOSTED_URL` | 客户端 | 只用来覆盖缺省托管地址，开发和测试时用 |
| `PROMPTCUT_DATA_DIR` | 服务器 | 两个服务全部持久数据的根目录 |
| `PROMPTCUT_CLUSTER_TOKEN` | 服务器 | 只守管理接口（地址登记、管理 HTTP、迁移导出）；数据面的任何连接都不用 |

**数据只在一个目录里**：

```
$PROMPTCUT_DATA_DIR/
  docservice/   项目快照、操作日志、内容库、项目凭证（scrypt 结果）、各项目的票据密钥
  assets/       media/、snap/、px/，按哈希存放
```

- 任务队列只在内存里，不在这里。迁移后，各发布方重连时会把仍需要的任务重新发布；已经在素材服务里的结果不用重做（语义「队列只在内存里」）。
- 服务器上的环境变量文件（令牌、上面几个配置项）不进仓库，要单独拷。它和数据目录一起，就是迁移的全部内容。

## 2. 步骤

1. **准备新服务器**：
   - nginx 站点配置、gzip 与 mime 设置、BBR 的 sysctl 用仓库里的模板重建：`server/hosted/deploy/`（占位符与放置位置见那里的 `README.md`），不用再从旧服务器抄；
   - 装 Node ≥ 22 和 PM2；
   - 云控制台的安全组放行 TCP 8787、8788（或新地址上选定的端口）；
   - 服务器自己的 UFW 放行 22 和这两个端口。
   - nginx：`/editor` 的三个源（编辑器页与两个舞台，都带 `Origin-Agent-Cluster: ?1`）、`/hosted`、`/media` 的反向代理与 TLS，照旧服务器的 `/etc/nginx/sites-enabled/promptcut`、`promptcut-stages` 抄；`/etc/nginx/nginx.conf` 要打开 `gzip_types`（JS、CSS、JSON、SVG 等）。不开的话在线页面的主脚本按原样传（4 MB 多），两个舞台各下载一遍，慢网络下首次握手超时、页面永久退回单舞台、当不了纯浏览器节点（2026-09-30 实测，开压缩后 1.3 MB）。两份站点配置（`promptcut`、`promptcut-stages`）的 `location ^~ /editor/assets/` 里还要有 `gzip_static on;`：部署脚本 `deploy-hosted --editor` 会给 `assets/` 下大于 1 KB 的 JS、CSS、JSON、SVG、WASM 生成同名 `.gz`，nginx 直接带 `Content-Length` 发这份预压缩文件；只靠动态 gzip 时响应是分块传输的，部分 Chrome 配置下入口脚本分块发时页面会卡死（2026-10-01 查明，见 `docs/archive/agent-reports/AGENT-nav-hang.md`）。
2. **部署代码**：用部署脚本（`scripts/remote/docservice.mjs`，SP 起同时部署两个服务）指向新服务器，先不启动。
3. **旧服务器停写**：`pm2 stop` 两个服务。这时成员会断开，客户端显示「托管端不可达」。
   - **停写前要等正在编辑的客户端停止写入**：有成员正在编辑（含 Agent 在提交改动、上传队列在传素材）时停服务，停的那一刻没落盘的改动留在客户端的离线日志里，要等重连后重放，中间有冲突就得人来选。先看各客户端的 Agent 状态与上传队列、服务器上各项目操作日志的最后一条 rev，连续 5 分钟不变再停；预渲染的推送不用等，它自己会重试。
   - 停写之前先把大头数据预同步过去（旧服务器照常服务，只读），停写后只补差量：2026-10-06 实测 3.1 GB 预同步 16 分钟（px 按分片目录 8 路并行 rsync），停写后的差量 10 秒。
4. **拷数据**：把旧服务器的 `PROMPTCUT_DATA_DIR` 整个打包、拷到新服务器（`tar` 或 `rsync -a`），再核对两边的文件数和总字节数一致。
5. **拷环境**：
   - 拷环境变量文件；
   - 把 `PROMPTCUT_DOCSERVICE_PUBLIC_URL`、`PROMPTCUT_ASSET_PUBLIC_URL` 改成新地址。
6. **启动并自检**：
   - `pm2 start` 两个服务；
   - `/healthz` 两个都通；
   - 素材服务已向文档服务登记新地址；
   - 项目数、各项目的 `projectRev` 与旧服务器停写前记下的一致。
7. **抽查字节**：
   - 素材和预渲染产物按哈希抽查，至少 100 个或全部；
   - 取回后重算 sha256，与哈希一致的比例要 100%。
8. **旧服务器改成转发**（新服务器 `/healthz` 全通之后立刻做，停写窗口到这一步结束）：
   - **旧客户端直连旧服务器的 8787、8788 端口，协作连接是 WebSocket，不跟随 301 跳转；已保存的项目文件和恢复凭证里记的也是旧地址。所以旧服务器要原样转发，不能用跳转**：两个端口用 nginx 的 stream 原样转到新服务器的同端口（要装 `libnginx-mod-stream`，端口要等旧服务停了才空得出来）；nginx 的 `/hosted`、`/media` 反代到新服务器（升级头、超时、上传上限照旧）；`/editor` 是页面，可以 301 到新服务器。
   - 转发配置在停写之前就写好、用 `nginx -t` 验过，停写后只做「放进去、reload」这一下。
   - 旧服务器 `pm2 stop` 之后要 `pm2 save`，不然重启后旧服务会被 PM2 拉起来、和转发抢端口。
9. **切客户端**，两种做法，任选其一或都做：
   - 把客户端内置的缺省托管地址改成新地址，并把旧主机名加进 `server/auth/hosted-default.mjs` 的 `RETIRED_HOSTED_HOSTS`（旧项目文件、恢复凭证、本机记录里的旧地址读进来换成新的，用户不用重新认证），然后发版；
   - 成员在加入项目的界面上把托管地址改成新地址。

   成员重新进入项目后，看到的项目、素材、已就绪的层都与迁移前一致，不重新预渲染。
10. **收尾**：
   - 旧服务器保留只读 7 天（M8 定），确认没问题后再下线；
   - 下线前再核对一次，新服务器数据目录的文件数不少于旧的。

### M8 演练的实际命令（2026-09-28）

演练在同一台服务器上：源是 `promptcut-hosted`（8787 / 8788，数据目录 `/var/lib/promptcut/hosted`），目标是第二份实例 `promptcut-drill`（8777 / 8778，`/var/lib/promptcut/drill`）。整份命令清单由 `node scripts/probes/m8-migrate-probe.mjs --step remote-plan` 打印，下面只记实际跑的和与清单不同的地方。`$PROMPTCUT_REMOTE` 是 `user@host`（本机信息见 `docs/local.md`），`$W` 是本机放种子、库存、截图的临时目录，不进仓库。

1. **备份、部署目标**（清单 A、B）：`pm2.config.cjs` 与 `~/.pm2/dump.pm2` 各备份一份 `*.bak-<日期>-m8`；删掉旧的演练进程、旧数据挪开；集群令牌在服务器上从源拷进目标的数据目录（不经本机；清单里的另一种做法是部署时带 `--write-token`）；然后部署（不加 `--save`），再把部署时建的数据目录挪开、换成空的，等第 3 步拷数据：
   ```
   ssh "$PROMPTCUT_REMOTE" 'pm2 delete promptcut-drill; mv /var/lib/promptcut/drill /var/lib/promptcut/drill.old-<日期>-m8; install -d -m 700 /var/lib/promptcut/drill/secrets && cp -a /var/lib/promptcut/hosted/secrets/cluster-token /var/lib/promptcut/drill/secrets/'
   node scripts/remote/docservice.mjs deploy-hosted --instance drill --doc-public-url ws://8.219.80.16:8777 --asset-public-url http://8.219.80.16:8778/api/asset
   ssh "$PROMPTCUT_REMOTE" 'pm2 stop promptcut-drill && mv /var/lib/promptcut/drill /var/lib/promptcut/drill.deploy-<日期>-m8 && install -d -m 700 /var/lib/promptcut/drill'
   ssh "$PROMPTCUT_REMOTE" 'ufw allow 8777/tcp comment "m8-drill <日期>"; ufw allow 8778/tcp comment "m8-drill <日期>"'
   ```
2. **停写之前记库存**（清单 C）：管理接口只经 SSH 转发，集群令牌在服务器上读进本机进程的环境变量，不落盘、不打印：
   ```
   ssh -N -L 18787:127.0.0.1:8787 -L 18788:127.0.0.1:8788 -L 18777:127.0.0.1:8777 -L 18778:127.0.0.1:8778 "$PROMPTCUT_REMOTE"   # 另开一个终端挂着
   export PROMPTCUT_CLUSTER_TOKEN=$(ssh "$PROMPTCUT_REMOTE" 'tr -d "\r\n" < /var/lib/promptcut/hosted/secrets/cluster-token')
   node scripts/probes/m8-migrate-probe.mjs --step seed --hosted http://127.0.0.1:18787 --seed "$W/seed.json"
   node scripts/probes/shared-project-probe.mjs --role inventory --hosted http://127.0.0.1:18787 --asset http://127.0.0.1:18788 --seed "$W/seed.json" --out "$W/inventory.json"
   ```
3. **停写、拷数据、起目标**（第 3～6 步，清单 D～F，一条 ssh 做完）：
   ```
   ssh "$PROMPTCUT_REMOTE" 'date -Is; pm2 stop promptcut-hosted; S=$(date +%s); rsync -a /var/lib/promptcut/hosted/ /var/lib/promptcut/drill/; echo "rsync $(( $(date +%s)-S ))s"; for d in hosted drill; do echo "$d files=$(find /var/lib/promptcut/$d -type f | wc -l) bytes=$(du -sb /var/lib/promptcut/$d | cut -f1)"; done; pm2 start promptcut-drill; sleep 3; curl -s http://127.0.0.1:8777/healthz; curl -s http://127.0.0.1:8778/healthz'
   ```
   实测：36 154 个文件、2.16 GB，rsync 36 s。
4. **核对**（第 6、7 步，清单 G）。**`--sample all` 经 SSH 转发跑不动**（实测约 150 KB/s，2.16 GB 要几个小时），改为三件合起来：
   ```
   export PROMPTCUT_CLUSTER_TOKEN=$(ssh "$PROMPTCUT_REMOTE" 'tr -d "\r\n" < /var/lib/promptcut/drill/secrets/cluster-token')
   node scripts/probes/shared-project-probe.mjs --role migrate-check --from-inventory "$W/inventory.json" --to http://127.0.0.1:18777 --to-asset http://127.0.0.1:18778 --seed "$W/seed.json" --sample 300
   ssh "$PROMPTCUT_REMOTE" 'cd /var/lib/promptcut/drill/assets; for ns in media snap px; do find $ns -type f -print0 | xargs -0 sha256sum | awk -v ns=$ns "{ n=split(\$2,a,\"/\"); b=a[n]; sub(/\\.[^.]*\$/,\"\",b); if (b==\$1) ok++; else { bad++; if (bad<=5) print \"MISMATCH\", ns, \$2 > \"/dev/stderr\" } print ns, b > \"/tmp/m8-drill-hashes.txt.\" ns } END { print ns, \"ok=\" ok+0, \"mismatch=\" bad+0 }"; done; cat /tmp/m8-drill-hashes.txt.media /tmp/m8-drill-hashes.txt.snap /tmp/m8-drill-hashes.txt.px > /tmp/m8-drill-hashes.txt'
   scp "$PROMPTCUT_REMOTE":/tmp/m8-drill-hashes.txt "$W/drill-hashes.txt"
   ```
   第一条核 rev、共享项目、三个命名空间的哈希集合与字节数，并按哈希取回 300 个；第二条在服务器上逐块重算 sha256、与文件名比（`px/.chunks/` 下是没传完的分块上传的暂存，不是块，报 mismatch 不计）；最后把 `drill-hashes.txt` 与库存文件里三个命名空间的 `hashes` 逐个对账，缺 0、多 0。演练时为了缩短停写，主实例在这一步之前就 `pm2 start` 恢复了；**真正换机时旧服务器不恢复写**，保持停写到第 10 步下线。
5. **切客户端**（第 9 步，清单 H）：
   ```
   node scripts/probes/m8-migrate-probe.mjs --step client --hosted http://8.219.80.16:8777 --seed "$W/seed.json" --inventory "$W/inventory.json" --ui --old-hosted wss://8-219-80-16.sslip.io/hosted/ --editor-port <端口> --shots "$W/shots"
   PROMPTCUT_HOSTED_URL=ws://8.219.80.16:8777 node scripts/probes/m8-migrate-probe.mjs --step client --hosted http://8.219.80.16:8777 --seed "$W/seed.json" --inventory "$W/inventory.json" --no-edit
   ```
6. **收尾**（第 10 步，清单 I）：
   ```
   ssh "$PROMPTCUT_REMOTE" 'pm2 stop promptcut-drill; ufw delete allow 8777/tcp; ufw delete allow 8778/tcp; ufw status | grep -E "8777|8778" || echo "8777/8778 已收回"; pm2 list'
   ssh "$PROMPTCUT_REMOTE" 'pm2 save'   # 确认 promptcut-hosted online、promptcut-drill stopped 之后
   ```
   种子文件含口令，用完删；种子项目留在源实例里，由创建者删除。

### 2026-10-06 真实换机记录

阿里云 `8.219.80.16` → 新云节点 `149.88.94.84`（两台的连接办法在本机 `docs/local.md`）。客户端随 0.7.17 切过去。

1. **新节点**：`docservice.mjs install`、`deploy-hosted`，nginx 与证书（现在有模板 `server/hosted/deploy/`）。详见 `docs/reports/REPORT-cloud-node-deploy.md`。
2. **预同步**（阿里云不停）：新节点上生成一把临时密钥，阿里云 `authorized_keys` 里用 `from="<新节点地址>"` 限定来源；`rsync -a` 拉数据目录。单路每秒约 0.5 MB，改成 px 按分片目录 `xargs -P 8` 并行后每秒约 2 MB，3.1 GB 共 957 秒。
3. **转发先备好**：阿里云装 `libnginx-mod-stream`，转发配置放在 `/etc/nginx/promptcut-forward/`，`nginx.conf` 顶层加一行 include 指向空目录；用临时端口 `nginx -t` 验过。改之前 nginx 整份备份。
4. **等写入停止**：只读看正在编辑的那台桌面版的 Agent 状态（提交数、副本版本）与上传队列，加阿里云上那个项目操作日志的大小，每 30 秒一次；连续 5 分钟不变（实际等了约 5 分钟）。
5. **停写到转发生效 72.2 秒**：`pm2 stop promptcut-hosted`（同机的信箱进程不动）→ 新节点停服务、`rsync -a --delete` 补差量（10 秒）→ 核对 → 新节点部署新代码并启动 → 三个 `/healthz` 200 → 阿里云启用转发。
6. **核对**：两边文件数 56,486、内容字节 3,148,102,385、docservice 目录的文件清单与内容指纹相同；五个房间（四个项目加一个测试房间）操作日志最后一条的 rev 相同（169、166、36、5、2），停写前后没变；随机 120 个素材两边 SHA-256 全部相同，且都等于文件名里的哈希。
7. **验收**：0.7.16 在阿里云上建的测试房间，换机后用 0.7.17 同一台设备打开旧文件，不用认证回到原房间原身份、只连新节点、存回的是新地址；全新的 0.7.16 经阿里云 8787 的转发加入同一房间，双向改名可见，改动落在新节点（rev 2 → 4，阿里云上冻结在 2）；正在编辑的那台 0.7.16 桌面版经转发自动重连回原项目，版本号与停写前一致。
8. **阿里云留着**：只做转发加信箱（`/coord`），托管服务停着、`pm2 save` 过；托管数据只读保留 7 天。

## 3. 验收（M8）

- 迁移后项目、素材、预渲染产物全部可用：
  - `projectRev` 连续，不归零；
  - 素材和产物按哈希逐个取回，校验通过的比例为 100%；
  - 已就绪的层不重新预渲染。
- 迁移过程的命令、耗时、数据量和第 7 步的抽查结果，都贴进 M8 报告。
