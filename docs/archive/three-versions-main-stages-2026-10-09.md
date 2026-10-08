# 2026-10-09 小阶段交付与验证记录

## 首个后台基础模块阶段

基底 main e0e3afc37f04f51f0ea5e85eb9aa392183cf77c0。33 个源码/测试文件从共同候选 cbe8398dccffc84760ed8db734777ee0d88cd607 逐字收回，均为新增模块；未带入 B/G 在途实现，也未修改现有渲染、卡片、舞台或桌面代码。文档来自集成 b9b85722，用户最新主分支决定保留。

固定独立候选 f41c5ff94a33d93b28c2dea5a48b7c2da61a11a6，测试前后同源且 clean，native 自动重跑 0：

| 命令 | 结果 | 耗时 | 原始日志（系统临时目录） |
|---|---|---|---|
| node node_modules/typescript/bin/tsc -b --force | exit0，零错 | 4.844秒 | pc-passed-foundations-f41c5ff9-type.log |
| npm test | 4452项，4450通过、0失败、0取消、2跳过 | 54192.9515ms，墙54.515秒 | pc-passed-foundations-f41c5ff9-full.log |
| npm run build | exit0 | 墙6.890秒 | pc-passed-foundations-f41c5ff9-build.log |

两个跳过：未设置舞台服务的真实卡片布局集成；Windows文件权限不能证明POSIX权限。均不记通过。模块功能目标已实际在完整npm执行：SQLite账本与故障重启、同消息/实例上下文隔离、连续保留任务检查点、素材精确HTTP请求/防重放和真实TLS三角色连接、工作目录/额度/出网隔离；受控registry/sender/media callback的边界仍保留，不冒称生产中央或用户界面交付。此阶段没有改画面；整套历史探针按用户2026-10-09纠偏留到发版前。

## 当前普通档浏览器失败

共同候选cbe8398d的真实探针单次自然结束：exit1/ok:false，2失败、pending0，脚本200227ms/墙200.313秒，native0，源不变clean。用户卡真实源码put/get一致、两个舞台ready；实际成本step176.9ms、capped/重载，当前rev4计划含目标。失败是回读尚未确认文档服务接受同源新片段，未启动独立host。临时项目由本探针删除，6320～6329结束无监听。

原始证据：TMP pc-root-c10-assets-cbe8398d.log/.result.json/-out。开工前集成301c3092的独立对照待运行；旧失败不覆盖、不把测试夹具问题冒称已证产品原因。

## 素材异步关闭审查

固定e361受控真实consumer/资源关闭/物理I/O反例证三问题：admit落盘失败后关闭Promise未监督、pause等待admission时拒绝未处理、openRead初始化不在close屏障。第一fd疑点在真实run-resources下未成立，拒绝前fd=-1。首次counter/raw均保留TMP pc-assets-e361-*。

B修后a7d纯目标29/29、零失败取消跳过、393.3215ms，类型exit0/5.453秒；两轮正式首红6项5过1败及13项10过3败保留。新源未做共同/TLS，未收回main。

## 节点Python授权

三个元包3.10.6-1~22.04升3.10.6-1~22.04.1并补python3-venv，实际解释器与采集venv仍Python3.10.12。升级前后nginx/账号/托管PID、启动和重启计数一致，未动本机cuda_Vit。原始私有日志TMP promptcut-node-python-upgrade-5992910b56ab4ac98f0f36576215417b.log；没有凭据值。
