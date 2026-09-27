# SP 契约测试（claude/sp-tests）报告

状态：测试写完，等集成对账。

依据：`docs/plan/shared-project-contract.md`（唯一依据）、`docs/plan/auth-contract.md`（含第 14 节）。
只照契约写，没看 `claude/sp-hosting`、`claude/sp-routing` 的实现。M6a 已集成的接口（`createSharedDocService`、`auth-kit.mjs` 的 hostFor、素材服务中间件）直接复用。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `server/test/sp-kit.mjs` | 共用工具；契约没写死的接口假设全部在文件头（下面第 3 节） |
| `server/test/sp-hosted.test.mjs` | 起 `server/hosted/main.mjs` 子进程：SPC1-1～1-7、SPC2-1、2-2、SPC3-1、SPC7-1、7-2 |
| `server/test/sp-boundary.test.mjs` | SP2 进程内（托管端与局域网主机）：SPC2-3～2-8 |
| `server/test/sp-store.test.mjs` | `fs-store` shard 布局、磁盘满 507：SPC1-8、SPC1-9 |
| `server/test/sp-route.test.mjs` | 路由与缺省托管地址：SPC5-1～5-11、SPC6-1～6-3 |
| `server/test/sp-lan.test.mjs` | 局域网发现：SPC4-1～4-9 |

## 2. 编号对应

| 验收 | 用例 |
|---|---|
| SP1 | SPC1-1 一个进程两个端口、公网素材地址经 `service.endpoints` 下发；SPC1-2 成员不设令牌、从非回环来源（本机局域网 IPv4）凭证进入，快照读写、带票据素材读写，不带票据 401、只读票据写 403；SPC1-3 两服务共用票据核对，签名错 401，`set-password` 后旧票据 401 |
| 第 1 节其余 | SPC1-4 数据目录布局（docservice/、assets/<ns>/<前两位>/、.layout，工作目录不写）；SPC1-5 数据目录不存在或是文件 → 退出码 1、`config.error { reason: 'data-dir' }`；SPC1-6 `secrets/cluster-token` 优先、回落环境变量、都没有照常启动；SPC1-7 `.layout` 对不上拒绝启动；SPC1-8 shard 布局（数据层、续传、HTTP、缺省布局不变）；SPC1-9 ENOSPC / EDQUOT → 507、分片保留、不标记完成，别的错误不回 507 |
| SP2 | SPC2-1、2-2（子进程）；SPC2-3 三种角色；SPC2-4 独立主机；SPC2-5 凭证错；SPC2-6 托管端管理接口无令牌 401；SPC2-7 局域网主机管理接口非回环 401、成员 announce forbidden；SPC2-8 局域网主机回环无令牌 announce 成功 |
| SP3 | SPC3-1 一轮发布、认领、完成后全部断开，新成员逐项计数一致（projectRev、快照全文、内容库键、素材与产物按哈希取回），重启后仍一致 |
| SP4（本机） | SPC4-1 参数表；4-2、4-3、4-4 包格式与 1 KiB 上限；4-5 选网卡与定向广播地址；4-6 45 s 过期与续期；4-7 原始套接字查询→单播应答；4-8 两个套接字 5 s 内发现、名字不符与主机停后找不到；4-9 发现与进入期间托管端连接数不变 |
| SP5 | SPC5-1～5-4 四种候选组合；5-5 托管连不上进 errors；5-6 discover 不回，3 s 左右返回；5-7 discover 抛错；5-8、5-9 手填兜底；5-10 `createSharedProject` 托管端建成、口令不出客户端；5-11 route.mjs、hosted-default.mjs 不静态引 node: 模块 |
| SP6 | SPC6-1 常量值；6-2 三种覆盖顺序；6-3 守门（git 跟踪与未跟踪文件，排除 docs/、archive/、测试、探针、.md）。「服务端改配置后按新地址登记」由 SPC1-1、SPC7-1 覆盖 |
| SP7 | SPC7-1 拷数据目录到第二份实例、改地址：`migrate-check` 通过，项目、快照、内容库、素材、产物全部可用，新地址下发，projectRev 连续（下一版 = 旧 + 1）；SPC7-2 对空实例 `migrate-check` 为 false |
| SP8 | 跨机，不写 |

## 3. 假设的接口（集成时只改 `sp-kit.mjs`）

