# AGENT-v18-tools-p1：0.7.18 云端 Agent 工具包 P1（镜头识别一半）

分支 `claude/v18-tools-p1`（从 main `5c286289` 分出），工作区 `.worktrees/v18-tools-p1`，端口段 28600～28639（探针没起服务端口；真测里为「播放列表不连网」那一条临时在 28601 起了一个本地假服务，用完关掉）。不推送、不合并。

本文里的代号：

- **P1**：`docs/plan/cloud-agent-tools-implementation.md` 工具拆包表里的一个包。这次只做它的镜头识别一半：`detect_shots`，以及让 `list_shots` 在云端说清「作业在跑 / 被中断 / 失败」。素材拼图（`see_frames({source:'media'})`、`hosted-media-frames.mjs`、`server/vision/media-sheet.mjs`、经真实 render 队列）这次不做。
- **F0**：同一张表里先行的公共地基（`tool-context.mjs`、`tool-jobs.mjs`、`project-assets.mjs`，以及它们依赖的 `run-resources.mjs`），已在 main，这个包只调用不修改。
- **G 包**：表里最后一个包，唯一能改工具总表（`cloud-tools.mjs`）和实例入口的人。
- **scdet**：ffmpeg 自带的镜头切换检测滤镜，只认硬切。**TransNetV2**：一个专门的镜头切换检测神经网络（ONNX 格式，31 MB 权重），硬切和溶解（渐变转场）都认，溶解还给起止跨度。
- **替身脚本**：`server/test/fixtures/shots-stub.mjs`，按同一份命令行约定扮演 ffmpeg / ffprobe / Python 的小脚本，只给单测用，让取消、超时、孙进程不依赖真模型就能反复跑。
- **〔裁〕**：文档没写到、我自己定的地方，等主会话和用户审。

## 做了什么

| 文件 | 内容 |
|---|---|
| `server/agent/service/perception/shots.mjs`（新） | `createShotsTools(...)` 返回 `{handles, call(name,args,context,{requestId}), status, cancel, close}`；`readShotsConfig(env,{root})`；`SHOTS_TOOL_NAMES`、`ShotsToolError` |
| `python/promptcut_shots/__main__.py`、`detector.py`（改，仅加可选开关） | 加三个全局选项 `--models-dir`、`--pylibs`、`--local-only`（后者让 ffmpeg 解码加 `-protocol_whitelist file`，并拒绝网络地址）；桌面版不用它们，不带开关时行为一字不变 |
| `python/tests/test_shots_hosted.py`（新） | 上面几个选项的 Python 单测，6 条 |
| `server/test/cloud-tools-p1-shots.test.mjs`（新） | 31 条单测（替身脚本） |
| `server/test/cloud-tools-p1-shots-real.test.mjs`（新） | 7 条真东西测试（真 ffmpeg、真 Python、真 TransNetV2 权重、恶意同名模块、播放列表不连网） |
| `server/test/cloud-tools-p1-fixture.mjs`、`server/test/fixtures/shots-stub.mjs`（新） | 测试底座（真的运行权限 / run-resources / tool-jobs / project-assets / 工作区，项目一侧内存替身）与替身脚本，单测、真测、探针共用 |
| `scripts/probes/cloud-tools-p1-shots-probe.mjs`（新） | 整条链探针，38 项检查，能重复跑 |
| `docs/reports/assets/v18-tools-p1/probe.log` | 探针输出 |

`cloud-tools.mjs`、`hosted-tools.mjs`、`instance.mjs`、`server/agent-service/` 下的文件一个字没动；桌面的 `server/vite-plugin-shots.ts`、`server/tools/ai.mjs`、`src/mcp/handlers/ai.ts` 只读未改；渲染那一带和那十个不许改的文件没碰。

### 实现的样子

