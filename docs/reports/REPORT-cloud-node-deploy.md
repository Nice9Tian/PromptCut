# 新云节点部署与在线页面换 0.7.15：报告

状态：**进行中**（2026-10-06）。阿里云的在线页面已换成 0.7.15 并核验通过；新云节点的部署还没开工，等用户给节点地址、登录用户和 SSH 私钥在本机的路径。本机信息（地址、密钥位置、备份位置）在不入库的 `docs/local.md`。

## 1. 做了什么

### 1.1 阿里云的 `/editor` 换成 0.7.15

- 在线构建：在 main `2cbe523e` 的 worktree 里跑 `npx vite build --mode online`，退出 0，主脚本 `assets/index-DvYaNaSX.js`（原文 4,279,571 字节，预压缩 1,345,131 字节）。
- 只换静态页面：本机用 `server/hosted/deploy.mjs` 的 `stageEditorBuild` 生成 14 个 `.gz`，拷成服务器部署目录下的 `.incoming-editor`，再只跑 `editorSwapLines()` 那几行。没有用 `deploy-hosted`（它会换应用目录并重载 PM2）。
- 换之前在服务器上整份备份了旧的 `editor/`（0.7.14，`index-RvNdCRPh.js`，172 个文件、19,730,220 字节，与原目录相同）。
- 换代输出：保留上一代 assets 13 个；保留 `runtime-config.json`；96 个本代 assets，109 个在位。
- 托管服务进程没动：换代前后 `promptcut-hosted` 的 pid 相同，PM2 重启计数 27、启动时刻 2026-10-04 都没变。

核验（2026-10-06，从 PC 经公网）：

| 源 | `/editor` | 主脚本 | 响应头 | 解压后 |
|---|---|---|---|---|
| 主站 | 200，`Origin-Agent-Cluster: ?1`，`no-store` | `index-DvYaNaSX.js` 200 | `Content-Encoding: gzip`，`Content-Length: 1345131`，不分块 | 4,279,571 字节，SHA-256 前 16 位 `7b5703f30dba33c9` |
| s1 | 同上 | 同上 | 同上 | 同上 |
| s2 | 同上 | 同上 | 同上 | 同上 |

三个源的 `runtime-config.json` 都回原来的两个舞台源。无头 Chrome 打开主站 `/editor`：停在「加入别人的项目」页，页面错误 0、失败请求 0、4xx/5xx 响应 0。

### 1.2 部署清单核对

`server/hosted/files.mjs` 的清单已经含 `server/hosting`（主机登记与中继）与 `server/recovery`，不用补。核对办法：`node scripts/remote/docservice.mjs stage-hosted <目录>` 拼出 79 个文件，在这个目录里单独起 `server/hosted/main.mjs`（本机回环、临时数据目录），文档端口 `/healthz` 200、`/hosting/healthz` 回 `{"ok":true,"role":"hosting","rooms":0,"online":0}`，素材端口 `/healthz` 200。

对照：阿里云生产 `https://8-219-80-16.sslip.io/hosted/hosting/healthz` 回 404，`/hosted/healthz`、`/media/healthz` 回 200——生产托管服务确实还是没有登记与中继接口的旧版本。按任务约定不重部署它。

### 1.3 阿里云 nginx 配置（只读抄下，给新节点用）

- `sites-enabled/promptcut`：主站。`/hosted`（升级头、读写超时 3600 s、上传上限 2 MB、不缓冲）、`/media`（上传上限 2 GB、不缓冲请求、读超时 600 s）反代到内网地址的 8787、8788，带 `proxy_bind`；`/editor` 四个 location 与 `/catalog/`，都带 `Origin-Agent-Cluster: ?1`；`/editor/assets/` 开 `gzip_static on`。另有只属于阿里云的 `/coord`（探针协调口），新节点不抄。
- `sites-enabled/promptcut-stages`：s1、s2 两个舞台源，只提供 `/media`、`/editor`、`/catalog/`，其余 404。
- `nginx.conf`：`gzip on`、`gzip_vary on`、`gzip_proxied any`、`gzip_comp_level 6`，`gzip_types` 含 JS、CSS、JSON、SVG、WASM 等。
- 证书：certbot `--nginx` 签的一张三个名字的 Let's Encrypt 证书，`certbot.timer` 自动续期。

### 1.4 探针：对着已部署的托管服务跑外网成员

现有 `scripts/probes/reopen-e2e.mjs --wan` 经 `reopen-wan.mjs` 在远端自己起一个临时网关，没有对着真实部署跑的入口。分支 `claude/cloud-node-deploy`（`8883c0d0`）给 `reopen-wan.mjs` 加了环境变量 `PC_REOPEN_WAN_SERVICE=<https://主机/hosted>`：给了就不起临时网关、不开隧道，外网成员仍在 `PC_REOPEN_SSH_HOST` 上跑，经这个地址发现房间并加入。只动探针。

基线（在该分支上）：`npx tsc -b --force` 退出 0；`npm test` 4348 项，4347 通过、0 失败、1 跳过，退出 0。这个入口还没有实跑过，要等新节点；未合入 main。

## 2. 没做的与原因

卡点 1：任务第 1 步「只读摸底新节点」要节点地址、登录用户与 SSH 私钥路径，任务书里这三项没填；本机 `~/.ssh`、`Downloads`、`docs/local.md` 与仓库文档里都没有新节点的记录。属「待用户」，不建候选。它挡住的：

- 第 1 步摸底；第 2 步装 Node 与 PM2、部署托管组合、写集群令牌；第 3 步 nginx 与证书；第 4 步新节点的 `/editor`；
- 第 6 步里新节点的三项验证（`/healthz` 与三个源、在线页面加入测试项目并读素材、协作重开恢复探针走真实部署）；
- 第 7 步里新节点信息写进 `docs/local.md`。

## 3. 待用户项

1. 给新节点地址与登录用户、SSH 私钥在本机的路径；域名与「并存 / 整体搬过去」不给就按缺省（sslip.io、并存）。
2. 新节点的防火墙与安全组放行由用户做；摸底后给出具体端口与命令（预计 80、443；照阿里云另有 8787、8788）。
3. 新节点的集群令牌：打算沿用阿里云那一份（经 ssh 读进环境变量再写过去，不落盘、不打印）；要另生成请说明。
4. 分支 `claude/cloud-node-deploy` 合入 main 须用户同意。
