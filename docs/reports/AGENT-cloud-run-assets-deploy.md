# 报告：在生产节点上部署云端 Agent 的「运行素材」（`gemini/cloud-run-assets-deploy`）

- **日期**：2026-10-18
- **分支**：`gemini/cloud-run-assets-deploy`
- **工作区**：`.worktrees/cloud-run-assets-deploy`
- **任务书**：[`docs/plan/cloud-run-assets-deploy-task.md`](../plan/cloud-run-assets-deploy-task.md)
- **状态**：已完成

---

## 1. 做了什么（节点部署与代码修复）

### 1.1 节点初始核实与全量备份
- 核实各服务实际运行目录（`systemctl show <单元> -p ExecStart`）：
  - `promptcut-doc-v2.service`：`/opt/promptcut-v2/releases/35f7b2ab/pc`
  - `promptcut-asset-v2.service`：`/opt/promptcut-v2/releases/41b6d335/pc`
  - `promptcut-agent.service`、`promptcut-agent-root.service`、`promptcut-agent-task-slot-a..f.service`：`/opt/promptcut-render/releases/35f7b2abb9db`
- 核实 `/etc/promptcut/agent-root/agent-root.json` 的 `worker` 已配好 `runAssets`（`origin: "https://127.0.0.1:8794/"`，`fingerprint256: "ccd5b8a1ffcf9b08d463639de21e9c3d1186424c072e8652fe7c7ed54bca60ff"`，`maxResponseBytes: 16777216`，`maxImportBytes: 536870912`）与 `tools`；补充设置 `"timeoutMs": 60000` 以匹配大文件/并发导入的 15 次连续租约复核耗时。
- 变更前将环境文件、单元文件、`/etc/promptcut`、素材状态文件、文档服务账本（`VACUUM INTO` 一致快照）及被替换的源码文件完整备份至 `/root/run-assets-backup-20261017T1805Z/`（`0700`）。

### 1.2 节点配置与素材 root 登记初始化
1. **素材 root 登记目录与发布器配置**：
   - 创建 `/var/lib/promptcut/asset-root`（`root:root 0755`）与 `/etc/promptcut/asset-root`（`root:root 0755`）。
   - 将文档服务连素材内部口的客户端私钥拷至 `/etc/promptcut/asset-root/doc-client.key`（`root:root 0600`，满足 `rootRead` 对 `uid === 0` 的要求），编写 `/etc/promptcut/asset-root/publisher.json`（`root:root 0600`）。
2. **素材服务（`promptcut-asset-v2`）**：
   - 更新 `/etc/systemd/system/promptcut-asset-v2.service`：设 `Type=exec`（避免 `Type=simple` + `ProtectSystem=strict` 下 `(sd-executor)` 尚未降权至 `uid 995` 即返回导致 `inspect` 报 `publisher-proc-changed`）、`Restart=no`（满足 `validatePublisherUnit` 的 `Restart === 'no'` 要求），并在 `ReadOnlyPaths` 加入 `"/var/lib/promptcut/asset-root"`。
   - 在 `/etc/promptcut-account-v2/promptcut-asset-v2.env` 增加变量（不列值）：
     - `PROMPTCUT_ASSET_RUN_ENABLED`
     - `PROMPTCUT_ASSET_AGENT_FINGERPRINT256`
     - `PROMPTCUT_ASSET_AGENT_SERVICE_KID`
     - `PROMPTCUT_ASSET_RUN_TIMEOUT_MS`
     - `PROMPTCUT_ASSET_RUN_MAX_RESPONSE_BYTES`
     - `PROMPTCUT_ASSET_RUN_MAX_BODY_BYTES`
     - `PROMPTCUT_ASSET_ROOT_UNIT`
     - `PROMPTCUT_ASSET_ROOT_CGROUP_PATH`
     - `PROMPTCUT_ASSET_ROOT_RESERVATION_FILE`
