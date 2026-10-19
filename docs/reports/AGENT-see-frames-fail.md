# AGENT 报告：云端 see_frames 生产失败（claude/see-frames-fail）

分支 `claude/see-frames-fail`，从 `claude/accept-018-fixes` 的 `c5285cfc` 切出。

## 结论（一句话）

这次 `see_frames` 失败不是渲染坏了：项目「验收018-Claude」从没开过托管方的「渲染节点」开关（账号项目创建时代码把两个托管开关都设成关，而语义写的是缺省开），渲染服务按开关回 403 `service-disabled`；再叠一个缺陷——出图分级 `frame-dispatcher.mjs` 把这句原因吞掉，模型只看到笼统的「没有可用的出图节点」。后一个已修；前一个在我的文件范围之外，交回主会话。

## 证据（节点 149.88.94.84，只读）

时间均为 UTC，2026-10-19。

1. Agent 主服务 `journalctl -u promptcut-agent`：
   - `18:16:27.916 agent.look.queued projectId=sp_x6g6btiv4o4j5r5oxzj434icei path=/api/vision/snapshot position=0`
   - `18:16:28.119 agent.look.refused status=403 look=service-disabled ms=221`
2. 渲染服务 PM2 日志 `~/.pm2/logs/promptcut-render-out-6.log`：
   - `18:16:27.911 look.queued id=xcyLd36S tool=see_frames runGrant=grant_c9e1a7`
   - `18:16:28.117 look.done state=failed status=403 look=service-disabled worker=null attempts=0`
   - 渲染服务的目录连接在 18:13:45 随文档服务重启断开、18:13:49 `directory.open` 重连上，之后才收到这次请求，不是目录没同步。
3. 文档服务账本（`/var/lib/promptcut-v2/doc/docservice/account-v2.sqlite`，`node:sqlite` 只读打开，只看项目字段与访问事件）：
   - `sp_x6g6btiv4o4j5r5oxzj434icei`「验收018-Claude」`status: active`，`hosted: { render: false, agent: true }`，没有 `hostedOptions`。
   - 它的访问事件只有两条：`seq 85 project-created 16:55:24`、`seq 86 set-hosted-service agent=true 16:55:37`。渲染节点一次也没开过。
   - 对照：「九天之测试」`sp_4lcukykm…` 有 `seq 26 set-hosted-service render=true`（10-17 13:51 手动开过），它的 `see_frames` 在 10-17 23:51 成功（`look.done state=done worker=isolated`）。
4. 对话记录 `/var/lib/promptcut/agent-shared/tenants/sp_x6g6…/conversations/cc-mvfhwi2p-xi4o/history.json`：`see_frames({source:"timeline", t:2.5})` 的 tool_result 是
   `{"error":"这次没看成：没有可用的出图节点（成员设备离线或不合格，云端渲染服务不可用）。"}`，`is_error: true`。渲染服务给的那句「项目创建者关掉了这个项目的渲染节点」没到模型手里。之后 Agent 在收尾汇报里写「渲染节点不可用，这一轮没能出图确认实际画面」，任务正常结束。
5. `agent.ready` 里的 `"look":false` 从 10-17 起每次都是这样（主服务自己不看画面，看画面走任务进程的 `worker.look`），与这次无关；`agent.look.*` 事件证明请求确实送到了渲染服务。

## 判断

| 层 | 结论 |
|---|---|
| 渲染服务、舞台、权限、票据、节点环境 | 都正常。签名验过、请求进了队列，按项目开关被拒（`server/hosted-render/look.mjs` `routeOnce`：`!p.enabled → 403 service-disabled`）。 |
| 这张卡那一刻能不能渲 | 没走到渲染这一步，与卡无关。 |
| 缺陷 A（已修，范围内） | `server/agent/service/frame-dispatcher.mjs` 在托管渲染失败后（抛错或回 `ok:false`）只剩手机浏览器兜底，兜不住就抛笼统的一句，渲染服务的原因码、渲染超时的错误码与调试信息、工作进程自己的回答（比如片段不存在）全被丢掉。`docs/semantics/product/agent.md`「看画面渲染超时就停」要求把「渲染超时」与调试信息告诉 Agent，这里与语义冲突。 |
| 缺陷 B（范围外，交回） | `server/account/authority.mjs` 第 320 行 `createProject` 把账号项目建成 `hosted: { render: false, agent: false }`；`docs/semantics/product/document-service.md`「项目对托管方的每种服务各有一个开关（渲染节点、云端 Agent），缺省开」、`product/agent.md`「云端 Agent 开关，缺省开」。页面上 `CloudAiPanel.tsx` 的「开启云端 Agent」按钮只开 Agent，用户照提示点完，渲染节点仍是关的，看画面与托管方的预渲染都用不了。 |

