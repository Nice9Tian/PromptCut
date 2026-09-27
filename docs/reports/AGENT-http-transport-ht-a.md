# AGENT 报告：HT-a 服务端（`claude/http-transport` 按契约返工）

状态：服务端返工完成，基线全绿（第 4 节）；等主会话审查。

HT-a 是 `docs/plan/http-transport-contract.md` 文件头「2026-09-27 拆分」的前一段：会话模型、序号确认、WebSocket 传输接会话层、本机信任开关；HTTP 长轮询（HT-b）保留代码、不接线。本报告只管服务端；客户端会话层 `server/render-node/session-link.mjs` 与各处接入在 `claude/ht-client`。

下文「第 N 节」都指 `docs/plan/http-transport-contract.md` 的章节；「H1～H14」是测试方 `server/test/ht-kit.mjs`（分支 `claude/ht-tests`）顶部列的、契约没写死的假设编号。

## 1. 合并与冲突

- `git merge --no-ff claude/c10a-integ`（`e0515c4`）。两处冲突：
  - `docs/plan/http-transport-contract.md`：取 C10a 集成分支一侧（第 2 版加第 16 节）。
  - `server/vite-plugin-frames.ts` 独立渲染主机的 `connect`：本分支按 `entry.transport` 选端点，C10a 给 `rec` 加了 `cards: null`。按两边意图合：保留按 `entry.transport` 选端点（这一处归 `claude/ht-client` 改成 `createDocEndpoint`，HT-a 不动），`rec` 加上 `cards: null`。
- `server/docservice/service.mjs`、`shared-service.mjs`、`server/auth/*`、`server/hosted/*`、`scripts/remote/docservice.mjs` 自动合并无冲突；返工在合并之后的版本上做，C10a 加的公网地址参数（`--doc-public-url` / `--asset-public-url`）、邀请链接源（`linkOrigin`）原样沿用。

## 2. 返工项的落实（第 15 节服务端各行）