- **两档，如实标**：有 Python、`onnxruntime` 和 `transnetv2.onnx` 权重才用 TransNetV2（硬切和溶解）；没配 Python、依赖或权重不全、素材太长，就用 ffmpeg `scdet`（阈值 10，与桌面版同一个数，只认硬切）。用的是哪一档记在 `engine`，`scdet` 档带一句说明为什么没用模型（缺 `onnxruntime`、缺权重、没配 Python、太长，分别点名）。**模型档中途出错**（Python 崩了、报错事件、结果格式不对）时退到 `scdet` 再跑一遍，`list_shots` 里带 `fellBackFrom: 'transnetv2'` 与原因，结果的 `engine` 记实际的 `scdet`，不假称是模型识别的。取消和超时不触发退档。连 ffmpeg 都起不来，`detect_shots` 立即回 `{ok:false, cloudUnavailable:true}` 并指向 `see_frames`，不起一个注定失败的作业。镜头识别彻底失败时（坏文件、超时、`scdet` 也失败），错误里带固定的一句退路：用 `see_frames` 看真实画面自己判断切点，不要凭空编镜头，或请用户在电脑上的 PromptCut 里检测。
- **上下文只来自 F0**：每个调用带 F0 发的可信八字段；起作业、读素材、起进程、写项目前后都用 `run-resources` 的 `authorize` 重验 doc 当前的 grant / fence（`detect_shots` 要 write，`list_shots` 要 read）。参数里的 `projectId`、路径、`engine` 之类一律不收。
- **素材**：只经 `project-assets` 的 `openRead`（带哈希核对）取到对话工作目录 `shots/<作业号>/`，跑完删；ffprobe / ffmpeg / Python 只读这份本地文件，输入前都带 `-protocol_whitelist file`。
- **子进程**：ffprobe、ffmpeg、Python 都只经 `workspace.spawn` 起（环境变量白名单、不弹窗），并经公共实现 `runner.mjs` 的 `superviseChild` 登记到 `run-resources`：这一轮被停、转私有、Agent 关闭、服务关闭、取消、超时时整棵进程树被杀、`exit` 与 `close` 都到了才算关。Python 用 `isolatedPythonArgs` 的隔离模式起（`-I`），对话工作区里的同名模块不进模块搜索路径。没有自己写起进程和杀进程的代码。
- **作业账本**：F0 的 `tool-jobs`（SQLite，种类 `shots.detect`）。阶段 `fetch`（0）→ `probe`（5%）→ `detect`（10%～95%，ffmpeg 用 `-progress` 的 `out_time_us`、模型档用 Python 的 `percent`）→ `commit`（97%）→ done；共有已读任务进入 retained 后账本更新自动补一次检查点。账本只存状态、进度、`outputRefs`（`{kind:'shots', id:<mediaId>}`）；中文失败原因、用的哪一档、退档原因放在对话工作区的 `shots/jobs.json`。
- **结果落点**：写项目素材的 `shots`（和桌面版 `actions.setMediaShots` 同一个形状 `{engine, createdAt, transitions, shots}`）。写之前再验一次 write 权限，并带取字节时的 `mediaRev` 做版本预期：素材中途被换掉就丢弃这次结果（`MEDIA_CHANGED`），不把旧结果写到新素材上。
- **`list_shots` 自己答**（不再借桌面版 handler，它读的「作业在跑」状态是进程内全局 Map）：在跑（带百分比；重测时标 `stale` 并不给旧镜头）、被中断（重启或关闭）、失败、被取消各说清，失败时若项目里还留着更早成功的一批结果会注明；没检测过是 `null`。每个镜头折进主体情况（建议位置、舞台矩形 `suggestedRect`、占用率、人物框），转场去掉缩略图，各条 `subjectHint` 的分支与桌面版一致。主体检测那一边的「在跑 / 失败」读 `subject.mjs` 写在同一个对话工作区里的 `subject/jobs.json` 与账本（P4 报告里留给 P1 / G 的第 7 条）。
- **其它**：同一素材同一时刻只一个作业；进程内同时最多 2 个（可调）；同一 `requestId` 重试不开第二个；取字节有大小（1 GiB）与时限；作业时限 = 素材秒数 × 2 秒，下限 2 分钟、上限 1 小时；已有结果默认复用，`force:true` 重测；图片、音频回「不是视频（是图片 / 音频），没有镜头可分」；别的项目的素材、不存在的 id 一律「找不到素材」；`pending` 的素材回「还没进素材服务」。

