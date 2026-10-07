# 用户卡与图卡出口策略撤销工作报告

2026-10-08，分支 `codex/three-versions-card-policy`，起点 `461206a3`，工作区 `.worktrees/three-versions-card-policy`。

## 任务与边界

按用户已定P1/P3，全部在线浏览器执行用户卡/图卡，外链图片、字体、样式、脚本照常加载，三个版本不做卡片出口护栏。撤销在线与Linux云worker链中Connection-Allowlist、出口代理/脚本拦截和相关能力拒绝；保留stage/editor分源、页面/API与管理口鉴权、项目素材授权、凭证隔离、运行开关、真实语法/GPU回退。Agent web/collect SSRF和audio-js断网sandbox不在任务范围。

只修改主会话指定独占文件；若需其它文件先回报主会话扩边界。端口5900～5909，不操作节点，不碰用户进程或数据，不装依赖/junction、不merge/push/main/release。测试进程用父仓库绝对silent preload、windowsHide、TMP日志；Python只指定cuda_Vit并禁止写pyc。

## 状态与验证计划

开工报告；已读本工作区AGENTS入口、developer_guide、constraints、suggested_agent_behavior，并沿用已读verification/multi_agent/git_and_release/solution_table规则。接下来读真实调用链，按完整小块提交；先针对性测试、外链fixture与握手/权限反向探针，再最终类型和全量npm各一次。仅已安装浏览器实测，不冒称Firefox/Safari通过。particles覆盖相关参数分支桌面改前后逐帧，在线外链恢复可见；其它渲染附加项按实际范围挑，不拿没有NASA的演示当充分验证。

尚未修改产品代码或启动服务。

## 完整块：执行策略与真实浏览器边界

- 所有执行闸不再依赖 Connection-Allowlist、Trusted Types 或移除 WebRTC；stage CSP 允许 HTTP/HTTPS 图片、字体、样式、脚本及连接，保留 frame/object/base/form 与 editor frame-src 边界。
- Linux worker 共用的 vite-gate 移除出口代理、出口响应头及其 Chrome 强制代理/UDP 参数；页面/API、管理口口令、素材转发通行记号与 WebSocket拒绝不变。
- NASA背景在 particles.forceOurs 保留原 background.image URL，桌面路径同值；未打包徽标。ocr2 使新策略缓存/成本身份失效，旧 ocr1 测试包仍可读，desktop最低壳版本未改。
- 第一轮49项48过1失败：OCS-S-04旧egress=script断言；第二轮71项70过1失败：自动替换没有命中该deepEqual；精确修正后第三轮71/71过。三轮日志分别 promptcut-card-policy-targeted-1/2/3.log（系统TMP）。
- card-policy-probe 第一次真实 Chrome 14/14过：四资源实际载入，RTC构造器保留；base-uri响应头/header与meta识别实际事件，meta-only及同源拒绝；编辑器DOM/localStorage SecurityError；HttpOnly空、项目A200/项目B401；真实hosted页面API403、无管理口令403、正确口令200。字体读取已有公开系统字体。
- 浏览器截图在TMP/pc-card-policy-WtTELK/external-resources.png已查看：深底外链样式与绿图像可见，但中文编码缺charset，夹具已补UTF-8，下轮截图复核。Firefox/Safari未实测。实际stage RPC与全产品probe待后续块。
