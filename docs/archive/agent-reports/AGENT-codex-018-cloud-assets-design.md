# F0 project-assets 真实授权路径设计报告

任务：为云端 Agent 剩余 project-assets 工具提供可立即派工的真实授权设计。固定起点2485c6cc，工作叶018-cloud-assets-design；只新增本报告与docs/plan/cloud-agent-project-assets-implementation.md，不实现产品代码，不启动服务、全量或节点操作。

开工已读AGENTS入口、developer_guide索引、suggested_agent_behavior与constraints。后续完整核对工具方案、素材语义与契约、真实doc/run/instance/asset底层接缝；普通人类账号票据不挪作retained任务凭据，不复制run-authority或以creator/global hash替代项目授权。

状态：设计完成；未实施产品接口。方案固定提交d4e61abb00ce3991adfdd045397472394283acf5；本报告最终提交另见Git HEAD。只有两份新增文档，没有读取实际密文/密钥/用户数据，没有listener、child、服务、full、类型、节点、merge/push或环境改动。

## 已交付设计

[完整实施设计](../../plan/cloud-agent-project-assets-implementation.md)包含真实源码接缝表、三级候选、ProjectAssets类型与成功点、逐HTTP签名、独立asset→doc再验、opaque票据绑定/期限、连续控制日志、持久intent/nonce/import/receipt、实际close与重启未知、两个功能包和唯一中央glue、产品与Linux验收矩阵。

已定产品承诺保持：项目素材隔离；字节不经doc；旧人类登录撤销；已读共有当前run可retained继续；private/stop/off/delete/instance fence优先；Agent不得借creator或全局hash。未决补渲故障A/B、提前让位、删除细节/计数/释放时机未被选择；没有新默认内存数字。所有新API和文件均写明尚未存在，不把方案当已实现或用户逐项批准。

## 〔裁〕选择与替代

| 编号／层 | 本设计选择与因果 | 替代及不采用原因 | 可验证尺子 |
|---|---|---|---|
| F0-1／三级，卡点1第3行 | Agent逐实际asset TLS请求用现RAM实例key签完整resource tuple，asset为可信TLS观察方，以自己的doc cert再问唯一run authority；opaque票据不单独授读 | 旧人类assetTicket不能满足retained；自由runGrant/body绕权威；长期bearer无实例证明；字节经doc违反职责 | 拟A `run-assets-authority/observer.test.mjs`＋B `project-assets-mtls.test.mjs`；同cert新OS、另project、改body/Range、observer换socket、撤销/actualclose均独立正反向0失败。未运行 |
| F0-2／三级，内部类型细化 | import先回真实stored assetRef/importId；只有doc addMedia落地后才有registeredMedia | asset服务直接addMedia越职责；预分配mediaId当成功与当前hosted-tools先入库后登记不符 | stored后失权拒登记；真实exec.mutate接受后才回mediaId；重复import/op不重复修改。未运行 |
| F0-3／三级，撤销实现策略 | run lease收到事件先同步pause，独立run权威确认retained后才恢复，revoked等实际close；human旧策略保持 | 忽略login事件会漏撤；全部随旧login终止违反共有已读当前轮保留 | 真实登录撤销/private/off事件、慢Readable `_destroy`/fd/HTTP gate，ACK实际close前pending；无consumer循环等待。未运行 |

这些是可派工技术选型，方案表状态为开放·设计选用，不是已试·过。新可信观察接缝要求代码审查与真实三进程mTLS/root Linux证明；不将来自body的exporter/self-report当真实连接。

## 依赖与文件所有权

| 顺序 | 功能／owner建议 | 边界 |
|---|---|---|
| A先行／Sol | 新account run-assets、internal handler、protocol及专用tests | 复用instanceAuthority/runAuthority；不改原权威、operation或中央；缺可信callback503 |
| B／Sol，A协议固定后 | 新asset run access/client、Agent ProjectAssets/client/resources，专用tests/probe | 现project-access generic生命周期、project-revocations唯一ACK参与者窄处须root另授租；不改发布/store语义，不触worker当前文件 |
| G最后／一个Sol | doc-agent-assembly/doc-assembly/asset-runtime/combo/main/files＋hosted-tools仅accountMode注入 | 唯一中央owner，消费A/B与worker冻结exports；真实provider/current registry/coordinator read/双head/closure全接后才开生产 |

