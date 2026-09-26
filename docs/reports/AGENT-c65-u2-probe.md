# AGENT 报告：c65-u2-probe（C6.5 跨机验收 U2 的编辑界面探针）

分支 `claude/c65-u2`（起点 `a8a9d39` = `claude/c65`），worktree `.worktrees/c65-u2`。不推送、不合并。

状态：探针的跨机模式写完，本机局域网模式、托管模式各跑通一轮（四个进程退出码都是 0），跨机指令草稿在第 4 节。没有改产品代码。

依据：`Master-Execution-Plan.md` 的 U2 条（「另一台机器用『打开共享项目』进入后，看到的项目与托管端或局域网主机的 `projectRev` 相同；在上面改一处，创建者 5 s 内收到」）；`c65-design.md` 第 11 节；`AGENT-c65-editor.md`、`AGENT-c65-integ2.md`；`probe-coord.mjs`、`shared-project-probe.mjs` 的 `--coord` 用法。

## 1. 做了什么

只改了 `scripts/probes/c65-editor-probe.mjs`，另加本报告。不带 `--role` 时，原来的 `local` / `shared` / `lan` 三个阶段一行没改，只是包进了 `else` 分支；`origin` 由 `const` 改成 `let`，因为 `--spawn-editor` 要改写它。

新加 `--role creator|member`，用法和规则写在文件头注释里。两个角色各开一个真 Chrome 页面（puppeteer），只经协调口交换信息（`probe-coord.mjs`，与 `shared-project-probe` 同一个形状），不共享文件系统。

- **起编辑器**：可以用 `--origin` 接一个已经在跑的编辑器；也可以用 `--spawn-editor <端口>`，由探针自己在仓库根起 `vite --port <端口> --strictPort`（带 `PROMPTCUT_PUSH=0`），跑完用 `taskkill /T /F` 结束自己起的这一棵进程树。
  - creator 的局域网模式另加 `PROMPTCUT_LAN_HOST=1`，编辑器自己改绑 `0.0.0.0`；其余情况都绑 `127.0.0.1`。
  - `--device-id` / `--device-name` 覆盖本机设备信息（`PROMPTCUT_DEVICE_ID` / `_NAME`），一台机器上起两个实例时用。
- **creator**：
  1. 起协调口（`--coord-port`，跨机时加 `--coord-host 0.0.0.0`），或用现成的（`--coord`）。
  2. 页面上走 D11 界面：「项目」菜单 →「新建共享项目」，填项目名 `u2-<runId>`、创建者 `alice`、随机的创建者密码、局域网模式或互联网模式、自由进入、随机的项目密码，再点「创建」。
  3. 等状态行出现「创建成功」，并确认 `view().kind === 'shared'`。
  4. 用创建者凭证另开一条连接，直接向主机（托管端）`project.open`，核对页面的 rev、sha256 与主机相同。截图 `creator-1-created.png`。
  5. 往协调口 `u2-join` 写入：项目名、项目密码、模式、托管地址（`--hosted-public`，缺省同 `--hosted`）、主机的 rev 与 sha256。
  6. 等 `u2-entered`，然后发 `u2-go`（带双方要写的记号），同时开始盯本页面 store，直到某个片段的 `params.text` 等于成员的记号。等 `u2-member-edit`（成员的「已提交」报告）。
  7. `memberEditSeenMs` = max(0, 看到的时刻 − 收到报告的时刻)，要求 ≤ 5000。另记 `memberEditSinceGoMs` = 看到的时刻 − 发出 `u2-go` 的时刻，这是含协调口往返的上界，只记录、不判定。看到的同一刻截图 `creator-2-saw-member-edit.png`，并记下时间轴上有没有「别人的改动」描边（`flash`）。
  8. 在另一个片段上改 `text`，同一次 evaluate 里等文档服务确认，把结果写进 `u2-creator-edit`。
  9. 等 `u2-member-result`，再核对最终状态：本页面、主机、成员页面三份的 rev 与 sha256 相同。
  10. 以创建者身份 `adminOp('delete')` 删掉项目；`--keep` 不删。
