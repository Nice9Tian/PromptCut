# 018中央素材接线报告

状态：开工。专属分支codex/018-asset-wiring，起点cc085b9ff46ffc932135d18960b82d0da9abd867；旧资产包保持只读。5860～5869开工只读核零监听。

目标：public opaque assetTicket经独立asset client证书mTLS问doc权威建立可信principal；项目独立stores挂中央HTTP/媒体/stream入口；真实连续access events追齐、实际资源close、receipt持久后ACK。重启/失联/head未齐ready=false且failclosed，内部追齐才允许组合join/session，public不能设置ready。提供独立asset进程入口及配置边界，生产OS用户/私钥隔离和部署由根负责。

独占：server/hosted/combo.mjs；server/hosted/main.mjs仅asset配置/入口；新asset↔doc mTLS client、服务入口及asset专属test/probe。本叶不改doc/account权限/HTTP/router/会话或旧素材底层包，接口不足先报其owner。本期仍保留LAN v1，无UI/费用/defaultmemory/真实密文/部署/版本/merge/push/清理操作。

验证：先约跨进程接口；独立服务真实A/B同hash、无证/伪principal/错project、GET/HEAD/Range/chunks/upload/complete/媒体/stream、long source/fd真实close才ACK；真实resume/crash/head与ready正反向。固定完整块后类型、target、一次必要full；首次失败全部保留。Node绝对静默预载，整子树windowsHide及实际close，产物只TMP；Python如需使用cuda_Vit和PYTHONDONTWRITEBYTECODE，不改环境/依赖。

未完成：实际assetTicket解析契约、独立mTLSclient/entry、连续消费与中央ready接线均尚未实施；当前base仍0.7.17，release前0.7.18 required传播由根整合确认。原isolated素材证据不替代本包中央验证。

## 跨进程接口与首块

- doc owner约定runtime assetReadyProbe({authorityId,requiredAccessHead}) -> {ok:true,ready:true,authorityId,instanceId,accessCursor,accessHead}；比较的是doc access事件head，不是account事件head。每次join/session前后实时同步doc，并要求两个head不变/asset精确追齐/同instance；缺callback生产503。asset内部GET /internal/v2/asset/status只认doc mTLS证书，先真实consumer.sync再回status，不提供public setReady或永久POST ready。
- doc owner另补opaque ticket解析：/internal/v2/access/check的assetTicket分支缺projectId时取真实绑定principal.projectId，显式projectId严格相同。原返回allowed+account/login/credential/generation/project/authority/access/revision/revocationSeq/authorizationId足够建立精确principal；没有另复制账号或项目权威。
- 首块新增独立asset doc client、service runtime/entry和combo/main status配置：doc只读自己status client私钥，独立asset只读自己client/server私钥；v2配置external status时combo不再监听旧素材端口，公网字节直达独立asset。缺接线仍准确不可用，不降级LAN全局库。此刻runtime尚待真实provider集成，不能称生产接通。
- asset-client-1 RPC测试2/2、0fail/skip，1729.559ms，TMP/promptcut-asset-wiring-client-1.log；真实临时CA/各角色证书和mTLS，覆盖opaque字段/pin/错证书/伪principal、连续通知、精确certificate-derived asset ACK及实时status精确head。这是transport单测，权限authority为局部stub，不替代真实doc+account+独立进程验收。
- 只读搜索误把account-hosted-wiring文件名/模块位置反写造成ENOENT，另一次rg Windows glob路径报os error123；按rg --files/真实import修正，无源码变更，不归咎产品。大段合读输出截断后改按真实文件分段读取。
