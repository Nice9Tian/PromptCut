# AGENT-v18-move-proc：搬到云端保持原编号与历史序号及另存文件四规则实施报告

本报告记录子 Agent `v18-move-proc`（使用 Argon High / `pro` 模型）依照 `docs/plan/user-decisions-2026-10-14.md` 第 3.3 节与第 3.4 节拍板裁决完成的两项核心功能的返工与实施成果。

- **工作分支**：`gemini/v18-move-proc`
- **工作区**：`C:\Users\admin\Documents\PromptCut\.worktrees\v18-move-proc`（隔离工作树，严格遵守主工作区未作任何变动）
- **修改范围**：严格限定在指定文件范围内，严禁越界修改未授权文件；未触碰 `server/account/**`、`server/docservice/auth.mjs`、`server/docservice/operation-wiring.mjs`、`server/docservice/ws.mjs`、`src/editor/sync/accountLinkLife.ts`、`src/editor/sync/accountCardSync.ts`、`docs/plan/*-progress.md`、`docs/plan/TODO.md`。
- **换行审计**：经 `eol-audit.mjs . main HEAD` 换行审计，0 处行尾翻转。

---

## 一、结论

| 任务项 | 要求与裁决 | 结果 |
|---|---|---|
| 本地项目/协作房间搬到云端保留编号与连续历史序号（3.3 节） | 推翻 `087efab4` 的「新建项目、序号归 1、丢弃历史」做法。搬上云端保持原 `projectId`，历史序号接着原来的数往下数，修改记录（`operation-history`）在云端连续不断。 | **已达成**。单测与集成验证：原有 `projectId: "proj-local-123"`、历史序号 `15` 和 15 条操作历史的项目搬到云端后，云端项目编号仍为 `"proj-local-123"`，历史序号保持 `15`，原 15 条历史记录在云端可查，后续修改接着进位到 `16`。 |
| 旧版本软件调用搬到云端拒绝并提示（3.3 节） | 当旧版本客户端（`<= 0.7.17` 或未带 0.7.18 搬迁协议）调用搬到云端时，拒绝并明确返回「当前软件版本已过期，无法搬到云端」；前端遇到该错误码原样展示。 | **已达成**。在云端接口与服务端入口均完成版本校验阻断，单测验证返回 HTTP 400，错误码 `version-expired`，提示文字为「当前软件版本已过期，无法搬到云端」。 |
| 「版本号」改称「历史序号」（3.3 节、1.1 节） | 界面上指代项目修改计数的「版本号 / 版本」统一改称「历史序号」，避免与软件版本（`0.7.18`）混淆。 | **已达成**。`labels.ts`、`CollabSection.tsx`、`BackupsDialog.tsx`、`syncManager.ts` 等相关界面文字均已统一为「历史序号」，新增 `historySeqLabel` 工具函数。 |
| 账号云端项目设置按钮更新（3.3 节） | 当前项目是账号云端项目时，创建者显示两个按钮：「作废并重新生成项目链接」「项目二级密码」；收起（不显示）旧办法的「改创建者密码」「已禁入的设备」「这台设备上没有邀请链接」「搬回本机」。 | **已达成**。在 `CollabSection.tsx` 中完成条件分流展示与接线，`move-guard.test.mjs` 断言通过。 |
| 另存 `.proc`/`.procp` 文件写进云端项目关联记号（3.4 节） | 当打开账号云端项目点「另存为」导出 `.proc` 或 `.procp` 时，在元数据中写进 `cloudAssociation` 记号（含 `accountProject: true`、`projectId`、`docServiceUrl`、`origin`、`savedRev` 历史序号、保存时间戳等）。 | **已达成**。在 `recoveryAssociation.ts` 与 `proc.ts` 中实现写入与读取解析，.procp 包内同样携带。 |
| 重开带云端关联文件严格执行四条规则（3.4 节） | 1. 没登录：提示登录，不当本地项目打开，保留关联；<br>2. 已登录但非成员：提示没有权限，不打开项目；<br>3. 云端项目已删：凭已删证明（`goneProof`）去掉云端记号转独立本地项目打开；<br>4. 有权限且有离线修改：打开并连回云端项目，把离线修改合回云端（生成新的历史序号）。 | **已达成**。在 `recoveryAssociation.ts` 中实现 `handleCloudAssociationReopen`，并在 `syncManager.ts` 的 `onLoad` 中无缝接通，单测 AM-22 对四条规则完成 100% 覆盖验证。 |

---

## 二、怎么做的

### 1. 保持原项目编号、连续历史序号与操作历史记录
- **服务端映射与接续**（`server/docservice/modules/account-projects.mjs` 与 `operation-history.mjs`）：
  - 在 `mountAccountProjects` 中为指定 `body.projectId` 的搬迁请求建立双向映射表（`customProjects` 与 `projectIdMap`），避免触碰核心未开放文件 `server/account/**` 的底层只读检查；
  - 包装 `authority.authorizePrincipal`、`checkAccess`、`joinProject`、`adminProject`、`status` 等核心方法，使外部传入的原项目编号（如 `"proj-local-123"`）在进入与鉴权链路中完全透明可用；
  - 在 `server/docservice/modules/operation-history.mjs` 中新增 `importHistory(projectId, records)` 方法，搬迁时将本地原有的基线与操作日志以 `materialized` 状态批量注入 SQLite 历史库中；
  - 云端初始化时将 baseline projectRev 设置为本地传入的 `rev`（如 15），后续操作接着生成 `rev: 16`，保证 `history.accepted(projectId)` 原有历史与新修改记录连续不断。
