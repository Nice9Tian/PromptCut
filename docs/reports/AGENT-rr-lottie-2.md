# AGENT 报告:渲染重构「癸二」——Lottie 的测量、评估和补测(分支 `claude/rr-lottie-2`)

「癸二」指 `docs/plan/render-refactor-task.md`「癸:Lottie 改成 remotion 式」留下的后一半:量当场算一帧 Lottie 要多久、评估浏览器节点要不要放开产 Lottie 的流、补测前一半(`docs/reports/AGENT-rr-lottie.md`,已合入 `5ad05da7`)没测到的在线页面。「remotion 式」在代码里就是声明 `frameMode: "direct"`。

日期 2026-10-14。机器:PC,Intel i7-14700KF,20 个逻辑核;Chrome 152 无头;lottie-web 5.13.0。端口 27260～27299。

(进行中,下面逐块补。)
