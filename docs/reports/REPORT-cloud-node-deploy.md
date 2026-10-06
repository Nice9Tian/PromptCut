# 新云节点部署与在线页面换 0.7.15：报告

状态：**完成**（2026-10-06）。新云节点 `149.88.94.84` 上跑起了托管组合（文档服务、素材服务，含 0.7.15 新增的主机登记与中继接口）和在线页面，nginx 与三个源的证书都配好；阿里云的在线页面换成了 0.7.15。按用户定的「并存」：阿里云照常服务，没有迁数据，没有改桌面版内置的托管地址。节点的地址、密钥位置、目录与备份位置在不入库的 `docs/local.md`。

## 1. 新节点

### 1.1 摸底（只读）

- Ubuntu 22.04 LTS（内核 5.15），KVM 虚拟机，8 核 Xeon Platinum 8272CL、16 GB 内存、无 swap；系统盘 39 GB（已用 2 GB），另有 40 GB 数据盘挂在 `/home`。位置在香港。
- 公网地址直接配在网卡上，没有内网地址。
- 已装：git、curl、rsync、python3；没有 Node、PM2、nginx、certbot、docker、ffmpeg。
- 防火墙：UFW 未启用，iptables 全放行；只有 22 在监听。云厂商那层后来实测 22、80、443、8787、8788 从公网都能连，**不需要用户放行端口**。
- 登录：服务器原来关着公钥登录（`sshd_config` 里 `PubkeyAuthentication no`）。会话不用密码登录，由用户自己输一次密码装上本机生成的部署公钥、把这项改成 yes；之后全程密钥登录。

### 1.2 Node、PM2 与托管组合

- `scripts/remote/docservice.mjs install`：Node v24.21.0（官方二进制，校验 SHA256）、PM2 7.0.4。
- `deploy-hosted --write-token --save --editor dist-online --doc-public-url wss://149-88-94-84.sslip.io/hosted/ --asset-public-url https://149-88-94-84.sslip.io/media/api/asset --stage-origins https://s1.149-88-94-84.sslip.io,https://s2.149-88-94-84.sslip.io`，退出 0：79 个文件、14 个预压缩 `.gz`；进程 `promptcut-hosted` 起来，`pm2 save`，装了 `pm2-root.service` 开机自启。
- 部署源：main 当时的提交 `be681c5e`。部署期间 main 从 `2cbe523e` 前进到 `be681c5e`（0.7.16，Claude Code 登录页的修复）；多出来的改动是 `server/runners/` 两个文件、一个测试与版本号，都不在托管清单里，托管端代码与 0.7.15 相同。
- 集群令牌：沿用阿里云那份（经 ssh 读进本机进程的环境变量，再由部署脚本经 ssh 标准输入写进 `secrets/cluster-token`，0600），没有落盘、没有打印。以后整体搬迁时不用换令牌。
- 部署清单不用补：`server/hosted/files.mjs` 已含 `server/hosting`（登记与中继）与 `server/recovery`。部署前在本机按清单拼出 79 个文件单独起过一次，`/hosting/healthz` 200。

### 1.3 nginx 与证书

- 装 nginx 1.18、certbot 1.21（Ubuntu 22.04 的包）。
- 站点配置从阿里云抄（只读登录取的）：`promptcut`（主站）与 `promptcut-stages`（s1、s2），换域名，`proxy_bind` 与反代目标换成本机地址 149.88.94.84；去掉只属于阿里云的 `/coord`（探针协调口）。其余照旧：三个源的 `/editor` 与 `/catalog/` 都带 `Origin-Agent-Cluster: ?1`，`/editor/assets/` 开 `gzip_static on`；`/hosted` 升级头、读写超时 3600 s、上传上限 2 MB、不缓冲；`/media` 上传上限 2 GB、不缓冲请求、读超时 600 s。删掉自带的 `default` 站点。
- `nginx.conf`：照阿里云打开 `gzip_vary`、`gzip_proxied any`、`gzip_comp_level 6` 与同样的 `gzip_types`。
- 与阿里云的差异：nginx 1.18 的 `mime.types` 没有 `wasm`（阿里云的 1.24 有），补了 `application/wasm wasm;`，不然 wasm 会按二进制流发。
- 证书：certbot `certonly --nginx` 签了一张 Let's Encrypt 证书，含主站、s1、s2 三个名字，到期 2027-01-04，`certbot.timer` 自动续期；没登记邮箱。
- 改之前的 nginx 配置备份在服务器 `/root/nginx-backup-20261006/`。

### 1.4 在线页面

从 main `2cbe523e`（0.7.15）`npx vite build --mode online`，退出 0，主脚本 `index-DvYaNaSX.js`；随 `deploy-hosted --editor` 部署，运行配置写了两个舞台源。构建内嵌的代码版本 `46d3c046…` 与 main `be681c5e` 算出的相同，所以与 0.7.15、0.7.16 的桌面版都对得上。

## 2. 阿里云的 `/editor` 换成 0.7.15

