# M6b 独立渲染主机：契约测试报告（claude/m6-host-tests）

契约：`docs/plan/render-host-contract.md`。worktree：`.worktrees/m6-host-tests`，分支 `claude/m6-host-tests`（基于 `claude/m6`，已含 M6a）。
对抗式分工：只照契约写，没看实现分支 `claude/m6-host`，没读 `.worktrees/m6-host`。

## 1. 交付

- `server/test/render-host-contract.test.mjs`：用例 RHC1～RHC20。
- `server/test/render-host-kit.mjs`：测试件。对实现接口的假设全部写在它的文件头，只有 `loadHostModule`、`startHost` 两处引用这些接口；集成时对不上只改这两处。
- 用到的已有接口（真实存在）：`fake-shared-env.mjs` 的 `startSharedService` / `createProject`（托管端，缺省把回环当远端）、`auth/client.mjs` 的 `buildAuthProtocols`、`render-queue` 与 `render-node` 的公共出口、`fake-loopback-transport`、`fake-render-queue-env`，以及文档服务 `describe().modules['render-queue'].spaces[projectId]`（M6a 报告第 5 节第 18 条）。
- 没用 `auth-kit.mjs`：这个分支上它引的 `server/auth/index.mjs`（`createSharedHost`）不存在，AU 系列测试在 `claude/m6` 上载入就失败（见第 5 节第 1 条）。

## 2. 编号与用例

| 编号 | 契约 | 验什么 | 在哪一层 |
|---|---|---|---|
| RHC1 | 第 2 节 | 单个对象 → 一项；`maxConcurrent` 缺省 1；字段照给的保留；`key` 代替口令也行 | 假设的 `parseHostConfig` |
| RHC2 | 第 2 节 | 数组按顺序每项一条；`maxConcurrent` 给在一项上即全局值；4 可以 | 同上 |
| RHC3 | 第 2 节 | 缺 url / projectId / username / 口令和 key、url 不是 ws、role 不是 render、不是对象、数组里一项坏、空数组 → 报错，错误码 `bad-host-config` 或 `bad-shared-config`，信息里没有口令；`maxConcurrent` 5、64 要么报错要么压到 ≤ 4；0、-1、1.5、`'2'` 报错 | 同上 |
| RHC4 | 第 2 节 | `loadHostConfig(file)` 读数组文件；文件不存在、不是 JSON 报错 | 假设的 `loadHostConfig` |
| RHC5 | 第 3、4 节 | `checkClaimable(plan, host 节点).ok === false`；pc 节点对照为 true；host 对细任务为 true | 已有 `checkClaimable` |
| RHC6 | 第 4 节 | 真队列 + 内存传输 + `createNodeSession`：host 节点对 plan 0 次 `task.claim`、认领并完成全部细任务、plan 仍 open；只有 plan 的队列里 40 拍 0 次认领；对照 pc 节点认领到这个 plan | 已有会话、队列 |
| RHC7 | 第 3 节 | `createLocalNode` 以 `profile: 'host'` 跑：`executor.plan` 0 次调用、不对 plan 发认领、细任务完成 | 已有 `createLocalNode` |
| RHC8 | 第 4 节 | `requires.codeVersion` 不在 `codeVersions` 里：0 次认领、任务仍 open；同版本的对照被认领 | 已有会话、队列 |
| RHC9 | 第 4 节 | 真文档服务：`render` 连接以 `profile: 'host'` 报到，能认领 bob、carol 两个不同成员发布的细任务；别的项目的 host 认领被拒 | 已有文档服务 |
| RHC10 | H3 | 只带 `promptcut.v1`、什么都不带、口令错：握手 401；打不开的连接收到 0 条；别的项目的成员在本项目发布、认领全过程里收到 0 条带本项目 id 或任务 id 的消息 | 已有文档服务 |
| RHC11 | 第 3 节 | 两份配置 → 两条 `render` 连接（按证明里的 `p` 区分）、每个项目恰好一次 `node.hello`；每个空间恰好一个已连节点、`profile: 'host'`、两个 nodeId 不同；`local` 空间没有主机节点 | 假设的 `createRenderHost` |
| RHC12 | 第 3 节 | `node.hello`：`profile: 'host'`、`capabilities: { userCards: true, graphCards: false }`、`codeVersions` 只有给的那一个、`envFingerprint` 照给的；主机不发 `task.publish` | 同上 |
| RHC13 | 第 3 节 | 两个项目五个细任务（来自三个成员）全部由主机完成，各记在各的空间；每个项目一个产物库、产物只推到自己项目的库；诊断按项目分开计数 | 同上 |
| RHC14 | 第 3 节〔裁〕 | 两个项目、`maxConcurrent: 2`：采样文档服务两个空间里 claimed 之和 ≤ 2、执行器同时在跑 ≤ 2，且确实用满 2（「有空位就认领」） | 同上 |
| RHC15 | 第 2、3 节 | 不给 `maxConcurrent`：两个项目合计同时只持有 1 个 | 同上 |
| RHC16 | 第 3 节 | 同一项目里有 plan 与细任务：主机只完成细任务，plan 仍 open，`executor.plan` 0 次 | 同上 |
| RHC17 | H2 | 主机代码版本与任务的 `requires.codeVersion` 不同：600 ms 后任务仍全 open、执行器 0 次、诊断 `connected: true, claimed: 0` | 同上 |
| RHC18 | H3 | 口令错的主机实例：诊断 `connected: false, claimed: 0`、空间里没有已连节点、任务仍 open、服务端记了 `auth.reject` | 同上 |
| RHC19 | 第 2 节「退出」 | 持有两个认领时 `stop()`：文档服务 `autoTick` 关着（租约不会过期），任务 3 s 内回到 open、执行器里的工作被中止、连接关掉、别的节点能认领 | 同上 |
| RHC20 | 第 3 节「诊断」 | `describe()` 形状 `{ nodes: [{ projectId, connected, claimed, completed, dedup, failed, lost }], codeVersion, envFingerprint, maxConcurrent }`；产物库 `has` 为真的任务计入 `dedup`、不渲染；能过 JSON | 同上 |

