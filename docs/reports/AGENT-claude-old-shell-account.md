# AGENT-claude-old-shell-account

分支 `claude/old-shell-account`（从 main `fdbc981d` 切），worktree `.worktrees/old-shell-account`，端口段 5910～5919（只用了 5910～5912）。

任务：0.2.8 以前的外壳打了更新补丁以后，桌面版账号入口（云端项目列表、搬到云端）不报错，改成说明「这个功能要装完整安装包」。补丁的最低外壳不抬（`desktop/scripts/make-patch.mjs` 的 `MIN_SHELL_VERSION` 没动，仍是 0.2.0）。

## 状态

代码、测试、探针完成，门槛全绿（失败的用例单跑复核通过，见「门槛结果」）。分支停在 worktree，没推送、没合并。

## 做了什么（逐文件）

| 文件 | 改动 |
|---|---|
| `src/account/desktopVault.ts` | 所有账号桥调用的唯一入口。新增：`OLD_SHELL_ACCOUNT_TEXT`（那句话）、`DesktopShellTooOldError`（`code = 'desktop-shell-too-old'`）、`isDesktopShellTooOld`、`isMissingAccountBridgeRejection`（判据，见下）、`shellHasAccountBridge`、`ACCOUNT_BRIDGE_MIN_SHELL = '0.2.8'`。`desktopAccountBridge` 在 `invoke` 被拒且原话是「没有这个命令」、并且外壳版本不是确定 ≥ 0.2.8 时抛 `DesktopShellTooOldError`，其余错误原样抛出；没有 `__TAURI__`（在线页面、开发服务器）仍报原来那句「此环境没有桌面账号安全存储」。 |
| `src/account/useAccountProjects.ts` | 加 `shellOld` 状态并从 hook 返回（手机版 `MobileStart.tsx` 不用它，不受影响）。初始化、恢复登录、列表、各个动作的 catch 里认到 `DesktopShellTooOldError` 就置 `shellOld`，不再写进 `error`。 |
| `src/account/AccountProjects.tsx` | 入口一：开始页「云端项目」。`shellOld` 时标题栏之外只显示一段说明（`<p class="sp-muted" role="status" data-pc="account-shell-old">`），不显示会失败的登录、新建、加入表单和红色错误条；其它情况原样。 |
| `src/editor/sync/accountMoveFlow.ts` | 入口二的数据一侧。`accountCloud()` 问账号桥配置时若被认定为外壳太老，记下一个模块内的标记；新增 `accountShellTooOld()`、`oldShellBlocksAccountMove(serviceUrl)`（外壳太老且云端地址是缺省的账号云端：没填、内置缺省托管地址）。每次问完标记都按最后一次结果更新（成功或别的失败会清掉它）。 |
| `src/editor/sync/CollabSection.tsx` | **越出清单的一个文件**（清单只给了 `accountMoveFlow.ts`；「搬到云端」的界面在这里，不改它就没有地方显示说明）。只加了：一个 `shellOld` 状态；打开设置时问完账号云端后读标记；设置里「放在云端」且目标是缺省云端、外壳太老时，把创建者用户名密码那一堆（走不通的旧办法）换成一块警示说明（沿用现有的 `pc-sync-warn` 样式）；`apply()`（点确定）和 `moveHosted()`（房间里点「搬到云端」）在同样条件下往状态行写这句话并返回，不往下搬。用户自己填了别的节点时完全不变（仍走旧办法）。 |
| `src/account/desktopShellOld.test.mjs`（新） | 单测，10 条，见下。 |
| `src/account/oldShellFlow.test.mjs`（新） | 用 Vite 服务端加载真的 `accountMoveFlow.ts`，页面全局换成外壳替身，测 `accountCloud` / 标记 / `oldShellBlocksAccountMove`，1 条（含各种情形）。 |
| `scripts/probes/old-shell-account-probe.mjs`（新，清单外的新增文件，只增不改别处） | 真浏览器探针，起本工作区编辑器（5910），无头 Chrome 打开，`window.__TAURI__` 换成外壳替身，四种外壳 × 三处入口。 |

## 判据：怎么认出「外壳太老」，为什么不误判

要点：只在**两个条件都成立**时才说外壳太老，任何一个不满足都照常报原来的错。

1. **拒绝的原话是 Tauri 对「没有这个命令」的那几句，且整句匹配**（`^…$`，不用「含有 not found / ACL」）：
   - `Command account_bridge not allowed by ACL`（发布版，最常见）
   - `Command account_bridge not found`
   - `account_bridge not allowed. Command not found` 和 `… Plugin not found`（调试版）
2. **版本核对**：原话符合时再读一次外壳版本（`window.__TAURI__.app.getVersion()`），**读得出且 ≥ 0.2.8，就不算外壳太老**（那是新外壳权限配错，照常报错）；读不出（0.2.5 以前的外壳没有给远程页面放行 `core:default`，读版本也被拒）或 < 0.2.8，才算。

