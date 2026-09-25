# SP 阶段报告：共享项目接入（阿里云托管与局域网）

2026-09-26。合并 `685756a`（main，合入 `claude/sp`）。

**依据**：
- 计划第 7 节 SP（D10 修订版）；
- 契约 `docs/plan/shared-project-contract.md`：第 9 节是查资料的结论，第 10 节是实现补充，第 11 节是集成裁定；
- 迁移流程 `docs/plan/hosting-migration.md`；
- 局域网发现方案的唯一出处 `docs/plan/direct-connect-plan.md` 设计要点第 4 条。

## 1. 交付

| 子分支 | 内容 |
|---|---|
| `sp-hosting` | 托管组合 `server/hosted/`：一个进程两个端口（文档服务 8787、素材服务 8788），共用凭证与票据；`PROMPTCUT_DATA_DIR` 单目录布局；`secrets/cluster-token`；失败即关（data-dir、layout、auth-store）；磁盘满回 507；`fs-store` 的 `shard` 布局；部署脚本 `deploy-hosted` 与 `--instance drill`；`migrate-check` |
| `sp-routing` | `server/auth/hosted-default.mjs`（缺省托管地址，源码里唯一出现这个 IP 的地方）；`server/auth/route.mjs`（新建与打开的两种模式路由）；`server/lan/discovery.mjs`（组播 239.255.42.99:54887，逐网卡，查询与应答为主，周期通告为辅，子网广播兜底）；`PROMPTCUT_LAN_HOST=1` 时编辑器以局域网主机身份绑 0.0.0.0 |
| `sp-tests` | 契约测试 SPC 53 条（对抗式） |
| `sp-integ` | 对账，按 8 条裁定改实现，为 W6 真实渲染给 `render-host-probe` 加 `--hosted` |

## 2. 基线（main `685756a`）

- `npx tsc -b --force` 退出码 0；`npm test` 2759 条，2758 通过，0 失败，1 跳过。
- 合入后在 main 上补跑（M6c 与 SP 第一次在一起）：
  - `preview-fallback-probe --page-preload` 退出码 0，`transparentBeats` 全为 0；
  - `verify-unified-frames` PASS；
  - `verify-determinism` 1800/1800。
- SP 系列测试 92/92（SPC 53、SPH 14、SPR 25）。

## 3. 验收

| 编号 | 结果 |
|---|---|
| SP1 | 本机托管组合：成员不设集群令牌，凭项目凭证进入；快照读取、带票据的素材读写成功（SPC1 与 SPH） |
| SP2 | 单测：三种角色和独立主机都不带令牌进入；凭证错被拒；托管端管理接口无令牌 401；局域网主机管理接口从局域网访问 401，从回环访问成功 |
| SP3 | 一轮之后全部成员断开，新成员取回的快照、内容库、素材、产物逐项计数一致，都在 `PROMPTCUT_DATA_DIR` 之下 |
| SP4 | 本机双套接字单测；跨机实测见 W6b |
| SP5 | 四种候选组合的单测 |
| SP6 | 守门测试：`8.219.80.16` 只出现在 `hosted-default.mjs`；三种覆盖顺序的单测 |
| SP7 | 本机两份托管组合：拷数据目录后 `migrate-check` 通过（抽查 7 个哈希全部相符），迁移后成员再进入读取正常 |
| SP8 | 跨机 W6，见第 4 节 |

## 4. 跨机 W6

笔记本 192.168.50.247 与主 PC 192.168.50.96 在同一家庭局域网。互联网模式经公网连阿里云，不需要手机热点〔裁〕。两边都在 `claude/sp` @ `c50a107`。

### W6a 互联网模式（项目托管在阿里云 8.219.80.16）

| 项 | 结果 |
|---|---|
| r1 | host-a 认领 1、host-b 认领 2、PC 2，5 个任务全部完成，重复 0，`identicalBytes true`；主机的 `assetBase` 是 `http://8.219.80.16:8788/api/asset`，产物推到阿里云 |
| r2 | host-c（代码版本不同）认领 0 |
| r3 | host-bad（口令错）`handshake 401`、认领 0 |
| auth-check | 非回环来源 `docHost 8.219.80.16`：错口令 401，对口令 101；素材不带票据 401、带票据 200、Range 206、伪造票据 401；连错 5 次后 401，冷却期挑战 429，61 s 后恢复 101 |
| 共享项目成员探针 | 笔记本不设集群令牌（`clusterToken: "unset"`）进入，用时 342 ms；带票据的素材读，请求头和查询串两种方式都成功；不带票据 401；认领并完成 4 个任务。创建者端：发布 6、完成 6、重复 0 |

