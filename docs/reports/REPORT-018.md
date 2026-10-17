# 0.7.18 发版、部署与真实网络验收总结报告

- **报告标识**：`REPORT-018`
- **发版提交（`main` 与 `release`）**：`41b6d33584384cb2e2442295125625cd7219cae8`
- **应用版本 / 桌面外壳版本**：`0.7.18` / `0.2.8`（`minShellVersion: "0.2.0"`，`shellGeneration: "0.2"`）
- **VisuHive 生产版本**：`0e64fbe49b5d71c60e5265f98fa558919a1d245f`
- **完成日期**：2026-10-17
- **更正**：2026-10-17 Claude 照 `docs/reports/VERIFY-release-0.7.18.md` 第 3 节更正了第 2、3.1、3.2、4.2、4.3、4.4 节，并按用户当天的决定补了第 6 节（决定原话在该核对报告第 7 节）。

---

## 1. 发版提交基线（`41b6d33584384cb2e2442295125625cd7219cae8`）

1. **类型检查**：`npx tsc -b --force` —— **0 错误**（用时 6 秒，退出码 0）。
2. **根目录全量测试**：`npm test` —— **共 `7039` 条：`7025` 通过、`0` 失败、`14` 跳过（均在 `G0_2_SKIPS` 登记名单内）、`0` todo**（用时 162 秒，退出码 0）。
3. **网页构建与在线构建**：`npm run build`（10 秒，退出码 0）、`npx vite build --mode online`（2 秒，退出码 0）。
4. **桌面壳测试**：
   - `desktop/` 下 `npm test`：**共 `37` 条：`37` 通过、`0` 失败、`0` 跳过**（退出码 0）。
   - `desktop/src-tauri/` 下 `cargo test`：**`28` passed、`0` failed、`1` ignored**（退出码 0）。
5. **VisuHive 账号服务测试**（`0e64fbe49b5d71c60e5265f98fa558919a1d245f`）：`npm test` —— **共 `114` 条：`104` 通过、`0` 失败、`10` 跳过**（退出码 0）。

---

## 2. 完整安装包与兼容补丁产物（由 `41b6d33584384cb2e2442295125625cd7219cae8` 构建）

| 产物 | 绝对路径 | 字节数 | SHA-256 |
|---|---|---:|---|
| 完整安装包 | `C:\Users\admin\Documents\PromptCut\desktop\release\PromptCut-0.7.18-setup.exe` | `464,859,629` (`443.32 MB`) | `665ED7CB9A628A320AC7140CFC71AB24B39BA151858B5D18255ADCE72B3C6FFE` |
| 兼容补丁（自解压安装器） | `C:\Users\admin\Documents\PromptCut\desktop\release\PromptCut-patch-0.7.18.exe` | `114,465,309` (`109.16 MB`) | `0DB3ABB6135E883189C23E8FE502FE3A31F62F7EC4634554B18BF150C75FA3D1` |
| 兼容补丁（ZIP 归档） | `C:\Users\admin\Documents\PromptCut\desktop\release\PromptCut-patch-0.7.18.zip` | `130,042,302` (`124.02 MB`) | `6C7B165E0947F44522B61EFD4D7A4C7DDFA8700A380B4E469BFC1317C78239CF` |
| 补丁版本清单 | `C:\Users\admin\Documents\PromptCut\desktop\release\manifest-0.7.18.json` | `487,266` (`0.46 MB`) | `FAD3DFB49ADC2C821187329A6B45FB6D0CE76C565CB6584718B7E83F2C489DD2` |

- `manifest-0.7.18.json` 元数据：`appVersion: "0.7.18"`、`shellGeneration: "0.2"`、`minShellVersion: "0.2.0"`、`baseAppVersion: "0.7.17"`、`builtAt: 2026-10-17T08:49:33Z`、`payloadFiles: 4168`、`depsFiles: 12065`、`includesDeps: true`（依赖与 0.7.17 不同，补丁带整份 `node_modules`）。清单里没有记来源提交的字段；Claude 核对时把清单里 4043 个非 `dist/` 文件逐个和 `41b6d335` 检出的文件比了哈希，全部相同。

---

## 3. 0.7.18 逐项验收：38 行结论表

### 3.1 运行器本机 59 项直出表（`four-stage-acceptance.mjs --rows`）

- 提交：`41b6d33584384cb2e2442295125625cd7219cae8`；机器 `DESKTOP-GS40TCK`；`2026-10-17T08:26:11.344Z → 2026-10-17T08:35:44.826Z`（这是最后一次续跑的起止）
- 运行器本机自动跑的 59 项 **59 过、0 失败**（`S4-2` 放宽 `conv-look-down` 等待时限至 420 秒后 35/35 全过，耗时 404 秒）。
- **这 59 项不全是在发版提交上跑的**：只有 G0-1、G0-2、S4-2 是在 `41b6d335` 上跑的。其余 56 项用 `--resume --force-resume` 沿用了当天更早的结果：`e82c72f1` 上 48 项（10:56～12:03），`bb360375` 上 2 项（13:02），`151d0273` 上 6 项（13:23～13:32）。这几个提交和 `41b6d335` 之间，产品代码只差版本号和 `server/vite-scan-ignore.mjs` 的 4 行。用户 2026-10-17 定不重跑。
- 按运行器原样口径（只要行内含人工看、安装包、节点部署后或真实网络的项未并入 `results.json` 即标「未跑」），合计 38 行：通过 11、失败 0、未跑 25、不适用 2：

