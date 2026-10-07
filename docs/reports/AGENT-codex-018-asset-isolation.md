# 项目素材隔离实施报告

任务分支 `codex/018-asset-isolation`，起点 `986ebec6ba36900a1944188b02b4399fb815de7a`。Sol 独占本工作区的素材服务、物理 store、媒体队列/转码/流接线及专用测试。卡片包冻结；不改中央组合、票据、账号、doc 权威或其它已租文件。不合并、推送、部署、升级依赖或碰真实用户数据。

## 已授权目标与边界

素材按项目物理隔离；知道 hash 不能跨读。A/B 合法分别上传同字节各自可读，B 未入库拒绝；删 A 不影响 B。持续流失权立即关闭，异项目、旧授权与迟到产物不能入库。GET/HEAD/Range/chunks/upload/complete、绑定、PCM、tier、thumb、stream 及队列缓存覆盖。中央 owner 后续挂载，本包不宣称生产组合已接通。

已读 AGENTS、developer_guide、suggested_agent_behavior、constraints、solution_table、verification、multi_agent、git_and_release；素材 product/mechanism、materials 工作流、asset-store-contract、three-versions-018-design 的素材包与接口、render-scheduling-supplement 全文。旧契约任意有效项目票据可读所有 hash 的条款与 2026-10-08 已定产品冲突，本包按已定隔离收紧；本地默认兼容。调度的内存/磁盘阶段不授权提前回收、故障 A/B 或删除策略。

## 接口与验证计划

先交 `createProjectAssetStores/authorizeAsset/openProjectStream` schema，与 doc-authority 的唯一身份/项目授权核验及撤销流协商，不复制权限账本。后做可独立运行的真实 HTTP 素材服务和队列/流负向测试。5780～5789 为独占端口；只用 TMP 合成数据与进程级环境，Node 绝对预载主仓库静默 helper，所有子进程隐藏并等 close。Python 如使用设 cuda_Vit、PYTHONDONTWRITEBYTECODE=1，models 仅进程指主 out/models。

定向测试、真实 HTTP 探针、强制类型检查、一次完整 npm test；所有失败与耗时照实保留，有代码/证据变化才必要复验。中央接线与 Linux/真网络由根后续验证。

## 开工记录

- 起点与工作区干净已核；初次只读搜索误用 Bash 花括号展开于 PowerShell，ParserError、未执行读取/变更；改明确文件清单后读取成功，不算测试。
- 状态：开工，未实现、未验证，不以计划替代通过。
