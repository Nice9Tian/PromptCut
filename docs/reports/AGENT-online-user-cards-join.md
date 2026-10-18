# 报告：账号项目里在线页面画出用户卡、云端渲染服务进项目（`gemini/online-user-cards-join`）

- **日期**：2026-10-18
- **分支**：`gemini/online-user-cards-join`
- **任务书**：[`docs/plan/online-user-cards-render-join-task.md`](../plan/online-user-cards-render-join-task.md)
- **目标项目**：`sp_4lcukykm2blylc5lok7za46yu3`（「九天之测试」，账号 `9tian` / `acc_f17cf0ab2b14547df056b54f`）

---

## 1. 改动总览与根因分析

### 1.1 舞台站点票据形状回归核对（不重做）
- 节点 `/etc/nginx/sites-available/promptcut-stages` 第 14、17、28 行已支持旧口令项目的 `v1.<payload>.<sig>` 与账号项目的 43 字符 base64url 票据。
- 实测账号票据（43 字符）与旧 `v1.` 票据请求 `POST /media-s/<sid>/_grant` 均返回 `204` 并下发 `Set-Cookie: pc_rt=...; Path=/media-s/<sid>/; HttpOnly; Secure; SameSite=Strict`；42 字符非法票据返回 `400`，非允许来源 Origin 返回 `403`。

### 1.4 舞台同步用户卡参数中的 `/@media/<哈希>[.扩展名]` 路径转换
- **根因**：跨源舞台运行在 `s1`/`s2` 子域上，nginx 仅暴露 `/media`、`/media-s/`、`/editor`、`/catalog/`，不提供桌面开发服务器的 `/@media/…` 路由（请求返回 `404`）。素材效果卡经 `cardMediaUrl` 转换，而用户卡（如 `fp-photo-scan`）直接读取 `<img src={params.photo}>`（值为 `/@media/a6a575c5f6d02d96d99edd3a42430a6de8f6906f8219daadf6fd3348ba6695e6`）。
- **修复**：在 [`src/render/mediaTier.ts`](../../src/render/mediaTier.ts) 新增 `resolveCardParams(params, p)`，并在 [`src/render/Stage.tsx`](../../src/render/Stage.tsx) 的 `DirectCard`、`GraphCard`、推帧卡 `<C>` 与 `GlPlane` 传参处统一包裹：
  - 桌面模式（`!p.online && !p.remote`）原样返回同一对象引用，不改变 `React.memo` 比较与导出像素基线；
  - 在线舞台将匹配 `/^\/@media\/[0-9a-f]{64}(?:\.[a-z0-9]+)?$/i` 的字符串参数映射为 `remoteMediaUrl(v, p.remote)`（cookie 模式下为 `/media-s/<sid>/media/<哈希>`，远程未就绪时给 `""` 避免向跨源舞台发 `/@media/` 404），并用 `WeakMap` 按 `(params, base, ticket, cookieSid)` 缓存转换结果以保持引用稳定。
- **单测**：[`src/render/mediaTierLowMemory.test.mjs`](../../src/render/mediaTierLowMemory.test.mjs) 新增 `LMT10`。

### 1.5 跨站舞台 `SameSite=Strict` Cookie 实测与同站舞台切换
- **切换前实测方法与结果**：
  - 方法：在节点使用无头浏览器 `chrome-headless-shell` 顶层页面导航至 `https://visuhive.com/login`，在页面内挂载 `https://s1.149-88-94-84.sslip.io/editor/stage.html` iframe，由顶层向 `https://s1.149-88-94-84.sslip.io/media-s/0123456789abcdef0123456789abcdef/_grant` 发送带 43 字符票据与 `credentials: "include"` 的 `POST`，通过 CDP `Network.responseReceivedExtraInfo`（`blockedSetCookieWithReason`）与 `Network.getCookies` 观测 cookie 存储及后续舞台同源 `fetch` 状态。
  - 结果：`_grant` 返回 `204`，但 CDP 报告 `blockedReasons: ["SchemefulSameSiteStrict"]`，`storedCookies: []`（0 条），随后跨站 iframe 内请求 `/media-s/<sid>/media/<hash>` 因未携带 `pc_rt` cookie 返回 `401`。实测证实契约 4.1 节「两个舞台源必须与编辑器页同站」。