为什么不会误判：
- 新外壳 `account_bridge` 自己的错误只有 `account_vault.rs` 里的 `desktop-account-*` 代号（单测把这个文件里所有 `desktop-account-*` 字面量都取出来，逐个确认不匹配判据）。网络错、`Failed to fetch`、别的命令的 ACL 拒绝（`Command other_cmd …`）、权限配错的长句（`account_bridge not allowed on window "…", webview "…", URL: …`、`… not allowed on origin […]`）都不匹配；后面带多余内容的句子也不匹配（锚定）。
- 老外壳是冻结的二进制，它说的话是固定的；新外壳升级 Tauri 后改了措辞也无妨，因为新外壳有这个命令，走不到这条路径。
- 新外壳配错权限时，原话可能和老外壳一样（`not allowed by ACL`），靠第 2 条的版本核对区分。**残余**：新外壳权限配错得连读版本也被拒时，两个条件都满足，会被说成外壳太老。这是开发者配错，不是用户会遇到的；而 0.2.0～0.2.5 这批真老外壳读不出版本，必须按「读不出算老」处理，两者无法再区分。
- 出处（Tauri 2.11 源码，本机 `~/.cargo/registry`）：`src/webview/mod.rs` 的 `Command {cmd} not allowed by ACL`（发布版，`invoke.acl.is_none()` 时）、`Command {command} not found`；`src/ipc/authority.rs` 的 `resolve_access_message`（调试版：`{cmd} not allowed. Command not found` / `Plugin not found`）。页面是 `127.0.0.1:5210` 的远程来源，而老外壳的权限清单里没有 `account_bridge`（`build.rs` 的 `app_manifest` 与 `capabilities/account.json` 都是 0.2.8 才加），所以老外壳走的是第一句。

## 造「老外壳」用的报错形状及依据

- 形状：`invoke('account_bridge', …)` 的 Promise 以**字符串**拒绝，内容 `Command account_bridge not allowed by ACL`（其余三句也在单测里全测了）。读版本的命令 `plugin:app|version` 在更老的外壳上也被拒，替身里用 `plugin:app|version not allowed by ACL`。
- 依据：上一节的 Tauri 源码；`desktop/src-tauri/build.rs`（0.2.8 才把 `account_bridge` 登记进 `app_manifest`）；`git show promptcut-v0.2.0:desktop/src-tauri/capabilities/default.json`（0.2.0 只有 `core:default`、`opener:default`、`window-state:default`，且 `remote.json` 到 2026-09-08 才有，所以更老的外壳连读版本也不行）。
- **没有真装一个 0.2.7 外壳**：这一条靠源码和替身，没有实机证据。用户自己测补丁演练时可以顺带点一下这两处看是不是那句话（见「待用户项」）。

## 两处入口的文案

同一句，放在 `OLD_SHELL_ACCOUNT_TEXT`：

> 这个功能要装完整安装包。你现在用的桌面外壳比较旧，只装更新补丁换不掉它，云端项目和账号登录要新外壳才能用；请安装最新的完整安装包。本地项目不受影响，照常可用。

- 为什么不行：装的是更新补丁，补丁换不掉外壳，这个功能要新外壳。怎么办：安装最新的完整安装包。顺带说明本地项目不受影响。
- 入口一（开始页「云端项目」）：用现有的 `sp-muted` 淡色说明；入口二（设置里「搬到云端」）：用现有的 `pc-sync-warn` 警示块，点「确定」或房间里点「搬到云端」后同一句进状态行（`info` 色调，不是红色错误）。

## 验证

门槛命令里的两个环境变量（本机值）只在命令行里设，没写进任何文件、提交或本报告。

### 单测、探针（已跑）

- `node --experimental-test-module-mocks --test src/account/desktopShellOld.test.mjs`：10 条，10 过，0 败。
- `node … --test-global-setup=server/test/global-setup.mjs --test src/account/oldShellFlow.test.mjs`：1 条，1 过，0 败。
- 探针：`node scripts/probes/old-shell-account-probe.mjs --port 5910`，退出码 0，`{"ok":true,"fails":[]}`。检查项（都过）：
  - 老外壳·开始页：云端项目一块是那句说明；无红色错误条；无登录表单和加入表单；无页面异常；确实调了一次 `account_bridge('configuration')` 并被拒。
  - 老外壳·设置（勾多用户协作 → 云端）：显示那句说明，没有创建者表单和账号登录表单；点「确定」后状态行是那句说明、没有继续搬、没有弹框、没有页面异常；改填别的节点地址后说明消失，旧办法的创建者表单照旧出现。
  - 老外壳·已开启的本机协作房间点「搬到云端」：状态行是那句说明、没有弹确认框、本机协作房间原样还在。
  - 真错误（外壳返回 `desktop-account-bridge`）：红色错误条照常显示，没有说成要装完整安装包。
  - 新外壳权限配错（原话与老外壳相同，版本 0.2.8）：红色错误条照常显示，没有说成要装完整安装包。
  - 新外壳正常：登录表单照旧，先取配置、再恢复登录，没有说明也没有错误条；设置里是账号这一套（有「账号说明」，没有老外壳说明）。
