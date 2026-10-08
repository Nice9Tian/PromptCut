# 0.7.18 迁移设计工作报告

## 任务与边界

在 `codex/three-versions-018-design` 分支、起点 `7b4b7106` 上只新增本报告与 `docs/plan/three-versions-018-design.md`。不实现产品代码，不合并、推送、部署、修改进度，不触及本地秘密、实际密文、密钥或用户数据。

## 阅读与验证记录

已完整阅读 AGENTS 入口、developer_guide 索引、guide_files下的suggested_agent_behavior、constraints、multi_agent、solution_table、verification、git_and_release；任务brief第2节指向的任务材料和第5/8/9/11节，account-binding-task、account-binding-contract全文、online-browser-task；cloud-agent/auth/hosted-render/online-card-exec契约、四阶段部署清单和2026-10-08补记。按资料先定语义、再读真实模块，旧段冲突在方案首表逐项列出。

代码核对点 PromptCut `7b4b7106`包含`6f85cd78`；最终又用 `git show bf6e48e6:<path>`只读核对最新account-binding-task、product/agent、product/platforms、TODO，未merge他人提交。VisuHive只读点`a2ebd001`；核对账号app/store/server/password逻辑、site页面、docs/accounts、README/user_readme及入口规则；未访问local秘密、实际密文或密钥。`8fb6df79`只读参考，未完成选型不是产品代码，不合它。

真实模块核对覆盖docservice/shared-service与normalizePrincipal、auth/delegation与票据、Agent service/http/hosted-wiring/conversations、tool声明、感知Python入口/插件、collector本机登录桥、asset全链路、render limits/broker/look、在线stage策略、proc/procp恢复链及缺素材音频。发现当前15秒身份缓存、busy-conversation、conversations写失败吞错、global storeOf(ns)、账号projects空数组/固定30天、当前改密立刻删除旧会话等不能承载新语义的地方，逐处指向真实文件和拟接口。

只读取证命令及结果：

- `node --input-type=module -e`导入`server/agent/service/cloud-tools.mjs`的`CLOUD_TOOL_PLAN`：pending精确23项，方案逐名列输入/输出/实现位置与节点尺子；另列handoff/collect-login/visual欠项及三个版本固定关闭spawn_agent。
- `git show 8fb6df79`与对应diff只读：选型提交，无可直接合并的完成工具实现。
- `Test-Path -LiteralPath`前批核对PromptCut72个真实路径、VisuHive10个真实路径，缺失均0；最终补核24个selection/guard/render真实路径，缺失0。所有拟新增路径明确标拟，已消除模糊`*.ts*`派工边界。探索时猜错awareness/page-channel/visual插件路径已经纠正为真实presence、cloud-tools/pageRequests和vision/routes，不作为存在事实写入方案。
- 最后root补充guard云worker链后，`rg --files`核到`server/hosted-render/vite-gate.mjs`、hosted-render-usercards/isolation tests、hosted-render-isolation probe、native/particles与externalResources test，`rg`实证proxy/Connection-Allowlist/UDP args；全归guard包独占，不碰Agent web/collect的SSRF保护，也不新打徽标。
- `rg`核对现存route、字段、工具schema、Connection-Allowlist/execGate、LIMIT_DEFAULTS和look busy分支；按最新已定P1～P10/R1逐项对照，并检索删除旧“doc离线改密前503”“只读发起页面选区”等选择。原二级503只留锁住替代，不选。
- `git diff --check`通过，未运行类型/全量测试/渲染/服务；纯新文档按主任务明示范围验证。主会话17项集成/1800帧证据仅在方案标为主会话起点证据，不冒充本子任务结果。

## 完成内容与接口边界

完整方案在 `docs/plan/three-versions-018-design.md`。包含旧契约段落/实际模块迁移矩阵、账号public/internal API请求响应与错误码、Principal v2/项目v2/SQLite v2、authority tombstone/gone证明、同域cookie/CSRF/CSP和同机mTLS/OS用户隔离；LAN身份完全保留。

改密先成功后选择，保留发起website、撤其它网站+全部旧editor；事件outbox/持久ACK、重复乱序/丢失/重启与多连接完成点有具体记录。最终选account唯一顺序见证，不用跨进程hrtime假设，不让doc离线阻止改密成功；reserve不等于accepted，seal/doc接受/停止fence恢复约束交独立Astra故障证明。0.7.18记录且保留修改，0.7.20按项目逐item补偿，新登录/别人/共有已读当前run保护，普通撤销冲突窗口独立。

