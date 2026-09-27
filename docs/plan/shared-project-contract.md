# 共享项目接入：阿里云托管与局域网：契约（SP）

状态：**定稿**（2026-09-26，主会话）。

**依据**：
- 主执行计划第 7 节 SP（D10 修订版）、第 12 节 D9；
- 语义 `product/document-service.md`（「部署组合」「连接发现」「局域网发现（已引入）」「共享项目与权限」）、`product/asset-service.md`（「凭票据读写」）；
- M6a 契约 `auth-contract.md`（含第 14 节集成裁定），M6b 契约 `render-host-contract.md`；
- 局域网发现方案的唯一出处 `direct-connect-plan.md`「设计要点」第 4 条（本契约只定参数，不另写方案）；
- 迁移流程 `hosting-migration.md`；
- 查资料（codex `gpt-6-sol` / `high`，第 9 节）。

〔裁〕是主会话定的细节。

---

## 1. 托管组合（阿里云上的一个进程）

- **入口 `server/hosted/main.mjs`**：一个 Node 进程，同时监听两个端口。
  - **文档服务**：`PROMPTCUT_DOCSERVICE_PORT`，缺省 8787，绑 `0.0.0.0`，`createSharedDocService({ mode: 'hosted' })`。
  - **素材服务**：`PROMPTCUT_ASSET_PORT`，缺省 8788，绑 `0.0.0.0`。
    - 独立的 HTTP 服务器，挂现有素材服务的中间件（C5 的 `BlobStore`，数据层用 `fs-store`）；
    - 与文档服务共用同一份凭证存储与票据核对（M6a 第 8 节「同进程共用」）。
  - 素材服务起来后，经回环地址、带集群令牌向本进程的文档服务登记公网地址 `PROMPTCUT_ASSET_PUBLIC_URL`（管理接口，M6a 第 10 节）；成员从 `service.endpoints` 拿到它。
- **数据目录** `PROMPTCUT_DATA_DIR`：全部持久数据都在它下面，拷走整个目录即可迁移（`hosting-migration.md`）。

  ```
  $PROMPTCUT_DATA_DIR/
    docservice/     文档服务的数据目录（local 空间的日志、tenants/<projectId>/、auth/）
    assets/         media/、snap/、px/，每个命名空间下按哈希前两位分 256 个子目录〔裁，第 9 节〕
    secrets/        cluster-token（0600），目录 0700
  ```

- **集群令牌**：从 `secrets/cluster-token` 读，文件不存在时回落环境变量 `PROMPTCUT_CLUSTER_TOKEN`。令牌随数据目录一起迁移，不进 PM2 的配置文件〔裁，第 9 节〕。
- **对外地址**：
  - `PROMPTCUT_DOCSERVICE_PUBLIC_URL`，形如 `ws://8.219.80.16:8787`，只作记录与诊断；
  - `PROMPTCUT_ASSET_PUBLIC_URL`，形如 `http://8.219.80.16:8788/api/asset`，登记给成员。
- **失败即关**：沿用 M6a 第 10 节。另加一条：数据目录不存在或不可写时退出码 1，打 `config.error { reason: 'data-dir' }`。
- **`fs-store` 的布局选项**：新增 `shard: true`，按哈希前两位分子目录，写入走同文件系统临时文件加改名。
  - 托管端用 `shard: true`；本机编辑器保持原布局不变〔裁：不动本机既有缓存〕。
  - 两种布局的读取互不兼容，所以布局记在 `assets/.layout` 里，启动时核对，对不上就拒绝启动。
- **磁盘满**：`ENOSPC`、`EDQUOT` 时写入回 507 `insufficient-storage`，不标记完成，已收的分片保留。
- **不渲染**：托管组合不挂预渲染进程，不起渲染节点。

## 2. 部署（`scripts/remote/docservice.mjs`）

- **新增 `deploy-hosted`**：
  - 拷 `server/hosted/`、`server/docservice/`、`server/auth/`、`server/asset-store/`、`server/render-queue/`，以及素材服务中间件依赖的最少文件（实现方列清单，写进本节的补充）；
  - 写出 PM2 配置，放在仓库外的部署目录：一个 fork 模式的 app `promptcut-hosted`，`instances: 1`，`max_memory_restart: '700M'`，`kill_timeout: 5000`；
  - 按需 `pm2 save`。
