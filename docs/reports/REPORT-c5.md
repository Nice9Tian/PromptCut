# 报告：C5 素材服务数据层与集群接入

集成分支 `claude/c5`。2026-09-25 验收通过，按用户「阶段验收全过即自动合并」的授权合入 main。

- 计划：`docs/plan/Master-Execution-Plan.md` 第 5.2 节、第 7 节 C5（含 2026-09-25 的更正）
- 契约：`docs/plan/asset-store-contract.md`（第 8 节是定稿后按测试方疑点补的细则）
- 第 6 步的独立审查：`docs/reports/REVIEW-c6-agy.md`（C6 拆分的依据，随本分支入库）

## 0. 范围更正

计划写 C5 时以为 `cloud-task.md` 第 5 步（素材服务空壳）还没做，实际早已在 main 上（`8b8ad2c`、`2944743`）。C5 因此收窄为三件事：
- 数据层抽象 `BlobStore`；
- 非本机写入要带集群令牌；
- 局域网地址登记到控制面。

外加 W2。`TODO.md` 里「素材服务：还不存在」一并更正。

## 1. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | tests 2294、pass 2293、fail 0、skipped 1（照旧需要 5190 的那条） |
| 新增测试（测试方只照契约写，没看实现） | `blob-store-conformance`（K1～K18，fs 与 memory 各跑一遍）、`asset-store-http`（H1～H6）、`asset-announce`（N1～N4） | 33 + 6 + 5，合进集成分支后首跑全过 |
| 既有测试 | `asset-service.test.mjs` | 11/11；只在转译替换表里加了一行，断言没改 |
| 导出确定性（主 Agent 重跑） | `verify-determinism.mjs --url http://127.0.0.1:5460/?export=1` | 1800/1800 相同 |
| 导出与快照重放（主 Agent 重跑） | `verify-unified-frames.mjs` | PASS |
| 导出像素基线（实现方跑） | 本分支 5460 对 main 5463，逐像素比较 | 1800 帧中 0 帧不同，PNG 逐字节相同 |
| 预渲染探针（实现方跑） | `preview-fallback-probe`、`ready-index-probe` | 两个都退出码 0 |
| 与 main 对打（实现方跑） | 同一串 46 个请求分别打 main 与本分支 | 状态码、响应头、回包全同，唯一差别是预检多了 `Authorization`；`out/media` 逐字节相同 |
| 地址登记 | 主 PC 在 5460 起 dev server（绑 0.0.0.0，设了 `PROMPTCUT_DOCSERVICE_URL`） | 登记 `asset:DESKTOP-GS40TCK` → `http://192.168.50.96:5460/api/asset`，控制面 `endpoints: 1` |

### W2 跨机（笔记本 192.168.50.247 → 主 PC 192.168.50.96:5460）

`asset-lan-probe.mjs --docservice ws://8.219.80.16:8787 --mb 20`：
- 退出码 0；`source: "docservice"`，地址由控制面下发；
- 7 步全部通过：
  - 不带令牌写回 401；
  - 只传第 0、1 片后，对账报 `[0,1]`；
  - 补齐其余分片，收尾 200；
  - 跨源 GET 带 CORS 头；
  - Range 回 206；
  - 20 MB 全件下载，sha256 相符。

主 PC 的 Windows 防火墙没有改：`C:\Program Files\nodejs\node.exe` 已经有入站允许规则。

## 2. 与对齐时不一致的地方

1. **缺省 `announcerId` 改为 `asset:<主机名>`**：原文的 `asset@…` 会被控制面拒收（契约第 8 节第 1 条）。
2. **本机判据比原文严**：`isTrusted` 缺省按 `http-guard.mjs` 的 `clientAddressOf` 判，看舞台端口的反向代理写进的真实对端。只看 `socket.remoteAddress` 的话，局域网请求经代理进来会被当成本机，不带令牌就能写。
3. **`/@media/<hash>` 老读路由没动**：它仍由 `mediaMiddleware` 按文件答，挪到数据层后面留给 C6.6（两档）。
4. **一个小现象**：设了 `PROMPTCUT_DOCSERVICE_URL` 时，Node 会报一条 `MaxListenersExceededWarning`（`listening` 事件第 11 个监听）。不影响功能。

## 3. 过程记录

- 子 Agent：`claude/c5-impl`（`opus-dev-high`）、`claude/c5-tests`（`opus-dev`）。两份报告的内容已并进本文，原文留在两个子分支的提交里。
- 测试方提了 9 条疑点，主 Agent 裁定后写进契约第 8 节，实现方和测试方都照改。
- 第 6 步的独立审查（agy，`gemini-3.1-pro-high`）在 C5 期间并行完成。结论已折进主执行计划 C6 一节：拆成 C6.1～C6.6；C6.4 的决议 11 与 C6.5 的操作格式、撤销语义，要等用户定。
