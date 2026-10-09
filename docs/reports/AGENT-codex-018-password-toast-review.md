# 改密探针分享提示只读审查

范围：只读 Luna 固定 f9b6a5e116f431a3bf3e27187e22c11cb99290b6 与 main 已过 controls 探针，不编辑其工作区、不运行浏览器/服务/full/节点。证据为系统TMP的 `pc-password-user-path-once-controls-toast-6`、`pc-password-user-path-once-toastfix-5`、`pc-password-user-path-once-consentfix-3` 脱敏结果与截图。密码、OTP、令牌值不读取/输出。

已确认：第6轮20项前置过，但未完成；consent已POST200且对话框计数为0，未发admin POST。其failure-4图整个Editor缺样式：默认button/纵向流式菜单、分享toast落到视口下方；第3轮实际admin200/message202截图则是完整正常布局。两轮Luna确认同一dist，index的CSS路径存在、440650字节。当前证据不支持“consent overlay未消失”或“server拒绝admin”。

f9的close helper与main controls相同：**先**等待关闭按钮中心elementFromPoint命中，**再**click；无样式长页面中按钮中心在视口外时elementFromPoint为null，click尚未执行，因此admin前序短路。main controls的完整顺序为真实project打开→consent真实确认→关闭分享toast→三页面各打开完→创建者启用。不能增加等待、force click或API启用来掩盖未样式页面。

静态排除：f9 MIME有text/css、/editor/assets映射DIST正确，fixture publicHandler通过Promise处理；CSS文件存在不等于浏览器实际成功加载/应用。缺失的是该次stylesheet请求status/失败分类、styleSheets/cssRules可读计数，以及button rect与viewport/命中元素白名单。最小建议在现探针加这些非秘密诊断与样式就绪前置，再由owner定位资源失败；目前不猜CSS请求失败的唯一原因。

Root另发现独立site-form-only也未发password请求。已向Luna索取其安全截图/字段有效性/事件/异常栈；这与Editor缺CSS应分别归因，不将一次无admin短路当改密功能失败。等待该轮证据后补本页明确结论。
