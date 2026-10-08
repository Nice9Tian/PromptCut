# 账号 v2 离线安装计划

本小包只生成供根审核的三服务部署产物，不操作节点、不写私钥、不启动服务。基底是 `c28a998726a3b8624a116348446f08b643449b14`；已冻结的 `account-v2-config.mjs` 继续作为唯一离线身份清单验证器，本包不修改它。

目标是让一个私有 CA 签发的 account/doc/asset 三张不同叶证书，连同现有账号 credential key、顺序签名钥匙和旧 doc cluster token，以各自的 OS 用户和绝对路径进入三个独立进程。安装计划仅输出公开登记 JSON、路径型环境文件、systemd unit 与所有权清单，要求根在安装前核对数据目录和私钥的实际 UID、权限、备份及异常实例恢复见证。Agent/render 未部署时既不登记虚构身份，也不生成单元。

验证边界：专属目标使用临时真实 CA/叶证书及真实账号 provider，检查最低三角色服务查询和缺失、错身份、重复登记的拒绝。产物本身不证明节点已安装、root cgroup 旧实例已收口或 Agent/render 已上线；这些仍留给后续真实网络验收。

实现范围：`server/hosted/main.mjs` 将账号 v2 内部登记约束为当前真实启用的 `account` 与 `asset` 两个角色；仅配置了 `PROMPTCUT_DOC_AGENT_SERVICE_KID` 才可加 `agent`，当前无 render 启用接缝，登记它会拒绝。角色名和 pin 均唯一且形状精确，account pin 对应账号服务证书配置、asset pin 对应独立素材 status 配置，doc 对 account、asset 使用同一实际证书。账号 v2 缺完整 asset status 或提供静态 `PROMPTCUT_ASSET_INSTANCE_ID` 拒启动；旧 LAN 缺省分支不受这条规则影响。

新增 `createAccountV2InstallPlan({manifestFile,installDir,nodePath,pcSourceDir,vhSourceDir,users})` 调用已冻结的离线验证器，只支持确实要安装的三个角色。产物返回账号、doc、素材三份不含私钥内容的环境文件，三份互不依赖启动顺序的 systemd 单元，以及公开证书登记与账号顺序公开钥文件。调用方必须显式提供不同的三个非 root 用户、实际 Node 和两仓库入口绝对路径；原 doc `secrets/cluster-token` 和账号现有 credential key 只核文件存在/权限/引用，不生成或替换。`fileAccess` 与 `filePolicies` 给出各自私有文件、公开文件、可写数据根、其他服务禁读路径及待安装文件 owner/group/mode。doc 仅写自己的项目/元数据根，asset 仅写自己的素材根；不授 doc 直接读 asset 字节目录。父子嵌套数据根、共享私有钥匙目录和安装目录穿入服务数据根都会拒。unit 不填任意内存默认值；素材起步可追真实 head，doc/account 不设置相互 `Requires=` 造成启动循环。

验证使用主库已安装 Node，`PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\\Users\\admin\\Documents\\VisuHive` 与其真实 `account/password-order.mjs`；所有临时证书由该次测试自己调用 OpenSSL 生成，一个私有 CA 签三张独立叶证书。端口 6440–6445，事前事后均检查为空。没有 mock account 权威、asset readiness、leaf 或项目权限。

| 尝试 | 原始日志 | 结果与原因 |
|---|---|---|
| 首次 | `%TEMP%\\pc-account-v2-install-plan-real-first.log` | 4 项中 3 过、1 败：Windows 的 VH 现有 `import(绝对盘符路径)` 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，账号进程未起，真实链未验。未改生产入口；测试进程在 Windows 将同一绝对模块路径转换为 `file:` URL。 |
| 修 Windows 夹具后的首次真实链 | `%TEMP%\\pc-account-v2-install-plan-order-url-after.log` | 真账号/doc/asset 已走 create 201、asset 未就绪 session 503、ready 后 session 200、项目查询 200；测试却因先注册的临时目录删除钩子在三个服务关闭前执行，Windows `EPERM`、测试 3/4。三个 PID 38860/43380/29024 当时仍在监听；核对进程命令与父 PID 7912 后，只对这三个自有 PID 做了强制收口，等待原测试退出。该轮不能算正常关闭通过。 |
| 调整收尾钩子 | `%TEMP%\\pc-account-v2-install-plan-teardown-after.log` | 4/4、0 失败，账号/doc/asset 子进程 `close` 均完成，6440–6445 清空。 |
| 最终加数据根边界负例 | `%TEMP%\\pc-account-v2-install-plan-data-boundary-target.log` | 5/5、0 失败、0 跳过、6064.781 ms、exit 0；真实三服务 PID 38104/35640/34020 均实际 `close`，6440–6445 清空。错角色、缺 account/asset、重复 pin、未声明 agent、缺 asset status、静态 instance 均由真实 `main.mjs` 子进程在监听前 `config.error` 拒绝。 |

最终强制类型日志 `%TEMP%\\pc-account-v2-install-plan-type.log`：`tsc -b --force` exit 0，日志为空。未跑全量 npm/G0/C10、未触节点或实际安装；根收回后的共同源码全量与真实网络验收仍需独立做。当前安装计划不证明实际 UID/chown 已执行、备份与恢复已完成、旧素材实例 root cgroup 关闭见证已取得，三项须在节点安装前由根核对。

遗留的首次失败临时目录 `%TEMP%\\pc-account-v2-install-ItI6p4` 仍含该次临时证书/钥匙。本会话已经核对其解析路径在本机 TEMP 内且自有 PID 均已结束，清理命令被自动审批拒绝，工具只给出 “blocked by policy”，未提供更具体原因；没有改用其他删除方式绕过。目录保留，正式部署不读取它。