- **演练实例**（M8 迁移演练）：`--instance drill` 用 app 名 `promptcut-drill`，端口 8777 / 8778，数据目录另给，`max_memory_restart: '400M'`。
- **UFW**：部署脚本不改防火墙。放行规则由主会话在服务器上手工加：8788，演练时再加 8777、8778。每次都记进阶段报告。
- **日志轮转**：服务器上装 `pm2-logrotate`，单文件 10 MB、保留 7 份。它装在远端，已授权。

## 3. 客户端：新建与打开的路由

- **缺省托管地址**：`server/auth/hosted-default.mjs` 导出一个常量 `DEFAULT_HOSTED_URL = 'http://8.219.80.16:8787'`，它是源码里唯一出现这个 IP 的地方（守门测试）。覆盖顺序：
  - 界面上改过的值（C6.5 接上）；
  - 否则 `PROMPTCUT_HOSTED_URL`；
  - 否则缺省值。
- **`server/auth/route.mjs`**（Node 与浏览器通用，浏览器侧不做局域网发现）：
  - `findSharedProject({ name, hostedUrl, lan: { discover } })` 回 `{ candidates: [{ where: 'lan' | 'hosted', base, projectId, name, mode, hostDeviceName? }], errors: [{ where, reason }] }`：
    - 先在本网段发现，限时 3 s；再向托管端 `GET shared/lookup?name=`；
    - 两边都有就都列出，谁也不挑。
  - `createSharedProject({ where: 'hosted' | 'lan', … })`：
    - 托管端：向托管地址 `POST shared/create`；
    - 局域网：本机编辑器的文档服务 `POST /docservice/shared/create`，只有本机回环能建（M6a）。建成后开始广播（第 4 节）。
- 托管端连不上、局域网发现超时，都进 `errors`，不抛异常；两边都没有候选时，由调用方给出「找不到」。

## 4. 局域网发现（参数；方案见 `direct-connect-plan.md` 设计要点第 4 条）

| 项 | 值 |
|---|---|
| 组播地址与端口 | `239.255.42.99:54887/udp`（本地管理域） |
| 兜底 | 同时向每个选中网卡的**子网定向广播地址**发查询 |
| 选网卡 | 已启用、非回环、非链路本地（169.254/16）、有 IPv4 的网卡。接收端逐网卡 `addMembership(group, 网卡地址)`；发送端逐网卡 `setMulticastInterface` 后发送，`TTL = 1` |
| 查询 | 客户端开始查找时发 `{ magic: 'promptcut-lan', v: 1, type: 'query', nonce, name? }`，每 500 ms 重发，共 3 次 |
| 应答 | 主机收到查询，单播回 `{ …, type: 'announce', nonce, projectId, name, mode, hostDeviceName, docservice: 'ws://<网卡地址>:<端口>/docservice', asset: 'http://<网卡地址>:<端口>/api/asset', ttlMs: 45000 }`，其中地址取收到查询的那块网卡的 |
| 周期通告 | 主机每 15 s 加随机抖动（±3 s）通告一次；客户端 45 s 没见到就移除 |
| 包大小 | 单包 UTF-8 JSON ≤ 1 KiB，超出不发 |
| 不做防伪 | 局域网发现只找地址；进入仍要项目凭证（M6a） |

- **主机端**：放本机的共享项目建成后，编辑器进程开始广播与应答；项目删掉或编辑器退出时停。
- **手填兜底**：`findSharedProject` 接受 `lan: { manual: ['http://192.168.x.y:port'] }`，直接对这些地址 `GET /docservice/shared/lookup?name=`。浏览器只能用这一路（C10）。
- **网络变化**：网卡增减时（每 10 s 检查一次）重建成员资格。

## 5. 局域网主机的绑定

- 编辑器（vite）以局域网主机身份运行时，文档服务与素材服务随编辑器绑 `0.0.0.0`。现在编辑器缺省绑回环，要显式开 `PROMPTCUT_LAN_HOST=1`，或者由 C6.5 的旧入口「新建共享项目」选放本机时在运行时打开。
- 管理接口只认回环（M6a 第 10 节，已实现）。
- 绑非回环而凭证存储没加载，拒绝启动（M6a）。

## 6. 探针 `scripts/probes/shared-project-probe.mjs`

`--mode internet|lan`、`--role creator|member`，结果一行 JSON：

