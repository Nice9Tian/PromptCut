# AGENT-v18-tools-p3：云端 Agent 的运动追踪与片段运动（P3 包）

分支 `claude/v18-tools-p3`，从 `main` d7075a58 分出，2026-10-13。范围见 `docs/plan/cloud-agent-tools-implementation.md` 拆包表 P3 一行：`track_status`、`track_install`、`track_points`、`get_track` 四个追踪工具，加 `attach_clip_motion`（把追踪轨迹绑到卡片段上，写在 `track` 之后）。

状态：实现、测试、探针都做完并通过，**工具表（`cloud-tools.mjs`）没翻开关**——接线归最后的 G 包，本包只交实现和 G 要填的东西（第 6 节）。名词先说一句：「F0」指已在 main 的公共地基（`tool-context.mjs`、`tool-jobs.mjs`、`project-assets.mjs`、`run-resources.mjs`）；「retained」指发起人登录退出后，已读的共有任务可以继续做完的那种授权状态；「fence」指 doc 一侧给任务授权的版本号，私有、停止、关 Agent 都会让它变。

## 1. 做了什么

| 文件 | 内容 |
|---|---|
| `server/agent/service/perception/track.mjs`（新） | 四个追踪工具的 provider：`createTrackTools(deps)` 返回 `{handles, call(name,args,context), close(reason), readResult, results}`；结果表 `createTrackResultStore`（SQLite，WAL+FULL） |
| `server/agent/service/hosted-motion.mjs`（新） | `attach_clip_motion` 的 provider：`createMotionTools({contextAccess, tracks, commit})` |
| `python/promptcut_track/`（本包独占） | 部署参数 `--pylibs/--models/--ffmpeg/--requirements`（盖过环境变量）、`track --max-frames`（超长直接拒绝、不截断）、错误事件带 `code`、ffmpeg 本地输入加 `-protocol_whitelist file` |
| `python/tests/test_track_cli.py`（新） | 上面几处的 Python 单测，7 条 |
| `server/test/cloud-tools-p3-{kit,track,motion,authority}…mjs`（新） | 测试工具包 + 三份测试，共 24 条 |
| `scripts/probes/cloud-tools-p3-probe.mjs`（新） | 可重复跑的端到端探针 |

行为要点（都有对应用例）：

- **素材**只经 F0 的 `ProjectAssets.openRead`（真流、真哈希、核大小）落到这个对话的工作区，再把工作区里的文件递给 Python；不收路径、地址。用完删（取消、失败也删）。
- **作业状态**写 F0 的 `ToolJobs`（真 SQLite）：queued → running（stage fetch/decode/track）→ done/error/cancelled/interrupted；每次推进 F0 都重核 doc 授权与 fence。active 变 retained 时 `update` 会撞 `job-scope-mismatch`，本模块走 F0 的 `checkpointRetained` 再试一次——**用真 run-authority 验过：发起人登录退出后在途追踪继续跑完**（P3-A2）。
- **结果**持久在本模块的表里，键是「项目 × 对话 × 素材 × 素材版本（`mediaRev`+哈希）」；只有作业表里是 `done` 的作业，结果才读得到；写完结果而作业推进失败（fence 变了），结果当场删掉（不留迟到产物）。
- **子进程**只经工作区的受限 `spawn()`（环境变量白名单、`windowsHide`），登记进 F0 的 `run-resources`：fence 变了由资源表杀掉；`close()` 等到每个子进程的 `close` 事件才回执。超时用自己的计时器杀并记 `TRACK_TIMEOUT`。
- **两档如实**：`track_status` 的 `ready` 只说 BootsTAPIR 那档（torch + 权重都在）；`engine` 才是「能追到哪一档」，没权重时是 `template`（模板匹配兜底，真跑过）。状态里一个服务器路径都不回。
- **没装模型或依赖**：没配 Python → `engine:null`+原因；解释器路径不对 → `解释器启动失败`；numpy 缺失 → 两档都不可用、`TRACK_ENGINE_UNAVAILABLE`；权重文件在但依赖不全 → 状态说就绪、真去追就如实失败（不假装成功）。
- **`track_install`** 云端默认不开放（回 `cloudUnavailable`，同 `collect_install` 的先例）；部署者开了（`install.enabled`）且给了出网闸才装：只跑包里随发的（或部署者指定的锁定）依赖清单，模型给的参数一个也进不了命令行；pip 子进程的代理指向出网闸起的回环代理，用完关；单进程单例，不重复启动。
- **`attach_clip_motion`** 不重写校验：在服务端项目副本上调**现成的** `src/mcp/handlers/ai.ts` 的 `attachClipMotion`（经 `host.callRoute`，轨迹临时放进 `host.setPageState`，出锁撤掉），由它核卡片段类型、时间重叠、`pointIndex`、追失败的点，再用 `buildClipMotion` 算位移。提交走宿主给的 `commit`（生产上是 `agent-exec` 的 `mutate`：算差异、带期望版本、opId 绑对话）。没有轨迹、还在跑、追失败、素材换版过期，一律拒绝，不提交、不伪造。