- **`runtime-config.json` 切换前后预演（Dry Run）**：
  - 切换前（`/opt/promptcut-hosted/editor/runtime-config.json`）：
    ```json
    {
      "docUrl": "wss://149-88-94-84.sslip.io/hosted/",
      "assetBase": "https://149-88-94-84.sslip.io/media/api/asset",
      "stageOrigins": [
        "https://s1.149-88-94-84.sslip.io",
        "https://s2.149-88-94-84.sslip.io"
      ],
      "onlineCardExec": true
    }
    ```
  - 切换后（按用户拍板：`https://149-88-94-84.sslip.io/editor` 直接 301 跳转 `https://visuhive.com/editor/`，在线编辑器与舞台统一用 `visuhive.com`）：
    ```json
    {
      "docUrl": "wss://visuhive.com/hosted/",
      "assetBase": "https://visuhive.com/media/api/asset",
      "stageOrigins": [
        "https://s1.visuhive.com",
        "https://s2.visuhive.com"
      ],
      "onlineCardExec": true
    }
    ```
- **证书签发与 nginx 配置切换**：
  - 核实 `s1.visuhive.com`、`s2.visuhive.com` DNS A 记录均解析至 `149.88.94.84`。
  - 使用 `certbot certonly --webroot -w /var/www/landing -d s1.visuhive.com -d s2.visuhive.com` 签发证书 `/etc/letsencrypt/live/s1.visuhive.com/fullchain.pem`。
  - 更新 `/etc/nginx/sites-available/promptcut-stages`（新增 `s1.visuhive.com s2.visuhive.com` 443/80 服务块，保留原 `sslip.io` 舞台块兼容）、`/etc/nginx/snippets/promptcut-editor-policy.conf`（`frame-src` 加入 `https://s1.visuhive.com https://s2.visuhive.com`）、`/etc/nginx/sites-available/promptcut`（`/editor` 及 `/editor/` 301 跳转至 `https://visuhive.com/editor/`），`nginx -t && systemctl reload nginx`。
  - 同站切换后复测：`blockedSet: []`，`storedCookies` 含 `pc_rt`（`domain: "s1.visuhive.com", sameSite: "Strict", httpOnly: true, secure: true`），舞台内请求 `/media-s/<sid>/media/a6a575c5f6d02d96d99edd3a42430a6de8f6906f8219daadf6fd3348ba6695e6` 返回 `200 image/jpeg`（`1280×1810`）。

### 1.6 初载同步用户卡变成 `ready` 或测量完成后自动结算当前帧
- **根因**：初载进入项目时，`fp-photo-scan` 尚未完成双舞台转译握手，首次 `setTime(0, { settle: true })` 按未就绪同步卡将其抑制（显示沙漏）并记入 `swapTrace`（`pipeline: "heavy", record: false`）。随后卡片变为 `ready`、后台探针完成测量（`probeRun.done: 1`）并更新分派表为 `light`，但暂停态的 `sendSetTime` effect 仅依赖 `[stageReady, live, playing, t, playToken, scrubbing, sendSetTime]`，不随卡片运行状态或分派表重算触发，导致画面一直停在沙漏直到用户手动移动播放头。
- **修复**：在 [`src/editor/planDispatch.ts`](../../src/editor/planDispatch.ts) 导出 `onPlanUpdated` 订阅函数；在 [`src/editor/Preview.tsx`](../../src/editor/Preview.tsx) 订阅 `onPlanUpdated`、`onCardRunStatesChanged` 与 `onProbeProgress`（当 `running` 由 `true` 变为 `false` 时），在暂停态且非拖动/低内存测量期间排入微任务执行 `sendPlanTo("front")`、`pumpRef.current()` 与 `sendSetTimeRef.current(tRef.current, { settle: true })`。
- **单测**：[`src/editor/onlineCardsL.test.mjs`](../../src/editor/onlineCardsL.test.mjs)、[`src/editor/onlineUserCards.test.mjs`](../../src/editor/onlineUserCards.test.mjs)、[`server/test/c10-ui-gates.test.mjs`](../../server/test/c10-ui-gates.test.mjs)。

