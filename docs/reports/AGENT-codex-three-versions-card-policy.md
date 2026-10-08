# 用户卡与图卡出口策略撤销工作报告

2026-10-08，分支 `codex/three-versions-card-policy`，起点 `461206a3`，工作区 `.worktrees/three-versions-card-policy`。

## 任务与边界

按用户已定P1/P3，全部在线浏览器执行用户卡/图卡，外链图片、字体、样式、脚本照常加载，三个版本不做卡片出口护栏。撤销在线与Linux云worker链中Connection-Allowlist、出口代理/脚本拦截和相关能力拒绝；保留stage/editor分源、页面/API与管理口鉴权、项目素材授权、凭证隔离、运行开关、真实语法/GPU回退。Agent web/collect SSRF和audio-js断网sandbox不在任务范围。

只修改主会话指定独占文件；若需其它文件先回报主会话扩边界。端口5900～5909，不操作节点，不碰用户进程或数据，不装依赖/junction、不merge/push/main/release。测试进程用父仓库绝对silent preload、windowsHide、TMP日志；Python只指定cuda_Vit并禁止写pyc。

## 状态与验证计划

实现与本包定向验收完成；最后一次全量full-3已因非本包fixture生命周期挂起中止，集成全量闸门由主会话派Astra诊断后复验。已读本工作区AGENTS入口、developer_guide、constraints、suggested_agent_behavior，并沿用已读verification/multi_agent/git_and_release/solution_table规则。已读真实调用链并按完整块提交；下列按源码阶段记录单测、外链fixture、握手/权限反向、类型与全量结果。仅已安装浏览器实测，不冒称Firefox/Safari通过。particles覆盖相关参数分支桌面改前后逐帧，在线外链恢复可见；其它渲染附加项按实际范围挑，不拿没有NASA的演示当充分验证。

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
- 不改全局环境、不改产品端口池；该首次计划已由主会话授权5930～5939落实，见后两节；只用探针进程级preload收束Node listen(0)，Chrome pipe消除调试TCP监听。
- 真实Linux节点未运行或部署；当前是Windows真实worker调用链，cgroup明确not-linux，不冒称OS隔离生产验收通过。

## hosted第二轮、CSS导入与经典云页结构补记

- 主会话已核5930～5939零监听并仅授权本探针附加段。TMP/promptcut-card-policy-port-helper.mjs（SHA256 97F56D6BBB3FE52D7C6D9F20702A420B13CCCA3B20AC448E40334F527787A15B）通过仅测试树的NODE_OPTIONS将net.Server.listen(0)收进该段；明确端口不改，独占lease与真实bind避冲突，Puppeteer launch用pipe:true、不留调试TCP。helper smoke监听5930、Chrome152且wsEndpoint空。没有改产品/全局配置。
- 第二轮真实预渲用5930/5931，固定服务仍5900～5909。完整执行至结束，41项过、3项失败（甲A1、乙A1、look L1）；日志TMP/promptcut-card-policy-hosted-2.log，pc-render-iso-i67SMt保留。甲3细项done1/failed2，乙2项failed2。日志明确warm-up 0帧后因Document http://127.0.0.1:5901/ 30秒未结束失败重试；look同一Document等待失败。不能说通过。自然shutdown清理后5900～5939本任务监听为空。
- 原夹具frameLoad导航其它服务完整舞台根页，移掉iframe后仍留下网络等待记录；这是观察到的挂起位置，未把CDP具体内部成因当已证。主会话批准仅loopback frame改不存在只读API路径，仍实际跨源导航/SOP与API认证负向，collector frame正向按实际结构策略标记，不恢复出口代理。
- 又核到经典云预渲页不走online stageGuard，原vite-gate只有出口头没有结构CSP。主会话批准经典HTML导航补frame-src/object-src/base-uri none，脚本/CSS/图片/字体/connect不加限制；结构闸与敏感API/管理认证分开断言。此为产品结构修正，区别于夹具导航修正与首次端口偏差。
- 主会话扩独占source-gate.mjs及vite-plugin-cards.ts仅cardOverridesLoader.load接线。源码预检原拒所有远端@import；已装Vite postcss-import isProcessableURL跳过远端；Tailwind4.3.3 compile实证http(s)字符串/url保留且loadStylesheet 0次，裸字符串//会调用本地resolver而url(//)不会。仅将已通过预检、非raw的协议相对远端import裸字符串等价转url，保持地址/条件/源文件与raw不变；http(s)原样，保留私有文件/plugin/config/source/reference拒绝。
- 新CSS单测首次10/10；加注释内同地址回归后必要第二次10/10。TMP/promptcut-card-policy-css-unit-1/2.log；TMP/css-toolchain只读实证脚本。新浏览器fixture将经真实Vite/Tailwind编译六种字符串/url、layer/supports/media与协议相对导入，再确认真实浏览器取回样式；还待新提交复验，不能套用此前16/16。
- 用户main新增三阶段调度文档不扩大本包；本证据不构成并发容量验证。

## 在线多文件CSS导入实证与完整修正

