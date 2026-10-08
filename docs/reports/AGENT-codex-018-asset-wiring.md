# 018中央素材接线报告

状态：开工。专属分支codex/018-asset-wiring，起点cc085b9ff46ffc932135d18960b82d0da9abd867；旧资产包保持只读。5860～5869开工只读核零监听。

目标：public opaque assetTicket经独立asset client证书mTLS问doc权威建立可信principal；项目独立stores挂中央HTTP/媒体/stream入口；真实连续access events追齐、实际资源close、receipt持久后ACK。重启/失联/head未齐ready=false且failclosed，内部追齐才允许组合join/session，public不能设置ready。提供独立asset进程入口及配置边界，生产OS用户/私钥隔离和部署由根负责。

独占：server/hosted/combo.mjs；server/hosted/main.mjs仅asset配置/入口；新asset↔doc mTLS client、服务入口及asset专属test/probe。本叶不改doc/account权限/HTTP/router/会话或旧素材底层包，接口不足先报其owner。本期仍保留LAN v1，无UI/费用/defaultmemory/真实密文/部署/版本/merge/push/清理操作。

验证：先约跨进程接口；独立服务真实A/B同hash、无证/伪principal/错project、GET/HEAD/Range/chunks/upload/complete/媒体/stream、long source/fd真实close才ACK；真实resume/crash/head与ready正反向。固定完整块后类型、target、一次必要full；首次失败全部保留。Node绝对静默预载，整子树windowsHide及实际close，产物只TMP；Python如需使用cuda_Vit和PYTHONDONTWRITEBYTECODE，不改环境/依赖。

未完成：实际assetTicket解析契约、独立mTLSclient/entry、连续消费与中央ready接线均尚未实施；当前base仍0.7.17，release前0.7.18 required传播由根整合确认。原isolated素材证据不替代本包中央验证。