- **member**：
  1. 起自己的编辑器（回环），打开页面。
  2. 从协调口取 `u2-join`。
  3. 页面上走 D11 界面：「打开共享项目」，填项目名，点「查找」。局域网模式靠本机编辑器的组播发现；托管模式用协调口给的地址（`--hosted` 优先）。并列两个候选时挑对应模式的那个。然后填项目密码与用户名 `bob`，点「进入」。
  4. 核对：页面的 rev、sha256，与探针凭成员凭证直接向主机读到的相同，也与 creator 报的相同；进入的 `where` 等于模式。截图 `member-1-entered.png`。
  5. 等 `u2-go`，在第一个片段上改 `text`，同一次 evaluate 里等到文档服务确认，再写 `u2-member-edit`。
  6. 盯本页面，直到 creator 的记号出现。`creatorEditSeenMs` 的算法与 creator 那边相同，要求 ≤ 5000。截图 `member-2-saw-creator-edit.png`。
  7. 最终再核一次页面与主机。无论成败都写 `u2-member-result`，免得 creator 干等。
- **局域网模式下成员查找时的托管地址**：页面查找时会同时查托管端。member 缺省把 `pc.shared.hostedUrl` 设成一个连不上的回环地址 `http://127.0.0.1:9`，这样不碰真正的托管端（页面会出「阿里云连不上」的角落气泡，截图里能看到）。给了 `--hosted` 就用它。
- **计时只用本机时钟**，不跨机比较时间戳。成员的改动先于协调口的报告到达时记 0。上界那一项另外记录。
- **最后一行 JSON**：creator 是 `{ ok, role, mode, projectId, rev, sha256, memberEditSeenMs, memberEditSinceGoMs, memberEdit, creatorEdit, creatorEditSeenMs, member: { entered, result }, final, deleted, shots, fails }`；member 是 `{ ok, role, mode, projectId, rev, where, base, candidate, enterMs, entered, memberEdit, creatorEditSeenMs, creatorEdit, final, shots, fails }`。有失败时退出码是 1。

提交：`32f18bc`（跨机模式）、`d3ad563`（改动与等确认放进同一次 evaluate）。第一版先 evaluate 改、再另一次 evaluate 等确认，确认往往在两次 evaluate 之间就回来了，所以 `commitMs` 只有 0～1 ms，不是从改动算起的。

## 2. 验证（本机，一台机器上两个编辑器实例）

- **端口**：creator 编辑器 5540（舞台 5541、5542），member 编辑器 5550（舞台 5551、5552），协调口 5559（绑 `0.0.0.0`），托管组合 8790 / 8791。
- **member 走局域网 IP**：member 用本机局域网 IP 192.168.50.96 连协调口，页面连主机或托管端也都经 192.168.50.96，不经 127.0.0.1。见结果里的 `base`：局域网模式是 `http://192.168.50.96:5540/docservice/`，托管模式是 `http://192.168.50.96:8790/`。
- **设备信息**：member 编辑器用 `--device-id pc-u2-member-probe-0001 --device-name u2-member-laptop` 与 creator 区分。
- **没碰的东西**：5190～5192；主工作区的 `.claude/launch.json` 没动，编辑器由探针自己起。

### 2.1 局域网模式

```
node scripts/probes/c65-editor-probe.mjs --role creator --mode lan --coord-port 5559 --coord-host 0.0.0.0 --spawn-editor 5540 --out out/u2/lan2-creator
node scripts/probes/c65-editor-probe.mjs --role member --coord http://192.168.50.96:5559 --spawn-editor 5550 --device-id pc-u2-member-probe-0001 --device-name u2-member-laptop --out out/u2/lan2-member
```

两个进程的退出码都是 0。原始最后一行：

