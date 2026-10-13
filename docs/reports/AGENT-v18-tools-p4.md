# AGENT-v18-tools-p4：0.7.18 云端 Agent 工具包 P4「主体识别」

分支 `claude/v18-tools-p4`（从 main `d7075a58` 分出），工作区 `.worktrees/v18-tools-p4`，端口段 28340～28379（这个包没起任何服务端口）。不推送、不合并。

本文里的代号：

- **P4**：`docs/plan/cloud-agent-tools-implementation.md` 工具拆包表里的一个包，管 `subject_status`、`subject_install`、`detect_subjects`、`list_subjects` 四个工具在云端 Agent 服务一侧的实现。
- **F0**：同一张表里先行的公共地基（`tool-context.mjs`、`tool-jobs.mjs`、`project-assets.mjs`，以及它们依赖的 `run-resources.mjs`），已在 main，这个包只调用不修改。
- **G 包**：表里最后一个包，唯一能改工具总表（`cloud-tools.mjs`）和实例入口的人。
- **light / full 两档**：主体检测的两档引擎。light 是 YuNet 人脸加 RT-DETR 人体（onnxruntime），只认 person 和 face，提示词不生效；full 再加 Grounding DINO，能按提示词找任意名词。
- **retained**：共有对话里已读过消息的那一轮，在发消息的人被踢或改密退出后仍可执行完（run authority 的规则）。
- **替身 Python**：`server/test/fixtures/subject-stub.mjs`，按同一份命令行与 JSONL 约定回话的小脚本，只给单测用，让取消、超时、孤儿进程不依赖真模型就能反复跑。
- **〔裁〕**：文档没写到、我自己定的地方，等主会话和用户审。

## 做了什么

只做表里 P4 一行，没碰别的包的文件，也没碰渲染那一带和那十个不许改的文件。

| 文件 | 内容 |
|---|---|
| `server/agent/service/perception/subject.mjs`（新） | 四个工具的云端实现：`createSubjectTools(...)` 返回 `{handles, call(name,args,context,{requestId}), cancel, close}`；`readSubjectConfig(env,{root})` 读节点配置；`SUBJECT_TOOL_NAMES`、`SubjectToolError` |
| `python/promptcut_subject/__main__.py`、`frames.py`（改，表里写明本包独占的目录） | 加三个全局选项 `--models-dir`、`--pylibs`、`--local-only` 和 `install --requirements`；桌面版不用它们，行为不变 |
| `python/tests/test_subject_hosted.py`（新） | 上面几个选项的 Python 单测，7 条 |
| `server/test/cloud-tools-p4-subject.test.mjs`（新） | 28 条单测 |
| `server/test/cloud-tools-p4-fixture.mjs`、`server/test/fixtures/subject-stub.mjs`（新） | 测试底座与替身 Python（单测与探针共用底座） |
| `scripts/probes/cloud-tools-p4-subject-probe.mjs`（新） | 真 Python、真权重、真 ffmpeg、真短视频的探针，39 项检查，能重复跑 |
| `docs/reports/assets/v18-tools-p4/` | 探针日志 `probe.log`、检测框叠在原图上的 `light-boxes.png` |

`server/vite-plugin-subject.ts`（桌面插件，归后面的 D 包）和 `cloud-tools.mjs`（总表，归 G 包）一个字没动。

### 实现的样子