### 1.2 文档服务目录计入账号项目成员与 `bump` / `lingering` 修复
- **根因**：
  1. 节点上正在运行的 `/opt/promptcut-v2/releases/35f7b2ab/pc/server/docservice/modules/hosted.mjs` 缺少 `bump` 返回新值、归零删除空键以及 `lingering` 写入；且 `connect()` 在 `conns.set(connId, ...)` 时未保存 `key`，重入同 `connId` 覆盖时若 `classOf` 改变会导致旧键计数残留，且 `lingering` 在重入删除内层键后未清理空外层 Map。
  2. 账号模式下渲染服务连接（`scope: 'service', service: 'render', role: 'render', realm: 'account', identityVersion: 2`）在三处被账号 v2 门禁误拦：
     - [`server/docservice/operation-wiring.mjs`](../../server/docservice/operation-wiring.mjs) 的 `checkPrincipal` 将所有 `principal.role !== 'page'` 视为 Agent 运行（要求 `runGrantId` 等四项字段），导致渲染服务拉取项目快照 `project.snapshot.get` 报 `run-provider-unavailable`；
     - [`server/docservice/modules/actor.mjs`](../../server/docservice/modules/actor.mjs) 的 `actorOf` 对 `realm === 'account'` 一律要求用户的 `accountId/loginId/credentialId/loginGeneration`，导致渲染服务向内容库写 `layers:<id>` 或 `render-manifest` 时报 `invalid-account-principal`；
     - [`server/account/authority.mjs`](../../server/account/authority.mjs) 的 `checkAccess` 在 `principal.service === 'render'` 分支返回的对象缺少 `authorityId`、`loginId`、`credentialId`、`loginGeneration`、`authorizationId`、`accessRevision`、`revocationSeq`，导致独立素材服务 `createAssetDocClient` 校验返回结果时报 `503 asset-authority-protocol`。
- **修复**：
  - 更新 [`server/docservice/modules/hosted.mjs`](../../server/docservice/modules/hosted.mjs)（`connect` 记录 `key`、清理空 `lingering` 外层 Map、`describe()` 暴露 `lingering`）；
  - 更新 [`server/docservice/operation-wiring.mjs`](../../server/docservice/operation-wiring.mjs)：对 `scope === 'service' && service === 'render' && role === 'render'` 的只读操作交由 `authority.checkAccess` 核验，写操作拒绝（`403 operation-forbidden`）；
  - 更新 [`server/docservice/modules/actor.mjs`](../../server/docservice/modules/actor.mjs)：对账号域下的 `service:render` 服务连接生成 `{ userId, deviceId, role: 'render', conversation: null, session }`；
  - 更新 [`server/account/authority.mjs`](../../server/account/authority.mjs)：补齐渲染服务 `checkAccess` 返回的协议字段并兼容 `asset-doc-client` 白名单过滤后的二次核验。
- **单测**：[`server/test/hosted-render-identity.test.mjs`](../../server/test/hosted-render-identity.test.mjs)（`HR5b`）、[`server/test/operation-wiring-core.test.mjs`](../../server/test/operation-wiring-core.test.mjs)、[`server/test/asset-doc-client.test.mjs`](../../server/test/asset-doc-client.test.mjs)。

### 1.3 升级 `promptcut-render` 至当前发布目录并验证隔离工作进程预渲染重卡
- **根因**：
  1. `pm2 describe promptcut-render` 原指向旧目录 `/opt/promptcut-render/releases/41b6d3358438/server/hosted-render/main.mjs`；
  2. [`server/hosted-render/main.mjs`](../../server/hosted-render/main.mjs) 末尾入口判断 `import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href` 在通过符号链接 `/opt/promptcut-render/current/server/hosted-render/main.mjs` 启动时，因 ESM 规范将 `import.meta.url` 解析为真实路径 `/opt/promptcut-render/releases/35f7b2abb9db/...` 而与未解符号链接的 `process.argv[1]` 不等，导致 `main()` 不执行直接退出。
- **修复**：在 [`server/hosted-render/main.mjs`](../../server/hosted-render/main.mjs) 使用 `fs.realpathSync(process.argv[1])` 解析真实路径后比对；将 `/opt/promptcut-render/current` 软链与 `/opt/promptcut-render/pm2.config.cjs` 切至 `/opt/promptcut-render/releases/35f7b2abb9db` 并 `pm2 save`。

