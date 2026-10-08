# 云端 run assets 权威 A 包报告

固定基底712dda863a48460002f343c99c3feb4907f7e968；工作叶018-cloud-run-assets-authority。目标是实施已审F0设计的doc资源发行、实例/资源精确再验、连续控制outbox与持久lease/nonce/receipt模块，保持现run authority唯一判权，不复制ACL或retained规则。

独占仅新增server/account/run-assets.mjs、run-assets-internal.mjs、run-asset-protocol.mjs、server/test/run-assets-*.test.mjs及本报告。原authority/instance/run provider、operation、中央/worker/asset/Jobs全部只读。当前状态：开工，接口和模块尚未实施。

根C10占用宽探针/full，当前禁止所有listener（含listen0）及full/服务/节点；仅无监听pure精确npm目标、绝对tsc。真实mTLS目标可编写但等待根窗口后执行，不将受控adapter当真实TLS证据。每次首红保留，源码固定后才运行，不改全局环境/安装依赖/用户数据/密钥。
