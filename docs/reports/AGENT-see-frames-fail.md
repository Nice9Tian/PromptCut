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
- `npx tsc -b --force`、`npm test`：见下节（跑完补）。
- 渲染附加项不适用：没改画面、渲染管线、取帧本身。
- 真实网络验证未跑：本任务对节点只读，不部署。

## 部署清单（交主会话执行）

| 文件 | 目标 | 说明 |
|---|---|---|
| `server/agent/service/frame-dispatcher.mjs` | `/opt/promptcut-render/releases/35f7b2abb9db/server/agent/service/` | `root:root`、`0644`。它只在任务进程里加载（`account-runner.mjs` 引入），任务槽每代新开进程，换完下一轮就生效，不用重启服务。 |

- 换前：`systemctl show promptcut-agent-root -p ExecStart` 确认在用的仍是 `35f7b2abb9db`；确认没有在跑的任务。
- 备份：`install -d -m 700 /root/see-frames-reason-backup-<时间>/ && cp -p <目标文件> 那里`。
- 回滚：拷回备份文件，同样不用重启。
- 验收：在一个渲染节点关着的测试项目里让云端 Agent 调 `see_frames`，tool_result 应是渲染服务那句 `service-disabled` 的话；在渲染节点开着的项目里照常出图。

## 要在节点上（或由用户）做的事

- 让「验收018-Claude」能看画面：创建者在项目设置（成员面板的托管方服务）里打开「渲染节点」。这是用户操作，不用改节点；不要手改账本。

## 没做的与交回主会话的

1. 缺陷 B（账号项目托管开关缺省关，与语义「缺省开」冲突）：改 `server/account/authority.mjs` 的 `createProject` 默认值，可能还要配 `src/editor/right/CloudAiPanel.tsx` 的提示，都在我的文件范围之外，没动。另需主会话定：已建的账号项目是否补开（会让托管渲染服务开始进这些项目；「生成轨道流」仍缺省关，不额外产流）。
2. 渲染超时的调试信息即使本次修好不再被分级吞掉，`server/harness/agent.mjs` 第 221 行把工具抛的错只留 `err.message`，`err.debug` 仍到不了模型。语义要求附调试信息，要改 harness 或在 `look-client.mjs` 把调试摘要拼进消息，前者属于别的子 Agent 的范围，留给主会话定。
3. `LOOK_ERRORS['service-disabled']` 的措辞「项目创建者关掉了这个项目的渲染节点」在缺省关的情况下不准确（创建者从没开过）。措辞写在 `docs/plan/cloud-agent-contract.md` 第 1666 行，没改；建议改成「这个项目没开托管方的渲染节点（创建者在项目设置里打开），云端渲不了画面」。