## 验证结果

机器：Windows 11，Node 24.19，Python 3.11（anaconda 的 `cuda_Vit` 环境，onnxruntime 1.20.1），ffmpeg 9.0.1。

### 基线

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc -b --force` | 0 | 零错误，无输出 |
| `npm test`（带两个环境变量） | 第一遍 1（3 条失败）；失败文件单独重跑 0 | 第一遍 6212 条：6201 过、3 失败、8 跳过。3 条失败都不是本包的文件，都是机器忙时的偶发：`account-real-runner`（端口 6701 被占，EADDRINUSE）、`cloud-tools-p3-track` P3-01（子进程退出的时点断言）、`cloud-tools-p4-subject` 的 subject_install（并发时序）。这 3 个文件单独重跑 46 条全过、零失败（`npm test -- <三个文件>` 退出码 0）。本包新增的 38 条（单测 31、真测 7）两遍都过 |
| `node --test server/test/windows-hide-silent-spawn.test.mjs` | 0 | 4 条全过（本包所有 `spawn` / `execFile` 都带 `windowsHide:true`） |
| `cd python && python -m unittest tests.test_shots_hosted` | 0 | 6 条过 |

### 真素材：已知硬切对上真值（`cloud-tools-p1-shots-real.test.mjs` 与探针）

现造的视频：三段不同画面（`testsrc2` 75 帧、`smptebars` 90 帧、`rgbtestsrc` 50 帧，25 fps）拼成 8.6 秒，真值切点在 3.0 秒与 6.6 秒。

| 档 | 检出的切点 | 真值 | 最大误差 |
|---|---|---|---|
| ffmpeg scdet | 3.0、6.6 | 3.0、6.6 | 0.000 秒 |
| TransNetV2（真 Python、真权重） | 2.96、6.56 | 3.0、6.6 | 0.040 秒（一帧；它标的是切点前最后一帧） |

另一段 1 秒交叉溶解（两段各 4 秒，3～4 秒渐变，`xfade`）：TransNetV2 检出 `{kind:'dissolve', start:3.08, end:3.96}`；换 scdet 档检出 0 个，`engineNote` 明说只认硬切。结果真的写进了（测试里的）项目素材（探针里读 `projects.get(...).shots`：engine、3 个镜头、一次提交且带作业号），`list_shots` 读得回来（3 个镜头首尾 0～3～6.6～8.6，两个转场），账本 `done`、`progress=1`、`outputRefs=[{kind:'shots',id}]`，取来的素材临时文件删净（工作区只剩 `shots/jobs.json`）。

### 「每包必须提交的证据」逐条（对上 `AGENT-018-prep.md` 2.3 的 #4「隔离验收」与 #11「基线」）

底座说明同 P4：真的 doc 一侧运行权限、`run-resources`、`tool-jobs`（SQLite）、项目素材物理库与 `project-assets`、工作区、真子进程；**没有**的是 Agent→素材服务→文档服务那一段 TLS 线路（受控线路适配器，字节、哈希、fd 都是真的），以及项目一侧的 doc 写入（内存替身）。

| 证据 | 结果 | 出处 |
|---|---|---|
| 没装依赖 | 过。真 Python（没有 onnxruntime）：`status` 报 `engine:'scdet'`，`reason` 点名 `onnxruntime 没装（No module named 'onnxruntime'）`；`detect_shots` 照样用 scdet 跑完，`list_shots` 的 `engineNote` 写明没用模型的原因，硬切仍对上真值 | 真测第 3 条；探针「2」段 |
| 权重不在 | 过。依赖在、权重目录是空：`engine:'scdet'`，点名 `transnetv2.onnx` 不在，不假称模型识别 | 真测第 4 条；探针 |
| 没配 Python | 过。只配 ffmpeg：scdet 档，`engineNote` 说「节点没有配置 TransNetV2」，整条链与硬切精度见上 | 单测；探针「1」段 |
| ffmpeg 没有 | 过。配了路径但起不来：`detect_shots` 回 `{ok:false, cloudUnavailable:true}` 并指向 `see_frames`，账本里没有作业，节点路径不泄露；整个节点没配（`config:null`）同样如实说 | 单测前两条；探针 |
| 取消（含孙进程） | 过。真 TransNetV2 档在 300 秒 1080p 片子上：取消前探到 2 个进程（Python 加它起的 ffmpeg 解码，开始前 0 个），`list_shots` 报 running 10%；取消后 0 个，账本 `cancelled`，没写项目，`list_shots` 抛「已被取消」。真 scdet 档：取消前 1 个 ffmpeg，取消后 0 个。替身下还按进程号查了孙进程（节点起的子进程再起的 `setInterval` 进程）确实没了；`abortForFence`（这一轮被停）的回执 `childrenOpen:0`、账本 `cancelled`；转私有后权限收回、进程被杀、账本不会变 `done`。取消不触发退档 | 探针「5a、5b」；单测「取消」三条 |
| 超时 | 过。真 Python 加 4 秒时限：到点杀进程树（查进程数回到 0），账本 `errorCode=SHOTS_TIMEOUT`，原因写明「超过 4 秒，已强制结束」并带退路，没写项目；模型档超时不退回 scdet；scdet 档同样 | 探针「5c」；单测 |
| 坏文件 | 过。真坏文件（文本冒充 mp4）：真 ffprobe 的话 `moov atom not found`，作业 `error`（`SHOTS_FAILED`）、带退路、工作目录路径被抹成 `<素材文件>`、没写项目；替身下还验了没有视频轨、scdet 退出码非 0 | 真测；探针「6」；单测 |
| 重启 | 过。graceful：`close` 杀进程树并等真关（回执 `childrenClosed:true, workPending:0`，探针里残留进程 0 个），账本 `interrupted`，新实例 `list_shots` 说「被服务关闭中断，没有结果，可以重新调 detect_shots（force:true）」而不是找不到；崩溃（没来得及 close）：账本里 `running` 的作业在重开时变 `interrupted`；连账本都不认识的作业也说被中断 | 探针「5d」；单测两条 |
| 跨项目 | 过。别的项目的素材，id 对得上也「找不到素材」；素材层直接读也读不到；`list_shots` 同样 | 单测；探针「6」 |
| 只读成员 | 过。能用 `list_shots`，`detect_shots` 在起任何进程之前被拒（`shots-forbidden`，状态 403），一个进程都没起过 | 单测；探针「6」 |
| 伪造上下文 | 过。换了 `runId`、缺字段的上下文被拒；参数里塞 `projectId` / `runGrantId` / `path` / `engine` 不起作用，写的是上下文里的项目，引擎由节点定 | 单测；探针「6」 |
| 恶意同名模块 | 过。在对话工作区根下放 `promptcut_shots.py`、`promptcut_stt.py`、`json.py`、`argparse.py`、`numpy.py`、`onnxruntime.py`、`subprocess.py`、`os.py`（被导入就写标记文件）：真 Python 查状态、真 TransNetV2 跑检测，标记文件始终为空，且模型档照常跑出结果、没有退档 | 真测第 5 条；探针「4」 |
| 播放列表不连网 | 过。素材是写着 `http://127.0.0.1:28601/…` 的 m3u8 播放列表：作业失败，本地假服务 0 次被访问；对照组（白名单放开 http 的 ffprobe）访问了本地服务 | 真测最后一条 |
| 图片 / 音频 / 不存在的素材 | 过。回「X 不是视频（是图片／音频），没有镜头可分」「找不到素材」，不登记作业 | 单测 |
| 401/403/503 | 过。权限被拒回 403 级（`shots-forbidden`）；文档服务联系不上 fail closed 回 503 级的 `authority-unavailable`，不起任何进程，恢复后可用 | 单测最后一条 |
| 失权与 private / stop 逐消息 fence | 过。见取消一行；共有已读任务登录被撤（retained）：作业照常跑完并写项目，账本走检查点 | 单测 |
| ACK 丢失幂等 | 过。同一 `requestId` 重试不开第二个；并发的三个 `detect_shots`（同素材）只起一个，账本里一行 | 单测 |
| 素材中途被换掉 | 过。检测期间改项目里素材的哈希：作业 `error`（`MEDIA_CHANGED`），不写旧结果 | 单测 |
| 服务进程、Python、ffmpeg 实际关闭与无残留 | 过。探针前后各数一次相关进程（0 / 0）、可见命令行窗口（3 / 3，没新增） | 探针末尾 |
| Linux 的 ffmpeg / Python / 模型文件与版本、节点隔离、无凭据日志 | **没做**：这个包没有 Linux 环境，也不碰节点；见「没做成的」 | — |

