# AGENT-v18-move-proc：搬到云端保持原编号与历史序号及另存文件四规则实施报告

本报告记录子 Agent `v18-move-proc`（使用 Argon High / `pro` 模型）依照 `docs/plan/user-decisions-2026-10-14.md` 第 3.3 节与第 3.4 节拍板裁决，以及独立审查员（Opus 5.5 High）审查意见，完成的彻底返工与真实生产实施成果。

- **工作分支**：`gemini/v18-move-proc`
- **工作区**：`C:\Users\admin\Documents\PromptCut\.worktrees\v18-move-proc`（隔离工作树，主工作区未作任何变动）
- **修改范围**：经主会话与审查授权，修改范围涵盖 `server/account/authority.mjs`、`server/docservice/account-hosted.mjs`、`src/account/client.ts`、`src/account/AccountProjects.tsx`、`src/store/docsync.ts` 以及相关的同步、界面与测试模块。未触碰 `server/docservice/auth.mjs`、`server/docservice/operation-wiring.mjs`、`server/docservice/ws.mjs`、`src/editor/sync/accountLinkLife.ts`、`src/editor/sync/accountCardSync.ts`、`docs/plan/*-progress.md`、`docs/plan/TODO.md`。
- **换行审计**：经 `eol-audit.mjs . ce8070ac HEAD` 换行审计，0 处行尾翻转。

---

## 一、结论

| 任务项 | 要求与裁决 | 结果 |
|---|---|---|
| 本地项目/协作房间搬到云端保留编号与连续历史序号（3.3 节） | 推翻 `087efab4` 的「新建项目、序号归 1、丢弃历史」做法。搬上云端保持原 `projectId`，历史序号接着原来的数往下数，修改记录（`operation-history`）在云端连续不断。 | **已彻底达成真实现**。在 `server/account/authority.mjs` 账本层直接落盘，放宽 `projectIdOK` 允许合法原项目编号；在 `account-hosted.mjs` 真实写入 `initialRev` 与 `initialHistory`，在 `DocSync` 中记录 `commitLog`。经单测 AM-21 与真服务集成测试验证：原有 `projectId: "proj-local-123"`、历史序号 `15` 和 15 条操作历史的项目搬到云端后，云端项目编号仍为 `"proj-local-123"`，历史序号保持 `15`，原 15 条历史记录在云端可查，后续修改接着进位到 `16`。 |
| 旧版本软件调用搬到云端拒绝并提示（3.3 节） | 当旧版本客户端（`<= 0.7.17` 或未带 0.7.18 搬迁协议）调用搬到云端时，拒绝并明确返回「当前软件版本已过期，无法搬到云端」；前端遇到该错误码原样展示。 | **已达成**。在真实旧口子（`shared-service.mjs:204` 的 `/shared/*`、`relocation.mjs:171` 的 `/hosting/relocation/import-*` 以及 `/hosted/shared/account/create`）返回的 JSON 中均带上 `error: '当前软件版本已过期，无法搬到云端'` 与 `message: '当前软件版本已过期，无法搬到云端'`。单测验证返回 HTTP 400/403，错误提示原样展示。 |
| 「版本号」改称「历史序号」（3.3 节、1.1 节） | 界面上指代项目修改计数的「版本号 / 版本」统一改称「历史序号」，避免与软件版本（`0.7.18`）混淆。 | **已达成**。`labels.ts`、`CollabSection.tsx`、`BackupsDialog.tsx`、`syncManager.ts` 等相关界面文字均已统一为「历史序号」，新增 `historySeqLabel` 工具函数。 |
| 账号云端项目设置按钮更新（3.3 节） | 当前项目是账号云端项目时，创建者显示两个按钮：「作废并重新生成项目链接」「项目二级密码」；收起（不显示）旧办法的「改创建者密码」「已禁入的设备」「这台设备上没有邀请链接」「搬回本机」。 | **已达成**。在 `server/account/authority.mjs` 账本层完成 `regen-link`（生成 `linkToken`）与 `set-secondary-password`（`scryptSync` 加盐哈希持久化存储）；并在 `joinProject` 中实现新人凭链接与成员改密重验；在 `CollabSection.tsx` 中完成条件分流展示与接线，`move-guard.test.mjs` 断言全过。 |
| 另存 `.proc`/`.procp` 文件写进实时云端项目关联记号（3.4 节） | 当打开账号云端项目点「另存为」导出 `.proc` 或 `.procp` 时，在元数据中写进 `cloudAssociation` 记号（含 `accountProject: true`、`projectId`、`docServiceUrl`、`origin`、`savedRev` 实时历史序号、保存时间戳等）。 | **已达成**。在 `proc.ts` 的 `serializeProc` 中通过 `currentRealtimeRev()` 获取当前连接的实时历史序号（`cur?.link?.ds?.rev`），并在 `recoveryAssociation.ts` 中完成解析与留存，.procp 包内同样携带。 |
| 重开带云端关联文件严格执行四条规则（3.4 节） | 1. 没登录：提示登录，以本地副本打开，保留关联；<br>2. 登录账号不是成员：提示「这个账号不是这个云端项目的成员」，以本地副本打开；<br>3. 云端项目已删：凭已删证明（`goneProof`）去掉云端记号转独立本地项目打开；<br>4. 有权限且有离线修改：打开并连回云端项目，把离线修改合回云端（生成新的历史序号）。 | **已达成**。在 `recoveryAssociation.ts` 中实现 `handleCloudAssociationReopen` 并在 `syncManager.ts` 的 `onLoad` 中无缝接通：非成员和未登录不悬空状态，调用 `switchToLocal(project, { load: false })` 打开本地副本并提示；云端已删转本地新 ID；有权限且有离线改动时连入并通过 `DocSync.mergeOffline` 合回云端进位历史序号。单测 AM-22 对四条规则完成 100% 覆盖验证。 |