- **`--mode internet --role creator --hosted <url>`**：
  - 在托管端建项目，把项目快照和一个素材传上去；
  - 以本机 PC 节点身份发布 `plan`，等全部完成；
  - 写出成员配置，交给协调口，协调方式同 W5 探针的 `--coord`。
- **`--mode internet --role member --hosted <url> --coord <url>`**：
  - 不设集群令牌，凭项目凭证进入；
  - 读项目快照、带票据读素材、以 `render` 角色认领并完成至少 1 个任务；
  - 输出各项结果与 `task.done` 计数。
- **`--mode lan --role creator`**：起局域网主机（`PROMPTCUT_LAN_HOST=1`），建放本机的项目，开始广播。
- **`--mode lan --role member [--manual <url>]`**：发现（记录发现耗时）后进入，其余同上。
- **`--role migrate-check --from <url> --to <url>`**：迁移前后对比。逐项核对项目数、`projectRev`、素材与产物的哈希抽查，全部通过才 `ok: true`。

## 7. 验收（计划 SP1～SP8 的判法）

| 编号 | 判法 |
|---|---|
| SP1 | 本机起托管组合（端口 8790～8799）：member 不设令牌进入成功；快照读取、票据读写成功 |
| SP2 | 单测覆盖计划 SP2 的每一条（三种角色 + 独立主机不带令牌进入成功、凭证错被拒、托管端管理接口无令牌 401、局域网主机管理接口非回环连不上、回环无令牌成功） |
| SP3 | 一轮之后全部成员断开，新成员取回的项目快照、内容库条目、素材、产物逐项计数一致，且文件都在 `PROMPTCUT_DATA_DIR` 之下 |
| SP4 | 同网段发现 ≤ 5 s；发现与进入期间托管端连接数不变；本机单测用两个 dgram 套接字模拟；跨机在 W6 验 |
| SP5 | 单测覆盖四种候选组合 |
| SP6 | 守门测试：源码里 `8.219.80.16` 只出现在 `hosted-default.mjs`（测试、文档、探针除外）；三种覆盖顺序的单测 |
| SP7 | 本机两份托管组合（两个数据目录、两组端口），按 `hosting-migration.md` 拷数据目录后 `migrate-check` 通过 |
| SP8 | 跨机 W6：放本机（局域网直连）同 SP4；放云端按计划 SP8。托管端的磁盘占用、RSS、流量记进报告 |

## 8. 分支

| 子分支 | Agent | 内容 | 端口段 |
|---|---|---|---|
| `claude/sp-hosting` | `opus-dev-high` | 第 1、2 节，`fs-store` 的 `shard` 布局，`migrate-check` | 5470～5479，本机托管组合 8790～8799 |
| `claude/sp-routing` | `opus-dev-high` | 第 3、4、5 节 | 5480～5489 |
| `claude/sp-tests` | `opus-dev` | 照本契约独立写 SP 系列单测 | 5490～5499 |

## 9. 查资料的结论（codex，`gpt-6-sol` / `high`；原文在 scratchpad 的 `research-sp.md`）

| 题 | 结论 | 本契约怎么用 |
|---|---|---|
| Windows 组播 | 用 239.255/16 本地管理域；逐网卡加入与发送；TTL 1；查询应答为主、周期通告为辅；子网定向广播兜底；AP 隔离与防火墙会挡，要留手填 | **采纳**（第 4 节） |
| PM2 | 单进程 fork 模式、两端口；秘密随数据目录放 0600 文件；`restart` 会断 WebSocket，客户端要重连；装日志轮转；`max_memory_restart` 700M、演练 400M | **采纳**（第 1、2 节） |
| UFW | `ufw allow 8788/tcp` 只加规则，不断现有连接 | **采纳**（第 2 节，主会话手工执行） |
| ext4 哈希存储 | 按前两位分目录；临时文件加改名或链接发布；持久化前 `fsync`；ENOSPC 处理；迁移用 `rsync -aS` 或 `tar --sparse` | **采纳**：分目录、临时文件、ENOSPC 回 507。`fsync` 只对 `complete` 做（分片丢了可以续传）〔裁〕 |
| 同机第二份实例 | 独立 app 名、数据目录、端口 8777 / 8778；两个进程的内存状态不互通 | **采纳**（第 2 节） |
| 公网改走 HTTPS/WSS | 建议 | **不采纳**：用户已接受明文（S4）〔裁〕 |

## 10. 实现补充（`claude/sp-hosting`，2026-09-26）

