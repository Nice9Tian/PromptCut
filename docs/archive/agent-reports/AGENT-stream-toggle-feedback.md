# AGENT 报告：stream-toggle-feedback

分支 `claude/stream-toggle-feedback`（起点 main `82ab4933`）。

任务：账号云端项目的「项目设置」里，「生成轨道流」开关在创建者不在 `render_streams` 权限分组时没有置灰、没有提示；保存被 403 拒绝后界面静默。查根因、修好、补测试、验证。

## 进度

- [x] 查清 403 原因与 `streamsAllowed` 为什么没生效
- [x] 修复（`40c6afba`）
- [x] 测试（STF1～STF3）
- [x] 验证（tsc、npm test、浏览器实测）
- [x] 部署清单

## 一、根因（证据）

生产节点只读诊断（2026-10-21）：

- nginx：`[20/Oct/2026:17:22:27 +0000] "POST /hosted/shared/account/admin" 403 98`；随后的 `/hosted/shared/account/session` 全是 200。
- 账号服务（`promptcut-account-v2`，VisuHive `vh-0e64fbe`）已有 `/internal/v2/permissions`；它的环境文件 `/etc/promptcut-account-v2/promptcut-account-v2.env` 与 `/etc/visuhive/smtp.env` 里没有非空的 `ACCOUNT_ADMINS`。
- 账号库只读查询（`runuser -u visuhive-account`，`node:sqlite` 只读打开）：`accounts` 只有 `9tian`（`acc_f17cf0ab2b14547df056b54f`），`permission_groups` 为空表。所以 9tian 既不在 `render_streams` 分组、也不是管理员。
- 文档服务（`/opt/promptcut-v2/releases/35f7b2ab/pc`）的 `server/account/authority.mjs` 第 428 行在 `set-hosted-option streams=true` 时查分组，不在组内 `reject(403, 'permission-denied')`——403 就是这一条，服务端行为是对的。
- 同一版本的 `server/docservice/account-hosted.mjs` 第 307～322 行在会话里下发了 `hosted.render.streamsAllowed: false`。

- 403 回包 98 字节与文档服务的错误体 `{"ok":false,"error":"permission-denied","code":"permission-denied","message":"permission-denied"}`（`server/docservice/modules/account-projects.mjs` 的 catch）长度吻合；`creator-required` 等其它 403 码长度不同。

所以 403 的原因是「创建者不在分组」，属于预期拒绝；界面问题全在页面一侧：

1. **`streamsAllowed` 在页面被丢掉**：`src/account/client.ts` 的 `validateSession` 只收 `render.available / enabled / streams`，把服务端下发的 `streamsAllowed` 删了；账号项目的 `view.hosted` 直接用这份会话（`syncManager.ts` `projectSession`），所以 `hostedOptionRowsOf` 永远拿不到 `notAllowed`，开关不置灰、不提示。口令项目走 `parseHosted`（收 `streamsAllowed`），所以 HS11 测得到、账号项目却漏了。
2. **拒绝原因被改写成无关文案**：账号那条路把 403 一律映射为 `forbidden`，`MembersPanel.tsx` 的 `failText('forbidden')` 显示「密码错误。」——账号项目根本没有密码这一步；`accountErrorText` 里也没有 `permission-denied` 的文案。按代码，那次 403 之后小确认框里应当出现一行红字「密码错误。」（小框不关）；用户说「什么说明都没有」，我没能在生产上复现当时的画面，可能是这行小字没被注意到，也可能另有原因——修复后这一行改成服务端给的原因，且开关随即置灰，两处都能看到。
3. **失败后不重读服务器状态**：`cur.setAccountHosted` 失败时不续会话，开关和 `streamsAllowed` 要等下一次 15 秒续会话才更新。

## 二、改法

只动页面一侧，服务端行为不改（`server/account/authority.mjs` 的 403 `permission-denied` 与 `server/docservice/account-hosted.mjs` 的 `streamsAllowed` 下发都是对的）。

| 文件 | 改了什么 |
|---|---|
| `src/account/client.ts` | `validateSession` 收下 `hosted.render.streamsAllowed`（布尔才收）；`ProjectSession` 类型加这一项；`accountErrorText` 加 `permission-denied`「你的账号没有开启这一项的权限，请联系托管方。」、`invalid-service`、`invalid-option` |
| `src/editor/sync/hostedServices.ts` | 新增纯函数 `accountHostedFailure`（账号那条路的失败 → 错误种类 + 一句能给人看的原因，任何异常都有一句话）、`hostedFailText`（有原因照原因说，否则照旧） |
| `src/editor/sync/syncManager.ts` | `setHostedService` / `setHostedOption` 账号分支失败时带 `message`（类型 `HostedChangeResult`）；`cur.setAccountHosted` 被拒或没做成时马上续一次会话，开关与置灰回到服务器真实值，再把原错误交给界面；删掉被取代的 `accountAdminError` |
| `src/editor/sync/MembersPanel.tsx` | `HostedServiceDialog` / `HostedOptionDialog` 的错误行改用 `hostedFailText`：账号项目显示服务端原因，口令项目照旧 |
| `src/account/client.test.mjs` | STF1：会话带 `streamsAllowed` 收下、非布尔丢掉；`set-hosted-option` 403 `permission-denied` 抛出的错误带那句提示 |
| `src/editor/sync/hostedServices.test.mjs` | STF2：账号会话 `streamsAllowed:false` 置灰并提示、`true` 能开能关；STF3：失败原因（403、断网、503、未知异常、口令项目回退） |

