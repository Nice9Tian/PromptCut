# AGENT-v18-tools-p2：云端 Agent 工具包 P2（语音转写）

分支 `claude/v18-tools-p2`，从 main `d7075a58` 分出。任务来源：`docs/plan/cloud-agent-tools-implementation.md` 工具拆包表 P2 一行（P2 指「语音转写」那一包；F0 指已在 main 的公共地基，即 `tool-context.mjs`、`tool-jobs.mjs`、`project-assets.mjs`；G 指最后统一接线的包；D 指桌面插件薄壳包）。

状态：实现、单测、真实素材集成测试都做完，等主会话审差异。没有推送、没有合并。

## 1. 做了什么

只做 P2 这一行。三个工具在 Agent 服务一侧做成一个 `CloudToolProvider`（`handles`、`call(name, args, context)`、`close(reason)`），文件：

| 文件 | 内容 |
|---|---|
| `server/agent/service/perception/stt.mjs`（新） | `createSttTools(...)`：`stt_status`、`stt_install`、`transcribe_media` |
| `python/promptcut_stt/`（本包独占目录，只加不改旧行为） | `transcribe --offline`；`status` 多报 `available_models`（权重放齐的模型名）；`install --requirements <文件>`；错误事件带 `kind`；`audio.py` 的 ffmpeg 抽音在离线模式加 `-protocol_whitelist file`、区分「没有音轨」 |
| `python/requirements-faster-whisper.lock.txt`（新） | faster-whisper 整棵依赖树的锁定版本（没有哈希，见第 4 节） |
| `python/tests/test_stt_offline.py`（新） | 9 条 Python 单测 |
| `server/test/cloud-tools-p2-stt.test.mjs`、`cloud-tools-p2-fixture.mjs`、`cloud-tools-p2-fake-stt.mjs`（新） | 22 条单测：假 Python 脚本把行为定死，其余是真的 |
| `server/test/cloud-tools-p2-stt-real.test.mjs`（新） | 5 条真实集成测试：真 Python + 真 faster-whisper + 真 ffmpeg + 真语音素材（缺依赖时整文件跳过并说明缺什么，npm test 不会因此红） |
| `server/test/cloud-tools-p2-real-lib.mjs`（新；`server/` 下的测试不许 import `scripts/`，所以放在这里）、`scripts/probes/cloud-tools-p2-stt-probe.mjs`（新） | 可重复跑的探针：准备依赖和素材，跑上面两个测试文件，缺依赖或有跳过就失败 |

没碰：F0 三个模块（只调用）、`server/vite-plugin-stt.ts`、`cloud-tools.mjs` 工具表、`hosted-tools.mjs`、`ssr-host.mjs`、`instance.mjs` 等中央文件、渲染那一带、十个不许改的文件。

### 行为（对模型）