## 没做成的与原因

1. **Linux 节点证据**：没有 Linux 环境。进程树在 Linux 上的杀法由公共实现 `runner.mjs` 负责（进程组），spawn 包有 Linux 演示（`scripts/probes/cloud-tools-spawn-linux-demo.mjs`）；本包的 ffprobe / ffmpeg / Python 起法与它一致，但没在 Linux 上跑过镜头识别本身。节点要装的东西见下文「G 包接线」第 6 条。
2. **Agent→素材服务→文档服务的真 mTLS 全链**：底座用 F0 同款受控线路适配器，字节、哈希、fd 都是真的，没有 TLS。要在 G 包的中央组合里用真实 Agent 实例注册和 mTLS 再跑一遍。
3. **项目一侧的 doc 写入**：`project.getMedia` / `setMediaShots` / `getStage` 是我定的窄接口，测试里是内存替身；G 包要接到 doc 的版本预期与操作栅栏上（见下节）。
4. **缩略图**：桌面版抓给时间轴画转场标记用的小图，云端不做（它是编辑界面的东西，云端项目没有对应的存放处），转场里不带 `thumbs`。若用户希望云端项目的时间轴上也有转场缩略图，要另做（缩略图要存成项目素材或另一类产物）。
5. **素材拼图那一半**：按派活指令这次不做（`see_frames({source:'media'})`、`hosted-media-frames.mjs`、`media-sheet.mjs`、经真实 render 队列），等看画面那条路。`list_shots` 里指向的 `see_frames` 目前只能用 timeline 来源。
6. **在线安装模型依赖**：没有 `shots_install` 工具（桌面版 `/api/shots/install` 一直有，但没暴露成 Agent 工具，工具总表里也没有这个名字），云端不装；依赖与权重由部署者放进节点。

