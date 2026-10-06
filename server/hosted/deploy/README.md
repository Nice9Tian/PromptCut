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
| `nginx-site-promptcut-stages.conf` | `/etc/nginx/sites-available/promptcut-stages`，链到 `sites-enabled/` | s1、s2 两个舞台源：只给 `/media`、`/media-s/`（凭 cookie 读素材）、`/editor`（含舞台入口 `stage.html` 与自检用的 `_iso/`）、`/catalog/` |
| `nginx-snippet-promptcut-stage-headers.conf` | `/etc/nginx/snippets/promptcut-stage-headers.conf` | 舞台源每个响应都带的头：内容安全策略、出口白名单 `Connection-Allowlist`、关 DNS 预解析，以及原有三条。舞台源的每个 location 都 include 它 |
| `nginx-snippet-promptcut-editor-policy.conf` | `/etc/nginx/snippets/promptcut-editor-policy.conf` | 主站 `/editor` 各 location 多带的一条 `frame-src`（舞台 iframe 只能载入本源与两个舞台源） |
| `nginx-gzip.conf` | `/etc/nginx/nginx.conf` 的 `http { }` 里 | 动态压缩的类型 |
| `nginx-mime-wasm.conf` | `/etc/nginx/mime.types` 的 `types { }` 里 | 只在 mime.types 没有 wasm 时加 |
| `sysctl-90-promptcut-bbr.conf` | `/etc/sysctl.d/90-promptcut-bbr.conf`，再 `modprobe tcp_bbr`、`echo tcp_bbr > /etc/modules-load.d/promptcut-bbr.conf`、`sysctl -p /etc/sysctl.d/90-promptcut-bbr.conf` | BBR 与 MTU 探测：高延迟、有丢包的线路上 cubic 会把单连接压到每秒十几 KB |

## 在线执行用户卡与图卡的隔离

在线浏览器在两个舞台源里执行用户卡与图卡的代码（`docs/plan/online-card-exec-contract.md` 第 3、4 节）。隔离靠舞台源的响应头与两条 `/media-s/` 路由，都在上面的模板里：

- 两个片段由 `node scripts/gen-stage-policy-nginx.mjs` 从 `src/online/stagePolicy.mjs` 生成（`--check` 只核对），不要手改；本机仿 nginx 的代理 `scripts/probes/lib/hosted-proxy.mjs` 与在线构建里舞台入口的 `<meta>` 取的是同一份策略。片段里的 `{{DOMAIN}}` 与站点配置一起替换，放到 `/etc/nginx/snippets/` 下。
- `/media-s/<会话号>/_grant`：编辑页面把只读素材票据交来，换成 HttpOnly cookie，卡片代码读不到；只认主站的源。`/media-s/<会话号>/media/<哈希>`：凭 cookie 读素材，nginx 把 cookie 换成 `Authorization` 头转给素材服务。素材服务不用改；原来的 `/media` 保留。
- **顺序：先改 nginx 再换页面。** 先放两个片段、换两份站点配置，`nginx -t` 通过后 `systemctl reload nginx`（不重启托管服务），再换在线页面。
  - 旧页面在新 nginx 下照常工作：它的舞台地址仍是 `/editor/?stage=1`，素材照旧走 `/media` 加 `?t=`；新加的响应头里不含 Trusted Types，不影响它。
  - 新页面在旧 nginx 下不会裸奔：舞台入口自带同文的 `<meta>` 策略，但舞台自检只认响应头那一份，判「没有隔离」，本页不执行用户卡与图卡，素材照旧走 `?t=`。
- 改完后核一遍：`curl -sI https://s1.{{DOMAIN}}/editor/stage.html` 有 `Content-Security-Policy`（含 `frame-ancestors https://{{DOMAIN}}`）与 `Connection-Allowlist`；`curl -sI https://s1.{{DOMAIN}}/editor/_iso/ok` 是 204、`/editor/_iso/redirect` 是 302；`curl -s -o /dev/null -w '%{http_code}' -X POST https://s1.{{DOMAIN}}/media-s/0123456789abcdef0123456789abcdef/_grant` 是 403（没有主站的 `Origin`）；`curl -sI https://{{DOMAIN}}/editor` 有 `frame-src`。
- **托管方的总开关**：`/opt/promptcut-hosted/editor/runtime-config.json` 里加一项 `"onlineCardExec": false`（例如 `{ "v": 1, "stageOrigins": [...], "onlineCardExec": false }`），在线页面就整体退回原来的做法，不执行用户卡与图卡；删掉这一项或写 `true` 就是开（缺省）。页面每次打开时读，不用重启任何服务。`deploy-hosted --stage-origins` 会重写这个文件，重新部署后要把这一项加回去。
- WebRTC 由 `Connection-Allowlist` 在浏览器里拦下（Chrome 152、154 实测）；不认这个响应头的浏览器靠页面里的脚本加固，那不是浏览器的保证。

证书：先装好站点配置里不含 ssl 的部分或用发行版默认站点占住 80 端口，再 `certbot certonly --nginx -d {{DOMAIN}} -d s1.{{DOMAIN}} -d s2.{{DOMAIN}}` 签一张三个名字的证书，路径与模板里的 `/etc/letsencrypt/live/{{DOMAIN}}/` 一致。删掉发行版的 `sites-enabled/default`。
