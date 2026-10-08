# 账号登录与云端项目用户入口实施报告

2026-10-09；工作分支`codex/018-account-wiring`；开工固定起点`26cbf7e07cb44a169b8aafe6cf1fae4500026e94`，tracked/untracked均干净。旧B素材叶保持冻结，不改其源或恢复机制。

目标为真实账号登录→新建云端项目→第二账号凭链接加入→双方网站列表有项目，并给桌面版和在线浏览器完整入口。本叶只负责PromptCut开始页、编辑器云端进入/登录恢复桥；网站列表与真实后端接线由root协同，不用受控ready替代完整链。

租约：`src/StartPage.tsx/css`，`src/editor/io`、`src/editor/sync`中账号登录/云端创建加入所需文件，新`src/account/`、专属tests/probe和本报告；desktop仅安全凭据存储及UI桥最小必要文件，具体路径先报告root。禁止修改server/account、server/hosted、素材store、Agent、B/G源、全局测试脚本/端口守门或环境安装。

开工已读AGENTS入口、developer_guide索引、suggested_agent_behavior、constraints；继续核账号任务书/产品语义/真实account-hosted API与已有前端和桌面桥。先交可复用入口与最小清单再实现；网站账号模式不在localStorage存长期凭据，桌面复用现有vault原则或报告缺机制。后端503原样准确呈现并交真实依赖，不绕ready/ACL。

验证未开始。6340～6349仅自身临时fixture；纯类型/无监听可做，任何监听目标/full先报命令待root排窗。Astra6320～6329在运行，不碰用户/其它Agent端口。所有数据日志TMP、子树windowsHide/绝对silent preload，Python仅进程cuda_Vit/models；不push/merge/节点/新worktree/install/junction。首红、具体源码与raw结果随后补记；用户路径功能探针实际通过才记阶段。

## 第一个可审实施块（尚未产品验收）

新`src/account/client.ts`严格消费VisuHive `account/app.mjs`的`/api/account/me`、`login/logout/projects`、`editor/session/renew`；网页请求cookie与CSRF同源，向doc`/hosted/shared/account/create|join|session`使用短期access bearer且credentials omit（真实doc public接口拒Cookie）。长期网站/editor凭据不写localStorage/sessionStorage；官网remember由服务器Cookie寿命决定。桌面login/recover/logout只走native桥；账号access只在RAM，恢复token只在DPAPI文件。

StartPage在线入口替换旧云房间口令，桌面新增云账号入口且保留本地新建/草稿/LAN。新AccountProjects显示登录、云端新建、链接加入、网站权威两列表/失败重试；桌面打开官网查看两列表，不新增Bearer list API。新建固定requestId与initialProject重试，已成功create但session503时保留projectId，不能重复创建。join重试固定requestId。进入后提供真实项目链接复制操作。列表故障显示不可用，不造空列表。

syncManager账号专用进入复用SyncLink和server projection，initialize:false不上传本地空根；WebSocket协议只用真实connectionTicket，每次resume/重建重新问session。旧auth.ticket/service.watch/shared.watch在v2明确禁用，因此账号素材分支用HTTP session assetTicket续签与已部署nginx`/media/api/asset`路径，旧LAN机制不改。账号selection.set/clear启用现有read发布者；旧Agent票据/节点/卡片同步不能凭旧协议绕入v2，本块没有伪造这几项授权，真实接线依赖其它owner。

root已追加租`src/editor/media/assetTiers.ts`账号素材分支、desktop新`account_vault.rs`与lib注册。〔裁〕现Cargo无HTTP crate且不能安装依赖，采用固定官网HTTPS的PowerShell/.NET桥，stdin传凭据、CREATE_NO_WINDOW、stderr不回显、禁redirect/Cookie/任意header/path，20s HTTP超时、1MiB请求/2MiB响应上限；URL只`https://visuhive.com`且请求只三个doc路径，账号三登录路径由固定operation生成。调用者核main WebView label+真实5210根URL；卡片/子WebView边界还需真实壳探针证实，不拿静态核代替。恢复文件独占新account-v1子目录，DPAPI CurrentUser、当前SID/SYSTEM ACL、tmp继承私有ACL、文件Flush(true)与原子替换；进程内串行桥，恢复前先持久requestId供丢响应后幂等重取。没有密码或access落盘。旧壳缺command明确提示使用桌面新版或在线页面，不降级明文存储。非Windows安全vault暂无实现，明确拒绝。

首次强制类型：`node C:/Users/admin/Documents/PromptCut/node_modules/typescript/bin/tsc -b --force`，exit1、3错误、wall7.2038s，raw`%TEMP%/pc-account-user-path-type-1.log`。分别为ensureDevice可空、默认randomUUID推断模板字符串、误写不存在onSharedMessage；已在本块精确修为设备空值拒、requestId:string、实际onSideMessage。第二次同命令exit0、零类型错误、wall7.5243s，raw`%TEMP%/pc-account-user-path-type-2.log`。使用绝对silent preload/规范PSModulePath，无业务listener。

新增client受控协议目标和Windows真实DPAPI/ACL/原子替换目标尚未执行；不会把JS/native mock当真实登录链。PC全量、桌面check/build、双账号真实browser+doc+asset路径及截图尚未执行，等待root测试窗口与真实configured中央。backend503是可见未完成状态。本块源码提交后再申请目标；不借其它候选测试数字。

2026-10-09首次窄pure `npm.cmd test -- src/account/client.test.mjs src/account/desktopVault.test.mjs` 于固定`cc144c2a`：2文件级/0过/2失败/0取消跳过，447.1618ms、wall828ms，raw`%TEMP%/pc-account-user-path-target-1.log`。无业务listener；原global guards保留。client在Node24 strip-only入口因constructor parameter property失败，不是权限断言失败；改显式status/code字段。Windows真实DPAPI首次封存/解密通过，但第二次File.Replace(tmp,file,$null)由PowerShell绑定出空backup路径，真实报路径非法；改为.NET真实null `[NullString]::Value`，保持原子替换，不能删原文件后move代替。这是实际运行发现的产品bug，保留首红。PS owned child自然close，TMP目录finally清理；后续仅固定修正后同目标有因复验。

同目标修后固定`7b350daa`第二次：5/5、零失败取消跳过、338.3682ms、wall608ms，raw`%TEMP%/pc-account-user-path-target-2.log`，原npm wrapper未重跑(native retry0)。4条client为受控fetch/native adapter，1条Windows真DPAPI/目录ACL/第二次原子replace只碰自建TMP，不是Tauri完整IPC/真实密码登录。没有HTTP/WS业务服务监听。官网链接已对齐实际`/account`。