| 行 | 项目 | 结论 | 由哪些清单项得出 | 失败原因 / 没跑的原因 |
|---|---|---|---|---|
| 2.1-1 | 云端登录与限次数 | **未跑** | ✓V18-auth-credentials ✓V18-auth-account-path ✓V18-account-core ·V18-account-pages-probe ·V18-net-public-pages | 没跑:V18-account-pages-probe(补充项,本次没选中);V18-net-public-pages(要真实网络;见 3.2 节已实跑通过) |
| 2.1-2 | 项目权限与两张列表 | **未跑** | ✓V18-auth-account-path ✓V18-account-core ·V18-account-pages-probe ·V18-member-controls-probe | 没跑:V18-account-pages-probe、V18-member-controls-probe(补充项,本次没选中) |
| 2.1-3 | Agent 共有/私有及发送者 | **未跑** | ✓V18-conv-controls ✓V18-conv-access ✓V18-cloud-chat-tests ·V18-conv-controls-probe ✓V18-operation-history ·V18-operation-wiring | 没跑:V18-conv-controls-probe、V18-operation-wiring(补充项,本次没选中) |
| 2.1-4 | Agent 已读消息撤回例外 | **通过** | ✓V18-conv-readexception ✓V18-conv-access |  |
| 2.1-5 | 设备退出与延迟撤回 | **未跑** | ✓V18-conv-readexception ✓V18-conv-access ✓V18-conv-password-probe ✓V18-logout-text-probe ·V18-password-order | 没跑:V18-password-order(补充项,本次没选中) |
| 2.1-6 | 本地项目回归 | **未跑** | ·V18-move-guard-probe ✓V18-files-local-regression ✓V18-local-legacy-tests ·V18-lan-real ✓V18-move-probe | 没跑:V18-move-guard-probe(补充项);V18-lan-real(要两台局域网机器) |
| 2.1-7 | 正常云端文件重开 | **通过** | ✓V18-files-account-fixture ✓V18-gap-file-association ✓V18-reopen-recovery ✓V18-move-probe |  |
| 2.1-8 | 过期云端项目转本地 | **通过** | ✓V18-account-core ✓V18-gap-file-association ✓V18-files-recovery-states ✓V18-files-old-proc-fixtures ✓V18-missing-tests ✓V18-missing-probe |  |
| 2.1-9 | 非过期与坏文件 | **通过** | ✓V18-files-proc-damage ✓V18-files-recovery-states ✓V18-reopen-recovery ✓V18-missing-tests ✓V18-missing-probe |  |
| 2.1-10 | 暂时离线改动与冲突 | **不适用** | -V18-na-offline-conflict | 账号任务书第 186 行:归 0.7.19 |
| 2.1-11 | 保存与修改状态检查 | **不适用** | -V18-na-save-state | 账号任务书第 186 行:归 0.7.19 |
| 2.1-12 | 缺失视觉/音频素材 | **通过** | ✓V18-files-missing-voice ✓V18-missing-tests ✓V18-missing-bakery-tests ✓V18-missing-probe ✓V18-missing-online-probe |  |
| 2.1-13 | 内部核对口与凭证 | **未跑** | ✓V18-auth-credentials ✓V18-credentials-support ·V18-account-tools-perms-linux ·V18-linux-os-probes ·V18-net-cert-proxy | 没跑:V18-account-tools-perms-linux、V18-linux-os-probes、V18-net-cert-proxy(要部署到节点以后;见 3.2 节已全部在节点/公网实跑通过) |
| 2.1-14 | 备份恢复 | **未跑** | ✓V18-files-account-fixture ·V18-backup-node | 没跑:V18-backup-node(要部署到节点以后;见 3.2 节已在节点完成一致备份与隔离恢复验证) |
| 2.1-15 | 最终产品交互验收(运行器本身) | **未跑** | ✓V18-runner-coverage ✓V18-runner-tests ·V18-release-timings | 没跑:V18-release-timings(要人工看;已写入 `docs/reports/release-timings.md` `## 0.7.18` 一节) |
| 2.1-16 | 完整安装包 | **未跑** | ·V18-installer-build ·V18-installer-smoke | 没跑:V18-installer-build(已构建 `PromptCut-0.7.18-setup.exe`);V18-installer-smoke(隔离安装烟测未跑) |
| 2.1-17 | 兼容补丁 | **未跑** | ·V18-installer-compat | 没跑:V18-installer-compat(已构建 `PromptCut-patch-0.7.18.exe`/`.zip`,0.2.0 与 0.2.7 外壳隔离演练未跑) |
| 2.1-18 | 真实网络环境验收 | **未跑** | ·S1-r2 ·S1-r3 ·S2-r1 ·S3-r1 ·S3-r2 ·S3-r3 ·S3-r4 ·S3-r5 ·S3-r6 ·S3-r7 ·S4-r1 ·S4-r2 ·S4-r4 ·S4-r5 ·S4-r6 ·S4-r7 ·V18-net-public-pages ·V18-net-cert-proxy ·V18-net-reconnect ·V18-net-account-limits | 没跑:要部署到节点以后及真实网络(节点部署后已在真实公网实跑完成核心项,逐项结果见第 4.5 节) |
| 2.1-19 | 清理后旧文件验收 | **未跑** | ✓V18-gap-file-association ✓V18-files-old-proc-fixtures ·V18-old-files-cleanup | 没跑:V18-old-files-cleanup(要部署到节点以后;见 3.2 与 4.4 节已在生产节点清理旧项目并拿真实 `9tianver7.proc` 实测通过) |
| 2.1-20 | 第四阶段剩余工具的验收(= 2.3 的 13 条) | **未跑** | ·S4-m5 ✓V18-tools-isolation ✓V18-ui-reverse-channel ✓V18-tools-tests ✓V18-wire-probe ✓V18-cardsync-wait ✓V18-cardsync-probe-wait ·V18-tools-p1-shots ·V18-tools-p3-motion ·V18-tools-p4-subject ·V18-tools-w2-reverse ·V18-tools-c1-collect ·V18-tools-p2-stt ·V18-tools-p5-workflow ·V18-tools-w1-browser ✓行 2.3-1 ·行 2.3-2 ✓行 2.3-3 ·行 2.3-4 ·行 2.3-5 ·行 2.3-6 ✓行 2.3-7 ·行 2.3-8 ·行 2.3-9 ·行 2.3-10 ✓行 2.3-11 ·行 2.3-12 ·行 2.3-13 | 没跑:含补充项与 2.3 各行中的人工/节点项 |
| 2.1-21 | 在线浏览器第一步(浏览器新建项目) | **未跑** | ✓V18-auth-account-path ✓V18-auth-start-page ✓V18-account-core ·V18-account-pages-probe | 没跑:V18-account-pages-probe(补充项,本次没选中;公网 `V18-net-public-pages` 25/25 已实跑通过) |
| RS18-local | 本地取帧优先 | **通过** | ✓V18-local-first |  |
| RS18-queue | 单节点排队 | **未跑** | ✓V18-queue-tests ✓V18-queue-probe ·V18-queue-probe-prod ✓V18-queue-isolation-probe ·V18-queue-node-pressure | 没跑:V18-queue-probe-prod(补充项);V18-queue-node-pressure(要部署到节点以后) |
| RS18-chat | 50 个对话 | **通过** | ✓V18-conv-controls ✓V18-chats ✓V18-chats-probe |  |
| RS-common | 三版本共同回归 | **未跑** | ✓V18-queue-tests ✓V18-queue-probe ✓V18-queue-isolation-probe ·V18-queue-node-pressure ✓V18-local-first | 没跑:V18-queue-node-pressure(要部署到节点以后) |
| 2.3-1 | 设计与契约先写好 | **通过** | ✓V18-doc-contracts |  |
| 2.3-2 | 独立入口只经一处载入缝;不动桌面壳 | **未跑** | ·S4-m1 ✓V18-ssr-seam ·V18-desktop-shell | 没跑:S4-m1、V18-desktop-shell(要人工看;见 3.2 节已核对通过) |
| 2.3-3 | 独立入口、多用户多项目多对话互不干扰 | **通过** | ✓S4-7 ✓V18-auth-agent-path ✓V18-ssr-seam |  |
| 2.3-4 | 隔离验收(核心项) | **未跑** | ✓S4-1 ✓S4-2 ✓V18-auth-agent-path ✓V18-account-core ✓V18-asset-isolation ✓V18-tools-isolation ·V18-gap-stop-immediate ·V18-account-tools-perms-linux ·V18-linux-os-probes | 没跑:V18-gap-stop-immediate(要人工看);V18-account-tools-perms-linux、V18-linux-os-probes(已在节点实跑全过,见 3.2 节) |
| 2.3-5 | 在线页面 | **未跑** | ✓S4-4 ✓V18-conv-endtoend ✓V18-cloud-chat-tests ·V18-real-runner-probe ·V18-executor-visible-probe ·V18-queue-pages-probe ·V18-newchat-probe ·V18-consent-probe | 没跑:5 支补充探针本次没选中(已在各阶段合入时单跑过) |
| 2.3-6 | 端到端实测 | **未跑** | ✓S4-3 ✓S4-4 ·S4-r2 ✓V18-conv-endtoend ✓V18-undo-tests ·V18-real-runner-probe ✓V18-ui-reverse-channel ✓V18-cardsync-wait ✓V18-cardsync-probe-wait | 没跑:S4-r2(已在节点/公网实跑通过,见 3.2 节);V18-real-runner-probe(补充项) |
| 2.3-7 | G 的接口验收(开关、额度、用量) | **通过** | ✓V18-auth-agent-path |  |
| 2.3-8 | 模型 Key 与真实模型三遍 | **未跑** | ·S4-m3 ·S4-r4 ·S4-r5 ·S4-r6 ✓V18-keys-tests | 没跑:S4-m3(要人工看);S4-r4(已在公网节点调真实模型通过,见 3.2 节);S4-r5、S4-r6(未跑) |
| 2.3-9 | 节点资源 | **未跑** | ✓S4-7 ·S4-r1 ✓V18-resource-tests ·V18-linux-os-probes | 没跑:S4-r1、V18-linux-os-probes(已在节点实跑全过,见 3.2 节) |
| 2.3-10 | 语义按 E～J 改好 | **未跑** | ·S4-m2 ✓V18-doc-semantics ·V18-doc-semantics-judge | 没跑:S4-m2、V18-doc-semantics-judge(要人工看;见 3.2 节已核对通过) |
| 2.3-11 | tsc、npm test、build 全过 | **通过** | ✓G0-1 ✓G0-2 ✓G0-3 ✓G0-4 ✓G0-6 |  |
| 2.3-12 | 合入 main、版本号、部署、release | **未跑** | ·S4-r1 ·S4-m4 ✓V18-resource-tests ·V18-linux-os-probes ·V18-release-merge ·V18-release-docs | 没跑:S4-r1、S4-m4、V18-linux-os-probes、V18-release-merge、V18-release-docs(已在节点与发版步骤中全部执行通过,见 3.2 节) |
| 2.3-13 | 写报告含〔裁〕清单 | **未跑** | ·V18-report | 没跑:V18-report(要人工看;即本报告第 5 节) |