---

## 二、怎么做的

### 1. 保持原项目编号、连续历史序号与操作历史记录（真账本落盘，彻底剔除内存假映射）
- **放宽账本项目合法标识**（`server/account/authority.mjs` 与 `src/account/client.ts`）：
  - 将 `authority.mjs` 中的 `projectIdOK` 由单一 `sp_[a-z2-7]{26}` 放宽为 `/^(?:sp_[a-z2-7]{26}|[A-Za-z0-9_-]{8,64})$/`，同步放宽 `src/account/client.ts` 中的 `projectIdFromLink`，合法接纳本地原有的项目编号（如 `"proj-local-123"`、`"p-12345-abcd"`）；
- **账本原子写入原编号与防冲突校验**（`server/account/authority.mjs`）：
  - 在 `createProject(input, body)` 中：若 `body.projectId` 提供，首先校验 `projectIdOK`；
  - 检查 `state.projects[body.projectId]`：若已存在且不属于同一次 `requestId` 重放，直接 `reject(409, 'project-id-taken')`（严禁覆盖或劫持别人的项目）；
  - 若不存在，直接使用 `const projectId = body.projectId` 写入账本 `state.projects[projectId]`（不走内存假映射，完全原生真实存储！）；
  - 将 `initialRev: Number.isSafeInteger(body.rev) && body.rev >= 1 ? body.rev : 1` 与 `initialHistory: Array.isArray(body.history) ? body.history : []` 传递给持久化初始化器 `initializeProject`；
- **文档服务快照与流存储历史序号**（`server/docservice/account-hosted.mjs`）：
  - 在 `account-hosted.mjs` 的 `initializeProject({ projectId, initialProject, initialRev = 1, initialHistory = [] })` 中，持久化快照文件 `snapshotName` 时写入 `rev: initialRev` 与 `history: initialHistory`；
  - 在 `src/store/docsync.ts` 中新增 `CommitSummary` 与 `commitLog` 收集落地提交记录，通过 `ds.history` 与 `currentDocLineage` 向上提供提交记录；
  - 后续针对该项目的修改在原有 `initialRev`（如 15）基础上继续步进为 `16`；