| 返工项 | 落实 | 提交 |
|---|---|---|
| `server/docservice/session.mjs`（新）：会话表、序号与确认、保留与补发、脱开与结束、`sessions` 统计 | 新文件 `createSessionLayer`。核心四个钩子接到它（第 7 节）：`write` 补 `seq` / `ack`（追加在对象末尾，文本拼接，不重新序列化）并进未确认缓冲；`buffered` = 未确认字节；`close` 结束会话、不保留，`router.disconnect` 与 `conn.close` 推迟到下一轮事件循环；`ack` 推进后调 `router.drained`。入站按 `seq` 收（重发丢弃、跳号 1002 `bad-seq`），交核心前摘掉 `seq` / `ack`；`session.ack`、`session.close` 由会话层处理。确认：满 32 条立即、否则 1 s 内单发 `session.ack`，另加「未确认字节满 64 KiB 立即」（见第 6 节第 3 条）。脱开保留 `retainMs`（缺省 60 000），期满 `conn.timeout` + `1006 timeout` 墓碑；墓碑 2 分钟。旧客户端（不带会话项）也登记在这里，标 `legacy`，行为与之前相同。 | `d63eaca`、`f7b9591` |
| `service.mjs`：WebSocket 升级认会话项、替换半开的旧连接、接续失败先接受升级再以 4404 / 4410 关闭；传输接会话层；`/healthz` 换成 `sessions` | 升级时 `parseSessionItem`：没有会话项 → 旧客户端；`promptcut.session.new` → 照常鉴权、建会话，第一条出站 `session.welcome`；`promptcut.session.<sid>.<ack>` → 不鉴权，接续；写法不对、多项、接续项旁边还有别的项 → 400。接续时旧传输以 4009 `superseded` 关。接续失败先 101，再以 4404 `no-session` / 4410 `session-closed <原码>[ <原因>]` / 1002 `bad-seq`（接续项里的 ack 越界，会话随之结束）关闭，关闭帧发出后不等对端（`ws.mjs` 加 `closeNow`）。心跳：旧客户端照旧断线并打 `conn.timeout`，讲会话的只脱开。`/healthz` 去掉 `transports`，加 `sessions`（第 8 节的键）；`describe().conns[i]` 加 `transport`、`fallback`、`detached`、`resumes`；`mount` 拒绝认领 `session.` 开头类型的模块。`maxConnections` 按会话数（含脱开的）。选项 `retainMs`、`tombstoneMs` 新增；第 1 版的 `httpCorsOrigins`、`httpWaitMs`、`httpIdleMs`、`httpTombstoneMs` 与 `handleLongPoll()` 删掉（不接线）。 | `d63eaca` |
| `http-transport.mjs`：保留、按第 15 节改到与会话层一致，不接线 | 改成接在会话层下面的薄传输：去掉批次号；帧就是带 `seq` 的消息文本；`recv` 按 `ack` 释放后回会话层里还没确认的帧（留到确认为止，重复的对方按 seq 去重）；`open` 认会话项（新会话鉴权、接续按 sid 查，404 / 410）与 `X-Promptcut-Fallback`（只认 `ws-error` / `ws-timeout` / `ws-closed`）；空闲 `waitMs + 15 s` 只让会话脱开；墓碑由会话层在会话结束时立；会话结束时挂着的 GET 先回完剩下的帧再带 `closed`。文件头写了 HT-b 的接法。`service.mjs` 不引它。 | `f7b9591` |
| `PROMPTCUT_TRUST_LOOPBACK` 接到第 10 节四处，删旧名，`0` 而没有令牌拒绝启动 | `createSharedDocService` 加 `trustLoopback`：`false` 时握手（回环不带凭证 401、本机声明不认）、共享 HTTP 端点（`server/auth/http.mjs`，按非回环限速）、创建者操作限速三处的 `isLoopback` 一律回 false。托管组合（`combo.mjs`）把同一开关用于素材服务与管理接口，并传给文档服务；`trustLoopback: false` 而没有令牌抛 `cluster-token-required`。`server/hosted/main.mjs`、`server/docservice/main.mjs` 读 `PROMPTCUT_TRUST_LOOPBACK`（只认 `0` / `1`，别的值 `config.error trust-loopback`），`0` 而没有令牌 `config.error cluster-token-required`、退出码 1。旧名 `PROMPTCUT_TEST_NO_LOOPBACK_TRUST` 在代码里已不存在。`auth/http.mjs` 只补了文件头说明（开关经组装方传进来的 `isLoopback` 生效，函数体不用改）。 | `6f30158` |
| `server/hosted/deploy.mjs`、`scripts/remote/docservice.mjs`：PM2 配置写 `PROMPTCUT_TRUST_LOOPBACK=0` | `hostedPm2Config` 的 env 加 `PROMPTCUT_TRUST_LOOPBACK: '0'`（正式、演练两个实例）。远端脚本在 `secrets/cluster-token` 不在时改为报错退出（退出码 5，提示加 `--write-token`），在 `pm2 startOrReload` 之前停手，免得换上一个起不来的进程。`scripts/remote/docservice.mjs` 文件头补说明。公网地址参数沿用 C10a。 | `6f30158` |
| 仓库里用旧名的脚本与探针 | `scripts/probes/c66-t9-probe.mjs` 文件头的本机自测改为 `PROMPTCUT_TRUST_LOOPBACK=0 PROMPTCUT_CLUSTER_TOKEN=<…>`（关掉本机信任必须带令牌）。**改不到的**：主会话 scratchpad 里 `run-t9-local.sh` 的用法说明仍写旧名，需主会话自己改成同样两项。 | `6f30158` |
| 旧客户端行为不变（第 3.6 节） | 不带会话项：101、只回显 `promptcut.v1`、没有 welcome、消息不带 `seq` / `ack`、积压按套接字算、断开即断线、心跳超时打 `conn.timeout`。`ht-legacy` 3/3、现有 `docservice*` 测试全过。 | `d63eaca` |
| 跟着开关改的测试 | `sp-hosting.test.mjs`：SP3 关掉本机信任时带令牌，另断言没令牌抛 `cluster-token-required`（原来会挂住的就是这条）；deploy-2 断言 PM2 配置里 `PROMPTCUT_TRUST_LOOPBACK` 是 `'0'`、脚本在没令牌时 `exit 5`；文件头说明改为开关管四处。 | `6f30158` |
| 第 1 版的三个测试文件（`1892c1f`、`da0ea0a`、`234e33e`） | `docservice-http-transport.test.mjs` 重写：不经 `createDocService`（不接线），自搭「核心 + 会话层 + 长轮询 + 回环 http 服务器」按第 6 节测 10 条（LP-open、send-recv、recv 挂起与替换、接续、close 与服务端关、空闲只脱开、413、busy、背压、CORS）。`docservice-transport-equivalence.test.mjs` 删除（HTTP 一半归 HT-b，WebSocket 与「断开再接续」由 `claude/ht-tests` 的 `ht3-equivalence` 覆盖）。`render-node-http-transport.test.mjs` 删除（见第 5 节第 2 条）。`fake-transport-kit.mjs` 保留，`lp()` / `recvUntil()` 改第 2 版。 | `f7b9591` |

## 3. 与测试方假设（`ht-kit.mjs` H1～H14）的对齐

