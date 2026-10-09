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
- 开工报告先独立提交；接口与页面复核、隔离 fixture、真实路径结果和任何无法验证原因将在后续提交中补充。