---

## 2. 验收项逐条证据（第 2 节 1～8）

### 验收项 1（1.1 回归核对）
- **舞台 `_grant` 新旧票据回归实测**：
  ```text
  account_43char: 204
  set-cookie: pc_rt=f1d32c80702b4da5ba879be60132502186787912921; Path=/media-s/0123456789abcdef0123456789abcdef/; HttpOnly; Secure; SameSite=Strict
  legacy_v1: 204
  set-cookie: pc_rt=v1.eyJwIjoxfQ.abcdef0123456789; Path=/media-s/0123456789abcdef0123456789abcdef/; HttpOnly; Secure; SameSite=Strict
  bad_42char: 400
  bad_origin: 403
  ```
- **在线页面诊断返回值（`https://visuhive.com/editor/` 打开 `sp_4lcukykm2blylc5lok7za46yu3`）**：
  - `__pcCardExecDiag()`：
    ```json
    {
      "available": true,
      "visual": true,
      "run": {
        "fp-photo-scan": {
          "state": "ready",
          "version": "10976e82acf290"
        }
      },
      "bundles": [
        {
          "entry": "src/cards/user/fp-photo-scan.tsx",
          "ok": true,
          "state": null
        }
      ],
      "stages": {
        "A": {
          "graph": "unknown",
          "states": [["fp-photo-scan", { "state": "ready" }]]
        },
        "B": {
          "graph": "unknown",
          "states": [["fp-photo-scan", { "state": "ready" }]]
        }
      }
    }
    ```
  - `document.querySelectorAll('[data-testid="local-pc-badge"]').length`：`0`
  - `placeholders`：`[]`（无「需要本地 PC 渲染辅助」占位图标或徽标）

### 验收项 2（1.6 打开项目什么都不点，几秒内活渲出来、不停在沙漏）
- **在线页面初载（`t = 0`，未点击时间轴或播放按钮）诊断返回值**：
  ```json
  {
    "frontId": "A",
    "suppressed": [],
    "probeRun": {
      "probed": [
        {
          "clipId": "c-mvcoeoxh-1",
          "cardId": "fp-photo-scan",
          "identityKey": "692d0b54994b6",
          "at": 1792278866120
        }
      ],
      "running": false,
      "done": 1,
      "total": 1
    },
    "swapTrace": [
      {
        "at": 2352,
        "op": "settle",
        "t": 0,
        "stale": 0,
        "plan": true,
        "costs": 0,
        "cards": [{ "id": "c-mvcoeo", "pipeline": "heavy", "key": null, "record": false }]
      },
      {
        "at": 4566,
        "op": "settle",
        "t": 0,
        "stale": 0,
        "plan": true,
        "costs": 1,
        "cards": [{ "id": "c-mvcoeo", "pipeline": "light", "key": "692d0b5499", "record": true, "vtOk": true, "tier": "seek" }]
      }
    ]
  }
  ```

### 验收项 3（1.4 舞台图片请求走 `/media-s/<sid>/media/<哈希>`，不请求 `/@media/…`，导出像素基线不变）
- **舞台 iframe 内 `<img>` 元素与网络请求实测**：
  ```json
  {
    "stageImgs": [
      {
        "origin": "https://s1.visuhive.com",
        "src": "https://s1.visuhive.com/media-s/1254ec4a67051dd44635ebf44f03b896/media/a6a575c5f6d02d96d99edd3a42430a6de8f6906f8219daadf6fd3348ba6695e6",
        "complete": true,
        "naturalWidth": 1280,
        "naturalHeight": 1810
      },
      {
        "origin": "https://s2.visuhive.com",
        "src": "https://s2.visuhive.com/media-s/1254ec4a67051dd44635ebf44f03b896/media/a6a575c5f6d02d96d99edd3a42430a6de8f6906f8219daadf6fd3348ba6695e6",
        "complete": true,
        "naturalWidth": 1280,
        "naturalHeight": 1810
      }
    ],
    "mediaRequests": [
      {
        "url": "https://s1.visuhive.com/media-s/1254ec4a67051dd44635ebf44f03b896/_grant",
        "status": 204,
        "mimeType": ""
      },
      {
        "url": "https://s2.visuhive.com/media-s/1254ec4a67051dd44635ebf44f03b896/_grant",
        "status": 204,
        "mimeType": ""
      },
      {
        "url": "https://s1.visuhive.com/media-s/1254ec4a67051dd44635ebf44f03b896/media/a6a575c5f6d02d96d99edd3a42430a6de8f6906f8219daadf6fd3348ba6695e6",
        "status": 200,
        "mimeType": "image/jpeg"
      },
      {
        "url": "https://s2.visuhive.com/media-s/1254ec4a67051dd44635ebf44f03b896/media/a6a575c5f6d02d96d99edd3a42430a6de8f6906f8219daadf6fd3348ba6695e6",
        "status": 200,
        "mimeType": "image/jpeg"
      }
    ],
    "atMediaRequests": []
  }
  ```