## 我做的裁定（〔裁〕，三级，都不改用户操作）

- 〔裁〕1 **引擎顺序照桌面版，与拆包表的写法不同**：拆包表 P1 一行写「ffprobe/ffmpeg `scdet` 真 hard-cut，TransNetV2 有实际依赖时再验」，把 scdet 当主线、TransNetV2 当可选；桌面版现在的做法是反过来的——装了拓展就用 TransNetV2，没装才退回 scdet。云端按桌面版的顺序（模型就绪用模型，否则 scdet），两档都真跑过。工具说明（`server/tools/ai.mjs`）里写的也是这个顺序。
- 〔裁〕2 `list_shots` 从「R 档：在项目副本上跑桌面版的 handler」改成本包自己答。原因：桌面版读的作业状态在 `src/mcp/common.ts` 里一张进程内全局 Map，云端 Agent 服务进程里没有、也不该有。输出格式与桌面版逐字段一致，外加 `engineNote` 里多说一句 scdet 的原因、`fellBackFrom` / `fallbackNote`、`stale` / `staleNote`。G 包要把它从 `CLOUD_AGENT_SIDE` 里拿掉。
- 〔裁〕3 模型档中途出错时退到 scdet 再跑（桌面版是直接把作业标成失败）。理由：用户想要的是镜头划分，退一档拿到硬切比拿到一个报错更有用；代价是明确标注 `fellBackFrom`，不假称模型识别。超时和取消不退档。
- 〔裁〕4 两档都用不了（ffmpeg 起不来）时 `detect_shots` 立即回「用不了」不起作业（桌面版是起作业、事后失败）。与 P4 的〔裁〕3 同一个约定：`ok:false, cloudUnavailable:true`。
- 〔裁〕5 素材太长（帧数超过 12 万，约 67 分钟 30fps）时模型档改用 scdet：模型档把整段视频解成 48×27 的小帧放进内存（每帧约 4 KB，复制两份），长片会吃光节点内存。阈值在 `SHOTS_DEFAULTS.maxModelFrames`，可调。
- 〔裁〕6 scdet 命中点的 `confidence` 写 `分数 / 100`（scdet 分数是 0～100 的画面差异），桌面版一律写 1。字段含义相同，只是更有信息；没有消费方依赖它恒为 1。
- 〔裁〕7 同一素材同一时刻只一个检测作业、进程内最多 2 个并发、作业有时限（桌面版都不限）；数在 `SHOTS_DEFAULTS` 里。
- 〔裁〕8 写入项目的转场只保留 `kind/start/end/time/confidence`（桌面版把 Python 返回的 `startFrame` 等也一并存了，类型里没有这些字段）。
- 〔裁〕9 Python 包加三个可选全局开关（`--models-dir`、`--pylibs`、`--local-only`），理由同 P4：工作区起子进程时 `PROMPTCUT_*` 一个都不传，模型目录、依赖目录改走命令行；`--local-only` 让素材（成员传的，可能是伪装成媒体的播放列表）的 ffmpeg 解码被限制在本地文件。桌面版不带开关，行为不变（桌面调用没改）。
- 〔裁〕10 `list_shots` 折叠主体情况时，`suggestedRect` 的舞台尺寸要项目一侧给（`project.getStage`）；没给就不返回 `suggestedRect` 这个键（不是返回 null，null 在桌面版的意思是「四侧都被占」）。

