# AGENT 报告：剪辑段首版局限补齐

分支 `claude/cut-segment-followups`，工作区 `.worktrees/cut-segment-followups`，基于 main `a55d8199`。
背景：`docs/archive/agent-reports/AGENT-cut-nesting.md`「没做成的与原因」（剪辑段即「剪辑套剪辑」：一条剪辑放进另一条剪辑序列里的那种片段）。

## 状态

第 1、2、3、5 项做完；第 4 项（能做就做）做了一半：`--media=ffmpeg` 导出画得出剪辑段里的视频与图片（改走完整整帧路线），剪辑段参与测量与预渲染没做（解法表见「没做成的」）。基线全绿。没有推送、没有合并。

## 每项结论

| # | 项 | 结论 |
|---|---|---|
| 1 | 剪辑段属性面板 | 做完。选中剪辑段时「编辑」分区显示剪辑段面板：引用、起点偏移、开始 / 结束、框（X、Y、缩放、旋转、铺满）、不透明度、淡入淡出、音量、静音、「打开被引用剪辑」；全走现有 store 动作，换新对象、可撤销；界面探针 17 条全过 |
| 2 | Agent 接口 | 做完。`EditorApi` 加 `addCutSegment` / `setCutSegment`，`add_cut_segment` / `set_cut_segment` 直连；本机与云端副本两条路的测试都过 |
| 3 | 导出声音递归进剪辑段 | 做完。导出前自动生成走进剪辑段（任意深度），产物写回被引用剪辑的原片段；成片按剪辑段音量、淡入淡出、静音出声；桌面导出与浏览器那一路（生成 + Chrome 混音）端到端测电平全过 |
| 4a | `--media=ffmpeg` 画剪辑段里的视频与图片 | 做完（三级改法）：剪辑段里有视频 / 图片时这次导出改走完整整帧路线，成片里有；探针两遍全过 |
| 4b | 剪辑段与里面的卡参与测量与预渲染 | 没做，解法表见「没做成的」 |
| 5 | 素材库剪辑组小方块的名字 | 做完。根因：总览缩略里名字被 flex 挤成 1.4 像素高；改为名字与时长压在底边、不收缩，13px，比视频 / 图片格子标题（11.5px）大 |

## 做了什么

### 1. 剪辑段属性面板

- 实际的属性面板在 `src/editor/left/Inspector.tsx`（「编辑」分区，可停靠在左右任一边），不在 `src/editor/right/**`；`right/` 下只有 AI 栏。所以新面板放在 `src/editor/left/CutSegmentForm.tsx`，`Inspector` 遇到剪辑段直接交给它（以前剪辑段落进卡片那一支，显示一个 `cardId` 为空的换卡下拉）。
- 各项走的动作：引用与偏移 `actions.setCutSegment`（循环引用、偏移超出被引用剪辑总长都抛，原因显示在面板底下；下拉里会循环引用的剪辑灰掉并写「会循环引用」）；开始 / 结束 `moveClip`；框 `setClipFrame`（没框时补一个和铺满等价的 `{x:0,y:0}` 再改，「铺满」清掉框）；不透明度、淡入淡出 `updateClip`（转场管着的那一侧灰掉）；音量 `setClipVolume`；静音 `setClipMuted`。全都换新项目对象、进撤销栈。
- 「打开被引用剪辑」调 `openCutInTimeline`，和双击时间轴上的剪辑段同一个函数。
- 数字框逐键提交（和原有「开始 / 结束」同一口径），输入中显示用户敲的原样（不再出现受控数字框的「0100」），失焦后回到项目里的值。

### 2. Agent 接口

