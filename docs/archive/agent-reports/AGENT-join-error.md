# AGENT-join-error 报告

分支 `claude/join-error`，worktree `.worktrees/join-error`。

## 任务

加入共享项目时，`enterShared`（`src/editor/sync/syncManager.ts`）把「连接在打开之前就关闭」一律判成 auth，页面显示「用户名或密码不对。忘了的话找创建者问一下。」；实际多是 WebSocket 没建成（M7 验收探针对阿里云实测时撞上，见 `claude/m7-accept-probe` 的报告第四段）。要分清：服务器明确回认证失败 → 保留原文案；连接没建成 → 报连不上；其它照旧。

## 根因：浏览器里分不出来

服务端在握手阶段拒绝时回 HTTP 401（`server/docservice/service.mjs` 的 `rejectUpgrade(socket, 401)`，契约 `docs/plan/auth-contract.md` 第 5 节）。浏览器的 WebSocket 规范有意不让页面看到升级失败的 HTTP 状态：握手被 401 拒、证书不对、代理挡了 Upgrade、网络不通，页面看到的都是 `error` 加关闭码 1006。`link.ts` 的注释也写了「浏览器里分不出前两种」。所以光改 `enterShared` 的判定做不到「服务器明确回认证失败才报 auth」。

试过、不行的路：

- 看关闭码、时机：都是 1006，时机不可靠。
- 另开一条不带凭证或带错凭证的 WebSocket 当对照：远端来源一样 401，结论相同，得不到信息。
- 看挑战（`shared/challenge`）回的盐：名单外的用户名回伪盐、形状一样，分不出。
- HTTP 长轮询传输（`http-transport.mjs`）能看到 401，但本阶段没接线。

## 改法

1. **服务端新增 `POST shared/verify`〔裁〕**（`server/auth/http.mjs`，`shared-service.mjs` 接线）。〔裁〕是本会话按「穷尽后最小修改」自行定的改动，等你审：
   - 请求体 `{ protocols: [...] }`，就是握手要给的子协议列表，其中必须有证明项 `promptcut.auth.…`（票据、本机声明、集群令牌一律 400）；
   - 交给与握手**同一个** `authenticate` 核对，请求头、来源、回环信任都沿用这次请求：认就回 200 `{ ok: true }`，不认就回 401 `unauthorized`（与握手一样不说原因）；
   - nonce 照样用掉，失败照样计入限速；被限速回 429（带 `retryAfter`）；
   - 组装方不给 `authenticate` 时不答（404，与旧服务一样）。
   - 局域网主机（挂载模式，桌面版）与托管端（独立模式，`main.mjs`、`hosted/combo.mjs`）都经 `createSharedDocService` 组装，两种形态都有这个端点。
2. **客户端** `server/auth/client.mjs` 加 `verifyProtocols`（认回 true，401 回 false，别的抛），`sharedApi.ts` 补类型。
3. **判定抽成纯函数** `src/editor/sync/enterFailure.ts` 的 `classifyEnterFailure`，`enterShared` 在「打开前就断」时调它：
   - 15 秒没连上也没断 → unreachable（照旧）；打开前收到 4004 → no-project；
   - 否则取一份新证明、问 `shared/verify`：服务端认 → **unreachable**（账号密码没问题，是连接没建成）；服务端 401 → auth（被踢过的仍是 kicked）；
   - 取新证明或 verify 时限速 → rate-limited（带秒数）；取新证明时 404 → no-project；网络错误、5xx → unreachable；
   - verify 回 404 或 405（还没升级的旧服务）→ 照旧 auth / kicked，不比以前差。
4. 文案一字没改，用 `JoinForm.tsx` 里已有的两条：
   - auth：「用户名或密码不对。忘了的话找创建者问一下。」
   - unreachable：「连不上服务器，请稍后再试。」（与 `onlineStatus.ts` 的「连不上服务器，请稍后再试。……」同一个说法）
   语义文档没动。

## 验证

- `node --test src/editor/sync/enterFailure.test.mjs server/test/join-verify.test.mjs`：12 过 0 失败。
  - `join-verify.test.mjs`：独立模式、挂载模式各三条：证明对 200、口令错 401（与握手结论一致）；核对过的证明 nonce 已用掉、再握手 401；没有证明项 400。
  - `enterFailure.test.mjs` 六条。**修前对照**：把 `classifyEnterFailure` 临时换回旧逻辑（打开前就断一律 auth/kicked）重跑，5 失败 1 过——「服务端认这份证明 → 连不上」那条修前判成 auth、失败；「服务端明确 401 → 仍判 auth」那条修前修后都过。跑完已还原。
- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；tests 3655，pass 3653，fail 0，skipped 2。
- `npx vite build --mode online`：退出码 0。`npm run build`：退出码 0。
- 不涉及渲染路径，G0-R 没跑。没有起 dev server、没有连阿里云做端到端。

## 没做成的及原因

- 在线形态真正生效要**阿里云上的托管端重新部署**这版服务端；部署前，页面问 verify 得 404，照旧判 auth（与修前相同）。本任务不连阿里云，部署是待办。
- 没做浏览器端到端（真的挡掉 Upgrade 再看页面文案）：M7 探针（`claude/m7-accept-probe`，2be0efe 起会带握手状态）在云端再跑时可以顺带看。

## 对任务书或语义的更正建议

- 任务书说「服务器明确回了认证失败」，但现行协议在浏览器里看不到这个「明确」，必须加一个能看到的通道；本分支选了最小的一处（HTTP 核对端点）。另一条路是握手先接受再以关闭码（如 4001）关掉，改动更大（契约第 5 节、所有 Node 客户端、未鉴权连接的开销），没选。
- `docs/plan/auth-contract.md` 第 4 节的端点表应补 `shared/verify` 一行（本分支没改契约文件，只在 `http.mjs` 文件头写明）。
- 一次输错密码现在会记两次失败（握手一次、verify 一次），限速会早一倍触发；如嫌严，可让 verify 失败不计入限速（但那样它就成了不限速的口令试探口，不建议）。

## 提交

见 `git log main..claude/join-error`。

## 主会话审查（2026-09-30，笔记本主会话）

- 本分支 M8 时期做完后一直「修复待审」（`REPORT-M5-M8.md` 第 6.3 节）。主会话读过 diff：`shared/verify` 与握手用同一个 `authenticate`、nonce 照样用掉、失败计入限速、参数校验严格；页面侧的判定抽成纯函数 `classifyEnterFailure`，旧服务端回 404 / 405 时退回原来的判法，不比以前差。〔裁〕（新增端点）照留，待用户审；`docs/plan/auth-contract.md` 第 4 节端点表已补这一行（`cd37c8ed`）。
- 分叉点较老（`3ab63cf0`），合到当时的 main 之上自动合并（`syncManager.ts`、`shared-service.mjs` 两处与 A3 的改动都在）；在 `claude/r6-merge` 上随整套验证通过（`c10-ui-probe`、`online-user-cards-probe` 都走加入表单）。
- 报告提到的代价照记：一次输错密码会记两次失败（握手一次、verify 一次），限速早一倍触发。线上生效要托管端重新部署（随 0.7.7）。合入 main `8237849f`。
