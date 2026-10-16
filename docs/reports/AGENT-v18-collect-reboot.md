# 0.7.18：采集代下打开、撤回接口与节点重启后任务槽自动接续

本报告记录分支 `gemini/v18-collect-reboot`（基线 `5ebefdfe`）完成的全部两项跨模块工程活：
1. **打开本机采集代下与 `web_handoff`**（`user-decisions-2026-10-14.md` 第 3.1 节第 110 行、第 5 节第 180 行）；
2. **节点重启后任务槽自动恢复**（跨 `boot_id` 自动接续），并将重启那一刻卡住的任务自动记为失败并释放（`user-decisions-2026-10-14.md` 第 3.1 节第 114 行）。

---

## 1. 做成了什么

### 1.1 采集代下打开、上传队列在途撤回与桌面提示条

- **补齐上传队列在途撤回接口**（`server/upload-queue.mjs`、`server/vite-plugin-media.ts`）：
  - 队列实例新增 `cancel(targets)` 方法：支持按素材 ID、原尺寸或小尺寸哈希撤回排队或正在上传的素材；若当前正在分片上传该素材，立即通过 `AbortController.abort()` 中止在途分片，移出内存队列并不计入失败重试，原子写回 `upload-queue.json` 并唤醒 `drain()` 等待者。
  - 服务端开放 `POST /api/media/upload-queue/cancel` 与 `DELETE /api/media/upload-queue/<hash>`：接收待撤回哈希列表，从上传队列撤回；对于成功从在途或队列中撤回的文件，将其从本地内容库（`out/media`）彻底删除并注销媒体索引（`forgetMediaIndex`）。
  - **已传完的文件严格不误删**（遵照 10-14 第 180 行）：已经在素材服务上 `complete` 并正常出队的文件，调用撤回时不属于队列项，不会被误删。
- **页面侧撤回联调与触发**（`src/ai/cloud/useCloud.ts`、`src/ai/cloud/collectBridge.ts`）：
  - 在 `src/ai/cloud/useCloud.ts` 中给桌面端 `desktopCollectUpload` 接入 `cancel` 接口；
  - 在 `src/ai/cloud/collectBridge.ts` 中，每当解析出下载文件哈希即记录在委托对象上。当云端取消委托（`collect_delegate_cancel`）、云端 30 秒失联超时（`abandoned`）、页面用户点「停止」（`abort`）、对话设为私有（`switchVisibility('private')`）或会话销毁时，当场调用 `upload.cancel` 撤回在途上传并删除临时文件。
- **桌面版代下醒目提示条**（`src/ai/cloud/collectBridge.ts`、`src/editor/TopBar.tsx`）：
  - 在 `collectBridge.ts` 中维护 `getActiveCollectDelegationUrl` 与 `subscribeActiveCollectDelegation`；
  - 在桌面版顶栏 `src/editor/TopBar.tsx` 中订阅该状态，在代下执行期间展示醒目提示条，原文严格为：**`「云端 Agent 正在用这台电脑上的登录下载：〈网址〉」`**；在下载完成、取消或失败后立即撤下。
- **缺省打开采集代下**（`PROMPTCUT_AGENT_COLLECT_DELEGATE`）：
  - 在 `server/agent-service/account-tool-settings.mjs`、`server/agent/service/account-tools.mjs`、`server/agent/service/cloud-tools.mjs` 中，将 `collectDelegate` 从「只有显式传 `1` 才开」改为**缺省开启**（只有显式配置 `0` 或 `false` 时才关闭）。
  - 同步更新提示词生成与单测用例。
- **`web_handoff` 按建议甲就绪**（10-14 第 110 行）：
  - 确认在账号模式下，当具备网页环境与反向通道时挂载 `web_handoff`；桌面版收到请求时自动调用 `webOpen` 打开云端当前网页，并在桌面端将浏览器交由本人操作，模型侧说明登录信息只保留在用户本机。

### 1.2 节点重启后任务槽自动恢复与中断任务记失败释放