## 2. 验证

环境：本机 Python 3.11（`cuda_Vit`，numpy 2.4.3、torch 2.5.1，**没有** `einshape`/`dm-tree`、**没有**权重）、ffmpeg 9.0.1。

| 命令 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0，零错误 |
| `npm test`（同一条命令里设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | 退出码 0；6062 条，6059 通过，0 失败，0 取消，3 跳过（原有的 symlink 等跳过，不是本包）；`✓ npm test 最终结果：零失败`。交活前跑了三次全量，都是零失败 |
| `node --test server/test/cloud-tools-p3-{track,motion,authority}.test.mjs` | 24 条全过（track 17：P3-01～08 含子用例，motion 4，authority 3） |
| `cd python && python -m unittest tests.test_track_cli tests.test_template_track` | 12 条全过。整个 `python/tests` 里有 1 条 `test_collect…test_probe_without_ytdlp_reports_not_installed` 失败：采集包的用例，本机装了 yt-dlp 所致，与本包无关（没碰采集包） |
| `node scripts/probes/cloud-tools-p3-probe.mjs` | 退出码 0，12 行 `PROBE … OK`，末行 `PROBE-RESULT pass` |

探针关键输出（真视频 320×200×60 帧，目标 25×25 噪声块按已知路径走，H.264 压过）：

```
PROBE 状态 OK engine=template ready=false 权重在=false runtime.torch=true(…路径未外露)
PROBE 追踪 OK … engine=template 帧数=60 最大误差=0.67px 可见=60/60
PROBE 真画面复核 OK 第 0/30/59 帧轨迹位置上的目标相似度 1.000/1.000/1.000
PROBE 取消 OK 取消前 pid=… 活着=true;取消后 errorCode=RUN_CANCELLED 进程已退出=true 无结果
PROBE 超时 OK limit=1500ms code=TRACK_TIMEOUT 进程已退出 无结果
PROBE 失败 OK 坏字节 code=TRACK_FAILED(消息不带路径);音频素材 code=TRACK_NOT_VIDEO
PROBE 没配 Python OK status.engine=null track_points→TRACK_UNCONFIGURED track_install→TRACK_INSTALL_DISABLED
PROBE 无残留进程 OK 工作目录下没有任何 Python / ffmpeg 进程
PROBE 无新窗口 OK 没有新冒出来的可见窗口
```

对「每包必须提交的证据」逐条（`cloud-agent-tools-implementation.md` 末节）：