实现方按第 1、2 节做完后补的细节；与正文有出入的地方逐条写明，由主会话在集成时裁定。

**部署文件清单**（第 2 节「实现方列清单」；唯一出处是 `server/hosted/files.mjs`，单测 SPH-deploy-1 在只含这些文件的暂存目录里真起一次入口）：

| 类别 | 路径 |
|---|---|
| 整个目录（跳过 `test/` 与 `*.test.*`） | `server/hosted/`、`server/docservice/`、`server/auth/`、`server/asset-store/`、`server/render-queue/` |
| 单个文件 | `server/asset-service.ts`、`server/vite-plugin-media.ts`、`server/http-guard.mjs`、`server/asset-announce.mjs`、`server/render-node/ws-transport.mjs` |
| 生成 | 部署目录根上的 `package.json`（`{ "type": "module" }`） |

- 素材服务中间件是 `.ts`：靠 Node 的类型剥离直接载入（Node ≥ 22.18 / 24，远端 v24.21.0），不转译；
  它的兄弟引用不带扩展名，由 `server/hosted/ts-resolve.mjs` 的同步解析钩子（`module.registerHooks`）补 `.ts`。
- 远端布局：代码在 `<部署目录>/app/`，PM2 配置在 `<部署目录>/pm2.config.cjs`（部署脚本生成，不含秘密）。
  正式实例 `/opt/promptcut-hosted`、数据 `/var/lib/promptcut/hosted`；演练实例 `/opt/promptcut-drill`、数据 `/var/lib/promptcut/drill`。

**托管组合的补充**：

1. 素材服务端口另有两条管理接口（第 1 节「迁移导出」）：`GET /admin/inventory`（盘点）与 `GET /admin/blob/<ns>/<hash>`（按哈希取字节）；
   只认 `Authorization: Bearer <集群令牌>` 或本机回环。素材服务的数据面仍然不认集群令牌。
2. 素材服务端口的 `/healthz` 回 `{ ok, role: 'asset', layout: 'shard' }`（第 11 节裁定前写的是 `shard2`）。
3. 失败即关另加两个原因词：`layout`（`assets/.layout` 对不上，或 `assets/` 有东西却没有标记）、
   `asset-public-url`（绑非回环而没设 `PROMPTCUT_ASSET_PUBLIC_URL`）；端口被占打 `config.error { reason: 'listen' }`。
4. 数据目录本身必须已存在（不存在即 `data-dir`，服务不替人建）；`docservice/`、`assets/`、`secrets/`（0700）由服务建。
5. 地址登记：有集群令牌时带令牌（管理身份），没有时以回环的本机身份登记（本机身份同样允许 `service.announce`）。〔2026-09-26 修订〕`PROMPTCUT_TRUST_LOOPBACK=0` 时只能带令牌，没有集群令牌就拒绝启动（`docs/plan/http-transport-contract.md` 第 10 节）。
6. `assets/.layout` 的内容是 `{"v":1,"layout":"shard"}`（第 11 节裁定）；本机编辑器的原布局记作 `flat`（本机不写标记）。
7. 磁盘满：`ENOSPC` / `EDQUOT` 回 507 的映射做在 `server/asset-service.ts`（分片与收尾两处），本机编辑器同样生效。
8. 〔2026-09-26 修订〕本机信任开关 `PROMPTCUT_TRUST_LOOPBACK`，取代原测试开关 `PROMPTCUT_TEST_NO_LOOPBACK_TRUST`（旧名删掉，不留兼容）。`0` 时文档服务握手、共享端点、素材服务、管理接口都不把回环当本机；缺省 `1`；`deploy-hosted` 给阿里云写 `0`。原测试开关只接到了素材服务与管理接口。详见 `docs/plan/http-transport-contract.md` 第 10 节。

**部署脚本的补充**：`deploy-hosted` 另有 `--replace-docservice`（旧的 `promptcut-docservice` 还在 PM2 里时，缺省拒绝部署正式实例，退出码 3）、
`--write-token`（把本机 `PROMPTCUT_CLUSTER_TOKEN` 经 ssh 标准输入写成 `secrets/cluster-token`，0600）；另加 `status-hosted`、`stage-hosted`。

## 11. 集成时的裁定（2026-09-26）

`claude/sp-hosting`、`claude/sp-routing`、`claude/sp-tests` 集成对账时，主会话对歧义与实现偏差的裁定。每条是「裁定：理由」。实现已按此核对或改过（`claude/sp-integ`，改动清单见 `docs/archive/agent-reports/AGENT-sp-integ.md`）。

