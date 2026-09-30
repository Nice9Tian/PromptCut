# AGENT-upload-timing

分支 `claude/upload-timing`，worktree `.worktrees/upload-timing`，起点 main `df81ae5d`（0.7.10 之后）。

## 状态

两项都做完，验收项全过。未推送、未合并。**没有改二级语义**；三级语义（`mechanism/asset-service.md`）加了一句，标〔裁〕，见下文。

## 提交

| 提交 | 内容 |
|---|---|
| `ba190722` | 文档：建本报告 |
| `55e259b9` | 修复：打开共享项目后、上传目标就绪之前导入的素材先记下，就绪后按哈希补交给上传队列；单测 UT-1～UT-5；三级语义加一句〔裁〕 |
| `5af9bf8e` | 探针：`shared-import-upload-probe` 加一步「上传目标就绪之前导入的素材，就绪后成员也取得到」 |
| `625ee79c` | 探针：其余调 `puppeteer.launch` 的探针启动参数以 `PROBE_CHROME_ARGS` 打头 |

用例编号：UT 是这次的「上传时序」单测（`src/editor/io/uploadTiming.test.mjs`）；MP-U 是 `claude/media-path` 加的「放云端后后台补上哈希的素材进上传队列」单测。

## 1. 放云端的时序缺口

**缺口**：打开共享项目后，页面要先问服务地址登记、再签 rw 素材票据，才把上传目标（远程素材服务的地址与票据）推给编辑器进程。这段时间里导入的素材，编辑器进程那一侧（`server/media-tiers.mjs` 的 `prepareImport` → 上传队列 `enqueue`）看到的是本机目标，当空操作跳过（`skippedLocal`），之后也没人再交，别的成员拿不到。

**修法（页面一侧，服务端没动）**：

- `src/editor/io/mediaUpload.ts`：`BackfillHooks` 加 `afterImport(media)`，由 `startTierBackfill` 挂上；`applyUploadedMedia`（用户导入、配音、素材收集三条路都汇到这里）写回哈希之后调它。后台补入库那一路调 `applyUploadedMedia` 时带 `{ imported: false }`，仍走原来的 `afterIngest`（`queueBackfilledMedia`），不重复交。
- `src/editor/media/assetTiers.ts`：新增 `queueImportedMedia(media, deps)`。共享项目里：
  - 上传目标还没就绪 → 按素材原尺寸哈希记下；`setUploadTargetReady(base)`（第一次带票据推成功、以及每次续签）时补交，走开启放云端时同一个入队口子 `enqueueExistingMedia`（视频带两档）；
  - 已经就绪 → 当场交一次（服务端 `prepareImport` 的入队与导入请求并行，赶不赶得上说不准；重复交无妨，队列按素材去重合并）；
  - 补交没成（编辑器进程没回）→ 留着，下一次就绪（续签）再交；
  - 队列回 `missing`（本机内容库没有）→ 用 `notify` 列给用户，与 0.7.9 起开启放云端、后台补入库同一句提示（`uploadMissingMessage` 气泡）；
  - 不记的情形：不是共享项目、没有入队口子（在线构建）、本机就是主机（`startUploadTarget(link, null)`）；离开共享项目（`startUploadTarget(null, null)`，`disconnectSharedAssets` 会调）时记下的丢掉，不交给下一个项目。
- `src/editor/sync/backfillUpload.ts`：`backfillHooks` 加 `afterImport`，入队口子 `postEnqueue`、提示同 `afterIngest`。

**〔裁：2026-10-01 `claude/upload-timing`〕** 三级 `docs/semantics/mechanism/asset-service.md`「本地内容库」加一句：「打开共享项目后、上传目标交到编辑器进程之前导入的素材，由页面记下，上传目标就绪后按哈希补交给上传队列；就绪之前离开了这个项目的丢掉，本机就是主机时不记。」语义没写到这个时序；二级「共享项目的素材都经素材服务入库、上传」本来就要求它们上传，这里只是把做法写进三级。选页面一侧而不在服务端记下「被跳过的」：服务端分不清跳过是因为本机项目（不该传）还是共享项目目标未到（该传），在服务端补交有把上一个本机项目的素材传进下一个共享项目的风险。

## 2. 其余探针的 Chrome 关掉实验配置

