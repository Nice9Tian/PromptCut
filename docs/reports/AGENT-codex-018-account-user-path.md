# 账号登录与云端项目用户入口实施报告

2026-10-09；工作分支`codex/018-account-wiring`；开工固定起点`26cbf7e07cb44a169b8aafe6cf1fae4500026e94`，tracked/untracked均干净。旧B素材叶保持冻结，不改其源或恢复机制。

目标为真实账号登录→新建云端项目→第二账号凭链接加入→双方网站列表有项目，并给桌面版和在线浏览器完整入口。本叶只负责PromptCut开始页、编辑器云端进入/登录恢复桥；网站列表与真实后端接线由root协同，不用受控ready替代完整链。

租约：`src/StartPage.tsx/css`，`src/editor/io`、`src/editor/sync`中账号登录/云端创建加入所需文件，新`src/account/`、专属tests/probe和本报告；desktop仅安全凭据存储及UI桥最小必要文件，具体路径先报告root。禁止修改server/account、server/hosted、素材store、Agent、B/G源、全局测试脚本/端口守门或环境安装。

开工已读AGENTS入口、developer_guide索引、suggested_agent_behavior、constraints；继续核账号任务书/产品语义/真实account-hosted API与已有前端和桌面桥。先交可复用入口与最小清单再实现；网站账号模式不在localStorage存长期凭据，桌面复用现有vault原则或报告缺机制。后端503原样准确呈现并交真实依赖，不绕ready/ACL。

验证未开始。6340～6349仅自身临时fixture；纯类型/无监听可做，任何监听目标/full先报命令待root排窗。Astra6320～6329在运行，不碰用户/其它Agent端口。所有数据日志TMP、子树windowsHide/绝对silent preload，Python仅进程cuda_Vit/models；不push/merge/节点/新worktree/install/junction。首红、具体源码与raw结果随后补记；用户路径功能探针实际通过才记阶段。