## G 包接线时要填什么

1. **工具表（`cloud-tools.mjs`）**：`detect_shots` 现在是 `{mode: P, why: NEED_PY('镜头识别')}`，`list_shots` 是 `{mode: R}` 且在 `CLOUD_AGENT_SIDE` 里。两个都改成由本包的 provider 执行（`handles` 就是这两个名字），`list_shots` 从 `CLOUD_AGENT_SIDE` 去掉。节点没配（`readShotsConfig` 返回 null）时工具照样交给模型，它们自己回「没配 / 用不了」并指向 `see_frames`；若 G 选择没配就不交给模型，这两个也一起不交。
2. **工厂**：
   ```
   createShotsTools({
     config: readShotsConfig(env, { root }),      // null 或 { error }（error 要在 main 里 fail 掉）
     resources,   // createRunResources(...)，与 tool-jobs、project-assets 同一个
     assets,      // createProjectAssets(...)
     jobs,        // createToolJobs(...)
     workspace: (context) => workspaces.open({ projectId, ownerKey, conversationId }),
     project: { getMedia, setMediaShots, getStage },
   })
   ```
3. **`project` 接口**（G 接到 doc）：
   - `getMedia(context, mediaId)`：项目当前副本里的素材记录（要有 `id, name, kind, duration, shots, subjects, pending`）或 `null`，带 `mediaRev`（与 `openRead` 返回的同一算法）；没有这个素材或它不在这个项目里就返回 `null`。**与 P4 的 `getMedia` 是同一个，只实现一次。**
   - `setMediaShots(context, { mediaId, expectedMediaRev, shots, jobId })`：在 doc 的版本预期与操作栅栏下写 `media.shots`（换新对象，不原地改）；`mediaRev` 对不上抛 `{code:'media-changed'}`。
   - `getStage(context)`：`{ width, height }`，项目的舞台尺寸（可选，见〔裁〕10）。