- **支持跨 `boot_id` 见证与代际推进**：
  - 在 `server/hosted/deploy/asset-root-registry-publisher.mjs` 中，移除了在检测到跨开机时直接抛出 `fail('publisher-cross-boot-unsupported')` 的硬限制；并在 `createRootScopeRuntimeV2` 的 `pinPrevious` 中增加了 `crossBoot`（`currentBoot !== old.instance.bootId`）分支：由于内核层前一次开机的所有进程必然全灭，当跨 boot 时不再要求原 boot 下的 systemd 单元/cgroup 必须匹配，直接签发合法的 `kind: 'boot-transition'` 关闭见证并安全推进到新一代 `epoch + 1`，锚点链保持完整，无需人工换 `authorityId`、删目录或修改文档服务配置重跑 `--bootstrap`。
  - 在 `server/hosted/asset-root-registry-schema-v2.mjs` 与 `server/hosted/run-assets-current-registry.mjs` 中支持 `kind: 'boot-transition'` 关闭见证校验。
  - 在 `server/hosted/deploy/agent-run-scope-publisher.mjs` 与 `server/hosted/agent-run-scope-schema.mjs` 中移除了阻止跨 boot 启动新世代的限制，历史链验证中允许已关闭世代跨越不同的 `bootId`。
- **任务槽自动接续与卡住任务记失败释放**（`server/agent-service/account-root-slots.mjs`、`account-slot-scheduler.mjs`）：
  - 节点重启后 root 入口与槽调度重启，调度器 `adopt` 发现槽中留着上一代未结清实例（处于 `bound` 或 `ready`）；
  - 槽调度器检测到旧进程已死，自动调用 `observeFailure()` 写出跨 boot 的失败观察（`kind: 'boot-transition'`）；
  - 文档服务（`reconcileScopeFailures`）读取失败观察后，为卡住的 run 签发 `kind: 'worker-failed'` 强制终态；
  - 槽调度器接收到该强制终态后执行 `forcedClose`，记录跨 boot 见证，文档服务（`reconcileScopeClosures`）自动将卡住任务结清记为 **`failed`（`worker-failed`）** 并释放槽位与对话排队锁（不自动重发消息）；
  - 任务槽随即恢复为 `idle`，立即恢复可用并正常接下一条任务在新一代进程中顺利跑完。

---

## 2. 代码改动清单

| 模块 / 路径 | 变动内容 |
|---|---|
| `server/upload-queue.mjs` | `createUploadQueue` 新增 `cancel(targets)` 方法，支持移出指定/全部队列项；若正在上传则中止在途分片并不计入失败重试；原子更新 `upload-queue.json` 并唤醒等待者。 |
| `server/vite-plugin-media.ts` | 挂载 `POST /api/media/upload-queue/cancel` 与 `DELETE /api/media/upload-queue/<hash>` 路由，调用队列撤回并物理删除本地未登记的在途/排队文件并注销索引；已完整传完的文件不删除。 |
| `src/ai/cloud/collectBridge.ts` | 维护 `activeDelegationUrl` 状态及外部订阅；在委托实例中记录 `hashes`；在云端取消委托、失联超时、主动取消时触发 `upload.cancel`；新增 `cancelAllCollectDelegations`。 |
| `src/ai/cloud/useCloud.ts` | 为 `desktopCollectUpload` 接入 `cancel` 接口；在任务点停止（`abort`）、对话转私有（`switchVisibility`）及会话清理时调用 `cancelAllCollectDelegations` 取消在途代下与上传。 |
| `src/editor/TopBar.tsx` | 订阅 `getActiveCollectDelegationUrl`，在桌面端代下期间渲染醒目提示条 `「云端 Agent 正在用这台电脑上的登录下载：〈网址〉」`，结束或取消后自动撤除。 |
| `server/agent-service/account-tool-settings.mjs` | 更新 `PROMPTCUT_AGENT_COLLECT_DELEGATE` 注释与校验（允许 `0`、`1`、`false`、`true`）。 |
| `server/agent/service/account-tools.mjs` | `readAccountToolConfig` 中 `collectDelegate` 缺省改为 `true`（仅当显式设为 `'0'` 或 `'false'` 时关闭）；`createAccountToolset` 中 `delegateDownload` 同样缺省为开启。 |
| `server/agent/service/cloud-tools.mjs` | `cloudSystemNote` 参数 `collectDelegate` 缺省值改为 `true`。 |
| `server/hosted/deploy/asset-root-registry-publisher.mjs` | 移除 `publisher-cross-boot-unsupported` 异常；`createRootScopeRuntimeV2` 支持 `crossBoot` 跨开机检测，安全生成 `kind: 'boot-transition'` 的关闭/失败见证。 |
| `server/hosted/asset-root-registry-schema-v2.mjs` | `validateAssetRootWitnessV2` 兼容并校验 `kind: 'boot-transition'` 见证。 |
| `server/hosted/run-assets-current-registry.mjs` | `validateRunAssetCurrentRecord` 支持 `kind: 'boot-transition'` 见证。 |
| `server/hosted/deploy/agent-run-scope-publisher.mjs` | 移除 `publishAgentScope` 在 `start` 模式下要求世代必须同 `bootId` 的 `boot-transition` 阻止检查。 |
| `server/hosted/agent-run-scope-schema.mjs` | `validateAgentScopeClosure` 与 `validateAgentScopeFailure` 支持 `boot-transition`；`validateAgentScopeHistory` 移除跨世代必须同 `bootId` 的硬性约束。 |
| `server/test/upload-enqueue-existing.test.mjs` | 增加 `UQE-8`（测试队列 `cancel` 中止分片及移出队列）与 `UQE-9`（测试 `/api/media/upload-queue/cancel` 接口清理在途文件且不误删已完成文件）。 |
| `server/test/cloud-tools-wire.test.mjs` | 更新 `WIRE-TABLE` 与 `WIRE-SET` 测试用例，验证 `collectDelegate` 缺省开启、显式设为 `0` 或 `false` 关闭。 |
| `server/test/cloud-tools-c1-page.test.mjs` | 增加 `C1-PAGE-07`，验证桌面提示条状态随代下起止动态切换，且取消时当场调用 `upload.cancel`。 |
| `server/test/agent-run-scope-fixture.mjs` | `scopeModel` 增加 `reboot(newBootId)` 支持，模拟跨 boot 开机号变化与 `crossBoot` 关闭。 |
| `server/test/account-root-slots.test.mjs` | 增加重启自动恢复单测，验证节点重启后接手旧世代、写失败记录、文档服务签发 `worker-failed`、强制关闭并释放锁，新世代在新 boot 下顺利开跑。 |

