# AGENT 报告：browser-export-hang

分支 `claude/browser-export-hang`（起点 main `a55d8199`），工作区 `.worktrees/browser-export-hang`，端口 5380–5382（dev server 在本工作区自己起，验完已停）。

任务：查清并修复「浏览器导出成片卡住不返回」：`window.__pcIo.exportVideoBrowser()` 在本机 dev server 上，一张卡的项目也不返回；探针 `scripts/probes/lowmem-export-compare.mjs` 也卡住。

## 结论

- **根因**：导出页（`src/ExportView.tsx`，`?export=1`）装了导出时钟（`src/kernel/exportClock.ts`、`pinEntropy.ts`），`performance.now()` 和 `Date.now()` 都被钉在当前导出帧的毫秒数上，项目载入后就是 0，不再走动。跨源导出舞台收到 `pc-export-init` 后，先「等舞台执行闸门打开，最多 10 秒」，这 10 秒是拿 `performance.now()` 量的，所以永远到不了头。闸门不开时就一直死等：
  - 桌面运行环境、开发服务器上的导出页不是在线构建的 `stage.html`，没有舞台加固，也没有自检，闸门一直停在 `checking`。所以**每一次**浏览器导出都卡在初始化，父页的 `sendRpc` 又不设时限，于是 `exportVideoBrowser()` 永远不返回。
  - 线上的在线构建里，导出页就是 `stage.html`，自检几百毫秒内通过，闸门打开，循环第一轮就退出，所以不卡。这和主会话在 visuhive.com/editor 上实测 11.8 秒返回一致。不过线上也有同一个隐患：自检没通过（`not-isolated`）、或父页没放行时，闸门开不了，同样会死等。所以这是代码缺陷，不只是本机环境的问题。
  - 同一段里还有一处「装好项目最多等 30 秒」，也是拿 `performance.now()` 量的，同样等不到头。
- **引入的提交**：`576ad0a3`（2026-10-16，「渲染重构:在线浏览器导出接入跨源隔离舞台…」）。它让开发服务器上的浏览器导出也走跨源导出舞台（有舞台端口时 `stageOrigins()` 不为空），同时写进了上面两处等待。
- **定位证据**：
  - 最小复现：一张 `punch-pill` 卡，`maxFrames: 15`。父页收到了 `pc-export-ready`，此后 90 秒内导出舞台对 `pc-export-init` 一条回包都没有。
  - 临时插桩（已撤）：导出页打出 `init start → marked → policy {"allowed":false,"reason":"checking","isolation":null}` 后，再没有下一行，「gate passed」一直没出现。父页这边，`activeCardSourceReader()` 为空，没有要打包的卡源。
- **逐个提交复现**（用同一个最小复现，每次在本工作区 checkout 后重起 5380）：

  | 提交 | 结果 |
  |---|---|
  | `20a518b9`（并入 576ad0a3 之前的 main） | 2.6 秒返回，15 帧，108344 字节 |
  | `576ad0a3^`（`28087331`） | 2.75 秒返回，15 帧，108344 字节 |
  | `576ad0a3`、`d624d2bd`（合并） | 编辑器起不来：舞台载 `dynamic-import-helper.js` 被拦（`ERR_ABORTED`），所以测不到导出。这是另一个问题，`d1ae109e` 修好 |
  | `d1ae109e`（舞台闸门放行该模块，main 上随 `daa226d2` 并入） | 编辑器起得来，导出 60 秒无返回，**卡住** |
  | `a55d8199`（main） | 卡住（90 秒、40 秒两次） |
  | 本分支 `7d365ca3` | 2.78 秒返回，15 帧，108344 字节（与引入之前逐字节同长） |

  所以卡住这个问题本身就是 `576ad0a3` 带进来的。它刚合入时被「舞台起不来」盖住，`d1ae109e` 之后才显出来。

## 改了什么（提交 `7d365ca3`）

- `src/export/realClock.ts`（新）：`realNow()` 取导出时钟接管前存下的真墙钟 `__pcRealDateNow`；`waitReal(ok, ms)` 按真时间等，到时限回 false。
- `src/ExportView.tsx`（`pc-export-init` 处理）：
  - 等闸门：只在本文档装了舞台加固（`stageGuardBooted()`，即在线构建的 `stage.html`）、并且闸门还在 `checking` 时才等，最多 10 秒真时间。没有自检的导出页不等，因为它永远等不到结果。
  - 等项目装好：改用 `waitReal`，30 秒真时间，到时限报「导出舞台装配项目超时」。
