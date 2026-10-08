# 生产单元工作目录修复

节点真实 systemd 249 拒绝之前生成的三个单元：WorkingDirectory 单值路径被外包双引号，报路径非绝对和 bad unit setting。新服务未启动，旧服务未停；生成的私钥、公开登记和旧数据均保留，没有重新生成钥匙来绕过问题。

只收 Sol 独立两文件提交 e378081ddd6505e7431dc31669276578f27de8ff：工作目录用单值格式、拒尾随白字与引号；其它角色、TLS pin、私钥与数据分离守门，以及 ExecStart 等向量字段保持。任务素材中央登记和未完成的新实例接受机制仍留独立分支，没有一并合入。

Sol 真实静态首红 5项4通过1失败，修后6/6，包含原有实际三服务路径；强制类型零错、6440–6449清空。原始 TEMP pc-account-v2-working-directory-{red,green,type}.log 保留。Windows 字符串断言不代替 Linux 实际单元解析；主会话还要核精确候选全量、生成配置和真实 systemd，再交付本阶段。

根首次候选f5b96bf7类型零错、完整5307/5303通过/0失败/4跳过70187.4166ms（墙70.547秒）、两构建通过，native重跑0。节点实际verify退出0但三份EnvironmentFile带引号均被忽略；另启动唯一隔离unit、真实含空格/百分号/反斜杠目录，CHDIR退出200，证明首修仍未正确。临时unit停止并清掉，旧三服务未停/新三服务未装，完整日志TEMP pc-account-unit-verify-f5b96bf7/unit-proof-first.log及对应full/type/build保留；不把全量绿或verify退出0等同部署通过。

二次仅收b51e494f两文件：WorkingDirectory与EnvironmentFile单值均只转义百分号，保留反斜杠与内部空格，向量字段原样保留。依据systemd v249 load-fragment.c的config_parse_working_directory/config_parse_unit_env_file源码，两者直接用rvalue解析。Sol新首红7项4过3败、修后7/7、type0，TEMP pc-account-v2-single-path-{red,green,type}.log；根还要以真实cwd与环境标记复核，不能用静态字符串断言代替实际加载。