| 证据 | 在哪 |
|---|---|
| 成功产物真实可读 | P3-01：逐帧误差 ≤1.5px（实测 0.67）；P3-M1：把提交进项目的逐帧位移，同视频里解出的真画面里目标的真实位移 × 舞台缩放比对，差 ≤4 个舞台像素 |
| 真短素材，不只是状态接口通 | 全部用例都是 ffmpeg 现造的真视频、真 Python |
| 没装模型/依赖时的回应 | P3-04 五种（没配 Python、解释器不对、numpy 缺、权重在依赖不全、安装默认关/无出网闸） |
| 取消、超时、失败各一例 | P3-03（超时、取消、关停、崩溃重启）、P3-02（失败三种）、P3-A3（真 run-authority 下私有打断） |
| 401/403/503、只读写拒、错项目 | P3-05（只读写拒、撤权读拒、伪造上下文、跨对话、跨项目、素材换版）；P3-M3（只读成员 attach 被拒） |
| 失权与 private/stop 逐消息 fence | P3-A1（私有后连读都拒，结果表里有也不给）、P3-A2（retained 继续跑完）、P3-A3（撤销后杀进程、宿主取消、无结果） |
| 取消实际子进程 exit+close | 每个取消/超时/关停用例都核 `pidAlive(pid)===false` 与资源表回执；探针另在系统进程表按工作目录路径查，无 Python/ffmpeg 残留 |
| 重启后持久状态 | P3-01（重开提供者与结果表，轨迹还在）、P3-03 崩溃重启（`running` → `interrupted`）、P3-08（僵尸排队作业按中断处理）、P3-M4 |
| ACK 丢失幂等 | P3-01：同请求再调不再起 Python（`started:false`，同一 jobId），`force` 才开新作业；P3-08 |
| 旧实例不能复活 | P3-08（上一代遗留的排队作业读到的是中断，不被当成进行中） |
| 进程/子进程/流收干净 | 同「取消实际子进程」；素材副本文件每个用例都核删净；`close()` 回执 `childrenClosed/workPending` |

## 3. 没做成的与原因

1. **没有经过舞台渲染的「真实画面」复核。** 任务书「真实画面复核移动轨迹」；渲染那一带这一包不碰。我换成了对视频**源画面**的复核（解出真帧，找目标真位置，位移×舞台缩放比对提交进项目的位移，P3-M1）。卡片在舞台上跟着走的实际画面（预览、导出）没看。要看这一步得经渲染进程，停在这里。
2. **BootsTAPIR 档没有正向验证。** 本机没有 `einshape`、`dm-tree`，也没有 `bootstapir_v2.pt`（208 MB）。只验了「状态只在权重在时说就绪」和「依赖不全时真去追会如实失败、不假装成功」。**一个提醒**：Python 的 `ready` 只看 torch + 权重文件，不看 `einshape`/`dm-tree`，所以权重在、这两个包缺时状态会报就绪、追踪会失败。我没改 `ready` 的判据（会改桌面的状态语义），写在这里等主会话定（第 5、6 节）。
3. **没验 Linux。** 部署者要提供节点上 ffmpeg/Python/numpy/（可选）torch+权重的版本与证明。Linux 上取消只杀到 Python 进程本身，它的 ffmpeg 子进程靠管道断了自己退出（Windows 上验过无残留）；`workspace.spawn` 没有进程组，统一补隔离归另一块（P4 的报告也是这个口径）。
4. **素材传输与 doc 授权不是端到端 mTLS。** 测试里素材走进程内直连项目素材库（同 F0 的 `project-assets-client.test.mjs`），授权在 P3-A* 接真 run-authority、其余用受控桩。真 mTLS、真实例注册、真模型 → tool call 的全链归 G 包组合验证；本包不冒称。
5. **`track_install` 没真下载。** 受控的锁定清单这条路用空清单真跑过（`pip install --target` 的子进程、代理环境变量、不重复启动、状态里 `needsModel` 如实）；没有联网装 torch。
6. **桌面一侧未动**：`server/vite-plugin-track.ts`、`server/perception-source.mjs` 归 D 包，没碰；桌面行为不变（Python 新增参数都是可选的）。

## 4. 〔裁〕清单

都是三级（用户看不出区别）或本包内部取舍，没有改一级、二级语义；用户合入前可以推翻。