- `src/online/isolation/stageGuard.ts`：加只读的 `stageGuardBooted()`。
- `src/export/frameCompositor.ts`：跨源导出舞台的每条请求（装项目、预热、出一帧）设 120 秒真时间上限（`EXPORT_STAGE_RPC_TIMEOUT_MS`），超时报「导出舞台 120 秒没有回应(…)」；取消导出时，等着的请求当场拒掉，原来要等回包才停。
- 回归测试 `src/export/realClock.test.mjs`：
  - RC-01：两个钟都钉住时，`waitReal` 照样按真时间到时限。
  - RC-02、RC-03：基本行为。
  - RC-04：`ExportView.tsx` 里不许再出现拿 `performance.now()` 算时限的 `while`/`if`。原代码会被 RC-04 抓到 2 处。

没动 `src/editor/io/exportSounds.ts`、`cardAudioGeneration.ts`、`server/bakery/export.mjs`，和 `claude/cut-segment-followups` 不冲突。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（设了两个 VisuHive 环境变量） | tests 7183，pass 7169，fail 0，skipped 14，退出码 0 |
| 新单测 | `node --test src/export/realClock.test.mjs` | 4/4 通过 |
| 最小复现 | 一张卡，`exportVideoBrowser({ maxFrames: 15 })` | 修前卡住；修后 2.78 秒，15 帧 |
| 探针 | `node scripts/probes/lowmem-export-compare.mjs --origin http://127.0.0.1:5380 --frames 45` | 退出码 0，`ok: true`，`fails: []`。浏览器一路 45 帧 h264 加 AAC，用时 45.3 秒；桌面一路 45 帧；逐帧平均 MAE 1.83，最低 PSNR 34.55（只报数，不设门槛） |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5380/?export=1"` | 1800 帧逐像素相同，退出码 0 |
| 看图 | 探针最差帧第 43 帧，浏览器与桌面对照 | 两张画面一致（彩条视频、`punch-pill` 文字、`chapter-bar`），见下 |

图（`docs/reports/assets/browser-export-hang/`）：
- `lowmem-browser-f43.png`：浏览器导出成片第 43 帧
- `lowmem-desktop-f43.png`：桌面导出同一帧
- `lowmem-browser-f0.png`：浏览器导出成片第 0 帧

没跑的：
- 像素基线（与 main 比桌面导出逐字节）没跑。桌面导出走同源 `__pcLoadProject` 分支和 `server/bakery`，这次一行没动；改的只是跨源导出舞台初始化里的等待时钟和父页 RPC 的时限，不碰取帧和合成。确定性 1800 帧已过，浏览器导出产物与引入之前的提交同长（108344 字节）。
- 在线构建本机没重跑。线上那条路只差等待用的钟：自检通过时与原来一样第一轮就过；主会话已在生产上实测原代码不卡。部署后建议在线上再导一次。

## 部署

- 改了 `src/`（`ExportView.tsx`、`export/frameCompositor.ts`、`export/realClock.ts`、`online/isolation/stageGuard.ts`）：**整份 `src/` 要同步进渲染树**，在线页面 `/editor` 要换新的在线构建，桌面版随下次发版。
- 不涉及服务器端（文档服务、素材服务、`server/`）的部署。

## 对任务书与语义的更正建议

- 「本机 dev server 才卡、线上不卡」的说法要修正：两边的根因是同一处。线上只是因为自检及时通过，没有走到死等那一支；线上自检失败时同样会卡。
- `mechanism/rendering.md` 不用改：这次只改等待用的钟和防卡死时限，没改语义。120 秒的 RPC 上限只防卡死，与 `verification.md`「探针里的等待时限只为防卡死」同一个意思；正常导出看不出区别。如果主会话认为「导出舞台不回应时报错，而不是一直等」属于二级（用户看得到的行为），请按〔裁〕审。
- 观察：`576ad0a3` 合入时编辑器在开发服务器上起不来（`dynamic-import-helper.js` 被舞台闸门拦），这段时间合入 main 的浏览器导出探针在 dev 上都跑不起来。建议发版验收时把 `lowmem-export-compare.mjs` 列为必跑。