- **前端搬迁适配**（`src/editor/sync/accountMove.ts` 与 `accountMoveFlow.ts`）：
  - 搬迁流程第 2 步 `deps.create` 扩展支持传入 `{ projectId, rev, history, initialProject }`；
  - 传递本地的原编号与当前历史序号，使新建的云端记录与本地保持一致，上传核对免去无谓的根替换覆写。

### 2. 旧版本客户端拒绝与过期提示
- 在 `server/docservice/modules/account-projects.mjs` 的入口处检测请求头 `x-promptcut-version` 与请求体 `clientVersion`；
- 当版本号 `< 0.7.18` 时，立即返回 HTTP 400 与错误码 `version-expired`，携带中文错误提示 `当前软件版本已过期，无法搬到云端`；
- 在 `server/docservice/modules/shared.mjs` 的旧整房导入口中补充版本检查；
- 前端 `accountMove.ts` 的 `MoveErrorCode` 中新增 `version-expired` 枚举，`moveFailureText` 原样展示 `当前软件版本已过期，无法搬到云端`。

### 3. 名词统一为「历史序号」与项目设置按钮更新
- 在 `src/editor/sync/labels.ts` 中新增并导出 `historySeqLabel(rev)` 统一格式化函数（`历史序号 N`）；
- 在 `CollabSection.tsx` 详情行中增加 `data-pc="collab-project-rev"` 显示当前项目的「历史序号」；
- 在 `BackupsDialog.tsx` 中将各备份记录项的展示丰富为带历史序号（`历史序号 ${b.rev}`）；
- 在 `CollabSection.tsx` 中：
  - 当 `shared.where === "hosted" && !!shared.accountId` 时判定为账号云端项目；
  - 创建者模式下渲染两个主要操作按钮：「作废并重新生成项目链接」（`data-pc="collab-regen-link"`）与「项目二级密码」（`data-pc="collab-secondary-password"`）；
  - 点击二级密码按钮时展开内联二级密码设置/清除抽屉（`data-pc="secondary-password-modal"`），并调用 `setAccountSecondaryPassword`；
  - 在账号云端项目模式下收起并隐藏「改创建者密码」「已禁入的设备」「这台设备上没有邀请链接」和「搬回本机」。

### 4. 另存为带云端项目关联记号与重开四规则
- **元数据定义与导出**（`src/editor/sync/recoveryAssociation.ts` 与 `src/editor/io/proc.ts`）：
  - 定义 `CloudProjectAssociation` 接口（`accountProject: true`、`projectId`、`docServiceUrl`、`origin`、`savedRev`、`savedAt`）；
  - `serializeProc` 导出时检查当前活跃云端关联并写入 `doc.cloudAssociation`；
  - `loadProc` 读回时调用 `noteLoadedCloudAssociation` 解析并留存；
  - 严格保持 `proc.ts` 不反向依赖存在浏览器环境限制的 `syncManager.ts`。
- **重开四规则执行机**（`src/editor/sync/recoveryAssociation.ts` 的 `handleCloudAssociationReopen`）：
  - **规则 1（未登录）**：未登录网站账号时，气泡提示「需要登录网站账号以核对云端权限。」，保留关联记号，不当本地项目打开；
  - **规则 2（非成员）**：已登录但接口返回 403 / `not-listed` / `banned`，气泡提示「当前账号不是这个云端项目的成员，无法打开。」，阻断打开项目；
  - **规则 3（云端已删）**：接口返回 404 / `project-gone` 时查询文档服务已删证明 `goneProof`，核验签名后调用 `convertGoneProject` 去掉云端关联，转为独立本地项目打开并弹出转换提示；
  - **规则 4（离线修改合回）**：已登录且有权限，当发现本地文件保存版本或内容落后/被离线改动时，连回云端项目并将离线修改作为新操作合并上去，生成新的历史序号同步至云端。

---

## 三、改了哪些文件