- **上下文只来自 F0**：每个调用带 F0 发的可信八字段；起作业、读素材、起进程、写项目前后都用 `run-resources` 的 `authorize` 重验 doc 当前的 grant / fence。参数里的 `projectId`、路径、`engine` 之类一律不收（单测里塞了也不起作用）。
- **素材**：只经 `project-assets` 的 `openRead`（带哈希核对）取到对话工作目录 `subject/<作业号>/`，跑完删。Python 只读这份本地文件，并带 `--local-only`（ffmpeg / ffprobe 的 `-protocol_whitelist file`），伪装成媒体的播放列表连不了网络。
- **子进程**：只经 `workspace.spawn`（环境白名单、不弹窗）起，并登记到 `run-resources`（kind `child`）：这一轮被停、转私有、Agent 关闭、服务关闭时，进程树被杀、`exit` 与 `close` 都到了才算关。Windows 上用 `taskkill /F /T` 杀整棵树（Python 起的 ffmpeg 抽帧不会变孤儿）。
- **作业账本**：用 F0 的 `tool-jobs`（SQLite，种类 `subject.detect` / `subject.install`）。阶段是 `fetch`（0～10%）→ `detect`（10%～95%）→ `commit`（97%）→ done；进度节流写账本；共有已读任务进入 retained 后账本更新自动补一次检查点（`checkpointRetained`）。账本只存状态、进度、`outputRefs`（`{kind:'subjects', id:<mediaId>}`），中文失败原因、采样点数等放在对话工作区的 `subject/jobs.json`（`ToolJobs` 没有放这些的字段）。
- **结果落点**：写项目素材的 `subjects`（和桌面版 `actions.setMediaSubjects` 同一个形状，含 `failedCount`、`fellBackFrom`、`fallbackReason`、失败采样的 `failed`/`reason`）。写之前再验一次 write 权限，并带取字节时的 `mediaRev` 做版本预期：素材中途被换掉就丢弃这次结果（`MEDIA_CHANGED`），不把旧结果写到新素材上。镜头级的折叠仍由 `list_shots` 读 `media.subjects` 时做，不写镜头。
- **没有兜底档**：`engine` 为 null（依赖或权重没装好）时 `detect_subjects` 立即回 `{ok:false, cloudUnavailable:true, error}` 并指向 `see_frames`，不起一个注定失败的作业（桌面版是起作业、事后失败，见〔裁〕3）。
- **light / full 两档**：由 Python 侧 `pick_engine` 定（没提示词优先 light，提示词且 full 就绪才用 full），Node 不猜；`engine` 记实际跑的一档，`fellBackFrom` 记中途退档及原因；light 档的 `engineNote` 明说「提示词不生效，只认 person 和 face」；已有 light 结果、这次带提示词、而机器现在有 full，才自动重测并回 `staleEngine:true`，只有 light 的机器上不重测并说明原因。**这个包 light 与 full 两档都做到了真跑**（full 在这台 Windows CPU 上用真 Grounding DINO 跑过），分开记录见下。
- **`subject_install` 受控**：不收任何参数（模型给的 `tier`、`pip` 都不起作用）。只有节点配了 `PYLIBS` 与锁定版本的 `REQUIREMENTS` 才允许，装的永远是 light 档，连网只经出网闸代理（没给出网闸时 `PIP_NO_INDEX=1`，也可给本地轮子目录）；没配就回 `{ok:false, cloudUnavailable:true}`。进程内同时只有一个安装作业；已经有引擎就直接回 `alreadyInstalled`。full 档（torch + 690 MB 权重）本来就不走在线装，只随部署送达。
- **节点路径不回给模型**：`subject_status` 只回 `exists`/`bytes`，不回权重目录和解释器路径；失败原因里节点目录换成 `<节点目录>`、对话工作目录换成 `<工作目录>`。
- **并发与上限**：同一素材同一时刻只有一个检测作业（相同参数回 `alreadyRunning`，换参数回 `subject-busy`）；进程内同时在跑的检测作业默认 2 个；同一 `requestId`（宿主给的工具调用号）重试不开第二个；取字节有大小上限与时限；检测时限与桌面版同一组数（每帧 20 秒、下限 120 秒）。

## 验证结果

机器：Windows 11，Node 24.19，Python 3.11（anaconda 的 `cuda_Vit` 环境，onnxruntime 1.20.1、torch 2.5.1、transformers 4.57.6），ffmpeg 9.0.1。最终提交 `7ea36d72`（代码；之后只有本报告的提交）。