- 看过的图（都在 `out/` 下，被仓库忽略不入库）：
  - `out/old-shell-account-1-start.png`：开始页「云端项目」一块是那句说明。
  - `out/old-shell-account-2-move.png`：设置 → 多用户协作 → 云端：警示块，点确定后状态行同一句。
  - `out/old-shell-account-4-room.png`：已开启的本机协作房间，点「搬到云端」后状态行同一句。
  - `out/old-shell-account-3-real-error.png`：真错误对照图（红色错误条「账号入口初始化失败。」）。

## 没做成的、对语义与任务书的意见

- **无真老外壳实测**（见上）。
- **真错误的文案**：Tauri 以字符串拒绝，`useAccountProjects` 的 `e instanceof Error ? e.message : '账号入口初始化失败。'` 一直把它显示成通用句，真错误原话看不到。这是原有行为，我没动（不在任务内）。
- **`src/editor/sync/recoveryAssociation.ts` 第 194 行附近**：重开带云端关联的文件时，老外壳上 `accountCloud()` 回 null，提示的是「请先登录网站账号；当前以本地副本打开」——在老外壳上登录是走不通的，提示有点误导，但不报错、不崩，本次没改（不在清单；要改的话在 `flow.accountShellTooOld()` 为真时换成那句话即可）。
- **缺省云端怎么认**：老外壳读不到账号云端配置（`configuration` 就是被拒的那个调用），`oldShellBlocksAccountMove` 拿内置缺省托管地址（`hosted.DEFAULT_HOSTED_URL`，现在是 `hosted.visuhive.com/hosted`）当账号云端认。用户手填 `https://visuhive.com` 这类账号站点地址时认不出，走旧办法，旧办法对缺省云端会被服务端回 `account-mode` 拒绝（原有行为）。
- **语义文档要补的**（我不动 `docs/semantics/**`，交给主 Agent）：`docs/semantics/workflow/project.md` 第 22 行「搬到云端」一段和 `docs/semantics/product/platforms.md`（桌面壳）可以补一句：外壳比 0.2.8 老（只打了更新补丁）时，开始页「云端项目」和设置里的「搬到云端」说明「这个功能要装完整安装包」，不报错。
- 进度文件 `docs/plan/three-versions-progress.md` 第 146 行那一条可以勾掉（我不动 `docs/plan/**`）。
- 待用户项：真实老外壳（0.2.0～0.2.7）打 0.7.19 补丁后，点开始页「云端项目」和设置里「搬到云端」各看一眼是不是那句话。

## 门槛结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 构建 | `npm run build` | 退出码 0（`✓ built in 2.54s`；有原有的 `INEFFECTIVE_DYNAMIC_IMPORT` 警告，与本次无关） |
| 全量测试，第一遍 | `npm test`（设了两个账号服务环境变量） | `ℹ tests 7554 / pass 7537 / fail 1 / cancelled 1 / skipped 15`，终态「仍有失败」。失败的两条：`server/test/asset-project-workers.test.mjs` 的「真实ffmpeg项目worker独立转码/登记…」（20 s 超时）、`server/test/cloud-tools-w1-browser.test.mjs` 的 `W1-CFG-03`（47 s） |
| 全量测试，第二遍 | 同上 | `tests 7554 / pass 7529 / fail 7 / cancelled 3 / skipped 15`。这一遍机器上正好有别的 Agent 在跑验收和探针，失败都是长超时的进程类用例：上面那条 ffmpeg、`cloud-tools-p3-motion` 的 `P3-M4`、`cloud-tools-p3-track` 的 `P3-04`、`cloud-tools-w1-browser` 的 `W1-TOOL-03`、`cloud-tools-w1-egress` 的 `W1-EGRESS-09`、`conversation-delete-running` 的「块五第 7 条」、`custom-measure` 的 `CM-7`/`CM-8`、`docservice-auth` 的 `A6` |
| 失败文件单跑复核 | `npm test -- <上面两遍里失败的 8 个文件>`（一次跑完） | `ℹ tests 91 / pass 91 / fail 0 / cancelled 0 / skipped 0`，「零失败」，退出码 0。其中 `asset-project-workers`、`cloud-tools-w1-browser` 此前也各单跑过一次，都全过（11/11、15/15） |
| 本次新增的测试 | 两遍全量里都出现并通过 | `desktopShellOld.test.mjs` 10 条、`oldShellFlow.test.mjs` 1 条 |
| 探针 | `node scripts/probes/old-shell-account-probe.mjs --port 5910` | 退出码 0，`{"ok":true,"fails":[]}`（见上） |

解读：两遍全量里的失败都落在与账号入口无关的、靠进程和时限的用例上（转码、浏览器服务、取消与超时、服务进程），第一遍是 2 条、第二遍是 9 条（机器更忙），单独重跑全部通过；本次改动的文件所对应的账号类测试在两遍里都全过。`T3-8`（`media-tiers`）这两遍里都过了，没有出现。日志都有 `ℹ tests N` 汇总行，不是被截短的日志。

没有跑「导出确定性」「快照重放一致」：本次不碰渲染、预渲染、导出，按 `verification.md`「按改动范围验证」不适用。