3. **文档服务（`promptcut-doc-v2`）**：
   - 更新 `/etc/systemd/system/promptcut-doc-v2.service`：在 `ReadOnlyPaths` 加入 `"/var/lib/promptcut/asset-root"`。
   - 在 `/etc/promptcut-account-v2/promptcut-doc-v2.env` 增加变量（不列值）：
     - `PROMPTCUT_DOC_RUN_ASSETS_ENABLED`
     - `PROMPTCUT_DOC_RUN_ASSET_REGISTRY_DIR`
     - `PROMPTCUT_DOC_RUN_ASSET_UID`
     - `PROMPTCUT_DOC_RUN_ASSET_UNIT`
     - `PROMPTCUT_DOC_RUN_ASSET_CGROUP_PATH`
     - `PROMPTCUT_DOC_RUN_ASSET_SERVICE_IDENTITY`
     - `PROMPTCUT_DOC_RUN_ASSET_TICKET_TTL_MS`
     - `PROMPTCUT_DOC_RUN_ASSET_MAX_BODY_BYTES`
4. **启动顺序与素材 root 登记发布**：
   - 先重启 `promptcut-doc-v2.service`，再运行 `asset-root-registry-publisher.mjs --config /etc/promptcut/asset-root/publisher.json --initialize` 启动 `promptcut-asset-v2.service` 并落盘 `anchor.json`、`reservation.json`、`epoch-1.json`、`current.json`、`publication-1.json`。
   - 注意：`promptcut-asset-v2` 在启动时建立到 `promptcut-doc-v2` 的单条长连接观察通道，因此**每次重启 `promptcut-doc-v2.service` 后，必须执行一次 `asset-root-registry-publisher.mjs --config /etc/promptcut/asset-root/publisher.json --rotate`** 使素材服务重连观察通道并推进代次。

### 1.3 部署与实测中发现并修复的代码问题
1. **`server/account/ledger.mjs`、`server/account/run-assets.mjs`、`server/hosted/run-assets-observer-authority.mjs`、`server/hosted/agent-run-scope-reader.mjs`、`server/account/conversation-authority.mjs`**：
   - **问题**：开启运行素材后，`promptcut-asset-v2` 每 100ms 轮询 `GET /internal/v2/run-assets/events`，每次轮询无条件触发 `mirror()` 写事务（850 KB JSON `SELECT` + `JSON.parse` + `UPDATE` + `PRAGMA synchronous=FULL` `fsync` + `deepFreeze`）及两次 `resolveObserver` mTLS 挑战，占满文档服务主线程 83.9% CPU；同时 `POST /complete` 内 15 次连续 `lease.assert()` 在 `runAssets.check()` 中对已准入的 `import`/`verifyRef` 租约重复调用 `resourceFor`（每次含 2 趟 `coordinator.read` 共 4 次 `checkAccess`）、二次 `auth.check` 与写事务，导致并发导入超时。
   - **修复**：
     - `ledger.mjs`：缓存 `cachedRaw`，在 `transaction(fn)` 未修改账本状态（`rawAfter === rawBefore`）时直接 `COMMIT` 跳过 `UPDATE`、`fsync` 与 `deepFreeze`；
     - `run-assets.mjs`：`mirror()` 在 `ledger.read()` 快照引用未变时直接返回缓存结果；`check()` 对已准入的 `leaseId` 续检在 `purpose !== 'openRead'` 时省去不可变 `resourceFor` 的重复查询，并在租约状态/游标未变时跳过写事务；
     - `run-assets-observer-authority.mjs`：`resolveObserver` 对已在 `WeakMap` 绑定且当前根登记 `epoch`/`recordDigest`/`instance` 未变的同一条存活 TLS 连接直接复用绑定；
     - `agent-run-scope-reader.mjs`：`createAgentScopeReader` 基于目录无锁与全部文件 `(dev, ino, size, mtimeNs)` 快照复用已验签的 `inspectAgentScopeSource` 结果；
     - `conversation-authority.mjs`：`completePendingDeletions` 在无 `deletion` 标记时直接返回 `0`。