契约第 3 节的「产物推到 `service.endpoints` 的 `asset`、用 `auth.ticket` 取票据」「掉线重连」、第 2 节的 `scripts/render-host.mjs` 入口与 HTTP 诊断口 `GET /api/frames/queue`、第 5 节的探针，都要起真的预渲染进程或 vite，不在单进程测试里；由探针验。产物库在测试里经 `sinkFor` 注入假的。

## 3. 假设的接口签名（集成时对账）

集中在 `server/test/render-host-kit.mjs` 文件头，这里照抄要点：

```
server/render-host/index.mjs
  parseHostConfig(raw, { device? }) → { entries, maxConcurrent }
    raw：单个对象或数组；每项 { url, projectId, username, deviceId, deviceName, as: 'member', password | key, role: 'render' }
    maxConcurrent 写在配置项上（数组时给在任何一项上都算全局值）；缺省 1，上限 4
    不合格抛 Error，err.code 为 'bad-host-config' 或 'bad-shared-config'，信息里不带口令与 K
  loadHostConfig(file) → 同上（可以同步也可以返回 Promise）
  createRenderHost({ entries, maxConcurrent, codeVersion, envFingerprint, executor, sinkFor, tickMs?, log? }) → host
    executor：契约 D.1 的 { plan, render }，所有节点共用
    sinkFor({ projectId, entry, endpoint }) → 契约 D.1 的 { has, put, resultFor? }，每个项目一个
    tickMs：节点节拍（测试给 20）
  host.start() → void | Promise
  host.stop() → Promise        让掉认领、关连接
  host.describe() → 契约第 3 节诊断的对象
```

连接假设走 `createWsEndpoint` 的缺省全局 `WebSocket`：测试在起主机前把 `globalThis.WebSocket` 换成记录用的子类，据此数 `node.hello`、看字段，不要求实现多开注入口。实现若自带 WebSocket 实现（不取全局的），RHC11、RHC12 要改成从服务端看。

诊断计数的含义假设为**累计**：`claimed` 是认领到的次数（RHC13 完成后断言 `claimed` 等于任务数，RHC20 断言 2），不是此刻持有数。`dedup` 与 `completed` 分开计（与 vite 插件现有 `stats` 一致），RHC20 只断言 `dedup === 1` 和 `completed + dedup ≥ 2`。

## 4. 验证

命令都在 worktree 根目录跑。