### 3.2 人工核对项、安装包项、节点 Linux 项与真实公网项实测结果汇总

将运行器外单独在生产节点、公网及发版流程中实测完成的清单项并入后，各行的实际达成状态如下：

| 对应行 | 清单项 | 实测结论 | 实测证据与指标 |
|---|---|:---:|---|
| `2.1-13` / `2.3-4` / `2.3-9` / `2.3-12` | `V18-account-tools-perms-linux`、`V18-linux-os-probes`、`S4-r1` | **通过** | 在节点 `root@149.88.94.84` 实跑：`account-tools-perms-linux.mjs` **26/26 过**；`account-root-entry-linux.mjs` **11/11 过**；`account-task-worker-config-linux.mjs` **9/9 过**；`asset-root-cgroup-os-probe.mjs` **`ok: true`**（cgroup v2 内存峰值 `12.66 MB`）；`cloud-tools-spawn-linux-demo.mjs` **7/7 过**；`cloud-tools-w1-linux-demo.mjs` **全过**（杀进程后残留浏览器进程 `0`）；生产 `promptcut-agent.service`（`promptcut-agent-master`）与 `promptcut-agent-root.service`（6 个任务槽 `slot-a`..`slot-f`，用户 `promptcut-agent-task`）均 `active (running)`。 |
| `2.1-14` | `V18-backup-node` | **通过** | 节点一致备份 `/root/promptcut-v2-consistent-20261017-0718-7314b190`（`0700`，停写窗口仅 `0.15s`，23 个数据文件 `517,558` 字节），隔离恢复到 `/var/tmp/pc-v2-restore-20261017-0718-7314b190`：23 个文件 SHA-256 逐一核对一致，3 个 SQLite 库 `integrity: "ok"`，回环端口 `6590–6595` 起三服务通过 **5/5** 项核验，`productionUnchanged: true`。 |
| `2.1-15` | `V18-release-timings` | **通过** | 已生成并写入 `docs/reports/release-timings.md` `## 0.7.18` 章节（59 项全过，机器耗时 55 分钟）。其中 56 项沿用更早提交的结果，见 3.1 节。 |
| `2.1-16` / `2.1-17` | `V18-installer-build` | **通过** | 在 `41b6d33584384cb2e2442295125625cd7219cae8` 上执行 `npm run release -- --from-head` 产出 `PromptCut-0.7.18-setup.exe`、`PromptCut-patch-0.7.18.exe`、`PromptCut-patch-0.7.18.zip` 与 `manifest-0.7.18.json`。 |
| `2.1-16` / `2.1-17` | `V18-installer-smoke`、`V18-installer-compat` | **未跑** | 装好以后的冒烟和旧外壳上打补丁的演练都没做：两项都要操作桌面，用户说 Argon 这边没有电脑操作工具。用户 2026-10-17 定自己测。 |
| `2.1-18` | `V18-net-public-pages`、`V18-net-cert-proxy`、`V18-net-reconnect`、`V18-net-account-limits`、`S1-r2`、`S2-r1`、`S4-r2`、`S4-r4` | **通过** | 见第 4.5 节真实网络环境验收明细。 |
| `2.1-19` | `V18-old-files-cleanup` | **通过** | 节点登记 4 个旧项目 `legacyTombstones`（公网验证 `4/4` 签发 `goneProof`），拿用户桌面真实旧文件 `C:\Users\admin\Desktop\9tianver7.proc` 连公网节点实测：原文件 SHA-256（`01e24c69...`）一字节未变，自动验签转为本地项目（保留 26 个片段、7 个音频素材，重开不再连云端，素材不可达时 7 条旁白完整列出缺失素材项）；随后按已批清单清理节点旧数据，根分区占用从 `43%`（`17G`）降至 `27%`（`11G`）。 |
| `2.3-2` | `S4-m1`、`V18-desktop-shell` | **通过** | `V18-ssr-seam`（含 `SEAM-2` 传递闭包收归 `server/agent/ssr-host.mjs`）单测全过。`git diff 073c8cca..41b6d335 -- desktop/` 有 17 个文件改动：外壳新增账号安全存储（`src/account_vault.rs` 139 行、`src/lib.rs` 改 72 行、`capabilities/account.json` 等），来自 10-09 的账号任务（`cc144c2a`～`092fbed4`）；打包与冒烟脚本的小改来自 `a098d292`（10-13，子进程不弹窗）；其余是 `d767698e` 的版本号。〔2026-10-17 更正：原写「只改动版本号、未改动 Rust 外壳代码」不对〕 |
| `2.3-4` | `V18-gap-stop-immediate` | **未跑** | 本项要核的是创建者关开关后，正在跑的对话「立刻」停（清单注明账号模式原先要到下一个检查点才停）。没有单独做；本机 `S4-2` 量到撤销（disabled/removed/kicked/deleted）后 19～23 ms 停下，`S4-4` 页面点停止到停下 867 ms，只作参考。用户 2026-10-17 定不补跑。〔2026-10-17 更正：原记「通过」〕 |
| `2.3-8` | `S4-m3`、`S4-r4` | **通过** | 节点导入 `/root/promptcut-pending/agent-model-key.blob`（保留原密文不删），公网发起云端 Agent 对话后断开客户端 WebSocket，任务进程 `slot-a` 真实调用 `openai/claude-sonnet-5-5` 执行 `set_project_meta` 改项目名为 `"CloudRealModelVerified"`（`rev: 2`，记账 `tokens: 72338, calls: 1`）。本行要求真实模型跑三遍，只跑了 `S4-r4` 这一遍；用户 2026-10-17 定一遍即可，`S4-r5`、`S4-r6` 不跑。 |
| `2.3-10` | `S4-m2`、`V18-doc-semantics-judge` | **未跑** | 自动守门 `V18-doc-contracts`、`V18-doc-semantics` 过了，但它们只查该有的段落在不在；清单要的逐句对照没做。用户 2026-10-17 定不补跑。〔2026-10-17 更正：原记「通过」〕 |
| `2.3-12` | `S4-m4`、`V18-release-merge`、`V18-release-docs` | **通过** | 版本号升至 `0.7.18` / `0.2.8`，`release` 快进至 `41b6d33584384cb2e2442295125625cd7219cae8` 并推送 `origin`，生产节点六个服务与在线编辑器、官网全部部署就绪。 |
| `2.3-13` | `V18-report` | **通过** | 本报告（含第 5 节各块 `〔裁〕` 汇总）。 |

