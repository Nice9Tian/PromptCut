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