1. 〔裁-P3-1〕**轨迹结果按对话隔离**：键是项目 × 对话 × 素材 × 版本，同项目另一个对话读不到。理由：和 F0 的作业表（按对话查）一致，私有对话产生的东西不外泄。代价：换对话要重追。备选：按项目共享（读时仍验当前授权）。要改只动 `lookup` 的 `conversationId` 条件，一处。
2. 〔裁-P3-2〕**云端 `track_install` 默认不开放**，部署者显式开（`install.enabled`）且给出网闸（或声明 `direct:true`）才装。先例：`collect_install` 云端不装东西。
3. 〔裁-P3-3〕**Python 加命令行总开关**（`--pylibs/--models/--ffmpeg/--requirements`，盖过环境变量）。理由：工作区的 `spawn` 会剥掉所有 `PROMPTCUT_*` 环境变量，服务的路径配置只能这么递；桌面不传这些参数，行为不变。
4. 〔裁-P3-4〕**超长视频直接拒绝、不截断**（`--max-frames`，默认 1800 帧≈60 秒@30fps，约 0.5 GB 灰度帧）：截断会让轨迹只盖前半段，而 `attach_clip_motion` 按「轨迹覆盖整段素材」对时间，悄悄对错。数字是部署者可调的默认值，不是产品承诺。
5. 〔裁-P3-5〕其余默认数字（都在 `TRACK_DEFAULTS`，可由部署者覆盖）：一次最多 32 个点，同时跑 2 个追踪，单次时限 10 分钟，安装时限 30 分钟，素材字节上限 1 GiB，状态缓存 10 秒。
6. 〔裁-P3-6〕**`track_points` 加了一个可选参数 `force:true`**（同请求默认幂等返回同一作业；要重追才带）。注意：现有工具定义（`server/tools/ai.mjs`）里没有这个参数，模型靠返回的 `hint` 文字知道；要不要写进 schema（会影响本机）等主会话定。
7. 〔裁-P3-7〕`get_track` 没追过时回 `{ok:true, found:false, hint}`，不是桌面的 `null`；失败时抛 `TrackToolError`（`code`: `TRACK_*`），与桌面「抛错」同形。结果多了 `jobId`、`mediaRev`，素材换版时多 `stale:true`。
8. 〔裁-P3-8〕ffmpeg 本地输入加 `-protocol_whitelist file`（素材是成员传的，伪装成视频的播放列表不能让 ffmpeg 连网）。实测新版 ffmpeg 对本地清单默认也拦，这是不依赖版本的兜底；与 `measure_audio` 同口径。
9. 〔裁-P3-9〕**读不写**的僵尸判定：同实例名下、标着排队/进行中却没有 runner 的作业（上一代进程没了），`get_track`/`attach` 读到的视图是「中断」，不写作业表；`track_points` 同请求重试时才把它写成 `interrupted`。理由：F0 只在启动时转 `running`，不转 `queued`。

## 5. 对任务书或语义的更正建议

- `cloud-agent-tools-implementation.md`：F0 一节写 `ToolRunContext`/`RunAccess.signalFor`，实际取消信号在 `run-resources.mjs`（`register`/`signalFor`/`abortForFence`），不在 `tool-context`；P3 一行写「BootsTAPIR 有权重才算对应档 ready」——实际还需 `einshape`、`dm-tree`（见第 3 节第 2 点），建议要么 Python `ready` 也检查这两个包，要么部署清单写明。
- `cloud-agent-tool-coverage.md` 里 `track_*`、`attach_clip_motion` 几行：实现已在 `perception/track.mjs`、`hosted-motion.mjs`，待 G 接线后改「现状」。
- `cloud-tools.mjs` 系统提示词里「这一版在云端还没有：……运动追踪……」一句，G 接线时要去掉「运动追踪」，并加上云端差别（见第 6 节）。
- 语义文档本包没改。若 `docs/semantics/product/agent.md` 要写云端追踪的差别，建议只写一句：「追踪结果按对话保存、素材换版后标过期；云端不替用户安装拓展」。

## 6. G 包接线时要填什么