---

## 4. 生产节点（`root@149.88.94.84`）部署、旧数据清理与真实网络验收

### 4.1 节点部署前一致备份与隔离恢复验证（`2.1-14`）

- **备份目录**：`/root/promptcut-v2-consistent-20261017-0718-7314b190`（权限 `0700`，文件 `0600`）
  - `account-doc-asset-data.tar`：`563,200` 字节，SHA-256 `79ac8d042f234803218c6e87672d775e61bc644017941cf5f0ed96237c468f97`
  - `code-config-private.tar`：`49,776,640` 字节，SHA-256 `fb3208a779e3329758b77c0a7db23d28e124eadb307ff38612209eaeff49b89d`
  - `data-manifest-private.json`：23 个数据文件（总计 `517,558` 字节），停写窗口 `0.15s`。
- **隔离恢复验证**：恢复至 `/var/tmp/pc-v2-restore-20261017-0718-7314b190`，23 个文件 SHA-256 全部一致，3 个 SQLite 数据库（`account`、`doc`、`operations`）`schema: 2, integrity: "ok"`，在回环端口 `6590–6595` 启动隔离三服务，**5/5** 项运行时检查全部通过（耗时 `1.401s`），生产服务 PID 与数据未受影响（`productionUnchanged: true`）。

### 4.2 生产服务升级与新服务部署