- `src/ai/mcpExecutor.ts` 的 `EditorApi` 加两个方法；`src/mcp/handlers/cutSegments.ts` 的 `cutSegmentHandlers` 按 `EditorApi` 定型，并进 `src/mcp/api.ts` 的 `editorApi`；`src/mcp/routes.mjs` 两条路由改成 `addCutSegment` / `setCutSegment`。
- 去掉 `src/mcp/handlers/clips.ts` 里借 `addClip` / `updateClip` 按参数分支的旧路（`update_clip` 不再认 `cutOffset`；`add_clip` 不带 `cardId` 不再被当成放剪辑段）。
- 云端：托管档在项目副本上执行，`server/agent/ssr-host.mjs` 的 `callRoute` 用同一张路由表、同一个 `editorApi`，所以不用改服务端代码；`cloud-tools.mjs` 里两个工具原已登记为副本执行。

### 3. 导出声音递归进剪辑段

- `src/editor/io/exportSounds.ts`：清单按混音同一份展开（`audioProjectOf`）走进剪辑段，展开出来的片段换回它在被引用剪辑里的原片段，带 `cutId`；静音的剪辑段、所在序列静音或隐藏、落在段窗口外的不列；同一条剪辑被引用几次只列一次；片段名写成「剪辑「剪辑2」里的「声画提示脉冲」」。生成按 `cutId` 定位。
- `src/kernel/cutSegments.ts` 加 `cutViewProject`（「切到那条剪辑时项目的样子」，只读）与 `findClipInCut`。
- `src/editor/io/cardAudioGeneration.ts`：`generateCardAudio(clipId, { cutId })` 按那条剪辑的视图算身份、合成，和用户切过去再生成是同一个结果；`src/store/actions/cardAudio.ts` 的 `commitCardAudio` 多一个 `clipCutId`，把产物写回停放剪辑的条目（一次项目替换，一步撤销）。
- `src/kernel/cardAudioRendition.mjs`：展开出来的片段（带 `cutOrigin`）按原片段核身份与覆盖范围，偏移加上裁掉的那一截。以前直接按展开后的片段核，片段 id 带了路径前缀，身份里按片段 id 找的输入素材（素材效果卡这类）找不到会误判缺失；报错也点的是原片段 id。`src/kernel/cutAudio.mjs` 的 `cutOrigin` 带上 `cutId`。这几个文件都不在有声卡源码闭包里（`audioCardSourceVersion.test.mjs` 钉住值没动，已生成的卡片声音不会判过期）。
- `src/audio/cardAudio.ts` 的 `assertProjectCardAudio` 也走展开后的项目：被引用剪辑里缺声音时，导出前当场点名原片段。
- 被引用剪辑里**独立音效**（提示音、键盘声）的文件丢了：导出前不补（补回要按激活剪辑提交 `commitSoundEffect`），导出失败并说明要打开那条剪辑重新生成。写进机制文档〔裁〕。

### 4a. `--media=ffmpeg` 兼容旁路

`server/bakery/export.mjs` 加 `cutSegmentsHaveVisualMedia`：项目的剪辑段里（任意深度，不算隐藏序列）有视频或图片时，这次导出改走缺省的完整整帧路线（`FrameScene` 连素材一起渲），日志里写一行原因。剪辑段里只有卡时照旧走旁路。用户看到的是成片里有剪辑段的视频与图片，没有别的不同，按三级办，标〔裁〕。

### 5. 素材库剪辑组格子

`src/editor/timeline/cut-tabs.css`、`src/editor/left/library/cutsGroup.tsx`：`.pc-lib-cut` 改为 `justify-content: flex-end`、`overflow: hidden`；名字 13px / 600、`flex-shrink: 0`；时长行 11px、不收缩；去掉名字的行内 `marginTop: 22`；胶片图标挪到左上 8px。总览缩略（约 95×53 像素）里名字从 1.44 像素高恢复到 17 像素一行。

### 语义文档

`docs/semantics/mechanism/rendering.md`「剪辑段」两条（三级，标〔裁：剪辑段补齐 2026-10-20〕）：「声音走平移展开」末句改为导出前生成递归进剪辑段的做法与独立音效的例外；「兼容旁路」改为改走完整整帧路线。

## 文件清单（相对 `a55d8199`）

