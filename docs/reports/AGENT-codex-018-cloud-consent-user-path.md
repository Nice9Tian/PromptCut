# 018 Cloud Agent 首次告知：实施记录

- 工作区：`018-cloud-assets-central-glue`；本叶 `codex/018-cloud-consent-user-path` 从 `main` 的 `dbda16c3` 开始。旧 `codex/018-run-assets-current` 的 `8c1078f6` 保留且起点前工作树干净。
- 范围：只实现账号 v2 的告知、真实账号端 GET/POST 与浏览器/桌面桥接及前端阻断；不会把旧 CloudIdentity 委托打开，也不会声明 Agent runner 已可用。
- 用户已定文案：`托管方能读到你和云端 Agent 的对话记录，包括私有对话`；操作仅 `我知道了`、`拒绝`。拒绝保留草稿，下一次使用重新提示。
- 入口设计：账号客户端精确查询/提交版本 1 的同意；当前账号和登录绑定在请求前后重核。account v2 项目连接只注入 consent source，换项目或注销撤掉。云端 UI 未取得账号服务同意前不建立会话、读历史、附文件、排队或发送；提交后端仍由真正 Agent 服务复核。
- 验证和未完成项随实施追加。生产模型、实例、节点部署、直接服务端绕过检查由其它模块负责。