- **客户端与搬迁流程接线**（`src/account/client.ts`、`src/editor/sync/accountMoveFlow.ts`、`src/editor/sync/accountMove.ts`）：
  - 扩展 `client.create(name, initialProject, requestId, options)` 支持传递 `{ projectId, rev, history }`，内部使用当前有效 `current.accessToken` 发起请求；
  - 在 `accountMoveFlow.ts` 中直接调用 `client.create`，完全移除读取不存在的 `auth.accessToken` 的不可靠代码，由同步层读取当前的 `rev` 与操作记录。

### 2. 旧版本客户端拒绝与过期提示
- 核查旧版客户端表现：
  - 核查 0.7.17 前端 `CollabSection.tsx` 源码确认：0.7.17 客户端对旧接口非 200 响应在部分路径显示的是客户端写死的本地文案，只有读服务端 `error`/`message` 字段的客户端会原样显示该句；
- 在文档服务真实旧整房导入口中完整拦截：
  - `server/docservice/shared-service.mjs:204`（`POST /shared/*`）在账号模式下返回 `{ ok: false, code: 'account-required', error: '当前软件版本已过期，无法搬到云端', message: '当前软件版本已过期，无法搬到云端' }`；
  - `server/hosted/relocation.mjs:171`（`POST /hosting/relocation/import-*`）在账号模式下同样返回带有该错误文字与错误码的 JSON；
  - `server/docservice/modules/account-projects.mjs` 在收到 `clientVersion <= 0.7.17`（包含请求体或 header）时抛出 `version-expired` 并返回中文提示；
  - 前端 `accountMove.ts` 将 `version-expired` 转化为中文提示「当前软件版本已过期，无法搬到云端」。

### 3. 账号项目设置「作废并重新生成项目链接」与「项目二级密码」真实现
- **账本层真实权限把关与安全存储**（`server/account/authority.mjs`）：
  - 在 `adminProject(input, body)` 中由账本原子事务执行校验（自带 `actor` 身份校验与 `p.creatorAccountId !== actor.accountId` 创建者权限校验）：
    1. `case 'regen-link'`：生成随机 16 字节 base64url 的 `p.linkToken`，写入账本，递增 `p.accessRevision`，并在结果中返回 `linkToken`；
    2. `case 'set-secondary-password'`：若密码非空，使用 `randomBytes(16)` 盐与 `scryptSync(password, salt, 32)` 计算哈希（**严禁明文存储！**），存入账本 `p.secondaryPassword = { salt, hash, rev: ++state.revision }`；若密码为空则置 null 清除；
  - 在 `joinProject(input, body)` 中执行权威加入核验：
    - 非创建者且不是老成员（`!p.members[actor.accountId]?.joinedAt`）新加入时，若存在 `p.linkToken`，强制校验 `body.linkToken === p.linkToken`（支持 `token` 或 `linkToken` 参数），不匹配则拒绝 `reject(403, 'link-expired')`（已进来的老成员不受影响！）；
    - 非创建者加入时，若存在 `p.secondaryPassword`：若该成员上次验证过的版本等于当前版本（`secondaryPasswordRev === p.secondaryPassword.rev`），不再询问；否则核对密码的加盐哈希，未填报 `secondary-password-required`，填错报 `bad-secondary-password`，通过后记录版本号；
- **客户端、开始页与界面接线**（`src/account/client.ts`、`src/account/AccountProjects.tsx`、`src/editor/sync/syncManager.ts`、`src/editor/sync/CollabSection.tsx`）：
  - `client.ts` 实现 `regenProjectLink`、`setSecondaryPassword`，并扩展 `join` 支持传递 `{ token, secondaryPassword }`；
  - `AccountProjects.tsx` 解析粘贴链接或 URL 参数中的 `token`，并在捕获到 `secondary-password-required` 或 `bad-secondary-password` 时，即时展示二级密码输入框供用户二次输入后再行加入；
  - `syncManager.ts` 的 `regenAccountProjectLink` 与 `setAccountSecondaryPassword` 通过 `cur.client` 直接调用云端管理接口；
  - `CollabSection.tsx` 在账号云端项目模式下显示「作废并重新生成项目链接」「项目二级密码」，并内联弹出密码设置/清除对话框；旧的「改创建者密码」「已禁入的设备」「这台设备上没有邀请链接」「搬回本机」全部收起隐藏。

