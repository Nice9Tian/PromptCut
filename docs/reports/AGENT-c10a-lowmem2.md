# AGENT 报告：c10a-lowmem2

分支 `claude/c10a-lowmem2`，worktree `.worktrees/c10a-lowmem2`，起点 `claude/c10a-integ` 的 `a216054`。端口段 5640～5649（演示探针 `--port 5640 --proxy-port 5643 --doc-port 5644 --asset-port 5645`，远程调试 5647）。

范围：`docs/plan/c10a-contract.md` 第 17 节「低内存档的过渡做法」（2026-09-27 用户定）：全部按重卡、停下追当前一帧、补渲任务、队列优先级、单测与演示探针。

## 进度

六项都已完成，代码在 `93a183f`。

## 提交

| 提交 | 内容 |
|---|---|
| `19c2d19` | 队列:优先级档(normal / backfill)、同键不另起、backfill 被 normal 升级;补渲计划任务切出 backfill 细任务;管线登记补渲片段;单测 C10A-L17-Q1～Q6 |
| `3b403b9` | 低内存档全部按重卡;停下追当前一帧(舞台 `settleLowMemory`,时限常量 `LOW_MEMORY_SETTLE_MS = 5000`);单测 H1/H2、S1～S5;改写 `snapshotFeed.test.mjs` 里旧规则的一条 |
| `4c4c112` | 页面补渲发布(`src/editor/lowMemoryBackfill.ts`);单测 B1～B5 |
| `503adf7`、`93a183f` | 演示探针补三项断言;第一轮暴露的两处探针自身问题 |

## 怎么落的(摘要)

- **全部按重卡**:
  - `planPipelines` 加 `allHeavy` 选项;`planDispatch.setPlanAllHeavy`;`Preview` 在 `ONLINE && lowMem` 时打开;
  - 播放、拖动时父页照旧把判重的卡(现在是全部卡)抑制。
- **停下追一帧**:
  - 纯逻辑在 `src/render/lowMemorySettle.ts`(先后顺序、时限驱动、结果形状);
  - 舞台 `StageView.settleLowMemory` 与 `drawLowMemory`:
    - 生效的抑制 = 父页的抑制 − `lowMemLive`;
    - 在 `.pc-settling` 下画,直接定位的一步到位,推帧卡从入点逐帧推;
    - 画好的层撤兜底、发 `settled`;到时限的层同一次提交里回到抑制;
    - 下一次 `setTime` / `play` 清空 `lowMemLive`;
  - 父页 `Preview.settleLowMemoryAt` 在停下那次 `setTime` 之后发它;`snapshotFeed` 去掉「低内存档忽略 settled」。
- **补渲发布**:
  - `missingLayers` 判缺产物:不在层表里,且不是用户卡、图卡;
  - `BackfillPublisher` 只发 `publisher.hello` 与 `task.publish`;还在等的 120 s 内不重发,换版本 10 s 宽限;
  - 项目号用共享项目号,版本号用 DocSync 确认过的 `rev`;
  - `OnlineSnapshotSource.layerClipIds()`。
- **队列**:
  - `messages.mjs` 的 `priority` 收整数(旧形状,算 normal 档名次)或 `'normal'` / `'backfill'`;补渲计划任务的键是 `plan:<id>@<rev>#backfill:<sig>`,带 `input.clips`;
  - `queue.mjs` 的 `mergeExisting` 做 backfill→normal 升级(重发 `task.opened`,version 不变);
  - `pick.mjs` 按档排序,只在排头那一档里挑;
  - `local-node.mjs` 认领补渲计划任务:预渲染集合换成清单、不切流、细任务 `lane: 'backfill'`;
  - `frame-pipeline.mjs`:
    - `addBackfill` 按项目 + 内容身份登记,并进同项目所有 entry 的预渲染集合,写层表;
    - 普通计划与轨道流只用 `basePrerenderSet`。

## 验证

- **类型检查**:`npx tsc -b --force`,退出码 0。
- **全量测试**:`npm test`(PATH 带 ffmpeg),退出码 0;tests 3286、pass 3284、fail 0、skipped 2。
- **新单测单独跑**:
  - `c10a-l17-queue` 6/6;
  - `c10a-l17-lowmem` 与相关回归 67/67;
  - `c10a-l17-backfill` 与相关回归 24/24;
  - 队列回归 491/491。
- **`c10a-demo-probe --local`**:
  - R1(`503adf7`)只挂探针自身两处:暂停着进来时要小尺寸 img,与新规则冲突;`pause()` 后 store 的 t 被舞台最后一拍盖掉,等不到 2.5 秒那次停下;
  - 改好后 R2、R3(`93a183f`)两轮全过。

| 字段 | R2 | R3 |
|---|---|---|
| ok / fails | true / [] | true / [] |
| 耗时 ms | 1148518 | 832356 |
| 播放采样 | 6 次都在播,全部抑制 | 同左 |
| 点到 2.5 秒停下追一帧 | 两层画好,132.5 ms | 两层画好,167.7 ms |
| 暂停处停下追一帧 | 146.7 ms | 178.2 ms |
| 补渲 | 5 个细任务全标 backfill,小尺寸回到手机、播放中贴上 | 同左 |
| 认领先后 | `NNNNNBBB` | `NNNNNBBB` |
| 手机请求 | 素材原尺寸 0,snap 0,`/@media` 0 | 同左 |
| 导出 | 300 帧 h264 + aac,10.000 s | 同左 |
| 意外重载 | 0 | 0 |

## 没做成的

- **direct(无状态)卡补不了**:管线不给 `none` 档产快照,这类卡在低内存档播放时恒为占位。建议随 C10 其余。
- **超时这条路没有在探针里真正触发**:本机追一帧不到 200 ms。这条路由单测 S2 覆盖。
- **手机仿真下舞台 iframe 截图是空的**:窄屏布局里舞台不可见。画面证据用的是舞台 DOM 的状态。

## 偏离与建议

1. `priority` 同名同时收整数与字符串。
2. 认领顺序由节点 `pick.mjs` 保证,队列不硬拦;同档仍是前 K 名随机取一个。
3. 补渲计划任务用共享项目号 + 真身版本。
4. 「按清单判」只看层表。
5. 超时的层维持原兜底(有小尺寸就贴小尺寸)。
6. 停下追一帧逐层串行:直接定位的先,推帧卡帧少的先。
7. 补渲登记只在渲染节点进程的内存里。

建议改的文字:

- 契约表 C 第 1 行,进入提示还写着「暂停时不追精确画面」;
- `render-queue-contract.md` 的 A.4、B.3、H.3 与 plan 结果键;
- `mechanism/rendering.md` 里「维持占位符」的措辞。