**provider 怎么造**（一个实例/项目一份；`context` 一律是 F0 `createToolRunContextAccess().fromGrant` 造的可信八字段，工具参数里没有 project/run/path）：

```js
const tracks = createTrackTools({
  contextAccess,                    // { authorize } —— F0 tool-context
  resources,                        // F0 run-resources（register / signalFor）
  jobs,                             // F0 createToolJobs（authorize、verifyFence 接同一个 resources）
  assets,                           // F0 createProjectAssets（只用 openRead）
  workspace: (ctx) => workspaces.open({ projectId: ctx.projectId, ownerKey, conversationId: ctx.conversationId }),
  databasePath: <Agent 数据目录>/state/track-results.db,   // 结果表，与 tool-jobs.db 同目录即可
  python: { executable, packageRoot /* 放 promptcut_* 的目录 */, pylibs, models, ffmpeg, requirements? },  // 部署配置，null = 没配
  readProject: async (ctx) => (await exec().snapshot(ctx.conversationId)).project,   // 可选；给了才能提前核素材、判过期
  install: { enabled: false /* 部署者决定 */, env: {} }, egress,   // 开安装时要 egress（createEgressGate）
  limits: {},                       // 覆盖 TRACK_DEFAULTS
});
const motion = createMotionTools({
  contextAccess, tracks,
  commit: ({ context, fenceRevision, tool, apply }) => exec().mutate(tool, context.conversationId, trackCtx, apply),
});
```

**要点**

1. 工具名 → provider：`track_status/track_install/track_points/get_track` → `tracks`（`tracks.handles`）；`attach_clip_motion` → `motion`（`motion.handles`）。**`attach_clip_motion` 必须在到达 `agent-exec` 的路由表之前就分给 `motion`**：`PAGE_STATE_TOOLS` 里它要向页面要轨迹，云端没有页面。
2. `cloud-tools.mjs`：这 5 项从 `pending` 改成 `hosted`（`H`），删掉 `NEED_PY('运动追踪')` 的用法；`attach_clip_motion` 的 `why` 同删。`track_status` 首次调用会起 Python（本机实测几秒，含 torch 导入），都在 60 秒内，不必进 `CLOUD_SLOW_TOOLS`。
3. 系统提示词（`CLOUD_SYSTEM_NOTE_LINES`）：去掉「运动追踪」；加一条：「追踪（`track_points`/`get_track`/`attach_clip_motion`）照常用，没装拓展时走模板匹配兜底；结果按对话保存，素材换版后会标过期要 `force:true` 重追；云端不替你安装拓展」。
4. `commit` 的契约：`apply(host)` 是 async、在进程锁里跑、只做项目副本上的同步改动；`fenceRevision` 是 attach 在提交前刚核过的 doc fence，**宿主在提交时要与 run authority 当前 fence 对账**（`exec().mutate` 目前不带这个检查，是 G 要补的；本包的测试里只断言收到了它）。
5. 关停顺序：`motion.close()` → `tracks.close()`（回执里 `childrenClosed/workPending`，`tracks` 自己开的结果表一并关；传入 `results` 的话归调用方关）→ `assets/resources/jobs`。控制 ACK 要等 `childrenClosed===true`。
6. 取消：fence 变化时宿主照 F0 的路径 `resources.abortForFence(context)`（杀 Python，等 close）→ `jobs.cancelForFence(context, 旧 fence)`；本包的 runner 会尽力自己写 `cancelled`，写不了（授权已撤）就留给 `cancelForFence`。P3-A3 是这条路径的实测。
7. 节点依赖（部署者给证明）：Python 3.x + numpy≥1.24（模板匹配档就绪只要这个和 ffmpeg）；BootsTAPIR 档另需 torch≥2.2,<3、`einshape`、`dm-tree`、`bootstapir_v2.pt`（放 `models` 目录）。`pylibs`/`models` 要在 Agent 进程可写（安装）/可读（权重）的位置，且**不要放进对话工作区**。
8. 要用户定的事见最终回复。
