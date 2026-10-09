# 018 改密后会话保留用户路径报告

## 开工范围（2026-10-09）

- 基线：分支 `codex/018-password-user-route`，提交 `ff51441c`；工作区初始干净。
- 验收目标：用隔离的真实 VisuHive provider 与网站页面建立三个登录会话和一个在线编辑器登录；在首个网站会话执行真实改密并选择退出其它设备后，验证发起网站会话保留、第二网站旧会话失效、编辑器退出并清除已读正文、旧密码不能登录且新密码可登录。全程不得输出密码、cookie、令牌、签名密钥或完整敏感响应。
- 先核对账号任务书的已定语义、VisuHive 真实账号与密码排序接口、PromptCut 网站与在线编辑器登录桥接，再搭隔离 fixture 和真实 Puppeteer 页面探针。fixture 不启用 Agent 执行器、不制造活动任务、不伪造 authority、fence、ACK 或 epoch。
- 文件租约仅为：`server/test/fixtures/account-password-user-path.mjs`、`scripts/probes/account-password-user-path-probe.mjs`、专属 `server/test/account-password-user-path*.test.mjs` 与本报告。PC 产品或 VisuHive 只读源若显出缺口，先提供证据与最小修复路径，等待 root 扩大租约后再动。
- 邮箱重设只有在可用的真实安全凭据/短信路径可无费用、安全地实测时才纳入。若凭据签发要求外部服务或不具备可用凭据，将明确标记未验证，不绕过重设凭据。桌面登录桥接如需跨租约产品改动，也单独界定阶段。
- 验证采用专属 `npm test -- <target>` wrapper、必要类型检查、探针语法与 diff 检查，以及固定源码后的隔离真实浏览器路径。端口仅 6680–6689；不得启动 full、使用生产账号/短信/收费服务、碰其他占用端口/节点、安装依赖、清理他人文件、合并或推送。

## 进度

- 已核对入口 `developer_guide.md`、`suggested_agent_behavior.md` 与 `constraints.md`；产品语义以账号任务书与 VisuHive 真实 provider 为准。
- 已用独立隔离 fixture 调用真实 VisuHive provider 的注册、登录、编辑器子会话、改密、事件选择、邮箱绑定、重设码签发与重设确认接口。邮件回调只在进程内接住 provider 随机签发的验证码；没有使用真实邮箱投递或生产账号。
- 专属 `npm test -- server/test/account-password-user-path.test.mjs` 在显式指向只读 VisuHive provider、密码排序模块和本地 authority 模块后通过：1/1；验证发起网站会话保留、另两网站会话及编辑器 bearer 失效、旧密码拒绝、新密码可登录；重设也验证旧会话撤销与新密码登录。provider 对改密和重设退出均返回 `logoutState=revoking`，这是服务确认仍待处理的真实状态；未声称退出已完成、未验证互联网邮件投递。
- 测试首轮在未显式提供外部 provider 路径时红于 `real v2 account provider root is required`，这属于环境入口缺失；加进程级路径后同一目标通过。探针和 fixture 另已通过 `node --check` 与 `git diff --check`。
- 固定在线构建 `npm run build -- --mode online --outDir <TEMP>` 通过。产物 `index.html` 引用 `/editor/assets/index-C3woiw05.js` 等在线资源；`stage.html` 使用同一编辑器入口资源，探针 runtime config 为两个独立 origin `s1.pc.localhost:6688`、`s2.pc.localhost:6689`。普通构建没有被当作在线资源验收。
- 独立 `--site-form-only` 浏览器 smoke（不算 Editor 完整路径通过）记录到：VisuHive `/assets/site.css` 为 `200 text/css`，样式表可读 49 条规则；表单有效、三项密码值存在且新密码重复匹配、按钮已启用，滚入视口后也确认为 visible/unobscured。但实际点击后 35 秒内未观察到 `/api/account/password` 请求，故站点表单仍为失败，截图和安全结果在 `%TEMP%\pc-password-user-path-site-form-smoke-9`。同一轮在线 Editor 的 JS chunks 为 200，但 `/editor/assets/index-C-Dl6M5S.css` 是无 HTTP response 的 failed request；document stylesheet 未加载且规则不可读，截图表现为无样式原生控件。这说明此前 toast 无法进入可视范围的轮次受在线 CSS 加载失败影响；不再将其归为产品权限结果。
- 真实浏览器尚未完成改密闭环。最初 403 轮 consent GET/POST 成功，但探针在 consent dialog/Agent 开启间停滞；脱敏业务码证实 `/agent/v1/info`、对话列表和事件请求返回 `403 disabled`。后来一轮真实路径完成：真实 project-agent admin POST 为 200，项目 ID只作相等比较并匹配当前项目；read-control 为 connected、实例已登记、`executorMounted=false`；Agent info/history 后续回到 200，网站 `/api/account/me` 为 200，实际发送消息 POST 为 202，界面显示等待执行服务。没有运行 Agent executor。
- 上述成功轮次之后进入改密 UI，但没有观察到 `/api/account/password` 请求，故没有把它记作改密通过。后续两轮复验未发 Agent admin 请求：探针在分享 toast 的真实关闭步骤卡住；Dom 计数显示 consent 对话框不存在、Agent 开启按钮和关闭状态可见、权限仍在读取。toast 截图/安全结果与之前的成功路径均保存在 `%TEMP%\pc-password-user-path-once-*`；每轮 browser、stage servers、fixture、asset 子进程均关闭，6680–6689 全部空闲。未用 API 绕过实际按钮。
- 桌面原生登录桥接不在本阶段范围。改密后真实在线编辑器正文自然清空、服务器读取关闭的浏览器断言尚未到达；必须等真实界面闭环再判定，不能由仅 provider session 撤销结果推断。