- canonical第三次18/18：真实Vite/Tailwind编译六种远端import后在Chrome152取回，四外链正向与经典云页frame/object/base结构负向通过；TMP/promptcut-card-policy-browser-3.log、pc-card-policy-css-final/result.json和external-resources.png。
- 进一步只读浏览器试验实际调用createCardLoader：第一试误用模块code字段（真实字段为js），回无卡片定义，保留TMP/promptcut-card-policy-css-loader-check-1.log；第二试按js字段卡定义成功，普通规则CSS后拼@import时远端属性为空，只有导入CSS时loaded（-2.log）。不是用户待决，而是已授权外链样式实现补漏。
- 主会话批准独占loader.ts，增加可选onStyles逐文件回调，旧onStyle串回调兼容。stageRuntime每份CSS各自style，Tailwind最后，换代插在该卡旧样式位置而非改变与其它卡的级联顺序；失败/卸载/clear撤整组。无正则挪import、无授权/网络协议改动、壳最低版本不变。
- cardRuntime针对此完整块17/17（含新数组/兼容/同代/失败/卸载/clear）；TMP/promptcut-card-policy-css-loader-unit-1.log。canonical补实际createCardLoader多CSS后续远端导入与真实DOM标签清理，待本提交后跑。
- type-3零错；full-3还未结束，唯一剩余codex-auth-state文件测试树与旧fake CLI可能保持stdout句柄，已报主会话且不改非独占auth文件、不把缺总结叫通过。原始TMP日志/events保留；最终完整块后仍要type/full必要复验。

## 最终固定源码验收与交回

- 完整产品源码5fd666a2；10d5f45b只将exec/graph/security三个既有probe改pipe，消除随机Chrome调试TCP。第四轮前后真实HEAD均10d5f45b571e309340604801fecebabc6fffc119，frameCode均eabe33dcd994a1af084de08fd46d56306518c45639dc900d7b21e4a10fbd3008，git均空。TMP/promptcut-card-policy-hosted-4-before/after.json留完整身份。
- 第三轮运行中我继续修改onStyles受监视源码，触发乙任务code-changed，0帧被作废；这是本人验证安排失误。完整自然跑完48过/1失败（乙A1），甲两细项60/60、五种外链与look成功仍不能替代完整全链通过。保留TMP/promptcut-card-policy-hosted-3.log及pc-render-iso-7NyN8Q，后续第四轮保持全部src/server固定，未盲复跑。
- 第四轮完整49/49、退出0：甲3细项done3/failed0，乙2细项done2/failed0；项目切换实际终止/清空；真实隔离worker image/font/style/script/嵌套import都loaded；敏感API/管理认证/私文件/其它项目源码与内容读取负向通过；look768×432真实回图。TMP/promptcut-card-policy-hosted-4.log与pc-render-iso-rOGCsg保留，终止后5900～5939监听空。真实经典页结构CSP执行，卡片网络出口限制不适用。
- hosted的旧素材按hash跨项目能力仍在residual(1)如实记录；本包未改asset，不将49/49等同新增项目素材全面隔离已实现/验收。由主会话素材包收紧后再按新权限验；原授权边界没有放宽。
- 最新canonical20/20：六种CSS经过Vite/Tailwind真实编译并被Chrome加载，真实createCardLoader多CSS后续import、换代失败/卸载/clear DOM清理均通过。TMP/promptcut-card-policy-browser-4.log、pc-card-policy-css-loader-final/result.json和external-resources.png（已查看：中文正常、外链深底样式与绿图可见）。TT缺省模拟不支持，Firefox/Safari没有实机测试。
- 新完整块online构建第三次成功，最新type-4 --force零错；exec第二次66/66，hot源码更新1609ms；graph第二次18/18。TMP/promptcut-card-policy-online-build-3/type-4/exec-2/graph-2.log；可看截图pc-card-policy-exec-final、pc-card-policy-graph-final。旧security最终117/117证明此前相同闸/HTML结构机制，新onStyles追加由canonical/exec/graph覆盖；未假称旧全量覆盖最新源码。
- full-3在codex-auth-state测试文件长等待，缺最终总结；主会话批准只killTree本人54836→36980→39772→44292树，退出1记中止/未完成。精确CIM/命令证据在TMP/promptcut-card-policy-full-3-owned-processes.json，旧fake CLI在case-eepgiZ；终段case-PsZsKk为split+descendant。Get-Process未提供句柄读数，不能断言具体stdout句柄根因。主会话另派Astra生命周期包；没有越权改auth，没有盲跑full至绿。full-1/2的4927总、4926过、0失败、1skip只属于之前源码，既有skip名称为“集成:/api/cards/layout 对真实项目返回整数框”。最终共同候选全量仍是整合闸门。
- 已只读986ebec6的render-scheduling-supplement全文及account/cloud/sound任务与brief新增映射；本包不实现提前回收/补渲A-B/删除权限待决，不把真实用户卡单项目/轮换/看画面探针冒称RS18/19/20容量、50对话或五分钟目标已验收。
- 最后仅清理旧probe表述和本报告，不再改变产品源码；无merge/push/version/release/节点/依赖/用户数据操作。只涉及主会话授予的39个文件；diff --check通过。交回后root审diff/截图、与账号/asset包整合、Astra修复后共同候选全量和Linux真节点验收仍需主会话完成。

## 收回后的探针环境保护补丁

- 根在卡片＋认证共同候选全量得到4933项、4931通过、1失败、1既有跳过，88041.425ms；唯一失败是新card-policy-probe未以no-user-dirs为首个import且未显式禁止port.json。该共同候选首次失败由根保留，不能抹掉或称通过。
- 根明确授权暂停素材包，回此旧分支只补该探针首个import `../lib/no-user-dirs.mjs`；它设置进程/子进程用户目录与端口文件保护。产品src/server源码、旧断言与固定第四轮身份不变，不改共同候选分支、不自行再跑全量。
- 对应 `node --test server/test/port-file.test.mjs server/test/no-user-dirs.test.mjs` 11/11、0失败/跳过，199.5515ms；TMP/promptcut-card-policy-port-guard-1.log。diff --check后独立中文提交，交回根再冻结。