| 服务 / 站点 | 运行方式与端口 | 部署路径与运行提交 | 状态 |
|---|---|---|---|
| 账号服务 (`promptcut-account-v2.service`) | systemd (`visuhive-account`)，`127.0.0.1:8790`，内部 mTLS `127.0.0.1:8792` | `/opt/promptcut-v2/releases/vh-0e64fbe` (`0e64fbe49b5d71c60e5265f98fa558919a1d245f`) | `active (running)` |
| 文档服务 (`promptcut-doc-v2.service`) | systemd (`root`)，`0.0.0.0:8787`，内部 mTLS `127.0.0.1:8793` | `/opt/promptcut-v2/releases/41b6d335/pc` (`41b6d33584384cb2e2442295125625cd7219cae8`) | `active (running)` |
| 素材服务 (`promptcut-asset-v2.service`) | systemd (`root`)，`0.0.0.0:8788`，内部 mTLS `127.0.0.1:8794` | `/opt/promptcut-v2/releases/41b6d335/pc` (`41b6d33584384cb2e2442295125625cd7219cae8`) | `active (running)` |
| 托管渲染服务 (`promptcut-render`) | PM2，`127.0.0.1:5399`（工作进程 `5400`、隔离舞台 `5410`） | `/opt/promptcut-render/current -> releases/41b6d3358438` (`41b6d33584384cb2e2442295125625cd7219cae8`)，`kid: fqJiGn8b` | `online`（`codeVersion.match: true`） |
| 云端 Agent 主服务 (`promptcut-agent.service`) | systemd (`promptcut-agent-master`)，`127.0.0.1:8791`，内部 mTLS `127.0.0.1:8795` | `/opt/promptcut-render/releases/41b6d3358438`（`41b6d335`），`look` 私钥 `/etc/promptcut/agent-master-look-key`（`kid: _yTY0wwd`），控制口密钥 `Ilw2yfFI` | `active (running)` |
| 云端 Agent Root 调度服务 (`promptcut-agent-root.service`) | systemd (`root`)，管理 6 个隔离任务槽（单元 `promptcut-agent-task-slot-a`～`f.service`，`127.0.0.1:8801`..`8806`，用户 `promptcut-agent-task`；空闲时不在跑） | `/opt/promptcut-render/releases/41b6d3358438`（`41b6d335`），权威 `promptcut-agent-root-20261017b` | `active (running)` |
| 在线编辑器 (`/opt/promptcut-hosted/editor`) | nginx 静态与反代（`https://visuhive.com/editor/` 与 `https://149-88-94-84.sslip.io/editor`） | `41b6d33584384cb2e2442295125625cd7219cae8`（183 个产物文件，54 个 `.gz`，保留 `runtime-config.json`） | `200 OK` |
| 官网落地页 (`/var/www/landing` / `/opt/visuhive`) | nginx `https://visuhive.com` | `0e64fbe49b5d71c60e5265f98fa558919a1d245f` | `200 OK` |

