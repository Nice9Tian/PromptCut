# 运行资源独立关闭证明：最小实现设计

开工点：本叶 d111ada9（正常终态源码 c705c125）保持冻结，产品只读。只新增本报告和系统 TMP 的无监听反例，不运行 npm/full/业务监听/模型/节点。核验对象为 Sol executor 655d796d294d2b67ce46163ef88f5195261b8134（读取时 clean）及主库 root publisher/schema v2 固定 main 4bb2355f85cc26a7e296f5434ad7781dce4f4704。

目标：给 normal finish 一个真实独立的 run 资源关闭 producer，保留同实例签名、完整 read/outcome 绑定和 FIFO；不把整代 asset scope 当作 run scope、不写自由 closed row、不用零计数或 donePromise 代替 OS 证明。先交可执行三级方案与实际反例，根裁定后再分实现租约。