- 只换静态页面：本机用 `server/hosted/deploy.mjs` 的 `stageEditorBuild` 生成预压缩文件，拷成部署目录下的 `.incoming-editor`，只跑 `editorSwapLines()` 那几行；没有用 `deploy-hosted`（它会换应用目录并重载 PM2）。
- 先在服务器上整份备份旧的 `editor/`（0.7.14，`index-RvNdCRPh.js`，172 个文件、19,730,220 字节）。
- 换代输出：保留上一代 assets 13 个；保留 `runtime-config.json`；96 个本代 assets，109 个在位。
- 托管服务进程没动：换代前后 `promptcut-hosted` 的 pid 相同，重启计数 27、启动时刻 2026-10-04 不变。阿里云的托管服务仍是旧版本（`/hosted/hosting/healthz` 404），按任务约定不重部署。

## 3. 验证

### 3.1 健康检查与三个源

新节点：`/hosted/healthz` 200（文档服务）、`/hosted/hosting/healthz` 200（`{"ok":true,"role":"hosting","rooms":0,"online":0}`）、`/media/healthz` 200（素材服务）。

两台都用同一个核验脚本（从 PC 经公网取三个源的 `/editor`、主脚本、运行配置，再用无头 Chrome 打开主站 `/editor`）：

| 节点 | 源 | `/editor` | 主脚本 | 响应头 | 解压后 |
|---|---|---|---|---|---|
| 新节点 | 主站、s1、s2 | 都 200，带 `Origin-Agent-Cluster: ?1`、`no-store` | 都是 `index-DvYaNaSX.js`，200 | `Content-Encoding: gzip`、`Content-Length: 1345131`，不分块 | 4,279,571 字节，SHA-256 前 16 位 `7b5703f30dba33c9`，三个源相同 |
| 阿里云 | 主站、s1、s2 | 同上 | 同上 | 同上 | 同上 |

两台的无头打开都停在「加入别人的项目」页，页面错误 0、失败请求 0、4xx/5xx 0；运行配置都回各自的两个舞台源。

### 3.2 在线页面加入测试项目并读素材

`node scripts/probes/c10a-demo-probe.mjs --site https://149-88-94-84.sslip.io --port 5560`（run `muw01bjae185`，测试项目、测试凭证）：

- 第 1 步过：本机桌面版当创建者，导入一段带声音的视频、放卡，项目放到新节点，取邀请链接；预渲染计划 5 个任务全部完成。
- 第 2 步过：手机仿真（低内存档）凭邀请链接只填用户名加入；读到小尺寸素材（4 次请求）与 50 个预渲染块，舞台显示小尺寸；截图上素材库有那段视频的缩略图、时间轴 3 个片段。
- 第 3 步过：手机上改重卡参数，创建者的渲染节点认领重渲，新键下的预渲染贴回手机（约 13 s 出新键、88 s 出新块）。
- 第 4 步没过（改 BBR 之前）：低内存档逐帧导出 10 秒。经新节点取原尺寸视频时 seek 一直超时，重试 11 次、45 分钟没出片。第 5、6 步（作废邀请码、桌面版加入表单）随后超时。
- 收尾：云端测试项目已删，再查回 404。

第 4 步的原因是 **PC 到新节点这条线路**，不是部署：同一个 1.3 MB 的主脚本，PC 从新节点取每秒 12～23 KB、往返约 250 ms；PC 从阿里云取每秒 1.4～2.6 MB。新节点到阿里云每秒约 2.1 MB，到 Cloudflare 下载、上传都约 2.3 MB/s，本机回环 55 MB/s。逐帧导出要拉原尺寸视频（815 次分段请求），在每秒十几 KB 的线路上 seek 赶不上时限。这一项不在本任务的验收单里；用户随后要求解决，见 3.2b 节。

### 3.2b 线路排查与 BBR（用户要求解决慢的问题之后）

- 排查：PC 自己出口快（Cloudflare 下载 60 MB/s）。1200 字节 ping 到新节点丢 17%、往返 205～262 ms。tracert 去程 PC → NTT → 香港正常；新节点侧 mtr 回程是香港 → Lumen（4.69.x、8.244.x）绕美国再回日本，那一段时延跳到 250～280 ms、丢包约 10%。4 条并行连接各自速度差很大（每秒 13～183 KB），是丢包把单条 TCP 压住了。
- 改法：服务器 TCP 拥塞控制 cubic → BBR（`/etc/sysctl.d/90-promptcut-bbr.conf`：`default_qdisc=fq`、`tcp_congestion_control=bbr`；开机载入 `tcp_bbr` 模块；`eth0` 根 qdisc 换成 fq）。可随时改回，改回的命令在本机 `docs/local.md`。不碰防火墙与安全设置。
- 效果（PC 下载 4.3 MB 主脚本，不压缩）：改前 3 轮每秒 10～20 KB、30 秒下不完；改后 8 轮单连接中位数每秒约 980 KB（273～1596），4 条并行合计约 2.4 MB/s（约 19 Mbps）。
- 复跑 3.2 节的探针（run 第二轮，590 秒）：第 1～6 步全部走完；第 4 步低内存档逐帧导出 10 秒出片了（300 帧 1920×1080 h264、10.000 s、AAC 音轨，244 秒），上一轮这一步 45 分钟没出片；第 5 步作废邀请码（旧链接被拒、新链接能进）、第 6 步桌面版加入（手填、粘贴链接）都过；收尾删了测试项目（查回 404）。
- 仍挂一条：「导出用的是素材原尺寸」，导出窗口里记到 2 次小尺寸素材请求（`mediaSmall: 2`）。`docs/archive/agent-reports/AGENT-lowmem-latency.md` 记过同一现象（导出前手机页面还有两次小尺寸请求被算进去，复跑不再出现），与线路和部署无关。
- 剩下的差距（约 19 Mbps 对标称 30 Mbps）来自回程绕美国那段的丢包，要服务商改路由。