2. **`server/hosted/asset-run-access.mjs`**：
   - **问题 1**：`GET /chunks` 在 `store.chunks(ref.hash).complete` 为 `false` 时直接返回了 `await staging.chunks(ref.hash)`；若首轮 `POST /complete` 在 `staging.complete()` 完成后因超时中断回滚，次轮重试时 `GET /chunks` 会因 `staging` 已完成而返回 `complete: true`，导致客户端跳过 `POST /complete`，文件滞留在 `.run-imports` 未发布到正式 `out/media`（随后 `see_frames` 报 `404 asset-missing`）。
   - **修复 1**：当 `store.chunks(ref.hash).complete` 为 `false` 时，`GET /chunks` 透传 `staging.chunks(ref.hash)` 的已收分片列表但固定 `complete: false`，确保必须走完 `POST /complete` 正式发布。
   - **问题 2**：`createAssetRunConsumer.start()` 在新 `assetInstanceId` 启动时只要 `Object.keys(saved.leases).length > 0`（哪怕全部都是已正常收口的 `state === 'closed'` 租约）就抛 `503 asset-run-recovery-pending`。
   - **修复 2**：仅当存在 `saved.pending` 或存在未收口租约（`l.state !== 'closed' || !l.receipt`）时才抛 `asset-run-recovery-pending`。
3. **`server/asset-store/project-revocations.mjs`**：
   - **问题**：`deliver(event)` 将 `done` 存入 `deliveries` Map 后，仅在 `drain()` 成功后删除；若素材服务在 `--rotate` 启动瞬间（发布器尚未解除 `.publisher.lock` 的几十毫秒窗口内）拉到权限事件，`deliver(event)` 因 `asset-current-publication-incomplete` 失败后，该 rejected Promise 永久留在 `deliveries` 中，导致解锁后每次 `sync()` 仍返回同一个失败 Promise。
   - **修复**：在 `deliver(event)` 中附加 `void done.catch(() => { if (deliveries.get(event.eventId) === done) deliveries.delete(event.eventId); });`，失败后自动移出缓存以便下一轮重试。
4. **`server/hosted/deploy/asset-root-registry-publisher.mjs`**：
   - **问题**：Linux systemd 249 在 `systemctl stop promptcut-asset-v2.service` 最后一个进程退出（`populated 0`）瞬间会立即移除 `.service` 的 cgroup 目录，导致 v1 `runAssetRootPublisher` 的 `events.read` 抛 `ENODEV`。
   - **修复**：在 v1 `pinPrevious` / `stopAndObserve` 中识别 systemd 已清空并移除服务 cgroup（`ENODEV` 且 `fs.lstat(scope.cgroupPath)` 为 `ENOENT`、原 `pidBirth` 已消失、单元已停）的状态。

---

## 2. 验收逐项证据（任务书第 2 节）

### 2.1 服务开关、`/healthz`、内部状态与权限探针
- **各服务 `/healthz` 与素材内部状态**：
  ```text
  {"ok":true,"service":"promptcut-docservice","uptimeMs":629010,"connections":5,"protocol":"promptcut.v1","modules":["render-queue","endpoints","hosted","project","content","events","costs","presence","selection","shared"],...,"accountMode":"v2","accountRequired":true,"assetReady":true}
  {"ok":true,"role":"asset","layout":2,"accountRequired":true,"assetReady":true}
  {"ok":true,"version":"0.7.18","codeVersion":"0.7.18","egressTestAllow":false,"look":true,"collect":false,"collectTestRunner":false,"taskProcesses":true,"scheduler":true}
  ASSET_INTERNAL_STATUS: 200 {"ok":true,"ready":true,"authorityId":"doc-node-20261009-037d8e0d-2c1e-495a-b19d-501ffbf49909","instanceId":"2f07fae1-4056-4cbf-8334-6946c23b193d","accessCursor":82,"accessHead":82,"runAssetsConfigured":true,"runAssetCursor":55,"runAssetHead":55,"runAssetsReady":true}
  ```