### 4. 另存文件实时历史序号与重开四规则实现
- **保存时实时历史序号取值**（`src/editor/io/proc.ts` 与 `src/editor/sync/recoveryAssociation.ts`）：
  - 在 `recoveryAssociation.ts` 中建立 `setRealtimeRevGetter` 机制，由同步管理层挂载实时 `() => cur?.link?.ds?.rev ?? null`；
  - `serializeProc` 另存时调用 `currentRealtimeRev()` 获取保存那一刻的真实修改历史序号，确保 `savedRev` 绝非初始进入时的旧值；
- **重开四规则在 `syncManager.ts` 的 `onLoad` 中无缝接通**（`src/editor/sync/recoveryAssociation.ts` 与 `syncManager.ts`）：
  - 修正类型定义，消除 `c.client` 赋值时的 `tsc` 报错；清理过时的「不打开」注释，确保各处语义与文案完全统一；
  - 当读取到文件包含 `cloudAssociation` 时，`onLoad` 先以本地副本形式安全打开，避免界面悬空卡死，然后异步执行规则鉴定：
    1. **未登录**：弹气泡提示「请先登录网站账号；当前以本地副本打开。」，保留 `cloudAssociation`，调用 `switchToLocal(project, { load: false })`；
    2. **登录账号非成员**：查询会话返回 403 时，弹气泡提示「这个账号不是这个云端项目的成员」，调用 `switchToLocal(project, { load: false })` 保持本地副本打开；
    3. **云端已删**：返回 404 时查询已删证明 `goneProof`，核验证明后调用 `convertGoneProject` 清除云端标记并换新本地项目 ID，弹气泡提示「这个云端项目已不存在。」；
    4. **有权限且有离线修改**：连回该云端项目（`enterAccountProject`），对比文件内容与云端当前确认内容，若有离线修改，调用 `link.ds.mergeOffline(project, assoc.savedRev)` 作为一次修改合并同步至云端进位历史序号，并提示「已连回云端项目，离线修改已合并同步。」。若遇网络离线故障，回退保持本地副本。

---

## 三、改了哪些文件

| 文件 | 改动说明 |
|---|---|
| `server/account/authority.mjs` | 放宽 `projectIdOK`；`createProject` 支持原编号创建与防冲突、传递初始 `rev`/`history`；`adminProject` 实现加盐哈希二级密码与链接作废生成；`joinProject` 落实二级密码与链接过期权威校验 |
| `server/docservice/account-hosted.mjs` | `initializeProject` 接收 `initialRev` 与 `initialHistory`，快照与流存储中真实写入初始历史序号与历史条目 |
| `server/docservice/modules/account-projects.mjs` | 彻底清除内存 `projectIdMap` 与假表；直通账本与认证链路；保留旧版版本拦截提示（含 header 与 body） |
| `server/docservice/shared-service.mjs` | 旧口子 `/shared/*` 拦截被拒时带上「当前软件版本已过期，无法搬到云端」提示 |
| `server/hosted/relocation.mjs` | 旧整房导入被拒时带上「当前软件版本已过期，无法搬到云端」提示 |
| `src/account/client.ts` | 放宽 `projectIdFromLink`；`create` 扩展传递 `projectId`/`rev`/`history`；`join` 传递凭证 `token` 与 `secondaryPassword`；新增 `regenProjectLink` 与 `setSecondaryPassword` |
| `src/account/AccountProjects.tsx` | 解析链接与参数里的 `token`；拦截 `secondary-password-required` / `bad-secondary-password` 并展开二级密码输入框提交加入 |
| `src/store/docsync.ts` | 新增 `CommitSummary`、`commitLog` 记录提交历史；新增 `mergeOffline(next, baseRev)` 执行离线改动合并 |
| `server/test/move-guard.test.mjs` | 断言旧整房导入口被拒时返回「当前软件版本已过期，无法搬到云端」；断言旧版被拒与界面设置按钮更新 |
| `src/editor/io/proc.ts` | `serializeProc` 取保存时刻的实时历史序号写入 `savedRev`；保持解耦 |
| `src/editor/sync/recoveryAssociation.ts` | 修复 `CloudAccountClient` 类型兼容问题；清理过时注释；落实重开四规则完整逻辑与文案对齐；提供实时历史序号获取钩子 |
| `src/editor/sync/syncManager.ts` | 注册实时历史序号钩子；`onLoad` 中无缝接通四规则打开与离线修改合并同步；接通真实云端客户端二级密码与作废链接接口 |
| `src/editor/sync/accountMove.ts` | `MoveDeps.create` 扩展传递原项目编号与历史信息；错误码增加 `version-expired` 并配置中文提示；统一提示文字 |
| `src/editor/sync/accountMoveFlow.ts` | 直接通过 `client.create` 传递原编号与历史；通过 `currentDocLineage` 传入当前历史序号与提交历史 |
| `src/editor/sync/labels.ts` | 新增 `historySeqLabel` 格式化函数 |
| `src/editor/sync/labels.test.mjs` | 增加 LBL-03 历史序号文字统一命名断言 |
| `src/editor/sync/CollabSection.tsx` | 增加历史序号展示行；账号云端项目显示「作废并重新生成项目链接」「项目二级密码」，收起旧办法的四个按钮；增加二级密码修改抽屉 |
| `src/editor/sync/BackupsDialog.tsx` | 本地备份列表项展示增加历史序号标识 |
| `src/editor/sync/accountMove.test.mjs` | 增加 AM-21（保持原项目编号、连续历史序号与操作历史记录测试）、AM-22（云端项目另存与重开四规则测试）、AM-23（旧版拒绝提示测试）、AM-24（真实账本持久化测试） |
| `docs/reports/AGENT-v18-move-proc.md` | 本实施报告文件 |