4. **调用约定**：`provider.call(name, args, context, { requestId })`，`requestId` 用宿主的工具调用号（8～128 个 `[A-Za-z0-9_-]`），重试就不会开第二个作业。`context` 必须是 F0 发的。
5. **控制路径**：这一轮停止 / 转私有 / Agent 关闭时，宿主照旧调 `resources.abortForFence`（它会杀本包登记的子进程树）与 `jobs.cancelForFence`；`provider.cancel(context, jobId)` 是给宿主和单测用的显式取消，不是模型工具；`provider.status(context)` 给宿主与探针看节点能跑到哪一档，不是模型工具。服务关闭时把 `provider.close(reason)` 的回执并进实例关闭的 ACK。
6. **环境变量**（`server/agent-service/main.mjs` 要读，照 `readSubjectConfig` 的位置）：`PROMPTCUT_FFMPEG`（必需，绝对路径；`scdet` 档只要它）、可选 `PROMPTCUT_FFPROBE`（缺省取 ffmpeg 同目录的 ffprobe）；要 TransNetV2 档再配 `PROMPTCUT_AGENT_SHOTS_PYTHON`（装了 `onnxruntime`、`numpy` 的解释器）、`PROMPTCUT_AGENT_SHOTS_MODELS`（里面放 `transnetv2.onnx`，31 MB）、可选 `PROMPTCUT_AGENT_SHOTS_PYLIBS`。`PROMPTCUT_FFMPEG` 同时被主体识别用来给 Python 的 PATH 加 ffmpeg 目录，两边读同一个变量。Linux 节点要装：ffmpeg（要含 `scdet` 滤镜，本机 9.0.1 验过，别的版本部署者自己确认）与 ffprobe；要模型档再装 Python 3 + onnxruntime + numpy 和权重文件。
7. **与 P4 的耦合**：`list_shots` 为了让 `subjectHint` 说对（主体检测在跑 / 上次失败），读 `subject.mjs` 写在对话工作区里的 `subject/jobs.json`（行里的 `kind:'detect'`、`mediaId`、`status`、`message`、`jobId`）与账本。P4 若改这个索引的格式，这里要跟着改；P5 的统一作业查询落地后可以换成它。
8. **`background_job_status`**（P5）：本包作业在账本里的种类是 `shots.detect`，产物引用 `{kind:'shots', id:<mediaId>}`；中文失败原因不在账本里，在对话工作区 `shots/jobs.json`。
9. **`auto_workflow`**（P5）：「STT→shots→subject」里的 shots 一段，调用 `provider.call('detect_shots', ...)` 即可；`reused` / `alreadyRunning` / `cloudUnavailable` 三种回执要识别，不要把「用不了」当成功。

## 对任务书或语义的更正建议

- 拆包表 P1 一行把 scdet 写成主线、TransNetV2 写成「有实际依赖时再验」，与桌面版现行顺序相反（见〔裁〕1）；建议拆包表改成「模型档就绪用模型，否则 scdet」，两档都要真跑。
- 拆包表接口草案里 `ToolJobs` 没有放文字原因的字段，也没有「按入参找作业」的接口，所以每个包都要自己维护一份「素材 → 作业」的工作区索引（P4 报告已提）；P1 又多了「list_shots 要读 P4 的索引」这一层耦合，更说明 F0 补一个 `latest(context, kind, key)` 与受限长度的 `message` 字段是值得的。
- `cloud-agent-tool-coverage.md` 里 `detect_shots`、`list_shots` 的「还差」栏，在 G 包接线并验过之后才能改；现在的状态是「本包实现与测试完成，未挂载」。
- 语义文档（`docs/semantics/`）本包不需要改。