- **Linux 权限探针 `scripts/probes/account-tools-perms-linux.mjs`**：
  ```text
  PERMS OK 任务进程里真的工具提供者:单子上被删的对话(它自己再也没有任务)也被顺手清掉——浏览器目录、对话目录都没了,单子空了 :: {"browser":null,"conversation":null,"queue":[],"log":[{"event":"agent.account-tools.browser-purged","reason":"private","removed":true},{"event":"agent.account-tools.browser-swept","marked":1,"removed":1,"conversations":1,"conversationsRemoved":1}]}
  PERMS OK 任务进程里真的工具提供者:开工前把自己这个对话照记号清了(只剩清单版本的计数) :: {"own":["rev"],"closed":{"childrenClosed":true,"workPending":0},"ledger":true}
  PERMS OK 任务进程里真的工具提供者:别的对话留着「对话被删」记号的顺手清掉(整个目录没了);没有记号的对话不动 :: {"others":{"c_swept":null,"c_kept":[".config",".tmp","profile","rev"],"c_gone2":null},"log":[{"event":"agent.account-tools.browser-purged","reason":"private","removed":true},{"event":"agent.account-tools.browser-swept","marked":1,"removed":1,"conversations":1,"conversationsRemoved":1}]}
  PERMS OK 收尾:临时目录删干净了 :: /tmp/pc-perms-kaEa4V
  PASS 26/26
  ```

### 2.2 真实云端对话逐项验证证据
1. **`import_media`：一个对话附件（`work:attachments/red-box.png`）与一个 `https` 图片地址（`https://www.w3.org/Icons/w3c_home.png`）均进素材库**：
   ```json
   {
     "queueState": "done",
     "events": [
       {
         "callId": "toolu_01kwS1uWfNyejCSALpVSiNzY",
         "input": { "url": "work:attachments/red-box.png" },
         "name": "import_media",
         "round": 1,
         "type": "tool_call"
       },
       {
         "callId": "toolu_01kwS1uWfNyejCSALpVSiNzY",
         "durationMs": 13014,
         "name": "import_media",
         "ok": true,
         "round": 1,
         "summary": "{\"mediaId\":\"m-mvd10v3t-1\",\"name\":\"red-box.png\",\"kind\":\"image\",\"kindLabel\":\"图片\",\"cardUrl\":\"/@media/89a6caabeb2594945e9c2c3bb96ebfa7bdc00a0932e0356aa89e4c3ddbc5dcac\",\"width\":64,\"height\":64,\"hint\":\"图片已进“图片”素材库(没放到时间轴)。卡片参数里要用这张图就填 cardUrl。\"}",
         "type": "tool_result"
       },
       {
         "callId": "toolu_01RhcjUXVfVpD8DfrUZnjHyF",
         "input": { "name": "w3c_home.png", "url": "https://www.w3.org/Icons/w3c_home.png" },
         "name": "import_media",
         "round": 1,
         "type": "tool_call"
       },
       {
         "callId": "toolu_01RhcjUXVfVpD8DfrUZnjHyF",
         "durationMs": 14283,
         "name": "import_media",
         "ok": true,
         "round": 1,
         "summary": "{\"mediaId\":\"m-mvd115ul-2\",\"name\":\"w3c_home.png\",\"kind\":\"image\",\"kindLabel\":\"图片\",\"cardUrl\":\"/@media/590608bf256237f22d84bbab2a0a1afc0d4f20db6350bbac2c6841f1f3e13b01\",\"width\":72,\"height\":48,\"hint\":\"图片已进“图片”素材库(没放到时间轴)。卡片参数里要用这张图就填 cardUrl。\"}",
         "type": "tool_result"
       }
     ],
     "projectMedia": [
       {
         "ext": "png",
         "hash": "89a6caabeb2594945e9c2c3bb96ebfa7bdc00a0932e0356aa89e4c3ddbc5dcac",
         "height": 64,
         "id": "m-mvd10v3t-1",
         "kind": "image",
         "name": "red-box.png",
         "size": 178,
         "tiers": { "original": "89a6caabeb2594945e9c2c3bb96ebfa7bdc00a0932e0356aa89e4c3ddbc5dcac" },
         "url": "/@media/89a6caabeb2594945e9c2c3bb96ebfa7bdc00a0932e0356aa89e4c3ddbc5dcac",
         "width": 64
       },
       {
         "ext": "png",
         "hash": "590608bf256237f22d84bbab2a0a1afc0d4f20db6350bbac2c6841f1f3e13b01",
         "height": 48,
         "id": "m-mvd115ul-2",
         "kind": "image",
         "name": "w3c_home.png",
         "size": 1848,
         "tiers": { "original": "590608bf256237f22d84bbab2a0a1afc0d4f20db6350bbac2c6841f1f3e13b01" },
         "url": "/@media/590608bf256237f22d84bbab2a0a1afc0d4f20db6350bbac2c6841f1f3e13b01",
         "width": 72
       }
     ]
   }
   ```
