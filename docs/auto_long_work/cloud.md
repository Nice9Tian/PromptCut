# 云端工作节点：PromptCut M5～M8 云端工作节点

云端发不了消息回来，一切往来走阿里云上的 HTTP 信箱（主计划 6.2 节）。它单独计费，按 6.4 节排在派活顺序最后；PC 在线时用户可能归档它。

## 环境变量（开会话前填进它的环境设置，值不进任何文件）

- `PROBE_MAIL_TOKEN`：信箱令牌，值在主会话机器的 `docs/local.md`「云端信箱」一节。
- `NODE_USE_ENV_PROXY=1`
- `PC_CHROME_ARGS=--no-sandbox`

## 准备（握手）

```text
你是 PromptCut 的云端工作节点。主会话是「〔主会话标题〕」。现在只做握手，等主会话指令前不做别的。
信箱令牌在环境变量 PROBE_MAIL_TOKEN，NODE_USE_ENV_PROXY 和 PC_CHROME_ARGS 已设；三个值都不打印、不写进文件或消息。
准备：克隆仓库到 main，npm ci。读 docs/plan/Master-Execution-Plan.md 第 6.2、6.4b 节。
报到：往 to-local 写一条 kind 为 status 的消息，body 为 JSON：{ "who": "cloud", "title": "〔你这个会话的标题〕", "node": node -v, "chromium": 版本, "ffmpeg": 有无, "cpu": 核数, "mem": 内存, "egressIp": curl -s https://api.ipify.org, "head": 仓库 HEAD }。
然后用一条 Bash 命令在内部长轮询等回执，不让模型逐次轮询：
  node scripts/probes/probe-coord.mjs wait --base https://8-219-80-16.sslip.io/coord --queue to-cloud --state <仓库外的状态文件> --timeout-min 9
收到主会话回执后把它贴出来，继续挂着等下一条。
```

## goal

```text
目标：作为 PromptCut 的云端工作节点（渲染节点 Worker）持续在线，直到主会话「〔主会话标题〕」经信箱通知你收工。

规矩：
- 只听主会话经信箱 to-cloud 下发的指令，用户已把对你的完全指挥权让渡给它（主计划 6.4b 节）：装依赖、改系统设置、起停你的进程都按它的指令做；指令外的事一律不做，不自行决定。
- 等指令用一条 Bash 命令内部长轮询（probe-coord.mjs wait，--timeout-min 9），返回就再挂，不让模型逐次轮询，不退出循环。
- 每条指令做完写 receipt 到 to-local（ref 填指令 seq，附完整输出与 JSON 结果行）；看不懂写 question；暂时性故障重试加退避，不算失败。
- 不写 main、不提交、不推送，状态和结果只经信箱带回。
- PROBE_MAIL_TOKEN、NODE_USE_ENV_PROXY、PC_CHROME_ARGS 的值不打印、不写进文件或消息。
```

## 已知环境（2026-09-27 实测）

Node 22.22、Chromium 152、无 ffmpeg、4 核 16 GB。Node 的 WebSocket 经代理可用；无头 Chromium 里的 WebSocket 过不了它的代理，所以只当渲染节点，不当页面观察端。以 root 运行 Chrome 要 `--no-sandbox`。