- **桌面与导出像素基线核对**：
  - 命令：`bash .worktrees/_export-baseline/check-commit.sh gemini/online-user-cards-join online-user-cards-join 5560`
  - 退出码：`0`，`240 / 240` 帧 PNG 与基线逐字节一致（`PASS`）。

### 验收项 4（1.5 跨站/同站 Cookie 实测与同站舞台户型图渲染）
- **跨站（`visuhive.com` + `s1.149-88-94-84.sslip.io`）与同站（`visuhive.com` + `s1.visuhive.com`）对比实测输出**：
  ```json
  {
    "beforeCrossSite": {
      "topOrigin": "https://visuhive.com",
      "stageOrigin": "https://s1.149-88-94-84.sslip.io",
      "grantStatus": 204,
      "storedCookies": [],
      "blockedSet": [
        [
          {
            "name": "pc_rt",
            "blockedReasons": ["SchemefulSameSiteStrict"]
          }
        ]
      ],
      "stageFetchStatus": 401
    },
    "afterSameSite": {
      "topOrigin": "https://visuhive.com",
      "stageOrigin": "https://s1.visuhive.com",
      "grantStatus": 204,
      "storedCookies": [
        {
          "name": "pc_rt",
          "domain": "s1.visuhive.com",
          "path": "/media-s/0123456789abcdef0123456789abcdef/",
          "sameSite": "Strict",
          "httpOnly": true,
          "secure": true
        }
      ],
      "blockedSet": [],
      "mediaGetStatus": 200,
      "mediaContentType": "image/jpeg"
    }
  }
  ```

### 验收项 5（1.2 成员在线时渲染服务进项目、离开过 `lingerMs` 后回 `active: false` 及单测）
- **成员页面在线时 `curl -s http://127.0.0.1:5399/status`**：
  ```json
  {
    "directory": {
      "connected": true,
      "list": [
        {
          "projectId": "sp_4lcukykm2blylc5lok7za46yu3",
          "enabled": true,
          "active": true,
          "members": true
        }
      ]
    },
    "projects": [
      {
        "projectId": "sp_4lcukykm2blylc5lok7za46yu3",
        "members": true,
        "drain": false,
        "nodeId": "hosted-render:8fD__SeRgloe/4lcukykm",
        "streams": false
      }
    ]
  }
  ```
- **成员全部离开、满 `lingerMs`（60 秒）后 `curl -s http://127.0.0.1:5399/status`**：
  ```json
  {
    "directory": {
      "connected": true,
      "list": [
        {
          "projectId": "sp_4lcukykm2blylc5lok7za46yu3",
          "enabled": true,
          "active": false,
          "members": false
        }
      ]
    },
    "projects": []
  }
  ```
- **单测**：`node --experimental-test-module-mocks --test server/test/hosted-render-identity.test.mjs`（20/20 通过，含 `HR5b 账号项目成员连接计入与撤出、bump 归零删键、lingering 写入与到期清零`）。

### 验收项 6（1.3 渲染服务版本对齐、起隔离工作进程并为判重卡产出层表与渲染结果）
- **`status.codeVersion`**：
  ```json
  {
    "self": "cd21031ff55682159cf20055c1006311caae4f8af555e81dd387f71cb559eca9",
    "editor": "same",
    "agent": "unknown",
    "expect": null,
    "match": true
  }
  ```
