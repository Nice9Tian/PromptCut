# 改密探针分享提示只读审查

范围：只读 Luna 固定 f9b6a5e116f431a3bf3e27187e22c11cb99290b6 与 main 已过 controls 探针，不编辑其工作区、不运行浏览器/服务/full/节点。证据为系统TMP的 `pc-password-user-path-once-controls-toast-6`、`pc-password-user-path-once-toastfix-5`、`pc-password-user-path-once-consentfix-3` 脱敏结果与截图。密码、OTP、令牌值不读取/输出。

已确认：第6轮20项前置过，但未完成；consent已POST200且对话框计数为0，未发admin POST。其failure-4图整个Editor缺样式：默认button/纵向流式菜单、分享toast落到视口下方；第3轮实际admin200/message202截图则是完整正常布局。两轮Luna确认同一dist，index的CSS路径存在、440650字节。当前证据不支持“consent overlay未消失”或“server拒绝admin”。

f9的close helper与main controls相同：**先**等待关闭按钮中心elementFromPoint命中，**再**click；无样式长页面中按钮中心在视口外时elementFromPoint为null，click尚未执行，因此admin前序短路。main controls的完整顺序为真实project打开→consent真实确认→关闭分享toast→三页面各打开完→创建者启用。不能增加等待、force click或API启用来掩盖未样式页面。

静态排除：f9 MIME有text/css、/editor/assets映射DIST正确，fixture publicHandler通过Promise处理；CSS文件存在不等于浏览器实际成功加载/应用。缺失的是该次stylesheet请求status/失败分类、styleSheets/cssRules可读计数，以及button rect与viewport/命中元素白名单。最小建议在现探针加这些非秘密诊断与样式就绪前置，再由owner定位资源失败；目前不猜CSS请求失败的唯一原因。

补充独立 site-form-smoke-9 的真实证据：Editor CSS failed-request、无HTTP response、规则0且不可读，确认资源未加载；仍缺 request.failure().errorText，不能猜TLS或MIME。网站CSS200/49规则与JS200正常，字段valid/match/submitEnabled及按钮visible/unobscured全true，却无password POST。failure-1图未见表单catch固定错误；safeShot会清输入，不能据空字段推原表单无效。静态VH account.js:334→336→143→28在POST前调用crypto.randomUUID，但尚无证据证明此处抛错。建议仅加click/submit/invalid计数、isTrusted/submitter/defaultPrevented、提示分类与isSecureContext/randomUUID能力布尔；如submit后generic错误成立，再收CDP caught异常类型与源码行（禁locals/值），不延长等待或API绕过。Root已交Luna实施此窄诊断。本咨询未启动任何服务/浏览器/测试，产品全只读；明确未定位网站提交无POST的唯一根因。