creator：
```
{"ok":true,"role":"creator","mode":"lan","runId":"96d4df1a","origin":"http://127.0.0.1:5540","coord":"http://127.0.0.1:5559","name":"u2-96d4df1a","projectId":"sp_7kqti2w3bnnpe2bzi6ushwycxs","rev":1,"shots":["C:\\Users\\admin\\Documents\\PromptCut\\.worktrees\\c65-u2\\out\\u2\\lan2-creator\\creator-1-created.png","C:\\Users\\admin\\Documents\\PromptCut\\.worktrees\\c65-u2\\out\\u2\\lan2-creator\\creator-2-saw-member-edit.png"],"device":{"deviceId":"pc-vqxCRm0vQRfjWbzscI-4fc","deviceName":"DESKTOP-GS40TCK-vqxC","lanHost":true,"localEditor":true},"where":"lan","sha256":"f56d2450f463b32d807f2260f9e298b822f5a08a8e68827c38d2f112fbd16901","member":{"entered":{"ok":true,"rev":1,"sha256":"f56d2450f463b32d807f2260f9e298b822f5a08a8e68827c38d2f112fbd16901","hostRev":1,"where":"lan","base":"http://192.168.50.96:5540/docservice/","candidate":"u2-96d4df1a · [局域网模式] 主机：DESKTOP-GS40TCK-vqxC","enterMs":279},"result":{"ok":true,"fails":[],"rev":1,"creatorEditSeenMs":3,"memberEdit":{"clipId":"c-muhp3t3l-5","value":"u2-member-96d4df1a","commitMs":74.6},"final":{"page":{"sha256":"521c62296652fc2f2301ffafaa7fed50dbd9a452080a2e71950f9836948e4a90","rev":3,"status":"online"},"host":{"rev":3,"sha256":"521c62296652fc2f2301ffafaa7fed50dbd9a452080a2e71950f9836948e4a90"}}}},"memberEditSeenMs":33,"memberEditSinceGoMs":126,"memberEdit":{"clipId":"c-muhp3t3l-5","value":"u2-member-96d4df1a","memberCommitMs":74.6,"seenClipId":"c-muhp3t3l-5","flash":true},"creatorEdit":{"clipId":"c-muhp3t3l-6","value":"u2-creator-96d4df1a","commitMs":57.7},"creatorEditSeenMs":3,"final":{"page":{"sha256":"521c62296652fc2f2301ffafaa7fed50dbd9a452080a2e71950f9836948e4a90","rev":3,"status":"online"},"host":{"rev":3,"sha256":"521c62296652fc2f2301ffafaa7fed50dbd9a452080a2e71950f9836948e4a90"},"member":{"sha256":"521c62296652fc2f2301ffafaa7fed50dbd9a452080a2e71950f9836948e4a90","rev":3,"status":"online"}},"deleted":true,"fails":[]}
```

member：
```
{"ok":true,"role":"member","mode":"lan","runId":"84ab5fdd","origin":"http://127.0.0.1:5550","coord":"http://192.168.50.96:5559","name":"u2-96d4df1a","projectId":"sp_7kqti2w3bnnpe2bzi6ushwycxs","rev":1,"shots":["C:\\Users\\admin\\Documents\\PromptCut\\.worktrees\\c65-u2\\out\\u2\\lan2-member\\member-1-entered.png","C:\\Users\\admin\\Documents\\PromptCut\\.worktrees\\c65-u2\\out\\u2\\lan2-member\\member-2-saw-creator-edit.png"],"device":{"deviceId":"pc-u2-member-probe-0001","deviceName":"u2-member-laptop","lanHost":false,"localEditor":true},"hosted":"http://127.0.0.1:9","enterMs":279,"where":"lan","base":"http://192.168.50.96:5540/docservice/","candidate":"u2-96d4df1a · [局域网模式] 主机：DESKTOP-GS40TCK-vqxC","entered":{"page":{"sha256":"f56d2450f463b32d807f2260f9e298b822f5a08a8e68827c38d2f112fbd16901","rev":1,"status":"online"},"host":{"rev":1,"sha256":"f56d2450f463b32d807f2260f9e298b822f5a08a8e68827c38d2f112fbd16901"},"creatorRev":1,"creatorSha256":"f56d2450f463b32d807f2260f9e298b822f5a08a8e68827c38d2f112fbd16901"},"memberEdit":{"clipId":"c-muhp3t3l-5","value":"u2-member-96d4df1a","commitMs":74.6},"creatorEditSeenMs":3,"creatorEdit":{"clipId":"c-muhp3t3l-6","value":"u2-creator-96d4df1a","creatorCommitMs":57.7,"seenClipId":"c-muhp3t3l-6","flash":true},"final":{"page":{"sha256":"521c62296652fc2f2301ffafaa7fed50dbd9a452080a2e71950f9836948e4a90","rev":3,"status":"online"},"host":{"rev":3,"sha256":"521c62296652fc2f2301ffafaa7fed50dbd9a452080a2e71950f9836948e4a90"}},"fails":[]}
```

