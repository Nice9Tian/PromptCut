# AGENT 报告：perf-t4

分支 `claude/perf-t4`（从 main 2c7cee2），worktree `.worktrees/perf-t4`。端口段 5600～5609（tiers-probe 用 5600／5603，dev server 与 A/B 小工具用 5606）。

## 任务

修 tiers-probe 的 T4 挂的问题。T4 是 C6.6 集成时加的验收项：后台导入、转码、上传期间，页面主线程不能有超过 50 ms 的长任务。笔记本（性能基准机）上 3 轮挂 2 轮，长任务 69 ms 和 56 ms，都出现在一次 move 编辑之后、dtMs 0；不上传的对照窗口里没有。

## 结论

### 长任务是什么

就是那次 move 编辑自己所在的任务。探针的 `setTimeout` 回调里调 `moveClip`，store 通知 `useSyncExternalStore`，React 在同一个任务的微任务里同步重渲整个编辑器。这种更新走同步档，没法切片。之后 `planDispatch` 的微任务重算分派表。证据如下。

- trace（main，PC 不降速，`--trace`；第 2 轮录到一个 57 ms 的）：`TimerFire 56.6 ms` 里面，`RunMicrotasks 56.5` 分成 `react-dom_client.js:9077`（React 同步重渲）`51.6 ms` 和 `planDispatch.ts:71` `3.6 ms`。线程 CPU 时间 53.1 ms，占时长 56.6 ms 的 94%，说明主线程是真在干活，不是被别的进程抢走了 CPU。
- 这个任务里按本仓库最外层帧（也就是被渲染的组件）汇总：`EffectsSection` 6.0、`planDispatch` 3.1、`ClipView` 3.0、`NodeGraphTab` 2.6、`TopBar` 2.0、`GroupBox` 1.5 ……（ms，采样）。`EffectsSection`（特效库）和 `NodeGraphTab`（节点图）在探针的布局里都是 `display:none`，根本看不见。
- 每次编辑的函数调用次数（CDP 精确覆盖，连挪 30 次最后一个片段）：main 上 `useStore` 234 次、`ClipView` 20 次（10 个片段渲了**两遍**）、`GroupBox` 12 次；本分支分别降到 95 次、10 次、0 次。

整棵重渲的来源有三处：

1. **看不见的分区页也在重渲。** 停靠栏的五个分区常驻挂载、只是不显示，每个都整份订阅 `project`。每次编辑都把特效库（转场、滤镜、强调、音效四组都订阅 `project` 和 `selection`）、节点图、字幕列表整棵重渲一遍。
2. **挪最后一段时整个编辑器渲两遍。** `TimelineInner` 渲完后在 effect 里 `syncDuration`：内容末尾变了，就再改一次项目，于是同一个任务里整个编辑器又渲一遍。探针每 20 次编辑挪一次最后一段（i = 9、29、49…），对照窗口 25 次编辑里有 1 次，上传窗口约 18 次编辑里也有 1 次。这和笔记本上「每轮挂一个、都在 move 之后」对得上。
3. **顶栏整份订阅 `project`**，只为了导出时用一下。

### 为什么只在上传期间

页面在上传期间没有做任何额外的事，是 move 这个任务本来就贴着 50 ms 的线，上传时后台抢 CPU，把它挤过了线。

- 页面在两个窗口里发的请求种类相同（`/api/data/costs`、`playhead`、`diff`、`frames/snapshot`、`skill-mode`……），**没有一个**是上传队列、两档或素材相关的；WebSocket 收发次数和节奏也相同。非编辑任务（≥ 3 ms）两个窗口一样，都是 `UpdateLayoutTree`、零星的 React 与 GC，最大 7 ms。逐个排除了任务书列的几项：上传状态推送、素材记录更新、两档登记轮询、预取、缩略图，页面上都没有发生；成本和计划重算（`planDispatch`）每次编辑都有，两个窗口一样。原因是探针从 node 直接 POST 导入，页面的项目里不引用这些素材。
- move 任务本身的长度（小工具 `editcost`，PC、不降速、每种编辑 20～30 次）：main 上挪最后一段是 24～52 ms。
- 在后台加 3 个和小版转码同样设置的 libx264 编码（`veryfast`、1080p，**已经是 BELOW_NORMAL 优先级**，和 `media-tiers.mjs` 的转码一样），同一个 move 变成 51～63 ms，两轮共 8 次超过 50。`ffmpeg` 降了优先级，还是会通过共享的核、内存带宽和睿频拖慢渲染进程。笔记本核少，更明显。