## 三、验证

- 类型检查：`npx tsc -b --force` → 退出码 0，零错误。
- 定向测试：`npm test -- src/account/client.test.mjs src/editor/sync/hostedServices.test.mjs server/test/account-hosted-option.test.mjs` → 49/49 通过（含 STF1～3 与服务端 AHO-6）。
- 全量：`npm test`（命令里设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`，后台静默）在提交 `40c6afba` 上 → tests 7238、pass 7223、fail 0、cancelled 0、skipped 15，退出码 0。
- 浏览器实测（Chrome 无头，Vite 端口 5430）：小页面 `out/stf/`（`out/` 不入库：`index.html`、`harness.tsx`、`run.mjs`；跑法 `node out/stf/run.mjs`）用**真的**账号客户端 `createAccountClient`（走 `validateSession`）、真的 `HostedServiceRows`、真的 `accountHostedFailure` / `hostedFailText`；文档服务一侧照 `authority.mjs`、`account-hosted.mjs` 的行为与回包形状模拟（不在分组时 `set-hosted-option enabled:true` 回 403 `permission-denied`，会话带 `streamsAllowed`）。8/8 通过：
  - 分组外：开关置灰、提示「你的账号没有开启这一项的权限，请联系托管方。」→ `docs/reports/assets/stream-toggle-feedback/1-out-of-group-disabled.png`
  - 首个会话不带 `streamsAllowed`（模拟修之前页面看到的样子）时开关可点；点「打开」被 403 拒：小框红字显示同一句原因，随后重读会话，开关未勾并置灰 → `2-denied-403-reason.png`
  - 分组内：可点 → 打开后勾上 → 关掉后不勾 → `3-in-group-on.png`、`4-in-group-off.png`
- **没做的**：本机隔离托管组合 + 在线构建的端到端实测（`scripts/probes/account-user-pages-probe.mjs` 那一套）没跑。那套夹具写死 6340～6342、6388 等端口和冻结的 VisuHive 站点，不在分配的 5430～5439 段内，改夹具超出文件范围；所以换成上面的组件级实测。同步管理里「失败后续会话」那一步（`syncManager.ts` 在 Node 里载不起来）没有单独的自动测试，靠类型检查与代码审查；建议部署后在生产上用 9tian 点一次确认（预期：开关已置灰带提示，点不了）。

## 四、部署要换什么

- 服务端：**不用换文件、不用重启**文档服务与账号服务（本次没改 `server/`）。
- 前端：`src/` 改了 4 个文件，按 `docs/local.md` 的规矩：
  1. 构建在线前端 `dist-online`，换 `/opt/promptcut-hosted/editor`（保留 `runtime-config.json`，换前备份）；
  2. 再把提交的整份 `src/` rsync 进渲染树 `/opt/promptcut-render/releases/35f7b2abb9db`；
  3. 重启 `promptcut-render`（PM2）与 `promptcut-agent`，核 `render.code-version match:true`。顺序必须先换在线前端再重启渲染服务。
- 桌面版：同一份 `src/` 随下一个补丁生效。
- 让 9tian 能开「生成轨道流」：由托管方在 VisuHive 后台把 9tian 加进 `render_streams` 分组，或在账号服务环境里设 `ACCOUNT_ADMINS`（目前两处都空）。这是运营决定，不是缺陷，交用户定。

## 五、对任务书或语义的更正建议

- 语义无冲突，`product/rendering.md`、`workflow/project.md` 的「置灰并提示」照原样落地。
- 发现的小问题（未改，超出本任务）：`server/account/client.mjs` 把账号服务的所有非 200 回包都变成 503 `account-unavailable`，所以 `account-hosted.mjs` 里「`permissions` 回 404 就当旧账号服务、不下发 `streamsAllowed`」那一支永远走不到；账号服务一时连不上时会话会下发 `streamsAllowed:false`，开关暂时置灰（偏保守，可以接受，但提示语会说成「没有权限」）。要区分的话需要 `client.mjs` 保留 404，另立任务。
- 生产只读诊断时，我在节点 `/tmp` 放过两个临时文件（`/tmp/stf-pg.mjs` 只读查询脚本；一次误把 `accounts.db` 复制成 `/tmp/acc-ro.db`），都已当场删除（`ls` 确认不存在），没有改动任何服务、库或配置。