结论：member 经组播发现找到主机（`[局域网模式] 主机：DESKTOP-GS40TCK-vqxC`），进入用时 279 ms。

- **进入时**：rev 1，页面、主机、creator 报的三份 sha256 相同。
- **成员改一处**：creator 在收到报告后 33 ms 看到（上界 126 ms），时间轴上有描边。
- **creator 改一处**：成员在收到报告后 3 ms 看到。
- **结束时**：rev 3，三份 sha256 相同；项目已删（`deleted: true`）。

在第一版（`32f18bc`）上也跑过一轮，两边都通过，退出码都是 0。结果是 `memberEditSeenMs 45`、`creatorEditSeenMs 9`，最终 rev 3 三份相同。那一轮的 `commitMs` 口径有误，见第 1 节末尾。

### 2.2 托管模式（本机托管组合）

托管组合（数据目录在 scratchpad `hosted-u2`，绑 `0.0.0.0`）：
```
PROMPTCUT_DATA_DIR=<scratchpad>/hosted-u2 PROMPTCUT_DOCSERVICE_PORT=8790 PROMPTCUT_ASSET_PORT=8791 PROMPTCUT_DOCSERVICE_HOST=0.0.0.0 PROMPTCUT_ASSET_PUBLIC_URL=http://192.168.50.96:8791/api/asset node server/hosted/main.mjs
node scripts/probes/c65-editor-probe.mjs --role creator --mode hosted --hosted http://192.168.50.96:8790 --coord-port 5559 --coord-host 0.0.0.0 --spawn-editor 5540 --out out/u2/hosted-creator
node scripts/probes/c65-editor-probe.mjs --role member --coord http://192.168.50.96:5559 --spawn-editor 5550 --device-id pc-u2-member-probe-0001 --device-name u2-member-laptop --out out/u2/hosted-member
```

两个探针进程的退出码都是 0（creator 的日志末行是 `EXIT 0`）。

我原来想在同一条 bash 里先把 creator 放到后台、`sleep 20` 之后再起 member，但这个环境禁止前台 `sleep`，member 没有起来，那条组合命令整体报了 1。creator 本身一直在等（协调口会等到 900 s），我单独起 member 之后这一轮跑完。这是我调用方式的问题，与探针无关。

