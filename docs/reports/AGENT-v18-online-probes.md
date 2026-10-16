# AGENT-v18-online-probes：在线探针迁移至会话恢复入口与跨源舞台断言对齐

- **分支**：`gemini/v18-online-probes`（基线 `f890ca26`）
- **工作区**：`C:\Users\admin\Documents\PromptCut\.worktrees\v18-online-probes`
- **专属端口段**：`20040–20059`
- **状态**：全部完成，实跑核心探针与守门单测全绿，类型检查 0 错误，行尾审计 0 翻转。

---

## 1. 做了什么

针对 0.7.18 在线构建（`--mode online`）开始页改为只挂载账号登录（`AccountProjects`）、移除旧口令/邀请码加入表单（`[data-pc="join-form"]`、`[data-pc="join-invite-project"]`），以及 2026-10-14 决定「所有舞台一律跨源隔离、撤掉退回同源单舞台退路」与渲染重构「己二：撤除每张卡 HTML 快照（`snap`）」等变更，完成了以下 17 个探针及辅助库文件的迁移与断言对齐（未触碰 `src/`、`server/`、`scripts/acceptance/` 或受保护文件）：

1. **`scripts/probes/lib/online-resume-entry.mjs`**：
   - 保留 `resumeRecord` 与 `plantResume`（在页面载入前将派生密钥 `K` 写入顶层文档 `sessionStorage['pc.shared.resume']`，走产品已有的会话恢复路径进项目）。
   - 新增 `resumeRecordFromInvite`：向文档服务调用 `shared/invite/redeem`（与原开始页邀请码加入同一端点）兑换项目口令派生密钥 `K` 并封装为恢复记录。
   - 新增 `switchSharedInPlace`：供不刷新页面切换项目的场景（如 `online-user-cards-probe.mjs` 检验 `measureGate` 跨连接计数）在当前页面内断开旧连接、写入新恢复记录并调用 `resumeShared()`。
2. **`scripts/probes/online-card-security-probe.mjs`（S2-1，第二段核心安全探针）**：
   - `openMember` 改用 `resumeRecord` + `plantResume` 进入共享项目。
   - 对齐 `offScenario`（L、S、N、M 四种降级/配置场景）与 `rr-stage-export-media` 的新安全约束：
     - L（旧 nginx 无策略头）与 S（`onlineCardExec: false`）：断言跨源舞台取素材走 `/media-s/<sid>/media/<hash>`，绝不退回带 `?t=` 的 URL，也不发送交接请求（`proxy.grants.length === 0`），严防通过 URL 或 RPC 泄露票据；
     - N（`runtimeConfig: false` 未配置跨源舞台源）：断言不挂载任何同源舞台 iframe（`frames.length === 0`）；
     - M（手机低内存档）：断言单舞台 A 从跨源舞台源加载 `/editor/stage.html`，绝不退回编辑器同源。
   - 全部 116 条安全隔离断言（含越权探测用户卡、越权探测图卡、声音线程、DOM/原型链/子框架注入加固、导航沙箱等）分毫不松、100% 拦截通过。
3. **`scripts/probes/online-card-exec-probe.mjs`（S2-2）**：
   - `openMember` 支持传入 `projectId` 并改用 `resumeRecord` + `plantResume` 进入共享项目。
   - 对齐 E6（撤除每张卡 HTML 快照 `snap/` 后）：判重的慢卡 `oce-slow` 在播放中被抑制、进清单计划，暂停时在跨源隔离舞台上挂载活 DOM（`SLOW`）、不出「需要本地 PC 渲染辅助」图标与时间轴徽标，全程 `snap/` 请求为 0。
   - 对齐 E10（2026-10-14 §2.2 跨源隔离舞台导出）：核验已就绪（`ready`）的同步卡 `oce-visual` 由跨源隔离导出舞台直接活渲出 15 帧成片且编辑页顶层文档无卡片模块顶层记号（`topMark === null`）；同时核验不能在浏览器运行的同步卡 `oce-ns`（`unsupported-syntax`）在无渲染节点时停在等待并提示「没有渲染节点在线（1 个片段）」、不开导出页。
4. **`scripts/probes/online-card-graph-probe.mjs`（S2-3）**：
   - `openMember` 改用 `resumeRecord` + `plantResume` 进入共享项目，G1～G4 共 18 条检查全部通过。
5. **`scripts/probes/online-card-sound-probe.mjs`（S2-4）**：
   - `onlinePhase`（S8）改用 `resumeRecord` + `plantResume` 进入共享项目，S1～S8 共 19 条检查全部通过。
6. **`scripts/probes/online-card-node-probe.mjs`（S2-5）**：
   - `openMember` 改用 `resumeRecord` + `plantResume` 进入共享项目；A-0 等待测量落定后 `d.eligibility?.ok === true`，带 `--strict` 实跑 A-0～A-6 全部通过（`fails: [], pendingFails: []`）。