### 3.2c 复查服务器配置（用户转述服务商说线路有优化之后）

- 服务器这端没有造成慢的配置：网卡（virtio）收发 0 错误 0 丢弃；CPU 空闲、无抢占；路径 MTU 1428～1439（PC 侧隧道），但连接的 MSS 已被压到 1330，大包不会被丢；另开了 `tcp_mtu_probing=1` 兜底。
- 线路变了：同一条回程（香港 → Lumen → 日本）时延从 250～280 ms 降到 57～62 ms，丢包从约 10% 降到 0%；PC ping 往返 86 ms、丢 0%。此时 PC 单连接下载每秒 1.7～2.0 MB，cubic 与 BBR 只差约一成（没有丢包时两者接近；BBR 留着，线路再丢包时有用）。
- 节点的带宽上限：到 Cloudflare 下载、上传，1 条与 8 条连接都是 18.5～19.0 Mbps，平顶，是服务商侧整形；PC 4 条并行下载合计 18.6 Mbps，已打满。标称 30 Mbps 与实测约 19 Mbps 的差距在服务商侧。

### 3.3 协作重开恢复探针走真实部署

`PC_REOPEN_WAN_SERVICE=https://149-88-94-84.sslip.io/hosted PC_REOPEN_SSH_HOST=root@149.88.94.84 node scripts/probes/reopen-e2e.mjs --wan`（在探针分支上，见第 4 节），退出 0，`"ok":true`：

- 主机重开：主机与成员的编辑器进程都真重启（pid、端口都变，浏览器存储清空），回到原房间 `sp_iqavh5q7…`，主机重新登记上线；成员先打开、保留身份等着，主机上线后自动加入；身份仍是 `creator:host` 与 `member:member`；重开零建房；`.proc`、`.procp`、草稿、系统路径、刷新五种入口都过。
- 外网成员：在新节点上经公网域名发现房间、认证、加入三次（`path: deployed-service`，没有临时公开入口）；双向编辑 4 次，项目版本走到 9；第二、三次进入恢复了原设备身份。
- 带票据的素材：外网成员读 media、snap、px 三类各 50,000 字节，哈希都核对通过。

这次托管服务进程没有重启（探针在部署服务上不重启云端，`actualCloudProcessRestart: false`），云端离线时主机先打开那条只在隔离服务上验过。

## 4. 代码改动（未合入 main）

分支 `claude/cloud-node-deploy`（`8883c0d0`，基于 `2cbe523e`）：`scripts/probes/reopen-wan.mjs` 加环境变量 `PC_REOPEN_WAN_SERVICE`，给了就对着已部署的托管服务跑外网成员，不起临时网关、不开隧道。只动探针。基线：`npx tsc -b --force` 退出 0；`npm test` 4348 项，4347 通过、0 失败、1 跳过。3.3 节就是用它跑通的。合入须用户同意。

## 5. 待用户项与遗留

1. **换 root 密码**：密码出现在了对话记录里；之后的维护只用密钥，不需要它。
2. **合入探针分支** `claude/cloud-node-deploy`。
3. **节点带宽约 19 Mbps**：上下行 1 条、8 条连接都平顶在 18.5～19.0 Mbps，是服务商侧整形，与标称 30 Mbps 不符，需向服务商核对套餐（见 3.2c 节）。PC 到节点的线路在复查时已正常（往返 86 ms、0 丢包，单连接每秒约 1.9 MB）。
4. 新节点 `~/.ssh/authorized_keys` 第一行是 PowerShell 管道写坏的公钥，无害，可删；`/tmp/pc-reopen-wan.*` 是探针留的证据目录，可删。
5. 阿里云的托管服务仍是旧版本：本机托管的项目，外网成员经阿里云重新加入仍要等它升级，或改用新节点；切客户端（改桌面版内置托管地址）不在本任务范围。
6. 不在本任务范围、没做：渲染服务常驻、云端 Agent、迁移阿里云数据、改桌面版内置的托管地址、发新版本。