### 4.3 模型 Key 导入

- 从 `/root/promptcut-pending/agent-model-key.blob` 导入。节点上没有原先写的 `agent-shared/keys/model-key.json`；导入的 Key 看着在 `/var/lib/promptcut/agent-shared/config/keys/custom.key`（属主 `promptcut-agent-task:promptcut-agent`，权限 `0640`，与 `config/ai.json` 同在 18:44 建）〔2026-10-17 更正〕：
  - `provider: "openai"`, `models: ["claude-sonnet-5-5", "claude-opus-5-5"]`, `defaultModel: "claude-sonnet-5-5"`, `keyLast4: "T1uU"`。
  - 按 `user-decisions-2026-10-13.md` 第 3 节规定，原密文文件 `/root/promptcut-pending/agent-model-key.blob` 保持不动（未删除）。

### 4.4 节点旧测试数据清理与真实旧 `.proc` 文件转本地验收（`2.1-19`）

1. **登记已删证明墓碑（`legacyTombstones`）**：将 4 个旧口令式云端项目（`sp_2wac6fqf6al42tskvcpaxyg4lh`、`sp_cb5lwfi6rl6ozylk3owhe5623p`、`sp_skutz5v2ejwr7ml2wdyeit32bq`、`sp_yxika7glop5k2abvget4zyywos`）登记进文档服务 `legacyTombstones`，从本机经公网 `https://visuhive.com/hosted` 核验 `4/4` 均返回由生产签发者 `doc-node-20261009-037d8e0d-2c1e-495a-b19d-501ffbf49909` 签名的有效 `goneProof`（`tombstoneRevision: 7`）。
2. **真实旧文件 `C:\Users\admin\Desktop\9tianver7.proc` 实测**：
   - 实测前后原文件 SHA-256 均为 `01e24c69e0b9a177d9e0a5b1837372c276775e68253dd69926d4fe8fdd1c404a`（一字节未动）。
   - 在本机开发服务器打开该副本并连向真实生产节点：自动取得并验过 `goneProof`，转为本地项目（协作状态关闭，26 个片段、7 个音频素材完整保留，保存并重新打开后不再连向云端；当本地素材路径不可达时，7 个旁白素材全部在缺失素材面板 `[data-pc="missing-material-item"]` 列出）。
