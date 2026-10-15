# AGENT-rr-stream-sched 工作进展与收尾报告

## 1. 任务背景与最新范围调整
- **原定目标**：依据 `docs/plan/user-decisions-2026-10-14.md` 实现四项内容（托管节点关流时不产出、权限分组 `render_streams` 与管理后台、`motion` 卡拆分 >= 30s、强设备抢弱设备与拖动保活）。
- **最新紧急指令调整**：
  1. 范围缩减为前两项：
     - ① 「生成轨道流」关着时，托管方渲染节点对项目什么都不产（稀疏与满密度均不产）；更新设置文字。
     - ② 「生成轨道流」权限分组 `render_streams` 与 VisuHive 管理后台及 PromptCut 鉴权置灰。
  2. 原第 3、4 项（`motion` 卡拆分与强设备抢占）取消，移交给后续分支。
  3. 严格遵守工作区隔离：VisuHive 所有修改仅在独立工作区 `C:\Users\admin\Documents\VisuHive\.worktrees\vh-stream-perm`（分支 `gemini/vh-stream-perm`）进行；VisuHive 主目录始终停留在 `main` 分支保持干净。

---

## 2. 当前已完成的工作

### VisuHive 侧（`C:\Users\admin\Documents\VisuHive\.worktrees\vh-stream-perm`，分支 `gemini/vh-stream-perm`）
1. **数据模型与权限组存储 (`account/store.mjs`)**：
   - 增加表 `permission_groups (group_name, account_id, created_at)` 及相应索引。
   - 实现管理员默认判定逻辑 `adminUsernames()` / `isAdminName(name)`（默认管理员 `9tian`，支持环境变量 `ACCOUNT_ADMINS`）。
   - 实现组检查 `inPermissionGroup(group, accountId)`：默认管理员默认拥有 `render_streams` 权限。
   - 实现组列表查询 `listPermissionGroup(group)`：返回所有组内成员，并动态包含平台管理员。
   - 实现成员增删 `addToPermissionGroup`、`removeFromPermissionGroup`（保护默认管理员不被移出）。
2. **应用层管理接口 (`account/app.mjs`)**：
   - `publicAccount(a)` 增加 `isAdmin: boolean`。
   - 新增管理接口：
     - `GET /admin/groups/:name`：管理员查看成员列表。
     - `POST /admin/groups/:name/add`：管理员通过账号名、邮箱或账号 ID（`acc_...`）添加成员。
     - `POST /admin/groups/:name/remove`：管理员移出成员（保护管理员）。
     - 非管理员请求一律返回 403 `forbidden`。
3. **服务间鉴权接口 (`account/internal.mjs`)**：
   - 增加内部 mTLS 接口 `GET /internal/v2/permissions?accountId=...&group=render_streams`，供 PromptCut 文档服务调用校验创作者权限。
4. **前端管理页面与导航 (`site/admin.html`、`site/account.html`、`site/assets/account.js`)**：
   - 新建 `site/admin.html` 管理页面，支持展示 `render_streams` 组成员、添加与移除成员。
   - `site/assets/account.js` 接入 `pages.admin` 页面控制器，表单提交防重与 CSRF 保护。
   - `site/account.html` 在账号为管理员时展示跳转「权限分组管理」的入口。
5. **单元测试 (`account/test/permissions.test.mjs`)**：
   - 编写了完整的权限组存储测试、管理员接口测试及内部 mTLS 接口测试。

---

## 3. 停在哪一步 / 还剩什么没做

因收到用户电脑即将重启的紧急收尾指令，当前在以下步骤暂停：
1. **PromptCut 侧对接（待执行）**：
   - `server/render-node/host.mjs`：当 `hostedOptions.render.streams` 为 false 时，完全不产出轨道流。
   - `server/account/client.mjs` & `server/account/authority.mjs` & `server/docservice/account-hosted.mjs`：接入 VisuHive 的 `/internal/v2/permissions` 接口。创作者无权限时拒绝开启并返回 403；向前端提供 `streamsAllowed` 状态。
   - `src/editor/sync/hostedServices.ts` & `HostedServiceRows.tsx`：更新说明文字；无权限时开关置灰并显示 `「你的账号没有开启这一项的权限，请联系托管方。」`。
2. **验证与探针（待执行）**：
   - 运行 PromptCut 探针 `node scripts/probes/hosted-render-streams-probe.mjs --base-port 20020`。
   - 运行 PromptCut 全量单测与权限集成单测。

---

## 4. 测试与验证状态
- **VisuHive 侧**：
  - 基线全部通过（95 pass, 10 skipped）。
  - 新增测试 `account/test/permissions.test.mjs` 已编写就绪。
- **PromptCut 侧**：
  - `npx.cmd tsc -b --force` 构建基线正常（0 errors）。
  - 探针 `hosted-render-streams-probe.mjs` 尚未在本分支执行。

---

## 5. 工作区与提交说明
- `C:\Users\admin\Documents\VisuHive` 主目录保持在 `main` 分支，工作区完全干净。
- `C:\Users\admin\Documents\VisuHive\.worktrees\vh-stream-perm` 上的变更已准备好提交至 `gemini/vh-stream-perm`。
- `C:\Users\admin\Documents\PromptCut\.worktrees\rr-stream-sched` 上的本报告已准备好提交至 `gemini/rr-stream-sched`。
