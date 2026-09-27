# AGENT-c10-catalog 报告

分支 `claude/c10-catalog`，起点 2f7f821（C10 最终集成提交，它的在线构建已部署在阿里云）。

任务：在线浏览器模式里内置的 Lottie、粒子素材卡请求 `/catalog/<kind>/<name>.json` 拿不到，画面空白。在线构建产出 catalog，托管端 nginx 放行 `/catalog/`。

## 做了什么

- `server/online-catalog.mjs`（新）：`catalogEntries(root)` 读 `server/catalog/{lottie,particles}/index.json` 的登记条目（名字只认 `[A-Za-z0-9-]+`、文件必须在，与桌面中间件放行的集合相同）；`onlineCatalogPlugin` 在 `generateBundle` 里把它们原样（逐字节）产出到输出目录的 `catalog/<kind>/<name>.json`。index.json 本身不产出（页面在构建时 import 它，运行时不读）。
- `vite.config.ts`：只在 `onlineConfig` 的插件表里加 `onlineCatalogPlugin(process.cwd())`，并补注释。桌面构建与开发服务器不变。
- **没改 `src/`**。卡片参数里的地址仍是 `/catalog/…`，同一个项目桌面、在线都能开。
- `server/test/c10a-online-build.test.mjs` 加守门测试（复用同文件已有的一次在线构建）：
  - C10-CATALOG-01 在线构建的 `catalog/` 与 index.json 登记的条目一一对应（不多不少）、逐字节相同，登记的 `url` 就是产物路径；
  - C10-CATALOG-02 桌面构建不带 `catalog/`。
  - 反证：临时去掉插件，C10-CATALOG-01 判红（已还原）。
- `scripts/probes/c10-catalog-probe.mjs`（新）：本机托管组合 + 仿 nginx 的三个源（编辑器页 +0、舞台 +1/+2），`/catalog/` 按下面 nginx 片段的规则提供；桌面 dev server 当创建者，放 `lottie-bodymovin` 与 `particles`（config=`/catalog/particles/bubble.json`），放云端取邀请链接；电脑浏览器成员进入后停在两张卡上等精确活渲。`--no-catalog` 不开 `/catalog/` 路由，重现修之前的线上。
- 部署脚本：`deploy-hosted --editor` 把整个在线构建目录 scp 成 `.incoming-editor` 再整体换名成 `editor/`（`server/hosted/deploy.mjs` 的 `editorSwapLines`），`catalog/` 随在线构建一起上去，不需要改。

## 托管端 nginx 片段（主站与 s1/s2 两个舞台源的 server 块各加一份）

```nginx
  # 动效素材目录（server/online-catalog.mjs：在线构建把 server/catalog/<kind>/index.json 登记的 Lottie、粒子文件产出到 editor/catalog/）。
  # 卡片参数里存的是同源绝对路径 /catalog/<kind>/<名>.json（桌面由开发服务器中间件提供），在线由这里提供。
  # 主站（编辑器页的源）与 s1/s2 两个舞台源的 server 块里各加一份（舞台 iframe 里的 fetch 解析到舞台自己的源）。
  # 只放行 /catalog/(lottie|particles)/<[A-Za-z0-9-]+>.json，与桌面中间件的形状相同；其余 /catalog/… 一律 404（不列目录、不给 index.json）。
  # if 里只有 return，是 nginx 文档认可的安全用法。缓存用 no-cache（文件名不带哈希，换代后靠 ETag / Last-Modified 重新验证，同桌面中间件）。
  location ^~ /catalog/ {
    root /opt/promptcut-hosted/editor;
    if ($uri !~ "^/catalog/(lottie|particles)/[A-Za-z0-9-]+\.json$") { return 404; }
    try_files $uri =404;
    charset utf-8; charset_types application/json;
    add_header Cache-Control "no-cache" always; add_header Referrer-Policy "no-referrer" always; add_header X-Content-Type-Options "nosniff" always; add_header Origin-Agent-Cluster "?1" always;
  }
```

- 舞台源那份放在 `location / { return 404; }` 之前或之后都行（`^~` 前缀优先于普通前缀）。演练实例的部署目录不同时把 `root` 换成 `<部署目录>/editor`。
- 缓存头与任务书的「与 /editor 相同」有一处不同：`/editor/` 的非 assets 是 `no-store`，这里用 `no-cache`（允许 304 重新验证，内容不会过期；与桌面中间件相同）。要完全照 `/editor` 就改成 `no-store`，其余不变。
- 本机没有 nginx（也没有 docker），片段没有用真 nginx 跑过 `nginx -t`；本机探针用 Node 仿同一规则。上线后主会话请跑一次 `nginx -t` 并 `curl -I` 核：`/catalog/lottie/bodymovin.json` 200、`/catalog/lottie/no-such.json` 404、`/catalog/magicui/index.json` 404、`/catalog/lottie/index.json` 404（index.json 未产出）。
- 附带：现有 `location /editor/`（`try_files $uri /editor/index.html`）也会把 `/editor/catalog/…` 当静态文件发出去，内容相同、无害。

## 验证

见文末「验证记录」。

## 没做成的、另发现的

- **粒子卡在编辑器预览里停住时画面是空的，与 /catalog/ 无关，2f7f821 上桌面也一样**：桌面 dev server、无头与有头 Chrome、简单参数（不填 config）都复现 —— tsParticles 生成的 1920×1080 canvas 在位（说明配置取到、引擎装上），但 2d 像素全透明。所以探针对粒子卡判的是「引擎装上 + 在线与桌面像素一致」，没有判「画面非空」。修它要改 `src/cards/native/particles.tsx`（会改代码版本），不在本任务范围，建议另立任务。