creator：
```
{"ok":true,"role":"creator","mode":"hosted","runId":"e9adc0e0","origin":"http://127.0.0.1:5540","coord":"http://127.0.0.1:5559","name":"u2-e9adc0e0","projectId":"sp_ua3x47w62wg2athhoi7wr3altx","rev":1,"shots":["C:\\Users\\admin\\Documents\\PromptCut\\.worktrees\\c65-u2\\out\\u2\\hosted-creator\\creator-1-created.png","C:\\Users\\admin\\Documents\\PromptCut\\.worktrees\\c65-u2\\out\\u2\\hosted-creator\\creator-2-saw-member-edit.png"],"device":{"deviceId":"pc-vqxCRm0vQRfjWbzscI-4fc","deviceName":"DESKTOP-GS40TCK-vqxC","lanHost":false,"localEditor":true},"where":"hosted","sha256":"fa0d738e06489e45a1a92e24e1ec03232cfadb40b58bb0ca485c3fe90e30ec96","member":{"entered":{"ok":true,"rev":1,"sha256":"fa0d738e06489e45a1a92e24e1ec03232cfadb40b58bb0ca485c3fe90e30ec96","hostRev":1,"where":"hosted","base":"http://192.168.50.96:8790/","candidate":"u2-e9adc0e0 · [互联网模式] 托管在阿里云","enterMs":262},"result":{"ok":true,"fails":[],"rev":1,"creatorEditSeenMs":0,"memberEdit":{"clipId":"c-muhos4k4-5","value":"u2-member-e9adc0e0","commitMs":49.6},"final":{"page":{"sha256":"424d8d5c4252f825531b111abfcbbe166702c5f4bbad4e0f479ba1539fec0d42","rev":3,"status":"online"},"host":{"rev":3,"sha256":"424d8d5c4252f825531b111abfcbbe166702c5f4bbad4e0f479ba1539fec0d42"}}}},"memberEditSeenMs":61,"memberEditSinceGoMs":132,"memberEdit":{"clipId":"c-muhos4k4-5","value":"u2-member-e9adc0e0","memberCommitMs":49.6,"seenClipId":"c-muhos4k4-5","flash":true},"creatorEdit":{"clipId":"c-muhos4k4-6","value":"u2-creator-e9adc0e0","commitMs":76.6},"creatorEditSeenMs":0,"final":{"page":{"sha256":"424d8d5c4252f825531b111abfcbbe166702c5f4bbad4e0f479ba1539fec0d42","rev":3,"status":"online"},"host":{"rev":3,"sha256":"424d8d5c4252f825531b111abfcbbe166702c5f4bbad4e0f479ba1539fec0d42"},"member":{"sha256":"424d8d5c4252f825531b111abfcbbe166702c5f4bbad4e0f479ba1539fec0d42","rev":3,"status":"online"}},"deleted":true,"fails":[]}
```

member：
```
{"ok":true,"role":"member","mode":"hosted","runId":"51889803","origin":"http://127.0.0.1:5550","coord":"http://192.168.50.96:5559","name":"u2-e9adc0e0","projectId":"sp_ua3x47w62wg2athhoi7wr3altx","rev":1,"shots":["C:\\Users\\admin\\Documents\\PromptCut\\.worktrees\\c65-u2\\out\\u2\\hosted-member\\member-1-entered.png","C:\\Users\\admin\\Documents\\PromptCut\\.worktrees\\c65-u2\\out\\u2\\hosted-member\\member-2-saw-creator-edit.png"],"device":{"deviceId":"pc-u2-member-probe-0001","deviceName":"u2-member-laptop","lanHost":false,"localEditor":true},"hosted":"http://192.168.50.96:8790","enterMs":262,"where":"hosted","base":"http://192.168.50.96:8790/","candidate":"u2-e9adc0e0 · [互联网模式] 托管在阿里云","entered":{"page":{"sha256":"fa0d738e06489e45a1a92e24e1ec03232cfadb40b58bb0ca485c3fe90e30ec96","rev":1,"status":"online"},"host":{"rev":1,"sha256":"fa0d738e06489e45a1a92e24e1ec03232cfadb40b58bb0ca485c3fe90e30ec96"},"creatorRev":1,"creatorSha256":"fa0d738e06489e45a1a92e24e1ec03232cfadb40b58bb0ca485c3fe90e30ec96"},"memberEdit":{"clipId":"c-muhos4k4-5","value":"u2-member-e9adc0e0","commitMs":49.6},"creatorEditSeenMs":0,"creatorEdit":{"clipId":"c-muhos4k4-6","value":"u2-creator-e9adc0e0","creatorCommitMs":76.6,"seenClipId":"c-muhos4k4-6","flash":true},"final":{"page":{"sha256":"424d8d5c4252f825531b111abfcbbe166702c5f4bbad4e0f479ba1539fec0d42","rev":3,"status":"online"},"host":{"rev":3,"sha256":"424d8d5c4252f825531b111abfcbbe166702c5f4bbad4e0f479ba1539fec0d42"}},"fails":[]}
```

结论：进入时 rev 1，三份 sha256 相同；`memberEditSeenMs 61`（上界 132）、`creatorEditSeenMs 0`；结束时 rev 3，三份相同；项目已删。