新增：`src/editor/left/CutSegmentForm.tsx`、`server/test/cut-segment-cloud-route.test.mjs`、`server/test/cut-segment-export-mode.test.mjs`、探针 `scripts/probes/cut-segment-panel-probe.mjs`、`scripts/probes/cut-segment-card-sound-probe.mjs`、`scripts/probes/cut-segment-ffmpeg-media-probe.mjs`、截图 `docs/reports/assets/cut-segment-followups/**`、本报告。

修改：`src/editor/left/Inspector.tsx`、`src/editor/left/library/cutsGroup.tsx`、`src/editor/timeline/cut-tabs.css`、`src/ai/mcpExecutor.ts`、`src/mcp/{api.ts,routes.mjs,handlers/clips.ts,handlers/cutSegments.ts}`、`src/editor/io/{exportSounds.ts,cardAudioGeneration.ts}`、`src/store/actions/cardAudio.ts`、`src/audio/cardAudio.ts`、`src/kernel/{cutSegments.ts,cutAudio.mjs,cutAudio.d.mts,cardAudioRendition.mjs}`、`server/bakery/export.mjs`；测试 `src/editor/io/exportSounds.test.mjs`（C1～C3）、`src/kernel/cardAudioRendition.test.mjs`（+1）、`src/mcp/handlers/cutSegments.test.mjs`（+1）；语义 `docs/semantics/mechanism/rendering.md`。

## 验证

最终代码上跑（提交见末尾；跑的时候工作区与提交一致，只差本报告）。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行 |
| 全量测试 | `npm test`（命令里设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | 退出码 0；7186 条：7172 过、0 败、0 取消、14 跳过；「npm test 最终结果：零失败」；一遍过，没有要单独重跑的 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5370/?export=1"` | 退出码 0；1800/1800 帧相同 |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5370 node scripts/verify-unified-frames.mjs` | 退出码 0；PASS |
| 与 main 的导出像素比对 | `bash .worktrees/_export-baseline/check.sh <本树> cut-segment-followups 5376` | 240 帧；对 89c15177 第二种结果（A）240/240 逐字节相同，PASS（不含剪辑段的项目像素不变） |
| 上一轮剪辑段界面探针 | `node scripts/probes/cut-nesting-ui-probe.mjs --origin http://127.0.0.1:5370` | 退出码 0；A1～A9 全过 |
| 上一轮剪辑段声音探针 | `node scripts/probes/cut-segment-audio-probe.mjs --port 5373` | 退出码 0；chrome、ffmpeg 两遍 PASS（段前 −200 dB、淡入头 −34.89 dB、主体 −24.09 dB，原素材 −24.08 dB） |
| 剪辑段面板与素材库格子（新） | `node scripts/probes/cut-segment-panel-probe.mjs --origin http://127.0.0.1:5370 --out docs/reports/assets/cut-segment-followups/panel` | 退出码 0；17/17 过（P1～P9、各自的撤销、P8 每次换新对象、L1、页面零报错） |
| 剪辑段有声卡导出（新） | `node scripts/probes/cut-segment-card-sound-probe.mjs --port 5373` | 退出码 0；20/20 过，数字见下 |
| 兼容旁路画剪辑段里的视频（新） | `node scripts/probes/cut-segment-ffmpeg-media-probe.mjs --port 5376` | 退出码 0；7/7 过：两遍 2 秒处左上四分之一中心 RGB (252,0,0)（剪辑段里的红色视频），右下 (51,51,51)；0.5 秒处左上 (53,60,74)；`--media ffmpeg` 那一遍日志写明改走完整整帧 |
| 新增单测 | `exportSounds.test.mjs` C1～C3、`cardAudioRendition.test.mjs` +1、`cutSegments.test.mjs`（mcp）+1、`cut-segment-cloud-route.test.mjs`、`cut-segment-export-mode.test.mjs` | 全过（也在 npm test 里） |

有声卡导出探针的电平（ffmpeg astats，每个窗口 0.26 秒）：

