# AGENT 报告：c10-site（C10 浏览器探针的外网模式与独立主机角色）

分支 `claude/c10-site`，起点 `24c2c57`（claude/c10-integ）。端口段 5420～5429。只改了 `scripts/probes/c10-browser-probe.mjs` 与本报告。

## 做了什么

`scripts/probes/c10-browser-probe.mjs`（用法全写在文件头）：

- `--site <源>`（外网模式）：不起本机托管组合与代理。页面 `<源>/editor`、文档服务 `<源>/hosted/`、素材服务 `<源>/media/api/asset`；
  两个舞台源读 `<源>/editor/runtime-config.json` 的 `stageOrigins`（读不到记失败、退回 `s1.<主机>`、`s2.<主机>`；`--stage-origins` 可覆盖，仍核一致）。
  创建者 = 本机桌面 dev server（+5～+7）连远端，成员 = 本机无头 Chrome 普通档（1600×1000）。A1～A4 判据不变，
  只有「播放 10 秒主文档长任务 0」在外网模式只报数、记入结果行的 `pending`（待笔记本复核）。
- `--role host --run <id>`：从协调口 KV `c10b.<run>.config` 读文档服务地址、项目 id、成员口令，起 `scripts/render-host.mjs`（IPC），
  写 `host.ready`（nodeId、profile、环境指纹、代码版本、传输、平台）、`host.progress`（认领 / 完成 / 失败数与传输，变了才写），
  等 `finish` / `abort` / 超时后经 IPC 正常退出，结果写 `host`。`--run latest` 取 10 分钟内的 `c10b.latest`；`--test-fingerprint` 只给本机自测用。
- `--role creator`（外网缺省；本机替身里给它就用 KV 等外部主机）：A5 先照旧核「没有节点在线时改一处 → 页面发布清单计划、open 等着、不报错」，
  然后写 KV `config`，等外部主机报到（`--host-wait-min`，缺省 15 分钟），报到后 15 分钟内认领并完成至少一段，
  再 10 分钟内页面取到它产的新快照（层换了新键、`envFingerprint` 等于主机报的指纹、`snap/` 就绪）、播放中贴着新快照；最后写 `finish`、收主机结果行（2 分钟）。
  记下认领方的 nodeId、profile、环境指纹、实际传输（`transport`、`resumes`、`legacy`、`opens`、`connectFailed`），新增一条核「认领方经 WebSocket」。
  没有主机报到：A5 后半记「待笔记本主机」（`steps.a5.pendingHost`、结果行 `pending`），不算失败；`--no-host` 直接这样记。出错收尾写 `abort`。
- 本机替身（不给 `--site`、不给 `--role`，即 `all`）：A5 照旧由探针自起本机主机（测试指纹），判据不变。

## 验证

机器负载：同时有十来个子智能体在跑测试与探针。

| 轮 | 命令 | 结果 |
|---|---|---|
| 本机替身 all | `node scripts/probes/c10-browser-probe.mjs --dist <在线构建> --out <目录>` | 退出码 0，`ok: true`、`fails: []`，417 s；长任务 0、采样 67、主重卡不同帧 57、投递 270、占位 t=0.1 fit 7 deadMs 23.3；snap 338、px 0；L2 costs 4；重开不重测、refetched 0、l2Hits 3；A5 主机 `host:DESKTOP-GS40TCK:5425/p0` claimed 3 / completed 1、transport ws、新层指纹 0c10b0e5f1a9e7d2、ready 31、播放贴着 main-v2；项目已删、端口全放 |
| 本机替身 creator + host（经阿里云协调口 KV，run `c10loc0928a`） | 同上加 `--role creator --run c10loc0928a`；另一进程 `--role host --run c10loc0928a --port 5425 --test-fingerprint 0c10b0e5f1a9e7d3` | 两边退出码 0、`ok: true`；主机报到 11 s；认领方 profile host、指纹 0c10b0e5f1a9e7d3（与页面、创建者都不同）、transport ws、resumes 0；新层 ready 31；主机退出码 0、released 1；结果与日志里没有令牌 |
| 外网（阿里云） | 待主会话「开始外网」 | 见下 |
