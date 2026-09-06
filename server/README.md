# PromptCut 服务端 

此目录包含 AI 助手后端集成，包括 Vite 插件、MCP 服务和 STT 集成。

## 端点
* `GET /api/ai/providers[?refresh=1]` - 返回 `{ ok, providers, stt }`。获取可用的运行器及 STT 状态。`providers` 中的每一项现在多包含一个 `auth` 字段（形状为 `{ loggedIn: true|false|null, detail?, fixHint?, loginCommand? }`，数据来自 `server/runners/auth.mjs` 的 `probeAuth` 探测，结果默认缓存 10 秒）。加上 `refresh=1` 查询参数可跳过 provider 缓存（5 秒）和 auth 缓存（10 秒）。列表除了三大 CLI，还固定包含第四项 `id` 为 `api`（API 直连）；若 `server/runners/api.mjs` 缺失，它是 `available: false` 加 `note` 为 "api runner 缺失" 的占位项。
* `POST /api/ai/login` - 接收 `{ provider, deviceAuth? }`，返回 `{ ok, job }`。后台运行官方登录命令，必要时打开浏览器；不弹命令行。Antigravity 使用独立 ConPTY 子进程执行 `models`，不进入 TUI 或 Trust 界面。退出后再次验证认证，只有验证通过才标记成功。
* `POST /api/ai/install` - 接收 `{ provider, dryRun? }`。Windows 下后台运行三家官方原生安装器，无需用户预装 npm。下载脚本重试、进程超时、退出码和安装后的可执行文件验证均纳入任务状态。
* `GET /api/ai/setup` - 返回 `{ ok, jobs }`，每家最多一个活动任务。状态为 `running / succeeded / failed`；携带进度、安装日志、必要的官方登录链接或设备码。关闭设置窗口后任务继续，重新打开会恢复进度。原始登录输出不会返回或落盘。
* `DELETE /api/ai/setup` - 接收 `{ provider }`，停止该任务的进程树，退出后可重试。设置写入端点只接受 JSON，并拒绝跨来源请求。
* `GET /api/ai/config` / `POST /api/ai/config` - 读写 `%LOCALAPPDATA%\promptcut\ai.json`（测试时可通过环境变量 `PROMPTCUT_AI_CONFIG` 覆盖路径）。**返回值里的 `apiKey` 永远是 `{ set, last4 }` 的脱敏结构，绝不回显原文。** POST 接收部分更新配置对象，进行深合并；`apiKey` 传空串或缺失时保持原值，传 `null` 则清空。其中 `vendor` 仅支持 `anthropic`/`openai`/`gemini`，`baseUrl` 必须是 HTTP/HTTPS 地址或留空，`defaultProvider` 仅支持 `claude`/`agy`/`codex`/`api`/`null`，非法参数返回 400。非 GET/POST 请求返回 405。
* `GET /api/ai/machine-code` - 返回 `{ ok, code }`,形如 `PCM-4HNS5-DRRD0-S1Z7S-S15ZQ`。这台机器的识别码,由机器级标识(Windows 取 MachineGuid,macOS 取 IOPlatformUUID,Linux 取 machine-id,都取不到就退回主机名+平台+网卡)做 SHA-256 后取 Crockford Base32 前 20 位。**只返回摘要,原始指纹不出服务端。**
* `GET /api/ai/agy-permissions` / `POST /api/ai/agy-permissions` - 读写 agy 的权限配置文件（默认 `~/.gemini/antigravity-cli/settings.json`，可通过环境变量 `PROMPTCUT_AGY_SETTINGS` 覆盖）。GET 请求返回 `{ path, total, granted, missing }`。POST 请求将 `missing` 列表全部加入 `permissions.allow` 数组并保存，返回 `{ path, added, total }`。非 GET/POST 请求返回 405。
* `POST /api/ai/chat` - 发送 AI 对话请求（SSE 流式响应）。
* `POST /api/ai/abort` - 中止指定的对话请求。
* `GET /api/mcp/events` - 编辑台连接到 MCP 的 SSE 事件流。
* `POST /api/mcp/result` - 编辑台返回的 MCP 工具执行结果。
* `POST /api/mcp/call` - MCP server 向编辑台请求工具调用。
* `GET /api/mcp/status` - 获取当前 MCP 连接状态（调试用）。