2. **`see_frames({ source: "media", mediaId })` 看到素材库里的图片**：
   ```json
   {
     "queueState": "done",
     "events": [
       {
         "callId": "toolu_01cTSkwVnNxo4x7ZNdzBbQsN",
         "input": { "mediaId": "m-mvd10v3t-1", "source": "media" },
         "name": "see_frames",
         "round": 1,
         "type": "tool_call"
       },
       {
         "callId": "toolu_01cTSkwVnNxo4x7ZNdzBbQsN",
         "durationMs": 7229,
         "name": "see_frames",
         "ok": true,
         "round": 1,
         "summary": "{\"ok\":true,\"mediaId\":\"m-mvd10v3t-1\",\"name\":\"red-box.png\",\"kind\":\"image\",\"width\":64,\"height\":64,\"cardUrl\":\"/@media/89a6caabeb2594945e9c2c3bb96ebfa7bdc00a0932e0356aa89e4c3ddbc5dcac\",\"note\":\"这是一张图片,下面就是它本身(长边缩到 1280 以内)。卡片参数里要用它就填 cardUrl。\",\"images\":\"1 张图见本条消息末尾,按顺序排列\"}",
         "type": "tool_result"
       }
     ],
     "assistantText": "红色。"
   }
   ```
3. **往素材库写文件的工具（`sound_generate`）写成功**：
   ```json
   {
     "queueState": "done",
     "events": [
       {
         "callId": "toolu_0117kFEbHnv2jD3tpdd6iHPF",
         "input": { "name": "verify-chime", "preset": "notification", "requestId": "snd-verify-1" },
         "name": "sound_generate",
         "round": 1,
         "type": "tool_call"
       },
       {
         "callId": "toolu_0117kFEbHnv2jD3tpdd6iHPF",
         "durationMs": 13623,
         "name": "sound_generate",
         "ok": true,
         "round": 1,
         "summary": "{\"ok\":true,\"id\":\"sound-09073c4fdf7f\",\"jobId\":\"sound-09073c4fdf7f\",\"requestId\":\"snd-verify-1\",\"state\":\"succeeded\",\"progress\":1,\"result\":{\"mediaId\":\"m-mvd17qkx-1\",\"reused\":false}}",
         "type": "tool_result"
       }
     ],
     "assistantText": "生成成功，mediaId 为 `m-mvd17qkx-1`。",
     "projectMedia": [
       {
         "duration": 0.4,
         "ext": "wav",
         "hash": "71e39fd164ebe3e03888eb63fdbe903753f43402b47758c2abc5e079de6e194d",
         "id": "m-mvd17qkx-1",
         "kind": "audio",
         "name": "verify-chime.wav",
         "size": 76844,
         "url": "/@media/71e39fd164ebe3e03888eb63fdbe903753f43402b47758c2abc5e079de6e194d"
       }
     ]
   }
   ```