### W6b 局域网模式（主 PC 当主机，编辑器 5480）

| 项 | 结果 |
|---|---|
| 发现 | 笔记本组播发现，用时 1542 ms（第一个应答 13 ms 就到了），`via: discover`，没用手填兜底 |
| 权限 | 管理接口从局域网访问 `bare 401`、`token 401`；素材不带票据 401、带票据 200，sha256 相符 |
| 任务 | 发布 3、完成 3、重复 0 |
| 不经阿里云 | 托管端连接数前后都是 1 |
| 删除 | 删掉项目后不再被发现（`goneAfterDelete true`） |

第一次跑 W6b，创建者在成员接入前就等超时了，打出的结果是 0/3。这是探针的时间窗口问题，不是产品问题：成员那一侧当时就是全过的。放宽窗口后重跑，全部通过。

### 托管端的资源（SP8 要求记录）

服务器配置：2 核，内存实测 1613 MB，40 GiB 盘，Node v24.21.0，PM2 7.0.4。

| 项 | W6 前 | W6 后 |
|---|---|---|
| 数据目录 | 158 B（只有 `.layout`） | 26.0 MB，519 个文件 |
| 进程 RSS | 101 MB | 117 MB |
| eth0 收 / 发 | 11.8 MB / 25.1 MB | 54.4 MB / 36.8 MB（增量：收 42.6 MB、发 11.7 MB） |

## 5. 远端操作记录（8.219.80.16）

| 操作 | 内容 |
|---|---|
| 准备 | 装 `pm2-logrotate`（单文件 10 MB，保留 7 份）；建 `/var/lib/promptcut/hosted/secrets`（目录 700）；生成集群令牌写入 `secrets/cluster-token`（600），值只在服务器上 |
| 部署 | `deploy-hosted --replace-docservice --save`：旧的 `promptcut-docservice` 换成 `promptcut-hosted`（fork 模式、单实例、`max_memory_restart` 700M），执行 `pm2 save`；旧服务里的测试数据没迁移 |
| 防火墙 | `ufw allow 8788/tcp`（服务器自己的 UFW）；阿里云安全组本来就放行了 8700～8799 |
| 验证 | 公网 `8787/healthz` 回 `ok: true`，挂了 5 个模块；`8788/healthz` 回 `layout: shard`；素材服务已凭集群令牌登记公网地址 |

## 6. 与计划不一致之处

- **W6 不用手机热点**：互联网模式连的是阿里云，同一局域网照样走公网〔裁〕。
- **拒绝启动的范围**：凭证存储加载失败时，只在 `PROMPTCUT_LAN_HOST=1` 下拒绝启动。`npm run dev` 本来就绑 0.0.0.0，这时只打日志，局域网来的连接一律 401〔裁〕。
- **运行时切到局域网主机**：vite 不能在运行时换绑定地址，要重启编辑器，写进了 C6.5 的遗留。

## 7. 顾问调用记录

| 用途 | 问题 | 结论 | 采纳 |
|---|---|---|---|
| 查资料（codex） | Windows 组播、PM2、UFW、ext4 哈希存储、同机第二实例 | 组播地址 239.255.42.99:54887，逐网卡发送，查询与应答为主；PM2 用单进程 fork 模式，秘密随数据目录走；`ufw allow` 只加规则；存储按哈希前两位分目录，临时文件加改名；演练用 8777/8778 | 采纳；「公网改 HTTPS」不采纳（用户已接受明文 S4）；`fsync` 只对 `complete` 做〔裁〕 |
| 攻坚（codex） | 没有 | — | 没有调用：没有用例连续失败 |
| 交互与文案（Gemini） | 本阶段没有用户界面（界面在 C6.5） | — | 没有调用 |
| 发散（Gemini） | 没有走到第 3 级 | — | 没有调用 |
