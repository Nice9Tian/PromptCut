# C6.3 测试方报告（c6-3-tests）

- 分支：`claude/c6-3-tests`（从 `claude/c6-3` 拉出，中途合入了契约第 10 节 `773a4ea`）
- 依据：`docs/plan/docservice-contract.md` 第 1～4 节、第 7 节、第 10 节；写法参考 `render-queue-contract.md` G、H 节
- 对抗式分工：只照契约写，没看 `claude/c6-3-impl` 和 `.worktrees/c6-3-impl`

## 做了什么

| 文件 | 用例 |
|---|---|
| `server/test/docservice-project.test.mjs`（新） | P1～P7，共 9 条（P7 拆成 3 条：截断恢复、截断后再追加再重启、存储层） |
| `server/test/docservice-content.test.mjs`（新） | N1～N8，共 10 条（N5 另加「缺省上限 256 KiB」，N6 另加「watch 以最后一条为准」） |
| `server/test/docservice-attach.test.mjs`（新） | M1～M4，共 4 条 |
| `server/test/fake-docservice-env.mjs`（新假件） | 动态 import 被测模块、临时目录、按查询串 `?user=` 定 principal 的 `authenticate`、独立模式起服务 |

合计 **23 条**。

写法：
- `node:test`，测试名以编号开头，端口一律 0，`autoTick: false`，时钟用 `now` 注入；
- 临时目录在用例结束时删掉；
- 被测模块用动态 import，模块缺失时每条用例各自失败，不会整个文件崩掉；
- 挂载模式的测试在宿主上没多出 `upgrade` 监听时立刻失败，免得握手一条条等到超时。宿主记下全部 socket，收尾时全断，不会挂住进程。

按第 10 节补进去的断言：
1. `listen()` 同步抛错，用的是 `assert.throws`（M3）；
2. `project.announced` 先于 `project.rev`（P2），`content.stored` 先于 `content.changed`（N6），只断言这个先后；
3. `content.watch` 是替换（N6 第二条）；
4. 内容库的 `actor` 是 `{ userId, session }`；`session: null` 视为没给（N6、N7）；
5. 挂上模块后 `/healthz` 的字段集与不挂时相同，`describe().modules.<name>` 不为 null（P1、N1）；
6. 内容库的回包（含错误回包）带请求的 `reqId`（所有 `content.*` 调用）；
7. 只差大小写的两个项目经文件存储重启后各自恢复（P4，对应第 9 条）；
8. 文档服务不回非自己路径的升级、也不关 socket（M1、M2）。

## 验证

### 每个文件 `node --check`

四个文件全过。

### 逐个跑新测试（实现未合入，失败是预期的）

| 文件 | 命令 | 退出码 | 结果 | 耗时 |
|---|---|---|---|---|
| project | `node --test server/test/docservice-project.test.mjs` | 1 | 0 过 / 9 败 | 74 ms |
| content | `node --test server/test/docservice-content.test.mjs` | 1 | 0 过 / 10 败 | 72 ms |
| attach | `node --test server/test/docservice-attach.test.mjs` | 1 | 0 过 / 4 败 | 66 ms |

失败原因全都是 `ERR_MODULE_NOT_FOUND`：`server/docservice/store/index.mjs` 还不存在。

逐条结果：

| 用例 | 当前 |
|---|---|
| P1 open 没见过的项目 | 败 |
| P2 announce 加一、只到订阅者、先回包后广播、close 退订 | 败 |
| P3 相同摘要不加、不广播、不写日志 | 败 |
| P4 文件存储重启恢复（含 `:`、只差大小写的项目） | 败 |
| P5 日志逐行合法 JSON、actor 来自 principal | 败 |
| P6 校验 → bad-message（带 reqId）、状态不变 | 败 |
| P7 截断的最后一行丢弃 | 败 |
| P7 截断后再追加、再重启 | 败 |
| P7 存储层（memory / 文件、路径穿越） | 败 |
| N1 put / get、hash、healthz 字段集、describe | 败 |
| N2 card-source 的 rev | 败 |
| N3 list 前缀、升序、1000 条边界 | 败 |
| N4 missing | 败 |
| N5 too-large 不落状态（按 UTF-8 字节） | 败 |
| N5 缺省 256 KiB | 败 |
| N6 changed / previousActor / actor.session / 先回包后广播 | 败 |
| N6 watch 以最后一条为准 | 败 |
| N7 文件存储重启恢复 | 败 |
| N8 不认识的 kind、key / kinds 不合法 | 败 |
| M1 挂载：/docservice 可用，/other 与无人认领的路径不碰 | 败 |
| M2 close 后宿主照常、连接断开、监听移除 | 败 |
| M3 listen 同步抛错、health 字段与独立模式相同 | 败 |
| M4 两种模式同一组断言（鉴权、R1 式路由、C1 式频道） | 败 |