---

## 3. 审查与自检证据

1. **类型检查**：
   - 运行 `npx.cmd tsc -b --force`，退出码 0，零错误。
2. **测试套件运行**：
   - 运行综合测试命令：
     ```powershell
     $env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
     $env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
     $env:PROMPTCUT_NO_PORT_FILE="1"
     node --test server/test/cloud-tools-c1*.test.mjs server/test/cloud-tools-w2*.test.mjs server/test/cloud-tools-wire.test.mjs server/test/account-root-slots.test.mjs server/test/upload-enqueue-existing.test.mjs server/test/c66-upload.test.mjs src/ai/cloud/page-requests.test.mjs server/test/agent-run-scope*.test.mjs server/test/asset-root-registry-publisher.test.mjs
     ```
   - **结果：共 228 项测试，226 项 PASS，0 项 FAIL，2 项 SKIP**（两项为 Windows 平台按规范跳过的 Linux 文件系统权限测试），零失败。
3. **行尾检查**：
   - 运行 `node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . 5ebefdfe HEAD`，输出为空，退出码 0，零行尾翻转。

---

## 4. 没做成的与原因

无。本分支分配的两项功能（代下与 web_handoff 打开 + 在途撤回接口与提示条，以及节点重启后任务槽跨 boot_id 自动恢复与卡住任务记失败释放）均已高质量落地并通过全量相关测试验证。

---

## 5. 我做的裁定与要主会话决定的事

1. **撤回接口的删除策略（裁定）**：
   在 `POST /api/media/upload-queue/cancel` 撤回在途分片并从队列移除时，根据 `upload-queue` 实际出队的 `cancelled` 列表精确定位待删除文件。由于传完的文件在 complete 成功那一刻已从队列移出，故传完的文件绝不会被当作在途撤回而删除，严格遵循 10-14 第 180 行原则。
2. **桌面提示条视觉呈现（裁定）**：
   提示条文案严格遵循需求原文 `「云端 Agent 正在用这台电脑上的登录下载：〈网址〉」`，放置在 `TopBar.tsx` 的同步状态区域旁，采用半圆胶囊状柔和蓝底背景与省略号截断（最大宽度 420px），并附带全量 URL 的 `title` 气泡提示，兼顾醒目度与不挤占顶栏操作空间。
3. **跨 boot 见证模式（裁定）**：
   在发布器见证中，当检测到 `currentBootId !== old.instance.bootId` 时将 `observed.kind` 标为 `'boot-transition'`，同时携带 `previousBootId` 与 `currentBootId`。此举不仅让验证端能够清晰审计出这是一次由于系统关机/重启引发的代际交接，而且在数学证明和哈希链条上完全自洽闭环。
