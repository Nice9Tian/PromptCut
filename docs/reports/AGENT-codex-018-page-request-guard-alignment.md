# AGENT：CAU-REV-06 接线守门适配

本次是独立的小修，不属于 `018-password-user-route` 改密用户路径，不触碰其工作文件。

## 范围与原因

根工作区全量首轮发现 `src/ai/cloud/page-requests.test.mjs` 的 CAU-REV-06 用完整字符串正则锁定旧版 `createCloudSession({ api, store, pageId, onPageRequest })` 接线。产品已显式传入 `accountMode: cloud.accountMode`，运行路径未失效；守门测试只因该参数而报错。

本修只更新这项源码守门断言和本报告。守门仍核对 `runPageRequest` 只有事件流接线处可调用、页面不暴露全局执行入口，并保留接口层委托票据及不带 Cookie 的检查；新增检查确认会话接线显式传递 `cloud.accountMode`。

## 验证

待执行目标测试：`npm test -- src/ai/cloud/page-requests.test.mjs`，经仓库测试包装器运行。此处不运行全量测试，也不修改产品代码。