- **数据目录**：`PROMPTCUT_DATA_DIR` 不存在就启动失败（`config.error { reason: 'data-dir' }`，退出码 1），服务不替用户建；部署脚本先建。理由：服务自己建会把写错的路径悄悄变成一个空实例，看起来正常、数据却不在该在的地方；部署脚本知道目标路径，由它建（`deploy-hosted` 已这样做）。
- **`.layout`**：对不上时退出码 1、原因词 `layout`；文件内容 `{"v":1,"layout":"shard"|"flat"}`。理由：与其余失败即关的原因词一致；布局名按含义起，不带实现细节（原实现写的 `shard2` 已改成 `shard`，`/healthz` 同）。
- **`migrate-check` 的输入**：`--from` / `--to` 是两份托管组合的文档服务 http 地址；集群令牌从环境变量 `PROMPTCUT_CLUSTER_TOKEN` 读，没有就读数据目录的 `secrets/cluster-token`（`--data-dir` 或 `PROMPTCUT_DATA_DIR`）；项目数经管理接口（`/admin/inventory`）列出。理由：文档服务地址是成员配置里唯一的入口，素材服务地址从 `service.endpoints` 取，还能顺带核对新实例登记的是自己的地址；令牌只在管理用途上读（M6a 第 11 节），在服务器上跑时直接读数据目录里的令牌文件，不必出现在命令行或环境里；共享项目与各空间的 `projectRev` 只有管理接口能完整列出。
- **`findSharedProject` 的细节**：
  - 托管端回 404 表示没有候选，不进 `errors`；连不上（含超时）才进 `errors`。理由：404 是「这里没有这个名字」的正常答复，连不上才是要提示用户的故障。
  - 局域网候选的 `base` 用 `http://<ip>:<端口>/docservice/`（托管候选同形：`http://<主机>:<端口>/`）；要连 WebSocket 时再换成 `ws://`（`route.mjs` 的 `wsBaseOf`）。理由：`client.mjs` 取挑战、查名字都走 http，候选直接交给它；一种写法便于去重与显示。
  - 手填与发现到的候选按 `base` 去重，发现的在前。理由：同一台主机经发现与手填两路查到时只列一次。
  - 局域网发现与托管端查询可以并行，结果与先后执行等价。理由：两边的候选都列出、谁也不挑，并行只省时间。
- **磁盘满**：`ENOSPC` / `EDQUOT` 映射成 507 `insufficient-storage` 做在素材服务的 HTTP 层（接受 `claude/sp-hosting` 改 `server/asset-service.ts` 的出错分支）。理由：数据层只抛错误码，状态码是 HTTP 层的事；本机编辑器同样受益，正常路径不变。
- **凭证存储读不了**：只在 `PROMPTCUT_LAN_HOST=1` 时拒绝启动；`npm run dev` 绑 `0.0.0.0` 时只打 `config.error { reason: 'auth-store' }`，局域网来的一律 401。理由：不改开发环境的现有行为；明确要当局域网主机时才失败即关，其余情况局域网来的一律 401 已经安全。
- **局域网广播与绑定**：是否广播按编辑器实际绑定的地址判断（只绑回环不广播）；`PROMPTCUT_LAN_HOST=1` 在 vite 插件的 `config` 钩子里压过命令行的 `--host`；运行时不能换绑定。理由：只绑回环时通告出去的地址别人连不上；桌面壳按 `--host 127.0.0.1` 拉起编辑器，写在 `server.host` 里会被命令行盖掉；vite 的 http 服务器不能在运行时换绑定地址。
  - **遗留（C6.5）**：第 5 节「由 C6.5 的旧入口『新建共享项目』选放本机时在运行时打开」做不到，C6.5 要靠桌面壳带着 `PROMPTCUT_LAN_HOST=1` 重启编辑器。
- **探针退出崩溃**：SP7 探针在结果行之后以 `0xC0000409` 退出，属于已知的 Windows 退出崩溃（有句柄还在关闭中就 `process.exit`，同 `render-queue-e2e.mjs` 的注释），保留规避：探针设 `process.exitCode` 后自然退出，10 s 兜底强退用 unref 的计时器。理由：崩溃发生在结果已写出之后，与被测行为无关；放本机那一路的探针（`shared-project-lan.mjs`）也改成同样的退出方式。