| 窗口 | 浏览器那一路（生成 + Chrome 离线混音） | 桌面导出（预渲染进程，成片 MP4） |
|---|---|---|
| S1 1.5 秒（音量 1） | −28.22 dB | −28.22 dB |
| S2 4.5 秒（音量 0.5） | −34.24 dB（低 6.02 dB） | −34.24 dB（低 6.02 dB） |
| S3 7.5 秒（静音） | −200 dB | −200 dB |
| S4 10.5 秒（淡入中段） | −33.22 dB（低 5.00 dB） | −33.22 dB（低 5.00 dB） |
| S5 13.5 秒（两层嵌套） | −28.22 dB | −28.22 dB |
| 段与段之间五个窗口 | 全部 −200 dB | 全部 −200 dB |

两路导出前的清单都只有一项（剪辑2 里那张有声卡，带 `cutId`，被引用 5 次、两层嵌套只列一次），改动前的核对点名原片段；导出后声音记在剪辑2 的原片段上，激活剪辑的序列不动，再列清单为空；桌面那一路进度里有声音生成阶段（1/1）。

看过的图（`docs/reports/assets/cut-segment-followups/`）：
- `panel/01-panel-selected.png`、`01b-panel.png`：选中剪辑段后的面板；`02`～`07`：改偏移、换引用、框、不透明度与淡化、音量与静音、偏移超出时面板底下的原因；`09-open-referenced.png`：打开被引用剪辑后标签栏；
- `panel/L1-overview-cuts-group.png`：总览组框里两格剪辑名清楚可读；`L1-detail-cuts.png`、`L1-image-detail.png`：详情格子与图片格子对照；
- `export/desktop-export-waveform.png`：桌面导出成片的波形，1.5、4.5、10.5（较小）、13.5 秒四处有声，7.5 秒（静音段）没有；
- `export/ffmpeg-bypass-nested-video-2s.png`：`--media ffmpeg` 导出 2 秒那一帧，左上四分之一是剪辑段里的红色视频。

没跑的：在线（visuhive.com/editor）实测（不碰生产节点，部署后由主会话做）。

## 没做成的与原因

1. **剪辑段与它里面的卡参与测量与预渲染（第 4 项后半）**：没做，剪辑段与里面的卡仍一律在舞台里活渲。按 `solution_table.md` 扫的思路：

   | 行 | 级 | 思路 | 卡在哪 |
   |---|---|---|---|
   | 1 | 三 | 把被引用剪辑里的卡按时间平移、框复合后「摊平」进父时间轴的分派表，各自测量、各自产轨道流，嵌套舞台里有流就藏活子树贴流 | 流平面按舞台坐标与片段自己的框贴，剪辑段的框、裁切、组不透明度要逐张复合；判重键、流键、输入签名、层表、`snapshotFeed` 选帧、渲染节点 `frame-stream` 都要认这种虚拟片段，横跨分派、预渲染进程、舞台三端，每端都有像素基线与预渲染探针要过 |
   | 2 | 三 | 把整个剪辑段当一张重卡：测量剪辑段（嵌套场景）的成本，按它产一条剪辑段级的轨道流 | 剪辑段不是注册表里的卡：成本键（`cardCostKey`，卡片源码版本）、测量（`probeRunner` 按卡测）、流的输入签名都要为 `@cut` 另立一套，身份里要并进被引用剪辑的内容（已有 `cutIdentity.mjs` 可用）；渲染节点要按同一份 `planPipelines` 认它。可行性最高，但改动面同样跨三端 |
   | 3 | 二 | 不预渲染，播放到重剪辑段时降档（例如先显示上一张或占位） | 用户看得出区别，属二级；现在的「慢帧就等」画面正确，不必换 |

   这是核心渲染改动、根因不在卡点（现在画面正确，只是重内容时预览慢），按任务书「能做就做」没有动它。建议另起一个任务按第 2 行做，带预渲染探针与像素基线。