### 2.3 看过的图（1440×900，`out/u2/`，未入库）

| 文件 | 内容 |
|---|---|
| `lan-creator/creator-2-saw-member-edit.png`（第一版那轮） | 顶栏「成员: 2 人」，第一个片段「数字滚动」有描边：别人的改动到了 |
| `lan-member/member-1-entered.png`（第一版那轮） | 成员进入后「成员: 2 人」、时间轴与创建者相同；右上角「阿里云连不上」气泡（局域网模式故意给的死地址） |
| `hosted-member/member-2-saw-creator-edit.png` | 第二个片段「模糊浮现」副标题变成 `u2-creator-e9adc0e0`，带描边：创建者的改动到了 |

其余几张（`lan2-*`、`hosted-creator/*`）是同一类画面。

### 2.4 没跑的

- 不带 `--role` 的三个原阶段这次没有重跑。那部分代码没改，只是包进了 `else`，`node --check` 通过。
- 没跑类型检查和全量测试：只动了一个探针脚本，不在 tsc 和 `npm test` 的范围里。

### 2.5 收尾

- 编辑器 5540、5550 都由探针自己起，跑完自己结束（日志里有 `editor.stopped`）。托管组合（node，PID 53028）由我用 `taskkill /T /F` 结束。结束后 5540～5559、8790～8799 没有监听。
- 局域网和托管两边的测试项目都以创建者身份删掉了（`deleted: true`），局域网主机以后启动时不会再广播它们。
- 没有建 junction，没跑 `npm ci`，没有装东西。

## 3. 需要主会话知道的

1. **我分到的端口段里有别人的进程**：5530～5532（PID 39952，`vite --port 5530`，10:00 起）和 5533～5535（PID 15968）都不是我起的，我没碰它们，所以改用了 5540、5550。主会话派活时若另有人用这一段，请核对一下。
2. **一台机器上两个编辑器共用仓库根**：两个实例共用同一个 `out/docservice`（凭证存储、本机空间日志）和 vite 依赖缓存。这次没出问题：member 的编辑器绑回环，不当主机；只用托管模式时，凭证存储里也不会有它的项目。真正跨机时笔记本有自己的一份，不存在这个问题。若要本机模拟得更彻底，可以给 member 另开一个临时 worktree 当根。
3. **托管模式的候选文案**：成员页面里的候选写的是「[互联网模式] 托管在阿里云」，即使托管端是本机的托管组合，因为文案是写死的。这不影响 U2，只是截图里看起来和实际不符。
4. **计时口径**：U2 说的「5 s 内收到」，我取的是「收到对方『已提交』报告 → 本页面 store 里出现那一处」，先看到就记 0；另给了一个含协调口往返的上界（`memberEditSinceGoMs`）。如果主会话要的是「成员改动 → 创建者看到」的端到端时间，两台机器的时钟不同步，只能用上界或者另做对时，请裁定用哪个。
5. **U2 的范围**：U2 只要求成员改、创建者收到。我按任务书另加了反方向（创建者改、成员收到，同样 ≤ 5 s 判定）和结束时三份一致的核对。

## 4. U2 跨机指令草稿

前提：

- 两台机器在同一局域网（W6b 已验证过：笔记本 192.168.50.247，主 PC 192.168.50.96）。
- 两边都签出同一个提交（本分支合入后的 `claude/c65` 或 main），并有 `node_modules`（puppeteer 带的 Chrome 要在）。
- 主 PC 的 Windows 防火墙要放行 node 的入站：编辑器 5540（局域网模式）、协调口 5559、托管组合 8790 / 8791（托管模式），以及局域网发现的 UDP 54887（组播 239.255.42.99）。W6b 时这些都通过。
- 笔记本只需要出站。
- 所有命令都在仓库根目录下的 PowerShell 里执行。

### 4.1 局域网模式（主 PC 当主机）

主 PC（creator）：
```powershell
node scripts/probes/c65-editor-probe.mjs --role creator --mode lan --coord-port 5559 --coord-host 0.0.0.0 --spawn-editor 5540 --out out/u2/lan-creator
```

