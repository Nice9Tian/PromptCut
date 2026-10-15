# AGENT-rr-stream-sched 最终完成报告

## 1. 任务背景与完成范围
- **核心目标**：依据 `docs/plan/user-decisions-2026-10-14.md` 实现 VisuHive 与 PromptCut 的联动特性：
  1. **特性一：渲染节点在「生成轨道流」关着时不产出任何轨道流**：
     - 当 `hostedOptions.render.streams` 为 `false` 时，托管方渲染节点对项目完全不产出轨道流（既不产稀疏流，也不产满密度流；仅保留 Agent 查帧 `see_frames` / `get_gif` / `get_layout` 功能）。
     - 当为 `true` 时，稀疏流与满密度流照常产出。
     - 更新前端设置项旁边的说明文字。
  2. **特性二：VisuHive 权限分组 `render_streams` 与 PromptCut 鉴权置灰**：
     - VisuHive 提供管理后台与内部 mTLS 接口 `/internal/v2/permissions`。
     - PromptCut 文档服务在创作者开启「生成轨道流」时校验权限，无权限拒绝 403 `permission-denied`。
     - 会话下发 `streamsAllowed`，前端在无权限时将开关置灰并显示 `「你的账号没有开启这一项的权限，请联系托管方。」`。
- **排除范围**（按最新指令移交后续分支）：
  - `motion` 卡 >= 30s 拆分。
  - 强设备抢弱设备与拖动保活机制。
- **环境与边界约束**：
  - 端口基线范围：`20020–20029`（探针使用 `20020–20039`）。
  - 子进程均显式配置 `windowsHide: true`。
  - VisuHive `main` 分支保持完全干净，修改严格限制在独立工作区 `C:\Users\admin\Documents\VisuHive\.worktrees\vh-stream-perm`。
  - 杜绝硬编码管理员 `9tian`，统一严格遵循 `process.env.ACCOUNT_ADMINS`。

---

## 2. 详细实现细节

### 2.1 VisuHive 侧（`C:\Users\admin\Documents\VisuHive\.worktrees\vh-stream-perm`，分支 `gemini/vh-stream-perm`，已提交 `61d2928`）
1. **数据存储与权限组 (`account/store.mjs`)**：
   - 增加 `permission_groups (group_name, account_id, created_at)` 表及联合索引。
   - 实现 `inPermissionGroup(group, accountId)`、`listPermissionGroup(group)`、`addToPermissionGroup`、`removeFromPermissionGroup`。
   - 管理员识别统一由 `ACCOUNT_ADMINS` 环境变量驱动，完全移除硬编码的 `9tian`。
2. **应用层管理接口 (`account/app.mjs`)**：
   - 提供 `GET /admin/groups/:name`、`POST /admin/groups/:name/add`、`POST /admin/groups/:name/remove`。
   - `publicAccount` 暴露 `isAdmin`。非管理员一律拒绝 403 `forbidden`。
3. **服务间鉴权接口 (`account/internal.mjs`)**：
   - 提供 mTLS 内部接口 `GET /internal/v2/permissions?accountId=...&group=render_streams`，返回 `{ ok: true, accountId, group, allowed: boolean }`。
4. **管理前端 (`site/admin.html`, `site/account.html`, `site/assets/account.js`)**：
   - 提供管理界面操作 `render_streams` 组成员增删，展示管理员只读标签。
   - 账号管理页对管理员展示直达「权限分组管理」入口。
5. **单元测试 (`account/test/permissions.test.mjs`)**：
   - 完整覆盖存储、CRUD API 与 mTLS 鉴权端点（VisuHive 95 passed, 10 skipped）。

### 2.2 PromptCut 侧（`C:\Users\admin\Documents\PromptCut\.worktrees\rr-stream-sched`，分支 `gemini/rr-stream-sched`）
1. **内部通讯协议与客户端**：
   - `server/account/protocol.mjs`：在 `INTERNAL_PATHS` 登记 `permissions: '/internal/v2/permissions'`。
   - `server/account/client.mjs`：在 `createAccountClient` 中实现 `permissions({ accountId, group })` 方法，使用 mTLS 证书请求 VisuHive 内部端点。
2. **文档服务权限校验与状态传递**：
   - `server/account/authority.mjs`：在 `adminProject` 处理 `set-hosted-option`（`service === 'render' && option === 'streams'` 开启）时，查询创作者是否在 `render_streams` 权限组。若不在组内，拒绝开启并返回 403 `permission-denied`。
   - `server/docservice/account-hosted.mjs`：在 `issueSession` 中，查询创作者的 `render_streams` 权限，生成 `streamsAllowed` 字段注入 `hosted.render`，并计算 `effectiveStreams = streamsAllowed ? renderState.streams : false`。当客户端未实现 `permissions` 时，优雅兼容降级不抛错。