4. **回归验证（页面「导入媒体」、云端对话附件发送时进素材库、不带附件的普通消息）**：
   - **页面「导入媒体」**：
     ```json
     {"putResult":{"hash":"77634567014eb0bb87c84deb72a9b0b31befd5f73b5f3cbb3e4451e48eb4c522","size":179,"uploaded":true},"readBytes":179,"sha256Match":true}
     ```
   - **云端对话附件发送时进素材库**：
     ```json
     {"greenPutResult":{"hash":"3cfd84cdd7e9782695d4b814a69476c69229753d98ef5050b61a1c4841e41bce","size":179,"uploaded":true},"queueState":"done","events":[{"callId":"call_838dd2f722911f19","input":{"mediaId":"media-auto-green-1","source":"media"},"name":"see_frames","round":1,"type":"tool_call"},{"callId":"call_838dd2f722911f19","durationMs":8208,"name":"see_frames","ok":true,"round":1,"summary":"{\"ok\":true,\"mediaId\":\"media-auto-green-1\",\"name\":\"auto-green.png\",\"kind\":\"image\",\"width\":64,\"height\":64,\"cardUrl\":\"/@media/3cfd84cdd7e9782695d4b814a69476c69229753d98ef5050b61a1c4841e41bce\",\"note\":\"这是一张图片,下面就是它本身(长边缩到 1280 以内)。卡片参数里要用它就填 cardUrl。\",\"images\":\"1 张图见本条消息末尾,按顺序排列\"}","type":"tool_result"}],"assistantText":"纯绿色（chroma key 绿），64×64 像素的纯色色块，没有任何其他内容。"}
     ```
   - **不带附件的普通消息**：
     ```json
     {"queueState":"done","assistantText":"PLAIN_OK"}
     ```
   - 所有验证用临时对话与临时项目均已删除，6 个任务槽均回到 `phase: "closed", activeState: "inactive", subState: "dead", mainPid: 0`。

---

## 3. 回退步骤

如需回退本次「运行素材」部署：
1. 确认无在跑任务后，停止 `promptcut-asset-v2.service` 与 `promptcut-doc-v2.service`。
2. 将 `/root/run-assets-backup-20261017T1805Z/` 下的 `promptcut-doc-v2.env`、`promptcut-asset-v2.env`拷回 `/etc/promptcut-account-v2/`，将备份的 `promptcut-doc-v2.service`、`promptcut-asset-v2.service` 拷回 `/etc/systemd/system/` 并执行 `systemctl daemon-reload`。
3. 将 `/root/run-assets-backup-20261017T1805Z/etc-promptcut/agent-root/agent-root.json` 拷回 `/etc/promptcut/agent-root/agent-root.json`。
4. 如需一并回退代码文件，将 `/root/run-assets-backup-20261017T1805Z/code-before-pollfix/` 下的备份文件拷回 `/opt/promptcut-v2/releases/35f7b2ab/pc/`、`/opt/promptcut-v2/releases/41b6d335/pc/` 与 `/opt/promptcut-render/releases/35f7b2abb9db/`。
5. 重启 `promptcut-doc-v2.service`、`promptcut-asset-v2.service` 与 `promptcut-agent-root.service`。

---

## 4. 没做成的与待用户操作项

- **待用户验证项（任务书第 2.3 节）**：请用户在项目 `sp_4lcukykm2blylc5lok7za46yu3`（九天之测试）里重发那条「户型图 60 秒一镜到底」请求，确认 Agent 能直接通过 `see_frames({ source: "media", mediaId })` 看到户型图。