| 假设 | 实现 |
|---|---|
| H1 会话层在 `server/docservice/session.mjs` | 是 |
| H2 `createDocService` 选项 `retainMs`，缺省 60 000，`welcome.retainMs` 等于它 | 是 |
| H3 会话项写法；接续不调 `authenticate`；接续时列表只有 `promptcut.v1` 与接续项 | 是（旁边多任何一项都 400） |
| H4 welcome 形状，`sid` 43 个字符 | 是 |
| **H5 接续失败在握手里回 404 / 410** | **按契约第 16 节改了**：先 101，再以 4404 / 4410 关闭。H5 写于第 16 节之前（`ht-tests` 最后一次提交 13:00:37，第 16 节 13:01:24），`ht-kit.mjs` 的 `resumeStatus` 要对账（见下）。判据不变：仍是「不存在 → 404 语义、已结束 → 410 语义」。 |
| H6 关闭码 1002 `bad-seq`、4009 `superseded`、1013 `backpressure` | 是 |
| H7 `/healthz.sessions` 的键、`list` 五个键、旧客户端计入 `ws` 与 `legacy`、没有 `transports` | 是；`opened` 连旧客户端一起累计 |
| H8 `describe().conns[i]` 四个字段 | 是（旧客户端也有：`transport: 'ws'`、`detached: false`、`resumes: 0`） |
| H9 日志 `session.detach`、`session.resume { connId, transport, gapMs }`、`conn.timeout`，会话号不进日志 | 是；另有 `session.fallback { connId, reason }`、`session.bad-seq { connId }`；`conn.open` 对旧客户端带 `legacy: true` |
| H10、H11、H12、H14 | 客户端的，归 `claude/ht-client` |
| H13 `server/hosted/*.mjs` 里有 `PROMPTCUT_TRUST_LOOPBACK`；`0` 无令牌退出码 1、`cluster-token-required` | 是 |

**H5 的对账（给集成时改 `ht-kit.mjs`，判据不动）**：`resumeStatus` 改成握手成功后读关闭帧，4404 折算 404、4410 折算 410，握手就被拒的照回状态码。本分支验证时在临时拷贝里就是这么改的：

```js
export async function resumeStatus(env, sid, ack = 0) {
  const { rawWsClient } = await import('./fake-raw-ws.mjs');
  let c;
  try {
    c = await rawWsClient(env.port, { protocols: [PROTOCOL, resumeItem(sid, ack)] });
  } catch (err) {
    const m = /HTTP\/1\.1 (\d{3})/.exec(String(err?.message));
    return m ? Number(m[1]) : -1;
  }
  const ended = await Promise.race([c.ended, new Promise((r) => setTimeout(() => r(null), 3000))]);
  c.destroy();
  const code = ended?.closeFrame?.code ?? c.closeFrame?.code;
  return code === 4404 ? 404 : code === 4410 ? 410 : 101;
}
```

不改时 HT1 / HT2 有 9 条用例在 `resumeStatus` 那一行失败（期望 404 / 410，实得 101），其余断言都已通过。

## 4. 验证

测试方的文件（`ht-kit.mjs`、`ht1-session`、`ht2-backpressure`、`ht-legacy`、`ht6-trust`）从 `claude/ht-tests` 临时拷进 worktree 跑，跑完移出，没有提交。

| 项 | 命令 | 结果 |
|---|---|---|
| HT1（WebSocket 部分）+ HT2 + ht-legacy，照测试方原样 | `node --test server/test/ht1-session.test.mjs server/test/ht2-backpressure.test.mjs server/test/ht-legacy.test.mjs` | 30 条：21 过、9 败，9 条全败在 H5 的 `resumeStatus` 那一行（期望 404 / 410，实得 101，见第 3 节）：HT1-resume-fail、HT1-bad-seq、HT1-retain、HT1-close、HT1-server-close-4003 / 4004 / closeConn、HT2-no-ack、HT2-detached。（第一轮另有 HT1-bad-resume-ack 败：服务端发 1002 后等对端回关闭帧 2 s，已加 `closeNow` 修好） |
| 同上，`resumeStatus` 按第 16 节对账后 | 同上 | **30 / 30 通过**（HT1 22、HT2 5、legacy 3） |
| HT6 | `node --test server/test/ht6-trust.test.mjs` | **5 / 5 通过** |
| 长轮询（不接线，自搭组装） | `node --test server/test/docservice-http-transport.test.mjs` | **10 / 10 通过** |
| 稳定性 | 对账后的 HT1 + HT2 + legacy + HT6 + 长轮询一起连跑两遍 | 两遍都是 **45 / 45 通过** |
| sp-hosting | `node --test server/test/sp-hosting.test.mjs` | **14 / 14 通过**（含 SP3、SP7、deploy-1 暂存目录里起 `main.mjs`） |
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试（测试方文件已移出） | `npm test` | 见下方「全量测试」 |

全量测试（`npm test`，测试方文件已移出 worktree，退出码 0）：**tests 3253、pass 3251、fail 0、skipped 2**。跳过的两条正是显式开启的集成用例：`集成:/api/cards/layout 对真实项目返回整数框`、`SKILL 闸门:闸关之后无头实例的工具调用不落地`。