### 修法（不改用户看得到的行为，不原地改 store 里的对象）

| 提交 | 改了什么 |
|---|---|
| 7596de1 | `store/core.ts` 加 `StoreHold`（React context）：包在它里面、值为 true 时，`useStore` 不订阅，一直返回上一次看得见时读到的值；变回 false 的那一次提交里按当时的 store 重读。`DockPages` 给五个分区各包一层，没选中或所在一侧收起着就是 true。**顶栏**不再订阅整份 `project`，导出时当场 `getState()`。 |
| 60ac75d | 新增 `editor/timeline/durationSync.ts`：模块加载时就挂 store 监听，排在所有 React 订阅前面；项目一变就排一个微任务去对总时长，这个微任务排在 React 刷新渲染的微任务前面，所以对完时长才渲，一次编辑只渲一遍。之所以放在微任务里而不是在监听里当场改：别人的改动经 docsync 写进 store 时，监听就在 docsync 的调用栈里，当场再提交一次等于重入。时间轴挂着时才起作用；原来的 effect 留着兜底。时长仍然不进撤销栈，手动截断照旧。 |
| ec9e84f | 单测，见下。 |
| 8acbde9 | 探针：`tiers-probe` 加 `--cpu-throttle N` 与 `--trace <文件>`（缺省不开，不改判定），编辑打 `performance.mark`；新增 `scripts/probes/longtask-stacks.mjs`，汇总 trace 里页面主线程上的长任务（时间线事件、V8 采样的自身时间与调用栈、线程 CPU 时间）。 |

## 验证

- **类型检查**：`npx tsc -b --force`，退出码 0，零错误。
- **全量测试**：`npm test`，退出码 0；tests 3410、pass 3408、fail 0、skipped 2。
- **新单测**（`src/store/storeHold.test.mjs` 3 条，`src/editor/timeline/durationSync.test.mjs` 7 条），用真的 React 渲染（`src/testing/fakeReactRoot.mjs`：react-dom/client 配一个假容器）：
  - 看不见的子树在 store 变化时一次都不重渲，值停在上一次；露出来就是当时的值，之后照常跟。一挂上就看不见的，第一次照常读。没包 StoreHold 的地方每次变动都重渲，行为不变。
  - 挪最后一段时，渲染读到的就是新时长，只渲一遍（修前做法的对照也在测试里：`[[5,4],[5,5]]`，渲两遍）。监听里不当场改；手动截断照旧；时长不进撤销栈，撤销一步片段和时长一起回去；没挂着时不动。
  - 这两个文件在 main 上跑不起来：main 没有 `StoreHold` 和 `durationSync`。
- **tiers-probe A/B**（PC，`--cpu-throttle 1.5`，交替各 5 轮，A = main 的 `src`，B = 本分支；探针脚本两边都用本分支的，只多了剖析开关和打点）：

| 轮 | A 上传窗口 >50 条数（最长） | A 对照窗口 >50 | B 上传窗口 >50（最长） | B 对照窗口 >50 |
|---|---|---|---|---|
| 1 | 4（140 ms） | 5 | 0（最长 50 ms，未超） | 0 |
| 2 | 8（104 ms） | 14 | 0 | 0 |
| 3 | 1（102 ms） | 2 | 0 | 0 |
| 4 | 1（101 ms） | 2 | 0 | 0 |
| 5 | 1（104 ms） | 1 | 0 | 0 |

  A 的 5 轮全挂，B 的 5 轮全过（整份探针 `ok: true`）。另外 B 在 `--cpu-throttle 2` 下跑了 3 轮也全过：上传窗口 0 条，对照窗口只有 1 条 59 ms。