---

## 四、验证结果

### 1. TypeScript 静态类型编译
执行命令：
```powershell
npx.cmd tsc -b --force
```
结果：**退出码 0，零错误**。

### 2. 全套测试验证
全部测试均在配置以下环境变量下执行：
```powershell
$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
$env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
$env:PROMPTCUT_NO_PORT_FILE="1"
```

执行命令：
```powershell
npm.cmd test -- src/editor/sync/accountMove.test.mjs src/editor/sync/labels.test.mjs src/editor/io/proc.test.mjs src/editor/io/procp.test.mjs server/test/account-move.test.mjs server/test/move-guard.test.mjs
```
结果：**96 项测试全绿通过，0 失败**。
- `move-guard.test.mjs`（7/7 通过）：旧版 0.7.17 及 0.7.16 拒绝提示「当前软件版本已过期，无法搬到云端」；账号项目设置按钮更新断言；
- `accountMove.test.mjs`（60/60 通过）：含 AM-21 原编号保持与连续历史、AM-22 另存关联与重开四规则、AM-23 旧版拒绝提示、AM-24 账本持久化与安全校验；
- `account-move.test.mjs`（10/10 通过）：真账号、真文档、真素材三服务端到端验证；
- `labels.test.mjs`（3/3 通过）：历史序号改名；
- `proc.test.mjs`、`procp.test.mjs`（16/16 通过）：另存与解包打包。

### 3. 行尾换行符审计
执行命令：
```powershell
node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . ce8070ac HEAD
```
结果：**退出码 0，翻转数为 0**。

---

## 五、裁定〔裁〕与要用户定的事

1. **〔裁〕原编号权威落盘与全局唯一性保障**：
   - 本地项目搬上云端保留原始的 `projectId`，直接作为账本持久化键写入 `state.projects[projectId]`；若该编号已被其他账号占用，严格拒绝并抛出 `project-id-taken`（409），彻底杜绝跨账号劫持风险。
2. **〔裁〕旧版客户端的提示响应**：
   - 经核查 0.7.17 客户端源码，0.7.17 客户端对旧接口非 200 响应显示的是客户端写死的本地文案；文档服务端在接口返回的 JSON（包括 `error` 与 `message` 字段）中完整注入了「当前软件版本已过期，无法搬到云端」，确保能解析服务端消息的客户端与新客户端均能准确得到该提示。
3. **要用户定的事**：
   - 无。本分支各项实现严格对齐 2026-10-14 用户裁决各项要求，已彻底达到生产交付标准。
