# 独立任务进程接线与关闭准备：根实证

2026-10-09。全部代码仍在集成分支，未把未完成的 worker 业务路线合入 main；本页只是已经亲跑的证据归档。
worker 指每条任务单独启动、只处理这条消息的进程；root 槽指由节点管理员控制、按原进程身份核验资源的隔离位置。

## 联合接线

- 固定联合源码 `ab217f05ad0fc09be354426bb577af4ed952b899`，包含原 RAM 身份、任务分配、事件双端耐久日志、文档关闭与失败观测接线。
- 根首次强制类型 0 错误，7.125 秒；17 个相关文件 219/219，0 失败/取消/跳过，1865.804ms（墙 2.125 秒）；自动重跑 0。测前后源码相同且工作区干净。
- 包含实际 mTLS 注册、事件 HTTPS/exporter/原 RAM 签名、双端 SQLite FULL 回执，以及实际 Doc handler 与终态 read/write/ticket 拒绝；注册和事件两份组件测试的 root OS/current getter 各自明确受控，不偷换为生产任务验收。
- 之前根在固定 `8c1b1c02` 的实际注册目标首次 1/1、933.0754ms（墙1.188秒）也保留；只证明身份/执行门和关闭，不证明 Hosted SSR 已成功启动。
- 所有自有 TLS 已关闭，6700–6721 零监听；端口窗口交回对应 Agent。

## 实际 Linux：先父死、子仍占资源，再原组实空

- 独立 forced 首轮：固定 `9e9854abc913c488c6b844aa44554f6c18c97c7d` 的10份源码，11/11、exit0、8703ms；这是受控 Doc issuer 下的实际 OS 证明，原失败和首次证据没有覆盖。
- 新 crash-observation 首轮：从联合固定源码导出的10份 Git blob逐一核SHA256，新目录、新PKI、新自有unit；12/12、proof/SSH均0、8502ms（wrapper12.047秒）。没有重跑。
- A在3854ms原父已消失，原子仍存活、文件FD/TCP仍占用，原scope populated=1；真实失败观测和完成marker可读后reader仍bound，绝不closed。
- A到5859ms同一固定FD看到populated=0，父子都消失、文件和两条连接关闭，才接受真实关闭链。
- 同期B在6083ms保持原实例和全部资源。B在8254ms文件/TCP已关但子仍存活、populated=1；8275ms原组实空后才closed，不能以连接为零提前释放。
- 真实B元组冒替A、缺marker、持锁、混代、新空实例均拒。两自有unit inactive/MainPID0，retainedUnits=[]，6540–6549无监听。
- 四生产服务PID为279515/279516/279517/9395，前后一致、NRestarts都0、都active。未删除实际数据，实验证据与unit配置保留。

## 没做到的边界

实际模型/文档工具尚未在新的独立OS任务进程中完整执行，gateway及正常收尾消费继续实施；完整FIFO用户路径、生产两个模型、附件、素材资源与渲染部署均不计通过。
新root观测是实际Linux，但Doc失败producer在本机SQLite/TLS中验证，Linux探针仍controlledDocIssuer=true、productionExecutor=false；没有把两份局部实验拼成生产业务证明。
若系统已删除原service cgroup、不能核原对象，仍保锁pending；不能用ENOENT或新进程空库存宣称旧任务结束。待完整路线固定后另跑该阶段全量和实际用户探针。

数字、原日志、两个Linux首轮与源码哈希见[同目录证据](three-versions-worker-preparation-2026-10-09-evidence/root-joint-target.json)。没有收录私钥、令牌、密码或机器绝对路径。