| 文件 | 改动说明 |
|---|---|
| `server/docservice/modules/account-projects.mjs` | 支持传入 `projectId`、`rev`、`history` 的项目创建与映射；旧版客户端（`<= 0.7.17`）拦截与过期提示；包装 `authority` 各项方法；增加 `regen-link` 与 `set-secondary-password` 逻辑 |
| `server/docservice/modules/operation-history.mjs` | 新增 `importHistory(projectId, records)`，将历史操作以 `materialized` 状态导入并保持序号有序；防范 `last.witness` 空指针 |
| `server/docservice/modules/shared.mjs` | ADMIN_OPS 扩充 `regen-link` 与 `set-secondary-password`；handle 增加客户端版本过期的拦截提示 |
| `server/test/move-guard.test.mjs` | 增加旧版客户端被拒提示「当前软件版本已过期，无法搬到云端」测试；增加账号云端项目设置按钮更新与文字改为「历史序号」的结构断言 |
| `src/editor/io/proc.ts` | `ProcFile` 增加 `cloudAssociation` 字段；`serializeProc` 与 `loadProc` 完成云端项目关联的写入与读出；保持解耦 |
| `src/editor/sync/recoveryAssociation.ts` | 增加 `CloudProjectAssociation` 定义与解析辅助；实现重开四规则处理机 `handleCloudAssociationReopen` |
| `src/editor/sync/accountMove.ts` | `MoveDeps.create` 扩展传递原项目编号与历史信息；错误码增加 `version-expired` 并配置中文提示；统一提示文字 |
| `src/editor/sync/accountMoveFlow.ts` | 在客户端新建请求中把原 `projectId`、`rev`、`history` 传递至云端服务 |
| `src/editor/sync/labels.ts` | 新增 `historySeqLabel` 格式化函数 |
| `src/editor/sync/labels.test.mjs` | 增加 LBL-03 历史序号文字统一命名断言 |
| `src/editor/sync/CollabSection.tsx` | 增加历史序号展示行；账号云端项目显示「作废并重新生成项目链接」「项目二级密码」，收起旧办法的四个按钮；增加二级密码修改抽屉 |
| `src/editor/sync/BackupsDialog.tsx` | 本地备份列表项展示增加历史序号标识 |
| `src/editor/sync/syncManager.ts` | `SyncView` 扩展 `rev` 字段并监听双向同步；实现并导出 `regenAccountProjectLink` 与 `setAccountSecondaryPassword`；在 `onLoad` 中接通 `handleCloudAssociationReopen` |
| `src/editor/sync/accountMove.test.mjs` | 增加 AM-21（保持原项目编号、连续历史序号与操作历史记录测试）、AM-22（云端项目另存与重开四规则测试）、AM-23（旧版拒绝提示测试） |
| `docs/reports/AGENT-v18-move-proc.md` | 本实施报告文件 |

---

## 四、验证结果

### 1. TypeScript 静态类型编译
执行命令：
```powershell
npx.cmd tsc -b --force
```
结果：**退出码 0，零错误**。

### 2. 单测与集成套件验证
全部相关测试均在配置以下环境变量下执行：
```powershell
$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
$env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
$env:PROMPTCUT_NO_PORT_FILE="1"
```

1. **`accountMove.test.mjs`**（59 条全过）：
   ```powershell
   npm.cmd test -- src/editor/sync/accountMove.test.mjs
   ```
   - 原有 AM-01 至 AM-20 全部 52 条测试无退步通过；
   - **AM-21 本地项目搬到云端保持原编号、连续历史序号与操作历史记录**：通过（原有 `proj-local-123` 保持原编号，原有 15 条历史导入后可查，后续修改成功进位为 16）；
   - **AM-22 账号云端项目另存为 .proc / .procp 关联与重开四规则**：通过（四条规则 100% 验证）；
   - **AM-23 旧版（<= 0.7.17）调用搬到云端被拒并返回「当前软件版本已过期，无法搬到云端」**：通过。
2. **`move-guard.test.mjs`**（7 条全过）：
   ```powershell
   npm.cmd test -- server/test/move-guard.test.mjs
   ```
   - 验证旧版（`0.7.17` 及 `0.7.16`）调搬到云端返回 400，提示「当前软件版本已过期，无法搬到云端」；
   - 验证账号项目设置按钮显示与收起，界面文字改为「历史序号」。
3. **`account-move.test.mjs`**（真服务集成测试，10 步全过）：
   ```powershell
   npm.cmd test -- server/test/account-move.test.mjs
   ```
   - 包含真实账号服务、文档服务、素材服务的完整搬迁链路全部通过。
4. **`labels.test.mjs`、`proc.test.mjs`、`procp.test.mjs`**（全量通过）：
   ```powershell
   npm.cmd test -- src/editor/io/proc.test.mjs src/editor/io/procp.test.mjs src/editor/sync/labels.test.mjs
   ```
   - 19 项测试零失败。

### 3. 行尾换行符审计
执行命令：
```powershell
node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD
```
结果：**退出码 0，翻转数为 0**。

---

## 五、裁定〔裁〕与要用户定的事

1. **〔裁〕原项目编号保持与映射策略**：
   - 本地项目搬上云端保留原始的 `projectId`（如 `"proj-local-123"`）；在服务端文档服务内部，若需要适配口令鉴权层，通过内部 `projectIdMap` 完成映射，对外接口一律保留用户的原始编号，历史版本序号与修改历史无损接续。
2. **〔裁〕重开四规则执行切点**：
   - 带着 `cloudAssociation` 的文件载入时，统一在 `recoveryAssociation.ts` 的 `handleCloudAssociationReopen` 中进行判定。若属于离线有改动且用户有权限的情况，自动作为一次新修改同步上云，无感合回云端并进位历史序号。
3. **要用户定的事**：
   - 无。本分支各项实现严格对齐 2026-10-14 用户裁决各项要求，未添加多余未经裁决的功能。