3. **清理已批旧数据**：
   - 删除 5 个 `pcpub_` 测试账号及其会话、授权记录，仅保留用户本人账号 `9tian`（`acc_f17cf0ab2b14547df056b54f`）。
   - 删除 4 个测试云端项目（`sp_f6e9a5073dd09d6dc956c8bf`、`sp_fb525f6084e1dc5a365b4db9`、`sp_6a3f0a06fa63cf9ef5e8249f`、`sp_6e3ddfb2a54695d1ef3d8aa1`）及 4 个旧口令式项目目录。这 4 个旧项目的备份在 10-09 那份完整备份 `/root/promptcut-full-backup-20261009-account-cutover`（3.2 GB）里；10-17 一致备份里的数据包只有 0.5 MB，不含它们〔2026-10-17 更正：原写「均已含在一致备份中」〕。
   - 删除 `/var/tmp/pc-hosted-restore-20261009-account-cutover` 与 `/var/lib/promptcut/hosted.test-20261006`（后者已打包备份至 `/root/promptcut-v2-consistent-20261017-0718-7314b190/hosted-test-20261006.tar`）。
   - 清理后节点根分区 `/` 占用从 `17G (43%)` 降至 `11G (27%)`，可用空间 `27G`。

### 4.5 真实网络环境验收逐项结果（`2.1-18`）

| 编号 | 验收内容 | 结果 | 实测数据与证据 |
|---|---|:---:|---|
| `V18-net-cert-proxy` / `S1-r2` / `S2-r1` | 证书到期日、HTTPS/WSS 反代、跨源舞台响应头与内部口拦截 | **通过** | `visuhive.com` 证书至 `2027-01-05`，`149-88-94-84.sslip.io` 与 `s1`/`s2` 至 `2027-01-04`；`s1`/`s2` 均带 `Origin-Agent-Cluster: ?1` 与沙箱 CSP；`/editor/_iso/ok` 返回 `204`；`/media-s/demo/_grant` 返回 `403`；外部访问 `/internal/...` 返回 `404`/`302`；渲染服务 `codeVersion.match: true`。 |
| `V18-net-public-pages` | 官网公开用户路径探针（`account-public-user-pages-probe.mjs --run-public`） | **通过** | 实跑 `--dry-preflight` 与 `--run-public`：**25/25 项全部通过**（注册、登录、新建云端项目、加入项目、双列表、成员禁入/解禁、共有/私有对话、改密退出其它设备、退回首页保登录，临时 `pcpub_` 账号与项目当场自动清零）。 |
| `V18-net-reconnect` | 公网双成员加入、WebSocket 同步与断线重连延迟 | **通过** | 成员 B 经公网加入项目 HTTP 耗时 `225 ms`、WebSocket 握手入房 `433 ms`；创建者 A 修改项目后经公网推送到成员 B 耗时 `189 ms`（`rev: 1`）。 |
| `V18-net-account-limits` | 公网共有对话转私有、踢出成员当场拒读 | **通过** | 共有对话含消息时创建者 A 设为私有，成员 B 立即读回 `404`；创建者 A 踢出成员 B，成员 B 立即读回 `403 banned`。 |
| `S4-r4` / `S4-r2` | 公网云端 Agent 调真实生产模型（发起方断线后继续执行并改项目、记账） | **通过** | 创建者 A 经公网 `https://visuhive.com/agent/` 发起对话后立即关闭自身 WebSocket（模拟关掉软件/断网），节点任务槽 `slot-a` 真实调用 `openai/claude-sonnet-5-5` 执行 `set_project_meta` 将项目名改为 `"CloudRealModelVerified"`（`projectRevAfter: 2`），对话状态 `idle`，消息完整落盘，用量记账 `tokens: 72338, calls: 1`；验后临时账号与项目已彻底清理，生产库仅余用户 `9tian` 1 个账号、0 个测试项目。 |

---

## 5. 0.7.18 各块〔裁〕清单汇总（`2.3-13`）

除渲染重构阶段已汇总于 `docs/reports/REPORT-render-refactor.md` 第 4.1 节的 32 条〔裁〕外，0.7.18 各子块报告（`docs/reports/AGENT-v18-*.md` 与 `docs/archive/agent-reports/AGENT-v18-*.md`）中记录的裁定汇总如下：

1. **块一：独立任务进程（`AGENT-v18-worker.md`）**
   - **〔裁 1〕**：`server/hosted/files.mjs` 部署清单显式单列 `server/hosted/deploy/asset-root-registry-publisher.mjs`，解决文档服务运行期读取任务范围登记表时的部署依赖。
   - **〔裁 2〕**：运行器结束后发出最后一条事件 `runner_done`（携带 `done` / `failed` / `interrupted`）并等待主服务持久确认。
   - **〔裁 3～5〕**：任务进程内工具直接经任务授权读写素材，不绕行主服务；看画面票据绑定当前任务上下文。
   - **〔裁 6〕**：`run-authority.mjs` 的强制停止控制记录在所撤任务全部凭 root 关闭记录结清后自动标为完成并附摘要。
   - **〔裁 9〕**：运行素材直连鉴权（`authenticateDirect`）在开启单任务单进程模式时只认任务身份证书，拒绝主服务身份直接读写任务素材。