- **H1** 托管组合的文档服务是独立模式：WS 在 `/`，HTTP 在 `/shared/…`。
- **H2** 素材服务路径 `/api/asset/<ns>/<hash>[/<n>|/complete|/chunks]`。
- **H3** 就绪判据：`GET /shared/lookup` 回 404、素材端口有 HTTP 回应；因此用固定端口 5490～5495（不依赖日志格式）。
- **H4** `.layout` 对不上＝非 0 退出码。
- **H5** `secrets/cluster-token` 内容是令牌本身，允许末尾换行。
- **H6** 素材服务登记的 `kind` 是 `'asset'`。
- **S1** shard 布局下全件文件名与原布局相同，放在 `<dir>/<前两位>/`。
- **M1、M2** `migrate-check` 的 `--from/--to` 是文档服务 http 地址，令牌取自环境变量 `PROMPTCUT_CLUSTER_TOKEN`；结果是 stdout 最后一行 JSON 的 `ok`。
- **D1** `hosted-default.mjs` 另导出 `resolveHostedUrl({ ui, env })`。
- **R1～R3** `lan.discover` 回应答包数组；`hostedUrl` 不带尾斜杠；`createSharedProject({ where, hostedUrl, name, mode, creator: { username, password }, password, list })`。
- **L0** 局域网发现模块 `server/auth/lan-discovery.mjs`，导出 `LAN_DISCOVERY`、`encodeQuery`、`encodeAnnounce`、`decodePacket`、`selectInterfaces`、`createLanTable`、`createLanHost`、`discoverLan`，其中 `createLanHost`、`discoverLan` 可注入网卡与单播目标（本机单测靠它模拟）。这一组猜得最多，对不上时按实现改 `sp-kit.mjs` 与 `sp-lan.test.mjs` 的调用形状，断言的参数值不动。

## 4. 验证结果

- `node --check` 六个文件全过。
- `node --test server/test/sp-*.test.mjs`：退出码 1，53 个用例，**通过 11、失败 42**。
  - 通过的：SPC2-3～2-8（9 个，M6a 已有行为），SPC1-8「缺省布局不变」，SPC1-9「EACCES 不回 507」。
  - 失败的原因归类（逐条看过）：`server/hosted/main.mjs` 不存在（托管组合 12 个用例），`route.mjs`、`lan-discovery.mjs`、`hosted-default.mjs` 不存在，`shard` 选项没有（子目录不存在），磁盘满回 500 而不是 507。没有因为测试本身的错误失败的。预期：实现不在本分支。
- 没跑全量测试与 tsc（只加了测试文件，没改产品代码）。

## 5. 契约歧义（请主会话裁定）

1. **托管组合的日志与退出**：契约没写 `listen` 行的格式，也没写 `.layout` 不符时的退出码与 `config.error` 原因。建议定为退出码 1、`config.error { reason: 'layout' }`，测试就可以查原因。
2. **`.layout` 的内容与首次启动**：没写文件内容格式，也没写「`assets/` 已有平铺布局的文件但没有 `.layout`」怎么办。
3. **数据目录「不存在」**：第 1 节说不存在即退出码 1；而 PM2 首次部署时目录多半要由部署脚本建。测试按「不替用户建」写（SPC1-5）。
4. **托管组合的绑定地址**：只写绑 `0.0.0.0`，没有覆盖用的环境变量。测试靠本机局域网 IPv4 模拟非回环来源；没有这种网卡的机器上 SPC1-2、1-3 跳过。
5. **`migrate-check` 的输入**：`--from/--to` 是文档服务还是素材服务地址、要不要集群令牌、「项目数」怎么数（管理接口还是别的），契约都没写。
6. **`findSharedProject`**：托管端查询回 404 算不算 `errors`；`lan.discover` 的参数与回值形状；lan 候选的 `base` 是 `ws://…/docservice` 还是 `http://host:port`；手填地址和 discover 同时给时是否都跑、结果是否去重。测试对这些都只做宽松断言。
7. **`resolveHostedUrl`**：函数名、参数形状没写；界面值为空串时算不算「改过」没写。
8. **局域网发现模块**：模块路径、函数、以及本机单测怎样「用两个 dgram 套接字模拟」都没写。另外同一项目被两台主机应答时，列表按什么去重也没写（测试按 projectId 加主机算一条）。
9. **磁盘满在哪一层映射成 507**：契约写「写入回 507」，测试按素材服务 HTTP 层验（数据层抛 `code: 'ENOSPC' | 'EDQUOT'` → 507），fs-store 自己怎么报没有约束。
10. **SP3「都落在 PROMPTCUT_DATA_DIR 之下」**：只能查数据目录里有什么、工作目录没被写，查不了「别处都没写」。SPC3-1 还多查了一件事：重启后逐项一致。
11. **第 5 节 `PROMPTCUT_LAN_HOST=1` 让 vite 绑 `0.0.0.0`**：要起 vite，本分支没写测试，留给集成或探针。

## 6. 没做的

- SP8（跨机）。
- 第 2 节部署脚本 `deploy-hosted`（要远端），第 6 节探针的 creator、member、lan 几种角色（只测了 `migrate-check`）。
- 真组播、子网定向广播、每 10 s 重建成员资格：本机单测只核对参数常量，行为留给 W6。
