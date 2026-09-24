# 报告：渲染任务队列 M5a（网络层、集群令牌、服务地址登记、文档服务通用化）

集成分支 `claude/rq-m5a`。进行中。

- 计划：`docs/plan/Master-Execution-Plan.md` 第 5.4 节、第 7 节 M5a（主工作区，未入库）
- 契约：`docs/plan/render-queue-contract.md` G 节
- 语义：main `95f9aa7`（S1、S2 与文档服务定位，用户逐条确认后提交）

## 过程记录

### 2026-09-25 开工前

- 语义改动 ①～⑨：用户全部同意，授权提交 main，提交为 `95f9aa7`；已合进本分支（`8f1cbe7`）。
- 契约 G 节：`4d08114` 起草，`b17c50a` 定稿。用户授权自动推进，没有逐节审阅。
- 派出三个子 Agent：
  - `claude/rq-m5a-svc`：`opus-dev-high`，G.1～G.6；
  - `claude/rq-m5a-net`：`opus-dev-high`，G.7；
  - `claude/rq-m5a-tests`：`opus-dev`，G.8、G.9，只照契约写。

### W0 笔记本环境回报（2026-09-25）

Worker 会话「分布式工作节点握手」回执原文摘要：

| 项 | 笔记本 | 主 PC | 判定 |
|---|---|---|---|
| 系统 | Windows 11 企业版 10.0.26200，AMD64 | Windows 11 Pro 10.0.26200 | — |
| Node | v24.19.0，npm 11.17.0 | v24.19.0 | ≥ 22 ✓ |
| 仓库 | `D:\VectorMPEG7\PromptCut`，工作区干净，HEAD = origin/main = `9a95ed8` | origin/main `9a95ed8`，本地 main `95f9aa7`（未推送） | ✓ |
| node_modules | 不存在 | 存在 | 见下 |
| 控制面 `/healthz` | 可达：`{"ok":true,"service":"promptcut-docservice",…}` | — | ✓ |
| 局域网 | WLAN `192.168.50.247`，网关 `192.168.50.1` | 以太网 `192.168.50.96`，网关 `192.168.50.1` | 同一 /24 网段 ✓ |
| 互 ping | — | 主 PC ping 笔记本不通 | 多半是 Windows 挡了 ICMP，W2 用 HTTP 实测 |
| 权限模式 | bypassPermissions | bypassPermissions | 跨会话消息不会被挂起 ✓ |
| 环境指纹 | 跳过：没有 node_modules，没有 puppeteer | `258acaaa7c5fe509`（windows / software / Chrome 152） | 待补 |

**W0 引出的两件事**：

1. **笔记本没有 node_modules**。
   - W1 用的 e2e 探针只依赖 `server/render-queue/`、`server/render-node/` 和 `server/test/fake-*.mjs`，这些都只用 Node 内置模块，预计不需要安装；
   - W4 起在笔记本上跑真实预渲染要用 puppeteer，必须 `npm install`，属于安装，到时先问用户。
2. **两台机器的指纹很可能相同**。
   - 指纹只由 OS、GPU 类别、Chrome 主版本三项决定；
   - 预渲染 Chrome 带 `--disable-gpu`，GPU 类别恒为 `software`；
   - 两台都是 Windows，puppeteer 锁定的 Chrome 版本也相同，所以笔记本的指纹大概率也是 `258acaaa7c5fe509`。
   - 这样 M5b 的 E6、K1～K3 和 W4「两种指纹」的前提在真机上不成立。M5b 开工前要定一种做法：
     - 用 `FramePipeline` 可注入的 `environment` 在一台机器上模拟第二种指纹；
     - 或者笔记本改用不同的 Chrome 启动参数（例如开 GPU）。
   - 装好依赖后先实测确认。
