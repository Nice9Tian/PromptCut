# 云端工作节点状态记录（2026-09-26，会话「云端工作」）

本文是已删除的云端会话「云端工作」推到分支 claude/cloud-node-status 的 STATUS.md 原文（最后一版，提交 3781735），作为历史记录收进 main。同期它经协调口写回的环境报告见 http-transport 分支上 docs/reports/HANDOFF-http-transport.md 第 8 节。该分支已删除。

---

# 云端工作节点状态（第 3 版）

- 连通性：ok（经 443 HTTPS，https://8-219-80-16.sslip.io）
- egressIp: 160.79.106.138
- 出网限制：只能经 CONNECT 代理走 443 HTTPS；不支持 WebSocket、非 443 端口、原始 TCP
- 已写回协调口：cloud-status、cloud-env

## 环境（cloud-env）

| 项 | 结果 |
|---|---|
| node | v22.22.2 |
| npm | 10.9.7 |
| git fetch origin | 可以 |
| 仓库 | origin/main 3d5de1e，npm ci 成功 |
| GET /hosted/healthz | 200 |
| GET /media/healthz | 200 |
| 硬件 | 4 vCPU、15 GiB 内存、无 GPU，以 root 运行 |

## Chrome

按指令参数（headless: 'shell'、--disable-gpu、--enable-unsafe-swiftshader、--no-first-run）启动**失败**，原文：

```
Error: Failed to launch the browser process:  Code: 1
stderr:
ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:102] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.
```

加上 `--no-sandbox` 后**成功**：`HeadlessChrome/152.0.7977.75`。
渲染认领若由探针起 Chrome，需要在这台机器上带 `--no-sandbox`（或以非 root 用户运行）。

## 下一步

每 10 分钟轮询 /coord/kv/member-config，出现 transport 为 http 的配置后按第 3 版指令接入。
