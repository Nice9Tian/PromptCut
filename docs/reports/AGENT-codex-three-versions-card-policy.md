# 用户卡与图卡出口策略撤销工作报告

2026-10-08，分支 `codex/three-versions-card-policy`，起点 `461206a3`，工作区 `.worktrees/three-versions-card-policy`。

## 任务与边界

按用户已定P1/P3，全部在线浏览器执行用户卡/图卡，外链图片、字体、样式、脚本照常加载，三个版本不做卡片出口护栏。撤销在线与Linux云worker链中Connection-Allowlist、出口代理/脚本拦截和相关能力拒绝；保留stage/editor分源、页面/API与管理口鉴权、项目素材授权、凭证隔离、运行开关、真实语法/GPU回退。Agent web/collect SSRF和audio-js断网sandbox不在任务范围。

只修改主会话指定独占文件；若需其它文件先回报主会话扩边界。端口5900～5909，不操作节点，不碰用户进程或数据，不装依赖/junction、不merge/push/main/release。测试进程用父仓库绝对silent preload、windowsHide、TMP日志；Python只指定cuda_Vit并禁止写pyc。

## 状态与验证计划

开工报告；已读本工作区AGENTS入口、developer_guide、constraints、suggested_agent_behavior，并沿用已读verification/multi_agent/git_and_release/solution_table规则。接下来读真实调用链，按完整小块提交；先针对性测试、外链fixture与握手/权限反向探针，再最终类型和全量npm各一次。仅已安装浏览器实测，不冒称Firefox/Safari通过。particles覆盖相关参数分支桌面改前后逐帧，在线外链恢复可见；其它渲染附加项按实际范围挑，不拿没有NASA的演示当充分验证。

尚未修改产品代码或启动服务。