## 改了什么

- `server/agent/service/frame-dispatcher.mjs`：记下托管渲染的回话（抛出的错误或 `ok:false` 的结果）；手机浏览器也兜不住时，抛回那个错误（`message`、`look`、`code`、`debug` 原样）或交回那个结果；这一轮被停时抛停止原因。没有托管渲染、也没有成员设备时照旧是「没有可用的出图节点」。日志 `frame.cloud-failed` 多记 `look`，`frame.cloud-unsuccessful` 不再整包记结果。
- `server/test/see-frames-cloud-reason.test.mjs`（新）：SF-REASON-01..06，01 用真实的 `createLookClient` 按生产日志回放（登记 202 → 问到 403 `service-disabled`）。

修后模型这次会看到：「这次没看成：项目创建者关掉了这个项目的渲染节点，云端渲不了画面。」

## 验证

- 新测试先对旧的 `frame-dispatcher.mjs` 跑：`# pass 2 # fail 4`（01、02、03、06 失败，复现了吞原因）；换回新文件：`see-frames-cloud-reason` + `cloud-agent-look` 共 `# tests 10 # pass 10 # fail 0`。
- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`（带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`，后台静默跑）：`tests 7140 / pass 7126 / fail 0 / skipped 14`，退出码 0，一次通过，没有需要单独重跑的。
- 渲染附加项不适用：没改画面、渲染管线、取帧本身。
- 真实网络验证未跑：本任务对节点只读，不部署。

## 部署清单（交主会话执行；含第二轮）

节点上这几份文件现在的内容与 `c5285cfc` 相同，只是 CRLF 行尾（`diff --strip-trailing-cr` 核过 `frame-dispatcher.mjs`、`look.mjs`；`authority.mjs` 的 SHA-256 与 git blob 一致）。换上的用 git blob 的 LF 字节（`git show <提交>:<路径>`），`root:root`、`0644`。

| 文件 | 换哪棵树 | 谁加载 | 要重启 |
|---|---|---|---|
| `server/account/authority.mjs` | 文档服务 `/opt/promptcut-v2/releases/35f7b2ab/pc`（`promptcut-doc-v2` 实际跑的目录，`ExecStart` 已核）；Agent 树 `/opt/promptcut-render/releases/35f7b2abb9db` 也换，保持两棵一致 | 只有文档服务（`createProject` 在 `docservice/modules/account-projects.mjs` 里调）；Agent 主服务、任务进程、渲染服务都不引入它 | `systemctl restart promptcut-doc-v2`，随后按 `docs/local.md` 跑一次 `node /opt/promptcut-v2/releases/35f7b2ab/pc/server/hosted/deploy/asset-root-registry-publisher.mjs --config /etc/promptcut/asset-root/publisher.json --rotate`。Agent 树那份不用重启 |
| `server/hosted-render/look.mjs` | Agent 树 `/opt/promptcut-render/releases/35f7b2abb9db`（`/opt/promptcut-render/current` 指向它）；文档服务树那份可一并换，不加载 | 渲染服务（PM2 `promptcut-render`）出这句话；任务进程也引入但只用常量 | `pm2 restart promptcut-render`（在跑的看画面请求会被打断，Agent 一侧按退避接着问） |
| `server/agent/service/frame-dispatcher.mjs` | Agent 树 `/opt/promptcut-render/releases/35f7b2abb9db` | 任务进程（`account-runner.mjs`） | 不用，任务槽每代新开进程 |

