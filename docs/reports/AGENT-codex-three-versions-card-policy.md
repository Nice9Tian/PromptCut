# 用户卡与图卡出口策略撤销工作报告

2026-10-08，分支 `codex/three-versions-card-policy`，起点 `461206a3`，工作区 `.worktrees/three-versions-card-policy`。

## 任务与边界

按用户已定P1/P3，全部在线浏览器执行用户卡/图卡，外链图片、字体、样式、脚本照常加载，三个版本不做卡片出口护栏。撤销在线与Linux云worker链中Connection-Allowlist、出口代理/脚本拦截和相关能力拒绝；保留stage/editor分源、页面/API与管理口鉴权、项目素材授权、凭证隔离、运行开关、真实语法/GPU回退。Agent web/collect SSRF和audio-js断网sandbox不在任务范围。

只修改主会话指定独占文件；若需其它文件先回报主会话扩边界。端口5900～5909，不操作节点，不碰用户进程或数据，不装依赖/junction、不merge/push/main/release。测试进程用父仓库绝对silent preload、windowsHide、TMP日志；Python只指定cuda_Vit并禁止写pyc。

## 状态与验证计划

实现与范围内浏览器验证已完成，hosted复验进行中；已读本工作区AGENTS入口、developer_guide、constraints、suggested_agent_behavior，并沿用已读verification/multi_agent/git_and_release/solution_table规则。接下来读真实调用链，按完整小块提交；先针对性测试、外链fixture与握手/权限反向探针，再最终类型和全量npm各一次。仅已安装浏览器实测，不冒称Firefox/Safari通过。particles覆盖相关参数分支桌面改前后逐帧，在线外链恢复可见；其它渲染附加项按实际范围挑，不拿没有NASA的演示当充分验证。

产品代码和探针已经修改；服务仅本任务临时回环夹具，关闭后核所有owned监听。

## 完整块：执行策略与真实浏览器边界

- 所有执行闸不再依赖 Connection-Allowlist、Trusted Types 或移除 WebRTC；stage CSP 允许 HTTP/HTTPS 图片、字体、样式、脚本及连接，保留 frame/object/base/form 与 editor frame-src 边界。
- Linux worker 共用的 vite-gate 移除出口代理、出口响应头及其 Chrome 强制代理/UDP 参数；页面/API、管理口口令、素材转发通行记号与 WebSocket拒绝不变。
- NASA背景在 particles.forceOurs 保留原 background.image URL，桌面路径同值；未打包徽标。ocr2 使新策略缓存/成本身份失效，旧 ocr1 测试包仍可读，desktop最低壳版本未改。
- 第一轮49项48过1失败：OCS-S-04旧egress=script断言；第二轮71项70过1失败：自动替换没有命中该deepEqual；精确修正后第三轮71/71过。三轮日志分别 promptcut-card-policy-targeted-1/2/3.log（系统TMP）。
- card-policy-probe 第一次真实 Chrome 14/14过：四资源实际载入，RTC构造器保留；base-uri响应头/header与meta识别实际事件，meta-only及同源拒绝；编辑器DOM/localStorage SecurityError；HttpOnly空、项目A200/项目B401；真实hosted页面API403、无管理口令403、正确口令200。字体读取已有公开系统字体。
- 浏览器截图在TMP/pc-card-policy-WtTELK/external-resources.png已查看：深底外链样式与绿图像可见，但中文编码缺charset，夹具已补UTF-8，下轮截图复核。Firefox/Safari未实测。实际stage RPC与全产品probe待后续块。

## 第二完整块：无TT结构保护和旧探针对齐

- 移除TT后增加HTML结构钩子：Element/ShadowRoot innerHTML、outerHTML、insertAdjacentHTML、setHTML/setHTMLUnsafe、document.write/writeln、Range.createContextualFragment、DOMParser.parseFromString。只拒frame/object/embed等结构与实体展开；普通HTML、style/link/script/font/img与WebRTC保留。
- 这些JS钩子只是结构防御和诊断，不声称是对任意恶意代码的安全边界。编辑器存储、账号与票据边界由真实跨源SOP、HttpOnly/主机与路径cookie、票据交接来源核验、服务端管理API认证、项目授权核验承担。CSP继续frame-src/object-src/base-uri/form-action；外链网络可达并不授予管理操作。
- 卡片audio()的blob声音线程继承新舞台策略、外链允许；audio-js工具专用断网sandbox、Agent web/collect SSRF源码完全未改。
- 最新card-policy-probe 16/16；Chrome152，TT缺省模拟为undefined、无Allowlist。四资源真实加载，正常innerHTML样式/外链图成功；五个解析入口拒框架。最终截图已看，中文正常。
- security第一轮80过7失败：2旧声音线程断网断言，4HTML解析短暂realm断言，1B summary未初始化；修代码/断言后第二轮116过1失败（C在两台自检完成前读取）；等待两台完成后C单组5/5，最终全组117/117，51个假凭证比较无泄漏。每次完整记录于TMP/promptcut-card-policy-security-1/2/C-3/4.log。
- exec功能66/66：真实content.put/转译/模块加载/stage RPC握手/声音/GPU/语法回退/源码更新/ocr2成本身份；graph18/18：图卡画面、素材解码失败回退和GPU反例。截图分别TMP/pc-card-policy-exec与pc-card-policy-graph。
- c10-browser-probe仅策略头注释修改；本包真实执行已由上述完整exec/graph/security覆盖，不扩开C10全流程，遵主会话最后“继续hosted/type/full，无其他扩测”。