- **每次调用都要可信的 ToolRunContext**（F0 的 8 字段），先过 `authorize`：`stt_status` 要读，`stt_install` 和 `transcribe_media` 要写。只读成员能问状态，装不了、转不了（`run-access-denied`，在探测环境、取素材、开作业之前就拒）。伪造的 context 被拒（`tool-context-untrusted`）。
- **参数严格**：多余字段一律拒（`bad-args`）。`stt_install` 只收 `engine`（枚举）；`transcribe_media` 只收 `mediaId`、`engine`、`model`（枚举）、`language`（语言代码或 `auto`）。没有 pip 参数、索引地址、依赖文件路径、本地路径、shell。
- **`stt_status`**：跑 `python -I -m promptcut_stt status`，回引擎是否已装、版本、`availableModels`、`ffmpeg` 有无、`installableHere`、`installRunning`。不带任何磁盘路径、解释器路径。
- **`stt_install`**：只装部署者在节点配置里给的锁定依赖文件（`runtime.requirements[engine]`），索引地址也只来自节点配置。没配就回「这台节点不开放自助安装」；已装就不开作业；节点上同时只允许一个安装；作业走 ToolJobs。
- **`transcribe_media`**：
  1. 开工前探测环境：Python 没配、引擎没装、权重没有、ffmpeg 没有，当场回 `{ok:false, cloudUnavailable:true, code, error}`，**不开作业、不取素材字节**。
  2. 经 `ProjectAssets.openRead` 取素材（别的项目的 mediaId、不存在的 mediaId 一律说成「素材取不到」，不透露在不在别处；图片回 `NO_AUDIO`；超过 `maxMediaBytes` 回 `MEDIA_TOO_LARGE`）。
  3. 开 ToolJobs 作业（`stt.transcribe`）：同一条消息里同样的请求只开一个，已失败/取消/中断的可以重新发起（换请求号）。立即返回 `jobId`，后台继续。
  4. 后台：取到工作区（边收边核哈希是 ProjectAssets 做的）→ 等转写名额（节点同时只跑一个）→ Python 子进程转写，参数固定：`transcribe --input <工作区文件> --engine --model --language <代码或 auto> --device auto --offline`，不带 `--out`。
  5. 结果规整（丢掉终点早于起点的坏段、文字截断、段数上限）→ 提交前重核写权限 → 调宿主给的 `commitTranscript`（项目写入的缝）→ 作业 `done`，`outputRefs=[{kind:'transcript', id:mediaId}]`。模型之后用现有的 `get_transcript` 读。
  6. 失败只在作业里记错误码（`TIMEOUT`、`NO_AUDIO`、`MODEL_NOT_INSTALLED`、`MEDIA_CHANGED`……），Python 原始消息（带临时路径）不进作业记录也不给模型；码对应的人话是导出的 `STT_ERROR_TEXT`。
- **子进程**：只经 `spawn`（不经 shell），环境变量按工作区白名单重建（再加节点配置的 `PROMPTCUT_PYLIBS`/`PROMPTCUT_MODELS`、锁定的 PATH 前缀），工作目录是本对话工作区，`windowsHide: true`。挂到 F0 的运行资源登记器；`kill` 换成杀整棵进程树（Windows 用 `taskkill /T`，Linux 用进程组），因为 Python 会再起 ffmpeg。
- **撤销/停止/私有**：登记器 `abortForFence` 一杀，子进程树真的退出；作业由宿主已有的 `cancelForFence` 标 `cancelled`；本模块不覆盖这个状态，也不往项目写。已被收回的运行不再起子进程。
- **「已读共有轮保留」**（登录退出后任务继续）：作业写库遇到 `job-scope-mismatch` 时自动走 ToolJobs 的 `checkpointRetained` 再继续，最终能写回。
- **重启**：`close()` 杀子进程树、等 exit+close、不改作业状态；ToolJobs 重开时把 `running` 标成 `interrupted`；同一请求重新发起得到新作业。
- `close(reason)` 回 `{childrenClosed, streamsClosed, workPending}`，等到子进程真的退出才回。

## 2. 验证（证据）

环境：Windows 11，内置 Python 3.11.9（主工作区 `desktop/src-tauri/runtime/python`，只读使用），faster-whisper 1.2.1 + small 权重（从主工作区已装好的一份复制到本工作区 `out/p2-stt/`，不入库），ffmpeg 9.0.1。

### 2.1 命令与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc -b --force` | 0 | 零错误 |
| `npm test`（先设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | 0 | 6064 条，通过 6060，失败 0，取消 0，跳过 4（3 条本来就跳过；第 4 条是真 pip 安装那条，没设 `P2_PIP=1` 时跳过）；末行「npm test 最终结果：零失败」 |
| `node scripts/probes/cloud-tools-p2-stt-probe.mjs`（探针：假脚本 22 条 + 真集成 5 条，不接受跳过，设 `P2_PIP=1`）| 0 | 27 条通过，失败 0，跳过 0 |
| `python -m unittest tests.test_stt_offline tests.test_status tests.test_audio tests.test_jsonl`（在 `python/` 下） | 0 | 25 条通过（含新增 9 条） |
| `npm test -- server/test/windows-hide-silent-spawn.test.mjs`（守门：起子进程都带 `windowsHide`） | 0 | 4 条通过 |

