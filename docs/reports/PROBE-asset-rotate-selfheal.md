# 验证证据：素材服务观察通道的 rotate 自愈

分支 `claude/asset-rotate-selfheal`。机器：本机 PC（Windows 11）。日期 2026-10-24。

## 这次加了什么

`server/hosted/deploy/` 下五个新文件，都是部署模板与一个看门狗脚本，不改任何在跑的服务代码：

| 文件 | 作用 |
|---|---|
| `systemd-promptcut-asset-rotate.service` | 一次性单元，跑一次 `publisher --rotate` 重建观察通道 |
| `systemd-promptcut-doc-rotate.dropin.conf` | 文档服务每次启动完自动触发上面那个单元（`--no-block`） |
| `asset-run-watchdog.mjs` | 看门狗：查状态口，只在「配了 run-assets 但 `runAssetsReady` 为 false」时才触发 rotate |
| `systemd-promptcut-asset-rotate-watch.service` / `.timer` | 看门狗的单元与两分钟一次的定时器 |
| `asset-run-watchdog.example.json` | 看门狗配置样例 |

另加 `server/hosted/deploy/README.md` 一节「素材服务的观察通道自愈」，和单测 `server/test/asset-run-watchdog.test.mjs`。

## 为什么

素材服务启动时跟文档服务建**一条**长连接当观察通道，身份绑在那一个 TLS socket 上。文档服务一重启通道就作废，重建只能由 root 在素材服务的 cgroup 之外跑 `--rotate`（设计约束，素材服务自己重连不了）。这一步原先靠人工记着做，2026-10-23 漏了一次，而且通道一丢就把整个素材服务拖成 not-ready，连普通用户读素材都 503，只好把 `PROMPTCUT_ASSET_RUN_ENABLED` 改成 `0`——代价是云端 Agent 一整天看不了素材（会话 `cc-mvm5fqj9-y7bk` 两次 `see_frames` 失败就是这么来的）。

## 测试

| 命令 | 结果 |
|---|---|
| `npm test -- server/test/asset-run-watchdog.test.mjs server/test/account-v2-install-plan.test.mjs server/test/account-v2-deploy-config.test.mjs server/test/asset-root-registry-publisher.test.mjs` | 70/70 通过 |

影响范围怎么算：新脚本自己的测试，加上另外三支读 `server/hosted/deploy/` 的测试（装机清单、部署配置、登记发布器），确认新增文件没碰坏它们对这个目录的假设。

新测试钉死的几条分寸：没配 run-assets 绝不自作主张 rotate；状态口读不到时不动手（那时去 stop/start 素材服务只会把一次普通重启变成两次）；冷却期内不重复 rotate；试够次数只报警；证书不是 PEM 时明着报错而不是装作「读不到」。

## 构建与类型检查

| 命令 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0 |
| `npm run build` | 成功 |

## 探针

这次没有对应的浏览器探针可跑：改的全是 systemd 模板和一个只在 Linux 节点上有意义的运维脚本，本机 Windows 上跑不出有意义的结果，也没改到画面（按 `verification.md`「按改动范围验证」不跑渲染附加项）。

真正的验收是**真实网络验证**，在节点上做，不是合入 main 的前提（`verification.md`「产品交互验收与真实网络环境验收」）。部署记录与核对结果写在 `docs/local.md`（不入库）。