- **tiers-probe 不降速**（本分支，3 轮）：全过，`ok: true`，上传窗口和对照窗口都是 0 条。
- **编辑耗时 A/B**（`editcost`，PC，不降速，交替各 3 轮，单位 ms）：挪最后一段 A 24～52、B 8～22；改参数 p50 A 12.9～13.5、B 7.8～10；改标签 p50 A 13.2～14.7、B 7.4～9.8。加 3 路后台编码后（各 2 轮）：挪最后一段 A 51～63、B 20～31；超过 50 的次数 A 8、B 0。
- **preview-fallback-probe**：`useStore` 预览也在用，保险起见跑了。dev server 用本分支，端口 5606，数据目录放临时目录。不带参数 PASS，透明拍数 0；`--page-preload` PASS，透明拍数 0；两次都没有 fails 和 pageErrors。
- **没跑**：导出确定性、导出与快照重放一致。改动没碰渲染、导出、快照、卡片代码。

**这项带耗时门槛，PC 上的数字只作参考，要笔记本过了才算修好。**

## 给笔记本的复核命令（性能基准机，端口 5580～5599）

在笔记本的仓库里取本分支（主会话推送后），先确认机器空闲，再连跑 3 轮：

```powershell
git fetch origin claude/perf-t4; git checkout --detach origin/claude/perf-t4
# 空闲确认:连采 5 次 CPU 负载,平均 < 15% 再跑(有别的探针、编码、构建在跑就等它结束)
1..5 | % { (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; Start-Sleep 2 }
1..3 | % { node scripts/probes/tiers-probe.mjs --port-a 5580 --port-r 5583 }
```

判定：每轮最后一行 JSON 的 `ok` 为 true，`t4.longtasksOver50` 为 0。如果还挂，加 `--trace $env:TEMP\t4.json` 重跑那一轮，再用 `node scripts/probes/longtask-stacks.mjs $env:TEMP\t4.json` 看长任务里是什么，把输出带回来。

## 没做的与建议（需要主会话定的事）

1. **React 开发版的开销。** 桌面版装出来也是在 `runtime/app` 里跑 `vite` dev，页面用的是 React 开发版。剖析里 `jsxDEV`、`createTask`、`performance.measure`（React 19.2 的开发期性能轨）加起来占编辑任务的自身时间一大半（采样里 `jsxDEV` 单项就约 11 ms/次，而整个任务约 29 ms）。改成生产版是另一件事，影响面大，本分支没碰；建议另立专项评估。
2. **`planDispatch` 每次编辑约 3 ms**（`cardCostKey` 的 `stableJson` 和 `cyrb53`）还留在编辑任务里。挪到下一个任务会让分派表晚一拍，舞台可能按旧表分派一拍，有无提示透明的风险，所以没挪；按片段记忆化又要证明节点只取决于片段自身，本分支也没做。现在的余量（1.5 倍、2 倍降速都过）够用，笔记本复核后仍紧再议。
3. **tiers-probe 的等待条件有个竞态**（不影响本次判定）。它等「iframe ≥ 2 且没有测量遮罩」，但遮罩要等约 3 秒后才出现，所以常常在遮罩出现之前就通过了。在 PC 上，测量从通过后约 3 秒持续到约 6.4 秒，和 5 秒静置、3 秒对照窗口有重叠；笔记本慢，重叠可能更大。建议改成等遮罩出现再消失（或者看 `probeProgress().running`）。
4. **没改语义文档**。StoreHold 是三级机制（用户看不出区别），而 `mechanism/` 里没有相应条目，所以没加；主会话觉得该记的话，可以在 `mechanism/` 的编辑界面相关处加一句「看不见的分区页不跟 store 更新」。