探针前后各查了一次可见窗口（`Get-Process … MainWindowHandle -ne 0 -and ProcessName -match …`）：前后都是空，没有弹窗。

### 2.2 真实素材的真实结果（不是状态接口通了）

素材：仓库自带的中文人声 `src/audio/assets/missing-material.wav`（1.37 秒）；Windows 自带合成语音（Zira）念一段已知英文，再用 ffmpeg 拼成带视频的 mp4（10 秒，160x120）、56 秒长音频、无音轨视频。素材都在 `out/p2-stt/media/`，不入库。

走的链：测试用的项目素材库（真实的项目分库文件）→ `ProjectAssets.openRead`（真）→ 工作区（真）→ 离线 Python 子进程（真）→ `commitTranscript`（假的内存项目）。

- 中文 wav，`language: zh`：`segments=[{"start":0,"end":1.28,"text":"找不到素材"}]`，`engine=faster-whisper`、`model=small`、`language=zh`。
- 英文 mp4（视频+音频，不给语言，自动检测）：`language=en`，`segments=[{"start":0,"end":8.96,"text":"Hello! This is a short test of cloud speech recognition. The quick brown fox jumps over the lazy dog."}]`；作业 `done`，`outputRefs=[{"kind":"transcript","id":"en-video"}]`；工作区里取来的副本已删除。
- `stt_status` 真实输出：`python 3.11.9`；`faster-whisper installed=true version=1.2.1 availableModels=["small"]`；`whisper installed=false`；`ffmpeg=true`；答案里没有磁盘路径。

### 2.3 逐条对任务书的验收

| 验收项 | 结果 |
|---|---|
| 真实短素材出真实结果 | 见 2.2 |
| 没装模型或依赖时的回应 | 真实：`model: medium` → `MODEL_NOT_INSTALLED`（带 `availableModels:["small"]`，离线子进程不会联网下载）；`engine: whisper` → `ENGINE_NOT_INSTALLED`（`canInstall:false`）；`stt_install whisper` → `INSTALL_NOT_ENABLED`（托管方没配锁定依赖）；无音轨视频 → 作业 `error`/`NO_AUDIO`；Python 没配 → `PYTHON_MISSING`；探测脚本崩 → `STATUS_FAILED`；缺 ffmpeg → `FFMPEG_MISSING`（假脚本）。这些都不开作业、不取素材字节 |
| 取消 | 真实：56 秒音频转写到一半（进度 0.178）时私有化对话 + `abortForFence` + `cancelForFence`，Python 进程 246 毫秒内退出，作业 `cancelled`（`FENCE_CANCELLED`），项目没写、工作区干净，`close()` 回 `{childrenClosed:true, streamsClosed:true, workPending:0}`。假脚本版还带一个孙进程，两个进程号都查到已退出 |
| 超时 | 真实：`transcribeMs=4000`，作业 `error`/`TIMEOUT`，Python 进程已退出，项目没写。假脚本版同样查孙进程已退出 |
| 失败 | 假脚本：通用失败、缺权重、无音轨、结果格式异常 → 各自的错误码；作业记录里查不到 Python 原始消息（含 `secret` 路径）；失败后同一请求可重新发起并成功；`TRANSCRIPT_TOO_LARGE`；素材在转写期间被换掉 → `MEDIA_CHANGED`，不覆盖 |
| 单测 + 能重复跑的探针 | `cloud-tools-p2-stt.test.mjs`（22）、`cloud-tools-p2-stt-real.test.mjs`（5）、`cloud-tools-p2-stt-probe.mjs` |
| 文档项目转写持久化 | **只验到 `commitTranscript` 缝**：提交带 `mediaId`、`mediaRev`、`assetHash`、`transcript`、`jobId`；假项目核素材哈希。真实文档服务的写入要 G 包接上后验（见第 3 节） |
| 重启取消 | 假脚本：`close()` 杀进程树；ToolJobs 重开后作业 `interrupted`/`INTERRUPTED_ON_RESTART`；同请求重新发起得到新作业并完成 |
| 跨项目拒 | 另一个项目里的 mediaId → `media-unavailable`，没有作业、没有子进程；上下文换成别的发送者/别的 run → `tool-context-untrusted` |
| 只读写拒 | `stt_install`、`transcribe_media` → `run-access-denied`，没有状态探测、没有素材读取、没有作业、没有子进程；`stt_status` 只读可用 |
| 失权 | 私有化后写授权被拒（真 SQLite 运行授权）；已被收回的运行不再起子进程；登录退出转「保留」的运行继续做完并写回，作业栅栏号前进（真 `checkpointRetained`） |
| 作业幂等、一次只跑一个 | 同一条消息里同样的请求同一个 `jobId`；两个素材同时转写，最大并发 1；同时只允许一个安装 |

