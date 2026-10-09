# 当前生产备份与隔离恢复实证

2026-10-09，主会话执行。这里记录当前账号、文档、素材三服务的数据备份及恢复，不把旧版本报告当作当前恢复证据。实际数据和备份均未删除。

## 一致备份

备份位于节点 `/root/promptcut-v2-consistent-20261009-b9fb4c8d8e5c`，目录仅 root 可读，产物模式0600。先备份实际代码、Node、配置、角色私钥和服务单元，再停止三个数据服务；确认进程、监听和素材所有者锁全部关闭后，备份数据并重核源清单，最后恢复原服务。停写1.465秒，nginx未重启。

| 产物 | 字节 | SHA256 |
|---|---:|---|
| account-doc-asset-data.tar | 337920 | 167d331f0c41b9754f2b6b047cf6b8ba535b594f75c864070f3542325cc28ef2 |
| code-config-private.tar | 176373760 | 5591415f88150ec40dea6aab87a5d133e65a954ab75bf69760c3f2b882fa4717 |

源数据18个文件、308944字节。恢复后的账号/文档/操作日志三个数据库均为schema2，完整性检查正常；6个账号、两个项目正文与版本可回读。逐文件摘要、所属用户和权限均与清单相符。原始安全结果见[备份](three-versions-production-restore-evidence/consistent-backup.json)与[最终离线校验](three-versions-production-restore-evidence/restore-offline-final.json)。仅离线校验时仍明确runtimeVerified=false，未冒称服务恢复通过。

## 三次实际启动，保留前两次失败

每次都重新解包至独立 `/var/tmp/pc-v2-restore-20261009-*` 目录，使用备份的Node和实际服务源码，以原角色用户、原权限启动三个临时单元。端口仅回环6590–6595，全部数据、环境和绝对路径指向恢复副本。私钥及原始journal仅保存在节点私有目录，没有进入仓库或对话。

| 次数 | 耗时 | 结果与原因 | 安全证据 |
|---|---:|---|---|
| 第一轮 | 45.241秒 | 0/4，临时恢复父目录受umask影响为0700，三个角色用户进入工作目录失败，实际CHDIR/Permission denied。未改生产权限。 | [首次运行](three-versions-production-restore-evidence/restore-runtime-first.json) |
| 第二轮 | 45.427秒 | 3/4，按原目录元数据恢复权限后三服务均实际active且HTTP200；探针误把延迟更新的doc assetReady健康字段当启动探测，未通过。 | [权限修正后](three-versions-production-restore-evidence/restore-runtime-permissions-fixed.json) |
| 第三轮 | 1.071秒 | 5/5，实际三个HTTP健康、doc角色证书与素材服务真实双向TLS状态校验、两个恢复项目正文和版本再次相符；runtimeVerified=true。 | [最终运行](three-versions-production-restore-evidence/restore-runtime-final.json) |

第二轮问题修在验证脚本：第三轮通过真实产品createAssetReadyProbe，使用恢复副本doc证书、CA和素材pin校验，accessHead=accessCursor=5，authority一致、一次通过；没有修改产品健康字段或写假ready。它证明恢复的doc角色凭据能够读真实素材状态，不将独立观察进程等同实际用户会话准入。最终记录仍保留doc/asset初始健康字段assetReady=false。

三次均实际关闭自建服务，MainPID=0、临时单元not-found，6590–6599全部空闲；生产账号279515、文档279516、素材279517及nginx9395在隔离恢复前后不变、active、零重启。备份时按授权重启三数据服务，隔离恢复没有再重启生产。

一次最初组合启动命令被自动审批拒绝，工具只给“blocked by policy”，没有执行。随后改为可审读的独立临时脚本、固定命名空间与生产进程保护，工具批准后才实际运行；不把被拒命令算作一次服务恢复。

安全JSON共7份保留首次与修正后的离线、运行结果。原始含敏感配置风险的journal及恢复副本继续保留在节点私有目录；没有删除任何备份、项目或账号。