- **放入判重卡 `probe-slow-stepped`（`c-heavy-verify-2`，`burnMs: 40`，`[5s, 6s]`）后隔离工作进程状态与产物**：
  - `status.isolation`：
    ```json
    {
      "enabled": true,
      "port": 5410,
      "current": {
        "projectId": "sp_4lcukykm2blylc5lok7za46yu3",
        "phase": "running",
        "worked": true
      },
      "runs": 7,
      "worker": {
        "pid": 834388,
        "running": true,
        "ready": true,
        "starts": 1,
        "exits": 0
      },
      "queue": {
        "profile": "host",
        "worker": "isolated",
        "codeVersion": "cd21031ff55682159cf20055c1006311caae4f8af555e81dd387f71cb559eca9",
        "envFingerprint": "0326290ea8e62e3d",
        "capabilities": {
          "userCards": true,
          "graphCards": false,
          "transcode": true,
          "streams": true
        },
        "nodes": [
          {
            "projectId": "sp_4lcukykm2blylc5lok7za46yu3",
            "nodeId": "hosted-render-iso:8fD__SeRgloe/4lcukykm",
            "connected": true,
            "claimed": 5,
            "completed": 1,
            "plans": 3,
            "failed": 0,
            "cards": { "state": "synced", "count": 1 }
          }
        ]
      }
    }
    ```
  - 项目层表 `layers:p-mvcg7qba-763f629a`（由渲染服务 `service:render@8fD__SeRgloesMVxJY97tw` 写入 `snapshot-manifest`）：
    ```json
    {
      "kind": "snapshot-manifest",
      "key": "layers:p-mvcg7qba-763f629a",
      "hash": "f6388e44e00601195cb55a5b48e05f6422012854a66236d150efe47b6552fb0d",
      "actor": {
        "userId": "service:render@8fD__SeRgloesMVxJY97tw",
        "deviceId": "8fD__SeRgloesMVxJY97tw",
        "role": "render",
        "conversation": null,
        "session": null
      },
      "at": 1792281326654,
      "body": {
        "v": 3,
        "kind": "layer-map",
        "projectId": "p-mvcg7qba-763f629a",
        "entryKey": "a7a26a77dfa3fb027fa2eee783c68de5275e0f76d1b71061036d457e8b1d2a66",
        "fps": 30,
        "width": 1920,
        "height": 1080,
        "span": 60,
        "at": 1792281326650,
        "layers": [],
        "streams": [
          {
            "topClipId": "c-heavy-verify-2",
            "clipIds": ["c-heavy-verify-2"],
            "kind": "card",
            "plane": "local",
            "contentKey": "58dde5b90cabc89bcd423384af1b5aca01dea169097048d4d713a73d5b61704f",
            "candidates": [
              {
                "envFingerprint": "0326290ea8e62e3d",
                "resultKey": "73c1d720d7e25d135408e4adc56447693b2f47b45a144e9ed72b74c78f6f9cc2"
              }
            ],
            "originFrame": 150,
            "lastSegment": 1,
            "segmentsPerTask": 8,
            "inputSig": "s1-fc3525e4c55300e9"
          }
        ]
      }
    }
    ```
  - 渲染服务产出的重卡层流清单 `73c1d720d7e25d135408e4adc56447693b2f47b45a144e9ed72b74c78f6f9cc2:0-1`（`render-manifest`）：
    ```json
    {
      "kind": "render-manifest",
      "key": "73c1d720d7e25d135408e4adc56447693b2f47b45a144e9ed72b74c78f6f9cc2:0-1",
      "hash": "1f4b252de3f727c3d91106c6f9d35da8d49b4fe73de2e9d54f5dd75e1af33474",
      "actor": {
        "userId": "service:render@8fD__SeRgloesMVxJY97tw",
        "deviceId": "8fD__SeRgloesMVxJY97tw",
        "role": "render",
        "conversation": null,
        "session": null
      },
      "at": 1792281340544,
      "body": {
        "v": 1,
        "kind": "stream",
        "resultKey": "73c1d720d7e25d135408e4adc56447693b2f47b45a144e9ed72b74c78f6f9cc2",
        "range": { "from": 0, "to": 1 },
        "header": {
          "kind": "card",
          "plane": "local",
          "clipIds": ["c-heavy-verify-2"],
          "fps": 30,
          "originFrame": 150,
          "lastFrame": 179,
          "bound": { "x": 0, "y": 0, "w": 1920, "h": 1080 },
          "offset": { "x": 0, "y": 0 },
          "tight": { "x": 472, "y": 412, "w": 342, "h": 256 }
        },
        "inits": {
          "e3be63353a47b3de": {
            "hash": "e3be63353a47b3debb8de6ba2758a933ab6078ccdb182f4eaca7c82aab9e13e8",
            "bytes": 783,
            "codec": "avc1.640032",
            "width": 1920,
            "height": 2176,
            "timescale": 30,
            "rect": { "x": 0, "y": 0, "w": 1920, "h": 1080 },
            "encoder": "libx264"
          }
        },
        "segments": {
          "0": {
            "hash": "806c1d444665e54d5141065e274c31b7d21b5a0f51fd7c84b19f339b348e548a",
            "bytes": 8081,
            "init": "e3be63353a47b3de",
            "stride": 15,
            "samples": 15,
            "encoder": "libx264"
          },
          "1": {
            "hash": "6e17634a14a8599698d0a077c15c41e44b87c1e0ef509dc6af274b91ad94a47a",
            "bytes": 8124,
            "init": "e3be63353a47b3de",
            "stride": 15,
            "samples": 15,
            "encoder": "libx264"
          }
        }
      }
    }
    ```
  - 验证完成后已移除临时重卡 `c-heavy-verify-2`，项目恢复为原样（仅 `t-1` 上的 `c-mvcoeoxh-1` `fp-photo-scan`）。

