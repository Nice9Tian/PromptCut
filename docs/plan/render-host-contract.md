# 独立渲染主机：契约（M6b）

状态：**定稿**（2026-09-26，主会话）。依据：主执行计划第 7 节 M6、第 12 节 D9 第 10 条；语义 `docs/semantics/architecture/platforms.md`「渲染节点」；M6a 契约 `docs/plan/auth-contract.md`（凭证、角色、空间）。〔裁〕是主会话定的细节。

## 1. 是什么

独立渲染主机，就是一台不带编辑界面、只开 `render` 连接的设备：
- 凭项目凭证进入一个或多个共享项目，认领本项目任何成员发布的细任务，产出推到项目所在的素材服务；
- 它和本机 PC 用同一个预渲染进程（语义「独立渲染主机和本机 PC 用同一个预渲染进程」），只是节点 `profile` 为 `host`，不替任何页面发布 `plan`。

## 2. 怎么起

- 入口 `scripts/render-host.mjs`：
  - 起一个编辑器 vite 服务（它会拉起预渲染进程），只绑回环，不开浏览器页面；
  - 端口用 `--port`（缺省 5400，测试用 5400～5409）；
  - 设这些环境变量：`PROMPTCUT_QUEUE_NODE=1`、`PROMPTCUT_NODE_PROFILE=host`、`PROMPTCUT_SHARED_CONFIG=<配置文件>`、`PROMPTCUT_STREAMS` 按参数。
- 配置文件形状沿用 M6a 契约第 11 节：
  - 数组，每项 `{ url, projectId, username, deviceId, deviceName, as: 'member', password | key, role: 'render' }`；
  - 另可给 `maxConcurrent`（缺省 1，上限 4）。
- 退出：收到 SIGINT 或 SIGTERM，让掉手里的认领、关连接、停子进程。退出码 0。

## 3. 节点行为

- **每个项目一条连接、一个节点**：
  - 配置里有几项，就开几条 `render` 连接，每条连到那个项目的文档服务，各报一次 `node.hello`；
  - 所有节点共用同一个预渲染执行器，并发总数不超过 `maxConcurrent`〔裁〕。
- **`node.hello`**：
  - `profile: 'host'`；
  - `capabilities: { userCards: true, graphCards: false }`，与 PC 节点相同；
  - `codeVersions: [本机 frameCode]`，一个主机实例只有一个代码版本〔裁：计划原文「按代码版本分 worker 池」落实为「每个实例一个版本，要多版本就起多个实例」，D6 本来就用两个实例〕；
  - `envFingerprint` 照本机探测结果。
- **不认领 `plan`**：主机只认领 `snapshot` 细任务，`plan` 留给发布方自己的节点（第 11.2 节「`plan` 就近认领」的一部分）。流任务在 M6c 接入之后才认领。
- **闲时门槛**：主机没有页面、没有播放，只要执行器有空位就认领。
- **产物**：
  - 推到该项目文档服务下发的素材服务地址（`service.endpoints` 里的 `asset`），用 `auth.ticket` 取的素材票据写；
  - 推完、收全再报 `complete`，与 PC 节点相同。
- **掉线与重连**：沿用 M5a 的传输（每次重连都重新取挑战，因为 `nonce` 只能用一次）。
- **诊断**：`GET http://127.0.0.1:<端口>/api/frames/queue` 回 `{ nodes: [{ projectId, connected, claimed, completed, dedup, failed, lost }], codeVersion, envFingerprint, maxConcurrent }`。复用预渲染进程已有的诊断口；没有就新增。

## 4. 队列侧

- 主机的 `render` 连接可以认领本空间里任何成员的细任务。
- 节点侧过滤照旧：`requires.codeVersion` 不在 `codeVersions` 里就不认领；指纹不符不认领；卡片锁照 F 节。
- `profile: 'host'` 的节点收到 `plan` 任务时直接跳过，不发认领。

## 5. 探针与测试

- **单测** `server/test/render-host.test.mjs`：
  - 配置解析（单项、数组、缺字段报错）；
  - 多项目开多条连接；
  - `plan` 跳过；
  - 并发上限；
  - 退出时让掉认领。
- **探针** `scripts/probes/render-host-probe.mjs`：
  - `--role creator`：
    - 起一个局域网模式的共享项目，用本机文档服务、素材服务；
    - 创建测试凭证，写出 host 配置文件；
    - 以本机节点身份发布一个项目的 `plan`。
  - `--role host --config <文件>`：起一个独立主机实例，等任务完成，输出一行 JSON：`{ ok, projectId, claimed, completed, codeVersion, envFingerprint, fails }`。
  - `--role check`：
    - 核对每个任务恰好一次 `task.done`；
    - 各节点完成数之和等于任务数；
    - 主机产的层与主 PC 单机重渲的结果逐像素相同（同指纹下）；
    - 输出一行 JSON。