### 基线

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc -b --force` | 0 | 零错误 |
| `npm test`（带两个环境变量） | 0 | 6066 条：6063 过、0 失败、3 跳过（原有的），耗时只记录（约 84 秒）；其中本包 28 条全过；「机器忙时偶发失败」名单里的文件这次都没失败 |
| Python 单测（`cd python && python -m unittest tests.test_subject_*`） | 0 | 83 条，过，10 条按设计跳过（缺引擎或权重时跳过的原有用例）；本包新增的 7 条在内 |
| `node --test server/test/windows-hide-silent-spawn.test.mjs`（包含在 `npm test` 里） | 0 | 过：本包所有 `spawn` 都带 `windowsHide:true` |

### 「每包必须提交的证据」逐条（`docs/plan/cloud-agent-tools-implementation.md` 最后一节；对上 `AGENT-018-prep.md` 2.3 的 #4「隔离验收」与 #11「基线」）

底座说明：单测与探针用的是**真的** doc 一侧运行权限（`run-authority` 的 SQLite，真的 admit / confirmRead / 私有栅栏 / 登录撤销）、真的 `run-resources`、真的 `tool-jobs`（SQLite）、真的 `project-assets` 加项目素材物理库（真字节、真哈希、真 fd）、真的工作区、真的子进程。**没有**的是：Agent→素材服务→文档服务那一段 **TLS 线路**（用 F0 同款的受控线路适配器），以及项目一侧的 doc 写入（用内存替身）；这两段归 F0 的 mTLS 测试和 G 包的中央组合，见「没做成的」。

| 证据 | 结果 | 出处 |
|---|---|---|
| 用真实短素材出真实结果 | 过。一张公有领域人像照片（matplotlib 自带的 `grace_hopper.jpg`）用 ffmpeg 做成 4 秒短片，走完整条链：light 档 4 个采样都检出 `person` 与 `face` 框（`conf` 0.97 / 0.94），坐标在画面内，我看过叠框图（`docs/reports/assets/v18-tools-p4/light-boxes.png`，框与人、脸吻合）；full 档带提示词 `person . face . tie .`，框的 label 出现 `person` / `face` / `tie`；一段无人的测试图案：作业成功、没有人物框、不是 failed；超出时长的采样点带 `failed` 与原因、`failedCount=1` | 探针 `PASS` 行，日志 `docs/reports/assets/v18-tools-p4/probe.log` |
| 账本与产物 | 过。作业 `done`、`progress=1`、`outputRefs=[{kind:'subjects',id}]`；项目侧只收到一次带作业号的提交；取来的素材临时文件删净 | 探针；单测第 4 条 |
| 没装模型或依赖时的回应 | 过（真 Python）。没装 onnxruntime 的解释器：`engine:null`，`light.runtime.error` 点名 `No module named 'onnxruntime'`；依赖在、权重目录空：`engine:null`，`yunet`、`rtdetr` 的 `exists:false`；两种情况下 `detect_subjects` 都回「两档都用不了，没有兜底档，退回 see_frames」，账本里没有作业；节点没配主体识别：同样如实说，且不落任何文件。**full 缺权重**：只放 light 权重，`engine:'light'`、`full.ready:false`、`dino.exists:false`，带提示词也只跑 light，提示词原样回显、`engineNote` 说明不生效 | 探针 1、1b 段；单测第 3、4 条 |
| 取消 | 过。真跑着的 Python（200 个采样点）：取消前探到 1 个 python/ffmpeg 进程，`list_subjects` 报 running 10%；`cancel` 后 0 个，账本 `cancelled`，没写项目。替身下还验了**孙进程**也被杀；`resources.abortForFence`（这一轮被停）的回执 `childrenOpen:0`、账本 `cancelled`；转私有后权限收回、进程被杀、结果不写、账本不会变 `done` | 探针 3 段；单测「取消」「被停」「转私有」三条 |
| 超时 | 过。真 Python 加 4 秒时限：到点杀进程树，账本 `errorCode=SUBJECT_TIMEOUT`，原因写明「超过 4 秒，已强制结束」，没写项目 | 探针 3 段；单测 |
| 失败 | 过。真坏文件（文本冒充 mp4）：作业 error，原因是 ffprobe 的话（`moov atom not found`），工作目录路径被换成 `<工作目录>`；替身下还验了 Python 报错、崩溃（stderr 回溯）、结果格式不对三种；真 pip 失败（锁定清单要一个不存在的版本）：作业 `SUBJECT_INSTALL_FAILED`，原因带 pip 的 `No matching distribution` | 探针；单测 |
| 错误 mediaId、跨项目、参数不合法 | 过。不存在的 id、`../../etc/passwd`、对象冒充字符串、音频素材、超过 200 个采样点、不是数字的采样点：全部明确拒绝，账本一条作业都没登记；另一个项目的素材即使 id 对得上也看不见，素材层直接读它也读不到；伪造上下文（改 runId、缺字段）被拒；参数里塞 `projectId` / `runGrantId` / `path` / `engine` 不起作用，写的是上下文里的项目 | 单测 |
| 只读写拒 | 过。只读成员能查状态与结果，`detect_subjects` / `subject_install` 在起任何东西前被拒（`subject-forbidden`，状态 403），没起过除查状态外的进程 | 单测 |
| 401/403/503 | 过。权限被拒回 403 级；文档服务联系不上 fail closed 回 503 级的 `authority-unavailable`，不起任何进程，恢复后可用 | 单测最后一条 |
| 失权与 private / stop 逐消息 fence | 过。转私有后读不到、进程被杀；这一轮被停：进程被杀、账本 cancelled；共有已读任务登录被撤（retained）：作业照常跑完并写项目，账本走检查点 | 单测 |
| 重启后持久作业状态 | 过。graceful：`close` 杀进程树并等真关（回执 `childrenClosed:true, workPending:0`，探针里残留进程 0 个），账本 `interrupted`，新实例 `list_subjects` 说「被中断，可以重新调 detect_subjects（force:true）」而不是找不到；崩溃（没来得及 close）：账本里 `running` 的作业在重开时变 `interrupted`，`list_subjects` 照样说被中断 | 探针 3 段；单测两条 |
| ACK 丢失幂等 | 过。同一 `requestId` 重试不开第二个作业；并发的三个 `detect_subjects`（同素材）只有一个起了作业，账本里只有一行；并发两个 `subject_install` 只有一个起 | 单测 |
| 服务进程、Python worker 实际关闭与无残留 | 过。探针前后各数一次 python / ffmpeg 进程（0 / 0）、可见命令行窗口（3 / 3，没新增） | 探针末尾 |
| 旧实例不能复活 | 部分。`close` 之后所有调用回 `subject-closing`；真正的「旧实例换新实例」要实例注册（G 包的中央组合） | 单测 |
| Linux 的 ffmpeg / Python / 模型文件与版本、节点隔离、无凭据日志 | **没做**：这个包没有 Linux 环境，也不碰节点；见「没做成的」 | — |

## 没做成的与原因

1. **Agent→素材服务→文档服务的真 mTLS 全链**：这个包的底座用 F0 同款受控线路适配器，字节、哈希、fd 都是真的，但没有 TLS。要在 G 包的中央组合里用真实 Agent 实例注册和 mTLS 再跑一遍；探针和测试底座都参数化好了（`createProjectAssets` 的 `runAssetClient` 换成真传输即可）。
2. **项目一侧的 doc 写入**：`project.getMedia` / `project.setMediaSubjects` 是我定的窄接口，测试里是内存替身；G 包要接到 doc 的版本预期与操作栅栏上（见下节）。
3. **Linux 节点证据**：没有 Linux 环境。子进程树的杀法在 Linux 上只杀得到直接子进程（`workspace.spawn` 没建进程组，不是我的文件），Python 起的 ffmpeg 抽帧是短命进程，会自己退出；要不留残余，部署者需用独立 unit / cgroup（`run-resources` 的 `childTreeWitness` 接口就是为这个留的）。
4. **真 onnxruntime 轮子的在线安装**：没有本地轮子目录，也没有为这件事去下载包。`subject_install` 的真 pip 只验了「空清单成功」和「找不到包失败」两条（探针 1c 段），安装成功后 `engine` 变 light 这一步用替身验了。部署者提供锁定清单与轮子目录后再实测。
5. **full 档的 Linux / GPU 耗时**：这台机器 CPU 上 full 约 2.7 秒一帧，沿用桌面版的预估；没测节点。

## 我做的裁定（〔裁〕，三级，都不改用户操作）

- 〔裁〕1 `list_subjects` 从「R 档：在项目副本上跑桌面版的 handler」改成本包自己答。原因：桌面版 handler 读的「作业在跑」状态在 `src/mcp/common.ts` 里一张进程内全局的 `Map`（按 mediaId 不分项目），云端 Agent 服务进程里没有、也不该有；作业状态现在来自账本加对话工作区的索引。输出格式与桌面版逐字段一致（建议位置来自 `kernel.suggestPosition`）。G 包要把它从 `CLOUD_AGENT_SIDE` 里拿掉。
- 〔裁〕2 `subject_install` 在没配「受控安装」（`PYLIBS` 与锁定清单）的节点上回 `cloudUnavailable`，不装。拆包表说「只准锁定依赖／权重的受控 job，不允许模型给 pip/shell 任意参数」，我把「锁定」落成部署者给清单；这是三级机制。
- 〔裁〕3 两档都用不了时 `detect_subjects` 立即回「用不了」，不起作业。桌面版是起作业、过会儿 `list_subjects` 才报错；云端起一个注定失败的作业白占名额和账本，也让模型多一轮才知道。模型看到的字段是 `ok:false, cloudUnavailable:true`，与 `collect_install` 等已有云端工具同一个约定。
- 〔裁〕4 同一素材同一时刻只一个检测作业、进程内最多 2 个并发（桌面版不限）；两个数在 `SUBJECT_DEFAULTS` 里，可调。
- 〔裁〕5 `subject_status` 的 `detail` 精简成 `exists` / `bytes` / `runtime`，不回节点上的权重目录与解释器路径；多了 `installable` 与 `install` 摘要两个字段。
- 〔裁〕6 `subject_status` 结果缓存 15 秒（每次都要起一个 import 了 torch 的 Python），`subject_status` 工具本身与 `subject_install` 强制刷新。
- 〔裁〕7 只读成员调 `subject_install` 也被拒（它占节点资源并登记账本，账本的 `start` 本来就要 write）。

## G 包接线时要填什么

1. **工具表（`cloud-tools.mjs`）**：`subject_status`、`subject_install`、`detect_subjects` 现在是 `{mode: P, why: NEED_PY('主体识别')}`，`list_subjects` 是 `{mode: R}` 且在 `CLOUD_AGENT_SIDE` 里。四个都改成由本包的 provider 执行（`handles` 就是这四个名字），`list_subjects` 从 `CLOUD_AGENT_SIDE` 去掉。节点没配（`readSubjectConfig` 返回 null）时工具照样交给模型，它们自己回「没配/用不了」并指向 `see_frames`（和 `collect_*` 一个约定）；若 G 选择没配就不交给模型，这四个也一起不交。
2. **工厂**：
   ```
   createSubjectTools({
     config: readSubjectConfig(env, { root }),      // null 或 { error }（error 要在 main 里 fail 掉）
     resources,   // createRunResources(...)，与 tool-jobs、project-assets 同一个
     assets,      // createProjectAssets(...)
     jobs,        // createToolJobs({ authorize: resources.authorize, verifyFence: resources.verifyFence, ... })
     workspace: (context) => workspaces.open({ projectId, ownerKey, conversationId }),
     project: { getMedia, setMediaSubjects },
     egress,      // 可选：受控安装连网时才要
   })
   ```
3. **`project` 接口**（G 接到 doc）：
   - `getMedia(context, mediaId)` 返回项目当前副本里的素材记录（要有 `id, name, kind, duration, shots, subjects, pending`）或 `null`，并带 `mediaRev`（与 `openRead` 返回的 `mediaRev` 同一算法，`project-assets` 设计里 `sha256(canonicalJson({v:1,mediaId,kind,hash,ext,size,tiers}))`）；没有这个素材或它不在这个项目里就返回 `null`。
   - `setMediaSubjects(context, { mediaId, expectedMediaRev, subjects, jobId })`：在 doc 的版本预期与操作栅栏下写 `media.subjects`（换新对象，不原地改）；`mediaRev` 对不上抛 `{code:'media-changed'}`。
4. **调用约定**：`provider.call(name, args, context, { requestId })`，`requestId` 用宿主的工具调用号（8～128 个 `[A-Za-z0-9_-]`），重试就不会开第二个作业。`context` 必须是 F0 发的。
5. **控制路径**：这一轮停止 / 转私有 / Agent 关闭时，宿主照旧调 `resources.abortForFence`（它会杀本包登记的子进程树）与 `jobs.cancelForFence`；`provider.cancel(context, jobId)` 是给宿主和单测用的显式取消，不是模型工具。服务关闭时把 `provider.close(reason)` 的回执（`{childrenClosed, streamsClosed, workPending}`）并进实例关闭的 ACK。
6. **环境变量**（`server/agent-service/main.mjs` 要读，照 `readCollectConfig` 的位置）：`PROMPTCUT_AGENT_SUBJECT_PYTHON`、`PROMPTCUT_AGENT_SUBJECT_MODELS`、可选 `..._PYLIBS`、`..._REQUIREMENTS`、`..._WHEELHOUSE`，以及 `PROMPTCUT_FFMPEG`（取它所在目录进 PATH）。`PYTHONPATH` 由 `readSubjectConfig` 按仓库的 `python/` 加 `PYLIBS` 拼。
7. **`list_shots`**（P1 / G）：它的 `subjectHint` 读的是桌面版那张全局 `Map` 的「在跑 / 上次失败」，云端读不到；作业在跑期间它会提示「还没做主体检测」。要让它也说对，需要它改读本包的索引（或 P5 的统一作业查询）。
8. **`background_job_status`**（P5）：本包作业在账本里的种类是 `subject.detect` / `subject.install`，产物引用 `{kind:'subjects', id}`；中文失败原因不在账本里，在对话工作区 `subject/jobs.json`（`ToolJobs` 没有放文字的字段）。

## 对任务书或语义的更正建议

- 拆包表的接口草案（`ToolRunContext` / `RunAccess.signalFor` / `ProjectAssets.openRead` 返回 `ReadableStream`）与已落地的 F0 不一样：真实的是 `run-resources.mjs` 的 `register` 与 `signalFor`、`openRead` 返回 Node `Readable` 加 `closed`。建议拆包表这一节按 F0 现状更新，免得后面的包照草案写。
- `ToolJobs` 没有「按入参找作业」的接口，也没有放文字原因的字段，所以每个包都要自己维护一份「素材 → 作业号」的索引。建议 F0 的所有者补一个 `latest(context, kind, key)` 之类的查询，或在账本里加一个受限长度的 `message` 字段；P2、P3 会碰到同样的问题。
- `cloud-agent-tool-coverage.md` 里 `detect_subjects`、`subject_status`、`subject_install` 三行的「还差」栏，在 G 包接线并验过之后才能改；现在的状态是「本包实现与测试完成，未挂载」。
- 语义文档（`docs/semantics/`）本包不需要改。

## 要用户定的事

没有需要用户定的。〔裁〕1～7 都是三级机制，没有改变用户看到的界面文字或操作。
