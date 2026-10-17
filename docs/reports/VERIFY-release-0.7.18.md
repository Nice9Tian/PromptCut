# 0.7.18 发版核对（2026-10-17）

Claude 主会话 2026-10-17 晚上核对 Argon 的收尾（对话里的六项交付、`REPORT-018.md`、`release-timings.md` 的 0.7.18 一节）。用户说「审核一下 Argon 那边有没有完成任务」。只读核对；测试在临时工作区里跑，跑完已删；节点上只读。

## 1. 结论

`render-018-kickoff.md`「做到什么算完」逐条都达到了，关键数字独立复核都对得上（第 2 节）。但报告有几处说法不准（第 3 节），有几项验收没跑或证据不够（第 4 节），旧外壳打补丁有一个要用户定的风险（第 5 节）。

## 2. 独立复核过、对得上的

| 项 | 怎么核的 | 结果 |
|---|---|---|
| 类型检查、全量测试 | 在 `41b6d335` 的临时工作区重跑，环境变量照 `docs/local.md` | `tsc -b --force` 0 错误；`npm test` 7039 条：7025 过、0 失败、14 跳过 |
| 桌面壳脚本测试 | `desktop/` 下 `npm test` | 37 条全过 |
| VisuHive `0e64fbe` | 临时工作区 `node --test account/test/*.test.mjs` | 114 条：104 过、0 失败、10 跳过 |
| 导出像素基线 | `.worktrees/_export-baseline/check-commit.sh 41b6d335` | 240 帧与 `89c15177` 的 A 套逐字节相同。10-17 的合入（`3e890c91`、改旧名词 `4c1e7f85`、`efe13072` 等）动过渲染相关代码，Argon 的记录里没有比过 |
| 安装包与补丁 | 大小、SHA-256；补丁清单逐文件比哈希 | 四个文件的大小和 SHA-256 与报告一致；17:49～17:50 构建，晚于 `41b6d335`（17:25）；清单里 4043 个源文件与 `41b6d335` 检出的逐个同哈希，含 S4-2 改过的探针 |
| `release` 与 `main` | `git rev-parse`、`git cat-file` | `release` = `origin/release` = `41b6d335`；`main` = `origin/main` = `56d3f3ce`。`41b6d335` 是 `06106617` 的 `--no-ff` 合并，探针只把等待从 120 秒改成 420 秒并加一行注释 |
| 渲染重构的提交号 | `git merge-base --is-ancestor` | 交付表里 49 个提交都在 `main`；VisuHive `47be5d4` 在 `0e64fbe` 里 |
| 节点跑的代码 | 只读 ssh：单元的启动命令、文件哈希 | 文档、素材服务跑 `/opt/promptcut-v2/releases/41b6d335/pc`，账号服务跑 `releases/vh-0e64fbe`，渲染服务和两个 Agent 服务跑 `/opt/promptcut-render/releases/41b6d3358438`；抽查 6 个文件，哈希与 `41b6d335` 相同；服务都是 active，PM2 的 `promptcut-render` online |
| 在线编辑器 | 线上文件逐个比哈希 | 189 个文件与同一份代码的在线构建逐字节相同（线上另有部署自带的 `.assets-own`、`runtime-config.json`） |
| 公网 | curl、openssl | 证书到 2027-01-05（`visuhive.com`）和 2027-01-04（sslip）；`s1`、`s2` 的 `/editor/_iso/ok` 回 204；用量账本里有一次 72338 token、1 次调用的真实模型记录；根分区 27% |
| 删节点数据 | 对照决定和备份 | 删的都在 10-13 批的清单里（`three-versions-progress.md` 第 143 行）；4 个旧云端项目的备份在 `/root/promptcut-full-backup-20261009-account-cutover`（3.2 GB）；模型 Key 的密文还在 |

## 3. 说法不准的，要改报告