- **H 系列在探针上怎么判**：
  - **H1**：`check` 的 `duplicateDone = 0`、`identical = true`；
  - **H2**：代码版本不同的实例 `claimed = 0`；
  - **H3**：没有凭证的实例连不上（握手 401），`claimed = 0`；
  - **H4～H10**：由 M6a 的单测覆盖，W5 上再用探针的 `--role auth-check` 跑一遍其中能跨机验的几项（错口令、限速、票据）。

## 6. 集成时的裁定（2026-09-26）

主会话在集成分支 `claude/m6-integ2` 上定的细节，以及集成对账时按这些裁定改的实现（报告 `docs/reports/AGENT-m6-integ2.md`）。

- **`maxConcurrent` 写在哪**：裁定：可写在数组任意一项上，取各项最大值，缺省 1；`render-host --max-concurrent`（环境变量 `PROMPTCUT_HOST_MAX_CONCURRENT`）给了就优先。理由：数组没有放全局字段的地方，写在项上最不改 M6a 的配置形状。
- **`maxConcurrent` 超过 4**：裁定：是配置错误，`code: 'bad-host-config'`，不截断；0、负数、小数、字符串同样报错。理由：静默压到 4 会让用户以为配了 9 路并发。〔集成时改：实现原来夹到 1～4、不合格的当没给，现改为 `hostMaxConcurrent` / `parseHostConfig` / `loadHostConfig` 一律报错，`createRenderHost` 收到超 4 的值也报错；RH1、RH4 按此改。〕
- **诊断计数**：裁定：`claimed`、`completed`、`dedup`、`failed`、`lost` 都是累计值；`completed` 不含 `dedup`，两者分开计。理由：H2 的「`claimed = 0`」按累计读才有意义；去重完成没有渲染，与真渲染分开才能看出主机干了多少活。（实现本来如此，没改。）
- **`plan` 跳过在哪一层**：裁定：在节点侧过滤器（`filter.mjs` 规则 6）与会话层做，即第 4 节的「节点侧跳过」；不接受只在主机外层过滤。队列侧不因 `profile: 'host'` 拒 `plan` 认领。（实现本来如此，没改。）
- **并发上限算什么**：裁定：计入正在认领中的（in-flight）——全部节点的「持有 + 在飞的认领」不超过 `maxConcurrent`。理由：两个项目的会话各有一条在飞认领时，只数持有会超上限。（实现本来如此，没改。）
- **执行器共用到哪一层**：裁定：接受「每个项目一个执行器对象，共用一个 `FramePipeline` 与一个全局并发闸」。理由：执行器按 `projectId@projectRev` 缓存、经那个项目的连接取快照，不同共享项目里的编辑器项目 id 可能相同，共用一个对象会串；并发、渲染间、帧库仍是同一份。第 3 节「所有节点共用同一个预渲染执行器」按此理解。
- **产物推到哪个素材服务**：裁定：接受「用文档服务下发的 `asset`；没有就用文档服务同 host 的 `/api/asset`；从不回落本机」。理由：局域网模式文档服务与素材服务同进程；推到主机自己的素材服务，发布方拉不到。
- **子进程临时目录**：裁定：接受 `render-host.mjs` 把子进程 `TEMP` / `TMP` 指到自己的数据目录。理由：编辑器往系统临时目录写 `promptcut/port.json`，主机写公共那份会把同机用户编辑器的 AI 面板指错。
- **主机配置的 `role`**：裁定（集成对账时按第 2 节的配置形状定）：某项给了 `role` 且不是 `render`，是配置错误 `bad-host-config`；不给按 `render`。理由：第 2 节形状写的是 `role: 'render'`，主机只开 `render` 连接，给别的角色多半是把页面用的配置拿错了。〔集成时改：实现原来接受任何合法角色、连接时一律改成 `render`。〕
- **素材回退的票据**：裁定（集成对账时修）：主机的 J.6 素材回退按回退基址挑票据，用那台素材服务所属项目的票据；同一台服务上有几个项目时用配置里靠前的那个；基址不属于任何项目时不带票据。理由：票据只在签发它的素材服务上有效，原来一律用第一个项目的票据，读第二个项目的素材服务会 401。〔集成时改：`asset-client.ts` 的 `setMediaFallbackTicket` 回调改为每试一个基址调一次、参数是基址；`render-node/host.mjs` 新增 `fallbackTicketFor`；补单测 RH-fallback-ticket。〕
- **`parseHostConfig`**：集成时在 `render-node/host.mjs` 补出（原来只有读环境变量的 `loadHostConfig`，解析逻辑现在由它承担，`loadHostConfig` 读文件后调它）。契约测试 RHC1～RHC4 直接测它。