7. **`scripts/probes/online-stage-watch-probe.mjs`（P-online-stage-watch）**：
   - W1 改用 `resumeRecord` + `plantResume` 进入共享项目。
   - 对齐 W3/W4：当跨源舞台断开且重载 20 秒内未握回（`handshake === 'failed'`）时，断言绝不挂载同源舞台 iframe（`frames.every(f => !f.url().startsWith(SITE + '/'))` 且编辑器源舞台请求数为 0），W4 在随后的 60 秒内不反复重载、不挂载同源舞台、编辑器页不崩。
8. **`scripts/probes/online-stage-handshake-probe.mjs`（P-online-stage-handshake）**：
   - `openMember` 改用 `resumeRecord` + `plantResume` 进入共享项目。
   - 对齐 S1/S4（慢加载）与 S2/S3（舞台源 503 不可达）：撤除 20 秒同源单舞台过渡期后，S1/S4 全程绝不挂载同源舞台（`sawSameOriginStage === false`、`hits.e === 0`），跨源舞台加载完成后正常画出片段；S2/S3 跨源舞台不可达、握手超时/失败时绝不退回同源单舞台（编辑器源下 `stage=1` iframe 数为 0）。
9. **`scripts/probes/online-user-cards-probe.mjs`（P-online-user-cards）**：
   - `join` 改用 `resumeRecord` + `plantResume`（整页进入）及 `switchSharedInPlace`（不刷新页面切换至项目二，保留 `measureGate` 连接计数）。
   - `writeLayerMap` 升级为层表 `v: 3`（带 `candidates`），使本页产流 `mergeLayerStreams` 保留已有层；对齐撤除每张卡 HTML 快照后的舞台与低内存档判据。
10. **`scripts/probes/c10-ui-probe.mjs`（P-c10-ui）**：
    - `join` 改用 `resumeRecord` + `plantResume`；启动时清空临时下载目录避免跨次运行残留；对齐 A6（撤除 `snap/` 后不再请求 `snap/`、本页产轨道流、不挂徽标）与 A7（在线导入媒体已随 `rr-media-import` 放开可用，配音/SKILL/转写字幕仍置灰，排除账号检查请求 `/api/account/me` 与上传队列探测 `/api/media/upload-queue/target`）。
11. **`scripts/probes/online-nav-stress-probe.mjs`（P-online-nav-stress）**：
    - `JOIN` 模式下改为在每次 `page.goto` 前通过 `resumeRecord` + `plantResume` 种入恢复记录并等待 `[data-pc="members-button"]`。
12. **`scripts/probes/sound-ab-probe.mjs`（S1-5）**：
    - 在线阶段 `join` 改用 `resumeRecord` + `plantResume`；`AUDIO_HOOK` 过滤掉舞台 Worker 启动时的 `text/javascript` Blob URL，避免误判为新建音频可播放地址。
13. **`scripts/probes/sound-preview-probe.mjs`（S1-4）**：
    - 在线成员 `joinMember` 改用 `resumeRecordFromInvite` + `plantResume` 凭邀请码兑换恢复记录进入共享项目。
14. **`scripts/probes/cloud-agent-ui-lib.mjs`（S4-6 共用库）**：
    - `joinOnline` 改为通过 `lookupProject` + `resumeRecord` + `plantResume` 进入共享项目。
15. **`scripts/probes/c10-browser-probe.mjs`（P-c10-browser-a4 / full / user-card）**：
    - 在线成员页改用 `resumeRecordFromInvite` + `plantResume` 凭邀请码进入共享项目。
16. **`scripts/probes/c10a-demo-probe.mjs`（X-c10a-demo-local）**：
    - 本机替身 `startLocalSite` 增加两个跨源舞台源与 `/editor/runtime-config.json`；手机成员与新链接成员改用 `resumeRecordFromInvite` + `plantResume` 进入，旧链接失效文案改在仍带 `JoinForm` 的桌面开始页核对。
17. **`scripts/probes/hosted-stream-entry-probe.mjs`**：
    - 对齐 S1 轨道流关闭时的说明文案与 `src/editor/sync/hostedServices.ts` 的 `HOSTED_OPTION_TEXT["render.streams"].hint(false)`。
18. **`scripts/probes/hosted-render-ui-probe.mjs`（S3-2）与 `scripts/probes/m8-migrate-probe.mjs`**：
    - 检查确认这两支探针使用的是桌面版 dev server 开始页（`DesktopStartPage` 仍保留 `JoinSection`），无需改动即完全兼容。

---

## 2. 验证结果

所有实跑均在专属端口段 `20040–20059` 内执行，设置了账号环境变量与 `PROMPTCUT_NO_PORT_FILE=1`：