没跑的：导出确定性、快照重放一致、画面探针——这次没改渲染、导出、卡片与画面，按 `verification.md` 不必跑。HT3、HT4、HT5、HT7 不在本分支的验收里（HT3 / HT4 / HT5 要客户端会话层，HT7 要阿里云部署）。

## 5. 没做成的及原因

1. **没做契约第 15 节里客户端那几行**：`session-link.mjs`、`render-node/index.mjs`、`vite-plugin-frames.ts` 三处接入、`server/agent/doc-link.mjs`、`src/editor/sync/`、`shared-config.mjs` 删 `transport` 字段、两个探针的 `--transport`——都归 `claude/ht-client`，本分支一行没动。
2. **第 1 版的节点端 HTTP 客户端没有配套的服务端了**：`server/render-node/http-transport.mjs`（`HttpWebSocket`、`createHttpEndpoint`）还是第 1 版协议（批次号、`{ seq, data }` 外包），与改过的服务端不通，而服务端又不接线，所以它的测试 `render-node-http-transport.test.mjs` 删掉了。它本身留着（第 15 节「留作底座」），HT-b 改客户端时一并改、重写测试。影响：`vite-plugin-frames.ts` 里 `entry.transport === "http"` 那条分支现在连不上（服务端不答 `/lp/…`）；这条分支连同 `shared-config.mjs` 的 `transport` 字段按第 15 节本来就要删，由 `claude/ht-client` 换成 `createDocEndpoint` 时去掉。集成前如果有人的共享项目配置里写了 `transport: 'http'`，会连不上。
3. **主会话 scratchpad 的 `run-t9-local.sh`** 用法说明里的旧名 `PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1` 我改不到；新写法是 `PROMPTCUT_TRUST_LOOPBACK=0 PROMPTCUT_CLUSTER_TOKEN=<令牌>`（`0` 时必须带令牌）。
4. **阿里云没有重新部署**：不在本任务里。部署时注意：远端 `secrets/cluster-token` 必须在（或带 `--write-token`），否则新的部署脚本在换进程前以退出码 5 停手。

## 6. 对契约的更正建议

1. **第 4.1 节「WebSocket 在握手里回这两个状态码」**已被第 16 节改掉，建议把第 4.1 节那句直接改成第 16 节的说法，并写明 4410 的 `reason` 格式。本实现是 `session-closed <原关闭码>[ <原原因>]`（截到 123 字节）；ack 越界的接续以 1002 `bad-seq` 关闭（会话随之结束），不是 4410。
2. **第 16 节第 3 条要求 H1～H14 集成时对账**：H5 与第 16 节直接冲突，建议 `claude/ht-tests` 按第 3 节的代码改 `resumeStatus`（只改公共件，判据不动）。
3. **确认的粒度只按条数与时间会卡住大消息**：第 3.4 节把 `buffered` 定为未确认字节，核心在它到高水位（64 KiB）后就不再直接写；而第 3.3 节的确认是「满 32 条或 1 s」。对方按这条规矩确认时，连发 64 KiB 的大消息（项目快照分片）每秒只能过一片左右；反方向客户端的未确认上限只有 1 MiB，服务端 1 s 才确认一次时，客户端一口气上传超过 1 MiB 就会自己结束会话。服务端这边我加了「收到的未确认字节满 64 KiB 立即确认」（`SESSION_DEFAULTS.ACK_BYTES`，〔裁〕，三级机制）；建议契约第 3.3 节把「或未确认字节满 64 KiB」写进两边的确认规则，客户端（`claude/ht-client`）同样照做。
4. **第 6 节没写「会话在、但当前挂的不是这条 HTTP 传输」时 send / recv 回什么**：本实现回 `409 { error: 'superseded' }`（传输被替换，或空闲判断开之后），客户端应经 `POST /lp/open` 接续。HT-b 定稿时建议写进第 6.2、6.3 节。
5. **第 6.2 节「同一时刻只有一个 POST 在途」没写服务端怎么回**：本实现第二个回 `409 { error: 'busy' }`。
6. **第 6.3 节 `bad-ack`**：第 14 节说保留 400 `bad-ack`，第 3.5 节说 ack 越界即会话已坏、1002 结束。本实现两者都做：回 400 `bad-ack`，同时会话以 1002 结束。建议在第 6.3 节写明。
7. **`/healthz.sessions.opened` 是否计旧客户端**契约没说，本实现计（旧客户端也是会话）。
8. **第 15 节「实现记录改在本版之后另起一节」**：我没有改契约文件（避免与 `claude/ht-client` 同时往同一处追加而冲突），以上内容建议主会话集成时合写成第 17 节。
