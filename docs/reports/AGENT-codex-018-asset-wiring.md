# 018中央素材接线报告

状态：开工。专属分支codex/018-asset-wiring，起点cc085b9ff46ffc932135d18960b82d0da9abd867；旧资产包保持只读。5860～5869开工只读核零监听。

目标：public opaque assetTicket经独立asset client证书mTLS问doc权威建立可信principal；项目独立stores挂中央HTTP/媒体/stream入口；真实连续access events追齐、实际资源close、receipt持久后ACK。重启/失联/head未齐ready=false且failclosed，内部追齐才允许组合join/session，public不能设置ready。提供独立asset进程入口及配置边界，生产OS用户/私钥隔离和部署由根负责。

独占：server/hosted/combo.mjs；server/hosted/main.mjs仅asset配置/入口；新asset↔doc mTLS client、服务入口及asset专属test/probe。本叶不改doc/account权限/HTTP/router/会话或旧素材底层包，接口不足先报其owner。本期仍保留LAN v1，无UI/费用/defaultmemory/真实密文/部署/版本/merge/push/清理操作。

验证：先约跨进程接口；独立服务真实A/B同hash、无证/伪principal/错project、GET/HEAD/Range/chunks/upload/complete/媒体/stream、long source/fd真实close才ACK；真实resume/crash/head与ready正反向。固定完整块后类型、target、一次必要full；首次失败全部保留。Node绝对静默预载，整子树windowsHide及实际close，产物只TMP；Python如需使用cuda_Vit和PYTHONDONTWRITEBYTECODE，不改环境/依赖。

开工状态（历史，后续实现见下）：实际assetTicket解析契约、独立mTLSclient/entry、连续消费与中央ready接线均尚未实施；当前base仍0.7.17，release前0.7.18 required传播由根整合确认。原isolated素材证据不替代本包中央验证。

## 跨进程接口与首块

- doc owner约定runtime assetReadyProbe({authorityId,requiredAccessHead}) -> {ok:true,ready:true,authorityId,instanceId,accessCursor,accessHead}；比较的是doc access事件head，不是account事件head。每次join/session前后实时同步doc，并要求两个head不变/asset精确追齐/同instance；缺callback生产503。asset内部GET /internal/v2/asset/status只认doc mTLS证书，先真实consumer.sync再回status，不提供public setReady或永久POST ready。
- doc owner另补opaque ticket解析：/internal/v2/access/check的assetTicket分支缺projectId时取真实绑定principal.projectId，显式projectId严格相同。原返回allowed+account/login/credential/generation/project/authority/access/revision/revocationSeq/authorizationId足够建立精确principal；没有另复制账号或项目权威。
- 首块新增独立asset doc client、service runtime/entry和combo/main status配置：doc只读自己status client私钥，独立asset只读自己client/server私钥；v2配置external status时combo不再监听旧素材端口，公网字节直达独立asset。缺接线仍准确不可用，不降级LAN全局库。此刻runtime尚待真实provider集成，不能称生产接通。
- asset-client-1 RPC测试2/2、0fail/skip，1729.559ms，TMP/promptcut-asset-wiring-client-1.log；真实临时CA/各角色证书和mTLS，覆盖opaque字段/pin/错证书/伪principal、连续通知、精确certificate-derived asset ACK及实时status精确head。这是transport单测，权限authority为局部stub，不替代真实doc+account+独立进程验收。
- 只读搜索误把account-hosted-wiring文件名/模块位置反写造成ENOENT，另一次rg Windows glob路径报os error123；按rg --files/真实import修正，无源码变更，不归咎产品。大段合读输出截断后改按真实文件分段读取。


## 独立入口、恢复fence和部署闭包完整块