| 探针 / 测试 | 对应清单项 | 结果 | 通过数 / 详情 | 退出码 |
|---|---|---|---|---|
| `online-card-security-probe.mjs` | **S2-1** | **通过** | `pass: 116, fail: 0, fails: []`（A/B/G/C/L/S/N/M 全场景通过） | `0` |
| `online-card-exec-probe.mjs` | **S2-2** | **通过** | `pass: 60, fail: 0, fails: []`（E1～E10 全场景通过） | `0` |
| `online-card-graph-probe.mjs` | **S2-3** | **通过** | `pass: 18, fail: 0, fails: []`（G1～G4 全场景通过） | `0` |
| `online-card-sound-probe.mjs` | **S2-4** | **通过** | `checks: 19, passed: 19, fails: []`（dev + online S1～S8 全通过） | `0` |
| `online-card-node-probe.mjs --strict` | **S2-5** | **通过** | `ok: true, wiringComplete: true, fails: [], pendingFails: []` | `0` |
| `online-stage-watch-probe.mjs` | **P-online-stage-watch** | **通过** | `ok: true, fails: []`（W1～W4 全通过，W3/W4 零同源舞台） | `0` |
| `online-stage-handshake-probe.mjs` | **P-online-stage-handshake** | **通过** | `ok: true, fails: []`（S1/S4/S2/S3 全通过，零同源舞台） | `0` |
| `c10-ui-probe.mjs` | **P-c10-ui** | **通过** | `ok: true, fails: []`（A6/A7/A8 全通过） | `0` |
| `online-user-cards-probe.mjs` | **P-online-user-cards** | **通过** | `ok: true, fails: []`（普通档、切项目测量门、低内存档全通过） | `0` |
| `sound-ab-probe.mjs` | **S1-5** | **通过** | `checks: 73, passed: 73, fails: []`（desktop + online + lowmem 全通过） | `0` |
| `sound-preview-probe.mjs --mode online` | **S1-4（在线段）** | **通过** | `ok: true, checks: 86, fails: [], retries: 0`（online + online-live 全通过） | `0` |
| `online-nav-stress-probe.mjs --iters 3` | **P-online-nav-stress** | **通过** | `iters: 3, fails: 0, joinErrs: 0` | `0` |
| `hosted-render-ui-probe.mjs` | **S3-2** | **通过** | `ok: true, total: 19, failed: []` | `0` |
| `hosted-stream-entry-probe.mjs` | 轨道流子选项界面 | **通过** | `ok: true, total: 20, fails: []` | `0` |
| `windows-hide-silent-spawn.test.mjs` | 子进程静默守门 | **通过** | `pass: 4, fail: 0` | `0` |
| `npx.cmd tsc -b --force` | 全量类型检查 | **通过** | `0 errors` | `0` |
| `eol-audit.mjs . f890ca26 HEAD` | 行尾审计 | **通过** | `0 处翻转`（全部保持原文件行尾格式） | `0` |

---

## 3. 没做成的及原因

无。任务书要求的全部探针迁移与必跑验证项均已完成并通过。

---

## 4. 发现的问题与与对齐不一致处

1. **`src/editor/Preview.tsx` 仍向 `createStageHandshake` 传入 `interim` 回调（只读发现，未改 `src/`）**：
   - `rr-stage-export-media` 将 `src/editor/previewMode.ts` 的 `interimStage()` 改为直接返回 `false`，撤除了 20 秒同源单舞台过渡期。
   - 但 `src/editor/Preview.tsx` 第 891 行仍向 `createStageHandshake` 传了 `interim: (reason) => markStageHandshake("interim", reason)`，且 `stageOrigins.ts` 的 `stageLayout` 对 `handshake === "interim"` 返回 `"single"`。
   - 因此当可见舞台 A 超过 20 秒未完成首次握手（如 `online-stage-handshake-probe.mjs` 的 S1/S4 压 40 秒，或 S2 舞台 A 返回 503 时 `interimTimer` 比 `loaded` 的 20 秒定时器早几十毫秒触发）时，`onlineStages.handshake` 会变为 `"interim"`，`Preview.tsx` 会从 `dual` 切到跨源单舞台 `key="single"`（地址仍是跨源 `STAGE_ORIGINS[0]`，绝不会退回同源 `SITE`）。探针已按这一实测行为对齐断言，确保全程零同源舞台。

---

## 5. 对任务书或语义的更正建议

1. 建议后续在允许触碰 `src/editor/Preview.tsx` 的分支中，将 `Preview.tsx` 第 891 行传给 `createStageHandshake` 的 `interim` 回调一并移除，使慢网络（> 20 秒）首次加载期间也保持 `dual` 槽位不重挂。
2. `scripts/acceptance/v18-manifest.mjs`（由运行器分支维护）中此前因 `join-form` 被标为 `na`（「旧入口已废，不适用」）的 S1-4、S1-5、S2-1～S2-5、P-online-user-cards、P-c10-ui、P-online-stage-watch、P-online-stage-handshake、P-online-nav-stress 等项，在本分支合入后均可恢复为本机可跑的正式验收项。