Agent身份拆owner/sender/initiator、实际成员、共有/私有各接口、creator只读与停任意任务、服务永无管理员能力；FIFO、切私有立即中止别人当前轮/取消别人queue、落地保留、read-WAL/doc receipt/runGrant和精确ops链、项目关闭/删除优先。托管方能读private首次告知文案/按钮/按账号同意、拒绝不发送全链路入口有接口。全员实时选区标用户名+“（当前用户）”，离线发起人消息快照注明非实时。

素材按project实际store隔离asset/upload/bind/px/thumb/stream/worker/transcode/key及同hash多项目；23工具逐项、匿名采集+本机代下凭据不离机、固定spawn回复；卡片浏览器出口护栏三个版本不做，外链照常，保留分源与项目隔离；容量含内存/项目数/磁盘压力排队，507内部保护不丢任务、Agent优先；真实旧proc/procp准确gone转换、包内本地优先、人声一次裁切/余静音/视频组合与时序、保存重开持久本地。

实施表19包，各十端口段5740～5929，工作区/分支同包名，两仓库分别建。`018-cloud-glue`单Sol独占shared-project/server实际中央文件，`018-tools-glue`单Sol独占工具核心接线，其余交模块接口，root不做多数常规实现。明确guard已从461206a3建工作区，不重复建立；现有Luna的三契约/部署/product/agent/mechanism/platforms/rulings不与实施包交叠。先guard+account基础+ops骨架，asset/工具/选区/容量按接口并行，Astra时序不阻塞独立实现；网站LAST后端先，上线五分钟自动site同步纳入次序。0.7.19四档逐字和0.7.20依赖保留，不提前扩大0.7.18业务范围。

部署记录引用root只读已核节点：PC `/opt/promptcut-hosted/app`与`/var/lib/promptcut/hosted`、doc8787/asset8788；account `/opt/visuhive-account`、`/var/lib/visuhive-account/accounts.db`、8790；render/Agent从未部署，Agent新配置8791防撞。SQLite在线backup一致性、实际restore隔离验、自动backup、全组件版本元组、复原不复活撤销高水位、三版本各完整包+patch+release+真网络与timings均有步骤。cipher只写root以指定文件`--file`导入、核末四位与两模型实调用后删除步骤，本任务未碰值或打印尾位。

## 裁定、风险、未做成与顾问

方案解法表14项机制裁定，每项原因、候选g/h/f与可执行探针名齐全；已定外链/容量/选区/私有/FIFO/无迁移/气泡/告知不再标待决或另裁。没有新增一级语义决定、没有下游完全无法开工项、没有停等用户审批。

重点风险是第4项accepted时序：account顺序见证不得取代doc权限权威；reserve/seal/accepted/fence真实协议必须由Astra独立worktree在每个持久切点验证，未证则不放行0.7.20补偿。第2项mTLS隔离需root实际部署专用用户/证书和同机错误UID验证；第14项rollback必须保留撤销高水位与恢复后新写journal。它们是后续实现/部署验收闸门，不是已通过结果。卡片出口护栏撤销是用户决定，其余账号、stage分源、project隔离仍须产品反向探针。

未做产品代码、探针实现、备份restore、网络验收、版本包与节点部署，原因是本子任务明确只授权设计与接口；已逐项派到实施包/root，不能报已完成业务。未调用外部顾问/新子Agent；主会话要求Sol自写方案、Astra只后续独立故障包，当前不存在顾问穷尽或已试实验结果。根正在跑集成基线，本任务没有重复占资源。

## 提交与最终状态

- `b8c9b4c5`：开工报告，单独提交。
- `eb7bfff4`：身份迁移矩阵/跨仓库API。
- `ae4efd3a`：退出区间/已读授权竞态（其中旧doc前置屏障方案在最终块已替换）。
- `86c0e653`：素材全链路/工具清单/旧文件恢复。
- 最终完整块：派工/验收/部署/最新用户决定及本完成报告；具体最终SHA在交回消息记录，避免报告自引用提交哈希。

## 状态

设计、接口与可派发包已完成。仅两份授权文档变更；最终提交后工作区应干净，由交回前`git status --short`确认。未合并、推送、建其它工作区、修改进度、启动服务或测试进程、操作节点或触及用户数据。