- 换前：确认 0 条活跃任务、6 个任务槽 `closed / inactive`；备份三份原文件（两棵树各自）到 `/root/see-frames-default-backup-<时间>/`（`0700`）。
- 回滚：拷回备份，照上表重启 `promptcut-doc-v2`（加 `--rotate`）与 `promptcut-render`。
- 已有项目不动数据。「验收018-Claude」仍是 `render: false`，要看画面须创建者在项目设置里开渲染节点（或主会话另定是否给已有项目补开）。
- 部署后验收：① 新建一个账号测试项目，会话里 `hosted.render.enabled`、`hosted.agent.enabled` 都为真，云端 Agent 不用点「开启云端 Agent」就能用，`see_frames` 出图；② 创建者关掉渲染节点后 `see_frames` 回「这次没看成：这个项目没开托管方的渲染节点（创建者在项目设置里打开），云端渲不了画面。」；③ 删掉测试项目。

## 要在节点上（或由用户）做的事

- 让「验收018-Claude」能看画面：创建者在项目设置（成员面板的托管方服务）里打开「渲染节点」。这是用户操作，不用改节点；不要手改账本。

## 第二轮（主会话 2026-10-20 追加）

1. **两个托管开关按语义缺省开**：`server/account/authority.mjs` `createProject` 由 `hosted: { render: false, agent: false }` 改为 `{ render: true, agent: true }`。「生成轨道流」语义缺省关（`product/rendering.md`、`workflow/project.md`），子选项没记就是关，不动。
   - 创建账号项目只有这一条路：`docservice/modules/account-projects.mjs` 调 `authority.createProject`；页面（`src/account/client.ts`）只传名字、`initialProject`、`allowLinkJoin`、`projectId`，不传开关；`state.projects[...] =` 全仓只此一处。
   - 已有项目数据不动。
   - 改了期望的测试（原先断言缺省关）：`server/test/account-hosted-option.test.mjs` 的 AHO-1（两个开关缺省开、账本里 `{render:true, agent:true}`、子选项没记）、AHO-2（账本开关期望改为开；「渲染节点关着时子选项照旧」改为先关再开）、AHO-5、AHO-6（会话里 `enabled` 改为真）；`server/test/operation-wiring-core.test.mjs`「render service can read project when hosted.render is enabled」改为先断言缺省开、创建者关掉后被拒、开回来能读。
   - `CloudAiPanel.tsx` 的「开启云端 Agent」按钮没动（创建者关过时仍有用）。
2. **`service-disabled` 措辞**：`server/hosted-render/look.mjs` 改成「这次没看成：这个项目没开托管方的渲染节点（创建者在项目设置里打开），云端渲不了画面。」；`docs/plan/cloud-agent-contract.md` 25.6 第 4 条同步改，标「2026-10-20 主会话按实测更正」。
3. harness 丢 `err.debug` 主会话已转给负责 harness 的子 Agent，本分支不管。

第二轮验证：受影响的 6 个测试文件（`account-hosted-option`、`operation-wiring-core`、`hosted-render-look`、`hosted-render-queue`、`see-frames-cloud-reason`、`cloud-agent-look`）`tests 53 / pass 53 / fail 0`；改测试前的全量跑出的 5 个失败正是上面 5 条缺省关断言（AHO-1/2/5/6、operation-wiring 那条），其余 7121 过。全量复跑结果见下。

第二轮全量（改测试后，`76296d7a`）：`npx tsc -b --force` 退出码 0；`npm test` `tests 7140 / pass 7124 / fail 1 / skipped 14`，满负载下两条偶发：
- `asset-project-workers.test.mjs`「真实ffmpeg项目worker独立转码/登记…」20 秒超时（真实 ffmpeg 转码，满负载慢）；
- `reopen-hosting.test.mjs`「真实中继 restricted…」`Cannot read properties of null (reading 'expiresAt')`（旧口令式中继，不经过账号项目创建，与本改动无关）。

单独重跑：两个文件一起 `node scripts/test-suite.mjs …` `tests 14 / pass 14 / fail 0`；`reopen-hosting.test.mjs` 再连跑 3 次，每次 `pass 3 / fail 0`。两条在第一轮全量（改动前）都是通过的，属满负载偶发，不是本改动引入。
