# 完整编辑器工具与独立进程关闭：根实证

2026-10-09。共同固定候选 `a4d22ce33264e957aabd6ef825305a90b3daa899`；以下各项运行前后同提交、工作区干净，无自动重跑。小阶段按类型、npm全量、自身功能探针收回。

## 已通过的范围

| 根会话实际执行 | 条数与结果 | 耗时 |
|---|---|---|
| `tsc -b --force` | 退出0，零类型错误 | 墙钟7.422秒 |
| 19个相关npm目标 | 177/177，失败、取消、跳过均0 | 6738.935ms，墙钟7.094秒 |
| `npm test`全量 | 5502条，5498通过、0失败、0取消、4条原有跳过 | 73472.3516ms，墙钟73.813秒 |
| Vite online构建，输出仅系统TEMP | 退出0 | 墙钟1.937秒 |
| 完整在线编辑器、两个账号窗口 | 17/17，completed=true | 10707ms，墙钟11.343秒 |
| 切私有后即时清除读取与历史、三个账号 | 29/29，completed=true | 8523ms，墙钟9.047秒 |
| 真实Linux、两个独立任务进程组 | 10/10，首次通过，无重跑 | 8357ms，含准备10061ms |

完整编辑器实际通过网站登录、项目加入、首次告知及开启，合法发送202后使用现有HostedRunnerFactory、同进程内存密钥的WSS和文档授权，实际运行`get_project/get_selection/report_progress/set_project_meta`。项目名称落盘，两个页面都收到文档版本1→2；同一用户消息和唯一助手、成功工具、进度与正常展开的原文可见，另一账号从持久历史重放。根会话实际看过双方截图。

模型响应由现有mock-script控制，factory、harness、文档连接、工具及实际写入没有替换。不是生产模型验收。任务许可仍active、队列仍占用，界面等待关闭与结算，completionReady=false；数据连接实际为0也没有据此假报整个任务完成。

HTTP窄修将定时poll的同步撤销异常纳入原Promise监督并关闭真实响应；没有放宽读权限。根复验切私有29项确认原读取断开、正文和附件立即清除、旧历史不可重放、创建者私有只读仍成立。

浏览器、两个舞台、夹具、独立素材子进程及原响应均实际关闭；租用端口段6620–6629、6700–6711无监听。截图：[A完整编辑器](three-versions-real-runner-scope-evidence/root-real-00-actual-editor.png)、[B历史重放](three-versions-real-runner-scope-evidence/root-real-01-actual-editor.png)、[成员清除私有历史](three-versions-real-runner-scope-evidence/root-private-06-member-after-private-history-refresh.png)。

## Linux关闭实验的实际边界

实验源码为`fc47062eb0d6133370dcad2bed917d7408806a22`；十个运行文件的Git blob SHA256与共同候选完全相同，列表见[源码与实验元数据](three-versions-real-runner-scope-evidence/linux-metadata.json)。不是套用旧生产报告。

根使用新命名空间、匿名新证书、受控Doc签发器、两个非root实验worker。systemd限制仅作用于自建实验单元：MemoryMax128M、CPUQuota25%、TasksMax32、最长90秒、无自动重启；两槽及这些数字都不是生产默认配置。受信输出目录位于`/run`的0755祖先下，替代原报告`/var/tmp`示例。

A在3823ms父进程已退出，但子仍持文件和TCP、原进程组非空，reader拒绝关闭；5825ms原固定句柄读到组为空、父子均退出、资源均关闭后才接受耐久关闭。期间B仍为原活跃身份、文件与连接保持；B在8147ms同样从原句柄证实关闭。缺marker、持有锁、混入B闭合记录、替换新空句柄四种反例均被真实reader拒绝。

两单元最后inactive、MainPID0，实验6540–6549零监听、无待收回单元。账号/文档/素材/nginx四个生产PID分别279515/279516/279517/9395，前后均active、重启数0。实验源码、证据和停用的自建单元文件保留，没有删除实际数据或备份。[完整安全结果](three-versions-real-runner-scope-evidence/linux-result.json)

本包提供独立Agent关闭记录、root发布与只读核验；没有接业务Doc admission、生产任务worker或终态finalizer。其后的实际接线单独验证，不能以受控签发器实验代替真实队列释放。

## 首次失败与尚未通过

Sol最初真实工具链出现重复启动读控制、测试进度参数漏必填、错读project.state字段；完整窗口探针先后有输入API不存在、读流同步异常、默认简洁视图选择器和原文展开判断错误。读流是产品窄修，其余按真实已有控件修夹具/探针。全部原始失败、最终成功和原因已归档：[原报告](agent-reports/AGENT-codex-018-agent-real-runner.md)。异常退出那轮没有结果JSON，manifest记缺失，未补称通过。

进程关闭原报告当时仅有纯测试；根实际Linux结果在其末尾另记，不覆盖历史：[原报告与根补记](agent-reports/AGENT-codex-018-agent-run-scope-producer.md)。本轮共同候选的全量及两个浏览器均首轮全绿。

改密网站/编辑器窗口尚未通过，保留在独立分支，不进入本阶段；provider专属通过不冒称用户路径通过。生产两模型、素材工具、任务worker与Doc结算接线仍未完成。

原TEMP文件未改；归档JSON隐藏敏感字段、URL查询和票据，日志包含敏感字段的整行隐藏。归档日志副本只去终端色码和行尾空格。65个文件与1份缺失记录见[证据manifest](three-versions-real-runner-scope-evidence/manifest.json)；类型、目标、全量、构建、窗口和Linux原结果均在该目录。
