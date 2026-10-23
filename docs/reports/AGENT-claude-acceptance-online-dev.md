# AGENT-claude-acceptance-online-dev

让整套验收能起一台**在线浏览器模式**的开发服务，并把 `vibe-groups-cloud-probe.mjs` 登记成会跑的清单项。分支 `claude/acceptance-online-dev`，从 `main`（`b3893261d`，0.7.23）切出，未推送、未合并。

## 怎么做的

### 1. `startDevServer` 的在线模式开关

`scripts/lib/dev-server.mjs` 的 `startDevServer({ ... })` 多收一个 `online`（缺省 `false`）。为真时在环境变量里加 `VITE_PC_ONLINE: '1'`。

做成开关而不是让调用方自己写那个变量名：**名字只认一处**，写错了不会悄悄起成桌面版那一台然后在探针里以奇怪的方式失败。`env` 里显式写的同名变量仍然压过它（`{ VITE_PC_ONLINE: '1', ...env }`），所以不夺走调用方的最终决定权。

这一层本来就把 `env` 透传到 vite 子进程，所以没有别的改动。

### 2. 验收多一台服务 `dev-online`

`scripts/acceptance/four-stage-acceptance.mjs` 的服务表加一个分支，和 `dev` 并列但**是两台**：

```js
if (name === 'dev-online') {
  const port = ctx.opts.devOnlinePort;                       // 缺省 5970，占 5970～5972
  const s = await startDevServer({ port, online: true, ... });
  return { vars: { 'dev-online.origin': s.origin, 'dev-online.port': s.port }, ... };
}
```

- **现有项用的 `{dev.origin}` 一个字没动**。`dev` 仍然不是在线模式；要在线的项自己写 `needs: ['dev-online']` 并用 `{dev-online.origin}`。整套里别的项不会跟着改走在线那一支。
- 端口落在 **5970～5972**，不在 5690～5699：那一段已经排满（`dev` 5690～5692、`dev-main` 5693～5695、远端口 5696、调试口 5697、Agent 口 5698）。可以用 `--dev-online-port` 改（`acceptance-lib.mjs` 的 `devOnlinePort`）。
- `SERVICES` 白名单（`acceptance-lib.mjs`）加上 `dev-online`，否则清单校验直接判不合格。

### 3. 顺手收掉一处看不见的停服务

原来「这一项不要哪几台 dev server」那一段是这么写的：

```js
if (!needs.has('dev') && !needs.has('dev-main')) services.stopDevs();
else { if (!needs.has('dev') && ...) { ...stop(); }   // ← 直接 stop，不打日志
       if (!needs.has('dev-main') && ...) { ...stop(); } }
```

`stopDevs()` 会打「停 X dev server」，这个分支不会。**结果是日志上看不出 `dev` 到底停没停** —— 我第一次跑两项连排时就撞上了：日志里只有「起共享 dev → 起在线模式 dev」，中间没有停的那一行。两台端口不冲突，所以跑是跑过了，但这个疏忽在端口撞车时才会暴露，代价是整项莫名其妙地起不来。

收成一条路：`Services.stopDev(name)` 一个方法负责停 + 打日志，`stopDevs()` 就是对 `DEV_SERVICES` 逐个调它；needs 那一段变成一行

```js
for (const d of DEV_SERVICES) if (!needs.has(d)) services.stopDev(d);
```

（一台都不要时等于全停，if/else 两种写法可以去掉。）改完日志里就有「停 dev dev server」了，见下面的证据。

### 4. 探针进整套

`scripts/acceptance/v23-manifest.mjs`：从 `V23_EXCLUDED` 里拿掉 `vibe-groups-cloud-probe.mjs`，登记成清单项

```js
PR23('V23-groups-cloud', '云端分组走真服务端：…',
  'vibe-groups-cloud-probe', ['--url', '{dev-online.origin}', '--api-port', '5973', '--out', '{item}'],
  { needs: ['dev-online'], timeoutMin: 30,
    known: '要在线模式的 dev server(服务名 dev-online，缺省 5970～5972)；探针自己再起一个服务端占 5973' })
```

`V23_EXCLUDED` 是被 `four-stage-manifest.mjs` 展开进 `EXCLUDED_PROBE_FILES` 的，所以拿掉 + 有项覆盖，`--check-coverage` 就自洽了。

## 验证

按 2026-10-23 的规矩只跑受影响的，没跑全量。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 覆盖自洽 | `node scripts/acceptance/four-stage-acceptance.mjs --check-coverage` | **守门:通过**，退出码 0；① 297 个探针文件都登记了或写明了排除原因 |
| 这一项真跑 | `--only V23-groups-cloud` | **过 49s**，结果行 `{"ok":true,"steps":11,"fails":[]}` |
| 和要 `dev` 的项连排 | `--only P-creativity --only V23-groups-cloud` | **2 项过 2** |
| 受影响测试 | `npm test -- server/test/four-stage-acceptance.test.mjs four-stage-acceptance-v18 dev-server-junction probe-timings no-user-dirs port-file` | 60 条，60 过、0 失败 |

### 连排那一次的日志（服务起停都对）

```
[23:47:55] 起共享 dev server(5690～5692)
[23:48:40]   pass  (44s)                  ← P-creativity，用 {dev.origin}
[23:48:40] 停 dev dev server              ← 第 3 节收完之后才看得见这一行
[23:48:40] 起在线模式 dev server(5970～5972)
[23:49:34]   pass  (53s)                  ← V23-groups-cloud，用 {dev-online.origin}
[23:49:34] 停 dev-online dev server
本地验证 2 项:过 2
```

### 测试抓到的一处

第一次跑受影响测试时 `FSA-05`（清单自洽）红了：`V23-groups-cloud 用了不认识的占位符 {dev-online.origin}`。那条测试里有一张「认识的占位符」白名单，加服务就得同步，已补上 `dev-online.origin` / `dev-online.port`。全仓库只有这一张表。

## 没做到的 / 要你知道的

- **端口 5973 是我挑的**。探针自己起的那个服务端缺省 5969，和 5970 段挨着容易混；我在清单项里显式给了 5973，落在你分给我的 5970～5979 内。要换一个说一声。
- **`dev-online` 和 `dev` 不会同时在跑**（needs 那一段会把不要的停掉）。要是以后有项同时要两台，现在的逻辑支持（两者端口不冲突），但没有这样的项，也没测过。
- **没跑全量**，按 2026-10-23 的规矩。
- `my_agent/` 又被误提交了一次（这个 worktree 从 `main` 切出，而补 `.gitignore` 那一行的提交还在未合并的 `claude/clip-silent-badge` 上）。这条分支里只把它退出索引、**没动 `.gitignore`** —— 两条分支改同一行会在合并时撞。那一行合进 `main` 之前，新建的 worktree 都要照办一次。