2. **浏览器导出成片的端到端**：`window.__pcIo.exportVideoBrowser()` 在本机 dev server 上连一个只有一张卡、没有剪辑段的项目都卡住不返回（5 分钟以上）；在开工前的提交 `a55d8199` 上另起一台 dev server 同样卡住，现有探针 `lowmem-export-compare.mjs` 也卡住，不是本次改动引入的。所以有声卡探针的浏览器那一路改为：和浏览器导出同样先 `prepareExportSounds`，再按 `browserExport.encodeAudio` 的做法（`audioPlanOf` → 切片 → `renderMix`）在 Chrome 里离线混音成 WAV 量电平，没走视频编码那一步。卡住的原因没查（不在本任务范围），建议主会话另查。
3. **被引用剪辑里丢了文件的独立音效**：导出前不补，导出失败并说明要打开那条剪辑重新生成（见第 3 节与机制文档〔裁〕）。补回要让 `commitSoundEffect` 认停放剪辑，没做。
4. **在线实测**：没做，见上。

## 对任务书或语义的更正建议

- 任务书写属性面板在 `src/editor/right/**`：实际的属性 / 参数区是 `src/editor/left/Inspector.tsx`（「编辑」分区），`right/` 只有 AI 栏。本次按实际放在 `left/`。
- `workflow/editing.md`（一级）可以补一句「选中剪辑段时，编辑分区可以改它引用哪条剪辑、从第几秒开始，以及框、不透明度、淡入淡出、音量、静音；有按钮打开被引用的剪辑」。一级不由会话改，没写，请用户定。
- `product/rendering.md`「导出时自动生成声音」（二级）原句已涵盖剪辑段，不用改；本次只是让实现符合它。
- 上一轮报告建议的 `developer_guide.md`「项目数据、时间轴」一行加「改实现再读 `mechanism/project-model.md`」仍未加。

## 〔裁〕清单

〔裁〕= 执行中自己定、用户合入前要审的决定。

| # | 级 | 内容 | 写在 |
|---|---|---|---|
| 1 | 三 | 导出前生成声音递归进剪辑段的做法；被引用剪辑里丢了文件的独立音效不补、导出失败并说明 | `mechanism/rendering.md`「剪辑段」声音一条 |
| 2 | 三 | `--media=ffmpeg` 遇到剪辑段里的视频 / 图片改走完整整帧路线 | 同上，兼容旁路一条 |

## 部署要换什么

改了 `src/`：**整份 `src/` 同步进渲染树**（渲染服务、预渲染进程、托管 Agent 服务都按 `src/` 加载）。

- **在线前端重建并换静态页**（`/opt/promptcut-hosted/editor`）：编辑台（剪辑段面板、素材库格子样式、导出前声音生成）都在前端构建里。
- **托管 Agent 服务**（`promptcut-hosted`，在项目副本上执行工具）：换 `src/ai/mcpExecutor.ts`、`src/mcp/{api.ts,routes.mjs,handlers/clips.ts,handlers/cutSegments.ts}` 以及它们加载的 `src/store/**`、`src/kernel/**`（含 `cutSegments.ts`、`cutAudio.mjs`、`cardAudioRendition.mjs`），重启 Agent 服务进程。服务端工具描述（`server/tools/cuts.mjs`）、`cloud-tools.mjs` 没改。
- **渲染服务 / 预渲染进程**：换 `server/bakery/export.mjs` 与 `src/kernel/{cutAudio.mjs,cardAudioRendition.mjs}`（导出混音按原片段核卡片声音）。没有剪辑段的项目导出像素、声音不变。
- **桌面版**：随 0.7.18 补丁一起出（前端与 `server/` 都在补丁里）。
- 文档服务、素材服务不用换。项目数据格式没变（停放剪辑里的片段多了 `cardAudio`，和激活剪辑里同一个字段）。

## 分支提交

`git log a55d8199..claude/cut-segment-followups`；最新提交号见主会话回执。