- `node --check server/test/render-host-contract.test.mjs`、`node --check server/test/render-host-kit.mjs`：退出码 0。
- `node --test server/test/render-host-contract.test.mjs`（本分支，没有实现）：20 条，**3 过 17 败**，都是预期：
  - RHC8、RHC9、RHC10 过（只用已有行为：代码版本过滤、空间内任何成员可认领、H3）；
  - RHC1～RHC4、RHC11～RHC20 败在「载入 `server/render-host/index.mjs` 失败」（假设的模块还不存在）；
  - RHC5～RHC7 败在「host 认领了 plan」（`filter.mjs` 目前只对 `browser` 拒 plan），正是 M6b 要改的行为。
- **测试本身的自检**：为确认用例没写错，在 worktree 里临时写了一份最小参考实现 `server/render-host/index.mjs`（按上面的假设接口：`normalizeEntry` + 每项一个 `createWsEndpoint` / `createLocalNode`、共享并发计数、stop 时 `yieldAll`），并临时给 `filter.mjs` 加了「host 拒 plan」一行。结果：
  - 20/20 过，连跑两遍都 20/20（每遍约 9.6 s）；
  - 变异检查：去掉共享并发上限（`isIdle: () => true`）→ RHC14「合计同时持有 4 > 2」、RHC15「2 > 1」失败；stop 时不 `yieldAll` → RHC19 失败。说明这三条真能抓到错；
  - 自检完已删掉参考实现、`git checkout` 还原 `filter.mjs`，都没提交。`git status` 干净。
- 没跑 `npx tsc -b --force` 与全量 `npm test`：只加了两个测试文件；新测试文件在实现合入前本来就是红的（任务书预期），加进全量测试会让基线变红，要等主会话把实现和测试一起合。

## 5. 契约歧义与更正建议

1. **`auth-kit.mjs` 在 `claude/m6` 上载入就失败**（任务之外，顺带发现）：它引 `server/auth/index.mjs` 的 `createSharedHost`，M6a 实现没有这个模块（实际入口是 `docservice/shared-service.mjs` 的 `createSharedDocService`）。`auth-spaces.test.mjs` 等 AU 系列在这个分支上全部报 `ERR_MODULE_NOT_FOUND`。M6a 合并时的对账看来没做完，建议主会话核对 `claude/m6` 上 `npm test` 的状态。
2. **`maxConcurrent` 写在哪**：第 2 节说配置是「数组，每项 {…}；另可给 `maxConcurrent`」，没说给在哪。数组没有地方放全局字段。可选：写在某一项上（测试的假设）、顶层改成 `{ projects: [...], maxConcurrent }`、或命令行 `--max-concurrent`。请定一种；若不是本测试的假设，改 `withMaxConcurrent` 一处即可。
3. **超上限怎么办**：「上限 4」没说超了是报错还是压到 4。RHC3 两种都接受；0、负数、小数、字符串按报错写的。
4. **配置字段哪些必填**：契约列的是完整形状，M6a 的 `normalizeEntry` 让 `deviceId`、`deviceName`、`as`、`role` 可缺省。RHC3 只把 url、projectId、username、口令与 key 当必填，另把 `role` 不是 `render` 当错（主机只开 render 连接）；`as: 'creator'` 能不能当主机没测。
5. **单个对象算不算合法**：第 2 节写「数组」，M6a 第 11 节说「也可以是数组」。RHC1 按两种都收写的。
6. **诊断计数是累计还是此刻**：`claimed` 等是累计还是当前持有，契约没说；H2 的「`claimed = 0`」读起来像累计。测试按累计写（见第 3 节）。建议契约写明，并说明 `completed` 含不含 `dedup`。
7. **plan 跳过在哪一层做**：第 4 节说节点收到 plan「直接跳过、不发认领」。测试要求在节点过滤或会话这一层做（RHC5～RHC7），不接受只在主机编排里过滤。若实现方只在主机外层过滤，RHC5～RHC7 会失败，届时请主会话裁定。
8. **并发上限与「在飞的认领」**：会话一次只有一条在飞的认领，但两个项目的会话各有一条时，持有 + 在飞可能超过合计上限。RHC14 以文档服务里 claimed 的采样判，要求合计持有数不超过上限，所以实现要把在飞的认领也算进共享计数（参考实现就是这么做的）。
9. **退出时让掉认领的原因词**：契约没定 `task.release` 的 `reason`，测试不查。