- 显式依赖接入：首次pick 0e12db21因base少da476出现报告/test冲突，未猜合并。根授权abort，仅撤中间状态，保留4d4aeb9a；然后按顺序pick da476e15659990247efa54bf1f20015b39576473（本叶20619755）和0e12db214f7d2509abb93c59fc47253834bf5584（本叶e27fbcad）。原doc源码由owner提供，未另改权限模块。
- 独立asset-main只读asset角色client/server私钥与doc CA/公开fingerprint；doc combo只读doc角色status client私钥。新增内部status监听独立mTLS口，只认doc叶cert pin。public opaque ticket由asset自己的client cert向doc核对，显式project不一致拒；不接public principal/role/runGrant，不把token存队列/cursor/receipt。status先消费真实连续日志，cursor/head不相等或doc失联拒ready；doc每次join/session两次真实status核精确head和同instance。周期100ms是日志追齐唤醒；每次数据请求仍问doc，不是权限缓存。
- 新asset-lifecycle：启动持久running marker和独占owner lock；正常close在consumer实际owned资源、HTTP内部/public listener全部收口之后才写clean。旧running时，生产必须提供root文件、全部祖先root所有且不可group/world写的fence；Windows生产不接受。证明绑定previousInstanceId、previousPid、previousServiceFingerprint256、serviceId asset、scope=上一marker的serviceIdentity，observedAt>=上一startedAt且不在未来。不同旧instance证明不能永久复用。缺证明/错身份/未核旧资源关闭拒消费者启动、拒ACK。服务身份由PROMPTCUT_ASSET_SERVICE_IDENTITY配置；根部署专用asset UID、systemd KillMode=control-group，停旧服务后真实核旧cgroup空，写root控制的单次证明再启动。PID死亡本身不等于orphan ffmpeg关闭。
- Windows受控fixture只在测试API显式allowFixtureRecoveryFence:true接受owned-tree-close；生产CLI没有该开关。证明由父测试在own child的实际close之后生成，本次没有在途ffmpeg（PCM已真实完成）。它证明自有文件流子树crash恢复，不证明Linux OS UID私钥隔离、orphan worker/cgroup或物理掉电。根须在节点核这些部署前提。

### 授权的纯移动与接线差异

| 文件 | 内容/行为边界 |
|---|---|
| server/frame-stream.mjs → server/asset-store/stream-store.mjs | readySegmentRanges、StreamStore、publicManifest、handleStreamRequest原函数体纯移动；原模块保持import/reexport同一个实现。SEGMENT_FRAMES仍来自原ffmpeg常量，producer/encoder/像素/参数未改。 |
| server/frame-mov.mjs → server/asset-store/atomic.mjs | atomic原重试/临时文件/rename函数纯移动，旧导出保持；PNG/MOV逻辑未动。 |
| server/snapshot-store.mjs → server/asset-store/ranges.mjs | mergeRanges原函数体纯移动并reexport；atomic改引纯模块，其余快照逻辑不动。 |
| server/vite-plugin-shots.ts → server/asset-store/shots-thumb.mjs | shotsDir、shotsThumbMiddleware按Node stripTypeScriptTypes只剥类型，原TS import/reexport；读口project guard/hold/trackHandle/actualclose行为保留。shotsDir旧dataDir表达式相同；识别/Python/worker不移动不改。原文件没有projectShotsDir函数，不发明导出。 |
| server/vite-plugin-media.ts | 根唯一授权的一行动态import bakery/index → bakery/ffmpeg，同findFfmpeg导出/行为。 |
| server/hosted/asset-runtime.mjs | 改引纯stream/thumb读口；stream传已解析pathname而不是含?t的req.url，并对不认路径答404。原handler协议不改。这是入口接线修正，不属纯移动。 |
| server/hosted/files.mjs | 新独立stageHostedAssetFiles和HOSTED_ASSET_DEPLOY_FILES；旧hosted清单/策略不改。 |

系统AST遍历asset-main所有静态/literal动态import（TS用Node剥类型，JSON计入），精确闭包49文件；bare外部依赖0、无法解析dynamic target0、missing0。清单和图在TMP/pc-asset-deploy-closure-2.json。独立stage不复制node_modules，不安装pngjs/puppeteer，也不把整套生成/解析模块放入asset角色。此前frame-stream→frame-mov→pngjs以及shots→vision-compose→pngjs链由纯抽取移除。

### 所有首次失败和有因修正