`scripts/probes/` 下调 `puppeteer.launch` 却没用 `PROBE_CHROME_ARGS` 的 44 个文件，启动参数都改成以 `...PROBE_CHROME_ARGS` 打头，写法照已有的那几个（静态 import 的加 `import { PROBE_CHROME_ARGS } from './probe-chrome.mjs'`；`c66-t9-probe`、`m8-migrate-probe`、`tiers-probe` 是动态 import puppeteer 的，跟着动态 import）。其中：

- `cross-machine-proc-probe`、`shared-import-upload-probe` 原来写死 `'--disable-field-trial-config'`，换成 `...PROBE_CHROME_ARGS`；
- `reveal-probe` 有头模式原来 `unshift('--window-position=…')`，改成插在 `PROBE_CHROME_ARGS` 之后，保持打头；
- `probe-connect.mjs` 的 `openBrowser`（`audio-determine-probe`、`backdrop-probe`、`gl-atlas-probe` 等经它起 Chrome）：调用方给的 `args` 前面补上 `PROBE_CHROME_ARGS`（去重）。

只改启动参数，没动任何判定。改完 `grep` 核对：`scripts/probes/` 里调 `puppeteer.launch` 的文件全部带 `PROBE_CHROME_ARGS`。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，0 错误（改完、两项都提交后各跑一次） |
| 全量测试 | `npm test` | 退出码 0；tests 4223、pass 4221、fail 0、skipped 2（两项都提交后再跑一次，同样结果） |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，不变 |
| UT 单测改前 | `node --experimental-test-module-mocks --test src/editor/io/uploadTiming.test.mjs`（只加测试、没改代码） | 退出码 1，5 个全挂；UT-1 挂在「就绪后一次补交」（就绪后没有任何入队请求），UT-5 挂在没有提示 |
| UT 单测改后 | 同上 | 5 过 0 挂 |
| 探针（改后） | `node scripts/probes/shared-import-upload-probe.mjs --doc-port 6140 --asset-port 6141 --port-a 6130 --port-b 6135` | 退出码 0，`fails: []`。early 导入时编辑器进程上传目标 `null`、`skippedLocal` 0→1、页面记下 1 条；放行后 A 的队列 `done 3、enqueued 3、merged 2、failures 0`；托管端三份字节 sha256 一致（含 early）；B 经 `/@media/<hash>` 取到三份、early 在 B 的页面里解码 320×240 |
| 探针对照（改前） | 同上，把三个 src 文件 `git stash` 掉再跑，跑完 `stash pop` 还原 | 退出码 1：「等不到：A 的上传队列清空、三条都传完」「托管端素材服务里有 image(early) 的同一份字节（404）」「B：取到 image(early)（404）」「B：early 解码（失败）」。窗口本身照样成立（目标 null、skippedLocal 0→1） |
| 第 2 项实跑 | 自己起 dev server 于 6130（`PROMPTCUT_NO_PORT_FILE=1`，数据目录在临时目录），`--origin http://127.0.0.1:6130` | `creativity-probe` 退出码 0（15 项）；`user-editing-probe` 退出码 0（18 项）；`editor-preview-smoke` 退出码 0（`fails: []`）。跑完结束自己起的 node 与 vite 两个进程，6130～6149 无监听 |
| 第 2 项其余 | `node --check scripts/probes/*.mjs` | 全部通过 |

没跑：G0-R 全套与全部探针（按 `verification.md`「子分支与集成分支各跑什么」，由主会话在集成分支上跑）。没有渲染改动，代码指纹不变。

## 没做成的

无。

## 需要主会话决定的事

1. 审三级〔裁〕那一句（`mechanism/asset-service.md`），可推翻。
2. `enqueueExistingMedia` 在「上传目标已就绪时导入」也会交一次，与服务端 `prepareImport` 的入队重复（队列合并，探针里 `merged 2` 就是这个）。代价是每次导入多一个小 POST；如果嫌多余，可以改成只在「导入请求发出时目标未就绪」才交，但需要把导入开始时刻带进 `applyUploadedMedia`，改动面更大，这次没做。
3. 服务端生成的素材（配音、素材收集）也经 `applyUploadedMedia`，所以一并覆盖；Agent 工具若将来有不经 `applyUploadedMedia` 直接写素材表的路，需要另外挂。