夹具里**真的**：SQLite 运行授权（`run-authority-fixture`）、ToolJobs（SQLite）、运行资源登记器、`ProjectAssets`、项目分库素材库、工作区（路径/配额）。夹具里**假的**：素材 HTTP 通道（没有真 mTLS，用和 `project-assets-client.test.mjs` 同样的受控 wire adapter 直接调真素材库）、文档项目（内存里的 `media` 表）、假脚本版测试里的 Python。

### 2.4 说明

- 第一次全量里有 2 条红，都是我自己的：真集成测试文件曾 import 了 `scripts/` 下的模块（被「server/** 不 import scripts/」守门拦下），以及我在全量运行中途改那个文件时留下的一处语法错误（被「.mjs 脚本全部能解析」拦下）。已把依赖准备模块挪到 `server/test/cloud-tools-p2-real-lib.mjs`、修了语法，重跑后上表为准。
- 机器上同时有别的子 Agent 在跑，已知会偶发失败的那些测试（任务书列的）这次全量里没有出现失败，不需要单独重跑。
- 真取消那条用了 41 秒（等 56 秒音频解到第一段才有进度可取消），耗时只记录。

## 3. G 包接线时要填什么

1. **工具表**（`server/agent/service/cloud-tools.mjs` 第 69 行）：`stt_status`、`stt_install`、`transcribe_media` 从 `{ mode: P, why: NEED_PY('语音识别') }` 改成 hosted（`mode: H`），去掉 `why`。`background_job_status`、`auto_workflow` 的 `why` 里提到语音识别的部分归 P5，不在这里。
2. **构造**（每个 Agent 服务实例一次，同一个 `resources` 和 `ProjectAssets` 实例）：
   ```js
   createSttTools({
     resources,            // createRunResources 的那个实例（要 authorize / register / signalFor）
     assets,               // createProjectAssets 的实例
     jobs,                 // createToolJobs 的实例（要 start / update / get / checkpointRetained）
     workspace: (context) => workspaces.open({ projectId: context.projectId, ownerKey, conversationId: context.conversationId }),
     commitTranscript,     // 见下
     runtime: { pythonPath, sourceRoot?, pylibs, modelsDir, ffmpegDir?, requirements: { 'faster-whisper': <锁定依赖文件> }, indexUrl? },
     limits: { engines: ['faster-whisper'], ... },
   })
   ```
   `workspace` 的 `ownerKey` 要和 `hosted-tools.mjs` 里同一个对话用的一致（我没有读到它从哪来，没去猜）。
3. **`commitTranscript(context, { mediaId, mediaRev, assetHash, transcript, jobId })`**（要 G 在 `hosted-tools.mjs` 一侧实现）：在文档服务的 mutate 里改项目副本，带期望版本提交。需要 `ssr-host.mjs` 暴露 `host.setMediaTranscript(mediaId, transcript)`（背后是 `store.actions.setMediaTranscript`，`src/store/actions/media.ts:31` 已有）。mutate 内部要先核：素材还在（否则抛 `Object.assign(new Error('media-missing'), { code: 'media-missing' })`），素材的 `hash`（或 `tiers.original`）仍等于 `assetHash`（否则抛 `code: 'media-changed'`）。`stt.mjs` 会把这两个码翻成作业错误 `MEDIA_CHANGED`。
4. **路由**：`provider.handles` 是 `stt_status`/`stt_install`/`transcribe_media`；`provider.call(name, args, context)` 返回可直接 JSON 化的对象；抛出的错误有 `.code`（`SttToolError`、`ToolContextError`、`ToolJobsError`、`RunResourceError` 都带）。
5. **关闭**：实例关闭时调 `provider.close(reason)`，把 `{childrenClosed, streamsClosed, workPending}` 并入关闭收据；撤销时除了 `resources.abortForFence`，要按已有做法调 `jobs.cancelForFence`（本模块不替宿主标 `cancelled`）。
6. **P5（后台作业状态、一键流程）要用的**：作业 `kind` 是 `stt.install`、`stt.transcribe`；错误码到人话用 `STT_ERROR_TEXT`；`transcribe_media` 的工作区取回副本在作业结束时已删。
7. **部署者要提供**（本包没有也无法验证）：Linux 上的 Python 3.11+、锁定依赖（用 `pip-compile --generate-hashes` 在目标平台重新解一份，替换本包给的无哈希版本）、small（或其它）权重放进 `modelsDir` 的 huggingface 缓存布局、ffmpeg；Agent 服务用非特权用户跑，最好 cgroup/容器里断网（Python 子进程只有 `--offline` 这一层软约束；`stt_install` 的 pip 要出网，要单独放行）。

## 4. 没做成的与原因

- **没有真 mTLS 的素材通道、没有真文档服务**：这两样是中央组合（G 包）的事，本包用 F0 的真模块加受控接线；`commitTranscript` 没有对着真文档验过。
- **Linux 没验**：本机是 Windows。Linux 的 Python/依赖/权重/ffmpeg 版本和节点隔离、无凭据日志证据要部署者提供。
- **锁定依赖文件没有哈希**，版本是从这台开发机上装好的一组取的（平台是 Windows）；Linux 上要重新解（说明在文件头）。
- **`stt_install` 的真 pip 只用一个小包验过**（探针里的一条，要联网，`P2_PIP=1`）；没有真装整棵 faster-whisper（约 300 MB）。
- **安装被撤销杀掉时**，`pip --target` 可能留下装到一半的包（pip 自己不是原子的）；下次安装会修，`stt_status` 以能否导入为准。这是 Python CLI 现有安装方式的局限，没改。
- 没做的子项：`whisper`（openai-whisper，依赖 PyTorch）默认不开放，`engines` 配置里没有它；开放要部署者给它自己的锁定文件和 `.pt` 权重。

## 5. 〔裁〕

- 〔裁-P2-1〕**`language` 不填时用自动检测**。工具描述写的是「不填则自动检测」，但桌面实现里不填时 Python 的 `--language` 默认值是 `zh`（`vite-plugin-stt.ts` 不填就不传，`__main__.py` 默认 `zh`）。云端照工具描述做（传 `auto`）。三级（实现选型），按「与本机一致」应该由 D 包决定桌面那边是改默认值还是改描述；不改桌面。
- 〔裁-P2-2〕**云端转写一律 `--offline`**（不联网下载权重，ffmpeg 只读本地文件）。桌面不带这个开关，行为不变。权重缺了是如实回应而不是自动下载，对应「部署者提供权重」的计划原文。三级。
- 〔裁-P2-3〕**节点同时只跑一个转写、只装一个引擎**（CPU 活）。数字 1 是 `createSlot` 的串行，不是预算数字；如要并行是以后的容量决定。三级。
- 〔裁-P2-4〕**`stt_install` 要写权限**（它改节点级的库目录）。判据沿用现有的「写」授权，没有新造权限。

## 6. 对任务书或语义的更正建议

- 工具拆包表 P2 行写「当前 Python CLI status/install/transcribe 可复用」：status/transcribe 要加离线与权重清单、install 要加 `--requirements` 才能满足「云端不联网下载、只装锁定依赖」，已在 `python/promptcut_stt/` 做了（只加不改旧行为）。表里可补一句。
- `server/tools/ai.mjs` 里这三个工具的 `side` 是 `page`，云端 G 包翻开关时注意描述里「写入项目 store」「用 stt_status 轮询」的措辞在云端依然成立（`get_transcript` 读项目副本；`stt_status` 的 `installed` 字段保留）。
- 桌面 `language` 默认值与描述不一致（见〔裁-P2-1〕）。

## 7. 要主会话决定或注意的

- 差异里 Python 部分是桌面也在用的包：新增的都是可选开关/额外字段，旧用例（`test_status.py` 等）全过；`stt-install.test.mjs` 等 JS 侧测试在全量里跑。
- `docs/local.md` 里除两个环境变量外没读。真密钥没进提交。
- 本工作区 `out/p2-stt/` 里有约 760 MB 的复制品（pylibs、small 权重）和生成的素材，已被 `.gitignore` 忽略；不再需要时可以删掉整个 `out/p2-stt/`。

## 8. 要用户定的事

没有一级语义（界面文字、用户操作）改动。本包没有需要用户拍板的条目。

## 9. 审查退回后的修改

主会话审查退回三处，已改。

1. **同一条消息里两个一模一样的 `transcribe_media` 并发会各开一份工**（`stt.mjs`）。原来的 `pending.has(started.jobId)` 永远是 false（`pending` 里放的是 Promise）。改成本进程里记正在做的转写作业号 `transcribing`（一个 Set）：`startJob` 一回来、在下一个 `await` 之前同步查，查到已在做就走 `started:false` 那条分支；查不到就当场登记，`runTranscription` 收尾（含 `jobs.get` 抛错那条路）时删掉。`stt_install` 那条路核过：`if (installing) return …; installing = controller;` 之间没有 `await`，是同步占位，没有同类问题，没改。
   - 新测试：`cloud-tools-p2-stt.test.mjs` 末尾「two identical transcribe_media calls sent at the same time…」，`Promise.all` 同时发两个，断言恰好一个 `started:true`、同一个 `jobId`、转写子进程只起一次、作业 `done`、提交一次、工作区干净。为了稳定造出「两次 `jobs.start` 都拿到 queued」的交错，测试把 `jobs.get` 包了一层拖慢 300 毫秒。
   - 红：在没改的 `stt.mjs` 上，该测试稳定失败（跑了 2 次，2 次都红），断言 `exactly one call starts the work` 报 `actual: [ true, true ]`，期望 `[ false, true ]`——两个调用都回了 `started:true`。不拖慢 `jobs.get` 时在没改的代码上是绿的（交错太窄），所以拖慢是测试必须的一部分。
   - 绿：改后同一条测试通过。
2. **探针在 main 上跑不了**（`server/test/cloud-tools-p2-real-lib.mjs`）。原来的 `path.resolve(ROOT, '..', '..')` 只在 `.worktrees/<名>` 里指向主工作区。改成：`mainRootOf()` 用 `git rev-parse --path-format=absolute --git-common-dir` 的上一级求（`spawnSync` 带 `windowsHide`，`P2_MAIN_ROOT` 可覆盖）；`depSources()` 按顺序找「本树的 `out/pylibs`、`out/models/…`」再「主工作区的 `out/…`」（同一目录只列一次，只读来源）；`findPython()` 的候选同样处理；`copyDeps()` 复制进本树的 `out/p2-stt/`，已有就不动，找不到来源时抛的错里列出找过的所有位置。新增 `cloud-tools-p2-real-lib.test.mjs`（4 条）：用临时 git 仓库和临时 worktree 验 `mainRootOf` 在 main 自己里和在深层 worktree 里都求对；用临时目录模拟「ROOT 就是主工作区」验来源是自己的 `out/…`、拷贝只落在自己的 `out/p2-stt/`、其它文件一个没写；模拟 worktree 时验本树优先、其次主工作区、主工作区目录内容前后不变；`findPython` 两种位置都对。没有真去主工作区里跑，也没往主工作区写东西。
3. **文字**：报告第 1 节表里的路径改为 `server/test/cloud-tools-p2-real-lib.mjs`；`python/requirements-faster-whisper.lock.txt` 文件头的 `requirementsFile` 改成代码里的 `runtime.requirements[引擎名]`。