笔记本（member），先试通：
```powershell
Invoke-RestMethod http://192.168.50.96:5559/healthz
```
期望 `ok: True`，`keys` 里有 `u2-join`（creator 建好项目之后才会有）。

然后跑：
```powershell
node scripts/probes/c65-editor-probe.mjs --role member --coord http://192.168.50.96:5559 --spawn-editor 5540 --out out/u2/lan-member
```

两边谁先起都行：member 最多等 900 s（`--timeout` 可改），协调口连不上会自动重试。

### 4.2 托管模式（主 PC 起本机托管组合代替阿里云）

主 PC，窗口 1（托管组合；数据目录用一个新建的空目录）：
```powershell
New-Item -ItemType Directory -Force out/u2/hosted-data | Out-Null
$env:PROMPTCUT_DATA_DIR = (Resolve-Path out/u2/hosted-data).Path
$env:PROMPTCUT_DOCSERVICE_PORT = '8790'; $env:PROMPTCUT_ASSET_PORT = '8791'; $env:PROMPTCUT_DOCSERVICE_HOST = '0.0.0.0'
$env:PROMPTCUT_ASSET_PUBLIC_URL = 'http://192.168.50.96:8791/api/asset'
node server/hosted/main.mjs
```

主 PC，窗口 2（creator）：
```powershell
node scripts/probes/c65-editor-probe.mjs --role creator --mode hosted --hosted http://192.168.50.96:8790 --coord-port 5559 --coord-host 0.0.0.0 --spawn-editor 5540 --out out/u2/hosted-creator
```

笔记本（member；托管地址从协调口拿）：
```powershell
Invoke-RestMethod http://192.168.50.96:8790/healthz
node scripts/probes/c65-editor-probe.mjs --role member --coord http://192.168.50.96:5559 --spawn-editor 5540 --out out/u2/hosted-member
```

跑完在主 PC 窗口 1 按 Ctrl+C 结束托管组合。

若要改用真正的阿里云托管端，把 creator 的 `--hosted` 换成 `http://8.219.80.16:8787` 即可。这会在线上托管端建一个项目，跑完探针会删掉它。要不要这样做，由用户决定。

### 4.3 期望字段（两边最后一行 JSON）

| 角色 | 字段 | 期望 |
|---|---|---|
| member | `ok` | `true`，退出码 0 |
| member | `where` | 等于 `mode`（`lan` / `hosted`） |
| member | `base` | 局域网模式是 `http://192.168.50.96:5540/docservice/`；托管模式是 `http://192.168.50.96:8790/` |
| member | `candidate` | 局域网模式含 `[局域网模式] 主机：<主 PC 设备名>` |
| member | `entered` | `page.rev` = `host.rev` = `creatorRev`，`page.sha256` = `host.sha256` = `creatorSha256`（U2 前半） |
| member | `creatorEditSeenMs` | ≤ 5000 |
| member | `creatorEdit` | `flash` 为 `true`，`seenClipId` = `clipId` |
| member | `final` | `page` 与 `host` 的 rev、sha256 相同 |
| creator | `ok` | `true`，退出码 0 |
| creator | `memberEditSeenMs` | ≤ 5000（U2 后半）；`memberEditSinceGoMs` 只记录 |
| creator | `memberEdit` | `flash` 为 `true`，`seenClipId` = `clipId` |
| creator | `member.entered.ok` | `true` |
| creator | `final` | `page`、`host`、`member` 三份的 rev、sha256 相同 |
| creator | `deleted` | `true` |

截图：主 PC 的 `out/u2/*-creator/creator-1-created.png`、`creator-2-saw-member-edit.png`；笔记本的 `out/u2/*-member/member-1-entered.png`、`member-2-saw-creator-edit.png`。

## 5. 需要主会话决定

- 第 3 节第 4 条的计时口径。
- U2 托管模式用本机托管组合，还是用阿里云（第 4.2 节末尾）。
- 合并、返工还是放弃。
