# PromptCut 服务端 

此目录包含 AI 助手后端集成，包括 Vite 插件、MCP 服务和 STT 集成。

## 端点
* `GET /api/ai/providers[?refresh=1]` - 返回 `{ ok, providers, stt }`。获取可用的运行器及 STT 状态。`providers` 中的每一项现在多包含一个 `auth` 字段（形状为 `{ loggedIn: true|false|null, detail?, fixHint?, loginCommand? }`，数据来自 `server/runners/auth.mjs` 的 `probeAuth` 探测，结果默认缓存 10 秒）。加上 `refresh=1` 查询参数可跳过 provider 缓存（5 秒）和 auth 缓存（10 秒）。列表除了三大 CLI，还固定包含第四项 `id` 为 `api`（API 直连）；若 `server/runners/api.mjs` 缺失，它是 `available: false` 加 `note` 为 "api runner 缺失" 的占位项。
* `POST /api/ai/login` - 接收体 `{ provider }`。调用可见的控制台窗口起该 provider 的登录命令（内部通过 `cmd /c start "PromptCut 登录" cmd /k <登录命令>` 拉起，`windowsHide` 为 `false`，是全项目唯一例外）。当 provider 不认识或 CLI 没装时返回 400。调用成功返回 `{ ok: true, hint }`。**注意：本工具只负责把登录窗口打开，实际的登录过程由用户自己在浏览器/控制台中完成。**
* `GET /api/ai/config` / `POST /api/ai/config` - 读写 `%LOCALAPPDATA%\promptcut\ai.json`（测试时可通过环境变量 `PROMPTCUT_AI_CONFIG` 覆盖路径）。**返回值里的 `apiKey` 永远是 `{ set, last4 }` 的脱敏结构，绝不回显原文。** POST 接收部分更新配置对象，进行深合并；`apiKey` 传空串或缺失时保持原值，传 `null` 则清空。其中 `vendor` 仅支持 `anthropic`/`openai`/`gemini`，`baseUrl` 必须是 HTTP/HTTPS 地址或留空，`defaultProvider` 仅支持 `claude`/`agy`/`codex`/`api`/`null`，非法参数返回 400。非 GET/POST 请求返回 405。
* `GET /api/ai/agy-permissions` / `POST /api/ai/agy-permissions` - 读写 agy 的权限配置文件（默认 `~/.gemini/antigravity-cli/settings.json`，可通过环境变量 `PROMPTCUT_AGY_SETTINGS` 覆盖）。GET 请求返回 `{ path, total, granted, missing }`。POST 请求将 `missing` 列表全部加入 `permissions.allow` 数组并保存，返回 `{ path, added, total }`。非 GET/POST 请求返回 405。
* `POST /api/ai/chat` - 发送 AI 对话请求（SSE 流式响应）。
* `POST /api/ai/abort` - 中止指定的对话请求。
* `GET /api/mcp/events` - 编辑台连接到 MCP 的 SSE 事件流。
* `POST /api/mcp/result` - 编辑台返回的 MCP 工具执行结果。
* `POST /api/mcp/call` - MCP server 向编辑台请求工具调用。
* `GET /api/mcp/status` - 获取当前 MCP 连接状态（调试用）。

## 登录状态探测（server/runners/auth.mjs）
该模块负责对 CLI 提供方进行登录状态探测。以下为实测结论：
- **Claude**：执行 `claude auth status` 探测。由于退出码是 1 但 `stdout` 仍是有效的 JSON，所以实现直接忽略退出码而采用 JSON 解析验证。实测返回 `loggedIn: false`。对应的 `loginCommand` 为 `['claude', 'auth', 'login']`。
- **Codex**：执行 `codex login status` 探测。由于本机 `config.toml` 第 5 行的 `model_reasoning_effort` 不兼容导致加载失败，实测返回 `loggedIn: null` 且提示 `fixHint`。我们绝不自动修改用户配置，需由用户自行修复。对应的 `loginCommand` 为 `['codex', 'login']`。
- **Agy**：由于 agy 没有检查登录状态的命令（且其首次未登录时会自动打开浏览器），因此始终返回 `loggedIn: null`。对应的 `loginCommand` 为 `['agy']`。

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