| 尝试 | 原始结果/原因 |
|---|---|
| client-1 | RPC 2/2、0fail，1729.559ms；局部authority stub，仅transport契约。 |
| stage-1 | 0过1失败；真实隔离import ERR_MODULE_NOT_FOUND pngjs来自frame-mov。保留TMP/promptcut-asset-wiring-stage-1.log。 |
| move-1 | 原frame-stream、snapshot-store和四份MOV/playback/archive/cache tests 82/82，0fail/skip，444.8134ms。 |
| stage-2 | 静态runtime import/缺配置拒启1/1，277.8856ms；当时未执行runtime的TS动态import，不能充当三读口证明。 |
| integration-1 | 1过1失败，2217.8094ms；首个完整入口拒启。stage-diagnostic-1定位抽取残留shotsDir返回TS标注，非产品服务不可用。 |
| integration-2 | 0过2失败；第一次机械删标注仅删一处，第二处root:string残留。我承认抽取方式失误；不删断言。 |
| integration-3 | 改用原TS函数经Node完整stripTypeScriptTypes后，真实动态三模块和provider/独立stage入口2/2，6566.0502ms。 |
| integration-4 | 2过1失败，6344.4268ms；故障代理仅丢一次ACK，consumer已立即通过通知队列重试清掉pending，测试读null。不是source未关闭。 |
| integration-5 | 故障持续丢ACK直到own process crash；3/3，0fail/skip，6736.1542ms；真实source fd gate与receipt重放通过。 |

上述日志均在TMP/promptcut-asset-wiring-<名称>.log；stage-diagnostic-1为明确语法原文。新child日志以时间戳独立保存，路径由测试diagnostic打印；首次两份旧child合并log曾用同名覆盖，主测试日志与diagnostic原文保留，不声称旧child副本全在。只读rg Windows glob/错误文件名报错、依赖扫描PowerShell引号导致node-e SyntaxError均未改源码；改literal stdin/真实路径后完成系统检查。

### 真实中央产品证据范围

asset-wiring-integration.test.mjs用冻结VisuHive provider的store/credentials/internal真实代码，新TMP SQLite与临时CA/账号，不读真实密码/钥匙/数据。实际combo(doc public5861/internal5862)问实际provider5860，隔离stage asset-main public5863/internal5864，asset角色独立进程且仅读取own cert/key。受控ACK丢失代理5866仅转发真实doc，先等doc持久成功再断响应；不伪造权限/ACK。RPC专用5865。子树隐藏并await实际close，所有artifact仅TMP。

覆盖三命名空间A/B独立同hash上传完成和GET/HEAD/Range/chunks/complete；B未入库404/空清单，同hash分别入库可读；无证/伪principal/错project/public内部口拒；回环缺client cert真实TLS失败；media上传/真实非零ffmpeg PCM、同项目adopt保留输入/跨项目私路径拒；真实stream manifest/init/seg、未接受publication marker隐藏；真实thumb文件隔离；asset离线join/session503且不加成员、上线真实head自动可用；HTTP正文结束后真fs source _destroy gate使closed=false、fd仍数值，持久logout时receipt为空/cursor不越事件；release到actualclose之后才完成ACK；真实网络持续丢ACK响应→own child crash→可信fixture fence→pending同receiptId及全字段重放；clean restart实际asset-main换instance并session再次通过。最后扩充成功join、新登录删除A而B同hash保留等断言待固定完整块target确认。

未覆盖/未挂载：没有生产部署/真实公网/Linux完整HTTP或专用OS UID实权隔离；cgroup证明由根提供且本机未试orphan ffmpeg；未挂render/Agent runGrant权限（仍拒body豁免）、业务队列自动删除/回收未决语义不实施；流producer仍由后续owner传可信写lease，本包挂真实read routes并以TMP可信seed验证，不冒称生产render产物已贯通。combo旧LAN全局admin inventory/usage不变，v2 public不降级它；不推出新管理员删除策略。基底仍.17；root release .18前必须传播PROMPTCUT_ACCOUNT_V2_REQUIRED=1及独立asset/status/key/UID/fence配置，否则缺required/配置即未完成生产，不冒称可上线。

待最终固定验证：type、含最新补充断言的target、一次必要npm full，以及diff--check/干净SHA；完成后另追加精确结果，不冒用旧节点6项或旧4966全量证据。