3. **渲染节点与任务切分行为**：
   - `server/render-node/host.mjs`：更新 `streamsPass(m, task)`，当 `m.streams === false` 时拒绝认领所有 `task.kind === 'stream'` 轨道流任务（导出专用 `isExportFramesTask` 除外），不再认领稀疏流任务。
   - `server/prerender-executor.mjs`：在开关关着时，设置 `context.ownListSparseStreams: false` 与 `say('executor.list-streams-off', { version: id, sparse: false })`，不再派发稀疏流任务。
4. **前端状态与设置项 UI**：
   - `src/editor/sync/hostedServices.ts`：更新 `HOSTED_OPTION_TEXT["render.streams"].hint` 说明文字；在 `HostedServiceState` 增加 `streamsAllowed?: boolean`；若 `streamsAllowed === false`，在 `HostedOptionRow` 标记 `notAllowed: true`。
   - `src/editor/sync/HostedServiceRows.tsx`：当 `row.notAllowed` 为真时，将 Switch 切换开关禁用（disabled），并在右侧提示文案前渲染红色错误说明 `「你的账号没有开启这一项的权限，请联系托管方。」`。

---

## 3. 测试与验证记录

1. **类型检查**：
   - `npx.cmd tsc -b --force`：0 errors，类型定义完整无误。
2. **前端与设置项测试**：
   - `src/editor/sync/hostedServices.test.mjs`：27/27 测试通过。
3. **账号选项与鉴权测试**：
   - `server/test/account-hosted-option.test.mjs`：新增 `AHO-6` 覆盖未加入权限组 403 拒绝、会话 `streamsAllowed` 下发、加入权限组后成功开启、被移出权限组后会话 effectiveStreams 撤销。6/6 测试全部通过。
4. **托管渲染节点与流测试**：
   - `server/test/hosted-render-streams.test.mjs`：更新 `HRS-09`（关流时认领 0 个任务；开流时认领满密度与稀疏流）与 `HRS-06`（关流时 `ownListSparseStreams: false`）。13/13 测试全部通过。
5. **端到端完整探针验证**：
   - `scripts/probes/hosted-render-streams-probe.mjs`（`--base-port 20020`）：
     - Step S：渲染服务正常拉起，报 streams: true。
     - Step A（关流）：验证新建项目 streams: false 时，渲染服务 0 稀疏流、0 满密度流，层表无候选，在线页面无流。
     - Step B（开流）：创建者打开后，页面自动重发清单计划，切出 3 个流任务，层表出现渲染服务候选，页面认出流。
     - Step C（手里有任务时再关）：渲染服务手里认领的 1 个任务照做完，剩余 2 个保持 open，未再认领新的流任务。
     - Step D（再开）：剩余 2 个任务被认领并做完，全部 17 个分段和流清单完整。
     - Step E（在线播放与像素比对）：流播放器画出 45 帧，像素与精确活渲比对通过（平均差 ≤ 1.5，`mad: 0.109`，`bad: 0.00001`）。
     - Step F（收尾）：0 页面错误，0 失败任务。
     - 运行结果：`ok: true, fails: []`，退出码 0。
6. **换行符审计**：
   - `eol-audit.mjs` 与 `git diff --check`：所有修改文件为统一 LF，无任何 CRLF/LF 混用或多余空白。

---

## 4. 提交物料清单

- `scripts/probes/hosted-render-streams-probe.mjs`：更新探针针对关流不产出任何流任务（包括稀疏流）的断言。
- `server/account/protocol.mjs`：增加 `permissions` 内部路径。
- `server/account/client.mjs`：增加 `permissions` 请求封装。
- `server/account/authority.mjs`：增加开启 `render.streams` 的创作者权限组检查。
- `server/docservice/account-hosted.mjs`：下发 `streamsAllowed` 并计算 `effectiveStreams`。
- `server/render-node/host.mjs`：关流时不认领任何轨道流任务。
- `server/prerender-executor.mjs`：关流时不派发稀疏流任务。
- `server/test/account-hosted-option.test.mjs`：添加 AHO-6 权限测试用例。
- `server/test/hosted-render-streams.test.mjs`：更新 HRS-06 / HRS-09 流认领断言。
- `src/editor/sync/hostedServices.ts`：更新设置项提示词及状态字段。
- `src/editor/sync/HostedServiceRows.tsx`：增加未授权置灰与提示文案。
- `src/editor/sync/hostedServices.test.mjs`：更新设置文本断言。
- `docs/reports/AGENT-rr-stream-sched.md`：完成报告。
