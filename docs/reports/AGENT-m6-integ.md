# M6a 集成对账报告

分支 `claude/m6-integ`，worktree `.worktrees/m6-integ`（已含 `claude/m6-auth` 实现与 `claude/m6-auth-tests` 契约测试的合并）。
只改了 `server/test/auth-kit.mjs`；没有改任何断言、没有删用例、没有放宽期望值。

## 1. 胶水改了什么（`server/test/auth-kit.mjs`）

| 位置 | 测试方的假设 | 接到的实际接口 |
|---|---|---|
| `assemble()` | `server/auth/index.mjs` 的 `createSharedHost(options)`（该文件不存在） | `server/docservice/shared-service.mjs` 的 `createSharedDocService({ mode, dataDir, store, server?, path?, clusterToken?, localDevice, now, log })`：有 `options.server` 用 `mode: 'lan'`，否则 `'hosted'`；凭证存储由 `server/auth/store.mjs` 的 `openCredentialStore({ dir: <dataDir>/auth, now, log })` 打开后传进去；`options.device` 对应 `localDevice`。回的 host 仍是文件头假设的形状：`service`、`auth`、`handleHttp`、`listen`（转给 `service.listen`）、`close`（转给 `service.close`） |
| `host.auth` | 凭证存储本身 | `server/auth/asset-tickets.mjs` 的 `createAssetTicketVerifier({ store, now })`：素材票据核对器，带同一个注入时钟 |
| `assetMiddleware()` | `assetServiceMiddleware(root, { stores, auth })` | 选项名实际是 `tickets`：`assetServiceMiddleware(root, { stores: { media }, tickets: host.auth })`；本机判据用缺省的 `isLoopbackRequest`（按 socket 对端地址，测试的 `__remote` 改写对它生效） |
| `ask()` 里的 `adaptMessage()` | `service.watch` 不带字段 | 服务地址登记模块（M5 就有，`server/docservice/modules/endpoints.mjs` 第 160～165 行）要求 `kinds` 是字符串数组或 `'all'`，契约第 10 节没写这个字段。用例没带 `kinds` 时补 `'all'`。只影响 AU11 第一条 |
| 删除 | `loadAuthIndex()` | 不再需要 |

`client.mjs` 的调用签名不用改：`deriveKey(password, salt, kdf)`、`buildAuthProtocols({ base, … })`、`ticketExpiry(ticket)` 都对得上；`base` 带不带末尾 `/` 都行（`httpBaseOf` 会去掉）。

提交：`a16d22e`（报告开工）、`M6a 集成:auth-kit 的 assemble / assetMiddleware 接到…`、`M6a 集成:auth-kit 的 ask 给 service.watch 补 kinds…`、本报告。

## 2. 验证结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --experimental-test-module-mocks --test server/test/auth-*.test.mjs` | 1 | tests 105 / pass 104 / fail 1（其中 AU 契约测试 64 条过 63 条，实现方自测 41 条全过）。连跑两次结果相同 |
| `npx tsc -b --force` | 0 | 零错误 |
| `npm test` | 1 | tests 2552 / pass 2550 / fail 1 / cancelled 0 / skipped 1（跳过的是原来就跳过的「集成:/api/cards/layout 对真实项目返回整数框」）；唯一失败就是下面那条 AU1 |

AU 用例通过数：**63 / 64**。第一次只接 `assemble` / `assetMiddleware` 时是 62 / 64，补了 `service.watch` 的 `kinds` 后 63 / 64。

## 3. 失败清单

### (A) 胶水没接对

无。

### (B) 测试写错了（与契约原文矛盾）

无。

### (C) 实现与契约不符

无。

### (D) 契约有歧义

**`server/test/auth-create.test.mjs` 第 68 行「AU1 字段缺失或不合法回 400 bad-request」**，契约第 3、4 节（AU1）。

失败信息：

```
AssertionError: 限定进入却没有 list：{"ok":true,"projectId":"sp_…","name":"proj-…","mode":"restricted"}
201 !== 400
  at auth-create.test.mjs:100
```

用例里其余 18 种不合法请求体都按期望回 400，只有「`mode: 'restricted'` 而请求体里不带 `list`」这一种实现回 201。

契约原文：
- 第 4 节端点表：`POST shared/create` 的请求是 `{ name, mode, kdf, creator: { username, salt, key }, project?: { salt, key }, list?: [{ username, salt, key }] }`；
- 第 3 节：「`project` 只在自由进入时有；`list` 只在限定进入时有。限定进入不设项目口令；创建者在限定进入下自动算名单的一员，不出现在 `list` 里」。

两边的理解：
- **测试方**：「`list` 只在限定进入时有」读成限定进入必须带 `list`，与「自由进入必须带 `project`」对称，缺了回 400。
- **实现方**（`server/auth/http.mjs` 第 100 行 `const entries = list ?? [];`）：请求格式里 `list?` 标了可选；限定进入下创建者自动在名单里，空名单（只有创建者一人）是合法项目，没带 `list` 等同空表。自由进入缺 `project` 则没有项目口令、无人能以成员进入，所以那边必须 400。

需要主会话裁定：限定进入不带 `list` 是 400，还是等同 `list: []`（空表 `[]` 两边都认为合法，测试没测它）。

## 4. 主会话已裁定的歧义（供核对）

| 裁定 | 相关用例 | 现状 |
|---|---|---|
| 派生输入按盐的 base64url 解码字节；口令 UTF-8，不做 NFC | AU2 `client.mjs` 对拍（`deriveKey('pässwörd-口令', …)` 与 `node:crypto` 一致） | 过 |
| 任何成员都能取创建者挑战，但只有创建者证明能通过 | AU5「不带证明、证明错、非创建者 → forbidden」「创建者与成员对全部数据面消息的结果一致」 | 过 |
| 冷却期内被拒的握手不再累计失败 | AU8 限速（61 s 后恢复） | 过 |
| 本机声明在独立模式下也认 | AU13（独立模式下本机声明触发 `no-project`） | 过 |
| `set-list` 移出会关掉该用户名在所有设备上的连接 | AU6 `set-list` 移出 | 过 |
| 已用过的 nonce 重放不计入限速失败（实现方的处理） | AU8「nonce 不对也算失败」用的是没见过的 nonce，AU2 nonce 复用只断言 401 | 过，两边不冲突 |

## 5. 对任务书与契约的更正建议

1. 契约第 4 节补一句：限定进入时 `list` 可以省略（等同空表），或者必须给出（缺了 400）。按第 3 节的裁定结果定。
2. 契约第 10 节写 `service.watch` 对所有身份开放，但没写消息字段。建议写明沿用 M5 服务地址登记的格式 `{ type: 'service.watch', kinds: string[] | 'all' }`，免得测试方再按不带字段来写。现在由 `auth-kit.mjs` 的 `adaptMessage` 补上；如果主会话认为 `kinds` 应该可选（缺省 `'all'`），就是实现改动，那时可以删掉这段胶水。
3. `auth-kit.mjs` 文件头的「假设的服务端接口」一段还按测试方的假设写，实际接口已写在 `assemble()` 的注释里。没改文件头，免得和测试方报告对不上；需要的话可以一并改。

## 6. 没做的

- 没有触发回退规则：没有同一处胶水连续改两次都不通的情况，也没有偶发、时序或端口相关的失败（AU 连跑两次、全量一次，失败都只有同一条）。
- 没起 dev server，没用端口段。
