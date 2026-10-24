# 验证记录：探针夹具的票据续期（反向通道那三项失败）

2026-10-24。`cloud-tools-wire-probe` 的「反向通道」三项在这台机器上开始稳定失败，
查下来是探针夹具自己的问题，产品代码没事。本文记查法、根因和改完的验证。

## 症状

```
PROBE 反向通道:模型调 seek → 任务进程 → 主服务的登记表 → 发起人的真编辑器页面,播放头真的变了 FAIL
  {"seek":{"ok":false,"initiatorOffline":true,…},"received":[],"opens":2,"attached":true,
   "worker":["agent.page.offline:page-not-live", …×3]}
PROBE 反向通道:play / pause 也到了发起页并交回 FAIL
PROBE 反向通道:这一轮结束之后页面再交(内容不同)被拒 FAIL  {"status":400,"body":{"code":"bad-request"}}
```

浏览器那一侧 `attached: true`（事件流挂着），任务进程那一侧却记 `page-not-live`。
第三项期望 409 / 410，因为前两项根本没发出去，页面交的是一份没登记过的结果，服务器回 400。

## 怎么定位的

1. **先缩范围**：`--only page` 单跑那一段 **9/9 全过、46 秒**，页面事件流 `opens: 1`（没断过）。
   全量跑才失败，`opens: 2`。所以不是那段逻辑坏，是跑到后面才坏。
2. **在夹具里打时间戳**（临时诊断，已还原），拿到直接证据：

   ```
   10:48:44.595  actor0 续票据 #7  -> pageStale=true
   10:48:44.939  actor0 页面连接重开并报到完成
   10:48:44.971  actor0 续票据 #8  -> pageStale=true
   10:48:50.033  actor0 续票据 #9
   10:48:50.129  actor0 续票据 #10
   10:48:50.477  actor0 页面连接重开并报到完成
   10:48:50.506  actor0 续票据 #11
   10:48:50.836  actor0 页面连接重开并报到完成
   10:48:50.867  actor0 续票据 #12
   10:48:50.867  actor0 agent …/messages 票据剩余 2s -> 2s pageStale=true   ← 模型发 seek 的那一次
   ```

   十秒里续了六次票，每次续回来**还是只剩 2 秒**。正常时候是 `票据剩余 120s`
   （失败之后同一个 actor 恢复成 `120s / 97s / 86s`）。

## 根因

两段代码对上就清楚了：

- 文档服务发会话时把有效期夹到凭证的剩余寿命上 ——
  `server/docservice/account-hosted.mjs`：`Math.min(principal.expiresAt, now() + 5 * 60_000)`；
- 编辑器那份短期凭证只活两分钟 ——
  VisuHive `account/credentials.mjs`：`CREDENTIAL_LIMITS.accessMs = 120_000`，
  且 `accessExpiresAt = Math.min(now() + accessMs, login.expires_at)`（网站登录本身是一天以上，不是瓶颈）。

所以凭证走到最后半分钟时，文档服务回的是「**200，但只剩几秒**」——不是 401。
而夹具的 `tickets()` 旧写法是 `if (renewed.status === 200) break;`，把它当成功收下：

- 下一次调用一看「快到期」又续一遍，于是续票风暴；
- 每次续票都置 `pageStale = true`，紧接着把页面到文档服务的那条连接 `terminate()` 掉、重开、重新报到；
- 在那几百毫秒里在场表没有这张页面。模型那一刻发来的 `seek` / `play` 查在场表就落在空隙里，
  得到 `page-not-live` → 回「发起方不在线」。

完全过期（401）时夹具是会重新讨凭证的，所以它能自愈；坏的是**活着但快死**那半分钟的夹缝。
页面那一段排在探针最后、大约四分钟才开始，所以它是最容易踩中的一段。
今天早些时候同一份代码 40/40，是因为前面几段跑得快、这一段开始得早；机器一忙就必然踩中
——不是随机抖动，是一个真实的脆弱点。

## 改法

`server/test/fixtures/account-runner-process.mjs` 的 `tickets()` 一处：把「200 就算成功」改成
「**200 且票据还有可用寿命**才算成功」。续回来仍低于 `RENEW_AT_MS`（30 秒）时，走它本来就有的
`site('/editor/session', …)` 重新讨一份编辑器凭证再续 —— 重讨会给一个新的两分钟窗口。
换过两次还是短的（说明不是「两分钟到头」这回事）就把手上这一份带出去，和旧写法一样，不死转。

产品代码不动：那个 `Math.min` 本身是对的，凭证到期了会话就该跟着到期。

这个改法是**把机制去掉**，不是把时间余量调大 —— 续回来短票据这件事不再被当成成功，
所以风暴不会再发生。

## 验证

| 项 | 结果 |
|---|---|
| `node --check server/test/fixtures/account-runner-process.mjs` | 通过 |
| `npm run build` | 成功 |
| `cloud-tools-wire-probe` 全量，第一次 | `PROBE-RESULT pass {"total":40,"ok":40,"fail":0,"skip":0}` |
| `cloud-tools-wire-probe` 全量，第二次（连跑确认） | `PROBE-RESULT pass {"total":40,"ok":40,"fail":0,"skip":0}` |
| 用到这个夹具的全部测试（7 个文件） | 38 项：37 通过、1 跳过、**0 失败** |

用到这个夹具的测试：`accept-018-auth-agent-path`、`accept-018-conv-endtoend`、
`account-master-production`、`account-render-publish-e2e`、`account-render-publish`、
`account-runner-process`、`account-runner-wiring`（探针侧还有 `cloud-agent-ui-probe`、
`cloud-tools-wire-probe`，后者就是上面跑的那个）。

改之前在同一台机器上连失败三次（我的分支合入 main 之后、未改动的 `origin/main`、
未改动的 `72dd9fc9`，三者同样三项同样症状），改之后连过两次。

## 没验的

- `cloud-agent-ui-probe` 也用这个夹具，没跑（它要起编辑器与无头浏览器，时间较长；
  本次改动只会让它的票据更稳，不会更差）。
- 合入 `release` 要跑的整套验收没跑：这是测试侧改动，按
  `docs/semantics/guide_files/verification.md`「按改动范围验证」走。