2. **块七：云端工具包与接线（`AGENT-v18-tools-*.md`、`AGENT-v18-wire.md`）**
   - **〔裁 P1/P2/P3/P4〕**：后台重工具（镜头识别、语音转写、运动追踪、主体识别）共享 `tool-jobs.mjs` 作业账本，写回文档前校验素材仍为取字节时的同一份（`mediaId` 与哈希未变）。
   - **〔裁 P5〕**：`auto_workflow` 配卡规则与桌面版逐条一致，云端新增前置转写/切镜头/主体识别阶段；按 `commitKey` 对同一份文字稿去重，不重复叠放字幕与卡片；主体识别缺省可选（未装或未就绪自动跳过并说明）。
   - **〔裁 W1〕**：网页操作浏览器按「项目 + 对话」隔离，只读成员在自身私有对话内可用；`web_close`、闲置、停止、Agent 关闭只关浏览器进程保留数据，对话转私有或项目/对话删除时清数据。
   - **〔裁 W2〕**：页面反向通道（`seek` / `play` / `pause` / `get_selection` / `web_handoff`）使用独立请求记录表，要求文档服务在场表与事件流同时在线；发起人被踢或退出后保留运行的任务不再请求其页面；`web_handoff` 仅传递云端浏览器当前页地址，不允许模型任意指定 URL。
   - **〔裁 Wire-1〕**：任务回合结束时若该轮发起了在途后台作业，等待后台作业完成才收尾本轮（最长 1 小时，超时中断并在对话内补说明）。
3. **块十与块十一：云端按轮占用、本地取帧优先与第二期工具（`AGENT-v18-block10-turn-lock.md`、`AGENT-v18-block11-providers.md`）**
   - **〔裁 B10-1〕**：`look` 私钥仅由 `agent-service` 主服务持有，任务进程经内部 mTLS 口 `/internal/v2/worker/look` 请求代签，主服务以文档服务权威返回的 `grant.projectId` 签发 10 分钟短期票据，拒绝跨项目代签。
   - **〔裁 B10-2〕**：无成员设备辅助的项目在首次向云端渲染服务要画面时申请按轮占用锁（30 秒心跳、2 分钟无心跳释放），FIFO 排队防止重试插队，排队期不计入单次 3 分钟渲染时限。
   - **〔裁 B11-1〕**：`see_frames({source:'media'})` 素材拼图在任务隔离临时目录内由 `ffmpeg`/`ffprobe` 抽帧合成网格 PNG，单次上限 24 张。
   - **〔裁 B11-2〕**：`measure_audio_js` 在渲染服务的 `--isolated-MeasureAudio` 无网络子进程内执行，`--max-old-space-size=192`，硬超时 5 秒。
   - **〔裁 B11-3〕**：`get_gif` 产出的 GIF 经 `hosted-visuals.mjs` 写入项目素材库并记入消息 `visuals`，前端通过受权路由 `/api/agent/v2/projects/:projectId/conversations/:conversationId/visuals/:visualId` 读取展示。

---

## 6. 要用户做的事 / 已知说明

1. **本机在用的桌面版升级**：构建产物已在 `desktop/release/PromptCut-0.7.18-setup.exe` 与 `desktop/release/PromptCut-patch-0.7.18.exe`，按规则我们未触碰您正在运行的 5190/5210 桌面实例，您可在空闲时自行安装升级。
2. **节点 root 密码**：照 `docs/local.md` 备忘，部署完成后您可按计划更换节点 root 密码（SSH 公钥登录已配置稳妥）。
3. **真实手机硬件解码与两台局域网实机回归（`V18-lan-real`）**：本次按开工指令只用这台 PC 与云节点完成全部验证，未动用第二台局域网电脑或真手机。
4. **安装包冒烟与补丁演练由用户自己测**（2026-10-17 用户定）：`V18-installer-smoke`（装好以后启动、关闭、走账号路径、双击文件打开）和 `V18-installer-compat`（0.2.0、0.2.7 外壳上打补丁）没跑，结果出来前 2.1-16、2.1-17 记「未跑」。
5. **已知问题：0.2.8 以前的外壳打 0.7.18 补丁**：0.7.18 桌面版的账号功能（云端项目列表、搬到云端）要调外壳的 `account_bridge` 命令，0.2.8 的外壳才有；补丁写的最低外壳是 0.2.0。按代码推断，旧外壳打完补丁后本地项目照常，账号和云端项目入口会报错（没实测）。用户 2026-10-17 定：最低外壳不抬，0.7.19 给账号入口加一句「这个功能要装完整安装包」。
6. **补丁比以前大**：依赖变了（多了 sucrase），补丁带整份 `node_modules`，补丁安装器 109 MB（0.7.17 的是 18 MB）。
7. **没跑、用户 2026-10-17 定不补跑的**：运行器加了 `--no-optional`，11 支补充探针没跑；`V18-gap-stop-immediate`、`V18-doc-semantics-judge`、`V18-queue-node-pressure` 没做；真实模型只跑了一遍（`S4-r4`），用户定一遍即可。