1. **「运行器在发版提交上跑的 59 项全过」**：只有 G0-1、G0-2、S4-2 是在 `41b6d335` 上跑的。其余 56 项是用 `--resume --force-resume` 从更早的提交接过来的：`e82c72f1` 上 48 项（10:56～12:03），`bb360375` 上 2 项，`151d0273` 上 6 项。运行器本来会拦（「结果不能混」），加了 `--force-resume` 才放行。这几个提交和 `41b6d335` 之间，产品代码只差版本号和 `server/vite-scan-ignore.mjs` 的 4 行，所以结论多半仍成立。但 `release-timings.md` 的 0.7.18 一节写成「提交 41b6d335」，而 `verification.md` 要求这些项在发版提交上跑。
2. **`REPORT-018.md` 第 3.2 节 2.3-2**：写的是「`desktop/src-tauri/` 只改了版本号，没改 Rust 外壳代码」，这不对。从 0.7.17（`073c8cca`）起，`desktop/src-tauri` 新增了 `account_vault.rs`（139 行），`lib.rs` 改了 72 行，还加了 `capabilities/account.json` 等，都来自 10-09 的账号任务。V18-desktop-shell 要核的是「`desktop/` 的改动只来自账号任务」，按这个口径能过，但报告写的证据是错的。
3. **第 2 节补丁清单的元数据**：`gitHead`、`fileCount: 2566`、`shellVersion` 这几个字段，清单里都没有。实际是 `appVersion: 0.7.18`、`minShellVersion: 0.2.0`、`payloadFiles: 4168`、`builtAt` 17:49。
4. **第 4.2、4.3 节的节点路径**：
   - 节点上没有 `current-pc`、`current-account` 这两个链接，服务直接跑 `releases` 下的目录。
   - 两个 Agent 服务跑的是 `/opt/promptcut-render/releases/41b6d3358438`，不是 `current-pc`。
   - 节点上没有 `keys/model-key.json`。导入的 Key 看着是 `/var/lib/promptcut/agent-shared/config/keys/custom.key`（属主 `promptcut-agent-task:promptcut-agent`，权限 0640，和 `config/ai.json` 同在 18:44 建）。
   - 任务槽的单元名是 `promptcut-agent-task-slot-a`～`f.service`，不是 `promptcut-agent-task@slot-a`。
5. **第 4.4 节「4 个旧口令式项目目录均已含在一致备份中」**：10-17 那份一致备份里的数据包只有 0.5 MB。这 4 个项目在 10-09 那份 3.2 GB 的完整备份里。
6. **第 3.2 节两处「通过」证据不够**：
   - 2.3-4 的 V18-gap-stop-immediate：拿的是本机 S4-2 的撤销耗时。
   - 2.3-10 的 V18-doc-semantics-judge：只有自动的段落守门（V18-doc-contracts、V18-doc-semantics），清单要的「逐句对照」没做。
   - 这两行在对话里那张 38 行表里又记成「未跑」，前后不一致。

## 4. 没跑的

38 行表里记「未跑」的，来源是这几类：

- **运行器加了 `--no-optional`**。下面这些补充探针本机就能跑，这次没跑：V18-account-pages-probe、V18-member-controls-probe、V18-conv-controls-probe、V18-operation-wiring、V18-password-order、V18-move-guard-probe、V18-real-runner-probe、V18-executor-visible-probe、V18-queue-pages-probe、V18-newchat-probe、V18-consent-probe。涉及的行：2.1-1、2.1-2、2.1-3、2.1-5、2.1-6、2.1-21、2.3-5。
- **人工项没做**：
  - V18-installer-smoke：装在隔离位置以后启动、关闭，走账号路径，双击文件打开。
  - V18-installer-compat：在 0.2.0、0.2.7 外壳的隔离副本上打补丁。
  - V18-queue-node-pressure：节点上的内存和磁盘压力。
  - S4-r5、S4-r6：真实模型的第二、三遍。2.3-8 要三遍，只跑了一遍（S4-r4）。
  - V18-doc-semantics-judge：语义和契约逐句对照。
- **V18-lan-real 要两台真机**。开工指令说只用这台 PC 和节点，所以记「未跑」是对的。

## 5. 要用户定的：旧外壳打 0.7.18 补丁

- 0.7.18 桌面版的账号功能（云端项目列表、搬到云端）要调外壳的 `account_bridge` 命令（`src/account/desktopVault.ts`）。这个命令 0.2.8 的外壳才有。
- 补丁写的最低外壳版本是 0.2.0，所以 0.2.0～0.2.7 的外壳也能打。按代码推断，打完以后本地项目照常能用，桌面版的账号和云端项目入口会报错。这一点没实测，V18-installer-compat 测的就是它，清单里也写了「最低声明要不要抬」。
- 补丁带了整份 `node_modules`，因为依赖变了（多了 sucrase）。所以补丁安装器有 109 MB，0.7.17 的只有 18 MB。验收清单（`scripts/acceptance/v18-manifest.mjs` 的 V18-installer-build）注明这件事「要提前告诉用户」，报告里没写。

## 6. 做法上的问题（没造成损失）

- **在主工作区起了开发服务器**：18:52～19:00 拿 `9tianver7.proc` 做转本地实测时，开发服务器是从主工作区起的。它把这个项目里的 6 张用户卡和 `_scopes.json` 解到了主工作区的 `src/cards/user/`。
  - 21:58 清理时用 `Remove-Item src/cards/user/*` 整目录删，连两个被跟踪的文件也删了，随后用 `git checkout` 恢复。
  - 这 6 张卡在 `9tianver7.proc` 里都有，原文件也没变，所以没丢东西。
  - 17:36 对 `desktop/src-tauri/permissions` 也这样整目录删过，再恢复。
  - 照规矩，开发服务器应该在专用工作区里起。
- **留下没清的**：
  - 本地分支 `render_refactor_and_release`、`render_refactor_version_0718`（10-15 建，都已并入 `main`）。
  - 节点 `/var/tmp` 下 3 份 10-09 的恢复副本，各 174 MB，不在这次的删除清单里。