另用一份「模块在、但 `service.mjs` 不支持挂载」的组合单跑 attach：4 条在 3 秒内全部失败，失败原因是「挂载模式要在宿主上加一个 upgrade 监听，现在宿主有 1 个」，没有挂住。

### 参考实现自检

在 scratchpad 里照契约写了一份最小参考实现：
- `store/index.mjs`；
- `modules/project.mjs`、`modules/content.mjs`；
- 给 `service.mjs` 补上挂载模式。

三个文件在它上面 **23/23 通过**，连跑 3 遍都全过，每遍约 5 秒。自检还做了几件事：
- **变异检查**：让挂载模式对别的路径回 404，M1 失败；不移除 `upgrade` 监听，M2 失败。
- **P4 抓到参考实现的 bug**：参考实现回放时没按 `projectId` 过滤，Windows 上 `CaseP4` 与 `casep4` 串了号，P4 失败。修好后通过。这正好对应第 10 节第 9 条。

参考实现和 scratchpad 里的副本已删除，没有提交。

### 既有测试与类型检查

- `npm test`（在本 worktree）：退出码 1；共 2332 条，2308 过，23 败，1 跳过。
  - 23 条失败全部是上面三个新文件；
  - 跳过的是既有的「集成:/api/cards/layout」；
  - 既有测试全过。
- `npx tsc -b --force`：退出码 0，零错误。

## 没做成的、要留意的

- **偶发「连接失败」**：自检早期约 30 次运行里，出现过 2 次 `new WebSocket` 刚连就失败（N7/N8 一次，P7 一次）。
  - 都出现在「关掉服务、立刻在新端口起服务再连」的用例里。
  - 之后连跑 20 多次没再出现，另写了 300 次起停连接的探针，也复现不了。
  - 已在 `fake-docservice-env.mjs` 里让连接失败时带出 URL、错误原因和关闭码。实现合入后若再遇到，看这条信息定位。
- 插件 `vite-plugin-docservice.ts` 按契约不写单测。

## 契约疑点与更正建议

1. **`projectId` 允许 `:`，而第 3 节写的文件名是 `<dir>/projects/<projectId>.ndjson`。**
   - Windows 上 `a:b.ndjson` 会变成文件 `a` 的备用数据流，能读回，但目录里看不到真文件，拷贝、部署时会丢。
   - 建议契约写明：文件名要把 `:` 之类编码掉（例如百分号编码）。
   - P4 只要求含 `:` 的项目能恢复，不断言文件名。
2. **截断之后的追加（P7 第二条是我加的）。**
   - 契约只说「读时丢掉半行」。但如果追加前不先截掉半行或补换行，新记录会接在半行后面，下次重启就丢了。
   - 建议契约补一句：第一次追加前，修掉结尾的半行。
3. **路径穿越「要拒绝」没说怎么拒绝**：抛错还是忽略。P7 存储层只断言没在目录外写出文件。
4. **内容库 `key` 不合法时回什么，契约没写。** 测试按 `bad-message` 断言（N8），建议写进契约。
5. **`content.put` 的 `session` 校验规则没写**：是否与项目模块一样限 1～128 个字符。测试没断言不合法 `session` 的行为。
6. **`body: null` 算不算合法。** 契约说 `body` 是「任意 JSON 值」，N1 把 `null` 当合法值测。
7. **`maxBodyBytes` 按 UTF-8 字节计。** 契约写的是「序列化后超过」，N5 按字节断言：35 个字符、101 字节算超。
