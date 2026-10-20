# AGENT 报告：stream-toggle-feedback

分支 `claude/stream-toggle-feedback`（起点 main `82ab4933`）。

任务：账号云端项目的「项目设置」里，「生成轨道流」开关在创建者不在 `render_streams` 权限分组时没有置灰、没有提示；保存被 403 拒绝后界面静默。查根因、修好、补测试、验证。

## 进度

- [ ] 查清 403 原因与 `streamsAllowed` 为什么没生效
- [ ] 修复
- [ ] 测试
- [ ] 验证（tsc、npm test、浏览器实测）
- [ ] 部署清单

## 一、根因（证据）

生产节点只读诊断（2026-10-21）：

- nginx：`[20/Oct/2026:17:22:27 +0000] "POST /hosted/shared/account/admin" 403 98`；随后的 `/hosted/shared/account/session` 全是 200。
- 账号服务（`promptcut-account-v2`，VisuHive `vh-0e64fbe`）已有 `/internal/v2/permissions`；它的环境文件 `/etc/promptcut-account-v2/promptcut-account-v2.env` 与 `/etc/visuhive/smtp.env` 里没有非空的 `ACCOUNT_ADMINS`。
- 账号库只读查询（`runuser -u visuhive-account`，`node:sqlite` 只读打开）：`accounts` 只有 `9tian`（`acc_f17cf0ab2b14547df056b54f`），`permission_groups` 为空表。所以 9tian 既不在 `render_streams` 分组、也不是管理员。
- 文档服务（`/opt/promptcut-v2/releases/35f7b2ab/pc`）的 `server/account/authority.mjs` 第 428 行在 `set-hosted-option streams=true` 时查分组，不在组内 `reject(403, 'permission-denied')`——403 就是这一条，服务端行为是对的。
- 同一版本的 `server/docservice/account-hosted.mjs` 第 307～322 行在会话里下发了 `hosted.render.streamsAllowed: false`。

所以 403 的原因是「创建者不在分组」，属于预期拒绝；界面问题全在页面一侧：

1. **`streamsAllowed` 在页面被丢掉**：`src/account/client.ts` 的 `validateSession` 只收 `render.available / enabled / streams`，把服务端下发的 `streamsAllowed` 删了；账号项目的 `view.hosted` 直接用这份会话（`syncManager.ts` `projectSession`），所以 `hostedOptionRowsOf` 永远拿不到 `notAllowed`，开关不置灰、不提示。口令项目走 `parseHosted`（收 `streamsAllowed`），所以 HS11 测得到、账号项目却漏了。
2. **拒绝原因被改写成无关文案**：账号那条路把 403 一律映射为 `forbidden`，`MembersPanel.tsx` 的 `failText('forbidden')` 显示「密码错误。」——账号项目根本没有密码这一步；`accountErrorText` 里也没有 `permission-denied` 的文案。
3. **失败后不重读服务器状态**：`cur.setAccountHosted` 失败时不续会话，开关和 `streamsAllowed` 要等下一次 15 秒续会话才更新。