## particles精确画面记录（全部7次尝试）

|尝试|日志（均系统TMP）|真实结果与改动依据|
|---|---|---|
|1|promptcut-card-policy-particles-1.log|ready等待30秒超时；当时夹具未记录pageerror，没有充分根因证据。|
|2|promptcut-card-policy-particles-2.log|增错误监听后实证裸react模块无法解析，HTML未经Vite转换；与第1次同类现象，但第1次根因只作推测。|
|3|promptcut-card-policy-particles-3.log|加transformIndexHtml后虚拟old/current路径404；明确不是渲染像素失败。|
|4|promptcut-card-policy-particles-4.log|补URL别名仍404；实证Vite规范化Windows路径为正斜线，而load比较仍反斜线；统一路径。|
|5|promptcut-card-policy-particles-5.log|两份真实模块和canvas已挂载，ElementHandle.screenshot的evaluate等待未返回。只关闭自建profile-nMOkEU Chrome，回传Target closed堆栈；挂起细节未证明为产品bug。|
|6|promptcut-card-policy-particles-6.log|改CDP裁剪但双页面路径仍卡在pixels的capture/detach链；独立CDP连接可frame(0)、work=[]并取320×180图。只关闭自建profile-tODisv Chrome，回传Session detached堆栈。不能仅凭这次断定Chrome根因。|
|7|promptcut-card-policy-particles-7.log|改旧/新页面串行取12帧、CDP固定320×180裁剪、mount阶段15秒防卡死和BEGIN/MOUNTED/FRAMES记录，22断言全过。观察支持串行路径有效，不以它倒推5/6挂起机制。|

- 第5/6关闭安全依据：从精确独占probe CLI Node的ParentProcessId链找到Chrome，再读其仅本任务临时profile的DevToolsActivePort，puppeteer.connect只连该endpoint执行browser.close；不读用户profile、不停其它浏览器/服务。后来第7独立新profile验证，无复用前次状态。
- 第7结果：TMP/pc-policy-particles-pXT6dZ/result.json；10分支（简单参数/links与seed/零和负下限/内联data图/无image/URL配置/NASA原URL/协议相对URL/本源图片）×12帧=120帧桌面改前后逐像素相同，各分支逐帧与直接跳帧一致。nasa-online.png/nasa-desktop.png已查看。
- 在线NASA仅证明保留原URL并发起该URL请求，网络响应用公开纯色PNG截获以验证CSS背景可见；没有验证NASA远端当前可达、没有下载徽标、没有将徽标入包。

## 类型与全量基线

- type-1 --force零错误；full-1共4927项，4926通过、0失败、1既有skip，74185ms。
- 加HTML结构实现后必要复验：type-2 --force零错误；full-2同4927/4926/0/1，119471ms。没有仅为刷绿无改动复跑。
- 日志TMP/promptcut-card-policy-type-1/2.log与promptcut-card-policy-full-1/2.log。online构建两次均成功；第二次为结构实现修改后的构建，既有动态import布局警告照录。

## hosted首次范围偏差与修正待验

- 首次固定5900～5909：resident编辑器5900与舞台5901/5902，isolated编辑器5903与舞台5904/5905，管理5906，collector5907，doc5908，asset5909。
- 既有server/vite-plugin-prerender.ts freePort调用server/safe-port.mjs listen(0)，无现成进程级PORT_RANGE；另外resident prerender34456监听5103、isolated prerender49644监听1067。Chrome remote-debugging-port=0又被OS分到5744（PID45016），实际偏离授权段；没有向其它任务服务发请求。
- 归属严格核验：精确hosted probe CLI Node38576 → supervisor50168 → isolated47516 → editor42040 → prerender49644；resident45972 → editor31292 → prerender34456；Chrome45016是49644子孙。已报主会话并仅killTree38576整树，所有5900～5909/1067/5103/5744 owned监听检查为空。首次按范围问题中止，不作通过；TMP/promptcut-card-policy-hosted-1.log，临时证据目录pc-render-iso-OfGcao保留。
- 不改全局环境、不改产品端口池；等待主会话分配附加空段，拟仅探针进程级preload收束Node listen(0)，Chrome使用pipe消除调试TCP监听。
- 真实Linux节点未运行或部署；当前是Windows真实worker调用链，cgroup明确not-linux，不冒称OS隔离生产验收通过。