端口6470～6499仅建议，未检查、未分配；此叶不创建后续工作区/分支。A/B先用自己TMP listen(0)真实fixtures，不把同进程free verifier当生产证据；root再给唯一full与Linux窗口。

必须另由owner完成的接缝：worker同RAM实例key的窄runAssetTransport（现proofFor只准POST /runs，不能签asset tuple）；ToolContext实际resources宿主（现无signalFor）；ToolJobs active→retained可信fenceRevision checkpoint迁移（现update对row revision严格相等）；Agent全部worker/child真实停止与历史OS证明。当前Jobs只有ledger，cancel/close不能替代执行收口。F0只交自身asset资源证据，不能自由ACK完整run control。

observer continuation精确绑定doc实际见到的asset RPC TLSSocket，同连接独占keepalive，不能池换socket或同cert新进程自报旧instance。两个原callback verifyServiceInState/verifyTransportInState接同一私有subject registry；普通direct路径不变。observer断连/doc重启使旧lease unknown/pending，RAM cap每次finally释放，旧cap不跨HTTP。恢复关闭仍须实际收据或root精确旧cgroup空证明。

## 只读核验记录

规则完整读：AGENTS、developer_guide索引、suggested_agent_behavior、constraints、solution_table、multi_agent、verification、git_and_release。资料完整读：cloud-agent-tools-implementation、asset-service产品/机制、asset-store-contract（历史LAN段与当前v2分清）、render-scheduling-supplement；账号/Agent契约核对素材、retained与2026-10-08失效补记相关段。

实际源码核对：tool-context、tool-jobs、project-access/stores/revocations/io、asset-runtime/doc-client、Agent instance-session/run-client、run-internal；doc-agent-assembly、doc-assembly、account-hosted、authority、account-projects、run-authority、hosted-tools、operation-wiring/history、MediaAsset类型按相关真实函数逐项检索。没有读运行数据、密文、private key。

最终路径命令使用`Test-Path -LiteralPath`核28个既有源码/契约：`checked:28,missing:[]`；8个拟新增模块：`proposed:8,alreadyExists:[]`。不是对拟API运行成功的证明。`rg -n`确认人类assetTicket authorizationId/token再验、account路由拒body.runGrantId、ToolJobs row fence相等、实例proof路径硬闸、cap finally release、run check retained/active及coordinator.read/history.snapshot真实接缝。改正hosted-tools函数行号为277/308/355；operation实际路径为server/docservice/operation-wiring.mjs，history为server/docservice/modules/operation-history.mjs。

只读路径失败原样记录：初猜`server/account/projects.mjs`、`server/account/account-projects.mjs`、`src/store/types.ts`、`server/agent-service/account-runner.mjs`不存在，rg找到实际account-projects/kernel/project/agent/service/account-runner；后猜`server/account/operation-wiring.mjs`、`server/docservice/history/*.mjs`不存在，rg定位实际docservice路径后成功核验。有一组合命令末项无匹配exit1；均为只读检索错误，没有启动服务、修改产品、降低断言或反复跑产品测试。开工提交3d7a7139中文信息未带类别前缀；后续完整块已用“文档：”规则，未改写提交历史。

`git diff --cached --check`设计提交前exit0；最终两文件对base的diff --check与租约/clean另在交回命令核。203行方案完整块d4e61abb；Git提示LF→CRLF符合仓库Windows换行配置，不是内容检验失败。没有type/target/full：root明确纯文档任务禁止服务/full，产品零改动，所列目标是实施后验收计划，不能冒用其它候选绿结果。

外部在途事项：Astra只读2485 LP close body限制反例已转root，旧中央叶冻结，此叶未获core租约所以未改；root另组合LP修复e350/022c326b，不把本设计当其修复证据。顾问/子Agent调用：无；没有把复杂设计当理由停等用户。

## 交回限制

设计已可立即派A，A协议固定后B与worker签名facade可按文件边界并行，最后G唯一装配。新trust adapter和actualclose尚待实现/实证；原human token不能续借，任一缺口生产503。root负责审查、租新叶、联合验证、实际Linux/OS UID隔离、备份/部署/版本元组和发布。本叶至最终提交后冻结，不实施后续包、不操作main/release/node。