## 要用户定的事

没有需要用户定的。〔裁〕1～10 都是三级机制，没有改变用户看到的界面文字或操作。唯一可以问一句的是缩略图（见「没做成的」第 4 条）：云端项目的时间轴上要不要有转场缩略图，这是一个会让用户看到不同的能力，当前不做，等用户说要再做。

## 闸门复测:探针「scdet 超时」一项不过(已修)

- **现象**:主会话合入 main 后重跑探针 37/38,`FAIL scdet 超时:同样 error、进程没了`;空闲机器上稳定复现。
- **实际值**(我在探针里加了打印后复现):作业 `state:"done"`、`errorCode:null`、`stage:"commit"`、`progress:1`,结果 `engine:scdet, shots:1`,进程数 0(开始前 0)。也就是 scdet 在 4 秒时限内**跑完并写进了项目**,没有超时。
- **原因**:检查本身对时间敏感,不是合入 main 后产品行为变了(workspace.mjs 额度改动没有影响这条路)。300 秒 1080p 的测试图案,ffmpeg 9.0.1 的 scdet 在空闲机器上不到 4 秒就解完;我第一次跑时机器忙才恰好超时。
- **修法**:探针里 scdet 超时单独起一个 0.4 秒时限的实例(足够小,启动加解码都跑不完),并加严检查:error、`超时`、账本 `SHOTS_TIMEOUT`、进程数回到开始前、没写项目,都要成立。没有放宽。
- **顺带修了一个产品小问题**:不到 1 秒的时限,超时提示写成「超过 0 秒」(`Math.round`);现在小于 10 秒的时限保留一位小数,写「超过 0.4 秒」。单测的 scdet 超时用例同步改成 0.4 秒并断言这句。
- **复测**:`npx tsc -b --force` 退出码 0;两个测试文件 38 条全过;探针连跑三遍都是 38/38(退出码 0),日志 `docs/reports/assets/v18-tools-p1/probe.log` 换成第三遍。

## 闸门第二次:不许直接 import `src/`(已改)

`accept-018-rest-ssr-seam` 的 SEAM-3 棘轮拦住了 `shots.mjs -> src/kernel/{project,layout}.ts`。独立入口对前端代码只经 `server/agent/ssr-host.mjs` 的载入缝,所以:

- `shots.mjs` 不再 import `src/` 下任何文件,也没有「缺省去 import」的退路;内核函数由宿主经工厂参数 `kernel` 注入,缺任何一个,工厂直接抛 `shots-unconfigured`「没配置全:缺内核函数 xxx」。
- 顺手把已合入的 `subject.mjs`(`defaultKernel` 懒加载 `src/kernel/project.ts`)按同一办法改掉,缺项抛 `subject-unconfigured`「没配置全」;从 `accept-018-rest-ssr-seam.test.mjs` 的 `KNOWN` 清单里删掉了它那一行。
- 测试底座(`cloud-tools-p1-fixture.mjs`、`cloud-tools-p4-fixture.mjs`)新增 `loadTestKernel()`,由测试代码自己从 `src/` 取函数注入(测试与探针不在棘轮的扫描范围内:棘轮只扫独立入口的传递闭包)。两个包各加一条「没注入就拒绝」的单测。
- **G 包接线时还要填**:经 `ssr-host.mjs` 的载入缝从前端代码取下面这些函数,注入工厂的 `kernel`:
  - `createShotsTools({ kernel: { subjectForRange, suggestPosition, rectForSafeSide } })`:前两个来自 `src/kernel/project.ts`,`rectForSafeSide` 来自 `src/kernel/layout.ts`;
  - `createSubjectTools({ kernel: { MAX_SUBJECT_TIMES, subjectSampleTimes, suggestPosition } })`:都来自 `src/kernel/project.ts`。
  - 载入缝里没有这些模块时,需要在 `ssr-host.mjs` 里加这两处载入(该文件归 G 包)。