---

## 3. 本地基线验证与节点备份/回退说明

### 3.1 本地基线
- `npx tsc -b --force`：退出码 `0`（0 错误）。
- `npm test`（带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT` 与 `PROMPTCUT_PASSWORD_ORDER_MODULE`）：退出码 `0`（`tests 7096, pass 7082, fail 0, skipped 14`）。
- 行尾审计 `node out/main-session-tools/eol-audit.mjs . main HEAD`：全部改动文件 `LF -> LF, 孤立CR 0`。
- 导出像素基线 `check-commit.sh`：退出码 `0`（`240 / 240` 帧完全一致）。

### 3.2 节点部署备份与回退步骤
- **nginx 与 `runtime-config.json` 备份**：`/root/nginx-stages-visuhive-backup-20261017T1902Z/`
  - 回退：将备份下的 `promptcut`、`promptcut-stages`、`promptcut-editor-policy.conf` 拷回 `/etc/nginx/` 对应位置，将 `runtime-config.json` 拷回 `/opt/promptcut-hosted/editor/runtime-config.json`，执行 `nginx -t && systemctl reload nginx`。
- **在线编辑器静态包备份**：`/opt/promptcut-hosted/.editor-backups/editor-before-usercards-merged-20261017T2200Z`（及更早的 `editor-before-usercards-join-20261017T1909Z`）
  - 回退：`rm -rf /opt/promptcut-hosted/editor && cp -a /opt/promptcut-hosted/.editor-backups/editor-before-usercards-merged-20261017T2200Z /opt/promptcut-hosted/editor`。
- **文档服务与渲染服务代码及 PM2 备份**：`/root/usercards-join-backup-20261017T1909Z/`
  - 回退：
    1. 将 `/root/usercards-join-backup-20261017T1909Z/pc/{hosted.mjs,operation-wiring.mjs,actor.mjs,authority.mjs}.bak` 拷回 `/opt/promptcut-v2/releases/35f7b2ab/pc/server/` 对应路径，重启 `promptcut-doc-v2.service` 并运行 `asset-root-registry-publisher.mjs --config /etc/promptcut/asset-root/publisher.json --rotate`；
    2. 将 `/opt/promptcut-render/current` 指回 `/opt/promptcut-render/releases/41b6d3358438`，拷回 `/root/usercards-join-backup-20261017T1909Z/pm2.config.cjs.bak` 至 `/opt/promptcut-render/pm2.config.cjs`，执行 `pm2 startOrRestart /opt/promptcut-render/pm2.config.cjs && pm2 save`。