## 登录状态探测（server/runners/auth.mjs）
- Claude：以 `claude auth status` 的 JSON 为准。
- Codex：合并 stdout/stderr 读取 `codex login status`。安装、登录和执行统一使用 `%LOCALAPPDATA%\promptcut\cli\codex-home`，不会修改 Codex 桌面应用的配置或凭据。用户需在 PromptCut 内登录一次。
- Antigravity：以后台 `agy models` 成功返回模型列表确认连接。未登录时通过隐藏 ConPTY 完成 OAuth，界面只显示浏览器授权入口。

CLI 管理目录默认为 `%LOCALAPPDATA%\promptcut\cli`，测试可通过 `PROMPTCUT_CLI_HOME` 覆盖。检测每次重新解析实际路径，支持用户目录、官方安装路径、npm shim 和 PATH。npm shim 优先由软件自带 Node 直接执行其包入口，以保留含中文、空格和 JSON 的参数。

后台登录依赖 `node-pty`，桌面打包流程会验证其原生组件可用。开发时修改 server/runners 的 mjs 后应完整重启服务（Node 动态 import 存在模块缓存）。

验证：`node --test server/test/cli-setup.test.mjs`、`node server/runners/agy-login.mjs --self-test`、`npm run build`。

官方参考：[Claude 安装](https://code.claude.com/docs/en/setup)、[Codex 命令](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[Antigravity 安装与认证](https://www.antigravity.google/docs/cli/install/)。

## 配置文件 ai.json
默认存储于 `%LOCALAPPDATA%\promptcut\ai.json`。它的完整形状如下：
```json
{
  "version": 1,
  "defaultProvider": null,
  "toolProtocol": false,
  "api": {
    "vendor": "anthropic",
    "baseUrl": "",
    "apiKey": "",
    "model": "",
    "maxTokens": 4096
  }
}
```
**强调**：`apiKey` 仅存在于服务端进程内存中使用，绝不写入普通日志、绝不出现在事件流中，也绝不通过任何接口回显给前端。

## 端口发现顺序
1. 环境变量 `PROMPTCUT_PORT`。
2. `%TEMP%\promptcut\port.json`。该锁文件现在除了 `port` 外还带有 `host` 字段（桥实际监听地址，`::` 或 `0.0.0.0` 会被规范化成 `127.0.0.1`）。`mcp-server.mjs` 调用桥的探测请求地址顺序为：锁文件 `host` → `127.0.0.1` → `[::1]` → `localhost`，**并且只有遇到 ECONNREFUSED 才会回退至下一个地址**。为避免因 Windows 系统下 `localhost` 可能只解析到 IPv6 `::1` 导致双栈连接失败，`server/vite.ai.config.ts` 已强制将 `server.host` 固定成 `127.0.0.1`。
3. 默认 5177。

## 运行测试
- `node server/test/auth-smoke.mjs`：打印三家登录探测结果，并使用临时文件测试 `ai-config` 的读写与密码脱敏机制。完全离线进行，不消耗任何额度和网络。
- `node server/test/mcp-smoke.mjs`：**自包含端到端** 冒烟测试。如果 5196 端口上没有桥，它会自行使用 `node node_modules/vite/bin/vite.js --config server/vite.ai.config.ts` 启动一个，等待就绪后依次执行 `initialize` / `tools/list` / 编辑台未连 / 编辑台已连（自动拉起 `server/test/fake-editor.mjs`）四组用例，收尾使用 `taskkill` 把自己起的 vite 整棵进程树杀掉并确认 5196 端口释放。如果 5196 上已经有桥则直接复用，**测试后不杀进程**。当环境变量 `PROMPTCUT_SMOKE_NO_BRIDGE=1` 时，可跳过起桥过程（此时仅跑前两组用例加断桥情况下的错误文本验证）。
  期望输出（启动桥，并且拉起编辑器的情况）：
  ```
  PASS: initialize
  PASS: tools/list
  PASS: tools/call (bridge up, editor down)
  PASS: tools/call (bridge up, editor up)
  ALL PASS
  [cleanup] 5196 已释放
  ```
- `node server/test/p1-verify.mjs`：第七轮的综合端到端验证测试，用于确保主线任务能够成功跑通。

## 环境变量开关
- `PROMPTCUT_AI_FAKE_RUNNER`: 设为 `1` 时，强制加载内置的 `server/test/fake-runner.mjs`（用于测试流程，避免消耗真实 API 的 Token）。
- `PROMPTCUT_AI_RUNNER_MODULE`: 指定动态加载 runner 的路径（默认 `./runners/index.mjs`）。如果指定的 runner 加载失败或不存在，调用接口将返回 503 错误，并说明 Runner 未就绪。
- `PROMPTCUT_AI_CONFIG`: 覆盖默认的配置文件路径，指定自定义的 `ai.json` 路径，用于测试。
- `PROMPTCUT_AGY_SETTINGS`: 覆盖 agy 的 settings.json 路径，用于测试权限相关功能。
- `PROMPTCUT_SMOKE_NO_BRIDGE`: 设为 `1` 时，在 `mcp-smoke.mjs` 测试中不自动启动 Vite 测试桥。

## 语音识别（STT）配置
引擎按以下顺序优先级选择：
1. 环境变量 `PROMPTCUT_STT_CMD`。
2. `%LOCALAPPDATA%\promptcut\stt.json` 里的 `cmd` 字段。
3. 自动检测 `cuda_Vit` conda 环境中的 `faster-whisper`。
4. 若未找到，默认提示需安装 `faster-whisper`。

## API 配置的加密分发与落盘加密

两处用的是同一套信封:PBKDF2-SHA256(60 万轮,轮数写在密文头里)+ AES-256-GCM,只有口令和 AAD 不同。

**分发**(`src/ai/configShare.ts`,前缀 `PCAI1.`,AAD `PromptCut-api-share-v1`)
接收方在「AI 设置 → API 直连 → 导入分发来的配置」里拿到本机识别码发给分发方;分发方加密后把密文发回去;接收方粘贴后本机自动解开并写入配置。分发方有两个等价的工具,产出的密文可以互相解开:双击根目录的 `make-api-share.bat` 打开 Rust 图形界面(`tools/api-share-gui`,首次运行会自动 `cargo build --release`),或者跑 `tools/make-api-share.py`(需要 `pip install cryptography`,适合脚本化)。密文里带可选的 `note` 和 `expiresAt`,过期的拒绝导入。识别码抄错大小写、漏掉分隔符、把 0 抄成 O 都能容错,聊天软件插的换行也会被去掉。**软件里只有接收侧,没有制作侧**——制作密文是分发方自己的事。

**落盘**(`server/runners/config-crypt.mjs`,前缀 `PCENC1.`,AAD `PromptCut-config-at-rest-v1`)
`ai.json` 里的 `apiKey` 以密文存储,口令是本机指纹。`readConfig()` 读出来就解开,`writeConfig()` 写进去前加密,所以下游(providers、`publicConfig`)一行都不用改。老配置里的明文 Key 原样读出,下次写入时自动转成密文;解不开(比如把配置拷到别的机器)按「没设 Key」处理,不抛错。

**这套东西挡什么、不挡什么**:挡的是明文在传输和磁盘上裸奔——邮件、聊天记录、同步盘、备份、误提交、截屏,以及密文被转发给第三个人(他机器码不同,解不开)。**挡不住**能在这台机器上以你的身份跑代码的人:口令由机器自己算出,推导逻辑随软件发出去。要更硬的保护应上 Windows DPAPI / macOS Keychain 这类由操作系统托管密钥的方案。真正的用量控制还得靠 API 侧的配额与轮换。

三份实现(TypeScript / Python / Rust)必须逐字节兼容。Rust 侧的测试里钉了一条由 TypeScript 生成的基准密文,跑偏了 `cargo test` 就会红;反向核对用 `cargo test --release -- --ignored --nocapture` 打印一条 Rust 生成的密文,再喂给另外两边解。

验证:`node --test server/test/config-share.test.mjs server/test/config-crypt.test.mjs server/test/machine-id.test.mjs`、`python tools/make-api-share.py --self-test`、`cd tools/api-share-gui && cargo test`。
